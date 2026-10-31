import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { StubPricingEngine, makeEvent } from './stubs.js';

/**
 * The reserved valuation columns in this edition: a new row records an unknown value (never zero), no
 * definition and no rate selection; a row stored by another edition keeps its own values while its
 * measurement inputs are unchanged (an explicit reprice included) and withdraws them when an input changes.
 */
const HISTORICAL = { value: 123.5, status: 'MEASURED', def: 'ab'.repeat(32), rateKey: 'recorded-key', resolved: 'cd'.repeat(32) } as const;

interface ValuationRow {
  reserved_value: number | null; ucu_rate_status: string; eacs_def_sha256: string; rate_key: string | null; rate_resolved_sha256: string | null;
  api_equiv_usd: number | null; price_status: string;
}
const NOW = 1_800_000_000_000;

describe('neutral valuation seam in the ledger', () => {
  let db: TokeneloDb;
  let ledger: SqliteLedger;
  const row = (id: string) => db.prepare(
    'SELECT ucu AS reserved_value, ucu_rate_status, eacs_def_sha256, rate_key, rate_resolved_sha256, api_equiv_usd, price_status FROM events WHERE id = ?').get(id) as unknown as ValuationRow;
  /** Stores a row the way another edition would have: real values in every reserved column. */
  const plantHistoricalValuation = (id: string) => db.prepare(
    'UPDATE events SET ucu = ?, ucu_rate_status = ?, eacs_def_sha256 = ?, rate_key = ?, rate_resolved_sha256 = ? WHERE id = ?')
    .run(HISTORICAL.value, HISTORICAL.status, HISTORICAL.def, HISTORICAL.rateKey, HISTORICAL.resolved, id);

  beforeEach(() => {
    db = openDb({ file: ':memory:' });
    ledger = new SqliteLedger(db, new StubPricingEngine(), createNullEngine());
  });
  afterEach(() => { db.close(); });

  it('a new row records an unknown value, a NONE status, no definition and no selection, and is still priced', () => {
    ledger.upsertEvents([makeEvent({ id: 'new', inputFresh: 1000, output: 2000 })]);
    const stored = row('new');
    expect(stored.reserved_value).toBeNull();
    expect(stored.ucu_rate_status).toBe('NONE');
    expect(stored.eacs_def_sha256).toBe('');
    expect(stored.rate_key).toBeNull();
    expect(stored.rate_resolved_sha256).toBeNull();
    expect(stored.api_equiv_usd).toBeCloseTo(3, 9);
    expect(stored.price_status).toBe('LIST');
  });

  it('a stored historical row reads back unchanged, and replaying it unchanged writes nothing', () => {
    ledger.upsertEvents([makeEvent({ id: 'old', inputFresh: 1000, output: 2000 })]);
    plantHistoricalValuation('old');
    const before = row('old');
    const result = ledger.upsertEvents([makeEvent({ id: 'old', inputFresh: 1000, output: 2000 })]);
    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(row('old')).toEqual(before);
    const [read] = ledger.getEvents({});
    expect(read).toMatchObject({ reservedValue: HISTORICAL.value, ucuRateStatus: HISTORICAL.status, eacsDefSha256: HISTORICAL.def,
      rateKey: HISTORICAL.rateKey, rateResolvedSha256: HISTORICAL.resolved });
  });

  it('an explicit reprice refreshes prices but never wipes the stored valuation columns', () => {
    ledger.upsertEvents([makeEvent({ id: 'old', inputFresh: 1000, output: 2000 })]);
    plantHistoricalValuation('old');
    db.prepare("UPDATE events SET api_equiv_usd = 99, price_version = 'older-table' WHERE id = ?").run('old');
    ledger.upsertEvents([makeEvent({ id: 'old', inputFresh: 1000, output: 2000 })], { reprice: true });
    const after = row('old');
    expect(after.api_equiv_usd).toBeCloseTo(3, 9);
    expect(after).toMatchObject({ reserved_value: HISTORICAL.value, ucu_rate_status: HISTORICAL.status, eacs_def_sha256: HISTORICAL.def,
      rate_key: HISTORICAL.rateKey, rate_resolved_sha256: HISTORICAL.resolved });
  });

  it('a changed measurement withdraws the stale value to unknown rather than keeping it or inventing zero', () => {
    ledger.upsertEvents([makeEvent({ id: 'old', inputFresh: 1000, output: 2000 })]);
    plantHistoricalValuation('old');
    ledger.upsertEvents([makeEvent({ id: 'old', inputFresh: 1000, output: 5000 })]);
    const after = row('old');
    expect(after.api_equiv_usd).toBeCloseTo(6, 9);
    expect(after.reserved_value).toBeNull();
    expect(after.ucu_rate_status).toBe('NONE');
    expect(after.eacs_def_sha256).toBe('');
    expect(after.rate_key).toBeNull();
    expect(after.rate_resolved_sha256).toBeNull();
  });
});

describe('neutral valuation seam in reads', () => {
  let db: TokeneloDb;
  beforeEach(() => {
    db = openDb({ file: ':memory:' });
    const ledger = new SqliteLedger(db, new StubPricingEngine(), createNullEngine());
    ledger.upsertEvents([makeEvent({ id: 'old', ts: NOW - 60_000, inputFresh: 1000, output: 2000 })]);
    db.prepare('UPDATE events SET ucu = ?, ucu_rate_status = ?, eacs_def_sha256 = ? WHERE id = ?').run(HISTORICAL.value, HISTORICAL.status, HISTORICAL.def, 'old');
  });
  afterEach(() => { db.close(); });

  it('no aggregate surfaces the stored value, even when a stored row carries one', async () => {
    const q = createQueries(db, defaultConfig({ hostLabel: 'M4a' }), { now: () => NOW, pricing: new StubPricingEngine() });
    const summary = await q.getSummary('all');
    const { sessions } = await q.getSessions({ range: 'all', activeOnly: false });
    expect(sessions).toHaveLength(1);
    const series = await q.getTimeseries('day', 'all');
    for (const payload of [summary, sessions, series]) expect(JSON.stringify(payload)).not.toContain(String(HISTORICAL.value));
    expect(summary.totals.apiEquivUsd).toBeCloseTo(3, 9);
  });

  it('the raw export still returns the stored values unchanged', async () => {
    const q = createQueries(db, defaultConfig({ hostLabel: 'M4a' }), { now: () => NOW, pricing: new StubPricingEngine() });
    const [event] = await q.exportEvents('all');
    expect(event).toMatchObject({ reservedValue: HISTORICAL.value, ucuRateStatus: HISTORICAL.status, eacsDefSha256: HISTORICAL.def });
  });

  it('session detail works and the stored value is not summed into it (the absent commit section is pinned in session-detail.test.ts)', async () => {
    const q = createQueries(db, defaultConfig({ hostLabel: 'M4a' }), { now: () => NOW, pricing: new StubPricingEngine() });
    const detail = await q.getSessionDetail('claude', 'session-1');
    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail)).not.toContain(String(HISTORICAL.value));
    expect(detail!.apiEquivUsd).toBeCloseTo(3, 9);
  });

  it('the local comparator values are an explicit unavailable result', async () => {
    const q = createQueries(db, defaultConfig({ hostLabel: 'M4a' }), { now: () => NOW, pricing: new StubPricingEngine() });
    const { local } = await q.getSummary('all');
    for (const value of [local.valueVsClaude, local.valueVsGpt]) {
      expect(value.usd).toBeNull();
      expect(value.status).toBe('NONE');
    }
    expect(local.netSavingsVsClaude).toBeNull();
    expect(local.netSavingsVsGpt).toBeNull();
  });
});
