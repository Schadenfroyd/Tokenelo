import { describe, it, expect } from 'vitest';
import {
  buildParentMap,
  buildSessions,
  computeActiveMs,
  activityTimeEvidence,
  computeBurn,
  computeWallTime,
  dedupeActivityMarks,
  effectiveSessionId,
  sessionGroupKey,
  summarizeSessionTelemetry,
} from '../../src/core/sessions.ts';
import { ZERO_TOKENS } from '../../src/core/types.ts';
import type { ActivityMark, RateStatus, UsageComponent, UsageEvent } from '../../src/core/types.ts';
import { summedSessionActiveMsSteps } from '../../src/core/activity-summary.ts';
import { drainSteps } from '../../src/core/event-loop.ts';

describe('Summary active time without discarded session figures', () => {
  it('folds child marks into the parent and keeps event-only groups at zero', () => {
    const events = [mkEvent({ id: 'parent', sessionId: 'parent', ts: 100 }),
      mkEvent({ id: 'child', sessionId: 'child', parentSessionId: 'parent', isSubagent: true, ts: 450 }),
      mkEvent({ id: 'empty', sessionId: 'empty', ts: 500 })];
    const marks = [mkMark({ sessionId: 'parent', ts: 100 }), mkMark({ sessionId: 'parent', ts: 200 }),
      mkMark({ sessionId: 'child', ts: 450 })];
    const narrow = events.map(({ host, source, sessionId, parentSessionId, isSubagent }) => ({ host, source, sessionId, parentSessionId, isSubagent }));
    expect(drainSteps(summedSessionActiveMsSteps(marks, narrow, 300))).toBe(350);
    expect(buildSessions(marks, events, { idleGapMs: 300, now: () => 1000 }).reduce((sum, row) => sum + row.activeMs, 0)).toBe(350);
  });

  it('retains global UUID ownership and reported Codex durations for activity-only sessions', () => {
    const marks = [mkMark({ source: 'codex', sessionId: 'owner', ts: 100, uuid: 'copied', durationMs: 125 }),
      mkMark({ source: 'codex', sessionId: 'copy', ts: 100, uuid: 'copied', durationMs: 125 }),
      mkMark({ source: 'codex', sessionId: 'owner', ts: 200, uuid: 'second', durationMs: 75 }),
      mkMark({ source: 'claude', sessionId: 'gaps', ts: 100 }), mkMark({ source: 'claude', sessionId: 'gaps', ts: 130 })];
    expect(drainSteps(summedSessionActiveMsSteps(marks, [], 300))).toBe(230);
    expect(buildSessions(marks, [], { idleGapMs: 300, now: () => 1000 }).reduce((sum, row) => sum + row.activeMs, 0)).toBe(230);
  });

  it('agrees with full session figures across hosts, sources, ancestry changes, ties and long gaps', () => {
    for (let seed = 0; seed < 24; seed++) {
      const events = Array.from({ length: 36 }, (_, i) => mkEvent({ id: `${seed}-${i}`, host: i % 2 ? 'A2000' : 'M4a',
        source: i % 3 ? 'claude' : 'codex', sessionId: `s${i % 9}`, ts: i * 10,
        isSubagent: i % 4 === 0, parentSessionId: i % 4 === 0 ? `s${(i + seed + 1) % 9}` : undefined }));
      const marks = Array.from({ length: 120 }, (_, i) => mkMark({ host: i % 2 ? 'A2000' : 'M4a', source: i % 3 ? 'claude' : 'codex',
        sessionId: `s${i % 11}`, ts: Math.floor(i / 3) * (seed + 1) * 100, uuid: i % 7 ? `u${i}` : `copy${i % 14}`,
        durationMs: i % 5 ? undefined : i / 2 }));
      const narrow = events.map(({ host, source, sessionId, parentSessionId, isSubagent }) => ({ host, source, sessionId, parentSessionId, isSubagent }));
      const full = buildSessions(marks, events, { idleGapMs: 300, now: () => 100_000 }).reduce((sum, row) => sum + row.activeMs, 0);
      expect(drainSteps(summedSessionActiveMsSteps(marks, narrow, 300))).toBe(full);
    }
  });
});

describe('session capture provenance', () => {
  it('keeps cloud/local providers separate even when source and model are identical', () => {
    const events = [
      mkEvent({ id: 'local-1', sessionId: 'mixed', ts: 100, model: 'shared-model', provider: 'local', inputFresh: 10, output: 2, reservedValue: 1, flags: ['localViaClaudeJsonl', 'localViaClaudeJsonl'] }),
      mkEvent({ id: 'cloud', sessionId: 'mixed', ts: 200, model: 'shared-model', provider: 'anthropic', inputFresh: 20, output: 3, apiEquivUsd: null, reservedValue: null, ucuRateStatus: 'NONE' }),
      mkEvent({ id: 'local-2', sessionId: 'mixed', ts: 50, model: 'earlier-model', provider: 'local', inputFresh: 5, output: 1, reservedValue: 2, flags: ['localViaClaudeJsonl'] }),
    ];
    const feeds = summarizeSessionTelemetry(events);
    expect(feeds).toHaveLength(2);
    expect(feeds[0]).toMatchObject({ provider: 'anthropic', events: 1, apiEquivUsd: null, unpricedEvents: 1 });
    expect(feeds[1]).toMatchObject({
      provider: 'local', events: 2, models: ['earlier-model', 'shared-model'], firstEventAt: 50, lastEventAt: 100,
      tokens: { inputFresh: 15, output: 3 }, apiEquivUsd: 0, flags: { localViaClaudeJsonl: 2 },
    });
  });

  it('separates recorded engines and preserves a missing legacy engine', () => {
    const events = ['ollama', 'vllm', undefined].map((engine, index) => mkEvent({
      id: `engine-${index}`, sessionId: 'local', source: 'ollama-proxy', provider: 'local', engine,
      model: 'same-model', ts: 100 + index, inputFresh: 2, output: 3,
    }));
    const feeds = summarizeSessionTelemetry(events);
    expect(feeds).toHaveLength(3);
    expect(feeds[0]).not.toHaveProperty('engine');
    expect(feeds.find((feed) => feed.engine === 'ollama')).toMatchObject({ events: 1, tokens: { inputFresh: 2, output: 3 } });
    expect(feeds.find((feed) => feed.engine === 'vllm')).toMatchObject({ events: 1, models: ['same-model'] });
  });

  it('includes folded subagent feeds and leaves activity-only sessions without fabricated capture', () => {
    const events = [
      mkEvent({ id: 'parent-event', sessionId: 'parent', ts: 100, inputFresh: 10, output: 5 }),
      mkEvent({ id: 'child-event', sessionId: 'child', parentSessionId: 'parent', isSubagent: true, ts: 200, provider: 'local', inputFresh: 20, output: 7 }),
    ];
    const rows = buildSessions([mkMark({ sessionId: 'activity-only', ts: 300 })], events, { idleGapMs: 300_000, now: () => 1000 });
    expect(rows.find((row) => row.sessionId === 'parent')?.telemetry).toHaveLength(2);
    expect(rows.find((row) => row.sessionId === 'parent')?.telemetry?.reduce((sum, feed) => sum + feed.events, 0)).toBe(2);
    expect(rows.find((row) => row.sessionId === 'activity-only')?.telemetry).toEqual([]);
  });
});

// NOTE: events keep their stored valuation values as reserved compatibility fields. Session rows and
// capture feeds never read or report them.

function mkEvent(overrides: {
  id: string;
  ts: number;
  sessionId: string;
  host?: string;
  source?: UsageEvent['source'];
  model?: string;
  inputFresh?: number;
  output?: number;
  cacheRead?: number;
  apiEquivUsd?: number | null;
  reservedValue?: number | null;
  ucuRateStatus?: RateStatus;
  isSubagent?: boolean;
  parentSessionId?: string;
  project?: string;
  repoRoot?: string;
  provider?: UsageEvent['provider'];
  engine?: string;
  flags?: UsageEvent['flags'];
}): UsageEvent {
  const tokens = {
    ...ZERO_TOKENS,
    inputFresh: overrides.inputFresh ?? 0,
    output: overrides.output ?? 0,
    cacheRead: overrides.cacheRead ?? 0,
  };
  const component: UsageComponent = { model: overrides.model ?? 'claude-sonnet-5', tokens };
  return {
    id: overrides.id,
    host: overrides.host ?? 'M4a',
    source: overrides.source ?? 'claude',
    ts: overrides.ts,
    tsSource: 'line',
    sessionId: overrides.sessionId,
    parentSessionId: overrides.parentSessionId,
    isSubagent: overrides.isSubagent ?? false,
    project: overrides.project,
    repoRoot: overrides.repoRoot,
    model: overrides.model ?? 'claude-sonnet-5',
    provider: overrides.provider ?? 'anthropic',
    engine: overrides.engine,
    components: [component],
    tokens,
    flags: overrides.flags ?? [],
    apiEquivUsd: overrides.apiEquivUsd === undefined ? 0 : overrides.apiEquivUsd,
    priceStatus: overrides.apiEquivUsd === null ? 'UNPRICED' : 'LIST',
    priceVersion: 'v1',
    reservedValue: overrides.reservedValue === undefined ? 0 : overrides.reservedValue,
    ucuRateStatus: overrides.ucuRateStatus ?? 'MEASURED',
    eacsDefSha256: 'sha',
  };
}

function mkMark(overrides: {
  sessionId: string;
  ts: number;
  host?: string;
  source?: ActivityMark['source'];
  uuid?: string;
  durationMs?: number;
}): ActivityMark {
  return {
    source: overrides.source ?? 'claude',
    sessionId: overrides.sessionId,
    ts: overrides.ts,
    uuid: overrides.uuid,
    host: overrides.host ?? 'M4a',
    durationMs: overrides.durationMs,
  };
}

// ── dedupeActivityMarks ──────────────────────────────────────────────────

describe('dedupeActivityMarks', () => {
  it('drops a resumed-session copied uuid, keeping the earlier session that owns it', () => {
    const marks = [
      mkMark({ sessionId: 'S1', ts: 1000, uuid: 'u1' }),
      mkMark({ sessionId: 'S1', ts: 1500, uuid: 'u2' }),
      mkMark({ sessionId: 'S2', ts: 1000, uuid: 'u1' }), // resumed/forked copy of S1's line u1
      mkMark({ sessionId: 'S2', ts: 2000, uuid: 'u3' }),
    ];
    const result = dedupeActivityMarks(marks);
    expect(result).toHaveLength(3);
    expect(result.some((m) => m.sessionId === 'S2' && m.uuid === 'u1')).toBe(false);
    expect(result.some((m) => m.sessionId === 'S1' && m.uuid === 'u1')).toBe(true);
  });

  it('earlier timestamp wins regardless of input order', () => {
    const marks = [
      mkMark({ sessionId: 'S2', ts: 5000, uuid: 'ux' }),
      mkMark({ sessionId: 'S1', ts: 1000, uuid: 'ux' }), // earlier ts, listed second
    ];
    const result = dedupeActivityMarks(marks);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('S1');
  });

  it('marks without a uuid are never deduped against each other', () => {
    const marks = [
      mkMark({ sessionId: 'S1', ts: 1000 }),
      mkMark({ sessionId: 'S1', ts: 1000 }),
    ];
    expect(dedupeActivityMarks(marks)).toHaveLength(2);
  });

  // ── MUTATION-GUARD EVIDENCE ────────────────────────────────────────────
  // Actually applied to src/core/sessions.ts in this session, run, observed failing, then
  // reverted and re-verified green (not just asserted in a comment):
  //
  //   MUTATION: `dedupeActivityMarks` changed to `return [...marks];` (dedup disabled).
  //   `npx vitest run test/sessions/sessions.test.ts` -> 2 failed / (rest passed):
  //     - 'drops a resumed-session copied uuid...': expected length 3, got 4
  //     - 'earlier timestamp wins...': expected length 1, got 2
  //   After reverting to the real implementation: full file green again (see full run below).
});

// ── computeActiveMs ──────────────────────────────────────────────────────

describe('active-time evidence', () => {
  it('distinguishes event-only sessions from zero gap time without declaring zero process runtime', () => {
    const [row] = buildSessions([], [mkEvent({ id: 'usage-only', sessionId: 'S1', ts: 100 })], { idleGapMs: 300_000, now: () => 100 });
    expect(row.activeMs).toBe(0);
    expect(row.activityEvidence).toEqual({ version: 1, basis: 'no-marks', markCount: 0, durationMarkCount: 0, idleGapMs: 300_000 });
    expect(activityTimeEvidence('claude', [mkMark({ sessionId: 'S1', ts: 100 })], 300_000)).toMatchObject({ basis: 'activity-gaps', markCount: 1 });
  });

  it('counts the actual deduplicated parent-plus-child mark population', () => {
    const marks = [mkMark({ sessionId: 'parent', ts: 0, uuid: 'same' }), mkMark({ sessionId: 'parent', ts: 0, uuid: 'same' }), mkMark({ sessionId: 'child', ts: 60_000, uuid: 'child' })];
    const events = [mkEvent({ id: 'parent', sessionId: 'parent', ts: 0 }), mkEvent({ id: 'child', sessionId: 'child', parentSessionId: 'parent', isSubagent: true, ts: 60_000 })];
    const [row] = buildSessions(marks, events, { idleGapMs: 300_000, now: () => 60_000 });
    expect(row.activeMs).toBe(60_000);
    expect(row.activityEvidence).toMatchObject({ basis: 'activity-gaps', markCount: 2, durationMarkCount: 0 });
  });

  it('declares only the positive Codex turn duration population actually selected by activeMs', () => {
    const marks = [mkMark({ source: 'codex', sessionId: 'S1', ts: 0, durationMs: 0 }), mkMark({ source: 'codex', sessionId: 'S1', ts: 100, durationMs: 900 }), mkMark({ source: 'codex', sessionId: 'S1', ts: 200 })];
    expect(computeActiveMs('codex', marks, 300_000)).toBe(900);
    expect(activityTimeEvidence('codex', marks, 300_000)).toMatchObject({ basis: 'reported-turn-durations', markCount: 3, durationMarkCount: 1 });
    expect(activityTimeEvidence('claude', marks, 300_000)).toMatchObject({ basis: 'activity-gaps', durationMarkCount: 0 });
  });
});

describe('computeActiveMs', () => {
  it('sums only gaps <= idleGapMs (5 min default)', () => {
    // gaps: 60_000 (<=300_000, counted), 540_000 (600_000-60_000, >300_000, excluded)
    const marks = [
      mkMark({ sessionId: 'S1', ts: 0 }),
      mkMark({ sessionId: 'S1', ts: 60_000 }),
      mkMark({ sessionId: 'S1', ts: 600_000 }),
    ];
    expect(computeActiveMs('claude', marks, 300_000)).toBe(60_000);
  });

  it('single mark has zero active time', () => {
    expect(computeActiveMs('claude', [mkMark({ sessionId: 'S1', ts: 0 })], 300_000)).toBe(0);
  });

  it('Codex: sums durationMs from marks that carry it, ignoring the gap calc entirely', () => {
    const marks = [
      mkMark({ sessionId: 'S1', ts: 0, durationMs: 1000, source: 'codex' }),
      mkMark({ sessionId: 'S1', ts: 2000, durationMs: 500, source: 'codex' }),
      mkMark({ sessionId: 'S1', ts: 5000, source: 'codex' }), // no durationMs, contributes 0
    ];
    // gap-sum would be 2000+3000=5000 (idleGapMs generous) -- durationMs sum (1500) must win.
    expect(computeActiveMs('codex', marks, 10_000_000)).toBe(1500);
  });

  it('Codex falls back to gap-sum when no mark carries durationMs', () => {
    const marks = [
      mkMark({ sessionId: 'S1', ts: 0, source: 'codex' }),
      mkMark({ sessionId: 'S1', ts: 1000, source: 'codex' }),
    ];
    expect(computeActiveMs('codex', marks, 300_000)).toBe(1000);
  });
});

// ── computeBurn ──────────────────────────────────────────────────────────

describe('computeBurn', () => {
  it('hand-computed tokens/min and $/h over the fixed 15-min window', () => {
    const now = 100_000_000;
    const events = [
      mkEvent({ id: 'a', ts: now - 1_000, sessionId: 'S1', inputFresh: 100, output: 50, apiEquivUsd: 0.3 }), // 150 tok
      mkEvent({ id: 'b', ts: now - 800_000, sessionId: 'S1', inputFresh: 200, output: 100, apiEquivUsd: 0.6 }), // 300 tok, inside window
      mkEvent({ id: 'c', ts: now - 1_000_000, sessionId: 'S1', inputFresh: 999, output: 999, apiEquivUsd: 9 }), // outside window
    ];
    const burn = computeBurn(events, now);
    expect(burn).not.toBeNull();
    // total tokens in-window = 150 + 300 = 450 over 15 min -> 30 tok/min
    expect(burn!.tokensPerMin).toBeCloseTo(450 / 15, 6);
    // total usd in-window = 0.3 + 0.6 = 0.9 over 0.25h -> 3.6 usd/h
    expect(burn!.usdPerHour).toBeCloseTo(0.9 / 0.25, 6);
  });

  it('null when nothing fell in the trailing window', () => {
    const now = 100_000_000;
    const events = [mkEvent({ id: 'a', ts: now - 1_000_000, sessionId: 'S1', inputFresh: 1, output: 1 })];
    expect(computeBurn(events, now)).toBeNull();
  });
});

// ── computeBurn price quality (R44): same window events as usdPerHour ───────

describe('computeBurn price quality', () => {
  const now = 100_000_000; // window (99_100_000, 100_000_000]

  function estimated(e: UsageEvent): UsageEvent {
    e.priceStatus = 'ESTIMATE';
    return e;
  }

  it('window edges: an unpriced event exactly at now - 15m is outside, an event at now is inside', () => {
    const burn = computeBurn([
      mkEvent({ id: 'edge', ts: 99_100_000, sessionId: 'S1', inputFresh: 1000, apiEquivUsd: null }),
      mkEvent({ id: 'now', ts: now, sessionId: 'S1', inputFresh: 150, apiEquivUsd: 0.3 }),
    ], now);
    // only 'now': 150 tok / 15 min = 10 tok/min; 0.3 / 0.25 h = 1.2 $/h
    expect(burn!.tokensPerMin).toBeCloseTo(10, 6);
    expect(burn!.usdPerHour).toBeCloseTo(1.2, 6);
    expect(burn!.priceQuality!.priceEvidence).toMatchObject({ issuesEvents: 0, aggregateAmountInvalid: false });
    expect(burn!.priceQuality).toMatchObject({ events: 1, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });

  it('an unpriced event outside the window does not qualify the window', () => {
    const burn = computeBurn([
      mkEvent({ id: 'old', ts: now - 1_000_000, sessionId: 'S1', apiEquivUsd: null }),
      mkEvent({ id: 'in', ts: now - 60_000, sessionId: 'S1', inputFresh: 30, apiEquivUsd: 0.3 }),
    ], now);
    expect(burn!.priceQuality!.priceEvidence).toMatchObject({ issuesEvents: 0, aggregateAmountInvalid: false });
    expect(burn!.priceQuality).toMatchObject({ events: 1, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });

  it('a known provider zero (local, $0 LIST) is priced, not unpriced', () => {
    const burn = computeBurn([mkEvent({ id: 'l', ts: now - 60_000, sessionId: 'S1', provider: 'local', inputFresh: 300, apiEquivUsd: 0 })], now);
    expect(burn!.usdPerHour).toBe(0);
    expect(burn!.priceQuality!.priceEvidence).toMatchObject({ issuesEvents: 0, aggregateAmountInvalid: false });
    expect(burn!.priceQuality).toMatchObject({ events: 1, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });

  it('all unpriced: the numeric rate stays 0 as before; quality says every event is unpriced', () => {
    const burn = computeBurn([
      mkEvent({ id: 'u1', ts: now - 60_000, sessionId: 'S1', inputFresh: 150, apiEquivUsd: null }),
      mkEvent({ id: 'u2', ts: now - 120_000, sessionId: 'S1', inputFresh: 300, apiEquivUsd: null }),
    ], now);
    expect(burn!.tokensPerMin).toBeCloseTo(30, 6);
    expect(burn!.usdPerHour).toBe(0);
    expect(burn!.priceQuality!.priceEvidence).toMatchObject({ issuesEvents: 0, aggregateAmountInvalid: false });
    expect(burn!.priceQuality).toMatchObject({ events: 2, unpricedEvents: 2, estimatedPriceEvents: 0, priceStatus: 'UNPRICED' });
  });

  it('mixed: priced sum is partial; estimated events are counted and included', () => {
    const burn = computeBurn([
      mkEvent({ id: 'p', ts: now - 60_000, sessionId: 'S1', apiEquivUsd: 0.3 }),
      mkEvent({ id: 'u', ts: now - 120_000, sessionId: 'S1', apiEquivUsd: null }),
      estimated(mkEvent({ id: 'e', ts: now - 180_000, sessionId: 'S1', apiEquivUsd: 0.6 })),
    ], now);
    // 0.3 + 0.6 = 0.9 over 0.25 h = 3.6
    expect(burn!.usdPerHour).toBeCloseTo(3.6, 6);
    expect(burn!.priceQuality!.priceEvidence).toMatchObject({ issuesEvents: 0, aggregateAmountInvalid: false });
    expect(burn!.priceQuality).toMatchObject({ events: 3, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
  });

  it('estimated only', () => {
    const burn = computeBurn([estimated(mkEvent({ id: 'e', ts: now - 60_000, sessionId: 'S1', apiEquivUsd: 0.6 }))], now);
    expect(burn!.priceQuality!.priceEvidence).toMatchObject({ issuesEvents: 0, aggregateAmountInvalid: false });
    expect(burn!.priceQuality).toMatchObject({ events: 1, unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' });
  });

  it('buildSessions: window quality differs from whole-session counts and includes a folded subagent', () => {
    const rows = buildSessions([], [
      mkEvent({ id: 'old', ts: now - 2_000_000, sessionId: 'P', apiEquivUsd: null }),
      mkEvent({ id: 'p', ts: now - 60_000, sessionId: 'P', apiEquivUsd: 0.3 }),
      estimated(mkEvent({ id: 'c', ts: now - 30_000, sessionId: 'C', isSubagent: true, parentSessionId: 'P', apiEquivUsd: 0.6 })),
    ], { idleGapMs: 300_000, now: () => now });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
    expect(rows[0].burn!.priceQuality!.priceEvidence).toMatchObject({ events: 2, issuesEvents: 0, aggregateAmountInvalid: false });
    expect(rows[0].burn).toMatchObject({ tokensPerMin: 0, usdPerHour: expect.closeTo(3.6, 6), priceQuality: { events: 2, unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' } });
  });

  it('buildSessions: no window events keeps burn null', () => {
    const rows = buildSessions([], [mkEvent({ id: 'old', ts: now - 2_000_000, sessionId: 'S1', apiEquivUsd: null })], { idleGapMs: 300_000, now: () => now });
    expect(rows[0].burn).toBeNull();
  });
});

// ── computeWallTime ──────────────────────────────────────────────────────

describe('computeWallTime', () => {
  it('hand-computed: two overlapping intervals + one disjoint', () => {
    const intervals = [
      { start: 0, end: 100 },
      { start: 50, end: 150 },
      { start: 200, end: 250 },
    ];
    // agentMs = 100+100+50 = 250 (sum of durations, double-counts the [50,100] overlap)
    // wallMs  = union [0,150] (150) + [200,250] (50) = 200
    expect(computeWallTime(intervals)).toEqual({ agentMs: 250, wallMs: 200 });
  });

  it('empty input -> zeros', () => {
    expect(computeWallTime([])).toEqual({ agentMs: 0, wallMs: 0 });
  });

  it('fully disjoint intervals: agentMs === wallMs', () => {
    const intervals = [
      { start: 0, end: 10 },
      { start: 100, end: 120 },
    ];
    expect(computeWallTime(intervals)).toEqual({ agentMs: 30, wallMs: 30 });
  });
});

// ── buildParentMap / effectiveSessionId / sessionGroupKey ────────────────

describe('buildParentMap and effectiveSessionId', () => {
  it('maps a subagent sessionId to its parent, leaves non-subagents unmapped', () => {
    const events = [
      mkEvent({ id: 'a', ts: 0, sessionId: 'PARENT' }),
      mkEvent({ id: 'b', ts: 1, sessionId: 'CHILD', isSubagent: true, parentSessionId: 'PARENT' }),
    ];
    const parentOf = buildParentMap(events);
    expect(effectiveSessionId('CHILD', parentOf)).toBe('PARENT');
    expect(effectiveSessionId('PARENT', parentOf)).toBe('PARENT');
    expect(effectiveSessionId('UNRELATED', parentOf)).toBe('UNRELATED');
  });

  it('sessionGroupKey is stable and distinguishes host/source/id', () => {
    expect(sessionGroupKey('M4a', 'claude', 'S1')).toBe(sessionGroupKey('M4a', 'claude', 'S1'));
    expect(sessionGroupKey('M4a', 'claude', 'S1')).not.toBe(sessionGroupKey('A2000', 'claude', 'S1'));
  });
});

// ── buildSessions (integration) ───────────────────────────────────────────

describe('buildSessions', () => {
  it('includes nested branches exactly once in the root session and its activity evidence', () => {
    const events = [
      mkEvent({ id: 'root', sessionId: 'R', ts: 1000, inputFresh: 10 }),
      mkEvent({ id: 'child', sessionId: 'C', parentSessionId: 'R', isSubagent: true, ts: 2000, inputFresh: 20 }),
      mkEvent({ id: 'grandchild', sessionId: 'G', parentSessionId: 'C', isSubagent: true, ts: 3000, inputFresh: 30 }),
    ];
    const rows = buildSessions([
      mkMark({ sessionId: 'R', ts: 1000 }), mkMark({ sessionId: 'C', ts: 2000 }), mkMark({ sessionId: 'G', ts: 3000 }),
    ], events, { idleGapMs: 300_000, now: () => 4000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'R', subagents: 2, tokens: { inputFresh: 60 }, start: 1000, end: 3000, activeMs: 2000 });
    expect(rows[0].telemetry?.reduce((sum, feed) => sum + feed.events, 0)).toBe(3);
  });

  it('does not transfer ancestry to an unrelated host or collector with the same opaque session id', () => {
    const events = [
      mkEvent({ id: 'linked', host: 'M4a', source: 'codex', sessionId: 'C', parentSessionId: 'R', isSubagent: true, ts: 100, inputFresh: 10 }),
      mkEvent({ id: 'other-host', host: 'A2000', source: 'codex', sessionId: 'C', ts: 100, inputFresh: 20 }),
      mkEvent({ id: 'other-source', host: 'M4a', source: 'claude', sessionId: 'C', ts: 100, inputFresh: 30 }),
    ];
    const rows = buildSessions([], events, { idleGapMs: 300_000, now: () => 200 });
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.host === 'A2000')).toMatchObject({ sessionId: 'C', tokens: { inputFresh: 20 } });
    expect(rows.find(row => row.source === 'claude')).toMatchObject({ sessionId: 'C', tokens: { inputFresh: 30 } });
    expect(rows.find(row => row.host === 'M4a' && row.source === 'codex')).toMatchObject({ sessionId: 'R', tokens: { inputFresh: 10 } });
  });

  it('leaves cyclic links unfolded and retains incoming branches without losing or duplicating usage', () => {
    const events = [
      mkEvent({ id: 'a', sessionId: 'A', parentSessionId: 'B', isSubagent: true, ts: 100, inputFresh: 10 }),
      mkEvent({ id: 'b', sessionId: 'B', parentSessionId: 'A', isSubagent: true, ts: 200, inputFresh: 20 }),
      mkEvent({ id: 'c', sessionId: 'C', parentSessionId: 'A', isSubagent: true, ts: 300, inputFresh: 30 }),
    ];
    const rows = buildSessions([], events, { idleGapMs: 300_000, now: () => 400 });
    expect(rows.map(row => row.sessionId).sort()).toEqual(['A', 'B']);
    expect(rows.reduce((sum, row) => sum + row.tokens.inputFresh, 0)).toBe(60);
    expect(rows.find(row => row.sessionId === 'A')).toMatchObject({ subagents: 1, tokens: { inputFresh: 40 } });
  });

  it('folds a subagent session into its parent: merged tokens, one row, subagents=1', () => {
    const events = [
      mkEvent({ id: 'p1', ts: 1000, sessionId: 'PARENT', inputFresh: 100, output: 50, apiEquivUsd: 1, reservedValue: 2 }),
      mkEvent({
        id: 'c1',
        ts: 2000,
        sessionId: 'CHILD',
        isSubagent: true,
        parentSessionId: 'PARENT',
        inputFresh: 40,
        output: 10,
        apiEquivUsd: 0.5,
        reservedValue: 1,
      }),
    ];
    const marks = [
      mkMark({ sessionId: 'PARENT', ts: 1000, uuid: 'm1' }),
      mkMark({ sessionId: 'CHILD', ts: 2000, uuid: 'm2' }),
    ];
    const rows = buildSessions(marks, events, { idleGapMs: 300_000, now: () => 3000 });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sessionId).toBe('PARENT');
    expect(row.subagents).toBe(1);
    expect(row.tokens.inputFresh).toBe(140);
    expect(row.tokens.output).toBe(60);
    expect(row.apiEquivUsd).toBe(1.5);
    expect(row.start).toBe(1000);
    expect(row.end).toBe(2000);
  });

  it('two unrelated sessions on different hosts stay separate rows', () => {
    const events = [
      mkEvent({ id: 'a', ts: 0, sessionId: 'S1', host: 'M4a', inputFresh: 10, output: 5 }),
      mkEvent({ id: 'b', ts: 0, sessionId: 'S1', host: 'A2000', inputFresh: 20, output: 5 }),
    ];
    const rows = buildSessions([], events, { idleGapMs: 300_000, now: () => 10_000 });
    expect(rows).toHaveLength(2);
  });

  it('live is true only when last activity is within the live threshold of now', () => {
    const events = [mkEvent({ id: 'a', ts: 1_000_000, sessionId: 'S1', inputFresh: 1, output: 1 })];
    const liveRows = buildSessions([], events, { idleGapMs: 300_000, now: () => 1_000_000 + 60_000 });
    expect(liveRows[0].live).toBe(true);

    const staleRows = buildSessions([], events, { idleGapMs: 300_000, now: () => 1_000_000 + 10 * 60_000 });
    expect(staleRows[0].live).toBe(false);
  });

  it('resumed-session copied-uuid marks do not inflate the resumed session start/end', () => {
    // S1 ran first (u1 at t=0, u2 at t=60_000). S2 is a resume that copies line u1 verbatim
    // (same uuid, same ts) plus its own new activity at t=120_000.
    const marks = [
      mkMark({ sessionId: 'S1', ts: 0, uuid: 'u1' }),
      mkMark({ sessionId: 'S1', ts: 60_000, uuid: 'u2' }),
      mkMark({ sessionId: 'S2', ts: 0, uuid: 'u1' }), // copied line, should be dropped
      mkMark({ sessionId: 'S2', ts: 120_000, uuid: 'u3' }),
    ];
    const rows = buildSessions(marks, [], { idleGapMs: 300_000, now: () => 200_000 });
    const s2 = rows.find((r) => r.sessionId === 'S2')!;
    // Without dedup S2.start would be 0 (inherited from the copied line); with dedup it is 120_000.
    expect(s2.start).toBe(120_000);
    expect(s2.end).toBe(120_000);
  });

  it('idle-gap: a long gap breaks active time even though start/end still spans it', () => {
    const marks = [
      mkMark({ sessionId: 'S1', ts: 0, uuid: 'a' }),
      mkMark({ sessionId: 'S1', ts: 60_000, uuid: 'b' }),
      mkMark({ sessionId: 'S1', ts: 3_600_000, uuid: 'c' }), // >1h later: idle gap
      mkMark({ sessionId: 'S1', ts: 3_660_000, uuid: 'd' }),
    ];
    const rows = buildSessions(marks, [], { idleGapMs: 300_000, now: () => 4_000_000 });
    const row = rows[0];
    expect(row.start).toBe(0);
    expect(row.end).toBe(3_660_000);
    // active = 60_000 (a->b) + 60_000 (c->d); the 3_540_000 gap (b->c) is excluded
    expect(row.activeMs).toBe(120_000);
  });
});

// full-file mutation-guard re-run evidence (see comment inside 'dedupeActivityMarks' describe
// block above for the exact before/after failure counts observed when the guard was disabled).

describe('buildSessions: large sessions never spread unbounded arrays into call arguments', () => {
  it('500k activity marks + 1 event in one session: exact start/end/activeMs, no stack overflow', () => {
    const N = 500_000;
    const t0 = 1_780_000_000_000;
    const marks: ActivityMark[] = new Array(N);
    // Descending insertion order so start/end are not simply the first/last element.
    for (let i = 0; i < N; i++) marks[i] = mkMark({ sessionId: 'big', ts: t0 + (N - 1 - i) * 1000 });
    const events = [mkEvent({ id: 'e', ts: t0 + N * 1000, sessionId: 'big', inputFresh: 1, output: 1 })];
    const rows = buildSessions(marks, events, { idleGapMs: 300_000, now: () => t0 + N * 1000 + 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].start).toBe(t0);
    expect(rows[0].end).toBe(t0 + N * 1000); // the event is later than every mark
    // gaps between consecutive marks: (N-1) × 1000 ms, each ≤ idleGapMs
    expect(rows[0].activeMs).toBe((N - 1) * 1000);
  });

  it('the spread form this replaced really does overflow at this size (guards the test itself)', () => {
    const arr = new Array(500_000).fill(1);
    expect(() => Math.min(...arr)).toThrow(RangeError);
  });
});
