import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PREFIX_CHUNK_BYTES, type CodexPrefixWitness } from '../../src/core/codex-prefix-witness.js';
import { isUnownedCodexContextState } from '../../src/core/codex-context-recovery.js';
import type { IngestState, TokeneloDb } from '../../src/core/types.js';
import { configureCurrentEventBasis } from '../../src/store/event-basis.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { StubValuationEngine, StubPricingEngine, makeEvent } from './stubs.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const SID = '01a00000-1111-7111-8111-111111111111';
const CLAIM = { host: 'A2000', sessionId: SID } as const;
const RECEIPT_PREFIX = 'tokenelo/codex-context-checkpoint@v1:';

function unownedState(sessionId = SID): Record<string, unknown> {
  return {
    v: 1,
    lineIndex: 12,
    sessionId,
    meta: { id: sessionId },
    ownTurnStarted: false,
    ownTurnSeen: false,
    hasRecords: false,
    pending: [],
    responseIds: [],
    summary: { ownBillableEmitted: 0, ownTotalDerived: 0, records: 0 },
  };
}

/** Synthetic structure only; these hashes are not claims about file bytes. */
function syntheticWitness(bytes: number, ino: number): CodexPrefixWitness {
  return {
    v: 1,
    bytes,
    chunks: Array(Math.floor(bytes / CODEX_PREFIX_CHUNK_BYTES)).fill('a'.repeat(64)),
    tail: 'b'.repeat(64),
    object: { dev: '1', ino: String(ino), birthNs: '1' },
    establishedAt: 1_800_000_000_000,
    readBytes: 0,
  };
}

function cursor(extra: unknown = unownedState(), patch: Partial<IngestState> = {}): IngestState {
  const size = patch.size ?? 128;
  const ino = Object.hasOwn(patch, 'ino') ? patch.ino : size > 128 ? 88 : 77;
  const state: IngestState = {
    key: 'C:/owned/rollout-test.jsonl', size: 128, mtimeMs: 1_800_000_000_000.25, offset: 128, ino: 77, extra, ...patch, ino,
  };
  if (state.extra && typeof state.extra === 'object' && !Array.isArray(state.extra)) {
    const boundExtra = { ...state.extra as Record<string, unknown> };
    const sessionId = typeof boundExtra.sessionId === 'string' ? boundExtra.sessionId : SID;
    boundExtra.meta ??= { id: sessionId };
    boundExtra.consumedPrefix ??= syntheticWitness(state.offset, Number.isSafeInteger(state.ino) ? state.ino! : 77);
    state.extra = boundExtra;
  }
  return state;
}

function newLedger(db: TokeneloDb): SqliteLedger {
  return new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
}

function ownedLedgerFixture(): { db: TokeneloDb; ledger: SqliteLedger; close: () => void } {
  const db = openDb({ file: ':memory:' });
  return { db, ledger: newLedger(db), close: () => db.close() };
}

function sourceBasisFixture(): { db: InstanceType<typeof DatabaseSync>; ledger: SqliteLedger; close: () => void } {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE main.events(id TEXT NOT NULL,session_id TEXT,host TEXT,source TEXT);
    CREATE TABLE main.event_projection(id TEXT NOT NULL,session_id TEXT,host TEXT,source TEXT);
    CREATE TABLE main.event_projection_basis(singleton INTEGER PRIMARY KEY CHECK(singleton=1),policy INTEGER NOT NULL);
    INSERT INTO main.event_projection_basis VALUES(1,7);
    CREATE TABLE main.event_interpretation_history(history_id INTEGER PRIMARY KEY,id TEXT NOT NULL,session_id TEXT,host TEXT,source TEXT);
    CREATE TABLE main.event_route_reports(event_id TEXT,source TEXT,component_index INTEGER,model TEXT,speed TEXT,kind TEXT,evidence TEXT);
    CREATE TABLE main.activity(id INTEGER PRIMARY KEY,source TEXT,session_id TEXT,uuid TEXT,host TEXT);
    CREATE TABLE main.ingest_state(key TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime_ms REAL NOT NULL,offset INTEGER NOT NULL,ino INTEGER,extra_json TEXT);
    CREATE TABLE main.meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `);
  configureCurrentEventBasis(db as unknown as TokeneloDb);
  return { db, ledger: newLedger(db as unknown as TokeneloDb), close: () => db.close() };
}

function tableSnapshot(db: TokeneloDb): Record<string, unknown[]> {
  return {
    retainedEvents: db.prepare('SELECT rowid,* FROM main.events ORDER BY rowid').all(),
    currentEvents: db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all(),
    interpretationHistory: db.prepare('SELECT rowid,* FROM main.event_interpretation_history ORDER BY rowid').all(),
    activity: db.prepare('SELECT rowid,* FROM main.activity ORDER BY rowid').all(),
    limits: db.prepare('SELECT rowid,* FROM main.limits ORDER BY rowid').all(),
    sequences: db.prepare('SELECT name,seq FROM main.sqlite_sequence ORDER BY name').all(),
  };
}

describe('Codex context checkpoint storage gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires affirmative ownership flags, zero accounting, and empty deferred state', () => {
    const good = unownedState();
    expect(isUnownedCodexContextState(good, SID)).toBe(true);
    const mutations: Array<(x: Record<string, unknown>) => void> = [
      x => { x.ownTurnStarted = undefined; },
      x => { delete x.ownTurnSeen; },
      x => { x.ownTurnSeen = true; },
      x => { x.sessionId = 'other'; },
      x => { (x.summary as Record<string, unknown>).ownBillableEmitted = undefined; },
      x => { (x.summary as Record<string, unknown>).ownTotalDerived = 1; },
      x => { (x.summary as Record<string, unknown>).records = 1; },
      x => { delete (x.summary as Record<string, unknown>).records; },
      x => { delete x.hasRecords; },
      x => { x.hasRecords = true; },
      x => { delete x.pending; },
      x => { x.pending = [{}]; },
      x => { delete x.responseIds; },
      x => { x.responseIds = ['response']; },
      x => { x.emittedAhead = undefined; },
      x => { x.limitsById = { codex: {} }; },
      x => { x.lastLimits = undefined; },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(good);
      mutate(candidate);
      expect(isUnownedCodexContextState(candidate, SID)).toBe(false);
    }
  });

  it.each([
    ['retained main.events', (db: InstanceType<typeof DatabaseSync>) => db.prepare('INSERT INTO main.events(id,session_id,host,source) VALUES(?,?,?,?)').run(`codex:${SID}:17`, 'other-session', 'OtherHost', 'other-source')],
    ['current event projection', (db: InstanceType<typeof DatabaseSync>) => db.prepare('INSERT INTO events(id,session_id,host,source) VALUES(?,?,?,?)').run(`CoDeX:${SID.toUpperCase()}:18`, 'other-session', 'OtherHost', 'other-source')],
    ['prior interpretation history', (db: InstanceType<typeof DatabaseSync>) => db.prepare('INSERT INTO main.event_interpretation_history(id,session_id,host,source) VALUES(?,?,?,?)').run('unrelated', SID, 'OtherHost', 'other-source')],
    ['activity session id', (db: InstanceType<typeof DatabaseSync>) => db.prepare('INSERT INTO main.activity(source,session_id,uuid,host) VALUES(?,?,?,?)').run('other-source', SID, 'unrelated-mark', 'OtherHost')],
    ['activity uuid prefix', (db: InstanceType<typeof DatabaseSync>) => db.prepare('INSERT INTO main.activity(source,session_id,uuid,host) VALUES(?,?,?,?)').run('other-source', 'other-session', `CoDeX:${SID.toUpperCase()}:19`, 'OtherHost')],
  ])('holds when %s already has an owner', (_label, seed) => {
    const fixture = sourceBasisFixture();
    try {
      const prior = cursor();
      fixture.ledger.setState(prior);
      seed(fixture.db);
      const stateBefore = fixture.ledger.getState(prior.key);
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, cursor(unownedState(), { size: 256, offset: 256 }), CLAIM)).toBe(false);
      expect(fixture.ledger.getState(prior.key)).toEqual(stateBefore);
      expect(fixture.db.prepare('SELECT key FROM main.meta WHERE key LIKE ?').all(`${RECEIPT_PREFIX}%`)).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('refuses relocation and any stale or non-byte-identical cursor snapshot', () => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor();
      fixture.ledger.setState(prior);
      const next = cursor(unownedState(), { size: 256, offset: 256 });
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, { ...next, key: `${next.key}.moved` }, CLAIM)).toBe(false);

      for (const patch of [
        { size: prior.size + 1 },
        { mtimeMs: prior.mtimeMs + 1 },
        { offset: prior.offset - 1 },
        { ino: prior.ino! + 1 },
        { extra: { ...unownedState(), lineIndex: 13 } },
      ]) {
        expect(fixture.ledger.recoverCodexContextCheckpoint({ ...prior, ...patch }, next, CLAIM)).toBe(false);
      }
      fixture.db.prepare('UPDATE main.ingest_state SET offset=? WHERE key=?').run(prior.offset - 1, prior.key);
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(false);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it.each([
    ['missing prior meta', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = { ...candidate.prior.extra as Record<string, unknown> }; delete extra.meta;
      candidate.prior = { ...candidate.prior, extra };
    }],
    ['wrong prior meta id', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.prior = { ...candidate.prior, extra: { ...candidate.prior.extra as Record<string, unknown>, meta: { id: 'other-session' } } };
    }],
    ['missing next meta', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = { ...candidate.next.extra as Record<string, unknown> }; delete extra.meta;
      candidate.next = { ...candidate.next, extra };
    }],
    ['wrong next meta id', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.next = { ...candidate.next, extra: { ...candidate.next.extra as Record<string, unknown>, meta: { id: 'other-session' } } };
    }],
    ['missing prior witness', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = { ...candidate.prior.extra as Record<string, unknown> }; delete extra.consumedPrefix;
      candidate.prior = { ...candidate.prior, extra };
    }],
    ['missing next witness', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = { ...candidate.next.extra as Record<string, unknown> }; delete extra.consumedPrefix;
      candidate.next = { ...candidate.next, extra };
    }],
    ['malformed next witness', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.next = { ...candidate.next, extra: { ...candidate.next.extra as Record<string, unknown>, consumedPrefix: { v: 1, bytes: 256, chunks: 'bad' } } };
    }],
    ['prior witness offset mismatch', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = candidate.prior.extra as Record<string, unknown>, witness = extra.consumedPrefix as CodexPrefixWitness;
      candidate.prior = { ...candidate.prior, extra: { ...extra, consumedPrefix: { ...witness, bytes: witness.bytes + 1 } } };
    }],
    ['next witness offset mismatch', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = candidate.next.extra as Record<string, unknown>, witness = extra.consumedPrefix as CodexPrefixWitness;
      candidate.next = { ...candidate.next, extra: { ...extra, consumedPrefix: { ...witness, bytes: witness.bytes - 1 } } };
    }],
    ['prior witness inode mismatch', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = candidate.prior.extra as Record<string, unknown>, witness = extra.consumedPrefix as CodexPrefixWitness;
      candidate.prior = { ...candidate.prior, extra: { ...extra, consumedPrefix: { ...witness, object: { ...witness.object, ino: '78' } } } };
    }],
    ['next witness inode mismatch', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = candidate.next.extra as Record<string, unknown>, witness = extra.consumedPrefix as CodexPrefixWitness;
      candidate.next = { ...candidate.next, extra: { ...extra, consumedPrefix: { ...witness, object: { ...witness.object, ino: '89' } } } };
    }],
    ['missing prior inode', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.prior = { ...candidate.prior, ino: undefined };
    }],
    ['missing next inode', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.next = { ...candidate.next, ino: undefined };
    }],
    ['empty prior prefix', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      const extra = candidate.prior.extra as Record<string, unknown>;
      candidate.prior = { ...candidate.prior, offset: 0, extra: { ...extra, consumedPrefix: syntheticWitness(0, 77) } };
    }],
    ['next cursor not at end of file', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.next = { ...candidate.next, size: candidate.next.size + 1 };
    }],
    ['noncanonical claim UUID', (candidate: { prior: IngestState; next: IngestState; claim: { host: string; sessionId: string } }) => {
      candidate.claim.sessionId = 'session:with:colons';
    }],
  ])('rejects structurally unbound checkpoint evidence: %s', (_label, mutate) => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor();
      const next = cursor(unownedState(), { size: 256, offset: 256 });
      fixture.ledger.setState(prior);
      const candidate = { prior, next, claim: { ...CLAIM } };
      mutate(candidate);
      expect(fixture.ledger.recoverCodexContextCheckpoint(candidate.prior, candidate.next, candidate.claim)).toBe(false);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('accepts a partial prior cursor only when its witness remains bound and the next cursor reaches EOF', () => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor(unownedState(), { size: 256, offset: 128, ino: 77 });
      const next = cursor(unownedState(), { size: 256, offset: 256, ino: 88 });
      fixture.ledger.setState(prior);
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('matches the exact witness inode through fswalk.safeIno modulo reduction', () => {
    const fixture = ownedLedgerFixture();
    try {
      const base = cursor();
      const baseNext = cursor(unownedState(), { size: 256, offset: 256 });
      const priorRawIno = BigInt(Number.MAX_SAFE_INTEGER) * 2n + 77n;
      const nextRawIno = BigInt(Number.MAX_SAFE_INTEGER) * 3n + 88n;
      const priorExtra = base.extra as Record<string, unknown>, priorWitness = priorExtra.consumedPrefix as CodexPrefixWitness;
      const nextExtra = baseNext.extra as Record<string, unknown>, nextWitness = nextExtra.consumedPrefix as CodexPrefixWitness;
      const prior = { ...base, extra: { ...priorExtra, consumedPrefix: { ...priorWitness,
        object: { ...priorWitness.object, ino: priorRawIno.toString() } } } };
      const next = { ...baseNext, extra: { ...nextExtra, consumedPrefix: { ...nextWitness,
        object: { ...nextWitness.object, ino: nextRawIno.toString() } } } };
      fixture.ledger.setState(prior);
      expect(prior.ino).toBe(Number(priorRawIno % BigInt(Number.MAX_SAFE_INTEGER)));
      expect(next.ino).toBe(Number(nextRawIno % BigInt(Number.MAX_SAFE_INTEGER)));
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it.each([
    ['size', 'size'],
    ['mtime', 'mtime_ms'],
    ['offset', 'offset'],
    ['ino', 'ino'],
    ['raw extra_json', 'extra_json'],
  ] as const)('refuses a stored cursor race on %s', (_label, column) => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor();
      fixture.ledger.setState(prior);
      const changed = column === 'size' ? prior.size + 1
        : column === 'mtime_ms' ? prior.mtimeMs + 1
          : column === 'offset' ? prior.offset - 1
            : column === 'ino' ? prior.ino! + 1
              : JSON.stringify({ ...unownedState(), lineIndex: 13 });
      fixture.db.prepare(`UPDATE main.ingest_state SET ${column}=? WHERE key=?`).run(changed, prior.key);
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, cursor(unownedState(), { size: 256, offset: 256 }), CLAIM)).toBe(false);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('fails closed when persisted extra_json is not byte-identical to the passed state', () => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor();
      fixture.ledger.setState(prior);
      fixture.db.prepare('UPDATE main.ingest_state SET extra_json=? WHERE key=?').run(` ${JSON.stringify(prior.extra)}`, prior.key);
      const normalized = fixture.ledger.getState(prior.key)!;
      expect(normalized.extra).toEqual(prior.extra);
      expect(fixture.ledger.recoverCodexContextCheckpoint(normalized, cursor(unownedState(), { size: 256, offset: 256 }), CLAIM)).toBe(false);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('commits only one cursor update and a typed append-only receipt while preserving historical rows', () => {
    const fixture = ownedLedgerFixture();
    try {
      fixture.ledger.upsertEvents([makeEvent({ id: 'unrelated-event', sessionId: 'other-session', inputFresh: 20, output: 3 })]);
      fixture.ledger.recordActivity([{ source: 'claude', sessionId: 'other-session', ts: 90, uuid: 'unrelated-mark', host: 'M4a' }]);
      fixture.ledger.recordLimits({ source: 'codex', host: 'A2000', capturedAt: 123, windows: [], estimate: false });
      fixture.db.prepare("INSERT INTO main.meta(key,value) VALUES('fixture-preserved','verbatim')").run();
      const priorExtra = { ...unownedState(), contextCheckpointReceiptId: 'older-receipt' };
      const prior = cursor(priorExtra);
      fixture.ledger.setState(prior);
      const rawBefore = fixture.db.prepare(`SELECT rowid AS rowid,key,size,mtime_ms,offset,ino,extra_json,
        typeof(rowid) AS rowid_type,typeof(key) AS key_type,typeof(size) AS size_type,typeof(mtime_ms) AS mtime_type,
        typeof(offset) AS offset_type,typeof(ino) AS ino_type,typeof(extra_json) AS extra_type
        FROM main.ingest_state WHERE key=?`).get(prior.key) as Record<string, unknown>;
      const historyBefore = tableSnapshot(fixture.db);
      const metaBefore = fixture.db.prepare('SELECT key,value FROM main.meta ORDER BY key').all();
      const next = cursor(unownedState(), { size: 256, mtimeMs: 1_800_000_000_123.5, offset: 256, ino: 88 });
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_999);

      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(true);

      const afterState = fixture.ledger.getState(prior.key)!;
      expect(afterState).toMatchObject({ size: next.size, mtimeMs: next.mtimeMs, offset: next.offset, ino: next.ino });
      const receiptId = (afterState.extra as Record<string, string>).contextCheckpointReceiptId;
      expect(receiptId.startsWith(RECEIPT_PREFIX)).toBe(true);
      expect(receiptId.slice(RECEIPT_PREFIX.length)).toMatch(/^[a-f0-9]{64}$/);
      const { contextCheckpointReceiptId: _receiptPointer, ...remainingExtra } = afterState.extra as Record<string, unknown>;
      expect(remainingExtra).toEqual(next.extra);
      const receiptRow = fixture.db.prepare('SELECT key,value FROM main.meta WHERE key=?').get(receiptId) as { key: string; value: string };
      const receipt = JSON.parse(receiptRow.value) as Record<string, unknown>;
      expect(receipt).toMatchObject({ version: 1, kind: 'codex-context-checkpoint-recovery', recordedAtMs: 1_800_000_000_999, claim: CLAIM });
      expect(receipt.priorCursor).toMatchObject({
        rowid: { type: 'integer' }, key: { type: 'text', value: prior.key }, size: { type: 'integer', decimal: String(rawBefore.size) },
        mtime_ms: { type: 'real', ieee754Hex: expect.any(String) }, offset: { type: 'integer', decimal: String(rawBefore.offset) },
        ino: { type: 'integer', decimal: String(rawBefore.ino) }, extra_json: { type: 'text', value: rawBefore.extra_json },
      });
      expect(receipt.priorExtraJson).toBe(JSON.stringify(prior.extra));
      expect(receipt.nextCursor).toMatchObject({
        key: { type: 'text', value: next.key }, size: { type: 'integer', decimal: String(next.size) },
        offset: { type: 'integer', decimal: String(next.offset) },
        extra_json_before_receipt_pointer: { type: 'text', value: JSON.stringify(next.extra) },
      });
      expect(fixture.db.prepare('SELECT rowid FROM main.ingest_state WHERE key=?').get(prior.key)).toEqual({ rowid: rawBefore.rowid });
      expect(tableSnapshot(fixture.db)).toEqual(historyBefore);
      const metaAfter = fixture.db.prepare('SELECT key,value FROM main.meta ORDER BY key').all();
      expect(metaAfter.filter((row: { key: string }) => !String(row.key).startsWith(RECEIPT_PREFIX))).toEqual(metaBefore);
      expect(metaAfter).toHaveLength(metaBefore.length + 1);
      expect(fixture.db.prepare('SELECT value FROM main.meta WHERE key=?').get('fixture-preserved')).toEqual({ value: 'verbatim' });
    } finally {
      fixture.close();
    }
  });

  it('holds a NULL inode because no prefix witness can be structurally bound to that cursor', () => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor(unownedState(), { ino: undefined });
      fixture.ledger.setState(prior);
      const next = cursor(unownedState(), { size: 256, offset: 256, ino: undefined });
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(false);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it.each(['ABORT', 'IGNORE'] as const)('rolls the cursor CAS back if the receipt insert fails with RAISE(%s)', failure => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor();
      fixture.ledger.setState(prior);
      fixture.db.exec(`CREATE TRIGGER reject_context_checkpoint_receipt BEFORE INSERT ON main.meta
        WHEN NEW.key LIKE '${RECEIPT_PREFIX}%'
        BEGIN SELECT RAISE(${failure}${failure === 'ABORT' ? ",'injected receipt failure'" : ''}); END`);
      expect(() => fixture.ledger.recoverCodexContextCheckpoint(prior, cursor(unownedState(), { size: 256, offset: 256 }), CLAIM))
        .toThrow(failure === 'ABORT' ? /injected receipt failure/ : /receipt append did not insert/);
      expect(fixture.ledger.getState(prior.key)).toEqual(prior);
      expect(fixture.db.prepare('SELECT COUNT(*) AS n FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`)).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it('refuses a deterministic receipt-key collision without overwriting the receipt or cursor', () => {
    const fixture = ownedLedgerFixture();
    try {
      const prior = cursor();
      const next = cursor(unownedState(), { size: 256, offset: 256 });
      fixture.ledger.setState(prior);
      vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_999);
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(true);
      const saved = fixture.db.prepare('SELECT key,value FROM main.meta WHERE key LIKE ?').get(`${RECEIPT_PREFIX}%`) as { key: string; value: string };

      fixture.ledger.setState(prior);
      expect(fixture.ledger.recoverCodexContextCheckpoint(prior, next, CLAIM)).toBe(false);
      expect(fixture.db.prepare('SELECT key,value FROM main.meta WHERE key=?').get(saved.key)).toEqual(saved);
      expect(fixture.ledger.getState(prior.key)).toEqual(prior);
    } finally {
      fixture.close();
    }
  });
});
