import { Env, getConfig } from '../env';
import { fetchJson } from '../utils/helpers';

interface EODHDSearchResult {
  Code?: string;
  Exchange?: string;
  Name?: string;
  Type?: string;
}

interface EODHDRealTimeQuote {
  code?: string;
  name?: string;
  exchange?: string;
  timestamp?: number;
  close?: number | string;
  previousClose?: number | string;
  change?: number | string;
  change_p?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  volume?: number | string;
}

interface EODHDEodCandle {
  date?: string;
  close?: number | string;
  adjusted_close?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  volume?: number | string;
}

interface ResolvedSymbol {
  displaySymbol: string;
  symbol: string;
  name?: string;
  exchange?: string;
}

interface StockQuote {
  displaySymbol: string;
  symbol: string;
  name?: string;
  exchange?: string;
  price: number;
  previousClose?: number;
  change?: number;
  changePercent?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  asOf?: string;
  source: 'delayed_real_time' | 'eod';
}

class EODHDAPI {
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(env: Env) {
    const config = getConfig(env);
    this.apiKey = env.EODHD_API_KEY;
    this.baseUrl = config.eodhdApiBaseUrl;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async lookupStockQuote(query: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('EODHD_API_KEY is not configured');
    }

    const resolvedSymbol = await this.resolveSymbol(query);
    const quote = await this.fetchQuote(resolvedSymbol);
    return this.formatQuote(quote, query);
  }

  private async resolveSymbol(query: string): Promise<ResolvedSymbol> {
    const directTicker = this.extractTickerCandidate(query);
    if (directTicker) {
      const normalized = this.normalizeDirectTicker(directTicker);
      return {
        displaySymbol: normalized.replace(/\.US$/i, ''),
        symbol: normalized,
        exchange: normalized.includes('.') ? normalized.split('.').pop() : 'US',
      };
    }

    const searchResults = await fetchJson<EODHDSearchResult[]>(
      `${this.baseUrl}/search/${encodeURIComponent(query.trim())}?limit=5&api_token=${encodeURIComponent(this.apiKey!)}&fmt=json`,
      {},
      'EODHD search error',
    );
    const bestMatch = this.pickBestSearchResult(query, searchResults);
    if (!bestMatch?.Code) {
      throw new Error(`No stock symbol found for "${query.trim()}"`);
    }

    return {
      displaySymbol: bestMatch.Code.replace(/\..+$/, ''),
      symbol: this.normalizeSearchResult(bestMatch.Code, bestMatch.Exchange),
      name: bestMatch.Name,
      exchange: bestMatch.Exchange,
    };
  }

  private async fetchQuote(resolvedSymbol: ResolvedSymbol): Promise<StockQuote> {
    try {
      const realTimeQuote = await fetchJson<EODHDRealTimeQuote>(
        `${this.baseUrl}/real-time/${encodeURIComponent(resolvedSymbol.symbol)}?api_token=${encodeURIComponent(this.apiKey!)}&fmt=json`,
        {},
        'EODHD real-time quote error',
      );
      const price = this.parseNumber(realTimeQuote.close);
      if (price !== null) {
        return {
          displaySymbol: resolvedSymbol.displaySymbol,
          symbol: resolvedSymbol.symbol,
          name: realTimeQuote.name || resolvedSymbol.name,
          exchange: realTimeQuote.exchange || resolvedSymbol.exchange,
          price,
          previousClose: this.parseNumber(realTimeQuote.previousClose) ?? undefined,
          change: this.parseNumber(realTimeQuote.change) ?? undefined,
          changePercent: this.parseNumber(realTimeQuote.change_p) ?? undefined,
          open: this.parseNumber(realTimeQuote.open) ?? undefined,
          high: this.parseNumber(realTimeQuote.high) ?? undefined,
          low: this.parseNumber(realTimeQuote.low) ?? undefined,
          volume: this.parseNumber(realTimeQuote.volume) ?? undefined,
          asOf: this.formatTimestamp(realTimeQuote.timestamp),
          source: 'delayed_real_time',
        };
      }
    } catch (error) {
      console.error('EODHD real-time quote failed, falling back to EOD data:', error);
    }

    const eodCandles = await fetchJson<EODHDEodCandle[]>(
      `${this.baseUrl}/eod/${encodeURIComponent(resolvedSymbol.symbol)}?order=d&limit=1&api_token=${encodeURIComponent(this.apiKey!)}&fmt=json`,
      {},
      'EODHD EOD quote error',
    );
    const latestCandle = Array.isArray(eodCandles) ? eodCandles[0] : null;
    const eodPrice = this.parseNumber(latestCandle?.adjusted_close) ?? this.parseNumber(latestCandle?.close);
    if (eodPrice === null) {
      throw new Error(`EODHD did not return a usable quote for ${resolvedSymbol.symbol}`);
    }

    return {
      displaySymbol: resolvedSymbol.displaySymbol,
      symbol: resolvedSymbol.symbol,
      name: resolvedSymbol.name,
      exchange: resolvedSymbol.exchange,
      price: eodPrice,
      open: this.parseNumber(latestCandle?.open) ?? undefined,
      high: this.parseNumber(latestCandle?.high) ?? undefined,
      low: this.parseNumber(latestCandle?.low) ?? undefined,
      volume: this.parseNumber(latestCandle?.volume) ?? undefined,
      asOf: latestCandle?.date,
      source: 'eod',
    };
  }

  private formatQuote(quote: StockQuote, query: string): string {
    const lines = [
      `Stock quote lookup for: ${query.trim()}`,
      `Resolved symbol: ${quote.symbol}`,
      quote.name ? `Company: ${quote.name}` : '',
      quote.exchange ? `Exchange: ${quote.exchange}` : '',
      `Price: ${this.formatMoney(quote.price)}`,
      quote.change !== undefined ? `Change: ${this.formatSignedMoney(quote.change)}` : '',
      quote.changePercent !== undefined ? `Change percent: ${this.formatSignedPercent(quote.changePercent)}` : '',
      quote.previousClose !== undefined ? `Previous close: ${this.formatMoney(quote.previousClose)}` : '',
      quote.open !== undefined ? `Open: ${this.formatMoney(quote.open)}` : '',
      quote.high !== undefined && quote.low !== undefined
        ? `Day range: ${this.formatMoney(quote.low)} - ${this.formatMoney(quote.high)}`
        : '',
      quote.volume !== undefined ? `Volume: ${this.formatInteger(quote.volume)}` : '',
      quote.asOf ? `As of: ${quote.asOf}` : '',
      `Source: ${quote.source === 'delayed_real_time' ? 'EODHD delayed real-time quote' : 'EODHD end-of-day quote'}`,
    ];

    return lines.filter(Boolean).join('\n');
  }

  private pickBestSearchResult(query: string, results: EODHDSearchResult[]): EODHDSearchResult | null {
    if (!Array.isArray(results) || results.length === 0) {
      return null;
    }

    const normalizedQuery = query.replace(/^\$/, '').trim().toUpperCase();
    const rankedResults = [...results].sort((left, right) => this.scoreSearchResult(right, normalizedQuery) - this.scoreSearchResult(left, normalizedQuery));
    return rankedResults[0] || null;
  }

  private scoreSearchResult(result: EODHDSearchResult, normalizedQuery: string): number {
    let score = 0;
    const code = (result.Code || '').toUpperCase();
    const exchange = (result.Exchange || '').toUpperCase();
    const type = (result.Type || '').toUpperCase();

    if (code === normalizedQuery || code === `${normalizedQuery}.US`) {
      score += 100;
    }
    if (code.startsWith(`${normalizedQuery}.`)) {
      score += 50;
    }
    if (exchange === 'US') {
      score += 20;
    }
    if (type === 'COMMON STOCK' || type === 'STOCK' || type === 'ETF') {
      score += 10;
    }

    return score;
  }

  private extractTickerCandidate(query: string): string | null {
    const dollarMatch = query.match(/\$([a-z]{1,10}(?:\.[a-z]{1,8})?)/i);
    if (dollarMatch) {
      return dollarMatch[1];
    }

    const keywordMatch = query.match(/\b(?:ticker|stock|shares?)\s+([a-z]{1,10}(?:\.[a-z]{1,8})?)\b/i);
    if (keywordMatch) {
      return keywordMatch[1];
    }

    const beforeKeywordMatch = query.match(/\b([a-z]{1,10}(?:\.[a-z]{1,8})?)\b(?=\s+(?:stock|shares?|price|quote)\b)/i);
    if (!beforeKeywordMatch) {
      return null;
    }

    const candidate = beforeKeywordMatch[1].toLowerCase();
    const stopWords = new Set(['check', 'what', 'which', 'best', 'read', 'again', 'right', 'now', 'price', 'stock', 'quote']);
    return stopWords.has(candidate) ? null : beforeKeywordMatch[1];
  }

  private normalizeDirectTicker(symbol: string): string {
    const upper = symbol.trim().toUpperCase();
    if (upper.includes('.')) {
      return upper;
    }
    return `${upper}.US`;
  }

  private normalizeSearchResult(code: string, exchange?: string): string {
    const upperCode = code.toUpperCase();
    if (upperCode.includes('.')) {
      return upperCode;
    }
    if (exchange) {
      return `${upperCode}.${exchange.toUpperCase()}`;
    }
    return `${upperCode}.US`;
  }

  private parseNumber(value: number | string | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private formatTimestamp(timestamp?: number): string | undefined {
    if (!timestamp) {
      return undefined;
    }
    return new Date(timestamp * 1000).toISOString();
  }

  private formatMoney(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  private formatSignedMoney(value: number): string {
    const sign = value > 0 ? '+' : '';
    return `${sign}${this.formatMoney(value)}`;
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
}

export default EODHDAPI;
