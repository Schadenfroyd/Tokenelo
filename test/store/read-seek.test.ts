/**
 * Keyset pages must seek at the cursor, not at the range start, and the filtered and tie-ordered results must stay exact.
 *
 * The seek check reads the VM program (EXPLAIN) and follows the register each SeekGE/SeekGT takes its key from back to the
 * `Variable` that loads a bound parameter. That gives the value the index search starts from. The planner is part of the
 * contract here, so this is a regression on this runtime's planner. The result checks below do not depend on the planner, so
 * a planner change can only fail the seek check, never the results.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { openReadSnapshot, readRows, rowStatement, type RowQuery } from '../../src/store/read-snapshot.js';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

interface Op {
  addr: number;
  opcode: string;
  p1: number;
  p2: number;
  p3: number;
  p4: string | null;
}

/** Values each SeekGE/SeekGT takes its key from, in program order, traced back through copies to a bound parameter. */
function seekKeyValues(db: TokeneloDb, sql: string, params: (string | number)[]): unknown[] {
  const ops = db.prepare(`EXPLAIN ${sql}`).all(...params) as unknown as Op[];
  const values: unknown[] = [];
  ops.forEach((op, idx) => {
    if (op.opcode !== 'SeekGE' && op.opcode !== 'SeekGT') return;
    // Composite searches consume consecutive registers: provider equality then
    // cursor timestamp. A constant equality parameter may be loaded in Init's
    // tail before execution jumps back to the seek program.
    for(let key=0;key<Number(op.p4 ?? 1);key++){
    let reg = op.p3+key, found=false;
    for (let j = idx - 1; j >= 0; j--) {
      const w = ops[j]!;
      if (w.p2 !== reg) continue;
      if (w.opcode === 'Variable') {
        values.push(params[w.p1 - 1]);
        found=true;
        break;
      }
      if (w.opcode === 'SCopy' || w.opcode === 'Copy' || w.opcode === 'Move') {
        reg = w.p1;
        continue;
      }
      break;
    }
    if(!found){const initial=ops.find(w=>w.opcode==='Variable'&&w.p2===reg);if(initial)values.push(params[initial.p1-1]);}
    }
  });
  return values;
}

const EVENT_INSERT_SQL = `INSERT INTO events (id, host, source, ts, ts_source, session_id, model, provider, engine, components_json,
                         price_status, price_version, ucu_rate_status, eacs_def_sha256, input_fresh, output)
     VALUES (?, 'H', 'claude', ?, 'line', 's', 'm', ?, NULL, '[]', 'ok', 'v', 'ok', 'h', 1, 1)`;

function insertEvent(db: TokeneloDb, id: string, ts: number, provider: string): void {
  db.prepare(EVENT_INSERT_SQL).run(id, ts, provider);
}

function insertActivity(db: TokeneloDb, uuid: string, ts: number): void {
  db.prepare("INSERT INTO activity (source, session_id, ts, uuid, host, kind) VALUES ('claude', 's', ?, ?, 'H', 'user')").run(ts, uuid);
}

function fileDb(): { writer: TokeneloDb; file: string } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-seek-'));
  const file = path.join(tmp, 'ledger.db');
  return { writer: openDb({ file }), file };
}

describe('keyset pages seek at the cursor', () => {
  it('a page with a cursor starts its index search at the cursor timestamp; the first page starts at the range start', () => {
    const { writer, file } = fileDb();
    writer.exec('BEGIN');
    for (let i = 0; i < 3000; i++) insertActivity(writer, `a-${i}`, 1000 + i * 10);
    writer.exec('COMMIT');
    const snap = openReadSnapshot(file);
    try {
      const q: RowQuery = { table: 'activity', columns: 'uuid', clauses: ['ts >= ?'], params: [1000] };
      const first = rowStatement(q, undefined, 2000);
      expect(seekKeyValues(snap.db, first.sql, first.params)[0]).toBe(1000);

      const cursor = { ts: 1000 + 2000 * 10, rid: 2001 };
      const later = rowStatement(q, cursor, 2000);
      expect(seekKeyValues(snap.db, later.sql, later.params)[0]).toBe(cursor.ts);
    } finally {
      snap.close();
      writer.close();
    }
  });

  it('the cursor seek holds with the provider filter that the local value uses', () => {
    const { writer, file } = fileDb();
    writer.exec('BEGIN');
    // Seed the identical 3000 rows without recompiling the same SQL 3000 times.
    const insert = writer.prepare(EVENT_INSERT_SQL);
    for (let i = 0; i < 3000; i++) insert.run(`e-${i}`, 1000 + i, i % 5 === 0 ? 'local' : 'anthropic');
    writer.exec('COMMIT');
    const snap = openReadSnapshot(file);
    try {
      const q: RowQuery = { table: 'events', columns: '*', clauses: ['ts >= ?', 'provider = ?'], params: [1000, 'local'] };
      const cursor = { ts: 1000 + 1500, rid: 1501 };
      const later = rowStatement(q, cursor, 100);
      expect(seekKeyValues(snap.db, later.sql, later.params)).toEqual(['local',cursor.ts]);
    } finally {
      snap.close();
      writer.close();
    }
  });
});

describe('filtered keyset pages: explicit order, ties and boundaries', () => {
  it('provider-filtered events with equal timestamps page in (ts, rowid) order, matching the unpaged read', async () => {
    const { writer, file } = fileDb();
    // Equal timestamps, interleaved providers. Expected order is written out: (ts ascending, then insertion order).
    const seeded: Array<[string, number, string]> = [
      ['l-1', 2000, 'local'], ['a-1', 2000, 'anthropic'], ['l-2', 2000, 'local'], ['l-3', 2000, 'local'],
      ['a-2', 2000, 'anthropic'], ['l-4', 3000, 'local'], ['l-5', 3000, 'local'], ['a-3', 1000, 'anthropic'],
      ['l-0', 1000, 'local'], ['l-6', 4000, 'local'],
    ];
    for (const [id, ts, provider] of seeded) insertEvent(writer, id, ts, provider);
    const expectedLocal = ['l-0', 'l-1', 'l-2', 'l-3', 'l-4', 'l-5', 'l-6'];
    // since = 1000 includes the first timestamp; the local rows with ts 1000 are l-0 (inserted after a-3, so higher rowid).
    const q: RowQuery = { table: 'events', columns: 'id', clauses: ['ts >= ?', 'provider = ?'], params: [1000, 'local'] };
    const snap = openReadSnapshot(file);
    try {
      const unpaged = (await readRows<{ id: string; ts: number; rid: number }, string>(snap.db, q, undefined, (r) => r.id));
      expect(unpaged).toEqual(expectedLocal);
      for (const pageRows of [1, 2, 3]) {
        const paged = await readRows<{ id: string; ts: number; rid: number }, string>(
          snap.db,
          q,
          { pageRows, yieldNow: async () => {} },
          (r) => r.id
        );
        expect(paged).toEqual(expectedLocal);
      }
    } finally {
      snap.close();
      writer.close();
    }
  });

  it('the since bound is inclusive and still applies on later pages', async () => {
    const { writer, file } = fileDb();
    for (let i = 0; i < 12; i++) insertActivity(writer, `u-${i}`, i < 4 ? 500 : 1000); // four rows before the bound
    const q: RowQuery = { table: 'activity', columns: 'uuid', clauses: ['ts >= ?'], params: [1000] };
    const snap = openReadSnapshot(file);
    try {
      const paged = await readRows<{ uuid: string; ts: number; rid: number }, string>(
        snap.db,
        q,
        { pageRows: 3, yieldNow: async () => {} },
        (r) => r.uuid
      );
      expect(paged).toEqual(['u-4', 'u-5', 'u-6', 'u-7', 'u-8', 'u-9', 'u-10', 'u-11']);
    } finally {
      snap.close();
      writer.close();
    }
  });
});
