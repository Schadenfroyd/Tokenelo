import { expect, it } from 'vitest';
import { captureNativeCounters, mergeNativeCounters, nativeCounterProjection } from '../../src/measurement/native-counter-evidence.js';
import { buildOllamaUsageEvent, parseNativeLine } from '../../src/collectors/ollama-proxy.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { StubValuationEngine, StubPricingEngine } from '../store/stubs.js';

const model = 'OWNED-NONGENERATING-FIXTURE';
function event(raw: Record<string, unknown>) {
  const final = parseNativeLine(JSON.stringify({ model, done: true, ...raw }))!;
  return { ...buildOllamaUsageEvent({ host: 'OWNED', model, ts: 1, requestStartNs: 1n, entrypoint: 'owned',
    tokens: nativeCounterProjection(final.nativeCounterEvidence), nativeCounterEvidence: final.nativeCounterEvidence }),
    id: 'OWNED-same-request-observation' };
}

it.each([
  { label: 'missing output', raw: { prompt_eval_count: 3 }, input: 3, output: 0, quality: 'incomplete', state: 'missing' },
  { label: 'reported output zero', raw: { prompt_eval_count: 3, eval_count: 0 }, input: 3, output: 0, quality: 'complete', state: 'reported' },
  { label: 'missing input', raw: { eval_count: 5 }, input: 0, output: 5, quality: 'incomplete', state: 'reported' },
  { label: 'invalid output text', raw: { prompt_eval_count: 3, eval_count: 'PRIVATE-RESPONSE-TEXT' }, input: 3, output: 0, quality: 'invalid', state: 'invalid' },
  { label: 'negative output', raw: { prompt_eval_count: 3, eval_count: -1 }, input: 3, output: 0, quality: 'invalid', state: 'invalid' },
  { label: 'fractional output', raw: { prompt_eval_count: 3, eval_count: 0.5 }, input: 3, output: 0, quality: 'invalid', state: 'invalid' },
  { label: 'unsafe output', raw: { prompt_eval_count: 3, eval_count: Number.MAX_SAFE_INTEGER + 1 }, input: 3, output: 0, quality: 'invalid', state: 'invalid' },
  { label: 'reported cache hit', raw: { prompt_eval_count: 18, prompt_eval_cached_count: 13, eval_count: 8 }, input: 5, output: 8, quality: 'complete', state: 'reported' },
])('$label retains field evidence, qualifies valuation and replays without revision', sample => {
  const db = openDb({ file: ':memory:' });
  try {
    const ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
    const incoming = event(sample.raw);
    expect(ledger.upsertEvents([incoming])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    const [stored] = ledger.getEvents({});
    expect(stored.tokens).toMatchObject({ inputFresh: sample.input, output: sample.output, countQuality: sample.quality });
    expect(stored.components[0]!.nativeCounterEvidence!.snapshots[0]!.eval_count.state).toBe(sample.state);
    expect(JSON.stringify(stored.components)).not.toContain('PRIVATE-RESPONSE-TEXT');
    if (sample.quality !== 'complete') {
      expect(stored.apiEquivUsd).toBeNull(); expect(stored.reservedValue).toBeNull();
      expect(stored.flags).not.toContain('legacyCountEvidenceMixed');
    } else {
      expect(stored.apiEquivUsd).not.toBeNull(); expect(stored.reservedValue).not.toBeNull();
    }
    const before = db.prepare('SELECT components_json,count_revision,api_equiv_usd,price_version,ucu FROM events').get();
    expect(ledger.upsertEvents([incoming])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
    expect(db.prepare('SELECT components_json,count_revision,api_equiv_usd,price_version,ucu FROM events').get()).toEqual(before);
  } finally { db.close(); }
});

it('a later reported output enriches the same request without dropping known input or adding an event', () => {
  const db = openDb({ file: ':memory:' });
  try {
    const ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
    ledger.upsertEvents([event({ prompt_eval_count: 3 })]);
    ledger.upsertEvents([event({ prompt_eval_count: 3, eval_count: 5 })]);
    const rows = ledger.getEvents({}); expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toMatchObject({ inputFresh: 3, output: 5, countQuality: 'complete' });
    expect(rows[0]!.components[0]!.nativeCounterEvidence!.snapshots).toHaveLength(2);
  } finally { db.close(); }
});

it('a capped raw history keeps the largest actually reported fields and withholds completeness', () => {
  let evidence = captureNativeCounters({ prompt_eval_count: 1, eval_count: 1 });
  for (let value = 2; value <= 65; value++) evidence = mergeNativeCounters(evidence, captureNativeCounters({ prompt_eval_count: value, eval_count: value }))!;
  expect(evidence.snapshots).toHaveLength(64);
  expect(nativeCounterProjection(evidence)).toMatchObject({ inputFresh: 65, output: 65, countQuality: 'incomplete' });
});

it('cache and prompt reports from different snapshots cannot certify cached counts greater than the gross prompt', () => {
  const merged = mergeNativeCounters(captureNativeCounters({ prompt_eval_cached_count: 15, eval_count: 4 }),
    captureNativeCounters({ prompt_eval_count: 10, eval_count: 4 }))!;
  expect(nativeCounterProjection(merged).countQuality).toBe('invalid');
  const db = openDb({ file: ':memory:' });
  try {
    const ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
    ledger.upsertEvents([event({ prompt_eval_cached_count: 15, eval_count: 4 })]);
    ledger.upsertEvents([event({ prompt_eval_count: 10, eval_count: 4 })]);
    const [row] = ledger.getEvents({});
    expect(row.tokens.countQuality).toBe('invalid');
    expect(row.apiEquivUsd).toBeNull(); expect(row.reservedValue).toBeNull();
    expect(row.components[0]!.nativeCounterEvidence!.snapshots).toHaveLength(2);
  } finally { db.close(); }
});

it('an unsupported native policy remains inspectable and held after repeated current-policy replays', () => {
  const db = openDb({ file: ':memory:' });
  try {
    const ledger = new SqliteLedger(db, new StubPricingEngine(), new StubValuationEngine());
    const future = event({ prompt_eval_count: 3, eval_count: 1 });
    future.components[0]!.nativeCounterEvidence = { ...future.components[0]!.nativeCounterEvidence!,
      policy: 'tokenelo/ollama-native-counters@v99' } as unknown as NonNullable<typeof future.components[0]['nativeCounterEvidence']>;
    ledger.upsertEvents([future]);
    const current = event({ prompt_eval_count: 3, eval_count: 5 });
    ledger.upsertEvents([current]); ledger.upsertEvents([current]);
    const [row] = ledger.getEvents({});
    expect(row.components[0]!.nativeCounterEvidence!.policy).toBe('tokenelo/ollama-native-counters@v99');
    expect(row.tokens.countQuality).toBe('incomplete');
    expect(row.flags).toContain('countPolicyUnsupported');
    expect(row.apiEquivUsd).toBeNull(); expect(row.reservedValue).toBeNull();
  } finally { db.close(); }
});
