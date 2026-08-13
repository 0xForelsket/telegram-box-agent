import { Env, getConfig } from '../env';
import { ModelAPIInterface, ModelResponse } from './model_api_interface';
import { fetchJson, getFirstChoiceContent } from '../utils/helpers';
import { ChatCompletionResponse, Message, ToolChoice, ToolDefinition } from './chat_types';
import { streamOpenAIChatCompletion } from './openai_chat_stream';

export interface OpenAIApiConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface OpenAIApiDependencies {
  config?: OpenAIApiConfig;
  fetchImpl?: typeof fetch;
}

export function openAIConfigFromEnv(env: Env): OpenAIApiConfig {
  const config = getConfig(env);
  return {
    apiKey: config.openaiApiKey,
    baseUrl: config.openaiBaseUrl,
    models: config.openaiModels,
    defaultModel: config.defaultModel || config.openaiModels[0],
  };
}

class OpenAIAPI implements ModelAPIInterface {
  private apiKey: string;
  private baseUrl: string;
  private models: string[];
  private defaultModel: string;
  private fetchImpl?: typeof fetch;

  constructor(env?: Env, dependencies: OpenAIApiDependencies = {}) {
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
    const data = await this.createChatCompletion(messages, model);
    return {
      content: getFirstChoiceContent(data, 'No response generated from OpenAI API'),
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
    options: {
      tools?: ToolDefinition[];
      toolChoice?: ToolChoice;
    } = {},
  ): Promise<ChatCompletionResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    return await fetchJson<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: model || this.defaultModel,
        messages,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      }),
    }, 'OpenAI API error', { fetchImpl: this.fetchImpl });
  }

  async createStreamingChatCompletion(
    messages: Message[],
    model: string | undefined,
    options: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
    onTextDelta: (delta: string) => Promise<void>,
  ): Promise<ChatCompletionResponse> {
    return await streamOpenAIChatCompletion(
      `${this.baseUrl}/chat/completions`,
      this.apiKey,
      {
        model: model || this.defaultModel,
        messages,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      },
      onTextDelta,
      { fetchImpl: this.fetchImpl },
    );
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

function requireEnvConfig(env?: Env): OpenAIApiConfig {
  if (!env) throw new Error('OpenAIAPI requires an Env or an explicit config.');
  return openAIConfigFromEnv(env);
}

export default OpenAIAPI;
