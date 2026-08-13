import { RedisClient } from '../utils/redis';

const DUE_QUEUE_KEY = 'agent_runs:v1:due';
const RECORD_PREFIX = 'agent_run:v1:';
const SESSION_PREFIX = 'agent_runs:v1:session:';
const RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const RUN_LEASE_MS = 10 * 60_000;
// Make a successful slice eligible well before the next five-minute Worker cron.
// A full five-minute delay can miss the next tick when the current wake takes time.
const DEFAULT_WAKE_DELAY_MS = 60_000;
const MAX_DUE_PER_CRON = 1;
const MAX_OBSERVATIONS = 12;
const MAX_JOURNAL_ENTRIES = 16;

export type AgentRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type AgentRunPhase = 'planning' | 'executing' | 'finalizing';

export interface AgentPlanStep {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'completed' | 'skipped';
}

export interface AgentObservation {
  stepId: string;
  summary: string;
  createdAt: number;
}

export interface AgentJournalEntry {
  wakeId: string;
  phase: AgentRunPhase;
  stepId: string;
  status: 'started' | 'completed' | 'failed';
  createdAt: number;
}

export interface AgentRun {
  id: string;
  chatId: number;
  sessionKey: string;
  goal: string;
  status: AgentRunStatus;
  phase: AgentRunPhase;
  createdAt: number;
  updatedAt: number;
  nextAt: number;
  wakeCount: number;
  maxWakes: number;
  retryCount: number;
  maxRetries: number;
  currentStep: number;
  plan: AgentPlanStep[];
  observations: AgentObservation[];
  journal: AgentJournalEntry[];
  activeWakeId?: string;
  progressMessageId?: number;
  result?: string;
  lastError?: string;
  // Kept for compatibility with jobs created by the first queue release.
  stepCount: number;
  maxSteps: number;
}

export type AgentWakeResult =
  | { type: 'planned'; plan: string[]; observation?: string; delayMs?: number }
  | { type: 'advanced'; observation: string; delayMs?: number }
  | { type: 'completed'; result: string; observation?: string }
  | { type: 'blocked'; error: string };

interface CreateAgentRunInput {
  chatId: number;
  sessionKey: string;
  goal: string;
  now?: number;
  maxWakes?: number;
}

export class AgentRunStore {
  constructor(private readonly redis: RedisClient) {}

  async create(input: CreateAgentRunInput): Promise<AgentRun> {
    const goal = input.goal.trim().replace(/\s+/g, ' ').slice(0, 2_000);
    if (!goal) throw new Error('Agent job goal is empty.');
    const now = input.now ?? Date.now();
    const maxWakes = Math.max(3, Math.min(16, input.maxWakes ?? 12));
    const run: AgentRun = {
      id: crypto.randomUUID().replace(/-/g, '').slice(0, 8),
      chatId: input.chatId,
      sessionKey: input.sessionKey,
      goal,
      status: 'queued',
      phase: 'planning',
      createdAt: now,
      updatedAt: now,
      nextAt: now,
      wakeCount: 0,
      maxWakes,
      retryCount: 0,
      maxRetries: 3,
      currentStep: 0,
      plan: [],
      observations: [],
      journal: [],
      stepCount: 0,
      maxSteps: maxWakes,
    };
    await this.save(run);
    await Promise.all([
      this.redis.zadd(DUE_QUEUE_KEY, run.nextAt, run.id),
      this.redis.zadd(this.sessionIndexKey(run.sessionKey), run.createdAt, run.id),
    ]);
    return run;
  }

  async list(sessionKey: string): Promise<AgentRun[]> {
    const ids = await this.redis.zrangeAll(this.sessionIndexKey(sessionKey), 50);
    const records = await this.redis.getMany(ids.map(id => this.recordKey(id)));
    const runs: AgentRun[] = [];
    const staleIds: string[] = [];
    for (let index = 0; index < ids.length; index++) {
      const run = this.parse(records[index]);
      if (!run || run.sessionKey !== sessionKey) {
        staleIds.push(ids[index]);
        continue;
      }
      runs.push(run);
    }
    await Promise.all(staleIds.map(id => this.redis.zrem(this.sessionIndexKey(sessionKey), id)));
    return runs.sort((left, right) => right.createdAt - left.createdAt);
  }

  async getForSession(sessionKey: string, id: string): Promise<AgentRun | null> {
    const run = await this.get(id.trim().toLowerCase());
    return run?.sessionKey === sessionKey ? run : null;
  }

  async setProgressMessage(id: string, messageId: number): Promise<AgentRun | null> {
    return await this.redis.withLock(`agent-run:${id}`, async () => {
      const run = await this.get(id);
      if (!run) return null;
      const updated = { ...run, progressMessageId: messageId, updatedAt: Date.now() };
      await this.save(updated);
      return updated;
    });
  }

  async cancel(sessionKey: string, id: string, now = Date.now()): Promise<AgentRun | null> {
    const normalizedId = id.trim().toLowerCase();
    if (!normalizedId) return null;
    return await this.redis.withLock(`agent-run:${normalizedId}`, async () => {
      const run = await this.get(normalizedId);
      if (!run || run.sessionKey !== sessionKey || this.isTerminal(run.status)) return null;
      const cancelled: AgentRun = { ...run, status: 'cancelled', activeWakeId: undefined, updatedAt: now, nextAt: 0 };
      await this.save(cancelled);
      await this.redis.zrem(DUE_QUEUE_KEY, run.id);
      return cancelled;
    });
  }

  async retirePending(now = Date.now()): Promise<number> {
    const ids = await this.redis.zrangeAll(DUE_QUEUE_KEY, 100);
    let retired = 0;
    for (const id of ids) {
      const changed = await this.redis.withLock(`agent-run:${id}`, async () => {
        const run = await this.get(id);
        await this.redis.zrem(DUE_QUEUE_KEY, id);
        if (!run || this.isTerminal(run.status)) return false;
        await this.save({
          ...run,
          status: 'failed',
          activeWakeId: undefined,
          nextAt: 0,
          updatedAt: now,
          lastError: 'Retired during the Upstash Box cutover. This record is read-only; start a new /agent job.',
        });
        return true;
      });
      if (changed) retired += 1;
    }
    return retired;
  }

  async drainDue(
    handler: (run: AgentRun) => Promise<AgentWakeResult>,
    now = Date.now(),
    onTransition?: (run: AgentRun) => Promise<void>,
  ): Promise<number> {
    const ids = await this.redis.zrangeByScore(DUE_QUEUE_KEY, 0, now, MAX_DUE_PER_CRON);
    let processed = 0;
    for (const id of ids) {
      const claimed = await this.claim(id, now);
      if (!claimed) continue;
      if (this.isTerminal(claimed.status)) {
        processed += 1;
        if (onTransition) await onTransition(claimed).catch(error => {
          console.error(`Agent job ${claimed.id} terminal notification failed:`, error);
        });
        continue;
      }
      let transitioned: AgentRun | null = null;
      try {
        const result = await handler(claimed);
        transitioned = await this.applyWakeResult(claimed.id, claimed.activeWakeId!, result, Date.now());
      } catch (error) {
        transitioned = await this.failOrRetry(claimed.id, claimed.activeWakeId!, error, Date.now());
      }
      if (transitioned) {
        processed += 1;
        if (onTransition) {
          try {
            await onTransition(transitioned);
          } catch (error) {
            console.error(`Agent job ${transitioned.id} transition notification failed:`, error);
          }
        }
      }
    }
    return processed;
  }

  private async claim(id: string, now: number): Promise<AgentRun | null> {
    return await this.redis.withLock(`agent-run:${id}`, async () => {
      const run = await this.get(id);
      if (!run || !['queued', 'waiting', 'running'].includes(run.status) || run.nextAt > now) {
        if (!run || (run && this.isTerminal(run.status))) await this.redis.zrem(DUE_QUEUE_KEY, id);
        return null;
      }
      if (run.wakeCount >= run.maxWakes) {
        const failed = await this.failTerminal(run, 'Agent job exhausted its maximum wake count.', now);
        await this.redis.zrem(DUE_QUEUE_KEY, id);
        return failed;
      }
      const wakeId = crypto.randomUUID().slice(0, 12);
      const stepId = this.currentStepId(run);
      const journal = this.appendJournal(run.journal, {
        wakeId, phase: run.phase, stepId, status: 'started', createdAt: now,
      });
      const claimed: AgentRun = {
        ...run,
        status: 'running',
        updatedAt: now,
        nextAt: now + RUN_LEASE_MS,
        wakeCount: run.wakeCount + 1,
        stepCount: run.wakeCount + 1,
        activeWakeId: wakeId,
        journal,
        plan: this.activateCurrentStep(run.plan, run.currentStep),
        lastError: undefined,
      };
      await this.save(claimed);
      await this.redis.zadd(DUE_QUEUE_KEY, claimed.nextAt, claimed.id);
      return claimed;
    });
  }

  private async applyWakeResult(id: string, wakeId: string, result: AgentWakeResult, now: number): Promise<AgentRun | null> {
    return await this.redis.withLock(`agent-run:${id}`, async () => {
      const run = await this.get(id);
      if (!run || run.status === 'cancelled' || run.activeWakeId !== wakeId) return null;
      const journal = this.completeJournal(run.journal, wakeId, result.type === 'blocked' ? 'failed' : 'completed');

      if (result.type === 'completed') {
        const completed: AgentRun = {
          ...run,
          status: 'completed',
          activeWakeId: undefined,
          result: result.result.trim().slice(0, 12_000),
          observations: result.observation
            ? this.appendObservation(run, result.observation, now)
            : run.observations,
          plan: this.completeCurrentStep(run.plan, run.currentStep),
          journal,
          updatedAt: now,
          nextAt: 0,
        };
        await this.save(completed);
        await this.redis.zrem(DUE_QUEUE_KEY, id);
        return completed;
      }

      if (result.type === 'blocked') {
        const failed = await this.failTerminal({ ...run, journal }, result.error, now);
        await this.redis.zrem(DUE_QUEUE_KEY, id);
        return failed;
      }

      if (result.type === 'planned') {
        const plan = this.normalizePlan(result.plan);
        if (plan.length === 0) {
          const failed = await this.failTerminal({ ...run, journal }, 'The planner returned no executable steps.', now);
          await this.redis.zrem(DUE_QUEUE_KEY, id);
          return failed;
        }
        const waiting = this.scheduleNext({
          ...run,
          phase: 'executing',
          plan,
          currentStep: 0,
          observations: result.observation
            ? this.appendObservation(run, result.observation, now, 'planning')
            : run.observations,
          journal,
          retryCount: 0,
        }, now, result.delayMs);
        await this.save(waiting);
        await this.redis.zadd(DUE_QUEUE_KEY, waiting.nextAt, id);
        return waiting;
      }

      const completedPlan = this.completeCurrentStep(run.plan, run.currentStep);
      const nextStep = run.currentStep + 1;
      const phase: AgentRunPhase = nextStep >= completedPlan.length ? 'finalizing' : 'executing';
      const waiting = this.scheduleNext({
        ...run,
        phase,
        plan: completedPlan,
        currentStep: nextStep,
        observations: this.appendObservation(run, result.observation, now),
        journal,
        retryCount: 0,
      }, now, result.delayMs);
      await this.save(waiting);
      await this.redis.zadd(DUE_QUEUE_KEY, waiting.nextAt, id);
      return waiting;
    });
  }

  private async failOrRetry(id: string, wakeId: string, error: unknown, now: number): Promise<AgentRun | null> {
    return await this.redis.withLock(`agent-run:${id}`, async () => {
      const run = await this.get(id);
      if (!run || run.status === 'cancelled' || run.activeWakeId !== wakeId) return null;
      const message = error instanceof Error ? error.message : 'Unknown agent job error.';
      const journal = this.completeJournal(run.journal, wakeId, 'failed');
      const retryCount = run.retryCount + 1;
      if (retryCount >= run.maxRetries || run.wakeCount >= run.maxWakes) {
        const failed = await this.failTerminal({ ...run, journal, retryCount }, message, now);
        await this.redis.zrem(DUE_QUEUE_KEY, id);
        return failed;
      }
      const waiting = this.scheduleNext({
        ...run,
        journal,
        retryCount,
        lastError: message.slice(0, 1_000),
      }, now, retryCount * DEFAULT_WAKE_DELAY_MS);
      await this.save(waiting);
      await this.redis.zadd(DUE_QUEUE_KEY, waiting.nextAt, id);
      return waiting;
    });
  }

  private scheduleNext(run: AgentRun, now: number, delayMs = DEFAULT_WAKE_DELAY_MS): AgentRun {
    const boundedDelay = Math.max(60_000, Math.min(30 * 60_000, delayMs));
    return {
      ...run,
      status: 'waiting',
      activeWakeId: undefined,
      updatedAt: now,
      nextAt: now + boundedDelay,
    };
  }

  private async failTerminal(run: AgentRun, error: string, now: number): Promise<AgentRun> {
    const failed: AgentRun = {
      ...run,
      status: 'failed',
      activeWakeId: undefined,
      lastError: error.slice(0, 1_000),
      updatedAt: now,
      nextAt: 0,
    };
    await this.save(failed);
    return failed;
  }

  private normalizePlan(steps: string[]): AgentPlanStep[] {
    return steps
      .map(step => step.trim().replace(/\s+/g, ' ').slice(0, 240))
      .filter(Boolean)
      .slice(0, 5)
      .map((title, index) => ({ id: `step-${index + 1}`, title, status: 'pending' as const }));
  }

  private activateCurrentStep(plan: AgentPlanStep[], currentStep: number): AgentPlanStep[] {
    return plan.map((step, index) => index === currentStep && step.status === 'pending'
      ? { ...step, status: 'active' as const }
      : step);
  }

  private completeCurrentStep(plan: AgentPlanStep[], currentStep: number): AgentPlanStep[] {
    return plan.map((step, index) => index === currentStep
      ? { ...step, status: 'completed' as const }
      : step);
  }

  private appendObservation(run: AgentRun, summary: string, createdAt: number, stepId = this.currentStepId(run)): AgentObservation[] {
    const compact = summary.trim().replace(/\s+/g, ' ').slice(0, 2_000);
    if (!compact) return run.observations;
    return [...run.observations, { stepId, summary: compact, createdAt }].slice(-MAX_OBSERVATIONS);
  }

  private appendJournal(journal: AgentJournalEntry[], entry: AgentJournalEntry): AgentJournalEntry[] {
    return [...journal.filter(item => item.wakeId !== entry.wakeId), entry].slice(-MAX_JOURNAL_ENTRIES);
  }

  private completeJournal(journal: AgentJournalEntry[], wakeId: string, status: 'completed' | 'failed'): AgentJournalEntry[] {
    return journal.map(entry => entry.wakeId === wakeId ? { ...entry, status } : entry).slice(-MAX_JOURNAL_ENTRIES);
  }

  private currentStepId(run: AgentRun): string {
    if (run.phase === 'planning') return 'planning';
    if (run.phase === 'finalizing') return 'finalizing';
    return run.plan[run.currentStep]?.id || `step-${run.currentStep + 1}`;
  }

  private isTerminal(status: AgentRunStatus): boolean {
    return ['completed', 'failed', 'cancelled'].includes(status);
  }

  private async get(id: string): Promise<AgentRun | null> {
    return this.parse(await this.redis.get(this.recordKey(id)));
  }

  private async save(run: AgentRun): Promise<void> {
    await this.redis.set(this.recordKey(run.id), JSON.stringify(run), RECORD_TTL_SECONDS);
  }

  private parse(raw: string | null): AgentRun | null {
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Partial<AgentRun>;
      if (!value || typeof value.id !== 'string' || typeof value.sessionKey !== 'string' || typeof value.goal !== 'string') return null;
      const legacyStepCount = typeof value.stepCount === 'number' ? value.stepCount : 0;
      const legacyMaxSteps = typeof value.maxSteps === 'number' ? value.maxSteps : 12;
      const maxWakes = typeof value.maxWakes === 'number' ? value.maxWakes : Math.max(legacyMaxSteps, 12);
      return {
        id: value.id,
        chatId: Number(value.chatId),
        sessionKey: value.sessionKey,
        goal: value.goal,
        status: value.status || 'queued',
        phase: value.phase || 'planning',
        createdAt: Number(value.createdAt) || Date.now(),
        updatedAt: Number(value.updatedAt) || Date.now(),
        nextAt: Number(value.nextAt) || 0,
        wakeCount: typeof value.wakeCount === 'number' ? value.wakeCount : legacyStepCount,
        maxWakes,
        retryCount: typeof value.retryCount === 'number' ? value.retryCount : 0,
        maxRetries: typeof value.maxRetries === 'number' ? value.maxRetries : 3,
        currentStep: typeof value.currentStep === 'number' ? value.currentStep : 0,
        plan: Array.isArray(value.plan) ? value.plan : [],
        observations: Array.isArray(value.observations) ? value.observations : [],
        journal: Array.isArray(value.journal) ? value.journal : [],
        activeWakeId: value.activeWakeId,
        progressMessageId: value.progressMessageId,
        result: value.result,
        lastError: value.lastError,
        stepCount: legacyStepCount,
        maxSteps: legacyMaxSteps,
      };
    } catch {
      return null;
    }
  }

  private recordKey(id: string): string {
    return `${RECORD_PREFIX}${id}`;
  }

  private sessionIndexKey(sessionKey: string): string {
    return `${SESSION_PREFIX}${sessionKey}`;
  }
}
