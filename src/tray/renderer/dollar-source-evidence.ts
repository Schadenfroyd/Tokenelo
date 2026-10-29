import { MAX_DATE_EPOCH_MS, usdWithinTolerance } from './response-evidence.js';

export type DollarSourceIssueReason = 'points' | 'point' | 'timestamp' | 'total' | 'sources'
  | 'source-value' | 'negative' | 'unsupported' | 'overflow' | 'mismatch';

export interface DollarSourceIssue {
  index: number | null;
  timestamp: number | null;
  reason: DollarSourceIssueReason;
  total: number | null;
  sourceSum: number | null;
}

export interface DollarSourceEvidence {
  state: 'empty' | 'consistent' | 'mismatch' | 'unavailable';
  buckets: number | null;
  consistentBuckets: number;
  mismatchedBuckets: number;
  unavailableBuckets: number | null;
  /** Zero-valued unfamiliar entries do not change dollar geometry; their identities remain unrepresented. */
  unrepresentedZeroEntries: number;
  issues: DollarSourceIssue[];
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function timestamp(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_EPOCH_MS;
}

/** Dollar geometry only. Does not establish source identity, clock accuracy, prices or token coverage. */
export function dollarSourceEvidence(points: unknown, plottedSources: readonly string[]): DollarSourceEvidence {
  if (!Array.isArray(points)) return {
    state: 'unavailable', buckets: null, consistentBuckets: 0, mismatchedBuckets: 0, unavailableBuckets: null, unrepresentedZeroEntries: 0,
    issues: [{ index: null, timestamp: null, reason: 'points', total: null, sourceSum: null }],
  };
  const sources = new Set(plottedSources);
  const issues: DollarSourceIssue[] = [];
  let consistentBuckets = 0, mismatchedBuckets = 0, unavailableBuckets = 0, unrepresentedZeroEntries = 0;
  for (let index = 0; index < points.length; index++) {
    const raw: unknown = points[index];
    let time: number | null = null, total: number | null = null, sourceSum: number | null = null;
    let reason: DollarSourceIssueReason | null = null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reason = 'point';
    else {
      const point = raw as Record<string, unknown>;
      time = timestamp(point.t) ? point.t : null;
      total = finite(point.apiEquivUsd) ? point.apiEquivUsd : null;
      const map = point.bySource;
      if (time === null) reason = 'timestamp';
      else if (total === null) reason = 'total';
      else if (total < 0) reason = 'negative';
      else if (!map || typeof map !== 'object' || Array.isArray(map)) reason = 'sources';
      else {
        const entries = Object.entries(map);
        if (entries.some(([, value]) => !finite(value))) reason = 'source-value';
        else if (entries.some(([, value]) => (value as number) < 0)) reason = 'negative';
        else {
          const sum = entries.reduce((value, [, amount]) => value + (amount as number), 0);
          sourceSum = Number.isFinite(sum) ? sum : null;
          if (sourceSum === null) reason = 'overflow';
          else if (entries.some(([source, amount]) => !sources.has(source) && (amount as number) > 0)) reason = 'unsupported';
          // Zero/nonzero geometry stays distinct even inside the dollar rounding tolerance.
          else if ((total === 0) !== (sourceSum === 0) || !usdWithinTolerance(total, sourceSum)) reason = 'mismatch';
          unrepresentedZeroEntries += entries.filter(([source, amount]) => !sources.has(source) && amount === 0).length;
        }
      }
    }
    if (reason === null) consistentBuckets++;
    else {
      if (reason === 'mismatch') mismatchedBuckets++; else unavailableBuckets++;
      issues.push({ index, timestamp: time, reason, total, sourceSum });
    }
  }
  return {
    state: points.length === 0 ? 'empty' : unavailableBuckets > 0 ? 'unavailable' : mismatchedBuckets > 0 ? 'mismatch' : 'consistent',
    buckets: points.length, consistentBuckets, mismatchedBuckets, unavailableBuckets, unrepresentedZeroEntries, issues,
  };
}
