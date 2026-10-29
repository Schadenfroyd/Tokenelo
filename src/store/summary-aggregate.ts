/**
 * Summary's aggregate assembly, as steps (see docs/RESPONSIVENESS-2026-10-03.md, "Summary aggregate read and assembly").
 *
 * The rows come from one aggregate read (the original `selectAgg` statement, or its keyset pages, which keep the same order).
 * This module folds them in that order into the totals, the per-source rows and the per-model rows. Each fold is the one the
 * unpaged assembly performed, in the same order: float sums are order-sensitive, and the order is the row order that
 * the aggregate read returns. Model groups retain the recorded provider as well as source, model and thinking mode;
 * nothing here reorders a within-group sum.
 *
 * Bounds. `AGG_STEP_ROWS` is a row-count bound: the generator yields after every AGG_STEP_ROWS rows, so one synchronous step
 * folds at most that many rows. It is not a time bound. Finishing the groups is O(number of groups), not O(rows).
 */
import type { PriceStatus, Source, SummaryResponse, TokenCounts, ModelRow } from '../core/types.js';
import { ZERO_TOKENS } from '../core/types.js';
import { addTokenCounts, normalizeCountQuality } from '../core/token-counts.js';
import { storedNativeTokenFields } from '../core/token-field-evidence.js';
import { hasEstimatedDollars, priceStatusOfCounts } from '../core/price-quality.js';
import { addPriceEvidence, emptyPriceEvidence, qualifyAggregateAmount, type PriceEvidence } from '../core/price-evidence.js';

/** One event row as the aggregate read returns it (the columns Summary uses). */
export interface RawEventAgg {
  field_components_json?: string | null;
  count_revision?: number | null;
  source: Source;
  model: string;
  provider: string;
  price_status: string;
  api_equiv_usd: number | null;
  input_fresh: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_unassigned?: number | null;
  cache_write_assumed_1h?: number | null;
  count_quality?: TokenCounts['countQuality'] | null;
  ucu_count_quality?: TokenCounts['countQuality'] | null;
  cache_read: number;
  output: number;
  reasoning: number;
  thinking: number | null;
}

/** Rows folded per synchronous step: a row-count bound, not a time bound. */
export const AGG_STEP_ROWS = 4000;

/** `events.thinking` (1/0/NULL) -> the tray's per-model bucket (founder req. 2026-09-27). */
export function thinkingBucket(v: number | null): 'thinking' | 'non-thinking' | 'unknown' {
  return v === null ? 'unknown' : v !== 0 ? 'thinking' : 'non-thinking';
}

/** Builds one row's token value. Each unchanged target fold retains the original row and category addition order. */
function rowTokens(r: RawEventAgg): TokenCounts {
  const countQuality = normalizeCountQuality(r.count_quality);
  const ucuQuality = normalizeCountQuality(r.ucu_count_quality ?? r.count_quality);
  const tokens: TokenCounts = { inputFresh: r.input_fresh, cacheWrite5m: r.cache_write_5m, cacheWrite1h: r.cache_write_1h,
    cacheRead: r.cache_read, output: r.output, reasoning: r.reasoning,
    ...(r.cache_write_unassigned == null ? {} : { cacheWriteUnassigned: r.cache_write_unassigned }),
    ...(r.cache_write_assumed_1h == null ? {} : { cacheWriteAssumed1h: r.cache_write_assumed_1h }),
    countQuality,
    ...(ucuQuality !== countQuality ? { ucuCountQuality: ucuQuality } : {}) };
  const fields = storedNativeTokenFields(r.field_components_json, tokens, r.count_revision);
  if (fields) tokens.fieldEvidence = fields;
  return tokens;
}

interface SourceAcc {
  events: number;
  /** Rows of this source with no dollar figure / with an ESTIMATE price (their own rows, never whole-host). */
  unpriced: number;
  estimated: number;
  tokens: TokenCounts;
  usd: number;
  priceEvidence: PriceEvidence;
}

interface ModelAcc {
  first: Pick<RawEventAgg, 'model' | 'provider' | 'source' | 'thinking'>;
  events: number;
  tokens: TokenCounts;
  usd: number;
  /** True while every row's api_equiv_usd is null (the model row then reports null, not 0). */
  allNull: boolean;
  unpriced: number;
  estimated: number;
  priceEvidence: PriceEvidence;
}

export interface AggregateParts {
  unpricedEvents: number;
  /** Events whose dollars are ESTIMATE-priced (a derived rate column was billed). */
  estimatedEvents: number;
  /** Weakest price status over the rows: LIST, ESTIMATE or UNPRICED. */
  /** null when there are no events (nothing priced, so no status is claimed). */
  totalsPriceStatus: 'LIST' | 'ESTIMATE' | 'UNPRICED' | null;
  totalsPriceEvidence: PriceEvidence;
  apiEquivUsd: number;
  totalsTokens: TokenCounts;
  bySource: SummaryResponse['bySource'];
  byModel: ModelRow[];
}

/**
 * Folds the rows in order into the Summary aggregate parts. Yields after every AGG_STEP_ROWS rows. `displayName` resolves a
 * model's display name (the pricing engine's; the model id when unknown). The result is the same whether the generator is
 * drained synchronously or paused between steps.
 */
function* aggregateRows(
  displayName: (model: string, provider?: ModelRow['provider']) => string
): Generator<void, AggregateParts, RawEventAgg | null> {
  let unpricedEvents = 0;
  let estimatedEvents = 0;
  let apiEquivUsd = 0;
  const totalsTokens: TokenCounts = { ...ZERO_TOKENS };
  const bySourceAcc = new Map<Source, SourceAcc>();
  const byModelAcc = new Map<string, ModelAcc>();
  const totalsPriceEvidence = emptyPriceEvidence();

  let n = 0;
  for (;;) {
    const r = yield;
    if (r === null) break;
    // Normalize this row once. addTokenCounts reads value and mutates only each target;
    // target additions still occur in the original totals/source/model and row order.
    const tokens = rowTokens(r);
    const unpriced = r.api_equiv_usd === null;
    const estimated = hasEstimatedDollars(r.api_equiv_usd, r.price_status);
    if (unpriced) unpricedEvents++;
    if (estimated) estimatedEvents++;
    apiEquivUsd = apiEquivUsd + (r.api_equiv_usd ?? 0);
    addPriceEvidence(totalsPriceEvidence, r.api_equiv_usd, r.price_status);
    addTokenCounts(totalsTokens, tokens);

    let s = bySourceAcc.get(r.source);
    if (!s) {
      s = { events: 0, unpriced: 0, estimated: 0, tokens: { ...ZERO_TOKENS }, usd: 0, priceEvidence: emptyPriceEvidence() };
      bySourceAcc.set(r.source, s);
    }
    s.events++;
    if (unpriced) s.unpriced++;
    if (estimated) s.estimated++;
    addTokenCounts(s.tokens, tokens);
    s.usd = s.usd + (r.api_equiv_usd ?? 0);
    addPriceEvidence(s.priceEvidence, r.api_equiv_usd, r.price_status);

    // Keep the recorded provider: a later model-table mapping must not relabel older unknown-provider events.
    // Thinking modes remain separate too (founder req. 2026-09-27).
    const key = `${r.source}\u0000${r.provider}\u0000${r.model}\u0000${thinkingBucket(r.thinking)}`;
    let m = byModelAcc.get(key);
    if (!m) {
      m = {
        first: { model: r.model, provider: r.provider, source: r.source, thinking: r.thinking },
        events: 0,
        tokens: { ...ZERO_TOKENS },
        usd: 0,
        allNull: true,
        unpriced: 0, estimated: 0, priceEvidence: emptyPriceEvidence(),
      };
      byModelAcc.set(key, m);
    }
    m.events++;
    addTokenCounts(m.tokens, tokens);
    m.usd = m.usd + (r.api_equiv_usd ?? 0);
    if (r.api_equiv_usd !== null) m.allNull = false;
    if (unpriced) m.unpriced++;
    if (estimated) m.estimated++;
    addPriceEvidence(m.priceEvidence, r.api_equiv_usd, r.price_status);

    n++;
  }

  const bySource = {} as SummaryResponse['bySource'];
  for (const [source, s] of bySourceAcc) {
    qualifyAggregateAmount(s.priceEvidence, s.usd);
    bySource[source] = {
      events: s.events,
      tokens: s.tokens,
      apiEquivUsd: s.usd,
      unpricedEvents: s.unpriced,
      estimatedPriceEvents: s.estimated,
      priceStatus: priceStatusOfCounts(s.events, s.unpriced, s.estimated, s.priceEvidence),
      priceEvidence: s.priceEvidence,
    };
  }

  const byModel: ModelRow[] = [];
  for (const m of byModelAcc.values()) {
    qualifyAggregateAmount(m.priceEvidence, m.usd);
    const priceStatus = priceStatusOfCounts(m.events, m.unpriced, m.estimated, m.priceEvidence);
    byModel.push({
      model: m.first.model,
      displayName: displayName(m.first.model, m.first.provider as ModelRow['provider']),
      provider: m.first.provider as ModelRow['provider'],
      source: m.first.source,
      thinking: thinkingBucket(m.first.thinking),
      events: m.events,
      tokens: m.tokens,
      apiEquivUsd: m.allNull ? null : m.usd,
      priceStatus,
      unpricedEvents: m.unpriced, estimatedPriceEvents: m.estimated, priceEvidence: m.priceEvidence,
    });
  }
  byModel.sort((a, b) => b.events - a.events);

  qualifyAggregateAmount(totalsPriceEvidence, apiEquivUsd);
  return {
    unpricedEvents,
    estimatedEvents,
    totalsPriceStatus: priceStatusOfCounts(n, unpricedEvents, estimatedEvents, totalsPriceEvidence),
    totalsPriceEvidence,
    apiEquivUsd,
    totalsTokens,
    bySource,
    byModel,
  };
}

/** Request-local fold: no full input array is retained. Memory still grows with distinct
 * source/model groups; this is not a whole-report memory or time bound. */
export class SummaryAggregate {
  private readonly rows: Generator<void, AggregateParts, RawEventAgg | null>;
  private count = 0;
  private finished = false;

  constructor(displayName: (model: string, provider?: ModelRow['provider']) => string) {
    this.rows = aggregateRows(displayName);
    this.rows.next();
  }

  get events(): number { return this.count; }

  add(row: RawEventAgg): void {
    if (this.finished) throw new Error('Summary fold is already finished');
    this.rows.next(row);
    this.count++;
  }

  finish(): AggregateParts {
    if (this.finished) throw new Error('Summary fold is already finished');
    this.finished = true;
    const result = this.rows.next(null);
    if (!result.done) throw new Error('Summary fold did not finish');
    return result.value;
  }
}

/** Array-based callers use the same ordered fold, preserving the existing pause policy. */
export function* summaryAggregateSteps(rows: readonly RawEventAgg[], displayName: (model: string, provider?: ModelRow['provider']) => string): Generator<void, AggregateParts, void> {
  const aggregate = new SummaryAggregate(displayName);
  let n = 0;
  for (const row of rows) {
    aggregate.add(row);
    if (++n % AGG_STEP_ROWS === 0) yield;
  }
  return aggregate.finish();
}
