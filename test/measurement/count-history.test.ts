import { describe, expect, it } from 'vitest';
import { captureCountEnvelope } from '../../src/measurement/count-envelope.js';
import { captureCountHistory, MAX_COUNT_HISTORY_JSON_LENGTH, MAX_COUNT_HISTORY_PACKETS } from '../../src/measurement/count-history.js';
const raw = (patch: Record<string, unknown> = {}) => ({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 100, ...patch });
const history = (...snapshots: Record<string, unknown>[]) => {
  const result = captureCountHistory(JSON.stringify(snapshots.map(r => JSON.stringify(captureCountEnvelope(r)))));
  expect(result.kind).toBe('count-history'); if (result.kind !== 'count-history') throw Error('Expected admitted same-component count history'); return result;
};
describe('private same-component count history', () => {
  it('merges monotone snapshots once and is order-independent for these counts', () => {
    const a = raw(), b = raw({ input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 6, cache_creation_input_tokens: 120 });
    const forward = history(a,b), reverse = history(b,a);
    expect(forward.totals).toEqual({ full: { quality: 'complete', value: 134 }, freshWork: { quality: 'complete', value: 128 } });
    expect(reverse).toEqual(forward); expect(forward.history).toMatchObject({ receivedPackets: 2, distinctSnapshots: 2, mergeState: 'monotone' });
  });
  it('coalesces equal counter vectors without claiming event dedup', () => {
    const h = history(raw(),raw()); expect(h.totals.full.value).toBe(109);
    expect(h.history.receivedPackets).toBe(2); expect(h.history.distinctSnapshots).toBe(1);
    expect(h.policies.identity).toBe('caller-unverified'); expect(h.policies.eventDedup).toBe('not-applied');
    expect(h).not.toHaveProperty('model'); expect(h).not.toHaveProperty('reservedValue');
  });
  it('retains opposing counter movement as conflict rather than adding maxima into a known total', () => {
    const h = history(raw(),raw({ input_tokens: 1, output_tokens: 4 }));
    expect(h.history.mergeState).toBe('incomparable'); expect(h.totals.full).toEqual({ quality: 'conflict', value: null }); expect(h.totals.freshWork.value).toBeNull();
  });
  it('can resolve missing evidence but preserves recorded invalidity', () => {
    const missing = raw(); delete (missing as Record<string, unknown>).cache_read_input_tokens;
    const partial = history(missing); expect(partial.totals.full.value).toBeNull(); expect(partial.totals.freshWork.value).toBe(105);
    expect(history(missing,raw()).totals.full.value).toBe(109);
    const invalid = history(raw({ input_tokens: 'private-marker' }),raw()); expect(invalid.history.countHistoryInvalid).toBe(true); expect(invalid.totals.full.value).toBeNull(); expect(JSON.stringify(invalid)).not.toContain('private-marker');
  });
  it('retains invalid TTL history even when later split evidence is valid', () => {
    const h = history(raw({ cache_creation: 'private-marker' }),raw({ cache_creation: { ephemeral_1h_input_tokens: 100 } }));
    expect(h.history.ttlHistoryInvalid).toBe(true); expect(h.cache.invalidTtlEvidence).toBe(true);
  });
  it('bounds history and parsing before accepting packets', () => {
    expect(MAX_COUNT_HISTORY_PACKETS).toBe(64);
    expect(captureCountHistory(JSON.stringify(new Array(65).fill('invalid')))).toMatchObject({ kind:'rejected',reason:'history-packet-limit' });
    expect(captureCountHistory(' '.repeat(MAX_COUNT_HISTORY_JSON_LENGTH+1))).toMatchObject({ kind:'rejected',reason:'history-too-large' });
    expect(captureCountHistory('private-marker')).toMatchObject({ kind:'rejected',reason:'invalid-history-json' });
    for (const input of ['[]','null','{}']) expect(captureCountHistory(input)).toMatchObject({ kind:'rejected',reason:'packet-list-required' });
  });
  it('reports only fixed packet refusal/ordinal and never reads in-process getters', () => {
    let calls=0; const input={get packets(){calls++;throw Error('Must not read getter');}};
    expect(captureCountHistory(input)).toMatchObject({kind:'rejected',reason:'history-string-required'}); expect(calls).toBe(0);
    const r=captureCountHistory(JSON.stringify([JSON.stringify(captureCountEnvelope(raw())),'private-marker']));
    expect(r).toMatchObject({kind:'rejected',reason:'packet-refused',packetIndex:1,packetReason:'invalid-json'}); expect(JSON.stringify(r)).not.toContain('private-marker');
  });
});
