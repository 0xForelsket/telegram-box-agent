import { describe, expect, it } from 'vitest';
import { calculateDate, calculateExpression, convertUnits, formatNumber, formatTimeInZone } from './deterministic_tools';

describe('deterministic utility tools', () => {
  it('calculates arithmetic without eval', () => {
    expect(calculateExpression('(2 + 3) * 4 ^ 2')).toBe(80);
    expect(() => calculateExpression('process.exit()')).toThrow('unsupported');
    expect(() => calculateExpression('1 / 0')).toThrow('not finite');
  });

  it('converts compatible units', () => {
    expect(formatNumber(convertUnits('10 km to miles').value)).toBe('6.21371192237');
    expect(convertUnits('32 f to c').value).toBe(0);
    expect(() => convertUnits('1 kg to km')).toThrow('not compatible');
  });

  it('formats a requested timezone', () => {
    expect(formatTimeInZone('Asia/Kuala_Lumpur', new Date('2026-08-12T00:00:00.000Z'))).toContain('2026');
    expect(() => formatTimeInZone('Not/A_Zone')).toThrow('Unknown IANA timezone');
  });

  it('does deterministic date arithmetic', () => {
    expect(calculateDate('2026-08-12 + 5 days')).toBe('2026-08-17');
    expect(calculateDate('2026-08-12 to 2026-08-20')).toBe('8 days');
    expect(() => calculateDate('2026-02-30 + 1 day')).toThrow('Invalid calendar date');
  });
});
