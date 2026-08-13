import { Env, getConfig } from '../env';
import { ModelAPIInterface, ModelResponse } from './model_api_interface';
import { ChatCompletionResponse, Message } from './chat_types';
import { fetchJson, getFirstChoiceContent } from '../utils/helpers';

export interface AzureApiConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface AzureApiDependencies {
  config?: AzureApiConfig;
  fetchImpl?: typeof fetch;
}

export function azureConfigFromEnv(env: Env): AzureApiConfig {
  const config = getConfig(env);
  return {
    apiKey: config.azureApiKey,
    baseUrl: config.azureEndpoint,
    models: config.azureModels,
    defaultModel: config.azureModels[0],
  };
}

class AzureAPI implements ModelAPIInterface {
  private apiKey: string;
  private baseUrl: string;
  private models: string[];
  private defaultModel: string;
  private fetchImpl?: typeof fetch;

  constructor(env?: Env, dependencies: AzureApiDependencies = {}) {
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
    const useModel = model || this.defaultModel;
    const url = `${this.baseUrl}/openai/deployments/${useModel}/chat/completions?api-version=2024-02-01`;
    const data = await fetchJson<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify({
        messages: messages,
      }),
    }, 'Azure API error', { fetchImpl: this.fetchImpl });

    return {
      content: getFirstChoiceContent(data, 'Azure API 未生成任何响应'),
      resolvedModel: useModel,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
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

function requireEnvConfig(env?: Env): AzureApiConfig {
  if (!env) throw new Error('AzureAPI requires an Env or an explicit config.');
  return azureConfigFromEnv(env);
}

export default AzureAPI;
