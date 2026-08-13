import { RedisClient } from '../utils/redis';

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
  payload: Record<string, string>;
}

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
        const nextAt = this.getNextOccurrence(job, now);
        if (nextAt) await this.schedule({ ...job, nextAt, attempts: 0 });
      } catch (error) {
        console.error(`Scheduled job ${job.id} failed:`, error);
        const attempts = (job.attempts || 0) + 1;
        if (attempts <= 3) {
          await this.schedule({ ...job, attempts, nextAt: now + attempts * 5 * 60_000 });
        }
      }
    }
    return processed;
  }

  private getNextOccurrence(job: ScheduledJob, now: number): number | null {
    const interval = job.recurrence === 'daily'
      ? 24 * 60 * 60_000
      : job.recurrence === 'weekly'
        ? 7 * 24 * 60 * 60_000
        : 0;
    if (!interval) return null;
    let nextAt = job.nextAt + interval;
    while (nextAt <= now) nextAt += interval;
    return nextAt;
  }
}

export function parseReminderInput(input: string, now = new Date()): { dueAt: number; text: string; recurrence?: 'daily' | 'weekly' } {
  const trimmed = input.trim();
  const daily = trimmed.match(/^daily\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (daily) {
    const localDate = new Date(now.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
    let dueAt = parseMalaysiaDateTime(localDate, daily[1], daily[2]);
    if (dueAt <= now.getTime()) dueAt += 24 * 60 * 60_000;
    return { dueAt, text: daily[3].trim(), recurrence: 'daily' };
  }
  const weekly = trimmed.match(/^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (weekly) {
    const targetDay = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekly[1].toLowerCase());
    const localNow = new Date(now.getTime() + 8 * 60 * 60_000);
    let daysAhead = (targetDay - localNow.getUTCDay() + 7) % 7;
    const targetDate = new Date(localNow);
    targetDate.setUTCDate(targetDate.getUTCDate() + daysAhead);
    let dueAt = parseMalaysiaDateTime(targetDate.toISOString().slice(0, 10), weekly[2], weekly[3]);
    if (dueAt <= now.getTime()) {
      daysAhead += 7;
      targetDate.setUTCDate(targetDate.getUTCDate() + 7);
      dueAt = parseMalaysiaDateTime(targetDate.toISOString().slice(0, 10), weekly[2], weekly[3]);
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
    const local = new Date(now.getTime() + 8 * 60 * 60_000);
    local.setUTCDate(local.getUTCDate() + 1);
    const date = local.toISOString().slice(0, 10);
    return { dueAt: parseMalaysiaDateTime(date, tomorrow[1], tomorrow[2]), text: tomorrow[3].trim() };
  }
  const absolute = trimmed.match(/^(?:at\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s+(.+)$/i);
  if (absolute) {
    return { dueAt: parseMalaysiaDateTime(absolute[1], absolute[2], absolute[3]), text: absolute[4].trim() };
  }
  throw new Error('Use: /remind in 20m text, /remind tomorrow 09:00 text, /remind daily 09:00 text, or /remind weekly mon 09:00 text.');
}

export function createJobId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}

export function parseDigestInput(input: string, now = new Date()): {
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
  const parsed = parseReminderInput(`${match[1]} __digest__`, now);
  if (!parsed.recurrence) throw new Error('Digest must be daily or weekly.');
  return { dueAt: parsed.dueAt, recurrence: parsed.recurrence, mode, query };
}

function parseMalaysiaDateTime(date: string, hour: string, minute: string): number {
  const hours = Number(hour);
  const minutes = Number(minute);
  if (hours > 23 || minutes > 59) throw new Error('Invalid reminder time.');
  const parsed = new Date(`${date}T${hour.padStart(2, '0')}:${minute}:00+08:00`).getTime();
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
