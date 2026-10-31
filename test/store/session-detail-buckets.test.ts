import { describe, expect, it } from 'vitest';
import { createQueries } from '../../src/store/queries.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { makeEvent } from './stubs.js';

// P1-2 (2026-10-04): session-detail chart buckets carry the price quality of THEIR OWN events, from the real ledger, through the
// same query the API serves. Three events one hour apart fall into three buckets: an unpriced model (UNPRICED), a Terra cache-write event
// (ESTIMATE, a derived column billed), and a Sol event (LIST).

const T0 = Date.parse('2026-10-04T10:00:00Z');
const HOUR = 3_600_000;
const SESSION = 'session-detail-buckets';

describe('session detail buckets carry their own price quality counts', () => {
  it('each bucket reports its own unpriced and estimated counts from the same events as its dollars', async () => {
    const db = openDb({ file: ':memory:' });
    const pricing = defaultPricingEngine();
    const valuationEngine = createNullEngine();
    const ledger = new SqliteLedger(db, pricing, valuationEngine);
    const common = { sessionId: SESSION, source: 'codex' as const, host: 'M4a' };
    ledger.upsertEvents([
      makeEvent({ ...common, id: 'unpriced-1', ts: T0, model: 'codex-auto-review', inputFresh: 1000, output: 100, thinking: null }),
      makeEvent({ ...common, id: 'estimate-1', ts: T0 + 3 * HOUR, model: 'gpt-5.6-terra', inputFresh: 1000, cacheWrite1h: 500, output: 100, thinking: null }),
      makeEvent({ ...common, id: 'list-1', ts: T0 + 6 * HOUR, model: 'gpt-5.6-sol', inputFresh: 1000, output: 100, thinking: null }),
    ]);

    const q = createQueries(db, defaultConfig(), {
      now: () => T0 + 7 * HOUR,
      pricing,
      probeOllama: async () => ({ reachable: false, models: [], note: 'test stub' }) as never,
      listProcesses: async () => [],
      getCollectorScans: () => [],
    });
    const detail = await q.getSessionDetail('codex', SESSION);
    expect(detail).not.toBeNull();
    const points = detail!.timeseries.points;
    expect(points).toHaveLength(3);

    const [unpriced, estimate, list] = points;
    // Each bucket: its own price quality (not borrowed, not defaulted to LIST)
    expect(unpriced).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 0, priceStatus: 'UNPRICED' });
    expect(estimate).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' });
    expect(list).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
    // the session's own dollar figures agree with the buckets (unpriced dollars are absent from the sum, never invented)
    const bucketUsd = points.reduce((s, p) => s + p.apiEquivUsd, 0);
    expect(bucketUsd).toBeCloseTo(detail!.apiEquivUsd, 9);
    db.close();
  });
});
