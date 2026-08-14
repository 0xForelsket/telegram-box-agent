/**
 * Which commands appear in Telegram's registered menu, and to whom.
 *
 * Two separate reductions live here:
 *
 * 1. Commands the Mini App renders as UI are withheld from the menu. They still
 *    work when typed — this only stops them occupying a row in a list nobody
 *    can scan. Withholding is not deprecation.
 * 2. Owner-only and group-only commands are registered against narrower
 *    Telegram scopes, so members never see a command that will refuse them and
 *    private chats never see one that only works in the bound group.
 */

/**
 * Bump whenever the scoping rules or absorbed set below change.
 *
 * The stale-menu fingerprint hashes command names and descriptions, so a change
 * to *which scope* a command lands in is invisible to it. Without this the menu
 * would keep serving the previous split until an unrelated command changed.
 */
export const MENU_SCHEMA_VERSION = 3;

/**
 * Rendered as tabs in the Mini App; typing them still works.
 *
 * The list *legs* of the consolidated families are no longer commands at all —
 * they are `/remind list`, `/feed list` and so on — so only genuinely
 * standalone read-only commands remain here.
 */
export const MINIAPP_ABSORBED_COMMANDS = new Set([
  'status',
  'usage',
  'cache',
  'people',
  'topics',
  'memory',
  'sources',
  'history',
]);

/** Refuse for anyone but `OWNER_USER_ID`. */
export const OWNER_ONLY_COMMANDS = new Set([
  'box',
  'action',
  'usage',
  'cache',
  'dashboard',
  'synccommands',
]);

/** Require the bound Telegram group; they throw in a private chat. */
export const GROUP_ONLY_COMMANDS = new Set([
  'box',
  'agent',
  'quick',
  'artifact',
  'action',
  'groupprofile',
]);

export interface MenuCommand {
  name: string;
  description: string;
}

export interface MenuScopePlan {
  /** `BotCommandScope` object passed straight to `setMyCommands`. */
  scope: Record<string, unknown>;
  commands: MenuCommand[];
}

/**
 * Builds the per-scope menus.
 *
 * Deliberately a small number of static scopes rather than one per user: an
 * earlier implementation scanned the keyspace and issued a `setMyCommands` call
 * per user, which grew a subrequest per user on a single invocation. Roles are
 * bounded, so this is at most three calls regardless of how many people use the
 * bot.
 */
export function buildMenuScopePlans(input: {
  commands: MenuCommand[];
  ownerUserId?: string;
  boundChatId?: number | null;
}): MenuScopePlan[] {
  const visible = input.commands.filter(command => !MINIAPP_ABSORBED_COMMANDS.has(command.name));
  const member = visible.filter(command => !OWNER_ONLY_COMMANDS.has(command.name));

  const plans: MenuScopePlan[] = [
    {
      scope: { type: 'all_private_chats' },
      commands: member.filter(command => !GROUP_ONLY_COMMANDS.has(command.name)),
    },
    { scope: { type: 'all_group_chats' }, commands: member },
    // `default` is the fallback for any scope not covered above.
    { scope: { type: 'default' }, commands: member },
  ];

  // The owner sees everything, but only inside the bound group, which is the
  // only place the owner-only commands are usable.
  if (input.ownerUserId && input.boundChatId != null) {
    plans.push({
      scope: { type: 'chat_member', chat_id: input.boundChatId, user_id: Number(input.ownerUserId) },
      commands: visible,
    });
  }

  return plans;
}
