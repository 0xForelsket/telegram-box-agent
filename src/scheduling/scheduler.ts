import { RedisClient } from '../utils/redis';
import { localParts, zonedTimeToUtc } from '../utils/timezone';

const QUEUE_KEY = 'schedule:v1:due';
// Each job can use several Redis and upstream subrequests. Keep a cron batch
// deliberately small so even the most expensive digest stays inside the
// Cloudflare Free request budget; the five-minute trigger drains any backlog.
const MAX_DUE_PER_RUN = 3;

export type ScheduledJobType = 'reminder' | 'digest';

export interface ScheduledJob {
  id: string;
  type: ScheduledJobType;
  chatId: number;
  sessionKey: string;
  nextAt: number;
  createdAt: number;
  recurrence?: 'daily' | 'weekly';
  attempts?: number;
  /**
   * The slot this occurrence was *supposed* to run at, preserved across
   * retries. Without it, a retry rewrites `nextAt`, and the recurrence is then
   * computed from the retry time — so one transient failure permanently shifts
   * a 09:00 daily reminder to 09:05.
   */
  slotAt?: number;
  payload: Record<string, string>;
}

/**
 * Retries for one occurrence before giving up on that occurrence. A recurring
 * job is never deleted for exhausting them; only the failed run is abandoned.
 */
const MAX_ATTEMPTS = 3;

export class SharedScheduler {
  constructor(private readonly redis: RedisClient) {}

  async schedule(job: ScheduledJob): Promise<void> {
    if (!Number.isFinite(job.nextAt) || job.nextAt <= 0) throw new Error('Invalid scheduled time.');
    await this.redis.zadd(QUEUE_KEY, job.nextAt, JSON.stringify(job));
  }

  async list(sessionKey: string): Promise<ScheduledJob[]> {
    const members = await this.redis.zrangeAll(QUEUE_KEY);
    return members
      .map(parseJob)
      .filter((job): job is ScheduledJob => !!job && job.sessionKey === sessionKey)
      .sort((left, right) => left.nextAt - right.nextAt);
  }

  async cancel(sessionKey: string, id: string, type?: ScheduledJobType): Promise<ScheduledJob | null> {
    const members = await this.redis.zrangeAll(QUEUE_KEY);
    const normalizedId = id.trim().toLowerCase();
    for (const member of members) {
      const job = parseJob(member);
      if (!job || job.sessionKey !== sessionKey || job.id.toLowerCase() !== normalizedId || (type && job.type !== type)) continue;
      return await this.redis.zrem(QUEUE_KEY, member) ? job : null;
    }
    return null;
  }

  async drainDue(handler: (job: ScheduledJob) => Promise<void>, now = Date.now()): Promise<number> {
    const members = await this.redis.zrangeByScore(QUEUE_KEY, 0, now, MAX_DUE_PER_RUN);
    let processed = 0;
    for (const member of members) {
      if (!(await this.redis.zrem(QUEUE_KEY, member))) continue;
      const job = parseJob(member);
      if (!job) continue;
      try {
        await handler(job);
        processed += 1;
        await this.scheduleNextOccurrence(job, now);
      } catch (error) {
        console.error(`Scheduled job ${job.id} failed:`, error);
        const attempts = (job.attempts || 0) + 1;
        if (attempts <= MAX_ATTEMPTS) {
          await this.schedule({
            ...job,
            attempts,
            // Anchor the recurrence to the slot this run belongs to, so the
            // retry time never becomes the new recurrence base.
            slotAt: job.slotAt ?? job.nextAt,
            nextAt: now + attempts * 5 * 60_000,
          });
          continue;
        }
        // The occurrence is abandoned, but a recurring job survives it. Losing
        // a standing reminder to a few minutes of upstream trouble is a far
        // worse failure than skipping one delivery.
        console.error(`Scheduled job ${job.id} exhausted ${MAX_ATTEMPTS} attempts; skipping this occurrence.`);
        await this.scheduleNextOccurrence(job, now);
      }
    }
    return processed;
  }

  private async scheduleNextOccurrence(job: ScheduledJob, now: number): Promise<void> {
    const nextAt = this.getNextOccurrence(job, now);
    if (nextAt === null) return;
    await this.schedule({ ...job, nextAt, attempts: 0, slotAt: undefined });
  }

  private getNextOccurrence(job: ScheduledJob, now: number): number | null {
    const interval = job.recurrence === 'daily'
      ? 24 * 60 * 60_000
      : job.recurrence === 'weekly'
        ? 7 * 24 * 60 * 60_000
        : 0;
    if (!interval) return null;
    // `slotAt` is the scheduled slot; `nextAt` may be a retry time.
    let nextAt = (job.slotAt ?? job.nextAt) + interval;
    while (nextAt <= now) nextAt += interval;
    return nextAt;
  }
}

/**
 * Wall-clock times are interpreted in `timezone`, which defaults to UTC rather
 * than the operator's zone. A deployment that wants local times sets
 * `DEFAULT_TIMEZONE`; silently assuming one region's offset is how `09:00`
 * used to mean 09:00 in Malaysia for everybody.
 */
export function parseReminderInput(
  input: string,
  now = new Date(),
  timezone = 'UTC',
): { dueAt: number; text: string; recurrence?: 'daily' | 'weekly' } {
  const trimmed = input.trim();
  const at = (year: number, month: number, day: number, hour: string, minute: string): number =>
    zonedWallClock(timezone, year, month, day, hour, minute);

  const daily = trimmed.match(/^daily\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (daily) {
    const today = localParts(timezone, now.getTime());
    let dueAt = at(today.year, today.month, today.day, daily[1], daily[2]);
    if (dueAt <= now.getTime()) dueAt = at(today.year, today.month, today.day + 1, daily[1], daily[2]);
    return { dueAt, text: daily[3].trim(), recurrence: 'daily' };
  }

  const weekly = trimmed.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (weekly) {
    const targetDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekly[1].toLowerCase());
    const today = localParts(timezone, now.getTime());
    const daysAhead = (targetDay - today.weekday + 7) % 7;
    let dueAt = at(today.year, today.month, today.day + daysAhead, weekly[2], weekly[3]);
    if (dueAt <= now.getTime()) {
      dueAt = at(today.year, today.month, today.day + daysAhead + 7, weekly[2], weekly[3]);
    }
    return { dueAt, text: weekly[4].trim(), recurrence: 'weekly' };
  }

  const relative = trimmed.match(/^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)\s+(.+)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multiplier = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 60 * 60_000 : unit.startsWith('d') ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
    return { dueAt: now.getTime() + amount * multiplier, text: relative[3].trim() };
  }

  const tomorrow = trimmed.match(/^tomorrow\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (tomorrow) {
    const today = localParts(timezone, now.getTime());
    return {
      dueAt: at(today.year, today.month, today.day + 1, tomorrow[1], tomorrow[2]),
      text: tomorrow[3].trim(),
    };
  }

  const absolute = trimmed.match(/^(?:at\s+)?(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (absolute) {
    return {
      dueAt: at(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]), absolute[4], absolute[5]),
      text: absolute[6].trim(),
    };
  }

  throw new Error('Use: /remind in 20m text, /remind tomorrow 09:00 text, /remind daily 09:00 text, or /remind weekly mon 09:00 text.');
}

export function createJobId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export function parseDigestInput(input: string, now = new Date(), timezone = 'UTC'): {
  dueAt: number;
  recurrence: 'daily' | 'weekly';
  mode: 'feeds' | 'search' | 'stock';
  query?: string;
} {
  const match = input.trim().match(/^(daily\s+\d{1,2}:\d{2}|weekly\s+(?:sun|mon|tue|wed|thu|fri|sat)\s+\d{1,2}:\d{2})\s+(feeds|search|stock)(?:\s+(.+))?$/i);
  if (!match) throw new Error('Use: /digest daily 08:00 feeds, /digest daily 08:00 search <topic>, or /digest weekly mon 08:00 stock <symbol>.');
  const mode = match[2].toLowerCase() as 'feeds' | 'search' | 'stock';
  const query = match[3]?.trim();
  if (mode !== 'feeds' && !query) throw new Error(`${mode} digests require a query or symbol.`);
  const parsed = parseReminderInput(`${match[1]} __digest__`, now, timezone);
  if (!parsed.recurrence) throw new Error('Digest must be daily or weekly.');
  return { dueAt: parsed.dueAt, recurrence: parsed.recurrence, mode, query };
}

function zonedWallClock(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: string,
  minute: string,
): number {
  const hours = Number(hour);
  const minutes = Number(minute);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours > 23 || minutes > 59) {
    throw new Error('Invalid reminder time.');
  }
  const parsed = zonedTimeToUtc(timezone, year, month, day, hours, minutes);
  if (!Number.isFinite(parsed)) throw new Error('Invalid reminder date.');
  return parsed;
}

function parseJob(raw: string): ScheduledJob | null {
  try {
    const job = JSON.parse(raw) as ScheduledJob;
    return job && typeof job.id === 'string' && typeof job.nextAt === 'number' && typeof job.sessionKey === 'string' ? job : null;
  } catch {
    return null;
  }
}
