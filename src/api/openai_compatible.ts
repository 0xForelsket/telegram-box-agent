import { Env, getConfig } from '../env';
import { ModelAPIInterface, ModelResponse } from './model_api_interface';
import { ChatCompletionResponse, Message, ToolChoice, ToolDefinition } from './chat_types';
import { fetchJson, getFirstChoiceContent, globalFetch } from '../utils/helpers';
import { inlineImage } from './image_payload';
import { streamOpenAIChatCompletion } from './openai_chat_stream';

const MAX_ANALYSIS_TOKENS = 300;

export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
}

export interface OpenAICompatibleDependencies {
  config?: OpenAICompatibleConfig;
  fetchImpl?: typeof fetch;
}

export function openAICompatibleConfigFromEnv(env: Env): OpenAICompatibleConfig {
  const config = getConfig(env);
  return {
    apiKey: config.openaiCompatibleKey || '',
    baseUrl: config.openaiCompatibleUrl ? normalizeOpenAICompatibleBaseUrl(config.openaiCompatibleUrl) : '',
    models: config.openaiCompatibleModels,
  };
}

class OpenAICompatibleAPI implements ModelAPIInterface {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private models: string[];
  private defaultModel: string;
  private modelsLoaded = false;

  constructor(env?: Env, dependencies: OpenAICompatibleDependencies = {}) {
    const config = dependencies.config ?? requireEnvConfig(env);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.models = [...config.models];
    this.defaultModel = this.models[0] || '';
    this.fetchImpl = dependencies.fetchImpl;
  }

  async generateResponse(messages: Message[], model?: string): Promise<string> {
    return (await this.generateResponseWithMetadata(messages, model)).content;
  }

  async generateResponseWithMetadata(messages: Message[], model?: string): Promise<ModelResponse> {
    const data = await this.createChatCompletion(messages, model);
    return {
      content: getFirstChoiceContent(data, 'No response generated from OpenAI Compatible API'),
      resolvedModel: model || this.defaultModel,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        cacheHitTokens: data.usage.prompt_cache_hit_tokens,
        cacheMissTokens: data.usage.prompt_cache_miss_tokens,
      } : undefined,
    };
  }

  async createChatCompletion(
    messages: Message[],
    model?: string,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice } = {},
  ): Promise<ChatCompletionResponse> {
    this.requireConfigured();
    const useModel = await this.resolveModel(model);
    return await fetchJson<ChatCompletionResponse>(
      this.getEndpoint('/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: useModel,
          messages,
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
        }),
      },
      'OpenAI Compatible API error',
      { fetchImpl: this.fetchImpl },
    );
  }

  async createStreamingChatCompletion(
    messages: Message[],
    model: string | undefined,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse> {
    this.requireConfigured();
    const useModel = await this.resolveModel(model);
    return await streamOpenAIChatCompletion(
      this.getEndpoint('/chat/completions'),
      this.apiKey,
      {
        model: useModel,
        messages,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      },
      onTextDelta,
      { fetchImpl: this.fetchImpl },
    );
  }

  async fetchModels(): Promise<void> {
    const data = await fetchJson<{ data?: Array<{ id?: string }> }>(
      this.getEndpoint('/models'),
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      'Failed to fetch models',
      { fetchImpl: this.fetchImpl },
    );

    const discovered = (data.data ?? [])
      .map(model => model?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    this.models = [...new Set([...this.models, ...discovered])];
    this.modelsLoaded = true;
    if (!this.defaultModel && this.models.length > 0) this.defaultModel = this.models[0];
  }

  async getModels(): Promise<string[]> {
    if (!this.modelsLoaded) await this.loadModelsIfPossible();
    return this.models;
  }

  isValidModel(model: string): boolean {
    return this.models.includes(model);
  }

  getDefaultModel(): string {
    if (!this.defaultModel && this.models.length === 0) {
      throw new Error('No OpenAI compatible model is configured');
    }
    return this.defaultModel || this.models[0];
  }

  getAvailableModels(): string[] {
    return this.models;
  }

  async analyzeImage(imageUrl: string, prompt: string, model: string): Promise<string> {
    this.requireConfigured();
    // Inlined rather than passed by reference: the configured base URL is an
    // arbitrary third party, and a URL it fetches for us is a URL it sees. A
    // Telegram file URL carries the bot token in its path.
    const image = await inlineImage(imageUrl, this.fetchImpl ?? globalFetch);
    const data = await fetchJson<ChatCompletionResponse>(
      this.getEndpoint('/chat/completions'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: image.dataUrl } },
            ],
          }],
          max_tokens: MAX_ANALYSIS_TOKENS,
        }),
      },
      'OpenAI Compatible image analysis API error',
      { fetchImpl: this.fetchImpl },
    );
    return getFirstChoiceContent(data, 'No content in OpenAI Compatible API response');
  }

  /**
   * Model discovery is an optimisation, not a precondition. When the provider's
   * /models endpoint is unavailable but models are configured, keep serving
   * those rather than failing the user's request.
   */
  private async loadModelsIfPossible(): Promise<void> {
    try {
      await this.fetchModels();
    } catch (error) {
      if (this.models.length === 0) throw error;
      console.error('Model discovery failed; using the configured model list:', error);
      this.modelsLoaded = true;
    }
  }

  private async resolveModel(model?: string): Promise<string> {
    if (!this.modelsLoaded) await this.loadModelsIfPossible();
    const useModel = model || this.defaultModel;
    if (!useModel) throw new Error('No model specified and no default model available');
    return useModel;
  }

  private requireConfigured(): void {
    if (!this.apiKey || !this.baseUrl) throw new Error('OpenAI Compatible API is not configured');
  }

  private getEndpoint(path: string): string {
    return `${this.baseUrl}/v1${path.startsWith('/') ? path : `/${path}`}`;
  }
}

function requireEnvConfig(env?: Env): OpenAICompatibleConfig {
  if (!env) throw new Error('OpenAICompatibleAPI requires an Env or an explicit config.');
  return openAICompatibleConfigFromEnv(env);
}

export default OpenAICompatibleAPI;
