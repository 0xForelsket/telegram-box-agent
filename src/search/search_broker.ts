import { RUNTIME_BUDGETS } from '../config/runtime_budgets';
import { RedisClient } from '../utils/redis';
import { parseSearchQuery } from './query_parser';
import { ParsedSearchQuery, SearchProvider, SearchProviderError, SearchResponse, SearchSource } from './types';

export interface SearchAttemptEvent {
  provider: string;
  success: boolean;
  latencyMs: number;
  category?: SearchProviderError['category'];
  fallback: boolean;
}

interface CachedSearchRecord {
  normalizedQuery: string;
  response: SearchResponse;
}

export class SearchBroker {
  private static readonly PROVIDER_TIMEOUT_MS = 15_000;

  constructor(
    private readonly providers: SearchProvider[],
    private readonly redis: RedisClient,
    private readonly onAttempt?: (event: SearchAttemptEvent) => void,
    private readonly providerMonthlyCaps: Record<string, number> = {},
    // The month a quota rolls over in has to match the one `/status` reports,
    // so both read the deployment's configured zone rather than a fixed one.
    private readonly timezone: string = 'UTC',
  ) {}

  isConfigured(): boolean {
    return this.providers.some(provider => provider.isConfigured());
  }

  async search(rawQuery: string, requestedLimit = 4): Promise<SearchResponse> {
    const query = parseSearchQuery(rawQuery, requestedLimit);
    const cached = await this.readCache(query);
    if (cached) {
      return { ...cached, cached: true };
    }

    const configuredProviders = this.providers
      .filter(provider => provider.isConfigured())
      .slice(0, RUNTIME_BUDGETS.maxSearchAttempts);
    if (configuredProviders.length === 0) {
      throw new SearchProviderError('No search provider is configured', 'broker', false, 'auth');
    }

    let lastError: unknown;
    for (const [index, provider] of configuredProviders.entries()) {
      const startedAt = Date.now();
      const reserved = await this.reserveProviderAttempt(provider.id);
      if (!reserved) {
        const quotaError = new SearchProviderError(
          `Monthly search cap reached for provider: ${provider.id}`,
          provider.id,
          true,
          'quota',
        );
        lastError = quotaError;
        this.onAttempt?.({ provider: provider.id, success: false, latencyMs: 0, category: 'quota', fallback: index > 0 });
        continue;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SearchBroker.PROVIDER_TIMEOUT_MS);
      try {
        const response = this.normalizeResponse(await provider.search(query, controller.signal), query, provider.id);
        if (response.sources.length === 0 && !response.answer) {
          throw new SearchProviderError('Search provider returned no usable results', provider.id, true, 'empty');
        }
        this.onAttempt?.({ provider: provider.id, success: true, latencyMs: Date.now() - startedAt, fallback: index > 0 });
        await this.writeCache(query, response);
        return response;
      } catch (error) {
        await this.refundProviderAttempt(provider.id);
        const normalizedError = this.normalizeError(error, provider.id, controller.signal.aborted);
        lastError = normalizedError;
        this.onAttempt?.({
          provider: provider.id,
          success: false,
          latencyMs: Date.now() - startedAt,
          category: normalizedError.category,
          fallback: index > 0,
        });
        // A non-retryable error is not retried against this provider, but a
        // different configured provider may still be healthy and authorized.
        if (!normalizedError.retryable && index === configuredProviders.length - 1) throw normalizedError;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All search providers failed');
  }

  private async reserveProviderAttempt(provider: string): Promise<boolean> {
    const cap = this.providerMonthlyCaps[provider];
    if (cap === undefined) return true;
    if (cap <= 0) return false;

    const month = this.getCurrentMonth();
    const legacyBaseline = provider === 'exa'
      ? Number.parseInt((await this.redis.get(`web_search_usage:${month}`)) || '0', 10) || 0
      : 0;
    const newCount = await this.redis.incrWithTTL(
      this.getProviderUsageKey(provider, month),
      35 * 24 * 60 * 60,
    );
    if (legacyBaseline + newCount <= cap) return true;
    await this.redis.decr(this.getProviderUsageKey(provider, month));
    return false;
  }

  private async refundProviderAttempt(provider: string): Promise<void> {
    if (this.providerMonthlyCaps[provider] === undefined) return;
    try {
      await this.redis.decr(this.getProviderUsageKey(provider, this.getCurrentMonth()));
    } catch (error) {
      console.error(`Failed to refund search reservation for ${provider}:`, error);
    }
  }

  private getCurrentMonth(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
  }

  private getProviderUsageKey(provider: string, month: string): string {
    return `search_usage:v1:${provider}:${month}`;
  }

  private normalizeResponse(response: SearchResponse, query: ParsedSearchQuery, provider: string): SearchResponse {
    const seen = new Set<string>();
    const sources: SearchSource[] = [];
    for (const source of response.sources) {
      const canonicalUrl = this.canonicalizeUrl(source.url);
      if (!canonicalUrl || seen.has(canonicalUrl)) continue;
      if (query.excludeDomains.some(domain => this.urlMatchesDomain(canonicalUrl, domain))) continue;
      if (query.includeDomains.length > 0 && !query.includeDomains.some(domain => this.urlMatchesDomain(canonicalUrl, domain))) continue;
      seen.add(canonicalUrl);
      sources.push({
        ...source,
        title: source.title.trim() || canonicalUrl,
        url: canonicalUrl,
        snippet: source.snippet?.replace(/\s+/g, ' ').trim(),
      });
      if (sources.length >= query.limit) break;
    }

    return {
      provider,
      answer: response.answer?.trim() || undefined,
      sources,
      query: query.raw,
      searchedAt: response.searchedAt || new Date().toISOString(),
    };
  }

  private normalizeError(error: unknown, provider: string, timedOut: boolean): SearchProviderError {
    if (error instanceof SearchProviderError) return error;
    if (timedOut) return new SearchProviderError('Search provider timed out', provider, true, 'timeout');
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes('401') || lower.includes('403') || lower.includes('api key')) {
      return new SearchProviderError(message, provider, false, 'auth');
    }
    if (lower.includes('400') || lower.includes('invalid')) {
      return new SearchProviderError(message, provider, false, 'request');
    }
    if (lower.includes('429') || lower.includes('quota') || lower.includes('rate limit')) {
      return new SearchProviderError(message, provider, true, 'quota');
    }
    return new SearchProviderError(message, provider, true, 'upstream');
  }

  private async readCache(query: ParsedSearchQuery): Promise<SearchResponse | null> {
    if (!this.isCacheable(query.raw)) return null;
    try {
      const raw = await this.redis.get(this.getCacheKey(query));
      if (!raw) return null;
      const record = JSON.parse(raw) as CachedSearchRecord;
      return record.normalizedQuery === this.cacheIdentity(query) ? record.response : null;
    } catch (error) {
      console.error('Failed to read search cache:', error);
      return null;
    }
  }

  private async writeCache(query: ParsedSearchQuery, response: SearchResponse): Promise<void> {
    if (!this.isCacheable(query.raw)) return;
    try {
      await this.redis.set(
        this.getCacheKey(query),
        JSON.stringify({ normalizedQuery: this.cacheIdentity(query), response } satisfies CachedSearchRecord),
        this.getCacheTTL(query.raw),
      );
    } catch (error) {
      console.error('Failed to write search cache:', error);
    }
  }

  private getCacheTTL(query: string): number {
    if (/\b(now|live|breaking|score|price|weather)\b/i.test(query)) return 5 * 60;
    if (/\b(today|latest|current|recent|news)\b/i.test(query)) return 60 * 60;
    return 6 * 60 * 60;
  }

  private isCacheable(query: string): boolean {
    return !/\b(password|passcode|token|secret|private|my email|my account)\b/i.test(query);
  }

  private getCacheKey(query: ParsedSearchQuery): string {
    return `search_cache:v1:${this.hash(this.cacheIdentity(query))}`;
  }

  private cacheIdentity(query: ParsedSearchQuery): string {
    return JSON.stringify({
      query: query.normalized.toLowerCase(),
      limit: query.limit,
      recencyDays: query.recencyDays,
      includeDomains: query.includeDomains,
      excludeDomains: query.excludeDomains,
    });
  }

  private hash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  private canonicalizeUrl(rawUrl: string): string | null {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      url.hash = '';
      for (const parameter of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$)/i.test(parameter)) url.searchParams.delete(parameter);
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  private urlMatchesDomain(rawUrl: string, domain: string): boolean {
    const hostname = new URL(rawUrl).hostname.replace(/^www\./, '').toLowerCase();
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }
}

export function formatSearchResponseForModel(response: SearchResponse, maxChars = 5_000): string {
  if (response.sources.length === 0 && response.answer) {
    return `Web search answer for: ${response.query}\nProvider: ${response.provider}\n\n${response.answer}`.slice(0, maxChars);
  }
  const chunks = [`Web search results for: ${response.query}`, `Provider: ${response.provider}${response.cached ? ' (cached)' : ''}`];
  if (response.answer) chunks.push(`Provider answer: ${response.answer}`);
  for (const [index, source] of response.sources.entries()) {
    chunks.push([
      `${index + 1}. ${source.title}`,
      `URL: ${source.url}`,
      source.publishedAt ? `Published: ${source.publishedAt}` : '',
      source.author ? `Author: ${source.author}` : '',
      source.snippet ? `Summary: ${source.snippet}` : '',
    ].filter(Boolean).join('\n'));
  }
  return chunks.join('\n\n').slice(0, maxChars);
}
