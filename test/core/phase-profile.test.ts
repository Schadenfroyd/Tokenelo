/**
 * Optional phase profiler: disabled path, statistics, owner accounting per inter-tick interval, in-flight attribution,
 * the allowed-key contract, environment gating, the static route map, and integration with the real Claude and Codex
 * scans.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_ITEM_KEYS,
  ALLOWED_KEYS,
  createProfiler,
  measure,
  setActiveProfiler,
  spanStart,
  startProfilerFromEnv,
  stopProfiler,
  summarizeOwners,
  type ProfileSink,
} from '../../src/core/phase-profile.js';
import { routeClass } from '../../src/daemon/main.js';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { CodexCollector } from '../../src/collectors/codex.js';
import { baseTestConfig, makeHarness, type TestHarness } from '../claude/helpers.js';
import { FIXTURES, MemoryStore, makeCtx } from '../codex/helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profilerModuleUrl = pathToFileURL(path.join(repoRoot, 'src/core/phase-profile.ts')).href;

function runProfilerChild(source: string): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.TOKENELO_PROFILE_FILE = '';
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    timeout: 15_000,
  });
}

function memorySink(): { sink: ProfileSink; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return { sink: { write: (l) => lines.push(JSON.parse(JSON.stringify(l))), flush: () => {} }, lines };
}

beforeEach(() => {
  setActiveProfiler(null);
});
afterEach(() => {
  stopProfiler();
});

describe('disabled path', () => {
  it('measure is a pass-through and spanStart returns 0 when no profiler is active', () => {
    expect(measure('x', () => 42)).toBe(42);
    expect(spanStart()).toBe(0);
  });

  it('startProfilerFromEnv does nothing without TOKENELO_PROFILE_FILE', () => {
    expect(startProfilerFromEnv({})).toBeNull();
  });

  it('startProfilerFromEnv refuses a relative profile path', () => {
    expect(() => startProfilerFromEnv({ TOKENELO_PROFILE_FILE: 'relative.jsonl' })).toThrow('absolute');
  });
});

describe('statistics per window', () => {
  it('counts, totals and maxima per phase name, nested-inclusive, with a fake clock', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    p.measure('a', () => {
      clock += 5;
    });
    p.measure('a', () => {
      clock += 3;
    });
    p.measure('b', () => {
      clock += 1;
    });
    p.flushStats(10);
    const stats = lines.find((l) => l.type === 'stats')!;
    expect(stats.phases).toEqual({ a: { count: 2, totalMs: 8, maxMs: 5 }, b: { count: 1, totalMs: 1, maxMs: 1 } });
    expect(stats.windowMs).toBe(10);
  });

  it('a throwing phase is still recorded, and the error propagates', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    expect(() =>
      p.measure('boom', () => {
        clock += 2;
        throw new Error('fail');
      })
    ).toThrow('fail');
    p.flushStats(4);
    expect((lines.find((l) => l.type === 'stats')!.phases as Record<string, { count: number }>).boom!.count).toBe(1);
  });
});

describe('owner accounting (pure)', () => {
  it('the largest single instance decides the owner, and the offset is measured from the gap start', () => {
    const owners = summarizeOwners(
      [
        { name: 'a', startMs: 100, endMs: 130 },
        { name: 'c', startMs: 40, endMs: 60 },
        { name: 'a', startMs: 135, endMs: 137 },
      ],
      50
    );
    expect(owners.map((o) => o.name)).toEqual(['a', 'c']);
    expect(owners[0]).toEqual({ name: 'a', count: 2, totalMs: 32, durMs: 30, startOffsetMs: 50 });
  });

  it('a large early span is not evicted by a flood of small later spans (no ring, no silent loss)', () => {
    const spans = [{ name: 'claude.window_read', startMs: 0, endMs: 300 }];
    for (let i = 0; i < 2000; i++) spans.push({ name: 'codex.push_line', startMs: 300 + i * 0.01, endMs: 300 + i * 0.01 + 0.005 });
    const owners = summarizeOwners(spans, 0);
    expect(owners[0]).toMatchObject({ name: 'claude.window_read', count: 1, durMs: 300 });
    expect(owners.find((o) => o.name === 'codex.push_line')).toMatchObject({ count: 2000 });
  });
});

describe('gap records and in-flight attribution', () => {
  it('a synchronous block longer than the threshold is recorded with the phase that owned it and the span count', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    p.measure('block', () => {
      clock = 60;
    });
    p.tick(60);
    const gaps = lines.filter((l) => l.type === 'gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.gapMs).toBe(60);
    expect(gaps[0]!.spans).toBe(1);
    expect((gaps[0]!.sync as Array<{ name: string }>).map((s) => s.name)).toEqual(['block']);
  });

  it('the interval accumulator is reset at each tick: a later gap with no spans reports none', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    p.measure('block', () => {
      clock = 60;
    });
    p.tick(60);
    clock = 120;
    p.tick(120);
    const gaps = lines.filter((l) => l.type === 'gap');
    expect(gaps).toHaveLength(2);
    expect(gaps[1]).toMatchObject({ gapMs: 60, spans: 0, sync: [] });
  });

  it('many per-line spans inside one gap do not hide the large span that owned it', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    p.recordSpan('claude.window_read', 0, 200);
    for (let i = 0; i < 2000; i++) p.recordSpan('codex.push_line', 200 + i * 0.01, 200 + i * 0.01 + 0.005);
    clock = 230;
    p.tick(230);
    const gap = lines.find((l) => l.type === 'gap')!;
    expect(gap.spans).toBe(2001);
    const sync = gap.sync as Array<{ name: string; count: number; durMs: number }>;
    expect(sync[0]).toMatchObject({ name: 'claude.window_read', count: 1, durMs: 200 });
    expect(sync.find((s) => s.name === 'codex.push_line')!.count).toBe(2000);
  });

  it('a gap below the threshold is not recorded', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    clock = 10;
    p.tick(10);
    expect(lines.filter((l) => l.type === 'gap')).toHaveLength(0);
  });

  it('an interval in flight at the gap is named in the gap record, and its end is logged', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    const id = p.begin('job.claude');
    clock = 40;
    p.tick(40);
    p.end(id);
    const gap = lines.find((l) => l.type === 'gap')!;
    expect(gap.inflight).toEqual(['job.claude']);
    expect(lines.some((l) => l.type === 'interval' && l.name === 'job.claude')).toBe(true);
  });
});

describe('what a profile line may contain', () => {
  it('every top-level key is in ALLOWED_KEYS, and owner items carry only ALLOWED_ITEM_KEYS', () => {
    let clock = 0;
    const { sink, lines } = memorySink();
    const p = createProfiler({ sink, now: () => clock, windowStartMs: 0 });
    const id = p.begin('http.v1.coverage');
    p.measure('codex.push_line', () => {
      clock = 50;
    });
    p.tick(50);
    p.end(id);
    p.flushStats(60);
    for (const line of lines) {
      for (const key of Object.keys(line)) expect(ALLOWED_KEYS.has(key), key).toBe(true);
      if (line.type === 'gap') {
        for (const item of line.sync as Array<Record<string, unknown>>) {
          for (const key of Object.keys(item)) expect(ALLOWED_ITEM_KEYS.has(key), key).toBe(true);
        }
      }
    }
  });
});

describe('environment gating writes only to the requested absolute file', () => {
  it('writes a start line to the file and stops cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-profile-'));
    try {
      const file = path.join(tmp, 'profile.jsonl');
      const p = startProfilerFromEnv({ TOKENELO_PROFILE_FILE: file });
      expect(p).not.toBeNull();
      stopProfiler();
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('"type":"start"');
      expect(text).not.toContain(tmp); // the path itself is never written into a line
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detaches its exit callback before a stopped profiler scratch directory is removed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-profile-stop-'));
    try {
      const file = path.join(tmp, 'profile.jsonl');
      const source = `
        const { startProfilerFromEnv, stopProfiler } = await import(${JSON.stringify(profilerModuleUrl)});
        const { rmSync } = await import('node:fs');
        startProfilerFromEnv({ TOKENELO_PROFILE_FILE: ${JSON.stringify(file)} });
        stopProfiler();
        rmSync(${JSON.stringify(tmp)}, { recursive: true, force: true });
      `;
      const child = runProfilerChild(source);
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).not.toContain('ENOENT');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replaces the exit callback and flushes only the active profiler on natural exit', () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-profile-first-'));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-profile-second-'));
    try {
      const firstFile = path.join(first, 'profile.jsonl');
      const secondFile = path.join(second, 'profile.jsonl');
      const source = `
        const { startProfilerFromEnv } = await import(${JSON.stringify(profilerModuleUrl)});
        const { rmSync } = await import('node:fs');
        const baseline = process.listenerCount('exit');
        startProfilerFromEnv({ TOKENELO_PROFILE_FILE: ${JSON.stringify(firstFile)} });
        if (process.listenerCount('exit') !== baseline + 1) process.exit(61);
        startProfilerFromEnv({ TOKENELO_PROFILE_FILE: ${JSON.stringify(secondFile)} });
        if (process.listenerCount('exit') !== baseline + 1) process.exit(62);
        rmSync(${JSON.stringify(first)}, { recursive: true, force: true });
      `;
      const child = runProfilerChild(source);
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stderr).not.toContain('ENOENT');
      const lines = fs.readFileSync(secondFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines.map((line) => line.type)).toEqual(['start', 'stats']);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('route labels: a fixed static set; everything else is other', () => {
  it('the static API routes map to their labels, with the query string ignored', () => {
    expect(routeClass('/v1/coverage')).toBe('v1.coverage');
    expect(routeClass('/v1/coverage?x=1')).toBe('v1.coverage');
    expect(routeClass('/v1/sessions/detail?source=claude&sessionId=abc')).toBe('v1.sessions.detail');
    expect(routeClass('/v1/limits/history')).toBe('v1.limits.history');
    expect(routeClass('/v1/hello?nonce=abc')).toBe('v1.hello');
  });

  it('an alphabetic session or project name in a path is other, even without digits', () => {
    expect(routeClass('/v1/sessions/claude/private-session-name')).toBe('other');
    expect(routeClass('/v1/private-project-name')).toBe('other');
    expect(routeClass('/v1/sessions/claude')).toBe('other');
    expect(routeClass('/v1/coverage/extra')).toBe('other');
  });

  it('identifier-shaped and unknown paths are other, and so is a missing URL', () => {
    expect(routeClass('/v1/sessions/0f3c2d1e-aaaa-4bbb-8ccc-123456789abc')).toBe('other');
    expect(routeClass('/v1/sessions%2Fclaude')).toBe('other');
    expect(routeClass('/some/other/path')).toBe('other');
    expect(routeClass('/V1/COVERAGE')).toBe('other');
    expect(routeClass(undefined)).toBe('other');
  });
});

describe('integration: the real collectors emit their phase names', () => {
  let h: TestHarness | undefined;
  afterEach(() => {
    h?.close();
    h = undefined;
  });

  it('a Claude scan reports the walk, state, read, parse, pricing, valuation and write phases', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-profile-claude-'));
    try {
      const projDir = path.join(tmpRoot, '-fixture-profile');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionId = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
      const lines = Array.from({ length: 5 }, (_, i) =>
        JSON.stringify({
          type: 'assistant', uuid: `p-${i}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/profile',
          message: { id: `prof-${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        })
      );
      fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      const { sink, lines: out } = memorySink();
      const p = createProfiler({ sink, windowStartMs: 0 });
      setActiveProfiler(p);
      await new ClaudeCollector().scan(h.ctx);
      p.flushStats(1);
      const phases = out.find((l) => l.type === 'stats')!.phases as Record<string, { count: number }>;
      for (const name of ['claude.walk', 'fs.stat_fields', 'claude.get_state', 'claude.window_read', 'claude.json_parse', 'claude.parse_segment', 'price.event', 'units.valuation', 'claude.upsert_events', 'claude.record_activity', 'claude.set_state', 'db.begin_immediate', 'db.commit']) {
        expect(phases[name], name).toBeDefined();
        expect(phases[name]!.count, name).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('a Codex scan reports the discovery, state, line parse, conversion and write phases', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-profile-codex-'));
    try {
      const dst = path.join(home, 'sessions', '2026', '09', '08', 'rollout-2026-09-08T07-14-11-01a08127-9a3d-7220-a867-0b45fa2e2dab.jsonl');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(FIXTURES, 'root-reset-01a08127.jsonl'), dst);
      const store = new MemoryStore();
      const { sink, lines: out } = memorySink();
      const p = createProfiler({ sink, windowStartMs: 0 });
      setActiveProfiler(p);
      await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
      p.flushStats(1);
      const phases = out.find((l) => l.type === 'stats')!.phases as Record<string, { count: number }>;
      for (const name of ['codex.discover', 'codex.stat_fields', 'codex.get_state', 'codex.push_line', 'codex.to_usage_event', 'codex.upsert_events']) {
        expect(phases[name], name).toBeDefined();
        expect(phases[name]!.count, name).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
