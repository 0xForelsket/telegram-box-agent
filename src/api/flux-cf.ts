import { Env, getConfig } from '../env';
import { ModelAPIInterface } from './model_api_interface';
import { Message } from './chat_types';
import { fetchJson } from '../utils/helpers';

const FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell';

// Workers AI accepts dimensions rather than a ratio, so the supported ratios
// are enumerated here and everything else falls back to square.
const ASPECT_RATIOS: Record<string, readonly [number, number]> = {
  '1:1': [1024, 1024],
  '1:2': [512, 1024],
  '3:2': [768, 512],
  '3:4': [768, 1024],
  '16:9': [1024, 576],
  '9:16': [576, 1024],
};

const PROMPT_REWRITE_INSTRUCTION = [
  'Rewrite the user request as a single image-generation prompt for a',
  'text-to-image model. Name the subject first, then setting, lighting, colour,',
  'and mood. Prefer concrete visual nouns over abstract description, keep it',
  'under roughly sixty words, and honour any aspect ratio the user mentions.',
  'Reply in English with the prompt alone — no preamble, commentary, or quotes.',
].join(' ');

interface FluxResponse {
  result?: { image?: string };
  success?: boolean;
  errors?: Array<string | { message?: string }>;
}

interface PromptRewriteResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export interface FluxApiConfig {
  apiToken: string;
  accountId: string;
  steps: number;
  promptOptimization: boolean;
  externalApiBase?: string;
  externalModel?: string;
  externalApiKey?: string;
}

export interface FluxApiDependencies {
  config?: FluxApiConfig;
  fetchImpl?: typeof fetch;
  randomSeed?: () => number;
}

export function fluxConfigFromEnv(env: Env): FluxApiConfig {
  const config = getConfig(env);
  return {
    apiToken: config.cloudflareApiToken,
    accountId: config.cloudflareAccountId,
    steps: config.fluxSteps,
    promptOptimization: config.promptOptimization,
    externalApiBase: config.externalApiBase,
    externalModel: config.externalModel,
    externalApiKey: config.externalApiKey,
  };
}

export class FluxAPI implements ModelAPIInterface {
  private readonly config: FluxApiConfig;
  private readonly fetchImpl?: typeof fetch;
  private readonly randomSeed: () => number;

  constructor(env?: Env, dependencies: FluxApiDependencies = {}) {
    this.config = dependencies.config ?? requireEnvConfig(env);
    this.fetchImpl = dependencies.fetchImpl;
    this.randomSeed = dependencies.randomSeed ?? (() => Math.floor(Math.random() * 1_000_000));
  }

  async generateImage(
    prompt: string,
    aspectRatio: string,
  ): Promise<{ imageData: Uint8Array; optimizedPrompt?: string }> {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error('Image prompt is empty.');

    // A rewrite failure must not cost the user their image; fall back to the
    // prompt they actually typed.
    let optimizedPrompt: string | undefined;
    if (this.config.promptOptimization && this.canRewritePrompts()) {
      optimizedPrompt = await this.rewritePrompt(trimmed, aspectRatio).catch(error => {
        console.error('Flux prompt rewrite failed; using the original prompt:', error);
        return undefined;
      });
    }

    const [width, height] = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS['1:1'];
    const data = await fetchJson<FluxResponse>(
      `https://api.cloudflare.com/client/v4/accounts/${this.config.accountId}/ai/run/${FLUX_MODEL}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiToken}`,
        },
        body: JSON.stringify({
          prompt: optimizedPrompt ?? trimmed,
          num_steps: this.config.steps,
          seed: this.randomSeed(),
          width,
          height,
        }),
      },
      'Flux API error',
      { fetchImpl: this.fetchImpl },
    );

    // Workers AI answers 200 with success:false for model-level failures, so an
    // ok status is not on its own proof of an image.
    if (data.success === false) throw new Error(`Flux API error: ${formatErrors(data.errors)}`);
    if (!data.result?.image) throw new Error('Flux API returned no image');

    return { imageData: decodeBase64(data.result.image), optimizedPrompt };
  }

  private canRewritePrompts(): boolean {
    return !!(this.config.externalApiBase && this.config.externalModel && this.config.externalApiKey);
  }

  private async rewritePrompt(prompt: string, aspectRatio: string): Promise<string | undefined> {
    const data = await fetchJson<PromptRewriteResponse>(
      `${this.config.externalApiBase}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.externalApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.externalModel,
          messages: [
            { role: 'system', content: PROMPT_REWRITE_INSTRUCTION },
            { role: 'user', content: `Aspect ratio ${aspectRatio}. Request: ${prompt}` },
          ],
        }),
      },
      'Flux prompt rewrite error',
      { fetchImpl: this.fetchImpl },
    );
    return data.choices?.[0]?.message?.content?.trim() || undefined;
  }

  async generateResponse(_messages: Message[], _model?: string): Promise<string> {
    throw new Error('Method not implemented for image generation.');
  }

  isValidModel(model: string): boolean {
    return model === FLUX_MODEL;
  }

  getDefaultModel(): string {
    return FLUX_MODEL;
  }

  getAvailableModels(): string[] {
    return [FLUX_MODEL];
  }

  getValidAspectRatios(): string[] {
    return Object.keys(ASPECT_RATIOS);
  }
}

function requireEnvConfig(env?: Env): FluxApiConfig {
  if (!env) throw new Error('FluxAPI requires an Env or an explicit config.');
  return fluxConfigFromEnv(env);
}

function formatErrors(errors: FluxResponse['errors']): string {
  if (!errors?.length) return 'Unknown error';
  return errors
    .map(entry => (typeof entry === 'string' ? entry : entry?.message ?? ''))
    .filter(Boolean)
    .join(', ') || 'Unknown error';
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
