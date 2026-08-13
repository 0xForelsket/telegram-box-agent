import { Env, getConfig } from '../env';
import { ModelAPIInterface, ModelResponse } from './model_api_interface';
import { ChatCompletionResponse, Message } from './chat_types';
import { fetchJson, getFirstChoiceContent } from '../utils/helpers';

export interface GroqApiConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface GroqApiDependencies {
  config?: GroqApiConfig;
  fetchImpl?: typeof fetch;
}

export function groqConfigFromEnv(env: Env): GroqApiConfig {
  const config = getConfig(env);
  return {
    apiKey: config.groqApiKey,
    baseUrl: 'https://api.groq.com/openai/v1',
    models: config.groqModels,
    defaultModel: config.groqModels[0],
  };
}

class GroqAPI implements ModelAPIInterface {
  private apiKey: string;
  private baseUrl: string;
  private models: string[];
  private defaultModel: string;
  private fetchImpl?: typeof fetch;

  constructor(env?: Env, dependencies: GroqApiDependencies = {}) {
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
    const url = `${this.baseUrl}/chat/completions`;
    const data = await fetchJson<ChatCompletionResponse>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: messages,
      }),
    }, 'Groq API error', { fetchImpl: this.fetchImpl });

    return {
      content: getFirstChoiceContent(data, 'No response generated from Groq API'),
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

function requireEnvConfig(env?: Env): GroqApiConfig {
  if (!env) throw new Error('GroqAPI requires an Env or an explicit config.');
  return groqConfigFromEnv(env);
}

export default GroqAPI;
