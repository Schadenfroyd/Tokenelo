import { describe, expect, it } from 'vitest';
import type { TokenCounts } from '../../src/tray/renderer/api-types.js';
import { aggregateTokenText, exactTokenLabel, tokenCountDetails, tokenTotalText } from '../../src/tray/renderer/token-counts.js';
const tokens: TokenCounts = { inputFresh: 100, cacheRead: 200, output: 50, reasoning: 20,
  cacheWrite5m: 10, cacheWrite1h: 30, cacheWriteUnassigned: 7, cacheWriteAssumed1h: 8, countQuality: 'complete' };

describe('compact and exact session token evidence', () => {
  it('keeps fleet rounding and legacy count qualification across mixed reports', () => {
    const total = aggregateTokenText([tokens, { ...tokens, inputFresh: 814_100, countQuality: undefined }]);
    expect(total.text).toBe('≈814.8k');
    expect(total.title).toContain('814,794 tokens'); expect(total.title).toContain('Count evidence unrecorded');
  });
  it('refuses a fleet total when one returned report is incomplete or numerically invalid', () => {
    for (const changed of [{ countQuality: 'incomplete' as const }, { inputFresh: 0.5 }]) {
      expect(aggregateTokenText([tokens, { ...tokens, ...changed }]).text).toBe('Unavailable');
    }
    expect(aggregateTokenText([]).text).toBe('Unavailable');
  });
  it('refuses unsafe fleet arithmetic even when each host subtotal is individually valid', () => {
    const huge: TokenCounts = { inputFresh: Number.MAX_SAFE_INTEGER - 100, cacheRead: 0, output: 0, reasoning: 0,
      cacheWrite5m: 0, cacheWrite1h: 0, countQuality: 'complete' };
    expect(tokenCountDetails(huge).totalAvailable).toBe(true);
    expect(aggregateTokenText([huge, tokens]).text).toBe('Unavailable');
  });
  it('adds the six disjoint categories once, retaining reasoning and assumed writes as subsets', () => {
    expect(tokenCountDetails(tokens)).toMatchObject({ subtotal: 397, totalAvailable: true, reasoning: 20, assumed1h: 8 });
    expect(tokenTotalText(tokens)).toBe('397');
    expect(exactTokenLabel(tokens)).toContain('397 tokens');
  });
  it('discloses a compact approximation while keeping the original integer available', () => {
    const large = { ...tokens, inputFresh: 814_100 };
    expect(tokenTotalText(large)).toBe('≈814.4k');
    expect(tokenCountDetails(large).subtotal).toBe(814397);
    expect(exactTokenLabel(large)).toContain('814,397 tokens');
  });
  it('retains the known subtotal without relabeling conflicting counts as a complete total', () => {
    const bad = { ...tokens, countQuality: 'conflict' as const, ucuCountQuality: 'complete' as const };
    expect(tokenCountDetails(bad)).toMatchObject({ subtotal: 397, totalAvailable: false });
    expect(tokenTotalText(bad)).toBe('Unavailable');
    expect(exactTokenLabel(bad)).toContain('complete total unavailable');
    expect(exactTokenLabel(bad)).toContain('v1-fresh work count known');
  });
  it('keeps missing legacy fields absent and the available categories qualified', () => {
    const legacy = { ...tokens, cacheWriteUnassigned: undefined, cacheWriteAssumed1h: undefined, countQuality: undefined };
    const result = tokenCountDetails(legacy);
    expect(result.subtotal).toBe(390); expect(result.components[5].value).toBeNull(); expect(result.assumed1h).toBeNull();
    expect(exactTokenLabel(legacy)).toContain('Count evidence unrecorded');
  });
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER])('does not display malformed or unsafe category sums (%s)', inputFresh => {
    const malformed = { ...tokens, inputFresh };
    expect(tokenCountDetails(malformed).subtotal).toBeNull(); expect(tokenTotalText(malformed)).toBe('Unavailable');
    expect(exactTokenLabel(malformed)).toContain('unavailable');
  });
});
