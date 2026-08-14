import type { TelegramBot } from './shared';

/**
 * Subcommand dispatch for the noun-shaped command families.
 *
 * `/bookmark` `/bookmarks` `/unbookmark` were three registered commands for one
 * noun, repeated across reminders, digests, feeds, and the group profile. The
 * pattern already existed in this codebase — `/agent status|cancel|approve` —
 * so these now follow it rather than each inventing its own conjugation.
 *
 * The default handler matters as much as the dispatch: `/remind in 20m water`
 * has to keep working. A first argument that is not a known subcommand falls
 * through to the family's primary action, so the most-typed form never grows a
 * mandatory keyword.
 */

export type SubcommandHandler = (input: {
  chatId: number;
  sessionKey: string;
  userId: string;
  bot: TelegramBot;
  /** Arguments after the subcommand keyword, or all of them for the default. */
  args: string[];
}) => Promise<void>;

export interface SubcommandSpec {
  /** Keyword plus any aliases, e.g. `['rm', 'remove', 'delete']`. */
  keywords: string[];
  handler: SubcommandHandler;
}

export interface SubcommandRouter {
  subcommands: SubcommandSpec[];
  /** Runs when the first argument matches no keyword. */
  fallback: SubcommandHandler;
  /** Shown when `fallback` is absent and nothing matched. */
  usage: string;
}

export function dispatchSubcommand(
  router: SubcommandRouter,
): (
  chatId: number,
  sessionKey: string,
  userId: string,
  bot: TelegramBot,
  args: string[],
) => Promise<void> {
  return async (chatId, sessionKey, userId, bot, args) => {
    const first = (args[0] ?? '').toLowerCase();
    const matched = first
      ? router.subcommands.find(spec => spec.keywords.includes(first))
      : undefined;
    const handler = matched?.handler ?? router.fallback;
    const rest = matched ? args.slice(1) : args;
    try {
      await handler({ chatId, sessionKey, userId, bot, args: rest });
    } catch (error) {
      await bot.sendMessageWithFallback(
        chatId,
        error instanceof Error ? error.message : router.usage,
      );
    }
  };
}

/**
 * Legacy names, mapped to what replaced them.
 *
 * Kept as one lookup rather than fifteen alias command handlers: the point of
 * consolidating was to shrink the surface, and re-adding it as hidden aliases
 * would undo that. `executeCommand` reads this on an unknown command so a typed
 * `/unremind` explains itself instead of failing silently. Safe to delete once
 * the old names have faded from muscle memory.
 */
export const RETIRED_COMMAND_HINTS: Record<string, string> = {
  bookmarks: '/bookmark list',
  unbookmark: '/bookmark rm <id-or-title>',
  reminders: '/remind list',
  unremind: '/remind rm <id>',
  digests: '/digest list',
  undigest: '/digest rm <id>',
  followfeed: '/feed follow <url>',
  feeds: '/feed list',
  unfollowfeed: '/feed rm <id>',
  setgroupprofile: '/groupprofile set <text>',
  addgroupprofile: '/groupprofile add <text>',
  cleargroupprofile: '/groupprofile clear',
};
