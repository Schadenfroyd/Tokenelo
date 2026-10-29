/**
 * Regression tests for src/core/token-counts.ts behaviour that a mutation run showed to be unasserted:
 * the token subtotals (including the subset count basis), the strict and fractional validators, and the fold
 * (`addTokenCounts`) that accumulates quantities, count quality and per-field coverage across rows.
 * Distinct powers of ten make every addend individually visible in a sum.
 */
import { describe, it, expect } from 'vitest';
import {
  addTokenCounts, completeTokenTotal, hasInvalidTokenQuantities, hasInvalidTokenValues, hasUnresolvedCounts,
  isCountQuality, normalizeCountQuality, tokenSubtotal, ucuCountQuality, ucuTokenSubtotal, weakestCountQuality,
} from '../../src/core/token-counts.js';
import { normalizedTokenFields, validTokenFieldCoverage } from '../../src/core/token-field-evidence.js';
import type { TokenCounts } from '../../src/core/types.js';

const tc = (o: Partial<TokenCounts> = {}): TokenCounts =>
  ({ inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, ...o });
const withEvidence = (t: TokenCounts): TokenCounts => ({ ...t, fieldEvidence: normalizedTokenFields(t) });

describe('token subtotals', () => {
  const t = tc({ inputFresh: 1, cacheWrite5m: 10, cacheWrite1h: 100, cacheWriteUnassigned: 1000, cacheRead: 10000, output: 100000, reasoning: 1000000 });
  it('tokenSubtotal sums every billable category and excludes reasoning (a subset of output)', () => {
    expect(tokenSubtotal(t)).toBe(111111);
  });
  it('ucuTokenSubtotal is fresh input + cache creation + output: it excludes cache reads and reasoning', () => {
    expect(ucuTokenSubtotal(t)).toBe(101111);
  });
  it('an absent unassigned-TTL field counts as zero, not one', () => {
    const u = tc({ inputFresh: 1, cacheWrite5m: 10, cacheWrite1h: 100, cacheRead: 10000, output: 100000 });
    expect(tokenSubtotal(u)).toBe(110111);
    expect(ucuTokenSubtotal(u)).toBe(100111);
  });
  it('completeTokenTotal is null for unresolved counts and the subtotal otherwise', () => {
    expect(completeTokenTotal(tc({ inputFresh: 5, countQuality: 'complete' }))).toBe(5);
    expect(completeTokenTotal(tc({ inputFresh: 5 }))).toBe(5);
    for (const q of ['incomplete', 'invalid', 'conflict'] as const) expect(completeTokenTotal(tc({ inputFresh: 5, countQuality: q }))).toBeNull();
  });
});

describe('count validators', () => {
  const keys = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const;
  const optional = ['cacheWriteUnassigned', 'cacheWriteAssumed1h'] as const;
  it('accept zero and the largest safe integer in every category', () => {
    for (const k of keys) for (const v of [0, Number.MAX_SAFE_INTEGER]) {
      expect(hasInvalidTokenValues(tc({ [k]: v }))).toBe(false);
      expect(hasInvalidTokenQuantities(tc({ [k]: v }))).toBe(false);
    }
  });
  it('reject a bad value in any required category, independently of the optional ones', () => {
    for (const k of keys) for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5' as never]) {
      expect(hasInvalidTokenValues(tc({ [k]: v }))).toBe(true);
      expect(hasInvalidTokenQuantities(tc({ [k]: v }))).toBe(true);
    }
  });
  it('reject a bad value in an optional category only when it is present', () => {
    for (const k of optional) {
      expect(hasInvalidTokenValues(tc({ [k]: undefined }))).toBe(false);
      expect(hasInvalidTokenQuantities(tc({ [k]: undefined }))).toBe(false);
      expect(hasInvalidTokenValues(tc({ [k]: 0 }))).toBe(false);
      for (const v of [-1, Number.NaN]) {
        expect(hasInvalidTokenValues(tc({ [k]: v }))).toBe(true);
        expect(hasInvalidTokenQuantities(tc({ [k]: v }))).toBe(true);
      }
    }
  });
  it('measured counters must be integers, attributed quantities may be fractional', () => {
    for (const k of [...keys, ...optional]) {
      expect(hasInvalidTokenValues(tc({ [k]: 1.5 }))).toBe(true);
      expect(hasInvalidTokenQuantities(tc({ [k]: 1.5 }))).toBe(false);
    }
  });
});

describe('weakestCountQuality', () => {
  it('orders complete < unrecorded < incomplete < invalid < conflict, treating absent as unrecorded', () => {
    expect(weakestCountQuality(undefined, undefined)).toBe('unrecorded');
    expect(weakestCountQuality('complete', undefined)).toBe('unrecorded');
    expect(weakestCountQuality('complete', 'complete')).toBe('complete');
    expect(weakestCountQuality('unrecorded', 'incomplete')).toBe('incomplete');
    expect(weakestCountQuality('incomplete', 'invalid')).toBe('invalid');
    expect(weakestCountQuality('conflict', 'invalid')).toBe('conflict');
    expect(weakestCountQuality('invalid', 'conflict')).toBe('conflict');
  });
  it('fails closed for unknown runtime labels instead of ranking them as complete', () => {
    const unknown = 'future-quality-label' as never;
    expect(isCountQuality(unknown)).toBe(false);
    expect(normalizeCountQuality(unknown)).toBe('invalid');
    expect(weakestCountQuality(unknown, 'complete')).toBe('invalid');
    const tokens = tc({ inputFresh: 5, countQuality: unknown, ucuCountQuality: unknown });
    expect(hasInvalidTokenValues(tokens)).toBe(true);
    expect(hasUnresolvedCounts(tokens)).toBe(true);
    expect(ucuCountQuality(tokens)).toBe('invalid');
    expect(completeTokenTotal(tokens)).toBeNull();
    const folded = tc();
    addTokenCounts(folded, tc({ inputFresh: 1, countQuality: unknown, ucuCountQuality: unknown }));
    expect(folded.countQuality).toBe('invalid');
    expect(ucuCountQuality(folded)).toBe('invalid');
  });
});

describe('addTokenCounts: quantities and optional fields', () => {
  it('adds every category', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 1, cacheWrite5m: 10, cacheWrite1h: 100, cacheRead: 1000, output: 10000, reasoning: 100000 }));
    addTokenCounts(t, tc({ inputFresh: 2, cacheWrite5m: 20, cacheWrite1h: 200, cacheRead: 2000, output: 20000, reasoning: 200000 }));
    expect(t).toMatchObject({ inputFresh: 3, cacheWrite5m: 30, cacheWrite1h: 300, cacheRead: 3000, output: 30000, reasoning: 300000 });
  });
  it('optional categories appear only once either side has them, and then sum', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 1 }));
    expect(t.cacheWriteUnassigned).toBeUndefined();
    expect(t.cacheWriteAssumed1h).toBeUndefined();
    expect(t.countQuality).toBeUndefined();
    addTokenCounts(t, tc({ cacheWriteUnassigned: 4, cacheWriteAssumed1h: 2 }));
    addTokenCounts(t, tc({ cacheWriteUnassigned: 5 }));
    addTokenCounts(t, tc());
    expect(t.cacheWriteUnassigned).toBe(9);
    expect(t.cacheWriteAssumed1h).toBe(2);
  });
  it('does not turn a non-finite optional cache counter into zero or keep complete quality', () => {
    const cases: Array<[TokenCounts, TokenCounts]> = [
      [tc({ cacheWriteUnassigned: Number.NaN, countQuality: 'complete' }), tc({ inputFresh: 1, countQuality: 'complete' })],
      [tc({ countQuality: 'complete' }), tc({ cacheWriteUnassigned: Number.NaN, countQuality: 'complete' })],
    ];
    for (const [target, value] of cases) {
      addTokenCounts(target, value);
      expect(target.cacheWriteUnassigned).toBeNaN();
      expect(hasInvalidTokenValues(target)).toBe(true);
      expect(target.countQuality).toBe('invalid');
      expect(target.ucuCountQuality ?? target.countQuality).toBe('invalid');
    }
  });
});

describe('addTokenCounts: count quality', () => {
  it('a complete fold stays complete; an incomplete row weakens it', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 1, countQuality: 'complete' }));
    addTokenCounts(t, tc({ inputFresh: 1, countQuality: 'complete' }));
    expect(t.countQuality).toBe('complete');
    addTokenCounts(t, tc({ inputFresh: 1, countQuality: 'incomplete' }));
    expect(t.countQuality).toBe('incomplete');
    addTokenCounts(t, tc({ inputFresh: 1, countQuality: 'complete' }));
    expect(t.countQuality).toBe('incomplete');
  });
  it('a total beyond the safe-integer range cannot stay complete', () => {
    const big = Number.MAX_SAFE_INTEGER - 5;
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: big, countQuality: 'complete' }));
    expect(t.countQuality).toBe('complete');
    addTokenCounts(t, tc({ inputFresh: big, countQuality: 'complete' }));
    expect(t.countQuality).toBe('invalid');
    expect(t.ucuCountQuality).toBeUndefined(); // the subset basis is invalid too, so no separate override is kept
  });
  it('a subset-basis override survives later rows and is dropped once it equals the overall quality', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 1, countQuality: 'complete', ucuCountQuality: 'incomplete' }));
    expect(t).toMatchObject({ countQuality: 'complete', ucuCountQuality: 'incomplete' });
    addTokenCounts(t, tc({ inputFresh: 1, countQuality: 'complete' }));
    expect(t).toMatchObject({ countQuality: 'complete', ucuCountQuality: 'incomplete' });
    const same = tc();
    addTokenCounts(same, tc({ inputFresh: 1, countQuality: 'incomplete', ucuCountQuality: 'incomplete' }));
    expect(same.countQuality).toBe('incomplete');
    expect(same.ucuCountQuality).toBeUndefined();
  });
  it('drops a prior subset override once later overall quality reaches the same basis', () => {
    const target = tc({ inputFresh: 1, countQuality: 'complete', ucuCountQuality: 'incomplete' });
    addTokenCounts(target, tc({ output: 1, countQuality: 'incomplete' }));
    expect(target.countQuality).toBe('incomplete');
    expect(target.ucuCountQuality).toBeUndefined();
  });
});

describe('addTokenCounts: per-field coverage', () => {
  it('accumulates known value, parts and unrecorded parts across plain and evidenced rows', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 5, output: 2, countQuality: 'complete' }));
    addTokenCounts(t, tc({ inputFresh: 7, cacheRead: 3, countQuality: 'complete' }));
    addTokenCounts(t, withEvidence(tc({ inputFresh: 11, countQuality: 'complete' })));
    const f = t.fieldEvidence!;
    expect(f.inputFresh).toMatchObject({ knownValue: 23, knownParts: 3, normalizedParts: 3, unrecordedParts: 3 });
    expect(f.cacheRead).toMatchObject({ knownValue: 3, knownParts: 3, normalizedParts: 3 });
    expect(f.output).toMatchObject({ knownValue: 2, knownParts: 3 });
    expect(validTokenFieldCoverage(t)).toBe(true);
  });
  it('a recorded zero is a known part, and an absent unassigned-TTL field is a known zero, never a one', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 4, countQuality: 'complete' }));
    addTokenCounts(t, withEvidence(tc({ inputFresh: 4, countQuality: 'complete' })));
    expect(t.fieldEvidence!.cacheRead).toMatchObject({ knownValue: 0, knownParts: 2 });
    expect(t.fieldEvidence!.cacheWriteUnassigned).toMatchObject({ knownValue: 0, knownParts: 2 });
  });
  it('counts a non-empty starting target as one prior part', () => {
    const t = tc({ inputFresh: 3, countQuality: 'complete' });
    addTokenCounts(t, tc({ inputFresh: 4, countQuality: 'complete' }));
    addTokenCounts(t, withEvidence(tc({ inputFresh: 6, countQuality: 'complete' })));
    expect(t.fieldEvidence!.inputFresh).toMatchObject({ knownValue: 13, knownParts: 3, normalizedParts: 3 });
  });
  it('a row that is not complete adds its quantity to the total but not to the known coverage', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 5, countQuality: 'incomplete' }));
    addTokenCounts(t, withEvidence(tc({ inputFresh: 1, countQuality: 'complete' })));
    expect(t.inputFresh).toBe(6);
    expect(t.fieldEvidence!.inputFresh).toMatchObject({ knownValue: 1, knownParts: 1, unrecordedParts: 2 });
    expect(validTokenFieldCoverage(t)).toBe(true);
  });
});

describe('addTokenCounts: coverage carried through accumulators', () => {
  it('a complete row stays known when an incomplete row is folded in before evidence arrives', () => {
    const t = tc();
    addTokenCounts(t, tc({ inputFresh: 5, countQuality: 'complete' }));
    addTokenCounts(t, tc({ inputFresh: 3, countQuality: 'incomplete' }));
    addTokenCounts(t, withEvidence(tc({ inputFresh: 1, countQuality: 'complete' })));
    expect(t.inputFresh).toBe(9);
    expect(t.countQuality).toBe('incomplete');
    expect(t.fieldEvidence!.inputFresh).toMatchObject({ knownValue: 6, knownParts: 2, unrecordedParts: 3 });
    expect(validTokenFieldCoverage(t)).toBe(true);
  });
  it('folding one accumulator into another carries its per-field coverage with it', () => {
    const inner = tc();
    addTokenCounts(inner, tc({ inputFresh: 5, countQuality: 'complete' }));
    addTokenCounts(inner, tc({ inputFresh: 7, countQuality: 'complete' }));
    const outer = tc();
    addTokenCounts(outer, inner);
    addTokenCounts(outer, withEvidence(tc({ inputFresh: 1, countQuality: 'complete' })));
    expect(outer.inputFresh).toBe(13);
    expect(outer.fieldEvidence!.inputFresh).toMatchObject({ knownValue: 13, knownParts: 3, unrecordedParts: 3 });
  });
});
