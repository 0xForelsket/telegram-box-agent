import { Env, getConfig } from '../../env';
import { ParsedSearchQuery, SearchProvider, SearchProviderError, SearchResponse, SearchSource } from '../types';

interface OpenAIWebSearchResponse {
  output_text?: string;
  output?: Array<{
    type?: string;
    action?: {
      sources?: Array<{ title?: string; url?: string }>;
    };
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

export class OpenAIWebSearchProvider implements SearchProvider {
  readonly id = 'openai';
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(env: Env) {
    const config = getConfig(env);
    this.apiKey = config.openaiSearchApiKey;
    this.model = config.openaiSearchModel;
  }

  isConfigured(): boolean {
    return !!this.apiKey && !!this.model;
  }

  async search(query: ParsedSearchQuery, signal: AbortSignal): Promise<SearchResponse> {
    if (!this.apiKey) {
      throw new SearchProviderError('OPENAI_SEARCH_API_KEY is not configured', this.id, false, 'auth');
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      signal,
      body: JSON.stringify({
        model: this.model,
        input: this.buildPrompt(query),
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        tool_choice: { type: 'web_search' },
        include: ['web_search_call.action.sources'],
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
        `OpenAI web search error ${response.status}: ${responseText.slice(0, 300)}`,
        this.id,
        retryable,
        category,
      );
    }

    let data: OpenAIWebSearchResponse;
    try {
      data = JSON.parse(responseText) as OpenAIWebSearchResponse;
    } catch {
      throw new SearchProviderError('OpenAI web search returned invalid JSON', this.id, true, 'upstream');
    }

    const answerParts: string[] = [];
    const sources: SearchSource[] = [];
    for (const item of data.output || []) {
      for (const source of item.action?.sources || []) {
        if (source.url) sources.push({ title: source.title || source.url, url: source.url });
      }
      for (const content of item.content || []) {
        if (content.text) answerParts.push(content.text);
        for (const annotation of content.annotations || []) {
          if (annotation.url) sources.push({ title: annotation.title || annotation.url, url: annotation.url });
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
    const directives = [
      query.includeDomains.length > 0 ? `Only use these domains: ${query.includeDomains.join(', ')}.` : '',
      query.excludeDomains.length > 0 ? `Exclude these domains: ${query.excludeDomains.join(', ')}.` : '',
      query.recencyDays ? `Prefer information published in the last ${query.recencyDays} days.` : '',
      `Return no more than ${query.limit} strong sources.`,
    ].filter(Boolean).join(' ');
    return `${query.normalized}\n\n${directives}`;
  }
}
