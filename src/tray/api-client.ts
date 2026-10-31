/**
 * Tray → daemon HTTP client. Real mode calls the daemon's local read-only API
 * (`127.0.0.1:<config.api.port>`, default 47821 per DESIGN §2.2) with the bearer token written by
 * the daemon to the data-dir token file (`../daemon/paths.js#getPaths().apiTokenFile`,
 * DESIGN §15.7.3). Mock mode (`TOKENELO_MOCK=<dir>`) serves canned JSON from that directory
 * instead of touching the network or the token file at all — used by `--snapshot` and by tests.
 *
 * Real routes (verified against the actual src/daemon/http.ts once it landed — this module was
 * first written before that file existed, assuming an `/api/*` prefix and a bare `SessionRow[]`
 * from `/sessions`; both were wrong and are fixed here, see this agent's report for the diff):
 *   GET /v1/summary?range=<Range>                          → SummaryResponse
 *   GET /v1/sessions?range=<Range>&active=0|1               → { range, sessions: SessionRow[] }
 *   GET /v1/limits                                          → LimitsResponse
 *   GET /v1/timeseries?range=<Range>&bucket=hour|day         → TimeseriesResponse
 *   GET /v1/doctor                                          → DoctorReport
 *   GET /v1/coverage                                        → CoverageResponse (build item 6)
 *   GET /v1/processes                                       → ProcessesResponse (build item 5)
 *   GET /v1/sessions/detail?source=<Source>&sessionId=<id>  → SessionDetail
 *   GET /v1/health                                          → { status, generatedAt } (used by isDaemonReachable)
 * `getSessions(range?)` omits `active` always (`active=0`, i.e. all of the range's sessions, not
 * just live ones — matching the Now tab's "live and recent" framing) and omits `range` itself when
 * called with no argument, which the daemon then defaults to 'today' — the Now tab's own call
 * pattern. The Sessions tab (task item 3, founder req. 2026-09-27) passes an explicit `range` for
 * its own range selector. `bucket` (getTimeseries) is derived from `range`: 'hour' for
 * 'today'/'24h', 'day' otherwise (the daemon itself defaults `bucket` to 'day' when omitted,
 * which would give a single-bucket chart for 'today').
 *
 * Mock mode file naming (test/fixtures/api/*.json — see that directory's fixtures):
 *   summary-<range>.json, fleet-<range>.json, sessions.json, limits.json, timeseries-<range>.json, doctor.json,
 *   coverage.json, processes.json.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import type {
  CoverageResponse,
  DoctorReport,
  FleetHostResult,
  FleetOverviewResponse,
  FleetSummaryResponse,
  HostLabel,
  LimitsResponse,
  ProcessesResponse,
  Range,
  SessionDetail,
  SessionRow,
  SessionsResponse,
  Source,
  SummaryResponse,
  UsageResponse,
  TimeseriesResponse,
  TokenCounts,
  RuntimeBuildIdentityStatus,
} from '../core/types.js';
import { USAGE_SOURCES } from '../core/types.js';
import { hasInvalidTokenValues } from '../core/token-counts.js';
import { priceQualityProblem, type PriceStatusLabel } from '../core/price-quality.js';
import { priceEvidenceProblem } from '../core/price-evidence.js';
import { fetchWithoutContentDecoding } from '../core/no-compression-fetch.js';
import { getPaths } from '../daemon/paths.js';
import { loadBuildIdentity, parseBuildIdentity, type BuildIdentity } from '../daemon/build-identity.js';
import { loadConfig } from '../daemon/config.js';
import { isTailnetPeerUrl, readFleetPeerToken } from '../daemon/fleet.js';

/** Fallback only — the real port always comes from `loadConfig(getPaths())`'s `api.port` (security
 * audit #4: the port used to be hardcoded here, independent of what the daemon was actually
 * configured/told to listen on). */
export const DEFAULT_API_PORT = 47821;

export class DaemonIdentityError extends Error {}

/** Intentional report-read cancellation observed by the client; it does not attest lease release or server-worker exit.
 * Fixed text and no stack: Electron may log the rejection before the stale renderer discards it. */
export class ReportReadRetiredError extends Error {
  constructor(message = 'The previous report view was retired.') {
    super(message);
    this.name = 'ReportReadRetiredError';
    Object.defineProperty(this, 'stack', { value: undefined, configurable: true });
  }
}
export class SummaryReadRetiredError extends ReportReadRetiredError {
  constructor() { super('[tokenelo:summary-cancelled] Historical usage report cancelled.'); this.name = 'SummaryReadRetiredError'; }
}

/** Resolves the configured API port for `env`, falling back to `DEFAULT_API_PORT` if the config
 * can't be read (e.g. it genuinely doesn't exist yet — the client shouldn't crash on that). */
export function resolveConfiguredPort(env: Record<string, string | undefined>): number {
  try {
    return loadConfig(getPaths({ env })).api.port;
  } catch {
    return DEFAULT_API_PORT;
  }
}

export interface ApiClient {
  getSummary(range: Range): Promise<SummaryResponse>;
  getUsage(range: Range, control?: { signal?: AbortSignal; onProgress?: (progress: SummaryReadProgress) => void }): Promise<UsageResponse>;
  getSummaryReport(range: Range, control?: { signal?: AbortSignal; onProgress?: (progress: SummaryReadProgress) => void }): Promise<SummaryResponse>;
  getSessions(range?: Range): Promise<SessionRow[]>;
  /** Same route and rows as getSessions, as the full envelope. `generatedAt` is present only when the daemon sent a valid clock. */
  getSessionsResponse(range?: Range): Promise<SessionsResponse>;
  getLimits(): Promise<LimitsResponse>;
  getTimeseries(range: Range): Promise<TimeseriesResponse>;
  getDoctor(): Promise<DoctorReport>;
  getCoverage(): Promise<CoverageResponse>;
  getProcesses(): Promise<ProcessesResponse>;
  getSessionDetail(source: Source, sessionId: string): Promise<SessionDetail>;
  getFleetOverview(range: Range): Promise<FleetOverviewResponse>;
}

export interface SummaryReadProgress { status: 'queued' | 'running'; phase?: 'reading-usage' | 'reading-activity' }
/** Bounds the explicit job operation; every admission/poll/body retains its ordinary fetch deadline. */
export const SUMMARY_OPERATION_TIMEOUT_MS = 50_000;

/** Mock-mode fixture filename for one session's detail — sanitized so an opaque collector-
 * assigned sessionId (Codex thread ids, Ollama `<client>:<model>:<date>` keys, …) that contains
 * characters unsafe in a filename (`:`, `/`) never escapes the fixtures directory or collides
 * with an unrelated file; falls back to a single generic `session-detail.json` fixture (mirroring
 * every other mock-mode method's "one canonical file, falls back if the specific one is missing"
 * pattern) so a snapshot/test doesn't need one fixture file per session id it might click into. */
function sessionDetailFixtureNames(source: Source, sessionId: string): string[] {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return [`session-detail-${source}-${safeId}.json`, 'session-detail.json'];
}

export interface ApiClientOptions {
  /** Overrides `http://127.0.0.1:<port>`. */
  baseUrl?: string;
  /** Overrides TOKENELO_MOCK. When set (or the env var is set), no network/token-file access happens. */
  mockDir?: string;
  /** Snapshot verification opt-in: exact range-specific files and matching response scope, no legacy fallback/array relabeling. */
  strictMockRanges?: boolean;
  /** Overrides the token file path (default: getPaths().apiTokenFile). */
  tokenFile?: string;
  /** Overrides this tray package's build identity for deterministic tests; not a user setting. */
  buildIdentity?: BuildIdentity | null;
  /** Injectable for tests; defaults to the Node HTTP client that refuses encoded responses. */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Overrides LOCAL_REQUEST_TIMEOUT_MS (tests). Not a user setting. */
  localTimeoutMs?: number;
}

/**
 * Deadline for each local daemon request (the /v1/hello challenge, and each read). Twenty seconds is an engineering judgement,
 * not a measured service level or proof that the daemon pause is resolved. The first read of a client makes two requests,
 * the challenge and the read, so it can wait up to twice this.
 */
export const LOCAL_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Start of every DaemonTimeoutError message. Electron's IPC passes only `String(error)` to the renderer, so the class does not
 * survive the crossing; the renderer recognises a timeout by this marker alone (renderer/request-failure.ts keeps the same string,
 * and a test checks that the two match).
 */
export const LOCAL_TIMEOUT_MARKER = '[tokenelo:local-timeout]';

// Fleet summaries aggregate each host's local usage data and can take several seconds on the
// larger databases. Keep the timeout above the measured cold-query latency (6–9s) so healthy
// peers are not shown as offline during initial collection.
const FLEET_REQUEST_TIMEOUT_MS = 15_000;

function fleetSummaryFromLocal(summary: SummaryResponse): FleetSummaryResponse {
  return {
    host: summary.host,
    range: summary.range,
    generatedAt: summary.generatedAt,
    totals: summary.totals,
    bySource: summary.bySource,
    activeTime: summary.activeTime,
  };
}

function constantTimeHexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Price-quality fields on a peer's totals (M3e). A peer built before a field existed omits it: that is UNKNOWN (null), never zero or LIST.
 * Fields that are present must be consistent with each other and with the event count; a corrupt block (negative, fractional, unknown label,
 * or a status that contradicts its counts) makes the peer untrusted.
 */
export function priceQualityTotalsOk(totals: Record<string, unknown>): boolean {
  if (totals.priceEvidence !== undefined && priceEvidenceProblem(totals.priceEvidence, typeof totals.events === 'number' ? totals.events : -1) !== null) return false;
  // Empty range from a peer built before the empty-range rule: LIST with no events and no counts is the empty state (normalised to null below).
  if (totals.priceEvidence === undefined && totals.events === 0 && totals.priceStatus === 'LIST' && (totals.unpricedEvents ?? 0) === 0 && (totals.estimatedPriceEvents ?? 0) === 0) return true;
  const legacyOnly = totals.estimatedPriceEvents === undefined && totals.priceStatus === undefined;
  if (legacyOnly) {
    // A payload from before the price-quality fields: only the unpriced count may be present (and it must be a valid count).
    return totals.unpricedEvents === undefined || (typeof totals.unpricedEvents === 'number' && Number.isSafeInteger(totals.unpricedEvents) && totals.unpricedEvents >= 0 && typeof totals.events === 'number' && totals.unpricedEvents <= totals.events);
  }
  return priceQualityProblem({
    events: totals.events,
    unpricedEvents: totals.unpricedEvents,
    estimatedPriceEvents: totals.estimatedPriceEvents,
    priceStatus: totals.priceStatus,
    ...(totals.priceEvidence !== undefined ? { priceEvidence: totals.priceEvidence } : {}),
  }) === null;
}

/** The fixed aggregate fields a Fleet peer may send for its totals and for each source row. Any other member is ignored, never carried on. */
const FLEET_AGGREGATE_KEYS = ['events', 'tokens', 'apiEquivUsd', 'unpricedEvents', 'estimatedPriceEvents', 'priceStatus', 'priceEvidence'] as const;

/** A copy of `row` holding only the fixed aggregate fields it actually carries (absent stays absent). */
export function pickFleetAggregate(row: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of FLEET_AGGREGATE_KEYS) if (Object.hasOwn(row, key)) picked[key] = row[key];
  return picked;
}

/** Totals with the price-quality fields normalised: absent means unknown (null), present values are kept as they were validated. Members outside the fixed aggregate fields are dropped. */
export function normalizeFleetTotals(totals: Record<string, unknown>): Record<string, unknown> & {
  unpricedEvents: number | null;
  estimatedPriceEvents: number | null;
  priceStatus: PriceStatusLabel | null;
} {
  return {
    ...pickFleetAggregate(totals),
    unpricedEvents: typeof totals.unpricedEvents === 'number' ? totals.unpricedEvents : null,
    estimatedPriceEvents: typeof totals.estimatedPriceEvents === 'number' ? totals.estimatedPriceEvents : null,
    // No events means no price status (null). Already-deployed peers send LIST here; it is the same empty state.
    priceStatus: totals.events === 0 ? null : typeof totals.priceStatus === 'string' ? (totals.priceStatus as PriceStatusLabel) : null,
  };
}

const nonnegativeFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonnegativeCount = (value: unknown): value is number => nonnegativeFinite(value) && Number.isSafeInteger(value);

function validFleetSourceRow(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return nonnegativeCount(r.events) && nonnegativeFinite(r.apiEquivUsd) && !!r.tokens
    && typeof r.tokens === 'object' && !hasInvalidTokenValues(r.tokens as TokenCounts)
    && priceQualityTotalsOk(r);
}

function isFleetSummary(value: unknown, expectedHost: HostLabel, range: Range): value is FleetSummaryResponse {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FleetSummaryResponse>;
  const tokens = candidate.totals?.tokens;
  const tokenFields = tokens
    ? [tokens.inputFresh, tokens.cacheWrite5m, tokens.cacheWrite1h, tokens.cacheRead, tokens.output, tokens.reasoning]
    : [];
  return (
    candidate.host === expectedHost &&
    candidate.range === range &&
    typeof candidate.generatedAt === 'number' && Number.isFinite(candidate.generatedAt) &&
    !!candidate.totals &&
    nonnegativeCount(candidate.totals.events) &&
    nonnegativeFinite(candidate.totals.apiEquivUsd) &&
    // Older peers may omit the price-quality fields: accepted, and recorded as unknown (null) below, never as zero.
    priceQualityTotalsOk(candidate.totals as unknown as Record<string, unknown>) &&
    !!candidate.totals.tokens &&
    tokenFields.length === 6 && !hasInvalidTokenValues(tokens!) &&
    [tokens!.cacheWriteUnassigned, tokens!.cacheWriteAssumed1h].every(field => field === undefined
      || typeof field === 'number' && Number.isSafeInteger(field) && field >= 0) &&
    (tokens!.countQuality === undefined || ['complete', 'incomplete', 'invalid', 'conflict', 'unrecorded'].includes(tokens!.countQuality)) &&
    (tokens!.ucuCountQuality === undefined || ['complete', 'incomplete', 'invalid', 'conflict', 'unrecorded'].includes(tokens!.ucuCountQuality)) &&
    typeof candidate.activeTime?.agentMs === 'number' &&
    typeof candidate.activeTime?.wallMs === 'number' &&
    nonnegativeFinite(candidate.activeTime.agentMs) &&
    nonnegativeFinite(candidate.activeTime.wallMs) &&
    !!candidate.bySource &&
    typeof candidate.bySource === 'object' &&
    Object.values(candidate.bySource).every(validFleetSourceRow)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Mock Fleet snapshots are deliberately closed: a new field must be reviewed before it can enter a saved fixture. */
function hasOnlyKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
}

function fleetFixturePriceEvidenceOk(value: unknown): boolean {
  return value === undefined || hasOnlyKeys(value,
    ['version', 'events', 'invalidAmountEvents', 'unknownStatusEvents', 'statusAmountConflictEvents', 'issuesEvents', 'aggregateAmountInvalid']);
}

function isAggregateFleetSummaryFixture(value: unknown, expectedHost: HostLabel, range: Range): value is FleetSummaryResponse {
  if (!hasOnlyKeys(value, ['host', 'range', 'generatedAt', 'totals', 'bySource', 'activeTime'])) return false;
  const summary = value as unknown as FleetSummaryResponse;
  if (!hasOnlyKeys(summary.totals,
    ['events', 'tokens', 'apiEquivUsd', 'unpricedEvents', 'estimatedPriceEvents', 'priceStatus'], ['priceEvidence'])) return false;
  if (!fleetFixturePriceEvidenceOk(summary.totals.priceEvidence)) return false;
  if (!hasOnlyKeys(summary.totals.tokens,
    ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'],
    ['cacheWriteUnassigned', 'cacheWriteAssumed1h', 'countQuality', 'ucuCountQuality'])) return false;
  if (!hasOnlyKeys(summary.activeTime, ['agentMs', 'wallMs'])) return false;
  if (!isPlainRecord(summary.bySource) || Object.keys(summary.bySource).length !== USAGE_SOURCES.length
    || USAGE_SOURCES.some(source => !Object.hasOwn(summary.bySource, source))) return false;
  for (const source of USAGE_SOURCES) {
    const row = summary.bySource[source];
    if (!hasOnlyKeys(row, ['events', 'tokens', 'apiEquivUsd'], ['unpricedEvents', 'estimatedPriceEvents', 'priceStatus', 'priceEvidence'])) return false;
    if (!fleetFixturePriceEvidenceOk(row.priceEvidence)) return false;
    if (!hasOnlyKeys(row.tokens,
      ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'],
      ['cacheWriteUnassigned', 'cacheWriteAssumed1h', 'countQuality', 'ucuCountQuality'])) return false;
  }

  // FleetOverviewResponse is the client-facing, normalized shape: older peers' omitted fields are
  // represented as null. isFleetSummary validates the wire shape, where those fields are absent.
  const wireUnknown = (row: Record<string, unknown>): Record<string, unknown> =>
    row.unpricedEvents === null && row.estimatedPriceEvents === null && row.priceStatus === null
      ? { ...row, unpricedEvents: undefined, estimatedPriceEvents: undefined, priceStatus: undefined }
      : row;
  const wireSummary = {
    ...summary,
    totals: wireUnknown(summary.totals as unknown as Record<string, unknown>),
    bySource: Object.fromEntries(USAGE_SOURCES.map(source => [source, wireUnknown(summary.bySource[source] as unknown as Record<string, unknown>)])),
  };
  return isFleetSummary(wireSummary, expectedHost, range);
}

function isFleetOverviewFixture(value: unknown, range: Range): value is FleetOverviewResponse {
  if (!hasOnlyKeys(value, ['range', 'generatedAt', 'hosts'])) return false;
  const overview = value as unknown as FleetOverviewResponse;
  if (overview.range !== range || !Number.isSafeInteger(overview.generatedAt) || overview.generatedAt < 0
    || !Array.isArray(overview.hosts) || overview.hosts.length === 0) return false;

  const labels = new Set<string>();
  let localHosts = 0;
  for (const host of overview.hosts) {
    if (!hasOnlyKeys(host, ['label', 'kind', 'status'], ['summary'])
      || typeof host.label !== 'string' || host.label.length === 0 || labels.has(host.label)
      || (host.kind !== 'local' && host.kind !== 'peer')
      || !['online', 'offline', 'unauthorized', 'untrusted', 'not-configured', 'report-timeout', 'report-unavailable'].includes(host.status)) return false;
    labels.add(host.label);
    if (host.kind === 'local') localHosts++;
    if (host.status === 'online') {
      if (!isAggregateFleetSummaryFixture(host.summary, host.label, range)) return false;
    } else if (Object.hasOwn(host, 'summary')) return false;
  }
  return localHosts === 1;
}

class FleetRequestTimeoutError extends Error {}

function withTimeout<T>(promiseFactory: (signal: AbortSignal) => Promise<T>, timeoutMs = FLEET_REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new FleetRequestTimeoutError('Fleet request deadline exceeded');
      controller.abort(reason);
      reject(reason);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => promiseFactory(controller.signal)), deadline])
    .finally(() => clearTimeout(timer));
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The local API token file is missing or could not be read. Thrown only by the live client's token read, so a caller can recognise
 * this case by type instead of by message text. Its name stays 'ApiError', so the string the renderer receives over IPC is unchanged.
 */
export class ApiTokenFileError extends ApiError {}

/** A local request that did not complete (response and body) within its deadline. Says nothing about why the daemon was slow. */
export class DaemonTimeoutError extends Error {
  constructor(
    readonly route: string,
    readonly timeoutMs: number
  ) {
    super(`${LOCAL_TIMEOUT_MARKER} GET ${route} did not complete within ${timeoutMs}ms`);
    this.name = 'DaemonTimeoutError';
  }
}

/**
 * Runs one local request (the fetch, the status check and the body parse) under one deadline. The deadline rejects from its own
 * timer, so a fetch that ignores its abort signal, or a body that stalls after the headers arrived, still ends the request. The
 * timer rejects before it aborts, so the timeout is what the caller sees, and a late result or abort failure of `request` is ignored.
 * Nothing is retried.
 */
function withLocalDeadline<T>(
  route: string,
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  settleOnParentAbort = false,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  let parentCancelled = false;
  let parentReason: unknown;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      parentCancelled = true;
      parentReason = parent?.reason ?? new Error('read_cancelled');
      controller.abort(parentReason);
      if (!settleOnParentAbort) reject(parentReason);
    };
    if (parent?.aborted) cancel();
    else parent?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      const timeout = new DaemonTimeoutError(route, timeoutMs);
      reject(timeout);
      controller.abort();
    }, timeoutMs);
  });
  const work = Promise.resolve().then(() => request(controller.signal)).then(
    (value) => {
      if (settleOnParentAbort && parentCancelled) throw parentReason;
      return value;
    },
    (error) => {
      if (settleOnParentAbort && parentCancelled) throw parentReason;
      throw error;
    },
  );
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
    if (cancel) parent?.removeEventListener('abort', cancel);
  });
}

/** Largest epoch ms a JavaScript Date can hold (±8.64e15). */
const MAX_EPOCH_MS = 8.64e15;

/**
 * The sessions envelope with its query clock checked. `generatedAt` is kept only when it is a whole epoch millisecond in
 * [0, 8.64e15]; anything else (absent on an older daemon, fractional, negative, non-numeric) is omitted: unknown. The clock is never
 * filled from the time the client received the response. `range`, `sessions` and supplied `timeBasis` are passed through
 * unchanged. The renderer validates recorded-window evidence; absent older metadata is never supplied from this clock.
 */
export function normalizeSessionsResponse(body: { range: Range; sessions: SessionRow[]; generatedAt?: unknown; timeBasis?: SessionsResponse['timeBasis'] }): SessionsResponse {
  const clock = body.generatedAt;
  const known = typeof clock === 'number' && Number.isInteger(clock) && clock >= 0 && clock <= MAX_EPOCH_MS;
  return { range: body.range, ...(known ? { generatedAt: clock } : {}),
    ...(body.timeBasis !== undefined ? { timeBasis: body.timeBasis } : {}), sessions: body.sessions };
}

/** sessions.json is a bare SessionRow[] (legacy fixture) or a full envelope. A bare array has no clock: unknown. */
function mockSessionsResponse(raw: unknown, range: Range | undefined): SessionsResponse {
  if (Array.isArray(raw)) return { range: range ?? 'today', sessions: raw as SessionRow[] };
  return normalizeSessionsResponse(raw as SessionsResponse);
}

function readMockJson(dir: string, candidates: string[]): unknown {
  for (const name of candidates) {
    const full = `${dir.replace(/\/+$/, '')}/${name}`;
    if (fs.existsSync(full)) {
      const text = fs.readFileSync(full, 'utf8');
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new ApiError(`mock fixture ${full} is not valid JSON: ${(err as Error).message}`);
      }
    }
  }
  throw new ApiError(
    `no mock fixture found in ${dir} (tried: ${candidates.join(', ')}) — TOKENELO_MOCK is set but the file is missing`
  );
}

function readRangedMock(dir: string, candidates: string[], range: Range, strict: boolean): unknown {
  const body = readMockJson(dir, candidates);
  if (strict && (body === null || typeof body !== 'object' || (body as { range?: unknown }).range !== range)) {
    throw new ApiError('mock fixture does not match the requested range');
  }
  return body;
}

export function createApiClient(opts: ApiClientOptions = {}): ApiClient {
  const env = opts.env ?? process.env;
  const mockDir = opts.mockDir ?? env.TOKENELO_MOCK;

  if (mockDir) {
    const strict = opts.strictMockRanges === true;
    const sessions = (range: Range = 'today') => mockSessionsResponse(readRangedMock(
      mockDir, strict ? [`sessions-${range}.json`] : ['sessions.json'], range, strict
    ), range);
    return {
      async getUsage(range, control) {
        if (control?.signal?.aborted) throw control.signal.reason ?? new SummaryReadRetiredError();
        return { snapshotScope: 'filed-fixture',
          summary: readRangedMock(mockDir, strict ? [`summary-${range}.json`] : [`summary-${range}.json`, 'summary-today.json'], range, strict) as SummaryResponse,
          timeseries: readRangedMock(mockDir, strict ? [`timeseries-${range}.json`] : [`timeseries-${range}.json`, 'timeseries-today.json'], range, strict) as TimeseriesResponse };
      },
      async getSummary(range) {
        return readRangedMock(mockDir, strict ? [`summary-${range}.json`] : [`summary-${range}.json`, 'summary-today.json'], range, strict) as SummaryResponse;
      },
      async getSummaryReport(range, control) {
        if (control?.signal?.aborted) throw control.signal.reason ?? new SummaryReadRetiredError();
        return readRangedMock(mockDir, strict ? [`summary-${range}.json`] : [`summary-${range}.json`, 'summary-today.json'], range, strict) as SummaryResponse;
      },
      async getSessions(range) {
        return sessions(range).sessions;
      },
      async getSessionsResponse(range) {
        return sessions(range);
      },
      async getLimits() {
        return readMockJson(mockDir, ['limits.json']) as LimitsResponse;
      },
      async getTimeseries(range) {
        return readRangedMock(mockDir, strict ? [`timeseries-${range}.json`] : [`timeseries-${range}.json`, 'timeseries-today.json'], range, strict) as TimeseriesResponse;
      },
      async getDoctor() {
        // Preserve the committed FILED-EXAMPLE envelope exactly; the Doctor summary treats the absent live identity as unknown.
        return readMockJson(mockDir, ['doctor.json']) as DoctorReport;
      },
      async getCoverage() {
        return readMockJson(mockDir, ['coverage.json']) as CoverageResponse;
      },
      async getProcesses() {
        return readMockJson(mockDir, ['processes.json']) as ProcessesResponse;
      },
      async getSessionDetail(source, sessionId) {
        return readMockJson(mockDir, sessionDetailFixtureNames(source, sessionId)) as SessionDetail;
      },
      async getFleetOverview(range) {
        const fleetFixtureName = `fleet-${range}.json`;
        const fleetFixturePath = `${mockDir.replace(/[\\/]+$/, '')}/${fleetFixtureName}`;
        if (fs.existsSync(fleetFixturePath)) {
          const fixture = readRangedMock(mockDir, [fleetFixtureName], range, true);
          if (!isFleetOverviewFixture(fixture, range)) {
            throw new ApiError('mock Fleet fixture is not a valid aggregate-only overview for the requested range');
          }
          return fixture;
        }

        // Preserve the historical one-host mock view only when no exact-range Fleet fixture is
        // present. Strict range requests can use only their exact summary fixture; legacy mode
        // retains the summary-today fallback it has always used.
        const summary = fleetSummaryFromLocal(
          readRangedMock(mockDir, strict ? [`summary-${range}.json`] : [`summary-${range}.json`, 'summary-today.json'], range, strict) as SummaryResponse
        );
        return { range, generatedAt: Date.now(), hosts: [{ label: summary.host, kind: 'local', status: 'online', summary }] };
      },
    };
  }

  const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${resolveConfiguredPort(env)}`;
  const fetchImpl = opts.fetchImpl ?? fetchWithoutContentDecoding;
  const tokenFile = opts.tokenFile ?? getPaths({ env }).apiTokenFile;
  const localTimeoutMs =
    typeof opts.localTimeoutMs === 'number' && Number.isFinite(opts.localTimeoutMs) && opts.localTimeoutMs > 0
      ? opts.localTimeoutMs
      : LOCAL_REQUEST_TIMEOUT_MS;
  // Read this package's identity once per client. A later file replacement cannot change what this process reports.
  const localBuildIdentity = opts.buildIdentity === undefined ? loadBuildIdentity() : opts.buildIdentity;

  let cachedToken: string | null = null;
  function readToken(): string {
    if (cachedToken !== null) return cachedToken;
    if (!fs.existsSync(tokenFile)) {
      throw new ApiTokenFileError(
        `daemon API token not found at ${tokenFile} — is the daemon running and has it written its token file?`
      );
    }
    try {
      cachedToken = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch (err) {
      throw new ApiTokenFileError(`daemon API token at ${tokenFile} could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown'})`);
    }
    return cachedToken;
  }

  // Security audit #4: verify we are actually talking to the daemon that holds this exact token
  // BEFORE ever sending that token — a squatter bound to the port (before the real daemon starts,
  // or any other local process) cannot produce the right proof without knowing the token, so this
  // catches that impostor on the very first call rather than handing it the bearer token outright.
  // Re-prove for every API request: a different process can take the same port after any prior proof.
  async function verifyDaemonIdentity(token: string, parent?: AbortSignal): Promise<void> {
    await withLocalDeadline('/v1/hello', localTimeoutMs, (signal) => proveDaemonIdentity(token, signal), parent);
  }

  async function proveDaemonIdentity(token: string, signal: AbortSignal): Promise<void> {
    const nonce = crypto.randomBytes(16).toString('hex'); // 32 hex chars, per daemon/http.ts's /v1/hello
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1/hello?nonce=${nonce}`, { signal });
    } catch (err) {
      throw new ApiError(`daemon identity challenge failed: GET /v1/hello — ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new ApiError(`daemon identity challenge failed: GET /v1/hello → HTTP ${res.status}`, res.status);
    }
    const body = (await res.json().catch(() => null)) as { proof?: unknown } | null;
    const got = typeof body?.proof === 'string' ? body.proof : '';
    const expected = crypto.createHmac('sha256', token).update(nonce).digest('hex');
    const gotBuf = Buffer.from(got, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const matches = gotBuf.length === expectedBuf.length && crypto.timingSafeEqual(gotBuf, expectedBuf);
    if (!matches) {
      throw new DaemonIdentityError(
        `daemon identity challenge failed: the server on ${baseUrl} could not prove it holds the real API token — refusing to send it (possible port squatter)`
      );
    }
  }

  async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    return requestJson(path, 'GET', signal);
  }

  async function requestJson<T>(path: string, method: 'GET' | 'POST' | 'DELETE', parent?: AbortSignal,
    extraHeaders: Record<string, string> = {}, budget = localTimeoutMs): Promise<T> {
    if (parent?.aborted) throw parent.reason ?? new Error('read_cancelled');
    const token = readToken();
    await verifyDaemonIdentity(token, parent);
    if (parent?.aborted) throw parent.reason ?? new Error('read_cancelled');
    // The route without its query names the request in a timeout; the body parse is inside the deadline.
    return withLocalDeadline(path.split('?')[0], budget, async (signal) => {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        ...(method === 'GET' ? {} : { method }),
        headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
        signal,
      });
      if (!res.ok) {
        throw new ApiError(`${method} ${path} → HTTP ${res.status}`, res.status);
      }
      return (await res.json()) as T;
    }, parent);
  }

  async function getSummaryReport(range: Range, control?: { signal?: AbortSignal; onProgress?: (progress: SummaryReadProgress) => void }): Promise<SummaryResponse> {
    if (range !== 'all') return getJson(`/v1/summary?range=${encodeURIComponent(range)}`, control?.signal);
    return withLocalDeadline('/v1/summary/read', SUMMARY_OPERATION_TIMEOUT_MS, async (signal) => {
      const health = await getJson<{ capabilities?: { summaryReadJobs?: unknown } }>('/v1/health', signal);
      if (health.capabilities?.summaryReadJobs !== 1) return getJson('/v1/summary?range=all', signal);
      const lease = crypto.randomBytes(16).toString('hex');
      try {
        const admitted = await requestJson<{ id: string }>('/v1/summary/read?range=all', 'POST', signal,
          { 'X-Tokenelo-Read-Lease': lease });
        if (!/^[0-9a-f]{32}$/.test(admitted.id)) throw new ApiError('invalid report identity');
        for (;;) {
          const body = await getJson<{ id: string; range: Range; status: string; budgetMs?: number;
            phase?: SummaryReadProgress['phase']; result?: SummaryResponse; error?: string }>(`/v1/summary/read/${admitted.id}?lease=${lease}`, signal);
          if (body.id !== admitted.id || body.range !== range) throw new ApiError('report identity or range mismatch');
          if (body.status === 'completed') {
            const result = body.result;
            if (!result || result.range !== range || typeof result.host !== 'string' || !Number.isFinite(result.generatedAt)
              || !result.totals || !Number.isSafeInteger(result.totals.events) || result.totals.events < 0
              || !result.totals.tokens || !result.bySource || typeof result.bySource !== 'object' || Array.isArray(result.bySource)
              || !Array.isArray(result.byModel) || result.timeBasis?.asOfMs !== result.generatedAt
              || result.timeBasis.startMs !== null || result.timeBasis.endInclusive !== true
              || result.timeBasis.timestampBasis !== 'recorded-timestamps') throw new ApiError('invalid historical report result');
            return result;
          }
          if (body.status === 'failed') {
            if (body.error === 'read_timeout') throw new DaemonTimeoutError('/v1/summary/read',
              Number.isInteger(body.budgetMs) && body.budgetMs! > 0 && body.budgetMs! <= SUMMARY_OPERATION_TIMEOUT_MS ? body.budgetMs! : SUMMARY_OPERATION_TIMEOUT_MS);
            throw new ApiError(body.error === 'result_too_large' ? 'The complete historical report exceeds this view’s capacity. Choose a shorter period.' : 'The historical usage report could not be completed. Choose a shorter period or try again.');
          }
          if (body.status === 'cancelled') throw new SummaryReadRetiredError();
          if (body.status !== 'queued' && body.status !== 'running') throw new ApiError('invalid report state');
          control?.onProgress?.({ status: body.status, ...(body.phase === 'reading-usage' || body.phase === 'reading-activity' ? { phase: body.phase } : {}) });
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) { reject(signal.reason ?? new SummaryReadRetiredError()); return; }
            const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new SummaryReadRetiredError()); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 250);
            signal.addEventListener('abort', cancel, { once: true });
          });
        }
      } finally {
        // The DELETE acknowledgement releases this lease only; it does not prove the worker has exited.
        await requestJson(`/v1/summary/read/lease/${lease}`, 'DELETE', undefined, {}, Math.min(localTimeoutMs, 5000)).catch(() => {});
      }
    }, control?.signal, true);
  }

  function validateUsage(value: UsageResponse, range: Range): UsageResponse {
    const summary = value?.summary, series = value?.timeseries;
    const expectedBucket = range === 'today' || range === '24h' ? 'hour' : 'day';
    if (value?.snapshotScope !== 'shared-read-transaction' || !summary || !series
      || summary.range !== range || series.range !== range || series.bucket !== expectedBucket
      || typeof summary.host !== 'string' || !Number.isSafeInteger(summary.generatedAt)
      || series.generatedAt !== summary.generatedAt || !summary.totals
      || !Number.isSafeInteger(summary.totals.events) || summary.totals.events < 0
      || !summary.totals.tokens || !Array.isArray(summary.byModel) || !Array.isArray(series.points)
      || !summary.timeBasis || !series.timeBasis
      || summary.timeBasis.asOfMs !== summary.generatedAt || series.timeBasis.asOfMs !== summary.generatedAt
      || (['startMs','asOfMs','endInclusive','timestampBasis','excludedFutureEvents','excludedFutureActivity'] as const)
        .some(key => summary.timeBasis![key] !== series.timeBasis![key]))
      throw new ApiError('invalid unified Usage report');
    return value;
  }

  async function getUsage(range: Range, control?: { signal?: AbortSignal; onProgress?: (progress: SummaryReadProgress) => void }): Promise<UsageResponse> {
    if (range !== 'all') return validateUsage(await getJson<UsageResponse>(`/v1/usage?range=${encodeURIComponent(range)}`, control?.signal), range);
    return withLocalDeadline('/v1/usage/read', SUMMARY_OPERATION_TIMEOUT_MS, async (signal) => {
      const health = await getJson<{ capabilities?: { usageReadJobs?: unknown } }>('/v1/health', signal);
      if (health.capabilities?.usageReadJobs !== 1) throw new ApiError('Unified Usage report unavailable. Update the daemon and tray together.');
      const lease = crypto.randomBytes(16).toString('hex');
      try {
        const admitted = await requestJson<{ id: string }>('/v1/usage/read?range=all', 'POST', signal,
          { 'X-Tokenelo-Read-Lease': lease });
        if (!/^[0-9a-f]{32}$/.test(admitted.id)) throw new ApiError('invalid report identity');
        for (;;) {
          const body = await getJson<{ id: string; range: Range; status: string; budgetMs?: number;
            phase?: SummaryReadProgress['phase']; result?: UsageResponse; error?: string }>(`/v1/usage/read/${admitted.id}?lease=${lease}`, signal);
          if (body.id !== admitted.id || body.range !== range) throw new ApiError('report identity or range mismatch');
          if (body.status === 'completed') {
            return validateUsage(body.result!, range);
          }
          if (body.status === 'failed') {
            if (body.error === 'read_timeout') throw new DaemonTimeoutError('/v1/usage/read',
              Number.isInteger(body.budgetMs) && body.budgetMs! > 0 && body.budgetMs! <= SUMMARY_OPERATION_TIMEOUT_MS ? body.budgetMs! : SUMMARY_OPERATION_TIMEOUT_MS);
            throw new ApiError(body.error === 'result_too_large' ? 'The complete historical report exceeds this view’s capacity. Choose a shorter period.' : 'The historical usage report could not be completed. Choose a shorter period or try again.');
          }
          if (body.status === 'cancelled') throw new SummaryReadRetiredError();
          if (body.status !== 'queued' && body.status !== 'running') throw new ApiError('invalid report state');
          control?.onProgress?.({ status: body.status, ...(body.phase === 'reading-usage' || body.phase === 'reading-activity' ? { phase: body.phase } : {}) });
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) { reject(signal.reason ?? new SummaryReadRetiredError()); return; }
            const cancel = () => { clearTimeout(timer); reject(signal.reason ?? new SummaryReadRetiredError()); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, 250);
            signal.addEventListener('abort', cancel, { once: true });
          });
        }
      } finally {
        // The DELETE acknowledgement releases this lease only; it does not prove the worker has exited.
        await requestJson(`/v1/usage/read/lease/${lease}`, 'DELETE', undefined, {}, Math.min(localTimeoutMs, 5000)).catch(() => {});
      }
    }, control?.signal, true);
  }

  async function getPeerSummary(peer: { label: HostLabel; url: string }, range: Range): Promise<FleetHostResult> {
    if (typeof peer.url !== 'string' || !isTailnetPeerUrl(peer.url)) {
      return { label: peer.label, kind: 'peer', status: 'not-configured' };
    }
    const base = peer.url.replace(/\/$/, '');
    const token = readFleetPeerToken(getPaths({ env }), peer.label);
    if (!token) return { label: peer.label, kind: 'peer', status: 'not-configured' };

    let peerIdentityVerified = false;
    try {
      const nonce = crypto.randomBytes(16).toString('hex');
      const helloBody = await withTimeout(async (signal) => {
        const hello = await fetchImpl(`${base}/v1/fleet/hello?nonce=${nonce}`, { signal });
        return hello.ok ? await hello.json().catch(() => null) as { proof?: unknown } | null : null;
      });
      const proof = typeof helloBody?.proof === 'string' ? helloBody.proof : '';
      const expectedProof = crypto.createHmac('sha256', token).update(nonce).digest('hex');
      if (!constantTimeHexEquals(proof, expectedProof)) {
        return { label: peer.label, kind: 'peer', status: 'untrusted' };
      }
      peerIdentityVerified = true;

      const reply = await withTimeout(async (signal) => {
        const res = await fetchImpl(`${base}/v1/fleet/summary?range=${encodeURIComponent(range)}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        });
        return { status: res.status, ok: res.ok, body: res.ok ? await res.json().catch(() => null) as unknown : null };
      });
      if (reply.status === 401) return { label: peer.label, kind: 'peer', status: 'unauthorized' };
      if (reply.status === 504) return { label: peer.label, kind: 'peer', status: 'report-timeout' };
      if (reply.status === 429 || reply.status === 503) return { label: peer.label, kind: 'peer', status: 'report-unavailable' };
      if (!reply.ok) return { label: peer.label, kind: 'peer', status: 'untrusted' };
      const body = reply.body;
      if (!isFleetSummary(body, peer.label, range)) return { label: peer.label, kind: 'peer', status: 'untrusted' };
      const bySource = body.bySource && typeof body.bySource === 'object'
        ? Object.fromEntries(Object.entries(body.bySource).map(([k, v]) => [k, pickFleetAggregate(v as unknown as Record<string, unknown>)]))
        : body.bySource;
      return { label: peer.label, kind: 'peer', status: 'online', summary: { ...body, bySource: bySource as never, totals: normalizeFleetTotals(body.totals as unknown as Record<string, unknown>) as unknown as FleetSummaryResponse['totals'] } };
    } catch (err) {
      if (peerIdentityVerified && err instanceof FleetRequestTimeoutError) {
        return { label: peer.label, kind: 'peer', status: 'report-timeout' };
      }
      return { label: peer.label, kind: 'peer', status: 'offline' };
    }
  }

  async function readRuntimeBuildIdentityStatus(): Promise<RuntimeBuildIdentityStatus> {
    if (!localBuildIdentity) return { state: 'unknown', observedAt: null };
    try {
      const health = await getJson<{ generatedAt?: unknown; buildIdentity?: unknown }>('/v1/health');
      const daemonIdentity = parseBuildIdentity(health.buildIdentity);
      const observedAt = typeof health.generatedAt === 'number' && Number.isSafeInteger(health.generatedAt) && health.generatedAt >= 0
        ? health.generatedAt : null;
      if (!daemonIdentity || !localBuildIdentity.sourceRevision || !daemonIdentity.sourceRevision
        || localBuildIdentity.sourceDirty === null || daemonIdentity.sourceDirty === null) {
        return { state: 'unknown', observedAt };
      }
      const same = localBuildIdentity.sourceRevision === daemonIdentity.sourceRevision
        && localBuildIdentity.sourceDirty === daemonIdentity.sourceDirty
        && localBuildIdentity.distManifestSha256 === daemonIdentity.distManifestSha256;
      if (!same) return { state: 'mismatch', observedAt };
      return { state: localBuildIdentity.sourceDirty ? 'matching-dirty' : 'matching', observedAt };
    } catch {
      // Doctor remains available on older or temporarily unhealthy daemons; identity is unknown, never guessed.
      return { state: 'unknown', observedAt: null };
    }
  }

  async function getFleetOverview(range: Range): Promise<FleetOverviewResponse> {
    // Preserve the local port-squatter check before contacting any configured peers. Once the
    // local daemon proves its identity, its summary can safely load in parallel with peer summaries.
    await verifyDaemonIdentity(readToken());
    const config = loadConfig(getPaths({ env }));
    const configuredPeers: unknown[] = Array.isArray(config.fleet.peers) ? config.fleet.peers : [];
    const seenLabels = new Set<HostLabel>([config.hostLabel]);
    const peers: { label: HostLabel; url: string }[] = [];
    for (const candidate of configuredPeers) {
      if (!candidate || typeof candidate !== 'object') continue;
      const peer = candidate as { label?: unknown; url?: unknown };
      if (typeof peer.label !== 'string' || peer.label.length === 0 || typeof peer.url !== 'string') continue;
      if (seenLabels.has(peer.label)) continue;
      seenLabels.add(peer.label);
      peers.push({ label: peer.label, url: peer.url });
    }
    // Read proved hosts concurrently. A local report timeout must not discard authenticated
    // peer reports; identity, authorization and other local failures still reject the overview.
    const localReport = getSummaryReport(range).then((summary): FleetHostResult => {
      const local = fleetSummaryFromLocal(summary);
      return { label: local.host, kind: 'local', status: 'online', summary: local };
    }).catch((error: unknown): FleetHostResult => {
      if (error instanceof DaemonTimeoutError) {
        return { label: config.hostLabel, kind: 'local', status: 'report-timeout' };
      }
      throw error;
    });
    const [local, remote] = await Promise.all([
      localReport,
      Promise.all(peers.map((peer) => getPeerSummary(peer, range))),
    ]);
    return {
      range,
      generatedAt: Date.now(),
      hosts: [
        local,
        ...remote.filter((peer) => peer.label !== local.label),
      ],
    };
  }

  return {
    getSummary: (range) => getJson(`/v1/summary?range=${encodeURIComponent(range)}`),
    getSummaryReport,
    getUsage,
    getSessions: async (range) => {
      const res = await getJson<SessionsResponse>(range ? `/v1/sessions?range=${encodeURIComponent(range)}` : '/v1/sessions');
      return res.sessions;
    },
    getSessionsResponse: async (range) =>
      normalizeSessionsResponse(await getJson<SessionsResponse>(range ? `/v1/sessions?range=${encodeURIComponent(range)}` : '/v1/sessions')),
    getLimits: () => getJson('/v1/limits'),
    getTimeseries: (range) => {
      const bucket = range === 'today' || range === '24h' ? 'hour' : 'day';
      return getJson(`/v1/timeseries?range=${encodeURIComponent(range)}&bucket=${bucket}`);
    },
    getDoctor: async () => {
      const report = await getJson<DoctorReport>('/v1/doctor');
      return { ...report, runtimeBuildIdentity: await readRuntimeBuildIdentityStatus() };
    },
    getCoverage: () => getJson('/v1/coverage'),
    getProcesses: () => getJson('/v1/processes'),
    getSessionDetail: (source, sessionId) =>
      getJson(`/v1/sessions/detail?source=${encodeURIComponent(source)}&sessionId=${encodeURIComponent(sessionId)}`),
    getFleetOverview,
  };
}

/** True when the daemon's local API answers, used by main.ts before deciding whether to spawn it. */
export async function isDaemonReachable(
  opts: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; env?: Record<string, string | undefined> } = {}
): Promise<boolean> {
  const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${resolveConfiguredPort(opts.env ?? process.env)}`;
  const fetchImpl = opts.fetchImpl ?? fetchWithoutContentDecoding;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  try {
    // Any response (even 401 — this endpoint still requires a bearer token, per http.ts's
    // method→Host→Origin→auth→route check order) proves a server is listening; only a network
    // error means "not reachable".
    await fetchImpl(`${baseUrl}/v1/health`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

