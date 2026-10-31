/**
 * Contract tests for the NATIVE-COUNTER projection of per-field evidence: nativeTokenFieldCoverage in
 * src/core/token-field-evidence.ts. This is the part the 2026-10-13 mutation run found least pinned
 * (docs/reviews/2026-10-13-mutation-testing/SURVIVORS.md, 25 survivors) and that
 * token-field-evidence-mutation-gaps.test.ts explicitly leaves out.
 *
 * The inputs are the fabricated shapes in test/fixtures/claude-cloud-2026-10-17/structure-only.json
 * (read from the file, not copied), plus a few extra fabricated shapes for boundaries the fixture does
 * not name. Every expected vector below was derived by hand from the documented meaning of each category,
 * not pasted from a run:
 *   - inputFresh is DERIVED (gross prompt minus cached prompt), cacheRead and output are REPORTED;
 *   - an absent cache counter is an ASSUMED zero (disclosed, never a reported zero);
 *   - a cache counter above the gross prompt, or an invalid cache counter, makes fresh input INVALID;
 *   - the three cache-write categories are NOT APPLICABLE to this engine (known zero);
 *   - reasoning is never reported by this engine, so it is MISSING (never a reported zero);
 *   - a category whose stored count differs from the raw projection (a legacy merge) is UNRECORDED,
 *     never attributed to the raw fields.
 *
 * This is a read-disclosure contract on fabricated counters. It does not establish that a real Ollama
 * build reports these fields, and it does not close the mutation gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nativeTokenFieldCoverage, TOKEN_FIELD_KEYS, unrecordedTokenFields, type TokenFieldCoverage, type TokenFieldEvidence } from '../../src/core/token-field-evidence.js';
import { captureNativeCounters, mergeNativeCounters, nativeCounterProjection, type NativeCounterEvidence } from '../../src/measurement/native-counter-evidence.js';
import type { TokenCounts, UsageComponent } from '../../src/core/types.js';

interface Shape { case: string; rawFields?: Record<string, number>; rawSnapshots?: Record<string, number>[]; expectedObservationStates?: Record<string, string>; policyNameOnly?: string }
const FIXTURE = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'claude-cloud-2026-10-17', 'structure-only.json'), 'utf8')) as { nativeCounterShapes: Shape[] };
const shape = (name: string): Shape => FIXTURE.nativeCounterShapes.find(s => s.case === name)!;

const ZERO: TokenFieldEvidence = { knownValue: 0, knownParts: 0, reportedParts: 0, derivedParts: 0, normalizedParts: 0, assumedParts: 0, notApplicableParts: 0, missingParts: 0, invalidParts: 0, unrecordedParts: 0 };
const f = (o: Partial<TokenFieldEvidence>): TokenFieldEvidence => ({ ...ZERO, ...o });
const NOT_APPLICABLE = f({ knownParts: 1, notApplicableParts: 1 });
const NEVER_REPORTED = f({ missingParts: 1 });   // reasoning: this engine does not report it
const reported = (value: number) => f({ knownValue: value, knownParts: 1, reportedParts: 1 });
const derived = (value: number) => f({ knownValue: value, knownParts: 1, derivedParts: 1 });
const coverage = (c: Pick<TokenFieldCoverage, 'inputFresh' | 'cacheRead' | 'output'>): TokenFieldCoverage => ({
  ...c, cacheWrite5m: NOT_APPLICABLE, cacheWrite1h: NOT_APPLICABLE, cacheWriteUnassigned: NOT_APPLICABLE, reasoning: NEVER_REPORTED });

function project(evidence: NativeCounterEvidence, edit?: (t: TokenCounts) => void): { components: UsageComponent[]; totals: TokenCounts; tokens: TokenCounts } {
  const tokens = nativeCounterProjection(evidence);
  const stored = { ...tokens }; edit?.(stored);
  const totals = { ...stored };
  return { components: [{ model: 'synthetic-model', tokens: stored, nativeCounterEvidence: evidence }], totals, tokens };
}
function coverageOf(evidence: NativeCounterEvidence, edit?: (t: TokenCounts) => void): { fields: TokenFieldCoverage; tokens: TokenCounts } {
  const p = project(evidence, edit);
  return { fields: nativeTokenFieldCoverage(p.components, p.totals)!, tokens: p.tokens };
}
const merged = (snapshots: Record<string, number>[]): NativeCounterEvidence =>
  snapshots.map(s => captureNativeCounters(s)).reduce((a, b) => mergeNativeCounters(a, b)!);

describe('the fixture shapes mean what the fixture says', () => {
  it('captures the stated observation state for every named counter, and names the assume-zero policy for a missing cache counter', () => {
    for (const s of FIXTURE.nativeCounterShapes.filter(x => x.rawFields && x.expectedObservationStates)) {
      const snapshot = captureNativeCounters(s.rawFields!).snapshots[0]!;
      for (const [counter, state] of Object.entries(s.expectedObservationStates!)) expect(snapshot[counter as keyof typeof snapshot].state, `${s.case}/${counter}`).toBe(state);
    }
    expect(captureNativeCounters(shape('missing-cache-counter-is-distinct-from-zero').rawFields!).missingCachePolicy).toBe('assume-zero');
    expect(shape('missing-cache-counter-is-distinct-from-zero').policyNameOnly).toBe('assume-zero');
  });
});

describe('per-field disclosure of one native report', () => {
  it('reported-zero-is-present: a reported zero cache and output are KNOWN zeros, fresh input is derived', () => {
    const { fields, tokens } = coverageOf(captureNativeCounters(shape('reported-zero-is-present').rawFields!));
    expect(tokens).toMatchObject({ inputFresh: 17, cacheRead: 0, output: 0, countQuality: 'complete' });
    expect(fields).toEqual(coverage({ inputFresh: derived(17), cacheRead: reported(0), output: reported(0) }));
  });

  it('missing-cache-counter-is-distinct-from-zero: the cache read is an ASSUMED zero, disclosed as assumed and not as reported', () => {
    const { fields, tokens } = coverageOf(captureNativeCounters(shape('missing-cache-counter-is-distinct-from-zero').rawFields!));
    expect(tokens).toMatchObject({ inputFresh: 21, cacheRead: 0, output: 4, countQuality: 'complete' });
    expect(fields).toEqual(coverage({
      inputFresh: f({ knownValue: 21, knownParts: 1, derivedParts: 1, assumedParts: 1 }),
      cacheRead: f({ knownValue: 0, knownParts: 1, assumedParts: 1 }), // known by policy, reportedParts stays 0
      output: reported(4),
    }));
  });

  it('invalid-negative-counter-remains-invalid: invalid cache makes cache AND fresh input invalid, while output stays reported', () => {
    const { fields, tokens } = coverageOf(captureNativeCounters(shape('invalid-negative-counter-remains-invalid').rawFields!));
    expect(tokens.countQuality).toBe('invalid');
    expect(fields).toEqual(coverage({ inputFresh: f({ invalidParts: 1 }), cacheRead: f({ invalidParts: 1 }), output: reported(4) }));
  });

  it('cache-exceeds-gross-prompt: the contradiction withholds fresh input as invalid but keeps the reported cache and output', () => {
    const { fields, tokens } = coverageOf(captureNativeCounters(shape('cache-exceeds-gross-prompt').rawFields!));
    expect(tokens.countQuality).toBe('invalid');
    expect(fields).toEqual(coverage({ inputFresh: f({ invalidParts: 1 }), cacheRead: reported(15), output: reported(2) }));
  });

  it('a cache count EQUAL to the gross prompt is valid: zero fresh input is a known derived zero', () => {
    const { fields, tokens } = coverageOf(captureNativeCounters({ prompt_eval_count: 10, prompt_eval_cached_count: 10, eval_count: 2 }));
    expect(tokens).toMatchObject({ inputFresh: 0, cacheRead: 10, countQuality: 'complete' });
    expect(fields).toEqual(coverage({ inputFresh: derived(0), cacheRead: reported(10), output: reported(2) }));
  });

  it('a cache count above a reported zero prompt is a contradiction (the gross prompt is the reported zero, not a floor of one)', () => {
    const { fields, tokens } = coverageOf(captureNativeCounters({ prompt_eval_count: 0, prompt_eval_cached_count: 1, eval_count: 0 }));
    expect(tokens.countQuality).toBe('invalid');
    expect(fields).toEqual(coverage({ inputFresh: f({ invalidParts: 1 }), cacheRead: reported(1), output: reported(0) }));
  });

  it('a missing prompt count, a missing completion count and an invalid completion count are each disclosed for that category only, never as a reported zero', () => {
    const rows: [string, Record<string, unknown>, Pick<TokenFieldCoverage, 'inputFresh' | 'cacheRead' | 'output'>][] = [
      ['a missing prompt count', { eval_count: 5 }, { inputFresh: f({ missingParts: 1 }), cacheRead: f({ knownParts: 1, assumedParts: 1 }), output: reported(5) }],
      ['a missing completion count', { prompt_eval_count: 3, prompt_eval_cached_count: 1 }, { inputFresh: derived(2), cacheRead: reported(1), output: f({ missingParts: 1 }) }],
      ['an invalid completion count', { prompt_eval_count: 3, eval_count: 'PRIVATE-TEXT' }, { inputFresh: f({ knownValue: 3, knownParts: 1, derivedParts: 1, assumedParts: 1 }), cacheRead: f({ knownParts: 1, assumedParts: 1 }), output: f({ invalidParts: 1 }) }],
    ];
    for (const [name, raw, expected] of rows) {
      const { fields } = coverageOf(captureNativeCounters(raw));
      expect(fields, name).toEqual(coverage(expected));
      expect(JSON.stringify(fields), name).not.toContain('PRIVATE-TEXT');
    }
  });
});

describe('per-field disclosure of a history of native reports', () => {
  it('same-native-snapshot-replayed: an identical replay is one observation, so one part per category', () => {
    const { fields, tokens } = coverageOf(merged(shape('same-native-snapshot-replayed').rawSnapshots!));
    expect(tokens).toMatchObject({ inputFresh: 22, cacheRead: 8, output: 6, countQuality: 'complete' });
    expect(fields).toEqual(coverage({ inputFresh: derived(22), cacheRead: reported(8), output: reported(6) }));
  });

  it('separate-native-observations-are-not-collapsed: the maximum of each counter is disclosed once, fresh input derived from those maxima', () => {
    const { fields, tokens } = coverageOf(merged(shape('separate-native-observations-are-not-collapsed').rawSnapshots!));
    expect(tokens).toMatchObject({ inputFresh: 12, cacheRead: 7, output: 5, countQuality: 'complete' });
    expect(fields).toEqual(coverage({ inputFresh: derived(12), cacheRead: reported(7), output: reported(5) }));
  });

  it('a capped history keeps the largest reported counters known, and the cache invariant uses that retained maximum', () => {
    const snapshots = Array.from({ length: 65 }, (_, i) => ({ prompt_eval_count: i + 1, prompt_eval_cached_count: 1, eval_count: i + 1 }));
    const evidence = merged(snapshots);
    expect(evidence.snapshots).toHaveLength(64);
    expect(evidence.largestReported).toMatchObject({ prompt_eval_count: 65, eval_count: 65 });
    const { fields, tokens } = coverageOf(evidence);
    expect(tokens).toMatchObject({ inputFresh: 64, cacheRead: 1, output: 65, countQuality: 'incomplete' }); // capped: never "complete"
    expect(fields).toEqual(coverage({ inputFresh: derived(64), cacheRead: reported(1), output: reported(65) }));
  });
});

describe('what is NOT attributed to the raw native fields', () => {
  it('a category whose stored count differs from the raw projection (a legacy merge) is unrecorded; the others keep their evidence', () => {
    const evidence = captureNativeCounters({ prompt_eval_count: 10, prompt_eval_cached_count: 4, eval_count: 3 });
    const { fields } = coverageOf(evidence, t => { t.output = 99; });
    expect(fields.output).toEqual(unrecordedTokenFields().output);
    expect(fields.inputFresh).toEqual(derived(6));
    expect(fields.cacheRead).toEqual(reported(4));
    expect(fields.cacheWrite5m).toEqual(NOT_APPLICABLE);
    // The same rule per category: a different stored fresh-input count is unrecorded as well.
    const other = coverageOf(evidence, t => { t.inputFresh = 7; }).fields;
    expect(other.inputFresh).toEqual(unrecordedTokenFields().inputFresh);
    expect(other.output).toEqual(reported(3));
  });

  it('a category whose component sum differs from the aggregate total becomes unrecorded across ALL components of that aggregate', () => {
    const evidence = captureNativeCounters({ prompt_eval_count: 10, prompt_eval_cached_count: 4, eval_count: 3 });
    const a = project(evidence), b = project(evidence);
    const totals: TokenCounts = { ...a.totals, inputFresh: a.totals.inputFresh * 2, cacheRead: a.totals.cacheRead * 2, output: 7 }; // 2 x 3 = 6 expected, 7 stored
    const fields = nativeTokenFieldCoverage([...a.components, ...b.components], totals)!;
    expect(fields.output).toEqual(unrecordedTokenFields(2).output); // parts = number of components, not 1
    expect(fields.inputFresh).toEqual(f({ knownValue: 12, knownParts: 2, derivedParts: 2 }));
    expect(fields.cacheRead).toEqual(f({ knownValue: 8, knownParts: 2, reportedParts: 2 }));
    expect(fields.reasoning).toEqual(f({ missingParts: 2 }));
  });

  it('evidence the code cannot interpret is never projected: a legacy-mixed or unsupported-policy component is wholly unrecorded', () => {
    const base = captureNativeCounters({ prompt_eval_count: 10, prompt_eval_cached_count: 4, eval_count: 3 });
    const tokens = nativeCounterProjection(base);
    const legacy = { ...base, legacyMixed: true as const };
    const future = { ...base, policy: 'tokenelo/ollama-native-counters@v99' } as unknown as NativeCounterEvidence;
    for (const [name, evidence] of [['legacyMixed', legacy], ['future policy', future]] as const) {
      const fields = nativeTokenFieldCoverage([{ model: 'synthetic-model', tokens, nativeCounterEvidence: evidence }], tokens)!;
      for (const key of TOKEN_FIELD_KEYS) expect(fields[key], `${name}/${key}`).toEqual(unrecordedTokenFields()[key]);
    }
  });

  it('with no native evidence on any component there is no projection at all; a plain component beside a native one stays unrecorded', () => {
    const tokens: TokenCounts = { inputFresh: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 };
    expect(nativeTokenFieldCoverage([{ model: 'synthetic-model', tokens }], tokens)).toBeUndefined();
    const native = project(captureNativeCounters({ prompt_eval_count: 10, prompt_eval_cached_count: 4, eval_count: 3 }));
    const total: TokenCounts = { ...native.totals, inputFresh: native.totals.inputFresh + 5, output: native.totals.output + 1 };
    const fields = nativeTokenFieldCoverage([...native.components, { model: 'synthetic-model', tokens }], total)!;
    expect(fields.output).toEqual(f({ knownValue: 3, knownParts: 1, reportedParts: 1, unrecordedParts: 1 }));
    expect(fields.inputFresh).toEqual(f({ knownValue: 6, knownParts: 1, derivedParts: 1, unrecordedParts: 1 }));
    expect(fields.cacheWrite5m).toEqual(f({ knownParts: 1, notApplicableParts: 1, unrecordedParts: 1 }));
  });
});
