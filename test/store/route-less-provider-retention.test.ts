import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import { makeEvent, StubValuationEngine } from './stubs.js';

// A provider label must travel with retained historical economic provenance.
// The two opposite hand-authored table/classification changes prevent a false
// hosted $0 LIST result or mislabeling historical hosted work as local work.
describe('ordinary route-less replay retains provider with recorded economics', () => {
  it.each(['local', 'anthropic'] as const)('retains %s classification; explicit changed-provider maintenance remains possible', initial => {
    const db = openDb({ file: ':memory:' });
    try {
      const next = initial === 'local' ? 'anthropic' : 'local';
      const row = { ...structuredClone(loadPriceRows().find(r => r.local)!), id: 'OWNED-PROVIDER-CLASSIFICATION', match: '^OWNED-PROVIDER-CLASSIFICATION$',
        provider: initial, local: initial === 'local', status: 'LIST' as const,
        rates: { in: initial === 'local' ? 0 : 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: initial === 'local' ? 0 : 1 } };
      const oldPrices = createPricingEngine([row]); const newPrices = createPricingEngine([{ ...row, provider: next, local: next === 'local',
        rates: { ...row.rates, in: next === 'local' ? 0 : 2, out: next === 'local' ? 0 : 2 } }]);
      const event = makeEvent({ id: 'OWNED-provider', model: row.id, inputFresh: 100, output: 100 }); event.provider = initial;
      expect(event.components[0].servingRoute).toBeUndefined();
      const old = new SqliteLedger(db, oldPrices, new StubValuationEngine()); old.upsertEvents([event]);
      const before = db.prepare('SELECT rowid,* FROM events').get();
      const current = new SqliteLedger(db, newPrices, new StubValuationEngine());
      const incoming = { ...event, provider: next };
      expect(current.upsertEvents([incoming])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
      expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(before);
      expect(current.getEvents()[0].provider).toBe(initial);
      expect(current.upsertEvents([incoming], { reprice: true }).updated).toBe(1);
      const after = current.getEvents()[0]; expect(after.provider).toBe(next); expect(after.priceVersion).toBe(newPrices.version);
      expect(after.apiEquivUsd).toBe(next === 'local' ? 0 : 0.0004);
    } finally { db.close(); }
  });
});
