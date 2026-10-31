/**
 * Sanitized REAL rollouts from A2000 (and the numbers they must produce). Fixture provenance: extracted
 * read-only on 2026-09-26 from C:\Users\example\.codex with a sanitizer that keeps types, ordinals, ids, turn ids,
 * timestamps, models and token numbers and replaces all message/tool content with "[redacted]" and paths with
 * /fixture/... ; item_completed lines and post-first-token_count response_items were dropped (no usage content).
 *
 * Expected values were hand-computed by an independent Python walk of the same fixture lines (not by this
 * code) and cross-checked against per-response token_usage_record ground truth where the file has it, against
 * the S9 Opus verifier's numbers, and against state_5.threads.tokens_used (read-only, same day):
 *
 *   file (thread)                         tokens_used(DB)   own usage     evidence
 *   root-reset-01a08127                   299,371           1,823,004     29 records sum 1,823,004 (= verifier)
 *   subagent-copied-snapshot-01a02222     90,201,025        5,104,534     43 own-turn deltas; 125 replayed rollout-4
 *                                                                          events are verbatim parent copies (see below)
 *   guardian-records-01a0928c             8,787,895         440,528       3 records sum 440,528 (= verifier)
 *   import-marker-01a0dfe2                0                 0             import count is total_tokens-only (fields 0)
 *   import-turn-01a09fbf                  44,424            0             ditto (two synthetic counts, fields 0)
 *   frozen-subagent-01a03586              1,285,247,912     7,209,421     = verifier truth; last 1,285,247,912 − first 1,278,038,491
 *   plain-root-01a0c559                   50,280            50,280        3 records sum 50,280 (gate-3 exact)
 *   root-compaction-record-01a0d73e       9,865,508         10,108,701    76 records; +243,193 = one compaction response
 *                                                                          the token_count counter never includes
 *
 * M4a guardian auto-review rollouts, sanitized the same way on 2026-09-27 from ~/.codex (read
 * locally; world_state/item_completed lines dropped, response_items reduced to {type, role}, rate_limits dropped):
 *
 *   m4a-auto-review-01a00057              8,552,512         709,643       = tokens_used − first snapshot 7,842,869
 *   m4a-auto-review-01a000e9              21,611,305        1,956,726     = tokens_used − first snapshot 19,654,579
 *
 * Both open a replayed `rollout-2` wrapper whose NESTED turn (turn_context with a UUIDv7 ~2 h / ~12 h newer than
 * the thread) produces the first own token_count (81,580 / 89,574) — §15.10.1 innermost-open-turn rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRolloutFile, rawBillable, toUsageEvent, type ParsedUsage } from '../../src/collectors/codex.js';
import { FIXTURES, MemoryStore, makeCtx } from './helpers.js';

async function parse(name: string) {
  const res = await parseRolloutFile(path.join(FIXTURES, name), { host: 'A2000' });
  const f = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  let billable = 0;
  for (const u of res.usage) for (const c of u.components) {
    f.input += c.raw.input; f.cached += c.raw.cached; f.cacheWrite += c.raw.cacheWrite;
    f.output += c.raw.output; f.reasoning += c.raw.reasoning;
    billable += rawBillable(c.raw);
  }
  return { ...res, fields: f, billable, s: res.state.summary };
}

const flagsOf = (us: ParsedUsage[]) => new Set(us.flatMap((u) => u.flags));

describe('real A2000 fixtures — own usage (hand-computed)', () => {
  it('fixtures are sanitized: every string value is an id, timestamp, enum, model, version or [redacted]', () => {
    const allowed = [
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, // thread / turn ids
      /^resp_[0-9a-f]+$/,
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/,
      /^(rollout|external-import-turn)-\d+$/,
      /^\[redacted\]$/,
      /^<EXTERNAL SESSION IMPORTED>$/,
      /^\/fixture\/(project|agent)$/,
      /^fixture-branch$/,
      /^[a-z_]{1,32}$/, // enums: default, low, user, codex, pro, guardian, …
      /^v\d+$/, // multi_agent_version
      /^(gpt|codex)-[a-z0-9.-]+$/, // model ids
      /^\d+\.\d+\.\d+(-[a-z]+\.[\d.]+)?$/, // cli_version
      /^(Codex Desktop|rocky-desktop)$/, // originator (client name)
      /^Bacon$/, // Codex-assigned agent nickname
    ];
    for (const name of fs.readdirSync(FIXTURES)) {
      for (const line of fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n')) {
        if (!line) continue;
        const walk = (v: unknown, k: string): void => {
          if (typeof v === 'string') {
            if (!allowed.some((re) => re.test(v))) throw new Error(`${name}: unsanitized ${k}=${JSON.stringify(v).slice(0, 80)}`);
          } else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
          else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
        };
        walk(JSON.parse(line), '');
      }
    }
  });

  it('root with a mid-file counter reset (01a08127): 1,823,004 = Σ 29 records; tokens_used 299,371 undercounts', async () => {
    const r = await parse('root-reset-01a08127.jsonl');
    // segment 1: 30,640 … 1,523,633 (monotone)            → 1,523,633
    // reset at ordinal 233: total 74,283 == last 74,283   → 74,283
    // then 148,821 − 74,283 = 74,538; 223,984 − 148,821 = 75,163; 299,371 − 223,984 = 75,387
    // 1,523,633 + 74,283 + 74,538 + 75,163 + 75,387 = 1,823,004
    expect(r.billable).toBe(1_823_004);
    expect(r.fields).toEqual({ input: 1_814_001, cached: 1_738_496, cacheWrite: 0, output: 9_003, reasoning: 4_571 });
    expect(r.s.ownTotalDerived).toBe(1_823_004); // derivation alone agrees with the records
    expect(r.s.recordTotal).toBe(1_823_004);
    expect(r.s.records).toBe(29);
    expect(r.s.recordMismatches).toBe(0);
    expect(r.s.resets).toBe(1);
    expect(r.s.lastTotal).toBe(299_371); // == state_5.threads.tokens_used → never usage
    expect(r.usage).toHaveLength(29);
    expect(r.usage.find((u) => u.key === 233)!.flags).toEqual(expect.arrayContaining(['recordReconciled', 'counterReset']));
    expect(r.usage.every((u) => u.model === 'gpt-5.6-luna' && u.effort === 'xhigh' && u.tsSource === 'record')).toBe(true);
    expect(r.usage[0]!.id).toBe('codex:01a08127-9a3d-7220-a867-0b45fa2e2dab:16');
  });

  it('spawned subagent (01a02222): copied first snapshot = 0, replayed rollout-4 region = 0, own turns = 5,104,534', async () => {
    const r = await parse('subagent-copied-snapshot-01a02222.jsonl');
    // first token_count (ordinal 4, before any own turn): total 71,495,155 → baseline, contributes 0
    // 125 token_counts inside the replayed `rollout-4` turn: verbatim (total,last) copies of parent 01a02131's
    //   events (checked read-only against the 2 GB parent rollout on A2000) → 0; their growth 13,601,336 skipped
    // 43 events in the child's own turns 01a02222-a9f0… and 01a02238-80ca…: Σ deltas = 5,104,534
    // S9 verifier's number 18,705,870 = 5,104,534 + 13,601,336 (it counted the replayed parent events)
    expect(r.billable).toBe(5_104_534);
    expect(r.fields).toEqual({ input: 5_091_285, cached: 4_913_408, cacheWrite: 0, output: 13_249, reasoning: 5_832 });
    expect(r.s.firstEventBeforeOwnTurn).toBe(true);
    expect(r.s.baselineTotal).toBe(71_495_155);
    expect(r.s.ownTotalDerived).toBe(5_104_534);
    expect(r.s.replayEvents).toBe(125);
    expect(r.s.replayExcludedTotal).toBe(13_601_336);
    expect(r.s.lastTotal).toBe(90_201_025); // tokens_used
    expect(r.usage).toHaveLength(43);
    expect(r.state.meta).toMatchObject({ isSubagent: true, parentThreadId: '01a02131-e706-7ec0-9448-03b195060d6e', sourceKind: 'subagent:thread_spawn' });
    // every line carries the frozen creation time 2026-08-21T02:24:52.108Z; own turns ran 02:24:52 and 02:48:43Z
    expect(r.usage.every((u) => u.tsSource === 'turn')).toBe(true);
    expect(new Set(r.usage.map((u) => u.ts))).toEqual(new Set([1_787_279_092_000, 1_787_280_523_000]));
  });

  it('guardian_review with token_usage_record (01a0928c): 440,528 = Σ 3 records; first snapshot excluded', async () => {
    const r = await parse('guardian-records-01a0928c.jsonl');
    // records: 113,236 + 146,889 + 180,403 = 440,528 ; last 8,787,895 − first 8,347,367 = 440,528
    expect(r.billable).toBe(440_528);
    expect(r.fields).toEqual({ input: 440_209, cached: 263_424, cacheWrite: 0, output: 319, reasoning: 156 });
    expect(r.s.recordTotal).toBe(440_528);
    expect(r.s.ownTotalDerived).toBe(440_528); // derivation agrees with the records (first_last 73,507 NOT added)
    expect(r.s.baselineTotal).toBe(8_347_367);
    expect(r.s.firstEventBeforeOwnTurn).toBe(true);
    expect(flagsOf(r.usage)).toEqual(new Set(['recordReconciled']));
    // frozen file: the first own turn has no task_started line → held until its task_complete (started_at
    // 1789166114); the other two use their task_started times.
    expect(r.usage.map((u) => [u.tsSource, u.ts])).toEqual([
      ['turn', 1_789_166_114_000],
      ['turn', 1_789_166_158_000],
      ['turn', 1_789_166_171_000],
    ]);
    expect(r.state.lastLimits?.windows[0]).toMatchObject({ id: 'primary', windowMinutes: 10080 });
  });

  it('import rollouts carry only synthetic total_tokens counts → 0 own usage; import detected', async () => {
    const a = await parse('import-marker-01a0dfe2.jsonl');
    expect(a.usage).toHaveLength(0);
    expect(a.s.importDetected).toBe(true);
    expect(a.s.missingOrdinals).toBe(1); // cli 0.158 lines have no ordinal → line-index keys
    // one total-only count 21,388 (no real turn before it) → whole total is the baseline; own counter 0
    expect(a.s).toMatchObject({
      tokenCountEvents: 1, firstEventBeforeOwnTurn: true, baselineTotal: 21_388, baselineBillable: 0,
      ownTotalDerived: 0, ownBillableEmitted: 0, lastTotal: 21_388, resets: 0, fieldDecreases: 0, records: 0,
    });
    const b = await parse('import-turn-01a09fbf.jsonl');
    expect(b.usage).toHaveLength(0);
    expect(b.s.importDetected).toBe(true);
    expect(b.s.lastTotal).toBe(44_424); // == tokens_used, but every token field is 0
    // two total-only counts under external-import-turn-6 / -12: 28,513 → baseline; 44,424 − 28,513 = 15,911 enters the
    // RAW counter derivation (non-billable total-only growth) while nothing is emitted; 28,513 + 15,911 = 44,424
    expect(b.s).toMatchObject({
      tokenCountEvents: 2, firstEventBeforeOwnTurn: true, baselineTotal: 28_513, baselineBillable: 0,
      ownTotalDerived: 15_911, ownBillableEmitted: 0, resets: 0, fieldDecreases: 0, records: 0,
    });
    expect(b.s.baselineTotal + b.s.ownTotalDerived).toBe(b.s.lastTotal);
  });

  it('frozen-timestamp guardian-type subagent (01a03586): 7,209,421; no event on the frozen creation day', async () => {
    const r = await parse('frozen-subagent-01a03586.jsonl');
    // 1,285,247,912 − 1,278,038,491 = 7,209,421 (first snapshot before own turn; no resets, no replay events)
    expect(r.billable).toBe(7_209_421);
    expect(r.fields).toEqual({ input: 7_204_564, cached: 6_795_520, cacheWrite: 0, output: 4_857, reasoning: 1_672 });
    expect(r.s.baselineTotal).toBe(1_278_038_491);
    expect(r.s.ownTotalDerived).toBe(7_209_421); // first_last 84,250 NOT added (verifier: rule (d) overcount)
    expect(r.usage).toHaveLength(55);
    const frozenLineTs = Date.parse('2026-08-24T20:46:24.849Z');
    expect(r.usage.every((u) => u.tsSource === 'turn' && u.ts !== frozenLineTs)).toBe(true);
    // turns really ran from 2026-08-27T17:25:14Z (started_at 1787851514)
    expect(Math.min(...r.usage.map((u) => u.ts))).toBe(1_787_851_514_000);
    expect(r.usage.every((u) => u.model === 'codex-auto-review' && u.effort === 'low')).toBe(true);
  });

  it('plain root, no anomalies (01a0c559): own == tokens_used == Σ records == 50,280', async () => {
    const r = await parse('plain-root-01a0c559.jsonl');
    expect(r.billable).toBe(50_280);
    expect(r.s.ownTotalDerived).toBe(50_280);
    expect(r.s.lastTotal).toBe(50_280);
    expect(r.fields).toEqual({ input: 50_152, cached: 14_080, cacheWrite: 0, output: 128, reasoning: 41 });
    expect(r.s.resets + r.s.baselineTotal + r.s.recordMismatches).toBe(0);
    expect(r.usage.every((u) => u.tsSource === 'record')).toBe(true);
  });

  it('compaction response recorded but not in the counter (01a0d73e): records win, +243,193', async () => {
    const r = await parse('root-compaction-record-01a0d73e.jsonl');
    expect(r.s.ownTotalDerived).toBe(9_865_508); // == tokens_used
    expect(r.billable).toBe(10_108_701); // Σ 76 unique records
    expect(r.billable - r.s.ownTotalDerived).toBe(243_193);
    expect(r.s.recordMismatches).toBe(1);
    expect(r.fields).toEqual({ input: 10_054_156, cached: 9_708_544, cacheWrite: 0, output: 54_545, reasoning: 11_860 });
  });

  it('priced through toUsageEvent (stub rates, hand-computed) for 01a08127', async () => {
    const r = await parse('root-reset-01a08127.jsonl');
    const ctx = makeCtx(new MemoryStore());
    const evs = r.usage.map((u) => toUsageEvent(u, r.state.meta, ctx));
    const sum = (f: (e: (typeof evs)[number]) => number) => evs.reduce((a, e) => a + f(e), 0);
    // inputFresh = 1,814,001 − 1,738,496 = 75,505 (no component has cached > input)
    expect(sum((e) => e.tokens.inputFresh)).toBe(75_505);
    expect(sum((e) => e.tokens.cacheRead)).toBe(1_738_496);
    expect(sum((e) => e.tokens.output)).toBe(9_003);
    // $ = (75,505×2 + 1,738,496×0.2 + 9,003×10)/1e6 = (151,010 + 347,699.2 + 90,030)/1e6 = 0.5887392
    expect(sum((e) => e.apiEquivUsd ?? NaN)).toBeCloseTo(0.5887392, 9);
    // Stub valuation-seam value (fresh input + cache writes + output, 1000 tokens per unit) = (75,505 + 9,003)/1000 = 84.508
    expect(sum((e) => e.reservedValue ?? NaN)).toBeCloseTo(84.508, 9);
    expect(evs.every((e) => e.provider === 'openai' && e.source === 'codex' && !e.isSubagent)).toBe(true);
  });

  it('Σ tokens_used over these threads is NOT usage (it is 56× the true own usage here)', async () => {
    const tokensUsed = 299_371 + 90_201_025 + 8_787_895 + 0 + 44_424 + 1_285_247_912 + 50_280 + 9_865_508;
    let own = 0;
    for (const f of fs.readdirSync(FIXTURES).filter((n) => !n.startsWith('m4a-'))) own += (await parse(f)).billable;
    // 1,823,004 + 5,104,534 + 440,528 + 0 + 0 + 7,209,421 + 50,280 + 10,108,701 = 24,736,468
    expect(own).toBe(24_736_468);
    expect(tokensUsed).toBe(1_394_496_415);
    expect(own).not.toBe(tokensUsed);
  });
});

/**
 * §15.10.1 — the active turn is the INNERMOST OPEN turn. Hand-computed from the sanitized fixture lines (independent
 * Python walk, 2026-09-27): every token_count delta equals its own last_token_usage.total_tokens, so
 *   01a00057: 8 deltas, Σ = 8,552,512 − 7,842,869 = 709,643; the one inside the `rollout-2` wrapper is 81,580.
 *   01a000e9: 15 deltas, Σ = 21,611,305 − 19,654,579 = 1,956,726; the one inside the wrapper is 89,574.
 * Field sums (own = last − first snapshot): see the expectations below.
 */
describe('M4a guardian auto-review fixtures — nested own turn inside a rollout-N wrapper (§15.10.1)', () => {
  async function parseM4a(name: string) {
    const res = await parseRolloutFile(path.join(FIXTURES, name), { host: 'fixture-host' });
    const f = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    let total = 0;
    for (const u of res.usage) for (const c of u.components) {
      f.input += c.raw.input; f.cached += c.raw.cached; f.cacheWrite += c.raw.cacheWrite;
      f.output += c.raw.output; f.reasoning += c.raw.reasoning; total += c.raw.total;
    }
    return { ...res, fields: f, total, s: res.state.summary };
  }

  /**
   * MUTANT oracle: the literal reading "any token_count while a `rollout-N` turn is open contributes 0".
   * Independent of the collector; the fixtures must discriminate it from the real rule.
   */
  function literalRolloutNRule(name: string): number {
    let open: string[] = [];
    let prev: number | null = null;
    let own = 0;
    for (const line of fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n')) {
      if (!line) continue;
      const o = JSON.parse(line) as { type: string; payload: Record<string, any> };
      const p = o.payload;
      if (p.type === 'task_started') open.push(p.turn_id);
      else if (p.type === 'task_complete' && open.includes(p.turn_id)) open = open.slice(0, open.indexOf(p.turn_id));
      else if (o.type === 'turn_context' && !open.includes(p.turn_id)) open.push(p.turn_id);
      else if (p.type === 'token_count' && p.info) {
        const t = p.info.total_token_usage.total_tokens as number;
        if (prev !== null && !open.some((x) => /^rollout-\d+$/.test(x))) own += t - prev;
        prev = t;
      }
    }
    return own;
  }

  it('01a00057: own usage 709,643 total tokens (= tokens_used 8,552,512 − first snapshot 7,842,869)', async () => {
    const r = await parseM4a('m4a-auto-review-01a00057.jsonl');
    expect(r.total).toBe(709_643);
    expect(r.s.ownTotalDerived).toBe(709_643);
    expect(r.fields).toEqual({ input: 708_819, cached: 354_304, cacheWrite: 0, output: 824, reasoning: 384 });
    expect(r.s.baselineTotal).toBe(7_842_869);
    expect(r.s.firstEventBeforeOwnTurn).toBe(true);
    expect(r.s.lastTotal).toBe(8_552_512); // == state_5.threads.tokens_used on M4a
    expect(r.usage).toHaveLength(8);
    // the nested own turn inside the rollout-2 wrapper: doctor-visible
    expect(r.s.ownInWrapperEvents).toBe(1);
    expect(r.s.ownInWrapperTotal).toBe(81_580);
    expect(r.s.replayEvents + r.s.olderTurnEvents).toBe(0);
    const nested = r.usage.find((u) => u.key === 14)!;
    expect(nested.turnId).toBe('01a000ca-6aaf-7f02-aec5-3036204f5e86');
    expect(nested.components[0]!.raw.total).toBe(81_580);
    // frozen guardian file: the nested turn's time comes from its task_complete.started_at (1786719660)
    expect([nested.tsSource, nested.ts]).toEqual(['turn', 1_786_719_660_000]);
    expect(r.usage.every((u) => u.model === 'codex-auto-review')).toBe(true);
  });

  it('01a000e9: own usage 1,956,726 total tokens (= tokens_used 21,611,305 − first snapshot 19,654,579)', async () => {
    const r = await parseM4a('m4a-auto-review-01a000e9.jsonl');
    expect(r.total).toBe(1_956_726);
    expect(r.s.ownTotalDerived).toBe(1_956_726);
    expect(r.fields).toEqual({ input: 1_955_254, cached: 1_272_064, cacheWrite: 0, output: 1_472, reasoning: 600 });
    expect(r.s.baselineTotal).toBe(19_654_579);
    expect(r.s.lastTotal).toBe(21_611_305);
    expect(r.usage).toHaveLength(15);
    expect(r.s.ownInWrapperEvents).toBe(1);
    expect(r.s.ownInWrapperTotal).toBe(89_574);
  });

  it('MUTATION: the literal "rollout-N ⇒ 0" rule gives different numbers on these fixtures (so it would fail above)', async () => {
    // 709,643 − 81,580 = 628,063 ; 1,956,726 − 89,574 = 1,867,152
    expect(literalRolloutNRule('m4a-auto-review-01a00057.jsonl')).toBe(628_063);
    expect(literalRolloutNRule('m4a-auto-review-01a000e9.jsonl')).toBe(1_867_152);
    expect((await parseM4a('m4a-auto-review-01a00057.jsonl')).total).not.toBe(628_063);
    expect((await parseM4a('m4a-auto-review-01a000e9.jsonl')).total).not.toBe(1_867_152);
  });
});
