/**
 * withTransaction's profiling spans. A busy_timeout wait for another connection's write lock is a synchronous sleep on the
 * event loop, so it must land in `db.begin_immediate`, not be hidden in the caller's span. Real file-backed connections;
 * the wait is SQLite's own busy handler, so only a lower bound on its duration is asserted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProfiler, setActiveProfiler, stopProfiler, type ProfileSink } from '../../src/core/phase-profile.js';
import { openDb, transactionDepth, withTransaction, type TokeneloDb } from '../../src/store/db.js';

type Phases = Record<string, { count: number; totalMs: number; maxMs: number }>;

function activeMemoryProfiler(): { phases(): Phases } {
  const lines: Array<Record<string, unknown>> = [];
  const sink: ProfileSink = { write: (l) => lines.push(JSON.parse(JSON.stringify(l))), flush: () => {} };
  const p = createProfiler({ sink, windowStartMs: 0 });
  setActiveProfiler(p);
  return {
    phases() {
      p.flushStats(p.now());
      return lines.filter((l) => l.type === 'stats').at(-1)!.phases as Phases;
    },
  };
}

describe('withTransaction profiling spans', () => {
  let tmpDir: string | undefined;
  const open: TokeneloDb[] = [];

  afterEach(() => {
    stopProfiler();
    for (const db of open.splice(0)) db.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('records a busy wait for another writer as db.begin_immediate and leaves no transaction open', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-db-profile-'));
    const file = path.join(tmpDir, 'tokenelo.db');
    const busyTimeoutMs = 200;
    const writer = openDb({ file, busyTimeoutMs }); // migrates first, before the other connection holds the lock
    open.push(writer);
    writer.exec('CREATE TABLE t (x INTEGER)');
    const other = openDb({ file, migrate: false });
    open.push(other);
    other.exec('BEGIN IMMEDIATE'); // holds the write lock

    const profile = activeMemoryProfiler();
    expect(() => withTransaction(writer, () => writer.prepare('INSERT INTO t (x) VALUES (1)').run())).toThrow();
    const phases = profile.phases();

    expect(phases['db.begin_immediate']?.count).toBe(1);
    // SQLite's busy handler sleeps until about busyTimeoutMs before it gives up; allow scheduler slack below it.
    expect(phases['db.begin_immediate']!.maxMs).toBeGreaterThanOrEqual(busyTimeoutMs * 0.75);
    expect(phases['db.commit']).toBeUndefined();
    expect(transactionDepth(writer)).toBe(0);

    other.exec('COMMIT');
    withTransaction(writer, () => writer.prepare('INSERT INTO t (x) VALUES (2)').run());
    expect((writer.prepare('SELECT x FROM t').all() as Array<{ x: number }>).map((r) => r.x)).toEqual([2]);
  });

  it('times only the outermost BEGIN and COMMIT, not nested savepoints', () => {
    const db = openDb({ file: ':memory:' });
    open.push(db);
    db.exec('CREATE TABLE t (x INTEGER)');
    const profile = activeMemoryProfiler();
    withTransaction(db, () => {
      db.prepare('INSERT INTO t (x) VALUES (1)').run();
      withTransaction(db, () => db.prepare('INSERT INTO t (x) VALUES (2)').run());
    });
    const phases = profile.phases();

    expect(phases['db.begin_immediate']?.count).toBe(1);
    expect(phases['db.commit']?.count).toBe(1);
    expect((db.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(2);
  });

  it('commits and leaves no transaction open when no profiler is active', () => {
    const db = openDb({ file: ':memory:' });
    open.push(db);
    db.exec('CREATE TABLE t (x INTEGER)');
    setActiveProfiler(null);
    withTransaction(db, () => db.prepare('INSERT INTO t (x) VALUES (1)').run());
    expect((db.prepare('SELECT count(*) AS c FROM t').get() as { c: number }).c).toBe(1);
    expect(transactionDepth(db)).toBe(0);
  });
});
