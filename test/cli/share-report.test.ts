import { describe, expect, it } from 'vitest';
import { buildShareReport, verifyShareReportDigest } from '../../src/cli/share-report.js';
import type { SummaryResponse, TokenCounts } from '../../src/core/types.js';

const tokens: TokenCounts = { inputFresh: 100, cacheRead: 200, output: 50, reasoning: 20,
  cacheWrite5m: 10, cacheWrite1h: 30, cacheWriteUnassigned: 7, cacheWriteAssumed1h: 8, countQuality: 'complete' };
function fixture(): SummaryResponse {
  const row = { events: 2, tokens: { ...tokens }, apiEquivUsd: 0.25, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' };
  return { host: 'SECRET-HOST', range: '7d', generatedAt: 10_000,
    timeBasis: { startMs: 1000, asOfMs: 10_000, endInclusive: true, timestampBasis: 'recorded-timestamps', excludedFutureEvents: 3, excludedFutureActivity: 4 },
    totals: { ...row },
    bySource: { claude: { ...row, tokens: { ...tokens } } }, byModel: [{ model: 'SECRET-MODEL' }],
    subscriptions: [{ account: 'SECRET-ACCOUNT' }], local: { project: 'SECRET-PATH' },
  } as unknown as SummaryResponse;
}
describe('aggregate share report', () => {
  it('keeps hand-calculated disjoint totals, time scope, source reconciliation and pricing qualifications', () => {
    const report = buildShareReport(fixture(), '7d');
    expect(report.totals.tokens.completeTotal).toBe(397);
    expect(report.totals.tokens.subsets).toMatchObject({ reasoningIncludedInOutput: 20, assumed1hIncludedInCacheWrite1h: 8, consistent: true });
    expect(report.queryScope).toMatchObject({ startMs: 1000, asOfMs: 10_000, excludedFutureEvents: 3, excludedFutureActivity: 4 });
    expect(report.sourceReconciliation.status).toBe('match');
    expect(report.totals.pricing).toMatchObject({ storedApiEquivalentUsd: 0.25, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED', partial: true });
  });
  it('excludes identifiers and arbitrary injected nested fields with a closed allowlist', () => {
    const input = fixture();
    Object.assign(input.totals.tokens, { project: 'SECRET-TOKEN-PATH' });
    Object.assign(input.timeBasis!, { sessionId: 'SECRET-TIME-ID' });
    Object.assign(input.bySource.claude, { path: 'SECRET-SOURCE-PATH' });
    // A legacy figure object, as an older daemon's summary carried it, is not a member of the closed allowlist either.
    Object.assign(input.totals, { ucu: { value: 123, definition: 'SECRET-FIGURE' } });
    input.bySource['SECRET-UNKNOWN-FEED' as never] = input.bySource.claude;
    const report = buildShareReport(input, '7d');
    expect(JSON.stringify(report)).not.toContain('SECRET');
    expect(report.sourceReconciliation.status).toBe('unavailable');
    expect(report.qualifications.privacy).toContain('can-still-identify-activity');
  });
  it('does not promote missing legacy fields or unresolved counts into complete totals', () => {
    for (const quality of [undefined, 'unrecorded', 'incomplete', 'conflict', 'invalid'] as const) {
      const input = fixture(); input.totals.tokens.countQuality = quality;
      expect(buildShareReport(input, '7d').totals.tokens.completeTotal).toBeNull();
    }
    const input = fixture(); delete input.totals.tokens.cacheWriteUnassigned; delete input.totals.tokens.cacheWriteAssumed1h;
    const report = buildShareReport(input, '7d');
    expect(report.totals.tokens.components.cacheWriteUnassigned).toBeNull();
    expect(report.totals.tokens.normalizedCategorySubtotal).toBeNull();
    expect(report.totals.tokens.missingComponents).toEqual(['cacheWriteUnassigned']);
  });
  it('does not claim a complete total for invalid numeric categories, overflow or contradictory subsets', () => {
    for (const n of [NaN, -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      const input = fixture(); input.totals.tokens.inputFresh = n;
      expect(buildShareReport(input, '7d').totals.tokens.completeTotal).toBeNull();
    }
    const input = fixture(); input.totals.tokens.reasoning = 51;
    expect(buildShareReport(input, '7d').totals.tokens.subsets.consistent).toBe(false);
    expect(buildShareReport(input, '7d').totals.tokens.completeTotal).toBeNull();
  });
  it('qualifies contradictory source events/components and missing legacy price counts', () => {
    const input = fixture(); input.bySource.claude.tokens.output = 49;
    expect(buildShareReport(input, '7d').sourceReconciliation.status).toBe('mismatch');
    input.bySource.claude.tokens.output = 50; input.bySource.claude.events = 3;
    expect(buildShareReport(input, '7d').sourceReconciliation.status).toBe('mismatch');
    delete input.bySource.claude.unpricedEvents; delete input.bySource.claude.estimatedPriceEvents;
    expect(buildShareReport(input, '7d').sources[0]!.pricing).toMatchObject({ unpricedEvents: null, estimatedPriceEvents: null, partial: null, countsConsistent: false });
  });
  it('rejects relabeled ranges and leaves malformed time scope unknown', () => {
    expect(() => buildShareReport(fixture(), '30d')).toThrow('range mismatch');
    const input = fixture(); input.timeBasis!.asOfMs = 11_000;
    expect(buildShareReport(input, '7d').queryScope).toBeNull();
  });
  it('makes deterministic unsigned provenance sensitive to values but independent of object insertion order', () => {
    const first = buildShareReport(fixture(), '7d'); const input = fixture();
    input.totals.tokens = Object.fromEntries(Object.entries(input.totals.tokens).reverse()) as unknown as TokenCounts;
    expect(buildShareReport(input, '7d').integrity.sha256).toBe(first.integrity.sha256);
    expect(verifyShareReportDigest(first)).toBe(true);
    first.totals.events = 3;
    expect(verifyShareReportDigest(first)).toBe(false);
    expect(first.qualifications.authenticity).toContain('unsigned');
  });
});
