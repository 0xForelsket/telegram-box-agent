import { fetchJson } from '../utils/helpers';

interface WikipediaSearchResponse {
  pages?: {
    key: string;
    title: string;
    excerpt?: string;
    description?: string | null;
  }[];
}

interface WikipediaSummaryResponse {
  title?: string;
  description?: string;
  extract?: string;
  content_urls?: {
    desktop?: { page?: string };
  };
  type?: string;
}

class WikipediaAPI {
  private static readonly SEARCH_URL = 'https://en.wikipedia.org/w/rest.php/v1/search/page';
  private static readonly SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';
  private static readonly USER_AGENT = 'Telegram-Box-Agent/0.1 (self-hosted bot)';
  private static readonly MAX_EXTRACT_CHARS = 1400;
  private static readonly SEARCH_LIMIT = 3;

  async lookup(query: string, signal?: AbortSignal): Promise<string> {
    const trimmed = query.trim();
    if (!trimmed) {
      return 'Wikipedia lookup failed: empty query.';
    }

    const searchUrl = `${WikipediaAPI.SEARCH_URL}?q=${encodeURIComponent(trimmed)}&limit=${WikipediaAPI.SEARCH_LIMIT}`;
    const searchData = await fetchJson<WikipediaSearchResponse>(searchUrl, {
      signal,
      headers: {
        'User-Agent': WikipediaAPI.USER_AGENT,
        Accept: 'application/json',
      },
    }, 'Wikipedia search HTTP error');
    const pages = searchData.pages ?? [];
    if (pages.length === 0) {
      return `No Wikipedia results for: ${trimmed}`;
    }

    const top = pages[0];
    const summary = await this.fetchSummary(top.key, signal);

    const lines: string[] = [`Wikipedia lookup for: ${trimmed}`];
    const title = summary?.title || top.title;
    lines.push(`Title: ${title}`);
    if (summary?.description || top.description) {
      lines.push(`Description: ${summary?.description || top.description}`);
    }
    const extract = summary?.extract?.trim();
    if (extract) {
      lines.push(`Extract: ${extract.slice(0, WikipediaAPI.MAX_EXTRACT_CHARS)}`);
    } else if (top.excerpt) {
      lines.push(`Excerpt: ${top.excerpt.replace(/<[^>]+>/g, '')}`);
    }
    const url = summary?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(top.key)}`;
    lines.push(`URL: ${url}`);
    if (summary?.type && summary.type !== 'standard') {
      lines.push(`Note: page type is "${summary.type}" — may be a disambiguation or list page.`);
    }

    if (pages.length > 1) {
      const alternatives = pages
        .slice(1)
        .map(page => `- ${page.title}${page.description ? ` (${page.description})` : ''}`)
        .join('\n');
      lines.push(`Other matches:\n${alternatives}`);
    }

    return lines.join('\n');
  }

  private async fetchSummary(key: string, signal?: AbortSignal): Promise<WikipediaSummaryResponse | null> {
    try {
      return await fetchJson<WikipediaSummaryResponse>(`${WikipediaAPI.SUMMARY_URL}/${encodeURIComponent(key)}`, {
        signal,
        headers: {
          'User-Agent': WikipediaAPI.USER_AGENT,
          Accept: 'application/json',
        },
      }, 'Wikipedia summary fetch failed');
    } catch (error) {
      console.error('Wikipedia summary fetch failed:', error);
      return null;
    }
  }
}

export default WikipediaAPI;
