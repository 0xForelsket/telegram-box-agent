import { Env, getConfig } from '../env';
import { ModelAPIInterface } from './model_api_interface';
import { Message } from './chat_types';
import { fetchJson } from '../utils/helpers';

const VALID_SIZES = ['1024x1024', '1024x1792', '1792x1024'] as const;

interface ImageGenerationResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
}

export interface ImageGenerationConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ImageGenerationDependencies {
  config?: ImageGenerationConfig;
  fetchImpl?: typeof fetch;
}

export function imageGenerationConfigFromEnv(env: Env): ImageGenerationConfig {
  const config = getConfig(env);
  return {
    apiKey: config.openaiApiKey,
    baseUrl: config.openaiBaseUrl,
    model: config.dallEModel,
  };
}

export class ImageGenerationAPI implements ModelAPIInterface {
  private readonly config: ImageGenerationConfig;
  private readonly fetchImpl?: typeof fetch;

  constructor(env?: Env, dependencies: ImageGenerationDependencies = {}) {
    this.config = dependencies.config ?? requireEnvConfig(env);
    this.fetchImpl = dependencies.fetchImpl;
  }

  async generateImage(prompt: string, size: string): Promise<string> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error('Image prompt is empty.');
    if (!this.getValidSizes().includes(size)) {
      throw new Error(`Unsupported image size: ${size}. Expected one of ${this.getValidSizes().join(', ')}.`);
    }

    const data = await fetchJson<ImageGenerationResponse>(
      `${this.config.baseUrl}/images/generations`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.config.model, prompt: trimmed, n: 1, size }),
      },
      'Image generation API error',
      { fetchImpl: this.fetchImpl },
    );

    // Previously indexed data[0].url blindly, which surfaced a TypeError rather
    // than a usable message whenever the provider returned an empty payload.
    const url = data.data?.[0]?.url;
    if (!url) throw new Error('Image generation API returned no image URL');
    return url;
  }

  async generateResponse(_messages: Message[], _model?: string): Promise<string> {
    throw new Error('Method not implemented for image generation.');
  }

  isValidModel(model: string): boolean {
    return model === this.config.model;
  }

  getDefaultModel(): string {
    return this.config.model;
  }

  getAvailableModels(): string[] {
    return [this.config.model];
  }

  getValidSizes(): string[] {
    return [...VALID_SIZES];
  }
}

function requireEnvConfig(env?: Env): ImageGenerationConfig {
  if (!env) throw new Error('ImageGenerationAPI requires an Env or an explicit config.');
  return imageGenerationConfigFromEnv(env);
}
