import type { QueryTimeBasis, Range, Source, TokenCounts } from '../core/types.js';
import { USAGE_SOURCES, ZERO_TOKENS } from '../core/types.js';
import { addTokenCounts, normalizeCountQuality } from '../core/token-counts.js';
import { storedNativeTokenFields } from '../core/token-field-evidence.js';
import { hasEstimatedDollars, priceStatusOfCounts } from '../core/price-quality.js';
import { rangeSince } from '../core/query-range.js';
import { checkRead } from '../core/read-control.js';
import { recordedQueryTimeBasis } from './query-time-basis.js';
import { openReadSnapshot, visitRows, type PageOptions, type RowQuery } from './read-snapshot.js';
import { addPriceEvidence, emptyPriceEvidence, qualifyAggregateAmount, type PriceEvidence } from '../core/price-evidence.js';

export interface UsageAggregateRow {
  events: number;
  tokens: TokenCounts;
  apiEquivUsd: number;
  unpricedEvents: number;
  estimatedPriceEvents: number;
  priceStatus: 'LIST' | 'ESTIMATE' | 'UNPRICED' | null;
  priceEvidence?: PriceEvidence;
}
type UsageAggregateSourceRow = Omit<UsageAggregateRow, 'unpricedEvents' | 'estimatedPriceEvents' | 'priceStatus'>
  & Partial<Pick<UsageAggregateRow, 'unpricedEvents' | 'estimatedPriceEvents' | 'priceStatus'>>;
type AggregateSource = Source | 'unrecognized-source';
/** Stored counts/dollars only. No identities, config, pricing/rate engines, sessions or models. */
export interface UsageAggregateResponse {
  range: Range;
  generatedAt: number;
  timeBasis?: QueryTimeBasis;
  totals: UsageAggregateRow;
  bySource: Partial<Record<AggregateSource, UsageAggregateSourceRow>>;
}
interface CountRow {
  field_components_json?: string | null;
  count_revision?: number | null;
  ts: number; rid: number; source: Source;
  input_fresh: number; cache_read: number; output: number; reasoning: number;
  cache_write_5m: number; cache_write_1h: number;
  cache_write_unassigned: number | null; cache_write_assumed_1h: number | null;
  count_quality: TokenCounts['countQuality'] | null;
  ucu_count_quality: TokenCounts['countQuality'] | null;
  api_equiv_usd: number | null; price_status: string;
}
const BASE_COLUMNS = 'source,input_fresh,cache_read,output,reasoning,cache_write_5m,cache_write_1h,api_equiv_usd,price_status';
const OPTIONAL_COLUMNS = ['cache_write_unassigned', 'cache_write_assumed_1h', 'count_quality', 'ucu_count_quality', 'count_revision'] as const;
const zero = (): UsageAggregateRow => ({ events: 0, tokens: { ...ZERO_TOKENS }, apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null, priceEvidence: emptyPriceEvidence() });
function counts(row: CountRow): TokenCounts {
  const countQuality = normalizeCountQuality(row.count_quality);
  const subsetQuality = normalizeCountQuality(row.ucu_count_quality ?? row.count_quality);
  const tokens: TokenCounts = { inputFresh: row.input_fresh, cacheRead: row.cache_read, output: row.output, reasoning: row.reasoning,
    cacheWrite5m: row.cache_write_5m, cacheWrite1h: row.cache_write_1h,
    ...(row.cache_write_unassigned === null ? {} : { cacheWriteUnassigned: row.cache_write_unassigned }),
    ...(row.cache_write_assumed_1h === null ? {} : { cacheWriteAssumed1h: row.cache_write_assumed_1h }),
    countQuality,
    ...(subsetQuality !== countQuality ? { ucuCountQuality: subsetQuality } : {}) };
  const fields = storedNativeTokenFields(row.field_components_json, tokens, row.count_revision);
  if (fields) tokens.fieldEvidence = fields;
  return tokens;
}
function add(target: UsageAggregateRow, row: CountRow, tokens: TokenCounts): void {
  target.events++;
  addTokenCounts(target.tokens, tokens);
  target.apiEquivUsd += row.api_equiv_usd ?? 0;
  if (row.api_equiv_usd === null) target.unpricedEvents++;
  if (hasEstimatedDollars(row.api_equiv_usd, row.price_status)) target.estimatedPriceEvents++;
  addPriceEvidence(target.priceEvidence!, row.api_equiv_usd, row.price_status);
}

/** One read-only snapshot, narrow columns and bounded pages. Accumulators retain only totals/source rows.
 * Page size bounds synchronous rows/mapping, not time. Dollars keep Summary's original per-scope row order. */
export async function readUsageAggregate(file: string, range: Range, opts?: {
  now?: () => number; pageRows?: number; yieldNow?: () => Promise<void>; signal?: AbortSignal;
}): Promise<UsageAggregateResponse> {
  checkRead(opts?.signal);
  const asOf = (opts?.now ?? Date.now)();
  const since = rangeSince(range, asOf);
  const snap = openReadSnapshot(file);
  try {
    const available = new Set((snap.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(row => row.name));
    const columns = BASE_COLUMNS + ',' + OPTIONAL_COLUMNS.map(name => available.has(name) ? name : 'NULL AS ' + name).join(',')
      + (available.has('components_json') ? ",CASE WHEN source='ollama-proxy' THEN components_json ELSE NULL END AS field_components_json" : ',NULL AS field_components_json');
    const query: RowQuery = { table: 'events', columns, clauses: [...(since === undefined ? [] : ['ts>=?']), 'ts<=?'],
      params: [...(since === undefined ? [] : [since]), asOf], order: since === undefined ? 'rowid' : 'tsRowid' };
    const totals = zero(); const sources = new Map<AggregateSource, UsageAggregateRow>();
    const page: PageOptions = { pageRows: opts?.pageRows ?? 2000, signal: opts?.signal,
      yieldNow: opts?.yieldNow ?? (() => new Promise<void>(resolve => setImmediate(resolve))), pageSpan: 'query.usage_aggregate_page' };
    await visitRows<CountRow>(snap.db, query, page, row => {
      const tokens = counts(row); add(totals, row, tokens);
      const sourceKey: AggregateSource = (USAGE_SOURCES as readonly string[]).includes(row.source) ? row.source : 'unrecognized-source';
      let source = sources.get(sourceKey);
      if (!source) { source = zero(); sources.set(sourceKey, source); }
      add(source, row, tokens);
    });
    checkRead(opts?.signal);
    for (const row of [totals, ...sources.values()]) {
      qualifyAggregateAmount(row.priceEvidence!, row.apiEquivUsd);
      row.priceStatus = priceStatusOfCounts(row.events, row.unpricedEvents, row.estimatedPriceEvents, row.priceEvidence);
    }
    return { range, generatedAt: asOf, timeBasis: recordedQueryTimeBasis(snap.db, since, asOf), totals, bySource: Object.fromEntries(sources) };
  } finally { snap.close(); }
}
