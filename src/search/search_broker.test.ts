import { describe, expect, it, vi } from 'vitest';
import { RedisClient } from '../utils/redis';
import { parseSearchQuery } from './query_parser';
import { SearchBroker } from './search_broker';
import { ParsedSearchQuery, SearchProvider, SearchProviderError, SearchResponse } from './types';

function provider(
  id: string,
  implementation: (query: ParsedSearchQuery, signal: AbortSignal) => Promise<SearchResponse>,
): SearchProvider {
  return {
    id,
    isConfigured: () => true,
    search: (query, signal) => implementation(query, signal),
  };
}

function redisMock(initial: string | null = null): RedisClient {
  return {
    get: vi.fn().mockResolvedValue(initial),
    set: vi.fn().mockResolvedValue(undefined),
  } as unknown as RedisClient;
}

describe('SearchBroker', () => {
  it('parses domains, exclusions, recency, and bounded limits', () => {
    expect(parseSearchQuery('chips site:example.com -site:spam.example past 14 days', 99)).toMatchObject({
      normalized: 'chips',
      limit: 8,
      recencyDays: 14,
      includeDomains: ['example.com'],
      excludeDomains: ['spam.example'],
    });
  });

  it('falls back after a retryable failure and normalizes duplicate sources', async () => {
    const attempts: string[] = [];
    const first = provider('first', async () => {
      throw new SearchProviderError('temporary outage', 'first', true, 'upstream');
    });
    const second = provider('second', async query => ({
      provider: 'second',
      query: query.raw,
      searchedAt: '2026-08-12T00:00:00.000Z',
      sources: [
        { title: 'Result', url: 'https://example.com/page?utm_source=test', snippet: '  useful   text ' },
        { title: 'Duplicate', url: 'https://example.com/page' },
        { title: 'Excluded', url: 'https://spam.example/bad' },
      ],
    }));
    const broker = new SearchBroker([first, second], redisMock(), event => attempts.push(`${event.provider}:${event.success}`));

    const result = await broker.search('topic -site:spam.example');
    expect(attempts).toEqual(['first:false', 'second:true']);
    expect(result.sources).toEqual([{ title: 'Result', url: 'https://example.com/page', snippet: 'useful text' }]);
  });

  it('does not retry the same provider after an authentication failure', async () => {
    const first = vi.fn().mockRejectedValue(new SearchProviderError('bad key', 'first', false, 'auth'));
    const broker = new SearchBroker([provider('first', first)], redisMock());

    await expect(broker.search('topic')).rejects.toMatchObject({ category: 'auth' });
    expect(first).toHaveBeenCalledOnce();
  });

  it('uses a matching cached response without calling a provider', async () => {
    const query = parseSearchQuery('stable topic', 4);
    const normalizedQuery = JSON.stringify({
      query: query.normalized.toLowerCase(),
      limit: query.limit,
      includeDomains: [],
      excludeDomains: [],
    });
    const cached = JSON.stringify({
      normalizedQuery,
      response: {
        provider: 'exa',
        query: 'stable topic',
        searchedAt: '2026-08-12T00:00:00.000Z',
        sources: [{ title: 'Cached', url: 'https://example.com/' }],
      },
    });
    const search = vi.fn();
    const broker = new SearchBroker([provider('exa', search)], redisMock(cached));

    const result = await broker.search('stable topic');
    expect(result.cached).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('falls through to a different provider after an authentication failure', async () => {
    const first = vi.fn().mockRejectedValue(new SearchProviderError('bad key', 'first', false, 'auth'));
    const second = vi.fn().mockResolvedValue({
      provider: 'second', query: 'topic', searchedAt: new Date().toISOString(),
      sources: [{ title: 'Result', url: 'https://example.com/result' }],
    });
    const broker = new SearchBroker([provider('first', first), provider('second', second)], redisMock());

    await expect(broker.search('topic')).resolves.toMatchObject({ provider: 'second' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  it('enforces provider-specific monthly caps and falls back', async () => {
    const firstSearch = vi.fn();
    const secondSearch = vi.fn().mockResolvedValue({
      provider: 'second',
      query: 'topic',
      searchedAt: '2026-08-12T00:00:00.000Z',
      sources: [{ title: 'Fallback', url: 'https://example.com/fallback' }],
    });
    const redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      incrWithTTL: vi.fn().mockResolvedValue(1),
      decr: vi.fn().mockResolvedValue(0),
    } as unknown as RedisClient;
    const broker = new SearchBroker(
      [provider('first', firstSearch), provider('second', secondSearch)],
      redis,
      undefined,
      { first: 0, second: 10 },
    );

    const result = await broker.search('topic');
    expect(result.provider).toBe('second');
    expect(firstSearch).not.toHaveBeenCalled();
    expect(secondSearch).toHaveBeenCalledOnce();
  });

  it('aborts a timed-out provider and continues in configured order', async () => {
    vi.useFakeTimers();
    try {
      const slow = provider('slow', async (_query, signal) => await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      }));
      const fallback = vi.fn().mockResolvedValue({
        provider: 'fallback', query: 'topic', searchedAt: '2026-08-12T00:00:00.000Z',
        sources: [{ title: 'Fallback', url: 'https://example.com/fallback' }],
      });
      const search = new SearchBroker([slow, provider('fallback', fallback)], redisMock()).search('topic');
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(search).resolves.toMatchObject({ provider: 'fallback' });
      expect(fallback).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never exceeds the configured provider-attempt budget', async () => {
    const calls = Array.from({ length: 5 }, () => vi.fn().mockRejectedValue(new SearchProviderError('down', 'test', true, 'upstream')));
    const broker = new SearchBroker(calls.map((call, index) => provider(`p${index}`, call)), redisMock());

    await expect(broker.search('topic')).rejects.toThrow('down');
    expect(calls.filter(call => call.mock.calls.length > 0)).toHaveLength(3);
    expect(calls[3]).not.toHaveBeenCalled();
    expect(calls[4]).not.toHaveBeenCalled();
  });
});
