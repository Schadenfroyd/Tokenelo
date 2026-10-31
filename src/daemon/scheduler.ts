/**
 * Runs registered ingest jobs on a fixed interval, with an optional `fs.watch` "hint" that lets a
 * job re-run sooner than its interval when one of its watched directories changes (DESIGN §2/§15:
 * "claude/codex every 30 s via fs.watch hints + interval; serverlog 10 s").
 *
 * Deliberately collector-agnostic: this module knows nothing about Claude/Codex/Ollama. `main.ts`
 * registers one job per available collector (`job.run` is a closure over `collector.scan(ctx)`),
 * so scheduler.ts has nothing to guard-import and stays simple and fully unit-testable with fake
 * jobs and fake timers.
 *
 * Guarantees:
 *   - A job never runs concurrently with itself: if the interval or a watch event fires while a
 *     run is still in flight, that trigger is coalesced into "run once more right after" rather
 *     than starting a second overlapping run (important for collectors that stream large files —
 *     DESIGN §4.2's 3.57 GB Codex rollout).
 *   - A thrown/rejected job is caught, logged, and does not stop the schedule.
 *   - `fs.watch` is best-effort: recursive watch is unsupported on some platforms (notably Linux;
 *     verified Node behavior — `fs.watch(dir, {recursive:true})` throws
 *     `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` there) and a watched path may not exist yet (a fresh
 *     `~/.codex` before Codex has ever run). Either failure is logged once and the job simply
 *     falls back to its plain interval — never a crash.
 */
import fs from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { CollectorScanStatus, IngestStats } from '../core/types.js';

const EVENT_LOOP_SAMPLE_MS = 60_000;
const EVENT_LOOP_RESOLUTION_MS = 20;
const SLOW_COLLECTOR_LOG_THRESHOLD_MS = 1_000;

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;

export interface SchedulerJob {
  name: string;
  intervalMs: number;
  run: () => Promise<IngestStats | void>;
  /** Directories to watch for a "run sooner" hint. Best-effort; see module doc. */
  watchPaths?: string[];
  /** Debounce for watch-triggered runs, so a burst of file writes doesn't spawn a run per event.
   * Default 2000ms. */
  watchDebounceMs?: number;
  /** Optional relevance test for a watch hint, given the changed name as fs.watch reports it (relative
   * to the watched directory). A hint it rejects does not start a run; the interval still runs the job. */
  watchFilter?: (changedName: string) => boolean;
}

/** True when a watch hint should start a run. No filter, or no reported name, means relevant: an
 * unknown change is never silently ignored. Only a reported name the filter rejects is dropped. */
export function watchHintIsRelevant(filter: ((changedName: string) => boolean) | undefined, changedName: string | null): boolean {
  if (!filter || changedName === null) return true;
  return filter(changedName);
}

/** Collector watch filter for transcript-style sources (Codex rollouts, Claude transcripts). A hint for a
 * non-`.jsonl` file (SQLite, logs) cannot by itself make the watch-triggered scan find new usage: the
 * `.jsonl` files it would re-read are unchanged, so they are skipped. Any later scheduled run still
 * picks up everything, because the interval is unchanged. */
export function isJsonlHint(changedName: string): boolean {
  return changedName.toLowerCase().endsWith('.jsonl');
}

export interface Scheduler {
  /** Runs every registered job once, sequentially, and resolves when all have settled. Used for
   * the daemon's "initial ingest" before the interval schedule takes over, and by the CLI's
   * `ingest` command (which does not start the interval schedule at all). */
  runAllOnce(opts?: { shouldStop?: () => boolean }): Promise<Array<{ name: string; stats?: IngestStats | void; error?: unknown }>>;
  /** Starts the interval + fs.watch schedule for every registered job. */
  start(): void;
  /** Clears all timers and closes all watchers. Idempotent. */
  stop(): void;
  /** Stop new jobs and wait for accepted scans before closing their ledger. */
  drain(): Promise<void>;
  /** Detached snapshots of registered jobs only. No warning/error text or filesystem paths. */
  snapshot(): CollectorScanStatus[];
}

interface JobState {
  job: SchedulerJob;
  running: boolean;
  rerunRequested: boolean;
  timer?: NodeJS.Timeout;
  watchers: fs.FSWatcher[];
  debounceTimer?: NodeJS.Timeout;
  status: CollectorScanStatus;
}

export function createScheduler(jobs: SchedulerJob[], opts?: { log?: Logger; now?: () => number; monotonicNow?: () => number }): Scheduler {
  const log: Logger = opts?.log ?? (() => {});
  const now = opts?.now ?? (() => Date.now());
  const monotonicNow = opts?.monotonicNow ?? (() => performance.now());
  const states: JobState[] = jobs.map((job) => ({ job, running: false, rerunRequested: false, watchers: [],
    status: { name: job.name, intervalMs: job.intervalMs, running: false, rerunQueued: false,
      currentStartedAt: null, lastStartedAt: null, lastFinishedAt: null, lastCompletedAt: null,
      lastFailedAt: null, lastOutcome: null, lastDurationMs: null, lastStats: null },
  }));
  const eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  let started = false;
  let stopping = false;
  const active = new Set<Promise<IngestStats | void>>();
  let eventLoopTimer: NodeJS.Timeout | undefined;

  function reportEventLoopDelay(): void {
    const asMilliseconds = (nanoseconds: number): number =>
      Number.isFinite(nanoseconds) ? Math.round((nanoseconds / 1_000_000) * 10) / 10 : 0;
    log('debug', 'daemon event loop delay sample', {
      windowMs: EVENT_LOOP_SAMPLE_MS,
      maxDelayMs: asMilliseconds(eventLoopDelay.max),
      meanDelayMs: asMilliseconds(eventLoopDelay.mean),
    });
    eventLoopDelay.reset();
  }

  async function runJob(state: JobState): Promise<{ name: string; stats?: IngestStats | void; error?: unknown }> {
    if (stopping) return { name: state.job.name };
    if (state.running) {
      state.rerunRequested = true;
      state.status.rerunQueued = true;
      return { name: state.job.name };
    }
    state.running = true;
    state.status.running = true;
    state.status.currentStartedAt = state.status.lastStartedAt = now();
    const monotonicStart = monotonicNow();
    const work=Promise.resolve().then(()=>state.job.run());
    active.add(work);
    try {
      const stats = await work;
      const metrics = stats && typeof stats === 'object' ? stats : undefined;
      state.status.lastCompletedAt = now();
      state.status.lastOutcome = metrics && metrics.warnings.length > 0 ? 'warnings' : 'completed';
      state.status.lastStats = metrics ? {
        filesScanned: metrics.filesScanned, filesSkipped: metrics.filesSkipped,
        recordsEmitted: metrics.eventsEmitted, bytesRead: metrics.bytesRead, warningCount: metrics.warnings.length,
        ...(metrics.codexCursorCoverageAtStat ? { codexCursorCoverageAtStat: { ...metrics.codexCursorCoverageAtStat } } : {}),
      } : null;
      if (
        stats &&
        typeof stats === 'object' &&
        (stats.durationMs >= SLOW_COLLECTOR_LOG_THRESHOLD_MS || stats.warnings.length > 0)
      ) {
        // Log slow or warning-bearing scans without session content or paths. The Windows service
        // launcher captures stderr to a user-local log for alpha diagnosis.
        log('debug', 'scheduler job completed', {
          job: state.job.name,
          durationMs: stats.durationMs,
          filesScanned: stats.filesScanned,
          filesSkipped: stats.filesSkipped,
          eventsEmitted: stats.eventsEmitted,
          bytesRead: stats.bytesRead,
          warningCount: stats.warnings.length,
        });
      }
      return { name: state.job.name, stats };
    } catch (error) {
      state.status.lastFailedAt = now();
      state.status.lastOutcome = 'failed';
      state.status.lastStats = null;
      log('warn', `scheduler job "${state.job.name}" failed`, { error: String(error) });
      return { name: state.job.name, error };
    } finally {
      active.delete(work);
      state.running = false;
      state.status.running = false;
      state.status.currentStartedAt = null;
      state.status.lastFinishedAt = now();
      state.status.lastDurationMs = Math.max(0, monotonicNow() - monotonicStart);
      if (state.rerunRequested && !stopping) {
        state.rerunRequested = false;
        state.status.rerunQueued = false;
        // Fire-and-forget the coalesced re-run; do not await inside finally.
        void runJob(state);
      }
    }
  }

  function armWatch(state: JobState): void {
    if (!state.job.watchPaths?.length) return;
    for (const dir of state.job.watchPaths) {
      try {
        if (!fs.existsSync(dir)) {
          log('debug', `scheduler: watch path does not exist yet, relying on interval only`, {
            job: state.job.name,
            dir,
          });
          continue;
        }
        const watcher = fs.watch(dir, { recursive: true }, (_event, changedName) => {
          if (!watchHintIsRelevant(state.job.watchFilter, changedName)) return;
          if (state.debounceTimer) clearTimeout(state.debounceTimer);
          state.debounceTimer = setTimeout(() => {
            void runJob(state);
          }, state.job.watchDebounceMs ?? 2000);
        });
        watcher.on('error', (err) => {
          log('warn', `scheduler: fs.watch error, relying on interval only`, { job: state.job.name, dir, error: String(err) });
        });
        state.watchers.push(watcher);
      } catch (err) {
        // e.g. ERR_FEATURE_UNAVAILABLE_ON_PLATFORM (recursive watch on Linux) — best-effort hint
        // only, the interval below is the real guarantee.
        log('warn', `scheduler: could not watch path, relying on interval only`, {
          job: state.job.name,
          dir,
          error: String(err),
        });
      }
    }
  }

  return {
    snapshot() {
      return states.map(({ status }) => ({
        ...status,
        lastStats: status.lastStats
          ? {
            ...status.lastStats,
            ...(status.lastStats.codexCursorCoverageAtStat
              ? { codexCursorCoverageAtStat: { ...status.lastStats.codexCursorCoverageAtStat } }
              : {}),
          }
          : null,
      }));
    },
    async runAllOnce(opts) {
      const results = [];
      for (const state of states) {
        if (opts?.shouldStop?.()) break; // No next initial job after its owner begins shutdown.
        results.push(await runJob(state));
      }
      return results;
    },

    start() {
      if (started) return;
      started = true;
      stopping = false;
      eventLoopDelay.enable();
      eventLoopTimer = setInterval(reportEventLoopDelay, EVENT_LOOP_SAMPLE_MS);
      for (const state of states) {
        state.timer = setInterval(() => void runJob(state), state.job.intervalMs);
        armWatch(state);
      }
    },

    async drain() {
      this.stop();
      await Promise.allSettled([...active]);
    },
    stop() {
      stopping = true;
      started = false;
      if (eventLoopTimer) clearInterval(eventLoopTimer);
      eventLoopTimer = undefined;
      eventLoopDelay.disable();
      eventLoopDelay.reset();
      for (const state of states) {
        state.rerunRequested = false;
        state.status.rerunQueued = false;
        if (state.timer) clearInterval(state.timer);
        if (state.debounceTimer) clearTimeout(state.debounceTimer);
        for (const w of state.watchers) w.close();
        state.watchers = [];
      }
    },
  };
}
