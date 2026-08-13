import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertCurrency, getGitHubRepository, getWeather, parseFeed, searchArxiv } from './structured_utilities';

describe('structured utilities', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('geocodes and formats a bounded weather forecast', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ results: [{ name: 'Kuala Lumpur', country: 'Malaysia', latitude: 3.14, longitude: 101.69 }] }))
      .mockResolvedValueOnce(Response.json({
        timezone: 'Asia/Kuala_Lumpur',
        current: { temperature_2m: 31, apparent_temperature: 35, weather_code: 61, wind_speed_10m: 8 },
        daily: { time: ['2026-08-12'], weather_code: [95], temperature_2m_min: [25], temperature_2m_max: [32], precipitation_probability_max: [80] },
      })));
    const result = await getWeather('Kuala Lumpur');
    expect(result).toContain('31°C');
    expect(result).toContain('thunderstorms');
  });

  it('converts currencies using a dated reference rate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([{ date: '2026-08-12', base: 'USD', quote: 'MYR', rate: 4.5 }])));
    await expect(convertCurrency(10, 'usd', 'myr')).resolves.toContain('45 MYR');
  });

  it('parses RSS and Atom-style links without a DOM library', () => {
    const feed = parseFeed(`<?xml version="1.0"?><rss><channel><title>News</title><item><title>One &amp; Two</title><link>https://example.com/1</link><description><![CDATA[Useful <b>summary</b>]]></description></item></channel></rss>`);
    expect(feed.title).toBe('News');
    expect(feed.items[0]).toMatchObject({ title: 'One & Two', url: 'https://example.com/1', summary: 'Useful summary' });
  });

  it('formats GitHub repository metadata from the official API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      full_name: 'owner/repo', description: 'A repo', html_url: 'https://github.com/owner/repo',
      stargazers_count: 10, forks_count: 2, open_issues_count: 1, language: 'TypeScript', default_branch: 'main', pushed_at: '2026-08-12T00:00:00Z',
    })));
    await expect(getGitHubRepository('owner/repo', 'summary')).resolves.toContain('Stars: 10');
  });

  it('parses bounded arXiv Atom entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(`<feed><entry><id>https://arxiv.org/abs/1234.5678</id><published>2026-08-12T00:00:00Z</published><title> Test Paper </title><summary> Result summary </summary><author><name>Alice</name></author></entry></feed>`)));
    const result = await searchArxiv('test');
    expect(result).toContain('Test Paper');
    expect(result).toContain('Alice');
  });
});
