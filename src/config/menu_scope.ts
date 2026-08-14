/**
 * Which commands appear in Telegram's registered menu, and to whom.
 *
 * The surface is now small enough that hiding commands matters far less than
 * it did — the previous absorbed-command list is gone because those commands
 * were removed outright rather than withheld. What remains is scoping: members
 * never see a command that will refuse them, and private chats never see one
 * that only works in the bound group.
 */

/**
 * Bump whenever the scoping rules below change.
 *
 * The stale-menu fingerprint hashes command names and descriptions, so a change
 * to *which scope* a command lands in is invisible to it.
 */
export const MENU_SCHEMA_VERSION = 5;

/** Refuse for anyone but `OWNER_USER_ID`. */
export const OWNER_ONLY_COMMANDS = new Set(['box', 'action']);

/** Require the bound Telegram group; they refuse in a private chat. */
export const GROUP_ONLY_COMMANDS = new Set([
  'box',
  'agent',
  'quick',
  'artifact',
  'action',
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
 * bounded, so this is at most four calls regardless of how many people use the
 * bot.
 */
export function buildMenuScopePlans(input: {
  commands: MenuCommand[];
  ownerUserId?: string;
  boundChatId?: number | null;
}): MenuScopePlan[] {
  const member = input.commands.filter(
    command => !OWNER_ONLY_COMMANDS.has(command.name),
  );

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
      commands: input.commands,
    });
  }

  return plans;
}
