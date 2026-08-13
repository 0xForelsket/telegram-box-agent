import { describe, expect, it } from 'vitest';
import { buildPromptLayout } from './prompt_layout';

describe('buildPromptLayout', () => {
  it('keeps the stable prefix byte-identical while volatile context changes', () => {
    const stable = {
      soul: 'soul', baseInstructions: 'base', replyStyle: 'short', stableMemory: 'memory',
      recentTurns: [{ role: 'assistant' as const, content: 'previous' }], userMessage: 'latest',
    };
    const first = buildPromptLayout({ ...stable, volatileContext: 'one', dateTimeContext: null });
    const second = buildPromptLayout({ ...stable, volatileContext: 'two', dateTimeContext: 'today' });
    expect(JSON.stringify(first.slice(0, 5))).toBe(JSON.stringify(second.slice(0, 5)));
    expect(first.at(-1)).toEqual({ role: 'user', content: 'latest' });
  });
});
