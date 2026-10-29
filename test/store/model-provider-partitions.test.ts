/** Stored provider is event provenance. A newly recognized local model must not relabel
 * older, unrecognized events of the same source/model/thinking mode. Synthetic inputs;
 * no live ledger or current price certification is exercised. The rows keep non-neutral stored
 * valuation values; none of them reaches any reported aggregate. */
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createQueries } from '../../src/store/queries.js';
import { createPricingEngine } from '../../src/core/pricing.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { ModelRow, PriceRow, Source } from '../../src/core/types.js';

const NOW = 1_700_000_000_000;
const MODEL = 'newly-recognized-local-model';
const localRow: PriceRow = {
  id: MODEL, match: `^${MODEL}$`, displayName: 'Local model fixture', provider: 'local',
  local: true,
  rates: { in: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: 0 }, status: 'ESTIMATE',
  source: 'synthetic regression fixture', verifiedAt: '2023-11-14',
};
const oldPricing = createPricingEngine([]);
const currentPricing = createPricingEngine([localRow]);

function projection(rows: ModelRow[]) {
  return rows.map(row => ({
    provider: row.provider, source: row.source, model: row.model, thinking: row.thinking,
    events: row.events, tokens: row.tokens, apiEquivUsd: row.apiEquivUsd,
    priceStatus: row.priceStatus,
  })).sort((a, b) => a.provider.localeCompare(b.provider) || a.thinking.localeCompare(b.thinking));
}

for (const source of ['claude', 'qwen-code'] as const satisfies readonly Source[]) {
  for (const reverseInsert of [false, true]) {
    describe(`${source}, ${reverseInsert ? 'local first' : 'unknown first'}`, () => {
      async function run(kind: 'summary' | 'detail') {
        const db = openDb({ file: ':memory:' });
        try {
          // Real pricing resolver transition: absent mapping yields unknown, a later local
          // mapping yields local. The already-stored event columns are never repriced here.
          expect(oldPricing.providerOf(MODEL)).toBe('unknown');
          expect(currentPricing.providerOf(MODEL)).toBe('local');
          const fixtures = [
            { id: 'old', provider: oldPricing.providerOf(MODEL), input: 11, output: 7, read: 5, reasoning: 2, usd: null, price: 'UNPRICED', reservedValue: null, rate: 'NONE', thinking: null },
            { id: 'local-a', provider: currentPricing.providerOf(MODEL), input: 13, output: 3, read: 0, reasoning: 1, usd: 0, price: 'ESTIMATE', reservedValue: 2, rate: 'FILED-EXAMPLE', thinking: null },
            { id: 'local-b', provider: currentPricing.providerOf(MODEL), input: 17, output: 4, read: 2, reasoning: 0, usd: 0, price: 'ESTIMATE', reservedValue: 3, rate: 'FILED-EXAMPLE', thinking: null },
            { id: 'local-nonthinking', provider: currentPricing.providerOf(MODEL), input: 19, output: 6, read: 0, reasoning: 0, usd: 0, price: 'ESTIMATE', reservedValue: 7, rate: 'FILED-EXAMPLE', thinking: 0 },
          ];
          const insert = db.prepare(`INSERT INTO events (
            id,host,source,ts,ts_source,session_id,model,provider,components_json,
            input_fresh,cache_write_5m,cache_write_1h,cache_read,output,reasoning,flags_json,
            api_equiv_usd,price_status,price_version,ucu,ucu_rate_status,eacs_def_sha256,thinking
          ) VALUES (?, 'fixture-host', ?, ?, 'line', 'fixture-session', ?, ?, '[]', ?, 0, 0, ?, ?, ?, '[]', ?, ?, 'synthetic-version', ?, ?, 'synthetic-definition', ?)`);
          for (const f of reverseInsert ? [...fixtures].reverse() : fixtures) {
            insert.run(f.id, source, NOW - 1000, MODEL, f.provider, f.input, f.read, f.output, f.reasoning, f.usd, f.price, f.reservedValue, f.rate, f.thinking);
          }
          const q = createQueries(db, defaultConfig({ hostLabel: 'fixture-host' }), {
            now: () => NOW, pricing: currentPricing,
            probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: NOW }),
          });
          const result = kind === 'summary' ? await q.getSummary('all') : await q.getSessionDetail(source, 'fixture-session');
          expect(result).not.toBeNull();
          const totals = kind === 'summary' ? (result as Awaited<ReturnType<typeof q.getSummary>>).totals : result!;
          expect(totals.events).toBe(4);
          expect(totals.tokens).toEqual({ inputFresh: 60, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 7, output: 20, reasoning: 3,
            ...(kind === 'summary' ? { countQuality: 'unrecorded' } : {}) });
          expect(totals.apiEquivUsd).toBe(0);
          expect(projection(result!.byModel)).toEqual([
            { provider: 'local', source, model: MODEL, thinking: 'non-thinking', events: 1, tokens: { inputFresh: 19, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 6, reasoning: 0, ...(kind === 'summary' ? { countQuality: 'unrecorded' } : {}) }, apiEquivUsd: 0, priceStatus: 'ESTIMATE' },
            { provider: 'local', source, model: MODEL, thinking: 'unknown', events: 2, tokens: { inputFresh: 30, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 2, output: 7, reasoning: 1, ...(kind === 'summary' ? { countQuality: 'unrecorded' } : {}) }, apiEquivUsd: 0, priceStatus: 'ESTIMATE' },
            { provider: 'unknown', source, model: MODEL, thinking: 'unknown', events: 1, tokens: { inputFresh: 11, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 5, output: 7, reasoning: 2, ...(kind === 'summary' ? { countQuality: 'unrecorded' } : {}) }, apiEquivUsd: null, priceStatus: 'UNPRICED' },
          ]);
          // The local-only presentation filter must include exactly the three known-local
          // events, independent of the original insertion order. Unknown remains unknown.
          expect(result!.byModel.filter(r => r.provider === 'local').reduce((n, r) => n + r.events, 0)).toBe(3);
          expect(result!.byModel.find(r => r.provider === 'unknown')!.displayName).toBe(MODEL);
          expect(result!.byModel.filter(r => r.provider === 'local').every(r => r.displayName === 'Local model fixture')).toBe(true);
        } finally { db.close(); }
      }
      it('Summary keeps stored provider partitions and local filtering accurate', () => run('summary'));
      it('session detail keeps the same provider partitions and totals', () => run('detail'));
    });
  }
}
