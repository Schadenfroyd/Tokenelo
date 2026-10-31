/**
 * Summary and Sessions on the snapshot path (request snapshot connection, keyset pages, yields) must return exactly what
 * the synchronous path returns, and a commit that lands while a Summary is paused between pages must not change it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries, type CreateQueriesOpts } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { TokeneloConfig } from '../../src/core/types.js';
import { createProfiler, setActiveProfiler, stopProfiler, type ProfileSink } from '../../src/core/phase-profile.js';

const NOW = 1_700_000_000_000;
const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function seedEvent(db: TokeneloDb, id: string, ts: number, sessionId: string, provider: string, usd: number): void {
  db.prepare(
    `INSERT INTO events (id, host, source, ts, ts_source, session_id, is_subagent, model, provider, components_json,
                         input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, flags_json,
                         api_equiv_usd, price_status, price_version, ucu_rate_status, eacs_def_sha256, thinking)
     VALUES (?, 'M4a', 'claude', ?, 'line', ?, 0, 'claude-sonnet-5', ?, '[]', 100, 0, 0, 0, 50, 0, '[]',
             ?, 'LIST', 'test-price-v1', 'MEASURED', 'test-def-sha', NULL)`
  ).run(id, ts, sessionId, provider, usd);
}

function seedActivity(db: TokeneloDb, uuid: string, ts: number, sessionId: string): void {
  db.prepare("INSERT INTO activity (source, session_id, ts, uuid, host, kind) VALUES ('claude', ?, ?, ?, 'M4a', 'user')").run(sessionId, ts, uuid);
}

/** 24 events over three sessions, with runs of equal timestamps and a local-provider subset; activity alongside. */
function seed(db: TokeneloDb): void {
  for (let i = 0; i < 24; i++) {
    const ts = NOW - 3_600_000 + Math.floor(i / 4) * 60_000; // groups of four share a timestamp
    const session = `s-${i % 3}`;
    const provider = i % 5 === 0 ? 'local' : 'anthropic';
    seedEvent(db, `ev-${String(i).padStart(3, '0')}`, ts, session, provider, 0.25 + i * 0.01);
    seedActivity(db, `act-${String(i).padStart(3, '0')}`, ts + 1000, session);
  }
}

function config(): TokeneloConfig {
  return defaultConfig({ hostLabel: 'M4a' });
}

describe('Summary and Sessions on the snapshot path', () => {
  it('match the synchronous path exactly, with pages that split equal-timestamp runs', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-qsnap-'));
    const file = path.join(tmp, 'ledger.db');
    const db = openDb({ file });
    seed(db);
    try {
      const sync = createQueries(db, config(), { now: () => NOW, probeOllama: stubProbe });
      const snap = createQueries(db, config(), {
        now: () => NOW,
        probeOllama: stubProbe,
        readSnapshotFile: file,
        pageRows: 3,
        yieldNow: async () => {},
      });
      expect(await snap.getSummary('all')).toEqual(await sync.getSummary('all'));
      expect(await snap.getSessions({ range: 'all', activeOnly: false })).toEqual(
        await sync.getSessions({ range: 'all', activeOnly: false })
      );
      expect((await snap.getSessions({ range: 'all', activeOnly: false })).sessions.length).toBe(3);
    } finally {
      db.close();
    }
  });

  it('a commit that lands while Summary is paused between pages is not in that Summary', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-qsnap-'));
    const file = path.join(tmp, 'ledger.db');
    const db = openDb({ file });
    seed(db);
    try {
      const baseline = await createQueries(db, config(), { now: () => NOW, probeOllama: stubProbe }).getSummary('all');

      let wrote = false;
      const snap = createQueries(db, config(), {
        now: () => NOW,
        probeOllama: stubProbe,
        readSnapshotFile: file,
        pageRows: 3,
        yieldNow: async () => {
          if (wrote) return;
          wrote = true;
          // The daemon's own writable connection commits while the request is paused: 40 more events, one dollar each,
          // with activity marks in a new session. The marks change agentMs, so a read that sees them is visible in the response.
          for (let i = 0; i < 40; i++) {
            seedEvent(db, `late-${i}`, NOW - 1000, 's-late', 'anthropic', 1);
            seedActivity(db, `late-act-${i}`, NOW - 1000 + i * 30_000, 's-late');
          }
        },
      });
      const during = await snap.getSummary('all');
      expect(wrote).toBe(true);
      expect(during).toEqual(baseline);
      expect(during.totals.events).toBe(24);

      // The next request sees the commit.
      const after = await createQueries(db, config(), { now: () => NOW, probeOllama: stubProbe }).getSummary('all');
      expect(after.totals.events).toBe(64);
    } finally {
      db.close();
    }
  });

  it('no page, map or session-build step on the snapshot path spans an event-loop turn', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-qsnap-'));
    const file = path.join(tmp, 'ledger.db');
    const db = openDb({ file });
    // One event per session, so the build has one step per session and the pacer must pause several times.
    db.exec('BEGIN');
    for (let i = 0; i < 400; i++) seedEvent(db, `t-${i}`, NOW - 1000 - i, `ts-${i}`, 'anthropic', 0.1);
    db.exec('COMMIT');

    // Profiler clock = event-loop turns: a span open across any macrotask boundary gets a duration above zero.
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
      const q = createQueries(db, config(), { now: () => NOW, probeOllama: stubProbe, readSnapshotFile: file, pageRows: 100 });
      const res = await q.getSessions({ range: 'all', activeOnly: false });
      expect(res.sessions).toHaveLength(400);
      profiler.flushStats(turn);
      const phases = profile.find((l) => l.type === 'stats')!.phases as Record<string, { count: number; maxMs: number }>;
      expect(phases['query.build_sessions']!.count).toBeGreaterThanOrEqual(2);
      expect(phases['query.build_sessions']!.maxMs).toBe(0);
      expect(phases['query.page']!.maxMs).toBe(0);
      expect(phases['query.map']!.maxMs).toBe(0);
    } finally {
      running = false;
      stopProfiler();
      db.close();
    }
  });
});
