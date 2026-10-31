/**
 * Daemon entry point (DESIGN §2, §6, §10, §12, §15). Wires together config → lock → store →
 * pricing/valuation engines → collectors → scheduler → HTTP API. Also exports `buildRuntime` /
 * `runIngestOnce`, which `cli/index.ts` reuses for `ingest`/`report`/`sessions`/… so the daemon and
 * the CLI share exactly one bootstrap path.
 *
 * Every collector is registered through its module's real export — one `Collector` per source:
 * ClaudeCollector (claude.ts), CodexCollector (codex.ts), OllamaServerlogCollector
 * (ollama-serverlog.ts, when local.capture = 'serverlog' or 'both'); the Ollama metering proxy
 * (ollama-proxy.ts) is a long-running listener started when local.capture = 'proxy' or 'both'.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import type {
  Collector,
  DoctorReport,
  MeteringBacklogStatus,
  ValuationEngine,
  IngestContext,
  IngestStats,
  LedgerWriter,
  PricingEngine,
  TokeneloConfig,
  UsageEvent,
} from '../core/types.js';
import { createLogger, installSqliteWarningFilter, type Logger } from '../core/log.js';
import {
  getPaths,
  ensureDirs,
  writeApiToken,
  tightenSecretFilePermissions,
  verifySecretDirectoryPermissions,
  tightenDataDirPermissions,
  type TokeneloPaths,
} from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { openDb, withTransaction, type TokeneloDb } from '../store/db.js';
import { SqliteLedger } from '../store/ledger.js';
import { MeteringBacklog } from '../store/metering-backlog.js';
import { createQueries, META_UNMETERED_KEY, META_ACL_WARNING_KEY, type Queries } from '../store/queries.js';
import { acquireLock, LockHeldError, type LockHandle } from './lock.js';
import { createHttpServer, closeHttpReads, stopHttpReadAdmission } from './http.js';
import { loadBuildIdentity } from './build-identity.js';
import { createFleetHttpServer, ensureFleetToken, FLEET_PORT, isTailnetAddress, stopFleetReadAdmission } from './fleet.js';
import { createScheduler, isJsonlHint, type SchedulerJob, type Scheduler } from './scheduler.js';
import { defaultPricingEngine, loadPriceRows, priceRowsVersion } from '../core/pricing.js';
import { ReportReads, isolatedReportQueries } from './report-reads.js';
import { SUMMARY_JOB_BUDGET_MS } from './summary-read-jobs.js';
import { createNullEngine } from '../core/null-engine.js';
import { ClaudeCollector, resolveClaudeRoots } from '../collectors/claude.js';
import { CodexCollector, resolveCodexHomes } from '../collectors/codex.js';
import { activeProfiler, startProfilerFromEnv, intervalBegin, intervalEnd } from '../core/phase-profile.js';
import { OllamaServerlogCollector } from '../collectors/ollama-serverlog.js';
import { createMeteringProxy, DEFAULT_PROXY_MAX_BODY_BYTES } from '../collectors/ollama-proxy.js';
import { QwenCodeCollector, resolveQwenRoots } from '../collectors/qwen-code.js';
import {
  ClaudeDesktopPlanUsageCollector,
  ClaudeDesktopSessionsCollector,
  resolveClaudeDesktopRoot,
} from '../collectors/claude-desktop.js';

// ── API token ────────────────────────────────────────────────────────────────

/** A real token is exactly 32 random bytes, hex-encoded — 64 lowercase/uppercase hex chars. */
export function isValidApiTokenFormat(token: string): boolean {
  return /^[0-9a-f]{64}$/i.test(token);
}

/**
 * Reads the existing API bearer token, or securely writes one on first run.
 * Reused tokens keep their bytes if permission verification fails. New token bytes are written
 * only after an empty file has passed the permission check; this runs before the local
 * authenticated HTTP server is constructed or bound.
 */
export interface EnsureApiTokenOptions {
  /** Test seam for deterministic platform/failure coverage; production uses the host defaults. */
  platform?: NodeJS.Platform;
  tightenPermissions?: typeof tightenSecretFilePermissions;
  verifyDirectory?: typeof verifySecretDirectoryPermissions;
}

export function ensureApiToken(
  paths: TokeneloPaths,
  db?: TokeneloDb,
  options: EnsureApiTokenOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const tighten = options.tightenPermissions ?? tightenSecretFilePermissions;
  let replaceExisting = false;
  if (fs.existsSync(paths.apiTokenFile)) {
    const existing = fs.readFileSync(paths.apiTokenFile, 'utf8').trim();
    if (isValidApiTokenFormat(existing)) {
      const aclOk = tighten(paths.apiTokenFile);
      recordAclOutcome(aclOk, db, platform);
      if (!aclOk) {
        throw new Error('could not restrict API token permissions to the current user; refusing to start the local API');
      }
      return existing;
    }
    // present but not a real token (corrupted/hand-edited/truncated) — replace only after safe staging
    replaceExisting = true;
  }
  const token = crypto.randomBytes(32).toString('hex');
  const aclOk = writeApiToken(paths, token, tighten, replaceExisting, options.verifyDirectory ?? verifySecretDirectoryPermissions);
  recordAclOutcome(aclOk, db, platform);
  if (!aclOk) {
    throw new Error('could not restrict API token permissions to the current user; refusing to start the local API');
  }
  return token;
}

function recordAclOutcome(aclOk: boolean, db: TokeneloDb | undefined, platform: NodeJS.Platform): void {
  if (aclOk || platform !== 'win32' || !db) return;
  try {
    recordAclWarning(db);
  } catch {
    // best effort; doctor simply won't show the warning this run
  }
}

/** Persists that the Windows token-file ACL restriction failed, for `getDoctor()` to surface. */
export function recordAclWarning(db: TokeneloDb): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'`
  ).run(META_ACL_WARNING_KEY);
}

// ── collector registration ──────────────────────────────────────────────────

export interface RegisteredCollector {
  name: string;
  collector: Collector;
  intervalMs: number;
  watchPaths: string[];
  /** Relevance test for watch hints (see scheduler.ts). Absent: every change is a hint. */
  watchFilter?: (changedName: string) => boolean;
}

/** One Collector per source, via each module's real export. */
export function registerCollectors(config: TokeneloConfig): RegisteredCollector[] {
  const collectors: RegisteredCollector[] = [
    {
      name: 'claude',
      collector: new ClaudeCollector({ maxLineBytes: config.claude.maxLineBytes }),
      intervalMs: 30_000,
      watchPaths: resolveClaudeRoots(config),
      watchFilter: isJsonlHint,
    },
    {
      name: 'codex',
      collector: new CodexCollector(),
      intervalMs: 30_000,
      watchPaths: resolveCodexHomes(config.codex.homes),
      watchFilter: isJsonlHint,
    },
    { name: 'qwen-code', collector: new QwenCodeCollector(), intervalMs: 30_000, watchPaths: resolveQwenRoots(config) },
    {
      name: 'claude-desktop-plan-usage',
      collector: new ClaudeDesktopPlanUsageCollector(),
      intervalMs: 30_000,
      watchPaths: [resolveClaudeDesktopRoot(config)],
    },
    {
      name: 'claude-desktop-sessions',
      collector: new ClaudeDesktopSessionsCollector(),
      intervalMs: 30_000,
      watchPaths: [resolveClaudeDesktopRoot(config)],
    },
  ];
  if (config.local.capture === 'serverlog' || config.local.capture === 'both') {
    collectors.push({
      name: 'ollama-serverlog',
      collector: new OllamaServerlogCollector(),
      intervalMs: 10_000,
      watchPaths: config.local.serverLogPath ? [config.local.serverLogPath] : [],
    });
  }
  return collectors;
}

/** A running proxy: close resolves after accepted response callbacks finish. */
export interface OllamaProxyRuntimeHandle {
  close(): Promise<void>;
  activeRequestCount(): number;
}

/** Adds `n` to the persisted unmetered-request counter doctor reports (DESIGN §15.3.3). */
export function bumpUnmeteredCounter(db: TokeneloDb, n = 1): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)`
  ).run(META_UNMETERED_KEY, String(n), n);
}

/** Builds one `createMeteringProxy` instance and starts listening; `null` on a bind failure
 * (logged, never thrown — the daemon keeps running without that one engine's capture). Shared by
 * the primary Ollama proxy and every `config.local.upstreams[]` entry (build item 4). */
async function startOneMeteringProxy(
  opts: { upstream: string; port: number; engine: string },
  config: TokeneloConfig,
  store: LedgerWriter,
  backlog: MeteringBacklog,
  log: Logger
): Promise<OllamaProxyRuntimeHandle | null> {
  const handle = createMeteringProxy({
    upstream: opts.upstream,
    port: opts.port,
    host: config.hostLabel,
    engine: opts.engine,
    injectUsage: config.local.proxyInjectUsage,
    maxBodyBytes: config.local.proxyMaxBodyBytes ?? DEFAULT_PROXY_MAX_BODY_BYTES,
    onEvent: (event: UsageEvent) => {
      try {
        backlog.enqueue({ kind: 'event', event });
      } catch (err) {
        log('warn', 'metering proxy: event could not be durably queued', { engine: opts.engine, error: String(err) });
      }
    },
    onUnmetered: () => {
      try {
        backlog.enqueue({ kind: 'unmetered', count: 1 });
      } catch (err) {
        log('warn', 'metering proxy: unmetered observation could not be durably queued', { engine: opts.engine, error: String(err) });
      }
    },
    log: (level, msg, data) => log(level, msg, data),
  });
  try {
    await handle.listen();
  } catch (err) {
    log('warn', 'metering proxy failed to start listening', { engine: opts.engine, port: opts.port, error: String(err) });
    return null;
  }
  log('info', `metering proxy (${opts.engine}) listening on 127.0.0.1:${opts.port}`, { upstream: opts.upstream });
  return { close: () => handle.close(), activeRequestCount: () => handle.activeRequestCount() };
}

async function startOllamaProxyIfConfigured(
  config: TokeneloConfig,
  store: LedgerWriter,
  backlog: MeteringBacklog,
  log: Logger
): Promise<OllamaProxyRuntimeHandle | null> {
  if (config.local.capture !== 'proxy' && config.local.capture !== 'both') return null;
  return startOneMeteringProxy(
    { upstream: config.local.ollamaUpstream, port: config.local.proxyPort, engine: 'ollama' },
    config,
    store,
    backlog,
    log
  );
}

/** One extra metering-proxy instance per `config.local.upstreams[]` entry (build item 4) —
 * independent of `local.capture`, which only ever governs the PRIMARY Ollama capture method. */
async function startExtraMeteringProxies(
  config: TokeneloConfig,
  store: LedgerWriter,
  backlog: MeteringBacklog,
  log: Logger
): Promise<OllamaProxyRuntimeHandle[]> {
  const upstreams = config.local.upstreams ?? [];
  const handles: OllamaProxyRuntimeHandle[] = [];
  try {
  for (const u of upstreams) {
    const handle = await startOneMeteringProxy(
      { upstream: u.upstream, port: u.listenPort, engine: u.name },
      config,
      store,
      backlog,
      log
    );
    if (handle) handles.push(handle);
  }
  } catch(error) {
    const closed=await Promise.allSettled(handles.map(handle=>handle.close()));
    const failures=closed.filter((r):r is PromiseRejectedResult=>r.status==='rejected').map(r=>r.reason);
    if(failures.length)throw new RuntimeCleanupError([error,...failures],String(error),{cause:error});
    throw error;
  }
  return handles;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

/** Cleanup failed with resources potentially still owned; retain startup exclusion. */
export class RuntimeCleanupError extends AggregateError {}

export interface Runtime {
  paths: TokeneloPaths;
  config: TokeneloConfig;
  db: TokeneloDb;
  pricing: PricingEngine;
  valuationEngine: ValuationEngine;
  store: LedgerWriter;
  queries: Queries;
  collectors: RegisteredCollector[];
  ollamaProxyHandle: OllamaProxyRuntimeHandle | null;
  meteringBacklog: MeteringBacklog | null;
  /** One handle per `config.local.upstreams[]` entry that started successfully (build item 4). */
  extraMeteringProxyHandles: OllamaProxyRuntimeHandle[];
  log: Logger;
  now: () => number;
  stopProxies(): Promise<void>;
  close(): Promise<void>;
}

/** The reader-close boundary must prove report-process retirement before shared state closes. */
export type ShutdownStep = () => Promise<unknown>;
export interface OwnedShutdownPlan {
  stopReadAdmission: () => void;
  drain: readonly ShutdownStep[];
  reportReaders: readonly ShutdownStep[];
  readServices: readonly ShutdownStep[];
  listeners: readonly ShutdownStep[];
  closeRuntime: ShutdownStep;
  releaseLock: () => void;
  /** Keep an existing referenced owner handle alive when reader retirement is unproved. */
  retainOwnership: () => void;
}

export async function completeOwnedShutdown(plan: OwnedShutdownPlan): Promise<void> {
  const settle = async (steps: readonly ShutdownStep[]): Promise<unknown[]> => {
    const outcomes = await Promise.allSettled(steps.map(step => Promise.resolve().then(step)));
    return outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map(outcome => outcome.reason);
  };
  const failures: unknown[] = [];
  try { plan.stopReadAdmission(); } catch (error) { failures.push(error); }
  const drainPromise = settle(plan.drain);
  const readerFailures = await settle(plan.reportReaders);
  if (readerFailures.length) {
    failures.push(...readerFailures);
    try { plan.retainOwnership(); } catch (error) { failures.push(error); }
    throw new AggregateError(failures, 'Report worker retirement unproved; ledger and startup ownership retained');
  }
  failures.push(...await drainPromise);
  const serviceFailures = await settle(plan.readServices);
  if (serviceFailures.length) {
    failures.push(...serviceFailures);
    try { plan.retainOwnership(); } catch (error) { failures.push(error); }
    throw new AggregateError(failures, 'Report read services did not close; ledger and startup ownership retained');
  }
  failures.push(...await settle(plan.listeners));
  try { await plan.closeRuntime(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Owned runtime cleanup failed; startup ownership retained');
  plan.releaseLock();
}

export interface StartupShutdownGate {
  requested(): boolean;
  request(): void;
  hold(): () => void;
}

/** Defers ownership cleanup while startup may still bind a listener or finish opening its runtime. */
export function createStartupShutdownGate(onRequest: () => void, startShutdown: () => void): StartupShutdownGate {
  let holds = 0;
  let wasRequested = false;
  let started = false;
  const startIfReady = () => {
    if (wasRequested && holds === 0 && !started) {
      started = true;
      startShutdown();
    }
  };
  return {
    requested: () => wasRequested,
    request() {
      if (wasRequested) return;
      wasRequested = true;
      onRequest();
      startIfReady();
    },
    hold() {
      holds++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds--;
        startIfReady();
      };
    },
  };
}

/** Installs signal handlers through one injectable path so startup-window behavior is testable. */
export function installShutdownSignalHandlers(
  target: Pick<EventEmitter, 'on' | 'off'>,
  request: () => void
): () => void {
  const handler = () => request();
  target.on('SIGINT', handler);
  target.on('SIGTERM', handler);
  return () => {
    target.off('SIGINT', handler);
    target.off('SIGTERM', handler);
  };
}
export interface BuildRuntimeOpts {
  paths?: TokeneloPaths;
  now?: () => number;
  log?: Logger;
  /** Start the Ollama metering proxy when local.capture = 'proxy' (daemon only; the CLI never binds it). */
  startProxy?: boolean;
  /** Daemon-only scheduler observations. CLI queries do not imply an active scan schedule. */
  getCollectorScans?: () => import('../core/types.js').CoverageResponse['collectorScans'];
}

export async function buildRuntime(opts?: BuildRuntimeOpts): Promise<Runtime> {
  installSqliteWarningFilter();
  const now = opts?.now ?? (() => Date.now());
  // core/log.ts writes to stderr by default: stdout is reserved for the CLI's JSON/CSV payloads.
  const log = opts?.log ?? createLogger({ now });
  const paths = opts?.paths ?? getPaths();
  ensureDirs(paths);

  let config = loadConfig(paths);
  if (!fs.existsSync(paths.configFile)) saveConfig(paths, config);
  config = loadConfig(paths); // re-read so on-disk == in-memory from this point on

  const db = openDb({ file: paths.dbFile });
  let backlogDb:TokeneloDb|undefined, backlogLedger:SqliteLedger|undefined;
  let meteringBacklog:MeteringBacklog|null=null;
  let ollamaProxyHandle:OllamaProxyRuntimeHandle|null=null;
  let extraMeteringProxyHandles:OllamaProxyRuntimeHandle[]=[];
  let closing:Promise<void>|undefined, proxyClosing:Promise<void>|undefined;
  const stopProxies=()=>proxyClosing??=Promise.all([...(ollamaProxyHandle?[ollamaProxyHandle]:[]),...extraMeteringProxyHandles].map(h=>h.close())).then(()=>{});
  const finish = () => {
    // One bounded replay pass; unresolved entries remain durable for next startup.
    meteringBacklog?.flush();
    meteringBacklog?.close();
    backlogDb?.close();
    db.close();
  };
  try {

  // Belt-and-suspenders (security audit #7): the data dir is already created 0700 by ensureDirs,
  // but tokenelo.db/-wal/-shm are created by the SQLite driver with no explicit mode, so their
  // permissions depend on the process umask alone unless we chmod them explicitly here too.
  tightenDataDirPermissions(paths);
  const pricing = defaultPricingEngine();
  const valuationEngine = createNullEngine();
  const store = new SqliteLedger(db, pricing, valuationEngine);
  // Proxy observations are durably queued independently of the capture ledger.
  // A lazy consumer connection never waits behind maintenance: failed writes
  // remain queued, and ordinary event replay preserves historical valuations.
  const needsBacklog = opts?.startProxy && (config.local.capture === 'proxy' || config.local.capture === 'both' || (config.local.upstreams?.length ?? 0) > 0 || fs.existsSync(path.join(paths.dataDir,'metering-backlog')));
  meteringBacklog = needsBacklog ? new MeteringBacklog(path.join(paths.dataDir, 'metering-backlog'), envelope => {
    backlogDb ??= openDb({ file: paths.dbFile, migrate: false, busyTimeoutMs: 0 });
    if (envelope.observation.kind === 'event') {
      backlogLedger ??= new SqliteLedger(backlogDb, pricing, valuationEngine);
      backlogLedger.upsertEvents([envelope.observation.event]);
    } else {
      // The receipt and counter commit together. A crash after commit but
      // before queue acknowledgement must not count the request twice.
      withTransaction(backlogDb, () => {
        const receipt = `metering_backlog_applied:${envelope.id}`;
        if (backlogDb!.prepare('SELECT value FROM meta WHERE key=?').get(receipt)) return;
        bumpUnmeteredCounter(backlogDb!, envelope.observation.kind === 'unmetered' ? envelope.observation.count : 0);
        backlogDb!.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(receipt,String(envelope.queuedAt));
      });
    }
  }) : null;
  const queries = createQueries(db, config, {
    now,
    pricing,
    getCollectorScans: opts?.getCollectorScans,
    getPrimaryOllamaActiveRequests: () => ollamaProxyHandle?.activeRequestCount() ?? null,
    getMeteringBacklogStatus: () => meteringBacklog?.status() ?? null,
    readSnapshotFile: paths.dbFile, // Summary and Sessions read through a request snapshot connection (store/read-snapshot.ts)
  });
  const collectors = registerCollectors(config);
  if (meteringBacklog) {
    const doctor = queries.getDoctor.bind(queries);
    queries.getDoctor = async control => attachMeteringBacklog(await doctor(control),meteringBacklog!.status());
  }
  ollamaProxyHandle = meteringBacklog ? await startOllamaProxyIfConfigured(config, store, meteringBacklog, log) : null;
  extraMeteringProxyHandles = meteringBacklog ? await startExtraMeteringProxies(config, store, meteringBacklog, log) : [];

  return {
    paths,
    config,
    db,
    pricing,
    valuationEngine,
    store,
    queries,
    collectors,
    ollamaProxyHandle,
    meteringBacklog,
    extraMeteringProxyHandles,
    log,
    now,
    stopProxies,
    close() {
      if(closing)return closing;
      const handles=[...(ollamaProxyHandle?[ollamaProxyHandle]:[]),...extraMeteringProxyHandles];
      // Preserve synchronous finalization for offline callers with no listeners.
      if(!handles.length) { try { finish();closing=Promise.resolve(); } catch(error) { closing=Promise.reject(error); } }
      else closing=stopProxies().then(()=>finish());
      return closing;

    },
  };
  } catch(error) {
    try { await stopProxies();finish(); }
    catch(cleanupError) { throw new RuntimeCleanupError([error,cleanupError],String(error),{cause:error}); }
    throw error;
  }
}

/** Queue observation occurs after the historical report; it is not part of its read snapshot. */
export function attachMeteringBacklog(report: DoctorReport, status: MeteringBacklogStatus): DoctorReport {
  const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const unknown = !validCount(status.pending) || !validCount(status.quarantined) || !validCount(status.writeFailures)
    || (status.historyIncomplete !== undefined && typeof status.historyIncomplete !== 'boolean')
    || (status.failureEvidenceStored !== undefined && status.failureEvidenceStored !== null && typeof status.failureEvidenceStored !== 'boolean');
  const review = unknown || status.historyIncomplete === true || status.failureEvidenceStored === false || status.quarantined > 0 || status.writeFailures > 0;
  return { ...report, ollama: { ...report.ollama, backlog: status }, warnings: [...report.warnings,
    ...(validCount(status.pending) && status.pending > 0 ? [`Metering capture pending: ${status.pending} requests are waiting to enter usage history.`] : []),
    ...(review ? ['Metering capture needs review: invalid observations, storage errors or incomplete diagnostic evidence. Usage history may be incomplete.'] : [])] };
}

function ingestContext(runtime: Runtime): IngestContext {
  return {
    host: runtime.config.hostLabel,
    config: runtime.config,
    store: runtime.store,
    pendingProxyEvents: (sinceTs, untilTs) => runtime.meteringBacklog?.pendingProxyEvents(sinceTs, untilTs) ?? [],
    primaryOllamaActiveRequests: () => runtime.ollamaProxyHandle?.activeRequestCount() ?? 0,
    meteringBacklogStatus: () => runtime.meteringBacklog?.status() ?? null,
    pricing: runtime.pricing,
    valuationEngine: runtime.valuationEngine,
    log: runtime.log,
    now: runtime.now,
  };
}

/** Runs every registered collector's `scan()` exactly once (daemon startup ingest, `tokenelo
 * ingest`). A collector that throws is reported as `{error}` and never aborts the others. */
export async function runIngestOnce(
  runtime: Runtime
): Promise<Array<{ name: string; stats?: IngestStats; error?: unknown }>> {
  const ctx = ingestContext(runtime);
  const results: Array<{ name: string; stats?: IngestStats; error?: unknown }> = [];
  for (const rc of runtime.collectors) {
    try {
      const stats = await rc.collector.scan(ctx);
      results.push({ name: rc.name, stats });
    } catch (error) {
      runtime.log('warn', `collector "${rc.name}" scan failed`, { error: String(error) });
      results.push({ name: rc.name, error });
    }
  }
  return results;
}

/**
 * Profiling label for a request. Only the exact static API routes in http.ts map to a label; the query string is
 * dropped first. Everything else, including any alphabetic name that is not a known route (a session, project or
 * model name in a path), maps to 'other'. A pattern test would admit such names, so this is an explicit set.
 */
const ROUTE_LABELS: ReadonlyMap<string, string> = new Map([
  ['/v1/hello', 'v1.hello'],
  ['/v1/health', 'v1.health'],
  ['/v1/summary', 'v1.summary'],
  ['/v1/usage', 'v1.usage'],
  ['/v1/sessions', 'v1.sessions'],
  ['/v1/sessions/detail', 'v1.sessions.detail'],
  ['/v1/limits', 'v1.limits'],
  ['/v1/limits/history', 'v1.limits.history'],
  ['/v1/processes', 'v1.processes'],
  ['/v1/coverage', 'v1.coverage'],
  ['/v1/timeseries', 'v1.timeseries'],
  ['/v1/doctor', 'v1.doctor'],
]);

export function routeClass(url: string | undefined): string {
  const pathname = (url ?? '').split('?')[0] ?? '';
  return ROUTE_LABELS.get(pathname) ?? 'other';
}

function buildScheduler(runtime: Runtime): Scheduler {
  const ctx = ingestContext(runtime);
  // Default-off: the job wrapper exists only when the profiler was enabled from the environment before this call.
  const profiling = activeProfiler() !== null;
  const jobs: SchedulerJob[] = runtime.collectors.map((rc) => ({
    name: rc.name,
    intervalMs: rc.intervalMs,
    watchPaths: rc.watchPaths,
    ...(rc.watchFilter ? { watchFilter: rc.watchFilter } : {}),
    run: profiling
      ? async () => {
          const id = intervalBegin(`job.${rc.name}`);
          try {
            return await rc.collector.scan(ctx);
          } finally {
            intervalEnd(id);
          }
        }
      : () => rc.collector.scan(ctx),
  }));
  return createScheduler(jobs, { log: runtime.log, now: runtime.now });
}

/** Daemon main: acquire the lock, run an initial ingest, start the interval schedule, start the
 * HTTP API, and wait for SIGINT/SIGTERM to shut everything down cleanly. */
export async function main(): Promise<number> {
  startProfilerFromEnv(); // no-op unless TOKENELO_PROFILE_FILE is set to an absolute scratch path
  // Security audit #7: a restrictive default umask means every file this process creates without
  // an explicit mode (notably the SQLite -wal/-shm siblings) starts out non-group/non-world
  // readable, before tightenDataDirPermissions()'s explicit chmod pass even runs.
  if (process.platform !== 'win32') process.umask(0o077);

  // Own the daemon's data before opening its ledger, scanning durable queue
  // files or starting proxy listeners. A refused launch must be read-only.
  const startupPaths = getPaths();
  ensureDirs(startupPaths);
  const startupConfig = loadConfig(startupPaths);
  const startupLog = createLogger();
  let lock: LockHandle;
  try { lock = acquireLock(startupPaths, startupConfig.api.port); }
  catch (err) {
    if (err instanceof LockHeldError) {
      startupLog('error', err.message); process.exitCode = 1; return 1;
    }
    throw err;
  }
  let scanSnapshot: BuildRuntimeOpts['getCollectorScans'] = () => undefined;
  let scheduler: Scheduler | undefined;
  let reportReads: ReportReads | undefined, historicalReads: ReportReads | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let fleetServer: ReturnType<typeof createFleetHttpServer> | null = null;
  let cleanupPromise: Promise<void> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  let initialCaptureState: 'pending' | 'running' | 'complete' | 'failed' | 'stopping' = 'pending';
  let startSignalShutdown = () => {};
  const shutdownGate = createStartupShutdownGate(() => {
    shuttingDown = true;
    initialCaptureState = 'stopping';
    if (server) stopHttpReadAdmission(server);
    if (fleetServer) stopFleetReadAdmission(fleetServer);
    if (server?.listening) server.ref();
    if (fleetServer?.listening) fleetServer.ref();
  }, () => startSignalShutdown());
  const releaseRuntimeStartup = shutdownGate.hold();
  const removeSignalHandlers = installShutdownSignalHandlers(process, shutdownGate.request);
  let runtime: Runtime;
  try { runtime = await buildRuntime({ paths: startupPaths, startProxy: true, getCollectorScans: () => scanSnapshot?.() }); }
  catch (err) {
    removeSignalHandlers();
    releaseRuntimeStartup();
    if(!(err instanceof RuntimeCleanupError)) {
      try { lock.release(); }
      catch(releaseError) { throw new AggregateError([err,releaseError],String(err),{cause:err}); }
    }
    throw err;
  }
  const closeServer=(listener:http.Server)=>new Promise<void>((resolve,reject)=>listener.close(error=>{
    if(error && (error as NodeJS.ErrnoException).code!=='ERR_SERVER_NOT_RUNNING')reject(error);else resolve();
  }));
  // Private, opt-in lifecycle receipts contain phase names and durations only.
  // They identify unfinished cleanup without exposing paths, usage or errors.
  const shutdownPhase=(phase:string,status:'begin'|'complete'|'failed',started?:number)=>{
    if(process.env.TOKENELO_SHUTDOWN_DIAGNOSTICS!=='1')return;
    try { fs.writeSync(2,JSON.stringify({shutdownPhase:phase,status,...(started===undefined?{}:{elapsedMs:performance.now()-started})})+'\n'); }
    catch { /* Diagnostics must not prevent ownership-preserving cleanup. */ }
  };
  const observeShutdown=<T>(phase:string,task:Promise<T>):Promise<T>=>{
    const started=performance.now();shutdownPhase(phase,'begin');
    return task.then(value=>{shutdownPhase(phase,'complete',started);return value;},error=>{shutdownPhase(phase,'failed',started);throw error;});
  };
  cleanup=()=>cleanupPromise??=(async()=>{
    try { runtime.log('info', 'shutting down'); } catch { /* Logging must not prevent ownership-preserving cleanup. */ }
    scheduler?.stop();
    const drain: ShutdownStep[] = [() => observeShutdown('proxy-close', runtime.stopProxies())];
    const activeScheduler = scheduler;
    if (activeScheduler) drain.push(() => observeShutdown('scheduler-drain', activeScheduler.drain()));
    const activeServer = server;
    const activeFleetServer = fleetServer;
    const activeReportReads = reportReads;
    const activeHistoricalReads = historicalReads;
    const reportReaders: ShutdownStep[] = [];
    if (activeReportReads) reportReaders.push(() => observeShutdown('report-read-close', activeReportReads.close()));
    if (activeHistoricalReads) reportReaders.push(() => observeShutdown('historical-read-close', activeHistoricalReads.close()));
    const readServices: ShutdownStep[] = [];
    if (activeServer) readServices.push(() => observeShutdown('http-read-close', closeHttpReads(activeServer)));
    const listeners: ShutdownStep[] = [];
    if (activeServer) listeners.push(() => observeShutdown('http-server-close', closeServer(activeServer)));
    if (activeFleetServer) listeners.push(() => observeShutdown('fleet-server-close', closeServer(activeFleetServer)));
    return completeOwnedShutdown({
      stopReadAdmission: () => {
        if (activeServer) stopHttpReadAdmission(activeServer);
        if (activeFleetServer) stopFleetReadAdmission(activeFleetServer);
      },
      drain,
      reportReaders,
      readServices,
      listeners,
      closeRuntime: () => observeShutdown('runtime-close', Promise.resolve().then(() => runtime.close())),
      releaseLock: () => {
        shutdownPhase('ownership-release', 'begin');
        lock.release();
        shutdownPhase('ownership-release', 'complete');
      },
      retainOwnership: () => {
        // Report reads only enter through these listeners. Their request closures retain the
        // ReportReads quarantine record; keep the existing referenced handles alive so Node
        // cannot drop the SQLite ownership lease after unproved retirement.
        if (activeServer?.listening) activeServer.ref();
        if (activeFleetServer?.listening) activeFleetServer.ref();
        shutdownPhase('report-read-ownership-retained', 'failed');
      },
    });
  })();
  startSignalShutdown=()=>{
    if(!cleanup)return;
    void cleanup().then(()=>{
      removeSignalHandlers();
      process.exit(0);
    }).catch(error=>{
      runtime.log('error','shutdown incomplete; ownership release unconfirmed',{error:String(error)});
      process.exitCode=1;
    });
  };
  releaseRuntimeStartup();
  if(shutdownGate.requested())return 0;
  try {
  const { paths, config, log } = runtime;
  if (config.api.port !== startupConfig.api.port) {
    throw new Error('API port changed during startup; restart with one checked configuration');
  }

  const token = ensureApiToken(paths, runtime.db);
  scheduler = buildScheduler(runtime);
  scanSnapshot = () => scheduler?.snapshot();

  // Retained-data reads and the authenticated process identity must be available while
  // the first local-history pass warms up. This state does not claim fresh capture.
  const priceRows = loadPriceRows();
  if (priceRowsVersion(priceRows) !== runtime.pricing.version) {
    throw new Error('pricing changed during startup; restart with one checked rate table');
  }
  const buildIdentity = loadBuildIdentity();
  reportReads = new ReportReads({ dbFile: paths.dbFile, buildIdentity, config, priceRows,
    pricesVersion: runtime.pricing.version }, {
    onRetired: observation => log('debug', 'report read retired', { ...observation }),
  });
  // One dedicated historical worker keeps long jobs out of the ordinary read queue.
  historicalReads = new ReportReads({ dbFile: paths.dbFile, buildIdentity, config, priceRows,
    pricesVersion: runtime.pricing.version }, {
    workers: 1, waiting: 2, budgetMs: SUMMARY_JOB_BUDGET_MS, maxResultBytes: 8 * 1024 ** 2,
    onRetired: observation => log('debug', 'historical report read retired', { ...observation }),
  });
  const apiQueries = isolatedReportQueries(runtime.queries, reportReads, historicalReads);
  if (runtime.meteringBacklog) {
    const doctor = apiQueries.getDoctor.bind(apiQueries);
    apiQueries.getDoctor = async control => attachMeteringBacklog(await doctor(control),runtime.meteringBacklog!.status());
  }

  const releaseListenerStartup = shutdownGate.hold();
  try {
  server = createHttpServer({
    port: config.api.port,
    token,
    queries: apiQueries,
    host: config.hostLabel,
    log,
    initialCaptureState: () => initialCaptureState,
    buildIdentity,
  });
  // Default-off: no listener is registered unless the profiler is active. When active, a request is an in-flight
  // interval named by its static route class; every other path is 'other'.
  if (activeProfiler() !== null) {
    server.prependListener('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      const id = intervalBegin(`http.${routeClass(req.url)}`);
      res.once('close', () => intervalEnd(id));
    });
  }

  await new Promise<void>((resolve, reject) => {
    server!.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log('error', `port ${config.api.port} already in use — another daemon (or something else) is bound to it`, {
          port: config.api.port,
        });
      }
      reject(err);
    });
    server!.listen(config.api.port, '127.0.0.1', () => {
      log('info', `daemon listening on 127.0.0.1:${config.api.port}`, { host: config.hostLabel });
      resolve();
    });
  });
  if(shutdownGate.requested())return 0;

  // M5 fleet listener is opt-in and binds only to the exact configured Tailscale interface IP.
  // A bad/missing secret or bind failure leaves the loopback API and capture daemon running.
  const fleetAddress = config.fleet.listenAddress;
  if (fleetAddress) {
    try {
      if (!isTailnetAddress(fleetAddress)) throw new Error('fleet.listenAddress must be an address in the Tailscale range');
      const fleetToken = ensureFleetToken(paths);
      const candidate = createFleetHttpServer({
        address: fleetAddress,
        port: FLEET_PORT,
        token: fleetToken,
        queries: apiQueries,
        host: config.hostLabel,
        log,
      });
      fleetServer = candidate;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        candidate.once('error', onError);
        candidate.listen(FLEET_PORT, fleetAddress, () => {
          candidate.off('error', onError);
          resolve();
        });
      });
      fleetServer = candidate;
      log('info', `fleet listener listening on ${fleetAddress}:${FLEET_PORT}`, { host: config.hostLabel });
    } catch (err) {
      if(fleetServer) { await closeServer(fleetServer);fleetServer=null; }
      log('error', 'fleet listener failed to start; local Tokenelo API remains available', {
        address: fleetAddress,
        port: FLEET_PORT,
        error: String(err),
      });
    }
  }
  } finally {
    releaseListenerStartup();
  }
  if(shutdownGate.requested())return 0;

  initialCaptureState = 'running';
  log('info', 'running initial ingest', { collectors: runtime.collectors.map((c) => c.name) });
  const initial = await scheduler.runAllOnce({ shouldStop: () => shuttingDown });
  if (shuttingDown) return 0; // No interval/watch restart after an initial-scan shutdown.
  initialCaptureState = initial.some((result) => result.error) ? 'failed' : 'complete';
  log('info', 'initial ingest complete', { results: initial.map((result) => ({ name: result.name, ok: !result.error })) });
  scheduler.start();
  return 0;
  } catch(error) {
    const runCleanup = cleanup;
    if (!runCleanup) throw error;
    if (shutdownGate.requested()) {
      await runCleanup();
      return 0;
    }
    try { await runCleanup(); } catch(cleanupError) { throw new RuntimeCleanupError([error,cleanupError],String(error),{cause:error}); }
    throw error;
  }
}

/** True when `moduleUrl` is the process entry script (works for symlinked bins and Windows paths). */
export function isEntryModule(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(fs.realpathSync(argv1)).href || moduleUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isEntryModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
