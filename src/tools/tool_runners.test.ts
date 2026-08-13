import { describe, expect, it, vi } from 'vitest';
import type { ToolCall } from '../api/chat_types';
import {
  parseToolArguments,
  runArxivTool,
  runCalculatorTool,
  runCurrencyTool,
  runStockQuoteTool,
  runWikipediaTool,
  toolFailure,
  toolSuccess,
} from './tool_runners';

function call(args: unknown, name = 'tool'): ToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

describe('parseToolArguments', () => {
  it('parses an object payload', () => {
    expect(parseToolArguments<{ a: number }>(call({ a: 1 }))).toEqual({ a: 1 });
  });

  it('returns an empty object for malformed JSON rather than throwing', () => {
    expect(parseToolArguments(call('{not json'))).toEqual({});
  });

  it('rejects non-object payloads', () => {
    expect(parseToolArguments(call('[1,2]'))).toEqual({});
    expect(parseToolArguments(call('"text"'))).toEqual({});
    expect(parseToolArguments(call('null'))).toEqual({});
  });

  it('treats missing arguments as empty', () => {
    expect(parseToolArguments({ id: 'x', type: 'function', function: { name: 'n', arguments: '' } })).toEqual({});
  });
});

describe('tool message helpers', () => {
  it('tags a result with the originating call id', () => {
    expect(toolSuccess(call({}), 'done')).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'done' });
  });

  it('formats a failure so the model can see what broke', () => {
    expect(toolFailure(call({}), 'Weather lookup', 'no such place').content)
      .toBe('Weather lookup failed: no such place');
  });
});

describe('runCalculatorTool', () => {
  it('evaluates an expression and echoes it back', async () => {
    expect((await runCalculatorTool(call({ expression: '2 + 3 * 4' }))).content).toBe('2 + 3 * 4 = 14');
  });

  it('reports a missing expression', async () => {
    expect((await runCalculatorTool(call({}))).content).toBe('Calculator failed: Missing expression.');
    expect((await runCalculatorTool(call({ expression: '   ' }))).content).toContain('Missing expression');
  });

  it('reports an unevaluable expression instead of throwing', async () => {
    const result = await runCalculatorTool(call({ expression: '2 +' }));
    expect(result.content).toContain('Calculator failed:');
  });
});

describe('runCurrencyTool', () => {
  it('rejects an incomplete request without calling out', async () => {
    expect((await runCurrencyTool(call({ amount: 5, from: 'USD' }))).content)
      .toContain('Missing amount, source currency, or destination currency');
    expect((await runCurrencyTool(call({ from: 'USD', to: 'EUR' }))).content)
      .toContain('Missing amount');
  });
});

describe('runArxivTool', () => {
  it('reports a missing query', async () => {
    expect((await runArxivTool(call({}))).content).toBe('arXiv search failed: Missing query.');
  });
});

describe('runWikipediaTool', () => {
  const api = (impl: () => Promise<string>) => ({ lookup: vi.fn(impl) } as never);

  it('returns the looked-up summary', async () => {
    const result = await runWikipediaTool(call({ query: 'Ada Lovelace' }), api(async () => 'A summary.'));

    expect(result).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'A summary.' });
  });

  it('trims the query before looking it up', async () => {
    const wikipedia = api(async () => 'ok');
    await runWikipediaTool(call({ query: '  Ada Lovelace  ' }), wikipedia);

    expect((wikipedia as unknown as { lookup: ReturnType<typeof vi.fn> }).lookup)
      .toHaveBeenCalledWith('Ada Lovelace', undefined);
  });

  it('reports a missing query without calling the API', async () => {
    const wikipedia = api(async () => 'ok');
    const result = await runWikipediaTool(call({}), wikipedia);

    expect(result.content).toBe('Wikipedia lookup failed: Missing query.');
    expect((wikipedia as unknown as { lookup: ReturnType<typeof vi.fn> }).lookup).not.toHaveBeenCalled();
  });

  it('turns a lookup error into a tool message rather than propagating', async () => {
    const result = await runWikipediaTool(
      call({ query: 'Ada' }),
      api(async () => { throw new Error('upstream down'); }),
    );

    expect(result.content).toBe('Wikipedia lookup failed: upstream down');
  });
});

describe('runStockQuoteTool', () => {
  const eodhd = (configured: boolean, impl?: () => Promise<string>) => ({
    isConfigured: () => configured,
    lookupStockQuote: vi.fn(impl ?? (async () => 'eodhd quote')),
  } as never);
  const yahoo = (impl?: () => Promise<string>) => ({
    lookupStockQuote: vi.fn(impl ?? (async () => 'yahoo quote')),
  } as never);

  function spy(api: unknown) {
    return (api as { lookupStockQuote: ReturnType<typeof vi.fn> }).lookupStockQuote;
  }

  it('prefers EODHD when it is configured', async () => {
    const primary = eodhd(true);
    const fallback = yahoo();

    expect((await runStockQuoteTool(call({ query: 'AAPL' }), primary, fallback)).content).toBe('eodhd quote');
    expect(spy(fallback)).not.toHaveBeenCalled();
  });

  it('falls back to Yahoo when EODHD is unconfigured', async () => {
    const primary = eodhd(false);
    const fallback = yahoo();

    expect((await runStockQuoteTool(call({ query: 'AAPL' }), primary, fallback)).content).toBe('yahoo quote');
    expect(spy(primary)).not.toHaveBeenCalled();
  });

  it('reports a missing query without calling either provider', async () => {
    const primary = eodhd(true);
    const fallback = yahoo();

    expect((await runStockQuoteTool(call({}), primary, fallback)).content)
      .toBe('Stock quote failed: Missing query.');
    expect(spy(primary)).not.toHaveBeenCalled();
    expect(spy(fallback)).not.toHaveBeenCalled();
  });

  it('turns a provider error into a tool message', async () => {
    const result = await runStockQuoteTool(
      call({ query: 'AAPL' }),
      eodhd(true, async () => { throw new Error('rate limited'); }),
      yahoo(),
    );

    expect(result.content).toBe('Stock quote failed: rate limited');
  });
});
