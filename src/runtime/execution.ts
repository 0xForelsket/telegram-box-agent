import { AsyncLocalStorage } from 'node:async_hooks';

interface Execution {
  signal: AbortSignal;
  deferReply?: (chatId: number, text: string) => Promise<void>;
  background: Promise<unknown>[];
}

const executions = new AsyncLocalStorage<Execution>();

export function executionSignal(signal?: AbortSignal | null, timeoutMs = 60_000): AbortSignal {
  const active = executions.getStore()?.signal;
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(active ? [active] : []), ...(signal ? [signal] : [])]);
}

export function assertExecutionActive(): void {
  executions.getStore()?.signal.throwIfAborted();
}

export function hasDeferredReply(): boolean {
  return !!executions.getStore()?.deferReply;
}

export async function runExecution<T>(timeoutMs: number, fn: () => Promise<T>, deferReply?: Execution['deferReply']): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Execution deadline exceeded.');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const scope: Execution = { signal: controller.signal, deferReply, background: [] };
    return await executions.run(scope, () => Promise.race([(async () => {
      const result = await fn();
      // Background work spawned during a turn shares its deadline and finishes
      // before another turn can acquire this conversation.
      let offset = 0;
      while (offset < scope.background.length) {
        const batch = scope.background.slice(offset); offset += batch.length;
        await Promise.allSettled(batch);
      }
      return result;
    })(), expired]));
  } finally {
    clearTimeout(timer!);
    controller.abort(new Error('Execution finished.'));
  }
}

export function trackBackground(promise: Promise<unknown>): boolean {
  const active = executions.getStore();
  if (!active) return false;
  active.background.push(promise);
  return true;
}

export async function deferReply(chatId: number, text: string): Promise<boolean> {
  const active = executions.getStore();
  if (!active?.deferReply) return false;
  active.signal.throwIfAborted();
  await active.deferReply(chatId, text);
  return true;
}
