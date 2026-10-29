/**
 * queries.ts owns SQL aggregation over already-priced columns; the pricing *computation* itself
 * belongs to core/pricing.ts (not this module). So these tests seed the
 * `events`/`activity`/`limits`/`skipped` tables directly with hand-chosen, already-computed
 * values (bypassing the pricing engine entirely) and hand-verify that queries.ts
 * sums/groups/buckets them correctly — every expected number below is computed by hand
 * in the test itself, not copied from a run. The seeded rows also carry the reserved stored
 * valuation columns, which these aggregation checks leave untouched.
 *
 * `getSessions`'s domain logic and the Summary `subscriptions` section *do* call the real
 * core/sessions.ts#buildSessions / core/subscriptions.ts (statically imported by
 * queries.ts) — true integration checks against documented, hand-verified algorithms, not mocks.
 * The only stub is the Ollama probe (doctor), so no test ever shells out to lsof or hits :11434.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { rowToEvent, type EventRow } from '../../src/store/ledger.js';
import { createQueries as realCreateQueries, rangeSince, type CreateQueriesOpts } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { TokeneloConfig } from '../../src/core/types.js';

const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });
function createQueries(d: TokeneloDb, c: TokeneloConfig, o?: CreateQueriesOpts) {
  return realCreateQueries(d, c, { probeOllama: stubProbe, ...o });
}

// ── seeding helper: one raw INSERT per event row, every column explicit ────

interface SeedEvent {
  id: string;
  host?: string;
  source?: string;
  ts: number;
  sessionId?: string;
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
  isSubagent?: boolean;
  thinking?: boolean | null;
}

function seedEvent(db: TokeneloDb, e: SeedEvent): void {
  db.prepare(
    `INSERT INTO events (
      id, host, source, ts, ts_source, session_id, is_subagent,
      model, provider, components_json,
      input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning,
      flags_json, api_equiv_usd, price_status, price_version, ucu, ucu_rate_status, eacs_def_sha256, thinking
    ) VALUES (
      @id, @host, @source, @ts, 'line', @sessionId, @isSubagent,
      @model, @provider, @componentsJson,
      @inputFresh, @cacheWrite5m, @cacheWrite1h, @cacheRead, @output, @reasoning,
      @flagsJson, @apiEquivUsd, @priceStatus, 'test-price-v1', @reservedValue, @ucuRateStatus, 'test-def-sha', @thinking
    )`
  ).run({
    id: e.id,
    host: e.host ?? 'M4a',
    source: e.source ?? 'claude',
    ts: e.ts,
    sessionId: e.sessionId ?? 'session-1',
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

function seedSkipped(db: TokeneloDb, p: string, reason: string, count = 1): void {
  db.prepare(`INSERT INTO skipped (path, reason, count, last_seen) VALUES (?, ?, ?, ?)`).run(p, reason, count, Date.now());
}

let db: TokeneloDb;
let config: TokeneloConfig;
const NOW = 1_700_000_000_000; // fixed instant so every range boundary is hand-computable

beforeEach(() => {
  db = openDb({ file: ':memory:' });
  config = defaultConfig({ hostLabel: 'M4a' });
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('rangeSince', () => {
  it('computes exact epoch-ms boundaries for every non-"today" range', () => {
    expect(rangeSince('24h', NOW)).toBe(NOW - 86_400_000);
    expect(rangeSince('7d', NOW)).toBe(NOW - 7 * 86_400_000);
    expect(rangeSince('30d', NOW)).toBe(NOW - 30 * 86_400_000);
    expect(rangeSince('all', NOW)).toBeUndefined();
  });

  it('"today" floors to local midnight of `now`', () => {
    const d = new Date(NOW);
    d.setHours(0, 0, 0, 0);
    expect(rangeSince('today', NOW)).toBe(d.getTime());
  });
});

describe('getSummary: token/dollar/event totals (hand-summed)', () => {
  it('sums tokens and apiEquivUsd exactly, and counts UNPRICED events without letting a null poison the sum', () => {
    // Two priced events + one unpriced (apiEquivUsd null) — the sum must be 3.50 + 1.25 = 4.75,
    // never NaN/null, and unpricedEvents must count exactly the one UNPRICED row.
    seedEvent(db, { id: 'e1', ts: NOW - 1000, model: 'claude-sonnet-5', apiEquivUsd: 3.5, reservedValue: 10, ucuRateStatus: 'MEASURED', inputFresh: 100, output: 50 });
    seedEvent(db, { id: 'e2', ts: NOW - 2000, model: 'claude-sonnet-5', apiEquivUsd: 1.25, reservedValue: 5, ucuRateStatus: 'MEASURED', inputFresh: 40, output: 20 });
    seedEvent(db, { id: 'e3', ts: NOW - 3000, model: 'unknown-model-xyz', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE', inputFresh: 10, output: 5 });

    const queries = createQueries(db, config, { now: () => NOW });
    return queries.getSummary('all').then((summary) => {
      expect(summary.totals.events).toBe(3);
      expect(summary.totals.apiEquivUsd).toBeCloseTo(4.75, 10);
      expect(summary.totals.unpricedEvents).toBe(1);
      expect(summary.totals.tokens).toEqual({
        inputFresh: 150, // 100+40+10
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 75, // 50+20+5
        reasoning: 0,
        countQuality: 'unrecorded', // seed rows have no raw counter evidence; migration does not backfill it.
      });
    });
  });

  it('range filtering excludes events outside the window, by exact ts boundary (>= since)', async () => {
    seedEvent(db, { id: 'in', ts: NOW - 86_400_000, model: 'claude-sonnet-5', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' }); // exactly at the 24h boundary — inclusive
    seedEvent(db, { id: 'out', ts: NOW - 86_400_000 - 1, model: 'claude-sonnet-5', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' }); // 1ms outside

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('24h');
    expect(summary.totals.events).toBe(1);
  });

  it('byModel: apiEquivUsd is null only when EVERY event for that model is unpriced, otherwise sums the known ones', async () => {
    seedEvent(db, { id: 'a', ts: NOW, model: 'all-unpriced', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE' });
    seedEvent(db, { id: 'b', ts: NOW, model: 'all-unpriced', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE' });
    seedEvent(db, { id: 'c', ts: NOW, model: 'mixed', apiEquivUsd: 2, priceStatus: 'LIST', reservedValue: 1, ucuRateStatus: 'MEASURED' });
    seedEvent(db, { id: 'd', ts: NOW, model: 'mixed', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE' });

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('all');
    const byModel = Object.fromEntries(summary.byModel.map((m) => [m.model, m]));
    expect(byModel['all-unpriced']!.apiEquivUsd).toBeNull();
    expect(byModel['all-unpriced']!.priceStatus).toBe('UNPRICED');
    expect(byModel['mixed']!.apiEquivUsd).toBe(2); // the unpriced sibling contributes 0, not null
    expect(byModel['mixed']!.priceStatus).toBe('UNPRICED'); // "some unpriced" still flags the group
  });

  it('byModel: splits the SAME model into separate rows per thinking mode (founder req. 2026-09-27), never blended', async () => {
    seedEvent(db, { id: 't1', ts: NOW, model: 'gemma4:26b', apiEquivUsd: 0, reservedValue: 10, ucuRateStatus: 'MEASURED', thinking: true });
    seedEvent(db, { id: 't2', ts: NOW, model: 'gemma4:26b', apiEquivUsd: 0, reservedValue: 20, ucuRateStatus: 'MEASURED', thinking: true });
    seedEvent(db, { id: 't3', ts: NOW, model: 'gemma4:26b', apiEquivUsd: 0, reservedValue: 5, ucuRateStatus: 'MEASURED', thinking: false });
    seedEvent(db, { id: 't4', ts: NOW, model: 'gemma4:26b', apiEquivUsd: 0, reservedValue: null, ucuRateStatus: 'NONE', thinking: null });

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('all');
    const gemmaRows = summary.byModel.filter((m) => m.model === 'gemma4:26b');
    expect(gemmaRows).toHaveLength(3); // thinking / non-thinking / unknown -- never one blended row
    const byMode = Object.fromEntries(gemmaRows.map((m) => [m.thinking, m]));
    expect(byMode.thinking!.events).toBe(2);
    expect(byMode['non-thinking']!.events).toBe(1);
    expect(byMode.unknown!.events).toBe(1);
  });

  it('bySource: groups and sums independently per source', async () => {
    seedEvent(db, { id: 'a', ts: NOW, source: 'claude', model: 'claude-sonnet-5', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' });
    seedEvent(db, { id: 'b', ts: NOW, source: 'codex', model: 'gpt-6-sol', apiEquivUsd: 3, reservedValue: 2, ucuRateStatus: 'MEASURED' });
    seedEvent(db, { id: 'c', ts: NOW, source: 'codex', model: 'gpt-6-sol', apiEquivUsd: 4, reservedValue: 3, ucuRateStatus: 'MEASURED' });

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('all');
    expect(summary.bySource['claude']!.events).toBe(1);
    expect(summary.bySource['claude']!.apiEquivUsd).toBe(1);
    expect(summary.bySource['codex']!.events).toBe(2);
    expect(summary.bySource['codex']!.apiEquivUsd).toBe(7);
  });
});

describe('getSessions: real integration smoke tests (actual core modules, minimal data)', () => {
  it('getSessions returns [] for an empty ledger and does not throw', async () => {
    const queries = createQueries(db, config, { now: () => NOW });
    const res = await queries.getSessions({ range: 'all', activeOnly: false });
    expect(res.sessions).toEqual([]);
  });

  it('getSessions reports the one clock read used for its range boundary as generatedAt, and the boundary stays inclusive', async () => {
    seedEvent(db, { id: 'in', sessionId: 'at-boundary', ts: NOW - 86_400_000, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' });
    seedEvent(db, { id: 'out', sessionId: 'before-boundary', ts: NOW - 86_400_000 - 1, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' });
    // The clock advances on every read: generatedAt must be the first read (the boundary's), not a later one.
    let t = NOW;
    const queries = createQueries(db, config, { now: () => t++ });
    const res = await queries.getSessions({ range: '24h', activeOnly: false });
    expect(res.range).toBe('24h');
    expect(res.generatedAt).toBe(NOW);
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['at-boundary']);
  });
});

describe('subscriptions: uses the real core/subscriptions.ts#computeSubscriptionLeverage (30-day-month proration, hand-verified)', () => {
  it('prorates a monthly price to a 7-day range as monthlyUsd * 7/30, and computes leverage = apiEquiv/billed', async () => {
    config.accounts = [{ id: 'acct-1', kind: 'claude', hosts: ['M4a'], planName: 'Max', monthlyUsd: 300 }];
    seedEvent(db, { id: 'a', host: 'M4a', ts: NOW - 1000, model: 'm', apiEquivUsd: 100, reservedValue: 1, ucuRateStatus: 'MEASURED' });

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('7d');
    const sub = summary.subscriptions.find((s) => s.account === 'acct-1')!;

    const expectedBilled = 300 * (7 / 30); // = 70
    expect(sub.billedUsd).toBeCloseTo(expectedBilled, 10);
    expect(sub.apiEquivUsd).toBe(100);
    expect(sub.leverage).toBeCloseTo(100 / expectedBilled, 10); // ≈ 1.42857
  });

  it('an account with no monthlyUsd configured never guesses a billed price: leverage and billedUsd are both null', async () => {
    config.accounts = [{ id: 'acct-2', kind: 'codex', hosts: ['M4a'] }];
    seedEvent(db, { id: 'a', host: 'M4a', source: 'codex', ts: NOW, model: 'm', apiEquivUsd: 50, reservedValue: 1, ucuRateStatus: 'MEASURED' });

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('all');
    const sub = summary.subscriptions.find((s) => s.account === 'acct-2')!;
    expect(sub.billedUsd).toBeNull();
    expect(sub.leverage).toBeNull();
    expect(sub.apiEquivUsd).toBe(50);
  });

  it('an account is only charged events from ITS configured hosts, never a sibling host\'s spend', async () => {
    config.accounts = [{ id: 'acct-1', kind: 'claude', hosts: ['M4a'], monthlyUsd: 300 }];
    seedEvent(db, { id: 'a', host: 'M4a', ts: NOW, model: 'm', apiEquivUsd: 10, reservedValue: 1, ucuRateStatus: 'MEASURED' });
    seedEvent(db, { id: 'b', host: 'A2000', ts: NOW, model: 'm', apiEquivUsd: 999, reservedValue: 1, ucuRateStatus: 'MEASURED' });

    const queries = createQueries(db, config, { now: () => NOW });
    const summary = await queries.getSummary('all');
    const sub = summary.subscriptions.find((s) => s.account === 'acct-1')!;
    expect(sub.apiEquivUsd).toBe(10); // not 1009
  });
});

describe('getTimeseries: exact day-bucketing', () => {
  it('buckets by UTC-aligned day and sums tokens/$ per bucket independently', async () => {
    const day0 = Date.UTC(2026, 0, 1, 0, 0, 0);
    const day1 = Date.UTC(2026, 0, 2, 0, 0, 0);
    seedEvent(db, { id: 'a', ts: day0 + 1000, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', inputFresh: 10, output: 5 });
    seedEvent(db, { id: 'b', ts: day0 + 2000, model: 'm', apiEquivUsd: 2, reservedValue: 2, ucuRateStatus: 'MEASURED', inputFresh: 20, output: 5 });
    seedEvent(db, { id: 'c', ts: day1 + 500, model: 'm', apiEquivUsd: 5, reservedValue: 5, ucuRateStatus: 'MEASURED', inputFresh: 1, output: 1 });

    const queries = createQueries(db, config, { now: () => day1 + 86_400_000 });
    const ts = await queries.getTimeseries('day', 'all');
    expect(ts.points).toHaveLength(2);
    const p0 = ts.points.find((p) => p.t === day0)!;
    const p1 = ts.points.find((p) => p.t === day1)!;
    expect(p0.apiEquivUsd).toBe(3); // 1 + 2
    expect(p0.tokens).toBe(40); // (10+5) + (20+5)
    expect(p1.apiEquivUsd).toBe(5);
    expect(p1.tokens).toBe(2);
  });
});

describe('getTimeseries: generatedAt is the one clock read behind the range boundary', () => {
  it('reads now() once: generatedAt equals the fixed now, and the 24h boundary is now − 24h (inclusive)', async () => {
    seedEvent(db, { id: 'in', ts: NOW - 86_400_000, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' });
    seedEvent(db, { id: 'out', ts: NOW - 86_400_000 - 1, model: 'm', apiEquivUsd: 10, reservedValue: 1, ucuRateStatus: 'MEASURED' });
    const now = vi.fn(() => NOW);
    const ts = await createQueries(db, config, { now }).getTimeseries('hour', '24h');
    expect(now).toHaveBeenCalledTimes(1);
    expect(ts.generatedAt).toBe(NOW);
    expect(ts.points.reduce((s, p) => s + p.apiEquivUsd, 0)).toBe(1);
  });

  it('Summary and Timeseries keep independent clocks: each reports its own start instant', async () => {
    let t = NOW;
    const queries = createQueries(db, config, { now: () => t });
    const summary = await queries.getSummary('7d');
    t = NOW + 5_000;
    const ts = await queries.getTimeseries('day', '7d');
    expect(summary.generatedAt).toBe(NOW);
    expect(ts.generatedAt).toBe(NOW + 5_000);
  });

  it('declares priceQualityCounts: true, including for an empty series, and every point carries both counts', async () => {
    const queries = createQueries(db, config, { now: () => NOW });
    const empty = await queries.getTimeseries('day', '7d');
    expect(empty.points).toEqual([]);
    expect(empty.priceQualityCounts).toBe(true);
    seedEvent(db, { id: 'p', ts: NOW - 1000, model: 'm', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE' });
    seedEvent(db, { id: 'e', ts: NOW - 2000, model: 'm', apiEquivUsd: 1, priceStatus: 'ESTIMATE', reservedValue: 1, ucuRateStatus: 'MEASURED' });
    const ts = await queries.getTimeseries('day', '7d');
    expect(ts.priceQualityCounts).toBe(true);
    for (const p of ts.points) {
      expect(Number.isSafeInteger(p.unpricedEvents)).toBe(true);
      expect(Number.isSafeInteger(p.estimatedPriceEvents)).toBe(true);
    }
    expect(ts.points.reduce((s, p) => s + (p.unpricedEvents ?? 0), 0)).toBe(1);
    expect(ts.points.reduce((s, p) => s + (p.estimatedPriceEvents ?? 0), 0)).toBe(1);
  });
});

describe('getDoctor: thinkingUnknownEvents (founder req. 2026-09-27)', () => {
  it('counts only events with thinking=NULL, never true/false rows', async () => {
    const db = openDb({ file: ':memory:' });
    const config = defaultConfig({ hostLabel: 'M4a' });
    seedEvent(db, { id: 'k1', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', thinking: true });
    seedEvent(db, { id: 'k2', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', thinking: false });
    seedEvent(db, { id: 'k3', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', thinking: null });
    seedEvent(db, { id: 'k4', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED' }); // thinking omitted -> NULL

    const queries = createQueries(db, config, { now: () => NOW });
    expect((await queries.getDoctor()).thinkingUnknownEvents).toBe(2);
  });
});

describe('getDoctor: exact flag/skip/unmatched counting', () => {
  it('counts skipped paths per reason, unmatched (UNPRICED) models per model, and per-flag counts — none of it double-counted or cross-contaminated', async () => {
    seedSkipped(db, '/a/one.jsonl', 'memory-vault', 2);
    seedSkipped(db, '/a/two.jsonl', 'memory-vault', 1);
    seedSkipped(db, '/b/three.jsonl', 'sync-conflict', 1);

    seedEvent(db, { id: 'u1', ts: NOW, model: 'ghost-model', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE' });
    seedEvent(db, { id: 'u2', ts: NOW, model: 'ghost-model', apiEquivUsd: null, priceStatus: 'UNPRICED', reservedValue: null, ucuRateStatus: 'NONE' });
    seedEvent(db, { id: 'p1', ts: NOW, model: 'priced-model', apiEquivUsd: 1, priceStatus: 'LIST', reservedValue: 1, ucuRateStatus: 'MEASURED' });

    seedEvent(db, { id: 'f1', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', flags: ['speedAssumed', 'cacheSplitAssumed'] });
    seedEvent(db, { id: 'f2', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', flags: ['speedAssumed'] });
    seedEvent(db, { id: 'f3', ts: NOW, model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', flags: ['counterReset'] });
    // A CODEX event flagged speedAssumed must not count toward the claude counters.
    seedEvent(db, { id: 'f4', ts: NOW, source: 'codex', model: 'm', apiEquivUsd: 1, reservedValue: 1, ucuRateStatus: 'MEASURED', flags: ['speedAssumed'] });

    const queries = createQueries(db, config, { now: () => NOW });
    const doctor = await queries.getDoctor();

    const memoryVault = doctor.skippedPaths.find((s) => s.reason === 'memory-vault')!;
    // 2 distinct paths (one sighted twice) — a count of PATHS, not of sightings, so a long-running
    // daemon re-sighting the same vault every scan does not inflate it.
    expect(memoryVault.count).toBe(2);
    expect(doctor.skippedPaths.find((s) => s.reason === 'sync-conflict')!.count).toBe(1);

    expect(doctor.unmatchedModels).toEqual([{ model: 'ghost-model', events: 2 }]);
    // None of u1/u2/p1/f1-f4 set `thinking` -> all 7 are NULL (not determinable).
    expect(doctor.thinkingUnknownEvents).toBe(7);

    expect(doctor.claude.speedAssumed).toBe(2); // f1, f2 — not the codex f4
    expect(doctor.claude.cacheSplitAssumed).toBe(1); // f1 only
    // Codex counters are per FILE from ingest_state summaries, never from per-event flags: the
    // counterReset-flagged event f3 alone is not a "reset file".
    expect(doctor.codex.resetFiles).toBe(0);
  });
});

describe('CLI Doctor request snapshot', () => {
  it('pins the complete CLI Doctor snapshot through a concurrent WAL append',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-doctor-snapshot-')),file=path.join(root,'ledger.sqlite'),writer=openDb({file});let pending:ReturnType<typeof setImmediate>|undefined;
    try{
      writer.exec('BEGIN');for(let i=0;i<1000;i++)seedEvent(writer,{id:'snapshot-'+i,ts:NOW,model:'unknown',apiEquivUsd:.1,reservedValue:0,ucuRateStatus:'NONE',thinking:true});writer.exec('COMMIT');
      const queries=createQueries(writer,defaultConfig({hostLabel:'CLI'}),{readSnapshotFile:file,now:()=>NOW});
      pending=setImmediate(()=>seedEvent(writer,{id:'later-append',ts:NOW,model:'unknown',apiEquivUsd:-500,reservedValue:0,ucuRateStatus:'NONE',thinking:true}));
      const report=await queries.getDoctor();expect(writer.prepare('SELECT COUNT(*)AS n FROM events').get()!.n).toBe(1001);expect(report.priceEvidence.events).toBe(1000);expect(report.priceEvidence.invalidAmountEvents).toBe(0);expect(report.priceEvidence.aggregateAmountInvalid).toBe(false);
      const later=await queries.getDoctor();expect(later.priceEvidence.events).toBe(1001);expect(later.priceEvidence.invalidAmountEvents).toBe(1);expect(later.priceEvidence.aggregateAmountInvalid).toBe(true);
    }finally{if(pending)clearImmediate(pending);writer.close();fs.rmSync(root,{recursive:true,force:true});}
  });
});

describe.each([false, true])('Sessions read payload isolation and legacy count evidence (fixed=%s)', (fixed) => {
  const sessionQueries = () => createQueries(db, config, { now: () => NOW, ...(fixed ? { readSnapshotDb: db, fixedSessionReportAsOf: NOW, pageRows: 2 } : {}) });
  it('preserves legacy raw count-evidence qualification rather than certifying stored complete columns', async () => {
    seedEvent(db, { id:'legacy-raw-evidence',ts:NOW,model:'m',apiEquivUsd:1,reservedValue:1,ucuRateStatus:'MEASURED',inputFresh:2,output:3 });
    const component={model:'m',tokens:{inputFresh:2,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:3,reasoning:0},countEvidence:{policy:'future-unsupported-policy'}};
    db.prepare("UPDATE events SET count_policy='tokenelo/claude-component-counts@v2',count_quality=?,ucu_count_quality=?,count_revision=NULL,components_json=? WHERE id=?").run('complete','complete',JSON.stringify([component]),'legacy-raw-evidence');
    const row=(await sessionQueries().getSessions({range:'all',activeOnly:false})).sessions[0];
    expect(row.tokens.countQuality).toBe('incomplete');expect(row.tokens.ucuCountQuality).toBeUndefined();expect(row.tokens.inputFresh).toBe(2);expect(row.tokens.output).toBe(3);expect(row.telemetry?.[0].tokens.countQuality).toBe('incomplete');
  });
  it('retains recorded revisions and every cache category, reasoning subset and telemetry flags',async()=>{
    seedEvent(db,{id:'recorded-counts',ts:NOW,model:'m',apiEquivUsd:.4,reservedValue:2,ucuRateStatus:'MEASURED',inputFresh:2,cacheWrite5m:3,cacheWrite1h:4,cacheRead:5,output:6,reasoning:1,flags:['cacheSplitUnknown']});
    db.prepare("UPDATE events SET count_policy='tokenelo/claude-component-counts@v2',count_revision=2,count_quality=?,ucu_count_quality=?,cache_write_unassigned=7,cache_write_assumed_1h=4 WHERE id=?").run('incomplete','complete','recorded-counts');
    expect(db.prepare('SELECT count_revision FROM events WHERE id=?').get('recorded-counts')!.count_revision).toBe(2);
    const row=(await sessionQueries().getSessions({range:'all',activeOnly:false})).sessions[0];
    expect(row.tokens).toEqual({inputFresh:2,cacheWrite5m:3,cacheWrite1h:4,cacheRead:5,output:6,reasoning:1,cacheWriteUnassigned:7,cacheWriteAssumed1h:4,countQuality:'incomplete',ucuCountQuality:'complete'});expect(row.telemetry?.[0].flags.cacheSplitUnknown).toBe(1);expect(row.apiEquivUsd).toBe(.4);
  });
  it('projects unknown stored count-quality labels as invalid without rewriting the SQLite history',async()=>{
    const id='unknown-count-quality';
    seedEvent(db,{id,ts:NOW,model:'m',apiEquivUsd:.2,reservedValue:1,ucuRateStatus:'MEASURED',inputFresh:10});
    const component={model:'m',tokens:{inputFresh:10,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:0,reasoning:0,countQuality:'future-component-quality'},countEvidence:{policy:'future-unsupported-policy'}};
    db.prepare('UPDATE events SET count_quality=?,ucu_count_quality=?,count_policy=?,count_revision=NULL,components_json=? WHERE id=?')
      .run('future-quality-label','future-subset-quality-label','tokenelo/claude-component-counts@v2',JSON.stringify([component]),id);
    const projected=rowToEvent(db.prepare('SELECT * FROM events WHERE id=?').get(id) as unknown as EventRow);
    expect(projected.tokens.countQuality).toBe('invalid');
    expect(projected.tokens.ucuCountQuality).toBeUndefined();
    expect(projected.components[0]?.tokens.countQuality).toBe('invalid');
    const queries=sessionQueries();
    const session=(await queries.getSessions({range:'all',activeOnly:false})).sessions[0];
    expect(session.tokens.countQuality).toBe('invalid');
    expect(session.tokens.ucuCountQuality).toBeUndefined();
    expect(session.telemetry?.[0].tokens.countQuality).toBe('invalid');
    const summary=await queries.getSummary('all');
    expect(summary.totals.tokens.countQuality).toBe('invalid');
    expect(summary.totals.tokens.ucuCountQuality).toBeUndefined();
    const timeseries=await queries.getTimeseries('day','all');
    expect(timeseries.points[0].countQuality).toBe('invalid');
    expect(timeseries.points[0].ucuCountQuality).toBeUndefined();
    const stored=db.prepare('SELECT count_quality,ucu_count_quality,components_json FROM events WHERE id=?').get(id) as {count_quality:string;ucu_count_quality:string;components_json:string};
    expect(stored.count_quality).toBe('future-quality-label');
    expect(stored.ucu_count_quality).toBe('future-subset-quality-label');
    expect(JSON.parse(stored.components_json)[0].tokens.countQuality).toBe('future-component-quality');
  });
  it('does not parse unused performance payload for the Sessions list',async()=>{
    seedEvent(db,{id:'unrelated-performance',ts:NOW,model:'m',apiEquivUsd:.2,reservedValue:1,ucuRateStatus:'MEASURED'});db.prepare('UPDATE events SET git_branch=?,entrypoint=?,effort=?,speed=?,service_tier=?,inference_geo=?,duration_ms=?,perf_json=? WHERE id=?').run('private-branch','cli-entry','high','fast','priority','us',12345,'{malformed unrelated performance payload','unrelated-performance');
    const rows=(await sessionQueries().getSessions({range:'all',activeOnly:false})).sessions;expect(rows).toHaveLength(1);expect(rows[0].apiEquivUsd).toBe(.2);expect(rows[0].telemetry?.[0].events).toBe(1);
  });
  it('still refuses malformed count payload rather than inventing valid counter evidence',async()=>{
    seedEvent(db,{id:'malformed-counts',ts:NOW,model:'m',apiEquivUsd:.2,reservedValue:1,ucuRateStatus:'MEASURED'});db.prepare('UPDATE events SET components_json=? WHERE id=?').run('{malformed count payload','malformed-counts');
    await expect(sessionQueries().getSessions({range:'all',activeOnly:false})).rejects.toThrow();
  });
});

describe('fixed Sessions snapshot clock contract', () => {
  it('refuses an unsafe clock or a clock without snapshot ownership', () => {
    expect(() => createQueries(db, config, { fixedSessionReportAsOf: NOW })).toThrow(RangeError);
    expect(() => createQueries(db, config, { readSnapshotDb: db, fixedSessionReportAsOf: NaN })).toThrow(RangeError);
  });
  it('refuses a mismatched callback before reading', async () => {
    await expect(createQueries(db, config, { readSnapshotDb: db, fixedSessionReportAsOf: NOW, now: () => NOW + 1 }).getSessions({range:'all'})).rejects.toThrow('fixed Sessions clock mismatch');
  });
  it('retains the legacy later burn/live clock read without an explicit contract', async () => {
    seedEvent(db, {id:'moving-clock',ts:NOW,model:'m',apiEquivUsd:1,reservedValue:0,ucuRateStatus:'NONE',inputFresh:2});
    let calls=0;
    const result=await createQueries(db,config,{now:()=>calls++===0?NOW:NOW+900001}).getSessions({range:'all'});
    expect(result.generatedAt).toBe(NOW);expect(result.sessions[0].burn).toBeNull();expect(result.sessions[0].live).toBe(false);expect(calls).toBeGreaterThan(1);
  });
  it('pins ancestry, counters, and activity through a concurrent WAL update', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-session-fold-')),file=path.join(root,'ledger.sqlite'),writer=openDb({file});
    try {
      seedEvent(writer,{id:'child',ts:NOW,sessionId:'child',isSubagent:true,model:'m',apiEquivUsd:1,reservedValue:0,ucuRateStatus:'NONE',inputFresh:2});
      writer.prepare('UPDATE events SET parent_session_id=? WHERE id=?').run('parent','child');
      const baseline=await createQueries(writer,config,{now:()=>NOW}).getSessions({range:'all'});
      let updated=false;
      const query=createQueries(writer,config,{now:()=>NOW,readSnapshotFile:file,fixedSessionReportAsOf:NOW,pageRows:1,yieldNow:async()=>{
        if (!updated) {updated=true;writer.prepare('UPDATE events SET parent_session_id=?,input_fresh=?,api_equiv_usd=? WHERE id=?').run('changed',999,500,'child');
          writer.prepare('INSERT INTO activity(host,source,session_id,ts,uuid) VALUES(?,?,?,?,?)').run('M4a','claude','changed',NOW,'owned-new-mark');}
      }});
      expect(await query.getSessions({range:'all'})).toEqual(baseline);expect(updated).toBe(true);
      expect((await createQueries(writer,config,{now:()=>NOW}).getSessions({range:'all'})).sessions[0].sessionId).toBe('changed');
      expect(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
    } finally {writer.close();fs.rmSync(root,{recursive:true,force:true});}
  });
  it('cancels between ancestry and payload reads, releases the snapshot, and permits a later query', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-session-cancel-')),file=path.join(root,'ledger.sqlite'),writer=openDb({file});
    try {
      seedEvent(writer,{id:'cancel-child',ts:NOW,sessionId:'child',isSubagent:true,model:'m',apiEquivUsd:1,reservedValue:0,ucuRateStatus:'NONE'});
      writer.prepare('UPDATE events SET parent_session_id=? WHERE id=?').run('parent','cancel-child');
      const controller=new AbortController(),reason=new Error('owned ancestry cancellation');
      await expect(createQueries(writer,config,{now:()=>NOW,readSnapshotFile:file,fixedSessionReportAsOf:NOW,pageRows:1,readSignal:controller.signal,
        yieldNow:async()=>controller.abort(reason)}).getSessions({range:'all'})).rejects.toBe(reason);
      expect(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
      expect((await createQueries(writer,config,{now:()=>NOW,readSnapshotFile:file,fixedSessionReportAsOf:NOW}).getSessions({range:'all'})).sessions).toHaveLength(1);
    } finally {writer.close();fs.rmSync(root,{recursive:true,force:true});}
  });
});

describe('filtered ancestry assignments retain complete payload and ordering', () => {
  it('keeps last valid nonzero assignment, ignored-row totals, cycles and range bounds', async () => {
    const assignments: Array<[string,string|null,number,number]> = [
      ['root',null,0,NOW-100],['child','first',1,NOW-90],['child','ignored',0,NOW-80],
      ['child','',1,NOW-70],['child','child',1,NOW-60],['child',null,1,NOW-50],
      ['child','last',-1,NOW-40],['last','child',1,NOW-30],['child','future',1,NOW+1],
      ['child','old',1,NOW-8*86400000],['standalone','unused',0,NOW-20],
    ];
    for(const [index,[session,parent,agent,ts]] of assignments.entries()) {
      const id='ancestry-'+index;
      seedEvent(db,{id,sessionId:session,ts,model:'m',apiEquivUsd:index===5?null:index+1,reservedValue:0,ucuRateStatus:'NONE',inputFresh:index+2});
      db.prepare('UPDATE events SET parent_session_id=?,is_subagent=? WHERE id=?').run(parent,agent,id);
    }
    for(const range of ['all','7d','today'] as const) {
      const original=await createQueries(db,config,{now:()=>NOW}).getSessions({range});
      const filtered=await createQueries(db,config,{now:()=>NOW,readSnapshotDb:db,fixedSessionReportAsOf:NOW,pageRows:1,yieldNow:async()=>{}}).getSessions({range});
      expect(filtered).toEqual(original);
      expect(filtered.sessions.some(s=>s.sessionId==='future')).toBe(false);
    }
  });
});

describe('fixed Sessions content-free subphase diagnostics', () => {
  it.each([false,true])('records ancestry and payload only for the explicit fixed contract (%s)', async fixed => {
    seedEvent(db,{id:'phase-event',ts:NOW,model:'private-model',apiEquivUsd:1,reservedValue:0,ucuRateStatus:'NONE',sessionId:'private-session'});
    const phases: string[]=[];
    const query=createQueries(db,config,{now:()=>NOW,...(fixed?{readSnapshotDb:db,fixedSessionReportAsOf:NOW}:{})});
    await query.getSessions({range:'all'},{onDiagnosticPhase:phase=>phases.push(phase)});
    expect(phases).toEqual(fixed?['sessions.events','sessions.ancestry','sessions.event-payload','sessions.activity','sessions.aggregation','sessions.response']:['sessions.events','sessions.activity','sessions.aggregation','sessions.response']);
    expect(JSON.stringify(phases)).not.toMatch(/private-model|private-session/);
  });
  it.each(['sessions.ancestry','sessions.event-payload'])('cancels at %s and releases the owned snapshot', async cancelAt => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-session-phase-')),file=path.join(root,'ledger.sqlite'),writer=openDb({file});
    try {
      seedEvent(writer,{id:'phase-child',ts:NOW,sessionId:'child',isSubagent:true,model:'m',apiEquivUsd:1,reservedValue:0,ucuRateStatus:'NONE'});
      writer.prepare('UPDATE events SET parent_session_id=? WHERE id=?').run('parent','phase-child');
      const controller=new AbortController(),reason=new Error('owned subphase cancellation'),phases:string[]=[];
      await expect(createQueries(writer,config,{now:()=>NOW,readSnapshotFile:file,fixedSessionReportAsOf:NOW}).getSessions({range:'all'},{
        signal:controller.signal,onDiagnosticPhase:phase=>{phases.push(phase);if(phase===cancelAt)controller.abort(reason);}
      })).rejects.toBe(reason);
      expect(phases.at(-1)).toBe(cancelAt);
      expect(writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()!.busy).toBe(0);
      expect((await createQueries(writer,config,{now:()=>NOW,readSnapshotFile:file,fixedSessionReportAsOf:NOW}).getSessions({range:'all'})).sessions).toHaveLength(1);
    } finally {writer.close();fs.rmSync(root,{recursive:true,force:true});}
  });
});
