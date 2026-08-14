import { describe, expect, it } from 'vitest';
import {
  buildMenuScopePlans,
  GROUP_ONLY_COMMANDS,
  MINIAPP_ABSORBED_COMMANDS,
  OWNER_ONLY_COMMANDS,
  type MenuCommand,
} from './menu_scope';
import { commands } from './commands';

const ALL: MenuCommand[] = commands.map(command => ({
  name: command.name,
  description: command.description,
}));

function plan(scopeType: string, overrides: Parameters<typeof buildMenuScopePlans>[0] | null = null) {
  const plans = buildMenuScopePlans(
    overrides ?? { commands: ALL, ownerUserId: '1501649147', boundChatId: -652447362 },
  );
  const found = plans.find(candidate => candidate.scope.type === scopeType);
  return found ? found.commands.map(command => command.name) : null;
}

describe('buildMenuScopePlans', () => {
  it('covers default, private, and group scopes', () => {
    const plans = buildMenuScopePlans({ commands: ALL });

    expect(plans.map(p => p.scope.type)).toEqual([
      'all_private_chats', 'all_group_chats', 'default',
    ]);
  });

  it('withholds Mini App commands from every scope', () => {
    for (const scope of ['all_private_chats', 'all_group_chats', 'default', 'chat_member']) {
      const names = plan(scope)!;
      for (const absorbed of MINIAPP_ABSORBED_COMMANDS) {
        expect(names, `${absorbed} leaked into ${scope}`).not.toContain(absorbed);
      }
    }
  });

  it('keeps owner-only commands out of the member menus', () => {
    for (const scope of ['all_private_chats', 'all_group_chats', 'default']) {
      const names = plan(scope)!;
      for (const owner of OWNER_ONLY_COMMANDS) {
        expect(names, `${owner} leaked into ${scope}`).not.toContain(owner);
      }
    }
  });

  it('keeps group-only commands out of private chats', () => {
    const names = plan('all_private_chats')!;

    for (const groupOnly of GROUP_ONLY_COMMANDS) {
      expect(names, `${groupOnly} leaked into private chats`).not.toContain(groupOnly);
    }
  });

  it('gives the owner the full menu inside the bound group', () => {
    const names = plan('chat_member')!;

    expect(names).toContain('box');
    expect(names).toContain('action');
    expect(names).toContain('agent');
  });

  it('binds the owner scope to the owner and the bound chat', () => {
    const owner = buildMenuScopePlans({
      commands: ALL, ownerUserId: '1501649147', boundChatId: -652447362,
    }).find(p => p.scope.type === 'chat_member')!;

    expect(owner.scope).toEqual({
      type: 'chat_member', chat_id: -652447362, user_id: 1501649147,
    });
  });

  // Without a bound group there is nowhere the owner-only commands work, so
  // there is no scope to register them against.
  it('omits the owner scope when no group is bound', () => {
    expect(plan('chat_member', { commands: ALL, ownerUserId: '1501649147', boundChatId: null }))
      .toBeNull();
  });

  it('omits the owner scope when no owner is configured', () => {
    expect(plan('chat_member', { commands: ALL, boundChatId: -652447362 })).toBeNull();
  });

  it('issues a bounded number of calls regardless of user count', () => {
    // The previous implementation grew one setMyCommands call per user.
    expect(buildMenuScopePlans({
      commands: ALL, ownerUserId: '1501649147', boundChatId: -652447362,
    })).toHaveLength(4);
  });

  it('meaningfully shrinks what a group member sees', () => {
    const member = plan('all_group_chats')!;

    expect(member.length).toBeLessThan(ALL.length);
    expect(ALL.length - member.length)
      .toBe(MINIAPP_ABSORBED_COMMANDS.size + countOwnerOnlyNotAbsorbed());
  });

  it('leaves conversational commands in every menu', () => {
    for (const scope of ['all_private_chats', 'all_group_chats', 'default']) {
      expect(plan(scope)).toContain('help');
      expect(plan(scope)).toContain('new');
      expect(plan(scope)).toContain('switchmodel');
    }
  });
});

function countOwnerOnlyNotAbsorbed(): number {
  return [...OWNER_ONLY_COMMANDS].filter(name => !MINIAPP_ABSORBED_COMMANDS.has(name)).length;
}

describe('absorbed command coverage', () => {
  it('only names commands that actually exist', () => {
    const names = new Set(ALL.map(command => command.name));
    for (const set of [MINIAPP_ABSORBED_COMMANDS, OWNER_ONLY_COMMANDS, GROUP_ONLY_COMMANDS]) {
      for (const name of set) {
        expect(names, `${name} is listed but is not a registered command`).toContain(name);
      }
    }
  });
});
