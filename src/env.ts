export interface Env {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string;
  OPENAI_MODELS: string;
  EXA_API_KEY?: string;
  SEARCH_PROVIDERS?: string;
  EXA_MONTHLY_SEARCH_CAP?: string;
  OPENAI_SEARCH_API_KEY?: string;
  OPENAI_SEARCH_MODEL?: string;
  OPENAI_SEARCH_MONTHLY_CAP?: string;
  GEMINI_SEARCH_MODEL?: string;
  GEMINI_SEARCH_MONTHLY_CAP?: string;
  EODHD_API_KEY?: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  WHITELISTED_USERS: string;
  WHITELISTED_GROUPS?: string;
  OWNER_USER_ID?: string;
  AMBIENT_MEMORY_DEFAULT?: string;
  DEFAULT_TIMEZONE?: string;
  SYSTEM_INIT_MESSAGE: string;
  SYSTEM_INIT_MESSAGE_ROLE: string;
  DEFAULT_MODEL?: string;
  SUMMARY_MODEL?: string;
  UTILITY_MODEL?: string;
  RESEARCH_MODEL?: string;
  VISION_MODEL?: string;
  VISION_MODELS?: string;
  DASHBOARD_BASE_URL?: string;
  MINIAPP_BASE_URL?: string;
  MODEL_FALLBACKS?: string;
  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
  DALL_E_MODEL?: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  FLUX_STEPS: string;
  PROMPT_OPTIMIZATION?: string;
  EXTERNAL_API_BASE?: string;
  EXTERNAL_MODEL?: string;
  EXTERNAL_API_KEY?: string;
  GOOGLE_MODEL_KEY: string;
  GOOGLE_MODEL_BASEURL?: string;
  EODHD_API_BASEURL?: string;
  GOOGLE_MODELS: string;
  GROQ_API_KEY: string;
  GROQ_MODELS: string;
  CLAUDE_API_KEY: string;
  CLAUDE_MODELS: string;
  CLAUDE_ENDPOINT?: string;
  AZURE_API_KEY: string;
  AZURE_MODELS: string;
  AZURE_ENDPOINT: string;
  OPENAI_COMPATIBLE_KEY?: string;
  OPENAI_COMPATIBLE_URL?: string;
  OPENAI_COMPATIBLE_MODELS?: string;
  GITHUB_TOKEN?: string;
  AUDIO_API_KEY?: string;
  AUDIO_API_BASE_URL?: string;
  TRANSCRIPTION_MODEL?: string;
  TTS_MODEL?: string;
  TTS_VOICE?: string;
  MAX_VOICE_FILE_BYTES?: string;
  BOX_AGENT_ENABLED?: string;
  BOX_ALLOW_GROUP_MEMBERS?: string;
  ACTION_BROKER_ENABLED?: string;
  ACTION_BROKER_GITHUB_REPOS?: string;
  UPSTASH_BOX_API_KEY?: string;
  UPSTASH_BOX_BASE_URL?: string;
  BOX_SNAPSHOT_ID?: string;
  BOX_CALLBACK_URL?: string;
  BOX_CALLBACK_SECRET?: string;
  DEEPSEEK_API_KEY?: string;
  ZAI_CODING_PLAN_API_KEY?: string;
  QSTASH_CURRENT_SIGNING_KEY?: string;
  QSTASH_NEXT_SIGNING_KEY?: string;
  BOX_DEEPSEEK_INPUT_USD_PER_MTOKENS?: string;
  BOX_DEEPSEEK_CACHED_INPUT_USD_PER_MTOKENS?: string;
  BOX_DEEPSEEK_OUTPUT_USD_PER_MTOKENS?: string;
  ARTIFACT_BUCKET?: R2Bucket;
}

interface AppConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  openaiModels: string[];
  exaApiKey?: string;
  searchProviders: string[];
  exaMonthlySearchCap: number;
  openaiSearchApiKey?: string;
  openaiSearchModel: string;
  openaiSearchMonthlyCap: number;
  geminiSearchModel: string;
  geminiSearchMonthlyCap: number;
  eodhdApiKey?: string;
  telegramBotToken: string;
  whitelistedUsers: string[];
  whitelistedGroups: string[];
  ownerUserId?: string;
  ambientMemoryDefault: boolean;
  defaultTimezone: string;
  systemInitMessage: string;
  systemInitMessageRole: string;
  defaultModel?: string;
  summaryModel?: string;
  utilityModel?: string;
  researchModel?: string;
  visionModel?: string;
  visionModels: string[];
  dashboardBaseUrl?: string;
  miniAppBaseUrl?: string;
  modelFallbacks: string[];
  upstashRedisRestUrl: string;
  upstashRedisRestToken: string;
  dallEModel: string;
  languageTTL: number;
  contextTTL: number;
  cloudflareApiToken: string;
  cloudflareAccountId: string;
  fluxSteps: number;
  promptOptimization: boolean;
  externalApiBase?: string;
  externalModel?: string;
  externalApiKey?: string;
  googleModelKey: string;
  googleModelBaseUrl: string;
  eodhdApiBaseUrl: string;
  googleModels: string[];
  groqApiKey: string;
  groqModels: string[];
  claudeApiKey: string;
  claudeModels: string[];
  claudeEndpoint: string;
  azureApiKey: string;
  azureModels: string[];
  azureEndpoint: string;
  openaiCompatibleKey?: string;
  openaiCompatibleUrl?: string;
  openaiCompatibleModels: string[];
  githubToken?: string;
  audioApiKey?: string;
  audioApiBaseUrl: string;
  transcriptionModel: string;
  ttsModel: string;
  ttsVoice: string;
  maxVoiceFileBytes: number;
  boxAgentEnabled: boolean;
  boxAllowGroupMembers: boolean;
  actionBrokerEnabled: boolean;
  actionBrokerGithubRepos: string[];
  upstashBoxApiKey?: string;
  upstashBoxBaseUrl?: string;
  boxSnapshotId?: string;
  boxCallbackUrl?: string;
  boxCallbackSecret?: string;
  deepseekApiKey?: string;
  zaiCodingPlanApiKey?: string;
  qstashCurrentSigningKey?: string;
  qstashNextSigningKey?: string;
  boxDeepseekInputUsdPerMTokens: number;
  boxDeepseekCachedInputUsdPerMTokens: number;
  boxDeepseekOutputUsdPerMTokens: number;
}

const getEnvOrDefault = (env: Env, key: keyof Env, defaultValue: string): string => {
  return (env[key] as string) || defaultValue;
};

export const getConfig = (env: Env): AppConfig => {
  const hasOpenAI = !!env.OPENAI_API_KEY;
  const hasGoogle = !!env.GOOGLE_MODEL_KEY;
  const hasGroq = !!env.GROQ_API_KEY;
  const hasClaude = !!env.CLAUDE_API_KEY;
  const hasAzure = !!env.AZURE_API_KEY;
  const hasOpenAICompatible = !!env.OPENAI_COMPATIBLE_KEY && !!env.OPENAI_COMPATIBLE_URL;

  if (!hasOpenAI && !hasGoogle && !hasGroq && !hasClaude && !hasAzure && !hasOpenAICompatible) {
    throw new Error('At least one model API key must be set (OpenAI, Google, Groq, Claude, Azure, or OpenAI Compatible)');
  }

  const boxAgentEnabled = getEnvOrDefault(env, 'BOX_AGENT_ENABLED', 'false') === 'true';
  const ownerUserId = env.OWNER_USER_ID?.trim() || undefined;

  // Box execution, approvals, and schedules are all owner-gated. Starting the
  // execution plane without a stated owner would leave those gates undecidable.
  if (boxAgentEnabled && !ownerUserId) {
    throw new Error('OWNER_USER_ID must be set when BOX_AGENT_ENABLED=true. Box execution, approvals, and schedules are owner-gated.');
  }

  return {
    openaiApiKey: env.OPENAI_API_KEY,
    openaiBaseUrl: getEnvOrDefault(env, 'OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModels: env.OPENAI_MODELS ? env.OPENAI_MODELS.split(',').map(model => model.trim()) : [],
    exaApiKey: env.EXA_API_KEY,
    searchProviders: getEnvOrDefault(env, 'SEARCH_PROVIDERS', 'exa')
      .split(',')
      .map(provider => provider.trim().toLowerCase())
      .filter(Boolean),
    exaMonthlySearchCap: parsePositiveInt(env.EXA_MONTHLY_SEARCH_CAP, 900),
    openaiSearchApiKey: env.OPENAI_SEARCH_API_KEY,
    openaiSearchModel: getEnvOrDefault(env, 'OPENAI_SEARCH_MODEL', 'gpt-5-mini'),
    openaiSearchMonthlyCap: parsePositiveInt(env.OPENAI_SEARCH_MONTHLY_CAP, 100),
    geminiSearchModel: getEnvOrDefault(env, 'GEMINI_SEARCH_MODEL', 'gemini-2.5-flash-lite'),
    geminiSearchMonthlyCap: parsePositiveInt(env.GEMINI_SEARCH_MONTHLY_CAP, 0),
    eodhdApiKey: env.EODHD_API_KEY,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    whitelistedUsers: env.WHITELISTED_USERS
      ? env.WHITELISTED_USERS.split(',').map(id => id.trim()).filter(Boolean)
      : [],
    whitelistedGroups: env.WHITELISTED_GROUPS
      ? env.WHITELISTED_GROUPS.split(',').map(id => id.trim()).filter(Boolean)
      : [],
    ownerUserId,
    ambientMemoryDefault: getEnvOrDefault(env, 'AMBIENT_MEMORY_DEFAULT', 'false') === 'true',
    defaultTimezone: resolveTimezone(env.DEFAULT_TIMEZONE),
    systemInitMessage: getEnvOrDefault(env, 'SYSTEM_INIT_MESSAGE', 'You are a helpful assistant.'),
    systemInitMessageRole: getEnvOrDefault(env, 'SYSTEM_INIT_MESSAGE_ROLE', 'system'),
    defaultModel: env.DEFAULT_MODEL,
    summaryModel: env.SUMMARY_MODEL,
    utilityModel: env.UTILITY_MODEL,
    researchModel: env.RESEARCH_MODEL,
    visionModel: env.VISION_MODEL,
    visionModels: env.VISION_MODELS
      ? env.VISION_MODELS.split(',').map(model => model.trim()).filter(Boolean)
      : [],
    dashboardBaseUrl: env.DASHBOARD_BASE_URL?.trim().replace(/\/+$/, '') || undefined,
    // Falls back to the dashboard origin: both are served by this Worker, so a
    // deployment that set one almost never means a different host for the other.
    miniAppBaseUrl:
      (env.MINIAPP_BASE_URL ?? env.DASHBOARD_BASE_URL)?.trim().replace(/\/+$/, '') || undefined,
    modelFallbacks: env.MODEL_FALLBACKS
      ? env.MODEL_FALLBACKS.split(',').map(model => model.trim()).filter(Boolean)
      : [],
    upstashRedisRestUrl: env.UPSTASH_REDIS_REST_URL,
    upstashRedisRestToken: env.UPSTASH_REDIS_REST_TOKEN,
    dallEModel: getEnvOrDefault(env, 'DALL_E_MODEL', 'dall-e-3'),
    languageTTL: 60 * 60 * 24 * 365,
    contextTTL: 60 * 60 * 24 * 30,
    cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
    fluxSteps: parseInt(getEnvOrDefault(env, 'FLUX_STEPS', '4')),
    promptOptimization: getEnvOrDefault(env, 'PROMPT_OPTIMIZATION', 'false') === 'true',
    externalApiBase: env.EXTERNAL_API_BASE,
    externalModel: env.EXTERNAL_MODEL,
    externalApiKey: env.EXTERNAL_API_KEY,
    googleModelKey: env.GOOGLE_MODEL_KEY,
    googleModelBaseUrl: getEnvOrDefault(env, 'GOOGLE_MODEL_BASEURL', 'https://generativelanguage.googleapis.com/v1beta'),
    eodhdApiBaseUrl: getEnvOrDefault(env, 'EODHD_API_BASEURL', 'https://eodhd.com/api'),
    googleModels: env.GOOGLE_MODELS ? env.GOOGLE_MODELS.split(',').map(model => model.trim()) : [],
    groqApiKey: env.GROQ_API_KEY,
    groqModels: env.GROQ_MODELS ? env.GROQ_MODELS.split(',').map(model => model.trim()) : [],
    claudeApiKey: env.CLAUDE_API_KEY,
    claudeModels: env.CLAUDE_MODELS ? env.CLAUDE_MODELS.split(',').map(model => model.trim()) : [],
    claudeEndpoint: getEnvOrDefault(env, 'CLAUDE_ENDPOINT', 'https://api.anthropic.com/v1'),
    azureApiKey: env.AZURE_API_KEY,
    azureModels: env.AZURE_MODELS ? env.AZURE_MODELS.split(',').map(model => model.trim()) : [],
    azureEndpoint: env.AZURE_ENDPOINT,
    openaiCompatibleKey: env.OPENAI_COMPATIBLE_KEY,
    openaiCompatibleUrl: env.OPENAI_COMPATIBLE_URL,
    openaiCompatibleModels: env.OPENAI_COMPATIBLE_MODELS ? env.OPENAI_COMPATIBLE_MODELS.split(',').map(model => model.trim()) : [],
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    audioApiKey: env.AUDIO_API_KEY?.trim() || undefined,
    audioApiBaseUrl: getEnvOrDefault(env, 'AUDIO_API_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
    transcriptionModel: getEnvOrDefault(env, 'TRANSCRIPTION_MODEL', 'gpt-4o-mini-transcribe'),
    ttsModel: getEnvOrDefault(env, 'TTS_MODEL', 'gpt-4o-mini-tts'),
    ttsVoice: getEnvOrDefault(env, 'TTS_VOICE', 'alloy'),
    maxVoiceFileBytes: parsePositiveInt(env.MAX_VOICE_FILE_BYTES, 10 * 1024 * 1024),
    boxAgentEnabled,
    boxAllowGroupMembers: getEnvOrDefault(env, 'BOX_ALLOW_GROUP_MEMBERS', 'false') === 'true',
    actionBrokerEnabled: getEnvOrDefault(env, 'ACTION_BROKER_ENABLED', 'false') === 'true',
    // An empty allowlist permits nothing. The broker is only a boundary if its
    // scope is stated, so scope is never inferred.
    actionBrokerGithubRepos: env.ACTION_BROKER_GITHUB_REPOS
      ? env.ACTION_BROKER_GITHUB_REPOS.split(',').map(repo => repo.trim()).filter(Boolean)
      : [],
    upstashBoxApiKey: env.UPSTASH_BOX_API_KEY?.trim() || undefined,
    upstashBoxBaseUrl: env.UPSTASH_BOX_BASE_URL?.trim().replace(/\/+$/, '') || undefined,
    boxSnapshotId: env.BOX_SNAPSHOT_ID?.trim() || undefined,
    boxCallbackUrl: env.BOX_CALLBACK_URL?.trim() || undefined,
    boxCallbackSecret: env.BOX_CALLBACK_SECRET?.trim() || undefined,
    deepseekApiKey: env.DEEPSEEK_API_KEY?.trim() || undefined,
    zaiCodingPlanApiKey: env.ZAI_CODING_PLAN_API_KEY?.trim() || undefined,
    qstashCurrentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY?.trim() || undefined,
    qstashNextSigningKey: env.QSTASH_NEXT_SIGNING_KEY?.trim() || undefined,
    boxDeepseekInputUsdPerMTokens: parsePositiveNumber(env.BOX_DEEPSEEK_INPUT_USD_PER_MTOKENS, 0.14),
    boxDeepseekCachedInputUsdPerMTokens: parsePositiveNumber(env.BOX_DEEPSEEK_CACHED_INPUT_USD_PER_MTOKENS, 0.0028),
    boxDeepseekOutputUsdPerMTokens: parsePositiveNumber(env.BOX_DEEPSEEK_OUTPUT_USD_PER_MTOKENS, 0.28),
  };
};

/**
 * Reminder times, digest schedules, and the Box daily-quota day boundary were
 * all hardcoded to Asia/Kuala_Lumpur, which silently reinterpreted every
 * self-hosted deployment's `09:00` as Malaysian time. An unusable zone falls
 * back to UTC rather than throwing, because a bad timezone should not take a
 * whole bot offline.
 */
function resolveTimezone(value: string | undefined): string {
  const timezone = value?.trim();
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    console.error(`DEFAULT_TIMEZONE "${timezone}" is not a recognised IANA zone; falling back to UTC.`);
    return 'UTC';
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseFloat(value) : fallback;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
