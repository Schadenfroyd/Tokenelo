/** Private correction primitive. Merge raw cache observations before projecting TTL
 * assignments: an assumed 1h bucket and an unassigned residual are not independent
 * counters to MAX against later reported TTL. The production adapter uses this primitive;
 * rollout still requires persistence/API/UI/native acceptance. */
import type { CacheCreationObservation, ContainerState, FieldObservation } from './claude-observation.js';
import { reconcileCacheCreation, type CacheCreationEvidence } from './cache-creation-evidence.js';

export const CACHE_WRITE_PROJECTION_VERSION = 'tokenelo/cache-write-projection@v0';
export const CACHE_SNAPSHOT_MERGE_VERSION = 'tokenelo/raw-cache-field-max@v0';
export type CacheFallbackPolicy = 'none' | 'assume-1h-if-no-ttl-reported';

export interface CacheWriteProjection {
  policyVersion: typeof CACHE_WRITE_PROJECTION_VERSION;
  fallbackPolicy: CacheFallbackPolicy;
  evidence: CacheCreationEvidence;
  /** Explicitly usable reported category counters, rather than actual zero for an absent field. */
  known5m: number;
  known1h: number;
  /** An explicit source-policy assignment, never promoted to reported TTL. */
  assumed1h: number;
  /** Known work with unassigned TTL; null if the total is unresolved. */
  unassignedTtl: number | null;
  /** Exact cache-work basis only; a lower bound/conflict/missing/invalid figure cannot supply it. */
  exactCacheWork: number | null;
  priceBasis: 'reported-ttl' | 'no-cache-work' | 'assumed-1h' | 'unknown-ttl' | 'incomplete' | 'conflict' | 'invalid';
}

function known(field: FieldObservation): number {
  return field.state === 'reported' && Number.isSafeInteger(field.value) && field.value >= 0 ? (field.value === 0 ? 0 : field.value) : 0;
}

/** `none` is the conservative default. Tokenelo's DESIGN15.1.4 source fallback must be
 * explicitly requested, and applies only when both TTL fields are missing and their
 * container is not malformed. Partial/explicit-zero residuals are never assigned to 1h. */
export function projectCacheWrites(
  observation: CacheCreationObservation,
  fallbackPolicy: CacheFallbackPolicy = 'none',
): CacheWriteProjection {
  if (fallbackPolicy !== 'none' && fallbackPolicy !== 'assume-1h-if-no-ttl-reported') {
    throw new RangeError('Unsupported cache fallback policy');
  }
  const evidence = reconcileCacheCreation(observation);
  const known5m = known(observation.ephemeral5m), known1h = known(observation.ephemeral1h);
  const exactCacheWork = evidence.total.state === 'reported' ? evidence.total.value : null;
  let assumed1h = 0, unassignedTtl = evidence.unknownTtlResidual;
  const canAssume = fallbackPolicy === 'assume-1h-if-no-ttl-reported'
    && evidence.ttlPartition === 'not-reported'
    && observation.ephemeral5m.state === 'missing' && observation.ephemeral1h.state === 'missing'
    && exactCacheWork !== null;
  if (canAssume) { assumed1h = exactCacheWork; unassignedTtl = 0; }
  const priceBasis: CacheWriteProjection['priceBasis'] = evidence.total.state === 'conflict' ? 'conflict'
    : evidence.total.state === 'invalid' || evidence.ttlPartition === 'invalid' ? 'invalid'
    : exactCacheWork === null ? 'incomplete'
    : exactCacheWork === 0 ? 'no-cache-work'
    : assumed1h > 0 ? 'assumed-1h'
    : (unassignedTtl ?? 0) > 0 ? 'unknown-ttl'
    : 'reported-ttl';
  return { policyVersion: CACHE_WRITE_PROJECTION_VERSION, fallbackPolicy, evidence,
    known5m, known1h, assumed1h, unassignedTtl, exactCacheWork, priceBasis };
}

function maxField(a: FieldObservation, b: FieldObservation): FieldObservation {
  // Invalid is absorbing: resolving it requires an explicit source/order decision outside this policy.
  if (a.state === 'invalid' || b.state === 'invalid') return { state: 'invalid', value: null };
  if (a.state === 'reported' && b.state === 'reported') return { state: 'reported', value: Math.max(a.value, b.value) };
  if (a.state === 'reported') return { ...a };
  if (b.state === 'reported') return { ...b };
  return { state: 'missing', value: null };
}

const CONTAINER_RANK: Record<ContainerState, number> = { absent: 0, null: 1, present: 2, malformed: 3 };

/** Caller establishes same-event/same-component identity; this function does not dedup
 * IDs or infer chronology. Raw numeric field MAX is order-independent. Assumptions and
 * residuals are recomputed afterward, never MAXed as independently reported counts.
 * Contradictory raw TTL maxima remain conflict; no full-row winner or clamp resolves them. */
export function mergeCacheWriteObservations(
  a: CacheCreationObservation, b: CacheCreationObservation,
  fallbackPolicy: CacheFallbackPolicy = 'none',
): { policyVersion: typeof CACHE_SNAPSHOT_MERGE_VERSION; mergedObservation: CacheCreationObservation; projection: CacheWriteProjection } {
  const mergedObservation: CacheCreationObservation = {
    flatTotal: maxField(a.flatTotal, b.flatTotal),
    container: CONTAINER_RANK[a.container] >= CONTAINER_RANK[b.container] ? a.container : b.container,
    ephemeral5m: maxField(a.ephemeral5m, b.ephemeral5m),
    ephemeral1h: maxField(a.ephemeral1h, b.ephemeral1h),
  };
  return { policyVersion: CACHE_SNAPSHOT_MERGE_VERSION, mergedObservation,
    projection: projectCacheWrites(mergedObservation, fallbackPolicy) };
}
