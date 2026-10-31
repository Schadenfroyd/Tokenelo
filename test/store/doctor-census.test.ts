import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readDoctorCensus } from '../../src/store/doctor-census.js';
import type { TokeneloDb } from '../../src/store/db.js';

const schema = 'CREATE TABLE events(api_equiv_usd,price_status,ucu_rate_status,thinking,source,flags_json,components_json)';
function add(db: DatabaseSync, amount: number | string | null = .1, status = 'LIST', source = 'codex', flags = '[]', components = '[]', thinking: number | null = 1) {
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(amount, status, 'NONE', thinking, source, flags, components);
}
function seed(db: DatabaseSync, n: number) {
  db.exec('BEGIN');for (let i = 0; i < n; i++) add(db);db.exec('COMMIT');
}

describe('cancellable Doctor census on the same SQLite snapshot', () => {
  it('emits static census subphase markers without changing the census', async () => {
    const db = new DatabaseSync(':memory:');db.exec(schema);add(db,.25);
    const phases: string[] = [];
    try {
      const result = await readDoctorCensus(db, undefined, phase => phases.push(phase));
      expect(phases).toEqual(['doctor.event-census.money-sum', 'doctor.event-census.row-batches']);
      expect(result.events).toBe(1);expect(result.usd).toBe(.25);
    } finally { db.close(); }
  });

  it('preserves empty counters and zero amount', async () => {
    const db = new DatabaseSync(':memory:');db.exec(schema);
    try { expect(await readDoctorCensus(db)).toEqual({ events: 0, usd: 0, invalidAmountEvents: 0,
      unknownStatusEvents: 0, statusAmountConflictEvents: 0, issuesEvents: 0,
      thinkingUnknownEvents: 0, ollamaLogThinkingUnknown: 0, speedAssumed: 0, cacheSplitAssumed: 0,
      iterationEvents: 0, reasoningClamped: 0 }); } finally { db.close(); }
  });

  it('preserves SQLite monetary accumulation and overlapping price/source counters across yields', async () => {
    const db = new DatabaseSync(':memory:');db.exec(schema);
    try {
      seed(db, 600);add(db, 1e16);add(db, 1);add(db, 1);add(db, -1e16, 'UNPRICED');
      add(db, null, 'LIST');add(db, 'nonnumeric', 'ESTIMATE', 'ollama-log', '[]', 'not-json', null);
      add(db, .1, 'FUTURE');add(db, .1, 'LIST', 'claude', '["speedAssumed","cacheSplitAssumed","reasoningClamped"]', '[{},{}]', null);
      // Flags and malformed components from another source do not become Claude counters.
      add(db, .1, 'LIST', 'codex', '["speedAssumed","cacheSplitAssumed","reasoningClamped"]', 'not-json');
      const expectedUsd = db.prepare('SELECT COALESCE(SUM(api_equiv_usd),0) AS usd FROM events').get()!.usd;
      const c = await readDoctorCensus(db);
      expect(c.usd).toBe(expectedUsd);expect(c).toMatchObject({ events: 609, invalidAmountEvents: 2,
        unknownStatusEvents: 1, statusAmountConflictEvents: 2, issuesEvents: 4,
        thinkingUnknownEvents: 2, ollamaLogThinkingUnknown: 1, speedAssumed: 1, cacheSplitAssumed: 1,
        iterationEvents: 1, reasoningClamped: 1 });
      add(db, null, 'UNPRICED', 'claude', '[]', 'not-json');
      await expect(readDoctorCensus(db)).rejects.toThrow(/malformed JSON/);
    } finally { db.close(); }
  });

  it('preserves cancellation reason and releases the iterator for a subsequent read', async () => {
    const db = new DatabaseSync(':memory:');db.exec(schema);seed(db, 1000);
    const controller = new AbortController(), reason = new Error('owned census cancellation');
    const pending = setImmediate(() => controller.abort(reason));
    try {
      await expect(readDoctorCensus(db, controller.signal)).rejects.toBe(reason);
      expect((await readDoctorCensus(db)).events).toBe(1000);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n).toBe(1000);
    } finally { clearImmediate(pending);db.close(); }
  });

  it.each([251, 1000])('services cancellation after a bounded native batch in a %i-row ledger', async (n) => {
    const db = new DatabaseSync(':memory:');db.exec(schema);seed(db, n);
    let rows = 0;
    const tracked = { prepare(sql: string) {
      const statement = db.prepare(sql);
      return { get(...args: Array<string | number>) {
        const row = statement.get(...args)!;
        if (sql.startsWith('SELECT COUNT(*)')) rows += Number(row.events);
        return row;
      } };
    } } as unknown as TokeneloDb;
    const controller = new AbortController(), reason = new Error('bounded census cancellation');
    const pending = setImmediate(() => controller.abort(reason));
    try {
      await expect(readDoctorCensus(tracked, controller.signal)).rejects.toBe(reason);
      expect(rows).toBeGreaterThan(0);expect(rows).toBeLessThanOrEqual(200);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n).toBe(n);
    } finally { clearImmediate(pending);db.close(); }
  });

  it('keeps negative, sparse and maximum signed64-bit rowids exact across batches', async () => {
    const db = new DatabaseSync(':memory:');db.exec(schema);
    try {
      seed(db, 201);db.prepare('UPDATE events SET rowid = ? WHERE rowid=1').run(-19);
      db.prepare('UPDATE events SET rowid = ? WHERE rowid=201').run(9223372036854775807n);
      const expectedUsd = db.prepare('SELECT SUM(api_equiv_usd) AS usd FROM events NOT INDEXED').get()!.usd;
      const c = await readDoctorCensus(db);expect(c.events).toBe(201);expect(c.usd).toBe(expectedUsd);
    } finally { db.close(); }
  });

  it('refuses a cancelled request before any native census read', async () => {
    const controller = new AbortController(), reason = new Error('cancelled before census');controller.abort(reason);
    const db = { prepare() { throw new Error('Unexpected database access'); } } as unknown as TokeneloDb;
    await expect(readDoctorCensus(db, controller.signal)).rejects.toBe(reason);
  });

  it('keeps the pinned WAL snapshot while another connection commits between yields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-owned-census-'));
    const file = path.join(root, 'ledger.sqlite'), writer = new DatabaseSync(file);let reader: DatabaseSync | undefined;
    let pending: ReturnType<typeof setImmediate> | undefined;
    try {
      writer.exec('PRAGMA journal_mode=WAL;'+schema);seed(writer, 1000);
      reader = new DatabaseSync(file, { readOnly: true });reader.exec('BEGIN');
      const before = reader.prepare('SELECT COUNT(*) AS n, SUM(api_equiv_usd) AS usd FROM events').get()!;
      pending = setImmediate(() => add(writer, 500, 'LIST', 'claude', '["speedAssumed"]', '[{},{}]', null));
      const c = await readDoctorCensus(reader);
      expect(writer.prepare('SELECT COUNT(*) AS n FROM events').get()!.n).toBe(1001);
      expect(c.events).toBe(before.n);expect(c.usd).toBe(before.usd);
      expect(c.speedAssumed).toBe(0);expect(c.iterationEvents).toBe(0);expect(c.thinkingUnknownEvents).toBe(0);
      reader.exec('ROLLBACK');expect((await readDoctorCensus(reader)).events).toBe(1001);
    } finally { if (pending) clearImmediate(pending);reader?.close();writer.close();fs.rmSync(root, { recursive: true, force: true }); }
  });
});
