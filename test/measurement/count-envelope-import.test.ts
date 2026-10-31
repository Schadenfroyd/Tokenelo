import { describe, expect, it } from 'vitest';
import { captureCountEnvelope } from '../../src/measurement/count-envelope.js';
import { importCountEnvelope, MAX_COUNT_ENVELOPE_JSON_LENGTH } from '../../src/measurement/count-envelope-import.js';

const raw = (patch: Record<string, unknown> = {}) => ({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 100, ...patch });
const packet = (usage: unknown) => {
  const e = captureCountEnvelope(usage); expect(e.kind).toBe('count-envelope'); return e;
};
const accepted = (serialized: string) => {
  const r = importCountEnvelope(serialized); expect(r.kind).toBe('count-envelope-import');
  if (r.kind !== 'count-envelope-import') throw Error('Expected admitted serialized count envelope'); return r.envelope;
};
describe('private serialized count-envelope import', () => {
  it('accepts producer packets independent of JSON key order and detaches the result', () => {
    const e = packet(raw()); const reordered = Object.fromEntries(Object.entries(e).reverse());
    expect(accepted(JSON.stringify(reordered))).toEqual(e);
    expect(accepted(JSON.stringify(e))).not.toBe(e);
  });
  it('preserves missing/full versus known fresh-work scope', () => {
    const input = raw(); delete (input as Record<string, unknown>).cache_read_input_tokens;
    const e = accepted(JSON.stringify(packet(input)));
    expect(e.totals.full).toEqual({ quality: 'incomplete', value: null }); expect(e.totals.freshWork.value).toBe(105);
  });
  it('keeps exact cache totals, explicit zero TTL and unknown residual separate from assumed TTL', () => {
    for (const nested of [undefined, null, {}, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, { ephemeral_5m_input_tokens: 40 }]) {
      const e = packet(raw({ cache_creation: nested })); expect(accepted(JSON.stringify(e))).toEqual(e);
    }
  });
  it('admits invalid/fractional/unsafe/conflicting evidence without promoting totals', () => {
    for (const patch of [{ input_tokens: 1.5 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }, { input_tokens: -1 }, { input_tokens: 'private-marker' }, { cache_creation: { ephemeral_5m_input_tokens: 110 } }]) {
      const e = accepted(JSON.stringify(packet(raw(patch)))); expect(e.totals.full.value).toBeNull(); expect(JSON.stringify(e)).not.toContain('private-marker');
    }
    const invalidTtl = packet(raw({ cache_creation: 'private-marker' }));
    const imported = accepted(JSON.stringify(invalidTtl)); expect(imported).toEqual(invalidTtl); expect(imported.cache.invalidTtlEvidence).toBe(true);
  });
  it('rejects counter/quality/TTL/total/policy contradictions rather than repairing them', () => {
    const change = [
      (e: any) => { e.categories.inputFresh = 99; }, (e: any) => { e.totals.full.value = 99; },
      (e: any) => { e.totals.full.quality = 'invalid'; }, (e: any) => { e.cache.ttlBasis = 'reported-ttl'; },
      (e: any) => { e.policies.dedup = 'applied'; }, (e: any) => { e.observations.cacheCreation.ephemeral5m = { state: 'reported', value: 7 }; },
    ];
    for (const mutate of change) { const e = packet(raw()); mutate(e); expect(importCountEnvelope(JSON.stringify(e))).toMatchObject({ kind: 'rejected', reason: 'inconsistent-envelope' }); }
  });
  it('rejects arbitrary metadata at the packet, nested category and observation field levels', () => {
    for (const mutate of [(e: any) => { e.sessionId = 'private-marker'; }, (e: any) => { e.categories.model = 'private-marker'; }, (e: any) => { e.observations.output.content = 'private-marker'; }]) {
      const e = packet(raw()); mutate(e); const result = importCountEnvelope(JSON.stringify(e)); expect(result).toMatchObject({ kind: 'rejected', reason: 'inconsistent-envelope' }); expect(JSON.stringify(result)).not.toContain('private-marker');
    }
  });
  it('rejects bad field/container shapes and future contracts with fixed reasons', () => {
    for (const mutate of [(e: any) => { e.observations.output = { state: 'reported', value: null }; }, (e: any) => { e.observations.cacheCreation.container = 'future'; }]) {
      const e = packet(raw()); mutate(e); expect(importCountEnvelope(JSON.stringify(e))).toMatchObject({ kind: 'rejected', reason: 'invalid-envelope' });
    }
    const e = packet(raw()); (e as any).contractVersion = 'future/private-marker'; expect(importCountEnvelope(JSON.stringify(e))).toMatchObject({ kind: 'rejected', reason: 'unsupported-contract' });
  });
  it('bounds parsing and accepts no in-process getter objects', () => {
    let calls = 0; const object = { get contractVersion() { calls++; throw Error('Must not invoke getter'); } };
    expect(importCountEnvelope(object)).toMatchObject({ kind: 'rejected', reason: 'json-string-required' }); expect(calls).toBe(0);
    expect(importCountEnvelope(' '.repeat(MAX_COUNT_ENVELOPE_JSON_LENGTH + 1))).toMatchObject({ kind: 'rejected', reason: 'packet-too-large' });
    expect(importCountEnvelope('private-marker')).toMatchObject({ kind: 'rejected', reason: 'invalid-json' });
    for (const text of ['null', '[]', '1', '"private-marker"']) expect(importCountEnvelope(text)).toMatchObject({ kind: 'rejected', reason: 'invalid-envelope' });
  });
});
