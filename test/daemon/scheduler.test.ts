import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createScheduler,
  isJsonlHint,
  watchHintIsRelevant,
  type SchedulerJob,
  type Scheduler,
} from '../../src/daemon/scheduler.js';

// Capture the real API once; a timed-out attempt must not capture a prior attempt's spy.
const nativeFsWatch = fs.watch;

describe('scheduler scan observations', () => {
  const quietStats = { collector: 'quiet', filesScanned: 12, filesSkipped: 0, eventsEmitted: 0,
    bytesRead: 0, warnings: [] as string[], durationMs: 999 };

  it('distinguishes a pending scan from a completed quiet scan and returns detached, private metadata', async () => {
    let wall = 1000;
    let mono = 10;
    const scheduler = createScheduler([{ name: 'quiet', intervalMs: 30_000, run: async () => {
      wall = 1025; mono = 35; return quietStats;
    } }], { now: () => wall, monotonicNow: () => mono });
    expect(scheduler.snapshot()[0]).toMatchObject({ lastOutcome: null, lastStats: null, lastFinishedAt: null, running: false });
    await scheduler.runAllOnce();
    expect(scheduler.snapshot()[0]).toMatchObject({ lastOutcome: 'completed', lastCompletedAt: 1025,
      lastStartedAt: 1000, lastFinishedAt: 1025, lastDurationMs: 25, running: false,
      lastStats: { filesScanned: 12, recordsEmitted: 0, warningCount: 0 } });
    const copy = scheduler.snapshot();
    copy[0].lastStats!.recordsEmitted = 99;
    copy[0].name = 'mutated';
    expect(scheduler.snapshot()[0].name).toBe('quiet');
    expect(scheduler.snapshot()[0].lastStats!.recordsEmitted).toBe(0);
  });

  it('forwards a Codex cursor snapshot and detaches its nested metadata from callers', async () => {
    const scheduler = createScheduler([{
      name: 'codex', intervalMs: 30_000, run: async () => ({
        ...quietStats,
        collector: 'codex',
        codexCursorCoverageAtStat: {
          filesDiscovered: 3, filesObservedAtStat: 2, filesBehindCursorAtStat: 1,
          bytesUnreadAtStat: 28, filesWithoutUsableCursorAtStat: 1,
          filesWithStatError: 1, filesWithCursorStateError: 0,
        },
      }),
    }]);
    await scheduler.runAllOnce();
    const snapshot = scheduler.snapshot();
    expect(snapshot[0].lastStats?.codexCursorCoverageAtStat).toMatchObject({
      filesDiscovered: 3, filesObservedAtStat: 2, filesBehindCursorAtStat: 1, bytesUnreadAtStat: 28,
    });
    snapshot[0].lastStats!.codexCursorCoverageAtStat!.bytesUnreadAtStat = 0;
    expect(scheduler.snapshot()[0].lastStats?.codexCursorCoverageAtStat?.bytesUnreadAtStat).toBe(28);
  });

  it('preserves last completion across failure, clears attempt metrics, and exposes warning counts without private text', async () => {
    let fail = false;
    let wall = 1000;
    const scheduler = createScheduler([{ name: 'a', intervalMs: 30_000, run: async () => {
      if (fail) throw new Error('private filesystem path');
      return { ...quietStats, warnings: ['private warning path'] };
    } }], { now: () => wall });
    await scheduler.runAllOnce();
    expect(scheduler.snapshot()[0]).toMatchObject({ lastOutcome: 'warnings', lastCompletedAt: 1000, lastStats: { warningCount: 1 } });
    fail = true; wall = 2000;
    await scheduler.runAllOnce();
    expect(scheduler.snapshot()[0]).toMatchObject({ lastOutcome: 'failed', lastCompletedAt: 1000,
      lastFailedAt: 2000, lastFinishedAt: 2000, lastStats: null });
    expect(JSON.stringify(scheduler.snapshot())).not.toContain('private');
    fail = false; wall = 3000;
    await scheduler.runAllOnce();
    expect(scheduler.snapshot()[0]).toMatchObject({ lastOutcome: 'warnings', lastCompletedAt: 3000,
      lastFailedAt: 2000, lastStats: { warningCount: 1 } });
  });

  it('measures duration monotonically even when the wall clock moves backwards', async () => {
    let wall = 1000;
    let mono = 100;
    const scheduler = createScheduler([{ name: 'a', intervalMs: 30_000, run: async () => {
      wall = 500; mono = 140; return quietStats;
    } }], { now: () => wall, monotonicNow: () => mono });
    await scheduler.runAllOnce();
    expect(scheduler.snapshot()[0]).toMatchObject({ lastStartedAt: 1000, lastFinishedAt: 500, lastDurationMs: 40 });
  });
});

describe('scheduler.runAllOnce', () => {
  it('runs every job exactly once, in order, and returns their results', async () => {
    const calls: string[] = [];
    const jobs: SchedulerJob[] = [
      { name: 'a', intervalMs: 1000, run: async () => { calls.push('a'); return undefined; } },
      { name: 'b', intervalMs: 1000, run: async () => { calls.push('b'); return undefined; } },
    ];
    const scheduler = createScheduler(jobs);
    const results = await scheduler.runAllOnce();
    expect(calls).toEqual(['a', 'b']);
    expect(results.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('a job that throws is caught and reported as {error}, and does not stop the others', async () => {
    const calls: string[] = [];
    const jobs: SchedulerJob[] = [
      { name: 'a', intervalMs: 1000, run: async () => { throw new Error('boom'); } },
      { name: 'b', intervalMs: 1000, run: async () => { calls.push('b'); } },
    ];
    const scheduler = createScheduler(jobs);
    const results = await scheduler.runAllOnce();
    expect(calls).toEqual(['b']);
    expect(results[0]!.error).toBeInstanceOf(Error);
    expect(results[1]!.error).toBeUndefined();
  });

  it('logs slow collector metrics without warning contents after a successful scan', async () => {
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const scheduler = createScheduler([
      {
        name: 'codex',
        intervalMs: 1000,
        run: async () => ({
          collector: 'codex',
          filesScanned: 12,
          filesSkipped: 2,
          eventsEmitted: 3,
          bytesRead: 4096,
          warnings: ['private path must not be included'],
          durationMs: 1987,
        }),
      },
    ], { log: (level, msg, data) => entries.push({ level, msg, data }) });

    await scheduler.runAllOnce();

    expect(entries).toEqual([
      {
        level: 'debug',
        msg: 'scheduler job completed',
        data: {
          job: 'codex',
          durationMs: 1987,
          filesScanned: 12,
          filesSkipped: 2,
          eventsEmitted: 3,
          bytesRead: 4096,
          warningCount: 1,
        },
      },
    ]);
  });

  it('does not log ordinary successful scans', async () => {
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const scheduler = createScheduler([
      {
        name: 'codex',
        intervalMs: 1000,
        run: async () => ({
          collector: 'codex',
          filesScanned: 0,
          filesSkipped: 0,
          eventsEmitted: 0,
          bytesRead: 0,
          warnings: [],
          durationMs: 25,
        }),
      },
    ], { log: (level, msg, data) => entries.push({ level, msg, data }) });

    await scheduler.runAllOnce();

    expect(entries).toEqual([]);
  });
});

describe('scheduler.start/stop: interval scheduling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a job on its interval and stop() halts further runs', async () => {
    vi.useFakeTimers();
    let count = 0;
    const jobs: SchedulerJob[] = [{ name: 'x', intervalMs: 1000, run: async () => { count++; } }];
    const scheduler = createScheduler(jobs);
    scheduler.start();
    expect(count).toBe(0); // start() does not itself run immediately — that's runAllOnce's job

    await vi.advanceTimersByTimeAsync(1000);
    expect(count).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(count).toBe(3);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(count).toBe(3); // no further runs after stop()
  });

  it('samples event-loop delay every minute and clears the sampler on stop', async () => {
    vi.useFakeTimers();
    const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
    const scheduler = createScheduler([], { log: (level, msg, data) => entries.push({ level, msg, data }) });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(entries).toEqual([
      {
        level: 'debug',
        msg: 'daemon event loop delay sample',
        data: { windowMs: 60_000, maxDelayMs: expect.any(Number), meanDelayMs: expect.any(Number) },
      },
    ]);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries).toHaveLength(1);
  });

  it('never runs a job concurrently with itself: an overlapping interval tick coalesces into one re-run after the in-flight run finishes', async () => {
    vi.useFakeTimers();
    let concurrentRuns = 0;
    let maxConcurrent = 0;
    let totalRuns = 0;
    let releaseFirst: (() => void) | undefined;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const jobs: SchedulerJob[] = [
      {
        name: 'slow',
        intervalMs: 100,
        run: async () => {
          concurrentRuns++;
          maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
          totalRuns++;
          if (totalRuns === 1) await firstRunGate; // hold the first run open across several ticks
          concurrentRuns--;
        },
      },
    ];
    const scheduler = createScheduler(jobs);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(100); // first run starts, blocks on the gate
    await vi.advanceTimersByTimeAsync(300); // three more ticks fire while it's still in flight

    expect(maxConcurrent).toBe(1); // never ran twice at once
    expect(totalRuns).toBe(1); // still only the first run has actually executed
    expect(scheduler.snapshot()[0]).toMatchObject({ running: true, rerunQueued: true,
      lastOutcome: null, lastCompletedAt: null, currentStartedAt: expect.any(Number) });

    releaseFirst!();
    await vi.advanceTimersByTimeAsync(0); // let the first run's finally{} coalesced re-run fire
    await vi.advanceTimersByTimeAsync(0);
    expect(totalRuns).toBe(2); // exactly one coalesced re-run, not three (one per missed tick)
    expect(scheduler.snapshot()[0]).toMatchObject({ running: false, rerunQueued: false,
      currentStartedAt: null, lastOutcome: 'completed', lastStats: null });

    scheduler.stop();
  });
});

describe('scheduler: fs.watch hints', () => {
  let tmpDir: string;
  let scheduler: Scheduler | undefined;

  afterEach(() => {
    scheduler?.stop();
    scheduler = undefined;
    vi.restoreAllMocks();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  // Native registration is not a delivery receipt. Exercise modification of an
  // existing file and require its actual callback followed by a scheduler run.
  // This is a delivered-hint test, not a one-write/file-creation delivery guarantee.
  it('a file change under a watched path triggers a run sooner than the interval', { retry: 2, timeout: 10_000 }, async () => {
    const watchedDir = tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-sched-watch-'));
    const target = 'existing-file.txt';
    fs.writeFileSync(path.join(watchedDir, target), 'before registration');
    let count = 0;
    let targetRunCount: number | null = null;
    const rawNames: Array<string | null> = [];
    const observer = vi.spyOn(fs, 'watch').mockImplementation((watched, options, listener) =>
      nativeFsWatch(watched, options, (event, name) => {
        const changed = name?.toString() ?? null;
        rawNames.push(changed);
        if (changed === target && targetRunCount === null) targetRunCount = count;
        listener!(event, name);
      }));
    const attemptScheduler = createScheduler([
      { name: 'watched', intervalMs: 60_000, watchPaths: [watchedDir], watchDebounceMs: 20, run: async () => { count++; } },
    ]);
    scheduler = attemptScheduler;
    const deadline = Date.now() + 8_000;
    try {
      attemptScheduler.start();
      expect(count).toBe(0);
      let writes = 0;
      while (targetRunCount === null && Date.now() < deadline) {
        fs.writeFileSync(path.join(watchedDir, target), String(++writes));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      while (targetRunCount !== null && count <= targetRunCount && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(rawNames).toContain(target);
      expect(targetRunCount).not.toBeNull();
      expect(count).toBeGreaterThan(targetRunCount!);
    } finally {
      attemptScheduler.stop();
      if (fs.watch === observer) observer.mockRestore();
    }
  });

  it('a nonexistent watch path never throws — the job still exists and can still be run manually', async () => {
    const jobs: SchedulerJob[] = [
      { name: 'ghost', intervalMs: 60_000, watchPaths: ['/definitely/does/not/exist/tokenelo-test'], run: async () => 'ok' as never },
    ];
    scheduler = createScheduler(jobs);
    expect(() => scheduler!.start()).not.toThrow();
    const results = await scheduler.runAllOnce();
    expect(results[0]!.error).toBeUndefined();
  });

  it('a hint for a non-.jsonl file does not start a run; a .jsonl hint does (real fs.watch)', { retry: 2, timeout: 10_000 }, async () => {
    const root = tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-sched-filter-'));
    const negativeDir = path.join(root, 'negative'), positiveDir = path.join(root, 'positive');
    fs.mkdirSync(negativeDir); fs.mkdirSync(positiveDir);
    const noise = 'logs_1.sqlite-wal', target = 'rollout-x.jsonl';
    fs.writeFileSync(path.join(negativeDir, noise), 'before registration');
    fs.writeFileSync(path.join(positiveDir, target), '{}\n');
    let negativeRuns = 0, positiveRuns = 0;
    let targetRunCount: number | null = null;
    const negativeNames: Array<string | null> = [], positiveNames: Array<string | null> = [];
    const observer = vi.spyOn(fs, 'watch').mockImplementation((watched, options, listener) =>
      nativeFsWatch(watched, options, (event, name) => {
        const changed = name?.toString() ?? null;
        if (String(watched) === negativeDir) negativeNames.push(changed);
        else if (String(watched) === positiveDir) {
          positiveNames.push(changed);
          if (changed === target && targetRunCount === null) targetRunCount = positiveRuns;
        }
        listener!(event, name);
      }));
    // Observe real rejected and accepted hints concurrently. A positive job cannot
    // conceal a mistakenly accepted negative hint: they have independent counters.
    const attemptScheduler = createScheduler([
      { name: 'negative', intervalMs: 60_000, watchPaths: [negativeDir], watchDebounceMs: 20, watchFilter: isJsonlHint, run: async () => { negativeRuns++; } },
      { name: 'positive', intervalMs: 60_000, watchPaths: [positiveDir], watchDebounceMs: 20, watchFilter: isJsonlHint, run: async () => { positiveRuns++; } },
    ]);
    scheduler = attemptScheduler;
    // Retain the original 400ms negative observation + 8s maximum, not two
    // serial OS readiness phases. Registration and all assertions share 8.4s.
    const wholeDeadline = Date.now() + 400 + 8_000;
    try {
      attemptScheduler.start();
      let writes = 0;
      while ((!negativeNames.includes(noise) || targetRunCount === null || positiveRuns <= targetRunCount)
        && Date.now() + 400 < wholeDeadline) {
        if (!negativeNames.includes(noise)) fs.writeFileSync(path.join(negativeDir, noise), String(++writes));
        if (targetRunCount === null) fs.writeFileSync(path.join(positiveDir, target), JSON.stringify({ fixture: ++writes }) + '\n');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(negativeNames).toContain(noise);
      expect(positiveNames).toContain(target);
      expect(targetRunCount).not.toBeNull();
      expect(positiveRuns).toBeGreaterThan(targetRunCount!);
      expect(Date.now() + 400).toBeLessThanOrEqual(wholeDeadline);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(negativeRuns).toBe(0); // delivered noise has its own full observation window
      expect(negativeNames).not.toContain(null);
      expect(positiveNames).not.toContain(null);
    } finally {
      attemptScheduler.stop();
      if (fs.watch === observer) observer.mockRestore();
    }
  });

});

describe('watch hint relevance', () => {
  it('no filter, or an unreported name, is always relevant; a filter decides only for a reported name', () => {
    expect(watchHintIsRelevant(undefined, 'anything.sqlite')).toBe(true);
    expect(watchHintIsRelevant(isJsonlHint, null)).toBe(true); // platform gave no name: never silently dropped
    expect(watchHintIsRelevant(isJsonlHint, 'sessions\\2026\\09\\rollout-x.jsonl')).toBe(true);
    expect(watchHintIsRelevant(isJsonlHint, 'logs_1.sqlite-wal')).toBe(false);
  });

  it('isJsonlHint is case-insensitive on the extension and rejects look-alike names', () => {
    expect(isJsonlHint('ROLLOUT.JSONL')).toBe(true);
    expect(isJsonlHint('notes.jsonl.tmp')).toBe(false);
    expect(isJsonlHint('transcript.json')).toBe(false);
  });
});

it('drain waits for an accepted scan and prevents a queued rerun after stop',async()=>{
 let release!:()=>void,enter!:()=>void,calls=0;
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const scheduler=createScheduler([{name:'owned-held',intervalMs:1000,run:async()=>{calls++;enter();await gate;}}]);
 const initial=scheduler.runAllOnce();await entered;
 await scheduler.runAllOnce();let drained=false;const draining=scheduler.drain().then(()=>{drained=true;});
 await Promise.resolve();expect(drained).toBe(false);expect(scheduler.snapshot()[0]?.running).toBe(true);
 release();await initial;await draining;expect(calls).toBe(1);expect(scheduler.snapshot()[0]?.running).toBe(false);expect(scheduler.snapshot()[0]?.rerunQueued).toBe(false);
});
it('a stopped scheduler cannot begin another initial scan until explicitly restarted',async()=>{
 let calls=0;const scheduler=createScheduler([{name:'owned-stop',intervalMs:1000,run:async()=>{calls++;}}]);
 scheduler.stop();await scheduler.runAllOnce();expect(calls).toBe(0);
 scheduler.start();try{await scheduler.runAllOnce();expect(calls).toBe(1);}finally{await scheduler.drain();}
});
