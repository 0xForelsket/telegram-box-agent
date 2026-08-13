import { Env, getConfig } from '../env';
import { ModelAPIInterface, ModelResponse } from './model_api_interface';
import { Message } from './chat_types';
import { fetchJson } from '../utils/helpers';

export interface ClaudeApiConfig {
  apiKey: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
}

export interface ClaudeApiDependencies {
  config?: ClaudeApiConfig;
  fetchImpl?: typeof fetch;
}

export function claudeConfigFromEnv(env: Env): ClaudeApiConfig {
  const config = getConfig(env);
  return {
    apiKey: config.claudeApiKey,
    baseUrl: config.claudeEndpoint || 'https://api.anthropic.com/v1',
    models: config.claudeModels,
    defaultModel: config.claudeModels[0],
  };
}

class ClaudeAPI implements ModelAPIInterface {
  private apiKey: string;
  private baseUrl: string;
  private models: string[];
  private defaultModel: string;
  private fetchImpl?: typeof fetch;

  constructor(env?: Env, dependencies: ClaudeApiDependencies = {}) {
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
    const url = `${this.baseUrl}/messages`;
    const data = await fetchJson<{
      content: Array<{ text: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: useModel,
        messages: messages.map(msg => ({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content
        })),
        max_tokens: 1000
      }),
    }, 'Claude API error', { fetchImpl: this.fetchImpl });

    if (!data.content || data.content.length === 0) {
      throw new Error('No response generated from Claude API');
    }
    const generatedText = data.content[0].text.trim();
    const promptTokens = data.usage?.input_tokens;
    const completionTokens = data.usage?.output_tokens;
    return {
      content: generatedText,
      resolvedModel: useModel,
      usage: data.usage ? {
        promptTokens,
        completionTokens,
        totalTokens: (promptTokens || 0) + (completionTokens || 0),
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

function requireEnvConfig(env?: Env): ClaudeApiConfig {
  if (!env) throw new Error('ClaudeAPI requires an Env or an explicit config.');
  return claudeConfigFromEnv(env);
}

export default ClaudeAPI;
