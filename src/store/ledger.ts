/**
 * SqliteLedger: the `LedgerWriter` (core/types.ts) implementation backing the events/activity/
 * limits/skipped/ingest_state tables created by migrations.ts.
 *
 * `upsertEvents` (DESIGN §15.1.2, task spec):
 *   - keyed by `id`; when a row for `id` already exists, each token field
 *     (inputFresh/cacheWrite5m/cacheWrite1h/cacheRead/output/reasoning) is the PER-FIELD MAX of
 *     the stored and incoming value — never a sum, never first-seen-wins.
 *   - `components` (and every other descriptive field: model/provider/effort/speed/
 *     serviceTier/inferenceGeo/entrypoint/project/repoRoot/gitBranch/tsSource/ts/durationMs/
 *     flags) follows the larger-output line. Claude session conflicts retain recorded
 *     ownership and economic context separately, with explicit provenance flags.
 *   - derived fields (apiEquivUsd, priceStatus, priceVersion) are then RECOMPUTED from the
 *     *merged* row's kept `components`, using the injected PricingEngine for new or changed
 *     measurement inputs. Ordinary replay retains the stored valuation; only explicit CLI
 *     reprice refreshes unchanged inputs. The reserved compatibility columns (the valuation
 *     value, rate status, definition hash and rate selection) are never computed here: a new
 *     row gets the injected valuation seam's neutral values, a stored row keeps its own values
 *     while its measurement inputs are unchanged (explicit reprice included) and withdraws them
 *     to unknown when an input changes.
 *   - the whole batch runs in one transaction; returns {inserted, updated, unchanged}.
 */
import { createHash } from 'node:crypto';
import type {
  ActivityMark,
  CodexContextCheckpointRecoveryCandidate,
  DesktopSessionMeta,
  ValuationEngine,
  EventFlag,
  EventUpsertOptions,
  HostLabel,
  IngestState,
  LedgerWriter,
  LimitSnapshot,
  PricingEngine,
  Provider,
  SkipReason,
  Source,
  TokenCounts,
  UsageComponent,
  UsageEvent,
} from '../core/types.js';
import { isCanonicalCodexSessionId, isStructurallyBoundCodexContextState, isUnownedCodexContextState } from '../core/codex-context-recovery.js';
import { withTransaction, type TokeneloDb } from './db.js';
import { addTokenCounts, hasInvalidTokenValues, hasUnresolvedCounts, hasUnresolvedSubsetCounts, normalizeCountQuality, subsetCountQuality, weakestCountQuality } from '../core/token-counts.js';
import { nativeTokenFieldCoverage } from '../core/token-field-evidence.js';
import { COMPONENT_COUNT_POLICY, mergeComponentCounts, COUNT_EVIDENCE_FLAGS, countEvidenceFlags, isSupportedCountPolicy } from '../measurement/component-count-evidence.js';
import { mergeNativeCounters, nativeCounterProjection, supportedNativeCounters } from '../measurement/native-counter-evidence.js';
import { canonicalizeComponentRoute, componentRouteState, mergeComponentRoute } from '../core/serving-route.js';
import { isDeepStrictEqual } from 'node:util';

const PRICE_FLAGS: readonly EventFlag[] = ['unpricedModel', 'longContextBracket', 'priceTierUnsupported', 'priceContextInvalid', 'servingRouteUnpriced'];

/** The provider classification a fresh valuation records; shared by maintenance
 * preview and write so a reporting-category change is disclosed before writing. */
export function providerForValuation(event: Pick<UsageEvent, 'components' | 'provider' | 'flags'>,
  pricing: Pick<PricingEngine, 'providerOf'>): Provider {
  if (event.flags.includes('servingRouteMisaligned')) return 'unknown';
  if (!event.components.some(c => componentRouteState(c) !== 'unrecorded')) return event.provider;
  const providers = new Set(event.components.map(c => pricing.providerOf(c.model, c.servingRoute)));
  return providers.size === 1 ? [...providers][0]! : 'unknown';
}

/** Ignore omitted optional object keys without converting NaN/Infinity into JSON null. */
function definedValue(value: unknown): unknown {
  if (Object.is(value, -0)) return 0; // JSON/SQLite store this valid count/context as zero.
  if (Array.isArray(value)) return value.map(definedValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).map(([k, v]) => [k, definedValue(v)]));
  return value;
}

/** Tables/definitions are not new measurements. Retain provenance for the recorded basis.
 * Counts, count policy/history, request context, thinking/effort/geography and a route-misalignment
 * hold may change either economic result. A route report is retained as evidence but does not
 * refresh a historical valuation during ordinary replay; explicit reprice is the reviewed refresh.
 * Descriptive ownership/project/provider updates alone must not apply today's table to old work.
 */
function sameValuationInputs(a: UsageEvent, b: UsageEvent): boolean {
  const tokens = (t: TokenCounts) => {
    // Row projection omits an override equal to countQuality. Compare its effective
    // meaning so equivalent explicit/implicit quality cannot refresh provenance.
    // Read-side coverage is disclosure, never a new observation or authority to
    // apply today's prices/calibration to unchanged historical work.
    const { ucuCountQuality: _override, fieldEvidence: _readCoverage, ...counts } = definedValue(t) as TokenCounts;
    return { cacheWriteUnassigned: 0, cacheWriteAssumed1h: 0, ...counts,
      ucuCountQuality: t.countQuality || t.ucuCountQuality ? subsetCountQuality(t) : null };
  };
  const basis = (e: UsageEvent) => ({
    tokens: tokens(e.tokens),
    components: e.components.map(c => {
      // A newly observed route is classification evidence, not permission to rewrite the stored
      // historical price. It remains on the merged component and is applied by explicit
      // reprice. Fresh-row admission policy is unchanged by this retention rule.
      const { servingRoute: _servingRoute, codexFieldStateEvidence: _codexFieldStateEvidence, ...component } = definedValue(c) as Record<string, unknown>;
      return { ...component, speed: c.speed ?? 'standard', tokens: tokens(c.tokens),
        // JSON persists non-finite request sizes as null. Both forms are invalid,
        // distinct from omitted context; pricing must never treat null as absent.
        ...(c.requestInput === undefined ? {} : { requestInput:
          typeof c.requestInput === 'number' && !Number.isFinite(c.requestInput) ? null : definedValue(c.requestInput) }),
      };
    }),
    inferenceGeo: e.inferenceGeo ?? null, effort: e.effort ?? null, thinking: e.thinking ?? null,
    servingRouteMisaligned: e.flags.includes('servingRouteMisaligned'),
  });
  return isDeepStrictEqual(basis(a), basis(b));
}

/** Codex field-state metadata is first-seen only: do not backfill old rows or replace the first observation on replay. */
function retainFirstSeenCodexFieldState(stored: UsageEvent | undefined, merged: UsageEvent): UsageEvent {
  if (!stored) return merged;
  const mappingProven = stored.source === 'codex' && merged.source === 'codex'
    && !stored.flags.includes('mergedComponentsMisaligned')
    && !merged.flags.includes('mergedComponentsMisaligned')
    && stored.components.length === merged.components.length
    && stored.components.every((component, index) => {
      const incoming = merged.components[index];
      return incoming !== undefined && component.model === incoming.model && component.speed === incoming.speed;
    });
  const components = merged.components.map((component, index) => {
    const { codexFieldStateEvidence: _incomingEvidence, ...withoutIncoming } = component;
    if (!mappingProven) return withoutIncoming;
    const first = stored.components[index]?.codexFieldStateEvidence;
    return first ? { ...withoutIncoming, codexFieldStateEvidence: first } : withoutIncoming;
  });
  return { ...merged, components };
}

/** 2^53 − 1: IngestState.ino must be a JS safe integer (types.ts note; NTFS ids exceed 2^53). */
const SAFE_INO_MOD = 9007199254740991n;

/** Reduces any integer-ish ino to a safe integer (`BigInt(ino) % (2^53 − 1)`); identity for safe values. */
function normalizeIno(ino: number | bigint): number {
  if (typeof ino === 'number' && Number.isSafeInteger(ino)) return ino;
  if (typeof ino === 'number' && !Number.isFinite(ino)) return 0;
  return Number(BigInt(typeof ino === 'number' ? Math.trunc(ino) : ino) % SAFE_INO_MOD);
}

/** node:sqlite INTEGER read with setReadBigInts(true) → number (throws only if genuinely beyond 2^53, which size/offset never are). */
function bigToNumber(v: number | bigint | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`ingest_state integer ${v} exceeds 2^53`);
  }
  return Number(v);
}

/** Reads cursor numeric columns without silently replacing unsupported stored values with zero. */
function checkedIngestStateNumber(value: number | bigint | null): number {
  try {
    const number = bigToNumber(value);
    if (number === null) throw new RangeError();
    return number;
  } catch {
    throw new RangeError('invalid ingest_state cursor');
  }
}

// ── row <-> UsageEvent mapping ─────────────────────────────────────────────

interface EventRow {
  id: string;
  host: string;
  source: string;
  ts: number;
  ts_source: string;
  session_id: string;
  parent_session_id: string | null;
  is_subagent: number;
  project: string | null;
  repo_root: string | null;
  git_branch: string | null;
  entrypoint: string | null;
  model: string;
  provider: string;
  engine: string | null;
  effort: string | null;
  speed: string | null;
  service_tier: string | null;
  inference_geo: string | null;
  components_json: string;
  input_fresh: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_unassigned?: number | null;
  cache_write_assumed_1h?: number | null;
  count_quality?: TokenCounts['countQuality'] | null;
  ucu_count_quality?: TokenCounts['countQuality'] | null;
  count_policy?: string | null;
  count_revision?: number | null;
  cache_read: number;
  output: number;
  reasoning: number;
  duration_ms: number | null;
  flags_json: string;
  api_equiv_usd: number | null;
  price_status: string;
  price_version: string;
  ucu: number | null;
  ucu_rate_status: string;
  eacs_def_sha256: string;
  rate_key?: string | null;
  rate_resolved_sha256?: string | null;
  perf_json?: string | null;
  thinking: number | null;
}

/** Narrow classification for a read-side hold; strict detail/ledger reads still reject. */
export class StoredComponentEvidenceError extends Error {
  constructor() {
    super('Stored component evidence is malformed; complete usage attribution is unavailable');
    this.name = 'StoredComponentEvidenceError';
  }
}

/** Maps one `events` row (SELECT *) back to a UsageEvent. Shared with store/queries.ts. */
function legacyMixedTokenCounts(tokens: TokenCounts): TokenCounts {
  const countQuality = weakestCountQuality(tokens.countQuality, 'incomplete');
  const subsetQuality = weakestCountQuality(subsetCountQuality(tokens), 'incomplete');
  const projected = { ...tokens, countQuality };
  delete projected.ucuCountQuality;
  if (subsetQuality !== countQuality) projected.ucuCountQuality = subsetQuality;
  return projected;
}

export function rowToEvent(row: EventRow): UsageEvent {
  // Detail/ledger reads need complete attribution and retain their fail-closed
  // contract. Aggregate reads separately qualify unusable component evidence.
  let parsed: unknown;
  try { parsed = JSON.parse(row.components_json); }
  catch { throw new StoredComponentEvidenceError(); }
  if (!Array.isArray(parsed) || parsed.some(c => !c || typeof c !== 'object' || !c.tokens || typeof c.tokens !== 'object'))
    throw new StoredComponentEvidenceError();
  const components = parsed as UsageComponent[];
  const event: UsageEvent = {
    id: row.id,
    host: row.host,
    source: row.source as Source,
    ts: row.ts,
    tsSource: row.ts_source as UsageEvent['tsSource'],
    sessionId: row.session_id,
    parentSessionId: row.parent_session_id ?? undefined,
    isSubagent: row.is_subagent !== 0,
    project: row.project ?? undefined,
    repoRoot: row.repo_root ?? undefined,
    gitBranch: row.git_branch ?? undefined,
    entrypoint: row.entrypoint ?? undefined,
    model: row.model,
    provider: row.provider as Provider,
    engine: row.engine ?? undefined,
    effort: row.effort ?? undefined,
    thinking: row.thinking === null || row.thinking === undefined ? null : row.thinking !== 0,
    speed: (row.speed as UsageEvent['speed']) ?? undefined,
    serviceTier: row.service_tier ?? undefined,
    inferenceGeo: row.inference_geo ?? undefined,
    components,
    tokens: {
      inputFresh: row.input_fresh,
      cacheWrite5m: row.cache_write_5m,
      cacheWrite1h: row.cache_write_1h,
      cacheRead: row.cache_read,
      output: row.output,
      reasoning: row.reasoning,
    },
    durationMs: row.duration_ms ?? undefined,
    flags: JSON.parse(row.flags_json) as UsageEvent['flags'],
    apiEquivUsd: row.api_equiv_usd,
    priceStatus: row.price_status as UsageEvent['priceStatus'],
    priceVersion: row.price_version,
    reservedValue: row.ucu,
    ucuRateStatus: row.ucu_rate_status as UsageEvent['ucuRateStatus'],
    eacsDefSha256: row.eacs_def_sha256,
    rateKey: row.rate_key ?? null,
    rateResolvedSha256: row.rate_resolved_sha256 ?? null,
  };
  if (row.cache_write_unassigned !== null && row.cache_write_unassigned !== undefined) event.tokens.cacheWriteUnassigned = row.cache_write_unassigned;
  if (row.cache_write_assumed_1h !== null && row.cache_write_assumed_1h !== undefined) event.tokens.cacheWriteAssumed1h = row.cache_write_assumed_1h;
  if (row.count_quality !== null && row.count_quality !== undefined) event.tokens.countQuality = normalizeCountQuality(row.count_quality);
  if (row.ucu_count_quality !== null && row.ucu_count_quality !== undefined) {
    const subsetQuality = normalizeCountQuality(row.ucu_count_quality);
    if (subsetQuality !== normalizeCountQuality(event.tokens.countQuality)) event.tokens.ucuCountQuality = subsetQuality;
  }
  if (row.count_revision == null && event.components.some(c => c.countEvidence || c.nativeCounterEvidence)) {
    // Raw JSON retained by a legacy writer is not proof its normalized columns agree.
    event.tokens = legacyMixedTokenCounts(event.tokens);
    event.components = event.components.map(c => c.nativeCounterEvidence ? { ...c,
      nativeCounterEvidence: { ...c.nativeCounterEvidence, legacyMixed: true },
      tokens: legacyMixedTokenCounts(c.tokens) } : c.countEvidence ? { ...c,
      countEvidence: isSupportedCountPolicy(c.countEvidence.policy)
        ? { ...c.countEvidence, mergeState: 'legacy-mixed' } : c.countEvidence,
      tokens: legacyMixedTokenCounts(c.tokens) } : c);
  }
  const fieldEvidence = nativeTokenFieldCoverage(event.components, event.tokens);
  if (fieldEvidence) event.tokens.fieldEvidence = fieldEvidence;
  if (row.perf_json) event.perf = JSON.parse(row.perf_json) as UsageEvent['perf'];
  return event;
}

export type { EventRow };

/** Qualify the actual component speeds used by pricing, including initial inserts. */
function qualifyClaudePricedSpeed(flags: EventFlag[], components: readonly UsageComponent[], source: UsageEvent['source']): void {
  if (source !== 'claude') return;
  const index = flags.indexOf('speedAssumed');
  const assumed = components.some(c => c.speed == null);
  if (!assumed && index >= 0) flags.splice(index, 1);
  if (assumed && index < 0) flags.push('speedAssumed');
}

/**
 * Merge duplicate observations using per-component MAX where identities align.
 * Supported native raw evidence may refine TTL categories; invalid observations
 * retain inspectable maxima with their holds. An unexplained legacy aggregate
 * keeps event-level MAX in either direction and is qualified, never resummed
 * into validated work. Misaligned components retain the winner with a gap flag.
 * Descriptive fields come from the kept line; thinking is merged by mergeThinking.
 * A Claude duplicate claiming a different session retains the stored session,
 * recorded timestamp and path attribution, independently of the count winner.
 * This is recorded ownership, not proof of original ownership. Conflicts remain
 * disclosed on subsequent merges; counts/components still follow the MAX rule.
 */
export function mergeDuplicateEvent(stored: UsageEvent, incoming: UsageEvent): UsageEvent {
  const incomingWins = incoming.tokens.output >= stored.tokens.output;
  const kept = incomingWins ? incoming : stored;
  const claude = stored.source === 'claude' && incoming.source === 'claude';
  const conflictingSession = claude && !!stored.sessionId && !!incoming.sessionId
    && stored.sessionId !== incoming.sessionId;
  const missingIncomingSession = claude && !!stored.sessionId && !incoming.sessionId;
  const enrichedSession = claude && !stored.sessionId && !!incoming.sessionId;
  const ownerContextArrived = claude && !!incoming.sessionId && incoming.sessionId === stored.sessionId
    && stored.flags.includes('sessionContextUnrecorded');
  const joinedCopy = enrichedSession && incoming.flags.includes('sessionAttributionConflict');
  const ownership = conflictingSession || missingIncomingSession ? {
    host: stored.host, ts: stored.ts, tsSource: stored.tsSource,
    sessionId: stored.sessionId, parentSessionId: stored.parentSessionId,
    isSubagent: stored.isSubagent, project: stored.project,
    repoRoot: stored.repoRoot, gitBranch: stored.gitBranch, entrypoint: stored.entrypoint,
  } : enrichedSession ? {
    host: incoming.host, ts: incoming.ts, tsSource: incoming.tsSource,
    sessionId: incoming.sessionId, parentSessionId: incoming.parentSessionId,
    isSubagent: incoming.isSubagent, project: incoming.project,
    repoRoot: incoming.repoRoot, gitBranch: incoming.gitBranch, entrypoint: incoming.entrypoint,
  } : ownerContextArrived ? {
    // Context reported by the recorded owner is independent of count growth.
    // A smaller snapshot can identify its parent/role without reducing usage.
    parentSessionId: incoming.isSubagent ? incoming.parentSessionId ?? stored.parentSessionId : undefined,
    isSubagent: incoming.isSubagent, project: incoming.project ?? stored.project,
    repoRoot: incoming.repoRoot ?? stored.repoRoot,
    gitBranch: incoming.gitBranch ?? stored.gitBranch, entrypoint: incoming.entrypoint ?? stored.entrypoint,
  } : {};
  const attributionConflict = conflictingSession || stored.flags.includes('sessionAttributionConflict')
    || incoming.flags.includes('sessionAttributionConflict');
  const economicContext = conflictingSession || missingIncomingSession ? {
    effort: stored.effort, inferenceGeo: stored.inferenceGeo,
    serviceTier: stored.serviceTier, speed: stored.speed,
  } : joinedCopy ? {
    // The UUID activity join identifies a recorded owner but does not turn
    // the conflicting copy into owner-reported economic evidence.
    effort: stored.effort ?? incoming.effort, inferenceGeo: stored.inferenceGeo ?? incoming.inferenceGeo,
    serviceTier: stored.serviceTier ?? incoming.serviceTier, speed: stored.speed ?? incoming.speed,
  } : ownerContextArrived || enrichedSession ? {
    // Absence is not a report that a previously observed value disappeared.
    // Owner evidence may replace a value, but missing fields retain their
    // reported context and its existing attribution qualifications.
    effort: incoming.effort ?? stored.effort, inferenceGeo: incoming.inferenceGeo ?? stored.inferenceGeo,
    serviceTier: incoming.serviceTier ?? stored.serviceTier,
    // Incoming is a raw collector observation: its speedAssumed flag describes
    // top-level evidence. Persisted flags describe priced components instead;
    // callers of this exported merge must not use them as raw observations.
    // The collector materializes missing speed as assumed standard. That is
    // still missing evidence, not a report that explicitly known fast changed.
    speed: incoming.flags.includes('speedAssumed') ? stored.speed ?? incoming.speed : incoming.speed ?? stored.speed,
  } : {};
  const metadataFlags: EventFlag[] = [...kept.flags];
  for (const flag of ['sessionContextUnrecorded', 'sessionAttributionEnriched'] as const)
    if ((stored.flags.includes(flag) || incoming.flags.includes(flag)) && !metadataFlags.includes(flag)) metadataFlags.push(flag);
  if (enrichedSession && !metadataFlags.includes('sessionAttributionEnriched')) metadataFlags.push('sessionAttributionEnriched');
  const aligned = alignComponents(stored.components, incoming.components, incomingWins);
  qualifyClaudePricedSpeed(metadataFlags, aligned ?? kept.components, claude ? 'claude' : kept.source);
  const thinking = mergeThinking(stored.thinking, incoming.thinking);
  const flags = withThinkingFlag(attributionConflict && !metadataFlags.includes('sessionAttributionConflict')
    ? [...metadataFlags, 'sessionAttributionConflict'] : metadataFlags, thinking);
  // A row already flagged mergedComponentsMisaligned keeps its proven field-wise MAX tokens on every later merge, even when its components
  // line up on a re-merge (reprice, re-ingest). Summing the kept components would drop those fields while the flag still claims a gap (P2-1).
  const flaggedMisaligned = stored.flags.includes('mergedComponentsMisaligned') || incoming.flags.includes('mergedComponentsMisaligned');
  const routeMisaligned = stored.flags.includes('servingRouteMisaligned') || incoming.flags.includes('servingRouteMisaligned')
    || ((!aligned || flaggedMisaligned) && [...stored.components,...incoming.components].some(c=>componentRouteState(c)!=='unrecorded'));
  if(routeMisaligned&&!flags.includes('servingRouteMisaligned'))flags.push('servingRouteMisaligned');
  if (aligned && !flaggedMisaligned) {
    const hasCountEvidence = aligned.some(c => c.countEvidence && isSupportedCountPolicy(c.countEvidence.policy));
    const assumed = aligned.some(c => (c.tokens.cacheWriteAssumed1h ?? 0) > 0);
    const correctedFlags = hasCountEvidence && !assumed ? flags.filter(f => f !== 'cacheSplitAssumed')
      : hasCountEvidence && assumed && !flags.includes('cacheSplitAssumed') ? [...flags, 'cacheSplitAssumed' as const] : flags;
    if (aligned.some(c => c.countEvidence && !isSupportedCountPolicy(c.countEvidence.policy))) {
      // An opaque component cannot explain an older writer's changed columns.
      // Retain their inspectable MAX instead of silently replacing them with a
      // stale component sum; neither numeric basis is certified as complete.
      const tokens = maxTokens(stored.tokens, incoming.tokens);
      return { ...kept, ...ownership, ...economicContext, id: incoming.id, components: aligned,
        tokens: { ...tokens, countQuality: weakestCountQuality(tokens.countQuality, 'incomplete'),
          ucuCountQuality: weakestCountQuality(subsetCountQuality(tokens), 'incomplete') }, thinking, flags: correctedFlags };
    }
    const projected = sumComponentTokens(aligned);
    const maximum = maxTokens(stored.tokens, incoming.tokens);
    const numericKeys = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning',
      'cacheWriteUnassigned', 'cacheWriteAssumed1h'] as const;
    const coherent = (event: UsageEvent) => {
      const sum = sumComponentTokens(event.components);
      return numericKeys.every(key => (event.tokens[key] ?? 0) === (sum[key] ?? 0));
    };
    // Raw native evidence can legitimately reproject an assumed TTL category.
    // An incoherent stored aggregate or older normalized writer cannot prove
    // that its larger event counter disappeared, even when models still align.
    const nativeProjection = coherent(stored) && coherent(incoming)
      && !stored.flags.includes('legacyCountEvidenceMixed') && !incoming.flags.includes('legacyCountEvidenceMixed')
      && [...stored.components, ...incoming.components].every(c =>
        c.countEvidence && isSupportedCountPolicy(c.countEvidence.policy) && c.countEvidence.mergeState !== 'legacy-mixed'
        || c.nativeCounterEvidence && supportedNativeCounters(c.nativeCounterEvidence) && !c.nativeCounterEvidence.legacyMixed);
    const ttlKeys: readonly typeof numericKeys[number][] = ['cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnassigned', 'cacheWriteAssumed1h'];
    if (!nativeProjection) {
      // Numerically coherent legacy/imported columns do not validate an
      // event-level hold that its components did not record. Preserve both
      // overall and fresh/output subset qualifications independently.
      // Capture the component subset qualification before an overall hold is folded:
      // cache/overall uncertainty must not erase independently complete fresh work.
      const componentOverall = projected.countQuality;
      const componentSubset = projected.ucuCountQuality ?? componentOverall;
      // addTokenCounts derives unrecorded for a mixed qualified/absent component
      // fold. An identical observation cannot use that synthetic absence to
      // downgrade a recorded event claim or implicitly refresh its economics.
      // Explicit unrecorded component evidence still participates.
      const sameObservedBasis = sameValuationInputs(stored, incoming);
      const explicitUnrecorded = [...stored.components, ...incoming.components]
        .some(c => c.tokens.countQuality === 'unrecorded');
      const explicitSubsetUnrecorded = [...stored.components, ...incoming.components]
        .some(c => (c.tokens.ucuCountQuality ?? c.tokens.countQuality) === 'unrecorded');
      const omitSyntheticOverall = sameObservedBasis && !explicitUnrecorded && componentOverall === 'unrecorded';
      const omitSyntheticSubset = sameObservedBasis && !explicitSubsetUnrecorded && componentSubset === 'unrecorded';
      // A stored legacy event supplies unrecorded evidence, even when the
      // incoming claim is complete: its smaller counter cannot certify retained
      // maxima which that incoming observation never reported.
      const overall = [omitSyntheticOverall ? undefined : componentOverall,
        stored.tokens.countQuality ?? 'unrecorded', incoming.tokens.countQuality]
        .filter((q): q is NonNullable<TokenCounts['countQuality']> => q !== undefined);
      const overallQuality = overall.reduce(weakestCountQuality);
      if (overallQuality === 'unrecorded' && componentOverall === undefined && stored.tokens.countQuality === undefined) {
        // Keep legacy absence represented as absence. Materializing a literal
        // unrecorded claim would change valuation inputs on an identical MAX
        // and silently apply today's pricing to the retained larger observation.
        delete projected.countQuality;
      } else if (stored.tokens.countQuality || incoming.tokens.countQuality || componentOverall !== undefined) {
        projected.countQuality = overallQuality;
      }
      const subsetQualities = [omitSyntheticSubset ? undefined : componentSubset,
        stored.tokens.ucuCountQuality ?? stored.tokens.countQuality ?? 'unrecorded',
        incoming.tokens.ucuCountQuality ?? incoming.tokens.countQuality]
        .filter((q): q is NonNullable<TokenCounts['countQuality']> => q !== undefined);
      const quality = subsetQualities.reduce(weakestCountQuality);
      if (quality !== (projected.countQuality ?? 'unrecorded')) projected.ucuCountQuality = quality;
      else delete projected.ucuCountQuality;
    }
    const incoherentLegacy = !nativeProjection && (!coherent(stored) || !coherent(incoming)
      || hasInvalidTokenValues(stored.tokens) || hasInvalidTokenValues(incoming.tokens));
    const unexplainedMaximum = incoherentLegacy || numericKeys.some(key =>
      (!nativeProjection || !ttlKeys.includes(key)) && ((maximum[key] ?? 0) > (projected[key] ?? 0)
        || !Number.isFinite(maximum[key] ?? 0)));
    if (unexplainedMaximum) {
      // Preserve event-level MAX in either direction of an unexplained legacy
      // discrepancy. A component sum cannot validate or replace that measurement.
      const tokens = incoherentLegacy ? maximum : maxTokens(maximum, projected);
      const quality = hasInvalidTokenValues(tokens) ? 'invalid' : 'incomplete';
      const components = aligned.map(c => ({ ...c,
        ...(c.countEvidence ? { countEvidence: { ...c.countEvidence, mergeState: 'legacy-mixed' as const } } : {}),
        tokens: { ...c.tokens, countQuality: weakestCountQuality(c.tokens.countQuality, 'incomplete'),
          ucuCountQuality: weakestCountQuality(subsetCountQuality(c.tokens), 'incomplete') } }));
      return { ...kept, ...ownership, ...economicContext, id: incoming.id, components,
        tokens: { ...tokens, countQuality: weakestCountQuality(tokens.countQuality, quality),
          ucuCountQuality: weakestCountQuality(subsetCountQuality(tokens), quality) }, thinking, flags: correctedFlags };
    }
    return { ...kept, ...ownership, ...economicContext, id: incoming.id, components: aligned, tokens: projected, thinking, flags: correctedFlags };
  }
  // Misaligned (different model or speed per component): the contract field-wise MAX of the event tokens is kept, so no proven field is
  // lost. Components stay the kept line's (the winner rule). The flag makes the gap between tokens and kept components visible.
  return {
    ...kept,
    ...ownership,
    ...economicContext,
    id: incoming.id,
    tokens: { ...maxTokens(stored.tokens, incoming.tokens), ...((stored.tokens.countQuality || incoming.tokens.countQuality) ? { countQuality: 'conflict' as const, ucuCountQuality: 'conflict' as const } : {}) },
    thinking,
    flags: [...flags.filter((f) => f !== 'mergedComponentsMisaligned'), 'mergedComponentsMisaligned'],
  };
}

function alignComponents(a: UsageComponent[], b: UsageComponent[], keepBBase: boolean): UsageComponent[] | null {
  if (a.length !== b.length) return null;
  const out: UsageComponent[] = [];
  for (let i = 0; i < a.length; i++) {
    const ca = a[i]!;
    const cb = b[i]!;
    // A single raw component can acquire an explicit standard speed in a later
    // streaming snapshot. The collector already uses standard as its absent-speed
    // fallback; this does not turn unknown speed into fast or reconcile distinct
    // models/iteration slots. Keep the winning component's metadata and assumptions.
    const standardEnrichment = a.length === 1 && ca.countEvidence && cb.countEvidence
      && isSupportedCountPolicy(ca.countEvidence.policy) && isSupportedCountPolicy(cb.countEvidence.policy)
      && ((ca.speed == null && cb.speed === 'standard') || (cb.speed == null && ca.speed === 'standard'));
    if (ca.model !== cb.model || ((ca.speed ?? null) !== (cb.speed ?? null) && !standardEnrichment)) return null;
    if (ca.countEvidence && !isSupportedCountPolicy(ca.countEvidence.policy) || cb.countEvidence && !isSupportedCountPolicy(cb.countEvidence.policy)) {
      // Opaque evidence is retained, never reinterpreted as the current version.
      const base = keepBBase ? cb : ca;
      const unknown = ca.countEvidence && !isSupportedCountPolicy(ca.countEvidence.policy) ? ca.countEvidence : cb.countEvidence;
      out.push({ ...base, countEvidence: unknown,
        tokens: { ...base.tokens, ...maxTokens(ca.tokens, cb.tokens), countQuality: 'incomplete', ucuCountQuality: 'incomplete' } });
    } else if (ca.nativeCounterEvidence && !supportedNativeCounters(ca.nativeCounterEvidence)
      || cb.nativeCounterEvidence && !supportedNativeCounters(cb.nativeCounterEvidence)) {
      const base = keepBBase ? cb : ca;
      const opaque = ca.nativeCounterEvidence && !supportedNativeCounters(ca.nativeCounterEvidence)
        ? ca.nativeCounterEvidence : cb.nativeCounterEvidence;
      out.push({ ...base, nativeCounterEvidence: opaque,
        tokens: { ...maxTokens(ca.tokens, cb.tokens), countQuality: 'incomplete', ucuCountQuality: 'incomplete' } });
    } else if (ca.nativeCounterEvidence && cb.nativeCounterEvidence) {
      const nativeCounterEvidence = mergeNativeCounters(ca.nativeCounterEvidence, cb.nativeCounterEvidence);
      const base = keepBBase ? cb : ca;
      out.push(nativeCounterEvidence
        ? { ...base, nativeCounterEvidence, tokens: nativeCounterProjection(nativeCounterEvidence) }
        : { ...base, tokens: { ...maxTokens(ca.tokens, cb.tokens), countQuality: 'incomplete', ucuCountQuality: 'incomplete' } });
    } else if (ca.countEvidence && cb.countEvidence) out.push(mergeComponentCounts(ca, cb, keepBBase));
    else if (ca.countEvidence || cb.countEvidence || ca.tokens.countQuality === 'incomplete' || cb.tokens.countQuality === 'incomplete') {
      // No raw reconstruction from old normalized categories. Keep the numeric categories
      // for inspection and withhold a complete basis, including subsequent repeated merges.
      const { countEvidence: _raw, ...base } = keepBBase ? cb : ca;
      out.push({ ...base, tokens: { ...maxTokens(ca.tokens, cb.tokens), countQuality: 'incomplete', ucuCountQuality: 'incomplete' } });
    } else out.push({ ...(keepBBase ? cb : ca), tokens: maxTokens(ca.tokens, cb.tokens) });
    const route = mergeComponentRoute(ca, cb);
    if (route !== undefined) out[out.length - 1] = { ...out[out.length - 1]!, servingRoute: route };
  }
  return out;
}

function sumComponentTokens(components: readonly UsageComponent[]): TokenCounts {
  const sum: TokenCounts = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
  for (const c of components) {
    addTokenCounts(sum, c.tokens);
  }
  return sum;
}

/** MAX of two TokenCounts, field by field (never a sum — DESIGN §15.1.2). */
function maxTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  const result: TokenCounts = {
    inputFresh: Math.max(a.inputFresh, b.inputFresh),
    cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
    cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    output: Math.max(a.output, b.output),
    reasoning: Math.max(a.reasoning, b.reasoning),
  };
  if (a.cacheWriteUnassigned !== undefined || b.cacheWriteUnassigned !== undefined)
    result.cacheWriteUnassigned = Math.max(a.cacheWriteUnassigned ?? 0, b.cacheWriteUnassigned ?? 0);
  if (a.cacheWriteAssumed1h !== undefined || b.cacheWriteAssumed1h !== undefined)
    result.cacheWriteAssumed1h = Math.max(a.cacheWriteAssumed1h ?? 0, b.cacheWriteAssumed1h ?? 0);
  if (a.countQuality || b.countQuality) result.countQuality = weakestCountQuality(a.countQuality, b.countQuality);
  const q = weakestCountQuality(subsetCountQuality(a), subsetCountQuality(b));
  if (q !== (result.countQuality ?? 'unrecorded')) result.ucuCountQuality = q;
  return result;
}

/**
 * Merges two per-line `thinking` readings the way the store merges every other Claude-streaming-
 * snapshot field: strongest evidence wins, never "last write wins". true (thinking observed) beats
 * false (verified non-thinking) beats null/undefined (not determinable) — so one line among several
 * duplicates for the same message.id that DID see thinking evidence is never erased by an earlier or
 * later line that didn't.
 */
function mergeThinking(a: boolean | null | undefined, b: boolean | null | undefined): boolean | null {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

/** Adds/removes the `thinkingUnknown` flag to match the final merged `thinking` value — flags come
 * from whichever line is "kept" (§15.1.2), but `thinking` is merged separately (mergeThinking above),
 * so the flag must be recomputed here rather than carried over from either input line's own flags. */
function withThinkingFlag(flags: readonly EventFlag[], thinking: boolean | null): EventFlag[] {
  const has = flags.includes('thinkingUnknown');
  const should = thinking === null;
  if (has === should) return [...flags];
  return should ? [...flags, 'thinkingUnknown'] : flags.filter((f) => f !== 'thinkingUnknown');
}

/** Deep-enough equality for the fields upsertEvents persists, to classify updated vs unchanged. */
function sameStoredShape(a: UsageEvent, storedRow: EventRow): boolean {
  // Flags are a set of disclosures. A different construction order alone must
  // not rewrite the row or advance its count revision on identical ingestion.
  const flags = new Set(a.flags);
  const storedFlags = new Set(JSON.parse(storedRow.flags_json) as EventFlag[]);
  return (
    a.host === storedRow.host &&
    a.source === storedRow.source &&
    a.sessionId === storedRow.session_id &&
    (a.parentSessionId ?? null) === storedRow.parent_session_id &&
    (a.isSubagent ? 1 : 0) === storedRow.is_subagent &&
    a.ts === storedRow.ts &&
    a.tsSource === storedRow.ts_source &&
    a.model === storedRow.model &&
    a.provider === storedRow.provider &&
    (a.engine ?? null) === storedRow.engine &&
    (a.effort ?? null) === storedRow.effort &&
    (a.thinking ?? null) === (storedRow.thinking === null ? null : storedRow.thinking !== 0) &&
    (a.speed ?? null) === storedRow.speed &&
    (a.serviceTier ?? null) === storedRow.service_tier &&
    (a.inferenceGeo ?? null) === storedRow.inference_geo &&
    (a.entrypoint ?? null) === storedRow.entrypoint &&
    (a.project ?? null) === storedRow.project &&
    (a.repoRoot ?? null) === storedRow.repo_root &&
    (a.gitBranch ?? null) === storedRow.git_branch &&
    (a.durationMs ?? null) === storedRow.duration_ms &&
    a.tokens.inputFresh === storedRow.input_fresh &&
    a.tokens.cacheWrite5m === storedRow.cache_write_5m &&
    a.tokens.cacheWrite1h === storedRow.cache_write_1h &&
    (a.tokens.cacheWriteUnassigned ?? null) === (storedRow.cache_write_unassigned ?? null) &&
    (a.tokens.cacheWriteAssumed1h ?? null) === (storedRow.cache_write_assumed_1h ?? null) &&
    (a.tokens.countQuality ?? null) === (storedRow.count_quality ?? null) &&
    (a.tokens.countQuality || a.tokens.ucuCountQuality ? COMPONENT_COUNT_POLICY : null) === (storedRow.count_policy ?? null) &&
    (a.tokens.countQuality || a.tokens.ucuCountQuality ? storedRow.count_revision != null : storedRow.count_revision == null) &&
    (a.tokens.countQuality || a.tokens.ucuCountQuality ? subsetCountQuality(a.tokens) : null) === (storedRow.ucu_count_quality ?? null) &&
    a.tokens.cacheRead === storedRow.cache_read &&
    a.tokens.output === storedRow.output &&
    a.tokens.reasoning === storedRow.reasoning &&
    // Compare the actual stored representation here, after the separate economic
    // basis/validation check. JSON maps invalid numeric evidence to null; object
    // key order still must not turn an equivalent persisted row into a write.
    isDeepStrictEqual(JSON.parse(JSON.stringify(a.components)), JSON.parse(storedRow.components_json)) &&
    flags.size === storedFlags.size && [...flags].every(f => storedFlags.has(f)) &&
    a.apiEquivUsd === storedRow.api_equiv_usd &&
    a.priceStatus === storedRow.price_status &&
    a.priceVersion === storedRow.price_version &&
    a.reservedValue === storedRow.ucu &&
    a.ucuRateStatus === storedRow.ucu_rate_status &&
    a.eacsDefSha256 === storedRow.eacs_def_sha256 &&
    (a.rateKey ?? null) === (storedRow.rate_key ?? null) &&
    (a.rateResolvedSha256 ?? null) === (storedRow.rate_resolved_sha256 ?? null) &&
    (a.perf ? JSON.stringify(a.perf) : null) === (storedRow.perf_json ?? null)
  );
}

export interface EventsFilter {
  since?: number; // epoch ms, inclusive
  until?: number; // epoch ms, exclusive
  source?: Source;
  host?: string;
  sessionId?: string;
  repoRoot?: string;
  model?: string;
}

type SqlParam = string | number | bigint | null;

function buildWhere(filter: EventsFilter | undefined): { clause: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter?.since !== undefined) {
    clauses.push('ts >= ?');
    params.push(filter.since);
  }
  if (filter?.until !== undefined) {
    clauses.push('ts < ?');
    params.push(filter.until);
  }
  if (filter?.source !== undefined) {
    clauses.push('source = ?');
    params.push(filter.source);
  }
  if (filter?.host !== undefined) {
    clauses.push('host = ?');
    params.push(filter.host);
  }
  if (filter?.sessionId !== undefined) {
    clauses.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter?.repoRoot !== undefined) {
    clauses.push('repo_root = ?');
    params.push(filter.repoRoot);
  }
  if (filter?.model !== undefined) {
    clauses.push('model = ?');
    params.push(filter.model);
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Activity insert. Dedup identity: (source, uuid) when uuid is present (unique index idx_activity_dedup_uuid);
 * otherwise (source, session_id, ts, kind) through the partial unique index idx_activity_dedup_fallback.
 *
 * SQLite treats NULLs as distinct in unique indexes, so a mark with NULL uuid AND NULL kind never conflicts and a
 * replayed window inserted it again. The guard closes only that case: it skips the insert when a row with the same
 * fallback identity and NULL kind already exists. A NULL kind is a missing kind, so it is not the same identity as an
 * empty-string kind or an explicit kind, and those keep the index path. The check and the insert run under the
 * BEGIN IMMEDIATE write lock (db.ts withTransaction), so no other writer can interleave between them, and within one
 * batch the check sees the rows inserted earlier in the same transaction. No schema change and no backfill: existing
 * duplicate rows are left in place.
 */
export const INSERT_ACTIVITY_SQL = `
      INSERT INTO activity (source, session_id, ts, uuid, host, project, kind, duration_ms)
      SELECT @source, @sessionId, @ts, @uuid, @host, @project, @kind, @durationMs
      WHERE @uuid IS NOT NULL OR @kind IS NOT NULL
         OR NOT EXISTS (
           SELECT 1 FROM activity
           WHERE source = @source AND session_id = @sessionId AND ts = @ts AND uuid IS NULL AND kind IS NULL
         )
      ON CONFLICT DO NOTHING
    `;

/** A statement prepared on a ledger's connection (node:sqlite StatementSync). */
type PreparedStatement = ReturnType<TokeneloDb['prepare']>;
type CachedStatement = 'getState' | 'setState' | 'recordSkipped' | 'codexStateCandidates' | 'codexStateKeys' | 'relocateState'
  | 'eventById' | 'upsertEvent' | 'recordActivity'
  | 'codexContextCheckpointRead' | 'codexContextCheckpointCollision' | 'codexContextCheckpointMainEvents'
  | 'codexContextCheckpointCurrentEvents' | 'codexContextCheckpointHistory' | 'codexContextCheckpointActivity'
  | 'codexContextCheckpointCas' | 'codexContextCheckpointReceipt'
  | 'claudeActivityOwner' | 'claudeFallbackOwner' | 'recordRouteReport';

const CODEX_CONTEXT_RECEIPT_PREFIX = 'tokenelo/codex-context-checkpoint@v1:';
const CODEX_CONTEXT_CHECKPOINT_BATCH_LIMIT = 256;

/** A collision invalidates this entire batch, including any earlier cursor updates. */
class CodexContextReceiptCollision extends Error {}

/** Scan a basis once, expanding each row to two possible owners inside SQLite. The
 * candidate list is materialized once and the returned distinct IDs are bounded
 * by the batch cap. CROSS JOIN fixes the expansion inside the basis-row loop;
 * it must never become one full basis scan per candidate. */
function codexContextOwnershipSql(table: string, identity: 'id' | 'uuid'): string {
  return `WITH codex_checkpoint_candidates(sid) AS MATERIALIZED (
      SELECT value FROM json_each(?)
    )
    SELECT DISTINCT owner.value AS sid
    FROM ${table} AS owned
    CROSS JOIN json_each(json_array(lower(owned.session_id),
      CASE WHEN substr(lower(owned.${identity}),1,6)='codex:' AND substr(owned.${identity},43,1)=':'
        THEN lower(substr(owned.${identity},7,36)) END)) AS owner
    WHERE owner.value IN (SELECT sid FROM codex_checkpoint_candidates)`;
}

type CursorSqliteRow = {
  rowid: bigint;
  key: string;
  size: bigint;
  mtime_ms: number;
  offset: bigint;
  ino: bigint | null;
  extra_json: string | null;
  rowid_type: string;
  key_type: string;
  size_type: string;
  mtime_type: string;
  offset_type: string;
  ino_type: string;
  extra_type: string;
};

type StoredSqliteValue =
  | { type: 'null' }
  | { type: 'integer'; decimal: string }
  | { type: 'real'; decimal: number; ieee754Hex: string }
  | { type: 'text'; value: string }
  | { type: 'blob'; hex: string };

function storedSqliteValue(type: string, value: unknown): StoredSqliteValue {
  if (type === 'null' && value === null) return { type: 'null' };
  if (type === 'integer' && typeof value === 'bigint') return { type: 'integer', decimal: value.toString(10) };
  if (type === 'real' && typeof value === 'number') {
    const bytes = new ArrayBuffer(8);
    new DataView(bytes).setFloat64(0, value, false);
    return { type: 'real', decimal: value, ieee754Hex: [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('') };
  }
  if (type === 'text' && typeof value === 'string') return { type: 'text', value };
  if (type === 'blob' && value instanceof Uint8Array) return { type: 'blob', hex: [...value].map(x => x.toString(16).padStart(2, '0')).join('') };
  throw new Error('Unsupported SQLite ingest_state storage class');
}

function validCheckpointCursor(state: IngestState): boolean {
  return !!state && typeof state === 'object'
    && typeof state.key === 'string' && state.key.length > 0
    && Number.isSafeInteger(state.size) && state.size >= 0
    && typeof state.mtimeMs === 'number' && Number.isFinite(state.mtimeMs)
    && Number.isSafeInteger(state.offset) && state.offset >= 0 && state.offset <= state.size
    && (state.ino === undefined || state.ino === null || Number.isSafeInteger(state.ino));
}

function rawExtraJson(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : undefined;
  } catch {
    return undefined;
  }
}

function cursorRowMatchesPrior(row: CursorSqliteRow, prior: IngestState): boolean {
  if (row.rowid_type !== 'integer' || typeof row.rowid !== 'bigint'
    || row.key_type !== 'text' || row.key !== prior.key
    || row.size_type !== 'integer' || typeof row.size !== 'bigint'
    || row.mtime_type !== 'real' || typeof row.mtime_ms !== 'number' || row.mtime_ms !== prior.mtimeMs
    || row.offset_type !== 'integer' || typeof row.offset !== 'bigint') return false;
  if (row.size !== BigInt(prior.size) || row.offset !== BigInt(prior.offset)) return false;
  if (row.ino_type === 'null') {
    if (row.ino !== null || prior.ino !== undefined && prior.ino !== null) return false;
  } else if (row.ino_type === 'integer') {
    if (typeof row.ino !== 'bigint' || prior.ino === undefined || prior.ino === null
      || row.ino !== BigInt(prior.ino)) return false;
  } else return false;
  if (row.extra_type === 'null') return row.extra_json === null && prior.extra === undefined;
  if (row.extra_type !== 'text' || typeof row.extra_json !== 'string') return false;
  const expected = rawExtraJson(prior.extra);
  return expected !== undefined && expected !== null && row.extra_json === expected;
}

export class SqliteLedger implements LedgerWriter {
  /** Fixed statements are prepared on first use and reused by this ledger. Collectors repeatedly use the cursor/skip,
   * event lookup/upsert, and activity write paths; each ledger owns its statements on its own connection.
   */
  private statements: Partial<Record<CachedStatement, PreparedStatement>> = {};

  constructor(
    private readonly db: TokeneloDb,
    private readonly pricing: PricingEngine,
    private readonly valuationEngine: ValuationEngine
  ) {}

  private statement(name: CachedStatement, sql: string): PreparedStatement {
    if (this.db.isOpen === false) {
      // Closing the connection finalizes its statements. Preparing again throws the connection's own closed-database
      // error, the same one the uncached path threw, and the stale statements are dropped.
      this.statements = {};
      return this.db.prepare(sql);
    }
    return (this.statements[name] ??= this.db.prepare(sql));
  }

  /** Reentrant (store/db.ts#withTransaction): nested calls — including the implicit ones inside
   * upsertEvents/recordActivity — become SAVEPOINTs of the outermost transaction. */
  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  upsertEvents(events: UsageEvent[], options?: EventUpsertOptions): { inserted: number; updated: number; unchanged: number } {
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;

    const selectStmt = this.statement('eventById', 'SELECT * FROM events WHERE id = ?');
    const upsertStmt = this.statement('upsertEvent', `
      INSERT INTO events (
        rowid, id, host, source, ts, ts_source, session_id, parent_session_id, is_subagent,
        project, repo_root, git_branch, entrypoint, model, provider, engine, effort, thinking, speed,
        service_tier, inference_geo, components_json,
        input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning,
        duration_ms, flags_json,
        api_equiv_usd, price_status, price_version, ucu, ucu_rate_status, eacs_def_sha256, perf_json,
        rate_key, rate_resolved_sha256, cache_write_unassigned, cache_write_assumed_1h, count_quality, ucu_count_quality, count_policy, count_revision
      ) VALUES (
        (SELECT rowid FROM main.events WHERE id=@id), @id, @host, @source, @ts, @tsSource, @sessionId, @parentSessionId, @isSubagent,
        @project, @repoRoot, @gitBranch, @entrypoint, @model, @provider, @engine, @effort, @thinking, @speed,
        @serviceTier, @inferenceGeo, @componentsJson,
        @inputFresh, @cacheWrite5m, @cacheWrite1h, @cacheRead, @output, @reasoning,
        @durationMs, @flagsJson,
        @apiEquivUsd, @priceStatus, @priceVersion, @reservedValue, @ucuRateStatus, @eacsDefSha256, @perfJson,
        @rateKey, @rateResolvedSha256, @cacheWriteUnassigned, @cacheWriteAssumed1h, @countQuality, @ucuCountQuality, @countPolicy, @countRevision
      )
      ON CONFLICT(id) DO UPDATE SET
        host = excluded.host, source = excluded.source, ts = excluded.ts,
        ts_source = excluded.ts_source, session_id = excluded.session_id,
        parent_session_id = excluded.parent_session_id, is_subagent = excluded.is_subagent,
        project = excluded.project, repo_root = excluded.repo_root,
        git_branch = excluded.git_branch, entrypoint = excluded.entrypoint,
        model = excluded.model, provider = excluded.provider, engine = excluded.engine, effort = excluded.effort,
        thinking = excluded.thinking,
        speed = excluded.speed, service_tier = excluded.service_tier,
        inference_geo = excluded.inference_geo, components_json = excluded.components_json,
        input_fresh = excluded.input_fresh, cache_write_5m = excluded.cache_write_5m,
        cache_write_1h = excluded.cache_write_1h, cache_read = excluded.cache_read,
        output = excluded.output, reasoning = excluded.reasoning,
        duration_ms = excluded.duration_ms, flags_json = excluded.flags_json,
        api_equiv_usd = excluded.api_equiv_usd, price_status = excluded.price_status,
        price_version = excluded.price_version, ucu = excluded.ucu,
        ucu_rate_status = excluded.ucu_rate_status, eacs_def_sha256 = excluded.eacs_def_sha256,
        perf_json = excluded.perf_json,
        rate_key = excluded.rate_key, rate_resolved_sha256 = excluded.rate_resolved_sha256,
        cache_write_unassigned = excluded.cache_write_unassigned, cache_write_assumed_1h = excluded.cache_write_assumed_1h,
        count_quality = excluded.count_quality, ucu_count_quality = excluded.ucu_count_quality, count_policy = excluded.count_policy, count_revision = excluded.count_revision
    `);

    this.transaction(() => {
      for (const observed of events) {
        const normalized = observed.components.map(canonicalizeComponentRoute);
        let incoming = normalized.some((c, i) => c !== observed.components[i]) ? { ...observed, components: normalized } : observed;
        const owner = incoming.source === 'claude' && incoming.collectorActivityUuid
          ? this.statement('claudeActivityOwner', `SELECT session_id,ts,host,project FROM activity WHERE source='claude' AND uuid=?`)
            .get(incoming.collectorActivityUuid) as {session_id:string;ts:number;host:string;project:string|null} | undefined
          : undefined;
        if (incoming.source === 'claude' && incoming.collectorFallbackUuidIdentity && incoming.collectorActivityUuid) {
          // Resolve legacy-shaped fallback IDs through exact keys, never a whole
          // ledger suffix scan. Retain the first stored ID and its rowid.
          const canonical = owner ? `claude:${owner.session_id}+${incoming.collectorActivityUuid}` : incoming.id;
          const known = this.statement('claudeFallbackOwner', 'SELECT id FROM main.events WHERE id IN (?,?,?) ORDER BY rowid LIMIT 1')
            .get(incoming.id,canonical,`claude:+${incoming.collectorActivityUuid}`) as {id:string}|undefined;
          incoming = {...incoming,id:known?.id ?? canonical};
        }
        const storedRow = selectStmt.get(incoming.id) as EventRow | undefined;
        const recorded = storedRow ? rowToEvent(storedRow) : undefined;
        // Retain only normalized allowlisted reports, including a claim that loses the
        // count winner. No arbitrary auth fields, endpoints, credentials or future keys.
        for(const [index,c]of incoming.components.entries())if(componentRouteState(c)!=='unrecorded'){
          const route=c.servingRoute!;
          this.statement('recordRouteReport',`INSERT OR IGNORE INTO event_route_reports(event_id,source,component_index,model,speed,kind,evidence)
            VALUES(?,?,?,?,?,?,?)`).run(incoming.id,incoming.source,index,c.model,c.speed??'',route.kind,route.evidence);
        }
        if (owner && owner.session_id && owner.session_id !== incoming.sessionId && (!storedRow || !storedRow.session_id)) {
          // A missing stored session is enriched from the recorded UUID owner,
          // never from an incoming copy that disagrees with that activity row.
          const ownerFlags: EventFlag[] = [];
          if (storedRow || !incoming.sessionId) ownerFlags.push('sessionAttributionEnriched');
          if (incoming.sessionId) ownerFlags.push('sessionAttributionConflict');
          const recordedContext = recorded;
          // A blank usage SID makes no conflicting session claim; its own file
          // and reported fields can fill gaps without treating copy metadata as
          // owner evidence. Retain earlier recorded fields when they exist.
          const unclaimed = !incoming.sessionId;
          incoming = {...incoming,host:owner.host,sessionId:owner.session_id,ts:owner.ts,tsSource:'activity',
            project:owner.project ?? recordedContext?.project ?? (unclaimed ? incoming.project : undefined),
            parentSessionId:recordedContext ? recordedContext.parentSessionId : (unclaimed ? incoming.parentSessionId : undefined),
            isSubagent:recordedContext?.isSubagent ?? (unclaimed ? incoming.isSubagent : false),
            repoRoot:recordedContext?.repoRoot ?? (unclaimed ? incoming.repoRoot : undefined),
            gitBranch:recordedContext?.gitBranch ?? (unclaimed ? incoming.gitBranch : undefined),
            entrypoint:recordedContext?.entrypoint ?? (unclaimed ? incoming.entrypoint : undefined),
            flags:[...new Set([...incoming.flags,...ownerFlags,'sessionContextUnrecorded'] as EventFlag[])]};
        } else if (owner && owner.session_id && storedRow && storedRow.session_id && owner.session_id !== storedRow.session_id) {
          // Existing historical mismatches need a separate reconciliation. Do
          // not silently rewrite the recorded owner during ordinary ingestion.
            incoming = {...incoming,flags:[...new Set([...incoming.flags,'sessionAttributionConflict'] as EventFlag[])]};
        }

        let merged: UsageEvent;
        if (!storedRow) {
          const thinking = incoming.thinking ?? null;
          const flags = [...incoming.flags];
          qualifyClaudePricedSpeed(flags, incoming.components, incoming.source);
          const initial = { ...incoming, thinking, flags: withThinkingFlag(flags, thinking) };
          // Inserts and replays must qualify the same measurement discrepancy.
          // An incoherent first observation cannot get a numeric valuation that
          // an identical replay subsequently withdraws.
          merged = mergeDuplicateEvent(initial, initial);
        } else {
          merged = mergeDuplicateEvent(recorded!, incoming);
        }
        // This evidence describes the first raw Codex observation only. It is descriptive metadata,
        // never permission to backfill older rows or replace the original field-state record.
        merged = retainFirstSeenCodexFieldState(recorded, merged);

        if (merged.components.some(c => c.countEvidence && !isSupportedCountPolicy(c.countEvidence.policy)
          || c.nativeCounterEvidence && !supportedNativeCounters(c.nativeCounterEvidence))) {
          merged = { ...merged,
            components: merged.components.map(c => c.countEvidence && !isSupportedCountPolicy(c.countEvidence.policy)
              || c.nativeCounterEvidence && !supportedNativeCounters(c.nativeCounterEvidence)
              ? { ...c, tokens: { ...c.tokens, countQuality: weakestCountQuality(c.tokens.countQuality, 'incomplete'),
                ucuCountQuality: weakestCountQuality(subsetCountQuality(c.tokens), 'incomplete') } } : c),
            tokens: { ...merged.tokens, countQuality: weakestCountQuality(merged.tokens.countQuality, 'incomplete'),
              ucuCountQuality: weakestCountQuality(subsetCountQuality(merged.tokens), 'incomplete') } };
        }
        const retainValuation = recorded !== undefined && options?.reprice !== true && sameValuationInputs(merged, recorded);
        const priceResult = retainValuation ? {
          usd: recorded.apiEquivUsd, status: recorded.priceStatus,
          flags: recorded.flags.filter(f => PRICE_FLAGS.includes(f)),
        } : this.pricing.priceEvent({
          components: merged.components,
          tokens: merged.tokens,
          inferenceGeo: merged.inferenceGeo,
          flags: merged.flags,
        });
        // The reserved compatibility columns are not part of the price refresh: a stored row keeps them whenever its
        // measurement inputs are unchanged, including through an explicit reprice, so historical values are never wiped.
        const retainUnits = recorded !== undefined && sameValuationInputs(merged, recorded);
        const valueResult = retainUnits ? { reservedValue: recorded.reservedValue, status: recorded.ucuRateStatus } : this.valuationEngine.valueForEvent({
          components: merged.components,
          tokens: merged.tokens,
          effort: merged.effort,
          thinking: merged.thinking,
          flags: merged.flags,
        });

        const basis = retainUnits ? { rateKey: recorded.rateKey, resolvedSha256: recorded.rateResolvedSha256 }
          : this.valuationEngine.rateBasisOf(merged.components, merged.effort, merged.thinking);
        const unresolved = hasUnresolvedCounts(merged.tokens);
        const unresolvedSubset = hasUnresolvedSubsetCounts(merged.tokens);
        // Reporting provider is part of recorded economic provenance, including
        // legacy route-less observations. A new descriptive classification must
        // not relabel historical $0/local or hosted prices on ordinary replay.
        const provider = retainValuation ? recorded.provider : providerForValuation(merged, this.pricing);
        const routeFlags: EventFlag[] = [];
        if (merged.components.some(c => componentRouteState(c) === 'invalid')) routeFlags.push('servingRouteInvalid');
        if (merged.components.some(c => componentRouteState(c) === 'conflict')) routeFlags.push('servingRouteConflict');
        const finalEvent: UsageEvent = {
          ...merged,
          provider,
          flags: [...new Set([...merged.flags.filter(f => !COUNT_EVIDENCE_FLAGS.includes(f) && !PRICE_FLAGS.includes(f)
            && f !== 'servingRouteInvalid' && f !== 'servingRouteConflict'), ...countEvidenceFlags(merged.components), ...priceResult.flags, ...routeFlags])],
          apiEquivUsd: unresolved ? null : priceResult.usd,
          priceStatus: unresolved ? 'UNPRICED' : priceResult.status,
          priceVersion: retainValuation ? recorded.priceVersion : this.pricing.version,
          reservedValue: unresolvedSubset ? null : valueResult.reservedValue,
          ucuRateStatus: unresolvedSubset ? 'NONE' : valueResult.status,
          eacsDefSha256: retainUnits ? recorded.eacsDefSha256 : this.valuationEngine.defSha256,
          rateKey: basis.rateKey,
          rateResolvedSha256: basis.resolvedSha256,
        };

        if (storedRow && sameStoredShape(finalEvent, storedRow)) {
          // Preserve exact stored bytes for a semantic no-op. Writing a reordered
          // flag set without advancing its count revision would correctly trip
          // the legacy-writer invalidation guard and erase count/price evidence.
          unchanged++;
          continue;
        }

        upsertStmt.run({
          id: finalEvent.id,
          host: finalEvent.host,
          source: finalEvent.source,
          ts: finalEvent.ts,
          tsSource: finalEvent.tsSource,
          sessionId: finalEvent.sessionId,
          parentSessionId: finalEvent.parentSessionId ?? null,
          isSubagent: finalEvent.isSubagent ? 1 : 0,
          project: finalEvent.project ?? null,
          repoRoot: finalEvent.repoRoot ?? null,
          gitBranch: finalEvent.gitBranch ?? null,
          entrypoint: finalEvent.entrypoint ?? null,
          model: finalEvent.model,
          provider: finalEvent.provider,
          engine: finalEvent.engine ?? null,
          effort: finalEvent.effort ?? null,
          thinking: finalEvent.thinking === null || finalEvent.thinking === undefined ? null : finalEvent.thinking ? 1 : 0,
          speed: finalEvent.speed ?? null,
          serviceTier: finalEvent.serviceTier ?? null,
          inferenceGeo: finalEvent.inferenceGeo ?? null,
          componentsJson: JSON.stringify(finalEvent.components),
          inputFresh: finalEvent.tokens.inputFresh,
          cacheWrite5m: finalEvent.tokens.cacheWrite5m,
          cacheWrite1h: finalEvent.tokens.cacheWrite1h,
          cacheWriteUnassigned: finalEvent.tokens.cacheWriteUnassigned ?? null,
          cacheWriteAssumed1h: finalEvent.tokens.cacheWriteAssumed1h ?? null,
          countQuality: finalEvent.tokens.countQuality ?? null,
          ucuCountQuality: finalEvent.tokens.countQuality || finalEvent.tokens.ucuCountQuality ? subsetCountQuality(finalEvent.tokens) : null,
          // The current writer policy covers overall AND subset-only qualifications.
          // Every changed materialization advances the trigger revision.
          countPolicy: finalEvent.tokens.countQuality || finalEvent.tokens.ucuCountQuality ? COMPONENT_COUNT_POLICY : null,
          countRevision: finalEvent.tokens.countQuality || finalEvent.tokens.ucuCountQuality ? (storedRow?.count_revision ?? 0) + 1 : null,
          cacheRead: finalEvent.tokens.cacheRead,
          output: finalEvent.tokens.output,
          reasoning: finalEvent.tokens.reasoning,
          durationMs: finalEvent.durationMs ?? null,
          flagsJson: JSON.stringify(finalEvent.flags),
          apiEquivUsd: finalEvent.apiEquivUsd,
          priceStatus: finalEvent.priceStatus,
          priceVersion: finalEvent.priceVersion,
          reservedValue: finalEvent.reservedValue,
          ucuRateStatus: finalEvent.ucuRateStatus,
          eacsDefSha256: finalEvent.eacsDefSha256,
          perfJson: finalEvent.perf ? JSON.stringify(finalEvent.perf) : null,
          rateKey: finalEvent.rateKey ?? null,
          rateResolvedSha256: finalEvent.rateResolvedSha256 ?? null,
        });

        if (!storedRow) {
          inserted++;
        } else {
          updated++;
        }
      }
    });

    return { inserted, updated, unchanged };
  }

  recordActivity(marks: ActivityMark[]): void {
    const stmt = this.statement('recordActivity', INSERT_ACTIVITY_SQL);
    this.transaction(() => {
      for (const mark of marks) {
        stmt.run({
          source: mark.source,
          sessionId: mark.sessionId,
          ts: mark.ts,
          uuid: mark.uuid ?? null,
          host: mark.host,
          project: mark.project ?? null,
          kind: mark.kind ?? null,
          durationMs: mark.durationMs ?? null,
        });
      }
    });
  }

  recordLimits(snapshot: LimitSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO limits (source, host, account, limit_id, captured_at, plan_type, windows_json, credits_json, estimate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.source,
        snapshot.host,
        snapshot.account ?? null,
        snapshot.limitId ?? null,
        snapshot.capturedAt,
        snapshot.planType ?? null,
        JSON.stringify(snapshot.windows),
        snapshot.credits ? JSON.stringify(snapshot.credits) : null,
        snapshot.estimate ? 1 : 0
      );
  }

  recordSkipped(path: string, reason: SkipReason): void {
    this
      .statement(
        'recordSkipped',
        `INSERT INTO skipped (path, reason, count, last_seen) VALUES (?, ?, 1, ?)
         ON CONFLICT(path, reason) DO UPDATE SET
           count = count + 1,
           last_seen = excluded.last_seen`
      )
      .run(path, reason, Date.now());
  }

  upsertDesktopSessionMeta(rows: (DesktopSessionMeta & { sourceFile: string })[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO desktop_sessions (
        cli_session_id, cwd, origin_cwd, title, model, effort, is_archived,
        created_at, last_activity_at, pr_number, pr_url, pr_repository, pr_state,
        source_file, updated_at
      ) VALUES (
        @cliSessionId, @cwd, @originCwd, @title, @model, @effort, @isArchived,
        @createdAt, @lastActivityAt, @prNumber, @prUrl, @prRepository, @prState,
        @sourceFile, @updatedAt
      )
      ON CONFLICT(cli_session_id) DO UPDATE SET
        cwd = excluded.cwd, origin_cwd = excluded.origin_cwd, title = excluded.title,
        model = excluded.model, effort = excluded.effort, is_archived = excluded.is_archived,
        created_at = excluded.created_at, last_activity_at = excluded.last_activity_at,
        pr_number = excluded.pr_number, pr_url = excluded.pr_url,
        pr_repository = excluded.pr_repository, pr_state = excluded.pr_state,
        source_file = excluded.source_file, updated_at = excluded.updated_at
    `);
    this.transaction(() => {
      for (const r of rows) {
        stmt.run({
          cliSessionId: r.cliSessionId,
          cwd: r.cwd ?? null,
          originCwd: r.originCwd ?? null,
          title: r.title ?? null,
          model: r.model ?? null,
          effort: r.effort ?? null,
          isArchived: r.isArchived === undefined ? null : r.isArchived ? 1 : 0,
          createdAt: r.createdAt ?? null,
          lastActivityAt: r.lastActivityAt ?? null,
          prNumber: r.prNumber ?? null,
          prUrl: r.prUrl ?? null,
          prRepository: r.prRepository ?? null,
          prState: r.prState ?? null,
          sourceFile: r.sourceFile,
          updatedAt: Date.now(),
        });
      }
    });
  }

  /**
   * Reads an ingest cursor. INTEGER columns are read as BigInt and narrowed explicitly: a row
   * written by an older build may hold a raw NTFS file id > 2^53 in `ino` (A2000:
   * 9,851,624,185,066,820), which node:sqlite's default number mode refuses to read (RangeError
   * ERR_OUT_OF_RANGE — reproduced on node 26.9). Such an ino is reduced to the safe-integer form
   * collectors now store, so the cursor stays readable instead of wedging the collector.
   */
  getState(key: string): IngestState | undefined {
    const stmt = this.statement('getState', 'SELECT key, size, mtime_ms, offset, ino, extra_json FROM ingest_state WHERE key = ?');
    stmt.setReadBigInts(true);
    const row = stmt.get(key) as
      | {
          key: string;
          size: number | bigint;
          mtime_ms: number | bigint;
          offset: number | bigint;
          ino: number | bigint | null;
          extra_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    const state: IngestState = {
      key: row.key,
      size: checkedIngestStateNumber(row.size),
      mtimeMs: checkedIngestStateNumber(row.mtime_ms),
      offset: checkedIngestStateNumber(row.offset),
      ino: row.ino === null ? undefined : normalizeIno(row.ino),
      extra: row.extra_json ? JSON.parse(row.extra_json) : undefined,
    };
    if (!validCheckpointCursor(state)) throw new RangeError('invalid ingest_state cursor');
    return state;
  }

  /** Persists only cursors that fit the shared safe-number contract before preparing/binding SQL. */
  setState(state: IngestState): void {
    if (!validCheckpointCursor(state)) throw new RangeError('invalid ingest_state cursor');
    this
      .statement(
        'setState',
        `INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset,
           ino = excluded.ino, extra_json = excluded.extra_json`
      )
      .run(
        state.key,
        state.size,
        state.mtimeMs,
        state.offset,
        state.ino === undefined || state.ino === null ? null : normalizeIno(state.ino),
        state.extra !== undefined ? JSON.stringify(state.extra) : null
      );
  }

  codexStateCandidates(sessionId: string, exceptKey: string): IngestState[] {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) return [];
    const rows = this.statement('codexStateCandidates', 'SELECT key FROM ingest_state WHERE key != ? AND key LIKE ? ORDER BY offset DESC').all(exceptKey, `%rollout-%-${sessionId}.jsonl`) as Array<{key:string}>;
    return rows.flatMap(row => { const state = this.getState(row.key); return state ? [state] : []; });
  }

  codexStateKeys(): string[] {
    return (this.statement('codexStateKeys', 'SELECT key FROM ingest_state').all() as Array<{key:string}>).map(row=>row.key);
  }

  relocateState(prior: IngestState, next: IngestState): boolean {
    if (prior.key === next.key) return false;
    return this.transaction(() => {
      if (this.getState(next.key)) return false;
      const result = this.statement('relocateState', `UPDATE ingest_state SET key=?,size=?,mtime_ms=?,offset=?,ino=?,extra_json=?
        WHERE key=? AND offset=? AND extra_json IS ?`).run(next.key,next.size,next.mtimeMs,next.offset,
        next.ino === undefined ? null : normalizeIno(next.ino),JSON.stringify(next.extra),prior.key,prior.offset,
        prior.extra === undefined ? null : JSON.stringify(prior.extra));
      return Number(result.changes) === 1;
    });
  }

  recoverCodexContextCheckpoint(prior: IngestState, next: IngestState, claim: { host: HostLabel; sessionId: string }): boolean {
    return this.recoverCodexContextCheckpoints([{ prior, next, claim }])[0] ?? false;
  }

  recoverCodexContextCheckpoints(candidates: readonly CodexContextCheckpointRecoveryCandidate[]): boolean[] {
    const held = Array<boolean>(candidates.length).fill(false);
    if (candidates.length === 0 || candidates.length > CODEX_CONTEXT_CHECKPOINT_BATCH_LIMIT) return held;
    const eligible = candidates.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== 'object') return [];
      const { prior, next, claim } = candidate;
      if (!prior || !next || !claim || typeof claim !== 'object'
        || !validCheckpointCursor(prior) || !validCheckpointCursor(next) || prior.key !== next.key
        || typeof claim.host !== 'string' || claim.host.length === 0
        || !isCanonicalCodexSessionId(claim.sessionId)
        || !isUnownedCodexContextState(prior.extra, claim.sessionId)
        || !isUnownedCodexContextState(next.extra, claim.sessionId)
        || !isStructurallyBoundCodexContextState(prior, claim.sessionId)
        || !isStructurallyBoundCodexContextState(next, claim.sessionId)
        || next.offset !== next.size
        || !next.extra || typeof next.extra !== 'object' || Array.isArray(next.extra)) return [];
      const nextExtra = next.extra as Record<string, unknown>;
      if (Object.hasOwn(nextExtra, 'contextCheckpointReceiptId')) return [];
      const nextExtraJson = rawExtraJson(nextExtra);
      return nextExtraJson === undefined || nextExtraJson === null ? [] : [{ candidate, index, nextExtraJson }];
    });
    if (eligible.length === 0) return held;

    try {
      return this.transaction(() => {
        const sessionIdsJson = JSON.stringify([...new Set(eligible.map(({ candidate }) => candidate.claim.sessionId.toLowerCase()))]);
        const owners = new Set<string>();
        for (const [name, table, identity] of [
          ['codexContextCheckpointMainEvents', 'main.events', 'id'],
          // Unqualified events is intentionally routed to the current projection.
          ['codexContextCheckpointCurrentEvents', 'events', 'id'],
          ['codexContextCheckpointHistory', 'main.event_interpretation_history', 'id'],
          ['codexContextCheckpointActivity', 'main.activity', 'uuid'],
        ] as const) {
          const rows = this.statement(name, codexContextOwnershipSql(table, identity)).all(sessionIdsJson) as { sid: string }[];
          for (const row of rows) owners.add(row.sid);
        }
        const outcomes = [...held];
        for (const { candidate, index, nextExtraJson } of eligible) {
          if (!owners.has(candidate.claim.sessionId.toLowerCase())) {
            outcomes[index] = this.writeCodexContextCheckpoint(candidate, nextExtraJson);
          }
        }
        return outcomes;
      });
    } catch (error) {
      if (error instanceof CodexContextReceiptCollision) return held;
      throw error;
    }
  }

  /** Called only after the batch's ownership scan, within its same write transaction. */
  private writeCodexContextCheckpoint(
    { prior, next, claim }: CodexContextCheckpointRecoveryCandidate, nextExtraJson: string,
  ): boolean {
    const read = this.statement('codexContextCheckpointRead', `SELECT rowid AS rowid,key,size,mtime_ms,offset,ino,extra_json,
      typeof(rowid) AS rowid_type,typeof(key) AS key_type,typeof(size) AS size_type,
      typeof(mtime_ms) AS mtime_type,typeof(offset) AS offset_type,typeof(ino) AS ino_type,
      typeof(extra_json) AS extra_type FROM main.ingest_state WHERE key=?`);
    read.setReadBigInts(true);
    const stored = read.get(prior.key) as CursorSqliteRow | undefined;
    if (!stored || !cursorRowMatchesPrior(stored, prior)) return false;

    const sid = claim.sessionId;
    const recordedAtMs = Date.now();
    const priorCursor = {
      rowid: storedSqliteValue(stored.rowid_type, stored.rowid),
      key: storedSqliteValue(stored.key_type, stored.key),
      size: storedSqliteValue(stored.size_type, stored.size),
      mtime_ms: storedSqliteValue(stored.mtime_type, stored.mtime_ms),
      offset: storedSqliteValue(stored.offset_type, stored.offset),
      ino: storedSqliteValue(stored.ino_type, stored.ino),
      extra_json: storedSqliteValue(stored.extra_type, stored.extra_json),
    };
    const normalizedNextIno = next.ino === undefined || next.ino === null ? null : normalizeIno(next.ino);
    const nextCursor = {
      key: { type: 'text', value: next.key },
      size: storedSqliteValue('integer', BigInt(next.size)),
      mtime_ms: storedSqliteValue('real', next.mtimeMs),
      offset: storedSqliteValue('integer', BigInt(next.offset)),
      ino: normalizedNextIno === null ? storedSqliteValue('null', null) : storedSqliteValue('integer', BigInt(normalizedNextIno)),
      extra_json_before_receipt_pointer: storedSqliteValue('text', nextExtraJson),
    };
    const payload = {
      version: 1,
      kind: 'codex-context-checkpoint-recovery',
      recordedAtMs,
      claim: { host: claim.host, sessionId: sid },
      priorCursor,
      priorExtraJson: stored.extra_json,
      nextCursor,
    };
    const receiptValue = JSON.stringify(payload);
    if (typeof receiptValue !== 'string') return false;
    const receiptKey = `${CODEX_CONTEXT_RECEIPT_PREFIX}${createHash('sha256').update(receiptValue).digest('hex')}`;
    if (this.statement('codexContextCheckpointCollision', 'SELECT 1 FROM main.meta WHERE key=?').get(receiptKey)) {
      throw new CodexContextReceiptCollision('Codex context checkpoint receipt already exists');
    }

    const persistedNextExtra = JSON.stringify({ ...JSON.parse(nextExtraJson), contextCheckpointReceiptId: receiptKey });
    if (typeof persistedNextExtra !== 'string') return false;
    const updated = this.statement('codexContextCheckpointCas', `UPDATE main.ingest_state
      SET size=?,mtime_ms=?,offset=?,ino=?,extra_json=?
      WHERE rowid=? AND key=?
        AND typeof(rowid)=? AND typeof(key)=? AND key=?
        AND typeof(size)=? AND size IS ?
        AND typeof(mtime_ms)=? AND mtime_ms IS ?
        AND typeof(offset)=? AND offset IS ?
        AND typeof(ino)=? AND ino IS ?
        AND typeof(extra_json)=? AND extra_json IS ?`).run(
      next.size, next.mtimeMs, next.offset, normalizedNextIno, persistedNextExtra,
      stored.rowid, stored.key,
      stored.rowid_type, stored.key_type, stored.key,
      stored.size_type, stored.size,
      stored.mtime_type, stored.mtime_ms,
      stored.offset_type, stored.offset,
      stored.ino_type, stored.ino,
      stored.extra_type, stored.extra_json,
    );
    if (Number(updated.changes) !== 1) return false;

    // Plain INSERT is deliberate: receipt collisions must abort and roll back the cursor CAS.
    const inserted = this.statement('codexContextCheckpointReceipt', 'INSERT INTO main.meta(key,value) VALUES(?,?)').run(receiptKey, receiptValue);
    if (Number(inserted.changes) !== 1) throw new Error('Codex context checkpoint receipt append did not insert');
    return true;
  }

  /** Events of one source whose ts falls in [sinceTs, untilTs] (inclusive), ascending by ts. */
  recentEvents(source: Source, sinceTs: number, untilTs: number): UsageEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE source = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC')
      .all(source, sinceTs, untilTs) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  // ── read helpers used by others later (daemon HTTP API, CLI, reports) ──────────

  /** All events matching `filter`, ordered by ts ascending. Fine for CLI/report use; for large
   * ranges prefer `iterateEvents` to avoid materializing everything at once. */
  getEvents(filter?: EventsFilter): UsageEvent[] {
    const { clause, params } = buildWhere(filter);
    const rows = this.db
      .prepare(`SELECT * FROM events ${clause} ORDER BY ts ASC`)
      .all(...params) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Same filter as getEvents, yielded one row at a time (SQLite step-by-step, not a bulk
   * `.all()`) — for the daemon/CLI to stream large ranges without holding them all in memory. */
  *iterateEvents(filter?: EventsFilter): Generator<UsageEvent> {
    const { clause, params } = buildWhere(filter);
    const stmt = this.db.prepare(`SELECT * FROM events ${clause} ORDER BY ts ASC`);
    stmt.setReadBigInts(false);
    const iterator = stmt.iterate(...params) as unknown as Iterable<EventRow>;
    for (const row of iterator) {
      yield rowToEvent(row);
    }
  }
}
