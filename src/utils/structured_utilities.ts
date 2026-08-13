import { URLReader } from '../web/url_reader';

const weatherLabels: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'heavy showers', 82: 'violent showers', 95: 'thunderstorms',
};

export async function getWeather(location: string, signal?: AbortSignal): Promise<string> {
  if (location.trim().length < 2) throw new Error('Provide a city or postal code.');
  const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geocodeUrl.search = new URLSearchParams({ name: location.trim(), count: '1', format: 'json', language: 'en' }).toString();
  const geocode = await fetchJson<{ results?: Array<{
    name: string; latitude: number; longitude: number; timezone?: string; country?: string; admin1?: string;
  }> }>(geocodeUrl, signal);
  const place = geocode.results?.[0];
  if (!place) throw new Error(`No weather location matched “${location.trim()}”.`);

  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
  forecastUrl.search = new URLSearchParams({
    latitude: String(place.latitude), longitude: String(place.longitude), timezone: 'auto', forecast_days: '3',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  }).toString();
  const forecast = await fetchJson<{
    timezone?: string;
    current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number };
    daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] };
  }>(forecastUrl, signal);
  const current = forecast.current || {};
  const label = weatherLabels[current.weather_code ?? -1] || `weather code ${current.weather_code ?? '?'}`;
  const placeLabel = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const lines = [
    `Weather for ${placeLabel}`,
    `Now: ${formatValue(current.temperature_2m, '°C')}, feels like ${formatValue(current.apparent_temperature, '°C')}, ${label}, wind ${formatValue(current.wind_speed_10m, ' km/h')}`,
  ];
  for (let index = 0; index < Math.min(3, forecast.daily?.time?.length || 0); index++) {
    const code = forecast.daily?.weather_code?.[index] ?? -1;
    lines.push(`${forecast.daily?.time?.[index]}: ${weatherLabels[code] || `weather code ${code}`}, ${formatValue(forecast.daily?.temperature_2m_min?.[index], '°C')}–${formatValue(forecast.daily?.temperature_2m_max?.[index], '°C')}, rain ${formatValue(forecast.daily?.precipitation_probability_max?.[index], '%')}`);
  }
  if (forecast.timezone) lines.push(`Timezone: ${forecast.timezone}`);
  return lines.join('\n');
}

export async function convertCurrency(amount: number, from: string, to: string, signal?: AbortSignal): Promise<string> {
  if (!Number.isFinite(amount)) throw new Error('Invalid amount.');
  const base = from.trim().toUpperCase();
  const quote = to.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) throw new Error('Use three-letter currency codes, for example USD or MYR.');
  if (base === quote) return `${amount} ${base} = ${amount} ${quote}`;
  const url = new URL('https://api.frankfurter.dev/v2/rates');
  url.search = new URLSearchParams({ base, quotes: quote }).toString();
  const rates = await fetchJson<Array<{ date: string; base: string; quote: string; rate: number }>>(url, signal);
  const rate = rates.find(item => item.base === base && item.quote === quote);
  if (!rate || !Number.isFinite(rate.rate)) throw new Error(`No reference rate available for ${base}/${quote}.`);
  return `${amount} ${base} = ${Number((amount * rate.rate).toPrecision(12))} ${quote}\nReference rate: 1 ${base} = ${rate.rate} ${quote} (${rate.date})`;
}

export interface FeedItem { title: string; url?: string; publishedAt?: string; summary?: string }

export async function readFeed(rawUrl: string, limit = 5, signal?: AbortSignal): Promise<{ title?: string; items: FeedItem[] }> {
  const page = await new URLReader().read(rawUrl, signal);
  if (!['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'text/plain'].includes(page.contentType)) {
    throw new Error(`URL is not an RSS/Atom feed (${page.contentType}).`);
  }
  return parseFeed(page.text, Math.max(1, Math.min(10, limit)));
}

export function parseFeed(xml: string, limit = 5): { title?: string; items: FeedItem[] } {
  const entries = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0, limit);
  const items = entries.map(match => {
    const body = match[2];
    const title = textTag(body, 'title') || 'Untitled item';
    const linkTag = body.match(/<link\b([^>]*)>([\s\S]*?)<\/link>/i);
    const linkSelf = body.match(/<link\b([^>]*)\/?\s*>/i);
    const attributes = linkTag?.[1] || linkSelf?.[1] || '';
    const href = attributes.match(/href=["']([^"']+)["']/i)?.[1];
    const summary = textTag(body, 'description') || textTag(body, 'summary') || textTag(body, 'content');
    return {
      title,
      url: decodeEntities(href || stripTags(linkTag?.[2] || '')).trim() || undefined,
      publishedAt: textTag(body, 'pubDate') || textTag(body, 'published') || textTag(body, 'updated') || undefined,
      summary: summary ? stripTags(summary).replace(/\s+/g, ' ').trim().slice(0, 300) : undefined,
    };
  });
  if (items.length === 0) throw new Error('No RSS or Atom entries found.');
  const feedWithoutEntries = xml.replace(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return { title: textTag(feedWithoutEntries, 'title') || undefined, items };
}

export function formatFeed(feed: { title?: string; items: FeedItem[] }): string {
  return [
    feed.title ? `Feed: ${feed.title}` : 'Feed updates',
    ...feed.items.map((item, index) => [
      `${index + 1}. ${item.title}`,
      item.publishedAt || '', item.summary || '', item.url || '',
    ].filter(Boolean).join('\n')),
  ].join('\n\n');
}

export async function getGitHubRepository(repo: string, view: 'summary' | 'releases' | 'issues', token?: string, signal?: AbortSignal): Promise<string> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Use a repository in owner/name format.');
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'Telegram-Box-Agent', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (view === 'releases') {
    const releases = await fetchJson<Array<{ name?: string; tag_name: string; published_at?: string; html_url: string }>>(`https://api.github.com/repos/${repo}/releases?per_page=5`, signal, headers);
    return [`Latest releases for ${repo}`, ...releases.map(item => `- ${item.name || item.tag_name} (${item.published_at?.slice(0, 10) || 'undated'})\n  ${item.html_url}`)].join('\n');
  }
  if (view === 'issues') {
    const issues = await fetchJson<Array<{ title: string; number: number; html_url: string; pull_request?: unknown }>>(`https://api.github.com/repos/${repo}/issues?state=open&per_page=10`, signal, headers);
    return [`Open issues for ${repo}`, ...issues.filter(item => !item.pull_request).slice(0, 5).map(item => `- #${item.number} ${item.title}\n  ${item.html_url}`)].join('\n');
  }
  const data = await fetchJson<{ full_name: string; description?: string; html_url: string; stargazers_count: number; forks_count: number; open_issues_count: number; language?: string; default_branch: string; pushed_at?: string }>(`https://api.github.com/repos/${repo}`, signal, headers);
  return [data.full_name, data.description || 'No description.', `Stars: ${data.stargazers_count} | Forks: ${data.forks_count} | Open issues: ${data.open_issues_count}`, `Language: ${data.language || 'n/a'} | Default branch: ${data.default_branch}`, `Last push: ${data.pushed_at || 'n/a'}`, data.html_url].join('\n');
}

export async function searchArxiv(query: string, limit = 5, signal?: AbortSignal): Promise<string> {
  if (!query.trim()) throw new Error('Provide an arXiv search query.');
  const url = new URL('https://export.arxiv.org/api/query');
  url.search = new URLSearchParams({ search_query: `all:${query.trim()}`, start: '0', max_results: String(Math.max(1, Math.min(10, limit))), sortBy: 'submittedDate', sortOrder: 'descending' }).toString();
  const response = await fetch(url, { signal, headers: { 'User-Agent': 'Telegram-Box-Agent/0.1 (self-hosted bot)' } });
  if (!response.ok) throw new Error(`arXiv returned HTTP ${response.status}.`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  if (entries.length === 0) throw new Error('No arXiv papers matched.');
  return entries.map((match, index) => {
    const body = match[1];
    const title = textTag(body, 'title')?.replace(/\s+/g, ' ').trim() || 'Untitled';
    const id = textTag(body, 'id') || '';
    const published = textTag(body, 'published')?.slice(0, 10) || 'undated';
    const authors = [...body.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map(author => stripTags(author[1])).slice(0, 4).join(', ');
    const summary = stripTags(textTag(body, 'summary') || '').replace(/\s+/g, ' ').trim().slice(0, 350);
    return `${index + 1}. ${title}\n${authors || 'Unknown authors'} — ${published}\n${summary}\n${id}`;
  }).join('\n\n');
}

async function fetchJson<T>(url: URL | string, signal?: AbortSignal, headers?: Record<string, string>): Promise<T> {
  const response = await fetch(url, { signal, headers });
  if (!response.ok) throw new Error(`Upstream API returned HTTP ${response.status}.`);
  return await response.json() as T;
}

function formatValue(value: number | undefined, suffix: string): string {
  return Number.isFinite(value) ? `${value}${suffix}` : 'n/a';
}

function textTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim() : null;
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ' '));
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    }
    return named[entity.toLowerCase()] || ' ';
  });
}
