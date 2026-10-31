/**
 * `Queries#getSessionDetail` (GET /v1/sessions/detail?source=&sessionId=, DESIGN §10/§15.7;
 * founder req. 2026-09-27 "session listing should open to more data when clicked"). Same seeding
 * style as test/store/queries.test.ts: hand-inserted rows with already-computed pricing values
 * and stored valuation values (bypassing the real pricing engine), every expected number
 * hand-verified here.
 *
 * The seeded rows keep non-neutral stored valuation values on purpose: the detail never reads or
 * reports them. The detail has no repository
 * attribution section and never inspects a repository; it is built from the ledger alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries as realCreateQueries, chooseSessionBucketMs, type CreateQueriesOpts } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { TokeneloConfig } from '../../src/core/types.js';

const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });
function createQueries(d: TokeneloDb, c: TokeneloConfig, o?: CreateQueriesOpts) {
  return realCreateQueries(d, c, { probeOllama: stubProbe, ...o });
}

interface SeedEvent {
  id: string;
  host?: string;
  source?: string;
  ts: number;
  sessionId: string;
  parentSessionId?: string;
  isSubagent?: boolean;
  model: string;
  provider?: string;
  apiEquivUsd: number | null;
  priceStatus?: 'LIST' | 'ESTIMATE' | 'UNPRICED';
  reservedValue: number | null;
  ucuRateStatus: string;
  inputFresh?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
  output?: number;
  reasoning?: number;
  flags?: string[];
  thinking?: boolean | null;
}

function seedEvent(db: TokeneloDb, e: SeedEvent): void {
  db.prepare(
    `INSERT INTO events (
      id, host, source, ts, ts_source, session_id, parent_session_id, is_subagent,
      model, provider, components_json,
      input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning,
      flags_json, api_equiv_usd, price_status, price_version, ucu, ucu_rate_status, eacs_def_sha256, thinking
    ) VALUES (
      @id, @host, @source, @ts, 'line', @sessionId, @parentSessionId, @isSubagent,
      @model, @provider, @componentsJson,
      @inputFresh, @cacheWrite5m, @cacheWrite1h, @cacheRead, @output, @reasoning,
      @flagsJson, @apiEquivUsd, @priceStatus, 'test-price-v1', @reservedValue, @ucuRateStatus, 'test-def-sha', @thinking
    )`
  ).run({
    id: e.id,
    host: e.host ?? 'M4a',
    source: e.source ?? 'claude',
    ts: e.ts,
    sessionId: e.sessionId,
    parentSessionId: e.parentSessionId ?? null,
    isSubagent: e.isSubagent ? 1 : 0,
    model: e.model,
    provider: e.provider ?? 'anthropic',
    componentsJson: JSON.stringify([{ model: e.model, tokens: { inputFresh: e.inputFresh ?? 0, cacheWrite5m: e.cacheWrite5m ?? 0, cacheWrite1h: e.cacheWrite1h ?? 0, cacheRead: e.cacheRead ?? 0, output: e.output ?? 0, reasoning: e.reasoning ?? 0 } }]),
    inputFresh: e.inputFresh ?? 0,
    cacheWrite5m: e.cacheWrite5m ?? 0,
    cacheWrite1h: e.cacheWrite1h ?? 0,
    cacheRead: e.cacheRead ?? 0,
    output: e.output ?? 0,
    reasoning: e.reasoning ?? 0,
    flagsJson: JSON.stringify(e.flags ?? []),
    apiEquivUsd: e.apiEquivUsd,
    priceStatus: e.priceStatus ?? (e.apiEquivUsd === null ? 'UNPRICED' : 'LIST'),
    reservedValue: e.reservedValue,
    ucuRateStatus: e.ucuRateStatus,
    thinking: e.thinking === undefined || e.thinking === null ? null : e.thinking ? 1 : 0,
  });
}

function seedMark(db: TokeneloDb, m: { source?: string; sessionId: string; ts: number; host?: string; uuid?: string; kind?: string }): void {
  db.prepare(
    `INSERT INTO activity (source, session_id, ts, uuid, host, project, kind, duration_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`
  ).run(m.source ?? 'claude', m.sessionId, m.ts, m.uuid ?? null, m.host ?? 'M4a', m.kind ?? 'assistant');
}

let db: TokeneloDb;
let config: TokeneloConfig;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  db = openDb({ file: ':memory:' });
  config = defaultConfig({ hostLabel: 'M4a' });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('chooseSessionBucketMs', () => {
  it('picks 5-minute buckets for a span <= 2h, hour buckets up to 2 days, day buckets beyond', () => {
    expect(chooseSessionBucketMs(0)).toBe(5 * 60_000);
    expect(chooseSessionBucketMs(2 * 3_600_000)).toBe(5 * 60_000); // exactly at the 2h boundary
    expect(chooseSessionBucketMs(2 * 3_600_000 + 1)).toBe(3_600_000);
    expect(chooseSessionBucketMs(2 * 86_400_000)).toBe(3_600_000); // exactly at the 2-day boundary
    expect(chooseSessionBucketMs(2 * 86_400_000 + 1)).toBe(86_400_000);
  });
});

describe('getSessionDetail: no such session', () => {
  it('returns null when nothing matches (source, sessionId) at all', async () => {
    const queries = createQueries(db, config, { now: () => NOW });
    expect(await queries.getSessionDetail('claude', 'nope')).toBeNull();
  });
});

describe('nested session drill-down coherence', () => {
  it('reconciles list, root, embedded branch, opened branch, timeline and Summary timing', async () => {
    for (const [sessionId, parentSessionId, amount] of [['R', undefined, 1], ['C', 'R', 2], ['G', 'C', 3]] as const) {
      const ts = NOW - 5000 + amount * 1000;
      seedEvent(db, { id: sessionId, source: 'codex', sessionId, parentSessionId, isSubagent: parentSessionId !== undefined,
        ts, model: 'test-model', inputFresh: amount * 10, cacheRead: amount * 100, output: amount, reasoning: 1,
        apiEquivUsd: amount, reservedValue: amount * 2, ucuRateStatus: 'FILED-EXAMPLE' });
      db.prepare(`INSERT INTO activity(source,session_id,ts,host,kind,duration_ms) VALUES('codex',?,?, 'M4a','turn',?)`).run(sessionId, ts, amount * 1000);
    }
    const q = createQueries(db, config, { now: () => NOW });
    const list = await q.getSessions({ range: 'all' });
    const root = (await q.getSessionDetail('codex', 'R'))!;
    const child = (await q.getSessionDetail('codex', 'C'))!;
    const grandchild = (await q.getSessionDetail('codex', 'G'))!;
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]).toMatchObject({ sessionId: 'R', subagents: 2, activeMs: 6000 });
    expect(root.tokens).toEqual(list.sessions[0].tokens);
    expect(root).toMatchObject({ events: 3, subagents: 2, activeMs: 6000, wallMs: 2000,
      tokens: { inputFresh: 60, cacheRead: 600, output: 6, reasoning: 3 }, apiEquivUsd: 6 });
    expect(root.subagentSessions).toHaveLength(1);
    expect(root.subagentSessions[0]).toMatchObject({ sessionId: 'C', subagents: 1 });
    expect(root.subagentSessions[0].tokens).toEqual(child.tokens);
    expect(root.subagentSessions[0].activeMs).toBe(child.activeMs);
    expect(root.subagentSessions[0].apiEquivUsd).toBe(child.apiEquivUsd);
    expect(child).toMatchObject({ events: 2, subagents: 1, activeMs: 5000 });
    expect(child.subagentSessions[0].tokens).toEqual(grandchild.tokens);
    expect(root.byModel.reduce((sum, row) => sum + row.tokens.inputFresh, 0)).toBe(60);
    expect(root.timeseries.points.reduce((sum, point) => sum + (point.totalTokens ?? 0), 0)).toBe(666);
    expect(root.timeseries.points.reduce((sum, point) => sum + point.tokens, 0)).toBe(66);
    expect((await q.getSummary('all')).activeTime.agentMs).toBe(6000);
  });

  it('does not include an earlier parent after a child is reassigned, or duplicate cyclic records', async () => {
    for (const [id, sessionId, parentSessionId, ts, amount] of [
      ['old', 'C', 'R', NOW - 4000, 10], ['new', 'C', 'Other', NOW - 3000, 20],
      ['root', 'R', undefined, NOW - 2000, 1], ['other', 'Other', undefined, NOW - 1000, 2],
      ['cycle-a', 'A', 'B', NOW - 2000, 3], ['cycle-b', 'B', 'A', NOW - 1000, 4],
    ] as const) seedEvent(db, { id, sessionId, parentSessionId, isSubagent: parentSessionId !== undefined,
      ts, model: 'test-model', inputFresh: amount, apiEquivUsd: amount, reservedValue: null, ucuRateStatus: 'NONE' });
    const q = createQueries(db, config, { now: () => NOW });
    expect((await q.getSessionDetail('claude', 'R'))).toMatchObject({ events: 1, tokens: { inputFresh: 1 } });
    expect((await q.getSessionDetail('claude', 'Other'))).toMatchObject({ events: 3, tokens: { inputFresh: 32 } });
    expect((await q.getSessionDetail('claude', 'A'))).toMatchObject({ events: 1, tokens: { inputFresh: 3 } });
    expect((await q.getSessionDetail('claude', 'B'))).toMatchObject({ events: 1, tokens: { inputFresh: 4 } });
  });
});

describe('getSessionDetail: capture provenance', () => {
  it('returns the same exact local Qwen feed as the session list, including unknown engine and event flags', async () => {
    seedEvent(db, { id: 'qwen-local', source: 'qwen-code', sessionId: 'qwen-session', ts: NOW - 1000,
      provider: 'local', model: 'qwen3.8:27b', inputFresh: 100, output: 20, apiEquivUsd: 0,
      reservedValue: 2, ucuRateStatus: 'ESTIMATE', flags: ['thinkingUnknown'] });
    const queries = createQueries(db, config, { now: () => NOW });
    const list = await queries.getSessions({ range: 'all', activeOnly: false });
    const detail = await queries.getSessionDetail('qwen-code', 'qwen-session');
    expect(detail?.telemetry).toEqual(list.sessions[0].telemetry);
    expect(detail?.telemetry).toEqual([expect.objectContaining({
      host: 'M4a', source: 'qwen-code', provider: 'local', models: ['qwen3.8:27b'], events: 1,
      tokens: expect.objectContaining({ inputFresh: 100, output: 20 }), apiEquivUsd: 0,
      unpricedEvents: 0, firstEventAt: NOW - 1000, lastEventAt: NOW - 1000,
      flags: { thinkingUnknown: 1 },
    })]);
    expect(detail?.telemetry?.[0]).not.toHaveProperty('engine');
  });
});

describe('getSessionDetail: single-session totals (hand-summed)', () => {
  it('sums tokens/apiEquivUsd, splits byModel per thinking mode, and computes cache/thinking shares exactly', async () => {
    seedEvent(db, {
      id: 'e1', sessionId: 's1', ts: NOW - 10_000, model: 'claude-sonnet-5',
      apiEquivUsd: 1, reservedValue: 10, ucuRateStatus: 'MEASURED',
      inputFresh: 100, cacheRead: 300, output: 50, thinking: true,
    });
    seedEvent(db, {
      id: 'e2', sessionId: 's1', ts: NOW - 5_000, model: 'claude-sonnet-5',
      apiEquivUsd: 2, reservedValue: 20, ucuRateStatus: 'MEASURED',
      inputFresh: 100, cacheRead: 100, output: 50, thinking: false,
    });
    seedMark(db, { sessionId: 's1', ts: NOW - 12_000 });
    seedMark(db, { sessionId: 's1', ts: NOW - 9_000 }); // gap 3s (<= idleGapMs) -> active
    seedMark(db, { sessionId: 's1', ts: NOW - 4_000 }); // gap 5s (<= idleGapMs) -> active

    const queries = createQueries(db, config, { now: () => NOW });
    const detail = await queries.getSessionDetail('claude', 's1');
    expect(detail).not.toBeNull();
    const d = detail!;

    expect(d.sessionId).toBe('s1');
    expect(d.host).toBe('M4a');
    expect(d.events).toBe(2);
    expect(d.tokens).toEqual({ inputFresh: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 400, output: 100, reasoning: 0 });
    expect(d.apiEquivUsd).toBe(3);
    // Both series share the same event ledger: $1+$2=$3; fresh/output=300; cache reads add 400.
    // Source chart values must be dollars, not the 300 token basis used by old series clients.
    for (const series of [d.timeseries, await queries.getTimeseries('hour', 'all')]) {
      expect(series.points.reduce((sum, point) => sum + (point.bySource.claude ?? 0), 0)).toBe(3);
      expect(series.points.reduce((sum, point) => sum + point.apiEquivUsd, 0)).toBe(3);
      expect(series.points.reduce((sum, point) => sum + point.tokens, 0)).toBe(300);
      expect(series.points.reduce((sum, point) => sum + (point.totalTokens ?? 0), 0)).toBe(700);
    }
    expect(d.firstEventTs).toBe(NOW - 10_000);
    expect(d.lastEventTs).toBe(NOW - 5_000);
    expect(d.subagents).toBe(0);
    expect(d.subagentSessions).toEqual([]);

    // cacheReadShare = cacheRead / (inputFresh+cacheWrite5m+cacheWrite1h+cacheRead) = 400/600
    expect(d.cacheReadShare).toBeCloseTo(400 / 600, 10);
    // thinkingShare = thinkingTrue / (thinkingTrue+thinkingFalse) = 1/2 (both events have a
    // determinable, non-null thinking value here, so thinkingUnknownEvents is 0)
    expect(d.thinkingShare).toBeCloseTo(0.5, 10);
    expect(d.thinkingUnknownEvents).toBe(0);

    // byModel: split into 2 rows (thinking / non-thinking), never blended, matching getSummary's rule.
    expect(d.byModel).toHaveLength(2);
    const byMode = Object.fromEntries(d.byModel.map((m) => [m.thinking, m]));
    expect(byMode.thinking!.events).toBe(1);
    expect(byMode['non-thinking']!.events).toBe(1);

    // start/end come from the activity marks (widest window: NOW-12000 .. NOW-4000), not just events.
    expect(d.start).toBe(NOW - 12_000);
    expect(d.end).toBe(NOW - 4_000);
    expect(d.wallMs).toBe(8_000);
    // activeMs: gaps between the 3 marks are 3000ms and 5000ms, both <= the default 5min idleGapMs.
    expect(d.activeMs).toBe(8_000);
    expect(d.activityEvidence).toEqual({ version: 1, basis: 'activity-gaps', markCount: 3, durationMarkCount: 0, idleGapMs: 300_000 });
  });

  it('cacheReadShare and thinkingShare are null when there is nothing to take a share of (never a false 0%)', async () => {
    seedEvent(db, { id: 'e1', sessionId: 's2', ts: NOW, model: 'm', apiEquivUsd: 0, reservedValue: null, ucuRateStatus: 'NONE', output: 10 });
    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 's2'))!;
    expect(d.activityEvidence).toEqual({ version: 1, basis: 'no-marks', markCount: 0, durationMarkCount: 0, idleGapMs: 300_000 });
    expect(d.cacheReadShare).toBeNull(); // no gross prompt tokens at all
    expect(d.thinkingShare).toBeNull(); // thinking omitted -> unknown for the only event
    expect(d.thinkingUnknownEvents).toBe(1);
  });

  it('flags summary counts each flag across events, omitting flags that never occur', async () => {
    seedEvent(db, { id: 'e1', sessionId: 's3', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', flags: ['speedAssumed', 'cacheSplitAssumed'] });
    seedEvent(db, { id: 'e2', sessionId: 's3', ts: NOW + 1000, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', flags: ['speedAssumed'] });
    const queries = createQueries(db, config, { now: () => NOW + 10_000 });
    const d = (await queries.getSessionDetail('claude', 's3'))!;
    expect(d.flags).toEqual({ speedAssumed: 2, cacheSplitAssumed: 1 });
    expect(d.flags.counterReset).toBeUndefined();
  });

  it('the detail has no repository attribution section, and the rest of the detail still works', async () => {
    seedEvent(db, { id: 'e1', sessionId: 's4', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', inputFresh: 10, output: 5 });
    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 's4'))!;
    const list = await queries.getSessions({ range: 'all', activeOnly: false });
    // The sections the detail adds to a list row are exactly the documented ones: nothing else is attached.
    const detailOnly = Object.keys(d).filter((key) => !(key in list.sessions[0]!)).sort();
    expect(detailOnly).toEqual(['byModel', 'cacheReadShare', 'events', 'firstEventTs', 'flags', 'lastEventTs', 'subagentSessions', 'thinkingShare', 'thinkingUnknownEvents', 'timeseries', 'wallMs']);
    expect(d).toMatchObject({ sessionId: 's4', events: 1, apiEquivUsd: 1, subagents: 0, tokens: { inputFresh: 10, output: 5 } });
  });
});

describe('getSessionDetail: recent burn price quality (R44)', () => {
  // Window is (NOW - 15m, NOW]. Hand-computed from the seeded rows, never from computeBurn.
  function seedBurnSession(): void {
    seedEvent(db, { id: 'old', sessionId: 'bp', ts: NOW - 2_000_000, model: 'm', apiEquivUsd: null, reservedValue: null, ucuRateStatus: 'NONE', inputFresh: 999 });
    seedEvent(db, { id: 'edge', sessionId: 'bp', ts: NOW - 900_000, model: 'm', apiEquivUsd: null, reservedValue: null, ucuRateStatus: 'NONE', inputFresh: 999 }); // lower edge: outside
    seedEvent(db, { id: 'own', sessionId: 'bp', ts: NOW - 60_000, model: 'm', apiEquivUsd: 0.3, reservedValue: 1, ucuRateStatus: 'MEASURED', inputFresh: 150 });
    seedEvent(db, { id: 'cu', sessionId: 'bc', parentSessionId: 'bp', isSubagent: true, ts: NOW - 30_000, model: 'm', apiEquivUsd: null, reservedValue: null, ucuRateStatus: 'NONE', inputFresh: 300 });
    seedEvent(db, { id: 'ce', sessionId: 'bc', parentSessionId: 'bp', isSubagent: true, ts: NOW, model: 'm', apiEquivUsd: 0.6, priceStatus: 'ESTIMATE', reservedValue: 1, ucuRateStatus: 'MEASURED' });
  }

  it('parent detail qualifies its folded window only; whole-session counts differ', async () => {
    seedBurnSession();
    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 'bp'))!;
    // Whole session: 3 unpriced (old, edge, cu), 1 estimated.
    expect(d).toMatchObject({ unpricedEvents: 3, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
    // Window: own + cu + ce. Tokens 150 + 300 = 450 / 15 = 30; $0.3 + $0.6 = 0.9 / 0.25 h = 3.6.
    expect(d.burn).toEqual({
      tokensPerMin: 30,
      usdPerHour: expect.closeTo(3.6, 9),
      priceQuality: { events: 3, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED',
        priceEvidence: { version: 1, events: 3, invalidAmountEvents: 0, unknownStatusEvents: 0,
          statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false } },
    });
    const list = await queries.getSessions({ range: 'all', activeOnly: false });
    expect(list.sessions.find((s) => s.sessionId === 'bp')?.burn).toEqual(d.burn);
  });

  it('child detail qualifies only its own window events', async () => {
    seedBurnSession();
    const queries = createQueries(db, config, { now: () => NOW });
    const c = (await queries.getSessionDetail('claude', 'bc'))!;
    // cu + ce: 300 / 15 = 20 tok/min; $0.6 / 0.25 h = 2.4.
    expect(c.burn).toEqual({
      tokensPerMin: 20,
      usdPerHour: expect.closeTo(2.4, 9),
      priceQuality: { events: 2, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED',
        priceEvidence: { version: 1, events: 2, invalidAmountEvents: 0, unknownStatusEvents: 0,
          statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false } },
    });
  });

  it('only outside-window unpriced events: burn stays null', async () => {
    seedEvent(db, { id: 'o', sessionId: 'bn', ts: NOW - 900_000, model: 'm', apiEquivUsd: null, reservedValue: null, ucuRateStatus: 'NONE', inputFresh: 5 });
    const queries = createQueries(db, config, { now: () => NOW });
    expect((await queries.getSessionDetail('claude', 'bn'))!.burn).toBeNull();
  });
});

describe('getSessionDetail: subagent folding', () => {
  it('folds a subagent event into the parent totals AND reports it separately in subagentSessions', async () => {
    seedEvent(db, { id: 'p1', sessionId: 'parent', ts: NOW - 20_000, model: 'claude-sonnet-5', apiEquivUsd: 5, reservedValue: 50, ucuRateStatus: 'MEASURED', inputFresh: 100, output: 50 });
    seedEvent(db, {
      id: 'c1', sessionId: 'child-1', parentSessionId: 'parent', isSubagent: true, ts: NOW - 15_000,
      model: 'claude-haiku-4-5', apiEquivUsd: 0.5, reservedValue: 5, ucuRateStatus: 'MEASURED', inputFresh: 20, output: 10,
    });

    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 'parent'))!;

    // Parent totals include the subagent's contribution.
    expect(d.events).toBe(2);
    expect(d.apiEquivUsd).toBe(5.5);
    expect(d.subagents).toBe(1);

    expect(d.subagentSessions).toHaveLength(1);
    const sub = d.subagentSessions[0]!;
    expect(sub.sessionId).toBe('child-1');
    expect(sub.tokens).toEqual({ inputFresh: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 10, reasoning: 0 });
    expect(sub.apiEquivUsd).toBe(0.5);
    expect(sub.models).toEqual(['claude-haiku-4-5']);

    // The subagent's own detail (clicked into directly) is queryable too, and is NOT the parent's.
    const subDetail = (await queries.getSessionDetail('claude', 'child-1'))!;
    expect(subDetail.events).toBe(1);
    expect(subDetail.apiEquivUsd).toBe(0.5);
    expect(subDetail.subagents).toBe(0);
  });
});

describe('getSessionDetail: a self-parent edge is an own event, never a child', () => {
  it('a session whose only parent edge points at itself counts each own event once, matching the list and the ledger', async () => {
    seedEvent(db, { id: 'a1', sessionId: 'S', parentSessionId: 'S', isSubagent: true, ts: NOW - 20_000, model: 'claude-sonnet-5',
      apiEquivUsd: 2, reservedValue: 20, ucuRateStatus: 'MEASURED', inputFresh: 100, output: 50, thinking: true });
    seedEvent(db, { id: 'a2', sessionId: 'S', parentSessionId: 'S', isSubagent: true, ts: NOW - 10_000, model: 'claude-sonnet-5',
      apiEquivUsd: 3, reservedValue: 30, ucuRateStatus: 'MEASURED', inputFresh: 200, cacheRead: 400, output: 100, thinking: false });
    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 'S'))!;

    expect(d.events).toBe(2); // would be 4 before the fix: each own row was read again as a child
    expect(d.tokens).toEqual({ inputFresh: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 400, output: 150, reasoning: 0 });
    expect(d.apiEquivUsd).toBe(5);
    expect(d.subagents).toBe(0);
    expect(d.subagentSessions).toEqual([]);
    expect(d.byModel.reduce((sum, m) => sum + m.events, 0)).toBe(2);
    expect(d.byModel.reduce((sum, m) => sum + (m.apiEquivUsd ?? 0), 0)).toBe(5);

    const list = await queries.getSessions({ range: 'all', activeOnly: false });
    const rows = list.sessions.filter((r) => r.source === 'claude' && r.sessionId === 'S');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokens).toEqual(d.tokens);
    expect(rows[0]!.apiEquivUsd).toBe(5);
    expect(rows[0]!.subagents).toBe(0);
  });

  it('a self-parent edge beside a legitimate child: own rows once, the child folds once, another source stays out of the detail', async () => {
    seedEvent(db, { id: 'o1', sessionId: 'S', parentSessionId: 'S', isSubagent: true, ts: NOW - 30_000, model: 'claude-sonnet-5',
      apiEquivUsd: 1, reservedValue: 10, ucuRateStatus: 'MEASURED', inputFresh: 100, output: 10 });
    seedEvent(db, { id: 'o2', sessionId: 'S', ts: NOW - 20_000, model: 'claude-sonnet-5',
      apiEquivUsd: 2, reservedValue: 20, ucuRateStatus: 'MEASURED', inputFresh: 200, output: 20 });
    seedEvent(db, { id: 'c1', sessionId: 'C', parentSessionId: 'S', isSubagent: true, ts: NOW - 15_000, model: 'claude-haiku-4-5',
      apiEquivUsd: 0.5, reservedValue: 5, ucuRateStatus: 'MEASURED', inputFresh: 20, output: 10 });
    // Different source with the same parent id: the claude detail must not read it (same-source boundary).
    seedEvent(db, { id: 'x1', source: 'codex', sessionId: 'X', parentSessionId: 'S', isSubagent: true, ts: NOW - 12_000,
      model: 'gpt-6-sol', provider: 'openai', apiEquivUsd: 7, reservedValue: 70, ucuRateStatus: 'MEASURED', inputFresh: 1000, output: 500 });
    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 'S'))!;

    expect(d.events).toBe(3); // o1, o2, c1 (o1 would be counted twice before the fix)
    expect(d.apiEquivUsd).toBeCloseTo(3.5, 10);
    expect(d.tokens).toEqual({ inputFresh: 320, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 40, reasoning: 0 });
    expect(d.subagents).toBe(1);
    expect(d.subagentSessions.map((s) => s.sessionId)).toEqual(['C']);
    expect(d.subagentSessions[0]!.apiEquivUsd).toBe(0.5);
    expect(d.byModel.reduce((sum, m) => sum + m.events, 0)).toBe(3);

    const list = await queries.getSessions({ range: 'all', activeOnly: false });
    const row = list.sessions.find((r) => r.source === 'claude' && r.sessionId === 'S')!;
    expect(row.tokens).toEqual(d.tokens);
    expect(row.apiEquivUsd).toBeCloseTo(3.5, 10);
    expect(row.subagents).toBe(1);
  });
});

describe('getSessionDetail: timeseries bucketing follows chooseSessionBucketMs and sums to the session total', () => {
  it('a short (<=2h) session buckets at 5-minute granularity and its points sum back to the totals', async () => {
    seedEvent(db, { id: 'e1', sessionId: 's5', ts: NOW - 3_600_000, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', inputFresh: 10, output: 5 });
    seedEvent(db, { id: 'e2', sessionId: 's5', ts: NOW - 1_800_000, model: 'm', apiEquivUsd: 2, reservedValue: 2, ucuRateStatus: 'MEASURED', inputFresh: 20, output: 5 });
    const queries = createQueries(db, config, { now: () => NOW });
    const d = (await queries.getSessionDetail('claude', 's5'))!;
    expect(d.timeseries.bucketMs).toBe(chooseSessionBucketMs(d.end - d.start));
    expect(d.timeseries.bucketMs).toBe(5 * 60_000); // span here is 1800000ms (30min) <= 2h
    const totalUsd = d.timeseries.points.reduce((s, p) => s + p.apiEquivUsd, 0);
    expect(totalUsd).toBeCloseTo(3, 10);
  });
});
