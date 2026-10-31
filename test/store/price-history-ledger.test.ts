/**
 * Price history: what a ledger row keeps when "today's" price table changes (2026-10-18).
 *
 * Real SqliteLedger and real PricingEngine, built from the FABRICATED pinned tables in
 * test/fixtures/price-history-2026-10-18/ (see its README). Three synthetic rows are priced in the "old" world,
 * then the price table changes ("today"). Every expected number is derived by hand in the comments; none is
 * read back from the code under test.
 *
 * A stored price keeps the dollars, status and table version it was recorded with, and an explicit reprice is
 * the only refresh. These cases pin that rule for the ledger and for a read. They do not measure anything
 * or look at a real ledger.
 *
 * Hand arithmetic for the three rows (rates are per million tokens, from the pinned fixture files):
 *   L  local weights model, in 3,000 / out 1,000.   price: local row is $0 at every column  -> $0, LIST.
 *   H  hosted model, in 100,000 / 5m write 20,000 / 1h write 10,000 / cache read 400,000 / out 50,000.
 *      old price  = 100,000*2 + 20,000*2.5 + 10,000*4 + 400,000*0.2 + 50,000*10
 *                 = 200,000 + 50,000 + 40,000 + 80,000 + 500,000 = 870,000 / 1e6 = $0.87
 *      today (x1.5 on every column) = $1.305
 *   N  hosted model that exists only in today's price table, in 1,000 / out 1,000.
 *      old: no price row -> UNPRICED (null, not zero).
 *      today: 1,000*1 + 1,000*5 = 6,000 / 1e6 = $0.006 LIST.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceRowsVersion } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { repriceLedger } from '../../src/cli/index.js';
import { getPaths } from '../../src/daemon/paths.js';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';
import type { UsageEvent } from '../../src/core/types.js';
import { NOW, PINNED, buildWorld, economics, synthConfig, synthEvent, type World } from '../helpers/price-history-world.js';

const old = buildWorld('old');
const today = buildWorld('today');

const LOCAL = () => synthEvent({ id: 'hist:local', model: 'synth-local-a', provider: 'local', thinking: false,
  tokens: { inputFresh: 3000, output: 1000 } });
const HOSTED = () => synthEvent({ id: 'hist:hosted', model: 'synth-hosted', provider: 'anthropic', source: 'claude', thinking: false,
  tokens: { inputFresh: 100_000, cacheWrite5m: 20_000, cacheWrite1h: 10_000, cacheRead: 400_000, output: 50_000 }, component: { speed: 'standard' } });
const NEWMODEL = () => synthEvent({ id: 'hist:new-model', model: 'synth-new-model', provider: 'anthropic', source: 'claude', thinking: false,
  tokens: { inputFresh: 1000, output: 1000 }, component: { speed: 'standard' } });
const seedEvents = () => [LOCAL(), HOSTED(), NEWMODEL()];

const dbs: TokeneloDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A memory ledger priced entirely by the old world; `later` writes through the pricing of another world. */
function seededMemory() {
  const db = openDb({ file: ':memory:' }); dbs.push(db);
  const first = new SqliteLedger(db, old.pricing, createNullEngine());
  first.upsertEvents(seedEvents());
  const byId = (ledger: SqliteLedger) => Object.fromEntries(ledger.getEvents({}).map(e => [e.id, e]));
  return { db, first, byId, later: (w = today) => new SqliteLedger(db, w.pricing, createNullEngine()) };
}
const rawRows = (db: TokeneloDb) => db.prepare('SELECT rowid AS rid, * FROM events ORDER BY rowid').all();
function withTokens(e: UsageEvent, patch: Partial<UsageEvent['tokens']>): UsageEvent {
  const copy = structuredClone(e);
  copy.tokens = { ...copy.tokens, ...patch };
  copy.components[0].tokens = { ...copy.components[0].tokens, ...patch };
  return copy;
}

describe('fixture self-check: the pinned worlds are what the hand arithmetic assumes', () => {
  it('table versions equal the pinned literals, and the two worlds differ', () => {
    expect(priceRowsVersion(old.priceRows)).toBe(PINNED.oldPriceVersion);
    expect(priceRowsVersion(today.priceRows)).toBe(PINNED.todayPriceVersion);
    expect(PINNED.oldPriceVersion).not.toBe(PINNED.todayPriceVersion);
  });
});

describe('values recorded in the old world (hand-computed)', () => {
  it('stores USD, price status and price version exactly as derived', () => {
    const { first, byId } = seededMemory();
    const rows = byId(first);
    expect(economics(rows['hist:local'])).toMatchObject({
      apiEquivUsd: 0, priceStatus: 'LIST', priceVersion: PINNED.oldPriceVersion, provider: 'local', // local weights row: $0 list rate
    });
    expect(rows['hist:hosted'].apiEquivUsd).toBeCloseTo(0.87, 12);
    expect(economics(rows['hist:hosted'])).toMatchObject({ priceStatus: 'LIST', priceVersion: PINNED.oldPriceVersion });
    // No price row in the old table: unknown dollars are null, not 0.
    expect(economics(rows['hist:new-model'])).toMatchObject({
      apiEquivUsd: null, priceStatus: 'UNPRICED', priceVersion: PINNED.oldPriceVersion,
    });
    expect(rows['hist:new-model'].flags).toContain('unpricedModel');
  });

  it('the stored price version identifies the table: resolving the stored components against it reproduces the stored dollars, today\'s table does not', () => {
    const { first, byId } = seededMemory();
    const h = byId(first)['hist:hosted'];
    expect(old.pricing.version).toBe(h.priceVersion);
    expect(old.pricing.priceEvent(h).usd).toBeCloseTo(h.apiEquivUsd!, 12);
    expect(today.pricing.version).not.toBe(h.priceVersion);
    expect(today.pricing.priceEvent(h).usd).toBeCloseTo(1.305, 12); // 870,000 * 1.5 / 1e6
  });
});

describe('after the price table changes, identical input keeps the stored price', () => {
  it('re-ingesting the same events through today\'s pricing is a no-op: every stored byte and rowid is unchanged', () => {
    const { db, first, byId, later } = seededMemory();
    const before = rawRows(db);
    const recorded = Object.values(byId(first)).map(economics);
    expect(later().upsertEvents(seedEvents())).toEqual({ inserted: 0, updated: 0, unchanged: 3 });
    expect(rawRows(db)).toEqual(before);
    expect(Object.values(byId(later())).map(economics)).toEqual(recorded);
  });

  it('replaying the exported rows is not a reprice either', () => {
    const { db, first, later } = seededMemory();
    const before = rawRows(db);
    const exported = first.getEvents({});
    expect(later().upsertEvents(exported)).toEqual({ inserted: 0, updated: 0, unchanged: 3 });
    expect(rawRows(db)).toEqual(before);
  });

  it('an unpriced row stays unpriced (null, UNPRICED, flagged) even though today\'s table now has a row for it', () => {
    const { later, byId } = seededMemory();
    later().upsertEvents(seedEvents());
    const n = byId(later())['hist:new-model'];
    expect(today.pricing.priceEvent(n).usd).toBeCloseTo(0.006, 12); // 1,000*1 + 1,000*5 = 6,000 / 1e6: what a reprice would record
    expect(n.apiEquivUsd).toBeNull();
    expect(n.apiEquivUsd).not.toBe(0);
    expect(n.priceStatus).toBe('UNPRICED');
    expect(n.priceVersion).toBe(PINNED.oldPriceVersion);
    expect(n.flags).toContain('unpricedModel');
  });
});

describe('what a read shows once today\'s price table is loaded (real getSummary)', () => {
  const dbsRead: TokeneloDb[] = [];
  afterEach(() => { for (const db of dbsRead.splice(0)) db.close(); });

  const T_READ = Date.UTC(2026, 8, 20, 12, 0, 0);
  /** Rows priced by `pricedBy`, read through queries built on `readBy`. */
  async function summaryOf(pricedBy: World, readBy: World) {
    const db = openDb({ file: ':memory:' }); dbsRead.push(db);
    new SqliteLedger(db, pricedBy.pricing, createNullEngine()).upsertEvents([
      synthEvent({ id: 'r:local', model: 'synth-local-a', provider: 'local', thinking: false, ts: T_READ, tokens: { inputFresh: 3000, output: 1000 } }),
      synthEvent({ id: 'r:hosted', model: 'synth-hosted', provider: 'anthropic', source: 'claude', thinking: false, ts: T_READ,
        tokens: { inputFresh: 100_000, cacheWrite5m: 20_000, cacheWrite1h: 10_000, cacheRead: 400_000, output: 50_000 }, component: { speed: 'standard' } }),
      // A local model with no price row in any world: unpriced, still local.
      synthEvent({ id: 'r:unpriced', model: 'synth-local-unpriced', provider: 'local', thinking: false, ts: T_READ, tokens: { inputFresh: 10, output: 10 } }),
    ]);
    const queries = createQueries(db, synthConfig(), { now: () => NOW, pricing: readBy.pricing,
      probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }) });
    return queries.getSummary('all');
  }

  it('the hosted row keeps its stored dollars ($0.87, not today\'s $1.305) and its stored price status', async () => {
    const s = await summaryOf(old, today);
    const hosted = s.byModel.find(m => m.model === 'synth-hosted')!;
    expect(hosted.apiEquivUsd).toBeCloseTo(0.87, 12);
    expect(hosted.priceStatus).toBe('LIST');
  });

  it('a local row with no price row is unpriced: dollars null, never 0', async () => {
    const s = await summaryOf(old, today);
    const unpriced = s.byModel.find(m => m.model === 'synth-local-unpriced')!;
    expect(unpriced.apiEquivUsd).toBeNull();
    expect(unpriced.priceStatus).toBe('UNPRICED');
  });
});

describe('explicit reprice is the only refresh, on a disposable temp-dir ledger', () => {
  function tempLedger() {
    const parent = process.env.TMPDIR ?? os.tmpdir();
    const root = fs.mkdtempSync(path.join(parent, 'tokenelo-price-history-')); dirs.push(root);
    expect(path.resolve(root).startsWith(path.resolve(parent) + path.sep)).toBe(true);
    const paths = getPaths({ env: { TOKENELO_HOME: root } });
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const db = openDb({ file: paths.dbFile });
    new SqliteLedger(db, old.pricing, createNullEngine()).upsertEvents(seedEvents());
    const rows = (d: TokeneloDb) => d.prepare('SELECT rowid AS rid, * FROM events ORDER BY rowid').all() as Record<string, unknown>[];
    const before = rows(db);
    db.close();
    return { paths, before, rows };
  }

  it('refreshes USD, status and version, and keeps ids, rowids and counts', () => {
    const { paths, before, rows } = tempLedger();
    const result = repriceLedger(paths, today.pricing, createNullEngine());
    expect(result).toMatchObject({ inserted: 0, updated: 3, unchanged: 0, tokensChanged: 0, countQualityChanged: 0, providerChanged: 0,
      priceVersionChanged: 3,
      usdChanged: 2,        // hosted 0.87 -> 1.305, new-model null -> 0.006; local stays $0
      priceStatusChanged: 1 // new-model UNPRICED -> LIST
    });
    const db = openDb({ file: paths.dbFile, readOnly: true });
    try {
      const after = rows(db);
      expect(after.map(r => [r.rid, r.id])).toEqual(before.map(r => [r.rid, r.id]));
      for (const [i, r] of after.entries()) {
        for (const k of ['input_fresh', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output', 'reasoning', 'model', 'host', 'ts']) expect(r[k]).toBe(before[i][k]);
        expect(r.price_version).toBe(PINNED.todayPriceVersion);
      }
      const byId = Object.fromEntries(after.map(r => [r.id as string, r]));
      expect(byId['hist:local']).toMatchObject({ api_equiv_usd: 0, price_status: 'LIST' });
      expect(byId['hist:hosted']).toMatchObject({ price_status: 'LIST' });
      expect(byId['hist:hosted'].api_equiv_usd as number).toBeCloseTo(1.305, 12);
      expect(byId['hist:new-model']).toMatchObject({ price_status: 'LIST' });
      expect(byId['hist:new-model'].api_equiv_usd as number).toBeCloseTo(0.006, 12);
    } finally { db.close(); }
  });

  it('takes a backup first, and the backup still holds every old value', () => {
    const { paths, before, rows } = tempLedger();
    const result = repriceLedger(paths, today.pricing, createNullEngine());
    expect(result.backup).toMatch(/^tokenelo-pre-reprice-.*\.sqlite$/);
    const backupFile = path.join(paths.dataDir, 'backups', result.backup!);
    expect(fs.existsSync(backupFile)).toBe(true);
    const backup = openDb({ file: backupFile, readOnly: true });
    try {
      const saved = rows(backup);
      expect(saved.map(r => r.price_version)).toEqual([PINNED.oldPriceVersion, PINNED.oldPriceVersion, PINNED.oldPriceVersion]);
      expect(saved.map(r => r.api_equiv_usd)).toEqual([0, before[1].api_equiv_usd, null]);
      expect(saved.map(r => [r.rid, r.id])).toEqual(before.map(r => [r.rid, r.id]));
    } finally { backup.close(); }
  });

  it('is idempotent: a second reprice under the same pricing changes nothing (and still takes its own backup)', () => {
    const { paths } = tempLedger();
    const first = repriceLedger(paths, today.pricing, createNullEngine());
    const second = repriceLedger(paths, today.pricing, createNullEngine());
    expect(second).toMatchObject({ updated: 0, unchanged: 3, usdChanged: 0, priceVersionChanged: 0 });
    expect(second.backup).not.toBe(first.backup);
    expect(fs.readdirSync(path.join(paths.dataDir, 'backups'))).toHaveLength(2);
  });
});

// Late thinking or effort evidence is deliberately NOT asserted here. On the current base it revalues a frozen row at today's
// price table although no price column depends on either (finding PM-06, still reproducing). A test that pinned the wrong
// behaviour would hide the finding, and a test that demanded the right behaviour would fail on the base.
describe('late evidence for an existing id', () => {
  it('a smaller later snapshot (fewer output tokens) changes nothing', () => {
    const { db, later } = seededMemory();
    const before = rawRows(db);
    expect(later().upsertEvents([withTokens(LOCAL(), { output: 10 })])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(rawRows(db)).toEqual(before);
  });

  it('attribution-only evidence (a project label) updates the row but keeps its recorded price', () => {
    const { first, later, byId } = seededMemory();
    const recorded = economics(byId(first)['hist:hosted']);
    expect(later().upsertEvents([{ ...HOSTED(), project: 'synthetic-project' }])).toMatchObject({ updated: 1, unchanged: 0 });
    const after = byId(later())['hist:hosted'];
    expect(after.project).toBe('synthetic-project');
    expect(economics(after)).toEqual(recorded);
  });

  it('documented design: a later higher count is a new measurement and reprices the WHOLE row at the table in force when it arrives', () => {
    // ledger.ts header: per-field MAX, then derived fields are recomputed for changed measurement inputs.
    // Output 50,000 -> 60,000 on the hosted row. Today's price: 100,000*3 + 20,000*3.75 + 10,000*6 + 400,000*0.3 + 60,000*15
    //   = 300,000 + 75,000 + 60,000 + 120,000 + 900,000 = 1,455,000 / 1e6 = $1.455.
    // The frozen basis would have given 0.87 + 10,000*10/1e6 = $0.97; the earlier basis is replaced, not kept beside it.
    const { first, later, byId } = seededMemory();
    expect(later().upsertEvents([withTokens(HOSTED(), { output: 60_000 })])).toMatchObject({ updated: 1 });
    const after = byId(later())['hist:hosted'];
    expect(after.tokens.output).toBe(60_000);
    expect(after.apiEquivUsd).toBeCloseTo(1.455, 12);
    expect(after.priceVersion).toBe(PINNED.todayPriceVersion);
    expect(byId(first)['hist:hosted'].apiEquivUsd).toBeCloseTo(1.455, 12); // same database: one row, one price
  });
});
