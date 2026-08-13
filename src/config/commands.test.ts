import { describe, expect, it, vi } from 'vitest';
import { translate } from '../utils/i18n';
import type { TelegramCommandBot } from './command_types';
import { commands } from './commands';

describe('Telegram command schema', () => {
  it('keeps command names unique and within Telegram constraints', () => {
    const names = commands.map(command => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,32}$/);
  });

  it('has a usable description for every command', () => {
    for (const command of commands) {
      const description = translate(command.description);
      expect(description.trim().length, command.name).toBeGreaterThan(0);
      // Telegram rejects setMyCommands entries longer than this.
      expect(description.length, command.name).toBeLessThanOrEqual(256);
    }
  });

  it('routes Box agent starts, status, cancellation, and GLM overrides', async () => {
    const bot = {
      startBoxAgentJob: vi.fn(async () => undefined),
      getBoxAgentStatus: vi.fn(async () => 'running'),
      cancelBoxAgentJob: vi.fn(async () => 'canceled'),
      sendMessageWithFallback: vi.fn(async () => []),
    } as unknown as TelegramCommandBot;
    const command = commands.find(candidate => candidate.name === 'agent')!;

    await command.action(-100, 'group:-100', 'owner', bot, ['--model', 'glm', 'generate', 'a', 'PDF']);
    expect(bot.startBoxAgentJob).toHaveBeenCalledWith(
      -100, 'group:-100', 'owner', 'generate a PDF', 'glm',
    );
    await command.action(-100, 'group:-100', 'owner', bot, ['status', 'bj_123456']);
    expect(bot.getBoxAgentStatus).toHaveBeenCalledWith(-100, 'owner', 'bj_123456');
    await command.action(-100, 'group:-100', 'owner', bot, ['cancel', 'bj_123456']);
    expect(bot.cancelBoxAgentJob).toHaveBeenCalledWith(-100, 'owner', 'bj_123456');
  });

  it('keeps /box enable owner-only and group-only', async () => {
    const bot = {
      isOwner: vi.fn(() => true),
      enableBoxForChat: vi.fn(async () => undefined),
      sendMessageWithFallback: vi.fn(async () => []),
    } as unknown as TelegramCommandBot;
    const command = commands.find(candidate => candidate.name === 'box')!;
    await command.action(-100, 'group:-100', 'owner', bot, ['enable']);
    expect(bot.enableBoxForChat).toHaveBeenCalledWith(-100, 'group:-100');

    await command.action(42, '42', 'owner', bot, ['enable']);
    expect(bot.enableBoxForChat).toHaveBeenCalledTimes(1);
  });

  it('reissues an authorized artifact link', async () => {
    const bot = {
      getArtifactLink: vi.fn(async () => 'report.pdf\nDownload link (24 hours): https://worker.example/artifacts/ba_123456'),
      sendMessageWithFallback: vi.fn(async () => []),
    } as unknown as TelegramCommandBot;
    const command = commands.find(candidate => candidate.name === 'artifact')!;
    await command.action(-100, 'group:-100', 'member', bot, ['ba_123456']);
    expect(bot.getArtifactLink).toHaveBeenCalledWith(-100, 'member', 'ba_123456');
  });
});
