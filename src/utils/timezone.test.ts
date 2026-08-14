import { describe, expect, it } from 'vitest';
import {
  formatInTimezone,
  localDayKey,
  localParts,
  offsetMsAt,
  secondsUntilLocalMidnight,
  zonedTimeToUtc,
} from './timezone';

const HOUR = 60 * 60_000;

describe('offsetMsAt', () => {
  it('reports a fixed-offset zone', () => {
    expect(offsetMsAt('Asia/Kuala_Lumpur', Date.UTC(2026, 0, 15, 12))).toBe(8 * HOUR);
    expect(offsetMsAt('UTC', Date.UTC(2026, 0, 15, 12))).toBe(0);
  });

  // A hardcoded numeric offset cannot express this; the zone moves twice a year.
  it('tracks a daylight-saving shift within one zone', () => {
    const winter = offsetMsAt('America/New_York', Date.UTC(2026, 0, 15, 12));
    const summer = offsetMsAt('America/New_York', Date.UTC(2026, 6, 15, 12));

    expect(winter).toBe(-5 * HOUR);
    expect(summer).toBe(-4 * HOUR);
  });

  it('handles a zone ahead of the date line', () => {
    expect(offsetMsAt('Pacific/Auckland', Date.UTC(2026, 0, 15, 12))).toBe(13 * HOUR);
  });
});

describe('zonedTimeToUtc', () => {
  it('resolves a wall-clock time to the right instant', () => {
    expect(zonedTimeToUtc('Asia/Kuala_Lumpur', 2026, 8, 14, 9, 0))
      .toBe(Date.UTC(2026, 7, 14, 1, 0));
  });

  it('resolves the same wall-clock time differently across a DST boundary', () => {
    const winter = zonedTimeToUtc('America/New_York', 2026, 1, 15, 9, 0);
    const summer = zonedTimeToUtc('America/New_York', 2026, 7, 15, 9, 0);

    expect(new Date(winter).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(new Date(summer).toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });

  it('round-trips through localParts', () => {
    const instant = zonedTimeToUtc('Europe/Berlin', 2026, 3, 29, 14, 30);
    const parts = localParts('Europe/Berlin', instant);

    expect(parts).toMatchObject({ year: 2026, month: 3, day: 29 });
  });

  it('normalises a day overflow into the next month', () => {
    expect(zonedTimeToUtc('UTC', 2026, 1, 32, 0, 0)).toBe(Date.UTC(2026, 1, 1));
  });
});

describe('localDayKey', () => {
  it('rolls the day at local midnight, not UTC midnight', () => {
    // 17:00 UTC is already the next day in Auckland.
    const instant = Date.UTC(2026, 7, 14, 17, 0);

    expect(localDayKey('UTC', instant)).toBe('2026-08-14');
    expect(localDayKey('Pacific/Auckland', instant)).toBe('2026-08-15');
  });
});

describe('secondsUntilLocalMidnight', () => {
  it('counts to the next local midnight', () => {
    const instant = zonedTimeToUtc('Asia/Kuala_Lumpur', 2026, 8, 14, 22, 0);

    expect(secondsUntilLocalMidnight('Asia/Kuala_Lumpur', instant)).toBe(2 * 60 * 60);
  });

  it('never returns a TTL small enough to expire a counter instantly', () => {
    const justBeforeMidnight = zonedTimeToUtc('UTC', 2026, 8, 14, 23, 59) + 59_000;

    expect(secondsUntilLocalMidnight('UTC', justBeforeMidnight)).toBeGreaterThanOrEqual(60);
  });

  it('stays correct on the day a zone changes offset', () => {
    // 2026-03-08 is the US spring-forward date; that local day is 23 hours long.
    const instant = zonedTimeToUtc('America/New_York', 2026, 3, 8, 0, 30);
    const seconds = secondsUntilLocalMidnight('America/New_York', instant);

    expect(seconds).toBe(22 * 60 * 60 + 30 * 60);
  });
});

describe('formatInTimezone', () => {
  it('renders the local wall clock, not UTC', () => {
    const instant = Date.UTC(2026, 7, 14, 1, 0);

    expect(formatInTimezone('Asia/Kuala_Lumpur', instant)).toContain('09:00');
    expect(formatInTimezone('UTC', instant)).toContain('01:00');
  });
});
