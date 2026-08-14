import { describe, expect, it, vi } from 'vitest';
import { dispatchSubcommand, RETIRED_COMMAND_HINTS } from './subcommand';
import type { TelegramBot } from './shared';
import { commands } from '../commands';

function harness() {
  const calls: Array<{ where: string; args: string[] }> = [];
  const sent: string[] = [];
  const bot = {
    sendMessageWithFallback: vi.fn(async (_chatId: number, text: string) => {
      sent.push(text);
      return [];
    }),
  } as unknown as TelegramBot;

  const action = dispatchSubcommand({
    usage: 'Usage: /thing <value>',
    fallback: async ({ args }) => { calls.push({ where: 'fallback', args }); },
    subcommands: [
      { keywords: ['list', 'ls'], handler: async ({ args }) => { calls.push({ where: 'list', args }); } },
      { keywords: ['rm', 'remove'], handler: async ({ args }) => { calls.push({ where: 'rm', args }); } },
    ],
  });
  return { action, calls, sent, bot };
}

const run = (h: ReturnType<typeof harness>, args: string[]) =>
  h.action(1, 'private:1', 'user', h.bot, args);

describe('dispatchSubcommand', () => {
  it('routes a recognised subcommand and strips its keyword', async () => {
    const h = harness();

    await run(h, ['rm', 'abc123']);

    expect(h.calls).toEqual([{ where: 'rm', args: ['abc123'] }]);
  });

  it('accepts keyword aliases', async () => {
    const h = harness();

    await run(h, ['ls']);
    await run(h, ['remove', 'x']);

    expect(h.calls.map(c => c.where)).toEqual(['list', 'rm']);
  });

  it('matches keywords case-insensitively', async () => {
    const h = harness();

    await run(h, ['LIST']);

    expect(h.calls[0].where).toBe('list');
  });

  // The whole reason the create leg keeps working: `/remind in 20m water` must
  // not have to become `/remind add in 20m water`.
  it('passes an unrecognised first argument to the fallback, unmodified', async () => {
    const h = harness();

    await run(h, ['in', '20m', 'water']);

    expect(h.calls).toEqual([{ where: 'fallback', args: ['in', '20m', 'water'] }]);
  });

  it('sends no arguments to the fallback when invoked bare', async () => {
    const h = harness();

    await run(h, []);

    expect(h.calls).toEqual([{ where: 'fallback', args: [] }]);
  });

  it('does not treat a value that merely starts with a keyword as one', async () => {
    const h = harness();

    await run(h, ['listen', 'to', 'this']);

    expect(h.calls[0].where).toBe('fallback');
  });

  it('reports a handler failure instead of rejecting', async () => {
    const h = harness();
    const action = dispatchSubcommand({
      usage: 'Usage: /thing',
      fallback: async () => { throw new Error('upstream exploded'); },
      subcommands: [],
    });

    await expect(action(1, 'private:1', 'user', h.bot, [])).resolves.toBeUndefined();
    expect(h.sent).toEqual(['upstream exploded']);
  });

  it('falls back to the usage line for a non-Error failure', async () => {
    const h = harness();
    const action = dispatchSubcommand({
      usage: 'Usage: /thing',
      fallback: async () => { throw 'not an error object'; },
      subcommands: [],
    });

    await action(1, 'private:1', 'user', h.bot, []);

    expect(h.sent).toEqual(['Usage: /thing']);
  });
});

describe('RETIRED_COMMAND_HINTS', () => {
  it('names no command that still exists', () => {
    const live = new Set(commands.map(command => command.name));

    for (const retired of Object.keys(RETIRED_COMMAND_HINTS)) {
      expect(live, `${retired} is both retired and registered`).not.toContain(retired);
    }
  });

  // Most hints now point at plain language or the menu button rather than
  // another command; only the ones that name a command need to resolve.
  it('points every command-shaped hint at a command that exists', () => {
    const live = new Set(commands.map(command => command.name));

    for (const [retired, replacement] of Object.entries(RETIRED_COMMAND_HINTS)) {
      if (!replacement.startsWith('/')) continue;
      const target = replacement.split(/\s+/)[0].slice(1);
      expect(live, `${retired} points at missing /${target}`).toContain(target);
    }
  });

  it('gives every retired name a non-empty hint', () => {
    for (const [retired, replacement] of Object.entries(RETIRED_COMMAND_HINTS)) {
      expect(replacement.trim(), `${retired} has an empty hint`).toBeTruthy();
    }
  });

  it('covers every command name the reduction removed', () => {
    for (const removed of [
      // Folded into a survivor.
      'switchmodel', 'flux', 'setambient', 'setreplystyle', 'dashboard',
      'groupprofile', 'setgroupprofile', 'addgroupprofile', 'cleargroupprofile',
      // Now reachable by asking.
      'calc', 'convert', 'time', 'date', 'weather', 'currency', 'github',
      'arxiv', 'read', 'research', 'remind', 'reminders', 'unremind',
      'digest', 'digests', 'undigest', 'bookmark', 'bookmarks', 'unbookmark',
      'feed', 'followfeed', 'feeds', 'unfollowfeed',
      'remember', 'recall', 'forget', 'translate', 'rewrite', 'summarize',
      'compare', 'speak',
      // Now in the Mini App.
      'status', 'usage', 'cache', 'history', 'memory', 'people', 'topics',
      'sources',
      // Gone entirely.
      'synccommands',
    ]) {
      expect(RETIRED_COMMAND_HINTS, `${removed} has no hint`).toHaveProperty(removed);
    }
  });
});
