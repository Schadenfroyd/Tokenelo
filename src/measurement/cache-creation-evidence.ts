/** Cache-creation reconciliation used by the production count adapter through cache projection.
 * Preserves raw observations; no TTL fallback, prices, rates, row writes, dedup, settlement or public export. Typed input
 * is the observation seam's output, not an untrusted/proxy-object validation boundary. */
import type { CacheCreationObservation, FieldObservation } from './claude-observation.js';

export const CACHE_CREATION_RECONCILIATION_VERSION = 'tokenelo/cache-creation-evidence@v0';

export type CacheCreationIssue =
  | 'flat-total-invalid-for-count'
  | 'ttl-5m-invalid-for-count'
  | 'ttl-1h-invalid-for-count'
  | 'ttl-subtotal-out-of-safe-range'
  | 'known-ttl-exceeds-flat-total'
  | 'cache-container-malformed';

export interface CacheCreationEvidence {
  policyVersion: typeof CACHE_CREATION_RECONCILIATION_VERSION;
  /** This convention requires nonnegative safe integer counters; raw observation accepts
   * other finite numbers and retains them. Reconciliation never rounds/coerces those. */
  countConvention: 'nonnegative-safe-integer';
  total:
    | { state: 'reported'; value: number }
    | { state: 'lower-bound'; value: number }
    | { state: 'missing' | 'invalid' | 'conflict'; value: null };
  /** Sum of explicitly usable reported TTL fields. Null means none or an unsafe sum. */
  knownTtlSubtotal: number | null;
  /** Residual of a known, consistent flat total after the known subtotal. It is never
   * assigned to 5m or 1h. Null if the total is not known or observations conflict. */
  unknownTtlResidual: number | null;
  ttlPartition: 'complete' | 'partial' | 'not-reported' | 'invalid' | 'conflict';
  observations: CacheCreationObservation;
  issues: CacheCreationIssue[];
}

function usable(field: FieldObservation): number | null {
  return field.state === 'reported' && Number.isSafeInteger(field.value) && field.value >= 0 ? field.value : null;
}

function bad(field: FieldObservation): boolean {
  return field.state === 'invalid' || (field.state === 'reported' && usable(field) === null);
}

/** A flat count contributes once; TTL fields partition it, never add to it. Without the
 * flat count a known split is only a lower bound, even when both TTL fields were reported.
 * A split above the flat count is conflict, never silently clamped or repriced. */
export function reconcileCacheCreation(input: CacheCreationObservation): CacheCreationEvidence {
  const observations: CacheCreationObservation = {
    flatTotal: { ...input.flatTotal }, container: input.container,
    ephemeral5m: { ...input.ephemeral5m }, ephemeral1h: { ...input.ephemeral1h },
  };
  const issues: CacheCreationIssue[] = [];
  if (bad(input.flatTotal)) issues.push('flat-total-invalid-for-count');
  if (bad(input.ephemeral5m)) issues.push('ttl-5m-invalid-for-count');
  if (bad(input.ephemeral1h)) issues.push('ttl-1h-invalid-for-count');
  if (input.container === 'malformed') issues.push('cache-container-malformed');
  const flat = usable(input.flatTotal), five = usable(input.ephemeral5m), hour = usable(input.ephemeral1h);
  const hasSplit = five !== null || hour !== null;
  const split = hasSplit ? (five ?? 0) + (hour ?? 0) : null;
  const unsafeSplit = split !== null && !Number.isSafeInteger(split);
  if (unsafeSplit) issues.push('ttl-subtotal-out-of-safe-range');
  const knownTtlSubtotal = unsafeSplit ? null : split;
  const exceedsFlat = flat !== null && split !== null && split > flat;
  if (exceedsFlat) issues.push('known-ttl-exceeds-flat-total');
  const conflict = exceedsFlat || (flat !== null && unsafeSplit);
  let total: CacheCreationEvidence['total'];
  if (conflict) total = { state: 'conflict', value: null };
  else if (flat !== null) total = { state: 'reported', value: flat === 0 ? 0 : flat };
  else if (knownTtlSubtotal !== null) total = { state: 'lower-bound', value: knownTtlSubtotal === 0 ? 0 : knownTtlSubtotal };
  else total = { state: bad(input.flatTotal) || bad(input.ephemeral5m) || bad(input.ephemeral1h) || unsafeSplit ? 'invalid' : 'missing', value: null };
  const unknownTtlResidual = total.state === 'reported' ? total.value - (knownTtlSubtotal ?? 0) : null;
  const invalidTtl = bad(input.ephemeral5m) || bad(input.ephemeral1h) || unsafeSplit || input.container === 'malformed';
  const ttlPartition: CacheCreationEvidence['ttlPartition'] = conflict ? 'conflict'
    : invalidTtl ? 'invalid'
    : !hasSplit ? 'not-reported'
    : total.state === 'reported' && five !== null && hour !== null && unknownTtlResidual === 0 ? 'complete'
    : 'partial';
  return { policyVersion: CACHE_CREATION_RECONCILIATION_VERSION, countConvention: 'nonnegative-safe-integer', total, knownTtlSubtotal, unknownTtlResidual, ttlPartition, observations, issues };
}
