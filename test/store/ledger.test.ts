import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import {
  StubPricingEngine,
  StubValuationEngine,
  STUB_PRICE_VERSION,
  STUB_DEF_SHA256,
  makeEvent,
} from './stubs.js';

describe('SqliteLedger.upsertEvents', () => {
  let db: TokeneloDb;
  let ledger: SqliteLedger;

  beforeEach(() => {
    db = openDb({ file: ':memory:' });
    ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
  });

  afterEach(() => {
    db.close();
  });

  it('inserts a new event and recomputes derived fields from the stub engines (hand-computed)', () => {
    // inputFresh=1000, output=2000 -> priceEvent usd = (1000+2000)/1000 * $1 = $3
    // stub valuation tokens = inputFresh+cacheWrite5m+cacheWrite1h+output = 1000+0+0+2000 = 3000; /100 = 30 (seam test double)
    const event = makeEvent({ id: 'e1', inputFresh: 1000, output: 2000 });
    const result = ledger.upsertEvents([event]);
    expect(result).toEqual({ inserted: 1, updated: 0, unchanged: 0 });

    const [stored] = ledger.getEvents({ });
    expect(stored).toBeDefined();
    expect(stored.apiEquivUsd).toBeCloseTo(3.0, 9);
    expect(stored.reservedValue).toBeCloseTo(30.0, 9);
    expect(stored.priceStatus).toBe('LIST');
    expect(stored.priceVersion).toBe(STUB_PRICE_VERSION);
    expect(stored.ucuRateStatus).toBe('MEASURED');
    expect(stored.eacsDefSha256).toBe(STUB_DEF_SHA256);
    expect(stored.tokens).toEqual({
      inputFresh: 1000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 2000,
      reasoning: 0,
    });
  });

  it('re-upserting the identical event is a no-op: unchanged=1, values untouched', () => {
    const event = makeEvent({ id: 'e1', inputFresh: 1000, output: 2000 });
    ledger.upsertEvents([event]);
    const second = ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 1000, output: 2000 })]);
    expect(second).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  });

  it('per-field MAX on conflict: a larger output line raises output AND keeps/raises inputFresh via MAX (never a sum)', () => {
    // First line: a partial streaming snapshot.
    ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 500, output: 100 })]);
    // Second line: same message.id, later snapshot with more of everything.
    const result = ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 800, output: 900 })]);
    expect(result).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    const [stored] = ledger.getEvents({});
    // MAX(500,800)=800, MAX(100,900)=900 -- NOT a sum (500+800=1300, 100+900=1000).
    expect(stored.tokens.inputFresh).toBe(800);
    expect(stored.tokens.output).toBe(900);
    // usd = (800+900)/1000 * 1 = 1.7 ; stub valuation value = (800+900)/100 = 17
    expect(stored.apiEquivUsd).toBeCloseTo(1.7, 9);
    expect(stored.reservedValue).toBeCloseTo(17.0, 9);
  });

  it('"kept line" selection: components/model come from whichever row has the larger output, independent of the per-field token MAX', () => {
    // Stored line has the larger output (2000) and model A.
    ledger.upsertEvents([
      makeEvent({ id: 'e1', inputFresh: 100, output: 2000, model: 'model-A' }),
    ]);
    // Incoming line has SMALLER output (500) but LARGER inputFresh (900) and a different model
    // (simulating DESIGN §15.1.3's iteration/model-fallback case). Per spec: components_json (and
    // therefore `model`, since it lives on the kept component) must come from the STORED line
    // (larger output), while inputFresh must still be MAX'd up to 900.
    const result = ledger.upsertEvents([
      makeEvent({ id: 'e1', inputFresh: 900, output: 500, model: 'model-B' }),
    ]);
    expect(result).toEqual({ inserted: 0, updated: 1, unchanged: 0 });

    const [stored] = ledger.getEvents({});
    expect(stored.model).toBe('model-A'); // kept line = stored (2000 >= 500)
    expect(stored.components[0]?.model).toBe('model-A');
    expect(stored.tokens.output).toBe(2000); // MAX(2000,500)
    expect(stored.tokens.inputFresh).toBe(900); // MAX(100,900) -- still raised despite losing "kept line"
  });

  it('incoming wins the kept-line tie (incoming.output >= stored.output)', () => {
    ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 100, output: 500, model: 'model-A' })]);
    ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 100, output: 500, model: 'model-B' })]);
    const [stored] = ledger.getEvents({});
    expect(stored.model).toBe('model-B');
  });

  it('recomputes derived fields on a raise (apiEquivUsd and the seam\'s stored value strictly increase when tokens rise)', () => {
    ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 100, output: 100 })]);
    const before = ledger.getEvents({})[0]!;
    ledger.upsertEvents([makeEvent({ id: 'e1', inputFresh: 100, output: 5000 })]);
    const after = ledger.getEvents({})[0]!;
    expect(after.apiEquivUsd!).toBeGreaterThan(before.apiEquivUsd!);
    expect(after.reservedValue!).toBeGreaterThan(before.reservedValue!);
  });

  // ── thinking-mode merge (founder req. 2026-09-27): true > false > null, never last-write-wins ──

  it('round-trips thinking true/false/null unchanged for a single insert', () => {
    ledger.upsertEvents([makeEvent({ id: 't1', inputFresh: 1, output: 1, thinking: true })]);
    ledger.upsertEvents([makeEvent({ id: 't2', inputFresh: 1, output: 1, thinking: false })]);
    ledger.upsertEvents([makeEvent({ id: 't3', inputFresh: 1, output: 1 })]); // thinking omitted -> not determinable
    const rows = Object.fromEntries(ledger.getEvents({}).map((e) => [e.id, e]));
    expect(rows.t1!.thinking).toBe(true);
    expect(rows.t2!.thinking).toBe(false);
    expect(rows.t3!.thinking).toBeNull();
    expect(rows.t3!.flags).toContain('thinkingUnknown');
    expect(rows.t1!.flags).not.toContain('thinkingUnknown');
    expect(rows.t2!.flags).not.toContain('thinkingUnknown');
  });

  it('merge: a later line proving thinking=true wins over an earlier null (unknown), regardless of which line is "kept"', () => {
    // First line: smaller output (loses "kept line"), thinking unknown (null).
    ledger.upsertEvents([makeEvent({ id: 'm1', inputFresh: 100, output: 100 })]);
    // Second line: larger output (wins "kept line"), and now proves thinking=true.
    ledger.upsertEvents([makeEvent({ id: 'm1', inputFresh: 100, output: 900, thinking: true })]);
    const [stored] = ledger.getEvents({});
    expect(stored.thinking).toBe(true);
    expect(stored.flags).not.toContain('thinkingUnknown');
  });

  it('merge: true beats false — a later line proving thinking=false never erases an earlier true (MUTATION GUARD for "last write wins")', () => {
    ledger.upsertEvents([makeEvent({ id: 'm2', inputFresh: 100, output: 900, thinking: true })]);
    ledger.upsertEvents([makeEvent({ id: 'm2', inputFresh: 100, output: 100, thinking: false })]);
    const [stored] = ledger.getEvents({});
    // If the merge were "last write wins" (or "kept line wins", where the smaller-output false line
    // loses "kept line" but a naive merge still took its thinking value), this would be false/null
    // instead — a genuine reasoning event must never be downgraded by a later non-reasoning line for
    // the SAME message.id (a real scenario would be two streaming snapshots of one message, not two
    // independent reasoning decisions, so evidence-of-thinking must be sticky).
    expect(stored.thinking).toBe(true);
  });

  it('merge: false beats null — a verified non-thinking reading is never downgraded to unknown by an undetermined line', () => {
    ledger.upsertEvents([makeEvent({ id: 'm3', inputFresh: 100, output: 900, thinking: false })]);
    ledger.upsertEvents([makeEvent({ id: 'm3', inputFresh: 100, output: 950 })]); // thinking omitted (null)
    const [stored] = ledger.getEvents({});
    expect(stored.thinking).toBe(false);
    expect(stored.flags).not.toContain('thinkingUnknown');
  });

  it('recomputes the thinkingUnknown flag from the MERGED thinking value, never trusting a caller-supplied flag at face value', () => {
    // Line 1 (deliberately inconsistent input: thinking=true but a stale 'thinkingUnknown' flag
    // already in its array) is corrected on insert. Line 2 (kept: larger output, thinking omitted
    // -> null, no flag) then merges with the stored true -> merged thinking stays true, so the flag
    // must be absent on the final row even though line 2's own (raw, pre-merge) flags array had
    // nothing to say about it either way.
    ledger.upsertEvents([makeEvent({ id: 'm4', inputFresh: 10, output: 10, thinking: true, flags: ['thinkingUnknown'] })]);
    ledger.upsertEvents([makeEvent({ id: 'm4', inputFresh: 10, output: 900 })]); // kept line: thinking null, no flag set
    const [stored] = ledger.getEvents({});
    expect(stored.thinking).toBe(true);
    expect(stored.flags).not.toContain('thinkingUnknown');
  });

  it('processes a whole batch inside one transaction (all-or-nothing on error)', () => {
    // A pricing engine that throws for a specific poison-pill model, so the second event in the
    // batch fails mid-transaction; the first event's insert must roll back with it.
    class ThrowingPricingEngine extends StubPricingEngine {
      override priceEvent(e: Parameters<StubPricingEngine['priceEvent']>[0]) {
        if (e.components.some((c) => c.model === 'THROW')) throw new Error('boom');
        return super.priceEvent(e);
      }
    }
    const txLedger = new SqliteLedger(db, new ThrowingPricingEngine(), new StubValuationEngine());
    const good = makeEvent({ id: 'e1', inputFresh: 10, output: 10 });
    const bad = makeEvent({ id: 'e2', inputFresh: 10, output: 10, model: 'THROW' });

    expect(() => txLedger.upsertEvents([good, bad])).toThrow('boom');
    // The whole batch (including the earlier, individually-valid 'good' row) must roll back.
    expect(txLedger.getEvents({})).toHaveLength(0);
  });

  // ── Mutation-guard evidence (DESIGN §15.1.2: "first-seen-wins must fail; per-line sum must
  // fail") — both mutants below were actually applied to src/store/ledger.ts in this session,
  // run, observed failing, then reverted and re-verified green (not just asserted in comments):
  //
  //   MUTATION A — per-line-sum (maxTokens() summed instead of Math.max'd):
  //   `npx vitest run test/store/ledger.test.ts` -> 3 failed / 11 passed:
  //     - 'per-field MAX on conflict...': expected inputFresh 800, got 1300 (500+800)
  //     - 'kept line selection...': expected output 2000, got 2500 (2000+500)
  //     - 're-upserting the identical event is a no-op...': expected unchanged=1, got updated=1
  //       (summing a value with itself changes it, so "identical" input is no longer a no-op)
  //
  //   MUTATION B — first-seen-wins (`merged = storedRow ? rowToEvent(storedRow) : incoming`,
  //   i.e. once a row exists for an id, ignore every later line entirely):
  //   `npx vitest run test/store/ledger.test.ts` -> 4 failed / 10 passed:
  //     - 'per-field MAX on conflict...': expected updated=1, got unchanged=1 (nothing ever moves)
  //     - 'kept line selection...': expected updated=1, got unchanged=1
  //     - 'incoming wins the kept-line tie...': expected model 'model-B', got 'model-A'
  //     - 'recomputes derived fields on a raise...': expected apiEquivUsd to rise, got 0.2 === 0.2
  //
  // After each mutant, `cp /tmp/ledger.ts.bak src/store/ledger.ts` restored the correct file and
  // the full suite (`npx vitest run test/store test/config`) was re-run: 6 files, 45 passed.
});

describe('SqliteLedger activity/skipped/ingest_state', () => {
  let db: TokeneloDb;
  let ledger: SqliteLedger;

  beforeEach(() => {
    db = openDb({ file: ':memory:' });
    ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
  });

  afterEach(() => {
    db.close();
  });

  it('dedupes activity marks by (source, uuid) when uuid is present', () => {
    ledger.recordActivity([
      { source: 'claude', sessionId: 's1', ts: 1, uuid: 'u1', host: 'M4a' },
      { source: 'claude', sessionId: 's1', ts: 1, uuid: 'u1', host: 'M4a' }, // exact dup
      { source: 'claude', sessionId: 's1', ts: 2, uuid: 'u1', host: 'M4a' }, // same uuid, different ts -> still a dup key
    ]);
    const rows = db.prepare('SELECT * FROM activity').all();
    expect(rows).toHaveLength(1);
  });

  it('dedupes activity marks by (source, session_id, ts, kind) when uuid is absent', () => {
    ledger.recordActivity([
      { source: 'codex', sessionId: 's1', ts: 100, host: 'A2000', kind: 'turn' },
      { source: 'codex', sessionId: 's1', ts: 100, host: 'A2000', kind: 'turn' }, // dup
      { source: 'codex', sessionId: 's1', ts: 100, host: 'A2000', kind: 'tool' }, // different kind -> distinct
    ]);
    const rows = db.prepare('SELECT * FROM activity').all();
    expect(rows).toHaveLength(2);
  });

  it('recordSkipped increments count and bumps last_seen on repeat sightings', () => {
    ledger.recordSkipped('/some/path.jsonl', 'memory-vault');
    ledger.recordSkipped('/some/path.jsonl', 'memory-vault');
    ledger.recordSkipped('/some/path.jsonl', 'memory-vault');
    const row = db.prepare('SELECT * FROM skipped WHERE path = ?').get('/some/path.jsonl') as {
      count: number;
    };
    expect(row.count).toBe(3);
  });

  it('getState/setState round-trips IngestState including optional ino/extra', () => {
    expect(ledger.getState('missing-key')).toBeUndefined();
    ledger.setState({ key: 'f1', size: 123, mtimeMs: 456.7, offset: 89, ino: 42, extra: { foo: 'bar' } });
    expect(ledger.getState('f1')).toEqual({
      key: 'f1',
      size: 123,
      mtimeMs: 456.7,
      offset: 89,
      ino: 42,
      extra: { foo: 'bar' },
    });
    // Update in place.
    ledger.setState({ key: 'f1', size: 200, mtimeMs: 456.7, offset: 150 });
    const updated = ledger.getState('f1');
    expect(updated?.size).toBe(200);
    expect(updated?.offset).toBe(150);
    expect(updated?.ino).toBeUndefined();
  });
});

describe('SqliteLedger.getEvents filters', () => {
  let db: TokeneloDb;
  let ledger: SqliteLedger;

  beforeEach(() => {
    db = openDb({ file: ':memory:' });
    ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
    ledger.upsertEvents([
      makeEvent({ id: 'a', ts: 100, source: 'claude', inputFresh: 1, output: 1 }),
      makeEvent({ id: 'b', ts: 200, source: 'codex', inputFresh: 1, output: 1 }),
      makeEvent({ id: 'c', ts: 300, source: 'claude', inputFresh: 1, output: 1 }),
    ]);
  });

  afterEach(() => {
    db.close();
  });

  it('filters by source', () => {
    const rows = ledger.getEvents({ source: 'codex' });
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('filters by since/until (ordered ascending by ts)', () => {
    const rows = ledger.getEvents({ since: 150, until: 300 });
    expect(rows.map((r) => r.id)).toEqual(['b']);
  });

  it('iterateEvents yields the same rows as getEvents', () => {
    const viaGet = ledger.getEvents({});
    const viaIterate = [...ledger.iterateEvents({})];
    expect(viaIterate.map((r) => r.id)).toEqual(viaGet.map((r) => r.id));
  });
});
