/**
 * Regression tests for src/core/token-field-evidence.ts: the default unrecorded vector, normalization of a
 * recorded vector, the validity rules for stored coverage, and the handling of stored native evidence.
 * The deeper per-counter native projection (`nativeTokenFieldCoverage`) still needs fixtures and is not covered here.
 */
import { describe, it, expect } from 'vitest';
import {
  addTokenFieldCoverage, normalizedTokenFields, storedNativeTokenFields, TOKEN_FIELD_KEYS, unrecordedTokenFields, validTokenFieldCoverage,
} from '../../src/core/token-field-evidence.js';
import type { TokenCounts } from '../../src/core/types.js';

const tc = (o: Partial<TokenCounts> = {}): TokenCounts =>
  ({ inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, ...o });

describe('unrecordedTokenFields and normalizedTokenFields', () => {
  it('default to one unrecorded part per field, and honour an explicit part count', () => {
    for (const k of TOKEN_FIELD_KEYS) expect(unrecordedTokenFields()[k]).toMatchObject({ unrecordedParts: 1, knownParts: 0, knownValue: 0 });
    for (const k of TOKEN_FIELD_KEYS) expect(unrecordedTokenFields(4)[k].unrecordedParts).toBe(4);
  });
  it('a complete vector becomes known; an absent unassigned-TTL field is a known zero', () => {
    const f = normalizedTokenFields(tc({ inputFresh: 9, output: 2, countQuality: 'complete' }), 3);
    expect(f.inputFresh).toMatchObject({ knownValue: 9, knownParts: 3, normalizedParts: 3, unrecordedParts: 3 });
    expect(f.cacheWriteUnassigned).toMatchObject({ knownValue: 0, knownParts: 3 });
    expect(f.cacheRead).toMatchObject({ knownValue: 0, knownParts: 3 });
  });
  it('a vector that is not complete stays entirely unrecorded', () => {
    for (const q of [undefined, 'incomplete', 'invalid', 'conflict', 'unrecorded'] as const) {
      const f = normalizedTokenFields(tc({ inputFresh: 9, countQuality: q }));
      for (const k of TOKEN_FIELD_KEYS) expect(f[k]).toMatchObject({ knownParts: 0, knownValue: 0 });
    }
  });
  it('a negative or non-integer field in a complete vector is not treated as known', () => {
    const f = normalizedTokenFields(tc({ inputFresh: -1, output: 1.5, cacheRead: 4, countQuality: 'complete' }));
    expect(f.inputFresh.knownParts).toBe(0);
    expect(f.output.knownParts).toBe(0);
    expect(f.cacheRead).toMatchObject({ knownParts: 1, knownValue: 4 });
  });
  it('addTokenFieldCoverage sums every counter, treating an absent side as zero', () => {
    const a = normalizedTokenFields(tc({ inputFresh: 2, countQuality: 'complete' }));
    const sum = addTokenFieldCoverage(a, normalizedTokenFields(tc({ inputFresh: 3, countQuality: 'complete' })));
    expect(sum.inputFresh).toMatchObject({ knownValue: 5, knownParts: 2, normalizedParts: 2, unrecordedParts: 2 });
    expect(addTokenFieldCoverage(undefined, a).inputFresh).toMatchObject({ knownValue: 2, knownParts: 1 });
  });
});

describe('validTokenFieldCoverage', () => {
  const withCoverage = (t: TokenCounts, edit?: (f: ReturnType<typeof normalizedTokenFields>) => void): TokenCounts => {
    const f = normalizedTokenFields(t); edit?.(f); return { ...t, fieldEvidence: f };
  };
  const base = tc({ inputFresh: 5, countQuality: 'complete' });
  it('is true without evidence and for evidence consistent with the totals', () => {
    expect(validTokenFieldCoverage(base)).toBe(true);
    expect(validTokenFieldCoverage(withCoverage(base))).toBe(true);
  });
  it('is false when a known value exceeds the stored total for that field, including an absent optional field', () => {
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { f.inputFresh.knownValue = 6; }))).toBe(false);
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { f.cacheWriteUnassigned.knownValue = 1; f.cacheWriteUnassigned.knownParts = 1; }))).toBe(false);
  });
  it('is false for a known value with no known parts, but true for zero value and zero parts', () => {
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { f.inputFresh.knownParts = 0; f.inputFresh.normalizedParts = 0; }))).toBe(false);
    expect(validTokenFieldCoverage(withCoverage(tc(), (f) => { for (const k of TOKEN_FIELD_KEYS) f[k].knownParts = 0; }))).toBe(true);
  });
  it('is false when a sub-count exceeds the known parts', () => {
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { f.inputFresh.assumedParts = 2; }))).toBe(false);
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { f.inputFresh.derivedParts = 1; }))).toBe(true);
  });
  it('is false for unknown keys, non-integer counters, or a missing field', () => {
    expect(validTokenFieldCoverage({ ...base, fieldEvidence: { ...normalizedTokenFields(base), extra: {} } as never })).toBe(false);
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { f.output.missingParts = 0.5; }))).toBe(false);
    expect(validTokenFieldCoverage(withCoverage(base, (f) => { delete (f as Record<string, unknown>).output; }))).toBe(false);
  });
});

describe('storedNativeTokenFields', () => {
  const components = (extra: object = {}) => JSON.stringify([{ model: 'm', tokens: tc(), ...extra }]);
  it('returns nothing for an empty value and nothing for components without native evidence', () => {
    expect(storedNativeTokenFields(null, tc())).toBeUndefined();
    expect(storedNativeTokenFields('', tc())).toBeUndefined();
    expect(storedNativeTokenFields(components(), tc())).toBeUndefined();
  });
  it('unparsable or malformed component JSON is invalid evidence and downgrades the totals', () => {
    for (const raw of ['{not json', '{}', '[null]', '[{"tokens":null}]', '[{"model":"m"}]']) {
      const totals = tc({ countQuality: 'complete', ucuCountQuality: 'incomplete' });
      const fields = storedNativeTokenFields(raw, totals)!;
      for (const k of TOKEN_FIELD_KEYS) expect(fields[k].invalidParts).toBe(1);
      expect(totals.countQuality).toBe('invalid');
      expect(totals.ucuCountQuality).toBeUndefined();
    }
  });
  it('invalid evidence never overwrites a conflict', () => {
    const totals = tc({ countQuality: 'conflict' });
    storedNativeTokenFields('{not json', totals);
    expect(totals.countQuality).toBe('conflict');
  });
  it('native evidence stored without a revision is unrecorded and makes the totals incomplete, keeping invalid and conflict', () => {
    const native = components({ nativeCounterEvidence: { schema: 'x' } });
    const totals = tc({ countQuality: 'complete', ucuCountQuality: 'incomplete' });
    const fields = storedNativeTokenFields(native, totals, null)!;
    for (const k of TOKEN_FIELD_KEYS) expect(fields[k].unrecordedParts).toBe(1);
    expect(totals.countQuality).toBe('incomplete');
    expect(totals.ucuCountQuality).toBeUndefined();
    for (const q of ['invalid', 'conflict'] as const) {
      const t = tc({ countQuality: q });
      storedNativeTokenFields(native, t, undefined);
      expect(t.countQuality).toBe(q);
    }
  });
});
