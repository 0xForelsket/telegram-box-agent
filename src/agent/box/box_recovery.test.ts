import { describe, expect, it, vi } from 'vitest';
import { BoxRecovery } from './box_recovery';
import type { BoxJob, BoxJobStore } from './box_job_store';

describe('Box reconciliation', () => {
  const now = 10_000_000;
  const job = { id: 'j', boxId: 'b', runId: 'r', status: 'running', createdAt: now - 600000, updatedAt: now - 600000 } as BoxJob;
  it('recovers a completed remote run when its webhook was lost', async () => {
    const payload = { box_id: 'b', run_id: 'r', status: 'completed' as const, output: 'done' };
    const reconcileCompletion = vi.fn().mockResolvedValue({ ...job, status: 'succeeded' });
    const recovery = new BoxRecovery({ reconcileCompletion } as unknown as BoxJobStore, async () => payload, () => now);
    expect((await recovery.reconcile(job)).status).toBe('succeeded');
    expect(reconcileCompletion).toHaveBeenCalledWith('j', payload, now);
  });
  it('leaves state alone during an inspection outage', async () => {
    const markTimedOut = vi.fn();
    const recovery = new BoxRecovery({ markTimedOut } as unknown as BoxJobStore, async () => { throw new Error('network'); }, () => now);
    await expect(recovery.reconcile(job)).rejects.toThrow('network');
    expect(markTimedOut).not.toHaveBeenCalled();
  });
  it('expires stranded provisioning and confirmed overlong running jobs', async () => {
    const markTimedOut = vi.fn().mockResolvedValue({ ...job, status: 'timed_out' });
    const recovery = new BoxRecovery({ markTimedOut } as unknown as BoxJobStore, async () => null, () => now);
    await recovery.reconcile({ ...job, status: 'provisioning', updatedAt: now - 600001 });
    await recovery.reconcile({ ...job, createdAt: now - 3600001 });
    expect(markTimedOut).toHaveBeenCalledTimes(2);
  });
});
