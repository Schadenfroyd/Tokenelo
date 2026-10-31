/**
 * Elapsed-time yield pacing in the Claude and Codex file loops. A count-only rule lets a chunk of slow files run for
 * hundreds of milliseconds, so the loops also yield on a time budget. The clock is injected, so the tests are
 * deterministic: each reading advances one millisecond, and a 5 ms budget must yield about every five files.
 *
 * The profiling segments (`*.file_sync`) must cover only synchronous work. The regression tests below drive the profiler
 * clock by event-loop turn, so a segment that stays open across any await gets a duration above zero.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FILES_PER_YIELD, YieldPacer } from '../../src/core/event-loop.js';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { CodexCollector } from '../../src/collectors/codex.js';
import { createProfiler, setActiveProfiler, stopProfiler, type ProfileSink } from '../../src/core/phase-profile.js';
import { baseTestConfig, makeHarness, type TestHarness } from '../claude/helpers.js';
import { FIXTURES, MemoryStore, makeCtx } from '../codex/helpers.js';

afterEach(() => {
  stopProfiler();
});

/** Counts event-loop turns while `fn` runs. A synchronous loop with no yields adds none. */
async function countTurns<T>(fn: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  let running = true;
  const spin = (): void => {
    if (!running) return;
    turns++;
    setImmediate(spin);
  };
  spin();
  try {
    const result = await fn();
    return { result, turns };
  } finally {
    running = false;
  }
}

/**
 * Runs `fn` with the profiler clock driven by event-loop turns, and returns the phase statistics. Durations here are
 * turn counts, not milliseconds. A span with a duration of 0 ran entirely between two event-loop turns, so it contains no
 * macrotask boundary.
 */
async function profileByTurn<T>(fn: () => Promise<T>): Promise<{ result: T; phases: Record<string, { count: number; maxMs: number }> }> {
  let turn = 1;
  let running = true;
  const spin = (): void => {
    if (!running) return;
    turn++;
    setImmediate(spin);
  };
  const profile: Array<Record<string, unknown>> = [];
  const sink: ProfileSink = { write: (l) => profile.push(l), flush: () => {} };
  const profiler = createProfiler({ sink, now: () => turn, windowStartMs: 0 });
  setActiveProfiler(profiler);
  spin();
  try {
    const result = await fn();
    profiler.flushStats(turn);
    const phases = profile.find((l) => l.type === 'stats')!.phases as Record<string, { count: number; maxMs: number }>;
    return { result, phases };
  } finally {
    running = false;
    stopProfiler();
  }
}

describe('YieldPacer', () => {
  it('yields after the item cap even when the clock does not move', () => {
    const p = new YieldPacer(1_000, 3, () => 0);
    expect([p.due(), p.due(), p.due()]).toEqual([false, false, true]);
    p.yielded();
    expect(p.due()).toBe(false);
  });

  it('yields once the budget has elapsed, even with few items, and restarts the clock on yielded()', () => {
    let t = 0;
    const p = new YieldPacer(10, 1_000, () => t);
    expect(p.due()).toBe(false); // at t = 0
    t = 10;
    expect(p.due()).toBe(true); // 10 ms elapsed
    p.yielded(); // last yield at t = 10
    t = 15;
    expect(p.due()).toBe(false);
    t = 20;
    expect(p.due()).toBe(true);
  });

  it('the item cap is the shipped FILES_PER_YIELD when no cap is given', () => {
    const p = new YieldPacer(1_000_000, undefined, () => 0);
    for (let i = 1; i < FILES_PER_YIELD; i++) expect(p.due()).toBe(false);
    expect(p.due()).toBe(true);
  });
});

/** 300 Claude transcripts in five project directories, one assistant line each. */
function writeClaudeFixture(root: string, lineNumber = 0): void {
  for (let p = 0; p < 5; p++) {
    const dir = path.join(root, `-fixture-pacing-${p}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 60; i++) {
      const sessionId = `00000000-0000-4000-8000-${String(p * 100 + i).padStart(12, '0')}`;
      fs.appendFileSync(
        path.join(dir, `${sessionId}.jsonl`),
        JSON.stringify({
          type: 'assistant', uuid: `u-${sessionId}-${lineNumber}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/pacing',
          message: { id: `pace-${sessionId}-${lineNumber}`, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }) + '\n'
      );
    }
  }
}

describe('Claude file loop yields on the time budget', () => {
  let h: TestHarness | undefined;
  let tmpRoot: string | undefined;
  afterEach(() => {
    h?.close();
    h = undefined;
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it('300 unchanged files with a 5 ms budget yield about every five files, not once per 200', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-pacing-claude-'));
    writeClaudeFixture(tmpRoot);
    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    await new ClaudeCollector().scan(h.ctx); // ingest everything with the default collector

    let clock = 0;
    const profile: Array<Record<string, unknown>> = [];
    const sink: ProfileSink = { write: (l) => profile.push(l), flush: () => {} };
    const profiler = createProfiler({ sink, windowStartMs: 0 });
    setActiveProfiler(profiler);
    const paced = new ClaudeCollector({ yieldBudgetMs: 5, monotonicNow: () => clock++ });
    const { result, turns } = await countTurns(() => paced.scan(h!.ctx));
    profiler.flushStats(1);

    expect(result.filesScanned).toBe(300);
    expect(result.bytesRead).toBe(0);
    expect(turns).toBeGreaterThanOrEqual(40); // a count-only rule would give one turn at file 200
    const phases = profile.find((l) => l.type === 'stats')!.phases as Record<string, { count: number }>;
    expect(phases['claude.file_sync']!.count).toBeGreaterThanOrEqual(40);
  });

  it('no file_sync segment spans an await, with changed files that take the window, batch and yield paths', async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-pacing-claude-'));
    writeClaudeFixture(tmpRoot);
    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    await new ClaudeCollector().scan(h.ctx);
    writeClaudeFixture(tmpRoot, 1); // one new assistant line per file: each file is read, parsed and written

    let clock = 0;
    const paced = new ClaudeCollector({ yieldBudgetMs: 5, monotonicNow: () => clock++ });
    const { result: scan, phases } = await profileByTurn(() => paced.scan(h!.ctx));

    expect(scan.bytesRead).toBeGreaterThan(0);
    expect(phases['claude.file_sync']!.count).toBeGreaterThanOrEqual(40);
    expect(phases['claude.file_sync']!.maxMs).toBe(0);
    // The walk pauses between directory reads, so its segments are split at those pauses and none spans a turn.
    expect(phases['claude.walk']!.count).toBeGreaterThanOrEqual(2);
    expect(phases['claude.walk']!.maxMs).toBe(0);
  });
});

/** Writes `n` rollout files under `home`, each a copy of the fixture's session_meta line with its own id. */
function writeCodexFixture(home: string, n: number): string[] {
  const source = fs.readFileSync(path.join(FIXTURES, 'root-reset-01a08127.jsonl'), 'utf8').split('\n')[0]!;
  const sourceId = '01a08127-9a3d-7220-a867-0b45fa2e2dab';
  const files: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `01a08127-9a3d-7220-a867-${String(i).padStart(12, '0')}`;
    const file = path.join(home, 'sessions', '2026', '09', '08', `rollout-2026-09-08T07-14-11-${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source.replaceAll(sourceId, id) + '\n');
    files.push(file);
  }
  return files;
}

describe('Codex file loop yields on the time budget', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('300 unchanged rollouts with a 5 ms budget yield about every five files', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-pacing-codex-'));
    writeCodexFixture(home, 300);
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store)); // ingest everything with the default collector

    let clock = 0;
    const paced = new CodexCollector({ homes: [home], yieldBudgetMs: 5, monotonicNow: () => clock++ });
    const { result, turns } = await countTurns(() => paced.scan(makeCtx(store)));

    expect(result.bytesRead).toBe(0);
    expect(turns).toBeGreaterThanOrEqual(40);
  });

  it('no file_sync segment spans an await, with changed rollouts that take the async read path', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-pacing-codex-'));
    const files = writeCodexFixture(home, 300);
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    for (const f of files) fs.appendFileSync(f, '\n'); // size changes, so each file is read again through parseRolloutFile

    let clock = 0;
    const paced = new CodexCollector({ homes: [home], yieldBudgetMs: 5, monotonicNow: () => clock++ });
    const { result: scan, phases } = await profileByTurn(() => paced.scan(makeCtx(store)));

    expect(scan.bytesRead).toBeGreaterThan(0);
    expect(phases['codex.file_sync']!.count).toBeGreaterThanOrEqual(40);
    expect(phases['codex.file_sync']!.maxMs).toBe(0);
  });
});
