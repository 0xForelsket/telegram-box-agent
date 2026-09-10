import { Box, type WebhookPayload } from '@upstash/box';
import type { Env } from '../../env';
import { BoxJobStore, type BoxJob } from './box_job_store';

export type InspectBoxRun = (job: BoxJob) => Promise<WebhookPayload | null>;

export class BoxRecovery {
  constructor(private readonly store: BoxJobStore, private readonly inspect: InspectBoxRun, private readonly now = Date.now) {}

  async reconcile(job: BoxJob): Promise<BoxJob> {
    const age = this.now() - job.updatedAt;
    if (['queued', 'provisioning'].includes(job.status) && age > 10 * 60_000) {
      return this.store.markTimedOut(job.id, 'Box provisioning was interrupted. Please start a new job.', this.now());
    }
    if (job.status !== 'running' || age < 5 * 60_000) return job;
    // A failed status query is not proof that the job failed. Leave it eligible
    // for the next recovery pass; never convert an API outage into data loss.
    const completion = await this.inspect(job);
    if (completion) return this.store.reconcileCompletion(job.id, completion, this.now());
    if (this.now() - job.createdAt > 60 * 60_000) {
      return this.store.markTimedOut(job.id, 'Box job exceeded its one-hour recovery deadline.', this.now());
    }
    return job;
  }
}

export function inspectBoxRun(env: Env): InspectBoxRun {
  return async job => {
    if (!job.boxId || !job.runId) return null;
    const box = await Box.get(job.boxId, {
      apiKey: env.UPSTASH_BOX_API_KEY, baseUrl: env.UPSTASH_BOX_BASE_URL, timeout: 10_000,
    });
    const run = (await box.listRuns()).find(run => run.id === job.runId && run.box_id === job.boxId);
    if (!run || run.status === 'running') return null;
    return {
      box_id: job.boxId, run_id: job.runId,
      status: run.status === 'completed' ? 'completed' : 'failed',
      output: run.output, error: run.error_message ?? (run.status === 'cancelled' ? 'Box run was canceled.' : undefined),
      metadata: { input_tokens: run.input_tokens, output_tokens: run.output_tokens,
        cached_input_tokens: run.cached_input_tokens, total_cost_usd: run.cost_usd },
    };
  };
}
