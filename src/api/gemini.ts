import { Env, getConfig } from '../env';
import { ModelAPIInterface, ModelResponse, ModelUsage } from './model_api_interface';
import { Message, MessageContent, MessageContentPart, ToolCall, ToolDefinition } from './chat_types';
import { fetchJson, globalFetch } from '../utils/helpers';
import { RUNTIME_BUDGETS } from '../config/runtime_budgets';
import { readSSEJson } from '../search/sse';

interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    id?: string;
    name: string;
    args?: Record<string, unknown>;
  };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
  thoughtSignature?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: GeminiContent;
  }>;
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: ToolDefinition['function']['parameters'];
  }>;
}

export interface GeminiApiConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface GeminiApiDependencies {
  config?: GeminiApiConfig;
  fetchImpl?: typeof fetch;
}

export function geminiConfigFromEnv(env: Env): GeminiApiConfig {
  const config = getConfig(env);
  return {
    apiKey: config.googleModelKey,
    baseUrl: config.googleModelBaseUrl || 'https://generativelanguage.googleapis.com/v1beta',
    models: config.googleModels,
    defaultModel: config.googleModels[0],
  };
}

export default class GeminiAPI implements ModelAPIInterface {
  private apiKey: string;
  private baseUrl: string;
  private models: string[];
  private defaultModel: string;
  private fetchImpl?: typeof fetch;

  constructor(env?: Env, dependencies: GeminiApiDependencies = {}) {
    const config = dependencies.config ?? requireEnvConfig(env);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.models = config.models;
    this.defaultModel = config.defaultModel;
    this.fetchImpl = dependencies.fetchImpl;
  }

  async generateResponse(messages: Message[], model?: string): Promise<string> {
    return (await this.generateResponseWithMetadata(messages, model)).content;
  }

  async generateResponseWithMetadata(messages: Message[], model?: string): Promise<ModelResponse> {
    const systemInstruction = this.buildSystemInstruction(messages);
    const contents = this.buildContents(messages);
    const data = await this.generateContent(contents, systemInstruction, undefined, model);

    const content = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!content) {
      throw new Error('Gemini API did not return any choices');
    }

    return {
      content,
      resolvedModel: data.modelVersion || model || this.defaultModel,
      usage: this.toModelUsage(data),
    };
  }

  async generateResponseWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (toolCall: ToolCall) => Promise<Message>,
    model?: string,
  ): Promise<string> {
    return (await this.generateResponseWithToolsAndMetadata(messages, tools, executeToolCall, model)).content;
  }

  async generateResponseWithToolsAndMetadata(
    messages: Message[],
    tools: ToolDefinition[],
    executeToolCall: (toolCall: ToolCall) => Promise<Message>,
    model?: string,
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<ModelResponse> {
    const systemInstruction = this.buildSystemInstruction(messages);
    const history = this.buildContents(messages);
    const geminiTools = this.buildGeminiTools(tools);
    const aggregateUsage: ModelUsage = {};
    let resolvedModel = model || this.defaultModel;

    let completedToolRounds = 0;
    while (true) {
      const data = await this.generateContent(history, systemInstruction, geminiTools, model, onTextDelta);
      this.addUsage(aggregateUsage, this.toModelUsage(data));
      resolvedModel = data.modelVersion || resolvedModel;
      const candidate = data.candidates?.[0]?.content;
      if (!candidate || !candidate.parts || candidate.parts.length === 0) {
        throw new Error('Gemini API did not return any choices');
      }

      const functionCalls = candidate.parts
        .map((part, index) => this.partToToolCall(part, index))
        .filter((toolCall): toolCall is ToolCall => toolCall !== null);

      if (functionCalls.length === 0) {
        const finalText = candidate.parts
          .map(part => part.text || '')
          .join('')
          .trim();

        if (!finalText) {
          throw new Error('Gemini tool-assisted response returned no final content');
        }

        return { content: finalText, usage: aggregateUsage, resolvedModel };
      }

      if (completedToolRounds >= RUNTIME_BUDGETS.maxToolRounds) {
        throw new Error('Gemini tool-assisted response exceeded maximum function-calling rounds');
      }

      history.push(candidate);

      const toolResults = await Promise.all(functionCalls.map(executeToolCall));
      history.push({
        role: 'user',
        parts: functionCalls.map((toolCall, index) => ({
          functionResponse: {
            id: toolCall.id,
            name: toolCall.function.name,
            response: {
              result: toolResults[index].content || '',
            },
          },
        })),
      });
      completedToolRounds += 1;
    }
  }

  private toModelUsage(data: GeminiGenerateContentResponse): ModelUsage | undefined {
    const usage = data.usageMetadata;
    if (!usage) {
      return undefined;
    }

    const promptTokens = usage.promptTokenCount;
    const cacheHitTokens = usage.cachedContentTokenCount;
    return {
      promptTokens,
      completionTokens: usage.candidatesTokenCount,
      totalTokens: usage.totalTokenCount,
      cacheHitTokens,
      cacheMissTokens: promptTokens === undefined
        ? undefined
        : Math.max(0, promptTokens - (cacheHitTokens || 0)),
    };
  }

  private addUsage(target: ModelUsage, addition?: ModelUsage): void {
    if (!addition) {
      return;
    }

    const fields: Array<keyof ModelUsage> = [
      'promptTokens',
      'completionTokens',
      'totalTokens',
      'cacheHitTokens',
      'cacheMissTokens',
    ];
    for (const field of fields) {
      if (addition[field] !== undefined) {
        target[field] = (target[field] || 0) + addition[field]!;
      }
    }
  }

  private async generateContent(
    contents: GeminiContent[],
    systemInstruction: string | null,
    tools?: GeminiTool[],
    model?: string,
    onTextDelta?: (delta: string) => Promise<void>,
  ): Promise<GeminiGenerateContentResponse> {
    const primaryModel = model || this.defaultModel;
    const candidateModels = [
      primaryModel,
      ...this.models.filter(candidate => candidate !== primaryModel),
    ];
    let lastError: unknown = null;

    for (const candidateModel of candidateModels) {
      const method = onTextDelta ? 'streamGenerateContent?alt=sse' : 'generateContent';
      const url = `${this.baseUrl}/models/${candidateModel}:${method}`;

      try {
        if (onTextDelta) {
          return await this.streamContent(url, {
            ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
            contents,
            ...(tools && tools.length > 0 ? { tools } : {}),
          }, onTextDelta);
        }
        return await fetchJson<GeminiGenerateContentResponse>(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
            contents,
            ...(tools && tools.length > 0 ? { tools } : {}),
          }),
        }, `Gemini API error (${candidateModel})`, { fetchImpl: this.fetchImpl });
      } catch (error) {
        lastError = error;
        if (!this.isFallbackableModelError(error) || candidateModel === candidateModels[candidateModels.length - 1]) {
          throw error;
        }
        console.warn(`Gemini model "${candidateModel}" failed, trying fallback model.`, error);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Gemini API error');
  }

  private async streamContent(
    url: string,
    body: Record<string, unknown>,
    onTextDelta: (delta: string) => Promise<void>,
  ): Promise<GeminiGenerateContentResponse> {
    const response = await (this.fetchImpl ?? globalFetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Gemini API error (${response.status}): ${(await response.text()).slice(0, 300)}`);
    }
    if (!response.body) throw new Error('Gemini streaming response had no body');

    const combined: GeminiGenerateContentResponse = {};
    const parts: GeminiPart[] = [];
    for await (const event of readSSEJson<GeminiGenerateContentResponse>(response.body)) {
      const eventParts = event.candidates?.[0]?.content?.parts || [];
      for (const part of eventParts) {
        parts.push(part);
        if (part.text) await onTextDelta(part.text);
      }
      if (event.modelVersion) combined.modelVersion = event.modelVersion;
      if (event.usageMetadata) combined.usageMetadata = event.usageMetadata;
    }
    if (parts.length > 0) {
      combined.candidates = [{ content: { role: 'model', parts } }];
    }
    return combined;
  }

  private isFallbackableModelError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return [
      '429',
      '503',
      'too many requests',
      'quota exceeded',
      'resource_exhausted',
      'unavailable',
      'high demand',
      'try again later',
    ].some(pattern => message.includes(pattern));
  }

  private buildGeminiTools(tools: ToolDefinition[]): GeminiTool[] {
    if (tools.length === 0) {
      return [];
    }

    return [{
      functionDeclarations: tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    }];
  }

  private partToToolCall(part: GeminiPart, index: number): ToolCall | null {
    if (!part.functionCall) {
      return null;
    }

    return {
      id: part.functionCall.id || crypto.randomUUID(),
      index,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args || {}),
      },
    };
  }

  private buildSystemInstruction(messages: Message[]): string | null {
    const systemMessages = messages
      .filter(message => message.role === 'system')
      .map(message => this.contentToText(message.content))
      .filter(Boolean);

    if (systemMessages.length === 0) {
      return null;
    }

    return systemMessages.join('\n\n');
  }

  private buildContents(messages: Message[]): GeminiContent[] {
    return messages
      .filter(message => message.role !== 'system' && message.role !== 'tool')
      .map(message => {
        const role = message.role === 'assistant' ? 'model' : 'user';
        const parts = this.contentToParts(message.content);
        return parts.length > 0 ? { role, parts } : null;
      })
      .filter((message): message is GeminiContent => message !== null);
  }

  private contentToText(content: MessageContent | null): string {
    if (content === null) {
      return '';
    }

    if (typeof content === 'string') {
      return content;
    }

    return content
      .map(part => this.partToText(part))
      .filter(Boolean)
      .join('\n');
  }

  private contentToParts(content: MessageContent | null): GeminiPart[] {
    if (content === null) {
      return [];
    }

    if (typeof content === 'string') {
      return [{ text: content }];
    }

    return content
      .map(part => this.partToGeminiPart(part))
      .filter((part): part is GeminiPart => part !== null);
  }

  private partToText(part: MessageContentPart): string {
    if (part.type === 'text') {
      return part.text;
    }

    return part.image_url.url;
  }

  private partToGeminiPart(part: MessageContentPart): GeminiPart | null {
    if (part.type === 'text') {
      return { text: part.text };
    }

    const dataUrlMatch = part.image_url.url.match(/^data:(.+);base64,(.+)$/);
    if (!dataUrlMatch) {
      return { text: part.image_url.url };
    }

    return {
      inlineData: {
        mimeType: dataUrlMatch[1],
        data: dataUrlMatch[2],
      },
    };
  }

  isValidModel(model: string): boolean {
    return this.models.includes(model);
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  getAvailableModels(): string[] {
    return this.models;
  }
}

function requireEnvConfig(env?: Env): GeminiApiConfig {
  if (!env) throw new Error('GeminiAPI requires an Env or an explicit config.');
  return geminiConfigFromEnv(env);
}
