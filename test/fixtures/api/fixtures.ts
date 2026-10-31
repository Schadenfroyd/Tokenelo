/**
 * Canonical, TYPE-CHECKED source for every test/fixtures/api/*.json file. Each exported const is
 * declared `satisfies <ResponseType>` against src/core/types.ts, and every literal-status value
 * (RateStatus, PriceStatus, Range, Source, SkipReason, …) is passed through a small typed helper
 * so a typo (e.g. `'FILED_EXAMPLE'` instead of `'FILED-EXAMPLE'`) is a compile error here — this
 * is the actual "fixture schema conformance to types.ts (tsc on the fixtures via a typed
 * import)" check (test/tray/fixtures-typecheck.test.ts spawns `tsc --noEmit` on this file).
 *
 * A plain JSON import can't do this: `resolveJsonModule` widens every string field of an
 * imported .json to `string`, so assigning it to a union-typed field always fails (even when the
 * value is correct), and an `as Type` cast always succeeds (even when the value is wrong) because
 * narrowing casts from a wider type are unchecked. Writing the fixtures as real TS object
 * literals is the only way `satisfies`/parameter types actually constrain the literal values.
 *
 * scripts' `npm run fixtures:gen` is intentionally NOT wired up (no new npm scripts per the hard
 * rule against editing package.json) — regenerate the committed JSON by running
 * `npx tsx test/fixtures/api/write-json.ts` after editing this file; the round-trip test in
 * fixtures-typecheck.test.ts fails loudly if the two ever drift apart.
 */
import type {
  CoverageResponse,
  CollectorScanStatus,
  DoctorReport,
  FleetOverviewResponse,
  FleetSummaryResponse,
  LimitsResponse,
  LimitSnapshot,
  ModelRow,
  ProcessesResponse,
  Provider,
  QueryTimeBasis,
  RateStatus,
  Range,
  SessionDetail,
  SessionsResponse,
  SessionRow,
  SkipReason,
  Source,
  SubscriptionRow,
  SummaryResponse,
  TimeseriesResponse,
  TokenCounts,
} from '../../../src/core/types.js';
import { USAGE_SOURCES } from '../../../src/core/types.js';

// Fixed to `date -u` at authoring time (2026-09-26T23:44:28Z, i.e. `new Date(1790466276688)`)
// rather than an arbitrary epoch, because two tabs compute against the real wall clock
// client-side: the Now tab's elapsed cells (`Date.now() - session.start`, app.ts#renderNowRow)
// and the Limits tab's reset countdowns (`resetsAt - Date.now()`, app.ts#renderLimitCard). A
// stale/arbitrary NOW produced a nonsensical "8770h 19m" elapsed reading and, separately, a
// "resets in 00:00:00" countdown for windows whose resetsAt had already silently fallen into the
// past relative to the real clock — both caught only by actually looking at the rendered PNGs
// (--snapshot), not by the fixture typechecking/round-tripping cleanly, which says nothing about
// whether the *values* are still sensible against the real clock right now. A static fixture will
// still drift by however much wall-clock time passes between authoring and running --snapshot
// again (windows sized in hours/days below give it reasonable headroom); regenerate via
// `npx tsx test/fixtures/api/write-json.ts` after bumping this constant if it goes stale.
const NOW = 1790466276688;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILED_EXAMPLE_TODAY_START = Date.parse('2026-09-26T06:00:00.000Z');

// Frozen synthetic Today boundary for the FILED-EXAMPLE snapshot: 2026-09-26 00:00 in
// America/Denver (MDT, UTC-06:00). Equal query clocks across these fixtures are only a shared
// synthetic clock/range, not a shared database snapshot or evidence of source completeness.
const FILED_EXAMPLE_TODAY_BASIS: QueryTimeBasis = {
  startMs: FILED_EXAMPLE_TODAY_START,
  asOfMs: NOW,
  endInclusive: true,
  timestampBasis: 'recorded-timestamps',
  excludedFutureEvents: 0,
  excludedFutureActivity: 0,
};
const FILED_EXAMPLE_CLAUDE_MONTHLY_USD = 200;
const FILED_EXAMPLE_CLAUDE_TODAY_COST_USD =
  FILED_EXAMPLE_CLAUDE_MONTHLY_USD * ((NOW - FILED_EXAMPLE_TODAY_START) / DAY_MS / 30);

const ZERO_TOKENS: TokenCounts = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };

function tok(t: Partial<TokenCounts>): TokenCounts {
  return { ...ZERO_TOKENS, ...t };
}

function bySourceZero(): SummaryResponse['bySource'] {
  const out = {} as SummaryResponse['bySource'];
  for (const s of USAGE_SOURCES) out[s] = { events: 0, tokens: { ...ZERO_TOKENS }, apiEquivUsd: 0 };
  return out;
}

// ── summary-<range> ──────────────────────────────────────────────────────────────────────────

const byModelToday: ModelRow[] = [
  {
    model: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    provider: 'anthropic' as Provider,
    source: 'claude' as Source,
    thinking: 'thinking',
    events: 500,
    tokens: tok({ inputFresh: 300000, cacheWrite5m: 12000, cacheWrite1h: 300000, cacheRead: 1900000, output: 60000, reasoning: 15000 }),
    apiEquivUsd: 120.1,
    priceStatus: 'LIST',
  },
  {
    model: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    provider: 'anthropic',
    source: 'claude',
    thinking: 'non-thinking',
    events: 200,
    tokens: tok({ inputFresh: 100000, cacheWrite1h: 40000, cacheRead: 200000, output: 20000 }),
    apiEquivUsd: 29.9,
    priceStatus: 'ESTIMATE',
  },
  {
    model: 'gpt-6-sol',
    displayName: 'GPT-6 Sol',
    provider: 'openai',
    source: 'codex',
    thinking: 'thinking',
    events: 117,
    tokens: tok({ inputFresh: 100000, cacheRead: 100000, output: 15000 }),
    apiEquivUsd: 30.0,
    priceStatus: 'LIST',
  },
  {
    model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
    displayName: 'Qwen3.8 27B (local)',
    provider: 'local',
    source: 'ollama-proxy',
    thinking: 'unknown',
    events: 18,
    tokens: tok({ inputFresh: 12000, output: 3000 }),
    apiEquivUsd: 0,
    priceStatus: 'LIST',
  },
  {
    model: 'codex-auto-review',
    displayName: 'codex-auto-review',
    provider: 'unknown',
    source: 'codex',
    thinking: 'unknown',
    events: 3,
    tokens: tok({ inputFresh: 2200, output: 400 }),
    apiEquivUsd: null,
    priceStatus: 'UNPRICED',
  },
  {
    model: 'benchmark-fixture',
    displayName: 'Benchmark fixture',
    provider: 'unknown',
    source: 'bench',
    thinking: 'unknown',
    events: 4,
    tokens: tok({ inputFresh: 340, output: 100 }),
    apiEquivUsd: 4.32,
    priceStatus: 'LIST',
  },
];

const summaryTodayBase = {
  host: 'M4a',
  range: 'today' as Range,
  generatedAt: NOW,
  totals: {
    events: 842,
    tokens: tok({ inputFresh: 514540, cacheWrite5m: 12000, cacheWrite1h: 340000, cacheRead: 2200000, output: 98500, reasoning: 15000 }),
    apiEquivUsd: 184.32,
    unpricedEvents: 3,
    estimatedPriceEvents: 0,
    priceStatus: 'UNPRICED' as const,
  },
  bySource: {
    ...bySourceZero(),
    claude: {
      events: 700,
      tokens: tok({ inputFresh: 400000, cacheWrite5m: 12000, cacheWrite1h: 340000, cacheRead: 2100000, output: 80000, reasoning: 15000 }),
      apiEquivUsd: 150.0,
    },
    codex: {
      events: 120,
      tokens: tok({ inputFresh: 102200, cacheRead: 100000, output: 15400 }),
      apiEquivUsd: 30.0,
    },
    'ollama-proxy': {
      events: 18,
      tokens: tok({ inputFresh: 12000, output: 3000 }),
      apiEquivUsd: 0,
    },
    bench: {
      events: 4,
      tokens: tok({ inputFresh: 340, output: 100 }),
      apiEquivUsd: 4.32,
    },
  },
  byModel: byModelToday,
  local: {
    captured: true,
    // No valuation rates are configured: both comparators are explicit unavailable values (usd null,
    // never zero), and so are the net savings derived from them.
    valueVsClaude: { usd: null, comparator: 'claude-sonnet-5', status: 'NONE' as RateStatus, unratedEvents: 0 },
    valueVsGpt: { usd: null, comparator: 'gpt-6-sol', status: 'NONE' as RateStatus, unratedEvents: 0 },
    energy: { kwh: 0.42, usd: 0.13, status: 'ESTIMATE' as const },
    netSavingsVsClaude: null,
    netSavingsVsClaudeStatus: 'NONE' as RateStatus,
    netSavingsVsGpt: null,
    netSavingsVsGptStatus: 'NONE' as RateStatus,
    decodeTokPerSec: 38.4,
  },
  subscriptions: [
    { account: 'founder@example.com (Claude Max)', kind: 'claude', planName: 'Max', billedUsd: 200, apiEquivUsd: 150.0, leverage: 0.75, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' as const, partial: false },
    { account: 'founder@example.com (Codex Plus)', kind: 'codex', billedUsd: null, apiEquivUsd: 30.0, leverage: null, unpricedEvents: null, estimatedPriceEvents: null, priceStatus: null, partial: null },
  ] satisfies SubscriptionRow[],
  activeTime: { agentMs: 5_400_000, wallMs: 7_200_000 },
} satisfies SummaryResponse;

export const summaryToday = {
  ...summaryTodayBase,
  timeBasis: FILED_EXAMPLE_TODAY_BASIS,
  subscriptions: subscriptionsForRange(FILED_EXAMPLE_TODAY_START, summaryTodayBase.bySource),
} satisfies SummaryResponse;

const TOKEN_SUM_FIELDS = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const;
const OPTIONAL_TOKEN_SUM_FIELDS = ['cacheWriteUnassigned', 'cacheWriteAssumed1h'] as const;
const SOURCES: readonly Source[] = USAGE_SOURCES;

function scaleTokens(tokens: TokenCounts, factor: number): TokenCounts {
  const scaled = { ...tokens };
  for (const field of TOKEN_SUM_FIELDS) scaled[field] = Math.round(tokens[field] * factor);
  for (const field of OPTIONAL_TOKEN_SUM_FIELDS) {
    if (typeof tokens[field] === 'number') scaled[field] = Math.round(tokens[field]! * factor);
  }
  return scaled;
}

function sumTokenCounts(rows: readonly TokenCounts[]): TokenCounts {
  const totals = tok({});
  for (const field of TOKEN_SUM_FIELDS) totals[field] = rows.reduce((sum, row) => sum + row[field], 0);
  for (const field of OPTIONAL_TOKEN_SUM_FIELDS) {
    if (rows.length > 0 && rows.every((row) => typeof row[field] === 'number')) {
      totals[field] = rows.reduce((sum, row) => sum + row[field]!, 0);
    }
  }
  for (const field of ['countQuality', 'ucuCountQuality'] as const) {
    const first = rows[0]?.[field];
    if (first !== undefined && rows.every((row) => row[field] === first)) totals[field] = first;
  }
  const firstEvidence = rows[0]?.fieldEvidence;
  if (firstEvidence !== undefined && rows.every((row) => JSON.stringify(row.fieldEvidence) === JSON.stringify(firstEvidence))) {
    totals.fieldEvidence = firstEvidence;
  }
  return totals;
}

function scaleBySource(rows: SummaryResponse['bySource'], factor: number): SummaryResponse['bySource'] {
  const scaled = {} as SummaryResponse['bySource'];
  for (const source of SOURCES) {
    const row = rows[source];
    scaled[source] = {
      ...row,
      events: row.events * factor,
      tokens: scaleTokens(row.tokens, factor),
      apiEquivUsd: row.apiEquivUsd * factor,
    };
  }
  return scaled;
}

function scaleByModel(rows: ModelRow[], factor: number): ModelRow[] {
  return rows.map((row) => ({
    ...row,
    events: row.events * factor,
    tokens: scaleTokens(row.tokens, factor),
    apiEquivUsd: row.apiEquivUsd === null ? null : row.apiEquivUsd * factor,
  }));
}

function scaledLocal(local: SummaryResponse['local'], factor: number): SummaryResponse['local'] {
  const scaleNullable = (value: number | null): number | null => value === null ? null : value * factor;
  // The comparator values are explicit "unavailable" values (usd null, zero unrated events), so a
  // range scale leaves them as they are; only the energy figures scale.
  return {
    ...local,
    valueVsClaude: { ...local.valueVsClaude },
    valueVsGpt: { ...local.valueVsGpt },
    energy: { ...local.energy, kwh: scaleNullable(local.energy.kwh), usd: scaleNullable(local.energy.usd) },
    netSavingsVsClaude: scaleNullable(local.netSavingsVsClaude),
    netSavingsVsGpt: scaleNullable(local.netSavingsVsGpt),
  };
}

function rangeTimeBasis(startMs: number | null): QueryTimeBasis {
  return {
    startMs,
    asOfMs: NOW,
    endInclusive: true,
    timestampBasis: 'recorded-timestamps',
    excludedFutureEvents: 0,
    excludedFutureActivity: 0,
  };
}

function rangeTotals(
  bySource: SummaryResponse['bySource'],
  byModel: ModelRow[],
): SummaryResponse['totals'] {
  const sourceRows = Object.values(bySource);
  return {
    events: sourceRows.reduce((sum, row) => sum + row.events, 0),
    tokens: sumTokenCounts(sourceRows.map((row) => row.tokens)),
    apiEquivUsd: sourceRows.reduce((sum, row) => sum + row.apiEquivUsd, 0),
    unpricedEvents: byModel.reduce((sum, row) => sum + (row.apiEquivUsd === null ? row.events : row.unpricedEvents ?? 0), 0),
    estimatedPriceEvents: byModel.reduce((sum, row) => sum + (row.estimatedPriceEvents ?? 0), 0),
    priceStatus: 'UNPRICED',
  };
}

function subscriptionsForRange(startMs: number | null, bySource: SummaryResponse['bySource']): SummaryResponse['subscriptions'] {
  const billedUsd = startMs === null ? null : FILED_EXAMPLE_CLAUDE_MONTHLY_USD * ((NOW - startMs) / DAY_MS / 30);
  return summaryTodayBase.subscriptions.map((row) => row.kind === 'claude' ? {
    ...row,
    billedUsd: startMs === FILED_EXAMPLE_TODAY_START ? FILED_EXAMPLE_CLAUDE_TODAY_COST_USD : billedUsd,
    apiEquivUsd: bySource.claude.apiEquivUsd,
    leverage: billedUsd === null || billedUsd <= 0 ? null : bySource.claude.apiEquivUsd / billedUsd,
    costBasis: {
      state: startMs === null ? 'period-unavailable' : 'configured-proration',
      monthlyUsd: FILED_EXAMPLE_CLAUDE_MONTHLY_USD,
      rangeStartMs: startMs,
      rangeEndMs: NOW,
      prorationDays: 30,
      origin: 'configured-plan-price',
      invoiceVerified: false,
    },
  } : row.kind === 'codex' ? {
    ...row,
    apiEquivUsd: bySource.codex.apiEquivUsd,
  } : row);
}

const sevenDayStart = NOW - 7 * DAY_MS;
const thirtyDayStart = NOW - 30 * DAY_MS;
const twentyFourHourStart = NOW - DAY_MS;

function summaryForRange(range: '24h' | '7d' | '30d' | 'all', factor: number, startMs: number | null): SummaryResponse {
  const bySource = scaleBySource(summaryTodayBase.bySource, factor);
  const byModel = scaleByModel(byModelToday, factor);
  return {
    ...summaryTodayBase,
    range,
    generatedAt: NOW,
    timeBasis: rangeTimeBasis(startMs),
    totals: rangeTotals(bySource, byModel),
    bySource,
    byModel,
    local: scaledLocal(summaryTodayBase.local, factor),
    subscriptions: subscriptionsForRange(startMs, bySource),
    activeTime: {
      agentMs: summaryTodayBase.activeTime.agentMs * factor,
      wallMs: summaryTodayBase.activeTime.wallMs * factor,
    },
  };
}

export const summary7d = summaryForRange('7d', 5, sevenDayStart) satisfies SummaryResponse;
export const summary30d = summaryForRange('30d', 18, thirtyDayStart) satisfies SummaryResponse;
export const summary24h = summaryForRange('24h', 2, twentyFourHourStart) satisfies SummaryResponse;
// This FILED-EXAMPLE uses the fixture set's 30-day values while preserving the All-query
// contract (startMs=null). Configured subscription proration is unavailable without a finite
// range start; this does not claim complete production retention.
export const summaryAll = summaryForRange('all', 18, null) satisfies SummaryResponse;

// Base for strict aggregate-only Fleet fixtures. Each range transform assigns independent host
// report clocks; API-equivalent values are not invoices, and the Ryzen nulls remain unknown.
function fleetZeroSource(): FleetSummaryResponse['bySource'][Source] {
  return { events: 0, tokens: tok({}), apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null };
}

function fleetBySource(rows: Partial<Record<Source, FleetSummaryResponse['bySource'][Source]>>): FleetSummaryResponse['bySource'] {
  const result = Object.fromEntries(SOURCES.map((source) => [source, fleetZeroSource()])) as FleetSummaryResponse['bySource'];
  return Object.assign(result, rows);
}

function filedFleetSummary(input: {
  host: string;
  events: number;
  tokens: TokenCounts;
  apiEquivUsd: number;
  unpricedEvents: number | null;
  estimatedPriceEvents: number | null;
  priceStatus: FleetSummaryResponse['totals']['priceStatus'];
  bySource: FleetSummaryResponse['bySource'];
  activeTime: { agentMs: number; wallMs: number };
}): FleetSummaryResponse {
  return {
    host: input.host, range: 'today', generatedAt: NOW,
    totals: {
      events: input.events, tokens: input.tokens, apiEquivUsd: input.apiEquivUsd,
      unpricedEvents: input.unpricedEvents, estimatedPriceEvents: input.estimatedPriceEvents,
      priceStatus: input.priceStatus,
    },
    bySource: input.bySource,
    activeTime: input.activeTime,
  };
}

const fleetTodayBase = {
  range: 'today',
  generatedAt: NOW,
  hosts: [
    {
      label: 'M4a', kind: 'local', status: 'online',
      summary: filedFleetSummary({
        host: 'M4a', events: 842,
        tokens: tok({ inputFresh: 512340, cacheWrite5m: 12000, cacheWrite1h: 340000, cacheRead: 2200000, output: 98100, reasoning: 15000 }),
        apiEquivUsd: 184.32, unpricedEvents: 3, estimatedPriceEvents: 0, priceStatus: 'UNPRICED',
        bySource: fleetBySource({
          claude: { events: 700, tokens: tok({ inputFresh: 400000, cacheWrite5m: 12000, cacheWrite1h: 340000, cacheRead: 2100000, output: 80000, reasoning: 15000 }), apiEquivUsd: 150, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' },
          codex: { events: 120, tokens: tok({ inputFresh: 100000, cacheRead: 100000, output: 15000 }), apiEquivUsd: 30, unpricedEvents: 3, estimatedPriceEvents: 0, priceStatus: 'UNPRICED' },
          'ollama-proxy': { events: 18, tokens: tok({ inputFresh: 12000, output: 3000 }), apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' },
          bench: { events: 4, tokens: tok({ inputFresh: 340, output: 100 }), apiEquivUsd: 4.32, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' },
        }),
        activeTime: { agentMs: 5400000, wallMs: 7200000 },
      }),
    },
    {
      label: 'A2000', kind: 'peer', status: 'online',
      summary: filedFleetSummary({
        host: 'A2000', events: 312,
        tokens: tok({ inputFresh: 390000, cacheWrite1h: 45000, cacheRead: 412000, output: 79000, reasoning: 23000 }),
        apiEquivUsd: 93.18, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST',
        bySource: fleetBySource({
          claude: { events: 192, tokens: tok({ inputFresh: 210000, cacheWrite1h: 45000, cacheRead: 320000, output: 42000, reasoning: 8000 }), apiEquivUsd: 56.2, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' },
          codex: { events: 120, tokens: tok({ inputFresh: 180000, cacheRead: 92000, output: 37000, reasoning: 15000 }), apiEquivUsd: 36.98, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' },
        }),
        activeTime: { agentMs: 3100000, wallMs: 4200000 },
      }),
    },
    {
      label: 'ryzen', kind: 'peer', status: 'online',
      summary: filedFleetSummary({
        host: 'ryzen', events: 94,
        tokens: tok({ inputFresh: 320000, output: 25000 }),
        apiEquivUsd: 12.75, unpricedEvents: null, estimatedPriceEvents: null, priceStatus: null,
        bySource: fleetBySource({
          'ollama-proxy': { events: 94, tokens: tok({ inputFresh: 320000, output: 25000 }), apiEquivUsd: 12.75 },
        }),
        activeTime: { agentMs: 900000, wallMs: 1200000 },
      }),
    },
  ],
} satisfies FleetOverviewResponse;

function scaleFleetTokens(tokens: TokenCounts, factor: number): TokenCounts {
  return {
    ...tokens,
    inputFresh: tokens.inputFresh * factor,
    cacheWrite5m: tokens.cacheWrite5m * factor,
    cacheWrite1h: tokens.cacheWrite1h * factor,
    cacheRead: tokens.cacheRead * factor,
    output: tokens.output * factor,
    reasoning: tokens.reasoning * factor,
    ...(tokens.cacheWriteUnassigned === undefined ? {} : { cacheWriteUnassigned: tokens.cacheWriteUnassigned * factor }),
    ...(tokens.cacheWriteAssumed1h === undefined ? {} : { cacheWriteAssumed1h: tokens.cacheWriteAssumed1h * factor }),
  };
}

function scaleFleetSourceRow(row: FleetSummaryResponse['bySource'][Source], factor: number): FleetSummaryResponse['bySource'][Source] {
  return {
    ...row,
    events: row.events * factor,
    tokens: scaleFleetTokens(row.tokens, factor),
    apiEquivUsd: Math.round(row.apiEquivUsd * factor * 100) / 100,
    ...(row.unpricedEvents === undefined ? {} : { unpricedEvents: row.unpricedEvents * factor }),
    ...(row.estimatedPriceEvents === undefined ? {} : { estimatedPriceEvents: row.estimatedPriceEvents * factor }),
  };
}

function fleetForRange(range: Range, factor: number, rangeIndex: number): FleetOverviewResponse {
  const generatedAt = NOW - rangeIndex * 60_000;
  return {
    range,
    generatedAt,
    hosts: fleetTodayBase.hosts.map((host, hostIndex) => ({
      ...host,
      ...(host.summary ? {
        summary: {
          ...host.summary,
          range,
          // Each host report retains its own query clock, independent of the Fleet response clock.
          generatedAt: generatedAt - (hostIndex + 1) * 5 * 60_000,
          totals: {
            ...host.summary.totals,
            events: host.summary.totals.events * factor,
            tokens: scaleFleetTokens(host.summary.totals.tokens, factor),
            apiEquivUsd: Math.round(host.summary.totals.apiEquivUsd * factor * 100) / 100,
            unpricedEvents: host.summary.totals.unpricedEvents === null ? null : host.summary.totals.unpricedEvents * factor,
            estimatedPriceEvents: host.summary.totals.estimatedPriceEvents === null ? null : host.summary.totals.estimatedPriceEvents * factor,
          },
          bySource: Object.fromEntries(USAGE_SOURCES.map((source) => [source, scaleFleetSourceRow(host.summary!.bySource[source], factor)])) as FleetSummaryResponse['bySource'],
          activeTime: { agentMs: host.summary.activeTime.agentMs * factor, wallMs: host.summary.activeTime.wallMs * factor },
        },
      } : {}),
    })),
  };
}

// Range fixtures deliberately use distinct scales and independent per-host report clocks. These
// are FILED-EXAMPLE aggregates, not measurements or estimates of current fleet usage.
export const fleetToday = fleetForRange('today', 1, 0) satisfies FleetOverviewResponse;
export const fleet24h = fleetForRange('24h', 2, 1) satisfies FleetOverviewResponse;
export const fleet7d = fleetForRange('7d', 7, 2) satisfies FleetOverviewResponse;
export const fleet30d = fleetForRange('30d', 30, 3) satisfies FleetOverviewResponse;
export const fleetAll = fleetForRange('all', 60, 4) satisfies FleetOverviewResponse;

// ── sessions ─────────────────────────────────────────────────────────────────────────────────

export const sessions = [
  {
    source: 'claude',
    unpricedEvents: 0,
    estimatedPriceEvents: 0, priceStatus: 'LIST' as const,
    sessionId: 'a1b2c3d4-1111-4a4a-8b8b-000000000001',
    host: 'M4a',
    project: '/fixture/tokenelo',
    repoRoot: '/fixture/tokenelo',
    models: ['claude-sonnet-5', 'claude-haiku-4-5'],
    start: NOW - 42 * 60_000,
    end: NOW - 1 * 60_000,
    activeMs: 38 * 60_000,
    live: true,
    subagents: 2,
    tokens: tok({ inputFresh: 82000, cacheWrite1h: 40000, cacheRead: 610000, output: 21000 }),
    apiEquivUsd: 18.42,
    burn: { tokensPerMin: 1850, usdPerHour: 26.3 },
  },
  {
    source: 'codex',
    unpricedEvents: 0,
    estimatedPriceEvents: 0, priceStatus: 'LIST' as const,
    sessionId: 'thread_9f8e7d6c5b4a3928',
    host: 'A2000',
    project: '/fixture/kilnfall-rts',
    repoRoot: '/fixture/kilnfall-rts',
    models: ['gpt-6-sol'],
    start: NOW - 130 * 60_000,
    end: NOW - 95 * 60_000,
    activeMs: 22 * 60_000,
    live: false,
    subagents: 0,
    tokens: tok({ inputFresh: 41000, cacheRead: 12000, output: 9800 }),
    apiEquivUsd: 6.11,
    burn: null,
  },
  {
    source: 'ollama-proxy',
    unpricedEvents: 0,
    estimatedPriceEvents: 0, priceStatus: 'LIST' as const,
    sessionId: 'ollama:M4a:qwen3.8:27b:2026-09-26',
    host: 'M4a',
    project: '/fixture/tokenelo-bench',
    models: ['hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL'],
    start: NOW - 12 * 60_000,
    end: NOW - 2 * 60_000,
    activeMs: 9 * 60_000,
    live: true,
    subagents: 0,
    tokens: tok({ inputFresh: 12000, output: 3000 }),
    apiEquivUsd: 0,
    burn: { tokensPerMin: 1000, usdPerHour: 0 },
    telemetry: [{
      host: 'M4a', source: 'ollama-proxy', provider: 'local', engine: 'ollama',
      models: ['hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL'], events: 18,
      tokens: tok({ inputFresh: 12000, output: 3000 }), apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST',
      firstEventAt: NOW - 12 * 60_000, lastEventAt: NOW - 2 * 60_000, flags: { thinkingUnknown: 18 },
    }],
  },
  {
    source: 'claude',
    unpricedEvents: 0,
    estimatedPriceEvents: 0, priceStatus: 'LIST' as const,
    sessionId: 'a1b2c3d4-2222-4a4a-8b8b-000000000002',
    host: 'M4a',
    project: '/fixture/tokenelo/subagents/triage',
    repoRoot: '/fixture/tokenelo',
    models: ['claude-haiku-4-5'],
    start: NOW - 5 * 60 * 60_000,
    end: NOW - 4 * 60 * 60_000 - 40 * 60_000,
    activeMs: 14 * 60_000,
    live: false,
    subagents: 0,
    tokens: tok({ inputFresh: 9000, output: 2100 }),
    apiEquivUsd: 0.14,
    burn: { tokensPerMin: 92, usdPerHour: 0.6 },
  },
] satisfies SessionRow[];

// Strict range-qualified fixtures use distinct FILED-EXAMPLE membership at each widening cutoff,
// so a stale Today list cannot pass the wider-range UI review. The All example contains only this
// sample population and is not a completeness claim. Keep legacy `sessions.json` unscoped.
const HOUR_MS = 60 * 60_000;
function olderFiledSession(sessionId: string, ageMs: number, suffix: string): SessionRow {
  const template = sessions[1];
  return {
    ...template,
    sessionId,
    project: `${template.project}/${suffix}`,
    start: template.start - ageMs,
    end: template.end - ageMs,
    live: false,
  };
}
const filed24hSession = olderFiledSession('a1b2c3d4-2222-4a4a-8b8b-000000000024', 18 * HOUR_MS, 'filed-24h');
const filed7dSession = olderFiledSession('a1b2c3d4-3333-4a4a-8b8b-000000000007', 2 * DAY_MS, 'filed-7d');
const filed30dSession = olderFiledSession('a1b2c3d4-4444-4a4a-8b8b-000000000030', 14 * DAY_MS, 'filed-30d');
const filedAllSession = olderFiledSession('a1b2c3d4-5555-4a4a-8b8b-000000000045', 45 * DAY_MS, 'filed-all');
function sessionsForRange(range: Range, startMs: number | null, rows: SessionRow[] = sessions): SessionsResponse {
  return { range, generatedAt: NOW, timeBasis: rangeTimeBasis(startMs), sessions: rows };
}
export const sessionsToday = sessionsForRange('today', FILED_EXAMPLE_TODAY_START) satisfies SessionsResponse;
export const sessions24h = sessionsForRange('24h', twentyFourHourStart, [...sessions, filed24hSession]) satisfies SessionsResponse;
export const sessions7d = sessionsForRange('7d', sevenDayStart, [...sessions, filed24hSession, filed7dSession]) satisfies SessionsResponse;
export const sessions30d = sessionsForRange('30d', thirtyDayStart, [...sessions, filed24hSession, filed7dSession, filed30dSession]) satisfies SessionsResponse;
export const sessionsAll = sessionsForRange('all', null,
  [...sessions, filed24hSession, filed7dSession, filed30dSession, filedAllSession]) satisfies SessionsResponse;

// ── limits ───────────────────────────────────────────────────────────────────────────────────

export const limits = {
  snapshots: [
    {
      source: 'codex',
      limitId: 'codex',
      host: 'A2000',
      account: 'example (Codex Plus)',
      capturedAt: NOW - 5 * 60_000,
      planType: 'plus',
      windows: [
        { id: 'primary', usedPercent: 42.5, windowMinutes: 300, resetsAt: NOW + 3 * 60 * 60_000 },
        { id: 'secondary', usedPercent: 71.2, windowMinutes: 10080, resetsAt: NOW + 4 * 24 * 60 * 60_000 },
      ],
      credits: { hasCredits: true, unlimited: false, balance: '12.40' },
      estimate: false,
    },
    {
      // Build item 2: real plan-window % parsed from the Desktop app's own plan-usage-history.json
      // — rendered ABOVE the block estimate (app.ts's renderLimits iterates snapshots in the
      // order the API returns them; queries.ts#getLimits puts every stored snapshot, incl. this
      // one, before the computed block-estimate rows).
      source: 'claude-desktop',
      host: 'M4a',
      account: 'a1b2c3d4e5f60718', // hashOrgId output — never the raw org UUID
      capturedAt: NOW - 90_000,
      windows: [
        { id: 'five_hour', usedPercent: 58 },
        { id: 'seven_day', usedPercent: 61 },
      ],
      estimate: false,
    },
    {
      source: 'claude-block-estimate',
      host: 'M4a',
      account: 'founder@example.com (Claude Max)',
      capturedAt: NOW - 1 * 60_000,
      windows: [
        { id: 'five_hour', usedPercent: 63.8, windowMinutes: 300, resetsAt: NOW + 96 * 60_000 },
        {
          // block_estimate (§15.9.5): tokens/$ used so far in the current 5h block, current burn
          // rate, and the linear projection to the block's end — new LimitWindow fields (tray
          // task item 6).
          id: 'block_estimate',
          usedPercent: null,
          startedAt: NOW - 3 * 60 * 60_000 - 12 * 60_000,
          tokens: 182_400,
          apiEquivUsd: 34.2,
          burnTokensPerMin: 950,
          projectedTokens: 251_000,
          projectedUsd: 47.05,
        },
      ],
      estimate: true,
      // FILED-EXAMPLE groups already included in the parent block totals; not additional usage.
      contributors: [
        {
          "host": "M4a",
          "model": "claude-sonnet-5",
          "provider": "anthropic",
          "servingRoutes": [
            {
              "kind": "unrecorded"
            }
          ],
          "priceVersion": "FILED-EXAMPLE-v1",
          "tsSource": "line",
          "firstEventAt": 1790460000000,
          "lastEventAt": 1790460000000,
          "events": 1,
          "tokens": {
            "inputFresh": 150000,
            "cacheWrite5m": 5000,
            "cacheWrite1h": 0,
            "cacheWriteUnassigned": 0,
            "cacheRead": 20000,
            "output": 4000,
            "reasoning": 0,
            "countQuality": "unrecorded"
          },
          "knownApiEquivUsd": 34.2,
          "priceStatusCounts": {
            "LIST": 1,
            "ESTIMATE": 0,
            "UNPRICED": 0,
            "unknown": 0
          },
          "priceEvidence": {
            "version": 1,
            "events": 1,
            "invalidAmountEvents": 0,
            "unknownStatusEvents": 0,
            "statusAmountConflictEvents": 0,
            "issuesEvents": 0,
            "aggregateAmountInvalid": false
          }
        },
        {
          "host": "M4a",
          "model": "unspecified",
          "provider": "unknown",
          "servingRoutes": [
            {
              "kind": "unknown",
              "evidence": "unrecorded"
            }
          ],
          "priceVersion": "FILED-EXAMPLE-unrecorded",
          "tsSource": "activity",
          "firstEventAt": 1790466000000,
          "lastEventAt": 1790466000000,
          "events": 1,
          "tokens": {
            "inputFresh": 3000,
            "cacheWrite5m": 0,
            "cacheWrite1h": 0,
            "cacheWriteUnassigned": 0,
            "cacheRead": 0,
            "output": 400,
            "reasoning": 0,
            "countQuality": "unrecorded"
          },
          "knownApiEquivUsd": null,
          "priceStatusCounts": {
            "LIST": 0,
            "ESTIMATE": 0,
            "UNPRICED": 1,
            "unknown": 0
          },
          "priceEvidence": {
            "version": 1,
            "events": 1,
            "invalidAmountEvents": 0,
            "unknownStatusEvents": 0,
            "statusAmountConflictEvents": 0,
            "issuesEvents": 0,
            "aggregateAmountInvalid": false
          }
        }
      ],
    },
  ] satisfies LimitSnapshot[],
} satisfies LimitsResponse;

// ── timeseries-<range> ───────────────────────────────────────────────────────────────────────

function distributeWeighted(total: number | null, weights: readonly number[], precision = 1): (number | null)[] {
  if (total === null) return weights.map(() => null);
  if (weights.length === 0) return [];
  const units = Math.round(total * precision);
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const exact = weights.map((weight) => units * (weightTotal > 0 ? weight / weightTotal : 1 / weights.length));
  const allocated = exact.map(Math.floor);
  let remaining = units - allocated.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, remainder: value - allocated[index]! }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let i = 0; i < remaining; i++) allocated[order[i]!.index]!++;
  return allocated.map((value) => value / precision);
}

function freshSeriesTokens(tokens: TokenCounts): number {
  return tokens.inputFresh + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.output;
}

function completeSeriesTokens(tokens: TokenCounts): number {
  return tokens.inputFresh + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead + tokens.output;
}

function tsPoints(summary: SummaryResponse, n: number, stepMs: number, startMs: number): TimeseriesResponse['points'] {
  const weights = Array.from({ length: n }, (_, index) => {
    const i = n - 1 - index;
    const claude = Math.max(0, 8 + Math.sin(i / 3) * 4 + i * 0.2);
    const codex = Math.max(0, 3 + Math.cos(i / 4) * 2);
    return claude + codex;
  });
  const bySourceSeries = {} as Record<Source, (number | null)[]>;
  for (const source of SOURCES) bySourceSeries[source] = distributeWeighted(summary.bySource[source].apiEquivUsd, weights, 100);
  const v1Tokens = distributeWeighted(freshSeriesTokens(summary.totals.tokens), weights);
  const totalTokens = distributeWeighted(completeSeriesTokens(summary.totals.tokens), weights);

  return weights.map((_, index) => {
    const bySource = {} as Partial<Record<Source, number>>;
    let apiEquivUsd = 0;
    for (const source of SOURCES) {
      const value = bySourceSeries[source][index]!;
      if (value !== null) {
        bySource[source] = value;
        apiEquivUsd += value;
      }
    }
    return {
      t: startMs + index * stepMs,
      apiEquivUsd,
      tokens: v1Tokens[index]!,
      totalTokens: totalTokens[index]!,
      bySource,
    };
  });
}

const todayHours = Math.ceil((NOW - FILED_EXAMPLE_TODAY_START) / (60 * 60_000));

export const timeseriesToday = {
  range: 'today' as Range,
  bucket: 'hour' as const,
  generatedAt: NOW,
  timeBasis: FILED_EXAMPLE_TODAY_BASIS,
  points: tsPoints(summaryToday, todayHours, 60 * 60_000, FILED_EXAMPLE_TODAY_START),
} satisfies TimeseriesResponse;
export const timeseries7d = {
  range: '7d' as Range,
  bucket: 'day' as const,
  generatedAt: NOW,
  timeBasis: rangeTimeBasis(sevenDayStart),
  points: tsPoints(summary7d, 7, DAY_MS, sevenDayStart),
} satisfies TimeseriesResponse;
export const timeseries30d = {
  range: '30d' as Range,
  bucket: 'day' as const,
  generatedAt: NOW,
  timeBasis: rangeTimeBasis(thirtyDayStart),
  points: tsPoints(summary30d, 30, DAY_MS, thirtyDayStart),
} satisfies TimeseriesResponse;

// ── doctor ───────────────────────────────────────────────────────────────────────────────────

export const doctor = {
  host: 'M4a',
  generatedAt: NOW,
  skippedPaths: [
    { reason: 'memory-vault' as SkipReason, count: 412, examples: ['/fixture/memory-vault/session-1.jsonl'] },
    { reason: 'sync-conflict' as SkipReason, count: 3, examples: ['/fixture/proj/a.sync-conflict-20260920.jsonl'] },
  ],
  unmatchedModels: [{ model: 'codex-auto-review', events: 3 }],
  thinkingUnknownEvents: 5,
  codex: { resetFiles: 2, inheritedBaselineFiles: 14, suspectFiles: 1, recordReconciledFiles: 0, nonZeroCacheWrite: 0, ownInWrapperFiles: 2, ownInWrapperEvents: 2, trailingRecordFiles: 0 },
  claude: { speedAssumed: 269, cacheSplitAssumed: 842, iterationEvents: 12, reasoningClamped: 0 },
  ollama: {
    servers: [
      { address: '127.0.0.1:11434', family: 'IPv4', version: '0.32.13', binary: 'ollama (homebrew)', logPath: '/opt/homebrew/var/log/ollama.log', logAvailable: true },
      { address: '[::1]:11434', family: 'IPv6', version: '0.34.2', binary: 'Ollama.app', logAvailable: false },
    ],
    unmeteredRequests: 0,
    capture: 'serverlog',
  },
  warnings: [
    'A2000 Codex: 1 rollout flagged inheritedBaselineSuspect (unexplained baseline after a turn).',
    'M4a: two Ollama servers detected; serverlog capture is best-effort (ESTIMATE).',
  ],
} satisfies DoctorReport;

// ── coverage (build item 6) ──────────────────────────────────────────────────────────────────

function collectorScanFixture(name: string, overrides: Partial<CollectorScanStatus> = {}): CollectorScanStatus {
  return { name, intervalMs: 30_000, running: false, rerunQueued: false, currentStartedAt: null,
    lastStartedAt: NOW - 4_000, lastFinishedAt: NOW - 3_975, lastCompletedAt: NOW - 3_975,
    lastFailedAt: null, lastOutcome: 'completed', lastDurationMs: 25,
    lastStats: { filesScanned: 12, filesSkipped: 0, recordsEmitted: 0, bytesRead: 0, warningCount: 0 },
    ...overrides,
  };
}

export const coverage = {
  host: 'M4a',
  generatedAt: NOW,
  collectorScans: [
    collectorScanFixture('claude'),
    collectorScanFixture('codex', { lastOutcome: 'failed', lastFailedAt: NOW - 3_975,
      lastCompletedAt: NOW - 2 * 60_000, lastStats: null }),
    collectorScanFixture('qwen-code', { running: true, currentStartedAt: NOW - 2 * 60_000,
      lastStartedAt: NOW - 2 * 60_000, lastFinishedAt: NOW - 3 * 60_000,
      lastCompletedAt: NOW - 3 * 60_000, rerunQueued: true }),
    collectorScanFixture('ollama-serverlog', { intervalMs: 10_000, lastOutcome: 'warnings',
      lastStats: { filesScanned: 1, filesSkipped: 1, recordsEmitted: 6, bytesRead: 2048, warningCount: 2 } }),
    collectorScanFixture('claude-desktop-plan-usage'),
    collectorScanFixture('claude-desktop-sessions'),
  ],
  tools: [
    { id: 'claude-code-cli', name: 'Claude Code CLI', category: 'cloud-agent-cli', installed: true, running: false, captured: true, lastEventAt: NOW - 5 * 60_000 },
    { id: 'codex-cli', name: 'Codex CLI', category: 'cloud-agent-cli', installed: true, running: true, captured: true, lastEventAt: NOW - 60_000 },
    { id: 'codex-desktop-rocky', name: 'Codex Desktop ("Rocky")', category: 'cloud-agent-desktop', installed: true, running: true, captured: true, lastEventAt: NOW - 60_000 },
    { id: 'qwen-code-cli', name: 'Qwen Code CLI', category: 'cloud-agent-cli', installed: true, running: false, captured: true, lastEventAt: NOW - 40 * 60_000 },
    { id: 'ollama', name: 'Ollama', category: 'local-llm-server', installed: true, running: true, captured: true, lastEventAt: NOW - 2 * 60_000 },
    { id: 'docker-model-runner', name: 'Docker Model Runner', category: 'local-llm-server', installed: true, running: true, captured: false, lastEventAt: null },
    { id: 'vllm', name: 'vLLM', category: 'local-llm-server', installed: false, running: false, captured: false, lastEventAt: null },
    { id: 'claude-desktop', name: 'Claude Desktop app', category: 'cloud-agent-desktop', installed: true, running: true, captured: true, lastEventAt: NOW - 15 * 60_000 },
    {
      id: 'claude-desktop-chat',
      name: 'Claude Desktop — plain chat (non-Code)',
      category: 'cloud-agent-desktop',
      installed: false,
      running: false,
      captured: false,
      lastEventAt: null,
      reason: 'claude.ai chat conversations are metered server-side; only a usage-percent history persists locally (captured separately)',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      category: 'cloud-agent-desktop',
      installed: false,
      running: false,
      captured: false,
      lastEventAt: null,
      reason: 'the local ai-tracking DB has zero token/cost columns; real usage lives only in Cursor\'s cloud dashboard',
    },
    { id: 'gemini-cli', name: 'Gemini CLI', category: 'cloud-agent-cli', installed: false, running: false, captured: false, lastEventAt: null },
    { id: 'lm-studio', name: 'LM Studio', category: 'local-llm-server', installed: false, running: false, captured: false, lastEventAt: null },
  ],
} satisfies CoverageResponse;

// ── processes (build item 5) ─────────────────────────────────────────────────────────────────

export const processes = {
  host: 'M4a',
  generatedAt: NOW,
  processes: [
    { pid: 4821, ppid: 1, startedAt: NOW - 40 * 60_000, exe: '/opt/homebrew/bin/claude', host: 'M4a', tool: 'claude-code-cli', subcommand: '-p' },
    { pid: 9012, ppid: 1, startedAt: NOW - 12 * 60_000, exe: '/Users/example/.local/bin/codex', host: 'M4a', tool: 'codex-cli', subcommand: 'exec' },
    { pid: 501, ppid: 1, startedAt: NOW - 8 * 3_600_000, exe: '/opt/homebrew/bin/ollama', host: 'M4a', tool: 'ollama', subcommand: 'serve', cwd: '/Users/example' },
  ],
} satisfies ProcessesResponse;

// ── session-detail ───────────────────────────────────────────────────────────────────────────

const SESSION_DETAIL_START = NOW - 42 * 60_000;
const SESSION_DETAIL_END = NOW - 1 * 60_000;

function sessionDetailTimeseries(): SessionDetail['timeseries'] {
  const bucketMs = 5 * 60_000;
  const points: SessionDetail['timeseries']['points'] = [];
  const bucketCount = Math.ceil((SESSION_DETAIL_END - SESSION_DETAIL_START) / bucketMs);
  const weights = Array.from({ length: bucketCount }, (_, i) => Math.max(0.02, 0.2 + Math.sin(i / 2) * 0.15 + i * 0.02));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0;
  let previousUsd = 0;
  let previousTokens = 0;
  let previousTotalTokens = 0;
  for (let i = 0; i < bucketCount; i++) {
    const t = Math.floor(SESSION_DETAIL_START / bucketMs) * bucketMs + i * bucketMs;
    cumulative += weights[i];
    const fraction = i === bucketCount - 1 ? 1 : cumulative / weightTotal;
    // Allocate exact whole cents/tokens; the chart must reconcile with detail totals.
    const usdCents = Math.round(1842 * fraction);
    const tokens = Math.round(143000 * fraction);
    const totalTokens = Math.round(753000 * fraction);
    const usd = (usdCents - previousUsd) / 100;
    points.push({
      t,
      apiEquivUsd: usd,
      tokens: tokens - previousTokens,
      totalTokens: totalTokens - previousTotalTokens,
      bySource: { claude: usd },
    });
    previousUsd = usdCents;
    previousTokens = tokens;
    previousTotalTokens = totalTokens;
  }
  return { bucketMs, points };
}

export const sessionDetailClaude = {
  source: 'claude' as Source,
  sessionId: 'a1b2c3d4-1111-4a4a-8b8b-000000000001',
  host: 'M4a',
  project: '/fixture/tokenelo',
  repoRoot: '/fixture/tokenelo',
  models: ['claude-sonnet-5', 'claude-haiku-4-5'],
  start: SESSION_DETAIL_START,
  end: SESSION_DETAIL_END,
  activeMs: 38 * 60_000,
  live: true,
  subagents: 2,
  tokens: tok({ inputFresh: 82000, cacheWrite1h: 40000, cacheRead: 610000, output: 21000 }),
  apiEquivUsd: 18.42,
  burn: { tokensPerMin: 1850, usdPerHour: 26.3 },
  byModel: [
    {
      model: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      provider: 'anthropic' as Provider,
      source: 'claude' as Source,
      thinking: 'thinking',
      events: 26,
      tokens: tok({ inputFresh: 60000, cacheWrite1h: 40000, cacheRead: 500000, output: 15000 }),
      apiEquivUsd: 14.5,
      priceStatus: 'LIST',
    },
    {
      model: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      provider: 'anthropic',
      source: 'claude',
      thinking: 'unknown',
      events: 4,
      tokens: tok({ inputFresh: 10000, cacheRead: 90000, output: 3000 }),
      apiEquivUsd: 2.4,
      priceStatus: 'LIST',
    },
    {
      model: 'claude-haiku-4-5',
      displayName: 'Claude Haiku 4.5',
      provider: 'anthropic',
      source: 'claude',
      thinking: 'non-thinking',
      events: 12,
      tokens: tok({ inputFresh: 12000, cacheRead: 20000, output: 3000 }),
      apiEquivUsd: 1.52,
      priceStatus: 'LIST',
    },
  ] satisfies ModelRow[],
  timeseries: sessionDetailTimeseries(),
  subagentSessions: [
    {
      sessionId: 'a1b2c3d4-1111-4a4a-8b8b-000000000001-sub-1',
      unpricedEvents: 0,
      estimatedPriceEvents: 0,
      priceStatus: 'LIST' as const,
      models: ['claude-haiku-4-5'],
      start: SESSION_DETAIL_START + 4 * 60_000,
      end: SESSION_DETAIL_START + 9 * 60_000,
      activeMs: 4 * 60_000,
      live: false,
      tokens: tok({ inputFresh: 6000, cacheRead: 9000, output: 1400 }),
      apiEquivUsd: 0.71,
    },
    {
      sessionId: 'a1b2c3d4-1111-4a4a-8b8b-000000000001-sub-2',
      unpricedEvents: 0,
      estimatedPriceEvents: 0,
      priceStatus: 'LIST' as const,
      models: ['claude-haiku-4-5'],
      start: SESSION_DETAIL_START + 20 * 60_000,
      end: SESSION_DETAIL_START + 24 * 60_000,
      activeMs: 3 * 60_000,
      live: false,
      tokens: tok({ inputFresh: 6000, cacheRead: 11000, output: 1600 }),
      apiEquivUsd: 0.81,
    },
  ],
  cacheReadShare: 610000 / (82000 + 40000 + 610000),
  thinkingShare: 26 / (26 + 12),
  thinkingUnknownEvents: 4,
  events: 42,
  firstEventTs: SESSION_DETAIL_START + 30_000,
  lastEventTs: SESSION_DETAIL_END - 15_000,
  wallMs: SESSION_DETAIL_END - SESSION_DETAIL_START,
  flags: { speedAssumed: 5, cacheSplitAssumed: 2, thinkingUnknown: 4 },
  gitBranch: 'main',
  entrypoint: 'cli',
  telemetry: [{
    host: 'M4a', source: 'claude', provider: 'anthropic', models: ['claude-sonnet-5', 'claude-haiku-4-5'],
    events: 42, tokens: tok({ inputFresh: 82000, cacheWrite1h: 40000, cacheRead: 610000, output: 21000 }),
    apiEquivUsd: 18.42, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST',
    firstEventAt: SESSION_DETAIL_START + 30_000, lastEventAt: SESSION_DETAIL_END - 15_000,
    flags: { speedAssumed: 5, cacheSplitAssumed: 2, thinkingUnknown: 4 },
  }],
  desktopMeta: {
    cliSessionId: 'a1b2c3d4-1111-4a4a-8b8b-000000000001', title: 'Review Tokenelo telemetry drill-downs',
    cwd: '/fixture/tokenelo/.worktrees/ui', originCwd: '/fixture/tokenelo', model: 'claude-sonnet-5',
    effort: 'high', isArchived: false, createdAt: SESSION_DETAIL_START, lastActivityAt: SESSION_DETAIL_END,
    prNumber: 77, prRepository: 'example-org/tokenelo', prState: 'OPEN',
    prUrl: 'https://example.invalid/example-org/tokenelo/pull/77',
  },
  unpricedEvents: 0,
  estimatedPriceEvents: 0, priceStatus: 'LIST' as const,
} satisfies SessionDetail;

export const sessionDetailLocal = {
  ...sessions[2],
  byModel: byModelToday.filter((row) => row.provider === 'local'),
  timeseries: { bucketMs: 300_000, points: [
    { t: Math.floor((NOW - 12 * 60_000) / 300_000) * 300_000, apiEquivUsd: 0, tokens: 4500, totalTokens: 4500, bySource: { 'ollama-proxy': 0 } },
    { t: Math.floor((NOW - 7 * 60_000) / 300_000) * 300_000, apiEquivUsd: 0, tokens: 7000, totalTokens: 7000, bySource: { 'ollama-proxy': 0 } },
    { t: Math.floor((NOW - 2 * 60_000) / 300_000) * 300_000, apiEquivUsd: 0, tokens: 3500, totalTokens: 3500, bySource: { 'ollama-proxy': 0 } },
  ] },
  subagentSessions: [], cacheReadShare: 0, thinkingShare: null, thinkingUnknownEvents: 18, events: 18,
  firstEventTs: NOW - 12 * 60_000, lastEventTs: NOW - 2 * 60_000, wallMs: 10 * 60_000,
  flags: { thinkingUnknown: 18 },
  unpricedEvents: 0,
  estimatedPriceEvents: 0, priceStatus: 'LIST' as const,
} satisfies SessionDetail;

export const allFixtures = {
  'summary-today.json': summaryToday,
  'summary-24h.json': summary24h,
  'summary-7d.json': summary7d,
  'summary-30d.json': summary30d,
  'summary-all.json': summaryAll,
  'fleet-today.json': fleetToday,
  'fleet-24h.json': fleet24h,
  'fleet-7d.json': fleet7d,
  'fleet-30d.json': fleet30d,
  'fleet-all.json': fleetAll,
  'sessions.json': sessions,
  'sessions-today.json': sessionsToday,
  'sessions-24h.json': sessions24h,
  'sessions-7d.json': sessions7d,
  'sessions-30d.json': sessions30d,
  'sessions-all.json': sessionsAll,
  'limits.json': limits,
  'timeseries-today.json': timeseriesToday,
  'timeseries-7d.json': timeseries7d,
  'timeseries-30d.json': timeseries30d,
  'doctor.json': doctor,
  'coverage.json': coverage,
  'processes.json': processes,
  'session-detail-claude-a1b2c3d4-1111-4a4a-8b8b-000000000001.json': sessionDetailClaude,
  // Generic fallback (api-client.ts#sessionDetailFixtureNames): any session id whose sanitized
  // filename doesn't have its own dedicated fixture falls back to this one, same pattern as
  // summary-<range>.json falling back to summary-today.json.
  'session-detail.json': sessionDetailClaude,
  'session-detail-ollama-proxy-ollama_M4a_qwen3_8_27b_2026-09-26.json': sessionDetailLocal,
};
