/**
 * Optional, env-gated phase profiler for attributing event-loop blocks in a real daemon run.
 *
 * Disabled unless TOKENELO_PROFILE_FILE is set to an ABSOLUTE scratch path chosen by the operator. When disabled every
 * hook is a single null check and runs the wrapped function unchanged, and the daemon registers no profiling listener or
 * wrapper (see main.ts).
 *
 * What it records (names are static strings in the code; nothing else is recorded):
 *   - stats lines: per phase name, the count, total and maximum duration within each stats window (nested phases are
 *     counted inclusively, so totals can overlap);
 *   - gap lines: each explicit-ticker gap at or above GAP_THRESHOLD_MS, with the synchronous phases that ran inside it
 *     (per name: count, total, and the largest single instance with its offset from the gap start) and the names of
 *     intervals in flight (jobs and HTTP routes, by static name);
 *   - interval lines: the start and end of each in-flight interval, by name.
 * Never recorded: file paths, file contents, prompts, model names, identifiers, or request bodies. A sink line holds
 * only the keys listed in ALLOWED_KEYS, which the tests check.
 *
 * Collector file metadata uses awaited stat: `fs.stat_fields` and `codex.stat_fields` measure only synchronous
 * bigint field conversion. `claude.stat_io` and `codex.stat_io` intervals record awaited metadata wall time separately,
 * never filesystem wait time as sync CPU ownership. Historical *.stat spans are not comparable to these new scopes.
 *
 * Attribution accounting. Synchronous code cannot be interrupted by a timer, so a synchronous span never straddles an
 * explicit tick. Every span finished since the previous tick therefore lies inside the gap that the next tick measures.
 * That holds only for spans that contain no await. A span bracketed across an await would include the time the loop spent
 * elsewhere, so a collector must pause such a span at each await (SyncSegment, awaitOutside). A span is then synchronous
 * work, and an awaited wait is never recorded as a synchronous owner.
 * The profiler keeps one accumulator per phase name for the current inter-tick interval, so no span is evicted and the
 * memory is proportional to the number of phase names, not to the number of lines. Each gap line reports how many spans
 * the interval contained (`spans`), so a reader can see the population the owner was chosen from.
 *
 * Limits of the attribution. The owner is the phase name with the largest single instance in the gap. That is wall-time
 * overlap on this thread, not CPU attribution, and not a proof of cause. A gap with no sync span is either uninstrumented
 * synchronous work or work outside every hook; missing spans are never evidence that a covered phase was absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const TICK_MS = 10;
export const GAP_THRESHOLD_MS = 25;
export const STATS_WINDOW_MS = 10_000;
const MAX_OWNERS = 8;

/** The only keys a profile line may contain. Nested items use ALLOWED_ITEM_KEYS. The tests assert both sets. */
export const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'type', 'atMs', 'mono', 'windowMs', 'phases', 'count', 'totalMs', 'maxMs', 'name', 'durMs', 'startMs', 'endMs',
  'gapMs', 'sync', 'spans', 'inflight', 'startOffsetMs', 'pid',
]);
export const ALLOWED_ITEM_KEYS: ReadonlySet<string> = new Set(['name', 'count', 'totalMs', 'durMs', 'startOffsetMs']);

export interface SpanRecord {
  name: string;
  startMs: number;
  endMs: number;
}

export interface PhaseStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface Owner {
  name: string;
  count: number;
  totalMs: number;
  durMs: number;
  startOffsetMs: number;
}

export interface ProfileSink {
  write(line: Record<string, unknown>): void;
  flush(): void;
}

export interface Profiler {
  now(): number;
  measure<T>(name: string, fn: () => T): T;
  recordSpan(name: string, startMs: number, endMs: number): void;
  begin(name: string): number;
  end(id: number): void;
  tick(nowMs: number): void;
  flushStats(nowMs: number): void;
  close(): void;
}

const round = (n: number): number => Math.round(n * 10) / 10;

interface Accumulator {
  count: number;
  totalMs: number;
  maxMs: number;
  maxStartMs: number;
}

function accumulate(acc: Map<string, Accumulator>, name: string, startMs: number, endMs: number): void {
  const dur = endMs - startMs;
  const a = acc.get(name) ?? { count: 0, totalMs: 0, maxMs: 0, maxStartMs: startMs };
  a.count++;
  a.totalMs += dur;
  if (dur > a.maxMs) {
    a.maxMs = dur;
    a.maxStartMs = startMs;
  }
  acc.set(name, a);
}

/**
 * Owners of a gap that began at `gapStartMs`: per phase name, the count, total, and the largest single instance,
 * ordered by that largest instance (wall-time overlap), at most MAX_OWNERS of them. Pure and deterministic.
 */
export function summarizeOwners(spans: readonly SpanRecord[], gapStartMs: number): Owner[] {
  const acc = new Map<string, Accumulator>();
  for (const s of spans) accumulate(acc, s.name, s.startMs, s.endMs);
  return ownersFrom(acc, gapStartMs);
}

function ownersFrom(acc: Map<string, Accumulator>, gapStartMs: number): Owner[] {
  return [...acc.entries()]
    .map(([name, a]) => ({
      name,
      count: a.count,
      totalMs: round(a.totalMs),
      durMs: round(a.maxMs),
      startOffsetMs: round(Math.max(0, a.maxStartMs - gapStartMs)),
    }))
    .sort((x, y) => y.durMs - x.durMs)
    .slice(0, MAX_OWNERS);
}

export function createProfiler(opts: { sink: ProfileSink; now?: () => number; windowStartMs?: number }): Profiler {
  const { sink } = opts;
  const now = opts.now ?? (() => performance.now());
  // Spans are timed on the profiler's own clock, so a test can drive span durations deterministically.
  const stats = new Map<string, PhaseStats>();
  const interval = new Map<string, Accumulator>(); // spans finished since the previous tick
  let intervalSpans = 0;
  const inflight = new Map<number, { name: string; startMs: number }>();
  let nextId = 1;
  let lastTick = now();
  let lastFlush = opts.windowStartMs ?? lastTick;

  const record = (name: string, startMs: number, endMs: number): void => {
    accumulate(interval, name, startMs, endMs);
    intervalSpans++;
    const dur = endMs - startMs;
    const s = stats.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    s.count++;
    s.totalMs += dur;
    if (dur > s.maxMs) s.maxMs = dur;
    stats.set(name, s);
  };

  const profiler: Profiler = {
    now,
    measure<T>(name: string, fn: () => T): T {
      const t0 = now();
      try {
        return fn();
      } finally {
        record(name, t0, now());
      }
    },
    recordSpan(name, startMs, endMs) {
      record(name, startMs, endMs);
    },
    begin(name) {
      const id = nextId++;
      inflight.set(id, { name, startMs: now() });
      return id;
    },
    end(id) {
      const item = inflight.get(id);
      if (!item) return;
      inflight.delete(id);
      sink.write({ type: 'interval', name: item.name, startMs: round(item.startMs), endMs: round(now()), atMs: Date.now() });
    },
    tick(t) {
      const gap = t - lastTick;
      const gapStart = lastTick;
      const owners = ownersFrom(interval, gapStart);
      const spans = intervalSpans;
      interval.clear();
      intervalSpans = 0;
      lastTick = t;
      if (gap >= GAP_THRESHOLD_MS) {
        sink.write({
          type: 'gap',
          atMs: Date.now(),
          mono: round(t),
          gapMs: round(gap),
          spans,
          sync: owners,
          inflight: [...inflight.values()].filter((i) => i.startMs < t).map((i) => i.name),
        });
      }
      if (t - lastFlush >= STATS_WINDOW_MS) profiler.flushStats(t);
    },
    flushStats(t) {
      const phases: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
      for (const [name, s] of stats) phases[name] = { count: s.count, totalMs: round(s.totalMs), maxMs: round(s.maxMs) };
      sink.write({ type: 'stats', atMs: Date.now(), mono: round(t), windowMs: round(t - lastFlush), phases });
      stats.clear();
      lastFlush = t;
      sink.flush();
    },
    close() {
      profiler.flushStats(now());
      sink.flush();
    },
  };
  return profiler;
}

/** Appends JSON lines to an absolute file, buffered and flushed in small batches. */
export function createFileSink(file: string): ProfileSink {
  if (!path.isAbsolute(file)) throw new Error('profile file must be an absolute path');
  const buffer: string[] = [];
  return {
    write(line) {
      buffer.push(JSON.stringify(line));
      if (buffer.length >= 50) this.flush();
    },
    flush() {
      if (buffer.length === 0) return;
      fs.appendFileSync(file, buffer.join('\n') + '\n');
      buffer.length = 0;
    },
  };
}

// ── process-wide hook ────────────────────────────────────────────────────────────────────────

let active: Profiler | null = null;
let activeTimer: NodeJS.Timeout | null = null;
let activeExitHandler: (() => void) | null = null;

function detachActiveExitHandler(): void {
  if (!activeExitHandler) return;
  process.off('exit', activeExitHandler);
  activeExitHandler = null;
}

export function activeProfiler(): Profiler | null {
  return active;
}

/** Installs (or with null, removes) the profiler used by the hooks. Closes the previous one. */
export function setActiveProfiler(p: Profiler | null): void {
  if (active !== p) {
    detachActiveExitHandler();
    if (active) active.close();
  }
  active = p;
}

/** Runs `fn` as a named synchronous phase. A pass-through when no profiler is active. */
export function measure<T>(name: string, fn: () => T): T {
  return active ? active.measure(name, fn) : fn();
}

/** Start time for a manually bracketed synchronous segment (0 when disabled). Use with spanEnd. */
export function spanStart(): number {
  return active ? active.now() : 0;
}

export function spanEnd(name: string, startMs: number): void {
  if (active && startMs > 0) active.recordSpan(name, startMs, active.now());
}

/**
 * A synchronous segment of a function that also awaits. The segment runs while it is open and is paused at each await, so
 * no recorded span contains an awaited wait (I/O, a yield, another job's turn). Use with awaitOutside, which pauses the
 * segment around each await. Pausing is idempotent, so close() after pause() records nothing extra.
 */
export class SyncSegment {
  private startMs: number;

  constructor(private readonly name: string) {
    this.startMs = spanStart();
  }

  pause(): void {
    spanEnd(this.name, this.startMs);
    this.startMs = 0;
  }

  resume(): void {
    this.startMs = spanStart();
  }

  close(): void {
    this.pause();
  }
}

/** Awaits `wait` with the segment paused, and resumes it when the wait settles. */
export async function awaitOutside<T>(segment: SyncSegment, wait: () => Promise<T>): Promise<T> {
  segment.pause();
  try {
    return await wait();
  } finally {
    segment.resume();
  }
}

/** Starts an in-flight interval (job or request). Returns 0 when disabled; pass it to intervalEnd. */
export function intervalBegin(name: string): number {
  return active ? active.begin(name) : 0;
}

export function intervalEnd(id: number): void {
  if (active && id > 0) active.end(id);
}

/**
 * Enables the profiler from the environment. Returns null (and does nothing) unless TOKENELO_PROFILE_FILE is set.
 * Starts an explicit ticker, unref'd so it never keeps a process alive, and writes a start line with the pid.
 */
export function startProfilerFromEnv(env: NodeJS.ProcessEnv = process.env): Profiler | null {
  const file = env.TOKENELO_PROFILE_FILE;
  if (!file) return null;
  const sink = createFileSink(file);
  const profiler = createProfiler({ sink });
  sink.write({ type: 'start', atMs: Date.now(), pid: process.pid });
  setActiveProfiler(profiler);
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = setInterval(() => profiler.tick(performance.now()), TICK_MS);
  activeTimer.unref();
  const exitHandler = (): void => {
    if (activeExitHandler === exitHandler) activeExitHandler = null;
    if (active === profiler) profiler.close(); // final stats window and buffered lines (synchronous)
  };
  activeExitHandler = exitHandler;
  process.once('exit', exitHandler);
  return profiler;
}

export function stopProfiler(): void {
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = null;
  setActiveProfiler(null);
}
