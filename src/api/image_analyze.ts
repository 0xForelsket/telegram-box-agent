import { Env, getConfig } from '../env';
import { ModelAPIInterface } from './model_api_interface';
import { ChatCompletionResponse, Message } from './chat_types';
import OpenAICompatibleAPI from './openai_compatible';
import { fetchJson, getFirstChoiceContent, globalFetch } from '../utils/helpers';
import { inlineImage } from './image_payload';

const MAX_ANALYSIS_TOKENS = 300;

interface GeminiImageAnalysisResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string | null }> } }>;
}

export interface ImageAnalysisConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModels: string[];
  googleApiKey: string;
  googleBaseUrl: string;
  googleModels: string[];
}

export interface ImageAnalysisDependencies {
  config?: ImageAnalysisConfig;
  fetchImpl?: typeof fetch;
  openaiCompatible?: OpenAICompatibleAPI;
}

export function imageAnalysisConfigFromEnv(env: Env): ImageAnalysisConfig {
  const config = getConfig(env);
  return {
    openaiApiKey: config.openaiApiKey,
    openaiBaseUrl: config.openaiBaseUrl,
    openaiModels: config.openaiModels,
    googleApiKey: config.googleModelKey,
    googleBaseUrl: config.googleModelBaseUrl,
    googleModels: config.googleModels,
  };
}

class ImageAnalysisAPI implements ModelAPIInterface {
  private readonly config: ImageAnalysisConfig;
  private readonly fetchImpl?: typeof fetch;
  private readonly openaiCompatibleApi: OpenAICompatibleAPI;

  constructor(env?: Env, dependencies: ImageAnalysisDependencies = {}) {
    this.config = dependencies.config ?? requireEnvConfig(env);
    this.fetchImpl = dependencies.fetchImpl;
    this.openaiCompatibleApi = dependencies.openaiCompatible
      ?? new OpenAICompatibleAPI(env, { fetchImpl: dependencies.fetchImpl });
  }

  async analyzeImage(imageUrl: string, prompt: string, model: string): Promise<string> {
    if (this.config.openaiModels.includes(model)) {
      return await this.analyzeWithOpenAI(imageUrl, prompt, model);
    }
    if (this.config.googleModels.includes(model)) {
      return await this.analyzeWithGemini(imageUrl, prompt, model);
    }
    const compatibleModels = await this.openaiCompatibleApi.getModels();
    if (compatibleModels.includes(model)) {
      return await this.openaiCompatibleApi.analyzeImage(imageUrl, prompt, model);
    }
    throw new Error(`Invalid model for image analysis: ${model}`);
  }

  private async analyzeWithOpenAI(imageUrl: string, prompt: string, model: string): Promise<string> {
    // Inlined rather than passed by reference: a URL handed to OpenAI is
    // fetched by OpenAI, which would disclose a Telegram file URL's bot token.
    const image = await this.fetchImageAsBase64(imageUrl);
    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: image.dataUrl } },
      ],
    }];

    const data = await fetchJson<ChatCompletionResponse>(
      `${this.config.openaiBaseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.openaiApiKey}`,
        },
        body: JSON.stringify({ model, messages, max_tokens: MAX_ANALYSIS_TOKENS }),
      },
      'OpenAI image analysis API error',
      { fetchImpl: this.fetchImpl },
    );
    return getFirstChoiceContent(data, 'No content in OpenAI API response');
  }

  private async analyzeWithGemini(imageUrl: string, prompt: string, model: string): Promise<string> {
    const image = await this.fetchImageAsBase64(imageUrl);
    const data = await fetchJson<GeminiImageAnalysisResponse>(
      `${this.config.googleBaseUrl}/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header rather than a ?key= query parameter, which would put the
          // credential into request logs and any intermediary's URL history.
          'x-goog-api-key': this.config.googleApiKey,
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: image.mimeType, data: image.base64 } },
            ],
          }],
        }),
      },
      'Gemini image analysis API error',
      { fetchImpl: this.fetchImpl },
    );

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content?.trim()) throw new Error('No content in Gemini API response');
    return content.trim();
  }

  private async fetchImageAsBase64(imageUrl: string) {
    return await inlineImage(imageUrl, this.fetchImpl ?? globalFetch);
  }

  async generateResponse(_messages: Message[], _model?: string): Promise<string> {
    throw new Error('Method not implemented for image analysis.');
  }

  isValidModel(model: string): boolean {
    return this.config.openaiModels.includes(model)
      || this.config.googleModels.includes(model)
      || this.openaiCompatibleApi.isValidModel(model);
  }

  getDefaultModel(): string {
    return this.config.openaiModels[0]
      || this.config.googleModels[0]
      || this.openaiCompatibleApi.getDefaultModel();
  }

  getAvailableModels(): string[] {
    return [
      ...this.config.openaiModels,
      ...this.config.googleModels,
      ...this.openaiCompatibleApi.getAvailableModels(),
    ];
  }
}

function requireEnvConfig(env?: Env): ImageAnalysisConfig {
  if (!env) throw new Error('ImageAnalysisAPI requires an Env or an explicit config.');
  return imageAnalysisConfigFromEnv(env);
}

export default ImageAnalysisAPI;
