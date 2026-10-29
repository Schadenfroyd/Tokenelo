import { describe, expect, it } from 'vitest';
import { dollarSourceEvidence } from '../../src/tray/renderer/dollar-source-evidence.js';
import { CHART_SOURCES } from '../../src/tray/renderer/charts.js';

const point = (apiEquivUsd: unknown, bySource: unknown, t: unknown = 1000) => ({ t, apiEquivUsd, bySource });

describe('dollar source breakdown geometry', () => {
  it('checks hand-computed two-source totals without mutating returned values', () => {
    const input = [point(3, { claude: 1, codex: 2 })], before = JSON.stringify(input);
    expect(dollarSourceEvidence(input, CHART_SOURCES)).toMatchObject({ state: 'consistent', buckets: 1, consistentBuckets: 1, issues: [] });
    expect(JSON.stringify(input)).toBe(before);
  });
  it('accepts nonzero floating-point roundoff within the existing tolerance', () => {
    expect(dollarSourceEvidence([point(0.3, { claude: 0.1, codex: 0.2 })], CHART_SOURCES).state).toBe('consistent');
  });
  it('keeps the original mismatched aggregate and source sum inspectable', () => {
    expect(dollarSourceEvidence([point(2, { claude: 1 })], CHART_SOURCES)).toMatchObject({ state: 'mismatch', mismatchedBuckets: 1, issues: [{ index: 0, timestamp: 1000, reason: 'mismatch', total: 2, sourceSum: 1 }] });
  });
  it('does not equate zero geometry with a tiny nonzero amount', () => {
    for (const value of [1e-12, 2e-8]) {
      expect(dollarSourceEvidence([point(value, {})], CHART_SOURCES).state).toBe('mismatch');
      expect(dollarSourceEvidence([point(0, { claude: value })], CHART_SOURCES).state).toBe('mismatch');
    }
  });
  it('distinguishes an explicit empty zero map from an absent or invalid map', () => {
    expect(dollarSourceEvidence([point(0, {})], CHART_SOURCES).state).toBe('consistent');
    for (const map of [undefined, null, [], 'empty']) expect(dollarSourceEvidence([point(0, map)], CHART_SOURCES).issues[0].reason).toBe('sources');
  });
  it('does not invent zero buckets from an absent or invalid point list', () => {
    expect(dollarSourceEvidence([], CHART_SOURCES)).toMatchObject({ state: 'empty', buckets: 0, issues: [] });
    for (const points of [undefined, null, {}, 'empty']) expect(dollarSourceEvidence(points, CHART_SOURCES)).toMatchObject({ state: 'unavailable', buckets: null, unavailableBuckets: null });
  });
  it('rejects unusable amounts without coercion', () => {
    for (const value of [null, undefined, '3', NaN, Infinity]) expect(dollarSourceEvidence([point(value, { claude: 3 })], CHART_SOURCES).issues[0].reason).toBe('total');
    for (const value of [null, '3', NaN, Infinity]) expect(dollarSourceEvidence([point(3, { claude: value })], CHART_SOURCES).issues[0].reason).toBe('source-value');
  });
  it('refuses negative values that the positive bar geometry cannot represent', () => {
    expect(dollarSourceEvidence([point(-1, { claude: -1 })], CHART_SOURCES).issues[0].reason).toBe('negative');
    expect(dollarSourceEvidence([point(0, { claude: -1, codex: 1 })], CHART_SOURCES).issues[0].reason).toBe('negative');
  });
  it('retains supported zero-cost local source data', () => {
    expect(dollarSourceEvidence([point(0, { 'ollama-proxy': 0, 'ollama-log': 0 })], CHART_SOURCES).state).toBe('consistent');
  });
  it('keeps zero unfamiliar entries explicit without hiding valid dollar geometry', () => {
    expect(dollarSourceEvidence([point(3, { claude: 3, 'future-source': 0 })], CHART_SOURCES)).toMatchObject({ state: 'consistent', unrepresentedZeroEntries: 1 });
    expect(dollarSourceEvidence([point(0, { 'future-source': 0 })], CHART_SOURCES)).toMatchObject({ state: 'consistent', unrepresentedZeroEntries: 1 });
    expect(dollarSourceEvidence([point(2, { 'future-source': 2 })], CHART_SOURCES)).toMatchObject({ state: 'unavailable', issues: [{ reason: 'unsupported', total: 2, sourceSum: 2 }] });
  });
  it('handles sum overflow as unavailable instead of accepting Infinity', () => {
    expect(dollarSourceEvidence([point(Number.MAX_VALUE, { claude: Number.MAX_VALUE, codex: Number.MAX_VALUE })], CHART_SOURCES)).toMatchObject({ state: 'unavailable', issues: [{ reason: 'overflow', sourceSum: null }] });
  });
  it('requires usable bucket time and preserves an explicit epoch-zero bucket', () => {
    expect(dollarSourceEvidence([point(0, {}, 0)], CHART_SOURCES).state).toBe('consistent');
    for (const value of [undefined, NaN, -1, 1.5, Number.MAX_SAFE_INTEGER]) expect(dollarSourceEvidence([{ ...point(0, {}), t: value }], CHART_SOURCES).issues[0].reason).toBe('timestamp');
  });
  it('keeps mismatch and unavailable counts separate in mixed responses', () => {
    expect(dollarSourceEvidence([point(3, { claude: 3 }), point(2, { claude: 1 }), point(0, null)], CHART_SOURCES)).toMatchObject({ state: 'unavailable', buckets: 3, consistentBuckets: 1, mismatchedBuckets: 1, unavailableBuckets: 1 });
  });
  it('does not treat an invalid bucket object as a consistent zero', () => {
    for (const value of [null, [], 0]) expect(dollarSourceEvidence([value], CHART_SOURCES).issues[0].reason).toBe('point');
  });
});
