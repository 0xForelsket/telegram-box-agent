import { RUNTIME_BUDGETS } from '../config/runtime_budgets';
import { ParsedSearchQuery } from './types';

export function parseSearchQuery(rawQuery: string, requestedLimit = 4): ParsedSearchQuery {
  const raw = rawQuery.trim().replace(/\s+/g, ' ');
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];

  for (const match of raw.matchAll(/(^|\s)(-?)site:([^\s]+)/gi)) {
    const domain = normalizeDomain(match[3]);
    if (!domain) continue;
    (match[2] ? excludeDomains : includeDomains).push(domain);
  }

  const recencyMatch = raw.match(/\b(?:past|last)\s+(\d{1,3})\s+days?\b/i);
  const normalized = raw
    .replace(/(^|\s)-?site:[^\s]+/gi, ' ')
    .replace(/\b(?:past|last)\s+\d{1,3}\s+days?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    raw,
    normalized: normalized || raw,
    limit: Math.max(1, Math.min(requestedLimit, RUNTIME_BUDGETS.maxSources)),
    recencyDays: recencyMatch ? Math.max(1, Math.min(Number(recencyMatch[1]), 365)) : undefined,
    includeDomains: [...new Set(includeDomains)],
    excludeDomains: [...new Set(excludeDomains)],
  };
}

function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/[^a-z0-9.-]/g, '');
}
