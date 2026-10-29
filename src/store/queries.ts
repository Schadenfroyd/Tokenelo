/**
 * SQL aggregations backing the daemon HTTP API and the CLI's read commands (DESIGN §2.1, §15.7).
 * Reads the `events`/`activity`/`limits`/`skipped`/`ingest_state`/`meta` tables directly (schema:
 * store/migrations.ts); it never writes.
 *
 * Domain logic is never re-implemented here — it is imported from the modules that own it:
 *   - `buildSessions` (core/sessions.ts), `computeSubscriptionLeverage` (core/subscriptions.ts),
 *     `computeClaudeBlockEstimates` / `newestSnapshotPerSeries` (core/limits.ts).
 *   - `rowToEvent` (store/ledger.ts) — the one events-row → UsageEvent mapping.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TokeneloDb } from './db.js';
import { readDoctorCensus } from './doctor-census.js';
import { openReadSnapshot, readRows, visitRows, type PageOptions, type RowQuery } from './read-snapshot.js';
import { rangeSince } from '../core/query-range.js';
import { ActivityGroupingIdentities, OrderedActivityGroupingIdentities, SummaryActivityAccumulator, summedSessionActiveMsSteps, type ActivityGroupingEvent } from '../core/activity-summary.js';
import { SessionHierarchy } from '../core/session-hierarchy.js';
import { SessionAncestryAccumulator, SessionEventAggregate } from '../core/session-aggregate.js';
import { recordedQueryTimeBasis } from './query-time-basis.js';
export { rangeSince } from '../core/query-range.js';

/** Aggregate columns Summary reads (the same columns as before, so the same row shape). */
const AGG_COLUMNS =
  'source, model, provider, price_status, api_equiv_usd, input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, thinking';
const COUNT_COLUMNS = 'cache_write_unassigned, cache_write_assumed_1h, count_quality, ucu_count_quality';
const countSchema = new WeakMap<TokeneloDb, { version: number; columns: Set<string> }>();
function hasCountColumns(db: TokeneloDb, name = 'count_quality'): boolean {
  const version = (db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version;
  let cached = countSchema.get(db);
  if (!cached || cached.version !== version) {
    cached = { version, columns: new Set((db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>).map(c => c.name)) };
    countSchema.set(db, cached);
  }
  return cached.columns.has(name);
}
function countColumnsFor(db: TokeneloDb, nativeFields = true): string {
  return COUNT_COLUMNS.split(', ').map(n => hasCountColumns(db, n) ? n : `NULL AS ${n}`).join(', ')
    + (hasCountColumns(db, 'count_revision') ? ', count_revision' : ', NULL AS count_revision')
    + (nativeFields ? hasCountColumns(db, 'components_json') ? ", CASE WHEN source='ollama-proxy' THEN components_json ELSE NULL END AS field_components_json" : ', NULL AS field_components_json' : '');
}

function readClaudeIncompleteCapture(db: TokeneloDb): NonNullable<CoverageResponse['incompleteCapture']> {
  const rows = db
    .prepare(`SELECT extra_json FROM ingest_state WHERE instr(extra_json, '${CLAUDE_HOLD_KEY}') > 0`)
    .all() as unknown as Array<{ extra_json: string | null }>;
  return [summarizeClaudeHolds(rows.map((row) => row.extra_json))];
}

/**
 * The aggregate read as a row query. Unfiltered (`since` undefined) is rowid order, which is the order a full scan returns and
 * the order the original unpaged statement returns. A range is (ts, rowid), the order of its index scan. Both are pinned by
 * test/store/summary-aggregate.test.ts, because float sums depend on this order.
 */
export function aggregateRowQuery(since: number | undefined, countColumns = COUNT_COLUMNS, asOf?: number): RowQuery {
  const ranged = since !== undefined;
  return {
    table: 'events',
    columns: `${AGG_COLUMNS}, ${countColumns}`,
    clauses: [...(ranged ? ['ts >= ?'] : []), ...(asOf !== undefined ? ['ts <= ?'] : [])],
    params: [...(ranged ? [since!] : []), ...(asOf !== undefined ? [asOf] : [])],
    order: ranged ? 'tsRowid' : 'rowid',
  };
}
import { rowToEvent, StoredComponentEvidenceError, type EventRow } from './ledger.js';
import { addTokenCounts, hasUnresolvedCounts, normalizeCountQuality, weakestCountQuality } from '../core/token-counts.js';
import { FILES_PER_YIELD, YIELD_BUDGET_MS, YieldPacer, yieldToEventLoop } from '../core/event-loop.js';
import { checkRead, readPhase, detailReadPhase, doctorReadPhase, sessionReadPhase, summaryReadPhase, timeseriesReadPhase, type DoctorReadPhase, type ReadControl } from '../core/read-control.js';
import { awaitOutside, measure, SyncSegment, intervalBegin, intervalEnd } from '../core/phase-profile.js';
import { drainSteps, drainStepsYielding } from '../core/event-loop.js';
import { SummaryAggregate, summaryAggregateSteps, type AggregateParts, type RawEventAgg } from './summary-aggregate.js';
import { createNullEngine, localValueUnavailable } from '../core/null-engine.js';
import { priceFieldsOf, priceQualityFromCounts, type PriceQuality } from '../core/price-quality.js';
import { emptyPriceEvidence, mergePriceEvidence, priceEvidenceOf, qualifyAggregateAmount, priceEvidenceFromCounts, PRICE_EVIDENCE_AGG_SQL, type PriceEvidence } from '../core/price-evidence.js';
import { defaultPricingEngine, recordedModelDisplayName } from '../core/pricing.js';
import {
  buildSessions,
  activityProject,
  buildSessionsYielding,
  computeActiveMs,
  activityTimeEvidence,
  computeBurn,
  dedupeActivityMarks,
  summarizeSessionTelemetry,
} from '../core/sessions.js';
import { computeSubscriptionLeverage } from '../core/subscriptions.js';
import { accountGroupKey, computeClaudeBlockEstimates, newestSnapshotPerSeries } from '../core/limits.js';
import { probeOllama, type OllamaProbeResult } from '../collectors/ollama-probe.js';
import { listAgentProcesses, listAgentProcessesChecked, type ProcessListing } from '../collectors/processes.js';
import { AGENT_CATALOG } from '../core/agent-catalog.js';
import { CLAUDE_HOLD_KEY, summarizeClaudeHolds } from '../core/capture-holds.js';
import type {
  ActivityMark,
  CoverageEntry,
  CoverageResponse,
  DesktopSessionMeta,
  DoctorReport,
  EventFlag,
  LimitSnapshot,
  LimitsResponse,
  LocalCaptureCoverageStatus,
  MeteringBacklogStatus,
  LocalValue,
  ModelRow,
  PlanUsageHistoryResponse,
  PriceStatus,
  Provider,
  PricingEngine,
  ProcessesResponse,
  Range,
  SessionDetail,
  SessionDetailSubagent,
  SessionRow,
  SessionsResponse,
  Source,
  SkipReason,
  SubscriptionRow,
  SummaryResponse,
  TimeseriesPoint,
  TimeseriesResponse,
  TokenCounts,
  TokeneloConfig,
  UsageEvent,
} from '../core/types.js';
import { ZERO_TOKENS, type ProcessListingStatus } from '../core/types.js';

/** meta-table key under which the daemon persists the proxy's cumulative unmetered-request count. */
export const META_UNMETERED_KEY = 'ollama_proxy_unmetered_requests';
/** Set by daemon/main.ts's `ensureApiToken` when a Windows icacls ACL restriction fails, so
 * `getDoctor()` can surface it (security audit #7). */
export const META_ACL_WARNING_KEY = 'windows_token_acl_warning';

/**
 * `ps -ww -p <pid> -o command=` (ollama-probe.ts) returns the FULL command line, including argv —
 * `doctor` must only ever report the executable path (security audit #10: "returns only the
 * executable path of the Ollama listener, not full argv"), since argv can carry flags/values an
 * operator would not expect to end up in a diagnostics report. Splits on the first run of
 * whitespace; a path containing a literal space would be mis-truncated, but none of the real
 * Ollama binaries/wrappers this collector targets (Homebrew, Ollama.app) do.
 */
export function executablePathOnly(command: string): string {
  const trimmed = command.trim();
  const idx = trimmed.search(/\s/);
  return idx === -1 ? trimmed : trimmed.slice(0, idx);
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// ── raw row shapes ───────────────────────────────────────────────────────────


export { thinkingBucket } from './summary-aggregate.js';

interface ActivityRow {
  source: string;
  session_id: string;
  ts: number;
  uuid: string | null;
  host: string;
  project: string | null;
  kind: string | null;
  duration_ms: number | null;
}

type SqlParam = string | number;

function sumTokensOfEvents(events: readonly UsageEvent[]): TokenCounts {
  const t: TokenCounts = { ...ZERO_TOKENS };
  for (const e of events) {
    addTokenCounts(t, e.tokens);
  }
  return t;
}

/** `null` only when EVERY event is unpriced and there is at least one event (matches
 * `core/sessions.ts`'s `sumApiEquivUsd` rule, duplicated here since that helper isn't exported). */
function sumApiEquivUsdOfEvents(events: readonly UsageEvent[]): number | null {
  if (events.length === 0) return 0;
  if (events.every((e) => e.apiEquivUsd === null)) return null;
  return events.reduce((sum, e) => sum + (e.apiEquivUsd ?? 0), 0);
}

/** `UsageEvent.thinking` (boolean|null) -> the same 'thinking'|'non-thinking'|'unknown' bucket
 * `thinkingBucket` (above) computes from the stored 1/0/NULL column. */
function thinkingBucketFromBool(v: boolean | null | undefined): 'thinking' | 'non-thinking' | 'unknown' {
  return v === true ? 'thinking' : v === false ? 'non-thinking' : 'unknown';
}

function uniqueModelsInOrder(events: readonly UsageEvent[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (!seen.has(e.model)) {
      seen.add(e.model);
      models.push(e.model);
    }
  }
  return models;
}

/** Per-(provider, model, thinking-mode) breakdown within the requested source — same shape/split rule as
 * `getSummary`'s byModel (founder req. 2026-09-27: never blend thinking/non-thinking into one row),
 * built from an already-fetched `UsageEvent[]` rather than a fresh SQL projection. */
function buildModelRowsFromEvents(events: readonly UsageEvent[], pricing: PricingEngine): ModelRow[] {
  const byModelMap = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const key = `${e.provider}\u0000${e.model}\u0000${thinkingBucketFromBool(e.thinking)}`;
    const m = byModelMap.get(key) ?? [];
    m.push(e);
    byModelMap.set(key, m);
  }
  const rows: ModelRow[] = [];
  for (const mevents of byModelMap.values()) {
    const first = mevents[0]!;
    rows.push({
      model: first.model,
      displayName: recordedModelDisplayName(pricing, first.model, first.provider as ModelRow['provider']),
      provider: first.provider,
      source: first.source,
      thinking: thinkingBucketFromBool(first.thinking),
      events: mevents.length,
      tokens: sumTokensOfEvents(mevents),
      apiEquivUsd: sumApiEquivUsdOfEvents(mevents),
      ...priceFieldsOf(mevents),
    });
  }
  rows.sort((a, b) => b.events - a.events);
  return rows;
}

// ── activity-bucketed time series (shared by getTimeseries and getSessionDetail) ────────────────

interface BucketableRow {
  ts: number;
  source: Source;
  tok: number;
  totalTok: number;
  countQuality?: TokenCounts['countQuality'];
  ucuCountQuality?: TokenCounts['countQuality'];
  usd: number;
  /** The row has no dollar figure / an ESTIMATE price (its own price quality). */
  unpriced?: boolean;
  estimated?: boolean;
  priceEvidence?: PriceEvidence;
}

/** Buckets rows by `Math.floor(ts / bucketMs) * bucketMs`, summing tokens/$ per bucket
 * independently. The reserved compatibility value of every bucket is `null` (unknown): stored
 * values are not summed. Sorted ascending by `t`. */
export function bucketTimeseries(rows: readonly BucketableRow[], bucketMs: number): TimeseriesPoint[] {
  const buckets = new Map<number, TimeseriesPoint>();
  // Buckets with at least one row whose price inputs are absent: their price status is unknown (null), not LIST.
  const priceUnknown = new Set<number>();
  const evidenceUnknown = new Set<number>();
  for (const r of rows) {
    const bucketStart = Math.floor(r.ts / bucketMs) * bucketMs;
    let point = buckets.get(bucketStart);
    if (!point) {
      point = { t: bucketStart, apiEquivUsd: 0, tokens: 0, totalTokens: 0, bySource: {}, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null };
      buckets.set(bucketStart, point);
      point.priceEvidence = emptyPriceEvidence();
    }
    point.apiEquivUsd += r.usd;
    if (r.priceEvidence) mergePriceEvidence(point.priceEvidence!, r.priceEvidence);
    else evidenceUnknown.add(bucketStart);
    point.tokens += r.tok;
    point.totalTokens = (point.totalTokens ?? 0) + r.totalTok;
    const rowQuality = normalizeCountQuality(r.countQuality);
    const rowUcuQuality = normalizeCountQuality(r.ucuCountQuality ?? r.countQuality);
    const uq = point.countQuality === undefined ? rowUcuQuality
      : weakestCountQuality(point.ucuCountQuality ?? point.countQuality, rowUcuQuality);
    point.countQuality = point.countQuality === undefined ? rowQuality : weakestCountQuality(point.countQuality, rowQuality);
    if (uq !== point.countQuality) point.ucuCountQuality = uq;
    else delete point.ucuCountQuality;
    if (r.unpriced !== undefined) point.unpricedEvents = (point.unpricedEvents ?? 0) + (r.unpriced ? 1 : 0);
    if (r.estimated !== undefined) point.estimatedPriceEvents = (point.estimatedPriceEvents ?? 0) + (r.estimated ? 1 : 0);
    if (r.unpriced === undefined || r.estimated === undefined) priceUnknown.add(bucketStart);
    // The weakest status of the bucket's own rows (UNPRICED > ESTIMATE > LIST); a bucket with an unknown input has no status (null).
    point.priceStatus = priceUnknown.has(bucketStart) ? null : (point.unpricedEvents ?? 0) > 0 ? 'UNPRICED' : (point.estimatedPriceEvents ?? 0) > 0 ? 'ESTIMATE' : 'LIST';
    point.bySource[r.source] = (point.bySource[r.source] ?? 0) + r.usd;
  }
  for (const [bucket, point] of buckets) {
    if (evidenceUnknown.has(bucket)) delete point.priceEvidence;
    else {
      qualifyAggregateAmount(point.priceEvidence!, point.apiEquivUsd);
      if (point.priceEvidence!.issuesEvents > 0 || point.priceEvidence!.aggregateAmountInvalid) point.priceStatus = null;
    }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/** Bucket size for a session-detail timeseries, chosen from the session's own span (founder spec:
 * "bucket size chosen by session length") rather than the tray's global hour/day buckets: 5-minute
 * buckets for a short session (<= 2h span — a global hour bucket would collapse the whole session
 * into 1-2 bars), hour buckets up to 2 days, day buckets beyond that. A non-positive/zero span
 * (single-event session) gets the finest (5-minute) bucket. */
export function chooseSessionBucketMs(spanMs: number): number {
  const FIVE_MIN = 5 * 60_000;
  const ONE_HOUR = 3_600_000;
  const ONE_DAY = 86_400_000;
  if (spanMs <= 2 * ONE_HOUR) return FIVE_MIN;
  if (spanMs <= 2 * ONE_DAY) return ONE_HOUR;
  return ONE_DAY;
}

// ── range handling ───────────────────────────────────────────────────────────

// ── local value (DESIGN §7.4, §15.5.3–5) ─────────────────────────────────────

/**
 * Energy of local inference as an ESTIMATE from configured watts × compute time (DESIGN §7.4,
 * §15.5.5: M4a energy is ESTIMATE from configured watts). kWh = Σ durationMs / 3.6e6 h × watts /
 * 1000; usd = kWh × tariff. Returns NONE (nulls) when watts or tariff is not configured, or when
 * any local event lacks a durationMs (its energy would be silently omitted — an undercount).
 */
export function estimateLocalEnergy(
  events: readonly Pick<UsageEvent, 'durationMs'>[],
  wattsEstimate: number | undefined,
  tariffUsdPerKwh: number | undefined
): LocalValue['energy'] {
  if (wattsEstimate === undefined || !Number.isFinite(wattsEstimate) || wattsEstimate <= 0 || tariffUsdPerKwh === undefined || !Number.isFinite(tariffUsdPerKwh) || tariffUsdPerKwh < 0) {
    return { kwh: null, usd: null, status: 'NONE' };
  }
  let ms = 0;
  for (const e of events) {
    if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0 || e.durationMs > Number.MAX_SAFE_INTEGER) {
      return { kwh: null, usd: null, status: 'NONE' };
    }
    ms += e.durationMs;
    if (!Number.isFinite(ms) || ms > Number.MAX_SAFE_INTEGER) return { kwh:null,usd:null,status:'NONE' };
  }
  const kwh = (ms / 3_600_000) * (wattsEstimate / 1000);
  const usd = kwh * tariffUsdPerKwh;
  return Number.isFinite(kwh) && Number.isFinite(usd) ? { kwh, usd, status:'ESTIMATE' } : { kwh:null, usd:null, status:'NONE' };
}

/** Output-weighted decode tok/s = Σ output / Σ (output / tok/s), over events that report it. */
export function weightedDecodeTokPerSec(events: readonly Pick<UsageEvent, 'tokens' | 'perf'>[]): number | undefined {
  let tokens = 0;
  let seconds = 0;
  for (const e of events) {
    const r = e.perf?.decodeTokPerSec;
    if (typeof r !== 'number' || !(r > 0) || e.tokens.output <= 0) continue;
    tokens += e.tokens.output;
    seconds += e.tokens.output / r;
  }
  return seconds > 0 ? tokens / seconds : undefined;
}

/** Names the comparator values are reported against. Labels only: no value is computed against them in this edition. */
export const LOCAL_VALUE_COMPARATORS = { claude: 'claude-sonnet-5', gpt: 'gpt-6-sol' } as const;

/**
 * LocalValue for a set of local-provider events. The comparator values are explicitly unavailable
 * (`usd: null`, status `'NONE'`): this edition configures no compute-unit rates, so local work is
 * never converted into a comparator's dollars. Energy is still estimated from configured watts and
 * tariff; net savings are therefore always unknown (`null`), never the energy cost relabelled.
 */
export function computeLocalValue(
  config: TokeneloConfig,
  localEvents: readonly UsageEvent[],
  malformedComponentEvents = 0
): LocalValue {
  const claude = localValueUnavailable(LOCAL_VALUE_COMPARATORS.claude, 0);
  const gpt = localValueUnavailable(LOCAL_VALUE_COMPARATORS.gpt, 0);
  if (malformedComponentEvents > 0) {
    // Never silently compute a full estimate from only the readable subset. Stored
    // normalized counts/dollars remain in Summary's independent aggregate path.
    return {
      captured: true,
      reason: `Combined local estimates are unavailable because component evidence is unreadable for ${malformedComponentEvents} recorded event(s). The model breakdown retains stored usage.`,
      readEvidence: { version: 1, state: 'malformed-components', captureMode: config.local.capture, events: localEvents.length + malformedComponentEvents,
        readableEvents: localEvents.length, malformedComponentEvents },
      valueVsClaude: claude,
      valueVsGpt: gpt,
      energy: { kwh: null, usd: null, status: 'NONE' },
      netSavingsVsClaude: null, netSavingsVsClaudeStatus: 'NONE',
      netSavingsVsGpt: null, netSavingsVsGptStatus: 'NONE',
    };
  }
  if (config.local.capture === 'off' && localEvents.length === 0) {
    return {
      captured: false,
      reason: 'local capture not configured',
      valueVsClaude: claude,
      valueVsGpt: gpt,
      energy: { kwh: null, usd: null, status: 'NONE' },
      netSavingsVsClaude: null,
      netSavingsVsClaudeStatus: 'NONE',
      netSavingsVsGpt: null,
      netSavingsVsGptStatus: 'NONE',
    };
  }
  const energy = estimateLocalEnergy(localEvents, config.local.wattsEstimate, config.local.tariffUsdPerKwh);
  const decode = weightedDecodeTokPerSec(localEvents);
  return {
    captured: true,
    ...(config.local.capture === 'off' ? { reason: 'local capture not configured (recorded local-model events remain available in this range)' } : {}),
    valueVsClaude: claude,
    valueVsGpt: gpt,
    energy,
    netSavingsVsClaude: null,
    netSavingsVsClaudeStatus: 'NONE',
    netSavingsVsGpt: null,
    netSavingsVsGptStatus: 'NONE',
    ...(decode !== undefined ? { decodeTokPerSec: decode } : {}),
  };
}

// ── the Queries interface http.ts and cli/index.ts depend on ───────────────

export interface SessionsOpts {
  range: Range;
  activeOnly: boolean;
}

export interface Queries {
  getSummary(range: Range, control?: ReadControl): Promise<SummaryResponse>;
  /** Available only through the daemon's isolated transactional worker, never a writable capture handle. */
  getUsage?(range: Range, control?: ReadControl): Promise<import('../core/types.js').UsageResponse>;
  getUsageReport?(range: Range, control?: ReadControl): Promise<import('../core/types.js').UsageResponse>;
  /** Daemon-only explicit historical job. Absent for direct CLI/legacy query implementations. */
  getSummaryReport?(range: Range, control?: ReadControl): Promise<SummaryResponse>;
  getSessions(opts: SessionsOpts, control?: ReadControl): Promise<SessionsResponse>;
  getLimits(): Promise<LimitsResponse>;
  getTimeseries(bucket: 'hour' | 'day', range: Range, control?: ReadControl): Promise<TimeseriesResponse>;
  getDoctor(control?: ReadControl): Promise<DoctorReport>;
  /** `GET /v1/sessions/detail?source=&sessionId=`. `null` when no session (own events/marks, or
   * any subagent's) matches `(source, sessionId)` at all — the route turns that into a 404. */
  getSessionDetail(source: Source, sessionId: string, control?: ReadControl): Promise<SessionDetail | null>;
  /** Raw event export for `tokenelo export` (DESIGN §15.7.8). Not part of the HTTP API. */
  exportEvents(range: Range): Promise<UsageEvent[]>;
  /** `GET /v1/processes` (build item 5) — live, on-demand (never cached/scheduled on this side;
   * see collectors/processes.ts's own doc for why). */
  getProcesses(): Promise<ProcessesResponse>;
  /** `GET /v1/coverage` (build item 6). */
  getCoverage(): Promise<CoverageResponse>;
  /** `GET /v1/limits/history` (build item 2's time-series requirement). */
  getPlanUsageHistory(): Promise<PlanUsageHistoryResponse>;
}

export interface CreateQueriesOpts {
  now?: () => number;
  /** Engines (daemon/main.ts#buildRuntime passes its own); default: the repo's rates files. */
  pricing?: PricingEngine;
  /** Ollama server discovery for `doctor` (tests inject a stub; default: live `probeOllama`). */
  probeOllama?: (upstream: string, signal?: AbortSignal) => Promise<OllamaProbeResult>;
  /** Live process listing for `getProcesses`/`getCoverage` (tests inject a stub; default:
   * collectors/processes.ts's real cross-platform `listAgentProcesses`). */
  listProcesses?: typeof listAgentProcesses;
  /** In-memory scheduler observations; never reconstructed from usage-event timestamps. */
  getCollectorScans?: () => CoverageResponse['collectorScans'];
  /** Current dual-capture health inputs; absent on legacy/direct query implementations. */
  getPrimaryOllamaActiveRequests?: () => number | null;
  getMeteringBacklogStatus?: () => MeteringBacklogStatus | null;
  /** Absolute path of the same database file. When set, Summary and Sessions read through one read-only snapshot
   * connection and load events and activity in keyset pages that yield between pages (store/read-snapshot.ts). When unset
   * (for example `:memory:`), they read on the handle synchronously, as before. */
  readSnapshotFile?: string;
  /** Worker-owned read-only handle already inside one transaction. Caller owns its lifetime.
   * Enables paging without opening a second snapshot; never supplied by the writable daemon. */
  readSnapshotDb?: TokeneloDb;
  /** Explicit fixed-clock worker contract for streamed Sessions reduction. Requires a snapshot;
   * legacy callers retain their later burn/live clock read. Never infer this from a callback. */
  fixedSessionReportAsOf?: number;
  /** Worker-wide cancellation also reaches Doctor discovery children. */
  readSignal?: AbortSignal;
  /** Rows per keyset page on the snapshot path. */
  pageRows?: number;
  /** Awaited between pages on the snapshot path. Tests inject a hook here; the default is one event-loop turn. */
  yieldNow?: () => Promise<void>;
}

/** Rows per keyset page on the snapshot path. A bound on one synchronous read, not a time promise. */
const DEFAULT_PAGE_ROWS = 2000;

/** The connection and paging a single request reads through. */
interface RequestReads {
  db: TokeneloDb;
  page?: PageOptions;
  close(): void;
}

/** Proposed reuse window for a successful process listing (see createQueries). */
export const PROCESS_LISTING_TTL_MS = 30_000;

/** Per-request wait for an uncached process listing. It bounds the response, not the probe (see currentProcessListing). */
export const PROCESS_LISTING_WAIT_MS = 750;

export function createQueries(db: TokeneloDb, config: TokeneloConfig, opts?: CreateQueriesOpts): Queries {
  const now = opts?.now ?? (() => Date.now());
  const fixedSessionAsOf = opts?.fixedSessionReportAsOf;
  if (fixedSessionAsOf !== undefined && (!Number.isSafeInteger(fixedSessionAsOf)
    || (!opts?.readSnapshotFile && !opts?.readSnapshotDb))) {
    throw new RangeError('fixed Sessions clock requires a safe integer and read snapshot');
  }
  let pricingCache = opts?.pricing ?? null;
  const pricing = (): PricingEngine => (pricingCache ??= defaultPricingEngine());
  // Doctor reports server/version/log evidence; its response never consumes blob-to-model mappings.
  const probe = opts?.probeOllama ?? ((upstream: string, signal?: AbortSignal) => probeOllama({ ollamaUpstream: upstream, signal, includeManifests: false }));
  // Process listing: a cached, checked result. A successful listing is reused for PROCESS_LISTING_TTL_MS
  // (proposed: 30 s), because one listing on Windows is a PowerShell CIM query of about 1.9 s measured on a
  // copy under load. A failed listing is never cached, and it is reported as unavailable, never as zero.
  const stubListing = opts?.listProcesses;
  const listingOf = async (host: string): Promise<ProcessListing> => {
    if (!stubListing) return listAgentProcessesChecked(host);
    try {
      return { status: 'ok', processes: await stubListing(host) };
    } catch {
      return { status: 'unavailable' };
    }
  };
  let processCache: { observedAt: number; processes: Extract<ProcessListing, { status: 'ok' }>['processes'] } | null = null;
  let processInflight: Promise<{ listing: ProcessListing; observedAt: number | null }> | null = null;
  // One probe at a time: every caller that arrives while it runs joins it. The probe never rejects, so a failure is
  // reported as unavailable (observedAt null) and is not cached; the in-flight slot is cleared when it settles.
  function startProbe(host: string): Promise<{ listing: ProcessListing; observedAt: number | null }> {
    return listingOf(host)
      .then((listing) => {
        const observedAt = now();
        if (listing.status === 'ok') processCache = { observedAt, processes: listing.processes };
        return { listing, observedAt };
      })
      .catch(() => ({ listing: { status: 'unavailable' as const }, observedAt: null }))
      .finally(() => {
        processInflight = null;
      });
  }
  // A caller waits at most PROCESS_LISTING_WAIT_MS for an uncached probe. A probe that is still running after that
  // is unknown for this response (unavailable, observedAt null), never zero, and it keeps running: a later request
  // joins it, or reuses its result if it completed inside the TTL.
  async function currentProcessListing(host: string): Promise<{ processes: Extract<ProcessListing, { status: 'ok' }>['processes']; listing: ProcessListingStatus }> {
    const t = now();
    if (processCache && t - processCache.observedAt < PROCESS_LISTING_TTL_MS) {
      return { processes: processCache.processes, listing: { status: 'ok', observedAt: processCache.observedAt } };
    }
    const probe = (processInflight ??= startProbe(host));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PROCESS_LISTING_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (settled !== null && settled.listing.status === 'ok') {
      return { processes: settled.listing.processes, listing: { status: 'ok', observedAt: settled.observedAt } };
    }
    return { processes: [], listing: { status: 'unavailable', observedAt: null, ...(settled === null ? { probePending: true as const } : {}) } };
  }

  function whereClause(filter: { since?: number; until?: number; asOf?: number; source?: Source; provider?: string }): {
    where: string;
    params: SqlParam[];
  } {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.since !== undefined) {
      clauses.push('ts >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('ts < ?');
      params.push(filter.until);
    }
    if (filter.asOf !== undefined) {
      clauses.push('ts <= ?');
      params.push(filter.asOf);
    }
    if (filter.source) {
      clauses.push('source = ?');
      params.push(filter.source);
    }
    if (filter.provider) {
      clauses.push('provider = ?');
      params.push(filter.provider);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  function selectAgg(since: number | undefined, d: TokeneloDb = db, asOf?: number): RawEventAgg[] {
    const { where, params } = whereClause({ since, asOf });
    return d
      .prepare(
        `SELECT source, model, provider, price_status, api_equiv_usd,
                input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, thinking, ${countColumnsFor(d)}
         FROM events ${where} ${asOf !== undefined ? (since !== undefined ? 'ORDER BY ts, rowid' : 'ORDER BY rowid') : ''}`
      )
      .all(...params) as unknown as RawEventAgg[];
  }

  function fetchEvents(filter: { since?: number; until?: number; asOf?: number; source?: Source; provider?: string }): UsageEvent[] {
    const { where, params } = whereClause(filter);
    const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY ts ASC`).all(...params) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  function selectActivity(since: number | undefined, asOf?: number): ActivityRow[] {
    const { where: clause, params } = whereClause({ since, asOf });
    return db.prepare(`SELECT * FROM activity ${clause} ORDER BY ts ASC`).all(...params) as unknown as ActivityRow[];
  }

  /** Opens the reads for one request: a snapshot connection and paging when the daemon gave a file, else the handle. */
  function openRequestReads(signal?: AbortSignal): RequestReads {
    signal ??= opts?.readSignal;
    checkRead(signal);
    if (!opts?.readSnapshotFile && !opts?.readSnapshotDb) return { db, close() {} };
    const snap = opts.readSnapshotDb ? { db: opts.readSnapshotDb, close() {} }
      : measure('query.snapshot_open', () => openReadSnapshot(opts.readSnapshotFile!));
    return {
      db: snap.db,
      page: { pageRows: opts.pageRows ?? DEFAULT_PAGE_ROWS, signal,
        yieldNow: async () => { checkRead(signal); await (opts.yieldNow ?? yieldToEventLoop)(); checkRead(signal); } },
      close: () => snap.close(),
    };
  }

  /** Events in (ts, rowid) order, for the request's reads. Same filter semantics as fetchEvents, without `until`/`source`. */
  async function loadEvents(r: RequestReads, filter: { since?: number; asOf?: number; provider?: string; sessionList?: boolean; onMalformedComponent?: () => void }): Promise<UsageEvent[]> {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter.since !== undefined) {
      clauses.push('ts >= ?');
      params.push(filter.since);
    }
    if (filter.asOf !== undefined) {
      clauses.push('ts <= ?');
      params.push(filter.asOf);
    }
    if (filter.provider) {
      clauses.push('provider = ?');
      params.push(filter.provider);
    }
    // Sessions consume recorded identity, attribution, counters, price evidence and flags.
    // Keep components_json/count_revision: legacy raw count evidence still qualifies normalized
    // counters in rowToEvent. Performance and unrelated request metadata belong to detail reads.
    const columns = filter.sessionList ? sessionEventColumns(r.db) : '*';
    const query: RowQuery = { table: 'events', columns, clauses, params };
    if (!filter.onMalformedComponent) return readRows<EventRow & { rid: number }, UsageEvent>(r.db, query, r.page, rowToEvent);
    const events = await readRows<EventRow & { rid: number }, UsageEvent | undefined>(r.db, query, r.page, row => {
      try { return rowToEvent(row); }
      catch (error) {
        if (!(error instanceof StoredComponentEvidenceError)) throw error;
        filter.onMalformedComponent!();
        return undefined;
      }
    });
    return events.filter((event): event is UsageEvent => event !== undefined);
  }

  function sessionEventColumns(d: TokeneloDb): string {
    // Unused list-only metadata stays absent. rowToEvent maps absent nullable fields
    // to the same undefined values as NULL, without allocating eight constant result
    // properties for every stored event. Detail reads retain their full payload.
    return [
      'id, host, source, ts_source, session_id, parent_session_id, is_subagent, project, repo_root',
      'model, provider, engine, thinking, components_json, input_fresh, cache_write_5m, cache_write_1h',
      'cache_read, output, reasoning, flags_json, api_equiv_usd, price_status, price_version',
      countColumnsFor(d, false),
    ].join(', ');
  }

  /** Both passes share the request's pinned transaction and ordered page traversal. Retain
   * only final parent assignments and aggregate values, not the complete event population. */
  async function loadSessionAggregate(r: RequestReads, since: number | undefined, asOf: number, control?: ReadControl): Promise<SessionEventAggregate> {
    const clauses = [...(since !== undefined ? ['ts >= ?'] : []), 'ts <= ?'];
    const params = [...(since !== undefined ? [since] : []), asOf];
    const ancestry = new SessionAncestryAccumulator();
    type IdentityRow = Pick<EventRow, 'host' | 'source' | 'session_id' | 'parent_session_id' | 'is_subagent'> & { ts: number; rid: number };
    sessionReadPhase(control, 'sessions.ancestry');
    await visitRows<IdentityRow>(r.db, { table: 'events',
      columns: 'host, source, session_id, parent_session_id, is_subagent',
      // Exclude only assignments the canonical hierarchy ignores. Full payload reads retain every event.
      clauses: [...clauses, 'is_subagent IS NOT 0', 'parent_session_id IS NOT NULL',
        "parent_session_id != ''", 'parent_session_id != session_id'], params }, r.page, row => ancestry.add({
        host: row.host, source: row.source as Source, sessionId: row.session_id,
        parentSessionId: row.parent_session_id ?? undefined, isSubagent: row.is_subagent !== 0,
      }));
    const aggregate = new SessionEventAggregate(ancestry.finish(), { asOf, idleGapMs: config.idleGapMs });
    sessionReadPhase(control, 'sessions.event-payload');
    await visitRows<EventRow & { ts: number; rid: number }>(r.db, { table: 'events',
      columns: sessionEventColumns(r.db), clauses, params }, r.page, row => aggregate.addEvent(rowToEvent(row)));
    return aggregate;
  }

  async function finishSessionAggregate(r: RequestReads, aggregate: SessionEventAggregate, marks: readonly ActivityMark[]): Promise<SessionRow[]> {
    const steps = aggregate.buildSteps(marks);
    if (!r.page) return measure('query.build_sessions', () => drainSteps(steps));
    const pacer = new YieldPacer(YIELD_BUDGET_MS, FILES_PER_YIELD, () => performance.now());
    const segment = new SyncSegment('query.build_sessions');
    try {
      return await drainStepsYielding(steps, { due: () => pacer.due(), yieldNow: async () => {
        await awaitOutside(segment, r.page!.yieldNow); pacer.yielded();
      } });
    } finally { segment.close(); }
  }

  /** Summary's timer only needs ordered identities/ancestry; avoid parsing every event's component/performance JSON. */
  async function summaryAgentMs(r: RequestReads, marks: readonly ActivityMark[], since: number | undefined, asOf: number, collected?: readonly ActivityGroupingEvent[]): Promise<number> {
    let events = collected;
    if (events === undefined) {
    const clauses = [...(since !== undefined ? ['ts >= ?'] : []), 'ts <= ?'];
    const params = [...(since !== undefined ? [since] : []), asOf];
    type GroupRow = Pick<EventRow, 'host' | 'source' | 'session_id' | 'parent_session_id' | 'is_subagent'> & { ts: number; rid: number };
    const identities = new ActivityGroupingIdentities();
    await visitRows<GroupRow>(r.db, {
      table: 'events', columns: 'host, source, session_id, parent_session_id, is_subagent', clauses, params,
    }, r.page, row => identities.add({ host: row.host, source: row.source as Source, sessionId: row.session_id,
      parentSessionId: row.parent_session_id ?? undefined, isSubagent: row.is_subagent !== 0 }));
    events = identities.events();
    }
    const steps = summedSessionActiveMsSteps(marks, events, config.idleGapMs);
    if (!r.page) return measure('query.active_time', () => drainSteps(steps));
    const pacer = new YieldPacer(YIELD_BUDGET_MS, FILES_PER_YIELD, () => performance.now());
    const seg = new SyncSegment('query.active_time');
    try {
      return await drainStepsYielding(steps, { due: () => pacer.due(), yieldNow: async () => {
        await awaitOutside(seg, r.page!.yieldNow); pacer.yielded();
      } });
    } finally { seg.close(); }
  }

  /** Build item 3: `desktop_sessions` row for a Claude session, by `cliSessionId === sessionId`.
   * `undefined` when no Claude Desktop Code-feature session ever matched this one (most sessions
   * never went through the Desktop app at all). Never queried for non-`claude` sources — the
   * table is keyed by the Claude Code CLI's own session id, which only ever exists for `claude`. */
  function desktopSessionMeta(source: Source, sessionId: string): DesktopSessionMeta | undefined {
    if (source !== 'claude') return undefined;
    const row = db
      .prepare(
        `SELECT cli_session_id, cwd, origin_cwd, title, model, effort, is_archived,
                created_at, last_activity_at, pr_number, pr_url, pr_repository, pr_state
         FROM desktop_sessions WHERE cli_session_id = ?`
      )
      .get(sessionId) as
      | {
          cli_session_id: string;
          cwd: string | null;
          origin_cwd: string | null;
          title: string | null;
          model: string | null;
          effort: string | null;
          is_archived: number | null;
          created_at: number | null;
          last_activity_at: number | null;
          pr_number: number | null;
          pr_url: string | null;
          pr_repository: string | null;
          pr_state: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      cliSessionId: row.cli_session_id,
      cwd: row.cwd ?? undefined,
      originCwd: row.origin_cwd ?? undefined,
      title: row.title ?? undefined,
      model: row.model ?? undefined,
      effort: row.effort ?? undefined,
      isArchived: row.is_archived === null ? undefined : row.is_archived !== 0,
      createdAt: row.created_at ?? undefined,
      lastActivityAt: row.last_activity_at ?? undefined,
      prNumber: row.pr_number ?? undefined,
      prUrl: row.pr_url ?? undefined,
      prRepository: row.pr_repository ?? undefined,
      prState: row.pr_state ?? undefined,
    };
  }

  /** One activity row as the mark the session build consumes. Per-row, so a page can be mapped on its own. */
  function activityRowToMark(a: ActivityRow): ActivityMark {
    return {
      source: a.source as Source,
      sessionId: a.session_id,
      ts: a.ts,
      uuid: a.uuid ?? undefined,
      host: a.host,
      project: a.project ?? undefined,
      kind: (a.kind as ActivityMark['kind']) ?? undefined,
      durationMs: a.duration_ms ?? undefined,
    };
  }

  function activityRowsToMarks(rows: readonly ActivityRow[]): ActivityMark[] {
    return rows.map(activityRowToMark);
  }

  function sessionsSince(since: number | undefined, activity?: readonly ActivityRow[], asOf?: number): SessionRow[] {
    const events = fetchEvents({ since, asOf });
    const marks = activityRowsToMarks(activity ?? selectActivity(since, asOf));
    return buildSessions(marks, events, { idleGapMs: config.idleGapMs, now });
  }

  /**
   * Session rows from events and marks the caller already read. On the snapshot path the build yields between steps (one
   * session group, or one chunk of grouping, at a time); the sync path is one call. Both return the same rows.
   */
  async function buildSessionRows(r: RequestReads, events: readonly UsageEvent[], marks: readonly ActivityMark[]): Promise<SessionRow[]> {
    const buildOpts = { idleGapMs: config.idleGapMs, now };
    if (!r.page) return measure('query.build_sessions', () => buildSessions(marks, events, buildOpts));
    const pacer = new YieldPacer(YIELD_BUDGET_MS, FILES_PER_YIELD, () => performance.now());
    // Each step between pauses is one synchronous segment, paused at each await (see SyncSegment).
    const seg = new SyncSegment('query.build_sessions');
    const rows = await buildSessionsYielding(marks, events, buildOpts, {
      due: () => pacer.due(),
      yieldNow: async () => {
        await awaitOutside(seg, r.page!.yieldNow);
        pacer.yielded();
      },
    });
    seg.close();
    return rows;
  }

  /** Fold each keyset page immediately in the original row order. Avoid retaining every raw
   * aggregate row alongside activity marks. Legacy synchronous callers keep their read path. */
  async function aggregateSummary(r: RequestReads, since: number | undefined, asOf: number): Promise<{ events: number; parts: AggregateParts; activityEvents?: ActivityGroupingEvent[] }> {
    const displayName = (model: string, provider?: ModelRow['provider']): string => recordedModelDisplayName(pricing(), model, provider ?? 'unknown');
    if (!r.page) {
      const rows = measure('query.agg', () => selectAgg(since, r.db, asOf));
      return { events: rows.length, parts: measure('query.agg_assemble', () => drainSteps(summaryAggregateSteps(rows, displayName))) };
    }
    const aggregate = new SummaryAggregate(displayName);
    const identities = new OrderedActivityGroupingIdentities();
    const query = aggregateRowQuery(since,countColumnsFor(r.db),asOf);
    query.columns += ', host, session_id, parent_session_id, is_subagent';
    await visitRows<RawEventAgg & { ts:number; rid:number; host:string; session_id:string; parent_session_id:string|null; is_subagent:number }>(r.db,
      query, { ...r.page, pageSpan:'query.agg_page' },row=>{
        aggregate.add(row);
        identities.add({host:row.host,source:row.source,sessionId:row.session_id,parentSessionId:row.parent_session_id??undefined,isSubagent:row.is_subagent!==0},row.ts,row.rid);
      });
    checkRead(r.page.signal);
    return { events:aggregate.events,parts:measure('query.agg_finish',()=>aggregate.finish()),activityEvents:identities.events() };
  }

  /** Activity marks in (ts, rowid) order, mapped per page on the snapshot path. */
  async function loadMarks(r: RequestReads, since: number | undefined, asOf?: number): Promise<ActivityMark[]> {
    const clauses = since !== undefined ? ['ts >= ?'] : [];
    const params: SqlParam[] = since !== undefined ? [since] : [];
    if (asOf !== undefined) { clauses.push('ts <= ?'); params.push(asOf); }
    // SQLite creates fresh strings for repeated attribution on each row. Share their values
    // within this request; retain every mark, field, UUID, timestamp and original row order.
    // Bound the pool so a high-cardinality ledger cannot create an unbounded extra index.
    const strings = new Map<string, string>();
    const intern = <T extends string | undefined>(value: T): T => {
      if (typeof value !== 'string') return value;
      const previous = strings.get(value);
      if (previous !== undefined) return previous as T;
      if (strings.size < 16_384) strings.set(value, value);
      return value;
    };
    return readRows<ActivityRow & { rid: number }, ActivityMark>(r.db, { table: 'activity', columns: '*', clauses, params }, r.page, row => {
      const mark = activityRowToMark(row);
      mark.source = intern(mark.source);
      mark.host = intern(mark.host);
      mark.sessionId = intern(mark.sessionId);
      mark.project = intern(mark.project);
      mark.kind = intern(mark.kind);
      return mark;
    });
  }

  /** Summary's timing rules use identities, UUID ownership, timestamps and duration precedence.
   * Source-file/project/kind payloads are not part of those rules. Keep the same keyset order
   * and full mark population; Sessions still read their attribution fields. */
  async function loadSummaryTimeMarks(r: RequestReads, since: number | undefined, asOf: number): Promise<ActivityMark[]> {
    const clauses = [...(since !== undefined ? ['ts >= ?'] : []), 'ts <= ?'];
    const params = [...(since !== undefined ? [since] : []), asOf];
    type TimeRow = Pick<ActivityRow, 'host' | 'source' | 'session_id' | 'uuid' | 'duration_ms'> & { ts: number; rid: number };
    return readRows<TimeRow, ActivityMark>(r.db, { table: 'activity',
      columns: 'host, source, session_id, uuid, duration_ms', clauses, params }, r.page,
      row => ({ host: row.host, source: row.source as Source, sessionId: row.session_id, ts: row.ts,
        uuid: row.uuid ?? undefined, durationMs: row.duration_ms ?? undefined }));
  }

  /** Subscription rows: each account is charged only its own kind's events (claude/codex) on its hosts. */
  function queryTimeBasis(since: number | undefined, asOf: number, d: TokeneloDb = db): NonNullable<SummaryResponse['timeBasis']> {
    return recordedQueryTimeBasis(d, since, asOf);
  }

  function subscriptions(since: number | undefined, until: number, d: TokeneloDb = db): SubscriptionRow[] {
    const out: SubscriptionRow[] = [];
    for (const account of config.accounts) {
      let apiEquivUsd = 0;
      // null = not queried (no hosts): unknown, never a zero count.
      let quality: PriceQuality | null = null;
      if (account.hosts.length > 0) {
        const params: SqlParam[] = [account.kind, ...account.hosts, until];
        let where = `WHERE source = ? AND host IN (${account.hosts.map(() => '?').join(',')}) AND ts <= ?`;
        if (since !== undefined) {
          where += ' AND ts >= ?';
          params.push(since);
        }
        const row = d
          .prepare(
            `SELECT COUNT(*) AS events, COALESCE(SUM(api_equiv_usd), 0) AS usd,
                    COALESCE(SUM(CASE WHEN api_equiv_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced,
                    COALESCE(SUM(CASE WHEN api_equiv_usd IS NOT NULL AND price_status = 'ESTIMATE' THEN 1 ELSE 0 END), 0) AS estimated,
                    ${PRICE_EVIDENCE_AGG_SQL}
               FROM events ${where}`,
          )
          .get(...params) as unknown as { events: number; usd: number; unpriced: number; estimated: number } & PriceEvidence;
        apiEquivUsd = row?.usd ?? 0;
        quality = priceQualityFromCounts(row.events, row.unpriced, row.estimated, priceEvidenceFromCounts({ events: row.events,
          invalidAmountEvents: row.invalidAmountEvents, unknownStatusEvents: row.unknownStatusEvents,
          statusAmountConflictEvents: row.statusAmountConflictEvents, issuesEvents: row.issuesEvents }, row.usd));
      }
      out.push(computeSubscriptionLeverage(account, apiEquivUsd, since ?? null, until, quality));
    }
    return out;
  }

  /**
   * Claude five-hour estimates use the union of each configured account's activity. Hosts without
   * an account mapping remain singleton groups. The SQL anchor is computed over each group's
   * activity union so a quiet gap on one host cannot discard activity that another host contributes.
   */
  function claudeBlockEstimates(nowMs: number, queryDb: TokeneloDb = db): LimitSnapshot[] {
    const hosts = (
      queryDb.prepare(`SELECT DISTINCT host FROM activity WHERE source = 'claude'`).all() as unknown as Array<{ host: string }>
    ).map((r) => r.host);
    const groups = new Map<string, string[]>();
    for (const host of hosts) {
      const key = accountGroupKey(host, 'claude', config.accounts);
      const members = groups.get(key);
      if (members) members.push(host);
      else groups.set(key, [host]);
    }
    const activityByHost = new Map<string, number[]>();
    const eventsByHost = new Map<string, UsageEvent[]>();
    for (const members of groups.values()) {
      const placeholders = members.map(() => '?').join(',');
      const anchorRow = queryDb
        .prepare(
          `SELECT MAX(ts) AS anchor FROM (
             SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS gap FROM activity WHERE source = 'claude' AND host IN (${placeholders})
           ) WHERE gap > ?`
        )
        .get(...members, FIVE_HOURS_MS) as { anchor: number | null } | undefined;
      const anchor = anchorRow?.anchor ?? null;
      let groupLastTs = Number.NEGATIVE_INFINITY;
      const active: string[] = [];
      for (const host of members) {
        const tsRows = queryDb
          .prepare(`SELECT ts FROM activity WHERE source = 'claude' AND host = ? AND ts >= ? ORDER BY ts ASC`)
          .all(host, anchor ?? Number.MIN_SAFE_INTEGER) as unknown as Array<{ ts: number }>;
        if (tsRows.length === 0) continue;
        const ts = tsRows.map((r) => r.ts);
        activityByHost.set(host, ts);
        active.push(host);
        groupLastTs = Math.max(groupLastTs, ts[ts.length - 1]!);
      }
      for (const host of active) {
        const evRows = queryDb
          .prepare(`SELECT * FROM events WHERE source = 'claude' AND host = ? AND ts >= ? ORDER BY ts ASC`)
          .all(host, groupLastTs - FIVE_HOURS_MS) as unknown as EventRow[];
        eventsByHost.set(host, evRows.map(rowToEvent));
      }
    }
    return computeClaudeBlockEstimates(activityByHost, eventsByHost, config.accounts, nowMs);
  }

  return {
    async getSummary(range: Range, control?: ReadControl): Promise<SummaryResponse> {
      const nowMs = now();
      const since = rangeSince(range, nowMs);
      const reads = openRequestReads(control?.signal);
      try {
        // Every read of this response goes through `reads.db`, so the totals, the sources, the local value and the
        // sessions all come from one database state.
        readPhase(control, 'reading-usage');
        summaryReadPhase(control, 'summary.usage');
        const { events, parts, activityEvents } = await aggregateSummary(reads, since, nowMs);

        summaryReadPhase(control, 'summary.local');
        let malformedComponentEvents = 0;
        const localEvents = await loadEvents(reads, { since, asOf: nowMs, provider: 'local', onMalformedComponent: () => { malformedComponentEvents++; } });
        const local = measure('query.local_value', () => computeLocalValue(config, localEvents, malformedComponentEvents));
        summaryReadPhase(control, 'summary.subscriptions');
        const subs = measure('query.subscriptions', () => subscriptions(since, nowMs, reads.db));

        readPhase(control, 'reading-activity');
        summaryReadPhase(control, 'summary.activity');
        let agentMs: number;
        let wallMs: number;
        if (reads.page && activityEvents) {
          // The snapshot path already yields ordered (ts,rowid) pages. Fold time as each page is
          // visited so a large range does not retain every ActivityMark and then dedupe/group it
          // in a second full-population pass. The synchronous compatibility path below remains
          // unchanged and is still the reference behavior for direct CLI readers.
          const accumulator = new SummaryActivityAccumulator(activityEvents, config.idleGapMs);
          const clauses = [...(since !== undefined ? ['ts >= ?'] : []), 'ts <= ?'];
          const params: SqlParam[] = [...(since !== undefined ? [since] : []), nowMs];
          type TimeRow = Pick<ActivityRow, 'host' | 'source' | 'session_id' | 'uuid' | 'duration_ms'> & { ts: number; rid: number };
          await visitRows<TimeRow>(reads.db, {
            table: 'activity', columns: 'host, source, session_id, uuid, duration_ms', clauses, params,
          }, reads.page, row => accumulator.add({
            host: row.host, source: row.source as Source, sessionId: row.session_id, ts: row.ts,
            uuid: row.uuid ?? undefined, durationMs: row.duration_ms ?? undefined,
          }, row.rid));
          summaryReadPhase(control, 'summary.active-time');
          const steps = accumulator.finishSteps();
          const pacer = new YieldPacer(YIELD_BUDGET_MS, FILES_PER_YIELD, () => performance.now());
          const segment = new SyncSegment('query.active_time');
          let result: { agentMs: number; wallMs: number };
          try {
            result = await drainStepsYielding(steps, { due: () => pacer.due(), yieldNow: async () => {
              await awaitOutside(segment, reads.page!.yieldNow); pacer.yielded();
            } });
          } finally { segment.close(); }
          agentMs = result.agentMs;
          wallMs = result.wallMs;
          summaryReadPhase(control, 'summary.wall-time');
        } else {
          const marks = await loadSummaryTimeMarks(reads, since, nowMs);
          summaryReadPhase(control, 'summary.active-time');
          agentMs = await summaryAgentMs(reads, marks, since, nowMs, activityEvents);
          summaryReadPhase(control, 'summary.wall-time');
          wallMs = unionWallMs(dedupeActivityMarks(marks).map((m) => m.ts), config.idleGapMs);
        }

        summaryReadPhase(control, 'summary.response');
        return {
          host: config.hostLabel,
          range,
          generatedAt: nowMs,
          timeBasis: queryTimeBasis(since, nowMs, reads.db),
          totals: {
            events,
            tokens: parts.totalsTokens,
            apiEquivUsd: parts.apiEquivUsd,
            unpricedEvents: parts.unpricedEvents,
            estimatedPriceEvents: parts.estimatedEvents,
            priceStatus: parts.totalsPriceStatus,
            priceEvidence: parts.totalsPriceEvidence,
          },
          bySource: parts.bySource,
          byModel: parts.byModel,
          local,
          subscriptions: subs,
          activeTime: { agentMs, wallMs },
        };
      } finally {
        reads.close();
      }
    },

    async getSessions(opts: SessionsOpts, control?: ReadControl): Promise<SessionsResponse> {
      // One clock read for the range boundary, reported as the response's query clock (not a snapshot identity).
      const nowMs = now();
      if (fixedSessionAsOf !== undefined && nowMs !== fixedSessionAsOf) throw new Error('fixed Sessions clock mismatch');
      const since = rangeSince(opts.range, nowMs);
      const reads = openRequestReads(control?.signal);
      try {
        sessionReadPhase(control, 'sessions.events');
        const aggregate = fixedSessionAsOf !== undefined ? await loadSessionAggregate(reads, since, nowMs, control) : undefined;
        const events = aggregate ? undefined : await loadEvents(reads, { since, asOf: nowMs, sessionList: true });
        sessionReadPhase(control, 'sessions.activity');
        const marks = await loadMarks(reads, since, nowMs);
        sessionReadPhase(control, 'sessions.aggregation');
        let sessions = aggregate ? await finishSessionAggregate(reads, aggregate, marks) : await buildSessionRows(reads, events!, marks);
        if (opts.activeOnly) sessions = sessions.filter((s) => s.live);
        sessionReadPhase(control, 'sessions.response');
        return { range: opts.range, generatedAt: nowMs, timeBasis: queryTimeBasis(since, nowMs, reads.db), sessions };
      } finally {
        reads.close();
      }
    },

    async getLimits(): Promise<LimitsResponse> {
      const reads = openRequestReads();
      const usesSameConnection = reads.db === db;
      let beganReadSavepoint = false;
      try {
        // The daemon supplies the same already-pinned WAL snapshot connection as `db`; this nested
        // savepoint composes with that request transaction. Direct CLI/legacy readers have no
        // separate snapshot connection, so the savepoint pins their first read instead. A
        // file-backed request snapshot owns its own transaction and needs no nested savepoint.
        // Using SAVEPOINT also avoids relying on DatabaseSync.isTransaction (added after Node 22.13).
        if (usesSameConnection) {
          reads.db.exec('SAVEPOINT tokenelo_limits_read');
          beganReadSavepoint = true;
        }
        const rows = reads.db
          .prepare(
            `SELECT * FROM (
               SELECT l.*, ROW_NUMBER() OVER (
                 PARTITION BY host, source, COALESCE(account, ''), COALESCE(limit_id, '')
                 ORDER BY captured_at DESC, id DESC
               ) AS rn
               FROM limits l
             ) WHERE rn = 1`
          )
          .all() as unknown as Array<{
          source: string;
          host: string;
          account: string | null;
          limit_id: string | null;
          captured_at: number;
          plan_type: string | null;
          windows_json: string;
          credits_json: string | null;
          estimate: number;
        }>;
        const stored: LimitSnapshot[] = rows.map((r) => ({
          source: r.source as LimitSnapshot['source'],
          ...(r.limit_id !== null ? { limitId: r.limit_id } : {}),
          host: r.host,
          account: r.account ?? undefined,
          capturedAt: r.captured_at,
          planType: r.plan_type ?? undefined,
          windows: JSON.parse(r.windows_json),
          credits: r.credits_json ? JSON.parse(r.credits_json) : undefined,
          estimate: r.estimate !== 0,
        }));
        const snapshots = [
          ...newestSnapshotPerSeries(stored, config.accounts),
          ...claudeBlockEstimates(now(), reads.db),
        ];
        if (beganReadSavepoint) {
          reads.db.exec('RELEASE tokenelo_limits_read');
          beganReadSavepoint = false;
        }
        return { snapshots };
      } catch (error) {
        if (beganReadSavepoint) {
          const cleanupErrors: unknown[] = [];
          try { reads.db.exec('ROLLBACK TO tokenelo_limits_read'); }
          catch (cleanupError) { cleanupErrors.push(cleanupError); }
          // Attempt release even if rollback fails, so a shared connection is not left with
          // a nested read savepoint when SQLite can still clean it up.
          try { reads.db.exec('RELEASE tokenelo_limits_read'); }
          catch (cleanupError) { cleanupErrors.push(cleanupError); }
          beganReadSavepoint = false;
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              'Limits read failed and request savepoint cleanup also failed',
              { cause: error }
            );
          }
        }
        throw error;
      } finally {
        if (!usesSameConnection) reads.close();
      }
    },

    async getTimeseries(bucket: 'hour' | 'day', range: Range, control?: ReadControl): Promise<TimeseriesResponse> {
      checkRead(control?.signal ?? opts?.readSignal);
      // One clock read: the range boundary and the reported generatedAt are the same instant (query clock, not a database revision).
      const nowMs = now();
      const since = rangeSince(range, nowMs);
      const bucketMs = bucket === 'hour' ? 3_600_000 : 86_400_000;
      timeseriesReadPhase(control, 'timeseries.sql');
      const tsRows = measure('timeseries.sql', () => db
        .prepare(
          `SELECT ts, source, output+input_fresh+cache_write_5m+cache_write_1h+${hasCountColumns(db) ? 'COALESCE(cache_write_unassigned,0)' : '0'} AS tok,
                  output+input_fresh+cache_write_5m+cache_write_1h+cache_read+${hasCountColumns(db) ? 'COALESCE(cache_write_unassigned,0)' : '0'} AS totalTok,
                  ${hasCountColumns(db) ? 'count_quality' : 'NULL'} AS countQuality,
                  ${hasCountColumns(db, 'ucu_count_quality') ? 'ucu_count_quality' : 'NULL'} AS ucuCountQuality, api_equiv_usd, price_status,
                  (api_equiv_usd IS NULL) AS unpriced, (api_equiv_usd IS NOT NULL AND price_status = 'ESTIMATE') AS estimated
           FROM events ${whereClause({ since, asOf: nowMs }).where}`
        )
        .all(...whereClause({ since, asOf: nowMs }).params)) as unknown as Array<{
        ts: number;
        source: Source;
        tok: number;
        totalTok: number;
        countQuality: TokenCounts['countQuality'] | null;
        ucuCountQuality: TokenCounts['countQuality'] | null;
        api_equiv_usd: number | null;
        unpriced: number;
        estimated: number;
        price_status: string;
      }>;
      timeseriesReadPhase(control, 'timeseries.map');
      const mappedRows: BucketableRow[] = measure('timeseries.map', () => {
        return tsRows.map((r) => ({
          ts: r.ts,
          source: r.source,
          tok: r.tok,
          totalTok: r.totalTok,
          countQuality: normalizeCountQuality(r.countQuality),
          ucuCountQuality: normalizeCountQuality(r.ucuCountQuality ?? r.countQuality),
          usd: r.api_equiv_usd ?? 0,
          unpriced: r.unpriced === 1,
          estimated: r.estimated === 1,
          priceEvidence: priceEvidenceOf(r.api_equiv_usd, r.price_status),
        }));
      });
      timeseriesReadPhase(control, 'timeseries.bucket');
      const points = measure('timeseries.bucket', () => bucketTimeseries(mappedRows, bucketMs));
      // bucketTimeseries sets both price-quality counts on every point it builds, so this responder declares the capability.
      checkRead(control?.signal ?? opts?.readSignal);
      timeseriesReadPhase(control, 'timeseries.response');
      return { bucket, range, generatedAt: nowMs, timeBasis: queryTimeBasis(since, nowMs), priceQualityCounts: true, points };
    },

    async getSessionDetail(source: Source, sessionId: string, control?: ReadControl): Promise<SessionDetail | null> {
      checkRead(control?.signal ?? opts?.readSignal);
      const nowMs = now();
      const liveThresholdMs = 5 * 60 * 1000; // matches core/sessions.ts#buildSessions's default

      // `fetchEvents`'s filter has no sessionId param (its other callers never needed one) — query
      // the events table directly instead of widening that shared helper's contract for one caller.
      detailReadPhase(control, 'detail-own-events');
      const ownEventsRows = db
        .prepare(`SELECT * FROM events WHERE source = ? AND session_id = ? ORDER BY ts ASC, rowid ASC`)
        .all(source, sessionId) as unknown as EventRow[];
      const own = ownEventsRows.map(rowToEvent);
      // Discover every recorded generation, using the same last valid assignment and host/source
      // namespace as session grouping. UNION bounds repeated/cyclic identities; SessionHierarchy
      // then removes cyclic edges consistently with the list and Summary timer.
      // Keep the descendant identities outermost and use the v1 source/session index;
      // otherwise SQLite can scan source-wide event rows or build a large automatic index.
      detailReadPhase(control, 'detail-descendants');
      const candidateRows = db.prepare(`WITH RECURSIVE
        ranked AS (
          SELECT host, session_id, parent_session_id,
            ROW_NUMBER() OVER (PARTITION BY host, session_id ORDER BY ts DESC, rowid DESC) AS rank
          FROM events WHERE source = ? AND is_subagent = 1
            AND parent_session_id IS NOT NULL AND parent_session_id <> '' AND parent_session_id <> session_id
        ), links AS (SELECT host, session_id, parent_session_id FROM ranked WHERE rank = 1),
        descendants(host, session_id) AS (
          SELECT host, session_id FROM links WHERE parent_session_id = ?
          UNION
          SELECT l.host, l.session_id FROM links l JOIN descendants d
            ON l.host = d.host AND l.parent_session_id = d.session_id
        )
        SELECT e.* FROM descendants d CROSS JOIN events e INDEXED BY idx_events_source_session
          ON e.host = d.host AND e.session_id = d.session_id
        WHERE e.source = ? AND e.session_id <> ? ORDER BY e.ts ASC, e.rowid ASC
      `).all(source, sessionId, source, sessionId) as unknown as EventRow[];
      checkRead(control?.signal ?? opts?.readSignal);
      const candidates = candidateRows.map(rowToEvent);
      const hierarchy = new SessionHierarchy([...own, ...candidates].sort((a, b) => a.ts - b.ts));
      const descendantsByHost = new Map<string, Set<string>>();
      for (const event of candidates) {
        if (!descendantsByHost.has(event.host)) descendantsByHost.set(event.host, hierarchy.descendants(event.host, source, sessionId));
      }
      const subagentEvents = candidates.filter(event => descendantsByHost.get(event.host)?.has(event.sessionId));

      const subagentSessionIds = [...new Set(subagentEvents.map((e) => e.sessionId))];
      const directSubagentIds = [...new Set(subagentEvents.filter(event =>
        hierarchy.children(event.host, source, sessionId).includes(event.sessionId)).map(event => event.sessionId))];

      detailReadPhase(control, 'detail-activity');
      const ownMarksRows = db
        .prepare(`SELECT * FROM activity WHERE source = ? AND session_id = ? ORDER BY ts ASC`)
        .all(source, sessionId) as unknown as ActivityRow[];
      const subagentMarksRows: ActivityRow[] =
        subagentSessionIds.length === 0
          ? []
          : (db
              .prepare(
                `SELECT * FROM activity WHERE source = ? AND session_id IN (${subagentSessionIds.map(() => '?').join(',')}) ORDER BY ts ASC`
              )
              .all(source, ...subagentSessionIds) as unknown as ActivityRow[]);
      const ownMarks = activityRowsToMarks(ownMarksRows);
      const subagentMarks = activityRowsToMarks(subagentMarksRows).filter(mark => descendantsByHost.get(mark.host)?.has(mark.sessionId));
      const allMarksSorted = dedupeActivityMarks([...ownMarks, ...subagentMarks]).sort((a, b) => a.ts - b.ts);

      detailReadPhase(control, 'detail-aggregation');
      const allEvents = [...own, ...subagentEvents];
      if (allEvents.length === 0 && allMarksSorted.length === 0) return null; // no such session at all

      // Plain loops (never Math.min/max(...arr)): a long-running session can carry far more than
      // the call-stack-safe number of marks/events (core/sessions.ts#buildSessions's own comment).
      let start = Infinity;
      let end = -Infinity;
      for (const m of allMarksSorted) {
        if (m.ts < start) start = m.ts;
        if (m.ts > end) end = m.ts;
      }
      for (const e of allEvents) {
        if (e.ts < start) start = e.ts;
        if (e.ts > end) end = e.ts;
      }

      const activeMs = computeActiveMs(source, allMarksSorted, config.idleGapMs);
      const live = nowMs - end < liveThresholdMs;

      const pickOwn = <T>(pick: (e: UsageEvent) => T | undefined): T | undefined => {
        const ownHit = own.find((e) => pick(e) !== undefined);
        if (ownHit) return pick(ownHit);
        const anyHit = allEvents.find((e) => pick(e) !== undefined);
        return anyHit ? pick(anyHit) : undefined;
      };
      const host =
        own[0]?.host ?? subagentEvents[0]?.host ?? ownMarks[0]?.host ?? subagentMarks[0]?.host ?? config.hostLabel;
      const project = pickOwn((e) => e.project) ?? activityProject(ownMarks, { host, source, sessionId });
      const repoRootOfEvents = pickOwn((e) => e.repoRoot);
      const gitBranch = pickOwn((e) => e.gitBranch);
      const entrypoint = pickOwn((e) => e.entrypoint);

      const tokens = sumTokensOfEvents(allEvents);
      const apiEquivUsd = sumApiEquivUsdOfEvents(allEvents);
      const priceFields = priceFieldsOf(allEvents);
      const burn = computeBurn(allEvents, nowMs);
      const byModel = buildModelRowsFromEvents(allEvents, pricing());

      const grossPrompt = tokens.inputFresh + tokens.cacheWrite5m + tokens.cacheWrite1h + (tokens.cacheWriteUnassigned ?? 0) + tokens.cacheRead;
      const cacheReadShare = grossPrompt > 0 && !hasUnresolvedCounts(tokens) ? tokens.cacheRead / grossPrompt : null;

      let thinkingTrue = 0;
      let thinkingFalse = 0;
      let thinkingUnknownEvents = 0;
      for (const e of allEvents) {
        if (e.thinking === true) thinkingTrue++;
        else if (e.thinking === false) thinkingFalse++;
        else thinkingUnknownEvents++;
      }
      const thinkingDeterminable = thinkingTrue + thinkingFalse;
      const thinkingShare = thinkingDeterminable > 0 ? thinkingTrue / thinkingDeterminable : null;

      const flags: Partial<Record<EventFlag, number>> = {};
      for (const e of allEvents) {
        for (const f of e.flags) flags[f] = (flags[f] ?? 0) + 1;
      }

      const bucketMs = chooseSessionBucketMs(end - start);
      const timeseriesPoints = bucketTimeseries(
        allEvents.map((e) => ({
          ts: e.ts,
          source: e.source,
          tok: e.tokens.inputFresh + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h + (e.tokens.cacheWriteUnassigned ?? 0) + e.tokens.output,
          totalTok: e.tokens.inputFresh + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h + (e.tokens.cacheWriteUnassigned ?? 0) + e.tokens.cacheRead + e.tokens.output,
          countQuality: e.tokens.countQuality ?? 'unrecorded',
          ucuCountQuality: e.tokens.ucuCountQuality ?? e.tokens.countQuality ?? 'unrecorded',
          usd: e.apiEquivUsd ?? 0,
          unpriced: e.apiEquivUsd === null,
          estimated: e.apiEquivUsd !== null && e.priceStatus === 'ESTIMATE',
          priceEvidence: priceEvidenceOf(e.apiEquivUsd, e.priceStatus),
        })),
        bucketMs
      );

      const subagentSessions: SessionDetailSubagent[] = directSubagentIds.map((subId) => {
        const branchByHost = new Map<string, Set<string>>();
        for (const event of subagentEvents) {
          if (!branchByHost.has(event.host)) branchByHost.set(event.host, hierarchy.descendants(event.host, source, subId));
        }
        const inBranch = (host: string, id: string) => id === subId || branchByHost.get(host)?.has(id) === true;
        const subEvents = subagentEvents.filter(event => inBranch(event.host, event.sessionId));
        const subMarks = subagentMarks.filter(mark => inBranch(mark.host, mark.sessionId)).sort((a, b) => a.ts - b.ts);
        let subStart = Infinity;
        let subEnd = -Infinity;
        for (const m of subMarks) {
          if (m.ts < subStart) subStart = m.ts;
          if (m.ts > subEnd) subEnd = m.ts;
        }
        for (const e of subEvents) {
          if (e.ts < subStart) subStart = e.ts;
          if (e.ts > subEnd) subEnd = e.ts;
        }
        return {
          sessionId: subId,
          subagents: new Set(subEvents.filter(event => event.sessionId !== subId).map(event => event.sessionId)).size,
          models: uniqueModelsInOrder(subEvents),
          start: subStart,
          end: subEnd,
          activeMs: computeActiveMs(source, subMarks, config.idleGapMs),
          live: nowMs - subEnd < liveThresholdMs,
          tokens: sumTokensOfEvents(subEvents),
          apiEquivUsd: sumApiEquivUsdOfEvents(subEvents),
          ...priceFieldsOf(subEvents),
        };
      });

      detailReadPhase(control, 'detail-response');
      return {
        source,
        sessionId,
        host,
        project,
        repoRoot: repoRootOfEvents,
        models: uniqueModelsInOrder(allEvents),
        start: start === Infinity ? nowMs : start,
        end: end === -Infinity ? nowMs : end,
        activeMs,
        activityEvidence: activityTimeEvidence(source, allMarksSorted, config.idleGapMs),
        live,
        subagents: subagentSessionIds.length,
        tokens,
        apiEquivUsd,
        ...priceFields,
        burn,
        telemetry: summarizeSessionTelemetry(allEvents),
        byModel,
        timeseries: { bucketMs, points: timeseriesPoints },
        subagentSessions,
        cacheReadShare,
        thinkingShare,
        thinkingUnknownEvents,
        events: allEvents.length,
        firstEventTs: allEvents.length > 0 ? allEvents.reduce((m, e) => Math.min(m, e.ts), Infinity) : null,
        lastEventTs: allEvents.length > 0 ? allEvents.reduce((m, e) => Math.max(m, e.ts), -Infinity) : null,
        wallMs: (end === -Infinity ? nowMs : end) - (start === Infinity ? nowMs : start),
        flags,
        ...(gitBranch !== undefined ? { gitBranch } : {}),
        ...(entrypoint !== undefined ? { entrypoint } : {}),
        ...((): { desktopMeta?: DesktopSessionMeta } => {
          const meta = desktopSessionMeta(source, sessionId);
          return meta ? { desktopMeta: meta } : {};
        })(),
      };
    },

    async getDoctor(control?: ReadControl): Promise<DoctorReport> {
      const signal = control?.signal ?? opts?.readSignal;
      checkRead(signal);
      const reads = openRequestReads(signal);
      const doctorDb = reads.db;
      try {
      // Only static phase names cross the profiler boundary. These synchronous spans contain
      // no await; the external probe below has its own interval, never a synchronous span.
      function diagnostic<T>(name: DoctorReadPhase, read: () => T): T {
        checkRead(signal);
        doctorReadPhase(control, name);
        return measure(name, read);
      }
      const warnings: string[] = [];
      // Same pinned worker transaction, with cancellation checks between census rows.
      doctorReadPhase(control, 'doctor.event-census');
      const census = await readDoctorCensus(doctorDb, signal, phase => doctorReadPhase(control, phase));
      const priceRow = census;
      const priceEvidence = priceEvidenceFromCounts({ events: priceRow.events, invalidAmountEvents: priceRow.invalidAmountEvents,
        unknownStatusEvents: priceRow.unknownStatusEvents, statusAmountConflictEvents: priceRow.statusAmountConflictEvents, issuesEvents: priceRow.issuesEvents }, priceRow.usd);
      if (priceEvidence.issuesEvents > 0 || priceEvidence.aggregateAmountInvalid) warnings.push(
        `Stored price fields need review: ${priceEvidence.invalidAmountEvents} invalid amounts, ${priceEvidence.unknownStatusEvents} unknown price labels, ${priceEvidence.statusAmountConflictEvents} label/amount conflicts. Stored values have not been recalculated.`);
      // count = distinct skipped PATHS per reason. `skipped.count` is sightings (bumped on every
      // scan), which grows with daemon uptime and is not a number of paths.
      const skippedRows = diagnostic('doctor.skipped-paths', () => doctorDb.prepare('SELECT path, reason FROM skipped ORDER BY path').all()) as unknown as Array<{
        path: string;
        reason: SkipReason;
      }>;
      const byReason = new Map<SkipReason, { count: number; examples: string[] }>();
      for (const r of skippedRows) {
        const bucket = byReason.get(r.reason) ?? { count: 0, examples: [] };
        bucket.count += 1;
        if (bucket.examples.length < 5) bucket.examples.push(r.path);
        byReason.set(r.reason, bucket);
      }
      const skippedPaths = [...byReason.entries()].map(([reason, v]) => ({ reason, ...v }));

      const unmatchedModels = (
        diagnostic('doctor.unmatched-models', () => doctorDb
          .prepare(
            `SELECT model, COUNT(*) AS n FROM events WHERE api_equiv_usd IS NULL GROUP BY model ORDER BY n DESC, model`
          )
          .all()) as unknown as Array<{ model: string; n: number }>
      ).map((r) => ({ model: r.model, events: r.n }));

      const thinkingUnknownEvents = Number(census.thinkingUnknownEvents);
      const ollamaLogThinkingUnknown = Number(census.ollamaLogThinkingUnknown);
      if (ollamaLogThinkingUnknown > 0) {
        warnings.push(
          `ollama-log: thinking mode is not determinable per request (the server log only exposes a per-model-load ` +
            `template hint, never a per-request signal) — ${ollamaLogThinkingUnknown} event(s) flagged thinkingUnknown`
        );
      }

      // Codex per-FILE counts from each rollout's persisted parse summary (collectors/codex.ts
      // CodexFileState.summary in ingest_state.extra), not per-event flags.
      const codexRow = diagnostic('doctor.codex-cursor-summaries', () => doctorDb
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN json_extract(extra_json, '$.summary.resets') > 0 THEN 1 ELSE 0 END), 0) AS resetFiles,
             COALESCE(SUM(CASE WHEN json_extract(extra_json, '$.summary.baselineTotal') > 0
                                 OR json_extract(extra_json, '$.summary.replayEvents') > 0
                                 OR json_extract(extra_json, '$.summary.olderTurnEvents') > 0 THEN 1 ELSE 0 END), 0) AS inheritedBaselineFiles,
             COALESCE(SUM(CASE WHEN json_extract(extra_json, '$.summary.inheritedBaselineSuspect') = 1 THEN 1 ELSE 0 END), 0) AS suspectFiles,
             COALESCE(SUM(CASE WHEN json_extract(extra_json, '$.summary.recordEvents') > 0 THEN 1 ELSE 0 END), 0) AS recordReconciledFiles,
             COALESCE(SUM(COALESCE(json_extract(extra_json, '$.summary.nonZeroCacheWrite'), 0)), 0) AS nonZeroCacheWrite,
             COALESCE(SUM(CASE WHEN json_extract(extra_json, '$.summary.ownInWrapperEvents') > 0 THEN 1 ELSE 0 END), 0) AS ownInWrapperFiles,
             COALESCE(SUM(COALESCE(json_extract(extra_json, '$.summary.ownInWrapperEvents'), 0)), 0) AS ownInWrapperEvents,
             COALESCE(SUM(CASE WHEN json_extract(extra_json, '$.summary.trailingRecords') > 0 THEN 1 ELSE 0 END), 0) AS trailingRecordFiles
           FROM ingest_state
           WHERE extra_json IS NOT NULL AND json_valid(extra_json)
             AND json_type(extra_json, '$.summary.tokenCountEvents') IS NOT NULL`
        )
        .get()) as DoctorReport['codex'];
      const codex: DoctorReport['codex'] = {
        resetFiles: Number(codexRow.resetFiles),
        inheritedBaselineFiles: Number(codexRow.inheritedBaselineFiles),
        suspectFiles: Number(codexRow.suspectFiles),
        recordReconciledFiles: Number(codexRow.recordReconciledFiles),
        nonZeroCacheWrite: Number(codexRow.nonZeroCacheWrite),
        ownInWrapperFiles: Number(codexRow.ownInWrapperFiles),
        ownInWrapperEvents: Number(codexRow.ownInWrapperEvents),
        trailingRecordFiles: Number(codexRow.trailingRecordFiles),
      };
      if (codex.nonZeroCacheWrite > 0) {
        warnings.push(
          `codex: ${codex.nonZeroCacheWrite} token_count event(s) with non-zero cache_write_input_tokens — the §15.2.8 subset assumption needs review`
        );
      }

      const claude: DoctorReport['claude'] = {
        speedAssumed: Number(census.speedAssumed),
        cacheSplitAssumed: Number(census.cacheSplitAssumed),
        iterationEvents: Number(census.iterationEvents),
        reasoningClamped: Number(census.reasoningClamped),
      };

      const incompleteCapture = readClaudeIncompleteCapture(doctorDb);
      let servers: DoctorReport['ollama']['servers'] = [];
      doctorReadPhase(control, 'doctor.ollama-probe');
      const probeInterval = intervalBegin('doctor.ollama-probe');
      try {
        const res = await probe(config.local.ollamaUpstream, signal);
        checkRead(signal);
        for (const s of res.servers) {
          if (!s.reachable || s.version === null) {
            if (s.process) warnings.push(`ollama: a process listens on ${s.address}:${s.port} but /api/version did not answer`);
            continue;
          }
          servers.push({
            address: s.address,
            family: s.family,
            version: s.version,
            ...(s.process?.command ? { binary: executablePathOnly(s.process.command) } : {}),
            ...(s.log.path ? { logPath: s.log.path } : {}),
            logAvailable: s.log.available,
          });
        }
      } catch (err) {
        checkRead(signal);
        servers = [];
        warnings.push(`ollama: probe failed: ${String(err)}`);
      } finally {
        intervalEnd(probeInterval);
      }
      const unmeteredRow = diagnostic('doctor.unmetered-metadata', () => doctorDb.prepare('SELECT value FROM meta WHERE key = ?').get(META_UNMETERED_KEY)) as
        | { value: string }
        | undefined;

      const aclWarningRow = diagnostic('doctor.acl-metadata', () => doctorDb.prepare('SELECT value FROM meta WHERE key = ?').get(META_ACL_WARNING_KEY)) as
        | { value: string }
        | undefined;
      if (aclWarningRow?.value === '1') {
        warnings.push(
          'windows: failed to restrict the API token file ACL via icacls — the token file may be readable by other local users'
        );
      }

      checkRead(signal);
      doctorReadPhase(control, 'doctor.response');
      return {
        host: config.hostLabel,
        generatedAt: now(),
        priceEvidence,
        skippedPaths,
        unmatchedModels,
        thinkingUnknownEvents,
        codex,
        claude,
        incompleteCapture,
        ollama: {
          servers,
          unmeteredRequests: unmeteredRow ? Number(unmeteredRow.value) || 0 : 0,
          capture: config.local.capture,
        },
        warnings,
      };
      } finally { reads.close(); }
    },

    async exportEvents(range: Range) {
      return fetchEvents({ since: rangeSince(range, now()) });
    },

    async getProcesses(): Promise<ProcessesResponse> {
      const { processes, listing } = await currentProcessListing(config.hostLabel);
      return { host: config.hostLabel, generatedAt: now(), processes, listing };
    },

    async getCoverage(): Promise<CoverageResponse> {
      const nowMs = now();
      // Never fails the endpoint over a listing error; an unavailable listing is reported as such, and its
      // `running` flags are unknown rather than "not running".
      const { processes: running, listing: processListing } = await currentProcessListing(config.hostLabel);
      const runningToolIds = new Set(running.map((p) => p.tool));

      const telemetryRows = db.prepare(
        `SELECT source, provider, engine, MAX(ts) AS maxTs FROM events GROUP BY source, provider, engine`
      ).all() as unknown as Array<{
        source: Source;
        provider: Provider;
        engine: string | null;
        maxTs: number | null;
      }>;

      // Some catalog entries are captured as LimitSnapshots (the `limits` table), not UsageEvents
      // — e.g. Claude Desktop's plan-usage-history.json, which carries no tokens at all.
      const lastLimitByLimitsSource = new Map<string, number>();
      const limitsSourceRows = db.prepare(`SELECT source, MAX(captured_at) AS maxTs FROM limits GROUP BY source`).all() as unknown as Array<{
        source: string;
        maxTs: number | null;
      }>;
      for (const r of limitsSourceRows) if (r.maxTs !== null) lastLimitByLimitsSource.set(r.source, r.maxTs);

      const platformKey: 'darwin' | 'win32' | 'linux' = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
      const home = os.homedir();

      const tools: CoverageEntry[] = AGENT_CATALOG.map((entry) => {
        const running_ = runningToolIds.has(entry.id);
        const installPaths = entry.installPaths?.[platformKey] ?? [];
        const installedByPath = installPaths.some((p) => {
          try {
            return fs.existsSync(path.join(home, p));
          } catch {
            return false;
          }
        });
        const selectors = entry.eventSelectors ?? (entry.source ? [{ source: entry.source }] : []);
        let lastEventAt: number | null = null;
        let lastTelemetryTimeBasis: CoverageEntry['lastTelemetryTimeBasis'] = null;
        for (const row of telemetryRows) {
          if (row.maxTs === null) continue;
          const matches = selectors.some((selector) =>
            selector.source === row.source &&
            (selector.provider === undefined || selector.provider === row.provider) &&
            (selector.engine === undefined || selector.engine === row.engine || (selector.allowMissingEngine === true && row.engine === null))
          );
          if (matches && (lastEventAt === null || row.maxTs > lastEventAt)) {
            lastEventAt = row.maxTs;
            lastTelemetryTimeBasis = 'event-recorded';
          }
        }
        if (lastEventAt === null && !entry.eventSelectors && !entry.source && entry.limitsSource) {
          lastEventAt = lastLimitByLimitsSource.get(entry.limitsSource) ?? null;
          if (lastEventAt !== null) lastTelemetryTimeBasis = 'plan-captured';
        }
        /* Source-only coverage remains supported for the existing CLI entries. Selector-based
         * entries distinguish Ollama server-log/proxy, configured local engines, and local models
         * observed inside Claude Code JSONL without letting unrelated events make them look live. */
        return {
          id: entry.id,
          name: entry.name,
          category: entry.category,
          installed: running_ || installedByPath,
          running: running_,
          captured: lastEventAt !== null,
          lastEventAt,
          lastTelemetryTimeBasis,
          ...(entry.notCapturableReason ? { reason: entry.notCapturableReason, captureSupport: entry.captureSupport ?? 'not-capturable' as const } : {}),
        };
      });

      const collectorScans = opts?.getCollectorScans?.();
      const localCapture = localCaptureCoverageStatus(db, config, nowMs, opts?.getPrimaryOllamaActiveRequests?.() ?? null, opts?.getMeteringBacklogStatus?.() ?? null);
      return { host: config.hostLabel, generatedAt: nowMs, tools,
        localCapture,
        incompleteCapture: readClaudeIncompleteCapture(db),
        processListing,
        ...(collectorScans !== undefined ? { collectorScans } : {}),
      };
    },

    async getPlanUsageHistory(): Promise<PlanUsageHistoryResponse> {
      const rows = db
        .prepare(`SELECT account, captured_at, windows_json FROM limits WHERE source = 'claude-desktop' ORDER BY captured_at ASC`)
        .all() as unknown as Array<{ account: string | null; captured_at: number; windows_json: string }>;
      const byAccount = new Map<string, PlanUsageHistoryResponse['series'][number]['points']>();
      for (const r of rows) {
        const account = r.account ?? 'unknown';
        const windows = JSON.parse(r.windows_json) as { id: string; usedPercent: number | null }[];
        const fh = windows.find((w) => w.id === 'five_hour')?.usedPercent ?? null;
        const sd = windows.find((w) => w.id === 'seven_day')?.usedPercent ?? null;
        const points = byAccount.get(account) ?? [];
        points.push({ t: r.captured_at, fiveHourUsedPercent: fh, sevenDayUsedPercent: sd });
        byAccount.set(account, points);
      }
      return {
        host: config.hostLabel,
        series: [...byAccount.entries()].map(([account, points]) => ({ account, points })),
      };
    },
  };
}

function localCaptureCoverageStatus(
  db: TokeneloDb,
  config: TokeneloConfig,
  observedAt: number,
  activeSignal: number | null,
  backlog: MeteringBacklogStatus | null,
): LocalCaptureCoverageStatus {
  if (config.local.capture !== 'both') return { mode: config.local.capture, observedAt, dualSettle: null };
  const rows = db.prepare(`SELECT extra_json FROM ingest_state WHERE key LIKE 'ollama-serverlog:%'`).all() as unknown as Array<{ extra_json: string | null }>;
  if (rows.length === 0) return {
    mode: 'both', observedAt,
    dualSettle: { state: 'unobserved', pendingLogEstimates: null, pendingLimitReached: null, historyIncomplete: null,
      activePrimaryProxyRequests: activeSignal, backlogPending: backlog?.pending ?? null, backlogLastError: backlog?.lastError ?? null,
      backlogReviewRequired: backlog ? (backlog.historyIncomplete === true || backlog.failureEvidenceStored === false || backlog.quarantined > 0 || backlog.writeFailures > 0) : null },
  };

  let pendingLogEstimates = 0;
  let pendingLimitReached = false;
  let historyIncomplete = false;
  let unknown = false;
  for (const row of rows) {
    if (typeof row.extra_json !== 'string') { unknown = true; continue; }
    let extra: unknown;
    try { extra = JSON.parse(row.extra_json); } catch { unknown = true; continue; }
    if (!extra || typeof extra !== 'object') { unknown = true; continue; }
    const state = extra as { pendingBlocks?: unknown; pendingLimitReached?: unknown; historyIncomplete?: unknown };
    if (!Array.isArray(state.pendingBlocks) || typeof state.pendingLimitReached !== 'boolean' || typeof state.historyIncomplete !== 'boolean') {
      unknown = true;
      continue;
    }
    const validBlocks = state.pendingBlocks.every((block) => {
      if (!block || typeof block !== 'object') return false;
      const b = block as { model?: unknown; promptEvalCount?: unknown; evalCount?: unknown; totalMs?: unknown; endTs?: unknown; durationMs?: unknown; path?: unknown };
      return typeof b.model === 'string' && Number.isSafeInteger(b.promptEvalCount) && Number.isSafeInteger(b.evalCount)
        && Number.isSafeInteger(b.endTs) && Number.isFinite(b.durationMs) && typeof b.path === 'string';
    });
    if (!validBlocks || pendingLogEstimates + state.pendingBlocks.length > Number.MAX_SAFE_INTEGER) { unknown = true; continue; }
    pendingLogEstimates += state.pendingBlocks.length;
    pendingLimitReached ||= state.pendingLimitReached;
    historyIncomplete ||= state.historyIncomplete;
  }
  const backlogReviewRequired = backlog
    ? backlog.historyIncomplete === true || backlog.failureEvidenceStored === false || backlog.quarantined > 0 || backlog.writeFailures > 0
    : null;
  const state: NonNullable<LocalCaptureCoverageStatus['dualSettle']>['state'] = rows.length === 0 ? 'unobserved'
    : historyIncomplete ? 'history-incomplete'
      : pendingLimitReached ? 'limit-reached'
        : unknown || activeSignal === null || backlog === null ? 'unknown'
          : backlogReviewRequired === true ? 'backlog-review'
            : pendingLogEstimates > 0 || activeSignal > 0 || backlog.pending > 0 || backlog.lastError !== null ? 'settling'
              : 'no-held-estimates';
  return {
    mode: 'both', observedAt,
    dualSettle: {
      state,
      pendingLogEstimates: unknown ? null : pendingLogEstimates,
      pendingLimitReached: unknown ? null : pendingLimitReached,
      historyIncomplete: unknown ? null : historyIncomplete,
      activePrimaryProxyRequests: activeSignal,
      backlogPending: backlog?.pending ?? null,
      backlogLastError: backlog?.lastError ?? null,
      backlogReviewRequired,
    },
  };
}

/** Wall time (ms) of point activity timestamps joined into intervals whose gaps are ≤ idleGapMs
 * (DESIGN §6 idle rule) — the summary endpoint's "wall time" (union across sessions). */
export function unionWallMs(timestamps: readonly number[], idleGapMs = 300_000): number {
  if (timestamps.length === 0) return 0;
  const sorted = [...timestamps].sort((a, b) => a - b);
  let total = 0;
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const t = sorted[i]!;
    if (t - prev > idleGapMs) {
      total += prev - start;
      start = t;
    }
    prev = t;
  }
  total += prev - start;
  return total;
}
