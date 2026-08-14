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
  // Folded into a surviving command.
  switchmodel: '/model',
  flux: '/img --flux <prompt>',
  setambient: '/settings ambient on|off',
  setreplystyle: '/settings style short|normal|long',
  groupprofile: '/settings profile',
  setgroupprofile: '/settings profile set <text>',
  addgroupprofile: '/settings profile add <text>',
  cleargroupprofile: '/settings profile clear',
  dashboard: '/settings dashboard',

  // Reachable by asking — the model already carries a tool for each.
  calc: 'just asking, e.g. "what is 1250 * 1.06 / 12"',
  convert: 'just asking, e.g. "12 km in miles"',
  time: 'just asking, e.g. "what time is it in Tokyo"',
  date: 'just asking, e.g. "how many days until 25 December"',
  weather: 'just asking, e.g. "weather in Penang"',
  currency: 'just asking, e.g. "50 USD in MYR"',
  github: 'just asking, e.g. "latest release of cloudflare/workers-sdk"',
  arxiv: 'just asking, e.g. "recent arXiv papers on retrieval"',
  read: 'just asking, e.g. "read <url> and summarise it"',
  research: 'just asking, e.g. "research <question>"',
  remind: 'just asking, e.g. "remind me in 20m to stretch"',
  reminders: 'just asking, e.g. "what reminders do I have"',
  unremind: 'just asking, e.g. "cancel reminder <id>"',
  digest: 'just asking, e.g. "send me a daily 08:00 feeds digest"',
  digests: 'just asking, e.g. "what digests are scheduled"',
  undigest: 'just asking, e.g. "cancel digest <id>"',
  bookmark: 'just asking, e.g. "bookmark <url>"',
  bookmarks: 'just asking, e.g. "what have I bookmarked"',
  unbookmark: 'just asking, e.g. "remove bookmark <id>"',
  feed: 'just asking, e.g. "what is new on <url>"',
  followfeed: 'just asking, e.g. "follow <url>"',
  feeds: 'just asking, e.g. "what feeds do I follow"',
  unfollowfeed: 'just asking, e.g. "unfollow <id>"',
  remember: 'just asking, e.g. "remember that I prefer metric"',
  recall: 'just asking, e.g. "what do you remember about X"',
  forget: 'just asking, e.g. "forget <id>"',
  translate: 'just asking, e.g. "translate this into Malay: ..."',
  rewrite: 'just asking, e.g. "rewrite this more clearly: ..."',
  summarize: 'just asking, e.g. "summarise this: ..."',
  compare: 'just asking, or /model to switch',
  speak: 'just asking, e.g. "say that out loud"',

  // Shown in the Mini App, on the menu button.
  status: 'the menu button',
  usage: 'the menu button',
  cache: 'the menu button',
  history: 'the menu button',
  memory: 'the menu button',
  people: 'the menu button',
  topics: 'the menu button',
  sources: 'the menu button',

  // Gone entirely: the command menu now re-syncs itself when it goes stale.
  synccommands: 'automatic — the menu re-syncs on its own',
};
