import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, withTransaction } from '../../src/store/db.js';
import { getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/store/migrations.js';

describe('openDb', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens a file-backed db in WAL mode with busy_timeout set, and runs migrations', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-db-'));
    const file = path.join(tmpDir, 'sub', 'tokenelo.db'); // parent dir must be created for us
    const db = openDb({ file, busyTimeoutMs: 1234 });

    const journalMode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string })
      .journal_mode;
    expect(journalMode).toBe('wal');

    const busyTimeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    expect(busyTimeout).toBe(1234);

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(fs.existsSync(file)).toBe(true);
    db.close();
  });

  it('opens :memory: without WAL and still migrates', () => {
    const db = openDb({ file: ':memory:' });
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('migrate:false skips schema creation', () => {
    const db = openDb({ file: ':memory:', migrate: false });
    expect(getSchemaVersion(db)).toBe(0);
    db.close();
  });
});

describe('withTransaction', () => {
  it('commits on success', () => {
    const db = openDb({ file: ':memory:' });
    db.exec('CREATE TABLE t (x INTEGER)');
    withTransaction(db, () => {
      db.prepare('INSERT INTO t (x) VALUES (1)').run();
    });
    expect((db.prepare('SELECT count(*) as c FROM t').get() as { c: number }).c).toBe(1);
    db.close();
  });

  it('rolls back on throw and rethrows the original error', () => {
    const db = openDb({ file: ':memory:' });
    db.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      withTransaction(db, () => {
        db.prepare('INSERT INTO t (x) VALUES (1)').run();
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect((db.prepare('SELECT count(*) as c FROM t').get() as { c: number }).c).toBe(0);
    db.close();
  });
});
