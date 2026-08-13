import { Agent, Box, type BoxConfig, type PromptFiles } from '@upstash/box';
import {
  BOX_MAX_DEEPSEEK_SPEND_USD,
  BOX_MAX_INPUT_CONTEXT_TOKENS,
  BOX_MAX_MODEL_RESPONSES,
  BOX_MAX_OUTPUT_TOKENS,
  PI_AI_VERSION,
  PI_CODING_AGENT_VERSION,
  PI_HARNESS_SOURCE,
  type ResolvedPiModelRoute,
} from './pi_runtime';
import {
  BOX_APPROVAL_GRANT_PATH,
  BOX_APPROVAL_NONCE_PATH,
  BOX_PENDING_APPROVAL_PATH,
  PI_EXECUTION_POLICY_EXTENSION_SOURCE,
} from './execution_policy';

const HARNESS_PATH = '/workspace/home/custom-pi-agent.mjs';
const ARTIFACT_PUBLISHER_PATH = '/workspace/home/publish-artifact.mjs';
const EXECUTION_POLICY_PATH = '/workspace/home/box-execution-policy.mjs';

// Research jobs need broad public-web access. Custom mode blocks private IP
// ranges even for allowed hostnames. Public-suffix rules preserve research,
// package, and callback access without enabling arbitrary private-network SSRF.
export const BOX_NETWORK_POLICY: NonNullable<BoxConfig['networkPolicy']> = {
  mode: 'custom',
  allowedDomains: [
    'api.deepseek.com', 'api.z.ai',
    '*.com', '*.org', '*.net', '*.edu', '*.gov', '*.mil', '*.int',
    '*.io', '*.ai', '*.co', '*.dev', '*.app', '*.cloud', '*.info',
    '*.biz', '*.me', '*.tech', '*.online', '*.site', '*.xyz', '*.news',
    '*.finance', '*.bank',
    '*.uk', '*.us', '*.ca', '*.au', '*.nz', '*.de', '*.fr', '*.es',
    '*.it', '*.nl', '*.be', '*.ch', '*.at', '*.se', '*.no', '*.dk',
    '*.fi', '*.ie', '*.pl', '*.cz', '*.pt', '*.eu', '*.jp', '*.kr',
    '*.cn', '*.hk', '*.sg', '*.my', '*.id', '*.th', '*.ph', '*.vn',
    '*.in', '*.ae', '*.sa', '*.br', '*.mx', '*.ar', '*.za',
  ],
};

export interface BoxCompletionWebhook {
  url: string;
  headers: Record<string, string>;
}

export interface LaunchPiBoxJobInput {
  jobId: string;
  prompt: string;
  boxApiKey: string;
  boxBaseUrl?: string;
  snapshotId?: string;
  route: ResolvedPiModelRoute;
  webhook: BoxCompletionWebhook;
  files?: PromptFiles;
  artifactSession?: {
    authorizeUrl: string;
    token: string;
  };
  approvalNonce: string;
  sessionId?: string;
}

export interface LaunchedPiBoxJob {
  boxId: string;
  runId: string;
  route: ResolvedPiModelRoute['route'];
  model: ResolvedPiModelRoute['model'];
}

export async function resumeApprovedPiBoxJob(input: {
  boxId: string;
  boxApiKey: string;
  boxBaseUrl?: string;
  approvalNonce: string;
  grant: { nonce: string; actionHash: string; expiresAt: number };
  webhook: BoxCompletionWebhook;
}): Promise<string> {
  const box = await Box.get(input.boxId, { apiKey: input.boxApiKey, baseUrl: input.boxBaseUrl });
  await box.resume();
  await box.files.write({ path: BOX_APPROVAL_GRANT_PATH, content: JSON.stringify(input.grant) });
  await box.files.write({ path: BOX_APPROVAL_NONCE_PATH, content: input.approvalNonce });
  const run = await box.agent.run({
    prompt: 'The owner approved the exact pending protected action. Continue the existing session, execute only that approved action, then finish the original request.',
    maxRetries: 0,
    webhook: { url: input.webhook.url, headers: input.webhook.headers },
  });
  return run.id;
}

export async function createPiBoxSchedule(input: {
  scheduleId: string;
  cron: string;
  prompt: string;
  boxApiKey: string;
  boxBaseUrl?: string;
  snapshotId: string;
  route: ResolvedPiModelRoute;
  approvalNonce: string;
  webhook: BoxCompletionWebhook;
}): Promise<{ boxId: string; scheduleId: string }> {
  const config: BoxConfig = {
    apiKey: input.boxApiKey,
    baseUrl: input.boxBaseUrl,
    name: `tg-schedule-${input.scheduleId}`,
    labels: ['telegram-agent', 'scheduled', input.route.route],
    runtime: 'node', size: 'small', browser: true,
    attachHeaders: input.route.providerAttachHeaders,
    networkPolicy: BOX_NETWORK_POLICY,
    agent: {
      harness: Agent.Custom,
      model: input.route.model,
      customHarness: { command: 'node', args: [HARNESS_PATH, '--session', input.scheduleId], protocol: 'box-sse-v1' },
    },
    env: {
      ...input.route.providerEnv,
      PI_ALLOWED_MODEL: input.route.model,
      PI_MAX_MODEL_RESPONSES: String(BOX_MAX_MODEL_RESPONSES),
      PI_MAX_CONTEXT_TOKENS: String(BOX_MAX_INPUT_CONTEXT_TOKENS),
      PI_MAX_OUTPUT_TOKENS: String(BOX_MAX_OUTPUT_TOKENS),
      PI_MAX_MODEL_SPEND_USD: String(BOX_MAX_DEEPSEEK_SPEND_USD),
      PI_INPUT_USD_PER_MTOKENS: String(input.route.rateCard?.inputUsdPerMTokens ?? 0.14),
      PI_CACHED_INPUT_USD_PER_MTOKENS: String(input.route.rateCard?.cachedInputUsdPerMTokens ?? 0.0028),
      PI_OUTPUT_USD_PER_MTOKENS: String(input.route.rateCard?.outputUsdPerMTokens ?? 0.28),
      PI_EXECUTION_POLICY_PATH: EXECUTION_POLICY_PATH,
      BOX_PENDING_APPROVAL_PATH,
      BOX_APPROVAL_GRANT_PATH,
      BOX_APPROVAL_NONCE_PATH,
      BOX_APPROVAL_NONCE: input.approvalNonce,
    },
  };
  const box = await Box.fromSnapshot(input.snapshotId, config);
  let scheduled = false;
  try {
    await box.files.write({ path: HARNESS_PATH, content: PI_HARNESS_SOURCE });
    await box.files.write({ path: EXECUTION_POLICY_PATH, content: PI_EXECUTION_POLICY_EXTENSION_SOURCE });
    await box.files.write({ path: BOX_APPROVAL_NONCE_PATH, content: input.approvalNonce });
    const schedule = await box.schedule.agent({
      cron: input.cron,
      prompt: input.prompt,
      model: input.route.model,
      webhookUrl: input.webhook.url,
      webhookHeaders: input.webhook.headers,
    });
    scheduled = true;
    return { boxId: box.id, scheduleId: schedule.id };
  } finally {
    if (!scheduled) await box.delete().catch(() => undefined);
  }
}

export async function launchPiBoxJob(input: LaunchPiBoxJobInput): Promise<LaunchedPiBoxJob> {
  const jobId = normalizeJobId(input.jobId);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('Box job prompt is empty.');
  if (!input.boxApiKey.trim()) throw new Error('UPSTASH_BOX_API_KEY is required.');
  if (!input.webhook.url.trim()) throw new Error('A Box completion webhook URL is required.');

  const boxConfig: BoxConfig = {
    apiKey: input.boxApiKey.trim(),
    baseUrl: input.boxBaseUrl?.trim() || undefined,
    name: `tg-agent-${jobId}`,
    labels: ['telegram-agent', input.route.route],
    runtime: 'node',
    size: 'small',
    browser: true,
    attachHeaders: input.route.providerAttachHeaders,
    networkPolicy: BOX_NETWORK_POLICY,
    agent: {
      harness: Agent.Custom,
      model: input.route.model,
      customHarness: {
        command: 'node',
        args: [HARNESS_PATH, '--session', input.sessionId ?? jobId],
        protocol: 'box-sse-v1',
      },
    },
    env: {
      ...input.route.providerEnv,
      PI_ALLOWED_MODEL: input.route.model,
      PI_MAX_MODEL_RESPONSES: String(BOX_MAX_MODEL_RESPONSES),
      PI_MAX_CONTEXT_TOKENS: String(BOX_MAX_INPUT_CONTEXT_TOKENS),
      PI_MAX_OUTPUT_TOKENS: String(BOX_MAX_OUTPUT_TOKENS),
      PI_MAX_MODEL_SPEND_USD: String(BOX_MAX_DEEPSEEK_SPEND_USD),
      PI_INPUT_USD_PER_MTOKENS: String(input.route.rateCard?.inputUsdPerMTokens ?? 0.14),
      PI_CACHED_INPUT_USD_PER_MTOKENS: String(input.route.rateCard?.cachedInputUsdPerMTokens ?? 0.0028),
      PI_OUTPUT_USD_PER_MTOKENS: String(input.route.rateCard?.outputUsdPerMTokens ?? 0.28),
      PI_EXECUTION_POLICY_PATH: EXECUTION_POLICY_PATH,
      BOX_PENDING_APPROVAL_PATH,
      BOX_APPROVAL_GRANT_PATH,
      BOX_APPROVAL_NONCE_PATH,
      BOX_APPROVAL_NONCE: input.approvalNonce,
      ...(input.artifactSession ? {
        BOX_ARTIFACT_AUTHORIZE_URL: input.artifactSession.authorizeUrl,
        BOX_ARTIFACT_SESSION_TOKEN: input.artifactSession.token,
        BOX_JOB_ID: jobId,
      } : {}),
    },
  };

  const box = input.snapshotId?.trim()
    ? await Box.fromSnapshot(input.snapshotId.trim(), boxConfig)
    : await Box.create(boxConfig);

  let accepted = false;
  try {
    if (!input.snapshotId?.trim()) {
      await box.exec.command(
        `cd /workspace/home && npm install --no-save --silent --ignore-scripts @earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION} @earendil-works/pi-ai@${PI_AI_VERSION}`,
      );
    }
    // Always refresh the harness so a snapshot cannot silently run an older
    // orchestration policy after the Worker deploys a safety change.
    await box.files.write({ path: HARNESS_PATH, content: PI_HARNESS_SOURCE });
    await box.files.write({ path: EXECUTION_POLICY_PATH, content: PI_EXECUTION_POLICY_EXTENSION_SOURCE });
    await box.files.write({ path: BOX_APPROVAL_NONCE_PATH, content: input.approvalNonce });
    if (input.artifactSession) {
      await box.files.write({ path: ARTIFACT_PUBLISHER_PATH, content: ARTIFACT_PUBLISHER_SOURCE });
    }

    const run = await box.agent.run({
      prompt: input.artifactSession ? withArtifactInstructions(prompt) : prompt,
      files: input.files,
      maxRetries: 0,
      webhook: {
        url: input.webhook.url.trim(),
        headers: input.webhook.headers,
      },
    });
    accepted = true;
    return {
      boxId: box.id,
      runId: run.id,
      route: input.route.route,
      model: input.route.model,
    };
  } finally {
    // Once accepted, the callback/cleanup path owns the Box. A provisioning or
    // submission failure has no callback, so clean that Box up here.
    if (!accepted) await box.delete().catch(() => undefined);
  }
}

function withArtifactInstructions(prompt: string): string {
  return `${prompt}\n\nWhen the user requests a downloadable file, create it under /workspace/home and publish each final file by running: node ${ARTIFACT_PUBLISHER_PATH} <absolute-file-path> [content-type]. Mention the published filename in your final response. Do not inline binary data.`;
}

export const ARTIFACT_PUBLISHER_SOURCE = String.raw`
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";

const [filePath, contentType = "application/octet-stream"] = process.argv.slice(2);
if (!filePath) throw new Error("Usage: publish-artifact.mjs <absolute-file-path> [content-type]");
const info = await stat(filePath);
if (!info.isFile() || info.size <= 0) throw new Error("Artifact must be a non-empty file.");
const authorizeUrl = process.env.BOX_ARTIFACT_AUTHORIZE_URL;
const sessionToken = process.env.BOX_ARTIFACT_SESSION_TOKEN;
const jobId = process.env.BOX_JOB_ID;
if (!authorizeUrl || !sessionToken || !jobId) throw new Error("Artifact publishing is not configured.");
const digest = createHash("sha256").update(basename(filePath)).update("\0").update(contentType).update("\0");
for await (const chunk of createReadStream(filePath)) digest.update(chunk);
const idempotencyKey = digest.digest("hex");

const authorization = await fetch(authorizeUrl, {
  method: "POST",
  headers: {
    "Authorization": "Bearer " + sessionToken,
    "Content-Type": "application/json",
    "X-Box-Job-Id": jobId,
    "X-Artifact-Idempotency-Key": idempotencyKey,
  },
  body: JSON.stringify({ filename: basename(filePath), contentType, size: info.size }),
});
if (!authorization.ok) throw new Error("Artifact authorization failed: " + authorization.status + " " + await authorization.text());
const target = await authorization.json();
if (target.alreadyUploaded) {
  console.log(JSON.stringify({ artifact_id: target.artifactId, filename: basename(filePath), size: info.size, duplicate: true }));
  process.exit(0);
}
const uploaded = await fetch(target.uploadUrl, {
  method: "PUT",
  headers: target.headers,
  body: createReadStream(filePath),
  duplex: "half",
});
if (!uploaded.ok) throw new Error("Artifact upload failed: " + uploaded.status + " " + await uploaded.text());
console.log(JSON.stringify({ artifact_id: target.artifactId, filename: basename(filePath), size: info.size }));
`;

function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{5,39}$/.test(normalized)) {
    throw new Error('Invalid Box job ID.');
  }
  return normalized;
}
