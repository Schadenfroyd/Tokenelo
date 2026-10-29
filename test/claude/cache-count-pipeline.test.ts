import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';
import { createPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { runMigrations } from '../../src/store/migrations.js';
import { captureComponentCounts, componentCountProjection, mergeComponentCounts } from '../../src/measurement/component-count-evidence.js';
import { addTokenCounts, completeTokenTotal } from '../../src/core/token-counts.js';
import { tokenTotalText, countBasisLabel } from '../../src/tray/renderer/token-counts.js';
import { describePoint, renderStackedBarChart } from '../../src/tray/renderer/charts.js';
import type { PriceRow, UsageComponent } from '../../src/core/types.js';
import { ownedLegacySchema } from '../helpers/legacy-schema.js';

const MODEL = 'provider/cache-fixture-model'; // production IDs are not constrained by the private observer's model syntax.
const NOW = 1_700_000_000_000;
const SESSION = '00000000-0000-4000-8000-000000000001';
const rows: PriceRow[] = [{ id: MODEL, match: '^provider/cache-fixture-model$', displayName: 'Synthetic', provider: 'anthropic',
  local: false, rates: { in: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: .1, out: 1 },
  status: 'LIST', source: 'Owned synthetic fixture; not vendor prices', verifiedAt: '2023-11-14' }];
const pricing = createPricingEngine(rows);
const valuationEngine = createNullEngine();
const owned: string[] = [];
afterEach(() => { for (const p of owned.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function usage(flat: number | undefined, five: number | undefined, hour: number | undefined, out = 20) {
  return { input_tokens: 10, cache_read_input_tokens: 30, output_tokens: out,
    ...(flat === undefined ? {} : { cache_creation_input_tokens: flat }),
    ...(five === undefined && hour === undefined ? {} : { cache_creation: {
      ...(five === undefined ? {} : { ephemeral_5m_input_tokens: five }),
      ...(hour === undefined ? {} : { ephemeral_1h_input_tokens: hour }) } }) };
}
async function harness(usages: Record<string, unknown>[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-r63-cache-')); owned.push(root);
  fs.mkdirSync(path.join(root, 'fixture-project'));
  const file = path.join(root, 'fixture-project', `${SESSION}.jsonl`);
  const text = usages.map((u, i) => JSON.stringify({ type: 'assistant', timestamp: new Date(NOW + i).toISOString(), sessionId: SESSION,
    uuid: `fixture-${i}`, message: { id: 'fixture-event', model: MODEL, usage: u } })).join('\n') + '\n';
  fs.writeFileSync(file, text);
  const config = defaultConfig({ hostLabel: 'fixture' }); config.claude.roots = [root];
  const db = openDb({ file: ':memory:' }), ledger = new SqliteLedger(db, pricing, valuationEngine);
  try {
    const stats = await new ClaudeCollector().scan({ host: 'fixture', config, store: ledger, pricing, valuationEngine, log: () => {}, now: () => NOW + 100 });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    const queries = createQueries(db, config, { now: () => NOW + 100, pricing,
      listProcesses: async () => [], probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: NOW }) });
    return { db, ledger, stats, queries };
  } catch (e) { db.close(); throw e; }
}

function useLegacySchema(h: Awaited<ReturnType<typeof harness>>, version: number): void {
  const current=h.db;h.db=ownedLegacySchema(version,current);current.close();
  h.ledger=new SqliteLedger(h.db,pricing,valuationEngine);
  h.queries=createQueries(h.db,defaultConfig({hostLabel:'fixture'}),{now:()=>NOW+100,pricing,
    listProcesses:async()=>[],probeOllama:async()=>({servers:[],manifests:new Map(),generatedAt:NOW})});
}

describe('production cache count path with owned inputs and independent arithmetic', () => {
  it.each([
    { name: 'partial split', inputs: [usage(100, 40, undefined)], five: 40, hour: 0, unknown: 60, assumed: 0, price: null },
    { name: 'explicit zero split', inputs: [usage(100, 0, 0)], five: 0, hour: 0, unknown: 100, assumed: 0, price: null },
    { name: 'no split policy', inputs: [usage(100, undefined, undefined)], five: 0, hour: 100, unknown: 0, assumed: 100, price: .000233 },
    { name: 'assumed then reported', inputs: [usage(100, undefined, undefined, 10), usage(100, 100, 0)], five: 100, hour: 0, unknown: 0, assumed: 0, price: .000158 },
    { name: 'reported then absent split', inputs: [usage(100, 100, 0, 10), usage(100, undefined, undefined)], five: 100, hour: 0, unknown: 0, assumed: 0, price: .000158 },
    { name: 'partial then complete', inputs: [usage(100, 40, undefined, 10), usage(100, 100, 0)], five: 100, hour: 0, unknown: 0, assumed: 0, price: .000158 },
  ])('$name conserves flat work in collector/store/Summary/session/feeds/chart/UI', async c => {
    const h = await harness(c.inputs);
    try {
      const [event] = h.ledger.getEvents();
      expect(event.model).toBe(MODEL); expect(h.stats.eventsEmitted).toBe(c.inputs.length);
      expect(event.tokens).toEqual({ inputFresh: 10, cacheRead: 30, output: 20, reasoning: 0,
        cacheWrite5m: c.five, cacheWrite1h: c.hour, cacheWriteUnassigned: c.unknown, cacheWriteAssumed1h: c.assumed, countQuality: 'complete' });
      expect(completeTokenTotal(event.tokens)).toBe(160); // 10 fresh + 100 creation + 30 read + 20 output.
      expect(event.reservedValue).toBeNull(); // the reserved valuation field of a new row is unknown, never zero.
      expect(event.ucuRateStatus).toBe('NONE'); expect(event.apiEquivUsd).toBe(c.price);
      expect(event.flags.includes('cacheSplitAssumed')).toBe(c.assumed > 0);
      const sql = h.db.prepare('SELECT cache_write_unassigned, cache_write_assumed_1h, count_quality, count_policy, count_revision FROM events').get();
      expect(sql).toMatchObject({ cache_write_unassigned: c.unknown, cache_write_assumed_1h: c.assumed, count_quality: 'complete', count_policy: 'tokenelo/claude-component-counts@v2' });
      const summary = await h.queries.getSummary('all');
      expect(summary.totals.tokens).toEqual(event.tokens); expect(summary.bySource.claude.tokens).toEqual(event.tokens);
      expect(summary.byModel[0].tokens).toEqual(event.tokens);
      expect((await h.queries.getSessions({ range: 'all' })).sessions[0].tokens).toEqual(event.tokens);
      const detail = await h.queries.getSessionDetail('claude', SESSION);
      expect(detail!.tokens).toEqual(event.tokens); expect(detail!.byModel[0].tokens).toEqual(event.tokens);
      expect(detail!.telemetry![0].tokens).toEqual(event.tokens);
      const point = (await h.queries.getTimeseries('hour', 'all')).points[0];
      expect(point.tokens).toBe(130); expect(point.totalTokens).toBe(160); expect(point.countQuality).toBe('complete');
      expect(detail!.timeseries.points[0].totalTokens).toBe(160);
      expect(tokenTotalText(detail!.tokens)).toBe('160'); expect(countBasisLabel(detail!.tokens)).toContain('Reported count basis');
      expect(describePoint(point, ['claude'], 'hour', 'totalTokens').totalText).toBe('160 tokens');
      const revision = sql!.count_revision;
      expect(h.ledger.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
      expect(h.db.prepare('SELECT count_revision FROM events').get()!.count_revision).toBe(revision);
      runMigrations(h.db); expect(h.ledger.getEvents()[0].tokens).toEqual(event.tokens);
    } finally { h.db.close(); }
  });

  it('retains a cache-only event whose reported TTL split is zero', async () => {
    const h = await harness([{ ...usage(100, 0, 0, 0), input_tokens: 0, cache_read_input_tokens: 0 }]);
    try { expect(h.stats.eventsEmitted).toBe(1); expect(completeTokenTotal(h.ledger.getEvents()[0].tokens)).toBe(100);
      expect(h.ledger.getEvents()[0].reservedValue).toBeNull(); expect(h.ledger.getEvents()[0].apiEquivUsd).toBeNull(); } finally { h.db.close(); }
  });

  it.each([
    { name: 'TTL maxima exceed flat', inputs: [usage(100, 40, undefined, 10), usage(100, 0, 100)] },
    { name: 'whole vector incomparable', inputs: [usage(100, 40, 60, 10), usage(90, 40, 50)] },
    { name: 'single over-total split', inputs: [usage(100, 80, 30)] },
  ])('$name withholds complete total, price and token chart bars', async c => {
    const h = await harness(c.inputs);
    try {
      const [event] = h.ledger.getEvents(); expect(event.tokens.countQuality).toBe('conflict');
      expect(completeTokenTotal(event.tokens)).toBeNull(); expect(event.apiEquivUsd).toBeNull(); expect(event.reservedValue).toBeNull();
      const summary = await h.queries.getSummary('all'); expect(summary.totals.tokens.countQuality).toBe('conflict');
      const point = (await h.queries.getTimeseries('hour', 'all')).points[0];
      expect(tokenTotalText(summary.totals.tokens)).toBe('Unavailable');
      expect(describePoint(point, ['claude'], 'hour', 'totalTokens').totalText).toContain('unavailable');
      const svg = renderStackedBarChart([point], { sources: ['claude'], metric: 'totalTokens' });
      expect(svg).toContain('Token total unavailable'); expect(svg).not.toContain('<title>Claude:');
    } finally { h.db.close(); }
  });

  it('lower-bound split and missing ordinary counters are qualified, never reconstructed', async () => {
    const h = await harness([usage(undefined, 40, undefined)]);
    try { const [e] = h.ledger.getEvents(); expect(e.tokens.cacheWrite5m).toBe(40); expect(e.tokens.countQuality).toBe('incomplete');
      expect(e.apiEquivUsd).toBeNull(); expect(e.reservedValue).toBeNull(); } finally { h.db.close(); }
  });

  it('an older writer invalidates count materialization and derived figures; raw JSON stays available', async () => {
    const h = await harness([usage(100, 40, undefined)]);
    try {
      const before = h.db.prepare('SELECT components_json FROM events').get()!.components_json;
      h.db.exec('UPDATE events SET output = 25, api_equiv_usd = 9, ucu = 9');
      const row = h.db.prepare('SELECT count_revision, count_quality, cache_write_unassigned, api_equiv_usd, ucu AS reserved_value, components_json FROM events').get();
      expect(row).toMatchObject({ count_revision: null, count_quality: null, cache_write_unassigned: null, api_equiv_usd: null, reserved_value: null, components_json: before });
      const [e] = h.ledger.getEvents(); expect(e.tokens.countQuality).toBe('incomplete');
      expect(e.components[0].countEvidence!.mergeState).toBe('legacy-mixed');
      expect(pricing.priceEvent(e).usd).toBeNull();
    } finally { h.db.close(); }
  });

  it('local zero rates price known unassigned work, but never prove an unresolved count basis', () => {
    const localPricing = createPricingEngine([{ ...rows[0], local: true, provider: 'local', rates: { in: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: 0 } }]);
    const component = (raw: Record<string, unknown>): UsageComponent => { const countEvidence = captureComponentCounts(raw);
      return { model: MODEL, countEvidence, tokens: componentCountProjection(countEvidence).tokens }; };
    expect(localPricing.priceComponent(component(usage(100, 0, 0))).usd).toBe(0);
    expect(localPricing.priceComponent(component(usage(100, 80, 30))).usd).toBeNull();
    expect(localPricing.priceComponent(component(usage(undefined, 40, undefined))).usd).toBeNull();
  });

  it('a retained non-maximal raw vector still detects a later incomparable snapshot', () => {
    const component = (u: Record<string, unknown>): UsageComponent => { const countEvidence = captureComponentCounts(u);
      return { model: MODEL, countEvidence, tokens: componentCountProjection(countEvidence).tokens }; };
    const a = component(usage(100, 40, 60, 30)), b = component(usage(120, 60, 60, 30)), c = component(usage(110, 50, 60, 25));
    const ab = mergeComponentCounts(a, b, true);
    expect(ab.tokens.countQuality).toBe('complete');
    expect(mergeComponentCounts(ab, c, true).tokens.countQuality).toBe('conflict');
    expect(mergeComponentCounts(a, mergeComponentCounts(b, c, true), true).tokens.countQuality).toBe('conflict');
  });

  it('bounds retained numeric snapshots and withholds completeness after the bound is exceeded', () => {
    const component = (n: number): UsageComponent => { const countEvidence = captureComponentCounts(usage(n, n, 0, n));
      return { model: MODEL, countEvidence, tokens: componentCountProjection(countEvidence).tokens }; };
    let merged = component(1);
    for (let n = 2; n <= 65; n++) merged = mergeComponentCounts(merged, component(n), true);
    expect(merged.countEvidence!.snapshots).toHaveLength(64);
    expect(merged.countEvidence!.snapshotLimitExceeded).toBe(true);
    expect(merged.tokens.countQuality).toBe('incomplete');
    expect(pricing.priceComponent(merged).usd).toBeNull();
  });

  it('reads an owned schema7 ledger without migration and upgrades with NULL evidence, preserving old counts', async () => {
    const h = await harness([usage(100, 100, 0)]);
    useLegacySchema(h,7);
    try {
      const [e] = h.ledger.getEvents();
      const old = [{ model: MODEL, tokens: { inputFresh: 10, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 30, output: 20, reasoning: 0 } }];
      h.db.prepare('UPDATE events SET components_json = ?').run(JSON.stringify(old));
      const q = createQueries(h.db, defaultConfig({ hostLabel: 'fixture' }), { now: () => NOW + 100, pricing,
        listProcesses: async () => [], probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: NOW }) });
      const summary = await q.getSummary('all'); expect(summary.totals.tokens.countQuality).toBe('unrecorded');
      expect(completeTokenTotal(summary.totals.tokens)).toBe(160);
      expect((await q.getTimeseries('hour', 'all')).points[0].totalTokens).toBe(160);
      expect(h.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value).toBe('7');
      runMigrations(h.db);
      expect(h.db.prepare('SELECT count_quality, count_revision, cache_write_unassigned FROM events').get())
        .toMatchObject({ count_quality: null, count_revision: null, cache_write_unassigned: null });
      expect(h.ledger.getEvents()[0].tokens).toEqual(old[0].tokens); expect(h.ledger.getEvents()[0].reservedValue).toBe(e.reservedValue);
      const countEvidence = captureComponentCounts(usage(100, 40, undefined));
      const tokens = componentCountProjection(countEvidence).tokens;
      h.ledger.upsertEvents([{ ...e, id: 'new-after-schema-upgrade', components: [{ model: MODEL, tokens, countEvidence }], tokens }]);
      const afterUpgrade = await q.getSummary('all');
      expect(afterUpgrade.totals.tokens.cacheWriteUnassigned).toBe(60);
      expect(completeTokenTotal(afterUpgrade.totals.tokens)).toBe(320); // same query object must notice the changed schema.
    } finally { h.db.close(); }
  });

  it('unsafe aggregate counts never supply an exact full-work basis', () => {
    const countEvidence = captureComponentCounts({ ...usage(0, 0, 0), input_tokens: Number.MAX_SAFE_INTEGER });
    const tokens = componentCountProjection(countEvidence).tokens;
    expect(tokens.countQuality).toBe('invalid'); expect(completeTokenTotal(tokens)).toBeNull();
    const c = { model: MODEL, tokens, countEvidence };
    expect(pricing.priceComponent(c).usd).toBeNull();
  });

  it('later larger integers cannot silently erase an earlier invalid-for-count raw counter', () => {
    const component = (u: Record<string, unknown>): UsageComponent => { const countEvidence = captureComponentCounts(u);
      return { model: MODEL, countEvidence, tokens: componentCountProjection(countEvidence).tokens }; };
    const a = component({ ...usage(100, 40, 60), input_tokens: 1.5 }), b = component(usage(100, 40, 60));
    const merged = mergeComponentCounts(a, b, true);
    expect(merged.tokens.countQuality).toBe('invalid'); expect(pricing.priceComponent(merged).usd).toBeNull();
  });

  it('invalid TTL history still withholds price when flat work is known and a later TTL MAX is usable', () => {
    const component = (u: Record<string, unknown>): UsageComponent => { const countEvidence = captureComponentCounts(u);
      return { model: MODEL, countEvidence, tokens: componentCountProjection(countEvidence).tokens }; };
    const merged = mergeComponentCounts(component(usage(100, 30.5, 60)), component(usage(100, 40, 60)), true);
    expect(merged.tokens.countQuality).toBe('complete'); expect(completeTokenTotal(merged.tokens)).toBe(160);
    expect(pricing.priceComponent(merged).usd).toBeNull();
  });

  it.each([
    { name: 'invalid ordinary count', raw: { ...usage(100, 40, 60), input_tokens: 1.5 } },
    { name: 'invalid TTL count', raw: usage(100, 30.5, 60) },
    { name: 'malformed TTL container', raw: { ...usage(100, 40, 60), cache_creation: 'malformed' } },
  ])('$name is stable on its first identical exported-event upsert', async c => {
    const h = await harness([c.raw]);
    try {
      const [event] = h.ledger.getEvents();
      const before = h.db.prepare('SELECT components_json, count_revision FROM events').get();
      expect(h.ledger.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
      expect(h.db.prepare('SELECT components_json, count_revision FROM events').get()).toEqual(before);
      expect(h.ledger.getEvents()[0].tokens).toEqual(event.tokens);
    } finally { h.db.close(); }
  });

  it.each([
    { name: 'omitted cache reads', raw: (() => { const { cache_read_input_tokens: _read, ...raw } = usage(100, 40, 60); return raw; })(), full: 'incomplete' },
    { name: 'invalid excluded cache reads', raw: { ...usage(100, 40, 60), cache_read_input_tokens: -1 }, full: 'invalid' },
  ])('$name withholds full usage/price while preserving the independently known v1-fresh count quality', async c => {
    const h = await harness([c.raw]);
    try {
      const [e] = h.ledger.getEvents();
      expect(e.tokens).toMatchObject({ countQuality: c.full, ucuCountQuality: 'complete' });
      expect(completeTokenTotal(e.tokens)).toBeNull(); expect(e.apiEquivUsd).toBeNull();
      expect(e.reservedValue).toBeNull(); expect(e.ucuRateStatus).toBe('NONE');
      expect(h.db.prepare('SELECT ucu_count_quality FROM events').get()).toEqual({ ucu_count_quality: 'complete' });
      const summary = await h.queries.getSummary('all');
      expect(summary.totals.tokens).toMatchObject({ countQuality: c.full, ucuCountQuality: 'complete' });
      const detail = await h.queries.getSessionDetail('claude', SESSION);
      expect(detail!.tokens).toEqual(e.tokens);
      const point = (await h.queries.getTimeseries('hour', 'all')).points[0];
      expect(point.tokens).toBe(130); expect(point).toMatchObject({ countQuality: c.full, ucuCountQuality: 'complete' });
      expect(describePoint(point, ['claude'], 'hour', 'totalTokens').totalText).toContain('unavailable');
      expect(describePoint(point, ['claude'], 'hour', 'tokens').totalText).toBe('130 fresh/write/output tokens · cache reads excluded');
      expect(countBasisLabel(e.tokens)).toContain('v1-fresh work count known');
      expect(h.ledger.upsertEvents([e])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    } finally { h.db.close(); }
  });

  it('invalid excluded read history does not invalidate independently reported v1-fresh work', async () => {
    const h = await harness([{ ...usage(100, 40, 60), cache_read_input_tokens: 1.5 }, usage(100, 40, 60)]);
    try {
      const [e] = h.ledger.getEvents(); expect(e.tokens).toMatchObject({ countQuality: 'invalid', ucuCountQuality: 'complete' });
      expect(e.apiEquivUsd).toBeNull(); expect(e.reservedValue).toBeNull(); expect(completeTokenTotal(e.tokens)).toBeNull();
    } finally { h.db.close(); }
  });

  it('a v8 writer advancing its revision still invalidates unsupported v1-fresh materialization', async () => {
    const h = await harness([usage(100, 40, 60)]);
    try {
      h.db.exec("UPDATE events SET count_policy = 'tokenelo/claude-component-counts@v1', count_revision = count_revision + 1, output = 25");
      expect(h.db.prepare('SELECT count_quality, ucu_count_quality, count_revision, api_equiv_usd, ucu AS reserved_value FROM events').get())
        .toEqual({ count_quality: null, ucu_count_quality: null, count_revision: null, api_equiv_usd: null, reserved_value: null });
      const [e] = h.ledger.getEvents(); expect(e.tokens.countQuality).toBe('incomplete');
      expect(pricing.priceEvent(e).usd).toBeNull();
    } finally { h.db.close(); }
  });

  it('upgrades an owned v8 ledger with NULL basis evidence and no historic recomputation', async () => {
    const h = await harness([usage(100, 40, 60)]);
    useLegacySchema(h,8);
    try {
      const before = h.db.prepare('SELECT components_json, input_fresh, cache_write_5m, cache_write_1h, cache_read, output, count_quality, count_revision, api_equiv_usd, ucu FROM events').get();
      expect((await h.queries.getSummary('all')).totals.events).toBe(1);
      runMigrations(h.db);
      expect(h.db.prepare('SELECT components_json, input_fresh, cache_write_5m, cache_write_1h, cache_read, output, count_quality, count_revision, api_equiv_usd, ucu FROM events').get()).toEqual(before);
      expect(h.db.prepare('SELECT ucu_count_quality FROM events').get()).toEqual({ ucu_count_quality: null });
      expect((await h.queries.getSummary('all')).totals.events).toBe(1);
    } finally { h.db.close(); }
  });

  it('a zero normalized legacy row still qualifies a later known v1-fresh aggregate as unrecorded', () => {
    const total = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
    addTokenCounts(total, { ...total });
    const raw = usage(100, 40, 60); delete (raw as Partial<typeof raw>).cache_read_input_tokens;
    addTokenCounts(total, componentCountProjection(captureComponentCounts(raw)).tokens);
    expect(total).toMatchObject({ countQuality: 'incomplete', ucuCountQuality: 'unrecorded' });
  });

  it('an unsupported count policy cannot supply prices and remains idempotent', async () => {
    const h = await harness([usage(100, 40, 60)]);
    try {
      const [known] = h.ledger.getEvents();
      const component = { ...known.components[0], countEvidence: { ...known.components[0].countEvidence!, policy: 'tokenelo/unknown-count-policy@v999' } } as UsageComponent;
      expect(pricing.priceComponent(component).usd).toBeNull();
      expect(() => componentCountProjection(component.countEvidence!)).toThrow(/Unsupported count evidence policy/);
      h.ledger.upsertEvents([{ ...known, id: 'unsupported-policy', components: [component] }]);
      const e = h.ledger.getEvents().find(e => e.id === 'unsupported-policy')!;
      expect(e.tokens.countQuality).toBe('incomplete'); expect(e.reservedValue).toBeNull(); expect(e.apiEquivUsd).toBeNull();
      expect(e.flags).toContain('countPolicyUnsupported');
      expect(e.components[0].countEvidence!.policy).toBe('tokenelo/unknown-count-policy@v999');
      expect(h.ledger.upsertEvents([e])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    } finally { h.db.close(); }
  });

  it.each([true, false])('unsupported policy remains unavailable across current/future merge, futureFirst=%s', async futureFirst => {
    const h = await harness([usage(100, 40, 60)]);
    try {
      const [known] = h.ledger.getEvents();
      const future = { ...known, components: [{ ...known.components[0], countEvidence: { ...known.components[0].countEvidence!, policy: 'tokenelo/unknown-count-policy@v999' } }] } as typeof known;
      h.db.exec('DELETE FROM events');
      h.ledger.upsertEvents([futureFirst ? future : known]); h.ledger.upsertEvents([futureFirst ? known : future]);
      const [e] = h.ledger.getEvents(); expect(e.tokens.countQuality).toBe('incomplete');
      expect(e.components[0].countEvidence!.policy).toBe('tokenelo/unknown-count-policy@v999');
      expect(e.apiEquivUsd).toBeNull(); expect(e.reservedValue).toBeNull(); expect(e.flags).toContain('countPolicyUnsupported');
      expect(completeTokenTotal((await h.queries.getSummary('all')).totals.tokens)).toBeNull();
      expect(h.ledger.upsertEvents([e])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    } finally { h.db.close(); }
  });

  it('older-writer invalidation preserves opaque policy bytes and inspectable column counts on re-upsert', async () => {
    const h = await harness([usage(100, 40, 60)]);
    try {
      const [known] = h.ledger.getEvents();
      const future = { ...known, components: [{ ...known.components[0], countEvidence: { ...known.components[0].countEvidence!, policy: 'tokenelo/unknown-count-policy@v999' } }] } as typeof known;
      h.db.exec('DELETE FROM events'); h.ledger.upsertEvents([future]);
      const raw = h.db.prepare('SELECT components_json FROM events').get()!.components_json;
      h.db.exec('UPDATE events SET output = 25');
      const [e] = h.ledger.getEvents();
      expect(e.tokens.output).toBe(25);
      expect(e.components[0].countEvidence).toEqual(JSON.parse(raw as string)[0].countEvidence);
      h.ledger.upsertEvents([e]);
      const [after] = h.ledger.getEvents(); expect(after.tokens.output).toBe(25);
      expect(after.reservedValue).toBeNull(); expect(after.apiEquivUsd).toBeNull();
      expect(after.components[0].countEvidence).toEqual(JSON.parse(raw as string)[0].countEvidence);
      expect(h.ledger.upsertEvents([after])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    } finally { h.db.close(); }
  });

  it('unsupported evidence cannot erase a conflict proved by a supported component', async () => {
    const h = await harness([usage(100, 80, 30)]);
    try {
      const [knownConflict] = h.ledger.getEvents();
      const evidence = captureComponentCounts(usage(100, 40, 60));
      const future = { model: MODEL, tokens: componentCountProjection(evidence).tokens,
        countEvidence: { ...evidence, policy: 'tokenelo/unknown-count-policy@v999' } } as UsageComponent;
      const tokens = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
      for (const c of [...knownConflict.components, future]) addTokenCounts(tokens, c.tokens);
      h.ledger.upsertEvents([{ ...knownConflict, id: 'known-conflict-plus-opaque', components: [...knownConflict.components, future], tokens }]);
      const e = h.ledger.getEvents().find(e => e.id === 'known-conflict-plus-opaque')!;
      expect(e.tokens.countQuality).toBe('conflict'); expect(e.flags).toContain('cacheTtlConflict');
      expect(e.flags).toContain('countPolicyUnsupported'); expect(e.reservedValue).toBeNull(); expect(e.apiEquivUsd).toBeNull();
    } finally { h.db.close(); }
  });
});
