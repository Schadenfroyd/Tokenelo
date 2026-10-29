import { describe, expect, it } from 'vitest';
import { captureCountEnvelope } from '../../src/measurement/count-envelope.js';
import type { CountEnvelope } from '../../src/measurement/count-envelope-types.js';

const raw = (patch: Record<string, unknown> = {}) => ({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 100, ...patch });
const envelope = (input: unknown): CountEnvelope => {
  const result = captureCountEnvelope(input);
  expect(result.kind).toBe('count-envelope');
  if (result.kind !== 'count-envelope') throw Error('Expected admitted single component');
  return result;
};
describe('private count-only envelope', () => {
  it('counts cache creation once and preserves partial TTL residual', () => {
    const e = envelope(raw({ cache_creation: { ephemeral_5m_input_tokens: 40 } }));
    expect(e.totals.full).toEqual({ quality: 'complete', value: 109 });
    expect(e.totals.freshWork).toEqual({ quality: 'complete', value: 105 });
    expect(e.categories.cacheWriteUnassigned).toBe(60);expect(e.cache.ttlBasis).toBe('unknown-ttl');
  });
  it('keeps explicit zero TTL distinct from source fallback', () => {
    const assumed = envelope(raw()), zeroSplit = envelope(raw({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }));
    expect(assumed.categories.cacheWriteAssumed1h).toBe(100);expect(assumed.categories.cacheWrite1h).toBe(100);
    expect(zeroSplit.categories.cacheWriteAssumed1h).toBe(0);expect(zeroSplit.categories.cacheWriteUnassigned).toBe(100);
    expect(assumed.totals.full.value).toBe(zeroSplit.totals.full.value);
  });
  it('keeps missing reads separate from known fresh-work count', () => {
    const input = raw();delete input.cache_read_input_tokens;const e = envelope(input);
    expect(e.observations.cacheRead).toEqual({ state:'missing',value:null });
    expect(e.totals.full).toEqual({ quality:'incomplete',value:null });expect(e.totals.freshWork.value).toBe(105);
  });
  it('does not coerce fractional, unsafe, negative or string counters into known totals', () => {
    for (const value of [1.5,Number.MAX_SAFE_INTEGER+1,-1,'secret-in-count',null]) {
      const e = envelope(raw({ input_tokens:value }));expect(e.totals.full.value).toBeNull();expect(e.totals.freshWork.value).toBeNull();expect(e.totals.full.quality).toBe('invalid');
      expect(JSON.stringify(e)).not.toContain('secret-in-count');
    }
  });
  it('retains conflict and lower-bound-only cache work without invented totals', () => {
    const conflict = envelope(raw({ cache_creation: { ephemeral_5m_input_tokens: 110 } }));
    expect(conflict.cache.ttlBasis).toBe('conflict');expect(conflict.totals.full.value).toBeNull();
    const input=raw({cache_creation:{ephemeral_5m_input_tokens:40}});delete input.cache_creation_input_tokens;
    const lower=envelope(input);expect(lower.categories.cacheWrite5m).toBe(40);expect(lower.cache.exactCreationCount).toBeNull();expect(lower.totals.freshWork.value).toBeNull();
  });
  it('rejects a message-level iterations wrapper without inspecting its entries', () => {
    for (const iterations of [[],[raw()],null,'secret']) expect(captureCountEnvelope(raw({iterations}))).toEqual({kind:'rejected',reason:'iterations-unsupported'});
    const input=raw();Object.defineProperty(input,'iterations',{get(){throw Error('Must not read iterations');}});expect(captureCountEnvelope(input).kind).toBe('rejected');
  });
  it('omits arbitrary metadata including model/build values and nested extras', () => {
    const input=raw({ model:'secret-model',version:'secret-build',sessionId:'secret-id',cwd:'secret-path',content:'secret-text',countEvidence:{policy:'secret-policy'},cache_creation:{ephemeral_5m_input_tokens:40,client:'secret-client'},output_tokens_details:{thinking_tokens:3} });
    const before=JSON.stringify(input),e=envelope(input);expect(JSON.stringify(e)).not.toContain('secret');expect(JSON.stringify(input)).toBe(before);
    expect(Object.keys(e)).toEqual(['kind','contractVersion','scope','policies','observations','categories','totals','cache']);expect(e).not.toHaveProperty('reasoning');expect(e).not.toHaveProperty('model');
  });
  it('never invokes getters and does not borrow inherited numeric fields', () => {
    let calls=0;const input=Object.create({input_tokens:99});Object.assign(input,{output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:0});
    Object.defineProperty(input,'model',{get(){calls++;throw Error('No model access');}});
    Object.defineProperty(input,'output_tokens',{get(){calls++;throw Error('No numeric getter');}});
    const e=envelope(input);expect(calls).toBe(0);expect(e.observations.inputFresh.state).toBe('missing');expect(e.observations.output.state).toBe('invalid');expect(e.totals.full.value).toBeNull();
  });
  it('distinguishes container states and explicit all-zero known totals', () => {
    for (const [container,state] of [[undefined,'absent'],[null,'null'],['secret','malformed'],[{},'present']] as const) {
      expect(envelope(raw({cache_creation:container})).observations.cacheCreation.container).toBe(state);
    }
    const e=envelope({input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0});expect(e.totals.full).toEqual({quality:'complete',value:0});
  });
  it('rejects non-object input and preserves sum-overflow qualification', () => {
    for (const input of [null,undefined,[],1,'secret']) expect(captureCountEnvelope(input)).toEqual({kind:'rejected',reason:'component-object-required'});
    const e=envelope(raw({input_tokens:Number.MAX_SAFE_INTEGER}));expect(e.totals.full.quality).toBe('invalid');expect(e.totals.full.value).toBeNull();expect(e.totals.freshWork.value).toBeNull();
  });
});
