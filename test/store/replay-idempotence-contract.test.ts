/**
 * Contract tests for REPLAY and IDEMPOTENT RE-INGEST at the ledger boundary (src/store/ledger.ts), driven by
 * the shapes the collectors and the metering proxy really produce. They add what the existing ledger tests do
 * not pin:
 *   - a proxy-metered request is counted exactly once however often its event is replayed, while two separate
 *     requests with identical content are two events (identity is the request, never the content);
 *   - duplicates inside ONE batch and growth within a batch follow MAX, never a sum;
 *   - a failed collector transaction (events plus cursor) leaves nothing behind, and replaying the corrected
 *     work converges to exactly the state a clean run reaches, then stays put;
 *   - the fabricated native-counter shapes in test/fixtures/claude-cloud-2026-10-17/structure-only.json:
 *     an identical snapshot is not a new observation, separate observations are kept (not collapsed, not
 *     summed), and contradictory observations are held (conflict) instead of being resolved or priced;
 *   - replayed route reports are not duplicated, and a later incompatible report is kept alongside the first.
 *
 * Fabricated counters and ids only; in-memory databases; an in-process fake upstream for the proxy cases.
 * Stub pricing and valuation-seam engines make every expected number hand-computable: this proves replay mechanics,
 * not prices, valuations or any collector's real-file behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { captureNativeCounters, mergeNativeCounters, nativeCounterProjection, type NativeCounterEvidence } from '../../src/measurement/native-counter-evidence.js';
import { buildOllamaUsageEvent } from '../../src/collectors/ollama-proxy.js';
import type { UsageEvent } from '../../src/core/types.js';
import { makeEvent, StubValuationEngine, StubPricingEngine } from './stubs.js';
import { nativeFinal, send, startRig } from '../helpers/proxy-contract-rig.js';

const FIXTURE = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'claude-cloud-2026-10-17', 'structure-only.json'), 'utf8')) as {
  nativeCounterShapes: { case: string; rawSnapshots?: Record<string, number>[] }[];
};
const shape = (name: string) => FIXTURE.nativeCounterShapes.find(s => s.case === name)!;

let open: TokeneloDb[] = [];
afterEach(() => { for (const db of open) db.close(); open = []; });
function fresh(pricing: StubPricingEngine = new StubPricingEngine()) {
  const db = openDb({ file: ':memory:' }); open.push(db);
  return { db, ledger: new SqliteLedger(db, pricing, new StubValuationEngine()) };
}
const rows = (db: TokeneloDb) => db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all();

/** An Ollama-proxy event for a fabricated native report; `id` fixed so that two reports are two observations of one request. */
function nativeEvent(id: string, evidence: NativeCounterEvidence): UsageEvent {
  return { ...buildOllamaUsageEvent({ host: 'SYNTH', model: 'synthetic-model', ts: 1_790_000_000_000, requestStartNs: 1n, entrypoint: 'synth',
    tokens: nativeCounterProjection(evidence), nativeCounterEvidence: evidence }), id };
}

describe('proxy-metered requests', () => {
  it('replaying a real proxy event any number of times leaves one row with the original bytes and counts', async () => {
    const rig = await startRig({ upstream: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(nativeFinal({ prompt_eval_count: 18, prompt_eval_cached_count: 13, eval_count: 8 })); } });
    try {
      await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: { 'content-type': 'application/json' }, body: '{"model":"synthetic-model","stream":false}' });
      await rig.proxy.close();
    } finally { await rig.stop(); }
    expect(rig.events).toHaveLength(1);
    const { db, ledger } = fresh();
    expect(ledger.upsertEvents([structuredClone(rig.events[0]!)])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    const before = rows(db);
    for (let i = 0; i < 3; i++) expect(ledger.upsertEvents([structuredClone(rig.events[0]!)])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(rows(db)).toEqual(before);
    expect(ledger.getEvents({})).toHaveLength(1);
    expect(ledger.getEvents({})[0]!.tokens).toMatchObject({ inputFresh: 5, cacheRead: 13, output: 8, countQuality: 'complete' });
  });

  it('two requests with identical content, time and start stamp are two events with distinct ids, and both are counted', async () => {
    const rig = await startRig({ proxyDeps: { now: () => 1_790_000_000_000, hrnow: () => 5n },
      upstream: (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(nativeFinal()); } });
    try {
      for (let i = 0; i < 2; i++) await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: { 'content-type': 'application/json' }, body: '{"model":"synthetic-model","stream":false}' });
      await rig.proxy.close();
    } finally { await rig.stop(); }
    expect(rig.events).toHaveLength(2);
    const [a, b] = rig.events as [UsageEvent, UsageEvent];
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('ollama:SYNTH:5:') && b.id.startsWith('ollama:SYNTH:5:')).toBe(true);
    const { ledger } = fresh();
    expect(ledger.upsertEvents([a, b])).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    const total = ledger.getEvents({}).reduce((sum, e) => ({ input: sum.input + e.tokens.inputFresh, output: sum.output + e.tokens.output }), { input: 0, output: 0 });
    expect(total).toEqual({ input: 14, output: 6 }); // 2 x (7, 3): never collapsed by content
  });
});

describe('one batch, one transaction', () => {
  it('duplicates and growth inside a single batch follow MAX: counted once, never summed, never shrunk', () => {
    const { ledger } = fresh();
    const at = (output: number) => makeEvent({ id: 'dup', inputFresh: 100, output });
    expect(ledger.upsertEvents([at(10), at(10), at(50), at(30)])).toEqual({ inserted: 1, updated: 1, unchanged: 2 });
    const stored = ledger.getEvents({});
    expect(stored).toHaveLength(1);
    expect(stored[0]!.tokens).toMatchObject({ inputFresh: 100, output: 50 });
    expect(stored[0]!.apiEquivUsd).toBeCloseTo(0.15, 9); // stub: (100 + 50) tokens at $1 per 1000
  });

  it('a failed events-plus-cursor transaction leaves nothing behind, and replaying the corrected work converges exactly once to a clean run', () => {
    class ThrowingPricing extends StubPricingEngine {
      override priceEvent(e: Parameters<StubPricingEngine['priceEvent']>[0]) {
        if (e.components.some(c => c.model === 'THROW')) throw new Error('boom');
        return super.priceEvent(e);
      }
    }
    const good1 = makeEvent({ id: 'c1', inputFresh: 10, output: 5 });
    const poisoned = makeEvent({ id: 'c2', inputFresh: 20, output: 7, model: 'THROW' });
    const corrected = makeEvent({ id: 'c2', inputFresh: 20, output: 7 });
    const cursor = { key: 'synthetic-file', size: 300, mtimeMs: 1, offset: 300 };
    const snapshot = (db: TokeneloDb) => db.prepare('SELECT id,input_fresh,output,api_equiv_usd,price_version FROM events ORDER BY id').all();

    const failing = fresh(new ThrowingPricing());
    expect(() => failing.ledger.transaction(() => { failing.ledger.upsertEvents([good1, poisoned]); failing.ledger.setState(cursor); })).toThrow('boom');
    expect(failing.ledger.getEvents({})).toHaveLength(0);
    expect(failing.ledger.getState(cursor.key)).toBeUndefined(); // the cursor did not advance past work that was not stored

    // Recovery: the same collector pass is replayed from the old cursor.
    const replay = () => failing.ledger.transaction(() => { const r = failing.ledger.upsertEvents([good1, corrected]); failing.ledger.setState(cursor); return r; });
    expect(replay()).toEqual({ inserted: 2, updated: 0, unchanged: 0 });
    const afterRecovery = snapshot(failing.db);
    expect(replay()).toEqual({ inserted: 0, updated: 0, unchanged: 2 });
    expect(snapshot(failing.db)).toEqual(afterRecovery);
    expect(failing.ledger.getState(cursor.key)).toMatchObject({ offset: 300 });

    const clean = fresh();
    clean.ledger.upsertEvents([good1, corrected]);
    expect(afterRecovery).toEqual(snapshot(clean.db));
  });
});

describe('native counter snapshots (fabricated shapes from structure-only.json)', () => {
  const [first, second] = shape('same-native-snapshot-replayed').rawSnapshots!;

  it('an identical snapshot is not a new observation: one snapshot, same totals, same stored row', () => {
    expect(first).toEqual(second);
    expect(mergeNativeCounters(captureNativeCounters(first!), captureNativeCounters(second!))!.snapshots).toHaveLength(1);
    const { db, ledger } = fresh();
    ledger.upsertEvents([nativeEvent('native-1', captureNativeCounters(first!))]);
    const before = rows(db);
    expect(ledger.upsertEvents([nativeEvent('native-1', captureNativeCounters(second!))])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(rows(db)).toEqual(before);
    const stored = ledger.getEvents({})[0]!;
    expect(stored.components[0]!.nativeCounterEvidence!.snapshots).toHaveLength(1);
    expect(stored.tokens).toMatchObject({ inputFresh: 22, cacheRead: 8, output: 6, countQuality: 'complete' }); // 30 gross - 8 cached
  });

  it('separate observations are both kept and combined by MAX, not collapsed and not summed, in either arrival order', () => {
    const [one, two] = shape('separate-native-observations-are-not-collapsed').rawSnapshots!;
    for (const order of [[one!, two!], [two!, one!]]) {
      const { ledger } = fresh();
      ledger.upsertEvents([nativeEvent('native-2', captureNativeCounters(order[0]!))]);
      expect(ledger.upsertEvents([nativeEvent('native-2', captureNativeCounters(order[1]!))]).updated).toBe(1);
      const stored = ledger.getEvents({});
      expect(stored).toHaveLength(1);
      expect(stored[0]!.components[0]!.nativeCounterEvidence!.snapshots).toHaveLength(2);
      // MAX per counter: gross 19, cached 7, output 5. A sum would give 29 / 7 / 7.
      expect(stored[0]!.tokens).toMatchObject({ inputFresh: 12, cacheRead: 7, output: 5, countQuality: 'complete' });
    }
  });

  it('contradictory observations are held as a conflict in either arrival order: no winner chosen, no price, no valuation value', () => {
    const up = { prompt_eval_count: 19, prompt_eval_cached_count: 0, eval_count: 2 };
    const down = { prompt_eval_count: 10, prompt_eval_cached_count: 0, eval_count: 5 }; // prompt lower, output higher
    for (const order of [[up, down], [down, up]]) {
      const { ledger } = fresh();
      for (const raw of order) ledger.upsertEvents([nativeEvent('native-3', captureNativeCounters(raw))]);
      const stored = ledger.getEvents({})[0]!;
      expect(stored.tokens.countQuality).toBe('conflict');
      expect(stored.apiEquivUsd).toBeNull();
      expect(stored.reservedValue).toBeNull();
      expect(stored.components[0]!.nativeCounterEvidence!.snapshots).toHaveLength(2);
      // Replaying either observation again neither resolves nor worsens the hold.
      expect(ledger.upsertEvents([nativeEvent('native-3', captureNativeCounters(up))]).inserted).toBe(0);
      expect(ledger.getEvents({})[0]!.tokens.countQuality).toBe('conflict');
      expect(ledger.getEvents({})[0]!.apiEquivUsd).toBeNull();
    }
  });
});

describe('route reports under replay', () => {
  const routed = (route: NonNullable<UsageEvent['components'][number]['servingRoute']>): UsageEvent => {
    const e = makeEvent({ id: 'routed-1', inputFresh: 10, output: 5, source: 'qwen-code', model: 'qwen3:8b' });
    return { ...e, components: [{ ...e.components[0]!, servingRoute: route }] };
  };
  it('replayed reports are not duplicated, and a later incompatible report is retained beside the first and flagged', () => {
    const { db, ledger } = fresh();
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM event_route_reports').get() as { n: number }).n;
    for (let i = 0; i < 3; i++) ledger.upsertEvents([routed({ kind: 'hosted', evidence: 'qwen-oauth' })]);
    expect(count()).toBe(1);
    ledger.upsertEvents([routed({ kind: 'local', evidence: 'metered-engine' })]);
    expect(count()).toBe(2);
    for (let i = 0; i < 2; i++) ledger.upsertEvents([routed({ kind: 'hosted', evidence: 'qwen-oauth' }), routed({ kind: 'local', evidence: 'metered-engine' })]);
    expect(count()).toBe(2);
    const stored = ledger.getEvents({});
    expect(stored).toHaveLength(1);
    expect(stored[0]!.flags).toContain('servingRouteConflict');
    expect(stored[0]!.tokens).toMatchObject({ inputFresh: 10, output: 5 }); // counts untouched by the route dispute
  });
});
