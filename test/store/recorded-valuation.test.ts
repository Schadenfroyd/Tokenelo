import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getPaths } from '../../src/daemon/paths.js';
import { repriceLedger } from '../../src/cli/index.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { captureComponentCounts, componentCountProjection } from '../../src/measurement/component-count-evidence.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { PricingEngine, UsageEvent } from '../../src/core/types.js';
import { createPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { openDb as openCompiledDb } from '../../dist/store/db.js';
import { SqliteLedger as CompiledSqliteLedger } from '../../dist/store/ledger.js';
import { makeEvent, StubEacsEngine } from './stubs.js';
import { ownedLegacySchema } from '../helpers/legacy-schema.js';

// OWNED-FILED memory ledger; actual price engine and production upsert. The prior table is a
// controlled counterfactual: Sonnet5.5 cache0.20 and absent Haiku5.5; not an invoice/capture proof.
const currentRows = loadPriceRows();
const priorRows = structuredClone(currentRows).filter(r => r.id !== 'claude-haiku-5-5');
priorRows.find(r => r.id === 'claude-sonnet-5-5')!.rates.cacheRead = 0.20;
const oldPricing = createPricingEngine(priorRows), currentPricing = createPricingEngine(currentRows);
// A valuation-seam double that differs from StubEacsEngine in every value it writes (the stored value x3 and another
// rate-basis identity), standing for "a different engine is injected when the ledger is reopened".
class ChangedValuationEngine extends StubEacsEngine {
  override ucuForEvent(e: Parameters<StubEacsEngine['ucuForEvent']>[0]) {
    const result = super.ucuForEvent(e); return { ...result, reservedValue: result.reservedValue! * 3 };
  }
  override rateBasisOf(components: Parameters<StubEacsEngine['rateBasisOf']>[0]) {
    const basis = super.rateBasisOf(components);
    return { ...basis, resolvedSha256: 'OWNED-FILED-new-valuation:' + basis.rateKey };
  }
}
const dbs: TokeneloDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function setup(event: UsageEvent = makeEvent({ id: 'recorded', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1_000_000, output: 100 })) {
  const db = openDb({ file: ':memory:' }); dbs.push(db);
  const old = new SqliteLedger(db, oldPricing, new StubEacsEngine()); old.upsertEvents([event]);
  const before = old.getEvents({})[0];
  const current = new SqliteLedger(db, currentPricing, new ChangedValuationEngine());
  return { db, event, before, current };
}
function economics(e: UsageEvent) {
  return { apiEquivUsd: e.apiEquivUsd, priceStatus: e.priceStatus, priceVersion: e.priceVersion,
    reservedValue: e.reservedValue, ucuRateStatus: e.ucuRateStatus, eacsDefSha256: e.eacsDefSha256,
    rateKey: e.rateKey, rateResolvedSha256: e.rateResolvedSha256 };
}

describe('recorded valuation survives ordinary replay; explicit maintenance and real updates recompute', () => {
  it('identical source replay retains all eight recorded economic fields and every stored byte', () => {
    const { db, event, before, current } = setup();
    const row = db.prepare('SELECT rowid,* FROM events').get();
    expect(before.apiEquivUsd).toBeCloseTo(0.2012, 12);
    expect(current.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(economics(current.getEvents({})[0])).toEqual(economics(before));
    expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
  });
  it('ordinary exported-row replay is not an implicit reprice', () => {
    const { before, current } = setup();
    expect(current.upsertEvents([before])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('explicit reprice refreshes $/version while preserving id/counts/rowid and the reserved valuation fields', () => {
    const { db, event, before, current } = setup();
    const rowid = db.prepare('SELECT rowid FROM events').get();
    expect(current.upsertEvents([before], { reprice: true })).toEqual({ inserted: 0, updated: 1, unchanged: 0 });
    const after = current.getEvents({})[0];
    expect(after.apiEquivUsd).toBeCloseTo(0.1012, 12); expect(after.priceVersion).toBe(currentPricing.version);
    // The reserved valuation fields are not part of a price refresh: the stored values stay while the inputs are unchanged.
    expect(after.reservedValue).toBe(before.reservedValue); expect(after.rateResolvedSha256).toBe(before.rateResolvedSha256);
    expect(after.tokens).toEqual(before.tokens); expect(after.id).toBe(event.id);
    expect(db.prepare('SELECT rowid FROM events').get()).toEqual(rowid);
  });
  it('explicit false uses the ordinary replay policy', () => {
    const { event, before, current } = setup(); current.upsertEvents([event], { reprice: false });
    expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('new event ids use current prices and the current valuation seam', () => {
    const { event, current } = setup(); current.upsertEvents([{ ...event, id: 'new' }]);
    const after = current.getEvents({}).find(e => e.id === 'new')!;
    expect(after.apiEquivUsd).toBeCloseTo(0.1012, 12); expect(after.priceVersion).toBe(currentPricing.version);
    expect(after.reservedValue).toBe(6);
  });
  it('advancing output recomputes the merged measurement and is never first-seen-wins', () => {
    const { event, before, current } = setup();
    const raised = structuredClone(event); raised.tokens.output = 200; raised.components[0].tokens.output = 200;
    expect(current.upsertEvents([raised]).updated).toBe(1);
    const after = current.getEvents({})[0]; expect(after.tokens.output).toBe(200);
    expect(after.apiEquivUsd).toBeCloseTo(0.1022, 12); expect(after.priceVersion).toBe(currentPricing.version);
    expect(after.reservedValue).toBeGreaterThan(before.reservedValue!);
  });
  it('a losing smaller snapshot retains the recorded merged measurement and valuation', () => {
    const { event, before, current } = setup(); const smaller = structuredClone(event);
    smaller.tokens.output = 10; smaller.components[0].tokens.output = 10;
    expect(current.upsertEvents([smaller]).unchanged).toBe(1);
    expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('new geography is a changed economic context, not a replay', () => {
    const { event, current } = setup(); current.upsertEvents([{ ...event, inferenceGeo: 'us' }]);
    const after = current.getEvents({})[0]; expect(after.inferenceGeo).toBe('us');
    expect(after.apiEquivUsd).toBeCloseTo(0.1012 * 1.1, 12); expect(after.priceVersion).toBe(currentPricing.version);
  });
  it('new thinking evidence recomputes the stored valuation without freezing streaming counts', () => {
    const { event, current } = setup(); current.upsertEvents([{ ...event, thinking: true }]);
    const after = current.getEvents({})[0]; expect(after.thinking).toBe(true);
    expect(after.priceVersion).toBe(currentPricing.version); expect(after.reservedValue).toBe(6);
  });
  it('project/branch attribution changes do not apply current rates to unchanged work', () => {
    const { event, before, current } = setup();
    current.upsertEvents([{ ...event, project: 'OWNED-FILED-project', gitBranch: 'OWNED-FILED-branch' }]);
    const after = current.getEvents({})[0]; expect(after.project).toBe('OWNED-FILED-project');
    expect(economics(after)).toEqual(economics(before));
  });
  it('route-only enrichment retains recorded economics until explicit reprice', () => {
    // Synthetic route evidence and StubEacsEngine values; not a live serving-route attestation or valuation.
    const { paths, cleanup } = maintenanceHome();
    const model = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';
    const event = makeEvent({ id: 'route-only-retention', model, inputFresh: 100, output: 10 });
    event.provider = 'local';
    const db = openDb({ file: paths.dbFile });
    let dbOpen = true;
    try {
      const recorded = new SqliteLedger(db, oldPricing, new StubEacsEngine());
      recorded.upsertEvents([event]);
      const before = recorded.getEvents({})[0];
      expect(before.apiEquivUsd).toBe(0);
      expect(before.priceStatus).toBe('LIST');

      const hosted = structuredClone(event);
      hosted.provider = 'unknown';
      hosted.components[0]!.servingRoute = { kind: 'hosted', evidence: 'qwen-oauth' };
      const ordinary = new SqliteLedger(db, currentPricing, new ChangedValuationEngine());
      expect(ordinary.upsertEvents([hosted])).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
      const afterEvidence = ordinary.getEvents({})[0];
      expect(afterEvidence.components[0]!.servingRoute).toEqual({ kind: 'hosted', evidence: 'qwen-oauth' });
      expect(economics(afterEvidence)).toEqual(economics(before));
      expect(afterEvidence.provider).toBe('local');
      expect(db.prepare('SELECT kind,evidence FROM event_route_reports WHERE event_id=?').all(event.id))
        .toEqual([{ kind: 'hosted', evidence: 'qwen-oauth' }]);
      db.close(); dbOpen = false;

      const result = repriceLedger(paths, currentPricing, new ChangedValuationEngine());
      expect(result).toMatchObject({ updated: 1, usdChanged: 1, priceStatusChanged: 1,
        priceVersionChanged: 1, providerChanged: 1 });
      expect(result.backup).toMatch(/^tokenelo-pre-reprice-.*\.sqlite$/);
      const refreshedDb = openDb({ file: paths.dbFile, readOnly: true });
      try {
        const refreshed = new SqliteLedger(refreshedDb, currentPricing, new ChangedValuationEngine()).getEvents({})[0];
        expect(refreshed).toMatchObject({ apiEquivUsd: null, priceStatus: 'UNPRICED', provider: 'unknown',
          priceVersion: currentPricing.version, reservedValue: before.reservedValue });
        expect(refreshed.flags).toContain('servingRouteUnpriced');
        expect(refreshed.rateResolvedSha256).toBe(before.rateResolvedSha256);
      } finally { refreshedDb.close(); }
      const backup = openDb({ file: path.join(paths.dataDir, 'backups', result.backup!), readOnly: true });
      try {
        const saved = new SqliteLedger(backup, oldPricing, new StubEacsEngine()).getEvents({})[0];
        expect(economics(saved)).toEqual(economics(before));
        expect(saved.components[0]!.servingRoute).toEqual({ kind: 'hosted', evidence: 'qwen-oauth' });
      } finally { backup.close(); }
    } finally { if (dbOpen) db.close(); cleanup(); }
  });
  it('compiled ledger runtime preserves recorded economics on route-only replay', () => {
    // The shipped dist path is tested separately so a source-only fix cannot mask stale compiled output.
    const model = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';
    const event = makeEvent({ id: 'compiled-route-retention', model, inputFresh: 100, output: 10 });
    event.provider = 'local';
    const db = openCompiledDb({ file: ':memory:' });
    try {
      const recorded = new CompiledSqliteLedger(db, oldPricing, new StubEacsEngine());
      recorded.upsertEvents([event]);
      const before = recorded.getEvents({})[0]!;
      expect(before.apiEquivUsd).toBe(0);
      expect(before.priceStatus).toBe('LIST');

      const hosted = structuredClone(event);
      hosted.provider = 'unknown';
      hosted.components[0]!.servingRoute = { kind: 'hosted', evidence: 'qwen-oauth' };
      const ordinary = new CompiledSqliteLedger(db, currentPricing, new ChangedValuationEngine());
      ordinary.upsertEvents([hosted]);
      const after = ordinary.getEvents({})[0]!;
      expect(after.components[0]!.servingRoute).toEqual({ kind: 'hosted', evidence: 'qwen-oauth' });
      expect(economics(after)).toEqual(economics(before));
      expect(after.provider).toBe('local');
    } finally { db.close(); }
  });
  it('flags with different construction order do not rewrite a recorded valuation', () => {
    const event = makeEvent({ id: 'flag-order', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1_000_000, output: 100,
      flags: ['localViaClaudeJsonl', 'reasoningClamped'] });
    const { before, current } = setup(event); current.upsertEvents([{ ...event, flags: [...event.flags].reverse() }]);
    expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('equivalent component object-key order does not rewrite the row or lose evidence', () => {
    const { db, event, current } = setup(); const row = db.prepare('SELECT rowid,* FROM events').get();
    const reordered = { ...event, components: [{ tokens: event.components[0].tokens, model: event.components[0].model }] };
    expect(current.upsertEvents([reordered]).unchanged).toBe(1);
    expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
  });
  it('absent and explicitly undefined optional component fields are the same replay', () => {
    const { event, before, current } = setup();
    current.upsertEvents([{ ...event, components: [{ ...event.components[0], speed: undefined, requestInput: undefined }] }]);
    expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('missing and explicitly zero optional cache work do not trigger repricing', () => {
    const { event, before, current } = setup(); const copy = structuredClone(event);
    copy.tokens.cacheWriteUnassigned = 0; copy.tokens.cacheWriteAssumed1h = 0;
    copy.components[0].tokens.cacheWriteUnassigned = 0; copy.components[0].tokens.cacheWriteAssumed1h = 0;
    current.upsertEvents([copy]); expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('formerly unpriced Haiku replay remains honestly unpriced until explicit reprice', () => {
    const event = makeEvent({ id: 'unpriced-haiku', model: 'claude-haiku-5-5', inputFresh: 100, output: 100 });
    const { before, current } = setup(event); expect(before.priceStatus).toBe('UNPRICED');
    current.upsertEvents([event]); const replayed = current.getEvents({})[0];
    expect(economics(replayed)).toEqual(economics(before)); expect(replayed.flags).toContain('unpricedModel');
    current.upsertEvents([replayed], { reprice: true }); const repriced = current.getEvents({})[0];
    expect(repriced.apiEquivUsd).toBeCloseTo(0.00006, 12); expect(repriced.flags).not.toContain('unpricedModel');
  });
  it('an added route-misalignment hold must invalidate an old numeric valuation', () => {
    const { event, current } = setup(); current.upsertEvents([{ ...event, flags: ['servingRouteMisaligned'] }]);
    const after = current.getEvents({})[0]; expect(after.apiEquivUsd).toBeNull(); expect(after.priceStatus).toBe('UNPRICED');
  });
  it('a stored row with no recorded rate basis stays unrecorded on replay and through explicit reprice', () => {
    const { db, event, current } = setup();
    db.prepare('UPDATE events SET rate_key=NULL,rate_resolved_sha256=NULL').run();
    current.upsertEvents([event]); const after = current.getEvents({})[0];
    expect(after.rateKey).toBeNull(); expect(after.rateResolvedSha256).toBeNull();
    current.upsertEvents([after], { reprice: true }); const repriced = current.getEvents({})[0];
    expect(repriced.rateKey).toBeNull(); expect(repriced.rateResolvedSha256).toBeNull();
  });
  it('a changed component request size takes the current whole-request bracket', () => {
    const event = makeEvent({ id: 'context', model: 'gpt-6.1-sol', inputFresh: 100, output: 100 });
    const { current } = setup(event); const copy = structuredClone(event); copy.components[0].requestInput = 272_001;
    current.upsertEvents([copy]); const after = current.getEvents({})[0];
    expect(after.apiEquivUsd).toBeCloseTo((100 * 4 + 100 * 15) / 1e6, 12);
    expect(after.flags).toContain('longContextBracket'); expect(after.priceVersion).toBe(currentPricing.version);
  });
});


describe('reviewed replay provenance regressions', () => {
  it('misaligned equal effective subset count quality retains prior provenance without explicit maintenance', () => {
    const first = makeEvent({ id: 'conflict-review', model: 'claude-sonnet-5-5', inputFresh: 1, cacheRead: 100, output: 10 });
    first.tokens.countQuality = 'complete'; first.components[0].tokens.countQuality = 'complete';
    const db = openDb({ file: ':memory:' }); dbs.push(db);
    const old = new SqliteLedger(db, oldPricing, new StubEacsEngine()); old.upsertEvents([first]);
    const incoming = makeEvent({ id: first.id, model: 'gpt-6.1-sol', inputFresh: 1, cacheRead: 100, output: 20 });
    incoming.tokens.countQuality = 'complete'; incoming.components[0].tokens.countQuality = 'complete';
    old.upsertEvents([incoming]); const before = old.getEvents({})[0];
    expect(before.tokens.countQuality).toBe('conflict'); expect(before.flags).toContain('mergedComponentsMisaligned');
    const current = new SqliteLedger(db, currentPricing, new ChangedValuationEngine());
    current.upsertEvents([incoming]); expect(economics(current.getEvents({})[0])).toEqual(economics(before));
  });
  it('same recorded route retains its provider with the recorded price; explicit reprice refreshes both', () => {
    const row = { ...structuredClone(currentRows.find(r => r.local)!), id: 'OWNED-FILED-route-model', match: '^OWNED-FILED-route-model$', provider: 'local' as const, local: true, status: 'LIST' as const,
      rates: { in: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: 0 } };
    const p1 = createPricingEngine([row]); const p2 = createPricingEngine([{ ...row, provider: 'anthropic', local: false,
      rates: { in: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, out: 1 } }]);
    const event = makeEvent({ id: 'provider-review', model: row.id, inputFresh: 100, output: 100 });
    event.provider = 'local'; event.components[0].servingRoute = { kind: 'local', evidence: 'metered-engine' };
    const db = openDb({ file: ':memory:' }); dbs.push(db); const old = new SqliteLedger(db, p1, new StubEacsEngine()); old.upsertEvents([event]);
    const before = old.getEvents({})[0]; const current = new SqliteLedger(db, p2, new ChangedValuationEngine());
    expect(current.upsertEvents([event]).unchanged).toBe(1); const replayed = current.getEvents({})[0];
    expect(replayed.provider).toBe('local'); expect(economics(replayed)).toEqual(economics(before));
    current.upsertEvents([replayed], { reprice: true }); const after = current.getEvents({})[0];
    expect(after.provider).toBe('anthropic'); expect(after.priceVersion).toBe(p2.version); expect(after.apiEquivUsd).toBeGreaterThan(0);
  });
  it('negative zero counts replay as stored zero without repricing or count revision growth', () => {
    const event = makeEvent({ id: 'zero-review', model: 'claude-sonnet-5-5', inputFresh: -0, cacheRead: 1_000_000, output: 100 });
    const { db, before, current } = setup(event); const row = db.prepare('SELECT rowid,* FROM events').get();
    expect(current.upsertEvents([event]).unchanged).toBe(1);
    expect(economics(current.getEvents({})[0])).toEqual(economics(before)); expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
  });
});


function nativeEvent(id: string, input: unknown = 100): UsageEvent {
  const evidence = captureComponentCounts({ input_tokens: input, cache_read_input_tokens: 100, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 100 });
  const tokens = componentCountProjection(evidence).tokens;
  return { ...makeEvent({ id, model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 }), tokens,
    components: [{ model: 'claude-sonnet-5-5', tokens, countEvidence: evidence }] };
}
it('native reported negative zero evidence is semantically the stored zero on replay', () => {
  const event = nativeEvent('native-zero-review', -0); const { db, before, current } = setup(event);
  const row = db.prepare('SELECT rowid,* FROM events').get();
  expect(current.upsertEvents([event]).unchanged).toBe(1);
  expect(economics(current.getEvents({})[0])).toEqual(economics(before)); expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
it('an unsupported count policy replays its unresolved recorded provenance', () => {
  const event = nativeEvent('future-policy-review'); event.components[0].countEvidence!.policy = 'OWNED-FILED-future-policy';
  const { before, current } = setup(event); expect(before.priceStatus).toBe('UNPRICED'); expect(before.tokens.countQuality).toBe('incomplete');
  current.upsertEvents([event]); expect(economics(current.getEvents({})[0])).toEqual(economics(before));
});
it('new malformed native evidence invalidates old numeric valuation; it is not a replay', () => {
  const good = nativeEvent('invalid-review'); const { before, current } = setup(good); expect(before.apiEquivUsd).not.toBeNull();
  current.upsertEvents([nativeEvent(good.id, Number.NaN)]); const after = current.getEvents({})[0];
  expect(after.apiEquivUsd).toBeNull(); expect(after.reservedValue).toBeNull(); expect(after.tokens.countQuality).toBe('invalid');
  expect(after.priceVersion).toBe(currentPricing.version);
});
it('identical malformed native evidence retains its unresolved price and definition provenance', () => {
  const event = nativeEvent('invalid-replay-review', Infinity); const { before, current } = setup(event);
  expect(before.tokens.countQuality).toBe('invalid'); current.upsertEvents([event]);
  expect(economics(current.getEvents({})[0])).toEqual(economics(before));
});
it('differing subset-only count quality is new evidence and withdraws an old stored value', () => {
  const event = nativeEvent('subset-quality-review'); const { before, current } = setup(event); expect(before.reservedValue).not.toBeNull();
  const changed = structuredClone(event); changed.components[0].tokens.ucuCountQuality = 'incomplete'; changed.tokens.ucuCountQuality = 'incomplete';
  // Legacy projection has no raw evidence to override the supplied quality; native policy projection remains authoritative otherwise.
  delete changed.components[0].countEvidence;
  current.upsertEvents([changed]); const after = current.getEvents({})[0]; expect(after.reservedValue).toBeNull();
  expect(after.eacsDefSha256).toBe(new ChangedValuationEngine().defSha256);
});


it('tied absent and standard speed snapshots replay without refreshing recorded valuation', () => {
  const line = (speed?: 'standard') => { const e = nativeEvent('speed-tie-review');
    if (speed) e.components[0].speed = speed; return e; };
  const db = openDb({ file: ':memory:' }); dbs.push(db);
  const old = new SqliteLedger(db, oldPricing, new StubEacsEngine()); old.upsertEvents([line(), line('standard')]);
  const before = old.getEvents({})[0]; expect(before.components[0].speed).toBe('standard');
  const current = new SqliteLedger(db, currentPricing, new ChangedValuationEngine()); current.upsertEvents([line(), line('standard')]);
  expect(economics(current.getEvents({})[0])).toEqual(economics(before));
});
it.each([Infinity, Number.NaN])('malformed request size %s remains unpriced through stored explicit reprice', requestInput => {
  const event = makeEvent({ id: 'invalid-context-review', model: 'gpt-6.1-sol', inputFresh: 100, output: 100 });
  event.components[0].requestInput = requestInput; const { before, current } = setup(event);
  expect(before.apiEquivUsd).toBeNull(); expect(before.flags).toContain('priceContextInvalid');
  current.upsertEvents([before], { reprice: true }); const after = current.getEvents({})[0];
  expect(after.apiEquivUsd).toBeNull(); expect(after.flags).toContain('priceContextInvalid');
});
it('negative zero request size replays as the stored zero without current provenance', () => {
  const event = makeEvent({ id: 'zero-context-review', model: 'gpt-6.1-sol', inputFresh: 100, output: 100 });
  event.components[0].requestInput = -0; const { before, current } = setup(event);
  current.upsertEvents([event]); expect(economics(current.getEvents({})[0])).toEqual(economics(before));
});

it.each([Infinity, Number.NaN])('same malformed request size %s replay retains every recorded row cell', requestInput => {
  const event = makeEvent({ id: 'stored-invalid-replay-review', model: 'gpt-6.1-sol', inputFresh: 100, output: 100 });
  event.components[0].requestInput = requestInput; const { db, before, current } = setup(event);
  const row = db.prepare('SELECT rowid,* FROM events').get(); expect(before.flags).toContain('priceContextInvalid');
  expect(current.upsertEvents([event]).unchanged).toBe(1);
  expect(economics(current.getEvents({})[0])).toEqual(economics(before)); expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});

it('valid zero request size is priced and replays without any recorded row write', () => {
  const event = makeEvent({ id: 'valid-zero-context-review', model: 'gpt-6.1-sol', inputFresh: 0, cacheRead: 0, output: 100 });
  event.components[0].requestInput = -0; const { db, before, current } = setup(event); const row = db.prepare('SELECT rowid,* FROM events').get();
  expect(before.apiEquivUsd).toBeGreaterThan(0); expect(before.priceStatus).not.toBe('UNPRICED');
  expect(current.upsertEvents([event]).unchanged).toBe(1); expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
it('explicit maintenance validates malformed event counters as well as valid component counters', () => {
  const db = openDb({ file: ':memory:' }); dbs.push(db); const computeUnits = createNullEngine(); const ledger = new SqliteLedger(db, currentPricing, computeUnits);
  const event = makeEvent({ id: 'invalid-event-review', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 }); ledger.upsertEvents([event]);
  db.prepare('UPDATE events SET output=?,flags_json=? WHERE id=?').run(100.5,JSON.stringify(['mergedComponentsMisaligned']),event.id);
  const stored = ledger.getEvents({})[0]; expect(stored.tokens.output).toBe(100.5); expect(stored.components[0].tokens.output).toBe(100);
  const preview = currentPricing.priceEvent(stored); const previewUcu = computeUnits.ucuForEvent(stored);
  expect(preview.usd).toBeNull(); expect(previewUcu.reservedValue).toBeNull(); ledger.upsertEvents([stored], { reprice: true }); const after = ledger.getEvents({})[0];
  expect(after.apiEquivUsd).toBe(preview.usd); expect(after.priceStatus).toBe(preview.status); expect(after.reservedValue).toBe(previewUcu.reservedValue); expect(after.ucuRateStatus).toBe(previewUcu.status);
  expect(after.tokens.output).toBe(100.5); expect(after.flags).toContain('priceContextInvalid');
});


it.each([100.5, 150])('unflagged legacy event output %s cannot be replaced by component100 on explicit maintenance', output => {
  const db = openDb({ file: ':memory:' }); dbs.push(db); const computeUnits = createNullEngine(); const ledger = new SqliteLedger(db, currentPricing, computeUnits);
  const event = makeEvent({ id: 'unflagged-count-review', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 }); ledger.upsertEvents([event]);
  db.prepare('UPDATE events SET output=? WHERE id=?').run(output,event.id); const stored = ledger.getEvents({})[0];
  expect(stored.flags).not.toContain('mergedComponentsMisaligned'); expect(stored.tokens.output).toBe(output);
  ledger.upsertEvents([stored],{ reprice: true }); const after = ledger.getEvents({})[0];
  expect(after.tokens.output).toBe(output); expect(after.components[0].tokens.output).toBe(100);
  expect(after.apiEquivUsd).toBeNull(); expect(after.reservedValue).toBeNull(); expect(after.flags).toContain('legacyCountEvidenceMixed');
  expect(after.tokens.countQuality).toBe(output===150 ? 'incomplete' : 'invalid');
  const row = db.prepare('SELECT rowid,* FROM events').get();
  expect(ledger.upsertEvents([after]).unchanged).toBe(1); expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
it('older-writer mismatch with native components retains the event counter rather than reproving a smaller sum', () => {
  const { db, current } = setup(nativeEvent('native-writer-gap'));
  db.prepare('UPDATE events SET output=?').run(150); const stored = current.getEvents({})[0];
  expect(stored.tokens.output).toBe(150); expect(stored.components[0].tokens.output).toBe(100); current.upsertEvents([stored],{ reprice: true }); const after = current.getEvents({})[0];
  expect(after.tokens.output).toBe(150); expect(after.apiEquivUsd).toBeNull(); expect(after.reservedValue).toBeNull();
  expect(after.flags).toContain('legacyCountEvidenceMixed'); expect(after.tokens.countQuality).toBe('incomplete');
  expect(after.components[0].countEvidence?.mergeState).toBe('legacy-mixed');
});
it.each(['incomplete', 'invalid', 'conflict'] as const)('unresolved %s counts retain unknown-model diagnostics on insert and explicit maintenance', countQuality => {
  const event = makeEvent({ id: 'unknown-diagnostic-review', model: 'OWNED-FILED-unmatched', inputFresh: 100, output: 100 });
  event.tokens.countQuality = countQuality; event.components[0].tokens.countQuality = countQuality;
  const { before, current } = setup(event); expect(before.flags).toContain('unpricedModel'); expect(before.apiEquivUsd).toBeNull();
  current.upsertEvents([before],{ reprice: true }); const after = current.getEvents({})[0];
  expect(after.flags).toContain('unpricedModel'); expect(after.apiEquivUsd).toBeNull();
});
it('invalid event counts retain both numeric-invalid and unknown-model reasons', () => {
  const event = makeEvent({ id: 'invalid-top-diagnostic-review', model: 'OWNED-FILED-unmatched', inputFresh: 100, output: 100 });
  event.tokens = { ...event.tokens, output: 100.5 };
  const result = currentPricing.priceEvent(event); expect(result.usd).toBeNull();
  expect(result.flags).toContain('unpricedModel'); expect(result.flags).toContain('priceContextInvalid');
});

it('unresolved event counts retain route and tier component diagnostics', () => {
  const local = currentRows.find(r => r.local)!;
  const routed = makeEvent({ id: 'route-diagnostic', model: local.id, inputFresh: 100, output: 100 });
  routed.components[0].servingRoute = { kind: 'hosted', evidence: 'qwen-oauth' }; routed.tokens = { ...routed.tokens, countQuality: 'incomplete' };
  const routeResult = currentPricing.priceEvent(routed); expect(routeResult.usd).toBeNull(); expect(routeResult.flags).toContain('servingRouteUnpriced');
  const tier = makeEvent({ id: 'tier-diagnostic', model: 'gpt-6.1-sol', inputFresh: 100, output: 100 });
  tier.components[0].speed = 'ultrafast'; tier.tokens = { ...tier.tokens, countQuality: 'incomplete' };
  const rows = structuredClone(currentRows); const tierRow = rows.find(r => r.id === currentPricing.resolve(tier.model)!.id)!; delete tierRow.ultrafast;
  const tierResult = createPricingEngine(rows).priceEvent(tier); expect(tierResult.usd).toBeNull(); expect(tierResult.flags).toContain('priceTierUnsupported');
});
it('an unpriced early component does not hide the later invalid-context reason or expose a partial total', () => {
  const event = makeEvent({ id: 'all-reasons', model: 'OWNED-FILED-unmatched', inputFresh: 100, output: 100 });
  event.components.push({ model: 'gpt-6.1-sol', tokens: { ...event.tokens }, requestInput: Infinity });
  const result = currentPricing.priceEvent(event); expect(result.usd).toBeNull(); expect(result.flags).toContain('unpricedModel'); expect(result.flags).toContain('priceContextInvalid');
});
it('coherent native TTL refinement is allowed to replace assumed1h with explicit5m without losing flat cache work', () => {
  const count = (known: boolean) => captureComponentCounts({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000,
    ...(known ? { cache_creation: { ephemeral_5m_input_tokens: 5000, ephemeral_1h_input_tokens: 0 } } : {}), output_tokens: 100 });
  const line = (known: boolean) => { const evidence = count(known); const tokens = componentCountProjection(evidence).tokens;
    return { ...nativeEvent('ttl-refinement'), tokens, components: [{ model: 'claude-sonnet-5-5', tokens, countEvidence: evidence }] }; };
  const { current } = setup(line(false)); current.upsertEvents([line(true)]); const after = current.getEvents({})[0];
  expect(after.tokens.cacheWrite5m).toBe(5000); expect(after.tokens.cacheWrite1h).toBe(0); expect(after.tokens.cacheWriteAssumed1h).toBe(0);
  expect(after.tokens.countQuality).toBe('complete'); expect(after.flags).not.toContain('legacyCountEvidenceMixed');
});

it.each([50, 99.5, -1])('smaller legacy output %s is retained and qualified instead of resummed into a priced counter', output => {
  const event = makeEvent({ id: 'lower-legacy', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 });
  const { db, current } = setup(event); db.prepare('UPDATE events SET output=?').run(output);
  current.upsertEvents([current.getEvents({})[0]], { reprice: true }); const after = current.getEvents({})[0];
  expect(after.tokens.output).toBe(output); expect(after.components[0].tokens.output).toBe(100);
  expect(after.apiEquivUsd).toBeNull(); expect(after.reservedValue).toBeNull(); expect(after.flags).toContain('legacyCountEvidenceMixed');
  expect(after.tokens.countQuality).toBe(output === 50 ? 'incomplete' : 'invalid');
  expect(current.upsertEvents([after]).unchanged).toBe(1);
});
it.each(['tier', 'context'])('component count hold preserves %s reason', reason => {
  const rows = structuredClone(currentRows); const model = 'gpt-6.1-sol'; delete rows.find(r => r.id === currentPricing.resolve(model)!.id)!.ultrafast;
  const component = { model, tokens: { inputFresh: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 100, reasoning: 0, countQuality: 'incomplete' as const },
    ...(reason === 'tier' ? { speed: 'ultrafast' as const } : { requestInput: Infinity }) };
  const result = createPricingEngine(rows).priceComponent(component); expect(result.usd).toBeNull();
  expect(result.flags).toContain(reason === 'tier' ? 'priceTierUnsupported' : 'priceContextInvalid');
});
it('qualified legacy cache assumption remains disclosed through repeated maintenance', () => {
  const event = makeEvent({ id: 'cache-assumption-replay', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 });
  event.tokens.cacheWrite1h = 5000; event.components[0].tokens.cacheWrite1h = 5000; event.flags = ['cacheSplitAssumed'];
  const { db, current } = setup(event); db.prepare('UPDATE events SET output=150').run();
  current.upsertEvents([current.getEvents({})[0]], { reprice: true }); const after = current.getEvents({})[0];
  expect(after.flags).toContain('cacheSplitAssumed'); expect(current.upsertEvents([after]).unchanged).toBe(1);
  expect(current.getEvents({})[0].flags).toContain('cacheSplitAssumed');
});

it.each(['inputFresh', 'cacheRead', 'output'] as const)('invalid native %s preserves the reported maximum without inventing legacy provenance', key => {
  const rawKey = { inputFresh: 'input_tokens', cacheRead: 'cache_read_input_tokens', output: 'output_tokens' }[key];
  const line = (invalid: boolean) => {
    const raw = { input_tokens: 100, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 100, ...(invalid ? { [rawKey]: NaN } : {}) };
    const countEvidence = captureComponentCounts(raw); const tokens = componentCountProjection(countEvidence).tokens;
    return { ...nativeEvent('native-invalid-provenance'), tokens, components: [{ model: 'claude-sonnet-5-5', tokens, countEvidence }] };
  };
  const db = openDb({ file: ':memory:' }); dbs.push(db); const ledger = new SqliteLedger(db, currentPricing, new StubEacsEngine());
  ledger.upsertEvents([line(false)]); ledger.upsertEvents([line(true)]); const after = ledger.getEvents({})[0];
  expect(after.tokens[key]).toBe(100); expect(after.components[0].tokens[key]).toBe(100); expect(after.tokens.countQuality).toBe('invalid');
  expect(after.flags).toContain('countBasisInvalid'); expect(after.flags).not.toContain('legacyCountEvidenceMixed');
  expect(after.components[0].countEvidence?.mergeState).toBe('monotone'); expect(after.components[0].countEvidence?.[key].state).toBe('invalid');
  expect(after.apiEquivUsd).toBeNull();
  if (key === 'cacheRead') expect(after.reservedValue).not.toBeNull(); else expect(after.reservedValue).toBeNull();
  const stored = db.prepare('SELECT rowid,* FROM events').get(); expect(ledger.upsertEvents([line(true)]).unchanged).toBe(1);
  expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(stored);
});
it.each(['inputFresh', 'cacheRead', 'output'] as const)('invalid native %s retains the maximum across several reported snapshots in every tested order', key => {
  const rawKey = { inputFresh: 'input_tokens', cacheRead: 'cache_read_input_tokens', output: 'output_tokens' }[key];
  const orders = [[100, NaN, 150], [150, NaN, 100], [NaN, 100, 150]];
  for (const [order, values] of orders.entries()) {
    const line = (value: number): UsageEvent => {
      const raw = { input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 100,
        cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        [rawKey]: value };
      const countEvidence = captureComponentCounts(raw), tokens = componentCountProjection(countEvidence).tokens;
      return { ...nativeEvent(`native-invalid-history-${key}-${order}`), tokens,
        components: [{ model: 'claude-sonnet-5-5', tokens, countEvidence }] };
    };
    const db = openDb({ file: ':memory:' }); dbs.push(db);
    const ledger = new SqliteLedger(db, currentPricing, new StubEacsEngine());
    for (const value of values) ledger.upsertEvents([line(value)]);
    const after = ledger.getEvents({})[0];
    expect(after.tokens[key]).toBe(150); expect(after.components[0].tokens[key]).toBe(150);
    expect(after.tokens.countQuality).toBe('invalid'); expect(after.flags).toContain('countBasisInvalid');
    expect(after.flags).not.toContain('legacyCountEvidenceMixed');
    expect(after.components[0].countEvidence?.[key].state).toBe('invalid');
    expect(after.components[0].countEvidence?.mergeState).toBe('monotone');
    expect(after.apiEquivUsd).toBeNull();
    if (key === 'cacheRead') expect(after.reservedValue).not.toBeNull(); else expect(after.reservedValue).toBeNull();
    const stored = db.prepare('SELECT rowid,* FROM events').get();
    expect(ledger.upsertEvents([line(NaN)]).unchanged).toBe(1);
    expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(stored);
  }
});

it.each([50, 150, 99.5, -1])('incoherent initial output %s is held on insert and stable on identical replay', output => {
  const event = makeEvent({ id: 'initial-incoherent', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 });
  event.tokens = { ...event.tokens, output };
  const db = openDb({ file: ':memory:' }); dbs.push(db); const ledger = new SqliteLedger(db, currentPricing, createNullEngine());
  ledger.upsertEvents([event]); const after = ledger.getEvents({})[0];
  expect(after.tokens.output).toBe(output); expect(after.components[0].tokens.output).toBe(100);
  expect(after.apiEquivUsd).toBeNull(); expect(after.reservedValue).toBeNull(); expect(after.flags).toContain('legacyCountEvidenceMixed');
  const stored = db.prepare('SELECT rowid,* FROM events').get(); expect(ledger.upsertEvents([event]).unchanged).toBe(1);
  expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(stored);
});

it.each(['incomplete', 'invalid', 'conflict'] as const)('event-only %s qualification is held on insert and identical replay', countQuality => {
  const event = makeEvent({ id: 'event-only-quality', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 });
  event.tokens = { ...event.tokens, countQuality };
  const db = openDb({ file: ':memory:' }); dbs.push(db); const ledger = new SqliteLedger(db, currentPricing, createNullEngine());
  ledger.upsertEvents([event]); const after = ledger.getEvents({})[0];
  expect(after.tokens.countQuality).toBe(countQuality); expect(after.apiEquivUsd).toBeNull(); expect(after.reservedValue).toBeNull();
  const row = db.prepare('SELECT rowid,* FROM events').get(); expect(ledger.upsertEvents([event]).unchanged).toBe(1);
  expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
it('event-only subset-count hold is preserved independently of valid price counts', () => {
  const event = makeEvent({ id: 'event-only-subset-quality', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 });
  event.tokens = { ...event.tokens, ucuCountQuality: 'incomplete' };
  const db = openDb({ file: ':memory:' }); dbs.push(db); const ledger = new SqliteLedger(db, currentPricing, createNullEngine());
  ledger.upsertEvents([event]); const after = ledger.getEvents({})[0];
  expect(after.apiEquivUsd).not.toBeNull(); expect(after.reservedValue).toBeNull(); expect(after.tokens.ucuCountQuality).toBe('incomplete');
  expect(ledger.upsertEvents([event]).unchanged).toBe(1);
});
const NativeDb = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof import('node:sqlite').DatabaseSync }).DatabaseSync;
function maintenanceHome() {
  const parent = process.env.TMPDIR ?? os.tmpdir(); const root = fs.mkdtempSync(path.join(parent, 'tokenelo-owned-maintenance-'));
  const paths = getPaths({ env: { TOKENELO_HOME: root } });
  const cleanup = () => { expect(path.resolve(root).startsWith(path.resolve(parent) + path.sep)).toBe(true); expect(fs.lstatSync(root).isSymbolicLink()).toBe(false); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, paths, cleanup };
}
function maintenanceSnapshot(db: TokeneloDb) {
  const names = db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return { ddl: db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all(),
    tables: Object.fromEntries(names.map(({ name }) => [name, db.prepare('SELECT * FROM main.' + JSON.stringify(name) + ' ORDER BY rowid').all()])) };
}
it('maintenance reserves writers before the complete backup and releases them after commit', () => {
  const { paths, cleanup } = maintenanceHome(); const db = openDb({ file: paths.dbFile }); const other = openDb({ file: paths.dbFile, migrate: false, busyTimeoutMs: 25 });
  const event = makeEvent({ id: 'maintenance-owned', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1000000, output: 100 });
  const old = new SqliteLedger(db, oldPricing, createNullEngine()); old.upsertEvents([event]); const before = maintenanceSnapshot(db); let blocked = false;
  const original = NativeDb.prototype.exec;
  NativeDb.prototype.exec = function(sql) { const result = original.call(this, sql); if (sql.startsWith('VACUUM INTO ')) { expect(() => other.exec("INSERT INTO meta(key,value) VALUES('OWNED-concurrent','during')")).toThrow(/locked|busy/i); blocked = true; } return result; };
  try {
    const result = repriceLedger(paths, currentPricing, createNullEngine()); expect(result).toMatchObject({ updated: 1, usdChanged: 1 }); expect(blocked).toBe(true);
    const backup = openDb({ file: path.join(paths.dataDir, 'backups', result.backup!), readOnly: true }); try { expect(maintenanceSnapshot(backup)).toEqual(before); } finally { backup.close(); }
    other.exec("INSERT INTO meta(key,value) VALUES('OWNED-concurrent','after')"); expect(other.prepare("SELECT value FROM meta WHERE key='OWNED-concurrent'").get()?.value).toBe('after');
  } finally { NativeDb.prototype.exec = original; other.close(); db.close(); cleanup(); }
});
it('maintenance price failure after the first updated row rolls back every table and retains its backup', () => {
  const { paths, cleanup } = maintenanceHome(); const db = openDb({ file: paths.dbFile }); const old = new SqliteLedger(db, oldPricing, createNullEngine());
  const event = makeEvent({ id: 'maintenance-failure-one', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1000000, output: 100 });
  old.upsertEvents([event, { ...event, id: 'maintenance-failure-two' }]); const before = maintenanceSnapshot(db); let calls = 0;
  const failing = { ...currentPricing, priceEvent: (e: Parameters<PricingEngine['priceEvent']>[0]) => { if (++calls === 4) throw new Error('OWNED failure after first update'); return currentPricing.priceEvent(e); } };
  try {
    expect(() => repriceLedger(paths, failing, createNullEngine())).toThrow('OWNED failure after first update'); expect(calls).toBe(4); expect(maintenanceSnapshot(db)).toEqual(before);
    const files = fs.readdirSync(path.join(paths.dataDir, 'backups')); expect(files).toHaveLength(1); const backup = openDb({ file: path.join(paths.dataDir, 'backups', files[0]), readOnly: true });
    try { expect(maintenanceSnapshot(backup)).toEqual(before); } finally { backup.close(); }
  } finally { db.close(); cleanup(); }
});
it('maintenance backup precedes schema migration on the reserved connection', () => {
  const { paths, cleanup } = maintenanceHome(); fs.mkdirSync(paths.dataDir, { recursive: true }); const prior = new NativeDb(paths.dbFile);
  prior.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','0'); CREATE TABLE owned_recovery(value TEXT); INSERT INTO owned_recovery VALUES('OWNED-FILED prior')"); const before = maintenanceSnapshot(prior); prior.close();
  try {
    const result = repriceLedger(paths, currentPricing, createNullEngine()); expect(result).toMatchObject({ updated: 0, inserted: 0 });
    const backup = new NativeDb(path.join(paths.dataDir, 'backups', result.backup!), { readOnly: true }); try { expect(maintenanceSnapshot(backup)).toEqual(before); } finally { backup.close(); }
    const after = openDb({ file: paths.dbFile, readOnly: true }); try { expect(after.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('10'); expect(after.prepare('SELECT value FROM owned_recovery').get()?.value).toBe('OWNED-FILED prior'); } finally { after.close(); }
  } finally { cleanup(); }
});
it('a migration failure restores the prior schema inside the maintenance boundary', () => {
  const { paths, cleanup } = maintenanceHome(); fs.mkdirSync(paths.dataDir, { recursive: true }); const prior = new NativeDb(paths.dbFile);
  prior.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','0'); CREATE TABLE owned_recovery(value TEXT); INSERT INTO owned_recovery VALUES('OWNED-FILED prior')"); const before = maintenanceSnapshot(prior); prior.close(); const original = NativeDb.prototype.exec;
  NativeDb.prototype.exec = function(sql) { const result = original.call(this, sql); if (/CREATE TABLE activity/.test(sql)) throw new Error('OWNED migration failure after actual DDL'); return result; };
  try {
    expect(() => repriceLedger(paths, currentPricing, createNullEngine())).toThrow('OWNED migration failure after actual DDL');
    const after = new NativeDb(paths.dbFile, { readOnly: true }); try { expect(maintenanceSnapshot(after)).toEqual(before); } finally { after.close(); }
    const files = fs.readdirSync(path.join(paths.dataDir, 'backups')); expect(files).toHaveLength(1);
  } finally { NativeDb.prototype.exec = original; cleanup(); }
});


it.each(['incomplete', 'invalid', 'conflict'] as const)('Q1 event-only subset %s survives explicit reprice and converges after replay under actual v10 triggers', ucuCountQuality => {
  const event = makeEvent({ id: 'subset-writer-policy', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1_000_000, output: 100 });
  event.tokens = { ...event.tokens, ucuCountQuality };
  const { db, before, current } = setup(event);
  expect(before.apiEquivUsd).not.toBeNull(); expect(before.reservedValue).toBeNull();
  const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='projection_invalidate_old_count_writer'").get() as { sql: string };
  expect(trigger.sql).toContain('NEW.ucu_count_quality');
  expect(current.upsertEvents([before], { reprice: true }).updated).toBe(1);
  const after = current.getEvents({})[0];
  expect(after.tokens.ucuCountQuality).toBe(ucuCountQuality); expect(after.apiEquivUsd).toBeCloseTo(0.1012, 12);
  expect(after.reservedValue).toBeNull(); expect(after.ucuRateStatus).toBe('NONE');
  const row = db.prepare('SELECT rowid,* FROM events').get();
  expect(current.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
it('Q2 owned stored complete event with quality-less components retains all recorded economics on ordinary replay', () => {
  const event = makeEvent({ id: 'complete-event-legacy-components', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1_000_000, output: 100 });
  event.tokens = { ...event.tokens, countQuality: 'complete' };
  const { db, current } = setup(event);
  // OWNED-FILED supported writer seed; not evidence that this shape exists in installed capture.
  db.prepare("UPDATE events SET count_quality='complete',ucu_count_quality='complete',count_policy='tokenelo/claude-component-counts@v2',count_revision=COALESCE(count_revision,0)+1 WHERE id=?").run(event.id);
  const recorded = current.getEvents({})[0]; const row = db.prepare('SELECT rowid,* FROM events').get();
  expect(recorded.tokens.countQuality).toBe('complete'); expect(recorded.components[0].tokens.countQuality).toBeUndefined();
  expect(current.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
  expect(economics(current.getEvents({})[0])).toEqual(economics(recorded));
  expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});


function seedOwnedLegacyMaintenance(version: number, destination: string) {
  const source = openDb({ file: ':memory:' });
  try {
    const event = makeEvent({ id: 'owned-legacy-maintenance', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1_000_000, output: 100 });
    new SqliteLedger(source, oldPricing, createNullEngine()).upsertEvents([event]);
    const legacy = ownedLegacySchema(version, source);
    try { fs.mkdirSync(path.dirname(destination), { recursive: true }); legacy.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
    finally { legacy.close(); }
  } finally { source.close(); }
}
it('M3 genuine schema9 populated maintenance matches migrate-first reprice and preserves the complete prior recovery basis', () => {
  const a = maintenanceHome(), b = maintenanceHome();
  seedOwnedLegacyMaintenance(9, a.paths.dbFile); fs.mkdirSync(b.paths.dataDir, { recursive: true }); fs.copyFileSync(a.paths.dbFile, b.paths.dbFile);
  const prior = new NativeDb(a.paths.dbFile, { readOnly: true }); const before = maintenanceSnapshot(prior); prior.close();
  try {
    const reference = openDb({ file: b.paths.dbFile });
    let expected: UsageEvent[];
    try { const ledger = new SqliteLedger(reference, currentPricing, createNullEngine()); const rows = ledger.getEvents({}); expect(rows).toHaveLength(1); ledger.upsertEvents(rows, { reprice: true }); expected = ledger.getEvents({}); }
    finally { reference.close(); }
    const result = repriceLedger(a.paths, currentPricing, createNullEngine()); expect(result.updated).toBe(1);
    const actual = openDb({ file: a.paths.dbFile });
    try {
      expect(new SqliteLedger(actual, currentPricing, createNullEngine()).getEvents({})).toEqual(expected);
      expect(actual.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('10');
      expect(actual.prepare('SELECT * FROM main.events ORDER BY rowid').all()).toEqual(before.tables.events);
    } finally { actual.close(); }
    const backup = new NativeDb(path.join(a.paths.dataDir, 'backups', result.backup!), { readOnly: true });
    try { expect(maintenanceSnapshot(backup)).toEqual(before); } finally { backup.close(); }
  } finally { a.cleanup(); b.cleanup(); }
});
it('M4 migration10 failure after a released migration9 savepoint restores the genuine populated schema8 basis', () => {
  const { paths, cleanup } = maintenanceHome(); seedOwnedLegacyMaintenance(8, paths.dbFile);
  const prior = new NativeDb(paths.dbFile, { readOnly: true }); const before = maintenanceSnapshot(prior); prior.close();
  const original = NativeDb.prototype.exec; let injected = false;
  NativeDb.prototype.exec = function(sql) {
    const result = original.call(this, sql);
    if (/^CREATE TABLE event_projection\s*\(/i.test(sql)) {
      expect(this.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value).toBe('9');
      expect(this.prepare("SELECT name FROM sqlite_schema WHERE name='event_projection'").get()?.name).toBe('event_projection');
      injected = true; throw new Error('OWNED released-v9-then-v10-DDL failure');
    }
    return result;
  };
  try {
    expect(() => repriceLedger(paths, currentPricing, createNullEngine())).toThrow('OWNED released-v9-then-v10-DDL failure'); expect(injected).toBe(true);
    const after = new NativeDb(paths.dbFile, { readOnly: true }); try { expect(maintenanceSnapshot(after)).toEqual(before); } finally { after.close(); }
    const files = fs.readdirSync(path.join(paths.dataDir, 'backups')); expect(files).toHaveLength(1);
    const backup = new NativeDb(path.join(paths.dataDir, 'backups', files[0]), { readOnly: true }); try { expect(maintenanceSnapshot(backup)).toEqual(before); } finally { backup.close(); }
  } finally { NativeDb.prototype.exec = original; cleanup(); }
});
it('M4 reprice failure after a complete schema9 to10 migration restores every prior table and DDL', () => {
  const { paths, cleanup } = maintenanceHome(); seedOwnedLegacyMaintenance(9, paths.dbFile);
  const prior = new NativeDb(paths.dbFile, { readOnly: true }); const before = maintenanceSnapshot(prior); prior.close(); let calls = 0;
  const failing = { ...currentPricing, priceEvent: (e: Parameters<PricingEngine['priceEvent']>[0]) => { if (++calls === 2) throw new Error('OWNED price failure after migration10'); return currentPricing.priceEvent(e); } };
  try {
    expect(() => repriceLedger(paths, failing, createNullEngine())).toThrow('OWNED price failure after migration10'); expect(calls).toBe(2);
    const after = new NativeDb(paths.dbFile, { readOnly: true }); try { expect(maintenanceSnapshot(after)).toEqual(before); } finally { after.close(); }
    const files = fs.readdirSync(path.join(paths.dataDir, 'backups')); expect(files).toHaveLength(1);
    const backup = new NativeDb(path.join(paths.dataDir, 'backups', files[0]), { readOnly: true }); try { expect(maintenanceSnapshot(backup)).toEqual(before); } finally { backup.close(); }
  } finally { cleanup(); }
});


it.each([false, true])('F1 independent subset-complete quality survives an event-only overall hold; explicit component claim %s', componentClaim => {
  const event = makeEvent({ id: 'independent-subset-complete', model: 'claude-sonnet-5-5', inputFresh: 100, output: 100 });
  event.tokens = { ...event.tokens, countQuality: 'incomplete', ucuCountQuality: 'complete' };
  if (componentClaim) event.components = event.components.map(c => ({ ...c, tokens: { ...c.tokens, countQuality: 'complete' } }));
  const db = openDb({ file: ':memory:' }); dbs.push(db); const ledger = new SqliteLedger(db, currentPricing, new StubEacsEngine());
  ledger.upsertEvents([event]); const after = ledger.getEvents({})[0];
  expect(after.apiEquivUsd).toBeNull(); expect(after.tokens.countQuality).toBe('incomplete');
  expect(after.tokens.ucuCountQuality).toBe('complete'); expect(after.reservedValue).toBe(2);
  const row = db.prepare('SELECT rowid,* FROM events').get(); expect(ledger.upsertEvents([event]).unchanged).toBe(1); expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
it('F2 lower complete incoming claim cannot certify larger retained legacy counts or silently refresh their price', () => {
  const stored = makeEvent({ id: 'legacy-larger', model: 'claude-sonnet-5-5', inputFresh: 100, cacheRead: 1_000_000, output: 120 });
  const { current, before } = setup(stored);
  const incoming = makeEvent({ id: stored.id, model: stored.model, inputFresh: 100, cacheRead: 1_000_000, output: 100 }); incoming.tokens = { ...incoming.tokens, countQuality: 'complete' };
  current.upsertEvents([incoming]); const after = current.getEvents({})[0];
  expect(after.tokens.output).toBe(120); expect(after.tokens.countQuality).not.toBe('complete'); expect(economics(after)).toEqual(economics(before));
});
it.each([false,true])('F3 stored complete mixed-component claim keeps recorded economics on identical replay; reversed %s', reverse => {
  const event = makeEvent({ id: 'mixed-component-complete', model: 'claude-sonnet-5-5', inputFresh: 200, cacheRead: 1_000_000, output: 200 });
  const first = { model: event.model, tokens: { inputFresh:100,cacheRead:1_000_000,cacheWrite5m:0,cacheWrite1h:0,output:100,reasoning:0,countQuality:'complete' as const } };
  const second = { model: event.model, tokens: { inputFresh:100,cacheRead:0,cacheWrite5m:0,cacheWrite1h:0,output:100,reasoning:0 } };
  event.components = reverse ? [second,first] : [first,second]; event.tokens = { ...event.tokens, countQuality: 'complete' };
  const { db,current } = setup(event);
  // Controlled supported writer seed; this is not an installed emitter-population claim.
  db.prepare("UPDATE events SET count_quality='complete',ucu_count_quality='complete',count_policy='tokenelo/claude-component-counts@v2',count_revision=COALESCE(count_revision,0)+1 WHERE id=?").run(event.id);
  const before=current.getEvents({})[0];const row=db.prepare('SELECT rowid,* FROM events').get();
  expect(current.upsertEvents([event])).toEqual({inserted:0,updated:0,unchanged:1});expect(economics(current.getEvents({})[0])).toEqual(economics(before));expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);
});
