/** Actual shipped prices and SVG helpers, synthetic counts only. No live ledger,
 * generation, vendor-price certification, runtime attestation or native acceptance. */
import { describe, expect, it } from 'vitest';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { describePoint, renderStackedBarChart, sessionTimelineMetric } from '../../src/tray/renderer/charts.js';
import type { UsageComponent } from '../../src/core/types.js';
import type { TimeseriesPoint } from '../../src/tray/renderer/api-types.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { bucketTimeseries, createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { UsageEvent } from '../../src/core/types.js';

const model = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';
const tokens = { inputFresh: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 10, reasoning: 0 };
const pricing = defaultPricingEngine();
const computeUnits = createNullEngine();
const point = (extra: Partial<TimeseriesPoint> = {}): TimeseriesPoint => ({ t: 1_790_000_000_000, apiEquivUsd: 0,
  tokens: 110, totalTokens: 150, bySource: { 'qwen-code': 0 }, ...extra });

const event = (components: UsageComponent[], extra: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'qwen-code:route', host: 'TEST', source: 'qwen-code', ts: 1_790_000_000_000, tsSource: 'line',
  sessionId: 'route-session', isSubagent: false, model, provider: 'local', thinking: false, components,
  tokens: components[0]!.tokens, flags: [], apiEquivUsd: 0, priceStatus: 'LIST', priceVersion: pricing.version,
  reservedValue: null, ucuRateStatus: 'NONE', eacsDefSha256: computeUnits.defSha256, ...extra,
});

describe('persisted route evidence', () => {
  it.each([false,true])('misaligned route claims cannot restore local zero, reverse=%s',reverse=>{
    const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing,computeUnits);
    const hosted=event([{model,tokens,servingRoute:{kind:'hosted',evidence:'qwen-oauth'}}]);
    const winner=event([{model,tokens:{...tokens,output:100}},{model:'qwen3:8b',tokens}],{tokens:{...tokens,output:110}});
    try{
      for(const e of reverse?[winner,hosted]:[hosted,winner])ledger.upsertEvents([e]);
      const stored=ledger.getEvents()[0]!;
      expect(stored.flags).toContain('servingRouteMisaligned');expect(stored.tokens.output).toBe(110);
      expect(stored.provider).toBe('unknown');expect(stored.apiEquivUsd).toBeNull();expect(stored.ucuRateStatus).toBe('NONE');
      expect(pricing.priceEvent(stored).usd).toBeNull();
      expect(db.prepare('SELECT kind,evidence FROM event_route_reports WHERE event_id=?').all(stored.id))
        .toEqual([{kind:'hosted',evidence:'qwen-oauth'}]);
      ledger.upsertEvents([winner]);expect(ledger.getEvents()[0]!.apiEquivUsd).toBeNull();
      expect(()=>db.exec('DELETE FROM event_route_reports')).toThrow(/immutable/);
    }finally{db.close();}
  });
  it.each(['gpt-6-sol','claude-sonnet-5'])('unknown Qwen serving of the cloud model name %s keeps its LIST price status',cloudModel=>{
    const component={model:cloudModel,tokens,servingRoute:{kind:'unknown',evidence:'qwen-openai-compatible'}as const};
    expect(pricing.priceComponent(component).status).toBe('LIST'); // Reference API-equivalent, not actual invoice/vendor proof.
  });
  it('explicit undefined stays invalid through SQL persistence, re-read and repeated merge', () => {
    const db = openDb({ file: ':memory:' }); const ledger = new SqliteLedger(db, pricing, computeUnits);
    try {
      ledger.upsertEvents([event([{ model, tokens, servingRoute: undefined }])]);
      const [stored] = ledger.getEvents();
      expect(stored!.provider).toBe('unknown');
      expect(stored!.components[0]!.servingRoute).toEqual({ kind: 'unknown', evidence: 'invalid' });
      expect(pricing.priceEvent(stored!).usd).toBeNull();
      ledger.upsertEvents([stored!]);
      expect(ledger.getEvents()[0]!.apiEquivUsd).toBeNull();
      expect(ledger.getEvents()[0]!.ucuRateStatus).toBe('NONE');
    } finally { db.close(); }
  });
  it.each([false, true])('route evidence survives route-less replay without refreshing stored economics, reverse=%s', reverse => {
    const db = openDb({ file: ':memory:' }); const ledger = new SqliteLedger(db, pricing, computeUnits);
    const old = event([{ model, tokens: { ...tokens, output: 100 } }]);
    const hosted = event([{ model, tokens: { ...tokens, output: 100 }, servingRoute: { kind: 'hosted', evidence: 'qwen-oauth' } }], { provider: 'unknown' });
    try {
      const first = reverse ? hosted : old;
      const second = reverse ? old : hosted;
      ledger.upsertEvents([first]); const before = ledger.getEvents()[0]!;
      ledger.upsertEvents([second]);
      const [stored] = ledger.getEvents();
      expect(stored!.tokens.output).toBe(100);
      expect(stored!.provider).toBe(before.provider);
      expect(stored!.apiEquivUsd).toBe(before.apiEquivUsd);
      expect(stored!.priceStatus).toBe(before.priceStatus);
      expect(stored!.priceVersion).toBe(before.priceVersion);
      expect(stored!.reservedValue).toBe(before.reservedValue);
      expect(stored!.ucuRateStatus).toBe(before.ucuRateStatus);
      expect(stored!.rateResolvedSha256).toBe(before.rateResolvedSha256);
      expect(stored!.components[0]!.servingRoute).toEqual({ kind: 'hosted', evidence: 'qwen-oauth' });
    } finally { db.close(); }
  });
  it('a smaller hosted observation preserves the larger retained counts and recorded valuation', () => {
    const db = openDb({ file: ':memory:' }); const ledger = new SqliteLedger(db, pricing, computeUnits);
    const larger = event([{ model, tokens: { ...tokens, output: 100 } }]);
    const smallerHosted = event([{ model, tokens, servingRoute: { kind: 'hosted', evidence: 'qwen-oauth' } }], { provider: 'unknown' });
    try {
      ledger.upsertEvents([larger]);
      const before = ledger.getEvents()[0]!;
      ledger.upsertEvents([smallerHosted]);
      const stored = ledger.getEvents()[0]!;
      expect(stored.tokens.output).toBe(100);
      expect(stored.components[0]!.tokens.output).toBe(100);
      expect(stored.provider).toBe(before.provider);
      expect(stored.apiEquivUsd).toBe(before.apiEquivUsd);
      expect(stored.priceStatus).toBe(before.priceStatus);
      expect(stored.priceVersion).toBe(before.priceVersion);
      expect(stored.reservedValue).toBe(before.reservedValue);
      expect(stored.ucuRateStatus).toBe(before.ucuRateStatus);
      expect(stored.rateResolvedSha256).toBe(before.rateResolvedSha256);
      expect(stored.components[0]!.servingRoute).toEqual({ kind: 'hosted', evidence: 'qwen-oauth' });
    } finally { db.close(); }
  });
  it('incompatible reported local/hosted claims retain stored economics and expose conflict', () => {
    const db = openDb({ file: ':memory:' }); const ledger = new SqliteLedger(db, pricing, computeUnits);
    try {
      ledger.upsertEvents([event([{ model, tokens: { ...tokens, output: 100 }, servingRoute: { kind: 'local', evidence: 'metered-engine' } }])]);
      const before = ledger.getEvents()[0]!;
      ledger.upsertEvents([event([{ model, tokens, servingRoute: { kind: 'hosted', evidence: 'qwen-oauth' } }], { provider: 'unknown' })]);
      const [stored] = ledger.getEvents();
      expect(stored!.tokens.output).toBe(100);
      expect(stored!.provider).toBe(before.provider);
      expect(stored!.apiEquivUsd).toBe(before.apiEquivUsd);
      expect(stored!.priceStatus).toBe(before.priceStatus);
      expect(stored!.priceVersion).toBe(before.priceVersion);
      expect(stored!.reservedValue).toBe(before.reservedValue);
      expect(stored!.ucuRateStatus).toBe(before.ucuRateStatus);
      expect(stored!.rateResolvedSha256).toBe(before.rateResolvedSha256);
      expect(stored!.flags).toContain('servingRouteConflict');
    } finally { db.close(); }
  });
  it('an unrecognized stored rate key does not break an actual Summary read', async () => {
    const db = openDb({ file: ':memory:' }); const ledger = new SqliteLedger(db, pricing, computeUnits);
    try {
      ledger.upsertEvents([event([{ model, tokens }])]);
      db.prepare('UPDATE events SET rate_key=?,rate_resolved_sha256=?').run(JSON.stringify([[model, { think: false }, 'future-route']]), '0'.repeat(64));
      const queries = createQueries(db, defaultConfig({ hostLabel: 'TEST' }), { now: () => 1_790_000_001_000,
        pricing, probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 1_790_000_001_000 }) });
      const result = await queries.getSummary('all');
      expect(result.totals.events).toBe(1);
      // The stored rate key is a reserved compatibility value: it is not interpreted by a Summary read.
    } finally { db.close(); }
  });
});

describe('recorded route and reference pricing', () => {
  it.each([null, false, 0, '', undefined])('a present invalid route %s cannot fall through to local zero pricing', value => {
    const c = { model, tokens, servingRoute: value } as unknown as UsageComponent;
    expect(pricing.priceComponent(c)).toMatchObject({ usd: null, status: 'UNPRICED' });
  });
  it('an absent legacy route preserves the recorded pricing policy', () => {
    expect(pricing.priceComponent({ model, tokens }).usd).toBe(0);
  });
});

describe('unavailable session amounts and token evidence', () => {
  it('a legacy local-zero row plus an unpriced hosted row uses token activity', () => {
    const choose = sessionTimelineMetric as (local: boolean, total: boolean, available: boolean, unpriced: number) => ReturnType<typeof sessionTimelineMetric>;
    const metric = choose(false, true, true, 1);
    const svg = renderStackedBarChart([point({ unpricedEvents: 1 })], { sources: ['qwen-code'], metric });
    expect(metric).toBe('totalTokens');
    expect(svg).not.toContain('$');
    expect(describePoint(point(), ['qwen-code'], 'hour', metric).totalText).toContain('150');
  });
  it.each([NaN, Infinity, -1])('invalid full token value %s is unavailable, not a zero-activity axis', totalTokens => {
    const p = point({ totalTokens });
    const svg = renderStackedBarChart([p], { sources: ['qwen-code'], metric: 'totalTokens' });
    expect(svg).toContain('unavailable');
    expect(svg).not.toContain('data-bucket-t');
    expect(describePoint(p, ['qwen-code'], 'hour', 'totalTokens').totalText).toContain('unavailable');
  });
  it('all unresolved token buckets show an unavailable view rather than an empty zero scale', () => {
    const svg = renderStackedBarChart([point({ countQuality: 'invalid' })], { sources: ['qwen-code'], metric: 'totalTokens' });
    expect(svg).toContain('unavailable');
    expect(svg).not.toContain('data-bucket-t');
  });
  it('a mixed valid and unresolved token series has a visible gap marker', () => {
    const svg = renderStackedBarChart([point(), point({ t: 1_790_000_003_600, countQuality: 'conflict' })], { sources: ['qwen-code'], metric: 'totalTokens' });
    expect(svg).toContain('bar-unavailable');
    expect(svg).toContain('Token total unavailable');
  });
  it('a chart bucket with an unknown price input has no price status (null), never LIST', () => {
    const [p] = bucketTimeseries([{ ts: 0, source: 'claude', tok: 1, totalTok: 1, usd: 1 }], 3_600_000);
    expect(p!.priceStatus).toBeNull();
  });
  it('the older token tooltip names its cache-read exclusion', () => {
    expect(describePoint(point({ totalTokens: undefined }), ['qwen-code'], 'hour', 'tokens').totalText).toContain('cache reads excluded');
  });
});
