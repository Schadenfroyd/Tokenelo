/**
 * src/tray/format.ts — the main-process tray title/tooltip formatters. Every expected value below
 * is hand-computed in the comment next to the assertion.
 */
import { describe, expect, it } from 'vitest';
import { formatCompactNumber, formatDuration, formatMoney, formatTrayLine } from '../../src/tray/format.js';

describe('formatMoney', () => {
  it('formats 184.3 as $184.30 (2 decimals always)', () => {
    expect(formatMoney(184.3)).toBe('$184.30');
  });
  it('formats 0 as $0.00', () => {
    expect(formatMoney(0)).toBe('$0.00');
  });
  it('adds thousands separators: 1234.5 -> $1,234.50', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
  });
  it('formats a negative amount with a leading minus before the dollar sign', () => {
    expect(formatMoney(-2.5)).toBe('-$2.50');
  });
});

describe('formatCompactNumber', () => {
  it('842 -> "842" (below 1000, no suffix)', () => {
    expect(formatCompactNumber(842)).toBe('842');
  });
  it('2143 -> "2.1k" (2143/1000 = 2.143, rounded to 1 decimal = 2.1)', () => {
    expect(formatCompactNumber(2143)).toBe('2.1k');
  });
  it('1000 -> "1k" (trailing .0 dropped)', () => {
    expect(formatCompactNumber(1000)).toBe('1k');
  });
  it('1_950_000 -> "1.9M" (verified: (1950000/1e6).toFixed(1) === "1.9" — 1.95 is not exactly representable in binary floating point and rounds down)', () => {
    expect(formatCompactNumber(1_950_000)).toBe('1.9M');
  });
  it('1_200_000 -> "1.2M"', () => {
    expect(formatCompactNumber(1_200_000)).toBe('1.2M');
  });
  it('0 -> "0"', () => {
    expect(formatCompactNumber(0)).toBe('0');
  });
});


describe('formatTrayLine', () => {
  it('shows the dollar figure alone: nothing else is appended to the title or tooltip', () => {
    expect(formatTrayLine({ apiEquivUsd: 184.2 })).toBe('$184.20');
    expect(formatTrayLine({ apiEquivUsd: 0 })).toBe('$0.00');
  });

  it('the dollar part is qualified when its own events are unpriced (partial) or estimated', () => {
    expect(formatTrayLine({ apiEquivUsd: 10, priceStatus: 'UNPRICED' })).toBe('$10.00 (partial)');
    expect(formatTrayLine({ apiEquivUsd: 10, priceStatus: 'ESTIMATE' })).toBe('$10.00 (estimated)');
    expect(formatTrayLine({ apiEquivUsd: 10, priceStatus: 'LIST' })).toBe('$10.00');
  });

  it('an absent price status adds no qualifier (no claim is made about unknown scope)', () => {
    expect(formatTrayLine({ apiEquivUsd: 10 })).toBe('$10.00');
  });
});

describe('formatDuration', () => {
  it('0ms -> "<1m"', () => {
    expect(formatDuration(0)).toBe('<1m');
  });
  it('59_999ms -> "<1m" (floors to the minute, 59.999s is still 0 whole minutes)', () => {
    expect(formatDuration(59_999)).toBe('<1m');
  });
  it('4 minutes exactly -> "4m"', () => {
    expect(formatDuration(4 * 60_000)).toBe('4m');
  });
  it('1h exactly -> "1h" (no "0m" suffix)', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h');
  });
  it('1h23m -> "1h 23m"', () => {
    expect(formatDuration(83 * 60_000)).toBe('1h 23m');
  });
  it('negative durations clamp to 0 -> "<1m"', () => {
    expect(formatDuration(-500)).toBe('<1m');
  });
});
