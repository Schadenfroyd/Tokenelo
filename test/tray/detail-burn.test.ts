import { describe, it, expect } from 'vitest';
import { burnLine, burnMoneyText, validBurnQuality } from '../../src/tray/renderer/detail-burn.ts';

// Hand-written expectations for the R44 recent-burn line. Rates are chosen so formatMoney/formatCompactNumber output is obvious:
// 30 tok/min -> "30", 3.6 $/h -> "$3.60".
const HEAD = 'Burn (last 15m): 30 tok/min · API-equiv';
const q = (events: number, unpricedEvents: number, estimatedPriceEvents: number, priceStatus: unknown) => ({ events, unpricedEvents, estimatedPriceEvents, priceStatus });

describe('burnLine', () => {
  it('no burn (no window events) renders no line', () => {
    expect(burnLine(null)).toBeNull();
    expect(burnLine(undefined)).toBeNull();
  });

  it('all LIST: the recorded rate with no qualifier', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 3.6, priceQuality: q(2, 0, 0, 'LIST') })).toBe(`${HEAD} $3.60/h`);
  });

  it('known provider zero (local LIST at $0) stays an explicit priced zero', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 0, priceQuality: q(1, 0, 0, 'LIST') })).toBe(`${HEAD} $0.00/h`);
  });

  it('all unpriced: no money figure, the window unpriced count, tokens kept', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 0, priceQuality: q(2, 2, 0, 'UNPRICED') })).toBe(`${HEAD} —/h · 2 unpriced events`);
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 0, priceQuality: q(1, 1, 0, 'UNPRICED') })).toBe(`${HEAD} —/h · 1 unpriced event`);
  });

  it('mixed: recorded sum of priced events, partial with missing and estimated counts', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 3.6, priceQuality: q(3, 1, 1, 'UNPRICED') }))
      .toBe(`${HEAD} $3.60/h · Partial · 1 unpriced event · 1 event uses estimated prices`);
  });

  it('estimated only: counts included estimated events', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 3.6, priceQuality: q(4, 0, 2, 'ESTIMATE') })).toBe(`${HEAD} $3.60/h · 2 events use estimated prices`);
  });

  it('legacy response without priceQuality: rate kept, coverage unknown (never LIST or zero)', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 3.6 })).toBe(`${HEAD} $3.60/h · Price coverage unknown`);
  });

  it('malformed or contradictory blocks: no money claim, coverage unavailable, tokens kept', () => {
    const bad: unknown[] = [
      null, 'LIST', 5, {},
      q(-1, 0, 0, 'LIST'), q(2, 0.5, 0, 'UNPRICED'), q(Infinity, 0, 0, 'LIST'), q(NaN, 0, 0, 'LIST'), q(2 ** 53, 0, 0, 'LIST'), q('2', 0, 0, 'LIST'),
      q(2, 2, 1, 'UNPRICED'), // counts exceed events
      q(2, 1, 0, 'LIST'), // status contradicts counts
      q(2, 0, 0, 'ESTIMATE'),
      q(2, 0, 0, 'BILLED'), // unknown label
      q(2, 0, 0, null), // null status with events
      q(2, 0, 0, undefined), // valid counts, missing status
      q(0, 0, 0, null), // a burn window always has at least one event
    ];
    for (const priceQuality of bad) {
      expect(burnLine({ tokensPerMin: 30, usdPerHour: 3.6, priceQuality })).toBe(`${HEAD} —/h · Price coverage unavailable`);
    }
  });

  it('valid LIST with a non-finite rate is unavailable, not a number', () => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: NaN, priceQuality: q(1, 0, 0, 'LIST') })).toBe(`${HEAD} —/h · Price coverage unavailable`);
  });
});

describe('validBurnQuality', () => {
  it('returns the canonical block for consistent counts', () => {
    expect(validBurnQuality(q(3, 1, 1, 'UNPRICED'))).toEqual(q(3, 1, 1, 'UNPRICED'));
    expect(validBurnQuality(q(1, 0, 0, 'LIST'))).toEqual(q(1, 0, 0, 'LIST'));
  });

  it('rejects a block missing a count', () => {
    expect(validBurnQuality({ events: 1, unpricedEvents: 0, priceStatus: 'LIST' })).toBeNull();
  });
});

describe('independent trailing-window count and price coverage', () => {
  it.each(['incomplete', 'invalid', 'conflict'] as const)('%s full counts withhold throughput while retaining priced money', countQuality => {
    expect(burnLine({ tokensPerMin: 30, usdPerHour: 3.6, countQuality, priceQuality: q(2, 0, 0, 'LIST') }))
      .toBe(`Burn (last 15m): token rate unavailable · ${countQuality} count evidence · API-equiv $3.60/h`);
  });
  it('Sessions money uses its own recent coverage: missing prices never become a measured zero', () => {
    expect(burnMoneyText({ tokensPerMin: 30, usdPerHour: 0, priceQuality: q(1, 1, 0, 'UNPRICED') })).toBe('—/h · 1 unpriced event');
    expect(burnMoneyText({ tokensPerMin: 30, usdPerHour: 0, priceQuality: q(1, 0, 0, 'LIST') })).toBe('$0.00/h');
    expect(burnMoneyText({ tokensPerMin: 30, usdPerHour: 3.6, priceQuality: q(3, 1, 1, 'UNPRICED') }))
      .toBe('$3.60/h · Partial · 1 unpriced event · 1 event uses estimated prices');
  });
});
