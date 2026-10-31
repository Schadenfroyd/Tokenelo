/**
 * The ingest-cursor and skip statements (getState, setState, recordSkipped) are prepared once per SqliteLedger, on first
 * use, and reused. Counted on the real node:sqlite `db.prepare`, matched by the leading SQL text of each statement.
 *
 * The prepare count must not depend on call count, file count or scan count, and it must not be shared across ledgers.
 * Cursor values, skip counts and closed or read-only connection errors must stay what an uncached ledger produces.
 * No timing claim is made here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import type { IngestState } from '../../src/core/types.js';
import { openDb, openLedgerReadOnly, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { baseTestConfig, makeHarness, type TestHarness } from '../claude/helpers.js';
import { StubValuationEngine, StubPricingEngine } from './stubs.js';

type CursorSql = 'getState' | 'setState' | 'recordSkipped';
type PrepareCounts = Record<CursorSql, number>;

const NTFS_INO = 9851624185066820n;

function classify(sql: string): CursorSql | undefined {
  if (sql.startsWith('SELECT key, size, mtime_ms, offset, ino, extra_json FROM ingest_state WHERE key = ?')) return 'getState';
  if (sql.startsWith('INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json)')) return 'setState';
  if (sql.startsWith('INSERT INTO skipped (path, reason, count, last_seen)')) return 'recordSkipped';
  return undefined;
}

/** Wraps this connection's native prepare and counts calls per cursor statement. Other SQL passes through uncounted. */
function countPrepares(db: TokeneloDb): PrepareCounts {
  const counts: PrepareCounts = { getState: 0, setState: 0, recordSkipped: 0 };
  const nativePrepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const kind = classify(sql);
    if (kind) counts[kind]++;
    return nativePrepare(sql);
  };
  return counts;
}

const newLedger = (db: TokeneloDb): SqliteLedger => new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());

/** Arbitrary keys and values, including absent optional fields, fractional times, zero, and non-object extras. */
const STATES: IngestState[] = [
  { key: '/plain/a.jsonl', size: 10, mtimeMs: 1_712_345_678_901.5, offset: 10 },
  { key: '/zero', size: 0, mtimeMs: 0, offset: 0, ino: 0 },
  { key: 'codex-sqlite:C:\\Users\\x\\state_5.sqlite', size: 4096, mtimeMs: 1, offset: 2048, ino: 12345, extra: { prevTotals: { input: 7, output: [1, 2] } } },
  { key: 'naïve 路径 with spaces.jsonl', size: Number.MAX_SAFE_INTEGER, mtimeMs: 2.25, offset: Number.MAX_SAFE_INTEGER, ino: 844424930325829 },
  { key: 'k'.repeat(2000), size: 3, mtimeMs: 3, offset: 1, extra: null },
  { key: '/extra/zero', size: 1, mtimeMs: 1, offset: 1, extra: 0 },
  { key: '/extra/empty-string', size: 1, mtimeMs: 1, offset: 1, extra: '' },
];

describe('SqliteLedger cursor statements: prepared once per ledger, on first use', () => {
  const dbs: TokeneloDb[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  });
  const open = (): TokeneloDb => {
    const db = openDb({ file: ':memory:' });
    dbs.push(db);
    return db;
  };

  it('prepares nothing at construction, then once per statement across hundreds of calls, per independent ledger', () => {
    const dbA = open();
    const dbB = open();
    const countsA = countPrepares(dbA);
    const countsB = countPrepares(dbB);
    const ledgerA = newLedger(dbA);
    const ledgerB = newLedger(dbB);
    expect(countsA).toEqual({ getState: 0, setState: 0, recordSkipped: 0 });

    for (let round = 0; round < 100; round++) {
      for (const [ledger, tag] of [[ledgerA, 'a'], [ledgerB, 'b']] as const) {
        const key = `/${tag}/file-${round % 10}.jsonl`;
        ledger.getState(key);
        ledger.setState({ key, size: round, mtimeMs: round + 0.5, offset: round, ino: round });
        ledger.recordSkipped(key, 'not-whitelisted');
      }
    }
    expect(countsA).toEqual({ getState: 1, setState: 1, recordSkipped: 1 });
    expect(countsB).toEqual({ getState: 1, setState: 1, recordSkipped: 1 });

    // Data still correct after reuse: last write wins per key, skip counts accumulate per (path, reason).
    expect(ledgerA.getState('/a/file-9.jsonl')).toEqual({ key: '/a/file-9.jsonl', size: 99, mtimeMs: 99.5, offset: 99, ino: 99 });
    expect(ledgerB.getState('/b/file-0.jsonl')).toEqual({ key: '/b/file-0.jsonl', size: 90, mtimeMs: 90.5, offset: 90, ino: 90 });
    expect(ledgerA.getState('/b/file-0.jsonl')).toBeUndefined();
    const skipped = dbA.prepare('SELECT path, count FROM skipped ORDER BY path').all() as Array<{ path: string; count: number }>;
    expect(skipped).toHaveLength(10);
    expect(skipped.every((r) => r.count === 10)).toBe(true);

    // A second ledger on the same connection prepares its own statements: the cache is per ledger, not global.
    const ledgerA2 = newLedger(dbA);
    expect(ledgerA2.getState('/a/file-9.jsonl')?.offset).toBe(99);
    ledgerA2.setState({ key: '/a/second', size: 1, mtimeMs: 1, offset: 1 });
    ledgerA2.recordSkipped('/a/second', 'other');
    expect(countsA).toEqual({ getState: 2, setState: 2, recordSkipped: 2 });
    expect(ledgerA.getState('/a/second')).toEqual(ledgerA2.getState('/a/second'));
  });

  it('a reused ledger returns exactly what a fresh, never-reused ledger returns, over arbitrary keys and legacy rows', () => {
    const db = open();
    const reused = newLedger(db);
    const fresh = (): SqliteLedger => newLedger(db); // a new ledger per read: always a freshly prepared statement
    // Legacy raw NTFS ino written by an older build, read through the cached BigInt statement.
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json) VALUES ('legacy', 10, 5.5, 7, ?, '{"a":1}')`).run(NTFS_INO);

    for (let pass = 0; pass < 3; pass++) {
      for (const s of STATES) {
        const written = { ...s, offset: s.offset === Number.MAX_SAFE_INTEGER ? s.offset : Math.min(s.size, s.offset + pass) };
        reused.setState(written);
        expect(reused.getState(s.key)).toStrictEqual(fresh().getState(s.key));
      }
      expect(reused.getState('legacy')).toStrictEqual(fresh().getState('legacy'));
      expect(reused.getState('missing')).toBeUndefined();
    }
    // Hand-checked values through the reused statement.
    expect(reused.getState('legacy')?.ino).toBe(844424930325829);
    expect(reused.getState(STATES[3]!.key)?.ino).toBe(844424930325829);
    expect(reused.getState('/extra/zero')?.extra).toBe(0);
    expect(reused.getState('/extra/empty-string')?.extra).toBe('');
    expect(reused.getState('k'.repeat(2000))?.extra).toBeNull();
    expect(reused.getState('/plain/a.jsonl')?.mtimeMs).toBe(1_712_345_678_901.5);
  });

  it('a RangeError from an out-of-range legacy size leaves the reused statement usable', () => {
    const db = open();
    const counts = countPrepares(db);
    const ledger = newLedger(db);
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino) VALUES ('huge', ?, 1, 1, NULL)`).run(2n ** 60n);
    ledger.setState({ key: 'ok', size: 5, mtimeMs: 5, offset: 5 });
    expect(() => ledger.getState('huge')).toThrow(RangeError);
    expect(ledger.getState('ok')).toEqual({ key: 'ok', size: 5, mtimeMs: 5, offset: 5 });
    expect(() => ledger.getState('huge')).toThrow(RangeError);
    expect(counts.getState).toBe(1);
  });

  it('rejects an unsafe in-memory inode without replacing a valid cursor, while legacy raw NTFS inodes still normalize', () => {
    const db = open();
    const ledger = newLedger(db);
    const valid: IngestState = { key: 'current', size: 10, mtimeMs: 5.5, offset: 7, ino: 844424930325829 };
    ledger.setState(valid);

    expect(() => ledger.setState({ ...valid, ino: Number(NTFS_INO) })).toThrow(RangeError);
    expect(() => ledger.setState({ ...valid, offset: valid.size + 1 })).toThrow(RangeError);
    expect(() => ledger.setState({ ...valid, key: '' })).toThrow(RangeError);
    expect(ledger.getState('current')).toEqual({ ...valid, extra: undefined });

    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json)
      VALUES ('legacy-ntfs', 10, 5.5, 7, ?, NULL)`).run(NTFS_INO);
    expect(ledger.getState('legacy-ntfs')).toEqual({
      key: 'legacy-ntfs', size: 10, mtimeMs: 5.5, offset: 7, ino: 844424930325829, extra: undefined,
    });
  });

  it('after close, a ledger that cached its statements throws the same error as one that never prepared them', () => {
    const db = open();
    const used = newLedger(db);
    used.getState('k');
    used.setState({ key: 'k', size: 1, mtimeMs: 1, offset: 1 });
    used.recordSkipped('k', 'other');
    const unused = newLedger(db);
    db.close();

    const errorOf = (fn: () => unknown): { name: string; code: unknown; message: string } => {
      try {
        fn();
      } catch (err) {
        const e = err as Error & { code?: unknown };
        return { name: e.name, code: e.code, message: e.message };
      }
      throw new Error('expected a throw');
    };
    for (const call of [
      (l: SqliteLedger) => l.getState('k'),
      (l: SqliteLedger) => l.setState({ key: 'k', size: 2, mtimeMs: 2, offset: 2 }),
      (l: SqliteLedger) => l.recordSkipped('k', 'other'),
    ]) {
      expect(errorOf(() => call(used))).toEqual(errorOf(() => call(unused)));
    }
  });

  it('on a read-only connection, reads reuse one statement and every write fails the same way without breaking reads', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cursor-ro-'));
    const file = path.join(dir, 'ledger.sqlite');
    try {
      const writerDb = openDb({ file });
      newLedger(writerDb).setState({ key: '/ro/a', size: 4, mtimeMs: 4.5, offset: 4, ino: 9, extra: { x: 1 } });
      writerDb.close();

      const roDb = openLedgerReadOnly(file);
      try {
        const counts = countPrepares(roDb);
        const ledger = newLedger(roDb);
        const messages: string[] = [];
        for (let i = 0; i < 3; i++) {
          expect(ledger.getState('/ro/a')).toEqual({ key: '/ro/a', size: 4, mtimeMs: 4.5, offset: 4, ino: 9, extra: { x: 1 } });
          try {
            ledger.setState({ key: '/ro/a', size: 5, mtimeMs: 5, offset: 5 });
            messages.push('no error');
          } catch (err) {
            messages.push((err as Error).message);
          }
        }
        expect(messages[0]).toMatch(/readonly/i);
        expect(new Set(messages).size).toBe(1);
        expect(counts.getState).toBe(1);
        expect(counts.setState).toBe(1);
      } finally {
        roDb.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ClaudeCollector over N files, scanned twice: cursor prepares do not grow with N or scan count', () => {
  let h: TestHarness | undefined;
  const roots: string[] = [];
  afterEach(() => {
    h?.close();
    h = undefined;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** N whitelisted session files with one assistant line each, plus N non-whitelisted files that are skipped every scan. */
  function makeRoot(n: number): { root: string; files: { path: string; bytes: number }[] } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cursor-reuse-'));
    roots.push(root);
    const projDir = path.join(root, '-fixture-reuse');
    fs.mkdirSync(projDir, { recursive: true });
    const files: { path: string; bytes: number }[] = [];
    for (let i = 0; i < n; i++) {
      const sessionId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`;
      const body =
        JSON.stringify({
          type: 'assistant', uuid: `r-${i}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/reuse',
          message: { id: `reuse-${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 1 + i, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: i } },
        }) + '\n';
      const filePath = path.join(projDir, `${sessionId}.jsonl`);
      fs.writeFileSync(filePath, body);
      files.push({ path: filePath, bytes: Buffer.byteLength(body) });
      fs.writeFileSync(path.join(projDir, `notes-${i}.jsonl`), '{}\n');
    }
    return { root, files };
  }

  function fingerprint(t: TestHarness): string {
    const events = t.db.prepare('SELECT * FROM events ORDER BY id').all();
    const activity = t.db.prepare('SELECT source, session_id, ts, uuid, host, project, kind, duration_ms FROM activity ORDER BY uuid').all();
    const cursors = t.db.prepare('SELECT key, size, offset, ino, extra_json FROM ingest_state ORDER BY key').all();
    return crypto.createHash('sha256').update(JSON.stringify({ events, activity, cursors })).digest('hex');
  }

  for (const n of [1, 50]) {
    it(`N=${n}: one prepare per cursor statement, with events, cursors and skips correct`, { timeout: 30_000 }, async () => {
      const { root, files } = makeRoot(n);
      h = makeHarness(baseTestConfig({ roots: [root] }));
      const counts = countPrepares(h.db);

      const first = await new ClaudeCollector().scan(h.ctx);
      expect(first.warnings).toEqual([]);
      expect(first.filesScanned).toBe(n);
      expect(first.filesSkipped).toBe(n);
      const afterFirst = fingerprint(h);

      const second = await new ClaudeCollector().scan(h.ctx);
      expect(second.warnings).toEqual([]);
      expect(second.filesScanned).toBe(n);
      expect(second.filesSkipped).toBe(n);

      expect(counts).toEqual({ getState: 1, setState: 1, recordSkipped: 1 });

      // The unchanged second scan writes nothing new.
      expect(fingerprint(h)).toBe(afterFirst);
      expect(h.ledger.getEvents({})).toHaveLength(n);
      for (const f of files) {
        const st = h.ledger.getState(f.path);
        expect(st?.offset).toBe(f.bytes);
        expect(st?.size).toBe(f.bytes);
      }
      const skipped = h.db.prepare('SELECT reason, count FROM skipped').all() as Array<{ reason: string; count: number }>;
      expect(skipped).toHaveLength(n);
      expect(skipped.every((r) => r.reason === 'not-whitelisted' && r.count === 2)).toBe(true);
    });
  }
});
