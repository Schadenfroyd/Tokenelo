import { describe, expect, it } from 'vitest';
import { mergeDuplicateEvent } from '../../src/store/ledger.js';
import type { TokenCounts, UsageComponent, UsageEvent } from '../../src/core/types.js';

const Z: TokenCounts = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
const tok = (p: Partial<TokenCounts>): TokenCounts => ({ ...Z, ...p });
const comp = (model: string, t: Partial<TokenCounts>, speed?: 'standard' | 'fast'): UsageComponent => ({ model, tokens: tok(t), ...(speed ? { speed } : {}) });
/** A duplicate line's event: tokens are the sum of its components, as the collectors emit them. */
function ev(id: string, components: UsageComponent[], extra: Partial<UsageEvent> = {}): UsageEvent {
  const sum = components.reduce((s, c) => ({
    inputFresh: s.inputFresh + c.tokens.inputFresh,
    cacheWrite5m: s.cacheWrite5m + c.tokens.cacheWrite5m,
    cacheWrite1h: s.cacheWrite1h + c.tokens.cacheWrite1h,
    cacheRead: s.cacheRead + c.tokens.cacheRead,
    output: s.output + c.tokens.output,
    reasoning: s.reasoning + c.tokens.reasoning,
  }), Z);
  return { id, components, tokens: sum, thinking: null, flags: [], ...extra } as unknown as UsageEvent;
}
const sumOf = (cs: UsageComponent[]): TokenCounts =>
  cs.reduce((s, c) => ({
    inputFresh: s.inputFresh + c.tokens.inputFresh,
    cacheWrite5m: s.cacheWrite5m + c.tokens.cacheWrite5m,
    cacheWrite1h: s.cacheWrite1h + c.tokens.cacheWrite1h,
    cacheRead: s.cacheRead + c.tokens.cacheRead,
    output: s.output + c.tokens.output,
    reasoning: s.reasoning + c.tokens.reasoning,
  }), Z);

describe('Claude copied attribution is separate from the MAX count winner', () => {
  it('later recorded main-role context clears an earlier subagent parent as a pair', () => {
    const stored=ev('role-context',[comp('claude-sonnet-5',{output:30})],{source:'claude',sessionId:'owner',isSubagent:true,parentSessionId:'parent',flags:['sessionContextUnrecorded']});
    const incoming=ev('role-context',[comp('claude-sonnet-5',{output:20})],{source:'claude',sessionId:'owner',isSubagent:false});
    const merged=mergeDuplicateEvent(stored,incoming);expect(merged.isSubagent).toBe(false);expect(merged.parentSessionId).toBeUndefined();expect(merged.tokens.output).toBe(30);
  });
  it('an assumed standard-speed owner snapshot does not erase previously reported fast speed', () => {
    const stored=ev('missing-speed',[comp('claude-sonnet-5',{output:30},'fast')],{source:'claude',sessionId:'owner',speed:'fast',flags:['sessionContextUnrecorded']});
    const incoming=ev('missing-speed',[comp('claude-sonnet-5',{output:20})],{source:'claude',sessionId:'owner',speed:'standard',flags:['speedAssumed']});
    const merged=mergeDuplicateEvent(stored,incoming);
    expect(merged.speed).toBe('fast');expect(merged.tokens.output).toBe(30);expect(merged.flags).toContain('mergedComponentsMisaligned');
  });
  it('a smaller owner snapshot restores recorded parent/subagent/repository context without shrinking MAX counts', () => {
    const stored=ev('owner-context',[comp('claude-sonnet-5',{output:30})],{source:'claude',sessionId:'owner',isSubagent:false,flags:['sessionContextUnrecorded']});
    const incoming=ev('owner-context',[comp('claude-sonnet-5',{output:20})],{source:'claude',sessionId:'owner',isSubagent:true,parentSessionId:'parent',project:'/fixture/owner',repoRoot:'/fixture/repo',gitBranch:'main',entrypoint:'agent'});
    const merged=mergeDuplicateEvent(stored,incoming);
    expect(merged).toMatchObject({sessionId:'owner',isSubagent:true,parentSessionId:'parent',project:'/fixture/owner',repoRoot:'/fixture/repo',gitBranch:'main',entrypoint:'agent'});
    expect(merged.tokens.output).toBe(30);expect(merged.flags).toContain('sessionContextUnrecorded');
  });
  it('retains recorded economics when an equal-output copy claims another session', () => {
    const a = ev('copy', [comp('claude-sonnet-5', { output: 20 })], { source: 'claude', sessionId: 'first', effort: 'low', inferenceGeo: 'global', serviceTier: 'standard', speed: 'standard' });
    const b = ev('copy', [comp('claude-sonnet-5', { inputFresh: 100, output: 20 })], { source: 'claude', sessionId: 'copy', effort: 'high', inferenceGeo: 'us', serviceTier: 'priority', speed: 'standard' });
    const merged = mergeDuplicateEvent(a, b);
    expect(merged).toMatchObject({ sessionId: 'first', effort: 'low', inferenceGeo: 'global', serviceTier: 'standard', speed: 'standard' });
    expect(merged.tokens.inputFresh).toBe(100);
    expect(merged.flags).toContain('sessionAttributionConflict');
    expect(mergeDuplicateEvent(merged, b)).toMatchObject({ sessionId: 'first', effort: 'low', inferenceGeo: 'global', serviceTier: 'standard' });
  });
  it.each([20, 30])('allows a later reported session to enrich missing attribution with stored output %i and prevents erasure', storedOutput => {
    const a = ev('missing', [comp('claude-sonnet-5', { output: storedOutput })], { source: 'claude', sessionId: '', effort: 'high', inferenceGeo: 'us' });
    const b = ev('missing', [comp('claude-sonnet-5', { output: 20 })], { source: 'claude', sessionId: 'reported', project: '/fixture/reported', effort: 'low', inferenceGeo: 'global' });
    const enriched = mergeDuplicateEvent(a, b);
    expect(enriched.sessionId).toBe('reported');
    expect(enriched.flags).toContain('sessionAttributionEnriched');
    expect(enriched.tokens.output).toBe(storedOutput);
    expect(enriched).toMatchObject({ effort: 'low', inferenceGeo: 'global' });
    expect(mergeDuplicateEvent(enriched, a).sessionId).toBe('reported');
  });
});

describe('mergeDuplicateEvent (L5): tokens and components agree after a duplicate-line merge', () => {
  it('literal crossed-field example: stored cache write 40,000 with output 10, incoming output 50 with no cache write → tokens = Σ components, the 40,000 writes are kept', () => {
    const stored = ev('msg-1', [comp('claude-sonnet-5', { cacheWrite1h: 40000, output: 10 })]);
    const incoming = ev('msg-1', [comp('claude-sonnet-5', { output: 50 })]);
    const m = mergeDuplicateEvent(stored, incoming);
    expect(m.tokens).toEqual(tok({ cacheWrite1h: 40000, output: 50 }));
    expect(m.components).toHaveLength(1);
    expect(sumOf(m.components)).toEqual(m.tokens);
    expect(m.components[0]!.tokens).toEqual(m.tokens);
  });

  it('a growing snapshot is a MAX, not a sum: output 10 then 50 with the same cache stays 50', () => {
    const stored = ev('msg-2', [comp('claude-sonnet-5', { inputFresh: 100, cacheRead: 900, output: 10 })]);
    const incoming = ev('msg-2', [comp('claude-sonnet-5', { inputFresh: 100, cacheRead: 900, output: 50 })]);
    const m = mergeDuplicateEvent(stored, incoming);
    expect(m.tokens.output).toBe(50);
    expect(m.tokens.cacheRead).toBe(900);
    expect(m.tokens.inputFresh).toBe(100);
  });

  it('an identical duplicate does not drift: merging a line with itself returns the same tokens and components', () => {
    const e = ev('msg-3', [comp('claude-opus-5-5', { inputFresh: 7, cacheWrite5m: 3, cacheRead: 11, output: 5, reasoning: 2 })]);
    const m = mergeDuplicateEvent(e, e);
    expect(m.tokens).toEqual(e.tokens);
    expect(m.components).toEqual(e.components);
  });

  it('single component: the merged tokens equal the field-wise MAX of the two event tokens (the contract rule, unchanged)', () => {
    const a = ev('msg-4', [comp('claude-sonnet-5', { inputFresh: 5, cacheWrite5m: 20, output: 9 })]);
    const b = ev('msg-4', [comp('claude-sonnet-5', { inputFresh: 8, cacheWrite1h: 4, output: 6 })]);
    const m = mergeDuplicateEvent(a, b);
    expect(m.tokens).toEqual(tok({ inputFresh: 8, cacheWrite5m: 20, cacheWrite1h: 4, output: 9 }));
  });

  it('multi-component (advisor/iteration) lines: MAX per component, then the sum; neither snapshot is summed', () => {
    const a = ev('msg-5', [comp('claude-sonnet-5', { output: 10 }), comp('claude-haiku-4-5', { output: 5 })]);
    const b = ev('msg-5', [comp('claude-sonnet-5', { output: 50 }), comp('claude-haiku-4-5', { output: 5 })]);
    const m = mergeDuplicateEvent(a, b);
    expect(m.components.map((c) => c.tokens.output)).toEqual([50, 5]);
    expect(m.tokens.output).toBe(55);
    expect(sumOf(m.components)).toEqual(m.tokens);
  });

  it('misaligned components (different model): the contract field-wise MAX of the tokens is kept (no proven field lost), the components are the kept line\'s, and the event is flagged', () => {
    const a = ev('msg-6', [comp('claude-sonnet-5', { cacheWrite1h: 40000, output: 10 })]);
    const b = ev('msg-6', [comp('claude-haiku-4-5', { inputFresh: 900, output: 50 })]);
    const m = mergeDuplicateEvent(a, b);
    expect(m.tokens).toEqual(tok({ inputFresh: 900, cacheWrite1h: 40000, output: 50 }));
    expect(m.components).toEqual(b.components);
    expect(m.flags).toContain('mergedComponentsMisaligned');
  });

  it('the merge keeps descriptive fields from the winning line and the id of the incoming line', () => {
    const a = ev('msg-7', [comp('claude-sonnet-5', { output: 10 })], { effort: 'low' } as Partial<UsageEvent>);
    const b = ev('msg-7', [comp('claude-sonnet-5', { output: 50 })], { effort: 'high' } as Partial<UsageEvent>);
    const m = mergeDuplicateEvent(a, b);
    expect((m as unknown as { effort: string }).effort).toBe('high');
    expect(m.id).toBe('msg-7');
  });
});
