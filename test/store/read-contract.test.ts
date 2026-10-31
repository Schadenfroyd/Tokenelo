/**
 * Read contract for a future paged read path. Two questions, each answered by SQLite behaviour rather than by assumption:
 *
 *  1. Tie order. Current read queries order by `ts ASC` with no tiebreaker. For equal timestamps, the order is whatever
 *     the chosen plan yields. A proposed keyset must reproduce it exactly, or wire output can change. This file pins the
 *     range-query order the plan actually uses, and shows that a (ts, id) keyset does NOT reproduce it.
 *  2. Snapshot. A paged read that yields between pages needs one consistent snapshot. Under WAL on a file database, a
 *     reader inside an explicit read transaction (including one still iterating a statement) must not see a writer's
 *     commits until it ends. A :memory: database has no second connection at all, so it cannot host this design.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncClass } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, openLedgerReadOnly, type TokeneloDb } from '../../src/store/db.js';

// Vitest's resolver does not load 'node:sqlite' as a static import (same pattern as test/codex/collector.test.ts).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncClass };

function insertEvent(db: TokeneloDb, id: string, ts: number): void {
  db.prepare(
    `INSERT INTO events (id, host, source, ts, ts_source, session_id, model, provider, engine, components_json,
                         price_status, price_version, ucu_rate_status, eacs_def_sha256, input_fresh, output)
     VALUES (?, 'H', 'claude', ?, 'line', 's', 'm', 'anthropic', NULL, '[]', 'ok', 'v', 'ok', 'h', 1, 1)`
  ).run(id, ts);
}

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('tie order of the production-shaped range read', () => {
  // Insertion order with reverse-lexical ids: z, a, m, b at ts 1000, then c at ts 2000.
  function seed(): TokeneloDb {
    const db = openDb({ file: ':memory:' });
    insertEvent(db, 'z-1', 1000);
    insertEvent(db, 'a-2', 1000);
    insertEvent(db, 'm-3', 1000);
    insertEvent(db, 'b-4', 1000);
    insertEvent(db, 'c-5', 2000);
    return db;
  }

  it('the range query uses idx_events_ts, so equal timestamps come back in rowid (insertion) order', () => {
    const db = seed();
    const sql = 'SELECT id FROM events WHERE ts >= ? ORDER BY ts ASC';
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(0) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    expect(plan).toContain('idx_projection_ts');
    const ids = (db.prepare(sql).all(0) as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['z-1', 'a-2', 'm-3', 'b-4', 'c-5']);
    db.close();
  });

  it('a keyset on (ts, rowid), paged two rows at a time, reproduces the unpaged order exactly', () => {
    const db = seed();
    const unpaged = (db.prepare('SELECT id FROM events WHERE ts >= ? ORDER BY ts ASC').all(0) as Array<{ id: string }>).map((r) => r.id);
    const paged: string[] = [];
    let after: [number, number] = [-Infinity, -Infinity];
    for (;;) {
      const page = db
        .prepare('SELECT rowid AS r, ts, id FROM events WHERE (ts, rowid) > (?, ?) ORDER BY ts, rowid LIMIT 2')
        .all(after[0], after[1]) as Array<{ r: number; ts: number; id: string }>;
      if (page.length === 0) break;
      for (const row of page) paged.push(row.id);
      const last = page[page.length - 1]!;
      after = [last.ts, last.r];
    }
    expect(paged).toEqual(unpaged);
    db.close();
  });

  it('a keyset on (ts, id) with text ids does NOT reproduce the production order for equal timestamps', () => {
    const db = seed();
    const unpaged = (db.prepare('SELECT id FROM events WHERE ts >= ? ORDER BY ts ASC').all(0) as Array<{ id: string }>).map((r) => r.id);
    const lexical = (db.prepare('SELECT id FROM events WHERE ts >= ? ORDER BY ts, id').all(0) as Array<{ id: string }>).map((r) => r.id);
    expect(lexical).toEqual(['a-2', 'b-4', 'm-3', 'z-1', 'c-5']);
    expect(lexical).not.toEqual(unpaged); // changing the tiebreak would change wire order
    db.close();
  });

  it('activity ids are INTEGER PRIMARY KEY, so (ts, id) and (ts, rowid) are the same order', () => {
    const db = openDb({ file: ':memory:' });
    const ins = db.prepare(
      "INSERT INTO activity (source, session_id, ts, uuid, host, kind) VALUES ('claude', 's', ?, ?, 'H', 'user')"
    );
    ins.run(1000, 'u-z');
    ins.run(1000, 'u-a');
    ins.run(1000, 'u-m');
    const byRowid = (db.prepare('SELECT uuid FROM activity WHERE ts >= ? ORDER BY ts ASC').all(0) as Array<{ uuid: string }>).map((r) => r.uuid);
    const byId = (db.prepare('SELECT uuid FROM activity WHERE ts >= ? ORDER BY ts ASC, id ASC').all(0) as Array<{ uuid: string }>).map((r) => r.uuid);
    expect(byRowid).toEqual(['u-z', 'u-a', 'u-m']);
    expect(byId).toEqual(byRowid);
    db.close();
  });
});

describe('snapshot across yields (file database, WAL)', () => {
  it('a reader inside a read transaction keeps its snapshot while a writer commits between pages', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-snapshot-'));
    const file = path.join(tmp, 'ledger.db');
    const writer = openDb({ file });
    for (let i = 0; i < 100; i++) insertEvent(writer, `old-${String(i).padStart(3, '0')}`, 1000 + i);

    const reader = openLedgerReadOnly(file);
    try {
      reader.exec('BEGIN');
      const count = (): number => (reader.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
      expect(count()).toBe(100);

      // Paged read across yields: take 10, let the writer commit 50 earlier-timestamp rows, then finish the page stream.
      const seen: string[] = [];
      const stream = reader.prepare('SELECT id FROM events ORDER BY ts, rowid').iterate() as Iterable<{ id: string }>;
      const it = stream[Symbol.iterator]();
      for (let i = 0; i < 10; i++) seen.push((it.next().value as { id: string }).id);
      await new Promise((resolve) => setImmediate(resolve));
      for (let i = 0; i < 50; i++) insertEvent(writer, `new-${String(i).padStart(3, '0')}`, 1);
      for (let next = it.next(); !next.done; next = it.next()) seen.push((next.value as { id: string }).id);

      expect(seen).toHaveLength(100);
      expect(seen.every((id) => id.startsWith('old-'))).toBe(true);
      expect(count()).toBe(100); // still the snapshot inside the transaction
      reader.exec('COMMIT');

      // A new read after the transaction sees the writer's commits.
      expect(count()).toBe(150);
    } finally {
      reader.close();
      writer.close();
    }
  });
});
