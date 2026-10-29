/**
 * Usage API oracle, query layer: the real createQueries(...) over a ledger written through the real SqliteLedger,
 * compared with the independent oracle (./oracle.ts) for every range the API supports.
 *
 * Scope: Summary, Timeseries (both buckets), Sessions, the unified Usage pair (the daemon's pinned-snapshot path) and
 * Limits (Claude block estimate). All data is fabricated (see ./cohort.ts). This edition reports no valuation, so none is derived here.
 * It does not establish capture completeness, real prices or vendor invoices.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY, COHORT, COHORT_MARKS, HOST_A, HOST_B, HOUR, IDLE_GAP_MS, NOW, RANGES, T, type RangeName } from './cohort.js';
import { aggregate, effectiveQuality, expectedBlock, expectedLimitContributors, expectedSessions, expectedSummary, expectedTimeseries, eventsIn, near, priceOf, rangeStart,
  usageBucketMs, type Agg, type Cats, type ExpectedSession } from './oracle.js';
import { json, openFileCohort, openMemoryCohort, stubProbe, usagePair, type Cohort, type FileCohort } from './harness.js';
import { expectCats, expectMoney, expectPriceAndCounts, expectSessionsResponse } from './expectations.js';
import { usageModelRowCopy } from '../../src/tray/renderer/usage-model-copy.js';
import { formatCompactNumber, formatPreciseMoney } from '../../src/tray/renderer/format.js';

const savedTz = process.env.TZ;
process.env.TZ = 'UTC'; // the main cohort's calendar day is UTC; the non-UTC case below switches zones explicitly
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

let mem: Cohort;
let file: FileCohort;
beforeAll(() => { mem = openMemoryCohort(); file = openFileCohort(); });
afterAll(() => { mem?.close(); file?.close(); });


describe('cohort and ledger write path', () => {
  it('runs on the pinned UTC calendar, so "today" starts at the cohort day boundary', () => {
    expect(new Date(NOW).getTimezoneOffset(), 'TZ=UTC could not be applied in this runner').toBe(0);
    expect(rangeStart('today', NOW)).toBe(T.today);
    expect(rangeStart('24h', NOW)).toBe(T.h24);
    expect(new Date(T.today).toISOString()).toBe('2026-10-18T00:00:00.000Z');
  });

  it('hand-counted pins of the cohort table (guards the oracle input itself)', () => {
    const pins: Record<RangeName, { events: number; unpriced: number; estimated: number; sessions: number }> = {
      today: { events: 15, unpriced: 4, estimated: 1, sessions: 8 },
      '24h': { events: 19, unpriced: 4, estimated: 1, sessions: 8 },
      '7d': { events: 24, unpriced: 5, estimated: 1, sessions: 10 },
      '30d': { events: 27, unpriced: 6, estimated: 1, sessions: 10 },
      all: { events: 28, unpriced: 6, estimated: 1, sessions: 10 },
    };
    for (const range of RANGES) {
      const a = aggregate(eventsIn(range));
      expect({ events: a.events, unpriced: a.unpricedEvents, estimated: a.estimatedPriceEvents, sessions: expectedSessions(range).length }, range).toEqual(pins[range]);
    }
    const today = aggregate(eventsIn('today'));
    expect(today.tokens).toEqual({ inputFresh: 11907, cacheWrite5m: 1000, cacheWrite1h: 2000, cacheRead: 31000, output: 1879, reasoning: 0 });
    expect(near(today.apiEquivUsd, 0.17877)).toBe(true); // 0.0675+0.042+0.0116+0.014+0.0045+0.00108+0.00109+0.0165+0.0205
    expect(COHORT.length).toBe(29);
    expect(COHORT.filter((e) => e.ts > NOW).map((e) => e.id)).toEqual(['xf1']);
  });

  it('the real ledger stored each event with the price, count quality and provider the rules give, and neutral reserved valuation values', () => {
    const rows = mem.db.prepare('SELECT id, api_equiv_usd, price_status, ucu AS reserved_value, ucu_rate_status, eacs_def_sha256, rate_key, rate_resolved_sha256, count_quality, provider FROM events').all() as any[];
    expect(rows.length).toBe(COHORT.length);
    for (const row of rows) {
      const e = COHORT.find((c) => c.id === row.id)!;
      const p = priceOf(e);
      expectMoney(row.api_equiv_usd, p.usd, `${e.id} usd`);
      expect(row.price_status, `${e.id} price status`).toBe(p.status);
      // The null engine writes honest unknowns for a new row: never a zero, never a definition or a rate selection.
      expect(row.reserved_value, `${e.id} reserved value`).toBeNull();
      expect(row.ucu_rate_status, `${e.id} reserved status`).toBe('NONE');
      expect(row.eacs_def_sha256, `${e.id} reserved definition hash`).toBe('');
      expect(row.rate_key, `${e.id} reserved rate key`).toBeNull();
      expect(row.rate_resolved_sha256, `${e.id} reserved resolved hash`).toBeNull();
      expect(row.count_quality ?? null, `${e.id} count quality`).toBe(e.quality ?? null);
      expect(row.provider, `${e.id} provider`).toBe(e.provider);
    }
  });

  it('keeps the partial / unknown / zero cases distinct in the stored rows', () => {
    const by = (id: string) => mem.db.prepare('SELECT api_equiv_usd, price_status, count_quality, input_fresh, output FROM events WHERE id = ?').get(id) as any;
    expect(by('e09')).toMatchObject({ api_equiv_usd: 0, price_status: 'LIST', count_quality: 'complete', input_fresh: 0, output: 0 }); // measured zero
    expect(by('e07')).toMatchObject({ api_equiv_usd: null, price_status: 'UNPRICED', count_quality: 'complete' }); // counts known, price unknown
    expect(by('e08')).toMatchObject({ api_equiv_usd: null, price_status: 'UNPRICED', count_quality: 'incomplete' }); // counts unknown, so price withheld
    expect(by('e10')).toMatchObject({ price_status: 'LIST', count_quality: null }); // legacy: unrecorded, not complete
    expect(by('l01')).toMatchObject({ api_equiv_usd: 0, price_status: 'LIST' }); // local model: priced zero
    expect(by('e05')).toMatchObject({ price_status: 'ESTIMATE' });
  });
});

describe.each(RANGES)('Summary, range %s, against the oracle', (range) => {
  it('totals: events, tokens, count quality, price quality', async () => {
    const s = await mem.queries.getSummary(range);
    const x = expectedSummary(range);
    expect(s.range).toBe(range);
    expect(s.generatedAt).toBe(NOW);
    expectPriceAndCounts(s.totals, x.totals, { nullWhenAllUnpriced: false });
  });

  it('bySource and byModel splits', async () => {
    const s = await mem.queries.getSummary(range);
    const x = expectedSummary(range);
    expect(Object.keys(s.bySource).sort()).toEqual([...x.bySource.keys()].sort());
    for (const [source, a] of x.bySource) expectPriceAndCounts((s.bySource as any)[source], a, { nullWhenAllUnpriced: false });
    expect(s.byModel.length).toBe(x.byModel.size);
    for (const row of s.byModel) {
      const e = x.byModel.get(`${row.source}|${row.provider}|${row.model}|${row.thinking}`);
      expect(e, `unexpected model row ${row.source}|${row.provider}|${row.model}|${row.thinking}`).toBeDefined();
      expectPriceAndCounts(row, e!, { nullWhenAllUnpriced: true });
      expect(row.displayName).toBe(e!.displayName);
    }
    for (let i = 1; i < s.byModel.length; i++) expect(s.byModel[i - 1]!.events).toBeGreaterThanOrEqual(s.byModel[i]!.events);
    expect(s.byModel.reduce((n, r) => n + r.events, 0)).toBe(s.totals.events);
  });

  it('time basis fences the clock and counts what it excluded; active time follows the marks', async () => {
    const s = await mem.queries.getSummary(range);
    const x = expectedSummary(range);
    expect(s.timeBasis).toEqual({ startMs: x.timeBasis.startMs, asOfMs: NOW, endInclusive: true, timestampBasis: 'recorded-timestamps',
      excludedFutureEvents: 1, excludedFutureActivity: 1 });
    expect(s.activeTime.wallMs).toBe(x.wallMs);
    expect(s.activeTime.agentMs).toBe(x.agentMs);
  });
});

describe.each(RANGES)('Summary local block, range %s', (range) => {
  it('reports the comparator value as unavailable, never $0', async () => {
    const s = await mem.queries.getSummary(range);
    const local = eventsIn(range).filter((e) => e.provider === 'local');
    expect(local.length).toBeGreaterThan(0);
    expect(s.local.captured).toBe(true);
    for (const v of [s.local.valueVsClaude, s.local.valueVsGpt]) {
      expect(v.usd, 'no comparator value is computed in this edition: unknown, not zero').toBeNull();
      expect(v.status).toBe('NONE');
    }
    expect(s.local.netSavingsVsClaude).toBeNull();
    expect(s.local.netSavingsVsGpt).toBeNull();
    expect(s.local.energy).toEqual({ kwh: null, usd: null, status: 'NONE' });
    // The local model's own API-equivalent dollars are a priced zero, which is a different statement.
    expect(s.byModel.find((r) => r.provider === 'local')!.apiEquivUsd).toBe(0);
  });
});

describe.each(RANGES)('Timeseries, range %s, against the oracle', (range) => {
  it.each(['hour', 'day'] as const)('%s buckets: time, dollars, tokens, count and price quality', async (bucket) => {
    const ts = await mem.queries.getTimeseries(bucket, range);
    const bucketMs = bucket === 'hour' ? HOUR : DAY;
    const x = expectedTimeseries(range, bucketMs);
    expect(ts).toMatchObject({ bucket, range, generatedAt: NOW, priceQualityCounts: true });
    expect(ts.timeBasis).toEqual(expect.objectContaining({ startMs: rangeStart(range, NOW), asOfMs: NOW, excludedFutureEvents: 1 }));
    expect(ts.points.map((p) => p.t)).toEqual(x.map((p) => p.t));
    ts.points.forEach((p, i) => {
      const e = x[i]!;
      expectMoney(p.apiEquivUsd, e.apiEquivUsd, `t=${p.t} apiEquivUsd`);
      expect(p.tokens, `t=${p.t} tokens`).toBe(e.tokens);
      expect(p.totalTokens, `t=${p.t} totalTokens`).toBe(e.totalTokens);
      expect(p.countQuality, `t=${p.t} countQuality`).toBe(e.countQuality);
      expect(p.unpricedEvents, `t=${p.t} unpriced`).toBe(e.unpricedEvents);
      expect(p.estimatedPriceEvents, `t=${p.t} estimated`).toBe(e.estimatedPriceEvents);
      expect(p.priceStatus, `t=${p.t} priceStatus`).toBe(e.priceStatus);
      expect(Object.keys(p.bySource).sort()).toEqual(Object.keys(e.bySource).sort());
      for (const [source, usd] of Object.entries(e.bySource)) expectMoney((p.bySource as any)[source], usd, `t=${p.t} ${source}`);
    });
    // The Summary and the series cover the same cohort: dollars and counts add up across the two responses.
    const s = await mem.queries.getSummary(range);
    expect(near(ts.points.reduce((n, p) => n + p.apiEquivUsd, 0), s.totals.apiEquivUsd)).toBe(true);
    expect(ts.points.reduce((n, p) => n + p.unpricedEvents!, 0)).toBe(s.totals.unpricedEvents);
    expect(ts.points.reduce((n, p) => n + p.estimatedPriceEvents!, 0)).toBe(s.totals.estimatedPriceEvents);
  });
});


describe.each(RANGES)('Sessions, range %s, against the oracle', (range) => {
  it('one row per host + source + session with the oracle values (synchronous path)', async () => {
    expectSessionsResponse(await mem.queries.getSessions({ range, activeOnly: false }), range);
  });
  it('the daemon pinned-snapshot path returns the same Sessions as the synchronous path', async () => {
    const snap = await file.withSnapshot((q) => q.getSessions({ range, activeOnly: false }));
    expectSessionsResponse(snap, range);
    expect(json(snap)).toEqual(json(await mem.queries.getSessions({ range, activeOnly: false })));
  });
});

describe.each(RANGES)('Unified Usage pair, range %s (pinned snapshot, as the daemon builds it)', (range) => {
  it('one clock, one time basis, the same cohort in Summary and Timeseries, equal to the synchronous reads', async () => {
    const pair = await file.withSnapshot((q) => usagePair(q, range));
    const expected = expectedSummary(range);
    expect(pair.snapshotScope).toBe('shared-read-transaction');
    expect(pair.summary.generatedAt).toBe(NOW);
    expect(pair.timeseries.generatedAt).toBe(NOW);
    expect(pair.timeseries.timeBasis).toEqual(pair.summary.timeBasis);
    expect(pair.timeseries.bucket).toBe(usageBucketMs(range) === HOUR ? 'hour' : 'day');
    expectPriceAndCounts(pair.summary.totals, expected.totals, { nullWhenAllUnpriced: false });
    for (const row of pair.summary.byModel) {
      const key = `${row.source}|${row.provider}|${row.model}|${row.thinking}`;
      const oracleRow = expected.byModel.get(key);
      expect(oracleRow, `unexpected rendered model row ${key}`).toBeDefined();
      const copy = usageModelRowCopy(row);
      const expectedSource = ({ claude: 'Claude', codex: 'Codex', 'ollama-proxy': 'Local proxy', 'ollama-log': 'Local server log', bench: 'Bench', 'qwen-code': 'Qwen Code' } as Record<string, string>)[oracleRow!.source];
      const expectedProvider = row.provider === 'openai' ? 'OpenAI' : row.provider === 'anthropic' ? 'Anthropic' : row.provider === 'local' ? 'Local' : row.provider;
      expect(copy.name).toBe(`${oracleRow!.displayName} · ${row.thinking === 'unknown' ? 'mode unknown' : row.thinking}`);
      expect(copy.source).toBe(expectedSource);
      expect(copy.provider).toBe(expectedProvider);
      expect(copy.detailsIdentity).toBe(`Model ${oracleRow!.model} · ${expectedSource} · ${expectedProvider} · ${oracleRow!.events.toLocaleString()} recorded ${oracleRow!.events === 1 ? 'event' : 'events'}`);
      const expectedTotal = oracleRow!.tokens.inputFresh + oracleRow!.tokens.cacheWrite5m + oracleRow!.tokens.cacheWrite1h + oracleRow!.tokens.cacheRead + oracleRow!.tokens.output;
      const expectedTokenLabel = unresolvedQuality(oracleRow!.countQuality) ? 'Unavailable' : `${expectedTotal >= 1000 ? '≈' : ''}${formatCompactNumber(expectedTotal)}`;
      expect(copy.tokenSubtotal).toBe(expectedTotal);
      expect(copy.categories.inputFresh.split(' · ')[0]).toBe(oracleRow!.tokens.inputFresh.toLocaleString());
      expect(copy.categories.cacheWrite5m.split(' · ')[0]).toBe(oracleRow!.tokens.cacheWrite5m.toLocaleString());
      expect(copy.categories.cacheWrite1h.split(' · ')[0]).toBe(oracleRow!.tokens.cacheWrite1h.toLocaleString());
      expect(copy.categories.cacheRead.split(' · ')[0]).toBe(oracleRow!.tokens.cacheRead.toLocaleString());
      expect(copy.categories.output.split(' · ')[0]).toBe(oracleRow!.tokens.output.toLocaleString());
      expect(copy.categories.reasoning.split(' · ')[0]).toBe(oracleRow!.tokens.reasoning.toLocaleString());
      expect(copy.summaryCount).toBe(expectedTokenLabel);
      expect(copy.summaryCountTitle).toBe(copy.countBasis);
      if (unresolvedQuality(oracleRow!.countQuality)) {
        expect(copy.countBasis.startsWith(`Complete token total unavailable · ${oracleRow!.countQuality} count evidence`)).toBe(true);
      } else if (oracleRow!.countQuality === 'unrecorded') {
        expect(copy.countBasis.startsWith('Count evidence unrecorded')).toBe(true);
      } else {
        expect(copy.countBasis.startsWith('Reported')).toBe(true);
      }
      const categoryHeading = unresolvedQuality(oracleRow!.countQuality) || row.tokens.fieldEvidence ? 'Normalized category subtotal' : 'Usage token categories';
      expect(copy.categoryLine.startsWith(`${categoryHeading} ${expectedTotal.toLocaleString()} ·`)).toBe(true);
      expect(copy.categoryLine).toContain(`fresh input ${oracleRow!.tokens.inputFresh.toLocaleString()}`);
      expect(copy.categoryLine).toContain(`cache write (5 min) ${oracleRow!.tokens.cacheWrite5m.toLocaleString()}`);
      expect(copy.categoryLine).toContain(`cache write (1 hr, including assumptions) ${oracleRow!.tokens.cacheWrite1h.toLocaleString()}`);
      expect(copy.categoryLine).toContain(`cache read ${oracleRow!.tokens.cacheRead.toLocaleString()}`);
      expect(copy.categoryLine).toContain(`output ${oracleRow!.tokens.output.toLocaleString()}`);
      expect(copy.reasoningLine).toContain(`Recorded reasoning ${oracleRow!.tokens.reasoning.toLocaleString()}`);
      expect(copy.reasoningLine.endsWith('is part of output and is not added to usage tokens again.')).toBe(true);
      expect(copy.priceStatus).toBe(oracleRow!.priceStatus);
      if (oracleRow!.allUnpriced) {
        expect(copy.summaryValue).toBe('—');
        expect(copy.apiValuePrefix).toBe('API-equivalent value unavailable · ');
      } else {
        expect(copy.summaryValue).toBe(formatPreciseMoney(oracleRow!.apiEquivUsd));
        expect(copy.apiValuePrefix).toBe(`Recorded API-equivalent $${oracleRow!.apiEquivUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })} · `);
      }
      if (row.provider === 'local') {
        const localCopy = usageModelRowCopy(row, 'local');
        expect(localCopy.identity).toBe(`${copy.name}, ${oracleRow!.model}, ${expectedSource}`);
        expect(localCopy.summaryCount).toBe(formatCompactNumber(oracleRow!.events));
        expect(localCopy.summaryCountTitle).toBe(copy.countBasis);
        expect(localCopy.summaryValue).toBe(expectedTokenLabel);
        expect(localCopy.summaryValueTitle).toBe(copy.countBasis);
      }
    }
    const x = expectedTimeseries(range, usageBucketMs(range));
    expect(pair.timeseries.points.map((p) => [p.t, p.unpricedEvents, p.estimatedPriceEvents])).toEqual(x.map((p) => [p.t, p.unpricedEvents, p.estimatedPriceEvents]));
    const memory = { summary: await mem.queries.getSummary(range), timeseries: await mem.queries.getTimeseries(pair.timeseries.bucket, range) };
    expect(json(pair.summary)).toEqual(json(memory.summary));
    expect(json(pair.timeseries)).toEqual(json(memory.timeseries));
  });
});

function unresolvedQuality(quality: string | undefined): boolean {
  return quality === 'incomplete' || quality === 'invalid' || quality === 'conflict';
}

describe('Limits (Claude five-hour block estimate), against the oracle', () => {
  it.each([HOST_A, HOST_B])('host %s: block window, tokens, dollars, burn and projection', async (host) => {
    const limits = await mem.queries.getLimits();
    const snaps = limits.snapshots.filter((s) => s.source === 'claude-block-estimate');
    expect(snaps.map((s) => s.host).sort()).toEqual([HOST_A, HOST_B]);
    const snap = snaps.find((s) => s.host === host)!;
    const x = expectedBlock(host)!;
    const w = snap.windows[0]!;
    expect(snap.estimate).toBe(true);
    expect(snap.capturedAt).toBe(NOW);
    expect(w).toMatchObject({ id: 'block_estimate', windowMinutes: 300, startedAt: x.startedAt, resetsAt: x.resetsAt, tokens: x.tokens });
    expect(w.usedPercent, 'no quota is known locally: unavailable, never a percentage').toBeNull();
    expect(w.countQuality).toBe(x.countQuality);
    expectMoney(w.apiEquivUsd ?? null, x.apiEquivUsd, 'block usd');
    expect(w.burnTokensPerMin).toBeCloseTo(x.burnTokensPerMin, 9);
    expect(w.projectedTokens).toBeCloseTo(x.projectedTokens, 9);
    expectMoney(w.projectedUsd ?? null, x.projectedUsd, 'projected usd');
    expect(snap.contributors).toMatchObject(expectedLimitContributors(host));
  });
  it('the block is not aligned to the clock hour or the day: the oracle shows the 11:00 block on HOST-A and the ended 10:00 block on HOST-B', () => {
    expect(new Date(expectedBlock(HOST_A)!.startedAt).toISOString()).toBe('2026-10-18T11:00:00.000Z');
    expect(new Date(expectedBlock(HOST_B)!.resetsAt).toISOString()).toBe('2026-10-18T15:00:00.000Z');
    expect(expectedBlock(HOST_B)!.resetsAt).toBeLessThan(NOW);
  });
});

describe('boundary and zone cases', () => {
  it('"today" follows LOCAL midnight, not UTC midnight (Asia/Kolkata, UTC+05:30)', async () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Asia/Kolkata';
    try {
      expect(new Date(NOW).getTimezoneOffset(), 'this runner cannot switch the process time zone').toBe(-330);
      const clock = Date.UTC(2026, 9, 18, 15, 30); // 21:00 on 2026-10-18 in Kolkata
      const localMidnight = Date.UTC(2026, 9, 17, 18, 30); // 2026-10-18T00:00 local
      expect(rangeStart('today', clock)).toBe(localMidnight);
      const { SqliteLedger } = await import('../../src/store/ledger.js');
      const { openDb } = await import('../../src/store/db.js');
      const { createQueries } = await import('../../src/store/queries.js');
      const { defaultConfig } = await import('../../src/daemon/config.js');
      const { toUsageEvent, buildEngines } = await import('./cohort.js');
      const engines = buildEngines();
      const db = openDb({ file: ':memory:' });
      try {
        const base = COHORT.find((c) => c.id === 'e06')!;
        new SqliteLedger(db, engines.pricing, engines.valuationEngine).upsertEvents([
          { ...base, id: 'z1', ts: localMidnight - 1, session: 'z' }, { ...base, id: 'z2', ts: localMidnight, session: 'z' }, { ...base, id: 'z3', ts: clock, session: 'z' },
        ].map(toUsageEvent));
        const q = createQueries(db, defaultConfig({ hostLabel: HOST_A }), { now: () => clock, pricing: engines.pricing, probeOllama: stubProbe });
        const today = await q.getSummary('today');
        expect(today.totals.events, 'only the two records at or after local midnight').toBe(2);
        expect(today.timeBasis!.startMs).toBe(localMidnight);
        expect((await q.getSummary('24h')).totals.events).toBe(3);
      } finally { db.close(); }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });

  it('an empty ledger is a known empty scope: zero events, no price status, no count quality, empty series and sessions', async () => {
    const { openDb } = await import('../../src/store/db.js');
    const { createQueries } = await import('../../src/store/queries.js');
    const { defaultConfig } = await import('../../src/daemon/config.js');
    const { buildEngines } = await import('./cohort.js');
    const engines = buildEngines();
    const db = openDb({ file: ':memory:' });
    try {
      const q = createQueries(db, defaultConfig({ hostLabel: HOST_A }), { now: () => NOW, pricing: engines.pricing, probeOllama: stubProbe });
      for (const range of RANGES) {
        const s = await q.getSummary(range);
        expect(s.totals).toMatchObject({ events: 0, apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null });
        expect(s.totals.tokens.countQuality, 'an empty scope records no count quality').toBeUndefined();
        expect(s.byModel).toEqual([]);
        const ts = await q.getTimeseries('day', range);
        expect(ts.points).toEqual([]);
        expect(ts.priceQualityCounts, 'the explicit capability that makes an empty series a known zero').toBe(true);
        expect((await q.getSessions({ range, activeOnly: false })).sessions).toEqual([]);
      }
    } finally { db.close(); }
  });
});
