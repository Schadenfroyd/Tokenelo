/** Owned synthetic fixtures only. These qualify batch SQL/transactions, not installed accounting. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PREFIX_CHUNK_BYTES, type CodexPrefixWitness } from '../../src/core/codex-prefix-witness.js';
import type { CodexContextCheckpointRecoveryCandidate, IngestState, TokeneloDb } from '../../src/core/types.js';
import { openDb } from '../../src/store/db.js';
import { configureCurrentEventBasis } from '../../src/store/event-basis.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { StubValuationEngine, StubPricingEngine, makeEvent } from './stubs.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const RECEIPT_PREFIX = 'tokenelo/codex-context-checkpoint@v1:';
const scratchParent = path.resolve('C:/Temp/tokenelo-r3230-source-binding-worker-20261021');
const dbs: TokeneloDb[] = [];
const roots: string[] = [];

function sid(n: number): string { return `01a00000-1111-7111-8111-${n.toString(16).padStart(12, '0')}`; }
function context(sessionId: string): Record<string, unknown> {
  return { v: 1, lineIndex: 12, sessionId, meta: { id: sessionId }, ownTurnStarted: false, ownTurnSeen: false, hasRecords: false,
    pending: [], responseIds: [], summary: { ownBillableEmitted: 0, ownTotalDerived: 0, records: 0 } };
}
/** Synthetic shape for the storage contract only; the digest strings are not file attestations. */
function syntheticWitness(bytes: number, ino: number): CodexPrefixWitness {
  return { v: 1, bytes, chunks: Array(Math.floor(bytes / CODEX_PREFIX_CHUNK_BYTES)).fill('a'.repeat(64)),
    tail: 'b'.repeat(64), object: { dev: '1', ino: String(ino), birthNs: '1' }, establishedAt: 1_800_000_000_000,
    readBytes: 0 };
}
function candidate(n: number): CodexContextCheckpointRecoveryCandidate {
  const sessionId = sid(n);
  const priorExtra = context(sessionId), nextExtra = context(sessionId);
  priorExtra.consumedPrefix = syntheticWitness(128, 77);
  nextExtra.consumedPrefix = syntheticWitness(256, 88);
  const prior: IngestState = { key: `/owned/rollout-${sessionId}.jsonl`, size: 128, offset: 128,
    ino: 77, mtimeMs: 1_800_000_000_000.25, extra: priorExtra };
  return { prior, next: { ...prior, size: 256, offset: 256, ino: 88, extra: nextExtra },
    claim: { host: 'A2000', sessionId } };
}
const newLedger = (db: TokeneloDb) => new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
function ownDb(db: TokeneloDb): TokeneloDb { dbs.push(db); return db; }
function filePath(): string {
  fs.mkdirSync(scratchParent, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchParent, 'tokenelo-codex-batch-'));
  roots.push(root);
  return path.join(root, 'fixture.sqlite');
}
function fixture(file = ':memory:'): { db: TokeneloDb; ledger: SqliteLedger } {
  const db = ownDb(new DatabaseSync(file));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE main.events(id TEXT NOT NULL,session_id TEXT,host TEXT,source TEXT);
    CREATE TABLE main.event_projection(id TEXT NOT NULL,session_id TEXT,host TEXT,source TEXT);
    CREATE TABLE main.event_projection_basis(singleton INTEGER PRIMARY KEY CHECK(singleton=1),policy INTEGER NOT NULL);
    INSERT INTO main.event_projection_basis VALUES(1,7);
    CREATE TABLE main.event_interpretation_history(history_id INTEGER PRIMARY KEY,id TEXT NOT NULL,session_id TEXT,host TEXT,source TEXT);
    CREATE TABLE main.event_route_reports(event_id TEXT,source TEXT,component_index INTEGER,model TEXT,speed TEXT,kind TEXT,evidence TEXT);
    CREATE TABLE main.activity(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,uuid TEXT,host TEXT);
    CREATE TABLE main.ingest_state(key TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime_ms REAL NOT NULL,offset INTEGER NOT NULL,ino INTEGER,extra_json TEXT);
    CREATE TABLE main.meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  configureCurrentEventBasis(db);
  return { db, ledger: newLedger(db) };
}
function seedStates(ledger: SqliteLedger, candidates: CodexContextCheckpointRecoveryCandidate[]): void {
  for (const entry of candidates) ledger.setState(entry.prior);
}
function cursors(db: TokeneloDb): unknown[] { return db.prepare('SELECT rowid,* FROM main.ingest_state ORDER BY key').all(); }
function receipts(db: TokeneloDb): unknown[] {
  return db.prepare('SELECT key,value FROM main.meta WHERE key LIKE ? ORDER BY key').all(`${RECEIPT_PREFIX}%`);
}
function accounting(db: TokeneloDb): Record<string, unknown[]> {
  return Object.fromEntries(['main.events', 'events', 'main.event_interpretation_history', 'main.activity',
    'main.limits', 'main.sqlite_sequence', 'main.event_route_reports'].map(table =>
    [table, db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) if (db.isOpen) db.close();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(`${scratchParent}${path.sep}`)) throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('bounded Codex checkpoint batch', () => {
  it('caps batches and rejects noncanonical claims before taking the write lock', () => {
    const { db, ledger } = fixture();
    const good = candidate(1), bad = candidate(2);
    bad.claim.sessionId = 'contains:a:colon';
    const exec = vi.spyOn(db, 'exec');
    expect(ledger.recoverCodexContextCheckpoints([])).toEqual([]);
    expect(ledger.recoverCodexContextCheckpoints(Array.from({ length: 257 }, () => good))).toEqual(Array(257).fill(false));
    expect(ledger.recoverCodexContextCheckpoints([bad])).toEqual([false]);
    expect(exec).not.toHaveBeenCalled();
    expect(cursors(db)).toEqual([]);
    expect(receipts(db)).toEqual([]);
  });

  it('preserves both case-insensitive ownership keys across every basis, host and source', () => {
    const { db, ledger } = fixture();
    const batch = Array.from({ length: 12 }, (_, n) => candidate(n));
    seedStates(ledger, batch);
    for (const [table, a, b] of [['main.events', 0, 1], ['events', 2, 3],
      ['main.event_interpretation_history', 4, 5]] as const) {
      db.prepare(`INSERT INTO ${table}(id,session_id,host,source) VALUES(?,?,?,?)`)
        .run(`CoDeX:${sid(a).toUpperCase()}:legacy`, sid(b).toUpperCase(), 'OtherHost', 'other-source');
    }
    db.prepare('INSERT INTO main.activity(uuid,session_id,host,source) VALUES(?,?,?,?)')
      .run(`CoDeX:${sid(6).toUpperCase()}:legacy`, sid(7).toUpperCase(), 'OtherHost', 'other-source');
    db.prepare('INSERT INTO main.events(id,session_id) VALUES(?,?)').run(`codex:${sid(8)}x:near-match`, 'other');
    db.prepare('INSERT INTO events(id,session_id) VALUES(?,?)').run(`uncodex:${sid(9)}:near-match`, null);
    db.prepare('INSERT INTO main.activity(uuid,session_id) VALUES(?,?)').run(`codex:${sid(10)}:`, null);
    const before = cursors(db);
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([
      false, false, false, false, false, false, false, false, true, true, false, true,
    ]);
    expect(receipts(db)).toHaveLength(3);
    const after = cursors(db);
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 10]) expect(after[n]).toEqual(before[n]);
  });

  it('returns independent stale outcomes and rejects the same stale prior after success', () => {
    const { db, ledger } = fixture();
    const batch = [candidate(1), candidate(2), candidate(3)];
    seedStates(ledger, batch);
    db.prepare('UPDATE main.ingest_state SET offset=127 WHERE key=?').run(batch[1].prior.key);
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([true, false, true]);
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([false, false, false]);
    expect(receipts(db)).toHaveLength(2);
  });

  it.each(['ABORT', 'IGNORE'] as const)('rolls the entire batch back on a later receipt RAISE(%s)', failure => {
    const { db, ledger } = fixture();
    const batch = [candidate(1), candidate(2)];
    seedStates(ledger, batch);
    const before = cursors(db);
    db.exec(`CREATE TRIGGER fail_second_receipt BEFORE INSERT ON main.meta
      WHEN json_extract(NEW.value,'$.claim.sessionId')='${sid(2)}'
      BEGIN SELECT RAISE(${failure}${failure === 'ABORT' ? ",'second receipt rejected'" : ''}); END`);
    expect(() => ledger.recoverCodexContextCheckpoints(batch)).toThrow(
      failure === 'ABORT' ? /second receipt rejected/ : /receipt append did not insert/);
    expect(cursors(db)).toEqual(before);
    expect(receipts(db)).toEqual([]);
  });

  it('rolls earlier successes back when a later candidate collides with an existing receipt', () => {
    const { db, ledger } = fixture();
    const batch = [candidate(1), candidate(2)];
    seedStates(ledger, batch);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_999);
    expect(ledger.recoverCodexContextCheckpoint(batch[1].prior, batch[1].next, batch[1].claim)).toBe(true);
    ledger.setState(batch[1].prior);
    const before = cursors(db), receiptBefore = receipts(db);
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([false, false]);
    expect(cursors(db)).toEqual(before);
    expect(receipts(db)).toEqual(receiptBefore);
  });

  it('restores every cursor and receipt on an outer transaction rollback', () => {
    const { db, ledger } = fixture();
    const batch = [candidate(1), candidate(2)];
    seedStates(ledger, batch);
    const before = cursors(db);
    expect(() => ledger.transaction(() => {
      expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([true, true]);
      throw new Error('outer failure');
    })).toThrow('outer failure');
    expect(cursors(db)).toEqual(before);
    expect(receipts(db)).toEqual([]);
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([true, true]);
  });

  it('sees an owner committed by another connection immediately before BEGIN IMMEDIATE', () => {
    const file = filePath(), { db, ledger } = fixture(file);
    const other = ownDb(new DatabaseSync(file));
    const entry = candidate(1);
    seedStates(ledger, [entry]);
    const rawExec = db.exec.bind(db);
    let injected = false;
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      if (sql === 'BEGIN IMMEDIATE' && !injected) {
        injected = true;
        other.prepare('INSERT INTO main.events(id,session_id) VALUES(?,?)').run(`CODEX:${sid(1).toUpperCase()}:external`, 'other');
      }
      return rawExec(sql);
    });
    expect(ledger.recoverCodexContextCheckpoints([entry])).toEqual([false]);
    expect(injected).toBe(true);
    expect(ledger.getState(entry.prior.key)).toEqual(entry.prior);
    expect(receipts(db)).toEqual([]);
  });

  it('holds the write lock and hides partial batches from a real second connection', () => {
    const file = filePath(), { db, ledger } = fixture(file);
    const other = ownDb(new DatabaseSync(file));
    other.exec('PRAGMA busy_timeout=35');
    const batch = [candidate(1), candidate(2)];
    seedStates(ledger, batch);
    const before = cursors(other);
    const rawPrepare = db.prepare.bind(db);
    let checked = false, blockedMs = 0;
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const stmt = rawPrepare(sql);
      if (sql.startsWith('INSERT INTO main.meta(key,value)')) {
        const run = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          if (!checked) {
            checked = true;
            expect(cursors(other)).toEqual(before); // first cursor update is not visible before commit
            const start = performance.now();
            expect(() => other.exec('BEGIN IMMEDIATE')).toThrow(/locked/);
            blockedMs = performance.now() - start;
          }
          return run(...args);
        };
      }
      return stmt;
    });
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([true, true]);
    expect(checked).toBe(true);
    expect(blockedMs).toBeGreaterThanOrEqual(20);
    expect(cursors(other)).not.toEqual(before);
    other.exec('BEGIN IMMEDIATE'); // lock is available immediately after recovery commits
    other.prepare('INSERT INTO main.activity(uuid,session_id) VALUES(?,?)').run(`codex:${sid(1)}:external`, null);
    other.exec('COMMIT');
    expect(other.prepare('SELECT COUNT(*) AS n FROM main.activity').get()).toMatchObject({ n: 1 });
  });

  it('preserves historical prices, rowids, allocators, limits, history and unrelated meta', () => {
    const db = ownDb(openDb({ file: ':memory:' })), ledger = newLedger(db);
    ledger.upsertEvents([makeEvent({ id: 'unrelated', sessionId: 'other', inputFresh: 20, output: 3 })]);
    ledger.upsertEvents([makeEvent({ id: 'unrelated', sessionId: 'other', inputFresh: 25, output: 3 })]);
    ledger.recordActivity([{ source: 'claude', sessionId: 'other', ts: 90, uuid: 'unrelated', host: 'M4a' }]);
    ledger.recordLimits({ source: 'codex', host: 'A2000', capturedAt: 123, windows: [], estimate: false });
    db.prepare("INSERT INTO main.meta(key,value) VALUES('preserved','verbatim')").run();
    const batch = [candidate(1), candidate(2)];
    seedStates(ledger, batch);
    const before = accounting(db), metaBefore = db.prepare('SELECT key,value FROM main.meta ORDER BY key').all();
    const rowids = db.prepare('SELECT key,rowid FROM main.ingest_state ORDER BY key').all();
    const schemaBefore = db.prepare('SELECT type,name,sql FROM main.sqlite_schema ORDER BY type,name').all();
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual([true, true]);
    expect(accounting(db)).toEqual(before);
    expect(db.prepare('SELECT key,rowid FROM main.ingest_state ORDER BY key').all()).toEqual(rowids);
    expect(db.prepare('SELECT key,value FROM main.meta WHERE key NOT LIKE ? ORDER BY key').all(`${RECEIPT_PREFIX}%`)).toEqual(metaBefore);
    expect(db.prepare('SELECT type,name,sql FROM main.sqlite_schema ORDER BY type,name').all()).toEqual(schemaBefore);
    expect(db.prepare('SELECT name FROM temp.sqlite_schema').all()).toEqual([]);
    expect(receipts(db)).toHaveLength(2);
  });

  it('scans four large bases once for 188 candidates with bounded results and no correlated candidate loop', () => {
    const { db, ledger } = fixture(filePath());
    const rowsPerBasis = 250_000;
    db.exec('BEGIN IMMEDIATE');
    for (const table of ['main.events', 'events', 'main.event_interpretation_history']) {
      db.exec(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<${rowsPerBasis})
        INSERT INTO ${table}(id,session_id,host,source)
        SELECT 'unrelated-event:'||value,'unrelated-session:'||value,'OtherHost','other-source' FROM n`);
    }
    db.exec(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<${rowsPerBasis})
      INSERT INTO main.activity(uuid,session_id,host,source)
      SELECT 'unrelated-mark:'||value,'unrelated-session:'||value,'OtherHost','other-source' FROM n`);
    db.exec('COMMIT');
    const batch = Array.from({ length: 188 }, (_, n) => candidate(n));
    seedStates(ledger, batch);
    const queries: Array<{ sql: string; calls: number; maxReturnedRows: number; totalMs: number }> = [];
    const rawPrepare = db.prepare.bind(db), rawExec = db.exec.bind(db);
    let lockAcquiredAt = 0, writeLockMs = 0, beginWaitMs = 0;
    vi.spyOn(db, 'exec').mockImplementation(sql => {
      const start = performance.now();
      const result = rawExec(sql);
      if (sql === 'BEGIN IMMEDIATE') { lockAcquiredAt = performance.now(); beginWaitMs = lockAcquiredAt - start; }
      if (sql === 'COMMIT') writeLockMs = performance.now() - lockAcquiredAt;
      return result;
    });
    vi.spyOn(db, 'prepare').mockImplementation(sql => {
      const stmt = rawPrepare(sql);
      if (sql.startsWith('WITH codex_checkpoint_candidates')) {
        const detail = { sql, calls: 0, maxReturnedRows: 0, totalMs: 0 };
        queries.push(detail);
        const all = stmt.all.bind(stmt);
        stmt.all = (...args) => {
          const start = performance.now(), rows = all(...args);
          detail.calls++;
          detail.totalMs += performance.now() - start;
          detail.maxReturnedRows = Math.max(detail.maxReturnedRows, rows.length);
          return rows;
        };
      }
      return stmt;
    });
    const start = performance.now();
    expect(ledger.recoverCodexContextCheckpoints(batch)).toEqual(Array(188).fill(true));
    const synchronousCallMs = performance.now() - start;
    expect(queries).toHaveLength(4);
    expect(queries.map(q => q.calls)).toEqual([1, 1, 1, 1]);
    const candidateJson = JSON.stringify(batch.map(c => c.claim.sessionId));
    const plans = queries.map(q => {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(candidateJson) as Array<{ detail: string }>;
      const details = plan.map(row => row.detail);
      expect(details.filter(detail => detail === 'SCAN owned')).toHaveLength(1);
      expect(details.some(detail => /CORRELATED/i.test(detail))).toBe(false);
      expect(details.some(detail => /MATERIALIZE codex_checkpoint_candidates/.test(detail))).toBe(true);
      expect(q.maxReturnedRows).toBeLessThanOrEqual(256);
      return details;
    });
    expect(receipts(db)).toHaveLength(188);
    // Finite synthetic qualification only; this generous bound is not an installed latency claim.
    expect(synchronousCallMs).toBeLessThan(15_000);
    const evidence = { kind: 'owned-synthetic-codex-batch', node: process.version, rowsPerBasis,
      accountingRows: rowsPerBasis * 4, candidates: batch.length, synchronousCallMs, writeLockMs, beginWaitMs,
      basisQueries: queries.map(({ sql: _sql, ...query }, i) => ({ ...query, plan: plans[i] })),
      persistentDdl: false, installedAcceptance: false };
    if (process.env.TOKENELO_CODEX_BATCH_EVIDENCE) {
      fs.writeFileSync(process.env.TOKENELO_CODEX_BATCH_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
    }
  }, 30_000);
});
