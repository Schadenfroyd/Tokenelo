import { describe, it, expect } from 'vitest';
import { usageResponseEvidence, usdWithinTolerance } from '../../src/tray/renderer/response-evidence.js';
import type { SummaryResponse, TimeseriesPoint, TimeseriesResponse } from '../../src/tray/renderer/api-types.js';

// Only the fields the helper reads are meaningful; the rest is filler cast to the response type.
function summary(totals: Partial<SummaryResponse['totals']>, extra: Partial<SummaryResponse> = {}): SummaryResponse {
  return { range: '7d', generatedAt: 1_000, totals: { apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, ...totals }, ...extra } as SummaryResponse;
}
function point(p: Partial<TimeseriesPoint>): TimeseriesPoint {
  return { t: 0, tokens: 0, bySource: {}, apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, ...p } as TimeseriesPoint;
}
function series(points: TimeseriesPoint[], extra: Partial<TimeseriesResponse> = {}): TimeseriesResponse {
  return { bucket: 'day', range: '7d', generatedAt: 2_000, priceQualityCounts: true, points, ...extra };
}

describe('usageResponseEvidence', () => {
  it('known matching amounts and counts: numeric match, timestamps reported independently', () => {
    const ev = usageResponseEvidence(
      summary({ apiEquivUsd: 4.75, unpricedEvents: 1, estimatedPriceEvents: 2 }),
      series([point({ apiEquivUsd: 3.5, unpricedEvents: 1, estimatedPriceEvents: 0 }), point({ apiEquivUsd: 1.25, estimatedPriceEvents: 2, unpricedEvents: 0 })]),
    );
    expect(ev.numeric).toBe('match');
    expect(ev.apiEquivUsd).toEqual({ state: 'match', summary: 4.75, timeseries: 4.75 });
    expect(ev.unpricedEvents.state).toBe('match');
    expect(ev.estimatedPriceEvents.timeseries).toBe(2);
    // Different clocks do not turn a field match into a mismatch, and are not a verdict either way.
    expect(ev.timestamps).toEqual({ summaryGeneratedAt: 1_000, timeseriesGeneratedAt: 2_000, differenceMs: 1_000 });
  });

  it('equal timestamps do not upgrade a dollar mismatch', () => {
    const ev = usageResponseEvidence(summary({ apiEquivUsd: 5 }), series([point({ apiEquivUsd: 4.99 })], { generatedAt: 1_000 }));
    expect(ev.apiEquivUsd.state).toBe('mismatch');
    expect(ev.numeric).toBe('mismatch');
    expect(ev.timestamps.differenceMs).toBe(0);
  });

  it('count mismatch on either field is a mismatch', () => {
    const ev = usageResponseEvidence(summary({ unpricedEvents: 2, estimatedPriceEvents: 0 }), series([point({ unpricedEvents: 1 })]));
    expect(ev.unpricedEvents).toMatchObject({ state: 'mismatch', summary: 2, timeseries: 1 });
    expect(ev.estimatedPriceEvents.state).toBe('match');
    expect(ev.numeric).toBe('mismatch');
  });

  it('range mismatch: fields are not compared and numeric is mismatch', () => {
    const ev = usageResponseEvidence(summary({}), series([point({})], { range: '24h' }));
    expect(ev.range).toEqual({ state: 'different', summary: '7d', timeseries: '24h' });
    expect(ev.apiEquivUsd.state).toBe('not-compared');
    expect(ev.numeric).toBe('mismatch');
  });

  it('roundoff within abs 1e-8 / rel 1e-10 matches; beyond it does not', () => {
    const sum = 0.1 + 0.2; // 0.30000000000000004
    expect(usageResponseEvidence(summary({ apiEquivUsd: 0.3 }), series([point({ apiEquivUsd: 0.1 }), point({ apiEquivUsd: 0.2 })])).apiEquivUsd.state).toBe('match');
    expect(sum).not.toBe(0.3);
    expect(usdWithinTolerance(0, 9e-9)).toBe(true);
    expect(usdWithinTolerance(0, 2e-8)).toBe(false);
    expect(usdWithinTolerance(1e6, 1e6 + 5e-5)).toBe(true); // rel: 1e-10 × 1e6 = 1e-4
    expect(usdWithinTolerance(1e6, 1e6 + 2e-4)).toBe(false);
  });

  it('legacy: absent counts and absent generatedAt are unknown, never zero; dollars still compare', () => {
    const legacyPoint = { t: 0, tokens: 0, bySource: {}, apiEquivUsd: 2 } as TimeseriesPoint;
    const ev = usageResponseEvidence(summary({ apiEquivUsd: 2, estimatedPriceEvents: undefined }), series([legacyPoint], { generatedAt: undefined }));
    expect(ev.apiEquivUsd.state).toBe('match');
    expect(ev.unpricedEvents).toMatchObject({ state: 'unknown', timeseries: null, timeseriesUnknown: 'absent' });
    expect(ev.estimatedPriceEvents).toMatchObject({ state: 'unknown', summary: null, summaryUnknown: 'absent' });
    expect(ev.numeric).toBe('unknown');
    expect(ev.timestamps).toEqual({ summaryGeneratedAt: 1_000, timeseriesGeneratedAt: null, differenceMs: null });
  });

  it('empty points: known zero counts only with the priceQualityCounts capability; without it the counts stay unknown', () => {
    const declared = usageResponseEvidence(summary({}), series([]));
    expect(declared.numeric).toBe('match');
    expect(declared.unpricedEvents.timeseries).toBe(0);
    const legacy = usageResponseEvidence(summary({}), series([], { generatedAt: undefined, priceQualityCounts: undefined }));
    expect(legacy.unpricedEvents).toMatchObject({ state: 'unknown', timeseriesUnknown: 'legacy-empty' });
    expect(legacy.apiEquivUsd.state).toBe('match');
    expect(legacy.numeric).toBe('unknown');
  });

  it('a valid clock alone never grants empty-series count certainty', () => {
    const ev = usageResponseEvidence(summary({}), series([], { generatedAt: 2_000, priceQualityCounts: undefined }));
    expect(ev.timestamps.timeseriesGeneratedAt).toBe(2_000);
    expect(ev.unpricedEvents).toMatchObject({ state: 'unknown', timeseries: null, timeseriesUnknown: 'legacy-empty' });
    expect(ev.estimatedPriceEvents).toMatchObject({ state: 'unknown', timeseries: null, timeseriesUnknown: 'legacy-empty' });
    expect(ev.numeric).toBe('unknown');
    // Only the literal `true` declares the capability.
    const truthy = { ...series([]), priceQualityCounts: 'yes' } as unknown as TimeseriesResponse;
    expect(usageResponseEvidence(summary({}), truthy).unpricedEvents.timeseriesUnknown).toBe('legacy-empty');
  });

  it('the capability with a missing or invalid clock still assesses empty counts; the clock is unknown', () => {
    for (const generatedAt of [undefined, -1, NaN]) {
      const ev = usageResponseEvidence(summary({}), series([], { generatedAt }));
      expect(ev.unpricedEvents).toMatchObject({ state: 'match', timeseries: 0 });
      expect(ev.estimatedPriceEvents).toMatchObject({ state: 'match', timeseries: 0 });
      expect(ev.numeric).toBe('match');
      expect(ev.timestamps).toEqual({ summaryGeneratedAt: 1_000, timeseriesGeneratedAt: null, differenceMs: null });
    }
    // A nonzero Summary count against a declared empty series is a real mismatch, not unknown.
    expect(usageResponseEvidence(summary({ unpricedEvents: 1 }), series([], { generatedAt: undefined })).unpricedEvents.state).toBe('mismatch');
  });

  it('clocks outside the JS Date range (> 8.64e15 ms) are unknown; the boundary itself is valid; fields are unaffected', () => {
    const max = 8_640_000_000_000_000;
    const over = usageResponseEvidence(summary({}, { generatedAt: max + 1_024 }), series([point({})], { generatedAt: Number.MAX_SAFE_INTEGER }));
    expect(over.timestamps).toEqual({ summaryGeneratedAt: null, timeseriesGeneratedAt: null, differenceMs: null });
    expect(over.numeric).toBe('match');
    const atMax = usageResponseEvidence(summary({}, { generatedAt: max }), series([point({})], { generatedAt: 0 }));
    expect(atMax.timestamps).toEqual({ summaryGeneratedAt: max, timeseriesGeneratedAt: 0, differenceMs: -max });
    expect(usageResponseEvidence(summary({}, { generatedAt: 1.5 }), series([point({})])).timestamps.summaryGeneratedAt).toBeNull();
  });

  it('rejects nonfinite dollars, negative/fractional/unsafe counts, and guards overflow', () => {
    expect(usageResponseEvidence(summary({ apiEquivUsd: NaN }), series([point({})])).apiEquivUsd.summaryUnknown).toBe('invalid');
    expect(usageResponseEvidence(summary({}), series([point({ apiEquivUsd: Infinity })])).apiEquivUsd.timeseriesUnknown).toBe('invalid');
    expect(usageResponseEvidence(summary({}), series([point({ apiEquivUsd: Number.MAX_VALUE }), point({ apiEquivUsd: Number.MAX_VALUE })])).apiEquivUsd.timeseriesUnknown).toBe('overflow');
    expect(usageResponseEvidence(summary({}), series([point({ unpricedEvents: -1 })])).unpricedEvents.timeseriesUnknown).toBe('invalid');
    expect(usageResponseEvidence(summary({}), series([point({ unpricedEvents: 1.5 })])).unpricedEvents.timeseriesUnknown).toBe('invalid');
    expect(usageResponseEvidence(summary({ unpricedEvents: 2 ** 53 }), series([point({})])).unpricedEvents.summaryUnknown).toBe('invalid');
    const big = Number.MAX_SAFE_INTEGER;
    expect(usageResponseEvidence(summary({}), series([point({ estimatedPriceEvents: big }), point({ estimatedPriceEvents: 1 })])).estimatedPriceEvents.timeseriesUnknown).toBe('overflow');
  });

  it('invalid generatedAt is an unknown timestamp but the fields are still assessed', () => {
    const ev = usageResponseEvidence(summary({}, { generatedAt: NaN }), series([point({})], { generatedAt: -5 }));
    expect(ev.timestamps).toEqual({ summaryGeneratedAt: null, timeseriesGeneratedAt: null, differenceMs: null });
    expect(ev.numeric).toBe('match');
  });
});
