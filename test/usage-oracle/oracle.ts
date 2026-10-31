/**
 * The Usage oracle: expected API values computed from the cohort TABLE (./cohort.ts) by plain TypeScript, from the
 * documented rules only. It imports no aggregation, pricing, session or query code from src/. The rules it
 * encodes, and where each is documented:
 *
 *  - Range window (core/query-range.ts doc, DESIGN section 15.7): an event is in a range when ts >= start and
 *    ts <= the query clock. "today" starts at LOCAL midnight (built here from calendar parts, a different formulation
 *    than the product's setHours); "24h/7d/30d" are fixed spans back from the clock; "all" has no start. A record
 *    stamped after the clock is excluded from every range and counted in timeBasis.excludedFuture*.
 *  - Price (core/pricing.ts doc): USD = sum(tokens x per-million rate) / 1e6 over input, 5m write, 1h write, cache
 *    read and output. A model with no price row is UNPRICED (null, never 0). Events whose count evidence is
 *    incomplete / invalid / conflict are UNPRICED. A row that bills a derived column is ESTIMATE. A local model's
 *    zero-rate row is a priced $0 (LIST).
 *  - Price quality (core/price-quality.ts doc): unpricedEvents = events with null USD; estimatedPriceEvents = priced
 *    events with status ESTIMATE; status = UNPRICED if any unpriced, else ESTIMATE if any estimated, else LIST,
 *    and null when there are no events.
 *  - Count quality (core/types.ts, core/token-counts.ts doc): complete < unrecorded < incomplete < invalid <
 *    conflict; an aggregate carries the weakest member. A row with none recorded reads as 'unrecorded'.
 *  - Valuation: this edition reports no valuation, so the oracle derives none, and every new stored row carries the
 *    neutral reserved values (see usage-oracle-queries.test.ts).
 *  - Time buckets (store/queries.ts bucketTimeseries doc): t = floor(ts / bucketMs) x bucketMs (UTC aligned).
 *  - Sessions (core/sessions.ts doc): one row per host + source + session id; active time sums gaps between marks
 *    that are > 0 and <= the idle gap, or, for Codex, the reported turn durations when any mark has one; live means
 *    the last record is less than 5 minutes before the clock; burn covers (clock - 15 min, clock].
 *  - Claude five-hour block (core/limits.ts doc): blocks of 5 hours start at the hour of the first activity after the
 *    previous block ended; the current block is the last; tokens = sum of all token categories (excluding the
 *    reasoning subset) of the host's Claude events with ts in [start, end]; USD is null only when the block holds
 *    events and every one is unpriced.
 */
import { COHORT, COHORT_MARKS, DAY, HOUR, IDLE_GAP_MS, MINUTE, NOW, PRICE_BOOK,
  type CohortEvent, type CohortMark, type RangeName } from './cohort.js';

export type Q = 'complete' | 'unrecorded' | 'incomplete' | 'invalid' | 'conflict';
const RANK: Record<Q, number> = { complete: 0, unrecorded: 1, incomplete: 2, invalid: 3, conflict: 4 };
export const effectiveQuality = (e: CohortEvent): Q => e.quality ?? 'unrecorded';
export const unresolved = (q: Q): boolean => q === 'incomplete' || q === 'invalid' || q === 'conflict';
export function weakestQuality(qs: readonly Q[]): Q | undefined {
  let worst: Q | undefined;
  for (const q of qs) if (worst === undefined || RANK[q] > RANK[worst]) worst = q;
  return worst;
}

// ── range window ────────────────────────────────────────────────────────────────────────────────────────────
export function rangeStart(range: RangeName, now: number): number | null {
  switch (range) {
    case 'today': { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
    case '24h': return now - DAY;
    case '7d': return now - 7 * DAY;
    case '30d': return now - 30 * DAY;
    case 'all': return null;
  }
}
export const inWindow = (ts: number, start: number | null, now: number): boolean => (start === null || ts >= start) && ts <= now;
export const eventsIn = (range: RangeName, now = NOW, events: readonly CohortEvent[] = COHORT): CohortEvent[] =>
  events.filter((e) => inWindow(e.ts, rangeStart(range, now), now));
export const marksIn = (range: RangeName, now = NOW, marks: readonly CohortMark[] = COHORT_MARKS): CohortMark[] =>
  marks.filter((m) => inWindow(m.ts, rangeStart(range, now), now));

// ── price per event ───────────────────────────────────────────────────────────────────────────────────
export type PriceStatus = 'LIST' | 'ESTIMATE' | 'UNPRICED';
export function priceOf(e: CohortEvent): { usd: number | null; status: PriceStatus } {
  const row = PRICE_BOOK.find((r) => new RegExp(r.match, 'i').test(e.model));
  if (!row || unresolved(effectiveQuality(e))) return { usd: null, status: 'UNPRICED' };
  const r = row.rates;
  const usd = (e.fresh * r.in + (e.cw5m ?? 0) * r.cacheWrite5m + (e.cw1h ?? 0) * r.cacheWrite1h + (e.cr ?? 0) * r.cacheRead + (e.out ?? 0) * r.out) / 1e6;
  const billsDerived = (row.derivedColumns ?? []).some((c) => (c === 'cacheWrite5m' ? (e.cw5m ?? 0) : (e.cw1h ?? 0)) > 0);
  return { usd, status: row.status === 'ESTIMATE' || billsDerived ? 'ESTIMATE' : 'LIST' };
}
export const thinkingBucket = (e: CohortEvent): 'thinking' | 'non-thinking' | 'unknown' => e.thinking === true ? 'thinking' : e.thinking === false ? 'non-thinking' : 'unknown';
export const displayNameOf = (e: CohortEvent): string => {
  const row = PRICE_BOOK.find((r) => new RegExp(r.match, 'i').test(e.model));
  return row ? (row.local && e.provider !== 'local' ? e.model : row.displayName) : e.model;
};

// ── aggregates ──────────────────────────────────────────────────────────────────────────────────────────────
export interface Cats { inputFresh: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number; reasoning: number }
export interface Agg {
  events: number; tokens: Cats;
  /** Weakest member; undefined only for an empty scope. */
  countQuality: Q | undefined;
  /** Sum of the PRICED events only. A number even when some events are unpriced: read it with the counts. */
  apiEquivUsd: number; allUnpriced: boolean;
  unpricedEvents: number; estimatedPriceEvents: number; priceStatus: PriceStatus | null;
}
export function sumCats(events: readonly CohortEvent[]): Cats {
  const t: Cats = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
  for (const e of events) { t.inputFresh += e.fresh; t.cacheWrite5m += e.cw5m ?? 0; t.cacheWrite1h += e.cw1h ?? 0; t.cacheRead += e.cr ?? 0; t.output += e.out ?? 0; t.reasoning += e.reasoning ?? 0; }
  return t;
}
export function priceStatusOf(events: number, unpriced: number, estimated: number): PriceStatus | null {
  return events === 0 ? null : unpriced > 0 ? 'UNPRICED' : estimated > 0 ? 'ESTIMATE' : 'LIST';
}
export function aggregate(events: readonly CohortEvent[]): Agg {
  const priced = events.map(priceOf);
  const unpricedEvents = priced.filter((p) => p.usd === null).length;
  const estimatedPriceEvents = priced.filter((p) => p.usd !== null && p.status === 'ESTIMATE').length;
  return {
    events: events.length, tokens: sumCats(events), countQuality: weakestQuality(events.map(effectiveQuality)),
    apiEquivUsd: priced.reduce((s, p) => s + (p.usd ?? 0), 0), allUnpriced: events.length > 0 && unpricedEvents === events.length,
    unpricedEvents, estimatedPriceEvents, priceStatus: priceStatusOf(events.length, unpricedEvents, estimatedPriceEvents),
  };
}
const groupBy = <K, V>(items: readonly V[], key: (v: V) => K): Map<K, V[]> => {
  const m = new Map<K, V[]>();
  for (const i of items) { const k = key(i); const g = m.get(k); if (g) g.push(i); else m.set(k, [i]); }
  return m;
};

// ── Summary ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface ExpectedSummary {
  range: RangeName; start: number | null; events: CohortEvent[]; totals: Agg;
  bySource: Map<string, Agg>;
  byModel: Map<string, Agg & { source: string; provider: string; model: string; thinking: string; displayName: string }>;
  timeBasis: { startMs: number | null; asOfMs: number; excludedFutureEvents: number; excludedFutureActivity: number };
  wallMs: number; agentMs: number;
}
export function unionMs(timestamps: readonly number[], gapMs = IDLE_GAP_MS): number {
  const ts = [...timestamps].sort((a, b) => a - b);
  let total = 0; let from = ts[0]; let prev = ts[0];
  for (const t of ts) { if (t - prev > gapMs) { total += prev - from; from = t; } prev = t; }
  return ts.length === 0 ? 0 : total + (prev - from);
}
export function expectedSummary(range: RangeName, now = NOW): ExpectedSummary {
  const start = rangeStart(range, now);
  const events = eventsIn(range, now);
  const bySource = new Map([...groupBy(events, (e) => e.source)].map(([k, v]) => [k, aggregate(v)]));
  const byModel = new Map([...groupBy(events, (e) => `${e.source}|${e.provider}|${e.model}|${thinkingBucket(e)}`)].map(([k, v]) =>
    [k, { ...aggregate(v), source: v[0]!.source, provider: v[0]!.provider, model: v[0]!.model, thinking: thinkingBucket(v[0]!), displayName: displayNameOf(v[0]!) }]));
  return {
    range, start, events, totals: aggregate(events), bySource, byModel,
    timeBasis: { startMs: start, asOfMs: now, excludedFutureEvents: COHORT.filter((e) => e.ts > now).length, excludedFutureActivity: COHORT_MARKS.filter((m) => m.ts > now).length },
    wallMs: unionMs(marksIn(range, now).map((m) => m.ts)),
    agentMs: expectedSessions(range, now).reduce((s, x) => s + x.activeMs, 0),
  };
}

// ── Timeseries ──────────────────────────────────────────────────────────────────────────────────────────────
export interface ExpectedPoint {
  t: number; apiEquivUsd: number; tokens: number; totalTokens: number; countQuality: Q; unpricedEvents: number; estimatedPriceEvents: number;
  priceStatus: PriceStatus; bySource: Record<string, number>; events: CohortEvent[];
}
export function expectedTimeseries(range: RangeName, bucketMs: number, now = NOW): ExpectedPoint[] {
  return [...groupBy(eventsIn(range, now), (e) => Math.floor(e.ts / bucketMs) * bucketMs)].map(([t, evs]): ExpectedPoint => {
    const a = aggregate(evs);
    const bySource: Record<string, number> = {};
    for (const e of evs) bySource[e.source] = (bySource[e.source] ?? 0) + (priceOf(e).usd ?? 0);
    return { t, apiEquivUsd: a.apiEquivUsd, tokens: a.tokens.inputFresh + a.tokens.cacheWrite5m + a.tokens.cacheWrite1h + a.tokens.output,
      totalTokens: a.tokens.inputFresh + a.tokens.cacheWrite5m + a.tokens.cacheWrite1h + a.tokens.cacheRead + a.tokens.output,
      countQuality: a.countQuality!, unpricedEvents: a.unpricedEvents, estimatedPriceEvents: a.estimatedPriceEvents, priceStatus: a.priceStatus!,
      bySource, events: evs };
  }).sort((x, y) => x.t - y.t);
}
/** The bucket the daemon pairs with Summary for each range (daemon/report-worker.ts): hours for today and 24h, days otherwise. */
export const usageBucketMs = (range: RangeName): number => (range === 'today' || range === '24h' ? HOUR : DAY);

// ── Sessions ────────────────────────────────────────────────────────────────────────────────────────────────
export interface ExpectedSession {
  key: string; host: string; source: string; sessionId: string; events: CohortEvent[]; marks: CohortMark[];
  start: number; end: number; project?: string; models: string[]; tokens: Cats; countQuality: Q | undefined;
  apiEquivUsd: number | null; unpricedEvents: number; estimatedPriceEvents: number; priceStatus: PriceStatus | null;
  live: boolean; activeMs: number; activityBasis: 'no-marks' | 'activity-gaps' | 'reported-turn-durations'; markCount: number; durationMarkCount: number;
  burn: null | { tokensPerMin: number; usdPerHour: number; events: number; unpricedEvents: number; estimatedPriceEvents: number; priceStatus: PriceStatus | null };
  feeds: { provider: string; engine: string | null; events: number; unpricedEvents: number; estimatedPriceEvents: number; firstEventAt: number; lastEventAt: number }[];
}
export function expectedSessions(range: RangeName, now = NOW): ExpectedSession[] {
  const evs = eventsIn(range, now); const marks = marksIn(range, now);
  const keys = new Map<string, { host: string; source: string; sessionId: string }>();
  const keyOf = (host: string, source: string, session: string) => `${host}\u0000${source}\u0000${session}`;
  for (const e of evs) keys.set(keyOf(e.host, e.source, e.session), { host: e.host, source: e.source, sessionId: e.session });
  for (const m of marks) keys.set(keyOf(m.host, m.source, m.session), { host: m.host, source: m.source, sessionId: m.session });
  const rows = [...keys].map(([key, id]): ExpectedSession => {
    const se = evs.filter((e) => keyOf(e.host, e.source, e.session) === key).sort((a, b) => a.ts - b.ts);
    const sm = marks.filter((m) => keyOf(m.host, m.source, m.session) === key).sort((a, b) => a.ts - b.ts);
    const all = [...se.map((e) => e.ts), ...sm.map((m) => m.ts)];
    const end = Math.max(...all);
    const a = aggregate(se);
    const durations = id.source === 'codex' ? sm.filter((m) => (m.durationMs ?? 0) > 0) : [];
    let activeMs = 0;
    if (durations.length > 0) activeMs = durations.reduce((s, m) => s + (m.durationMs ?? 0), 0);
    else for (let i = 1; i < sm.length; i++) { const gap = sm[i]!.ts - sm[i - 1]!.ts; if (gap > 0 && gap <= IDLE_GAP_MS) activeMs += gap; }
    const recent = se.filter((e) => e.ts > now - 15 * MINUTE && e.ts <= now);
    const ra = aggregate(recent);
    const feedGroups = groupBy(se, (e) => `${e.host}|${e.source}|${e.provider}|${e.engine ?? ''}`);
    return {
      key, ...id, events: se, marks: sm, start: Math.min(...all), end,
      project: se.find((e) => e.project !== undefined)?.project ?? sm.find((m) => m.project !== undefined)?.project,
      models: [...new Set(se.map((e) => e.model))],
      tokens: a.tokens, countQuality: se.every((e) => e.quality === undefined) ? undefined : a.countQuality,
      apiEquivUsd: se.length === 0 ? 0 : a.allUnpriced ? null : a.apiEquivUsd,
      unpricedEvents: a.unpricedEvents, estimatedPriceEvents: a.estimatedPriceEvents, priceStatus: a.priceStatus,
      live: now - end < 5 * MINUTE, activeMs,
      activityBasis: sm.length === 0 ? 'no-marks' : durations.length > 0 ? 'reported-turn-durations' : 'activity-gaps',
      markCount: sm.length, durationMarkCount: durations.length,
      burn: recent.length === 0 ? null : { tokensPerMin: (ra.tokens.inputFresh + ra.tokens.cacheWrite5m + ra.tokens.cacheWrite1h + ra.tokens.cacheRead + ra.tokens.output) / 15,
        usdPerHour: ra.apiEquivUsd / 0.25, events: recent.length, unpricedEvents: ra.unpricedEvents, estimatedPriceEvents: ra.estimatedPriceEvents, priceStatus: ra.priceStatus },
      feeds: [...feedGroups.values()].map((g) => { const fa = aggregate(g); return { provider: g[0]!.provider, engine: g[0]!.engine ?? null, events: g.length,
        unpricedEvents: fa.unpricedEvents, estimatedPriceEvents: fa.estimatedPriceEvents, firstEventAt: Math.min(...g.map((e) => e.ts)), lastEventAt: Math.max(...g.map((e) => e.ts)) }; }),
    };
  });
  return rows.sort((x, y) => x.start - y.start);
}

// ── Limits (Claude five-hour block estimate) ────────────────────────────────────────────────────────────────
export function expectedBlock(host: string, now = NOW) {
  const activity = COHORT_MARKS.filter((m) => m.source === 'claude' && m.host === host).map((m) => m.ts).sort((a, b) => a - b);
  let cur: { start: number; end: number } | null = null;
  for (const ts of activity) if (cur === null || ts > cur.end) { const start = Math.floor(ts / HOUR) * HOUR; cur = { start, end: start + 5 * HOUR }; }
  if (cur === null) return null;
  const inBlock = COHORT.filter((e) => e.source === 'claude' && e.host === host && e.ts >= cur!.start && e.ts <= cur!.end);
  const a = aggregate(inBlock);
  const tokens = a.tokens.inputFresh + a.tokens.cacheWrite5m + a.tokens.cacheWrite1h + a.tokens.cacheRead + a.tokens.output;
  const usd = inBlock.length > 0 && a.unpricedEvents === inBlock.length ? null : a.apiEquivUsd;
  const elapsed = Math.max(1, Math.min(now, cur.end) - cur.start);
  const remaining = Math.max(0, cur.end - Math.min(now, cur.end));
  return { startedAt: cur.start, resetsAt: cur.end, events: inBlock.length, tokens,
    countQuality: inBlock.every((e) => e.quality === undefined) ? undefined : a.countQuality,
    apiEquivUsd: usd, burnTokensPerMin: tokens / (elapsed / 60_000), projectedTokens: tokens + (tokens / elapsed) * remaining,
    projectedUsd: usd === null ? null : usd + (usd / elapsed) * remaining };
}

/** Independent grouped source-record oracle for the Limits contributor drill-down. */
export function expectedLimitContributors(host: string, now = NOW) {
  const block = expectedBlock(host, now);
  if (block === null) return [];
  const events = COHORT.filter((e) => e.source === 'claude' && e.host === host
    && e.ts >= block.startedAt && e.ts <= block.resetsAt);
  const groups = new Map<string, {
    host: string; model: string; provider: string; servingRoutes: { kind: 'unrecorded' }[];
    firstEventAt: number; lastEventAt: number; events: number;
    tokens: { inputFresh: number; cacheWrite5m: number; cacheWrite1h: number; cacheWriteUnassigned?: number; cacheRead: number; output: number; reasoning: number; countQuality?: string };
    knownApiEquivUsd: number; pricedEvents: number; invalidAmount: boolean;
    priceStatusCounts: { LIST: number; ESTIMATE: number; UNPRICED: number; unknown: number };
    priceEvidence: { version: 1; events: number; invalidAmountEvents: number; unknownStatusEvents: number; statusAmountConflictEvents: number; issuesEvents: number; aggregateAmountInvalid: boolean };
  }>();
  const qualityRank: Record<string, number> = { complete: 0, unrecorded: 1, incomplete: 2, invalid: 3, conflict: 4 };
  for (const event of events) {
    // This fixture uses one price-book version and line timestamps. The independent oracle
    // asserts host/model/provider/route/time/count/price aggregation; the production unit test
    // covers explicit route variants and grouping by stored price version/timestamp source.
    const key = JSON.stringify([event.host, event.model, event.provider, 'unrecorded']);
    let row = groups.get(key);
    if (!row) {
      row = {
        host: event.host, model: event.model, provider: event.provider, servingRoutes: [{ kind: 'unrecorded' }],
        firstEventAt: event.ts, lastEventAt: event.ts, events: 0,
        tokens: { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 },
        knownApiEquivUsd: 0, pricedEvents: 0, invalidAmount: false,
        priceStatusCounts: { LIST: 0, ESTIMATE: 0, UNPRICED: 0, unknown: 0 },
        priceEvidence: { version: 1, events: 0, invalidAmountEvents: 0, unknownStatusEvents: 0,
          statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false },
      };
      groups.set(key, row);
    }
    row.events++;
    row.firstEventAt = Math.min(row.firstEventAt, event.ts);
    row.lastEventAt = Math.max(row.lastEventAt, event.ts);
    row.tokens.inputFresh += event.fresh;
    row.tokens.cacheWrite5m += event.cw5m ?? 0;
    row.tokens.cacheWrite1h += event.cw1h ?? 0;
    row.tokens.cacheRead += event.cr ?? 0;
    row.tokens.output += event.out ?? 0;
    row.tokens.reasoning += event.reasoning ?? 0;
    const incomingQuality = effectiveQuality(event);
    if (event.quality !== undefined || row.tokens.countQuality !== undefined) {
      const incoming = incomingQuality;
      const prior = row.events === 1 ? incoming : row.tokens.countQuality ?? 'unrecorded';
      row.tokens.countQuality = qualityRank[prior] >= qualityRank[incoming] ? prior : incoming;
    }
    const price = priceOf(event);
    const amountInvalid = price.usd !== null
      && (typeof price.usd !== 'number' || !Number.isFinite(price.usd) || price.usd < 0);
    const statusUnknown = !['LIST', 'ESTIMATE', 'UNPRICED'].includes(price.status);
    const statusConflict = !statusUnknown
      && (price.usd === null ? price.status !== 'UNPRICED' : price.status === 'UNPRICED');
    const issue = amountInvalid || statusUnknown || statusConflict;
    row.priceEvidence.events++;
    row.priceEvidence.invalidAmountEvents += amountInvalid ? 1 : 0;
    row.priceEvidence.unknownStatusEvents += statusUnknown ? 1 : 0;
    row.priceEvidence.statusAmountConflictEvents += statusConflict ? 1 : 0;
    row.priceEvidence.issuesEvents += issue ? 1 : 0;
    if (amountInvalid) row.invalidAmount = true;
    switch (price.status) {
      case 'LIST': row.priceStatusCounts.LIST++; break;
      case 'ESTIMATE': row.priceStatusCounts.ESTIMATE++; break;
      case 'UNPRICED': row.priceStatusCounts.UNPRICED++; break;
      default: row.priceStatusCounts.unknown++; break;
    }
    if ((price.status === 'LIST' || price.status === 'ESTIMATE')
      && typeof price.usd === 'number' && Number.isFinite(price.usd) && price.usd >= 0) {
      row.knownApiEquivUsd += price.usd;
      row.pricedEvents++;
    }
  }
  return [...groups.values()]
    .map((row) => ({
      host: row.host, model: row.model, provider: row.provider, servingRoutes: row.servingRoutes,
      firstEventAt: row.firstEventAt, lastEventAt: row.lastEventAt, events: row.events,
      tokens: row.tokens,
      knownApiEquivUsd: row.invalidAmount || row.priceEvidence.issuesEvents > 0 || row.pricedEvents === 0 ? null : row.knownApiEquivUsd,
      priceStatusCounts: row.priceStatusCounts,
      priceEvidence: row.priceEvidence,
    }))
    .sort((a, b) => a.host.localeCompare(b.host) || a.model.localeCompare(b.model)
      || a.provider.localeCompare(b.provider) || JSON.stringify(a.servingRoutes).localeCompare(JSON.stringify(b.servingRoutes)));
}

/** Floating-point comparison for sums whose order the oracle does not reproduce. */
export const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
