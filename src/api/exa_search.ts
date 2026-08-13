import { Env, getConfig } from '../env';
import { fetchJson } from '../utils/helpers';
import { ParsedSearchQuery, SearchProvider, SearchProviderError, SearchResponse } from '../search/types';

interface ExaSearchResponse {
  requestId: string;
  results: {
    title?: string;
    url: string;
    publishedDate?: string;
    author?: string;
    highlights?: string[];
  }[];
}

class ExaSearchAPI implements SearchProvider {
  readonly id = 'exa';
  private readonly apiKey?: string;
  private static readonly SEARCH_URL = 'https://api.exa.ai/search';

  constructor(env: Env) {
    const config = getConfig(env);
    this.apiKey = config.exaApiKey;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async search(query: ParsedSearchQuery, signal: AbortSignal): Promise<SearchResponse> {
    if (!this.apiKey) {
      throw new SearchProviderError('EXA_API_KEY is not configured', this.id, false, 'auth');
    }

    try {
      const data = await fetchJson<ExaSearchResponse>(ExaSearchAPI.SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        signal,
        body: JSON.stringify({
          query: this.buildProviderQuery(query),
          numResults: query.limit,
          ...(query.recencyDays ? {
            startPublishedDate: new Date(Date.now() - query.recencyDays * 24 * 60 * 60 * 1000).toISOString(),
          } : {}),
          contents: {
            highlights: {
              maxCharacters: 900,
            },
          },
        }),
      }, 'Exa search error');
      return {
        provider: this.id,
        query: query.raw,
        searchedAt: new Date().toISOString(),
        sources: data.results.map(result => ({
          title: result.title?.trim() || result.url,
          url: result.url,
          publishedAt: result.publishedDate,
          author: result.author,
          snippet: (result.highlights || [])
            .map(item => item.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' '),
        })),
      };
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const auth = lower.includes('401') || lower.includes('403') || lower.includes('api key');
      throw new SearchProviderError(
        message,
        this.id,
        !auth,
        auth ? 'auth' : lower.includes('429') || lower.includes('quota') ? 'quota' : 'upstream',
      );
    }
  }

  private buildProviderQuery(query: ParsedSearchQuery): string {
    return [
      query.normalized,
      ...query.includeDomains.map(domain => `site:${domain}`),
      ...query.excludeDomains.map(domain => `-site:${domain}`),
    ].join(' ');
  }
}

export default ExaSearchAPI;
