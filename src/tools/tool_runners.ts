import { Message, ToolCall } from '../api/chat_types';
import type EODHDAPI from '../api/eodhd';
import type WikipediaAPI from '../api/wikipedia';
import type YahooFinanceAPI from '../api/yahoo_finance';
import { calculateExpression, formatNumber } from '../utils/deterministic_tools';
import { convertCurrency, getGitHubRepository, getWeather, searchArxiv } from '../utils/structured_utilities';

/**
 * Tool implementations that need no bot state.
 *
 * Each takes what it needs as an argument and returns a tool message, so they
 * are callable and testable without constructing a TelegramBot. Runners that
 * do reach into bot state — web search, URL reading, reminders, memory, and
 * agent jobs — stay on the class until they carry their dependencies too.
 */

export function parseToolArguments<T extends object>(toolCall: ToolCall): Partial<T> {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<T> : {};
  } catch {
    return {};
  }
}

export function toolSuccess(toolCall: ToolCall, content: string): Message {
  return { role: 'tool', tool_call_id: toolCall.id, content };
}

export function toolFailure(toolCall: ToolCall, label: string, error: string): Message {
  return { role: 'tool', tool_call_id: toolCall.id, content: `${label} failed: ${error}` };
}

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export async function runCalculatorTool(toolCall: ToolCall): Promise<Message> {
  const { expression } = parseToolArguments<{ expression?: string }>(toolCall);
  const trimmed = expression?.trim();
  if (!trimmed) return toolFailure(toolCall, 'Calculator', 'Missing expression.');
  try {
    return toolSuccess(toolCall, `${trimmed} = ${formatNumber(calculateExpression(trimmed))}`);
  } catch (error) {
    return toolFailure(toolCall, 'Calculator', describeError(error, 'Calculation failed.'));
  }
}

export async function runWeatherTool(toolCall: ToolCall, signal?: AbortSignal): Promise<Message> {
  const { location } = parseToolArguments<{ location?: string }>(toolCall);
  const trimmed = location?.trim();
  if (!trimmed) return toolFailure(toolCall, 'Weather lookup', 'Missing location.');
  try {
    return toolSuccess(toolCall, await getWeather(trimmed, signal));
  } catch (error) {
    return toolFailure(toolCall, 'Weather lookup', describeError(error, 'Weather lookup failed.'));
  }
}

export async function runCurrencyTool(toolCall: ToolCall, signal?: AbortSignal): Promise<Message> {
  const args = parseToolArguments<{ amount?: number; from?: string; to?: string }>(toolCall);
  if (!Number.isFinite(args.amount) || !args.from || !args.to) {
    return toolFailure(toolCall, 'Currency conversion', 'Missing amount, source currency, or destination currency.');
  }
  try {
    return toolSuccess(toolCall, await convertCurrency(args.amount!, args.from, args.to, signal));
  } catch (error) {
    return toolFailure(toolCall, 'Currency conversion', describeError(error, 'Currency conversion failed.'));
  }
}

export async function runGitHubTool(
  toolCall: ToolCall,
  githubToken?: string,
  signal?: AbortSignal,
): Promise<Message> {
  const args = parseToolArguments<{ repository?: string; view?: string }>(toolCall);
  const repository = args.repository?.trim();
  if (!repository || !['summary', 'releases', 'issues'].includes(args.view || '')) {
    return toolFailure(toolCall, 'GitHub lookup', 'Provide repository in owner/name format and a valid view.');
  }
  try {
    const content = await getGitHubRepository(
      repository,
      args.view as 'summary' | 'releases' | 'issues',
      githubToken,
      signal,
    );
    return toolSuccess(toolCall, content);
  } catch (error) {
    return toolFailure(toolCall, 'GitHub lookup', describeError(error, 'GitHub lookup failed.'));
  }
}

export async function runArxivTool(toolCall: ToolCall, signal?: AbortSignal): Promise<Message> {
  const { query } = parseToolArguments<{ query?: string }>(toolCall);
  const trimmed = query?.trim();
  if (!trimmed) return toolFailure(toolCall, 'arXiv search', 'Missing query.');
  try {
    return toolSuccess(toolCall, await searchArxiv(trimmed, 5, signal));
  } catch (error) {
    return toolFailure(toolCall, 'arXiv search', describeError(error, 'arXiv search failed.'));
  }
}

export async function runWikipediaTool(
  toolCall: ToolCall,
  wikipediaAPI: WikipediaAPI,
  signal?: AbortSignal,
): Promise<Message> {
  const { query } = parseToolArguments<{ query?: string }>(toolCall);
  const trimmed = query?.trim();
  if (!trimmed) return toolFailure(toolCall, 'Wikipedia lookup', 'Missing query.');
  try {
    return toolSuccess(toolCall, await wikipediaAPI.lookup(trimmed, signal));
  } catch (error) {
    console.error('Error executing Wikipedia tool:', error);
    return toolFailure(toolCall, 'Wikipedia lookup', describeError(error, 'Unknown Wikipedia error.'));
  }
}

export async function runStockQuoteTool(
  toolCall: ToolCall,
  eodhdAPI: EODHDAPI,
  yahooFinanceAPI: YahooFinanceAPI,
): Promise<Message> {
  const { query } = parseToolArguments<{ query?: string }>(toolCall);
  const trimmed = query?.trim();
  if (!trimmed) return toolFailure(toolCall, 'Stock quote', 'Missing query.');
  try {
    // EODHD is the licensed source when configured; Yahoo is the unauthenticated
    // fallback so quotes still work on a bare install.
    const content = eodhdAPI.isConfigured()
      ? await eodhdAPI.lookupStockQuote(trimmed)
      : await yahooFinanceAPI.lookupStockQuote(trimmed);
    return toolSuccess(toolCall, content);
  } catch (error) {
    console.error('Error executing stock quote tool:', error);
    return toolFailure(toolCall, 'Stock quote', describeError(error, 'Unknown stock quote error.'));
  }
}
