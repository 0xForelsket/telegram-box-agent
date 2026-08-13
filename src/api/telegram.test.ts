import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TelegramBot from './telegram';
import { Message } from './chat_types';
import { Env } from '../env';
import { TelegramTypes } from '../../types/telegram';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    WHITELISTED_USERS: '42',
    SYSTEM_INIT_MESSAGE: 'test',
    SYSTEM_INIT_MESSAGE_ROLE: 'system',
    DEFAULT_MODEL: 'gemini-test',
    UPSTASH_REDIS_REST_URL: 'https://redis.example',
    UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    CLOUDFLARE_API_TOKEN: '',
    CLOUDFLARE_ACCOUNT_ID: '',
    FLUX_STEPS: '4',
    GOOGLE_MODEL_KEY: 'google-key',
    GOOGLE_MODELS: 'gemini-test',
    GROQ_API_KEY: '',
    GROQ_MODELS: '',
    CLAUDE_API_KEY: '',
    CLAUDE_MODELS: '',
    AZURE_API_KEY: '',
    AZURE_MODELS: '',
    AZURE_ENDPOINT: '',
    ...overrides,
  };
}

function webhookRequest(update: TelegramTypes.Update, secret = 'webhook-secret'): Request {
  return new Request('https://worker.test', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify(update),
  });
}

function createCallbackUpdate(fromUserId: number, data: string): TelegramTypes.Update {
  return {
    update_id: 1,
    callback_query: {
      id: 'callback-1',
      from: {
        id: fromUserId,
        is_bot: false,
        first_name: 'Test',
      },
      chat_instance: 'chat-instance',
      data,
      message: {
        message_id: 10,
        date: 1,
        chat: {
          id: -100,
          type: 'group',
          title: 'Test Group',
        },
      },
    },
  };
}

function createPrivateMessageUpdate(updateId: number, text: string): TelegramTypes.Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      from: { id: 42, is_bot: false, first_name: 'Test' },
      chat: { id: 42, type: 'private' },
      text,
    },
  };
}

describe('TelegramBot model picker', () => {
  it('resolves a stale model selection to the configured default', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === 'https://api.deepseek.com/v1/models') {
        return Response.json({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] });
      }
      throw new Error(`Unexpected fetch: ${input.toString()}`);
    }));
    const bot = new TelegramBot(createEnv({
      DEFAULT_MODEL: 'deepseek-v4-flash',
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const internals = bot as unknown as { redis: { get: ReturnType<typeof vi.fn> } };
    internals.redis = { get: vi.fn().mockResolvedValue('retired-model') };

    await expect(bot.getCurrentModel('private:42')).resolves.toBe('deepseek-v4-flash');
    await expect(bot.getSelectableModels()).resolves.toEqual([
      'gemini-test', 'deepseek-v4-flash', 'deepseek-v4-pro',
    ]);
    vi.unstubAllGlobals();
  });

  it('uses the selected model for vision only when it is explicitly vision-capable', () => {
    const bot = new TelegramBot(createEnv({
      OPENAI_API_KEY: 'openai-key',
      OPENAI_MODELS: 'vision-test',
      VISION_MODEL: 'auto',
      VISION_MODELS: 'gemini-test,vision-test',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-pro',
    }));
    const getRoleModel = (bot as unknown as {
      getRoleModel(role: 'vision', fallback: string): string;
    }).getRoleModel.bind(bot);

    expect(getRoleModel('vision', 'vision-test')).toBe('vision-test');
    expect(getRoleModel('vision', 'deepseek-v4-pro')).toBe('gemini-test');
  });
});

describe('TelegramBot callback handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === 'https://redis.example') {
        const command = JSON.parse(init?.body as string) as unknown[];
        const commandName = String(command[0]).toUpperCase();
        if (commandName === 'GET') {
          return Response.json({ result: null });
        }
        if (commandName === 'SET') {
          return Response.json({ result: 'OK' });
        }
        if (commandName === 'DEL') {
          return Response.json({ result: 1 });
        }
        return Response.json({ result: null });
      }
      if (url === 'https://redis.example/pipeline') {
        const commands = JSON.parse(init?.body as string) as unknown[][];
        return Response.json(commands.map(command => {
          const commandName = String(command[0]).toUpperCase();
          return { result: commandName === 'INCR' ? 1 : 1 };
        }));
      }
      if (url === 'https://api.exa.ai/search') {
        return Response.json({
          requestId: 'search-1',
          results: [
            {
              title: 'Comey and Trump Instagram post',
              url: 'https://example.com/comey-trump-instagram',
              highlights: ['Search-grounded detail about the Comey and Trump Instagram post.'],
            },
          ],
        });
      }
      if (url.startsWith('https://query2.finance.yahoo.com/v1/finance/search')) {
        const parsedUrl = new URL(url);
        const query = parsedUrl.searchParams.get('q') || '';
        return Response.json({
          quotes: [
            {
              symbol: 'SIVE.ST',
              quoteType: 'EQUITY',
              shortname: 'Sivers Semiconductors AB',
              longname: 'Sivers Semiconductors AB',
              exchange: 'STO',
              exchDisp: 'Stockholm',
              score: query.includes('Sivers Semiconductors') ? 20000 : 100,
              isYahooFinance: true,
            },
          ],
        });
      }
      if (url.startsWith('https://query1.finance.yahoo.com/v8/finance/chart/')) {
        return Response.json({
          chart: {
            result: [
              {
                meta: {
                  symbol: 'SIVE.ST',
                  instrumentType: 'EQUITY',
                  shortName: 'Sivers Semiconductors AB',
                  longName: 'Sivers Semiconductors AB',
                  exchangeName: 'STO',
                  fullExchangeName: 'Stockholm',
                  currency: 'SEK',
                  regularMarketPrice: 6.12,
                  chartPreviousClose: 5.7,
                  regularMarketDayHigh: 6.2,
                  regularMarketDayLow: 5.8,
                  regularMarketVolume: 123456,
                  regularMarketTime: 1770000000,
                },
                timestamp: [1769913600, 1770000000],
                indicators: {
                  quote: [{
                    open: [5.6, 5.75],
                    high: [5.8, 6.2],
                    low: [5.5, 5.8],
                    close: [5.7, 6.12],
                    volume: [100000, 123456],
                  }],
                },
              },
            ],
            error: null,
          },
        });
      }
      if (url.startsWith('https://en.wikipedia.org/w/rest.php/v1/search/page')) {
        return Response.json({
          pages: [{
            key: 'James_Comey',
            title: 'James Comey',
            description: 'American lawyer',
            excerpt: 'James Comey is an American lawyer.',
          }],
        });
      }
      if (url === 'https://en.wikipedia.org/api/rest_v1/page/summary/James_Comey') {
        return Response.json({
          title: 'James Comey',
          description: 'American lawyer',
          extract: 'James Brien Comey Jr. is an American lawyer.',
          content_urls: {
            desktop: {
              page: 'https://en.wikipedia.org/wiki/James_Comey',
            },
          },
          type: 'standard',
        });
      }
      if (url.startsWith('https://api.telegram.org/')) {
        return Response.json({
          ok: true,
          result: {
            message_id: 99,
            from: { id: 1, is_bot: true, first_name: 'bot' },
            chat: { id: -100, type: 'group' },
            date: 1,
            text: 'ok',
          },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not allow unwhitelisted users to trigger inline model changes', async () => {
    const bot = new TelegramBot(createEnv());

    await bot.handleUpdate(createCallbackUpdate(99, 'model_gemini-test'));

    const redisCommands = fetchMock.mock.calls
      .filter(([input]) => input.toString() === 'https://redis.example')
      .map(([, init]) => JSON.parse(init?.body as string) as string[]);

    expect(redisCommands.some(command => command[0] === 'SET' && command[1] === 'model:group:-100')).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes('/sendMessage'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes('/answerCallbackQuery'))).toBe(true);
  });

  it('acknowledges a callback it does not recognise without acting on it', async () => {
    const bot = new TelegramBot(createEnv());

    await bot.handleUpdate(createCallbackUpdate(42, 'lang_es'));

    const redisCommands = fetchMock.mock.calls
      .filter(([input]) => input.toString() === 'https://redis.example')
      .map(([, init]) => JSON.parse(init?.body as string) as string[]);

    // The language picker is gone; a stale button from an old menu must not
    // write state, but the query still has to be answered or Telegram spins.
    expect(redisCommands.some(command => command[0] === 'SET' && String(command[1]).startsWith('language:'))).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().includes('/answerCallbackQuery'))).toBe(true);
  });

  it('lets the model answer without a tool even when the prompt says look up', async () => {
    const bot = new TelegramBot(createEnv({
      EXA_API_KEY: 'exa-key',
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'I can answer directly.' } }],
    });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const generateChatResponse = (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string): Promise<string>;
    }).generateChatResponse.bind(bot);

    const response = await generateChatResponse([
      { role: 'user', content: 'look up James Comey' },
    ], 'deepseek-v4-pro', 'private:42');

    expect(response).toBe('I can answer directly.');
    expect(createCompletion).toHaveBeenCalledTimes(1);
    expect(createCompletion.mock.calls[0][4]).toMatchObject({ toolChoice: 'auto' });
    expect(fetchMock.mock.calls.some(([input]) => input.toString() === 'https://api.exa.ai/search')).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => input.toString().startsWith('https://en.wikipedia.org/'))).toBe(false);
  });

  it('executes web search only when the model selects it', async () => {
    const bot = new TelegramBot(createEnv({
      EXA_API_KEY: 'exa-key',
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'call-web', type: 'function',
              function: { name: 'web_search', arguments: JSON.stringify({ query: 'Comey Trump Instagram post' }) },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'web-grounded answer' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const generateChatResponse = (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string): Promise<string>;
    }).generateChatResponse.bind(bot);

    const response = await generateChatResponse([
      { role: 'user', content: 'What happened between Comey and Trump on Instagram?' },
    ], 'deepseek-v4-pro', 'private:42');

    expect(response).toBe('web-grounded answer');
    expect(createCompletion).toHaveBeenCalledTimes(2);
    expect(createCompletion.mock.calls[0][4]).toMatchObject({ toolChoice: 'auto' });
    expect(createCompletion.mock.calls[1][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-web' }),
    ]));
    expect(createCompletion.mock.calls[1][4]).toMatchObject({ toolChoice: 'auto' });
    expect(fetchMock.mock.calls.some(([input]) => input.toString() === 'https://api.exa.ai/search')).toBe(true);
  });

  it('reads a user-supplied URL when selected and recovers blocked pages through search', async () => {
    const bot = new TelegramBot(createEnv({
      EXA_API_KEY: 'exa-key',
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call-url', type: 'function',
            function: { name: 'read_url', arguments: JSON.stringify({ url: 'https://x.com/example/status/123' }) },
          }],
        } }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'link-grounded answer' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const response = await (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string): Promise<string>;
    }).generateChatResponse([{ role: 'user', content: 'What does https://x.com/example/status/123 say?' }], 'deepseek-v4-pro', 'private:42');

    expect(response).toBe('link-grounded answer');
    expect(createCompletion.mock.calls[0][4].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'read_url' }) }),
    ]));
    expect(createCompletion.mock.calls[1][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool', tool_call_id: 'call-url',
        content: expect.stringContaining('Indexed web evidence follows'),
      }),
    ]));
    expect(fetchMock.mock.calls.some(([input]) => input.toString() === 'https://api.exa.ai/search')).toBe(true);
  });

  it('allows DeepSeek and GLM-style models to choose another tool after seeing the first result', async () => {
    const bot = new TelegramBot(createEnv({
      EXA_API_KEY: 'exa-key',
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call-web', type: 'function',
            function: { name: 'web_search', arguments: JSON.stringify({ query: 'Comey Trump news' }) },
          }],
        } }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call-wiki', type: 'function',
            function: { name: 'wikipedia_lookup', arguments: JSON.stringify({ query: 'James Comey' }) },
          }],
        } }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'combined answer' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const response = await (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string): Promise<string>;
    }).generateChatResponse([{ role: 'user', content: 'Explain the current story and who Comey is.' }], 'deepseek-v4-pro', 'private:42');

    expect(response).toBe('combined answer');
    expect(createCompletion).toHaveBeenCalledTimes(3);
    expect(createCompletion.mock.calls[1][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-web' }),
    ]));
    expect(createCompletion.mock.calls[2][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-web' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-wiki' }),
    ]));
    expect(createCompletion.mock.calls.every(call => call[4].toolChoice === 'auto')).toBe(true);
  });

  it('lets ordinary chat create a Redis-backed reminder through the agent tool loop', async () => {
    const bot = new TelegramBot(createEnv({
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call-reminder', type: 'function',
            function: { name: 'manage_reminders', arguments: JSON.stringify({ action: 'create', schedule: 'in 20m', text: 'check the oven' }) },
          }],
        } }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done — I will remind you in 20 minutes.' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const response = await (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string, chatId?: number): Promise<string>;
    }).generateChatResponse([{ role: 'user', content: 'Remind me in 20 minutes to check the oven.' }], 'deepseek-v4-pro', '42', 42);

    expect(response).toContain('remind you');
    expect(createCompletion.mock.calls[0][4].tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'manage_reminders' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'manage_memory' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'calculator' }) }),
    ]));
    expect(createCompletion.mock.calls[1][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call-reminder',
        content: expect.stringContaining('Reminder'),
      }),
    ]));
    const redisCommands = fetchMock.mock.calls
      .filter(([input]) => input.toString() === 'https://redis.example')
      .map(([, init]) => JSON.parse(init?.body as string) as string[]);
    expect(redisCommands.some(command => command[0] === 'ZADD' && command[1] === 'schedule:v1:due')).toBe(true);
  });

  it('does not recreate the retired cron-stepped agent queue through a stale model tool call', async () => {
    const bot = new TelegramBot(createEnv({
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call-agent-job', type: 'function',
            function: { name: 'manage_agent_jobs', arguments: JSON.stringify({
              action: 'create', goal: 'Research the latest semiconductor cycle and prepare a concise investment brief.',
            }) },
          }],
        } }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Queued. I will send the brief when the background job finishes.' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const response = await (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string, chatId?: number): Promise<string>;
    }).generateChatResponse([{ role: 'user', content: 'Work on a semiconductor-cycle brief in the background and send it later.' }], 'deepseek-v4-pro', '42', 42);

    expect(response).toContain('Queued');
    expect(createCompletion.mock.calls[1][1]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call-agent-job',
        content: 'Unknown or unavailable tool: manage_agent_jobs',
      }),
    ]));
    const redisCommands = fetchMock.mock.calls
      .filter(([input]) => input.toString() === 'https://redis.example')
      .map(([, init]) => JSON.parse(init?.body as string) as string[]);
    expect(redisCommands.some(command => command[0] === 'ZADD' && command[1] === 'agent_runs:v1:due')).toBe(false);
  });

  it('limits unattended agent wakes to read-only tools', async () => {
    const bot = new TelegramBot(createEnv({
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
      SEARCH_PROVIDERS: 'exa',
      EXA_API_KEY: 'exa-key',
    }));
    const createCompletion = vi.fn().mockResolvedValue({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'step observation' } }],
    });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    await (bot as unknown as {
      generateChatResponse(
        messages: Message[], currentModel: string, sessionKey: string, chatId?: number,
        onTextDelta?: undefined, attemptedModels?: Set<string>, allowAgentJobs?: boolean,
        allowMutatingTools?: boolean,
      ): Promise<string>;
    }).generateChatResponse(
      [{ role: 'user', content: 'Execute one saved research step.' }],
      'deepseek-v4-pro', '42', 42, undefined, new Set(), false, false,
    );

    const toolNames = createCompletion.mock.calls[0][4].tools
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(['web_search', 'read_url', 'calculator']));
    expect(toolNames).not.toEqual(expect.arrayContaining([
      'manage_reminders', 'manage_memory', 'manage_agent_jobs',
    ]));
  });

  it('recovers structured plans and step observations from agent envelopes', () => {
    const bot = new TelegramBot(createEnv());
    const internals = bot as unknown as {
      parseAgentPlan(response: string): string[];
      parseAgentStepResponse(response: string): { type: string; observation?: string; result?: string };
    };

    expect(internals.parseAgentPlan('<agent-plan>{"steps":["Find sources","Compare evidence"]}</agent-plan>'))
      .toEqual(['Find sources', 'Compare evidence']);
    expect(internals.parseAgentStepResponse(
      '<agent-step>{"status":"advanced","observation":"Two primary sources agree."}</agent-step>',
    )).toEqual({ type: 'advanced', observation: 'Two primary sources agree.' });
    expect(internals.parseAgentStepResponse(
      '<agent-step>{"status":"complete","observation":"Done.","final_answer":"Final brief"}</agent-step>',
    )).toEqual({ type: 'completed', result: 'Final brief', observation: 'Done.' });
  });

  it('executes Wikipedia only when the model selects it', async () => {
    const bot = new TelegramBot(createEnv({
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'call-wiki', type: 'function',
              function: { name: 'wikipedia_lookup', arguments: JSON.stringify({ query: 'James Comey' }) },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'wikipedia-grounded answer' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const generateChatResponse = (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string): Promise<string>;
    }).generateChatResponse.bind(bot);

    const response = await generateChatResponse([
      { role: 'user', content: 'Who is James Comey?' },
    ], 'deepseek-v4-pro', 'private:42');

    expect(response).toBe('wikipedia-grounded answer');
    expect(fetchMock.mock.calls.some(([input]) => input.toString().startsWith('https://en.wikipedia.org/'))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => input.toString() === 'https://api.exa.ai/search')).toBe(false);
  });

  it('executes a stock quote only when the model selects it and supplies the subject', async () => {
    const bot = new TelegramBot(createEnv({
      EXA_API_KEY: 'exa-key',
      OPENAI_COMPATIBLE_KEY: 'deepseek-key',
      OPENAI_COMPATIBLE_URL: 'https://api.deepseek.com',
      OPENAI_COMPATIBLE_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
    }));
    const createCompletion = vi.fn()
      .mockResolvedValueOnce({
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant', content: null,
            tool_calls: [{
              id: 'call-stock', type: 'function',
              function: { name: 'stock_quote', arguments: JSON.stringify({ query: 'Sivers Semiconductors' }) },
            }],
          },
        }],
      })
      .mockResolvedValueOnce({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'stock-grounded answer' } }],
      });
    (bot as unknown as { createTrackedChatCompletion: typeof createCompletion }).createTrackedChatCompletion = createCompletion;

    const generateChatResponse = (bot as unknown as {
      generateChatResponse(messages: Message[], currentModel: string, sessionKey: string): Promise<string>;
    }).generateChatResponse.bind(bot);

    const response = await generateChatResponse([
      { role: 'system', content: '## Topics\nSGX rally from an older discussion.' },
      { role: 'assistant', content: 'Sivers Semiconductors is a Swedish fabless chip company.' },
      { role: 'user', content: 'why have they pumped so much recently look at their stock prices' },
    ], 'deepseek-v4-pro', 'private:42');

    expect(response).toBe('stock-grounded answer');
    const yahooSearchCall = fetchMock.mock.calls.find(([input]) => input.toString().startsWith('https://query2.finance.yahoo.com/v1/finance/search'));
    expect(yahooSearchCall).toBeDefined();
    const query = new URL(yahooSearchCall?.[0].toString() || '').searchParams.get('q') || '';
    expect(query).toContain('Sivers Semiconductors');
    expect(fetchMock.mock.calls.some(([input]) => input.toString() === 'https://api.exa.ai/search')).toBe(false);
  });

  it('keeps stable prompt content before volatile context for provider cache hits', () => {
    const bot = new TelegramBot(createEnv());
    const buildChatMessages = (bot as unknown as {
      buildChatMessages(inputs: {
        promptState: {
          botSettings: { ambientMemory: boolean; replyStyle: 'short' | 'normal' | 'long' };
          groupProfile: string | null;
          personCards: Array<{ name: string; notes: string[]; lastUpdatedAt: string }>;
          activeTopics: Array<{ topic: string; status?: string; lastUpdatedAt: string }>;
          conversationSummary: string | null;
          recentTurns: Message[];
          ambientMessages: string[];
          seenMembers: Array<{
            userId: string;
            displayName: string;
            firstSeenAt: string;
            lastSeenAt: string;
          }>;
          currentModel: string;
        };
        promptText: string;
        replyContext: string | null;
        includeCurrentDateTime: boolean;
      }): Message[];
    }).buildChatMessages.bind(bot);

    const messages = buildChatMessages({
      promptState: {
        botSettings: { ambientMemory: true, replyStyle: 'short' },
        groupProfile: 'Durable group profile',
        personCards: [{ name: 'Alice', notes: ['likes concise answers'], lastUpdatedAt: '2026-04-29T00:00:00.000Z' }],
        seenMembers: [{
          userId: '42',
          displayName: 'Alice',
          firstSeenAt: '2026-04-29T00:00:00.000Z',
          lastSeenAt: '2026-04-29T00:00:00.000Z',
        }],
        conversationSummary: 'Rolling summary',
        activeTopics: [{ topic: 'Volatile active topic', status: 'open', lastUpdatedAt: '2026-04-29T00:00:00.000Z' }],
        ambientMessages: ['Recent ambient message'],
        recentTurns: [{ role: 'assistant', content: 'Recent assistant turn' }],
        currentModel: 'gemini-test',
      },
      promptText: 'Current user message',
      replyContext: 'Volatile reply context',
      includeCurrentDateTime: true,
    });

    const contents = messages.map(message => typeof message.content === 'string' ? message.content : '');
    const stableMemoryIndex = contents.findIndex(content => content.includes('Durable memory for this chat'));
    const volatileContextIndex = contents.findIndex(content => content.includes('Current context for this request'));
    const dateIndex = contents.findIndex(content => content.includes('Current local date is'));
    const recentTurnIndex = contents.findIndex(content => content.includes('Recent assistant turn'));
    const userIndex = contents.findIndex(content => content.includes('Current user message'));

    expect(stableMemoryIndex).toBeGreaterThan(1);
    expect(recentTurnIndex).toBeGreaterThan(stableMemoryIndex);
    expect(volatileContextIndex).toBeGreaterThan(recentTurnIndex);
    expect(dateIndex).toBeGreaterThan(volatileContextIndex);
    expect(userIndex).toBe(messages.length - 1);

    const stableMemory = contents[stableMemoryIndex];
    const volatileContext = contents[volatileContextIndex];
    expect(stableMemory.indexOf('## Group profile')).toBeLessThan(stableMemory.indexOf('## People'));
    expect(stableMemory.indexOf('## People')).toBeLessThan(stableMemory.indexOf('## Summary'));
    expect(volatileContext.indexOf('## Relevant people')).toBeLessThan(volatileContext.indexOf('## Relevant topics'));
    expect(volatileContext.indexOf('## Relevant topics')).toBeLessThan(volatileContext.indexOf('## Reply context'));
    expect(volatileContext.indexOf('## Reply context')).toBeLessThan(volatileContext.indexOf('## Relevant ambient'));
    expect(volatileContext).not.toMatch(/\[(?:just seen|seen \d+[hd] ago|seen today|stale)\]/);
  });

  it('adds a current-subject priority hint for ambiguous follow-ups', () => {
    const bot = new TelegramBot(createEnv());
    const buildChatMessages = (bot as unknown as {
      buildChatMessages(inputs: {
        promptState: {
          botSettings: { ambientMemory: boolean; replyStyle: 'short' | 'normal' | 'long' };
          groupProfile: string | null;
          personCards: Array<{ name: string; notes: string[]; lastUpdatedAt: string }>;
          activeTopics: Array<{ topic: string; status?: string; lastUpdatedAt: string }>;
          conversationSummary: string | null;
          recentTurns: Message[];
          ambientMessages: string[];
          seenMembers: Array<{
            userId: string;
            displayName: string;
            firstSeenAt: string;
            lastSeenAt: string;
          }>;
          currentModel: string;
        };
        promptText: string;
        replyContext: string | null;
        includeCurrentDateTime: boolean;
      }): Message[];
    }).buildChatMessages.bind(bot);

    const messages = buildChatMessages({
      promptState: {
        botSettings: { ambientMemory: false, replyStyle: 'short' },
        groupProfile: 'Older group memory mentions SGX.',
        personCards: [],
        seenMembers: [],
        conversationSummary: 'The group discussed SGX last week.',
        activeTopics: [{ topic: 'SGX rally', status: 'open', lastUpdatedAt: '2026-04-29T00:00:00.000Z' }],
        ambientMessages: [],
        recentTurns: [{ role: 'assistant', content: 'Sivers Semiconductors is a Swedish fabless chip company.' }],
        currentModel: 'gemini-test',
      },
      promptText: 'why have they pumped so much recently',
      replyContext: null,
      includeCurrentDateTime: false,
    });

    const currentContext = messages
      .map(message => typeof message.content === 'string' ? message.content : '')
      .find(content => content.includes('Current context for this request'));

    expect(currentContext).toContain('## Current subject');
    expect(currentContext).toContain('Sivers Semiconductors');
    expect(messages.findIndex(message => message.content === 'Sivers Semiconductors is a Swedish fabless chip company.'))
      .toBeLessThan(messages.findIndex(message => message.content === currentContext));
  });

  it('keeps the durable prefix identical when only volatile request context changes', () => {
    const bot = new TelegramBot(createEnv());
    const buildChatMessages = (bot as unknown as { buildChatMessages(inputs: any): Message[] }).buildChatMessages.bind(bot);
    const basePromptState = {
      botSettings: { ambientMemory: true, replyStyle: 'short' as const },
      groupProfile: 'Stable profile',
      personCards: [{ name: 'Alice', notes: ['likes concise answers'], lastUpdatedAt: '2026-08-01T00:00:00.000Z' }],
      seenMembers: [{ userId: '42', displayName: 'Alice', firstSeenAt: '2026-08-01T00:00:00.000Z', lastSeenAt: '2026-08-01T00:00:00.000Z' }],
      conversationSummary: 'Stable summary',
      activeTopics: [{ topic: 'Release plan', status: 'open', lastUpdatedAt: '2026-08-01T00:00:00.000Z' }],
      recentTurns: [
        { role: 'user' as const, content: 'Earlier question' },
        { role: 'assistant' as const, content: 'Earlier answer' },
      ],
      currentModel: 'gemini-test',
    };

    const first = buildChatMessages({
      promptState: { ...basePromptState, ambientMessages: ['First ambient detail'] },
      promptText: 'What about the release plan?',
      replyContext: 'First reply target',
      includeCurrentDateTime: false,
    });
    const second = buildChatMessages({
      promptState: { ...basePromptState, ambientMessages: ['Different ambient detail'] },
      promptText: 'What about the release plan now?',
      replyContext: 'Different reply target',
      includeCurrentDateTime: true,
    });

    const lastStableIndex = first.findIndex(message => message.content === 'Earlier answer');
    expect(lastStableIndex).toBeGreaterThan(2);
    expect(JSON.stringify(first.slice(0, lastStableIndex + 1)))
      .toBe(JSON.stringify(second.slice(0, lastStableIndex + 1)));
  });

  it('falls back to a configured text model only for retryable provider failures', async () => {
    const bot = new TelegramBot(createEnv({
      GOOGLE_MODELS: 'gemini-primary,gemini-fallback',
      DEFAULT_MODEL: 'gemini-primary',
      MODEL_FALLBACKS: 'gemini-fallback',
    }));
    const primary = {
      generateResponse: vi.fn().mockRejectedValue(new Error('429 quota exceeded')),
      isValidModel: () => true,
      getDefaultModel: () => 'gemini-primary',
      getAvailableModels: () => ['gemini-primary'],
    };
    const fallback = {
      generateResponse: vi.fn().mockResolvedValue('fallback answer'),
      isValidModel: () => true,
      getDefaultModel: () => 'gemini-fallback',
      getAvailableModels: () => ['gemini-fallback'],
    };
    const internals = bot as unknown as {
      getModelAPIForModel(model: string): Promise<typeof fallback>;
      generateTrackedResponse(api: typeof primary, messages: Message[], model: string, mode: 'chat'): Promise<string>;
    };
    vi.spyOn(internals, 'getModelAPIForModel').mockResolvedValue(fallback);

    await expect(internals.generateTrackedResponse(primary, [{ role: 'user', content: 'hello' }], 'gemini-primary', 'chat'))
      .resolves.toBe('fallback answer');
    expect(fallback.generateResponse).toHaveBeenCalledOnce();
  });

  it('does not hide malformed requests behind a model fallback', async () => {
    const bot = new TelegramBot(createEnv({
      GOOGLE_MODELS: 'gemini-primary,gemini-fallback',
      DEFAULT_MODEL: 'gemini-primary',
      MODEL_FALLBACKS: 'gemini-fallback',
    }));
    const primary = {
      generateResponse: vi.fn().mockRejectedValue(new Error('400 invalid request')),
      isValidModel: () => true,
      getDefaultModel: () => 'gemini-primary',
      getAvailableModels: () => ['gemini-primary'],
    };
    const internals = bot as unknown as {
      getModelAPIForModel(model: string): Promise<never>;
      generateTrackedResponse(api: typeof primary, messages: Message[], model: string, mode: 'chat'): Promise<string>;
    };
    const lookup = vi.spyOn(internals, 'getModelAPIForModel');

    await expect(internals.generateTrackedResponse(primary, [{ role: 'user', content: 'hello' }], 'gemini-primary', 'chat'))
      .rejects.toThrow('400 invalid request');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('preserves webhook update deduplication across Telegram retries', async () => {
    const bot = new TelegramBot(createEnv());
    const internals = bot as unknown as {
      markUpdateAsProcessed(updateId: number): Promise<boolean>;
      handleUpdate(update: TelegramTypes.Update): Promise<void>;
    };
    vi.spyOn(internals, 'markUpdateAsProcessed').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const handle = vi.spyOn(internals, 'handleUpdate').mockResolvedValue(undefined);
    const update = createPrivateMessageUpdate(77, 'hello');

    await bot.handleWebhook(webhookRequest(update));
    await bot.handleWebhook(webhookRequest(update));
    expect(handle).toHaveBeenCalledOnce();
  });

  it('rejects a webhook carrying no secret token', async () => {
    const bot = new TelegramBot(createEnv());
    const update = createPrivateMessageUpdate(78, 'hello');

    const response = await bot.handleWebhook(
      new Request('https://worker.test', { method: 'POST', body: JSON.stringify(update) }),
    );

    expect(response.status).toBe(403);
  });

  it('rejects a webhook carrying the wrong secret token', async () => {
    const bot = new TelegramBot(createEnv());

    const response = await bot.handleWebhook(
      webhookRequest(createPrivateMessageUpdate(79, 'hello'), 'not-the-secret'),
    );

    expect(response.status).toBe(403);
  });

  it('refuses all webhook traffic when no secret is configured', async () => {
    const bot = new TelegramBot(createEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }));
    const update = createPrivateMessageUpdate(80, 'hello');

    // Previously an unset secret disabled the check entirely, so a forged
    // update from anyone who knew the URL was accepted.
    expect((await bot.handleWebhook(webhookRequest(update))).status).toBe(403);
    expect((await bot.handleWebhook(
      new Request('https://worker.test', { method: 'POST', body: JSON.stringify(update) }),
    )).status).toBe(403);
  });

  it('still rejects non-POST methods', async () => {
    const bot = new TelegramBot(createEnv());

    expect((await bot.handleWebhook(new Request('https://worker.test', { method: 'GET' }))).status).toBe(405);
  });
  it('continues ordinary chat without stored memory when Redis is unavailable', async () => {
    const degradedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.startsWith('https://redis.example')) throw new TypeError('network unavailable');
      if (url.startsWith('https://api.telegram.org/')) {
        return Response.json({ ok: true, result: { message_id: 1, chat: { id: 42, type: 'private' }, date: 1 } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', degradedFetch);
    const bot = new TelegramBot(createEnv());
    const api = {
      generateResponse: vi.fn().mockResolvedValue('degraded but working'),
      isValidModel: () => true,
      getDefaultModel: () => 'gemini-test',
      getAvailableModels: () => ['gemini-test'],
    };
    vi.spyOn(bot as any, 'getModelAPIForModel').mockResolvedValue(api);

    await expect(bot.handleUpdate(createPrivateMessageUpdate(88, 'hello'))).resolves.toBeUndefined();
    const sent = degradedFetch.mock.calls.find(([input]) => input.toString().endsWith('/sendMessage'));
    expect(sent).toBeDefined();
    expect(degradedFetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/sendMessage$/),
      expect.objectContaining({ body: expect.stringContaining('degraded but working') }),
    );
  });

  it('bounds research searches, page reads, sources, and synthesis calls', async () => {
    const bot = new TelegramBot(createEnv());
    const sources = Array.from({ length: 12 }, (_, index) => ({ title: `S${index}`, url: `https://example.com/${index}` }));
    const search = vi.fn().mockResolvedValue({ provider: 'mock', query: 'q', searchedAt: new Date().toISOString(), sources });
    const internals = bot as any;
    vi.spyOn(internals, 'createSearchBroker').mockReturnValue({ isConfigured: () => true, search });
    const read = vi.spyOn(internals, 'readPageWithTimeout').mockResolvedValue({
      url: 'https://example.com', title: 'Page', contentType: 'text/plain', text: 'evidence',
    });
    vi.spyOn(internals, 'saveLastSources').mockResolvedValue(undefined);
    vi.spyOn(internals, 'getCurrentModel').mockResolvedValue('gemini-test');
    vi.spyOn(internals, 'getModelAPIForModel').mockResolvedValue({});
    const synthesis = vi.spyOn(internals, 'generateTrackedResponse').mockResolvedValue('answer');

    await bot.research('42', 'Explain a bounded topic');
    expect(search.mock.calls.length).toBeLessThanOrEqual(3);
    expect(read.mock.calls.length).toBeLessThanOrEqual(2);
    expect(synthesis).toHaveBeenCalledOnce();
  });

  it('shares cancellation state through Redis and reports stale command menus', async () => {
    const bot = new TelegramBot(createEnv());
    const values = new Map<string, string>();
    const redis = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      del: vi.fn(async (key: string) => { values.delete(key); }),
      withLock: vi.fn(async (_key: string, callback: () => Promise<unknown>) => await callback()),
    };
    (bot as any).redis = redis;

    const id = await bot.beginCancellableTask('42', 'research');
    await expect(bot.cancelActiveTask('42')).resolves.toBe('research');
    await expect(bot.assertTaskActive('42', id)).rejects.toThrow('cancelled');
    await bot.finishCancellableTask('42', id);
    await expect((bot as any).getCommandMenuStatus()).resolves.toBe('stale');
  });
});

describe('TelegramBot authorization defaults', () => {
  it('denies every user when the whitelist is unset', () => {
    const bot = new TelegramBot(createEnv({ WHITELISTED_USERS: '' }));

    expect(bot.isUserWhitelisted('42')).toBe(false);
    expect(bot.isUserWhitelisted('anyone')).toBe(false);
  });

  it('admits only listed users', () => {
    const bot = new TelegramBot(createEnv({ WHITELISTED_USERS: '42, 77' }));

    expect(bot.isUserWhitelisted('42')).toBe(true);
    expect(bot.isUserWhitelisted('77')).toBe(true);
    expect(bot.isUserWhitelisted('99')).toBe(false);
  });

  it('requires an explicit OWNER_USER_ID rather than inferring one', () => {
    // A single-entry whitelist used to be treated as the owner, so adding a
    // second user silently revoked ownership from the first.
    const inferred = new TelegramBot(createEnv({ WHITELISTED_USERS: '42' }));

    expect(inferred.isOwner('42')).toBe(false);
  });

  it('recognises the configured owner', () => {
    const bot = new TelegramBot(createEnv({ WHITELISTED_USERS: '42,77', OWNER_USER_ID: '42' }));

    expect(bot.isOwner('42')).toBe(true);
    expect(bot.isOwner('77')).toBe(false);
  });

  it('ignores empty entries left by trailing commas', () => {
    const bot = new TelegramBot(createEnv({ WHITELISTED_USERS: '42,,' }));

    expect(bot.isUserWhitelisted('42')).toBe(true);
    expect(bot.isUserWhitelisted('')).toBe(false);
  });
});

describe('TelegramBot group whitelisting', () => {
  const GROUP = -1001234567890;
  const OTHER_GROUP = -1009999999999;

  function groupBot(overrides: Partial<Env> = {}) {
    return new TelegramBot(createEnv({
      WHITELISTED_USERS: '',
      WHITELISTED_GROUPS: String(GROUP),
      ...overrides,
    }));
  }

  it('authorizes an unlisted user speaking in a whitelisted group', () => {
    expect(groupBot().isAuthorized({ userId: 'stranger', chatId: GROUP, chatType: 'supergroup' })).toBe(true);
  });

  it('rejects the same user in a group that is not whitelisted', () => {
    expect(groupBot().isAuthorized({ userId: 'stranger', chatId: OTHER_GROUP, chatType: 'supergroup' })).toBe(false);
  });

  it('does not let a group grant leak into private chats', () => {
    // The grant is scoped to the group; a DM carries no group to check against.
    expect(groupBot().isAuthorized({ userId: 'stranger', chatId: 555, chatType: 'private' })).toBe(false);
  });

  it('still authorizes an individually whitelisted user anywhere', () => {
    const bot = groupBot({ WHITELISTED_USERS: '42' });

    expect(bot.isAuthorized({ userId: '42', chatId: 555, chatType: 'private' })).toBe(true);
    expect(bot.isAuthorized({ userId: '42', chatId: OTHER_GROUP, chatType: 'group' })).toBe(true);
  });

  it('accepts either grant independently', () => {
    const bot = groupBot({ WHITELISTED_USERS: '42' });

    // Listed user, unlisted group.
    expect(bot.isAuthorized({ userId: '42', chatId: OTHER_GROUP, chatType: 'group' })).toBe(true);
    // Unlisted user, listed group.
    expect(bot.isAuthorized({ userId: 'stranger', chatId: GROUP, chatType: 'group' })).toBe(true);
    // Neither.
    expect(bot.isAuthorized({ userId: 'stranger', chatId: OTHER_GROUP, chatType: 'group' })).toBe(false);
  });

  it('treats plain groups and supergroups alike', () => {
    const bot = groupBot();

    expect(bot.isAuthorized({ userId: 'stranger', chatId: GROUP, chatType: 'group' })).toBe(true);
    expect(bot.isAuthorized({ userId: 'stranger', chatId: GROUP, chatType: 'supergroup' })).toBe(true);
  });

  it('denies everything when neither list is configured', () => {
    const bot = new TelegramBot(createEnv({ WHITELISTED_USERS: '', WHITELISTED_GROUPS: '' }));

    expect(bot.isAuthorized({ userId: '42', chatId: GROUP, chatType: 'supergroup' })).toBe(false);
    expect(bot.isAuthorized({ userId: '42', chatId: 555, chatType: 'private' })).toBe(false);
  });

  it('matches group IDs exactly, including the leading minus', () => {
    const bot = groupBot();

    expect(bot.isGroupWhitelisted(GROUP)).toBe(true);
    // A positive ID with the same digits is a different chat entirely.
    expect(bot.isGroupWhitelisted(Math.abs(GROUP))).toBe(false);
  });

  it('supports multiple whitelisted groups', () => {
    const bot = groupBot({ WHITELISTED_GROUPS: `${GROUP}, ${OTHER_GROUP}` });

    expect(bot.isGroupWhitelisted(GROUP)).toBe(true);
    expect(bot.isGroupWhitelisted(OTHER_GROUP)).toBe(true);
    expect(bot.isGroupWhitelisted(-100)).toBe(false);
  });
});

describe('TelegramBot supergroup migration', () => {
  const OLD_GROUP = -652447362;
  const NEW_SUPERGROUP = -1001234567890;

  function migrationUpdate(chatId: number, fields: Record<string, number>): TelegramTypes.Update {
    return {
      update_id: 900,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: chatId, type: 'group', title: 'Test Group' },
        from: { id: 42, is_bot: false, first_name: 'Test' },
        ...fields,
      },
    };
  }

  it('names the new chat id when a group migrates away', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(message => { errors.push(String(message)); });
    const bot = new TelegramBot(createEnv({ WHITELISTED_GROUPS: String(OLD_GROUP) }));

    await bot.handleUpdate(migrationUpdate(OLD_GROUP, { migrate_to_chat_id: NEW_SUPERGROUP }));

    expect(errors.some(line => line.includes(String(NEW_SUPERGROUP)) && line.includes('WHITELISTED_GROUPS'))).toBe(true);
    spy.mockRestore();
  });

  it('flags traffic from a migrated supergroup that is not whitelisted', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(message => { errors.push(String(message)); });
    const bot = new TelegramBot(createEnv({ WHITELISTED_GROUPS: String(OLD_GROUP) }));

    await bot.handleUpdate(migrationUpdate(NEW_SUPERGROUP, { migrate_from_chat_id: OLD_GROUP }));

    expect(errors.some(line => line.includes('not in WHITELISTED_GROUPS'))).toBe(true);
    spy.mockRestore();
  });

  it('stays quiet once the new supergroup is whitelisted', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(message => { errors.push(String(message)); });
    const bot = new TelegramBot(createEnv({ WHITELISTED_GROUPS: String(NEW_SUPERGROUP) }));

    await bot.handleUpdate(migrationUpdate(NEW_SUPERGROUP, { migrate_from_chat_id: OLD_GROUP }));

    expect(errors.some(line => line.includes('WHITELISTED_GROUPS'))).toBe(false);
    spy.mockRestore();
  });
});
