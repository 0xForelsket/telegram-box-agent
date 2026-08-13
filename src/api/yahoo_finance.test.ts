import { afterEach, describe, expect, it, vi } from 'vitest';
import YahooFinanceAPI from './yahoo_finance';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('YahooFinanceAPI', () => {
  it('uses the public chart endpoint instead of the crumb-protected quote endpoint', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (!url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/AAPL')) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return Response.json({
        chart: {
          result: [{
            meta: {
              symbol: 'AAPL', currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
              instrumentType: 'EQUITY', longName: 'Apple Inc.', regularMarketPrice: 231.42,
              regularMarketTime: 1786564801, chartPreviousClose: 228.1,
              regularMarketDayHigh: 233, regularMarketDayLow: 227.5, regularMarketVolume: 45_000_000,
              fiftyTwoWeekLow: 169.21, fiftyTwoWeekHigh: 260.1,
            },
            indicators: { quote: [{ open: [229], high: [233], low: [227.5], close: [231.42], volume: [45_000_000] }] },
          }],
          error: null,
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new YahooFinanceAPI().lookupStockQuote('AAPL stock');

    expect(result).toContain('Resolved symbol: AAPL');
    expect(result).toContain('Price: $231.42');
    expect(result).toContain('Change: +$3.32');
    expect(result).toContain('Source: Yahoo Finance (Chart)');
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes('/v7/finance/quote'))).toBe(false);
  });

  it('resolves a company name before loading its chart', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.startsWith('https://query2.finance.yahoo.com/v1/finance/search')) {
        return Response.json({ quotes: [{ symbol: 'SIVE.ST', quoteType: 'EQUITY', longname: 'Sivers Semiconductors AB', isYahooFinance: true }] });
      }
      if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/SIVE.ST')) {
        return Response.json({ chart: { result: [{ meta: { symbol: 'SIVE.ST', currency: 'SEK', regularMarketPrice: 6.12 }, indicators: { quote: [{}] } }], error: null } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new YahooFinanceAPI().lookupStockQuote('Sivers Semiconductors');

    expect(result).toContain('Resolved symbol: SIVE.ST');
    expect(result).toContain('SEK\u00a06.12');
  });
});
