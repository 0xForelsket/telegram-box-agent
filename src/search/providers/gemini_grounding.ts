import { Env, getConfig } from '../../env';
import { ParsedSearchQuery, SearchProvider, SearchProviderError, SearchResponse, SearchSource } from '../types';

interface GeminiInteractionResponse {
  output_text?: string;
  steps?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        title?: string;
        url?: string;
      }>;
    }>;
  }>;
}

/** Official Gemini Interactions API Google Search grounding provider. */
export class GeminiGroundingProvider implements SearchProvider {
  readonly id = 'gemini_grounding';
  private readonly apiKey: string;
  private readonly model: string;

  constructor(env: Env) {
    const config = getConfig(env);
    this.apiKey = config.googleModelKey;
    this.model = config.geminiSearchModel;
  }

  isConfigured(): boolean {
    return !!this.apiKey && !!this.model;
  }

  async search(query: ParsedSearchQuery, signal: AbortSignal): Promise<SearchResponse> {
    if (!this.apiKey) {
      throw new SearchProviderError('GOOGLE_MODEL_KEY is not configured', this.id, false, 'auth');
    }

    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      signal,
      body: JSON.stringify({
        model: this.model,
        input: this.buildPrompt(query),
        tools: [{ type: 'google_search' }],
      }),
    });
    const responseText = await response.text();
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const category = response.status === 401 || response.status === 403
        ? 'auth'
        : response.status === 429
          ? 'quota'
          : response.status >= 500
            ? 'upstream'
            : 'request';
      throw new SearchProviderError(
        `Gemini grounding error ${response.status}: ${responseText.slice(0, 300)}`,
        this.id,
        retryable,
        category,
      );
    }

    let data: GeminiInteractionResponse;
    try {
      data = JSON.parse(responseText) as GeminiInteractionResponse;
    } catch {
      throw new SearchProviderError('Gemini grounding returned invalid JSON', this.id, true, 'upstream');
    }

    const answerParts: string[] = [];
    const sources: SearchSource[] = [];
    for (const step of data.steps || []) {
      if (step.type !== 'model_output') continue;
      for (const block of step.content || []) {
        if (block.text) answerParts.push(block.text);
        for (const annotation of block.annotations || []) {
          if (annotation.type === 'url_citation' && annotation.url) {
            sources.push({ title: annotation.title || annotation.url, url: annotation.url });
          }
        }
      }
    }

    return {
      provider: this.id,
      query: query.raw,
      searchedAt: new Date().toISOString(),
      answer: data.output_text?.trim() || answerParts.join('\n').trim() || undefined,
      sources,
    };
  }

  private buildPrompt(query: ParsedSearchQuery): string {
    return [
      query.normalized,
      query.includeDomains.length > 0 ? `Only use these domains: ${query.includeDomains.join(', ')}.` : '',
      query.excludeDomains.length > 0 ? `Exclude these domains: ${query.excludeDomains.join(', ')}.` : '',
      query.recencyDays ? `Prefer information from the last ${query.recencyDays} days.` : '',
      `Return no more than ${query.limit} high-quality sources.`,
    ].filter(Boolean).join('\n');
  }
}
