import { describe, expect, it } from 'vitest';
import { tokenPeriodEvidence } from '../../src/tray/renderer/token-period.js';
import type { SummaryResponse, TokenCounts } from '../../src/tray/renderer/api-types.js';
const counts: TokenCounts = { inputFresh: 100, cacheRead: 200, output: 50, reasoning: 20, cacheWrite5m: 10,
  cacheWrite1h: 30, cacheWriteUnassigned: 7, cacheWriteAssumed1h: 8, countQuality: 'complete' };
function summary(tokens = counts, events = 2): SummaryResponse {
  return { range: '7d', totals: { tokens, events }, bySource: { claude: { events, tokens } } } as SummaryResponse;
}
describe('selected token-period evidence', () => {
  it('adds disjoint categories, retaining reasoning and policy assumptions as subsets', () => {
    const result = tokenPeriodEvidence(summary(), '7d');
    expect(result.subtotal).toBe(397); expect(result.totalAvailable).toBe(true);
    expect(result.headline).toBe('Reported tokens'); expect(result.reasoning).toBe(20); expect(result.assumed1h).toBe(8);
    expect(result.components.map(row => row.value)).toEqual([100, 200, 50, 10, 30, 7]);
    expect(result.sourceState).toBe('match');
  });
  it('preserves incomplete evidence even when the known subtotal is useful', () => {
    const result = tokenPeriodEvidence(summary({ ...counts, countQuality: 'incomplete', ucuCountQuality: 'complete' }), '7d');
    expect(result.totalAvailable).toBe(false); expect(result.subtotal).toBe(397);
    expect(result.headline).toBe('Complete token total'); expect(result.basis).toContain('incomplete count evidence');
    expect(result.basis).toContain('v1-fresh work count known');
  });
  it('does not turn omitted legacy fields into reported zero or complete count evidence', () => {
    const legacy = { ...counts, countQuality: undefined, cacheWriteUnassigned: undefined, cacheWriteAssumed1h: undefined };
    const result = tokenPeriodEvidence(summary(legacy), '7d');
    expect(result.headline).toBe('Normalized token categories'); expect(result.basis).toContain('Count evidence unrecorded');
    expect(result.components[5].value).toBeNull(); expect(result.assumed1h).toBeNull(); expect(result.subtotal).toBe(390);
  });
  it('distinguishes no recorded usage from unresolved or contradictory zero evidence', () => {
    const zero = { inputFresh: 0, cacheRead: 0, output: 0, reasoning: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    expect(tokenPeriodEvidence(summary(zero, 0), '7d')).toMatchObject({ empty: true, subtotal: 0, totalAvailable: true });
    expect(tokenPeriodEvidence(summary({ ...zero, countQuality: 'conflict' }, 0), '7d')).toMatchObject({ empty: false, totalAvailable: false });
    expect(tokenPeriodEvidence(summary(zero, 1), '7d').basis).toContain('Count evidence unrecorded');
  });
  it('compares source events and each category without claiming capture completeness', () => {
    const different = summary(); different.bySource.claude.tokens = { ...counts, output: 49 };
    expect(tokenPeriodEvidence(different, '7d').sourceState).toBe('mismatch');
    const missing = summary(); missing.bySource = undefined as never;
    expect(tokenPeriodEvidence(missing, '7d')).toMatchObject({ sourceState: 'unavailable', sources: [] });
    const unknown = summary(); unknown.bySource = { future: { events: 2, tokens: counts } } as never;
    expect(tokenPeriodEvidence(unknown, '7d').sourceState).toBe('unavailable');
  });
  it('does not present invalid or unsafe numeric fields as exact usable totals', () => {
    for (const value of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      const result = tokenPeriodEvidence(summary({ ...counts, inputFresh: value }), '7d');
      expect(result.totalAvailable).toBe(false); expect(result.subtotal).toBeNull();
      expect(result.basis).toContain('unavailable');
    }
  });
  it('refuses a mismatched selected range rather than relabeling another period', () => {
    expect(() => tokenPeriodEvidence(summary(), '30d')).toThrow('Selected token summary range mismatch');
  });
});
