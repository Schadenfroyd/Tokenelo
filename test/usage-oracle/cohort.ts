/**
 * The ONE synthetic cohort behind the Usage API oracle (docs/reviews/2026-10-18-usage-api-oracle/NOTES.md).
 *
 * Everything here is fabricated: host labels, session ids, project paths, model ids, token counts and prices.
 * Nothing was captured from a real tool, ledger, vendor or machine. The price book is a small synthetic rate table
 * (not the repository's rates/prices.json). No MEASURED label appears anywhere in this cohort.
 *
 * The cohort is data. It is written through the real SqliteLedger (real migrations, real price computation with the
 * synthetic book, and the null engine for the reserved valuation columns) by `seedCohort`, and the oracle
 * (./oracle.ts) is computed from the same table by plain TypeScript, without calling any aggregation code in src/.
 *
 * Clock: NOW is fixed. Calendar days are UTC because the tests pin TZ=UTC for the main cohort (the "today"
 * range starts at LOCAL midnight; a separate case in usage-oracle-queries.test.ts proves that in a non-UTC zone).
 */
import type { ActivityMark, PriceRow, Provider, Source, UsageEvent } from '../../src/core/types.js';
import { createPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import type { TokeneloDb } from '../../src/store/db.js';

export const NOW = Date.UTC(2026, 9, 18, 15, 30, 0, 0); // 2026-10-18T15:30:00.000Z, a Sunday
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const IDLE_GAP_MS = 5 * MINUTE; // defaultConfig().idleGapMs, DESIGN section 6
export const HOST_A = 'HOST-A';
export const HOST_B = 'HOST-B';
export const RANGES = ['today', '24h', '7d', '30d', 'all'] as const;
export type RangeName = (typeof RANGES)[number];

const utc = (iso: string): number => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || !iso.endsWith('Z')) throw new Error(`cohort time must be an explicit UTC instant: ${iso}`);
  return ms;
};

// ── synthetic price book (USD per million tokens; fabricated) ───────────────────────────────────────────────
const zeroRates = { in: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: 0 };
function priceRow(id: string, displayName: string, provider: Provider, eacsClass: PriceRow['eacsClass'], local: boolean,
  rates: PriceRow['rates'], extra: Partial<PriceRow> = {}): PriceRow {
  return { id, match: `^${id}`, displayName, provider, eacsClass, local, rates, status: 'LIST',
    source: 'synthetic usage-oracle cohort (fabricated rates)', verifiedAt: '2026-10-18', ...extra };
}
export const PRICE_BOOK: PriceRow[] = [
  priceRow('oracle-opus', 'Oracle Opus', 'anthropic', 'ELO_CLD', false, { in: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, out: 50 }),
  // No primary 1-hour cache-write figure: an event that bills that column is priced ESTIMATE, never LIST.
  priceRow('oracle-haiku', 'Oracle Haiku', 'anthropic', 'ELO_CLD', false, { in: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, out: 10 },
    { derivedColumns: ['cacheWrite1h'] }),
  priceRow('oracle-gpt', 'Oracle GPT', 'openai', 'ELO_GPT', false, { in: 5, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0.5, out: 20 }),
  priceRow('oracle-local-27b', 'Oracle Local 27B', 'local', 'ELO_LMA', true, zeroRates),
  // 'oracle-unlisted' deliberately has NO row: its events are UNPRICED, which is not $0.
];

/** The engines the ledger is written with: the synthetic price book, and the null engine (neutral reserved valuation values). */
export function buildEngines() {
  const computeUnits = createNullEngine();
  const pricing = createPricingEngine(PRICE_BOOK);
  return { pricing, computeUnits };
}

// ── the cohort table ────────────────────────────────────────────────────────────────────────────────────────
export type Quality = 'complete' | 'incomplete' | 'invalid' | 'conflict';
export interface CohortEvent {
  id: string; host: string; source: Source; session: string; ts: number; model: string; provider: Provider;
  engine?: string; project?: string;
  fresh: number; cw5m?: number; cw1h?: number; cr?: number; out?: number; reasoning?: number;
  /** Declared count quality. undefined = a legacy row that never recorded it (stored NULL, read as 'unrecorded'). */
  quality?: Quality;
  thinking: boolean | null;
  durationMs?: number;
  why: string;
}
const E = (e: CohortEvent): CohortEvent => e;
const P = { alpha: '/synthetic/alpha', beta: '/synthetic/beta', live: '/synthetic/live-unpriced', edge: '/synthetic/edge', delta: '/synthetic/delta' };

export const T = {
  today: utc('2026-10-18T00:00:00.000Z'), h24: NOW - DAY, d7: NOW - 7 * DAY, d30: NOW - 30 * DAY,
} as const;

export const COHORT: readonly CohortEvent[] = [
  // Session claude-s1 on HOST-A: spans every range; two models; live (last event 3 minutes before NOW).
  E({ id: 'e01', host: HOST_A, source: 'claude', session: 'claude-s1', project: P.alpha, ts: utc('2026-10-11T17:30:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 4000, cr: 20000, out: 800, quality: 'complete', thinking: true, why: 'priced; inside 7d/30d/all, outside 24h and today' }),
  E({ id: 'e02', host: HOST_A, source: 'claude', session: 'claude-s1', project: P.alpha, ts: utc('2026-10-17T16:30:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 3000, cw5m: 500, cr: 10000, out: 600, quality: 'complete', thinking: true, why: 'priced; inside 24h and wider, outside today' }),
  E({ id: 'e03', host: HOST_A, source: 'claude', session: 'claude-s1', project: P.alpha, ts: utc('2026-10-18T14:50:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 2000, cw5m: 1000, cr: 15000, out: 400, quality: 'complete', thinking: false, why: 'priced; today' }),
  E({ id: 'e04', host: HOST_A, source: 'claude', session: 'claude-s1', project: P.alpha, ts: utc('2026-10-18T15:22:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 1500, cr: 12000, out: 300, quality: 'complete', thinking: true, why: 'priced; inside the 15-minute burn window' }),
  E({ id: 'e05', host: HOST_A, source: 'claude', session: 'claude-s1', project: P.alpha, ts: utc('2026-10-18T15:27:00.000Z'), model: 'oracle-haiku', provider: 'anthropic',
    fresh: 800, cw1h: 2000, out: 200, quality: 'complete', thinking: null, why: 'ESTIMATE price (bills the derived 1-hour cache-write column); thinking unknown' }),
  // Session claude-s2: the partial / unknown / zero cases, all today.
  E({ id: 'e06', host: HOST_A, source: 'claude', session: 'claude-s2', project: P.beta, ts: utc('2026-10-18T09:10:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 900, out: 100, quality: 'complete', thinking: false, why: 'priced control' }),
  E({ id: 'e07', host: HOST_A, source: 'claude', session: 'claude-s2', project: P.beta, ts: utc('2026-10-18T09:12:00.000Z'), model: 'oracle-unlisted', provider: 'anthropic',
    fresh: 700, out: 70, quality: 'complete', thinking: null, why: 'UNPRICED: counts are complete but the model has no price row (not $0)' }),
  E({ id: 'e08', host: HOST_A, source: 'claude', session: 'claude-s2', project: P.beta, ts: utc('2026-10-18T09:14:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 600, out: 60, quality: 'incomplete', thinking: null, why: 'missing native count (incomplete): known categories kept, price withheld (UNPRICED), not zero' }),
  E({ id: 'e09', host: HOST_A, source: 'claude', session: 'claude-s2', project: P.beta, ts: utc('2026-10-18T09:16:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 0, out: 0, quality: 'complete', thinking: false, why: 'MEASURED ZERO: complete counts that are all zero; priced $0 LIST (not unknown)' }),
  E({ id: 'e10', host: HOST_A, source: 'claude', session: 'claude-s2', project: P.beta, ts: utc('2026-10-18T09:18:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 300, out: 30, thinking: null, why: 'legacy row with no count quality recorded (read as unrecorded); still priced' }),
  // Session claude-s3: an all-unpriced live session.
  E({ id: 'e11', host: HOST_A, source: 'claude', session: 'claude-s3', project: P.live, ts: utc('2026-10-18T15:26:00.000Z'), model: 'oracle-unlisted', provider: 'anthropic',
    fresh: 50, out: 5, quality: 'complete', thinking: null, why: 'every event of this session is unpriced; inside the burn window' }),
  E({ id: 'u01', host: HOST_A, source: 'claude', session: 'claude-s3', project: P.live, ts: utc('2026-10-18T06:30:00.000Z'), model: 'oracle-unlisted', provider: 'anthropic',
    fresh: 40, out: 4, quality: 'complete', thinking: null, why: 'the only event of its hour bucket and unpriced: that bucket\'s dollars are unavailable, not $0' }),
  // Session claude-edge: one event on each side of every range boundary (inclusive start, ts <= NOW).
  ...([
    ['b01', T.d30 - 1, 101, 'one millisecond before the 30d start: only in all'],
    ['b02', T.d30, 102, 'exactly at the 30d start: included (ts >= start)'],
    ['b03', T.d7 - 1, 103, 'one millisecond before the 7d start: 30d and all only'],
    ['b04', T.d7, 104, 'exactly at the 7d start: included'],
    ['b05', T.h24 - 1, 105, 'one millisecond before the 24h start: 7d and wider only'],
    ['b06', T.h24, 106, 'exactly at the 24h start: included'],
    ['b07', T.today - 1, 107, 'one millisecond before local midnight: not today'],
    ['b08', T.today, 108, 'exactly at local midnight: today'],
    ['b09', NOW, 109, 'exactly at the query clock: included (ts <= NOW)'],
  ] as const).map(([id, ts, fresh, why]) => E({ id, host: HOST_A, source: 'claude', session: 'claude-edge', project: P.edge, ts, model: 'oracle-opus',
    provider: 'anthropic', fresh, quality: 'complete', thinking: null, why })),
  // HOST-B: the same session id as claude-s1 on another host is a different session; other count qualities.
  E({ id: 'h01', host: HOST_B, source: 'claude', session: 'claude-s1', project: '/synthetic/other-host', ts: utc('2026-10-18T10:00:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 1100, out: 110, quality: 'complete', thinking: true, why: 'same session id, other host: separate session row' }),
  E({ id: 'h02', host: HOST_B, source: 'claude', session: 'claude-hb', project: '/synthetic/other-host', ts: utc('2026-10-15T10:00:00.000Z'), model: 'oracle-opus', provider: 'anthropic',
    fresh: 700, out: 70, quality: 'conflict', thinking: null, why: 'conflicting count evidence: UNPRICED, aggregate count quality becomes conflict' }),
  E({ id: 'h03', host: HOST_B, source: 'claude', session: 'claude-hb', project: '/synthetic/other-host', ts: utc('2026-09-25T10:00:00.000Z'), model: 'oracle-haiku', provider: 'anthropic',
    fresh: 400, out: 40, quality: 'invalid', thinking: false, why: 'invalid count evidence: UNPRICED; only 30d and all' }),
  // Codex (provider openai): one session across two ranges, plus a record stamped after the query clock.
  E({ id: 'x01', host: HOST_A, source: 'codex', session: 'codex-t1', project: P.delta, ts: utc('2026-10-17T20:00:00.000Z'), model: 'oracle-gpt', provider: 'openai',
    fresh: 5000, cr: 8000, out: 700, reasoning: 200, quality: 'complete', thinking: true, why: 'priced; 24h and wider; reasoning is a subset of output' }),
  E({ id: 'x02', host: HOST_A, source: 'codex', session: 'codex-t1', project: P.delta, ts: utc('2026-10-18T12:00:00.000Z'), model: 'oracle-gpt', provider: 'openai',
    fresh: 2500, cr: 4000, out: 300, quality: 'complete', thinking: true, why: 'priced; today' }),
  E({ id: 'xf1', host: HOST_A, source: 'codex', session: 'codex-future', project: P.delta, ts: NOW + 1, model: 'oracle-gpt', provider: 'openai',
    fresh: 110, quality: 'complete', thinking: false, why: 'one millisecond AFTER the query clock: excluded from every range, counted in timeBasis.excludedFutureEvents' }),
  // Local model (provider local, ollama-proxy source): a priced zero, which is different from unpriced.
  E({ id: 'l01', host: HOST_A, source: 'ollama-proxy', session: 'proxy:cli:oracle-local-27b:2026-10-18', engine: 'ollama', ts: utc('2026-10-18T13:00:00.000Z'),
    model: 'oracle-local-27b', provider: 'local', fresh: 1200, out: 300, quality: 'complete', thinking: null, durationMs: 4000, why: 'local model: API-equivalent $0 is a priced zero (LIST)' }),
  E({ id: 'l02', host: HOST_A, source: 'ollama-proxy', session: 'proxy:cli:oracle-local-27b:2026-10-14', engine: 'ollama', ts: utc('2026-10-14T10:00:00.000Z'),
    model: 'oracle-local-27b', provider: 'local', fresh: 800, out: 200, quality: 'complete', thinking: null, durationMs: 2500, why: 'local model four days ago: 7d and wider' }),
];

export interface CohortMark { host: string; source: Source; session: string; ts: number; uuid: string; project?: string; durationMs?: number }
const eventMarks: CohortMark[] = COHORT.filter((e) => e.source === 'claude').map((e) => ({ host: e.host, source: e.source, session: e.session, ts: e.ts, uuid: `m-${e.id}`, project: e.project }));
/** Activity marks: one per Claude event, plus an activity-only session, Codex turn durations, and one mark after the clock. */
export const COHORT_MARKS: readonly CohortMark[] = [
  ...eventMarks,
  ...(['2026-10-18T11:00:00.000Z', '2026-10-18T11:03:00.000Z', '2026-10-18T11:20:00.000Z', '2026-10-18T11:22:00.000Z'] as const).map((iso, i) => ({
    host: HOST_A, source: 'claude' as Source, session: 'claude-idle', ts: utc(iso), uuid: `m-idle-${i}`, project: '/synthetic/idle' })),
  { host: HOST_A, source: 'codex', session: 'codex-t1', ts: utc('2026-10-17T20:00:00.000Z'), uuid: 'm-x01', project: P.delta, durationMs: 120_000 },
  { host: HOST_A, source: 'codex', session: 'codex-t1', ts: utc('2026-10-18T11:58:00.000Z'), uuid: 'm-x02a', project: P.delta },
  { host: HOST_A, source: 'codex', session: 'codex-t1', ts: utc('2026-10-18T12:00:00.000Z'), uuid: 'm-x02b', project: P.delta, durationMs: 60_000 },
  { host: HOST_A, source: 'codex', session: 'codex-future', ts: NOW + 5000, uuid: 'm-xf1', project: P.delta },
];

// ── ledger seeding (real SqliteLedger) ──────────────────────────────────────────────────────────────────────
export function toUsageEvent(c: CohortEvent): UsageEvent {
  const tokens = { inputFresh: c.fresh, cacheWrite5m: c.cw5m ?? 0, cacheWrite1h: c.cw1h ?? 0, cacheRead: c.cr ?? 0, output: c.out ?? 0, reasoning: c.reasoning ?? 0,
    ...(c.quality ? { countQuality: c.quality } : {}) };
  return {
    id: c.id, host: c.host, source: c.source, ts: c.ts, tsSource: 'line', sessionId: c.session, isSubagent: false,
    ...(c.project ? { project: c.project } : {}), model: c.model, provider: c.provider, ...(c.engine ? { engine: c.engine } : {}),
    thinking: c.thinking, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
    components: [{ model: c.model, tokens }], tokens, flags: [],
    // Placeholders: upsertEvents always recomputes the price and the reserved valuation fields for a new row from the components with the engines it was given.
    apiEquivUsd: -999, priceStatus: 'UNPRICED', priceVersion: 'placeholder', reservedValue: -999, ucuRateStatus: 'NONE', eacsDefSha256: 'placeholder',
  };
}

export function seedCohort(db: TokeneloDb, engines = buildEngines()): void {
  const ledger = new SqliteLedger(db, engines.pricing, engines.computeUnits);
  const marks: ActivityMark[] = COHORT_MARKS.map((m) => ({ source: m.source, sessionId: m.session, ts: m.ts, uuid: m.uuid, host: m.host,
    ...(m.project ? { project: m.project } : {}), ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}) }));
  ledger.recordActivity(marks);
  ledger.upsertEvents(COHORT.map(toUsageEvent));
}
