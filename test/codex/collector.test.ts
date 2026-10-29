/**
 * CodexCollector end-to-end against a temp CODEX_HOME with an in-memory ledger: discovery + dedupe,
 * incremental resume (appends, partial trailing lines, truncation), thread_turns timestamps via a real
 * read-only node:sqlite DB, rate limits and activity marks.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexCollector, detectCodexThinking, discoverRollouts, resolveCodexHomes, safeIno, statFile, parseRolloutFile, CodexRolloutParser, rawBillable } from '../../src/collectors/codex.js';
import type { UsageEvent } from '../../src/core/types.js';
import { FIXTURES, MemoryStore, Rollout, makeCtx } from './helpers.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
};

const ID_RESET = '01a08127-9a3d-7220-a867-0b45fa2e2dab';
const ID_GUARD = '01a0928c-66fa-7e63-8ca1-6346d2c83dce';
const ID_SPAWN = '01a02222-a911-7d51-bb59-c44f412f764c';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-codex-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function place(fixture: string, rel: string): string {
  const dst = path.join(home, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), dst);
  return dst;
}

function placeRollout(rollout: Rollout, rel: string): string {
  const dst = path.join(home, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, rollout.text());
  return dst;
}

function sessionBillable(store: MemoryStore, sid: string): number {
  let b = 0;
  for (const e of store.events.values()) {
    if (e.sessionId !== sid) continue;
    b += e.tokens.inputFresh + e.tokens.cacheRead + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h + e.tokens.output;
  }
  return b;
}

describe('roots and discovery', () => {
  it('$CODEX_HOME comma list, else ~/.codex; config wins', () => {
    expect(resolveCodexHomes(undefined, { CODEX_HOME: '/a, /b' }, '/home/u')).toEqual(['/a', '/b']);
    expect(resolveCodexHomes(undefined, {}, '/home/u')).toEqual([path.join('/home/u', '.codex')]);
    expect(resolveCodexHomes(['/c'], { CODEX_HOME: '/a' }, '/home/u')).toEqual(['/c']);
  });

  it('dedupes a session present in sessions/ and archived_sessions/ (sessions/ wins) — counted once', async () => {
    const live = place('root-reset-01a08127.jsonl', `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    const arch = place('root-reset-01a08127.jsonl', `archived_sessions/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    const { files, duplicates } = discoverRollouts([home]);
    expect(files.map((f) => f.path)).toEqual([live]);
    expect(duplicates.map((d) => d.path)).toEqual([arch]);

    const store = new MemoryStore();
    const stats = await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    expect(sessionBillable(store, ID_RESET)).toBe(1_823_004); // not 3,646,008
    expect(stats.filesScanned).toBe(1);
    expect(store.skipped).toEqual([{ path: arch, reason: 'other' }]);
  });
});

describe('parent baseline evidence completeness', () => {
  const parentId = '01a00000-0000-7000-8000-000000000101';
  const childId = '01a00000-0000-7000-8000-000000000102';
  const parentPath = `sessions/2026/09/08/rollout-2026-09-08T00-00-00-${parentId}.jsonl`;
  const childPath = `sessions/2026/09/08/rollout-2026-09-08T00-01-00-${childId}.jsonl`;

  function smallParent(total = 20): Rollout {
    return new Rollout().meta({ id: parentId, thread_source: 'user' })
      .taskStarted('parent-own').assistant().tokenCount([total, 0, 0, 0], [total, 0, 0, 0]);
  }

  function longParent(): Rollout {
    const rollout = new Rollout()
      .meta({ id: parentId, thread_source: 'user' })
      .taskStarted('parent-own')
      .assistant()
      .tokenCount([10, 0, 0, 0], [10, 0, 0, 0]);
    for (let total = 11; total <= 79; total++) rollout.tokenCount([total, 0, 0, 0], [1, 0, 0, 0]);
    return rollout;
  }

  function childWithBaselineTen(): Rollout {
    return new Rollout()
      .meta({ id: childId, parent_thread_id: parentId, thread_source: 'subagent' })
      .taskStarted('child-own', Date.UTC(2026, 8, 1, 12, 0, 1) / 1000)
      .assistant()
      .tokenCount([1_010, 0, 0, 0], [1_000, 0, 0, 0]);
  }

  it('keeps a baseline unknown when an unchanged parent cache retains only its latest 64 of 70 totals', async () => {
    const parentFile = placeRollout(longParent(), parentPath);
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const parentState = store.getState(parentFile)!;
    const parentExtra = parentState.extra as { summary: { tokenCountEvents: number }; recentTotals: number[] };
    expect(parentExtra.summary.tokenCountEvents).toBe(70);
    expect(parentExtra.recentTotals).toHaveLength(64);
    expect(parentExtra.recentTotals).not.toContain(10);

    const childFile = placeRollout(childWithBaselineTen(), childPath);
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const childExtra = store.getState(childFile)!.extra as { summary: { baselineTotal: number; inheritedBaselineSuspect: boolean } };
    expect(childExtra.summary).toMatchObject({ baselineTotal: 10, inheritedBaselineSuspect: false });
    expect(sessionBillable(store, childId)).toBe(1_000);
    expect([...store.events.values()].filter((event) => event.sessionId === childId)).toHaveLength(1);
  });

  it('retains a suspect diagnosis when a complete cached parent has no matching total', async () => {
    placeRollout(smallParent(), parentPath);
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const childFile = placeRollout(childWithBaselineTen(), childPath);
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const extra = store.getState(childFile)!.extra as { summary: { inheritedBaselineSuspect: boolean } };
    expect(extra.summary.inheritedBaselineSuspect).toBe(true);
    expect(sessionBillable(store, childId)).toBe(1_000);
  });

  it('uses a complete parent parsed earlier in the same scan for negative membership', async () => {
    placeRollout(smallParent(), parentPath);
    const childFile = placeRollout(childWithBaselineTen(), childPath);
    const store = new MemoryStore();

    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));

    const extra = store.getState(childFile)!.extra as { summary: { baselineTotal: number; inheritedBaselineSuspect: boolean } };
    expect(extra.summary).toMatchObject({ baselineTotal: 10, inheritedBaselineSuspect: true });
    expect(sessionBillable(store, childId)).toBe(1_000);
  });

  it.each([false, true])('leaves a parent with an unread trailing line unknown (cached=%s)', async (cached) => {
    const parentFile = placeRollout(smallParent(), parentPath);
    fs.appendFileSync(parentFile, '{"type":"event_msg","payload":{"type":"token_count"}');
    const store = new MemoryStore();
    if (cached) await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const childFile = placeRollout(childWithBaselineTen(), childPath);
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const parent = store.getState(parentFile)!;
    expect(parent.offset).toBeLessThan(parent.size);
    const extra = store.getState(childFile)!.extra as { summary: { inheritedBaselineSuspect: boolean } };
    expect(extra.summary.inheritedBaselineSuspect).toBe(false);
    expect(sessionBillable(store, childId)).toBe(1_000);
  });

  it('withholds negative membership when a duplicate parent file was excluded by discovery', async () => {
    placeRollout(smallParent(), parentPath);
    const archived = placeRollout(smallParent(10),
      'archived_sessions/rollout-2026-09-08T00-00-00-' + parentId + '.jsonl');
    const childFile = placeRollout(childWithBaselineTen(), childPath);
    const store = new MemoryStore();
    const stats = await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const extra = store.getState(childFile)!.extra as { summary: { inheritedBaselineSuspect: boolean } };
    expect(extra.summary.inheritedBaselineSuspect).toBe(false);
    expect(stats.filesSkipped).toBe(1);
    expect(store.skipped).toContainEqual({ path: archived, reason: 'other' });
    expect(sessionBillable(store, parentId)).toBe(20);
    expect(sessionBillable(store, childId)).toBe(1_000);
  });

  it('leaves a malformed persisted parent total cache unknown', async () => {
    const parentFile = placeRollout(smallParent(), parentPath);
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const prior = store.getState(parentFile)!;
    store.setState({ ...prior, extra: { ...(prior.extra as object), recentTotals: ['invalid'] } });
    const childFile = placeRollout(childWithBaselineTen(), childPath);
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const extra = store.getState(childFile)!.extra as { summary: { inheritedBaselineSuspect: boolean } };
    expect(extra.summary.inheritedBaselineSuspect).toBe(false);
    expect(sessionBillable(store, childId)).toBe(1_000);
  });

  it('keeps a legacy parent cache without recent totals unknown instead of treating it as a complete empty set', async () => {
    const parentFile = placeRollout(longParent(), parentPath);
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const prior = store.getState(parentFile)!;
    const legacyExtra = { ...(prior.extra as Record<string, unknown>) };
    delete legacyExtra.recentTotals;
    store.setState({ ...prior, extra: legacyExtra });

    const childFile = placeRollout(childWithBaselineTen(), childPath);
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const childExtra = store.getState(childFile)!.extra as { summary: { baselineTotal: number; inheritedBaselineSuspect: boolean } };
    expect(childExtra.summary).toMatchObject({ baselineTotal: 10, inheritedBaselineSuspect: false });
    expect(sessionBillable(store, childId)).toBe(1_000);
  });
});

describe('statFile', () => {
  it('always yields a safe-integer ino (NTFS ids exceed 2^53; node:sqlite cannot read them back)', () => {
    const p = path.join(home, 'x.jsonl');
    fs.writeFileSync(p, 'abc\n');
    const st = statFile(p);
    expect(Number.isSafeInteger(st.ino)).toBe(true);
    expect(st.size).toBe(4);
    expect(st.ino).toBe(Number(fs.statSync(p, { bigint: true }).ino % 9007199254740991n));
    // a real A2000 NTFS file id (> 2^53): node:sqlite threw RangeError reading it back before this guard
    const ntfs = 9_851_624_185_066_820n;
    expect(Number.isSafeInteger(safeIno(ntfs))).toBe(true);
    expect(safeIno(ntfs)).toBe(844_424_930_325_829); // 9,851,624,185,066,820 − 9,007,199,254,740,991
    expect(safeIno(ntfs + 1n)).not.toBe(safeIno(ntfs));
  });
});

describe('full scan of the real fixtures', () => {
  it('records byte-snapshot cursor coverage for a newly discovered rollout without calling it captured', async () => {
    const rollout = place('root-reset-01a08127.jsonl', `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    const sourceBytesAtStat = fs.statSync(rollout).size;
    const stats = await new CodexCollector({ homes: [home] }).scan(makeCtx(new MemoryStore()));
    expect(stats.codexCursorCoverageAtStat).toMatchObject({
      filesDiscovered: 1,
      filesObservedAtStat: 1,
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: sourceBytesAtStat,
      filesWithoutUsableCursorAtStat: 1,
      filesWithStatError: 0,
      filesWithCursorStateError: 0,
    });
  });

  it('reports a new rollout as unread at its scan-time stat while parsing it from byte zero', async () => {
    const rollout = place('root-reset-01a08127.jsonl', `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    const size = fs.statSync(rollout).size;
    const stats = await new CodexCollector({ homes: [home] }).scan(makeCtx(new MemoryStore()));
    expect(stats.codexCursorCoverageAtStat).toMatchObject({
      filesDiscovered: 1,
      filesObservedAtStat: 1,
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: size,
      filesWithoutUsableCursorAtStat: 1,
      filesWithStatError: 0,
      filesWithCursorStateError: 0,
    });
  });

  it('reports appended trailing bytes separately from emitted usage', async () => {
    const rollout = place('root-reset-01a08127.jsonl', `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    const store = new MemoryStore();
    const collector = new CodexCollector({ homes: [home] });
    await collector.scan(makeCtx(store));
    const priorOffset = store.states.get(rollout)!.offset;
    const partial = Buffer.from('{"type":"event_msg","payload":{"type":"token_count"}');
    fs.appendFileSync(rollout, partial);
    const stats = await collector.scan(makeCtx(store));
    expect(stats.codexCursorCoverageAtStat).toMatchObject({
      filesDiscovered: 1,
      filesObservedAtStat: 1,
      filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: partial.length,
      filesWithoutUsableCursorAtStat: 0,
    });
    expect(store.states.get(rollout)?.offset).toBe(priorOffset);
  });

  it('stores exactly the hand-computed own usage per session and records the newest rate-limit snapshot', async () => {
    place('root-reset-01a08127.jsonl', `archived_sessions/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    place('guardian-records-01a0928c.jsonl', `sessions/2026/09/11/rollout-2026-09-11T16-17-50-${ID_GUARD}.jsonl`);
    place('subagent-copied-snapshot-01a02222.jsonl', `archived_sessions/rollout-2026-08-20T20-24-51-${ID_SPAWN}.jsonl`);
    place('import-marker-01a0dfe2.jsonl', 'sessions/2026/09/26/rollout-2026-09-26T16-42-35-01a0dfe2-7616-79a0-b50f-13f600d19d96.jsonl');
    const store = new MemoryStore();
    const ctx = makeCtx(store);
    const stats = await new CodexCollector({ homes: [home] }).scan(ctx);
    expect(sessionBillable(store, ID_RESET)).toBe(1_823_004);
    expect(sessionBillable(store, ID_GUARD)).toBe(440_528);
    expect(sessionBillable(store, ID_SPAWN)).toBe(5_104_534);
    expect(store.events.size).toBe(29 + 3 + 43);
    expect(stats.eventsEmitted).toBe(75);
    expect(stats.filesScanned).toBe(4);
    const guard = [...store.events.values()].filter((e) => e.sessionId === ID_GUARD);
    expect(guard.every((e) => e.isSubagent && e.parentSessionId === '01a08d0d-1f91-7c42-a57f-95c1f913ce61')).toBe(true);
    // root-reset-01a08127.jsonl's turn_context carries reasoning_effort:'xhigh' throughout -> every
    // event thinking:true regardless of that particular event's own reasoning_output_tokens (some
    // are 0 in this fixture — effort alone already proves it, per detectCodexThinking).
    const resetEvents = [...store.events.values()].filter((e) => e.sessionId === ID_RESET);
    expect(resetEvents.length).toBeGreaterThan(0);
    expect(resetEvents.every((e) => e.thinking === true)).toBe(true);
    expect(resetEvents.every((e) => !e.flags.includes('thinkingUnknown'))).toBe(true);
    // newest snapshot across files = the 01a0928c turn at 2026-09-11 (started_at 1789166171)
    expect(store.limits).toHaveLength(1);
    expect(store.limits[0]).toMatchObject({ source: 'codex', estimate: false, planType: 'pro', capturedAt: 1_789_166_171_000 });
    // activity: turn marks carry real durations (task_complete duration_ms)
    const turnMarks = store.activity.filter((m) => m.sessionId === ID_RESET && m.kind === 'turn' && m.durationMs !== undefined);
    expect(turnMarks.map((m) => m.durationMs)).toEqual([152_686, 32_363, 10_927, 14_296, 12_806, 11_873, 13_815]);
    // doctor-facing summary persisted in ingest_state.extra
    const st = [...store.states.values()].find((s) => s.key.includes(ID_RESET))!;
    expect((st.extra as { summary: { resets: number } }).summary.resets).toBe(1);
  });

  it('a second scan of unchanged files reads nothing and writes nothing', async () => {
    place('guardian-records-01a0928c.jsonl', `sessions/2026/09/11/rollout-2026-09-11T16-17-50-${ID_GUARD}.jsonl`);
    const store = new MemoryStore();
    const c = new CodexCollector({ homes: [home] });
    await c.scan(makeCtx(store));
    const calls = store.upsertCalls;
    const again = await c.scan(makeCtx(store));
    expect(again.filesScanned).toBe(0);
    expect(again.bytesRead).toBe(0);
    expect(store.upsertCalls).toBe(calls);
  });
});

describe('incremental resume', () => {
  it('reports a partial trailing append as unread source bytes while leaving the cursor before it', async () => {
    const file = place('root-reset-01a08127.jsonl', `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    const store = new MemoryStore();
    const collector = new CodexCollector({ homes: [home] });
    await collector.scan(makeCtx(store));
    const oldOffset = store.states.get(file)!.offset;
    const tail = Buffer.from('{"type":"event_msg","payload":{"type":"token_count"}');
    fs.appendFileSync(file, tail);
    const stats = await collector.scan(makeCtx(store));
    expect(stats.codexCursorCoverageAtStat).toMatchObject({
      filesDiscovered: 1, filesObservedAtStat: 1, filesBehindCursorAtStat: 1,
      bytesUnreadAtStat: tail.length, filesWithoutUsableCursorAtStat: 0,
    });
    expect(store.states.get(file)?.offset).toBe(oldOffset);
  });

  async function scanInChunks(fixture: string, cuts: number[], batchSize = 2000) {
    const src = fs.readFileSync(path.join(FIXTURES, fixture));
    const dst = path.join(home, `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { force: true });
    const store = new MemoryStore();
    const c = new CodexCollector({ homes: [home], batchSize });
    let written = 0;
    for (const cut of [...cuts, src.length]) {
      fs.appendFileSync(dst, src.subarray(written, cut));
      written = cut;
      // make sure mtime moves even on coarse-mtime filesystems
      const t = new Date(Date.now() + written);
      fs.utimesSync(dst, t, t);
      await c.scan(makeCtx(store));
    }
    return store;
  }

  it('appending in arbitrary byte chunks (mid-line cuts included) gives the same events as one read', async () => {
    const whole = await scanInChunks('root-reset-01a08127.jsonl', []);
    const size = fs.statSync(path.join(FIXTURES, 'root-reset-01a08127.jsonl')).size;
    const cuts = [1, 777, 5_000, Math.floor(size / 3), Math.floor(size / 2) + 13, size - 5];
    const chunked = await scanInChunks('root-reset-01a08127.jsonl', cuts);
    expect(sessionBillable(chunked, ID_RESET)).toBe(1_823_004);
    expect([...chunked.events.keys()].sort()).toEqual([...whole.events.keys()].sort());
    const withoutCodexFieldState = (event: UsageEvent): UsageEvent => ({
      ...event,
      components: event.components.map(component => {
        const { codexFieldStateEvidence: _evidence, ...rest } = component;
        return rest;
      }),
    });
    // Resumed cursors predate field-state capture, so their additive metadata stays unassessed.
    for (const [id, e] of whole.events) expect(withoutCodexFieldState(chunked.events.get(id)!)).toEqual(withoutCodexFieldState(e));
  });

  it('small batches persist intermediate offsets that resume exactly', async () => {
    const store = await scanInChunks('subagent-copied-snapshot-01a02222.jsonl', [40_000, 90_000], 3);
    expect(sessionBillable(store, ID_SPAWN)).toBe(5_104_534);
  });

  it('a crash between batches resumes from the last committed batch with no loss and no double count', async () => {
    place('subagent-copied-snapshot-01a02222.jsonl', `archived_sessions/rollout-2026-08-20T20-24-51-${ID_SPAWN}.jsonl`);
    class CrashingStore extends MemoryStore {
      crashAt = 4;
      override upsertEvents(events: Parameters<MemoryStore['upsertEvents']>[0]) {
        if (this.upsertCalls + 1 === this.crashAt) {
          this.upsertCalls++;
          throw new Error('simulated crash');
        }
        return super.upsertEvents(events);
      }
    }
    const store = new CrashingStore();
    const c = new CodexCollector({ homes: [home], batchSize: 5 });
    const first = await c.scan(makeCtx(store));
    expect(first.warnings.some((w) => w.includes('simulated crash'))).toBe(true);
    const partial = sessionBillable(store, ID_SPAWN);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(5_104_534);
    store.crashAt = -1;
    await c.scan(makeCtx(store));
    expect(sessionBillable(store, ID_SPAWN)).toBe(5_104_534);
    expect(store.events.size).toBe(43);
  });

  it('a partial trailing line is not consumed until it is completed', async () => {
    const dst = path.join(home, 'sessions/2026/09/01/rollout-2026-09-01T00-00-00-01a0aaaa-0000-7000-8000-000000000001.jsonl');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const r = new Rollout().meta({ id: '01a0aaaa-0000-7000-8000-000000000001', thread_source: 'user' })
      .taskStarted('T1').assistant().tokenCount([100, 0, 10], [100, 0, 10]);
    const full = r.text();
    fs.writeFileSync(dst, full.slice(0, full.length - 20)); // last line cut mid-JSON, no newline
    const store = new MemoryStore();
    const c = new CodexCollector({ homes: [home] });
    await c.scan(makeCtx(store));
    expect(store.events.size).toBe(0);
    const st = store.getState(dst)!;
    expect(st.offset).toBeLessThan(st.size);
    fs.appendFileSync(dst, full.slice(full.length - 20));
    await c.scan(makeCtx(store));
    expect(sessionBillable(store, '01a0aaaa-0000-7000-8000-000000000001')).toBe(110);
  });

  it('a truncated/replaced file is re-read from 0 with fresh state', async () => {
    const dst = path.join(home, 'sessions/2026/09/01/rollout-2026-09-01T00-00-00-01a0aaaa-0000-7000-8000-000000000002.jsonl');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const sid = '01a0aaaa-0000-7000-8000-000000000002';
    const long = new Rollout().meta({ id: sid, thread_source: 'user' }).taskStarted('T1').assistant()
      .tokenCount([100, 0, 10], [100, 0, 10]).tokenCount([300, 0, 30], [200, 0, 20]);
    fs.writeFileSync(dst, long.text());
    const store = new MemoryStore();
    const ctx = makeCtx(store);
    const c = new CodexCollector({ homes: [home] });
    await c.scan(ctx);
    const short = new Rollout().meta({ id: sid, thread_source: 'user' }).taskStarted('T1').assistant().tokenCount([50, 0, 5], [50, 0, 5]);
    fs.writeFileSync(dst, short.text());
    await c.scan(ctx);
    expect(ctx.logs.some((l) => l.msg.includes('re-reading'))).toBe(true);
    expect(store.getState(dst)!.offset).toBe(Buffer.byteLength(short.text()));
  });
});

describe('thread_turns (thread_history_1.sqlite, read-only)', () => {
  it('buckets a frozen subagent turn with no in-file timing by thread_turns.started_at', async () => {
    const sid = '01a0bbbb-0000-7000-8000-000000000003';
    const created = Date.UTC(2026, 7, 24, 20, 46, 24, 849);
    const r = new Rollout(created, 0)
      .meta({ id: sid, thread_source: 'subagent', parent_thread_id: '01a0bbbb-0000-7000-8000-0000000000aa', source: { subagent: { other: 'guardian' } } })
      .tokenCount([5000, 0, 50], [0, 0, 0, 0, 0, 1])
      .taskStarted('rollout-2', 1_787_604_384)
      .turnContextFlat('01a0bbbb-1111-7000-8000-000000000001', 'codex-auto-review', 'low')
      .assistant()
      .tokenCount([6000, 0, 60], [1000, 0, 10]); // the turn is still running: no task_complete yet
    const dst = path.join(home, `sessions/2026/08/24/rollout-2026-08-24T14-46-24-${sid}.jsonl`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, r.text());
    const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
    db.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT,
      started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT,
      rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER)`);
    db.prepare('INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(sid, '01a0bbbb-1111-7000-8000-000000000001', 3, 'in_progress', 1_787_851_514);
    db.close();
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const evs = [...store.events.values()];
    expect(evs.map((e) => [e.tsSource, e.ts])).toEqual([['turn', 1_787_851_514_000]]);
    // the DB file is untouched by the read-only open
    expect(fs.existsSync(path.join(home, 'thread_history_1.sqlite'))).toBe(true);
  });
});

describe('against the real SqliteLedger (in-memory DB, stub engines)', () => {
  it('ingests the fixtures, re-ingest is a no-op, totals match the hand-computed own usage', async () => {
    const { openDb } = await import('../../src/store/db.js');
    const { SqliteLedger } = await import('../../src/store/ledger.js');
    place('root-reset-01a08127.jsonl', `archived_sessions/rollout-2026-09-08T07-14-11-${ID_RESET}.jsonl`);
    place('guardian-records-01a0928c.jsonl', `sessions/2026/09/11/rollout-2026-09-11T16-17-50-${ID_GUARD}.jsonl`);
    place('subagent-copied-snapshot-01a02222.jsonl', `archived_sessions/rollout-2026-08-20T20-24-51-${ID_SPAWN}.jsonl`);
    const db = openDb({ file: ':memory:' });
    const probe = makeCtx(new MemoryStore());
    const ledger = new SqliteLedger(db, probe.pricing, probe.valuationEngine);
    const ctx = makeCtx(ledger);
    const c = new CodexCollector({ homes: [home], batchSize: 7 });
    const s1 = await c.scan(ctx);
    expect(s1.warnings).toEqual([]);
    const s2 = await c.scan(ctx);
    expect(s2.filesScanned).toBe(0);
    const rows = db
      .prepare(`SELECT session_id s, count(*) n, sum(input_fresh + cache_read + cache_write_5m + cache_write_1h + output) b
                FROM events GROUP BY session_id ORDER BY session_id`)
      .all() as { s: string; n: number; b: number }[];
    expect(rows).toEqual([
      { s: ID_SPAWN, n: 43, b: 5_104_534 },
      { s: ID_RESET, n: 29, b: 1_823_004 },
      { s: ID_GUARD, n: 3, b: 440_528 },
    ]);
    db.close();
  });
});

describe('rate limits across files are recorded per limit id (DESIGN §15.9.5)', () => {
  it('the newest snapshot of EACH id is recorded; a newer other-id snapshot never hides the main codex limit', async () => {
    const A = '01a09999-0000-7000-8000-000000000001';
    const B = '01a09999-0000-7000-8000-000000000002';
    const rl = (id: string, pct: number) => ({
      limit_id: id, primary: { used_percent: pct, window_minutes: 10080, resets_at: 1_790_444_630 }, secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'pro',
    });
    const write = (rel: string, text: string) => {
      const p = path.join(home, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    };
    write(`sessions/2026/09/20/rollout-2026-09-20T10-00-00-${A}.jsonl`,
      new Rollout().meta({ id: A }).taskStarted('T1').assistant().tokenCountNoInfo(rl('codex', 44), 1_789_000_000_000).text());
    write(`sessions/2026/09/21/rollout-2026-09-21T10-00-00-${B}.jsonl`,
      new Rollout().meta({ id: B }).taskStarted('T1').assistant()
        .tokenCountNoInfo(rl('codex', 40), 1_788_000_000_000) // older than file A's codex snapshot
        .tokenCountNoInfo(rl('codex_bengalfox', 3), 1_789_500_000_000) // newest overall
        .text());
    const store = new MemoryStore();
    await new CodexCollector({ homes: [home] }).scan(makeCtx(store));
    const byId = new Map(store.limits.map((l) => [l.limitId, l]));
    expect(store.limits).toHaveLength(2);
    expect(byId.get('codex')).toMatchObject({ capturedAt: 1_789_000_000_000, windows: [{ usedPercent: 44 }] });
    expect(byId.get('codex_bengalfox')).toMatchObject({ capturedAt: 1_789_500_000_000, windows: [{ usedPercent: 3 }] });
  });
});

describe('trailing own records (file ended after a token_usage_record — A2000 01a0819d-cfe2 / -a6f1)', () => {
  const TH = '01a0819d-cfe2-7ef0-8f65-12c21ee505e1';
  const OWN = '01a0819d-d01b-75c1-993c-c0c752866014';

  it('are emitted only once the file is idle (≥ 1 h), exactly once, and never double counted on resume', async () => {
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'guardian_review', parent_thread_id: '01a0819d-0000-7000-8000-000000000000' })
      .taskStarted(OWN, 1_788_264_000).turnContextNested(OWN, 'codex-auto-review', 'low').assistant()
      .record(TH, OWN, 'resp_1', [300, 100, 42])
      .tokenCount([300, 100, 42], [300, 100, 42]) // own first event → 342
      .record(TH, OWN, 'resp_2', [350, 300, 4]); // trailing → 354
    const file = path.join(home, 'sessions/2026/09/08', `rollout-2026-09-08T15-23-05-${TH}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, r.text());
    const mtime = statFile(file).mtimeMs;
    const store = new MemoryStore();
    const ctx = makeCtx(store, [home]);
    const billableOf = (): number => sessionBillable(store, TH);

    // live (30 min since the last write): the record is held for its token_count
    await new CodexCollector({ homes: [home], now: () => mtime + 30 * 60_000 }).scan(ctx);
    expect(billableOf()).toBe(342);
    // idle (2 h): the unchanged file is revisited only because it has pending records → +354
    const s2 = await new CodexCollector({ homes: [home], now: () => mtime + 2 * 3_600_000 }).scan(ctx);
    expect(s2.filesScanned).toBe(1);
    expect(billableOf()).toBe(696);
    const st = store.getState(file)!.extra as { pending: unknown[]; summary: { trailingRecords: number; trailingRecordTotal: number } };
    expect(st.pending).toEqual([]);
    expect(st.summary).toMatchObject({ trailingRecords: 1, trailingRecordTotal: 354 });
    // idle again, nothing pending → skipped, nothing added
    const s3 = await new CodexCollector({ homes: [home], now: () => mtime + 3 * 3_600_000 }).scan(ctx);
    expect(s3.filesScanned).toBe(0);
    expect(billableOf()).toBe(696);

    // the thread resumes: the counter now includes resp_2 (354) plus a new 510 → only 510 is added
    fs.appendFileSync(file, new Rollout(Date.UTC(2026, 8, 8, 17, 0, 0)).tokenCount([1_150, 700, 56], [500, 300, 10]).text());
    await new CodexCollector({ homes: [home], now: () => Date.now() - 60_000 }).scan(ctx);
    // 342 + 354 + 510 = 1,206 = the counter's final total_tokens
    expect(billableOf()).toBe(1_206);
  });
});

// Founder req. 2026-09-27. Every real/fixture effort value observed anywhere in this repo or on
// this Mac is 'low'/'medium'/'ultra'/'xhigh' (test/fixtures/codex/*.jsonl grep) — no 'none'/'minimal'
// sample exists to verify against (confirmed empty ~/.codex/sessions on this host this session), so
// the 'none'/'minimal' → false rows below implement the founder's literal spec but are UNVERIFIED
// against a real rollout; flagged in the delivery report too.
describe('detectCodexThinking (hand-computed; §15.5 founder amendment 2026-09-27)', () => {
  it.each([
    // [effort, reasoningTokens, expected]
    [undefined, 0, null], // never determinable — no effort recorded and no reasoning tokens
    [undefined, 42, true], // reasoning tokens alone are conclusive regardless of effort
    ['low', 0, true], // effort set (not none/minimal) → true even with 0 reasoning tokens this event
    ['medium', 0, true],
    ['ultra', 0, true],
    ['xhigh', 0, true],
    ['high', 500, true],
    ['none', 0, false], // UNVERIFIED against a real rollout (see file-header comment above)
    ['minimal', 0, false], // UNVERIFIED against a real rollout
    ['none', 5, true], // reasoning tokens > 0 wins even over an effort that would otherwise say false
    ['minimal', 5, true],
  ] as const)('effort=%s reasoningTokens=%s -> %s', (effort, reasoningTokens, expected) => {
    expect(detectCodexThinking(effort, reasoningTokens)).toBe(expected);
  });

  // MUTATION GUARD: a regression that dropped the reasoningTokens>0 check entirely (checking only
  // effort) would make this pass at `false` instead of `true` — reasoning tokens must win.
  it('reasoning tokens > 0 overrides an otherwise-false effort (mutation guard)', () => {
    expect(detectCodexThinking('minimal', 1)).not.toBe(false);
    expect(detectCodexThinking('minimal', 1)).toBe(true);
  });
});

describe('CodexCollector — unchanged inventory yields to the event loop', () => {
  // Fixture-scale setup, not a product latency budget: each file is only its session_meta header (the
  // full 60 KB fixture x 600 files made the first scan dominate and failed the default 5 s under host load).
  it('a second scan of an unchanged rollout inventory returns to the event loop between chunks', { timeout: 30_000 }, async () => {
    const FILES = 600;
    const SOURCE_ID = '01a08127-9a3d-7220-a867-0b45fa2e2dab';
    const header = fs.readFileSync(path.join(FIXTURES, 'root-reset-01a08127.jsonl'), 'utf8').split('\n')[0]!;
    for (let i = 0; i < FILES; i++) {
      const id = `01a08127-9a3d-7220-a867-${String(i).padStart(12, '0')}`;
      const rel = `sessions/2026/09/08/rollout-2026-09-08T07-14-11-${id}.jsonl`;
      fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
      fs.writeFileSync(path.join(home, rel), header.replaceAll(SOURCE_ID, id) + '\n');
    }
    const store = new MemoryStore();
    const collector = new CodexCollector({ homes: [home] });
    const first = await collector.scan(makeCtx(store)); // first scan ingests everything
    expect(first.filesScanned).toBe(FILES);

    // Second scan: every file is unchanged, so the loop is pure synchronous state reads. Without
    // yields this counter would stay at 0 until the scan returns.
    let spins = 0;
    let running = true;
    const spin = (): void => {
      if (!running) return;
      spins++;
      setImmediate(spin);
    };
    spin();
    const second = await collector.scan(makeCtx(store));
    running = false;
    expect(second.filesScanned).toBe(0); // unchanged files are skipped before any re-read is counted
    expect(second.bytesRead).toBe(0);
    expect(spins).toBeGreaterThanOrEqual(Math.floor(FILES / 200));
  });
});


describe('legacy response identity prefix recovery', () => {
  const prefix = () => {
    const sid = ID_RESET;
    const r = new Rollout().meta({ id: sid, thread_source: 'user' }).taskStarted('T-history')
      .turnContextFlat('T-history', 'gpt-6-sol', 'low').assistant();
    for (let i = 0; i < 4097; i++) r.record(sid, 'T-history', `prefix-${i}`, [10, 0, 1])
      .tokenCount([(i + 1) * 10, 0, i + 1], [10, 0, 1]);
    const p = new CodexRolloutParser(undefined, { host: 'test' });
    for (const line of r.lines) { p.pushLine(line); p.takeUsage(); p.takeMarks(); }
    const legacy = p.snapshotState(); delete legacy.responseIdsComplete; legacy.responseIds = legacy.responseIds.slice(-4096);
    return { r, legacy, offset: Buffer.byteLength(r.text()) };
  };
  it('reads the consumed prefix for exact identity, emits only appended new usage and preserves legacy diagnostics', async () => {
    const { r, legacy, offset } = prefix(), before = JSON.stringify(legacy);
    r.record(ID_RESET, 'T-history', 'prefix-0', [10, 0, 1]).tokenCount([40970, 0, 4097], [10, 0, 1])
      .record(ID_RESET, 'T-history', 'new-response', [17, 0, 2]).tokenCount([40987, 0, 4099], [17, 0, 2]);
    const file = path.join(home, 'owned-response-history.jsonl'); fs.writeFileSync(file, r.text());
    const batches: { offset: number; usage: number }[] = [];
    const result = await parseRolloutFile(file, { host: 'test', state: legacy, startOffset: offset,
      onBatch: b => { batches.push({ offset: b.offset, usage: b.usage.reduce((a, e) => a + e.components.reduce((s, c) => s + rawBillable(c.raw), 0), 0) }); } });
    expect(batches.reduce((a, b) => a + b.usage, 0)).toBe(19);
    expect(batches.every(b => b.offset >= offset)).toBe(true);
    expect(result.offset).toBe(Buffer.byteLength(r.text()));
    expect(result.bytesRead).toBe(Buffer.byteLength(r.text()));
    expect(result.state.responseIds).toHaveLength(4098);
    expect(result.state.responseIdHistoryRecoveredAtOffset).toBe(offset);
    expect(result.state.summary.records).toBe(4098);
    expect(result.state.summary.recordDuplicates).toBe(legacy.summary.recordDuplicates + 1);
    expect(JSON.stringify(legacy)).toBe(before);
  });
  it('does not call an offset/usage commit when the consumed prefix is incomplete', async () => {
    const { r, legacy, offset } = prefix(), before = JSON.stringify(legacy);
    const file = path.join(home, 'owned-truncated-history.jsonl'); fs.writeFileSync(file, r.text().slice(0, -1));
    let commits = 0;
    await expect(parseRolloutFile(file, { host: 'test', state: legacy, startOffset: offset, onBatch: () => { commits++; } }))
      .rejects.toThrow('complete readable consumed prefix');
    expect(commits).toBe(0); expect(JSON.stringify(legacy)).toBe(before);
  });
  it('holds a prefix that no longer contains a previously retained response identity', async () => {
    const { r, legacy, offset } = prefix(); legacy.responseIds[0] = 'retained-id-absent-from-prefix';
    const before = JSON.stringify(legacy), file = path.join(home, 'owned-mismatched-history.jsonl'); fs.writeFileSync(file, r.text());
    let commits = 0;
    await expect(parseRolloutFile(file, { host: 'test', state: legacy, startOffset: offset, onBatch: () => { commits++; } }))
      .rejects.toThrow('does not match the retained response IDs');
    expect(commits).toBe(0); expect(JSON.stringify(legacy)).toBe(before);
  });
});


describe('missing subagent turn time holds usage and offsets', () => {
  const created = Date.UTC(2026, 9, 10), realStart = created / 1000 + 7200, sid = ID_RESET, turn = 'T-held';
  function pending(records = false) {
    const r = new Rollout(created, 0).meta({ id: sid, source: { subagent: { other: 'guardian' } }, parent_thread_id: 'parent' })
      .tokenCount([100, 0, 10], [0, 0, 0]).turnContextFlat(turn, 'gpt-6-sol', 'none').assistant();
    if (records) r.record(sid, turn, 'held-response', [17, 0, 2]);
    else r.tokenCount([300, 0, 30], [200, 0, 20]);
    return r;
  }
  it('never commits an unresolved EOF, then emits once at the late completion time and resumes safely', async () => {
    const r = pending(), file = path.join(home, 'held-time.jsonl'); fs.writeFileSync(file, r.text()); let commits = 0;
    await expect(parseRolloutFile(file, { host: 'test', batchSize: 1, onBatch: () => { commits++; } })).rejects.toThrow('unread offset held');
    expect(commits).toBe(0);
    r.taskComplete(turn, realStart, realStart + 1, 1000); fs.writeFileSync(file, r.text());
    const result = await parseRolloutFile(file, { host: 'test', batchSize: 1 });
    expect(result.usage.map(u => [u.ts, u.tsSource, rawBillable(u.components[0]!.raw)])).toEqual([[realStart * 1000, 'turn', 220]]);
    const resumed = await parseRolloutFile(file, { host: 'test', state: JSON.parse(JSON.stringify(result.state)), startOffset: result.offset });
    expect(resumed.usage).toHaveLength(0);
  });
  it('collector restart preserves the unread position and reports a timestamp hold without publishing usage', async () => {
    const r = pending(), file = path.join(home, 'sessions', `rollout-2026-10-10T00-00-00-${sid}.jsonl`); fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, r.text());
    const store = new MemoryStore(); await new CodexCollector({ homes: [home], batchSize: 1 }).scan(makeCtx(store));
    expect(store.getState(file)).toBeUndefined(); expect(store.events.size).toBe(0); expect(store.skipped).toContainEqual({ path: file, reason: 'timestamp-unavailable' });
    r.taskComplete(turn, realStart, realStart + 1, 1000); fs.writeFileSync(file, r.text());
    await new CodexCollector({ homes: [home], batchSize: 1 }).scan(makeCtx(store));
    expect([...store.events.values()].map(e => [e.ts, e.tsSource, e.tokens.inputFresh, e.tokens.output])).toEqual([[realStart * 1000, 'turn', 200, 20]]);
    expect(store.getState(file)?.offset).toBe(Buffer.byteLength(r.text()));
    await new CodexCollector({ homes: [home], batchSize: 1 }).scan(makeCtx(store)); expect(store.events.size).toBe(1);
  });
  it('idle trailing records wait for their real turn time, including a completion before finalization', async () => {
    const r = pending(true), file = path.join(home, 'held-trailing-time.jsonl'); fs.writeFileSync(file, r.text());
    await expect(parseRolloutFile(file, { host: 'test', finalizeTrailingRecords: true })).rejects.toThrow('unread offset held');
    r.taskComplete(turn, realStart, realStart + 1, 1000); fs.writeFileSync(file, r.text());
    const result = await parseRolloutFile(file, { host: 'test', finalizeTrailingRecords: true });
    expect(result.usage.map(u => [u.ts, u.tsSource, rawBillable(u.components[0]!.raw)])).toEqual([[realStart * 1000, 'turn', 19]]);
  });
  it('reads beyond a full valid batch while another turn awaits timing, without releasing a frozen event', async () => {
    const r = pending(); r.turnContextFlat('T-known', 'gpt-6-sol', 'none').taskStarted('T-known', realStart + 10).assistant()
      .tokenCount([317, 0, 32], [17, 0, 2]).taskComplete(turn, realStart, realStart + 1, 1000);
    const file = path.join(home, 'held-batch-time.jsonl'); fs.writeFileSync(file, r.text()); const batches: number[][] = [];
    await parseRolloutFile(file, { host: 'test', batchSize: 1, onBatch: b => { batches.push(b.usage.map(u => u.ts)); } });
    expect(batches.flat().sort()).toEqual([realStart * 1000, (realStart + 10) * 1000]);
  });
});


describe('timestamp hold checkpoint and literal turn-key safety', () => {
  const created = Date.UTC(2026, 9, 10), start = created / 1000 + 7200, sid = ID_RESET, turn = 'T-late';
  it('a resumed timing hold leaves the caller checkpoint byte-for-byte unchanged, then emits once after timing arrives', async () => {
    const r = new Rollout(created, 0).meta({ id: sid, source: { subagent: { other: 'guardian' } } })
      .tokenCount([100, 0, 10], [0, 0, 0]).turnContextFlat(turn, 'gpt-6-sol', 'none').assistant();
    const file = path.join(home, 'resumed-time-hold.jsonl'); fs.writeFileSync(file, r.text()); const first = await parseRolloutFile(file, { host: 'test' });
    expect(first.usage).toHaveLength(0); const original = JSON.stringify(first.state); r.tokenCount([300, 0, 30], [200, 0, 20]); fs.writeFileSync(file, r.text()); let commits = 0;
    await expect(parseRolloutFile(file, { host: 'test', state: first.state, startOffset: first.offset, batchSize: 1, onBatch: () => { commits++; } })).rejects.toThrow('unread offset held');
    expect(commits).toBe(0); expect(JSON.stringify(first.state)).toBe(original);
    r.taskComplete(turn, start, start + 1, 1000); fs.writeFileSync(file, r.text());
    const recovered = await parseRolloutFile(file, { host: 'test', state: first.state, startOffset: first.offset });
    expect(recovered.usage.map(u => [u.ts, u.tsSource, rawBillable(u.components[0]!.raw)])).toEqual([[start * 1000, 'turn', 220]]);
    expect(JSON.stringify(first.state)).toBe(original);
  });
  it('JSON checkpoint retains the completed turn time needed by a record finalized only after the file becomes idle', async () => {
    const r = new Rollout(created, 0).meta({ id: sid, source: { subagent: { other: 'guardian' } } })
      .tokenCount([100, 0, 10], [0, 0, 0]).turnContextFlat(turn, 'gpt-6-sol', 'none').assistant()
      .record(sid, turn, 'pending-idle-response', [17, 0, 2]).taskComplete(turn, start, start + 1, 1000);
    const file = path.join(home, 'idle-time-checkpoint.jsonl'); fs.writeFileSync(file, r.text()); const active = await parseRolloutFile(file, { host: 'test' });
    expect(active.usage).toHaveLength(0); expect(active.state.pending).toHaveLength(1);
    const idle = await parseRolloutFile(file, { host: 'test', state: JSON.parse(JSON.stringify(active.state)), startOffset: active.offset, finalizeTrailingRecords: true });
    expect(idle.usage.map(u => [u.ts, u.tsSource, rawBillable(u.components[0]!.raw)])).toEqual([[start * 1000, 'turn', 19]]);
  });
  it('a literal __proto__ turn ID retains its own verified time without changing an object prototype', async () => {
    const r = new Rollout(created, 0).meta({ id: sid, source: { subagent: { other: 'guardian' } } })
      .taskStarted('__proto__', start).turnContextFlat('__proto__', 'gpt-6-sol', 'none').assistant().tokenCount([17, 0, 2], [17, 0, 2]);
    const file = path.join(home, 'literal-turn-time.jsonl'); fs.writeFileSync(file, r.text()); const result = await parseRolloutFile(file, { host: 'test' });
    expect(result.usage.map(u => [u.ts, u.tsSource])).toEqual([[start * 1000, 'turn']]);
    expect(Object.getPrototypeOf(result.state.inFileTurnTimesS)).toBe(Object.prototype);
    expect(Object.hasOwn(result.state.inFileTurnTimesS!, '__proto__')).toBe(true);
    const restored = JSON.parse(JSON.stringify(result.state)); expect(restored.inFileTurnTimesS.__proto__).toBe(start);
  });
});


describe('root timestamp fallback and missing timestamp evidence', () => {
  const created = Date.UTC(2026, 9, 10), start = created / 1000 + 7200, sid = ID_RESET;
  it('root counter usage prefers a verified turn time and uses line time only when no turn or record timing exists', async () => {
    for (const verified of [false, true]) {
      const r = new Rollout(created, 0).meta({ id: sid, source: 'cli' }).turnContextFlat('T-root', 'gpt-6-sol', 'none');
      if (verified) r.taskStarted('T-root', start);
      r.assistant().tokenCount([17, 0, 2], [17, 0, 2]);
      const file = path.join(home, `root-time-${verified}.jsonl`); fs.writeFileSync(file, r.text()); const result = await parseRolloutFile(file, { host: 'test' });
      expect(result.usage.map(u => [u.ts, u.tsSource, rawBillable(u.components[0]!.raw)])).toEqual([[verified ? start * 1000 : created, verified ? 'turn' : 'line', 19]]);
    }
  });
  it('missing root line, record and turn time holds usage instead of inventing a creation or zero timestamp', async () => {
    const r = new Rollout(created, 0).meta({ id: sid, source: 'cli' }).turnContextFlat('T-missing', 'gpt-6-sol', 'none').assistant().tokenCount([17, 0, 2], [17, 0, 2]);
    const text = r.lines.map(line => { const row = JSON.parse(line); delete row.timestamp; return JSON.stringify(row); }).join('\n')+'\n';
    const file = path.join(home, 'root-without-time.jsonl'); fs.writeFileSync(file, text); let commits = 0;
    await expect(parseRolloutFile(file, { host: 'test', onBatch: () => { commits++; } })).rejects.toThrow('unread offset held'); expect(commits).toBe(0);
  });
});


describe('legacy checkpoint recovers verified turn clocks without replaying historical accounting', () => {
  const created = Date.UTC(2026, 9, 10), start = created / 1000 + 7200, sid = ID_RESET, turn = 'T-legacy-clock';
  async function legacy() {
    const r = new Rollout(created, 0).meta({ id: sid, source: { subagent: { other: 'guardian' } } })
      .tokenCount([100, 0, 10], [0, 0, 0]).turnContextFlat(turn, 'gpt-6-sol', 'none').assistant()
      .tokenCount([200, 0, 20], [100, 0, 10]).taskComplete(turn, start, start + 1, 1000);
    const file = path.join(home, 'legacy-turn-clock.jsonl'); fs.writeFileSync(file, r.text()); const parsed = await parseRolloutFile(file, { host: 'test' });
    const saved = JSON.parse(JSON.stringify(parsed.state)) as CodexFileState; delete saved.inFileTurnTimesS; delete saved.turnStartedAtS;
    expect(saved.responseIdsComplete).toBe(true); return { r, file, saved, offset: parsed.offset };
  }
  it('restores only clocks from an already consumed prefix and emits the appended 19 tokens once at the known turn time', async () => {
    const { r, file, saved, offset } = await legacy(), original = JSON.stringify(saved);
    r.tokenCount([217, 0, 22], [17, 0, 2]); fs.writeFileSync(file, r.text());
    const batches: { offset: number; billable: number }[] = [];
    const result = await parseRolloutFile(file, { host: 'test', state: saved, startOffset: offset,
      onBatch: b => { batches.push({ offset: b.offset, billable: b.usage.reduce((sum,u) => sum + u.components.reduce((a,c) => a + rawBillable(c.raw),0),0) }); expect(b.usage.every(u => u.tsSource === 'turn' && u.ts === start * 1000)).toBe(true); } });
    expect(batches.reduce((sum,b) => sum + b.billable,0)).toBe(19); expect(batches.every(b => b.offset >= offset)).toBe(true);
    expect(result.state.summary.ownBillableEmitted).toBe(saved.summary.ownBillableEmitted + 19);
    expect(result.state.inFileTurnTimesS?.[turn]).toBe(start); expect(result.bytesRead).toBe(Buffer.byteLength(r.text()));
    expect(JSON.stringify(saved)).toBe(original);
  });
  it('refuses a truncated clock prefix without committing usage, offset or mutating the saved state', async () => {
    const { r, file, saved, offset } = await legacy(), original = JSON.stringify(saved); fs.writeFileSync(file, r.text().slice(0,-1)); let commits=0;
    await expect(parseRolloutFile(file, { host: 'test', state: saved, startOffset: offset, onBatch: () => { commits++; } })).rejects.toThrow('complete readable consumed prefix');
    expect(commits).toBe(0); expect(JSON.stringify(saved)).toBe(original);
  });
});
