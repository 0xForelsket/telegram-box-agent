import { describe, expect, it, vi } from 'vitest';
import { runExecution, executionSignal, trackBackground, assertExecutionActive } from './execution';

describe('execution deadline', () => {
  it('aborts pending calls and fences late side effects', async () => {
    let signal!: AbortSignal;
    let late!: () => void;
    const blocked = new Promise<void>(resolve => { late = resolve; });
    const effect = vi.fn();
    await expect(runExecution(5, async () => {
      signal = executionSignal();
      await blocked;
      assertExecutionActive(); effect();
    })).rejects.toThrow('deadline');
    expect(signal.aborted).toBe(true);
    late(); await Promise.resolve();
    expect(effect).not.toHaveBeenCalled();
  });
  it('waits for turn background work before releasing the conversation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const completed = vi.fn();
    const run = runExecution(1000, async () => { trackBackground(pending); }).then(completed);
    await Promise.resolve(); expect(completed).not.toHaveBeenCalled();
    finish(); await run; expect(completed).toHaveBeenCalledOnce();
  });
});
