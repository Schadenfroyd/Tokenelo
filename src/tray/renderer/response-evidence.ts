/**
 * Response evidence for the Usage tab: whether the selected Summary and the Timeseries response agree on a few named fields.
 * Pure (no DOM, no strings for display): it returns states and numbers, and the caller owns all copy.
 *
 * What a match means: only that range, the aggregate apiEquivUsd (within tolerance) and the summed unpriced/estimated event counts
 * agree. It is never acceptance of token totals, coverage, or a common database snapshot. Each response's generatedAt is its own
 * query clock: equal or different values neither prove nor disprove a shared snapshot, so they are reported, never compared for a verdict.
 * A clock is never read as schema evidence either: only the explicit `priceQualityCounts` capability makes an empty series a known zero.
 * Missing or invalid counts are unknown, never zero.
 */
import type { Range, SummaryResponse, TimeseriesResponse } from './api-types.js';

/** Dollar tolerance: |a − b| ≤ max(ABS, REL × max(|a|, |b|)). */
export const USD_ABS_TOLERANCE = 1e-8;
export const USD_REL_TOLERANCE = 1e-10;

export type FieldState = 'match' | 'mismatch' | 'unknown' | 'not-compared';

/** Why a side is unknown. `legacy-empty`: no points and no `priceQualityCounts` capability, so the responder may not send per-point counts. */
export type UnknownReason = 'absent' | 'invalid' | 'overflow' | 'legacy-empty';

export interface FieldEvidence {
  state: FieldState;
  summary: number | null;
  timeseries: number | null;
  /** Set when a side is unknown. */
  summaryUnknown?: UnknownReason;
  timeseriesUnknown?: UnknownReason;
}

export interface UsageResponseEvidence {
  range: { state: 'same' | 'different'; summary: Range; timeseries: Range };
  apiEquivUsd: FieldEvidence;
  unpricedEvents: FieldEvidence;
  estimatedPriceEvents: FieldEvidence;
  /** Fields only. `mismatch` when the range differs or any field mismatches; `unknown` when any field is unknown; else `match`. */
  numeric: 'match' | 'mismatch' | 'unknown';
  /** Query clocks, independent of `numeric`. null = absent, or not an integer epoch ms in [0, 8.64e15] (the JS Date range). */
  timestamps: { summaryGeneratedAt: number | null; timeseriesGeneratedAt: number | null; differenceMs: number | null };
}

type Side = { value: number; unknown?: undefined } | { value: null; unknown: UnknownReason };

/** Largest epoch ms a JS Date can represent (ECMA-262 TimeClip). */
export const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

function validEpochMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_DATE_EPOCH_MS ? v : null;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function summaryCount(v: unknown): Side {
  if (v === undefined || v === null) return { value: null, unknown: 'absent' };
  return isCount(v) ? { value: v } : { value: null, unknown: 'invalid' };
}

function summaryUsd(v: unknown): Side {
  if (v === undefined || v === null) return { value: null, unknown: 'absent' };
  return typeof v === 'number' && Number.isFinite(v) ? { value: v } : { value: null, unknown: 'invalid' };
}

/** Σ of a per-point count. An empty list is a known zero only when the responder declares `priceQualityCounts: true`. */
function sumCounts(points: readonly unknown[], field: 'unpricedEvents' | 'estimatedPriceEvents', countsDeclared: boolean): Side {
  if (points.length === 0) return countsDeclared ? { value: 0 } : { value: null, unknown: 'legacy-empty' };
  let sum = 0;
  for (const p of points) {
    const v = (p as Record<string, unknown> | null)?.[field];
    if (v === undefined || v === null) return { value: null, unknown: 'absent' };
    if (!isCount(v)) return { value: null, unknown: 'invalid' };
    if (v > Number.MAX_SAFE_INTEGER - sum) return { value: null, unknown: 'overflow' };
    sum += v;
  }
  return { value: sum };
}

function sumUsd(points: readonly unknown[]): Side {
  let sum = 0;
  for (const p of points) {
    const v = (p as Record<string, unknown> | null)?.apiEquivUsd;
    if (v === undefined || v === null) return { value: null, unknown: 'absent' };
    if (typeof v !== 'number' || !Number.isFinite(v)) return { value: null, unknown: 'invalid' };
    sum += v;
    if (!Number.isFinite(sum)) return { value: null, unknown: 'overflow' };
  }
  return { value: sum };
}

export function usdWithinTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(USD_ABS_TOLERANCE, USD_REL_TOLERANCE * Math.max(Math.abs(a), Math.abs(b)));
}

function field(s: Side, t: Side, compared: boolean, equal: (a: number, b: number) => boolean): FieldEvidence {
  const out: FieldEvidence = { state: 'unknown', summary: s.value, timeseries: t.value };
  if (s.unknown) out.summaryUnknown = s.unknown;
  if (t.unknown) out.timeseriesUnknown = t.unknown;
  if (!compared) out.state = 'not-compared';
  else if (s.value !== null && t.value !== null) out.state = equal(s.value, t.value) ? 'match' : 'mismatch';
  return out;
}

export function usageResponseEvidence(summary: SummaryResponse, timeseries: TimeseriesResponse): UsageResponseEvidence {
  const sameRange = summary.range === timeseries.range;
  const totals = (summary.totals ?? {}) as Partial<SummaryResponse['totals']>;
  const points: readonly unknown[] | null = Array.isArray(timeseries.points) ? timeseries.points : null;
  const tsGeneratedAt = validEpochMs(timeseries.generatedAt);
  const sumGeneratedAt = validEpochMs(summary.generatedAt);
  const invalid: Side = { value: null, unknown: 'invalid' };
  // Strictly `true`: any other value (absent, truthy string, a clock) grants nothing.
  const countsDeclared = (timeseries as { priceQualityCounts?: unknown }).priceQualityCounts === true;

  const exact = (a: number, b: number): boolean => a === b;
  const apiEquivUsd = field(summaryUsd(totals.apiEquivUsd), points ? sumUsd(points) : invalid, sameRange, usdWithinTolerance);
  const unpricedEvents = field(summaryCount(totals.unpricedEvents), points ? sumCounts(points, 'unpricedEvents', countsDeclared) : invalid, sameRange, exact);
  const estimatedPriceEvents = field(summaryCount(totals.estimatedPriceEvents), points ? sumCounts(points, 'estimatedPriceEvents', countsDeclared) : invalid, sameRange, exact);

  const states = [apiEquivUsd.state, unpricedEvents.state, estimatedPriceEvents.state];
  const numeric = !sameRange || states.includes('mismatch') ? 'mismatch' : states.includes('unknown') ? 'unknown' : 'match';

  return {
    range: { state: sameRange ? 'same' : 'different', summary: summary.range, timeseries: timeseries.range },
    apiEquivUsd,
    unpricedEvents,
    estimatedPriceEvents,
    numeric,
    timestamps: {
      summaryGeneratedAt: sumGeneratedAt,
      timeseriesGeneratedAt: tsGeneratedAt,
      differenceMs: sumGeneratedAt !== null && tsGeneratedAt !== null ? tsGeneratedAt - sumGeneratedAt : null,
    },
  };
}
