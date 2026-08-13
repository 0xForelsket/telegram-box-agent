export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
  author?: string;
}

export interface SearchResponse {
  provider: string;
  answer?: string;
  sources: SearchSource[];
  query: string;
  searchedAt: string;
  cached?: boolean;
}

export interface ParsedSearchQuery {
  raw: string;
  normalized: string;
  limit: number;
  recencyDays?: number;
  includeDomains: string[];
  excludeDomains: string[];
}

export interface SearchProvider {
  readonly id: string;
  isConfigured(): boolean;
  search(query: ParsedSearchQuery, signal: AbortSignal): Promise<SearchResponse>;
}

export class SearchProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    readonly category: 'auth' | 'quota' | 'timeout' | 'request' | 'upstream' | 'empty' | 'unknown',
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }
}
