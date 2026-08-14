import { describe, expect, it } from 'vitest';
import { Env, getConfig } from './env';

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENAI_API_KEY: '',
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODELS: '',
    TELEGRAM_BOT_TOKEN: 'telegram-token',
    WHITELISTED_USERS: '',
    SYSTEM_INIT_MESSAGE: 'test',
    SYSTEM_INIT_MESSAGE_ROLE: 'system',
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

describe('getConfig', () => {
  it('reuses parsed configuration for the same Worker Env binding', () => {
    const env = createEnv({ WHITELISTED_USERS: '42, 77' });

    expect(getConfig(env)).toBe(getConfig(env));
  });

  it('defaults ambient memory off unless explicitly enabled', () => {
    expect(getConfig(createEnv()).ambientMemoryDefault).toBe(false);
    expect(getConfig(createEnv({ AMBIENT_MEMORY_DEFAULT: 'true' })).ambientMemoryDefault).toBe(true);
  });

  it('parses the explicit vision-capability list and dashboard origin', () => {
    const config = getConfig(createEnv({
      VISION_MODEL: 'auto',
      VISION_MODELS: 'gemini-test,gpt-5.6-luna',
      DASHBOARD_BASE_URL: 'https://worker.example/',
    }));
    expect(config.visionModel).toBe('auto');
    expect(config.visionModels).toEqual(['gemini-test', 'gpt-5.6-luna']);
    expect(config.dashboardBaseUrl).toBe('https://worker.example');
  });

  it('keeps the Box runtime disabled by default and parses its isolated credentials', () => {
    expect(getConfig(createEnv()).boxAgentEnabled).toBe(false);
    expect(getConfig(createEnv()).boxAllowGroupMembers).toBe(false);

    const config = getConfig(createEnv({
      BOX_AGENT_ENABLED: 'true',
      OWNER_USER_ID: '42',
      BOX_ALLOW_GROUP_MEMBERS: 'true',
      UPSTASH_BOX_API_KEY: 'box-key',
      UPSTASH_BOX_BASE_URL: 'https://box.example/',
      BOX_SNAPSHOT_ID: 'snapshot-1',
      BOX_CALLBACK_URL: 'https://worker.example/box/callback',
      BOX_CALLBACK_SECRET: 'callback-secret',
      DEEPSEEK_API_KEY: 'deepseek-key',
      ZAI_CODING_PLAN_API_KEY: 'zai-plan-key',
      BOX_DEEPSEEK_INPUT_USD_PER_MTOKENS: '0.14',
      BOX_DEEPSEEK_OUTPUT_USD_PER_MTOKENS: '0.28',
    }));

    expect(config).toMatchObject({
      boxAgentEnabled: true,
      boxAllowGroupMembers: true,
      upstashBoxApiKey: 'box-key',
      upstashBoxBaseUrl: 'https://box.example',
      boxSnapshotId: 'snapshot-1',
      boxCallbackUrl: 'https://worker.example/box/callback',
      boxCallbackSecret: 'callback-secret',
      deepseekApiKey: 'deepseek-key',
      zaiCodingPlanApiKey: 'zai-plan-key',
      boxDeepseekInputUsdPerMTokens: 0.14,
      boxDeepseekOutputUsdPerMTokens: 0.28,
    });
  });

  it('parses user and group whitelists independently', () => {
    const config = getConfig(createEnv({
      WHITELISTED_USERS: '42, 77',
      WHITELISTED_GROUPS: '-1001234567890 ,-1009999999999',
    }));

    expect(config.whitelistedUsers).toEqual(['42', '77']);
    expect(config.whitelistedGroups).toEqual(['-1001234567890', '-1009999999999']);
  });

  it('drops empty whitelist entries left by trailing commas', () => {
    const config = getConfig(createEnv({ WHITELISTED_USERS: '42,,', WHITELISTED_GROUPS: ',' }));

    expect(config.whitelistedUsers).toEqual(['42']);
    expect(config.whitelistedGroups).toEqual([]);
  });

  it('defaults both whitelists to empty', () => {
    const config = getConfig(createEnv());

    expect(config.whitelistedUsers).toEqual([]);
    expect(config.whitelistedGroups).toEqual([]);
  });

  it('refuses to enable the Box runtime without a stated owner', () => {
    expect(() => getConfig(createEnv({ BOX_AGENT_ENABLED: 'true' })))
      .toThrow('OWNER_USER_ID must be set when BOX_AGENT_ENABLED=true');
  });

  it('treats a whitespace-only owner as unset', () => {
    expect(() => getConfig(createEnv({ BOX_AGENT_ENABLED: 'true', OWNER_USER_ID: '   ' })))
      .toThrow('OWNER_USER_ID must be set');
  });

  it('allows the Box runtime to stay disabled without an owner', () => {
    expect(() => getConfig(createEnv({ BOX_AGENT_ENABLED: 'false' }))).not.toThrow();
    expect(getConfig(createEnv()).ownerUserId).toBeUndefined();
  });
});
