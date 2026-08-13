import { TelegramCommandBot, Command } from './command_types';
import { translate, translateMessage, UserMessageKey } from '../utils/i18n';
import { ImageGenerationAPI } from '../api/image_generation';
import { sendChatAction } from '../utils/helpers';
import { FluxAPI } from '../api/flux-cf';
import { getConfig } from '../env';
import { calculateDate, calculateExpression, convertUnits, formatNumber, formatTimeInZone } from '../utils/deterministic_tools';
import { convertCurrency, formatFeed, getGitHubRepository, getWeather, readFeed, searchArxiv } from '../utils/structured_utilities';
import { ProviderHealth } from '../utils/usage_tracker';

type TelegramBot = TelegramCommandBot;

function formatProviderHealth(item: ProviderHealth): string {
  const failures = Object.entries(item.errorCategories)
    .sort(([, left], [, right]) => right - left)
    .map(([category, count]) => `${category} ${count}`)
    .join(', ');
  return `${item.provider}=${item.status} (${item.successes}/${item.calls}${failures ? `; ${failures}` : ''})`;
}

async function userMessage(
  _bot: TelegramBot,
  _userId: string,
  key: UserMessageKey,
  values: Record<string, string | number> = {},
): Promise<string> {
  return translateMessage(key, values);
}

async function requireGroupAdmin(chatId: number, sessionKey: string, userId: string, bot: TelegramBot): Promise<boolean> {
  if (!sessionKey.startsWith('group:')) {
    await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'group_only'));
    return false;
  }

  try {
    const isAdmin = await bot.isUserGroupAdmin(chatId, userId);
    if (!isAdmin) {
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'admin_only'));
      return false;
    }
    return true;
  } catch (error) {
    await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'admin_check_failed'));
    return false;
  }
}

async function requireOwner(chatId: number, userId: string, bot: TelegramBot): Promise<boolean> {
  if (!bot.isOwner(userId)) {
    await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'owner_only'));
    return false;
  }
  return true;
}

export const commands: Command[] = [
  {
    name: 'start',
    description: 'start_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const welcomeMessage = translate('welcome');
      await bot.sendMessageWithFallback(chatId, welcomeMessage);
    },
  },
  {
    name: 'switchmodel',
    description: 'switchmodel_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        console.log('Executing switchmodel command');
        const availableModels = await bot.getSelectableModels();

        console.log('Available models:', availableModels);
        const keyboard = {
          inline_keyboard: availableModels.map(model => [{text: model, callback_data: `model_${model}`}])
        };
        console.log('Sending message with model selection keyboard');
        await bot.sendMessage(chatId, translate('choose_model'), { reply_markup: JSON.stringify(keyboard) });
        console.log('Message sent successfully');
      } catch (error) {
        console.error('Error in switchmodel command:', error);
        await bot.sendMessage(chatId, translate('error') + ': ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    },
  },
  {
    name: 'new',
    description: 'new_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      await bot.clearContext(sessionKey, chatId);
    },
  },
  {
    name: 'history',
    description: 'history_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const summary = await bot.summarizeHistory(sessionKey);
      await bot.sendMessage(chatId, summary || translate('no_history'));
    },
  },
  {
    name: 'help',
    description: 'help_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      let helpMessage = translate('help_intro') + '\n\n';

      const groups: Array<[string, string[]]> = [
        ['Chat', ['start', 'switchmodel', 'new', 'history', 'compare', 'translate', 'rewrite', 'summarize', 'cancel']],
        ['Agent runtime', ['agent', 'quick', 'artifact', 'box']],
        ['Research', ['research', 'read', 'sources', 'feed', 'followfeed', 'feeds', 'unfollowfeed', 'arxiv', 'github', 'bookmark', 'bookmarks', 'unbookmark']],
        ['Memory', ['memory', 'remember', 'recall', 'forget', 'people', 'topics']],
        ['Utilities', ['calc', 'convert', 'currency', 'date', 'time', 'weather', 'remind', 'reminders', 'unremind', 'digest', 'digests', 'undigest', 'speak', 'img', 'flux']],
        ['Group and admin', ['status', 'dashboard', 'setambient', 'setreplystyle', 'groupprofile', 'setgroupprofile', 'addgroupprofile', 'cleargroupprofile', 'usage', 'cache', 'synccommands']],
      ];
      for (const [group, names] of groups) {
        helpMessage += `${group}\n`;
        for (const name of names) {
          const command = commands.find(candidate => candidate.name === name);
          if (!command) continue;
          helpMessage += `/${command.name} - ${translate(command.description)}\n`;
        }
        helpMessage += '\n';
      }

      helpMessage += translate('image_analysis_description');
      
      await bot.sendMessage(chatId, helpMessage);
    },
  },
  {
    name: 'groupprofile',
    description: 'groupprofile_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const profile = await bot.getGroupProfile(sessionKey);
      if (!profile) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'no_group_profile'));
        return;
      }

      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'group_profile', { profile }));
    },
  },
  {
    name: 'setgroupprofile',
    description: 'setgroupprofile_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const profile = args.join(' ').trim();
      if (!profile) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'set_group_profile_usage'));
        return;
      }

      await bot.setGroupProfile(sessionKey, profile);
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'group_profile_updated'));
    },
  },
  {
    name: 'addgroupprofile',
    description: 'addgroupprofile_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const note = args.join(' ').trim();
      if (!note) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'add_group_profile_usage'));
        return;
      }

      await bot.appendGroupProfile(sessionKey, note);
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'group_profile_added'));
    },
  },
  {
    name: 'cleargroupprofile',
    description: 'cleargroupprofile_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      await bot.clearGroupProfile(sessionKey);
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'group_profile_cleared'));
    },
  },
  {
    name: 'synccommands',
    description: 'synccommands_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (sessionKey.startsWith('group:')) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'private_only'));
        return;
      }

      await bot.syncCommands();
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'menu_synced'));
    },
  },
  {
    name: 'status',
    description: 'status_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (sessionKey.startsWith('group:') && !(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const status = await bot.getStatus(sessionKey);
      const word = (key: UserMessageKey) => translateMessage(key);
      await bot.sendMessageWithFallback(chatId, translateMessage('status_report', {
        model: status.currentModel,
        summaryModel: status.summaryModel,
        researchModel: status.researchModel,
        visionModel: status.visionModel,
        ambientMemory: word(status.ambientMemory ? 'value_on' : 'value_off'),
        replyStyle: status.replyStyle,
        groupProfile: word(status.hasGroupProfile ? 'value_set' : 'value_empty'),
        summary: word(status.hasSummary ? 'value_present' : 'value_empty'),
        recentTurns: status.recentTurnCount,
        ambientBuffer: status.ambientMessageCount,
        seenMembers: status.seenMemberCount,
        personCards: status.personCardCount,
        activeTopics: status.activeTopicCount,
        webSearch: `${word(status.webSearchAvailable ? 'value_available' : 'value_unavailable')} (${status.searchProviders.join(' → ') || word('value_none')})`,
        modelFallbacks: status.modelFallbacks.join(' → ') || word('value_none'),
        modelHealth: status.modelProviderHealth.map(formatProviderHealth).join(', ') || word('value_no_observations'),
        searchHealth: status.searchProviderHealth.map(formatProviderHealth).join(', ') || word('value_no_observations'),
        searchQuota: status.searchQuotas.map(item => `${item.provider}=${item.used}/${item.cap ?? word('value_uncapped')}`).join(', ') || word('value_none'),
        commandMenu: status.commandMenuStatus,
      }));
    },
  },
  {
    name: 'dashboard',
    description: 'dashboard_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      if (!(await requireOwner(chatId, userId, bot))) return;
      if (sessionKey.startsWith('group:')) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'private_only'));
        return;
      }
      const access = await bot.createDashboardLink(sessionKey, userId);
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'dashboard_link', {
        url: access.url,
        minutes: access.expiresInMinutes,
      }));
    },
  },
  {
    name: 'calc',
    description: 'calc_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        const expression = args.join(' ').trim();
        if (!expression) throw new Error(await userMessage(bot, userId, 'calc_usage'));
        await bot.sendMessageWithFallback(chatId, `${expression} = ${formatNumber(calculateExpression(expression))}`);
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'calc_failed'));
      }
    },
  },
  {
    name: 'convert',
    description: 'convert_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        const conversion = convertUnits(args.join(' '));
        await bot.sendMessageWithFallback(chatId, `${args.join(' ')} = ${formatNumber(conversion.value)} ${conversion.to}`);
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'conversion_failed'));
      }
    },
  },
  {
    name: 'time',
    description: 'time_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        const timeZone = args[0] || 'Asia/Kuala_Lumpur';
        await bot.sendMessageWithFallback(chatId, `${timeZone}: ${formatTimeInZone(timeZone)}`);
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'timezone_failed'));
      }
    },
  },
  {
    name: 'date',
    description: 'date_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        await bot.sendMessageWithFallback(chatId, calculateDate(args.join(' ')));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'date_failed'));
      }
    },
  },
  {
    name: 'remind',
    description: 'remind_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        await bot.sendMessageWithFallback(chatId, await bot.addReminder(chatId, sessionKey, args.join(' ')));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'reminder_failed'));
      }
    },
  },
  {
    name: 'reminders',
    description: 'reminders_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      await bot.sendMessageWithFallback(chatId, await bot.listReminders(sessionKey) || await userMessage(bot, userId, 'no_reminders'));
    },
  },
  {
    name: 'unremind',
    description: 'unremind_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const removed = args[0] ? await bot.removeReminder(sessionKey, args[0]) : null;
      await bot.sendMessageWithFallback(chatId, removed
        ? await userMessage(bot, userId, 'reminder_removed', { value: removed })
        : await userMessage(bot, userId, 'reminder_not_found'));
    },
  },
  {
    name: 'digest',
    description: 'digest_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        await bot.sendMessageWithFallback(chatId, await bot.addDigest(chatId, sessionKey, args.join(' ')));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'digest_failed'));
      }
    },
  },
  {
    name: 'digests',
    description: 'digests_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      await bot.sendMessageWithFallback(chatId, await bot.listDigests(sessionKey) || await userMessage(bot, userId, 'no_digests'));
    },
  },
  {
    name: 'undigest',
    description: 'undigest_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const removed = args[0] ? await bot.removeDigest(sessionKey, args[0]) : null;
      await bot.sendMessageWithFallback(chatId, removed
        ? await userMessage(bot, userId, 'digest_removed', { value: removed })
        : await userMessage(bot, userId, 'digest_not_found'));
    },
  },
  {
    name: 'speak',
    description: 'speak_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const text = args.join(' ').trim();
      if (!text) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'speak_usage'));
        return;
      }
      try {
        const progress = await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'speech_progress'));
        const audio = await bot.synthesizeSpeech(text);
        await bot.sendVoice(chatId, audio, text.slice(0, 200));
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, await userMessage(bot, userId, 'speech_generated'));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'speech_failed'));
      }
    },
  },
  {
    name: 'translate',
    description: 'translate_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const [target, ...textParts] = args;
      if (!target || textParts.length === 0) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'translate_usage'));
        return;
      }
      try {
        await bot.sendMessageWithFallback(chatId, await bot.runTextShortcut(sessionKey, 'translate', textParts.join(' '), target));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'translation_failed'));
      }
    },
  },
  {
    name: 'rewrite',
    description: 'rewrite_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (args.length === 0) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'rewrite_usage'));
        return;
      }
      try {
        await bot.sendMessageWithFallback(chatId, await bot.runTextShortcut(sessionKey, 'rewrite', args.join(' ')));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'rewrite_failed'));
      }
    },
  },
  {
    name: 'summarize',
    description: 'summarize_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (args.length === 0) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'summarize_usage'));
        return;
      }
      try {
        await bot.sendMessageWithFallback(chatId, await bot.runTextShortcut(sessionKey, 'summarize', args.join(' ')));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'summarize_failed'));
      }
    },
  },
  {
    name: 'weather',
    description: 'weather_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        await bot.sendMessageWithFallback(chatId, await getWeather(args.join(' '), AbortSignal.timeout(10_000)));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'weather_failed'));
      }
    },
  },
  {
    name: 'currency',
    description: 'currency_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const match = args.join(' ').trim().match(/^(-?\d+(?:\.\d+)?)\s+([A-Za-z]{3})\s+(?:to|in)\s+([A-Za-z]{3})$/);
      if (!match) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'currency_usage'));
        return;
      }
      try {
        await bot.sendMessageWithFallback(chatId, await convertCurrency(Number(match[1]), match[2], match[3], AbortSignal.timeout(10_000)));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'currency_failed'));
      }
    },
  },
  {
    name: 'feed',
    description: 'feed_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const url = args[0];
      if (!url) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'feed_usage'));
        return;
      }
      try {
        const count = Number.parseInt(args[1] || '5', 10) || 5;
        await bot.sendMessageWithFallback(chatId, formatFeed(await readFeed(url, count, AbortSignal.timeout(10_000))));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'feed_failed'));
      }
    },
  },
  {
    name: 'followfeed',
    description: 'followfeed_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!args[0]) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'follow_feed_usage'));
        return;
      }
      try {
        const id = await bot.addFeedSubscription(sessionKey, args[0]);
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'feed_followed', { value: id }));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'follow_feed_failed'));
      }
    },
  },
  {
    name: 'feeds',
    description: 'feeds_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      await bot.sendMessageWithFallback(chatId, await bot.listFeedSubscriptions(sessionKey) || await userMessage(bot, userId, 'no_feeds'));
    },
  },
  {
    name: 'unfollowfeed',
    description: 'unfollowfeed_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const removed = args[0] ? await bot.removeFeedSubscription(sessionKey, args[0]) : null;
      await bot.sendMessageWithFallback(chatId, removed
        ? await userMessage(bot, userId, 'feed_unfollowed', { value: removed })
        : await userMessage(bot, userId, 'feed_not_found'));
    },
  },
  {
    name: 'github',
    description: 'github_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const repo = args[0];
      const view = args[1] === 'releases' || args[1] === 'issues' ? args[1] : 'summary';
      if (!repo) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'github_usage'));
        return;
      }
      try {
        const config = getConfig(bot.getEnv());
        await bot.sendMessageWithFallback(chatId, await getGitHubRepository(repo, view, config.githubToken, AbortSignal.timeout(10_000)));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'github_failed'));
      }
    },
  },
  {
    name: 'arxiv',
    description: 'arxiv_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (args.length === 0) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'arxiv_usage'));
        return;
      }
      try {
        await bot.sendMessageWithFallback(chatId, await searchArxiv(args.join(' '), 5, AbortSignal.timeout(12_000)));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : await userMessage(bot, userId, 'arxiv_failed'));
      }
    },
  },
  {
    name: 'usage',
    description: 'usage_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      if (!(await requireOwner(chatId, userId, bot))) {
        return;
      }
      await bot.sendMessageWithFallback(chatId, await bot.getUsageReport());
    },
  },
  {
    name: 'cache',
    description: 'cache_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      if (!(await requireOwner(chatId, userId, bot))) {
        return;
      }
      await bot.sendMessageWithFallback(chatId, await bot.getCacheReport(sessionKey));
    },
  },
  {
    name: 'research',
    description: 'research_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const question = args.join(' ').trim();
      if (!question) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'research_usage'));
        return;
      }
      let taskId: string | null = null;
      let progress: Awaited<ReturnType<TelegramBot['sendMessageWithFallback']>> = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, 'research');
        await sendChatAction(chatId, 'typing', bot.getEnv());
        progress = await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'research_progress'));
        const answer = await bot.research(sessionKey, question);
        await bot.assertTaskActive(sessionKey, taskId);
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, answer);
        else await bot.sendMessageWithFallback(chatId, answer);
      } catch (error) {
        console.error('Research command failed:', error);
        const message = await userMessage(bot, userId, 'research_failed', {
          error: error instanceof Error ? error.message : await userMessage(bot, userId, 'unknown_error'),
        });
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, message);
        else await bot.sendMessageWithFallback(chatId, message);
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: 'read',
    description: 'read_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const forceAgent = args[0]?.toLowerCase() === '--agent';
      const url = args[forceAgent ? 1 : 0]?.trim();
      if (!url) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'read_usage'));
        return;
      }
      const instruction = args.slice(forceAgent ? 2 : 1).join(' ').trim();
      if (forceAgent || (/\.pdf(?:[?#]|$)/i.test(url) && instruction)) {
        try {
          await bot.startBoxAgentJob(chatId, sessionKey, userId, `Read and analyze ${url}. ${instruction || 'Extract the important content accurately, using PDF or browser tooling as needed.'}`);
        } catch (error) {
          await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : 'Box reading request failed.');
        }
        return;
      }
      let taskId: string | null = null;
      let progress: Awaited<ReturnType<TelegramBot['sendMessageWithFallback']>> = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, 'read');
        await sendChatAction(chatId, 'typing', bot.getEnv());
        progress = await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'read_progress'));
        const answer = await bot.readUrl(sessionKey, url);
        await bot.assertTaskActive(sessionKey, taskId);
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, answer);
        else await bot.sendMessageWithFallback(chatId, answer);
      } catch (error) {
        console.error('Read command failed:', error);
        const message = await userMessage(bot, userId, 'read_failed', {
          error: error instanceof Error ? error.message : await userMessage(bot, userId, 'unknown_error'),
        });
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, message);
        else await bot.sendMessageWithFallback(chatId, message);
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: 'sources',
    description: 'sources_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      const sources = await bot.getLastSources(sessionKey);
      await bot.sendMessageWithFallback(chatId, sources || await userMessage(bot, userId, 'no_sources'));
    },
  },
  {
    name: 'compare',
    description: 'compare_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const question = args.join(' ').trim();
      if (!question) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'compare_usage'));
        return;
      }
      let taskId: string | null = null;
      let progress: Awaited<ReturnType<TelegramBot['sendMessageWithFallback']>> = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, 'compare');
        await sendChatAction(chatId, 'typing', bot.getEnv());
        progress = await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'compare_progress'));
        const answer = await bot.compareModels(sessionKey, question);
        await bot.assertTaskActive(sessionKey, taskId);
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, answer);
        else await bot.sendMessageWithFallback(chatId, answer);
      } catch (error) {
        const message = await userMessage(bot, userId, 'compare_failed', {
          error: error instanceof Error ? error.message : await userMessage(bot, userId, 'unknown_error'),
        });
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, message);
        else await bot.sendMessageWithFallback(chatId, message);
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: 'box',
    description: 'box_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if ((args[0] || '').toLowerCase() !== 'enable') {
        await bot.sendMessageWithFallback(chatId, 'Usage: /box enable (owner-only, from the Telegram group to bind)');
        return;
      }
      if (!(await requireOwner(chatId, userId, bot))) return;
      if (!sessionKey.startsWith('group:')) {
        await bot.sendMessageWithFallback(chatId, 'Run /box enable inside the Telegram group you want to bind.');
        return;
      }
      try {
        await bot.enableBoxForChat(chatId, sessionKey);
        await bot.sendMessageWithFallback(chatId, `Box execution is bound to this group (${chatId}).`);
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : 'Failed to bind Box execution.');
      }
    },
  },
  {
    name: 'agent',
    description: 'agent_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      try {
        const action = (args[0] || '').toLowerCase();
        if (action === 'status') {
          await bot.sendMessageWithFallback(chatId, await bot.getBoxAgentStatus(chatId, userId, args[1]));
          return;
        }
        if (action === 'cancel') {
          if (!args[1]) {
            await bot.sendMessageWithFallback(chatId, 'Usage: /agent cancel <job-id>');
            return;
          }
          await bot.sendMessageWithFallback(chatId, await bot.cancelBoxAgentJob(chatId, userId, args[1]));
          return;
        }
        if (action === 'approve') {
          if (!args[1] || !args[2]) {
            await bot.sendMessageWithFallback(chatId, 'Usage: /agent approve <job-id> <nonce>');
            return;
          }
          await bot.sendMessageWithFallback(chatId, await bot.approveBoxAgentJob(chatId, userId, args[1], args[2]));
          return;
        }
        if (action === 'schedule') {
          const operation = (args[1] || '').toLowerCase();
          if (operation === 'list') {
            await bot.sendMessageWithFallback(chatId, await bot.listBoxAgentSchedules(chatId, userId));
            return;
          }
          if (['pause', 'resume', 'delete'].includes(operation)) {
            if (!args[2]) throw new Error(`Usage: /agent schedule ${operation} <schedule-id>`);
            await bot.sendMessageWithFallback(chatId, await bot.changeBoxAgentSchedule(chatId, userId, args[2], operation as 'pause' | 'resume' | 'delete'));
            return;
          }
          if (operation === 'create') {
            const fields = args.slice(2, 7);
            if (fields.length !== 5) throw new Error('Usage: /agent schedule create <5-field UTC cron> [--model deepseek|glm] <prompt>');
            const rest = args.slice(7);
            let requestedRoute: string | undefined;
            if (rest[0] === '--model') { rest.shift(); requestedRoute = rest.shift(); }
            const prompt = rest.join(' ').trim();
            if (!prompt) throw new Error('Scheduled agent prompt is required.');
            await bot.sendMessageWithFallback(chatId, await bot.createBoxAgentSchedule(chatId, userId, fields.join(' '), prompt, requestedRoute));
            return;
          }
          throw new Error('Usage: /agent schedule create|list|pause|resume|delete');
        }

        let requestedRoute: string | undefined;
        const requestArgs = [...args];
        if (requestArgs[0]?.startsWith('--model=')) {
          requestedRoute = requestArgs.shift()!.slice('--model='.length);
        } else if (requestArgs[0] === '--model') {
          requestArgs.shift();
          requestedRoute = requestArgs.shift();
        }
        const request = requestArgs.join(' ').trim();
        if (!request) {
          await bot.sendMessageWithFallback(
            chatId,
            'Usage: /agent [--model deepseek|glm] <request>\n/agent status [job-id]\n/agent cancel <job-id>\n/agent approve <job-id> <nonce>',
          );
          return;
        }
        await bot.startBoxAgentJob(chatId, sessionKey, userId, request, requestedRoute);
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : 'Box agent request failed.');
      }
    },
  },
  {
    name: 'quick',
    description: 'quick_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const request = args.join(' ').trim();
      if (!request) {
        await bot.sendMessageWithFallback(chatId, 'Usage: /quick <request>');
        return;
      }
      try {
        await bot.runQuickChat(chatId, sessionKey, userId, request);
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : 'Quick request failed.');
      }
    },
  },
  {
    name: 'artifact',
    description: 'artifact_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!args[0]) {
        await bot.sendMessageWithFallback(chatId, 'Usage: /artifact <artifact-id>');
        return;
      }
      try {
        await bot.sendMessageWithFallback(chatId, await bot.getArtifactLink(chatId, userId, args[0]));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, error instanceof Error ? error.message : 'Artifact lookup failed.');
      }
    },
  },
  {
    name: 'cancel',
    description: 'cancel_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      const type = await bot.cancelActiveTask(sessionKey);
      await bot.sendMessageWithFallback(chatId, type
        ? await userMessage(bot, userId, 'cancelling_task', { type })
        : await userMessage(bot, userId, 'no_active_task'));
    },
  },
  {
    name: 'bookmark',
    description: 'bookmark_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const [url, ...titleParts] = args;
      if (!url) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'bookmark_usage'));
        return;
      }
      try {
        await bot.addBookmark(sessionKey, url, titleParts.join(' '));
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'bookmark_saved'));
      } catch (error) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'bookmark_failed', {
          error: error instanceof Error ? error.message : await userMessage(bot, userId, 'unknown_error'),
        }));
      }
    },
  },
  {
    name: 'bookmarks',
    description: 'bookmarks_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot) => {
      await bot.sendMessageWithFallback(chatId, await bot.listBookmarks(sessionKey) || await userMessage(bot, userId, 'no_bookmarks'));
    },
  },
  {
    name: 'unbookmark',
    description: 'unbookmark_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      const removed = await bot.removeBookmark(sessionKey, args.join(' '));
      await bot.sendMessageWithFallback(chatId, removed
        ? await userMessage(bot, userId, 'bookmark_removed', { value: removed })
        : await userMessage(bot, userId, 'bookmark_not_found'));
    },
  },
  {
    name: 'setambient',
    description: 'setambient_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const value = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'ambient_usage'));
        return;
      }

      const settings = await bot.setBotSettings(sessionKey, { ambientMemory: value === 'on' });
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'ambient_updated', {
        value: translateMessage(settings.ambientMemory ? 'value_on' : 'value_off'),
      }));
    },
  },
  {
    name: 'setreplystyle',
    description: 'setreplystyle_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const replyStyle = (args[0] || '').toLowerCase();
      if (!['short', 'normal', 'long'].includes(replyStyle)) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'reply_style_usage'));
        return;
      }

      const settings = await bot.setBotSettings(sessionKey, { replyStyle: replyStyle as 'short' | 'normal' | 'long' });
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'reply_style_updated', { value: settings.replyStyle }));
    },
  },
  {
    name: 'img',
    description: 'img_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
  
      if (!args.length) {
        await bot.sendMessageWithFallback(chatId, translate('image_prompt_required'));
        return;
      }
  
      const validSizes = ['1024x1024', '1024x1792', '1792x1024'];
      const sizeArg = args[args.length - 1].toLowerCase();
      let size: string;
      let prompt: string;
  
      if (validSizes.includes(sizeArg)) {
        size = sizeArg;
        prompt = args.slice(0, -1).join(' ');
      } else {
        size = '1024x1024';
        prompt = args.join(' ');

        if (sizeArg.includes('x') || sizeArg.includes('*')) {
          const sizeOptions = validSizes.map(s => `\`${s}\``).join(', ');
          await bot.sendMessage(chatId, translate('invalid_size') + sizeOptions);
          return;
        }
      }
  
      let taskId: string | null = null;
      let progress: Awaited<ReturnType<TelegramBot['sendMessageWithFallback']>> = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, 'image');
        await sendChatAction(chatId, 'upload_photo', bot.getEnv());
        progress = await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'image_progress'));
        const imageApi = new ImageGenerationAPI(bot.getEnv());
        const startedAt = Date.now();
        try {
          const imageUrl = await imageApi.generateImage(prompt, size);
          bot.recordModelOperation(imageApi.getDefaultModel(), 'image', startedAt, true);
          await bot.assertTaskActive(sessionKey, taskId);
          await bot.sendPhoto(chatId, imageUrl, { caption: prompt });
          if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, await userMessage(bot, userId, 'image_complete'));
        } catch (error) {
          bot.recordModelOperation(imageApi.getDefaultModel(), 'image', startedAt, false, error);
          throw error;
        }
      } catch (error) {
        console.error('Error generating image:', error);
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, translate('image_generation_error'));
        else await bot.sendMessage(chatId, translate('image_generation_error'));
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: 'flux',
    description: 'flux_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {

      if (!args.length) {
        await bot.sendMessage(chatId, translate('flux_usage'));
        return;
      }

      let aspectRatio = '1:1';
      let prompt: string;

      const fluxApi = new FluxAPI(bot.getEnv());
      const validRatios = fluxApi.getValidAspectRatios();

      if (validRatios.includes(args[args.length - 1])) {
        aspectRatio = args[args.length - 1];
        prompt = args.slice(0, -1).join(' ');
      } else {
        prompt = args.join(' ');
      }

      let taskId: string | null = null;
      let progress: Awaited<ReturnType<TelegramBot['sendMessageWithFallback']>> = [];
      try {
        taskId = await bot.beginCancellableTask(sessionKey, 'image');
        await sendChatAction(chatId, 'upload_photo', bot.getEnv());
        progress = await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'image_progress'));
        const startedAt = Date.now();
        let imageData: Uint8Array;
        let optimizedPrompt: string | undefined;
        try {
          ({ imageData, optimizedPrompt } = await fluxApi.generateImage(prompt, aspectRatio));
          bot.recordModelOperation(fluxApi.getDefaultModel(), 'image', startedAt, true);
          await bot.assertTaskActive(sessionKey, taskId);
        } catch (error) {
          bot.recordModelOperation(fluxApi.getDefaultModel(), 'image', startedAt, false, error);
          throw error;
        }
        
        const config = getConfig(bot.getEnv());
        let caption = `${translate('original_prompt')}: ${prompt}\n`;
        caption += `${translate('image_specs')}: ${aspectRatio}\n`;
        
        if (config.promptOptimization && optimizedPrompt) {
          caption += `${translate('prompt_generation_model')}: ${config.externalModel || 'Unknown'}\n`;
          caption += `${translate('optimized_prompt')}: ${optimizedPrompt}\n`;
        }

        await bot.sendPhoto(chatId, imageData, { caption: caption });
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, await userMessage(bot, userId, 'image_complete'));
      } catch (error) {
        console.error(`Error generating Flux image for user ${userId}:`, error);
        if (error instanceof Error) {
          console.error('Error details:', error.message);
        }
        if (progress[0]?.message_id) await bot.replaceProgressMessage(chatId, progress[0].message_id, translate('image_generation_error'));
        else await bot.sendMessage(chatId, translate('image_generation_error'));
      } finally {
        if (taskId) await bot.finishCancellableTask(sessionKey, taskId);
      }
    },
  },
  {
    name: 'people',
    description: 'people_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const formatted = await bot.getFormattedPersonCards(sessionKey);
      if (!formatted) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'no_people'));
        return;
      }

      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'people_header', { value: formatted }));
    },
  },
  {
    name: 'topics',
    description: 'topics_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const formatted = await bot.getFormattedActiveTopics(sessionKey);
      if (!formatted) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'no_topics'));
        return;
      }

      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'topics_header', { value: formatted }));
    },
  },
  {
    name: 'memory',
    description: 'memory_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (sessionKey.startsWith('group:') && !(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const summary = await bot.getFormattedSummary(sessionKey);
      if (!summary) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'no_summary'));
        return;
      }

      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'summary_header', { value: summary }));
    },
  },
  {
    name: 'remember',
    description: 'remember_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (sessionKey.startsWith('group:') && !(await requireGroupAdmin(chatId, sessionKey, userId, bot))) return;
      const text = args.join(' ').trim();
      if (!text) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'remember_usage'));
        return;
      }
      const id = await bot.rememberDurableMemory(sessionKey, text);
      await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'remembered', { id }));
    },
  },
  {
    name: 'recall',
    description: 'recall_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (sessionKey.startsWith('group:') && !(await requireGroupAdmin(chatId, sessionKey, userId, bot))) return;
      const result = await bot.recallDurableMemory(sessionKey, args.join(' ').trim());
      await bot.sendMessageWithFallback(chatId, result
        ? await userMessage(bot, userId, 'memories_header', { value: result })
        : await userMessage(bot, userId, 'no_memory_match'));
    },
  },
  {
    name: 'forget',
    description: 'forget_description',
    action: async (chatId: number, sessionKey: string, userId: string, bot: TelegramBot, args: string[]) => {
      if (!(await requireGroupAdmin(chatId, sessionKey, userId, bot))) {
        return;
      }

      const name = args.join(' ').trim();
      if (!name) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'forget_usage'));
        return;
      }

      const forgottenMemory = await bot.forgetSavedMemory(sessionKey, name);
      if (forgottenMemory) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'memory_forgotten', { value: forgottenMemory }));
        return;
      }

      const deleted = await bot.deletePersonCard(sessionKey, name);
      if (deleted) {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'person_forgotten', { name }));
      } else {
        await bot.sendMessageWithFallback(chatId, await userMessage(bot, userId, 'person_not_found', { name }));
      }
    },
  },
];
