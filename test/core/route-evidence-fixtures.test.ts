/**
 * Falsifiable ROUTE-EVIDENCE fixtures (follow-up to decision D4, docs/cloud/CLAUDE-INBOX-2026-10-17.md:
 * "add falsifiable route fixtures before proposing implementation").
 *
 * test/fixtures/route-evidence-2026-10-18/ holds fabricated components for the six route states
 * (local-reported, hosted-reported, unrecorded, unknown, invalid, conflict). THIS FILE ASSERTS ONLY TODAY'S
 * BEHAVIOR, so the fixtures are proven to exercise the code:
 *   components.json         inputs (read here)
 *   current-behavior.json   what the code classifies today (read and asserted here)
 * It deliberately does NOT read target-d4-classification.json. That file records, as plain data, the
 * classification decision D4 would require; it is a proposal for the owner and today's code does not meet it
 * (the unrecorded cases differ). No test asserts it, so no failing test is added.
 *
 * Nothing here decides D4. A weights-name match is still priced at the local zero rate when the route is
 * unrecorded, and one case below pins that and the proxy's route-less event shape so the open question stays
 * visible. Standard API-equivalent value, served tier and invoice cost are not modelled by these fixtures.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowsLocalRatePolicy, componentRouteState, isServingRouteState, type ServingRouteState } from '../../src/core/serving-route.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { buildOllamaUsageEvent } from '../../src/collectors/ollama-proxy.js';
import { captureNativeCounters, nativeCounterProjection } from '../../src/measurement/native-counter-evidence.js';
import type { UsageComponent, UsageEvent } from '../../src/core/types.js';

const DIR = path.join(process.cwd(), 'test', 'fixtures', 'route-evidence-2026-10-18');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
interface Case { id: string; routeState: ServingRouteState; note: string; component: UsageComponent }
interface Current {
  routeState: ServingRouteState; allowsLocalRatePolicy: boolean; providerOf: string;
  priceComponent: { usd: number | null; status: string; flags: string[] };
  storedByLedger: { provider: string; apiEquivUsd: number | null; priceStatus: string; routeFlags: string[] };
}
const cases: Case[] = read('components.json').cases;
const current: Record<string, Current> = read('current-behavior.json').cases;
const pricing = defaultPricingEngine();
const valuationEngine = createNullEngine();

const eventFor = (c: UsageComponent, id: string): UsageEvent => ({
  id, host: 'SYNTH', source: 'qwen-code', ts: 1_790_000_000_000, tsSource: 'line', sessionId: 'route-fixture-session', isSubagent: false,
  model: c.model, provider: pricing.providerOf(c.model, c.servingRoute), thinking: false, components: [c], tokens: c.tokens, flags: [],
  apiEquivUsd: 0, priceStatus: 'LIST', priceVersion: pricing.version, reservedValue: null, ucuRateStatus: 'NONE', eacsDefSha256: valuationEngine.defSha256,
});

describe('route-evidence fixtures: shape and hygiene', () => {
  it('cover all six route states, have unique ids, one current-behavior row each, and carry only fabricated content', () => {
    expect(new Set(cases.map(c => c.id)).size).toBe(cases.length);
    expect([...new Set(cases.map(c => c.routeState))].sort()).toEqual(['conflict', 'hosted-reported', 'invalid', 'local-reported', 'unknown', 'unrecorded']);
    expect(cases.every(c => isServingRouteState(c.routeState))).toBe(true);
    expect(Object.keys(current).sort()).toEqual(cases.map(c => c.id).sort());
    for (const c of cases) {
      expect(Object.keys(c.component).filter(k => !['model', 'tokens', 'servingRoute'].includes(k)), c.id).toEqual([]);
      // "unrecorded" is the ABSENCE of the key; every other state has the key present (null included).
      expect(Object.hasOwn(c.component, 'servingRoute'), c.id).toBe(c.routeState !== 'unrecorded');
    }
    const strings: string[] = [];
    (function collect(v: unknown): void {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    })(read('components.json').cases);
    // Values only: no URL, address, credential-like or absolute-path string anywhere in the inputs.
    expect(strings.filter(s => /:\/\/|@|\\|^[/~]|^[A-Za-z]:/.test(s))).toEqual([]);
  });
});

describe('route-evidence fixtures: CURRENT behavior (not a statement of what it should be)', () => {
  it('classifies every case into the labelled route state, and only unrecorded and local-reported admit the local rate policy', () => {
    for (const c of cases) {
      const state = componentRouteState(c.component);
      expect(state, c.id).toBe(c.routeState);
      expect(state, c.id).toBe(current[c.id]!.routeState);
      expect(allowsLocalRatePolicy(state), c.id).toBe(current[c.id]!.allowsLocalRatePolicy);
    }
    expect(cases.filter(c => allowsLocalRatePolicy(componentRouteState(c.component))).map(c => c.id).sort())
      .toEqual(['local-reported', 'unrecorded-hosted-looking-weights-name', 'unrecorded-weights-name']);
  });

  it('prices each case as the real pricing engine does today: local zero rate for the two admitted states, unpriced with a route flag for every other', () => {
    for (const c of cases) {
      const want = current[c.id]!;
      const priced = pricing.priceComponent(c.component);
      expect({ usd: priced.usd, status: priced.status, flags: priced.flags }, c.id).toEqual(want.priceComponent);
      expect(pricing.providerOf(c.component.model, c.component.servingRoute), c.id).toBe(want.providerOf);
    }
  });

  it('[pins current legacy policy] a hosted-looking weights name with no route evidence is still priced as free local work', () => {
    const c = cases.find(x => x.id === 'unrecorded-hosted-looking-weights-name')!;
    expect(c.component.model).toBe('qwen/qwen3-coder-fabricated');
    expect(pricing.priceComponent(c.component)).toMatchObject({ usd: 0, status: 'LIST' });
    expect(pricing.providerOf(c.component.model)).toBe('local');
    // The same model with an explicit unknown route is unpriced: affirmative evidence, not the name, is what the code distinguishes.
    expect(pricing.priceComponent({ ...c.component, servingRoute: { kind: 'unknown', evidence: 'unrecorded' } })).toMatchObject({ usd: null, status: 'UNPRICED' });
  });

  it('records each case in the ledger as expected today: provider, amount, price status and route flags', () => {
    const db = openDb({ file: ':memory:' });
    try {
      const ledger = new SqliteLedger(db, pricing, valuationEngine);
      for (const c of cases) ledger.upsertEvents([eventFor(c.component, `route-fixture-${c.id}`)]);
      const stored = new Map(ledger.getEvents({}).map(e => [e.id, e]));
      for (const c of cases) {
        const row = stored.get(`route-fixture-${c.id}`)!;
        const want = current[c.id]!.storedByLedger;
        expect({ provider: row.provider, apiEquivUsd: row.apiEquivUsd, priceStatus: row.priceStatus,
          routeFlags: row.flags.filter(f => f.startsWith('servingRoute')).sort() }, c.id).toEqual(want);
      }
    } finally { db.close(); }
  });

  it('[pins current legacy policy] an event built by the metering proxy carries no servingRoute key, so it is an unrecorded route', () => {
    const evidence = captureNativeCounters({ prompt_eval_count: 7, eval_count: 3 });
    const event = buildOllamaUsageEvent({ host: 'SYNTH', model: 'qwen3:8b', ts: 1, requestStartNs: 1n, entrypoint: 'synth',
      tokens: nativeCounterProjection(evidence), nativeCounterEvidence: evidence });
    expect(event.provider).toBe('local');
    expect(Object.hasOwn(event.components[0]!, 'servingRoute')).toBe(false);
    expect(componentRouteState(event.components[0]!)).toBe('unrecorded');
    expect(allowsLocalRatePolicy(componentRouteState(event.components[0]!))).toBe(true);
  });
});
