import { fetchJson } from '../utils/helpers';

interface YahooSearchQuote {
  symbol: string;
  quoteType?: string;
  shortname?: string;
  longname?: string;
  exchange?: string;
  exchDisp?: string;
  score?: number;
  isYahooFinance?: boolean;
}

interface YahooQuote {
  symbol?: string;
  quoteType?: string;
  shortName?: string;
  longName?: string;
  exchange?: string;
  fullExchangeName?: string;
  currency?: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketPreviousClose?: number;
  regularMarketOpen?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number | string | Date;
  marketCap?: number;
  fiftyTwoWeekLow?: number;
  fiftyTwoWeekHigh?: number;
  trailingPE?: number;
  forwardPE?: number;
  quoteSourceName?: string;
  marketState?: string;
}

interface YahooSearchResponse {
  quotes?: YahooSearchQuote[];
}

interface YahooChartMeta {
  symbol?: string;
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketVolume?: number;
  chartPreviousClose?: number;
  fiftyTwoWeekLow?: number;
  fiftyTwoWeekHigh?: number;
  longName?: string;
  shortName?: string;
}

interface YahooChartQuote {
  open?: Array<number | null>;
  high?: Array<number | null>;
  low?: Array<number | null>;
  close?: Array<number | null>;
  volume?: Array<number | null>;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: YahooChartMeta;
      timestamp?: number[];
      indicators?: { quote?: YahooChartQuote[] };
    }>;
    error?: { code?: string; description?: string } | null;
  };
}

class YahooFinanceAPI {
  async lookupStockQuote(query: string): Promise<string> {
    const symbol = await this.resolveSymbol(query);
    const quote = await this.fetchQuote(symbol);

    if (!this.isFiniteNumber(quote.regularMarketPrice)) {
      throw new Error(`Yahoo Finance did not return a usable quote for ${symbol}`);
    }

    return this.formatQuote(quote, query);
  }

  private async resolveSymbol(query: string): Promise<string> {
    const directTicker = this.extractTickerCandidate(query);
    if (directTicker) {
      return directTicker.toUpperCase();
    }

    const searchQuery = this.buildSearchQuery(query);
    const results = await fetchJson<YahooSearchResponse>(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchQuery)}&quotesCount=6&newsCount=0`,
      {},
      'Yahoo Finance search error',
    );
    const quotes = (results.quotes || []) as YahooSearchQuote[];
    const bestMatch = this.pickBestSearchResult(searchQuery, quotes);
    if (!bestMatch?.symbol) {
      throw new Error(`No Yahoo Finance symbol found for "${searchQuery}"`);
    }

    return bestMatch.symbol;
  }

  private async fetchQuote(symbol: string): Promise<YahooQuote> {
    // Yahoo's old /v7/finance/quote endpoint now requires a cookie/crumb and
    // returns HTTP 401 to server-side clients. The chart endpoint remains a
    // public, keyless source for the same current-price fields.
    const data = await fetchJson<YahooChartResponse>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d&includePrePost=false`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Telegram-Box-Agent/0.1',
        },
      },
      'Yahoo Finance chart error',
    );
    const result = data.chart?.result?.[0];
    const meta = result?.meta;
    if (!result || !meta) {
      const reason = data.chart?.error?.description || data.chart?.error?.code;
      throw new Error(reason || `Yahoo Finance returned no quote for ${symbol}`);
    }

    const candle = result.indicators?.quote?.[0];
    const latestIndex = this.findLatestCandleIndex(candle);
    const price = meta.regularMarketPrice ?? this.valueAt(candle?.close, latestIndex);
    if (!this.isFiniteNumber(price)) {
      throw new Error(`Yahoo Finance returned no quote for ${symbol}`);
    }
    const previousClose = meta.chartPreviousClose;
    const change = this.isFiniteNumber(previousClose) ? price - previousClose : undefined;
    const changePercent = this.isFiniteNumber(previousClose) && previousClose !== 0
      ? change! / previousClose * 100
      : undefined;

    return {
      symbol: meta.symbol || symbol,
      quoteType: meta.instrumentType,
      shortName: meta.shortName,
      longName: meta.longName,
      exchange: meta.exchangeName,
      fullExchangeName: meta.fullExchangeName,
      currency: meta.currency,
      regularMarketPrice: price,
      regularMarketChange: change,
      regularMarketChangePercent: changePercent,
      regularMarketPreviousClose: previousClose,
      regularMarketOpen: this.valueAt(candle?.open, latestIndex),
      regularMarketDayHigh: meta.regularMarketDayHigh ?? this.valueAt(candle?.high, latestIndex),
      regularMarketDayLow: meta.regularMarketDayLow ?? this.valueAt(candle?.low, latestIndex),
      regularMarketVolume: meta.regularMarketVolume ?? this.valueAt(candle?.volume, latestIndex),
      regularMarketTime: meta.regularMarketTime,
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
      quoteSourceName: 'Chart',
    };
  }

  private findLatestCandleIndex(candle?: YahooChartQuote): number {
    const lengths = [candle?.close?.length, candle?.open?.length, candle?.volume?.length]
      .filter((length): length is number => typeof length === 'number');
    const maxLength = lengths.length > 0 ? Math.max(...lengths) : 0;
    for (let index = maxLength - 1; index >= 0; index--) {
      if (this.isFiniteNumber(candle?.close?.[index]) || this.isFiniteNumber(candle?.open?.[index])) {
        return index;
      }
    }
    return -1;
  }

  private valueAt(values: Array<number | null> | undefined, index: number): number | undefined {
    const value = index >= 0 ? values?.[index] : undefined;
    return this.isFiniteNumber(value) ? value : undefined;
  }

  private buildSearchQuery(query: string): string {
    return query
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/@\w+/g, ' ')
      .replace(/\b(?:stock|stocks|share|shares|price|prices|quote|ticker|market cap|latest|current|recent|recently|today|now|look at|check|why|have|has|did|do|does|they|them|their|theirs|it|its|this|that|so much|pumped|pump)\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim() || query.trim();
  }

  private pickBestSearchResult(query: string, quotes: YahooSearchQuote[]): YahooSearchQuote | null {
    const yahooQuotes = quotes.filter(quote =>
      quote.isYahooFinance !== false &&
      ['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes((quote.quoteType || '').toUpperCase()),
    );
    if (yahooQuotes.length === 0) {
      return null;
    }

    const normalizedQuery = query.trim().toUpperCase();
    return [...yahooQuotes].sort((left, right) =>
      this.scoreSearchResult(right, normalizedQuery) - this.scoreSearchResult(left, normalizedQuery),
    )[0] || null;
  }

  private scoreSearchResult(result: YahooSearchQuote, normalizedQuery: string): number {
    let score = 0;
    const symbol = result.symbol.toUpperCase();
    const shortName = (result.shortname || '').toUpperCase();
    const longName = (result.longname || '').toUpperCase();
    const quoteType = (result.quoteType || '').toUpperCase();

    if (symbol === normalizedQuery) score += 100;
    if (symbol.startsWith(`${normalizedQuery}.`)) score += 80;
    if (shortName.includes(normalizedQuery) || longName.includes(normalizedQuery)) score += 40;
    if (quoteType === 'EQUITY') score += 20;
    if (result.exchange === 'NMS' || result.exchange === 'NYQ') score += 5;
    score += typeof result.score === 'number' ? Math.min(result.score, 100000) / 10000 : 0;

    return score;
  }

  private extractTickerCandidate(query: string): string | null {
    const dollarMatch = query.match(/\$([a-z]{1,10}(?:[.-][a-z]{1,8})?)/i);
    if (dollarMatch) {
      return dollarMatch[1];
    }

    const keywordMatch = query.match(/\b(?:ticker|stock|shares?)\s+([a-z]{1,10}(?:[.-][a-z]{1,8})?)\b/i);
    if (keywordMatch) {
      return this.isTickerStopWord(keywordMatch[1]) ? null : keywordMatch[1];
    }

    const beforeKeywordMatch = query.match(/\b([a-z]{1,10}(?:[.-][a-z]{1,8})?)\b(?=\s+(?:stock|shares?|price|quote)\b)/i);
    if (!beforeKeywordMatch) {
      return null;
    }

    return this.isTickerStopWord(beforeKeywordMatch[1]) ? null : beforeKeywordMatch[1];
  }

  private isTickerStopWord(candidate: string): boolean {
    const stopWords = new Set(['check', 'what', 'which', 'best', 'read', 'again', 'right', 'now', 'price', 'prices', 'stock', 'stocks', 'quote', 'their']);
    return stopWords.has(candidate.toLowerCase());
  }

  private formatQuote(quote: YahooQuote, query: string): string {
    const currency = quote.currency || 'USD';
    const lines = [
      `Stock quote lookup for: ${query.trim()}`,
      quote.symbol ? `Resolved symbol: ${quote.symbol}` : '',
      quote.longName || quote.shortName ? `Company: ${quote.longName || quote.shortName}` : '',
      quote.fullExchangeName || quote.exchange ? `Exchange: ${quote.fullExchangeName || quote.exchange}` : '',
      `Price: ${this.formatMoney(quote.regularMarketPrice!, currency)}`,
      this.isFiniteNumber(quote.regularMarketChange) ? `Change: ${this.formatSignedMoney(quote.regularMarketChange!, currency)}` : '',
      this.isFiniteNumber(quote.regularMarketChangePercent) ? `Change percent: ${this.formatSignedPercent(quote.regularMarketChangePercent!)}` : '',
      this.isFiniteNumber(quote.regularMarketPreviousClose) ? `Previous close: ${this.formatMoney(quote.regularMarketPreviousClose!, currency)}` : '',
      this.isFiniteNumber(quote.regularMarketOpen) ? `Open: ${this.formatMoney(quote.regularMarketOpen!, currency)}` : '',
      this.isFiniteNumber(quote.regularMarketDayHigh) && this.isFiniteNumber(quote.regularMarketDayLow)
        ? `Day range: ${this.formatMoney(quote.regularMarketDayLow!, currency)} - ${this.formatMoney(quote.regularMarketDayHigh!, currency)}`
        : '',
      this.isFiniteNumber(quote.fiftyTwoWeekLow) && this.isFiniteNumber(quote.fiftyTwoWeekHigh)
        ? `52-week range: ${this.formatMoney(quote.fiftyTwoWeekLow!, currency)} - ${this.formatMoney(quote.fiftyTwoWeekHigh!, currency)}`
        : '',
      this.isFiniteNumber(quote.marketCap) ? `Market cap: ${this.formatLargeNumber(quote.marketCap!)}` : '',
      this.isFiniteNumber(quote.regularMarketVolume) ? `Volume: ${this.formatInteger(quote.regularMarketVolume!)}` : '',
      this.isFiniteNumber(quote.trailingPE) ? `Trailing P/E: ${quote.trailingPE!.toFixed(2)}` : '',
      this.isFiniteNumber(quote.forwardPE) ? `Forward P/E: ${quote.forwardPE!.toFixed(2)}` : '',
      quote.marketState ? `Market state: ${quote.marketState}` : '',
      quote.regularMarketTime ? `As of: ${this.formatMarketTime(quote.regularMarketTime)}` : '',
      `Source: Yahoo Finance${quote.quoteSourceName ? ` (${quote.quoteSourceName})` : ''}`,
    ];

    return lines.filter(Boolean).join('\n');
  }

  private isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
  }

  private formatMoney(value: number, currency: string): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  private formatSignedMoney(value: number, currency: string): string {
    const sign = value > 0 ? '+' : '';
    return `${sign}${this.formatMoney(value, currency)}`;
  }

  private formatSignedPercent(value: number): string {
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  }

  private formatInteger(value: number): string {
    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 0,
    }).format(value);
  }

  private formatLargeNumber(value: number): string {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(value);
  }

  private formatMarketTime(value: number | string | Date): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === 'number') {
      return new Date(value * 1000).toISOString();
    }
    return value;
  }
}

export default YahooFinanceAPI;
