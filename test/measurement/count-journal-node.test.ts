import { describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseHandle } from 'node:sqlite';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { captureCountEnvelope } from '../../src/measurement/count-envelope.js';
import { CountJournal, CountJournalError, MAX_COUNT_JOURNAL_BATCH_LENGTH, MAX_COUNT_JOURNAL_BATCH_RECORDS } from '../../src/measurement/count-journal-node.js';

const key = (v: string) => createHash('sha256').update(v).digest('hex');
const source = key('source'), epoch = key('epoch'), component = key('component'), context = key('context');
const packet = (input = 2, output = 3) => JSON.stringify(captureCountEnvelope({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 }));
const item = (p = packet(), componentKey = component, contextSha = context) => ({ componentKey, contextSha, packet: p });
const batch = (records: unknown[] = [item()], patch: Record<string, unknown> = {}) => JSON.stringify({ sourceKey: source, epochSha: epoch, offset: 100, resetEpoch: false, records, ...patch });
// Vitest 2's transform predates this prefix-only builtin; resolve it with Node itself.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
function memory(run: (db: DatabaseHandle, journal: CountJournal) => void) {
  const db = new DatabaseSync(':memory:');
  try { run(db, CountJournal.create(db)); } finally { db.close(); }
}
function count(db: DatabaseHandle) { return db.prepare('SELECT COUNT(*) AS n FROM count_journal_snapshots').get()?.n; }
function value(journal: CountJournal, id = component) {
  const result = journal.project(id);
  expect(result.kind).toBe('projected');
  if (result.kind !== 'projected') throw Error('Expected projected count history');
  return result.history.totals.full.value;
}

describe('private separate Node count journal', () => {
  it('retries canonical packets within identity without coalescing distinct equal-valued calls', () => memory((db, j) => {
    expect(j.ingest(batch())).toEqual({ kind: 'committed', insertedSnapshots: 1, cursorOffset: 100 });
    expect(j.ingest(batch())).toEqual({ kind: 'committed', insertedSnapshots: 0, cursorOffset: 100 });
    expect(j.ingest(batch([item(packet(), key('other-component'))], { offset: 101 }))).toMatchObject({ kind: 'committed', insertedSnapshots: 1 });
    expect(count(db)).toBe(2); expect(value(j)).toBe(9); expect(value(j, key('other-component'))).toBe(9);
    expect(CountJournal.open(db).project(component)).toEqual(j.project(component));
  }));
  it('preserves revision conflicts and context conflicts without a known combined total', () => memory((db, j) => {
    expect(j.ingest(batch([item(packet(3, 2)), item(packet(2, 3))]))).toMatchObject({ kind: 'committed', insertedSnapshots: 2 });
    expect(j.project(component)).toMatchObject({ kind: 'projected', history: { totals: { full: { quality: 'conflict', value: null } } } });
    expect(j.ingest(batch([item(packet(), component, key('different-model-context'))]))).toMatchObject({ kind: 'committed', insertedSnapshots: 1 });
    expect(count(db)).toBe(3); expect(j.project(component)).toEqual({ kind: 'unavailable', reason: 'component-context-conflict' });
  }));
  it('keeps all revisions beyond the projection limit without truncating or returning a stale total', () => memory((db, j) => {
    const records = Array.from({ length: 65 }, (_, i) => item(packet(i)));
    expect(j.ingest(batch(records.slice(0, 64)))).toMatchObject({ kind: 'committed', insertedSnapshots: 64 });
    expect(value(j)).toBe(70);
    expect(j.ingest(batch([records[64]], { offset: 101 }))).toMatchObject({ kind: 'committed', insertedSnapshots: 1 });
    expect(count(db)).toBe(65); expect(j.project(component)).toEqual({ kind: 'unavailable', reason: 'history-packet-limit' });
    expect(j.cursor(source)?.offset).toBe(101);
  }));
  it('validates the whole serialized batch before mutating packet evidence or its cursor', () => memory((db, j) => {
    const tampered = JSON.parse(packet()); tampered.sessionId = 'private-marker';
    expect(j.ingest(batch([item(), item(JSON.stringify(tampered))]))).toEqual({ kind: 'refused', reason: 'packet-refused', packetIndex: 1 });
    expect(count(db)).toBe(0); expect(j.cursor(source)).toBeNull();
    let getterCalls = 0;
    expect(j.ingest({ get records() { getterCalls++; throw Error('private-marker'); } })).toEqual({ kind: 'refused', reason: 'batch-string-required' });
    expect(getterCalls).toBe(0);
    expect(j.ingest(' '.repeat(MAX_COUNT_JOURNAL_BATCH_LENGTH + 1))).toMatchObject({ reason: 'batch-too-large' });
    expect(j.ingest(batch(new Array(MAX_COUNT_JOURNAL_BATCH_RECORDS + 1).fill(item())))).toMatchObject({ reason: 'batch-invalid' });
    for (const input of ['private-marker', batch([], { extra: true }), batch([], { offset: Number.MAX_SAFE_INTEGER + 1 }), batch([], { sourceKey: 'private-marker' })]) {
      const result = j.ingest(input); expect(result).toMatchObject({ kind: 'refused', reason: 'batch-invalid' }); expect(JSON.stringify(result)).not.toContain('private-marker');
    }
  }));
  it('refuses backward cursors and requires an explicit generation reset while preserving old evidence', () => memory((db, j) => {
    j.ingest(batch());
    expect(j.ingest(batch([item(packet(10))], { offset: 99 }))).toEqual({ kind: 'refused', reason: 'cursor-backwards' });
    expect(j.ingest(batch([item(packet(10))], { epochSha: key('new-epoch'), offset: 0 }))).toEqual({ kind: 'refused', reason: 'cursor-epoch-conflict' });
    expect(count(db)).toBe(1); expect(j.cursor(source)).toEqual({ epochSha: epoch, offset: 100 });
    expect(j.ingest(batch([item(packet(10))], { epochSha: key('new-epoch'), offset: 0, resetEpoch: true }))).toMatchObject({ kind: 'committed', insertedSnapshots: 1 });
    expect(count(db)).toBe(2); expect(j.cursor(source)).toEqual({ epochSha: key('new-epoch'), offset: 0 });
    expect(value(j)).toBe(17);
  }));
  it('rolls back both snapshot inserts and cursor advancement on a later SQLite failure', () => memory((db, j) => {
    j.ingest(batch());
    db.exec("CREATE TRIGGER private_failure BEFORE UPDATE ON count_journal_cursors BEGIN SELECT RAISE(ABORT,'private-marker'); END");
    expect(j.ingest(batch([item(packet(10))], { offset: 101 }))).toEqual({ kind: 'refused', reason: 'storage-refused' });
    expect(count(db)).toBe(1); expect(j.cursor(source)?.offset).toBe(100); expect(value(j)).toBe(9);
    expect(db.isTransaction).toBe(false);
  }));
  it('never rolls back a transaction owned by the caller during create, open or ingest refusal', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE foreign_work (n INTEGER); BEGIN; INSERT INTO foreign_work VALUES (1)');
      expect(() => CountJournal.create(db)).toThrow(CountJournalError);
      expect(db.isTransaction).toBe(true); expect(db.prepare('SELECT n FROM foreign_work').get()?.n).toBe(1);
      db.exec('ROLLBACK; DROP TABLE foreign_work');
      const j = CountJournal.create(db); db.exec('BEGIN');
      expect(() => CountJournal.open(db)).toThrow(CountJournalError);
      expect(j.ingest(batch())).toMatchObject({ kind: 'refused', reason: 'storage-refused' });
      expect(() => j.cursor(source)).toThrow(CountJournalError);
      expect(j.project(component)).toEqual({ kind: 'unavailable', reason: 'stored-evidence-unavailable' });
      expect(db.isTransaction).toBe(true); db.exec('ROLLBACK');
    } finally { db.close(); }
  });
  it('refuses an unrelated existing schema and leaves its contents intact', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE foreign_work (n INTEGER); INSERT INTO foreign_work VALUES (7)');
      const before = db.prepare('SELECT * FROM sqlite_schema').all();
      expect(() => CountJournal.create(db)).toThrow(CountJournalError); expect(() => CountJournal.open(db)).toThrow(CountJournalError);
      expect(db.prepare('SELECT * FROM sqlite_schema').all()).toEqual(before); expect(db.prepare('SELECT n FROM foreign_work').get()?.n).toBe(7);
    } finally { db.close(); }
  });
  it('refuses schema/version tampering and unexpected triggers before reopening', () => memory((db) => {
    db.prepare('UPDATE count_journal_meta SET version=?').run('private-marker');
    expect(() => CountJournal.open(db)).toThrow(CountJournalError);
    db.prepare('UPDATE count_journal_meta SET version=?').run('tokenelo/local-count-journal@v0');
    db.exec('CREATE VIEW unexpected AS SELECT * FROM count_journal_meta');
    expect(() => CountJournal.open(db)).toThrow(CountJournalError); db.exec('DROP VIEW unexpected');
    db.exec("CREATE TRIGGER unexpected AFTER INSERT ON count_journal_snapshots BEGIN SELECT 1; END");
    expect(() => CountJournal.open(db)).toThrow(CountJournalError);
  }));
  it('refuses corrupted persisted packets and provides fixed storage errors for closed handles', () => memory((db, j) => {
    j.ingest(batch());
    db.prepare('UPDATE count_journal_snapshots SET packet_json=?').run(packet(4));
    expect(j.project(component)).toEqual({ kind: 'unavailable', reason: 'stored-evidence-unavailable' });
  }));
  it('sanitizes failures from closed handles and rejects unsafe storage settings', () => {
    const db = new DatabaseSync(':memory:'), j = CountJournal.create(db); db.close();
    expect(j.ingest(batch())).toEqual({ kind: 'refused', reason: 'storage-refused' });
    expect(j.project(component)).toEqual({ kind: 'unavailable', reason: 'stored-evidence-unavailable' });
    try { j.cursor(source); throw Error('Expected refusal'); } catch (e) {
      expect(e).toBeInstanceOf(CountJournalError); expect((e as Error).message).toBe('Count journal unavailable'); expect((e as Error).stack).toBeUndefined();
    }
    const other = new DatabaseSync(':memory:');
    try { other.exec('PRAGMA synchronous=OFF'); expect(() => CountJournal.create(other)).toThrow(CountJournalError); expect(other.prepare('SELECT COUNT(*) AS n FROM sqlite_schema').get()?.n).toBe(0); } finally { other.close(); }
  });
});
