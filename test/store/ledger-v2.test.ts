/**
 * SqliteLedger contract v0.2.1 additions (DESIGN §15.9.5/§15.9.6): reentrant transactions
 * (SAVEPOINT), recentEvents, NTFS-sized ino robustness, perf persistence, limitId.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, transactionDepth, withTransaction, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { safeIno, statSafe } from '../../src/collectors/fswalk.js';
import { StubPricingEngine, StubValuationEngine, makeEvent } from './stubs.js';
import type { CodexFieldStateEvidence, UsageEvent } from '../../src/core/types.js';

/** A2000's real NTFS file id (DESIGN §15.9.6, types.ts note) — > 2^53. */
const NTFS_INO = 9851624185066820n;
const MOD = 2n ** 53n - 1n;

let db: TokeneloDb;
let ledger: SqliteLedger;

beforeEach(() => {
  db = openDb({ file: ':memory:' });
  ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
});

afterEach(() => {
  db.close();
});

const count = (): number => (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;

function codexFieldState(inputState: CodexFieldStateEvidence['fields']['input_tokens']): CodexFieldStateEvidence {
  return {
    schemaVersion: 1,
    source: 'token_count.info.total_token_usage',
    basis: 'counter-delta',
    priorPresence: 'unassessed',
    fields: {
      input_tokens: inputState,
      cached_input_tokens: 'reported-zero',
      cache_write_input_tokens: 'missing',
      output_tokens: 'reported-nonzero',
      reasoning_output_tokens: 'missing',
      total_tokens: 'reported-nonzero',
    },
  };
}

function codexEvent(id: string, evidence?: CodexFieldStateEvidence) {
  const event = makeEvent({ id, source: 'codex', sessionId: 'codex-session', model: 'gpt-6-luna', inputFresh: 10, cacheRead: 4, output: 3 });
  return {
    ...event,
    components: event.components.map(component => ({
      ...component,
      ...(evidence ? { codexFieldStateEvidence: evidence } : {}),
    })),
  };
}

function codexMisalignedEvent(id: string, evidence: CodexFieldStateEvidence, kind: 'model' | 'speed' | 'length'): UsageEvent {
  const event = codexEvent(id, evidence);
  if (kind === 'model') return {
    ...event,
    model: 'gpt-6-sol',
    components: event.components.map(component => ({ ...component, model: 'gpt-6-sol' })),
  };
  if (kind === 'speed') return {
    ...event,
    speed: 'fast',
    components: event.components.map(component => ({ ...component, speed: 'fast' })),
  };
  const component = event.components[0]!;
  return {
    ...event,
    components: [
      { ...component, tokens: { ...component.tokens, inputFresh: 4, cacheRead: 1, output: 1 } },
      { ...component, tokens: { ...component.tokens, inputFresh: 6, cacheRead: 3, output: 2 } },
    ],
  };
}

function persistedCodexRow(id: string) {
  return db.prepare(`SELECT rowid,components_json,input_fresh,cache_read,output,api_equiv_usd,price_status,
      price_version,ucu AS reserved_value,ucu_rate_status,eacs_def_sha256,count_quality,ucu_count_quality,count_policy,count_revision FROM events WHERE id=?`).get(id) as {
    rowid: number; components_json: string; input_fresh: number; cache_read: number; output: number;
    api_equiv_usd: number | null; price_status: string; price_version: string; reserved_value: number | null;
    ucu_rate_status: string; eacs_def_sha256: string; count_quality: string | null; ucu_count_quality: string | null;
    count_policy: string | null; count_revision: number | null;
  };
}

describe('Codex field-state evidence retention', () => {
  it('writes first-seen metadata once and ignores changed metadata on duplicate without refreshing valuation or cursor', () => {
    const id = 'codex:session:17';
    const cursor = { key: 'codex:fixture.jsonl', size: 100, mtimeMs: 10, offset: 100, ino: 7, extra: { lineIndex: 4, prevTotal: 17 } };
    ledger.setState(cursor);
    const firstEvidence = codexFieldState('reported-nonzero');
    expect(ledger.upsertEvents([codexEvent(id, firstEvidence)])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    const before = persistedCodexRow(id);
    const beforeCursor = ledger.getState(cursor.key);
    const beforeCount = count();
    const beforeMaxRowid = (db.prepare('SELECT MAX(rowid) AS rowid FROM events').get() as { rowid: number }).rowid;

    expect(ledger.upsertEvents([codexEvent(id, codexFieldState('invalid'))])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });

    const after = persistedCodexRow(id);
    expect(after.rowid).toBe(before.rowid);
    expect(after.components_json).toBe(before.components_json);
    expect(JSON.parse(after.components_json)[0].codexFieldStateEvidence).toEqual(firstEvidence);
    expect({ ...after, components_json: undefined }).toEqual({ ...before, components_json: undefined });
    expect([after.count_quality, after.ucu_count_quality, after.count_policy, after.count_revision]).toEqual([null, null, null, null]);
    expect(ledger.getEvents({}).find(event => event.id === id)?.components[0]?.codexFieldStateEvidence).toEqual(firstEvidence);
    expect(ledger.getState(cursor.key)).toEqual(beforeCursor);
    expect(count()).toBe(beforeCount);
    expect((db.prepare('SELECT MAX(rowid) AS rowid FROM events').get() as { rowid: number }).rowid).toBe(beforeMaxRowid);
  });

  it('does not backfill field-state evidence onto a Codex row first stored by the legacy writer', () => {
    const id = 'codex:legacy-session:8';
    const original = codexEvent(id);
    ledger.upsertEvents([original]);
    const before = persistedCodexRow(id);
    ledger.upsertEvents([codexEvent(id, codexFieldState('reported-zero'))]);
    const after = persistedCodexRow(id);
    expect(JSON.parse(after.components_json)[0].codexFieldStateEvidence).toBeUndefined();
    expect(after.rowid).toBe(before.rowid);
    expect(after.api_equiv_usd).toBeCloseTo(before.api_equiv_usd!, 12);
    expect(after.reserved_value).toBeCloseTo(before.reserved_value!, 12);
  });

  it.each(['model', 'speed', 'length'] as const)('strips component evidence across a %s mismatch and keeps it stripped on repeat', kind => {
    const id = `codex:misaligned-${kind}:3`;
    const cursor = { key: `codex:${kind}.jsonl`, size: 12, mtimeMs: 4, offset: 12, ino: 3, extra: { opaque: true } };
    ledger.setState(cursor);
    const first = codexEvent(id, codexFieldState('reported-nonzero'));
    ledger.upsertEvents([first]);
    const before = persistedCodexRow(id);
    const beforeEvent = ledger.getEvents({}).find(event => event.id === id)!;
    const beforeCursor = ledger.getState(cursor.key);
    const beforeMaxRowid = (db.prepare('SELECT MAX(rowid) AS rowid FROM events').get() as { rowid: number }).rowid;

    const mismatched = codexMisalignedEvent(id, codexFieldState('invalid'), kind);
    const firstMerge = ledger.upsertEvents([mismatched]);
    expect(firstMerge).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const after = persistedCodexRow(id);
    const afterEvent = ledger.getEvents({}).find(event => event.id === id)!;
    expect(afterEvent.flags).toContain('mergedComponentsMisaligned');
    expect(afterEvent.components.length).toBe(kind === 'length' ? 2 : 1);
    expect(afterEvent.components.every(component => component.codexFieldStateEvidence === undefined)).toBe(true);
    expect(JSON.parse(after.components_json).every((component: { codexFieldStateEvidence?: unknown }) => component.codexFieldStateEvidence === undefined)).toBe(true);
    expect(afterEvent.tokens).toEqual(beforeEvent.tokens);
    expect(after.rowid).toBe(before.rowid);
    expect(after.api_equiv_usd).toBeCloseTo(before.api_equiv_usd!, 12);
    expect(after.price_status).toBe(before.price_status);
    expect(after.price_version).toBe(before.price_version);
    expect(after.reserved_value).toBeCloseTo(before.reserved_value!, 12);
    expect(after.ucu_rate_status).toBe(before.ucu_rate_status);
    expect(after.eacs_def_sha256).toBe(before.eacs_def_sha256);
    expect(ledger.getState(cursor.key)).toEqual(beforeCursor);
    expect(count()).toBe(1);
    expect((db.prepare('SELECT MAX(rowid) AS rowid FROM events').get() as { rowid: number }).rowid).toBe(beforeMaxRowid);

    expect(ledger.upsertEvents([codexMisalignedEvent(id, codexFieldState('reported-zero'), kind)])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    const repeated = persistedCodexRow(id);
    const repeatedEvent = ledger.getEvents({}).find(event => event.id === id)!;
    expect(repeated.components_json).toBe(after.components_json);
    expect(repeatedEvent.flags).toContain('mergedComponentsMisaligned');
    expect(repeatedEvent.components.every(component => component.codexFieldStateEvidence === undefined)).toBe(true);
    expect(repeated.api_equiv_usd).toBeCloseTo(before.api_equiv_usd!, 12);
    expect(repeated.reserved_value).toBeCloseTo(before.reserved_value!, 12);
  });
});

describe('reentrant transaction (SAVEPOINT)', () => {
  it('upsertEvents and recordActivity work inside ledger.transaction (they open nested transactions themselves)', () => {
    ledger.transaction(() => {
      ledger.upsertEvents([makeEvent({ id: 'a', inputFresh: 1, output: 1 })]);
      ledger.recordActivity([{ source: 'claude', sessionId: 's', ts: 1, uuid: 'u1', host: 'M4a' }]);
      ledger.setState({ key: 'k', size: 1, mtimeMs: 1, offset: 1 });
      expect(transactionDepth(db)).toBe(1);
    });
    expect(transactionDepth(db)).toBe(0);
    expect(count()).toBe(1);
    expect(ledger.getState('k')?.offset).toBe(1);
  });

  it('an outer failure rolls back everything, including committed-looking nested work', () => {
    expect(() =>
      ledger.transaction(() => {
        ledger.upsertEvents([makeEvent({ id: 'a', inputFresh: 1, output: 1 })]);
        ledger.setState({ key: 'k', size: 1, mtimeMs: 1, offset: 1 });
        throw new Error('outer boom');
      })
    ).toThrow('outer boom');
    expect(count()).toBe(0);
    expect(ledger.getState('k')).toBeUndefined();
    expect(transactionDepth(db)).toBe(0);
  });

  it('a nested failure rolls back ONLY its savepoint; the outer transaction continues and commits', () => {
    ledger.transaction(() => {
      ledger.upsertEvents([makeEvent({ id: 'keep', inputFresh: 1, output: 1 })]);
      expect(() =>
        ledger.transaction(() => {
          ledger.upsertEvents([makeEvent({ id: 'drop', inputFresh: 1, output: 1 })]);
          throw new Error('inner boom');
        })
      ).toThrow('inner boom');
      expect(transactionDepth(db)).toBe(1);
      ledger.upsertEvents([makeEvent({ id: 'after', inputFresh: 1, output: 1 })]);
    });
    expect(ledger.getEvents({}).map((e) => e.id).sort()).toEqual(['after', 'keep']);
  });

  it('three levels deep: innermost rollback keeps levels 1 and 2', () => {
    withTransaction(db, () => {
      db.exec(`INSERT INTO meta (key, value) VALUES ('l1', '1')`);
      withTransaction(db, () => {
        db.exec(`INSERT INTO meta (key, value) VALUES ('l2', '2')`);
        try {
          withTransaction(db, () => {
            db.exec(`INSERT INTO meta (key, value) VALUES ('l3', '3')`);
            expect(transactionDepth(db)).toBe(3);
            throw new Error('l3');
          });
        } catch {
          // swallowed on purpose
        }
      });
    });
    const keys = (db.prepare(`SELECT key FROM meta WHERE key LIKE 'l_' ORDER BY key`).all() as Array<{ key: string }>).map(
      (r) => r.key
    );
    expect(keys).toEqual(['l1', 'l2']);
  });

  it('an upsert batch failing inside an outer transaction rolls back only that batch', () => {
    class Throwing extends StubPricingEngine {
      override priceEvent(e: Parameters<StubPricingEngine['priceEvent']>[0]) {
        if (e.components.some((c) => c.model === 'THROW')) throw new Error('boom');
        return super.priceEvent(e);
      }
    }
    const l2 = new SqliteLedger(db, new Throwing(), new StubValuationEngine());
    l2.transaction(() => {
      l2.upsertEvents([makeEvent({ id: 'ok', inputFresh: 1, output: 1 })]);
      expect(() =>
        l2.upsertEvents([makeEvent({ id: 'x1', inputFresh: 1, output: 1 }), makeEvent({ id: 'x2', inputFresh: 1, output: 1, model: 'THROW' })])
      ).toThrow('boom');
    });
    expect(l2.getEvents({}).map((e) => e.id)).toEqual(['ok']);
  });
});

describe('recentEvents(source, sinceTs, untilTs)', () => {
  it('returns only that source, ts in the inclusive window, ascending, with derived fields', () => {
    ledger.upsertEvents([
      makeEvent({ id: 'p1', source: 'ollama-proxy', ts: 100, inputFresh: 1, output: 5 }),
      makeEvent({ id: 'p2', source: 'ollama-proxy', ts: 300, inputFresh: 1, output: 6 }),
      makeEvent({ id: 'p0', source: 'ollama-proxy', ts: 99, inputFresh: 1, output: 7 }),
      makeEvent({ id: 'p3', source: 'ollama-proxy', ts: 301, inputFresh: 1, output: 8 }),
      makeEvent({ id: 'c1', source: 'claude', ts: 200, inputFresh: 1, output: 9 }),
    ]);
    const got = ledger.recentEvents('ollama-proxy', 100, 300);
    expect(got.map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(got[0]!.tokens.output).toBe(5);
    expect(got[0]!.apiEquivUsd).toBe(0.006); // stub: (1+5)/1000 × $1
  });
});

describe('ingest_state ino robustness (A2000 NTFS ids > 2^53)', () => {
  it('reproduces the failure mode: a raw > 2^53 INTEGER is unreadable by node:sqlite in number mode', () => {
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino) VALUES ('raw', 1, 1, 1, ?)`).run(NTFS_INO);
    expect(() => db.prepare(`SELECT ino FROM ingest_state WHERE key = 'raw'`).get()).toThrow(RangeError);
  });

  it('getState reads a legacy row holding the raw NTFS id instead of throwing, reduced to the safe form', () => {
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json) VALUES ('legacy', 10, 5.5, 7, ?, '{"a":1}')`).run(
      NTFS_INO
    );
    const st = ledger.getState('legacy');
    expect(st).toEqual({ key: 'legacy', size: 10, mtimeMs: 5.5, offset: 7, ino: Number(NTFS_INO % MOD), extra: { a: 1 } });
    expect(Number.isSafeInteger(st!.ino)).toBe(true);
    // hand-computed: 9851624185066820 − 9007199254740991 = 844424930325829
    expect(st!.ino).toBe(844424930325829);
  });

  it('setState preserves an already reduced safe ino on round trip', () => {
    ledger.setState({ key: 'f', size: 1, mtimeMs: 1, offset: 1, ino: safeIno(NTFS_INO) });
    const st = ledger.getState('f')!;
    expect(Number.isSafeInteger(st.ino)).toBe(true);
    expect(st.ino).toBe(844_424_930_325_829);
    // A raw read in plain number mode must not throw any more.
    expect(() => db.prepare(`SELECT ino FROM ingest_state WHERE key = 'f'`).get()).not.toThrow();
  });

  it('rejects invalid cursor writes before SQL and preserves the prior row and fractional mtime', () => {
    const prior = { key: 'cursor', size: 10, mtimeMs: 5.5, offset: 7, ino: 42, extra: { held: true } };
    ledger.setState(prior);
    const before = ledger.getState(prior.key);
    const invalid = [
      { ...prior, size: Number.MAX_SAFE_INTEGER + 1 },
      { ...prior, offset: Number.MAX_SAFE_INTEGER + 1 },
      { ...prior, offset: 7.5 },
      { ...prior, offset: 11 },
      { ...prior, ino: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const state of invalid) {
      expect(() => ledger.setState(state)).toThrow(/invalid ingest_state cursor/);
      expect(ledger.getState(prior.key)).toEqual(before);
    }
    expect(ledger.getState(prior.key)?.mtimeMs).toBe(5.5);
  });

  it('rejects unsupported legacy outer size and offset values instead of substituting zero or rounded Numbers', () => {
    const tooLarge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('unsafe-size', tooLarge, 5.5, 1, 9, '{"historyIncomplete":true}');
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('unsafe-offset', Number.MAX_SAFE_INTEGER, 5.5, tooLarge, 9, '{"historyIncomplete":true}');
    db.prepare(`INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('fractional-size', 10.5, 5.5, 1, 9, '{"historyIncomplete":true}');

    for (const key of ['unsafe-size', 'unsafe-offset', 'fractional-size']) {
      expect(() => ledger.getState(key)).toThrow('invalid ingest_state cursor');
    }
  });

  it('collectors store safeIno(bigint): the A2000 id maps to 844424930325829, safe ids are unchanged', () => {
    expect(safeIno(NTFS_INO)).toBe(844424930325829);
    expect(safeIno(12345n)).toBe(12345);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-ino-'));
    try {
      const f = path.join(dir, 'x.jsonl');
      fs.writeFileSync(f, 'abc');
      const s = statSafe(f);
      expect(s.size).toBe(3);
      expect(Number.isSafeInteger(s.ino)).toBe(true);
      expect(s.ino).toBe(safeIno(fs.statSync(f, { bigint: true }).ino));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('perf + limitId persistence', () => {
  it('UsageEvent.perf round-trips through upsertEvents/getEvents', () => {
    const e = makeEvent({ id: 'o', source: 'ollama-proxy', inputFresh: 1, output: 1 });
    e.perf = { decodeTokPerSec: 42.5, prefillTokPerSec: 900 };
    ledger.upsertEvents([e]);
    expect(ledger.getEvents({})[0]!.perf).toEqual({ decodeTokPerSec: 42.5, prefillTokPerSec: 900 });
    const plain = makeEvent({ id: 'p', inputFresh: 1, output: 1 });
    ledger.upsertEvents([plain]);
    expect(ledger.getEvents({ source: 'claude' })[0]!.perf).toBeUndefined();
  });

  it('recordLimits stores limitId', () => {
    ledger.recordLimits({ source: 'codex', limitId: 'codex_bengalfox', host: 'A2000', capturedAt: 5, windows: [], estimate: false });
    expect((db.prepare('SELECT limit_id FROM limits').get() as { limit_id: string }).limit_id).toBe('codex_bengalfox');
  });
});
