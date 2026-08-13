import { Box } from '@upstash/box';
import { createPiBoxSchedule } from '../src/agent/box/box_launcher';
import { resolvePiModelRoute } from '../src/agent/box/pi_runtime';

const boxApiKey = requireEnv('UPSTASH_BOX_API_KEY');
const snapshotId = requireEnv('BOX_SNAPSHOT_ID');
const deepseekApiKey = requireEnv('DEEPSEEK_API_KEY');
const proofId = `schedule-proof-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
const route = resolvePiModelRoute({
  requestedRoute: 'deepseek',
  actorUserId: 'schedule-proof-owner',
  ownerUserId: 'schedule-proof-owner',
  deepseekApiKey,
  deepseekRateCard: {
    inputUsdPerMTokens: positiveNumber(process.env.BOX_DEEPSEEK_INPUT_USD_PER_MTOKENS, 0.14),
    cachedInputUsdPerMTokens: positiveNumber(process.env.BOX_DEEPSEEK_CACHED_INPUT_USD_PER_MTOKENS, 0.0028),
    outputUsdPerMTokens: positiveNumber(process.env.BOX_DEEPSEEK_OUTPUT_USD_PER_MTOKENS, 0.28),
  },
});

let box: Box | undefined;
let upstreamScheduleId: string | undefined;
try {
  const created = await createPiBoxSchedule({
    scheduleId: proofId,
    cron: '0 0 1 1 *',
    prompt: 'Schedule API lifecycle proof; this task is deleted before its first run.',
    boxApiKey,
    boxBaseUrl: process.env.UPSTASH_BOX_BASE_URL?.trim() || undefined,
    snapshotId,
    route,
    approvalNonce: crypto.randomUUID().replace(/-/g, ''),
    webhook: {
      url: 'https://example.com/upstash-box-schedule-proof',
      headers: { 'X-Proof-Id': proofId },
    },
  });
  box = await Box.get(created.boxId, {
    apiKey: boxApiKey,
    baseUrl: process.env.UPSTASH_BOX_BASE_URL?.trim() || undefined,
  });
  upstreamScheduleId = created.scheduleId;
  const listed = await box.schedule.list();
  if (!listed.some(schedule => schedule.id === created.scheduleId && schedule.status === 'active')) {
    throw new Error('Created schedule was not listed as active.');
  }
  await box.schedule.pause(created.scheduleId);
  if ((await box.schedule.get(created.scheduleId)).status !== 'paused') throw new Error('Schedule did not pause.');
  await box.schedule.resume(created.scheduleId);
  if ((await box.schedule.get(created.scheduleId)).status !== 'active') throw new Error('Schedule did not resume.');
  await box.schedule.delete(created.scheduleId);
  upstreamScheduleId = undefined;
  console.log(`[box-schedule-proof] PASS box=${created.boxId} create/list/pause/resume/delete`);
} finally {
  if (box && upstreamScheduleId) await box.schedule.delete(upstreamScheduleId).catch(() => undefined);
  if (box) {
    const id = box.id;
    await box.delete().catch(() => undefined);
    console.log(`[box-schedule-proof] deleted box=${id}`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = raw ? Number.parseFloat(raw) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid DeepSeek rate card.');
  return value;
}
