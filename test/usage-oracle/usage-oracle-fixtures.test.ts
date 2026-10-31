/**
 * Usage API oracle, paired response fixtures and the renderer side.
 *
 *  1. Golden fixtures (test/fixtures/usage-oracle-2026-10-18/): the committed JSON equals what the real code returns for the
 *     cohort today. A normal run only reads and compares; drift fails loudly. Regeneration is opt-in (see the README there).
 *  2. The committed fixtures themselves satisfy the oracle (so a hand edit of a fixture cannot drift from the cohort).
 *  3. The real tray api-client in mock mode serves the same files (the offscreen-snapshot path), including the Fleet overview.
 *  4. The renderer's PURE modules (formatters, evidence and label builders) are fed those same fixtures and must show the
 *     numbers and qualifiers of the same cohort: unpriced is unavailable not $0, an incomplete count is unavailable not 0, a
 *     partial figure says partial. DOM code in app.ts is not exercised here (see NOTES.md for the screens that means).
 *  5. The comparison helpers reject wrong responses (guards against tests that would pass on any input).
 *
 * Fabricated data only. Nothing here establishes native screen acceptance, accessibility, real prices or capture completeness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/tray/api-client.js';
import { activityTimeLabel } from '../../src/tray/renderer/activity-time.js';
import { CHART_SOURCES, describePoint } from '../../src/tray/renderer/charts.js';
import { burnMoneyText } from '../../src/tray/renderer/detail-burn.js';
import { dollarSourceEvidence } from '../../src/tray/renderer/dollar-source-evidence.js';
import { formatApiEquivSubtotal, formatDuration, formatMoney } from '../../src/tray/renderer/format.js';
import { isRangeScopedTab } from '../../src/tray/renderer/initial-scope.js';
import { aggregatePriceFields, priceFieldState } from '../../src/tray/renderer/price-evidence.js';
import { priceEvidenceLabel } from '../../src/tray/renderer/quality.js';
import { recordedWindowDisclosure } from '../../src/tray/renderer/recorded-window.js';
import { usageResponseEvidence } from '../../src/tray/renderer/response-evidence.js';
import { aggregateTokenText, exactTokenLabel, hasKnownEmptyUsage, tokenTotalText } from '../../src/tray/renderer/token-counts.js';
import { tokenPeriodEvidence } from '../../src/tray/renderer/token-period.js';
import { usageComparisonCopy, usageQueryClockCopy } from '../../src/tray/renderer/usage-comparison-copy.js';
import { usageTimelineEmptyCaption } from '../../src/tray/renderer/usage-empty.js';
import { COHORT, COHORT_MARKS, HOST_A, NOW, PRICE_BOOK, RANGES, type RangeName } from './cohort.js';
import { effectiveQuality, expectedSessions, expectedSummary, expectedTimeseries, rangeStart, unresolved, usageBucketMs, type ExpectedSession } from './oracle.js';
import { expectMoney, expectPriceAndCounts, expectSession, expectSessionsResponse } from './expectations.js';
import { API_FIXTURE_DIR, checkFixture, openFileCohort, readFixture, stubProbe, usagePair, type FileCohort } from './harness.js';

const savedTz = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

let file: FileCohort;
beforeAll(() => { file = openFileCohort(); });
afterAll(() => file?.close());

const summaryOf = (range: RangeName) => readFixture(`api/summary-${range}.json`);
const seriesOf = (range: RangeName) => readFixture(`api/timeseries-${range}.json`);
const sessionsOf = (range: RangeName) => readFixture(`api/sessions-${range}.json`);

// ── 1. golden fixtures ──────────────────────────────────────────────────────────────────────────────────────────
describe('golden fixtures equal the live responses for the cohort', () => {
  it('cohort.json is the cohort table (inputs next to outputs)', () => {
    checkFixture('cohort.json', { clock: new Date(NOW).toISOString(), timeZone: 'UTC', events: COHORT, activityMarks: COHORT_MARKS, priceBook: PRICE_BOOK });
  });
  it.each(RANGES)('summary, timeseries (the bucket the Usage tab pairs) and sessions for %s', async (range) => {
    const pair = await file.withSnapshot((q) => usagePair(q, range));
    checkFixture(`api/summary-${range}.json`, pair.summary);
    checkFixture(`api/timeseries-${range}.json`, pair.timeseries);
    checkFixture(`api/sessions-${range}.json`, await file.withSnapshot((q) => q.getSessions({ range, activeOnly: false })));
  });
  it('limits.json (Claude five-hour block estimates)', async () => {
    checkFixture('api/limits.json', await file.queries.getLimits());
  });
});

// ── 2. committed fixtures satisfy the oracle ────────────────────────────────────────────────────────────────────
describe.each(RANGES)('committed fixtures for %s satisfy the oracle', (range) => {
  it('summary, timeseries and sessions describe the same cohort', () => {
    const s = summaryOf(range);
    const x = expectedSummary(range);
    expect(s.range).toBe(range);
    expectPriceAndCounts(s.totals, x.totals, { nullWhenAllUnpriced: false });
    expect(s.timeBasis.startMs).toBe(rangeStart(range, NOW));
    const t = seriesOf(range);
    expect(t.range).toBe(range);
    expect(t.bucket).toBe(usageBucketMs(range) === 3_600_000 ? 'hour' : 'day');
    expect(t.generatedAt).toBe(s.generatedAt);
    expect(t.timeBasis).toEqual(s.timeBasis);
    expect(t.points.map((p: any) => p.t)).toEqual(expectedTimeseries(range, usageBucketMs(range)).map((p) => p.t));
    expectSessionsResponse(sessionsOf(range), range);
    expect(sessionsOf(range).generatedAt).toBe(s.generatedAt);
  });
});

// ── 3. mock mode of the real api-client (what the offscreen snapshots read) ─────────────────────────────────────
describe('the real api-client in strict mock mode serves exactly these files', () => {
  const client = () => createApiClient({ mockDir: API_FIXTURE_DIR, strictMockRanges: true, env: {} });
  it.each(RANGES)('getUsage(%s) is a filed fixture pair with one range and one clock', async (range) => {
    const usage = await client().getUsage(range);
    expect(usage.snapshotScope).toBe('filed-fixture');
    expect(usage.summary).toEqual(summaryOf(range));
    expect(usage.timeseries).toEqual(seriesOf(range));
    expect(usageResponseEvidence(usage.summary, usage.timeseries).numeric).toBe('match');
  });
  it.each(RANGES)('getFleetOverview(%s) is aggregate-only and carries the same totals', async (range) => {
    const overview = await client().getFleetOverview(range);
    expect(overview.hosts).toHaveLength(1);
    const summary = overview.hosts[0]!.summary!;
    expect(Object.keys(summary).sort()).toEqual(['activeTime', 'bySource', 'generatedAt', 'host', 'range', 'totals']);
    expect(summary.totals).toEqual(summaryOf(range).totals);
    expect(summary.bySource).toEqual(summaryOf(range).bySource);
    expect(JSON.stringify(summary), 'no session ids, projects or model rows leave the host').not.toMatch(/claude-s|codex-t|\/synthetic\/|oracle-opus|oracle-unlisted/);
    // The Fleet card reads totals through these pure helpers.
    expect(aggregateTokenText([summary.totals.tokens]).text).toBe('Unavailable');
    const fields = aggregatePriceFields([summary.totals]);
    expect(fields.usable).toBe(true);
    expect(fields.priceEvidence).toMatchObject({ events: expectedSummary(range).totals.events, issuesEvents: 0 });
  });
});

// ── 4. renderer pure modules on the same fixtures ───────────────────────────────────────────────────────────────
/** The documented display rule (renderer/format.ts formatMoney): cents and above as $x.xx; a nonzero amount under one cent is never shown as $0.00. */
const moneyText = (usd: number) => (usd === 0 ? '$0.00' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);
const compact = (n: number) => (n >= 1000 ? `≈${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const priceLabel = (unpriced: number, estimated: number, status: string | null): string | null => {
  const parts: string[] = [];
  if (unpriced > 0) parts.push(`Partial · ${unpriced} unpriced`);
  if (estimated > 0) parts.push(`${estimated} ${estimated === 1 ? 'event uses' : 'events use'} estimated prices`);
  return parts.length ? parts.join(' · ') : status === 'LIST' ? null : 'unexpected';
};

describe.each(RANGES)('renderer figures for %s come from the same cohort', (range) => {
  it('token period: known category subtotal is shown, the complete total is unavailable (not zero) because count evidence is unresolved', () => {
    const s = summaryOf(range);
    const x = expectedSummary(range);
    const ev = tokenPeriodEvidence(s, range);
    const cats = x.totals.tokens;
    const known = cats.inputFresh + cats.cacheWrite5m + cats.cacheWrite1h + cats.cacheRead + cats.output;
    expect(unresolved(x.totals.countQuality!)).toBe(true);
    expect(ev.sourceState, 'by-source rows add up to the totals').toBe('match');
    expect(ev.empty).toBe(false);
    expect(ev.totalAvailable).toBe(false);
    expect(ev.subtotal).toBe(known);
    expect(ev.headline).toBe('Complete token total');
    expect(ev.basis).toBe(`Complete token total unavailable · ${x.totals.countQuality} count evidence`);
    expect(tokenTotalText(s.totals.tokens)).toBe('Unavailable');
    expect(exactTokenLabel(s.totals.tokens)).toBe(`Known category subtotal; complete total unavailable: ${known.toLocaleString()} tokens · Complete token total unavailable · ${x.totals.countQuality} count evidence`);
    expect(hasKnownEmptyUsage(s.totals.tokens, s.totals.events)).toBe(false);
    expect(ev.components.find((c) => c.key === 'inputFresh')!.value).toBe(cats.inputFresh);
    expect(ev.components.find((c) => c.key === 'cacheRead')!.value).toBe(cats.cacheRead);
  });

  it('per source: sources whose events are all complete show a total; the source holding the incomplete event does not', () => {
    const s = summaryOf(range);
    const x = expectedSummary(range);
    for (const [source, a] of x.bySource) {
      const known = a.tokens.inputFresh + a.tokens.cacheWrite5m + a.tokens.cacheWrite1h + a.tokens.cacheRead + a.tokens.output;
      const text = tokenTotalText(s.bySource[source].tokens);
      if (unresolved(a.countQuality!)) expect(text, source).toBe('Unavailable');
      else expect(text, source).toBe(compact(known));
    }
    expect(tokenTotalText(s.bySource.claude.tokens)).toBe('Unavailable');
    expect(tokenTotalText(s.bySource.codex.tokens)).not.toBe('Unavailable');
  });

  it('dollars: the priced subtotal is shown with a "partial" qualifier and the estimated-price count; never as a complete value', () => {
    const s = summaryOf(range);
    const x = expectedSummary(range).totals;
    expect(priceFieldState(s.totals)).toBe('checked');
    expect(formatApiEquivSubtotal(s.totals)).toBe(moneyText(x.apiEquivUsd));
    expect(priceEvidenceLabel(s.totals)).toBe(priceLabel(x.unpricedEvents, x.estimatedPriceEvents, x.priceStatus));
    expect(priceEvidenceLabel(s.totals)).toContain(`Partial · ${x.unpricedEvents} unpriced`);
  });

  it('model rows: all-unpriced rows are unavailable (—), a priced zero is $0.00, estimates and partial rows are labelled', () => {
    const s = summaryOf(range);
    const x = expectedSummary(range);
    for (const row of s.byModel) {
      const e = x.byModel.get(`${row.source}|${row.provider}|${row.model}|${row.thinking}`)!;
      const figure = { apiEquivUsd: row.apiEquivUsd, events: row.events, unpricedEvents: row.unpricedEvents, priceEvidence: row.priceEvidence };
      if (e.allUnpriced) {
        expect(row.apiEquivUsd, `${row.model} stored`).toBeNull();
        expect(formatApiEquivSubtotal(figure), `${row.model} shown`).toBe('—');
      } else expect(formatApiEquivSubtotal(figure), `${row.model} shown`).toBe(moneyText(e.apiEquivUsd));
      expect(priceEvidenceLabel(row), row.model).toBe(priceLabel(e.unpricedEvents, e.estimatedPriceEvents, e.priceStatus));
    }
    const local = s.byModel.find((r: any) => r.model === 'oracle-local-27b');
    expect(local.apiEquivUsd).toBe(0);
    expect(formatApiEquivSubtotal({ apiEquivUsd: local.apiEquivUsd, events: local.events, unpricedEvents: local.unpricedEvents, priceEvidence: local.priceEvidence })).toBe('$0.00');
    expect(priceEvidenceLabel(local)).toBeNull();
    const unlisted = s.byModel.find((r: any) => r.model === 'oracle-unlisted');
    expect(formatApiEquivSubtotal({ apiEquivUsd: unlisted.apiEquivUsd, events: unlisted.events, unpricedEvents: unlisted.unpricedEvents, priceEvidence: unlisted.priceEvidence })).toBe('—');
  });

  it('the table and the chart agree (dollars, unpriced and estimated counts, per-source dollars) and the query clocks are identical', () => {
    const s = summaryOf(range);
    const t = seriesOf(range);
    const evidence = usageResponseEvidence(s, t);
    const x = expectedSummary(range).totals;
    expect(evidence).toMatchObject({ range: { state: 'same' }, numeric: 'match', apiEquivUsd: { state: 'match' }, unpricedEvents: { state: 'match', summary: x.unpricedEvents, timeseries: x.unpricedEvents },
      estimatedPriceEvents: { state: 'match', summary: x.estimatedPriceEvents, timeseries: x.estimatedPriceEvents }, timestamps: { differenceMs: 0 } });
    expect(usageQueryClockCopy(evidence)).toBeNull();
    const sources = dollarSourceEvidence(t.points, CHART_SOURCES);
    expect(sources.state).toBe('consistent');
    expect(usageComparisonCopy(evidence, sources, [s.totals])).toEqual({ label: 'Compared figures agree · stored price fields checked', warn: false });
    expect(usageTimelineEmptyCaption(s, t)).toBeNull();
  });

  it('every chart bucket is qualified by its own unpriced and estimated counts; an all-unpriced bucket reads $0.00 only beside "Partial · N unpriced"', () => {
    const t = seriesOf(range);
    const bucket = t.bucket as 'hour' | 'day';
    const x = expectedTimeseries(range, usageBucketMs(range));
    expect(t.points).toHaveLength(x.length);
    t.points.forEach((p: any, i: number) => {
      const e = x[i]!;
      expect(priceEvidenceLabel(p), `t=${p.t}`).toBe(priceLabel(e.unpricedEvents, e.estimatedPriceEvents, e.priceStatus));
      expectMoney(p.apiEquivUsd, e.apiEquivUsd, `t=${p.t}`);
    });
    const onlyUnpriced = x.filter((p) => p.unpricedEvents === p.events.length);
    expect(onlyUnpriced.length, 'the cohort has an all-unpriced bucket in every range except those that exclude it').toBeGreaterThanOrEqual(range === 'all' || range === '30d' ? 2 : 1);
    for (const e of onlyUnpriced) {
      const p = t.points.find((q: any) => q.t === e.t);
      expect(p.apiEquivUsd).toBe(0);
      expect(p.priceStatus).toBe('UNPRICED');
      expect(describePoint(p, CHART_SOURCES, bucket).totalText).toBe('$0.00');
      expect(priceEvidenceLabel(p)).toBe(`Partial · ${e.unpricedEvents} unpriced`);
    }
  });

  it('recorded window: the response cutoff and the count of records stamped after it are disclosed, not inferred', () => {
    const start = rangeStart(range, NOW);
    for (const basis of [summaryOf(range).timeBasis, seriesOf(range).timeBasis, sessionsOf(range).timeBasis]) {
      const d = recordedWindowDisclosure(basis);
      expect(d.state).toBe('available');
      expect(d.window).toBe(start === null ? `Recorded history through ${new Date(NOW).toISOString()} (inclusive); start unspecified.`
        : `Recorded timestamps ${new Date(start).toISOString()} to ${new Date(NOW).toISOString()} (both boundaries included).`);
      expect(d.exclusions).toBe('Later timestamps excluded — events: 1; activity records: 1.');
    }
  });

  it('sessions: active-time wording follows each row\'s recorded basis; burn wording follows its own window', () => {
    const rows = sessionsOf(range).sessions as any[];
    for (const e of expectedSessions(range)) {
      const row = rows.find((r) => r.host === e.host && r.source === e.source && r.sessionId === e.sessionId);
      const label = activityTimeLabel(row).text;
      if (e.activityBasis === 'no-marks') expect(label, e.key).toBe('active — · no activity marks');
      else if (e.activityBasis === 'reported-turn-durations') expect(label, e.key).toBe(`turn time ${formatDuration(e.activeMs)} · summed`);
      else expect(label, e.key).toBe(`active ${formatDuration(e.activeMs)} · activity estimate`);
      if (e.burn !== null) {
        const q = e.burn;
        const notes = [`${moneyText(q.usdPerHour)}/h`];
        if (q.unpricedEvents === q.events) expect(burnMoneyText(row.burn), e.key).toBe(`—/h · ${q.unpricedEvents} unpriced ${q.unpricedEvents === 1 ? 'event' : 'events'}`);
        else {
          if (q.unpricedEvents > 0) notes.push(`Partial · ${q.unpricedEvents} unpriced ${q.unpricedEvents === 1 ? 'event' : 'events'}`);
          if (q.estimatedPriceEvents > 0) notes.push(`${q.estimatedPriceEvents} ${q.estimatedPriceEvents === 1 ? 'event uses' : 'events use'} estimated prices`);
          expect(burnMoneyText(row.burn), e.key).toBe(notes.join(' · '));
        }
      } else expect(row.burn, e.key).toBeNull();
    }
  });

  it('sessions: all-unpriced rows are unavailable (—); an activity-only row is explicitly an empty feed, not unknown telemetry', () => {
    const rows = sessionsOf(range).sessions as any[];
    const s3 = rows.find((r) => r.sessionId === 'claude-s3');
    expect(s3.apiEquivUsd).toBeNull();
    expect(formatApiEquivSubtotal({ apiEquivUsd: s3.apiEquivUsd, events: s3.telemetry[0].events, unpricedEvents: s3.unpricedEvents, priceEvidence: s3.priceEvidence })).toBe('—');
    expect(s3.priceStatus).toBe('UNPRICED');
    const idle = rows.find((r) => r.sessionId === 'claude-idle');
    expect(idle).toMatchObject({ telemetry: [], priceStatus: null, unpricedEvents: 0, estimatedPriceEvents: 0, burn: null });
    expect(idle.tokens.countQuality, 'no events: no count evidence is claimed').toBeUndefined();
  });
});

describe('renderer wording for scopes the cohort does not populate', () => {
  it('an empty ledger is a known empty scope; the same series without the capability is only "not provided"', async () => {
    const { openDb } = await import('../../src/store/db.js');
    const { createQueries } = await import('../../src/store/queries.js');
    const { defaultConfig } = await import('../../src/daemon/config.js');
    const db = openDb({ file: ':memory:' });
    try {
      const q = createQueries(db, defaultConfig({ hostLabel: HOST_A }), { now: () => NOW, pricing: file.engines.pricing, probeOllama: stubProbe });
      const summary = JSON.parse(JSON.stringify(await q.getSummary('7d')));
      const series = JSON.parse(JSON.stringify(await q.getTimeseries('day', '7d')));
      expect(tokenPeriodEvidence(summary, '7d')).toMatchObject({ empty: true, basis: 'No usage events recorded in this scope' });
      expect(usageTimelineEmptyCaption(summary, series)).toBe('No usage events recorded for this timeline.');
      const { priceQualityCounts: _dropped, ...legacy } = series;
      expect(usageTimelineEmptyCaption(summary, legacy as typeof series)).toBe('No API-equivalent timeline points were provided.');
      expect(formatApiEquivSubtotal(summary.totals), 'a known-empty scope is a real zero').toBe('$0.00');
    } finally { db.close(); }
  });

  it('the seven tabs: exactly the four range-scoped tabs take the range control', () => {
    const tabs = ['now', 'sessions', 'usage', 'local', 'limits', 'coverage', 'fleet'];
    expect(tabs.filter(isRangeScopedTab)).toEqual(['sessions', 'usage', 'local', 'fleet']);
  });
});

// ── 5. the comparison helpers reject wrong responses ────────────────────────────────────────────────────────────
describe('the oracle comparison is not trivially true', () => {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const today = () => ({ summary: clone(summaryOf('today')), x: expectedSummary('today') });
  it('catches an unpriced model row reported as $0', () => {
    const { summary, x } = today();
    const row = summary.byModel.find((r: any) => r.model === 'oracle-unlisted');
    expect(() => expectPriceAndCounts(row, x.byModel.get(`${row.source}|${row.provider}|${row.model}|${row.thinking}`)!, { nullWhenAllUnpriced: true })).not.toThrow();
    row.apiEquivUsd = 0;
    expect(() => expectPriceAndCounts(row, x.byModel.get(`${row.source}|${row.provider}|${row.model}|${row.thinking}`)!, { nullWhenAllUnpriced: true })).toThrow();
  });
  it('catches a dropped unpriced count, a lost boundary event and a count quality shown as complete', () => {
    for (const mutate of [(t: any) => { t.unpricedEvents -= 1; }, (t: any) => { t.events -= 1; }, (t: any) => { t.tokens.countQuality = 'complete'; }, (t: any) => { t.tokens.inputFresh += 1; }]) {
      const { summary, x } = today();
      mutate(summary.totals);
      expect(() => expectPriceAndCounts(summary.totals, x.totals, { nullWhenAllUnpriced: false })).toThrow();
    }
  });
  it('catches a wrong session range window, active time or live flag', () => {
    const rows = clone(sessionsOf('7d')) as any;
    const x = expectedSessions('7d');
    const find = (e: ExpectedSession) => rows.sessions.find((r: any) => r.host === e.host && r.source === e.source && r.sessionId === e.sessionId);
    const e = x.find((s) => s.sessionId === 'claude-s1' && s.host === HOST_A)!;
    expect(() => expectSession(find(e), e)).not.toThrow();
    for (const mutate of [(r: any) => { r.start += 1; }, (r: any) => { r.activeMs += 1; }, (r: any) => { r.live = !r.live; }, (r: any) => { r.estimatedPriceEvents = 0; }]) {
      const copy = clone(find(e));
      mutate(copy);
      expect(() => expectSession(copy, e)).toThrow();
    }
  });
  it('a legacy row with no recorded count quality is read as unrecorded', () => {
    expect(effectiveQuality(COHORT.find((c) => c.id === 'e10')!)).toBe('unrecorded');
  });
});
