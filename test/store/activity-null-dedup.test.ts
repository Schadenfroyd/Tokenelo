/**
 * Activity dedup when a mark has NULL uuid AND NULL kind. The unique fallback index
 * (source, session_id, ts, kind) WHERE uuid IS NULL never conflicts on NULL kind, because SQLite treats NULLs
 * as distinct in unique indexes, so an unmapped transcript line (no uuid, no kind) was inserted again on every
 * replay of its window. These tests pin the intended identity and the behaviour that must not change.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { INSERT_ACTIVITY_SQL, SqliteLedger } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type { ActivityMark } from '../../src/core/types.js';

const base: ActivityMark = { source: 'claude', sessionId: 's-1', ts: 1_000, host: 'A2000' } as ActivityMark;

let db: TokeneloDb;
let ledger: SqliteLedger;
let tmp: string | null = null;

function newLedger(file = ':memory:'): void {
  db = openDb({ file });
  ledger = new SqliteLedger(db, defaultPricingEngine(), createNullEngine());
}

function rows(): Array<{ uuid: string | null; kind: string | null; duration_ms: number | null; host: string; project: string | null }> {
  return db.prepare('SELECT uuid, kind, duration_ms, host, project FROM activity ORDER BY id').all() as never;
}

beforeEach(() => {
  newLedger();
});

afterEach(() => {
  db?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('NULL uuid and NULL kind: one row per identity', () => {
  it('within one batch, the same mark twice inserts once', () => {
    ledger.recordActivity([base, base]);
    expect(rows()).toHaveLength(1);
  });

  it('across calls, replaying the same mark inserts nothing new', () => {
    ledger.recordActivity([base]);
    ledger.recordActivity([base]);
    ledger.recordActivity([base, base]);
    expect(rows()).toHaveLength(1);
  });

  it('across a close and reopen of a file database, replaying the window inserts nothing new', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-activity-null-'));
    const file = path.join(tmp, 'ledger.db');
    newLedger(file);
    ledger.recordActivity([base, { ...base, ts: base.ts + 1 }]);
    db.close();

    newLedger(file);
    ledger.recordActivity([base, { ...base, ts: base.ts + 1 }]);
    expect(rows()).toHaveLength(2);
  });

  it('a different timestamp, session or source is a different identity and is kept', () => {
    ledger.recordActivity([base, { ...base, ts: 2_000 }, { ...base, sessionId: 's-2' }, { ...base, source: 'codex' }]);
    expect(rows()).toHaveLength(4);
  });
});

describe('NULL kind is distinct from an empty-string kind and from an explicit kind', () => {
  it('null kind and empty-string kind are two identities, each kept once', () => {
    ledger.recordActivity([base, { ...base, kind: '' as never }]);
    ledger.recordActivity([base, { ...base, kind: '' as never }]);
    expect(rows()).toHaveLength(2);
  });

  it('an explicit kind keeps the existing index path: a replay is ignored (unchanged behaviour)', () => {
    const user = { ...base, kind: 'user' as const };
    ledger.recordActivity([user, user]);
    ledger.recordActivity([user]);
    expect(rows()).toHaveLength(1);
  });
});

describe('UUID present: the (source, uuid) index is the identity, unchanged', () => {
  it('the same uuid replayed with a null kind inserts once', () => {
    const withUuid = { ...base, uuid: 'u-1' };
    ledger.recordActivity([withUuid]);
    ledger.recordActivity([withUuid, withUuid]);
    expect(rows()).toHaveLength(1);
  });

  it('distinct uuids at the same ts and kind are both kept', () => {
    ledger.recordActivity([{ ...base, uuid: 'u-1' }, { ...base, uuid: 'u-2' }]);
    expect(rows()).toHaveLength(2);
  });
});

describe('first write wins for metadata, as before', () => {
  it('a replay with a different duration or host does not change the stored row', () => {
    ledger.recordActivity([{ ...base, durationMs: 5 }]);
    ledger.recordActivity([{ ...base, durationMs: 9, host: 'OTHER', project: 'p' }]);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row).toMatchObject({ duration_ms: 5, host: 'A2000', project: null });
  });
});

describe('existing duplicate history', () => {
  it('rows already duplicated before this fix are not deleted, and a replay adds no further copies', () => {
    // Written directly, the way the pre-fix insert wrote them: NULL uuid and NULL kind never conflict.
    const raw = db.prepare(
      'INSERT INTO activity (source, session_id, ts, uuid, host, project, kind, duration_ms) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL)'
    );
    raw.run('claude', 's-1', 1_000, 'A2000');
    raw.run('claude', 's-1', 1_000, 'A2000');
    expect(rows()).toHaveLength(2);

    ledger.recordActivity([base]);
    expect(rows()).toHaveLength(2);
  });
});

describe('the guard uses the partial fallback index', () => {
  it('the query plan for the insert searches idx_activity_dedup_fallback', () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${INSERT_ACTIVITY_SQL}`)
      .all({
        source: 'claude',
        sessionId: 's-1',
        ts: 1_000,
        uuid: null,
        host: 'A2000',
        project: null,
        kind: null,
        durationMs: null,
      }) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(' | ');
    expect(detail).toContain('idx_activity_dedup_fallback');
  });
});
