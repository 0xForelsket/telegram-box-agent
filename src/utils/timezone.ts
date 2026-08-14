/**
 * IANA-timezone arithmetic for scheduling.
 *
 * The previous code added a fixed `8 * 60 * 60_000` and formatted with a
 * hardcoded `Asia/Kuala_Lumpur`. That is wrong for every other deployment, and
 * a fixed offset is wrong even for the right region once daylight saving
 * applies. Everything here resolves the zone's *actual* offset at the instant
 * in question, so a zone that shifts mid-year stays correct across the shift.
 */

/** The zone's UTC offset, in milliseconds, at a given instant. */
export function offsetMsAt(timezone: string, instant: number): number {
  const date = new Date(instant);
  // `en-CA` gives ISO-ordered parts, so the reconstructed timestamp is
  // unambiguous regardless of the host's locale.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find(part => part.type === type)?.value ?? '0');

  // `hour: '2-digit'` with hour12:false renders midnight as 24 in some ICU
  // versions; normalise it back to 0 so the reconstruction does not jump a day.
  const hour = field('hour') % 24;
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** `YYYY-MM-DD` for the given instant as seen in `timezone`. */
export function localDayKey(timezone: string, instant: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

/**
 * The UTC timestamp for a local wall-clock time in `timezone`.
 *
 * Resolved twice: the offset depends on the instant, and the instant depends on
 * the offset. The first pass uses the offset at the naive guess, the second
 * re-resolves at the corrected instant so a time that lands on a DST boundary
 * settles on the offset actually in force there.
 */
export function zonedTimeToUtc(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = naive - offsetMsAt(timezone, naive);
  instant = naive - offsetMsAt(timezone, instant);
  return instant;
}

/** Local calendar fields for an instant, as seen in `timezone`. */
export function localParts(
  timezone: string,
  instant: number,
): { year: number; month: number; day: number; weekday: number } {
  const key = localDayKey(timezone, instant);
  const [year, month, day] = key.split('-').map(Number);
  // Reconstructing at UTC midnight makes getUTCDay the local weekday.
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return { year, month, day, weekday };
}

/** Seconds from `instant` until the next local midnight in `timezone`. */
export function secondsUntilLocalMidnight(timezone: string, instant: number): number {
  const { year, month, day } = localParts(timezone, instant);
  const nextMidnight = zonedTimeToUtc(timezone, year, month, day + 1, 0, 0);
  return Math.max(60, Math.ceil((nextMidnight - instant) / 1000));
}

/** Human-readable local time, used in reminder and schedule confirmations. */
export function formatInTimezone(timezone: string, instant: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(instant));
}
