/** Production Claude count adapter. Numeric evidence never validates/replaces model IDs.
 * Parsed JSON only, no identity/content/path capture. Legacy normalized rows cannot recover raw counters. */
import type { EventFlag, TokenCounts, UsageComponent } from '../core/types.js';
import { weakestCountQuality } from '../core/token-counts.js';
import { observeClaudeMessage, type CacheCreationObservation, type FieldObservation } from './claude-observation.js';
import { mergeCacheWriteObservations, projectCacheWrites, type CacheFallbackPolicy, type CacheWriteProjection } from './cache-write-projection.js';
import { supportedNativeCounters } from './native-counter-evidence.js';

export const COMPONENT_COUNT_POLICY = 'tokenelo/claude-component-counts@v2';
export function isSupportedCountPolicy(policy: unknown): boolean {
  return policy === COMPONENT_COUNT_POLICY || policy === 'tokenelo/claude-component-counts@v1';
}
export interface ComponentCountEvidence {
  /** v1 retains the same raw vectors and can be explicitly reprojected on merge. */
  policy: string;
  inputFresh: FieldObservation;
  cacheRead: FieldObservation;
  output: FieldObservation;
  cacheCreation: CacheCreationObservation;
  fallbackPolicy: CacheFallbackPolicy;
  mergeState: 'monotone' | 'incomparable' | 'legacy-mixed';
  /** Distinct content-free counter vectors, bounded; needed to detect a later vector
   * incomparable with an earlier non-maximal snapshot. Aggregate MAX alone loses it. */
  snapshots: CountSnapshot[];
  snapshotLimitExceeded?: true;
  /** Sticky validation evidence also survives truncation of retained vectors. */
  countHistoryInvalid?: true;
  ttlHistoryInvalid?: true;
}
type CountSnapshot = Pick<ComponentCountEvidence, 'inputFresh' | 'cacheRead' | 'output' | 'cacheCreation'>;
const SNAPSHOT_LIMIT = 64;
export const COUNT_EVIDENCE_FLAGS: readonly EventFlag[] = ['countSnapshotsIncomparable', 'countSnapshotsCapped',
  'cacheTtlConflict', 'cacheTtlInvalid', 'cacheTtlUnassigned', 'countBasisIncomplete', 'countBasisInvalid', 'legacyCountEvidenceMixed', 'countPolicyUnsupported'];
export function countEvidenceFlags(components: readonly UsageComponent[]): EventFlag[] {
  const flags = new Set<EventFlag>();
  for (const c of components) {
    const e = c.countEvidence;
    if (c.tokens.countQuality === 'incomplete') flags.add('countBasisIncomplete');
    if (c.tokens.countQuality === 'invalid') flags.add('countBasisInvalid');
    if (!e) {
      if (c.nativeCounterEvidence) {
        if (!supportedNativeCounters(c.nativeCounterEvidence)) {
          flags.add('countPolicyUnsupported'); flags.add('countBasisIncomplete');
        } else {
          if (c.tokens.countQuality === 'conflict') flags.add('countSnapshotsIncomparable');
          if (c.nativeCounterEvidence.historyCapped) flags.add('countSnapshotsCapped');
          if (c.nativeCounterEvidence.legacyMixed) flags.add('legacyCountEvidenceMixed');
        }
      } else if (c.tokens.countQuality === 'incomplete') flags.add('legacyCountEvidenceMixed');
      continue;
    }
    if (!isSupportedCountPolicy(e.policy)) {
      flags.add('countPolicyUnsupported'); flags.add('countBasisIncomplete'); continue;
    }
    const p = componentCountProjection(e);
    if (e.mergeState === 'incomparable') flags.add('countSnapshotsIncomparable');
    if (e.mergeState === 'legacy-mixed') flags.add('legacyCountEvidenceMixed');
    if (e.snapshotLimitExceeded) flags.add('countSnapshotsCapped');
    if (p.cache.priceBasis === 'conflict') flags.add('cacheTtlConflict');
    if (p.cache.priceBasis === 'invalid' || p.ttlHistoryInvalid) flags.add('cacheTtlInvalid');
    if ((p.cache.unassignedTtl ?? 0) > 0) flags.add('cacheTtlUnassigned');
  }
  return COUNT_EVIDENCE_FLAGS.filter(f => flags.has(f));
}

export function captureComponentCounts(raw: Record<string, unknown>): ComponentCountEvidence {
  // Only numeric observations are consumed. Production model/fallback and iteration selection stay in the collector.
  const o = observeClaudeMessage({ usage: raw }).topLevel;
  const counters = { inputFresh: o.inputTokens, cacheRead: o.cacheReadInputTokens,
    output: o.outputTokens, cacheCreation: o.cacheCreation };
  const evidence: ComponentCountEvidence = { policy: COMPONENT_COUNT_POLICY, ...counters,
    fallbackPolicy: 'assume-1h-if-no-ttl-reported', mergeState: 'monotone', snapshots: [counters] };
  // Record sticky invalidity at capture, so the first identical merge does not
  // manufacture new evidence or advance the ledger's materialization revision.
  return { ...evidence,
    ...(invalidCountHistory(evidence) ? { countHistoryInvalid: true as const } : {}),
    ...(invalidTtlHistory(evidence) ? { ttlHistoryInvalid: true as const } : {}) };
}

function count(f: FieldObservation): number {
  return f.state === 'reported' && Number.isSafeInteger(f.value) && f.value >= 0 ? f.value : 0;
}
function quality(f: FieldObservation): NonNullable<TokenCounts['countQuality']> {
  return f.state === 'missing' ? 'incomplete'
    : f.state === 'invalid' || !Number.isSafeInteger(f.value) || f.value < 0 ? 'invalid' : 'complete';
}
function invalidCountHistory(e: ComponentCountEvidence): boolean {
  return !!e.countHistoryInvalid || e.snapshots.some(s => [s.inputFresh, s.cacheRead, s.output, s.cacheCreation.flatTotal]
    .some(f => quality(f) === 'invalid'));
}
function invalidTtlHistory(e: ComponentCountEvidence): boolean {
  return !!e.ttlHistoryInvalid || e.snapshots.some(s => s.cacheCreation.container === 'malformed'
    || [s.cacheCreation.ephemeral5m, s.cacheCreation.ephemeral1h].some(f => quality(f) === 'invalid'));
}
function invalidSubsetHistory(e: ComponentCountEvidence): boolean {
  return e.snapshots.some(s => [s.inputFresh, s.output, s.cacheCreation.flatTotal].some(f => quality(f) === 'invalid'));
}
/** Invalid native observations retain the largest actually reported count for
 * inspection. This does not validate it: the raw invalid state and count quality
 * remain absorbing, and the valuation hold remains independent of this number. */
function inspectableNativeCount(e: ComponentCountEvidence, key: 'inputFresh' | 'cacheRead' | 'output'): number {
  const field = e[key];
  if (field.state !== 'invalid') return count(field);
  return Math.max(0, ...e.snapshots.map(snapshot => count(snapshot[key])));
}
export function componentCountProjection(e: ComponentCountEvidence, reasoning = 0): { tokens: TokenCounts; cache: CacheWriteProjection; ttlHistoryInvalid: boolean } {
  if (!isSupportedCountPolicy(e.policy)) throw new Error('Unsupported count evidence policy');
  const cache = projectCacheWrites(e.cacheCreation, e.fallbackPolicy);
  let subsetQuality = weakestCountQuality(quality(e.inputFresh), quality(e.output));
  const cacheQuality = cache.evidence.total.state === 'reported' ? 'complete'
    : cache.evidence.total.state === 'conflict' ? 'conflict'
    : cache.evidence.issues.some(i => i.endsWith('invalid-for-count') || i === 'ttl-subtotal-out-of-safe-range') ? 'invalid' : 'incomplete';
  subsetQuality = weakestCountQuality(subsetQuality, cacheQuality);
  let countQuality = weakestCountQuality(subsetQuality, quality(e.cacheRead));
  if (e.mergeState === 'incomparable') countQuality = 'conflict';
  if (e.mergeState === 'legacy-mixed') countQuality = weakestCountQuality(countQuality, 'incomplete');
  if (e.snapshotLimitExceeded) countQuality = weakestCountQuality(countQuality, 'incomplete');
  if (invalidCountHistory(e)) countQuality = weakestCountQuality(countQuality, 'invalid');
  if (e.mergeState === 'incomparable') subsetQuality = 'conflict';
  if (e.mergeState === 'legacy-mixed' || e.snapshotLimitExceeded) subsetQuality = weakestCountQuality(subsetQuality, 'incomplete');
  if (invalidSubsetHistory(e)) subsetQuality = weakestCountQuality(subsetQuality, 'invalid');
  const tokens: TokenCounts = { inputFresh: inspectableNativeCount(e, 'inputFresh'), cacheRead: inspectableNativeCount(e, 'cacheRead'), output: inspectableNativeCount(e, 'output'),
    cacheWrite5m: cache.known5m, cacheWrite1h: cache.known1h + cache.assumed1h,
    cacheWriteUnassigned: cache.unassignedTtl ?? 0, cacheWriteAssumed1h: cache.assumed1h,
    reasoning: Math.min(Math.max(0, reasoning), inspectableNativeCount(e, 'output')), countQuality };
  if (!Number.isSafeInteger(tokens.inputFresh + tokens.cacheRead + tokens.output + tokens.cacheWrite5m + tokens.cacheWrite1h + (tokens.cacheWriteUnassigned ?? 0)))
    tokens.countQuality = weakestCountQuality(countQuality, 'invalid');
  if (!Number.isSafeInteger(tokens.inputFresh + tokens.output + tokens.cacheWrite5m + tokens.cacheWrite1h + (tokens.cacheWriteUnassigned ?? 0)))
    subsetQuality = weakestCountQuality(subsetQuality, 'invalid');
  if (subsetQuality !== tokens.countQuality) tokens.ucuCountQuality = subsetQuality;
  return { cache, tokens, ttlHistoryInvalid: invalidTtlHistory(e) };
}

function maxField(a: FieldObservation, b: FieldObservation): FieldObservation {
  if (a.state === 'invalid' || b.state === 'invalid') return { state: 'invalid', value: null };
  if (a.state === 'reported' && b.state === 'reported') return { state: 'reported', value: Math.max(a.value, b.value) };
  return a.state === 'reported' ? { ...a } : { ...b };
}
/** Check full reported counter vectors before raw MAX. Missing values/assumptions are not zeros.
 * Any pair with opposing movement is absorbing conflict; order is not inferred from file timestamps. */
function incomparable(a: CountSnapshot, b: CountSnapshot): boolean {
  const aa = [a.inputFresh, a.cacheRead, a.output, a.cacheCreation.flatTotal, a.cacheCreation.ephemeral5m, a.cacheCreation.ephemeral1h];
  const bb = [b.inputFresh, b.cacheRead, b.output, b.cacheCreation.flatTotal, b.cacheCreation.ephemeral5m, b.cacheCreation.ephemeral1h];
  let up = false, down = false;
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i]!, y = bb[i]!;
    if (x.state !== 'reported' || y.state !== 'reported') continue;
    up ||= y.value > x.value; down ||= y.value < x.value;
  }
  return up && down;
}
export function mergeComponentCounts(a: UsageComponent, b: UsageComponent, keepB: boolean): UsageComponent {
  const ae = a.countEvidence, be = b.countEvidence;
  if (!ae || !be) throw new Error('Raw component evidence required on both snapshots');
  if (!isSupportedCountPolicy(ae.policy) || !isSupportedCountPolicy(be.policy))
    throw new Error('Unsupported count evidence policy');
  const cache = mergeCacheWriteObservations(ae.cacheCreation, be.cacheCreation, ae.fallbackPolicy);
  const mergeState = ae.mergeState === 'incomparable' || be.mergeState === 'incomparable'
      || ae.snapshots.some(x => be.snapshots.some(y => incomparable(x, y)))
    ? 'incomparable' : ae.mergeState === 'legacy-mixed' || be.mergeState === 'legacy-mixed' || ae.fallbackPolicy !== be.fallbackPolicy
      ? 'legacy-mixed' : 'monotone';
  const distinct = new Map([...ae.snapshots, ...be.snapshots].map(s => [JSON.stringify(s), s]));
  const snapshots = [...distinct].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, s]) => s).slice(0, SNAPSHOT_LIMIT);
  const countEvidence: ComponentCountEvidence = { policy: COMPONENT_COUNT_POLICY,
    inputFresh: maxField(ae.inputFresh, be.inputFresh), cacheRead: maxField(ae.cacheRead, be.cacheRead),
    output: maxField(ae.output, be.output), cacheCreation: cache.mergedObservation,
    fallbackPolicy: ae.fallbackPolicy, mergeState, snapshots,
    ...(invalidCountHistory(ae) || invalidCountHistory(be) ? { countHistoryInvalid: true as const } : {}),
    ...(invalidTtlHistory(ae) || invalidTtlHistory(be) ? { ttlHistoryInvalid: true as const } : {}),
    ...(ae.snapshotLimitExceeded || be.snapshotLimitExceeded || distinct.size > SNAPSHOT_LIMIT ? { snapshotLimitExceeded: true as const } : {}) };
  const tokens = componentCountProjection(countEvidence, Math.max(a.tokens.reasoning, b.tokens.reasoning)).tokens;
  // A bounded raw history can discard an earlier maximum. Keep its normalized
  // inspection value on invalid fields without fabricating a reported vector.
  for (const key of ['inputFresh', 'cacheRead', 'output'] as const) {
    if (countEvidence[key].state !== 'invalid') continue;
    const prior = [a.tokens[key], b.tokens[key]].filter(value => Number.isSafeInteger(value) && value >= 0);
    tokens[key] = Math.max(tokens[key], ...prior);
  }
  if (countEvidence.output.state === 'invalid') tokens.reasoning = Math.min(tokens.output, Math.max(a.tokens.reasoning, b.tokens.reasoning));
  return { ...(keepB ? b : a), countEvidence, tokens };
}
