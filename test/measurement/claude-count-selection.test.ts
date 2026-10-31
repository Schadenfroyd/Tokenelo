import { describe, expect, it } from 'vitest';
import { captureClaudeCountSelection, MAX_COUNT_COMPONENTS } from '../../src/measurement/claude-count-selection.js';

const component = (input_tokens = 2) => ({ input_tokens, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
const selected = (input: unknown) => {
  const r = captureClaudeCountSelection(input);expect(r.kind).toBe('claude-count-selection');
  if (r.kind !== 'claude-count-selection') throw Error('Expected selected count result');return r;
};
describe('private Claude count component selection', () => {
  it('preserves absent/null/empty iteration containers and selects top-level once', () => {
    for (const [iterations,container,length] of [[undefined,'absent',null],[null,'null',null],[[],'present',0]] as const) {
      const r=selected({...component(),iterations});expect(r.selection).toBe('top-level');expect(r.iterations).toEqual({container,length});expect(r.components).toHaveLength(1);expect(r.totals.full.value).toBe(9);
    }
  });
  it('selects iteration entries and never adds top-level final counts again', () => {
    const last=component(10),r=selected({...last,iterations:[component(20),last]});
    expect(r.selection).toBe('iterations');expect(r.totals.full.value).toBe(44);expect(r.totals.freshWork.value).toBe(36);expect(r.components.map(c=>[c.ordinal,c.final])).toEqual([[0,false],[1,true]]);
  });
  it('does not expose metadata or mutate source input', () => {
    const input={...component(),iterations:null,model:'secret',version:'secret',sessionId:'secret',content:'secret'};const before=JSON.stringify(input),r=selected(input);expect(JSON.stringify(r)).not.toContain('secret');expect(JSON.stringify(input)).toBe(before);
  });
  it('refuses malformed/accessor containers without invoking them', () => {
    for (const iterations of ['secret',{},1]) expect(captureClaudeCountSelection({...component(),iterations})).toMatchObject({kind:'rejected',reason:'iterations-malformed'});
    const input=component();Object.defineProperty(input,'iterations',{get(){throw Error('No getter');}});expect(captureClaudeCountSelection(input).kind).toBe('rejected');
  });
  it('keeps invalid iteration entries unavailable without borrowing top-level or inherited values', () => {
    const r=selected({...component(999),iterations:[component(),null]});expect(r.totals.full.value).toBeNull();expect(r.components[1].envelope.kind).toBe('rejected');
    const entries=new Array(1);Object.defineProperty(entries,'0',{get(){throw Error('No entry getter');}});expect(selected({iterations:entries}).totals.full.value).toBeNull();
  });
  it('preserves independently eligible fresh-work totals across omitted reads', () => {
    const c=component();delete c.cache_read_input_tokens;const r=selected({iterations:[c,component()]});expect(r.totals.full).toEqual({quality:'incomplete',value:null});expect(r.totals.freshWork).toEqual({quality:'complete',value:10});
  });
  it('refuses oversized selection and never promotes unsafe sums to known totals', () => {
    expect(captureClaudeCountSelection({iterations:new Array(MAX_COUNT_COMPONENTS+1)})).toMatchObject({kind:'rejected',reason:'component-limit-exceeded'});
    const r=selected({iterations:[component(Number.MAX_SAFE_INTEGER-7),component(10)]});expect(r.totals.full.value).toBeNull();expect(r.totals.full.quality).toBe('invalid');
  });
  it('does not infer an empty record from missing fields or accept non-object usage', () => {
    for (const raw of [null,[],1,'secret']) expect(captureClaudeCountSelection(raw)).toMatchObject({kind:'rejected',reason:'usage-object-required'});
    expect(selected({}).totals.full).toEqual({quality:'incomplete',value:null});
    expect(selected({input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0,iterations:null}).totals.full).toEqual({quality:'complete',value:0});
  });
});
