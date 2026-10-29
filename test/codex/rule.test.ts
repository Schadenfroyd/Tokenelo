/**
 * The §15.2 derivation rule on synthetic rollouts with hand-computed expected values.
 * Every expected number below is worked out in the comment next to it — none is read back from the code.
 */
import { describe, expect, it } from 'vitest';
import {
  CodexRolloutParser,
  isRealTurnId,
  rawBillable,
  readRawUsage,
  toTokenCounts,
  toUsageEvent,
  type CodexFileState,
  type ParserOptions,
  type ParsedUsage,
} from '../../src/collectors/codex.js';
import type { TurnTiming } from '../../src/collectors/codex-sqlite.js';
import { MemoryStore, Rollout, makeCtx, stubUsd, type U } from './helpers.js';

const SID = '01a0aaaa-0000-7000-8000-000000000001';
const PARENT = '01a0aaaa-0000-7000-8000-0000000000pp';

function run(lines: string[], opts: Partial<ParserOptions> = {}, state?: CodexFileState) {
  const p = new CodexRolloutParser(state, { host: 'test', ...opts });
  for (const l of lines) p.pushLine(l);
  p.releaseDeferred(); // what parseRolloutFile does before every persisted offset
  const usage = p.takeUsage();
  const marks = p.takeMarks();
  return { usage, marks, state: p.snapshotState(), parser: p };
}

function billable(us: ParsedUsage[]): number {
  return us.reduce((a, u) => a + u.components.reduce((b, c) => b + rawBillable(c.raw), 0), 0);
}

function fieldSum(us: ParsedUsage[]) {
  const t = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  for (const u of us) for (const c of u.components) {
    t.input += c.raw.input; t.cached += c.raw.cached; t.cacheWrite += c.raw.cacheWrite;
    t.output += c.raw.output; t.reasoning += c.raw.reasoning;
  }
  return t;
}

function withoutCodexFieldState(us: ParsedUsage[]): ParsedUsage[] {
  return us.map(event => ({ ...event, components: event.components.map(component => {
    const { codexFieldStateEvidence: _evidence, ...rawComponent } = component;
    return rawComponent;
  }) }));
}

function parserFieldStateMapSize(parser: CodexRolloutParser): number {
  // Test seam only: do not add a production diagnostics API for this transient map.
  return (parser as unknown as { recordFieldStates: Map<string, unknown> }).recordFieldStates.size;
}

describe('toTokenCounts (cache-write subset assumption §15.2.8)', () => {
  it('maps hand-computed fields', () => {
    // input 1000 incl. cached 600 and cache_write 100 → inputFresh = 1000 − 600 − 100 = 300
    // reasoning 70 > output 50 → clamped to 50
    const { tokens, reasoningClamped } = toTokenCounts({ input: 1000, cached: 600, cacheWrite: 100, output: 50, reasoning: 70, total: 1050 });
    expect(tokens).toEqual({ inputFresh: 300, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 600, output: 50, reasoning: 50 });
    expect(reasoningClamped).toBe(true);
  });
  it('never goes negative when cached exceeds input', () => {
    expect(toTokenCounts({ input: 10, cached: 20, cacheWrite: 0, output: 1, reasoning: 0, total: 11 }).tokens.inputFresh).toBe(0);
  });
  it('readRawUsage defaults total to input+output and ignores junk', () => {
    expect(readRawUsage({ input_tokens: 5, output_tokens: 2 })).toEqual({ input: 5, cached: 0, cacheWrite: 0, output: 2, reasoning: 0, total: 7 });
    expect(readRawUsage(null)).toBeNull();
  });
});

describe('turn ids', () => {
  it('rollout-N and external-import-turn-N are not real turns', () => {
    expect(isRealTurnId('rollout-2')).toBe(false);
    expect(isRealTurnId('external-import-turn-1')).toBe(false);
    expect(isRealTurnId('external-import-turn-12')).toBe(false);
    expect(isRealTurnId('01a0cfa4-8056-7c80-b12e-c5b33138611c')).toBe(true);
    expect(isRealTurnId(undefined)).toBe(false);
  });
});

describe('root thread: per-field deltas', () => {
  it('first event after an own turn contributes last_token_usage; later events contribute deltas', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'user', source: 'vscode' })
      .taskStarted('T1', 1_788_000_000)
      .turnContextNested('T1', 'gpt-6-luna', 'medium')
      .user()
      .assistant()
      .tokenCount([1000, 200, 30, 10], [1000, 200, 30, 10]) // first: +1000/200/30/10
      .tokenCount([2500, 1200, 80, 25], [1500, 1000, 50, 15]) // Δ: 1500/1000/50/15
      .tokenCount([2500, 1200, 80, 25], [1500, 1000, 50, 15]) // repeated totals: Δ 0 → no event
      .tokenCount([4000, 2600, 100, 25], [1500, 1400, 20, 0]); // Δ: 1500/1400/20/0
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(3);
    // input 1000+1500+1500 = 4000; cached 200+1000+1400 = 2600; output 30+50+20 = 100; reasoning 10+15+0 = 25
    expect(fieldSum(usage)).toEqual({ input: 4000, cached: 2600, cacheWrite: 0, output: 100, reasoning: 25 });
    // billable 4000 + 100 = 4100 = last total_tokens (root thread without anomalies == tokens_used)
    expect(billable(usage)).toBe(4100);
    expect(state.summary.lastTotal).toBe(4100);
    expect(state.summary.ownTotalDerived).toBe(4100);
    expect(state.summary.firstEventBeforeOwnTurn).toBe(false);
    expect(usage[0]!.model).toBe('gpt-6-luna');
    expect(usage[0]!.effort).toBe('medium');
    expect(usage.map((u) => u.id)).toEqual([`codex:${SID}:5`, `codex:${SID}:6`, `codex:${SID}:8`]);
    // requestInput comes from last_token_usage.input_tokens (per request, for the GPT-6 272K bracket)
    expect(usage.map((u) => u.components[0]!.requestInput)).toEqual([1000, 1500, 1500]);
  });

  it('a per-field decrease with a non-decreasing total is clamped to 0 and counted', () => {
    const r = new Rollout()
      .meta({ id: SID })
      .taskStarted('T1').assistant()
      .tokenCount([100, 50, 10], [100, 50, 10])
      .tokenCount([300, 40, 20], [200, 0, 10]); // cached 50→40 (−10 clamped to 0); input +200; output +10
    const { usage, state } = run(r.lines);
    expect(fieldSum(usage)).toEqual({ input: 300, cached: 50, cacheWrite: 0, output: 20, reasoning: 0 });
    expect(state.summary.fieldDecreases).toBe(1);
  });
});

describe('first event: inherited snapshot vs own turn (§15.2.1)', () => {
  const inheritedPrefix = () =>
    new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT, source: { subagent: { other: 'guardian' } } })
      .compacted()
      .tokenCount([7_000_000, 6_000_000, 5_000, 1_000], [0, 0, 0, 0, 0, 76_510]) // copied parent snapshot
      .taskStarted('rollout-2', 1_786_000_000)
      .user()
      .assistant() // replayed history inside a synthetic rollout-N turn is NOT an own turn
      .turnContextFlat('T-real', 'codex-auto-review', 'low').taskStarted('T-real', 1_788_264_000)
      .assistant()
      .tokenCount([7_081_473, 6_004_864, 5_107, 1_042], [81_473, 4_864, 107, 42]);

  it('a snapshot before any own turn contributes 0; its whole total is the baseline', () => {
    const { usage, state } = run(inheritedPrefix().lines);
    // only the second event counts: Δ = 81,473 input / 4,864 cached / 107 output / 42 reasoning
    expect(fieldSum(usage)).toEqual({ input: 81_473, cached: 4_864, cacheWrite: 0, output: 107, reasoning: 42 });
    expect(billable(usage)).toBe(81_580);
    expect(state.summary.firstEventBeforeOwnTurn).toBe(true);
    expect(state.summary.baselineTotal).toBe(7_005_000);
    expect(state.summary.baselineBillable).toBe(7_005_000);
  });

  it('a real task_started without model output is not yet an own turn', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT })
      .taskStarted('T-real', 1_788_264_000)
      .user()
      .compacted()
      .toolOutput() // tool results are not model output
      .tokenCount([500_000, 0, 100], [400, 0, 10]);
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(0);
    expect(state.summary.firstEventBeforeOwnTurn).toBe(true);
  });

  it('a post-turn first event with an unexplained baseline counts last_token_usage and is flagged suspect', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT })
      .taskStarted('T-real', 1_788_264_000)
      .reasoning()
      .tokenCount([900_000, 800_000, 1_000], [50_000, 40_000, 500]); // baseline = 901,000 − 50,500 = 850,500
    const { usage, state } = run(r.lines, { parentTotals: () => new Set([1, 2, 3]) });
    expect(billable(usage)).toBe(50_500);
    expect(state.summary.baselineTotal).toBe(850_500);
    expect(state.summary.inheritedBaselineSuspect).toBe(true);
    expect(usage[0]!.flags).toContain('inheritedBaselineSuspect');
  });

  it('…and is NOT suspect when the baseline equals a parent token_count total', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT })
      .taskStarted('T-real', 1_788_264_000)
      .reasoning()
      .tokenCount([900_000, 800_000, 1_000], [50_000, 40_000, 500]);
    const { usage, state } = run(r.lines, { parentTotals: (pid) => (pid === PARENT ? new Set([850_500]) : undefined) });
    expect(billable(usage)).toBe(50_500);
    expect(state.summary.inheritedBaselineSuspect).toBe(false);
    expect(usage[0]!.flags).not.toContain('inheritedBaselineSuspect');
  });

  it('leaves a post-turn baseline unasserted when complete parent totals are unavailable', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT })
      .taskStarted('T-real', 1_788_264_000)
      .reasoning()
      .tokenCount([900_000, 800_000, 1_000], [50_000, 40_000, 500]);
    const { usage, state } = run(r.lines);
    expect(billable(usage)).toBe(50_500);
    expect(state.summary.baselineTotal).toBe(850_500);
    expect(state.summary.inheritedBaselineSuspect).toBe(false);
    expect(usage[0]!.flags).not.toContain('inheritedBaselineSuspect');
  });
});

describe('replayed rollout-N turns (copied parent history)', () => {
  it('token_counts inside a rollout-N turn contribute 0 and re-anchor; the real turn after counts deltas', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT, source: { subagent: { thread_spawn: { parent_thread_id: PARENT } } } })
      .turnContextNested('T-parent', 'gpt-5.6-sol', 'ultra')
      .tokenCount([70_000_000, 69_000_000, 200_000], [0, 0, 0, 0, 0, 31_870]) // first: before own turn → 0
      .taskStarted('rollout-4', 1_787_279_092)
      .assistant()
      .tokenCount([70_041_012, 69_039_680, 200_218], [41_012, 39_680, 218]) // replay → 0
      .tokenCount([70_091_464, 69_080_384, 200_271], [50_452, 40_704, 53]) // replay → 0
      .taskComplete('rollout-4', undefined, 1_787_279_092)
      .taskStarted('T-own', 1_787_279_092)
      .turnContextNested('T-own', 'gpt-5.6-sol', 'ultra')
      .assistant()
      .tokenCount([70_141_993, 69_130_304, 200_311], [50_529, 49_920, 40]); // own: Δ vs LAST REPLAY totals
    const { usage, state } = run(r.lines);
    // own Δ = 70,141,993 − 70,091,464 = 50,529 input; 69,130,304 − 69,080,384 = 49,920 cached; 311 − 271 = 40 output
    expect(fieldSum(usage)).toEqual({ input: 50_529, cached: 49_920, cacheWrite: 0, output: 40, reasoning: 0 });
    expect(state.summary.replayEvents).toBe(2);
    // replay growth skipped: (70,241,230 − 70,200,000) + (70,291,735 − 70,241,230) = 41,230 + 50,505 = 91,735
    expect(state.summary.replayExcludedTotal).toBe(91_735);
  });
});

describe('turns older than the thread (UUIDv7) are inherited', () => {
  it('uuidV7Ms reads the embedded ms timestamp', async () => {
    const { uuidV7Ms, isInheritedTurn } = await import('../../src/collectors/codex.js');
    expect(uuidV7Ms('01a02222-a911-7d51-bb59-c44f412f764c')).toBe(0x01a02222a911);
    expect(uuidV7Ms('T1')).toBeNull();
    expect(uuidV7Ms('01a02222-a911-4d51-bb59-c44f412f764c')).toBeNull(); // v4, not v7
    expect(isInheritedTurn('01a021ef-cce2-7b12-bd4d-0227935484de', '01a02222-a911-7d51-bb59-c44f412f764c')).toBe(true);
    expect(isInheritedTurn('01a02222-a9f0-75b2-9089-8d1699336233', '01a02222-a911-7d51-bb59-c44f412f764c')).toBe(false);
    expect(isInheritedTurn('rollout-4', undefined)).toBe(true);
  });

  it('cli 0.147 pattern: rollout-2 then the PARENT\'s turn_context → copied events contribute 0', () => {
    const child = '01a0aaaa-0000-7000-8000-000000000001';
    const parentTurn = '01a0aaa9-ffff-7000-8000-000000000009'; // UUIDv7 1 ms older than the child thread
    const ownTurn = '01a0aaab-0000-7000-8000-000000000002';
    const r = new Rollout()
      .meta({ id: child, thread_source: 'subagent', parent_thread_id: PARENT })
      .tokenCount([0, 0, 0, 0, 0, 266_065], [0, 0, 0, 0, 0, 52_806]) // synthetic snapshot → 0
      .taskStarted('rollout-2')
      .turnContextNested(parentTurn, 'gpt-5.6-sol', 'xhigh')
      .tokenCount([68_261, 9_984, 640, 368, 0, 334_966], [68_261, 9_984, 640, 368]) // parent copy → 0
      .tokenCount([137_190, 77_312, 682, 377, 0, 403_937], [68_929, 67_328, 42, 9]) // parent copy → 0
      .taskStarted(ownTurn, 1_788_264_000)
      .turnContextNested(ownTurn, 'gpt-5.6-sol', 'xhigh')
      .assistant()
      .tokenCount([206_189, 145_664, 721, 383, 0, 472_975], [68_999, 68_352, 39, 6]); // own: Δ vs last copy
    const { usage, state } = run(r.lines);
    // own Δ = 206,189 − 137,190 = 68,999 input; 145,664 − 77,312 = 68,352 cached; 721 − 682 = 39 output; 6 reasoning
    expect(fieldSum(usage)).toEqual({ input: 68_999, cached: 68_352, cacheWrite: 0, output: 39, reasoning: 6 });
    expect(state.summary.olderTurnEvents).toBe(2);
  });
});

describe('§15.10.1 active turn = innermost open turn (rollout-N wrappers)', () => {
  const TH = '01a0aaaa-0000-7000-8000-000000000001'; // thread UUIDv7
  const OWN = '01a0aaab-0000-7000-8000-000000000002'; // newer than the thread → own
  const OWN2 = '01a0aaac-0000-7000-8000-000000000003';
  const V4 = '8b751e4b-57d0-4323-8f57-c9d52eecad69'; // UUIDv4 (older Codex) — age unknown

  it('M4a pattern: wrapper → nested own turn_context → token_count counts; after the nested turn closes the wrapper is active again', () => {
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'subagent', parent_thread_id: PARENT })
      .compacted()
      .tokenCount([1_000_000, 0, 1_000], [0, 0, 0, 0, 0, 5_000]) // first, before any own turn → baseline 1,001,000
      .taskStarted('rollout-2')
      .user()
      .turnContextNested(OWN, 'codex-auto-review', 'low')
      .assistant()
      .tokenCount([1_080_000, 0, 1_500], [80_000, 0, 500]) // own nested: Δ 80,000 + 500 = 80,500
      .taskComplete(OWN, 1_000, 1_010)
      .tokenCount([1_090_000, 0, 1_600], [10_000, 0, 100]) // wrapper active again → 0 (growth 10,100 skipped)
      .taskComplete('rollout-2')
      .taskStarted(OWN2, 1_020)
      .turnContextNested(OWN2, 'codex-auto-review', 'low')
      .assistant()
      .tokenCount([1_190_000, 0, 1_700], [100_000, 0, 100]); // own: Δ 100,000 + 100 = 100,100
    const { usage, state } = run(r.lines, { turns: () => new Map([[OWN, { turnId: OWN, startedAtS: 1_000 }], [OWN2, { turnId: OWN2, startedAtS: 1_020 }]]) });
    // 80,500 + 100,100 = 180,600
    expect(billable(usage)).toBe(180_600);
    expect(state.summary.ownInWrapperEvents).toBe(1);
    expect(state.summary.ownInWrapperTotal).toBe(80_500);
    expect(state.summary.replayEvents).toBe(1);
    expect(state.summary.replayExcludedTotal).toBe(10_100);
    expect(usage.map((u) => u.turnId)).toEqual([OWN, OWN2]);
  });

  it('keeps the first counter on a reactivated replay wrapper inherited after prior own output', () => {
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'subagent', parent_thread_id: PARENT })
      .taskStarted('rollout-2')
      .taskStarted(OWN, 1_000)
      .turnContextNested(OWN, 'codex-auto-review', 'low')
      .assistant()
      .taskComplete(OWN, 1_000, 1_010)
      .tokenCount([1_000, 0, 10], [1_000, 0, 10]) // first counter: wrapper is active again
      .taskComplete('rollout-2')
      .taskStarted(OWN2, 1_020)
      .turnContextNested(OWN2, 'codex-auto-review', 'low')
      .assistant()
      .tokenCount([1_500, 0, 30], [500, 0, 20]);
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(1);
    expect(billable(usage)).toBe(520);
    expect(usage[0]!.turnId).toBe(OWN2);
    expect(state.summary).toMatchObject({
      firstEventBeforeOwnTurn: false,
      baselineTotal: 1_010,
      ownTotalDerived: 520,
    });
  });

  it('A2000 019ff278 pattern: own turn_context BEFORE the wrapper → events inside the wrapper are own', () => {
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'subagent', parent_thread_id: PARENT, source: { subagent: { thread_spawn: { parent_thread_id: PARENT } } } })
      .compacted()
      .turnContextNested(OWN, 'gpt-5.6-sol', 'high')
      .tokenCount([29_416_933, 0, 0, 0, 0, 29_416_933], [0, 0, 0, 0, 0, 65_763]) // first, no output yet → baseline
      .taskStarted('rollout-4', 1_786_479_434)
      .assistant()
      .tokenCount([29_486_000, 0, 703], [69_067, 0, 703]) // own: Δ total 29,486,703 − 29,416,933 = 69,770
      .tokenCount([29_558_000, 0, 1_086], [72_000, 0, 383]) // own: Δ 72,383
      .taskComplete(OWN, 1_786_479_434, 1_786_482_784)
      .taskComplete('rollout-4', undefined, 1_786_479_434)
      .taskStarted(OWN2, 1_020)
      .turnContextNested(OWN2, 'gpt-5.6-sol', 'high')
      .assistant()
      .tokenCount([29_658_000, 0, 1_186], [100_000, 0, 100]); // own: Δ 100,100
    const { usage, state } = run(r.lines, { turns: () => new Map([[OWN, { turnId: OWN, startedAtS: 1_000 }], [OWN2, { turnId: OWN2, startedAtS: 1_020 }]]) });
    // billable (input+output) Δs: 69,067+703 = 69,770 ; 72,000+383 = 72,383 ; 100,000+100 = 100,100 → 242,253
    expect(billable(usage)).toBe(242_253);
    expect(state.summary.baselineTotal).toBe(29_416_933);
    expect(state.summary.replayEvents + state.summary.olderTurnEvents).toBe(0);
    expect(state.summary.ownInWrapperEvents).toBe(2);
    expect(state.summary.ownInWrapperTotal).toBe(69_770 + 72_383);
    expect(usage.slice(0, 2).every((u) => u.turnId === OWN)).toBe(true);
  });

  it('A2000 019ff2f3 pattern: an own turn opened inside rollout-2 stays open across rollout-264 until its turn_aborted', () => {
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'subagent', parent_thread_id: PARENT })
      .compacted()
      .tokenCount([2_000_000, 0, 2_000], [0, 0, 0, 0, 0, 9_000]) // first → baseline
      .taskStarted('rollout-2', 1_000)
      .turnContextNested(OWN, 'gpt-5.6-sol', 'high')
      .assistant()
      .tokenCount([2_010_000, 0, 2_100], [10_000, 0, 100]) // own (nested in rollout-2): 10,100
      .taskComplete('rollout-2', undefined, 1_000) // closes ONLY the wrapper
      .taskStarted('rollout-264', 1_000)
      .tokenCount([2_030_000, 0, 2_300], [20_000, 0, 200]) // own turn still open: 20,200
      .turnAborted(OWN)
      .tokenCount([2_040_000, 0, 2_400], [10_000, 0, 100]) // only rollout-264 open → 0 (growth 10,100)
      .taskComplete('rollout-264', undefined, 1_000);
    const { usage, state } = run(r.lines, { turns: () => new Map([[OWN, { turnId: OWN, startedAtS: 1_000 }], [OWN2, { turnId: OWN2, startedAtS: 1_020 }]]) });
    expect(billable(usage)).toBe(30_300);
    expect(state.summary.ownInWrapperEvents).toBe(2);
    expect(state.summary.replayEvents).toBe(1);
    expect(state.summary.replayExcludedTotal).toBe(10_100);
    expect(state.openTurns).toEqual([]);
  });

  it('a turn of unknown age (UUIDv4) opened before a wrapper does NOT make the wrapper own (A2000 019ff44a: parent copies)', () => {
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'subagent', parent_thread_id: PARENT })
      .turnContextNested(V4, 'gpt-5.6-sol', 'high')
      .tokenCount([500_000, 0, 500], [0, 0, 0, 0, 0, 10_000]) // first → baseline
      .taskStarted('rollout-3')
      .assistant()
      .tokenCount([550_000, 0, 600], [50_000, 0, 100]) // copied → 0
      .taskComplete(V4)
      .taskComplete('rollout-3')
      .taskStarted(OWN, 1_000)
      .turnContextNested(OWN, 'gpt-5.6-sol', 'high')
      .assistant()
      .tokenCount([560_000, 0, 700], [10_000, 0, 100]); // own Δ 10,000 + 100
    const { usage, state } = run(r.lines, { turns: () => new Map([[OWN, { turnId: OWN, startedAtS: 1_000 }], [OWN2, { turnId: OWN2, startedAtS: 1_020 }]]) });
    expect(billable(usage)).toBe(10_100);
    expect(state.summary.replayEvents).toBe(1);
    expect(state.summary.replayExcludedTotal).toBe(50_100);
    expect(state.summary.ownInWrapperEvents).toBe(0);
  });

  it('an older (parent) turn_context before the wrapper keeps the region inherited (01a02222 pattern)', () => {
    const older = '01a0aaa9-ffff-7000-8000-000000000009';
    const r = new Rollout()
      .meta({ id: TH, thread_source: 'subagent', parent_thread_id: PARENT })
      .turnContextNested(older, 'gpt-5.6-sol', 'high')
      .tokenCount([500_000, 0, 500], [0, 0, 0, 0, 0, 10_000])
      .taskStarted('rollout-4')
      .assistant()
      .tokenCount([550_000, 0, 600], [50_000, 0, 100]) // copied → 0
      .taskComplete('rollout-4')
      .taskStarted(OWN, 1_000)
      .turnContextNested(OWN, 'gpt-5.6-sol', 'high')
      .assistant()
      .tokenCount([560_000, 0, 700], [10_000, 0, 100]);
    const { usage, state } = run(r.lines, { turns: () => new Map([[OWN, { turnId: OWN, startedAtS: 1_000 }], [OWN2, { turnId: OWN2, startedAtS: 1_020 }]]) });
    expect(billable(usage)).toBe(10_100);
    expect(state.summary.replayEvents).toBe(1);
  });

  it('resumes from a pre-§15.10.1 state (no openTurns): the persisted active turn is the single open turn', () => {
    const head = new Rollout()
      .meta({ id: TH, thread_source: 'user' })
      .taskStarted(OWN).assistant()
      .tokenCount([1_000, 0, 10], [1_000, 0, 10]);
    const a = run(head.lines);
    const legacy = JSON.parse(JSON.stringify(a.state)) as CodexFileState & { openTurns?: unknown };
    delete legacy.openTurns;
    delete (legacy.summary as Partial<typeof legacy.summary>).ownInWrapperEvents;
    const tail = new Rollout().tokenCount([1_500, 0, 20], [500, 0, 10]); // Δ 500 + 10 in turn OWN
    const b = run(tail.lines, {}, legacy);
    expect(billable(b.usage)).toBe(510);
    expect(b.usage[0]!.turnId).toBe(OWN);
    expect(b.state.openTurns).toEqual([{ id: OWN }]);
    expect(b.state.summary.ownInWrapperEvents).toBe(0);
  });

  it('the M4a fixture split at EVERY line boundary (JSON state round-trip) yields identical events', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { FIXTURES } = await import('./helpers.js');
    const lines = fs.readFileSync(path.join(FIXTURES, 'm4a-auto-review-01a00057.jsonl'), 'utf8').split('\n').filter(Boolean);
    const whole = run(lines);
    for (let cut = 0; cut <= lines.length; cut++) {
      let a: ReturnType<typeof run>;
      try { a = run(lines.slice(0, cut)); }
      catch (error) {
        expect(String(error)).toContain('waiting for a verifiable turn timestamp');
        const retried = run(lines);
        expect(retried.usage.map(u => [u.id, u.components])).toEqual(whole.usage.map(u => [u.id, u.components]));
        expect(retried.state.summary).toEqual(whole.state.summary);
        continue;
      }
      const restored = JSON.parse(JSON.stringify(a.state)) as CodexFileState;
      const b = run(lines.slice(cut), {}, restored);
      expect([...a.usage, ...b.usage].map((u) => [u.id, u.components])).toEqual(whole.usage.map((u) => [u.id, u.components]));
      expect(b.state.summary).toEqual(whole.state.summary);
    }
  });
});

describe('trailing token_usage_records (own responses with no later token_count)', () => {
  const TH = '01a0aaaa-0000-7000-8000-000000000001';
  const OWN = '01a0aaab-0000-7000-8000-000000000002';
  const OWN2 = '01a0aaac-0000-7000-8000-000000000003';
  // A2000 01a0819d-cfe2 shape: records 34,196 / 34,354 / 36,416 each followed by a token_count, then a last
  // record 38,860 and EOF (the guardian ended). Scaled-down numbers, same structure.
  const base = () =>
    new Rollout()
      .meta({ id: TH, thread_source: 'guardian_review', parent_thread_id: PARENT })
      .taskStarted(OWN, 1_788_264_000).turnContextNested(OWN, 'codex-auto-review', 'low').assistant()
      .record(TH, OWN, 'resp_1', [300, 100, 42])
      .tokenCount([300, 100, 42], [300, 100, 42]) // first event after an own turn: its own last → 342
      .record(TH, OWN, 'resp_2', [350, 300, 4]); // trailing: no token_count follows

  it('are NOT emitted while the file may still be written (the record precedes its token_count)', () => {
    const { usage, state } = run(base().lines);
    expect(billable(usage)).toBe(342);
    expect(state.pending).toHaveLength(1);
  });

  it('finalizeTrailingRecords (idle file) emits them once, keyed by the record line, flagged recordReconciled', () => {
    const p = new CodexRolloutParser(undefined, { host: 'test' });
    const lines = base().lines;
    for (const l of lines) p.pushLine(l);
    p.finalizeTrailingRecords();
    p.finalizeTrailingRecords(); // idempotent: nothing left pending
    const usage = p.takeUsage();
    // 342 + (350 + 4) = 696
    expect(billable(usage)).toBe(696);
    expect(usage[1]!.id).toBe(`codex:${TH}:${lines.length - 1}`); // ordinal of the record line
    expect(usage[1]!.flags).toEqual(['recordReconciled']);
    expect(usage[1]!.components[0]!.codexFieldStateEvidence).toMatchObject({
      source: 'token_usage_record.usage', basis: 'trailing-record',
    });
    expect(p.state.summary.trailingRecords).toBe(1);
    expect(p.state.summary.trailingRecordTotal).toBe(354);
    expect(p.state.pending).toHaveLength(0);
  });

  it('a thread resumed after finalization does not count the finalized responses twice', () => {
    const p = new CodexRolloutParser(undefined, { host: 'test' });
    for (const l of base().lines) p.pushLine(l);
    p.finalizeTrailingRecords();
    const first = p.takeUsage();
    const restored = JSON.parse(JSON.stringify(p.snapshotState())) as CodexFileState;
    // the thread resumes: the counter now includes resp_2 (354) AND a new response of 510 with no record
    const more = new Rollout(Date.UTC(2026, 8, 1, 13, 0, 0))
      .taskStarted(OWN2, 1_788_267_600).assistant()
      .tokenCount([1_150, 700, 56], [500, 300, 10]); // Δ from 342: input 850, cached 600, output 14 (=354 + 510)
    const b = run(more.lines, {}, restored);
    // counter Δ = (1,150 + 56) − (300 + 42) = 864 = resp_2 354 + new 510 → this event emits only 510:
    //   input 850 − 350 = 500, cached 600 − 300 = 300, output 14 − 4 = 10
    expect(fieldSum(b.usage)).toEqual({ input: 500, cached: 300, cacheWrite: 0, output: 10, reasoning: 0 });
    // emitted: 342 + 354 (finalized) + 510 = 1,206 = the counter's total
    expect(billable(first) + billable(b.usage)).toBe(1_206);
    // ownTotalDerived stays the pure counter derivation (gate 3): 342 + 864 = 1,206
    expect(b.state.summary.ownTotalDerived).toBe(1_206);
    expect(b.state.emittedAhead).toBeUndefined();
  });
});

describe('counter reset (§15.2.1)', () => {
  it('on a decrease contributes last_token_usage, flags counterReset and re-anchors', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'user' })
      .taskStarted('T1').assistant()
      .tokenCount([1_000_000, 900_000, 5_000], [1_000_000, 900_000, 5_000])
      .tokenCount([1_500_000, 1_300_000, 8_000], [500_000, 400_000, 3_000])
      .settings('gpt-5.6-luna')
      .taskStarted('T2').assistant()
      .tokenCount([70_000, 60_000, 300], [70_000, 60_000, 300]) // reset: total 70,300 < 1,508,000
      .tokenCount([140_000, 125_000, 500], [70_000, 65_000, 200]); // Δ vs re-anchored 70,300
    const { usage, state } = run(r.lines);
    // 1,005,000 + 503,000 + 70,300 + 70,200 = 1,648,500
    expect(billable(usage)).toBe(1_648_500);
    expect(state.summary.resets).toBe(1);
    expect(state.summary.lastTotal).toBe(140_500); // what threads.tokens_used would show (undercount)
    expect(usage[2]!.flags).toContain('counterReset');
    expect(usage[2]!.model).toBe('gpt-5.6-luna');
  });
});

describe('token_usage_record ground truth (§15.2.2)', () => {
  it('records pending since the previous token_count become the event components', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'user' })
      .taskStarted('T1').assistant()
      .record(SID, 'T1', 'resp_a', [30_000, 17_000, 500, 300])
      .tokenCount([30_000, 17_000, 500, 300], [30_000, 17_000, 500, 300])
      .record(SID, 'T1', 'resp_b', [40_000, 29_000, 400, 200])
      .record(SID, 'T1', 'resp_b', [40_000, 29_000, 400, 200]) // duplicate response_id → ignored
      .record(PARENT, 'T0', 'resp_parent', [9, 9, 9]) // another thread's record → ignored
      .compacted()
      .record(SID, 'T1', 'resp_compact', [238_597, 229_248, 4_596]) // compaction call the counter misses
      .tokenCount([70_000, 46_000, 900, 500], [40_000, 29_000, 400, 200]);
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(2);
    expect(usage.every((u) => u.flags.includes('recordReconciled'))).toBe(true);
    // records: 30,500 + 40,400 + 243,193 = 314,093 ; derivation would give 70,900
    expect(billable(usage)).toBe(314_093);
    expect(usage[1]!.components).toHaveLength(2); // one component per response (own requestInput each)
    expect(usage[1]!.components.map((c) => c.requestInput)).toEqual([40_000, 238_597]);
    expect(state.summary.records).toBe(3);
    expect(state.summary.recordDuplicates).toBe(1);
    expect(state.summary.recordsForeignThread).toBe(1);
    expect(state.summary.recordMismatches).toBe(1);
    expect(state.summary.recordTotal).toBe(314_093);
    expect(state.summary.ownTotalDerived).toBe(70_900);
  });
});

describe('model / effort sources (§15.2.7)', () => {
  it('flat turn_context, nested turn_context, thread_settings and token_count payload model', () => {
    const r = new Rollout()
      .meta({ id: SID })
      .taskStarted('T1')
      .turnContextFlat('T1', 'gpt-6-sol', 'high').assistant()
      .tokenCount([10, 0, 1], [10, 0, 1])
      .turnContextNested('T2', 'gpt-6-astra', 'low')
      .tokenCount([20, 0, 2], [10, 0, 1])
      .tokenCount([30, 0, 3], [10, 0, 1], { model: 'gpt-6-luna' })
      .settings('gpt-5.6-terra', 'xhigh')
      .tokenCount([40, 0, 4], [10, 0, 1]);
    const { usage } = run(r.lines);
    expect(usage.map((u) => [u.model, u.effort])).toEqual([
      ['gpt-6-sol', 'high'],
      ['gpt-6-astra', 'low'],
      ['gpt-6-luna', 'low'],
      ['gpt-5.6-terra', 'xhigh'],
    ]);
  });
  it('world_state model is a fallback only', () => {
    const r = new Rollout().meta({ id: SID }).worldState('gpt-5.6-sol').taskStarted('T1').assistant().tokenCount([10, 0, 1], [10, 0, 1]);
    expect(run(r.lines).usage[0]!.model).toBe('gpt-5.6-sol');
  });
});

describe('imports (§15.2.6)', () => {
  it('only the exact marker (or external-import-turn-N) tags later usage importedContext', () => {
    const base = () => new Rollout().meta({ id: SID }).taskStarted('T1').assistant().tokenCount([10, 0, 1], [10, 0, 1]);
    const mentioned = base().agentText('see <EXTERNAL SESSION IMPORTED> in the docs').tokenCount([20, 0, 2], [10, 0, 1]);
    expect(run(mentioned.lines).usage.flatMap((u) => u.flags)).not.toContain('importedContext');
    const marked = base().marker().tokenCount([20, 0, 2], [10, 0, 1]);
    const out = run(marked.lines);
    expect(out.usage[0]!.flags).not.toContain('importedContext');
    expect(out.usage[1]!.flags).toContain('importedContext');
    expect(out.state.summary.importDetected).toBe(true);
    const turn = new Rollout().meta({ id: SID }).taskStarted('external-import-turn-3');
    expect(run(turn.lines).state.summary.importDetected).toBe(true);
  });
  it('the synthetic import token_count (zero fields, total only) contributes nothing', () => {
    const r = new Rollout(Date.UTC(2026, 8, 26), 1, false)
      .meta({ id: SID })
      .taskStarted('external-import-turn-1', 1_790_454_805)
      .user().assistant().marker()
      .tokenCount([0, 0, 0, 0, 0, 21_388], [0, 0, 0, 0, 0, 21_388]);
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(0);
    expect(state.summary.baselineBillable).toBe(0);
  });

  // Two total-only counts under generic external-import-turn-N ids, no marker (shape of fixture 01a09fbf).
  const twoImportCounts = () => new Rollout()
    .meta({ id: SID })
    .taskStarted('external-import-turn-1').user().assistant()
    .tokenCount([0, 0, 0, 0, 0, 1_000], [0, 0, 0, 0, 0, 1_000])
    .taskComplete('external-import-turn-1')
    .taskStarted('external-import-turn-2').user().assistant()
    .tokenCount([0, 0, 0, 0, 0, 1_600], [0, 0, 0, 0, 0, 1_600])
    .taskComplete('external-import-turn-2');

  it('generic import turns without a marker: no usage, no activity; total growth stays in the raw counter diagnostic', () => {
    const { usage, marks, state } = run(twoImportCounts().lines);
    expect(usage).toHaveLength(0);
    expect(marks).toHaveLength(0); // import turns are not this session's activity
    // first count 1,000 precedes any real turn → baseline; 1,600 − 1,000 = 600 is non-billable total-only growth
    expect(state.summary).toMatchObject({
      importDetected: true, tokenCountEvents: 2, firstEventBeforeOwnTurn: true, baselineTotal: 1_000,
      ownTotalDerived: 600, ownBillableEmitted: 0, lastTotal: 1_600, resets: 0, fieldDecreases: 0,
    });
  });

  // The counter total across a synthetic → real transition has no fixture evidence, so these cases pin only what is
  // emitted (records win) and the record-side summary, never `ownTotalDerived`.
  it('a real turn nested inside an open import turn: its records are emitted, tagged importedContext', () => {
    const r = new Rollout()
      .meta({ id: SID })
      .taskStarted('external-import-turn-1').user().assistant()
      .tokenCount([0, 0, 0, 0, 0, 1_000], [0, 0, 0, 0, 0, 1_000])
      .taskStarted('T1').assistant() // real turn opened while the import turn is still open
      .record(SID, 'T1', 'resp_1', [800, 500, 10])
      .record(SID, 'T1', 'resp_c', [300, 200, 5]) // compaction-like response the counter never includes
      .tokenCount([800, 500, 10, 0, 0, 1_810], [800, 500, 10])
      .taskComplete('T1')
      .taskComplete('external-import-turn-1');
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.turnId).toBe('T1');
    expect(usage[0]!.flags).toEqual(expect.arrayContaining(['recordReconciled', 'importedContext']));
    // records win: 810 + 305 = 1,115 (input 800 + 300, cached 500 + 200, output 10 + 5)
    expect(billable(usage)).toBe(1_115);
    expect(fieldSum(usage)).toEqual({ input: 1_100, cached: 700, cacheWrite: 0, output: 15, reasoning: 0 });
    expect(state.summary).toMatchObject({ importDetected: true, records: 2, recordTotal: 1_115, recordMismatches: 1, ownBillableEmitted: 1_115 });
  });

  it('a real turn after a marker import: records are emitted with importedContext; the import count emits nothing', () => {
    const r = new Rollout()
      .meta({ id: SID })
      .taskStarted('external-import-turn-1').user().assistant().marker()
      .tokenCount([0, 0, 0, 0, 0, 21_388], [0, 0, 0, 0, 0, 21_388])
      .taskComplete('external-import-turn-1')
      .taskStarted('T2').assistant()
      .record(SID, 'T2', 'resp_2', [1_000, 600, 20, 5])
      .tokenCount([1_000, 600, 20, 5, 0, 22_408], [1_000, 600, 20, 5]);
    const { usage, state } = run(r.lines);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.flags).toEqual(expect.arrayContaining(['recordReconciled', 'importedContext']));
    expect(fieldSum(usage)).toEqual({ input: 1_000, cached: 600, cacheWrite: 0, output: 20, reasoning: 5 });
    expect(state.summary).toMatchObject({ importDetected: true, baselineTotal: 21_388, baselineBillable: 0, records: 1, ownBillableEmitted: 1_020 });
  });

  it('resuming at every line boundary across total-only import counts yields identical events and summary', () => {
    const r = twoImportCounts().marker()
      .taskStarted('T1').assistant()
      .record(SID, 'T1', 'resp_1', [800, 500, 10])
      .tokenCount([800, 500, 10, 0, 0, 2_410], [800, 500, 10]);
    const whole = run(r.lines);
    for (let cut = 0; cut <= r.lines.length; cut++) {
      const a = run(r.lines.slice(0, cut));
      const restored = JSON.parse(JSON.stringify(a.state)) as CodexFileState;
      const b = run(r.lines.slice(cut), {}, restored);
      expect(withoutCodexFieldState([...a.usage, ...b.usage])).toEqual(withoutCodexFieldState(whole.usage));
      expect(b.state.summary).toEqual(whole.state.summary);
      expect(b.state.imported).toBe(true);
    }
    expect(billable(whole.usage)).toBe(810); // the record only; both import counts emit nothing
    expect(whole.usage[0]!.flags).toContain('importedContext');
  });
});

describe('timestamps (§15.2.5)', () => {
  const created = Date.UTC(2026, 7, 24, 20, 46, 24, 849);
  const frozen = () =>
    new Rollout(created, 0) // every line carries the creation timestamp
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT, source: { subagent: { other: 'guardian' } } })
      .tokenCount([1000, 0, 10], [0, 0, 0, 0, 0, 500])
      .taskStarted('rollout-2', 1_787_604_384)
      .turnContextFlat('T-a', 'codex-auto-review', 'low') // real turn with NO task_started line
      .assistant()
      .tokenCount([2000, 0, 20], [1000, 0, 10])
      .taskComplete('T-a', 1_787_851_514, 1_787_851_571, 56_280)
      .taskStarted('T-b', 1_787_851_596)
      .turnContextFlat('T-b', 'codex-auto-review', 'low')
      .assistant()
      .tokenCount([3000, 0, 30], [1000, 0, 10]);

  it('frozen subagent lines use task_started / the turn\'s task_complete started_at (not the frozen line time)', () => {
    const { usage, marks } = run(frozen().lines);
    expect(usage.map((u) => [u.tsSource, u.ts]).sort()).toEqual([
      ['turn', 1_787_851_514_000], // T-a: no task_started line → held until task_complete(started_at)
      ['turn', 1_787_851_596_000], // T-b: in-file task_started
    ]);
    expect(usage.every((u) => u.ts !== created)).toBe(true);
    const done = marks.find((m) => m.kind === 'turn' && m.durationMs === 56_280);
    expect(done?.ts).toBe(1_787_851_571_000);
  });

  it('an unfinished subagent turn refuses a checkpoint instead of billing at its frozen line time', () => {
    const r = new Rollout(created, 0)
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT })
      .tokenCount([1000, 0, 10], [0, 0, 0, 0, 0, 5]) // inherited snapshot → 0
      .taskStarted('rollout-2', 1_787_604_384)
      .turnContextFlat('T-a', 'codex-auto-review', 'low')
      .assistant()
      .tokenCount([3000, 0, 30], [2000, 0, 20]); // Δ 2,000 / 20, turn never completes in this read
    expect(() => run(r.lines)).toThrow('waiting for a verifiable turn timestamp');

  });

  it('thread_turns rows (thread_history_1.sqlite) win for frozen files', () => {
    const rows = new Map<string, TurnTiming>([
      ['T-a', { turnId: 'T-a', startedAtS: 1_787_851_514, completedAtS: 1_787_851_571, durationMs: 56_280, status: 'completed', rolloutOrdinal: 5 }],
    ]);
    const { usage } = run(frozen().lines, { turns: (tid) => (tid === SID ? rows : undefined) });
    expect(usage.map((u) => [u.tsSource, u.ts])).toEqual([
      ['turn', 1_787_851_514_000],
      ['turn', 1_787_851_596_000],
    ]);
  });

  it('root counter prefers verified turn time; record-sourced events retain their real record time', () => {
    const t0 = Date.UTC(2026, 8, 8, 13, 14, 13);
    const r = new Rollout(t0, 1000)
      .meta({ id: SID, thread_source: 'user' })
      .taskStarted('T1', 1).assistant()
      .tokenCount([10, 0, 1], [10, 0, 1])
      .record(SID, 'T1', 'resp_x', [10, 0, 1])
      .tokenCount([20, 0, 2], [10, 0, 1]);
    const { usage } = run(r.lines);
    expect(usage.map((u) => [u.tsSource, u.ts])).toEqual([
      ['turn', 1000],
      ['record', t0 + 4000],
    ]);
  });
});

describe('rate limits → LimitSnapshot', () => {
  it('keeps the newest snapshot with windows in epoch ms', () => {
    const rl = (pct: number) => ({
      limit_id: 'codex', primary: { used_percent: pct, window_minutes: 10080, resets_at: 1_790_444_630 }, secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'pro',
    });
    const r = new Rollout().meta({ id: SID }).taskStarted('T1').assistant()
      .tokenCount([10, 0, 1], [10, 0, 1], { rate_limits: rl(41) })
      .tokenCountNoInfo(rl(79))
      .tokenCountNoInfo({ ...rl(5), limit_id: 'premium' }); // another limit id never overwrites the plan limit
    const { state } = run(r.lines);
    expect(state.lastLimits).toMatchObject({
      source: 'codex', host: 'test', estimate: false, planType: 'pro',
      windows: [{ id: 'primary', usedPercent: 79, windowMinutes: 10080, resetsAt: 1_790_444_630_000 }],
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    });
  });
});

describe('rate limits are kept per limit_id (DESIGN §15.9.5)', () => {
  const rl = (id: string, pct: number | null, name: string | null = null) => ({
    limit_id: id, limit_name: name,
    primary: pct === null ? null : { used_percent: pct, window_minutes: 10080, resets_at: 1_790_444_630 },
    secondary: null, credits: { has_credits: false, unlimited: false, balance: '0' }, plan_type: 'pro',
  });

  it('each id keeps its own newest snapshot with limitId set; an id with no windows (A2000 "premium") is skipped', () => {
    const r = new Rollout().meta({ id: SID }).taskStarted('T1').assistant()
      .tokenCountNoInfo(rl('codex', 41), 1_789_000_000_000)
      .tokenCountNoInfo(rl('codex_bengalfox', 0, 'GPT-5.3-Codex-Spark'), 1_789_000_001_000)
      .tokenCountNoInfo(rl('codex', 44), 1_789_000_002_000)
      .tokenCountNoInfo(rl('premium', null), 1_789_000_003_000);
    const { state } = run(r.lines);
    expect(Object.keys(state.limitsById ?? {}).sort()).toEqual(['codex', 'codex_bengalfox']);
    expect(state.limitsById!.codex).toMatchObject({ limitId: 'codex', windows: [{ usedPercent: 44 }] });
    expect(state.limitsById!.codex_bengalfox).toMatchObject({ limitId: 'codex_bengalfox', windows: [{ usedPercent: 0 }] });
    // back-compat field still tracks only the main plan limit
    expect(state.lastLimits).toMatchObject({ limitId: 'codex', windows: [{ usedPercent: 44 }] });
  });

  it('a snapshot without limit_id (older Codex) is the main "codex" limit', () => {
    const { limit_id: _drop, ...noId } = rl('codex', 12);
    void _drop;
    const r = new Rollout().meta({ id: SID }).taskStarted('T1').assistant().tokenCountNoInfo(noId);
    const { state } = run(r.lines);
    expect(state.limitsById?.codex?.limitId).toBe('codex');
  });
});

describe('resumability', () => {
  it('splitting the stream at EVERY line boundary (with JSON state round-trip) yields identical events', () => {
    const r = new Rollout()
      .meta({ id: SID, thread_source: 'subagent', parent_thread_id: PARENT })
      .tokenCount([5000, 0, 50], [0, 0, 0, 0, 0, 100])
      .taskStarted('rollout-3').assistant()
      .tokenCount([6000, 0, 60], [1000, 0, 10])
      .taskStarted('T1', 1_788_264_000).assistant()
      .record(SID, 'T1', 'resp_1', [1000, 500, 10])
      .tokenCount([7000, 500, 70], [1000, 500, 10])
      .tokenCount([100, 0, 5], [100, 0, 5])
      .tokenCount([300, 0, 9], [200, 0, 4]);
    const whole = run(r.lines);
    for (let cut = 0; cut <= r.lines.length; cut++) {
      const a = run(r.lines.slice(0, cut));
      const restored = JSON.parse(JSON.stringify(a.state)) as CodexFileState;
      const b = run(r.lines.slice(cut), {}, restored);
      expect(withoutCodexFieldState([...a.usage, ...b.usage])).toEqual(withoutCodexFieldState(whole.usage));
      expect(b.state.summary).toEqual(whole.state.summary);
    }
    // hand check: first 0 (pre-turn), replay 0, record 1,010, reset 105, Δ 204 → 1,319
    expect(billable(whole.usage)).toBe(1_319);
  });
});

describe('toUsageEvent money and stub valuation-seam value (stub engines, hand-computed)', () => {
  it('prices each component and sums', () => {
    const store = new MemoryStore();
    const ctx = makeCtx(store);
    const r = new Rollout().meta({ id: SID, thread_source: 'user', originator: 'Codex Desktop' })
      .taskStarted('T1').turnContextFlat('T1', 'gpt-6-luna', 'medium').assistant()
      .tokenCount([1_000_000, 600_000, 20_000, 5_000, 100_000], [1_000_000, 600_000, 20_000, 5_000, 100_000]);
    const { usage, state } = run(r.lines);
    const ev = toUsageEvent(usage[0]!, state.meta, ctx);
    // inputFresh = 1,000,000 − 600,000 − 100,000 = 300,000; cacheRead 600,000; cw5m 100,000; output 20,000
    expect(ev.tokens).toEqual({ inputFresh: 300_000, cacheWrite5m: 100_000, cacheWrite1h: 0, cacheRead: 600_000, output: 20_000, reasoning: 5_000 });
    // $ = (300,000×2 + 100,000×2.5 + 600,000×0.2 + 20,000×10)/1e6 = (600,000 + 250,000 + 120,000 + 200,000)/1e6 = 1.17
    expect(ev.apiEquivUsd).toBeCloseTo(1.17, 10);
    expect(stubUsd(ev.tokens)).toBeCloseTo(1.17, 10);
    // stub valuation-seam value = (300,000 + 100,000 + 20,000)/1000 = 420
    expect(ev.reservedValue).toBe(420);
    expect(ev).toMatchObject({ source: 'codex', sessionId: SID, isSubagent: false, entrypoint: 'Codex Desktop', project: '/fixture/project', effort: 'medium', provider: 'openai' });
  });
});

describe('passive Codex field-state evidence', () => {
  const countLine = (ordinal: number, total: Record<string, unknown>, last: Record<string, unknown>): string => JSON.stringify({
    timestamp: '2026-09-01T12:00:04.000Z', ordinal, type: 'event_msg',
    payload: { type: 'token_count', model: 'gpt-6-luna', info: { total_token_usage: total, last_token_usage: last } },
  });
  const ownPrefix = () => new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T1').assistant().lines;
  const usageFields = (cacheRead?: unknown): Record<string, unknown> => ({
    input_tokens: 10, ...(cacheRead === undefined ? {} : { cached_input_tokens: cacheRead }),
    cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 13,
  });

  it('distinguishes reported zero, absent, and invalid while keeping normalized numbers identical', () => {
    const cases = [
      { value: 0, expected: 'reported-zero' },
      { value: undefined, expected: 'missing' },
      { value: '0', expected: 'invalid' },
    ] as const;
    const results = cases.map(({ value, expected }) => {
      const total = usageFields(0);
      const last = usageFields(value);
      const lines = ownPrefix();
      const parsed = run([...lines, countLine(lines.length, total, last)]);
      const event = toUsageEvent(parsed.usage[0]!, parsed.state.meta, makeCtx(new MemoryStore()));
      return { expected, event, state: event.components[0]!.codexFieldStateEvidence };
    });
    expect(results.map(result => result.state?.fields.cached_input_tokens)).toEqual(['reported-zero', 'missing', 'invalid']);
    for (const { event } of results) {
      expect(event.tokens).toEqual({ inputFresh: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 3, reasoning: 0 });
      expect(event.tokens.countQuality).toBeUndefined();
      expect(event.components[0]!.codexFieldStateEvidence?.schemaVersion).toBe(1);
      expect(event.components[0]!.codexFieldStateEvidence).toMatchObject({
        source: 'token_count.info.last_token_usage', basis: 'first-own-last',
      });
    }
    expect(results.map(result => result.expected)).toEqual(results.map(result => result.state?.fields.cached_input_tokens));
  });

  it('keeps count IDs and normalized deltas through resume; prior cumulative field presence stays unassessed', () => {
    const r = new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T1').assistant()
      .tokenCount([10, 0, 2], [10, 0, 2])
      .tokenCount([20, 3, 5], [10, 3, 3]);
    const whole = run(r.lines);
    const first = run(r.lines.slice(0, -1));
    const resumed = run(r.lines.slice(-1), {}, JSON.parse(JSON.stringify(first.state)) as CodexFileState);
    expect(resumed.usage).toEqual(whole.usage.slice(1));
    expect(resumed.usage[0]!.id).toBe(whole.usage[1]!.id);
    const evidence = resumed.usage[0]!.components[0]!.codexFieldStateEvidence;
    expect(evidence).toMatchObject({ basis: 'counter-delta', priorPresence: 'unassessed' });
    expect(resumed.usage[0]!.components[0]!.raw).toEqual({ input: 10, cached: 3, cacheWrite: 0, output: 3, reasoning: 0, total: 13 });
    expect(toTokenCounts(resumed.usage[0]!.components[0]!.raw).tokens).toEqual({
      inputFresh: 7, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 3, output: 3, reasoning: 0,
    });
    expect(JSON.stringify(resumed.state)).not.toContain('codexFieldStateEvidence');
  });

  it('marks counter resets and direct records without changing their existing count basis', () => {
    const reset = new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T1').assistant()
      .tokenCount([100, 0, 5], [100, 0, 5])
      .tokenCount([20, 2, 3], [20, 2, 3]);
    const resetResult = run(reset.lines);
    expect(resetResult.usage[1]!.components[0]!.codexFieldStateEvidence).toMatchObject({
      source: 'token_count.info.last_token_usage', basis: 'counter-reset-last',
    });
    expect(resetResult.usage[1]!.components[0]!.raw).toEqual({ input: 20, cached: 2, cacheWrite: 0, output: 3, reasoning: 0, total: 23 });

    const record = new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T1').assistant()
      .record(SID, 'T1', 'resp-evidence', [9, 2, 4]).tokenCount([9, 2, 4], [9, 2, 4]);
    const recordResult = run(record.lines);
    expect(recordResult.usage[0]!.components[0]!.codexFieldStateEvidence).toMatchObject({
      source: 'token_usage_record.usage', basis: 'record-reconciled',
      fields: { input_tokens: 'reported-nonzero', cached_input_tokens: 'reported-nonzero', total_tokens: 'reported-nonzero' },
    });
    expect(recordResult.usage[0]!.id).toBe(`codex:${SID}:4`);
  });

  it('retains map entries only for pending records through reconciliation and trailing emission', () => {
    const r = new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T1').assistant()
      .record(SID, 'T1', 'resp-map-1', [9, 2, 4])
      .tokenCount([9, 2, 4], [9, 2, 4])
      .record(SID, 'T1', 'resp-map-2', [6, 1, 2]);
    const parser = new CodexRolloutParser(undefined, { host: 'test' });
    for (const line of r.lines.slice(0, 4)) parser.pushLine(line);
    expect(parser.state.pending).toHaveLength(1);
    expect(parserFieldStateMapSize(parser)).toBe(1);

    parser.pushLine(r.lines[4]!);
    expect(parser.state.pending).toHaveLength(0);
    expect(parserFieldStateMapSize(parser)).toBe(0);
    const reconciled = parser.takeUsage()[0]!;
    expect(reconciled.components[0]!.codexFieldStateEvidence).toMatchObject({
      basis: 'record-reconciled', fields: { input_tokens: 'reported-nonzero' },
    });

    parser.pushLine(r.lines[5]!);
    expect(parser.state.pending).toHaveLength(1);
    expect(parserFieldStateMapSize(parser)).toBe(1);
    parser.finalizeTrailingRecords();
    expect(parser.state.pending).toHaveLength(0);
    expect(parserFieldStateMapSize(parser)).toBe(0);
    expect(parser.takeUsage()[0]!.components[0]!.codexFieldStateEvidence).toMatchObject({
      basis: 'trailing-record', fields: { input_tokens: 'reported-nonzero' },
    });
  });

  it('does not invent pending record presence when resumed from a legacy cursor', () => {
    const prefix = new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T1').assistant()
      .record(SID, 'T1', 'resp-resume', [9, 2, 4]);
    const saved = run(prefix.lines);
    expect(parserFieldStateMapSize(saved.parser)).toBe(1);
    const tail = new Rollout( Date.UTC(2026, 8, 1, 12, 0, 5)).tokenCount([9, 2, 4], [9, 2, 4]);
    const resumed = run(tail.lines, {}, JSON.parse(JSON.stringify(saved.state)) as CodexFileState);
    expect(parserFieldStateMapSize(resumed.parser)).toBe(0);
    expect(resumed.usage[0]!.components[0]!.codexFieldStateEvidence).toMatchObject({
      source: 'token_usage_record.usage', basis: 'record-reconciled',
      fields: { input_tokens: 'unassessed', cached_input_tokens: 'unassessed' },
    });
  });
});


describe('exact response identity across persisted checkpoints (DESIGN15.2.2)', () => {
  const horizon = () => {
    const r = new Rollout().meta({ id: SID, thread_source: 'user' }).taskStarted('T-own')
      .turnContextFlat('T-own', 'gpt-6-sol', 'low').assistant();
    for (let i = 0; i < 4097; i++) r.record(SID, 'T-own', `history-${i}`, [10, 0, 1])
      .tokenCount([(i + 1) * 10, 0, i + 1], [10, 0, 1]);
    return r;
  };
  it.each(['same-parser', 'json-restart'] as const)('an oldest response remains deduplicated after %s beyond 4096 IDs', (mode) => {
    const r = horizon(), first = run(r.lines);
    expect(billable(first.usage)).toBe(4097 * 11);
    const cut = r.lines.length;
    r.record(SID, 'T-own', 'history-0', [10, 0, 1]).tokenCount([40970, 0, 4097], [10, 0, 1]);
    const p = mode === 'same-parser' ? first.parser : new CodexRolloutParser(JSON.parse(JSON.stringify(first.state)), { host: 'test' });
    for (const line of r.lines.slice(cut)) p.pushLine(line);
    expect(billable(p.takeUsage())).toBe(0);
    expect(p.snapshotState().responseIds).toHaveLength(4097);
    expect(p.snapshotState().responseIdsComplete).toBe(true);
    expect(p.snapshotState().summary.records).toBe(4097);
    expect(p.snapshotState().summary.recordDuplicates).toBe(1);
  });
  it('refuses a truncated legacy identity window when no consumed-prefix recovery is supplied', () => {
    const state = run(horizon().lines).state;
    delete state.responseIdsComplete; state.responseIds = state.responseIds.slice(-4096);
    expect(() => new CodexRolloutParser(state, { host: 'test' })).toThrow('response history is incomplete');
  });
});
