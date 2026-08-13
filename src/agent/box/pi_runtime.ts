export const UPSTASH_BOX_SDK_VERSION = '0.6.3';
export const PI_CODING_AGENT_VERSION = '0.84.1';
export const PI_AI_VERSION = '0.84.1';

export const PI_DEEPSEEK_MODEL = 'deepseek/deepseek-v4-flash';
export const PI_GLM_MODEL = 'zai/glm-5.2';

export const BOX_MAX_MODEL_RESPONSES = 12;
export const BOX_MAX_INPUT_CONTEXT_TOKENS = 256_000;
export const BOX_MAX_OUTPUT_TOKENS = 64_000;
export const BOX_MAX_DEEPSEEK_SPEND_USD = 1;

export type BoxModelRoute = 'deepseek' | 'glm';

export interface DeepSeekRateCard {
  inputUsdPerMTokens: number;
  cachedInputUsdPerMTokens?: number;
  outputUsdPerMTokens: number;
}

export interface DeepSeekSafetyLimits {
  maxInputTokensPerResponse: number;
  maxOutputTokensPerResponse: number;
  maxModelResponses: number;
  maxSpendUsd: number;
}

export const DEFAULT_DEEPSEEK_SAFETY_LIMITS: DeepSeekSafetyLimits = {
  maxInputTokensPerResponse: BOX_MAX_INPUT_CONTEXT_TOKENS,
  maxOutputTokensPerResponse: BOX_MAX_OUTPUT_TOKENS,
  maxModelResponses: BOX_MAX_MODEL_RESPONSES,
  maxSpendUsd: BOX_MAX_DEEPSEEK_SPEND_USD,
};

export interface ResolvedPiModelRoute {
  route: BoxModelRoute;
  provider: 'deepseek' | 'zai';
  model: typeof PI_DEEPSEEK_MODEL | typeof PI_GLM_MODEL;
  /** Non-secret placeholders required by Pi's provider discovery. */
  providerEnv: Record<string, string>;
  /** Write-only host-side headers; values never enter the Box container. */
  providerAttachHeaders: Record<string, Record<string, string>>;
  rateCard?: DeepSeekRateCard;
  worstCaseSpendUsd?: number;
}

export class BoxRuntimeConfigurationError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'BOX_MODEL_FORBIDDEN'
      | 'BOX_MODEL_KEY_MISSING'
      | 'BOX_MODEL_ROUTE_INVALID'
      | 'BOX_COST_BOUND_UNSAFE',
  ) {
    super(message);
    this.name = 'BoxRuntimeConfigurationError';
  }
}

export function calculateWorstCaseDeepSeekSpend(
  rateCard: DeepSeekRateCard,
  limits: DeepSeekSafetyLimits = DEFAULT_DEEPSEEK_SAFETY_LIMITS,
): number {
  const inputCost = (limits.maxInputTokensPerResponse / 1_000_000) * rateCard.inputUsdPerMTokens;
  const outputCost = (limits.maxOutputTokensPerResponse / 1_000_000) * rateCard.outputUsdPerMTokens;
  return (inputCost + outputCost) * limits.maxModelResponses;
}

export function validateDeepSeekCostBound(
  rateCard: DeepSeekRateCard,
  limits: DeepSeekSafetyLimits = DEFAULT_DEEPSEEK_SAFETY_LIMITS,
): number {
  const values = [
    rateCard.inputUsdPerMTokens,
    rateCard.cachedInputUsdPerMTokens ?? rateCard.inputUsdPerMTokens,
    rateCard.outputUsdPerMTokens,
    limits.maxInputTokensPerResponse,
    limits.maxOutputTokensPerResponse,
    limits.maxModelResponses,
    limits.maxSpendUsd,
  ];
  if (values.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new BoxRuntimeConfigurationError(
      'DeepSeek pricing and safety limits must all be finite positive numbers.',
      'BOX_COST_BOUND_UNSAFE',
    );
  }

  const worstCaseSpendUsd = calculateWorstCaseDeepSeekSpend(rateCard, limits);
  if (worstCaseSpendUsd > limits.maxSpendUsd) {
    throw new BoxRuntimeConfigurationError(
      `DeepSeek worst-case spend $${worstCaseSpendUsd.toFixed(6)} exceeds the $${limits.maxSpendUsd.toFixed(2)} job limit.`,
      'BOX_COST_BOUND_UNSAFE',
    );
  }
  return worstCaseSpendUsd;
}

export function resolvePiModelRoute(input: {
  requestedRoute?: string;
  actorUserId: string;
  ownerUserId?: string;
  deepseekApiKey?: string;
  zaiCodingPlanApiKey?: string;
  deepseekRateCard: DeepSeekRateCard;
}): ResolvedPiModelRoute {
  const route = (input.requestedRoute?.trim().toLowerCase() || 'deepseek') as BoxModelRoute;
  if (route !== 'deepseek' && route !== 'glm') {
    throw new BoxRuntimeConfigurationError(
      `Unsupported Box model route: ${input.requestedRoute}`,
      'BOX_MODEL_ROUTE_INVALID',
    );
  }

  if (route === 'glm') {
    if (!input.ownerUserId || input.actorUserId !== input.ownerUserId) {
      throw new BoxRuntimeConfigurationError(
        'The GLM Coding Plan route is restricted to the bot owner.',
        'BOX_MODEL_FORBIDDEN',
      );
    }
    if (!input.zaiCodingPlanApiKey?.trim()) {
      throw new BoxRuntimeConfigurationError(
        'ZAI_CODING_PLAN_API_KEY is required for the GLM Coding Plan route.',
        'BOX_MODEL_KEY_MISSING',
      );
    }
    return {
      route,
      provider: 'zai',
      model: PI_GLM_MODEL,
      // Pi needs a non-empty provider variable for discovery. The real key is
      // injected by the Box host only for HTTPS requests to Z.AI.
      providerEnv: { ZAI_API_KEY: 'host-injected' },
      providerAttachHeaders: {
        'api.z.ai': { Authorization: `Bearer ${input.zaiCodingPlanApiKey.trim()}` },
      },
    };
  }

  if (!input.deepseekApiKey?.trim()) {
    throw new BoxRuntimeConfigurationError(
      'DEEPSEEK_API_KEY is required for the DeepSeek Box route.',
      'BOX_MODEL_KEY_MISSING',
    );
  }
  const worstCaseSpendUsd = validateDeepSeekCostBound(input.deepseekRateCard);
  return {
    route,
    provider: 'deepseek',
    model: PI_DEEPSEEK_MODEL,
    providerEnv: { DEEPSEEK_API_KEY: 'host-injected' },
    providerAttachHeaders: {
      'api.deepseek.com': { Authorization: `Bearer ${input.deepseekApiKey.trim()}` },
    },
    rateCard: input.deepseekRateCard,
    worstCaseSpendUsd,
  };
}

export const PI_HARNESS_SOURCE = String.raw`
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const WORK_DIR = "/workspace/home";
const SESSIONS_DIR = "/workspace/home/.pi-sessions";
const args = process.argv.slice(2);

function readArg(name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

function positiveInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(name, fallback) {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);

function emit(event, data) {
  originalStdoutWrite("event: " + event + "\n");
  originalStdoutWrite("data: " + JSON.stringify(data) + "\n\n");
}

const prompt = readArg("-p");
const requestedModel = readArg("--model");
const allowedModel = process.env.PI_ALLOWED_MODEL ?? "";
const sessionId = readArg("--session") || randomUUID();
const sessionDir = SESSIONS_DIR + "/" + sessionId;
const maxModelResponses = positiveInt("PI_MAX_MODEL_RESPONSES", 12);
const maxContextTokens = positiveInt("PI_MAX_CONTEXT_TOKENS", 256000);
const maxOutputTokens = positiveInt("PI_MAX_OUTPUT_TOKENS", 64000);
const maxModelSpendUsd = positiveNumber("PI_MAX_MODEL_SPEND_USD", 1);
const inputUsdPerMTokens = positiveNumber("PI_INPUT_USD_PER_MTOKENS", 0.14);
const cachedInputUsdPerMTokens = positiveNumber("PI_CACHED_INPUT_USD_PER_MTOKENS", 0.0028);
const outputUsdPerMTokens = positiveNumber("PI_OUTPUT_USD_PER_MTOKENS", 0.28);
const executionPolicyPath = process.env.PI_EXECUTION_POLICY_PATH ?? "";

if (!prompt) {
  emit("error", { error: "no prompt provided", session_id: sessionId });
  process.exit(1);
}
if (!allowedModel || requestedModel !== allowedModel) {
  emit("error", { error: "model route does not match the Box allowlist", session_id: sessionId });
  process.exit(1);
}

function isTextMimeType(mime) {
  if (mime.startsWith("text/")) return true;
  return ["application/json", "application/javascript", "application/typescript",
    "application/xml", "application/yaml", "application/x-yaml", "application/toml",
    "application/sql", "application/graphql"].includes(mime.split(";")[0]);
}

function buildPrompt(base) {
  if (!process.env.PROMPT_FILES_PATH) return base;
  try {
    const raw = readFileSync(process.env.PROMPT_FILES_PATH, "utf-8");
    try { unlinkSync(process.env.PROMPT_FILES_PATH); } catch {}
    const files = JSON.parse(raw);
    const fence = String.fromCharCode(96, 96, 96);
    const parts = [base];
    for (const file of files) {
      const mediaType = file.media_type || file.mediaType || "application/octet-stream";
      const safeName = basename(file.filename || "attachment.bin").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
      if (!isTextMimeType(mediaType)) {
        const path = WORK_DIR + "/input-" + randomUUID().slice(0, 8) + "-" + safeName;
        writeFileSync(path, Buffer.from(file.data, "base64"), { mode: 0o600 });
        parts.push("\n\nAttached binary file staged at: " + path + " (" + mediaType + "). Inspect it with the available local tools.");
        continue;
      }
      const content = Buffer.from(file.data, "base64").toString("utf-8");
      parts.push("\n\nAttached file: " + safeName + "\n" + fence + "\n" + content + "\n" + fence);
    }
    return parts.join("");
  } catch (error) {
    console.error("[pi] Failed to load prompt attachments: " + String(error));
    return base;
  }
}

function resolveModel(value) {
  const separator = value.indexOf("/");
  if (separator < 1) return undefined;
  return getModel(value.slice(0, separator), value.slice(separator + 1));
}

function estimateInputTokens(value) {
  try {
    const serialized = JSON.stringify(value);
    // UTF-8 bytes are a conservative upper bound for text token count. This
    // may reject early, but it cannot silently permit a request over the cap.
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return maxContextTokens + 1;
  }
}

function projectedCost(inputTokens, outputTokens = maxOutputTokens) {
  return ((inputTokens / 1000000) * inputUsdPerMTokens) + ((outputTokens / 1000000) * outputUsdPerMTokens);
}

try {
  process.chdir(WORK_DIR);
  await mkdir(sessionDir, { recursive: true });

  const catalogModel = resolveModel(requestedModel);
  if (!catalogModel) throw new Error("Pi model not found: " + requestedModel);
  const model = {
    ...catalogModel,
    contextWindow: Math.min(catalogModel.contextWindow ?? maxContextTokens, maxContextTokens),
    maxTokens: Math.min(catalogModel.maxTokens ?? maxOutputTokens, maxOutputTokens),
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd: WORK_DIR,
    agentDir: sessionDir,
    additionalExtensionPaths: executionPolicyPath ? [executionPolicyPath] : [],
  });
  await resourceLoader.reload();

  let providerRequestCount = 0;
  let meteredCostUsd = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const isProviderRequest = requestedModel.startsWith("deepseek/")
      ? /^https:\/\/api\.deepseek\.com\//i.test(target)
      : /^https:\/\/api\.z\.ai\/api\/coding\/paas\/v4\//i.test(target);
    if (!isProviderRequest) return originalFetch(input, init);
    providerRequestCount += 1;
    if (providerRequestCount > maxModelResponses) throw new Error("Pi reached the maximum model-response count before a provider request.");
    let payload;
    try { payload = typeof init.body === "string" ? JSON.parse(init.body) : {}; } catch { payload = {}; }
    const estimatedInput = estimateInputTokens(payload);
    if (estimatedInput > maxContextTokens) throw new Error("Pi provider request exceeds the maximum input-context bound.");
    const requestedOutput = Number(payload.max_output_tokens ?? payload.max_tokens ?? maxOutputTokens);
    if (!Number.isFinite(requestedOutput) || requestedOutput <= 0 || requestedOutput > maxOutputTokens) {
      throw new Error("Pi provider request exceeds the maximum output-token bound.");
    }
    if (requestedModel.startsWith("deepseek/") && meteredCostUsd + projectedCost(estimatedInput, requestedOutput) > maxModelSpendUsd) {
      throw new Error("Pi refused a provider request because its worst-case cost could exceed the per-job spend limit.");
    }
    // Pi needs a non-empty discovery variable, but that placeholder must never
    // reach the provider. Remove its Authorization header so the Box host can
    // inject the real credential through attachHeaders as the sole value.
    const providerHeaders = new Headers(
      init.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    providerHeaders.delete("authorization");
    const providerInit = { ...init, headers: providerHeaders };
    const providerInput = input instanceof Request
      ? new Request(input, providerInit)
      : input;
    const response = await originalFetch(
      providerInput,
      input instanceof Request ? undefined : providerInit,
    );
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.clone().text();
        detail = body.replace(/[\r\n]+/g, " ").slice(0, 300);
      } catch {}
      throw new Error(
        "Provider request failed with HTTP " + response.status
          + (detail ? ": " + detail : ""),
      );
    }
    const headerInput = Number(response.headers.get("x-usage-input-tokens") ?? 0);
    const headerCached = Number(response.headers.get("x-usage-cached-input-tokens") ?? 0);
    const headerOutput = Number(response.headers.get("x-usage-output-tokens") ?? 0);
    if (requestedModel.startsWith("deepseek/") && [headerInput, headerCached, headerOutput].every(Number.isFinite)) {
      meteredCostUsd += (Math.max(0, headerInput - headerCached) / 1000000) * inputUsdPerMTokens
        + (Math.max(0, headerCached) / 1000000) * cachedInputUsdPerMTokens
        + (Math.max(0, headerOutput) / 1000000) * outputUsdPerMTokens;
    }
    return response;
  };

  const { session, extensionsResult } = await createAgentSession({
    model,
    thinkingLevel: "high",
    cwd: WORK_DIR,
    agentDir: sessionDir,
    sessionManager: SessionManager.continueRecent(WORK_DIR, sessionDir),
    resourceLoader,
  });
  if (extensionsResult.errors.length > 0) throw new Error("Pi execution policy failed to load: " + extensionsResult.errors.map(item => item.error).join("; "));

  emit("tool", { name: "pi_agent", toolCallId: sessionId, input: { model: requestedModel } });

  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let totalCostUsd = 0;
  let modelResponses = 0;
  let limitError = "";
  let resolveEnd;
  const agentEndPromise = new Promise(resolve => { resolveEnd = resolve; });

  function addUsage(message) {
    if (message?.role !== "assistant") return;
    modelResponses += 1;
    if (!message.usage) return;
    inputTokens += message.usage.input ?? 0;
    outputTokens += message.usage.output ?? 0;
    cachedInputTokens += message.usage.cacheRead ?? 0;
    const uncached = Math.max(0, (message.usage.input ?? 0) - (message.usage.cacheRead ?? 0));
    const calculated = requestedModel.startsWith("deepseek/")
      ? (uncached / 1000000) * inputUsdPerMTokens
        + ((message.usage.cacheRead ?? 0) / 1000000) * cachedInputUsdPerMTokens
        + ((message.usage.output ?? 0) / 1000000) * outputUsdPerMTokens
      : 0;
    totalCostUsd += calculated;
    meteredCostUsd = Math.max(meteredCostUsd, totalCostUsd);
  }

  session.subscribe(event => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        output += update.delta;
        emit("text", { text: update.delta });
      } else if (update.type === "thinking_delta") {
        emit("thinking", { text: update.delta });
      }
    } else if (event.type === "tool_execution_start") {
      emit("tool", { name: event.toolName, toolCallId: event.toolCallId, input: event.args ?? {} });
    } else if (event.type === "tool_execution_end") {
      emit("tool_result", {
        toolCallId: event.toolCallId,
        output: String(event.result ?? ""),
        is_error: event.isError ?? false,
      });
    } else if (event.type === "turn_end") {
      addUsage(event.message);
      if (event.message?.role === "assistant"
        && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) {
        limitError = event.message.errorMessage
          || "Pi provider request ended with " + event.message.stopReason + ".";
        void session.abort();
        return;
      }
      const anotherResponseRequired = (event.toolResults?.length ?? 0) > 0;
      if (anotherResponseRequired && (modelResponses >= maxModelResponses || providerRequestCount >= maxModelResponses)) {
        limitError = "Pi reached the maximum model-response count.";
        void session.abort();
      } else if (requestedModel.startsWith("deepseek/") && totalCostUsd >= maxModelSpendUsd) {
        limitError = "Pi reached the maximum model-spend limit.";
        void session.abort();
      }
    } else if (event.type === "agent_end") {
      resolveEnd();
    }
  });

  await session.prompt(buildPrompt(prompt));
  await agentEndPromise;
  try {
    const pending = JSON.parse(readFileSync(process.env.BOX_PENDING_APPROVAL_PATH || "/workspace/home/.box-pending-approval.json", "utf8"));
    const marker = "BOX_APPROVAL_REQUIRED:" + Buffer.from(JSON.stringify(pending)).toString("base64url");
    throw new Error(marker);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("BOX_APPROVAL_REQUIRED:")) throw error;
  }
  if (limitError) throw new Error(limitError);

  emit("done", {
    output,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: cachedInputTokens,
    total_cost_usd: totalCostUsd,
    model_responses: modelResponses,
    session_id: sessionId,
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  emit("error", { error: message, session_id: sessionId });
  process.exit(1);
}
`;
