/**
 * Request snapshots and keyset paging (store/read-snapshot.ts). The expected orders below are written out, not taken from the
 * single-statement read, so a mutation in the shared code cannot pass by agreeing with itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { openReadSnapshot, readRows, type RowQuery } from '../../src/store/read-snapshot.js';

let tmp: string | null = null;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function insertEvent(db: TokeneloDb, id: string, ts: number): void {
  db.prepare(
    `INSERT INTO events (id, host, source, ts, ts_source, session_id, model, provider, engine, components_json,
                         price_status, price_version, ucu_rate_status, eacs_def_sha256, input_fresh, output)
     VALUES (?, 'H', 'claude', ?, 'line', 's', 'm', 'anthropic', NULL, '[]', 'ok', 'v', 'ok', 'h', 1, 1)`
  ).run(id, ts);
}

function insertActivity(db: TokeneloDb, uuid: string, ts: number): void {
  db.prepare("INSERT INTO activity (source, session_id, ts, uuid, host, kind) VALUES ('claude', 's', ?, ?, 'H', 'user')").run(ts, uuid);
}

/** A file database: the snapshot connection needs one. Equal timestamps come in runs that straddle page boundaries. */
function seedFile(): { writer: TokeneloDb; file: string } {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-readsnap-'));
  const file = path.join(tmp, 'ledger.db');
  const writer = openDb({ file });
  // 7 events at ts 1000, then 9 at ts 2000, then 4 at ts 3000, in insertion order.
  for (let i = 0; i < 7; i++) insertEvent(writer, `e1-${i}`, 1000);
  for (let i = 0; i < 9; i++) insertEvent(writer, `e2-${i}`, 2000);
  for (let i = 0; i < 4; i++) insertEvent(writer, `e3-${i}`, 3000);
  return { writer, file };
}

const EVENT_IDS_IN_ORDER = [
  ...Array.from({ length: 7 }, (_, i) => `e1-${i}`),
  ...Array.from({ length: 9 }, (_, i) => `e2-${i}`),
  ...Array.from({ length: 4 }, (_, i) => `e3-${i}`),
];

const eventQuery: RowQuery = { table: 'events', columns: 'id', clauses: ['ts >= ?'], params: [0] };

describe('readRows: keyset pages reproduce the single-statement order', () => {
  it('waits for a transient supported-writer lock before pinning without changing retained event rows', async () => {
    const { writer, file } = seedFile();
    const before = writer.prepare('SELECT rowid AS rid, id, input_fresh, output, price_version FROM events ORDER BY rowid').all();
    writer.close();
    const script = path.join(tmp!, 'supported-lock-writer.mjs');
    const module = pathToFileURL(path.resolve('src/store/db.ts')).href;
    fs.writeFileSync(script, `import {openDb} from ${JSON.stringify(module)};
      const db=openDb({file:process.argv[2]});db.exec('PRAGMA locking_mode=EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');db.exec('UPDATE meta SET value=value');console.log('READY');
      setTimeout(()=>{db.exec('ROLLBACK');db.close();},250);`);
    const child = spawn(process.execPath, ['--import', 'tsx', script, file], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    let snap: ReturnType<typeof openReadSnapshot> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ''; const timer = setTimeout(() => reject(Error('fixture readiness: ' + stderr)), 2000);
        child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('READY')) { clearTimeout(timer); resolve(); } });
        child.once('error', error => { clearTimeout(timer); reject(error); });
      });
      snap = openReadSnapshot(file);
      expect(snap.db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
      expect(snap.db.prepare('SELECT rowid AS rid, id, input_fresh, output, price_version FROM events ORDER BY rowid').all()).toEqual(before);
      expect(before.map(row => row.id)).toEqual(EVENT_IDS_IN_ORDER);
    } finally {
      snap?.close();
      // Own only this fixture child; always wait for its bounded rollback/exit before fixture removal.
      expect(await exit, stderr).toBe(0);
    }
  });

  it('pages of 3 and of 4 across equal-timestamp runs return every event once, in insertion order', async () => {
    const { writer, file } = seedFile();
    const snap = openReadSnapshot(file);
    try {
      const unpaged = (await readRows<{ id: string; ts: number; rid: number }>(snap.db, eventQuery)).map((r) => r.id);
      expect(unpaged).toEqual(EVENT_IDS_IN_ORDER);
      for (const pageRows of [3, 4]) {
        const paged = await readRows<{ id: string; ts: number; rid: number }>(snap.db, eventQuery, {
          pageRows,
          yieldNow: async () => {},
        });
        expect(paged.map((r) => r.id)).toEqual(EVENT_IDS_IN_ORDER);
      }
    } finally {
      snap.close();
      writer.close();
    }
  });

  it('activity marks page in (ts, id) order, equal to the unpaged read', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-readsnap-'));
    const writer = openDb({ file: path.join(tmp, 'ledger.db') });
    for (const u of ['u-z', 'u-a', 'u-m']) insertActivity(writer, u, 1000);
    for (const u of ['u-b', 'u-y']) insertActivity(writer, u, 2000);
    const q: RowQuery = { table: 'activity', columns: 'uuid', clauses: ['ts >= ?'], params: [0] };
    const snap = openReadSnapshot(path.join(tmp, 'ledger.db'));
    try {
      const expected = ['u-z', 'u-a', 'u-m', 'u-b', 'u-y'];
      expect((await readRows<{ uuid: string; ts: number; rid: number }>(snap.db, q)).map((r) => r.uuid)).toEqual(expected);
      const paged = await readRows<{ uuid: string; ts: number; rid: number }>(snap.db, q, { pageRows: 2, yieldNow: async () => {} });
      expect(paged.map((r) => r.uuid)).toEqual(expected);
    } finally {
      snap.close();
      writer.close();
    }
  });

  it('awaits yieldNow after each full page', async () => {
    const { writer, file } = seedFile(); // 20 events
    const snap = openReadSnapshot(file);
    try {
      let yields = 0;
      await readRows(snap.db, eventQuery, { pageRows: 4, yieldNow: async () => void yields++ });
      expect(yields).toBe(5); // pages of 4,4,4,4,4 (20 rows): a yield after each full page; the empty page ends the loop
    } finally {
      snap.close();
      writer.close();
    }
  });
});

describe('openReadSnapshot: one state for the whole request', () => {
  it('a writer commit between pages is invisible to the request, and visible to the next one', async () => {
    const { writer, file } = seedFile(); // 20 events visible before the request starts
    const snap = openReadSnapshot(file);
    try {
      let committed = false;
      const paged = await readRows<{ id: string; ts: number; rid: number }>(snap.db, eventQuery, {
        pageRows: 5,
        yieldNow: async () => {
          if (committed) return;
          committed = true;
          // The daemon's writable connection commits new events while the request is paused between pages.
          for (let i = 0; i < 30; i++) insertEvent(writer, `late-${i}`, 4000 + i);
        },
      });
      expect(committed).toBe(true);
      expect(paged.map((r) => r.id)).toEqual(EVENT_IDS_IN_ORDER);
      expect(paged.some((r) => r.id.startsWith('late-'))).toBe(false);
    } finally {
      snap.close();
    }
    // After the request ends, a new snapshot sees the commit.
    const next = openReadSnapshot(file);
    try {
      const rows = await readRows<{ id: string; ts: number; rid: number }>(next.db, eventQuery);
      expect(rows).toHaveLength(50);
    } finally {
      next.close();
      writer.close();
    }
  });
});
