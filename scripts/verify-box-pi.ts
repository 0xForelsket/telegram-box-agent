import { Agent, Box, type BoxConfig } from '@upstash/box';
import {
  BOX_MAX_DEEPSEEK_SPEND_USD,
  BOX_MAX_INPUT_CONTEXT_TOKENS,
  BOX_MAX_MODEL_RESPONSES,
  BOX_MAX_OUTPUT_TOKENS,
  PI_AI_VERSION,
  PI_CODING_AGENT_VERSION,
  PI_HARNESS_SOURCE,
  resolvePiModelRoute,
  type BoxModelRoute,
} from '../src/agent/box/pi_runtime';
import {
  BOX_APPROVAL_GRANT_PATH,
  BOX_APPROVAL_NONCE_PATH,
  BOX_PENDING_APPROVAL_PATH,
  PI_EXECUTION_POLICY_EXTENSION_SOURCE,
} from '../src/agent/box/execution_policy';
import { BOX_NETWORK_POLICY } from '../src/agent/box/box_launcher';

const mode = (process.argv[2] ?? '').trim().toLowerCase();
if (mode !== 'deepseek' && mode !== 'glm' && mode !== 'approval') {
  throw new Error('Usage: verify-box-pi <deepseek|glm|approval>');
}
const target: BoxModelRoute = mode === 'glm' ? 'glm' : 'deepseek';

const boxApiKey = requireEnv('UPSTASH_BOX_API_KEY');
const deepseekApiKey = requireEnv('DEEPSEEK_API_KEY');
const zaiCodingPlanApiKey = requireEnv('ZAI_CODING_PLAN_API_KEY');
const ownerUserId = process.env.OWNER_USER_ID?.trim() || 'box-verification-owner';
const rateCard = {
  inputUsdPerMTokens: positiveNumber(process.env.BOX_DEEPSEEK_INPUT_USD_PER_MTOKENS, 0.14),
  cachedInputUsdPerMTokens: positiveNumber(process.env.BOX_DEEPSEEK_CACHED_INPUT_USD_PER_MTOKENS, 0.0028),
  outputUsdPerMTokens: positiveNumber(process.env.BOX_DEEPSEEK_OUTPUT_USD_PER_MTOKENS, 0.28),
};
const snapshotId = process.env.BOX_SNAPSHOT_ID?.trim();
const approvalNonce = crypto.randomUUID().replace(/-/g, '');
const policyPath = '/workspace/home/box-execution-policy.mjs';

if (target === 'glm') verifyNonOwnerRejection();

const route = resolvePiModelRoute({
  requestedRoute: target,
  actorUserId: ownerUserId,
  ownerUserId,
  deepseekApiKey,
  zaiCodingPlanApiKey,
  deepseekRateCard: rateCard,
});

const marker = `pi-${mode}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const proofPath = `/workspace/home/${marker}.txt`;
const boxConfig: BoxConfig = {
  apiKey: boxApiKey,
  baseUrl: process.env.UPSTASH_BOX_BASE_URL?.trim() || undefined,
  name: `pi-proof-${mode}-${Date.now().toString(36)}`,
  labels: ['pi-proof', mode],
  runtime: 'node',
  size: 'small',
  attachHeaders: route.providerAttachHeaders,
  networkPolicy: BOX_NETWORK_POLICY,
  agent: {
    harness: Agent.Custom,
    model: route.model,
    customHarness: {
      command: 'node',
      args: ['/workspace/home/custom-pi-agent.mjs', '--session', marker],
      protocol: 'box-sse-v1',
    },
  },
  env: {
    ...route.providerEnv,
    PI_ALLOWED_MODEL: route.model,
    PI_MAX_MODEL_RESPONSES: String(BOX_MAX_MODEL_RESPONSES),
    PI_MAX_CONTEXT_TOKENS: String(BOX_MAX_INPUT_CONTEXT_TOKENS),
    PI_MAX_OUTPUT_TOKENS: String(BOX_MAX_OUTPUT_TOKENS),
    PI_MAX_MODEL_SPEND_USD: String(BOX_MAX_DEEPSEEK_SPEND_USD),
    PI_INPUT_USD_PER_MTOKENS: String(rateCard.inputUsdPerMTokens),
    PI_CACHED_INPUT_USD_PER_MTOKENS: String(rateCard.cachedInputUsdPerMTokens),
    PI_OUTPUT_USD_PER_MTOKENS: String(rateCard.outputUsdPerMTokens),
    PI_EXECUTION_POLICY_PATH: policyPath,
    BOX_PENDING_APPROVAL_PATH,
    BOX_APPROVAL_GRANT_PATH,
    BOX_APPROVAL_NONCE_PATH,
    BOX_APPROVAL_NONCE: approvalNonce,
  },
};
const box = snapshotId
  ? await createBoxFromSnapshotAfterConnectTimeout(snapshotId, boxConfig)
  : await createBoxAfterConnectTimeout(boxConfig);

console.log(`[box-proof] created box=${box.id} route=${route.route} model=${route.model}`);
try {
  if (!snapshotId) {
    const install = await retryProvisioning(
      'Pi package installation',
      () => box.exec.command(
        `cd /workspace/home && npm install --no-save --silent --ignore-scripts @earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION} @earendil-works/pi-ai@${PI_AI_VERSION}`,
      ),
    );
    if (install.status !== 'completed' || install.exitCode !== 0) {
      throw new Error(`Pinned Pi package installation failed with status ${install.status}.`);
    }
  }
  await retryProvisioning(
    'Pi harness upload',
    () => box.files.write({ path: 'custom-pi-agent.mjs', content: PI_HARNESS_SOURCE }),
  );
  await retryProvisioning(
    'execution policy upload',
    () => box.files.write({ path: policyPath, content: PI_EXECUTION_POLICY_EXTENSION_SOURCE }),
  );
  await retryProvisioning(
    'approval nonce upload',
    () => box.files.write({ path: BOX_APPROVAL_NONCE_PATH, content: approvalNonce }),
  );
  const harnessCheck = await retryProvisioning(
    'Pi harness smoke check',
    () => box.exec.command(
      'cd /workspace/home && node --check custom-pi-agent.mjs && node -e "Promise.all([import(\'@earendil-works/pi-coding-agent\'),import(\'@earendil-works/pi-ai/compat\').then(m => { if (typeof m.getModel !== \'function\') throw new Error(\'getModel unavailable\') })])"',
    ),
  );
  if (harnessCheck.status !== 'completed' || harnessCheck.exitCode !== 0) {
    throw new Error(`Pi harness smoke check failed: ${redact(harnessCheck.stderr || harnessCheck.result)}`);
  }
  console.log('[box-proof] pinned Pi packages and harness installed');
  await verifyProviderConnectivity(box, target);
  await verifyPublicInternetConnectivity(box);

  if (mode === 'approval') {
    await verifyApprovalRoundTrip(box, marker);
    console.log(`[box-proof] PASS route=${route.route} approval-gate=true`);
    process.exitCode = 0;
  } else {

  const first = await box.agent.run({
    prompt: [
      `Use the bash tool to create ${proofPath} containing exactly this text: ${marker}`,
      'Then use the read tool to read that file.',
      `Finish your response with PROOF_ONE:${marker}`,
    ].join('\n'),
    maxRetries: 0,
  });
  assertCompleted(first.status, 'first Pi turn');
  console.log(`[box-proof] first result=${summarizeResult(first.result)} input=${first.cost.inputTokens} output=${first.cost.outputTokens}`);
  try {
    const firstFile = await readProofFile(box, proofPath, first, 'first Pi turn');
    assertContains(firstFile, marker, 'first proof file');
    assertContains(first.result, `PROOF_ONE:${marker}`, 'first Pi response');
  } catch (error) {
    await diagnoseHarness(box, route.model, marker);
    throw error;
  }
  console.log(`[box-proof] first turn passed input=${first.cost.inputTokens} output=${first.cost.outputTokens}`);

  const resumeMarker = `${marker}-resumed`;
  const second = await box.agent.run({
    prompt: [
      `Continue the same session. Use bash to append a new line containing ${resumeMarker} to ${proofPath}.`,
      'Then use the read tool to read the entire file.',
      `Finish your response with PROOF_TWO:${resumeMarker}`,
    ].join('\n'),
    maxRetries: 0,
  });
  assertCompleted(second.status, 'resumed Pi turn');
  const resumedFile = await box.files.read(proofPath);
  assertContains(resumedFile, marker, 'resumed proof file original marker');
  assertContains(resumedFile, resumeMarker, 'resumed proof file appended marker');
  console.log(`[box-proof] resumed result=${summarizeResult(second.result)}`);
  assertContains(second.result, `PROOF_TWO:${resumeMarker}`, 'resumed Pi response');
  console.log(`[box-proof] resumed turn passed input=${second.cost.inputTokens} output=${second.cost.outputTokens}`);
  console.log(`[box-proof] PASS route=${route.route} model=${route.model}`);
  }
} finally {
  await box.delete();
  console.log(`[box-proof] deleted box=${box.id}`);
}

async function verifyProviderConnectivity(activeBox: Box, modelRoute: BoxModelRoute): Promise<void> {
  const endpoint = modelRoute === 'glm'
    ? 'https://api.z.ai/api/coding/paas/v4/models'
    : 'https://api.deepseek.com/models';
  const probe = await activeBox.exec.command(
    `node -e 'fetch("${endpoint}").then(async r => { console.log("status=" + r.status); if (!r.ok) { console.error((await r.text()).slice(0, 300)); process.exit(2); } }).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(3); })'`,
  );
  if (probe.status !== 'completed' || probe.exitCode !== 0) {
    throw new Error(
      `Provider connectivity probe failed: ${redact(probe.stderr || probe.stdout || probe.result)}`,
    );
  }
  console.log(`[box-proof] provider connectivity ${redact(probe.stdout).trim()}`);
}

async function verifyPublicInternetConnectivity(activeBox: Box): Promise<void> {
  const probe = await activeBox.exec.command(
    `node -e 'fetch("https://example.com/").then(r => { console.log("status=" + r.status); if (!r.ok) process.exit(2); }).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exit(3); })'`,
  );
  if (probe.status !== 'completed' || probe.exitCode !== 0) {
    throw new Error(
      `Public internet connectivity probe failed: ${redact(probe.stderr || probe.stdout || probe.result)}`,
    );
  }
  console.log(`[box-proof] public internet connectivity ${redact(probe.stdout).trim()}`);
}

async function verifyApprovalRoundTrip(activeBox: Box, approvalMarker: string): Promise<void> {
  const approvedPath = `/workspace/home/${approvalMarker}-approved.txt`;
  const protectedCommand = `curl -fsS -X DELETE https://httpbingo.org/status/204 && printf '${approvalMarker}\\n' | tee ${approvedPath}`;
  let blocked = false;
  let blockedReason = '';
  try {
    const run = await activeBox.agent.run({
      prompt: `This is an authorized approval-gate integration test. Attempt this exact bash command once and do not alter or discuss it: ${protectedCommand}`,
      maxRetries: 0,
    });
    blocked = run.status === 'failed' && String(run.result).includes('BOX_APPROVAL_REQUIRED:');
    blockedReason = `status=${run.status} result=${String(run.result).slice(0, 500)}`;
  } catch (error) {
    blocked = error instanceof Error && error.message.includes('BOX_APPROVAL_REQUIRED:');
    blockedReason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
  if (!blocked) throw new Error(`Protected action was not paused with the approval marker: ${blockedReason}`);
  const pending = JSON.parse(await retryProvisioning(
    'pending approval read',
    () => activeBox.files.read(BOX_PENDING_APPROVAL_PATH),
  )) as {
    nonce: string; action: string; actionHash: string;
  };
  if (pending.nonce !== approvalNonce || pending.action !== protectedCommand || !/^[a-f0-9]{64}$/.test(pending.actionHash)) {
    throw new Error('Protected action approval binding is invalid.');
  }
  try {
    await activeBox.files.read(approvedPath);
    throw new Error('Protected action executed before approval.');
  } catch (error) {
    if (error instanceof Error && error.message === 'Protected action executed before approval.') throw error;
  }
  await activeBox.files.write({
    path: BOX_APPROVAL_GRANT_PATH,
    content: JSON.stringify({ nonce: pending.nonce, actionHash: pending.actionHash, expiresAt: Date.now() + 5 * 60_000 }),
  });
  const resumed = await activeBox.agent.run({
    prompt: 'The owner approved the exact pending protected action. Retry that exact command without changing it, then confirm completion.',
    maxRetries: 0,
  });
  assertCompleted(resumed.status, 'approved Pi turn');
  console.log(`[box-proof] approved result=${summarizeResult(resumed.result)}`);
  assertContains(await retryProvisioning(
    'approved action proof read',
    () => activeBox.files.read(approvedPath),
  ), approvalMarker, 'approved action proof file');
  let secondActionPaused = false;
  let secondActionReason = '';
  try {
    const run = await activeBox.agent.run({
      prompt: `Continue this policy integration test. Attempt this exact bash command once without changing it: gh pr comment 1 --body ${approvalMarker}`,
      maxRetries: 0,
    });
    secondActionPaused = run.status === 'failed' && String(run.result).includes('BOX_APPROVAL_REQUIRED:');
    secondActionReason = `status=${run.status} result=${String(run.result).slice(0, 500)}`;
  } catch (error) {
    secondActionPaused = error instanceof Error && error.message.includes('BOX_APPROVAL_REQUIRED:');
    secondActionReason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  }
  if (!secondActionPaused) throw new Error(`A second protected action was not paused independently: ${secondActionReason}`);
  console.log('[box-proof] protected action paused, nonce/hash bound, approved once, resumed, and a different action required separate approval');
}

function verifyNonOwnerRejection(): void {
  try {
    resolvePiModelRoute({
      requestedRoute: 'glm',
      actorUserId: 'non_owner_probe',
      ownerUserId,
      deepseekApiKey,
      zaiCodingPlanApiKey,
      deepseekRateCard: rateCard,
    });
    throw new Error('Non-owner GLM route unexpectedly succeeded.');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'BOX_MODEL_FORBIDDEN') throw error;
    console.log('[box-proof] non-owner GLM selection rejected');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Invalid DeepSeek rate card.');
  return parsed;
}

function assertCompleted(status: string, label: string): void {
  if (status !== 'completed') throw new Error(`${label} ended with status ${status}.`);
}

function assertContains(value: unknown, expected: string, label: string): void {
  if (typeof value !== 'string' || !value.includes(expected)) {
    throw new Error(`${label} did not contain its expected marker.`);
  }
}

function summarizeResult(value: unknown): string {
  return JSON.stringify(redact(typeof value === 'string' ? value.slice(0, 1_500) : String(value).slice(0, 1_500)));
}

async function readProofFile(
  activeBox: Box,
  path: string,
  run: { logs(): Promise<Array<{ level: string; message: string }>> },
  label: string,
): Promise<string> {
  try {
    return await activeBox.files.read(path);
  } catch (error) {
    const logs = await run.logs().catch(() => []);
    for (const entry of logs.slice(-20)) {
      console.error(`[box-proof] ${label} log ${entry.level}: ${redact(entry.message).slice(0, 1_500)}`);
    }
    throw error;
  }
}

function redact(value: string): string {
  return [boxApiKey, deepseekApiKey, zaiCodingPlanApiKey]
    .filter(Boolean)
    .reduce((text, secret) => text.split(secret).join('[redacted]'), value);
}

async function retryProvisioning<T>(label: string, action: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`[box-proof] ${label} attempt ${attempt} failed; retrying`);
        await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function createBoxAfterConnectTimeout(config: BoxConfig): Promise<Box> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await Box.create(config);
    } catch (error) {
      lastError = error;
      const cause = error && typeof error === 'object' && 'cause' in error
        ? error.cause as { code?: string } | undefined
        : undefined;
      const safePreRequestFailure = cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || cause?.code === 'EAI_AGAIN';
      if (!safePreRequestFailure || attempt === 3) throw error;
      console.warn(`[box-proof] Box connection attempt ${attempt} failed before reaching Upstash; retrying`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function createBoxFromSnapshotAfterConnectTimeout(snapshot: string, config: BoxConfig): Promise<Box> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await Box.fromSnapshot(snapshot, config);
    } catch (error) {
      lastError = error;
      if (attempt === 3) throw error;
      console.warn(`[box-proof] snapshot restore attempt ${attempt} failed; retrying`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function diagnoseHarness(activeBox: Box, model: string, diagnosticMarker: string): Promise<void> {
  const logs = await activeBox.logs({ limit: 50 }).catch(() => []);
  for (const entry of logs.slice(-20)) {
    console.error(`[box-proof] box log ${entry.level}: ${redact(entry.message).slice(0, 1_500)}`);
  }
  const direct = await activeBox.exec.command(
    `cd /workspace/home && node custom-pi-agent.mjs -p "Reply with DIRECT_${diagnosticMarker} only" --model "${model}" --stream`,
  );
  console.error(`[box-proof] direct harness status=${direct.status} exit=${direct.exitCode}`);
  console.error(`[box-proof] direct harness stdout=${redact(direct.stdout).slice(0, 8_000)}`);
  console.error(`[box-proof] direct harness stderr=${redact(direct.stderr).slice(0, 8_000)}`);
}
