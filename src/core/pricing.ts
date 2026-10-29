/**
 * Pricing engine (DESIGN.md §5, §15.4). Owns `rates/prices.json`: `{ rows, _unpriced }`, where
 * `rows` is an ordered array of `PriceRow` (src/core/types.ts), first-match-wins against the raw
 * model id, more-specific ids ordered before general ones in the file itself (e.g.
 * `claude-fable-5-1` before `claude-fable-5`); `_unpriced` documents model ids the sourcing task
 * investigated and confirmed have no official vendor price (never invented — they stay UNPRICED).
 *
 * `priceComponent` prices one `UsageComponent` (one component per `usage.iterations` entry when
 * present, per DESIGN §15.1.3 — that fan-out happens in the Claude collector, not here; this
 * module only ever sees already-split components). `priceEvent` sums a `UsageEvent`'s components
 * and is null (UNPRICED) as soon as any one of them is unpriced — never silently drops the
 * unpriced part and reports a partial total.
 *
 * Every number here is traceable to a source + verifiedAt in `rates/prices.json` itself (never in
 * comments only) — see that file's own `source`/`verifiedAt` fields, especially the older
 * (inherited from an earlier rate table, not independently re-verified this session) rows, which are marked
 * `status: "ESTIMATE"` rather than `"LIST"`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EventFlag,
  PriceResult,
  PriceRow,
  PriceStatus,
  PricingEngine,
  Provider,
  RateColumns,
  UsageComponent,
  UsageEvent,
} from './types.js';
import { hasInvalidTokenValues, hasUnresolvedCounts } from './token-counts.js';
import { allowsLocalRatePolicy, componentRouteState, reportedRouteState } from './serving-route.js';
import { componentCountProjection, isSupportedCountPolicy } from '../measurement/component-count-evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** `src/core/pricing.ts` (dev, via tsx) or `dist/core/pricing.js` (built) → repo root, two levels up. */
export const DEFAULT_PRICES_PATH = path.resolve(__dirname, '..', '..', 'rates', 'prices.json');

/** A model id with no official vendor price, documented (not invented) in `prices.json`'s
 * `_unpriced` block — see {@link loadUnpricedNotes}. Never priced; stays UNPRICED via `resolve()`
 * returning null for it (no row's `match` targets these ids). */
export interface UnpricedNote {
  id: string;
  reason: string;
}

/** On-disk shape of `rates/prices.json`: the `PriceRow[]` array wrapped with a documentation-only
 * `_unpriced` block (ids the sourcing task investigated and confirmed have no official per-token
 * price — see DESIGN §5/§15.4 "never silently priced at a default tier"). A bare `PriceRow[]` (the
 * pre-wrap shape) is also accepted for backward compatibility. */
type PricesFile = PriceRow[] | { rows: PriceRow[]; _unpriced?: UnpricedNote[] };

/** Reads and JSON-parses `rates/prices.json` (or an override path, e.g. for tests). Not cached:
 * callers that need it hot-reloaded (CLI `reprice`) can call this again; callers that don't
 * (the daemon at startup) call it once and hold the resulting engine. Returns only the `PriceRow[]`
 * — `priceRowsVersion` and every engine built from this function's result therefore hash/see just
 * the rows, not the `_unpriced` documentation block (use {@link loadUnpricedNotes} for that). */
/** Billing schema validation precedes hashing or matching. Extra documentation fields
 * do not alter the five quoted numeric columns; malformed values never become LIST. */
function validatePriceRows(rows: unknown): asserts rows is PriceRow[] {
  if (!Array.isArray(rows)) throw new Error('Invalid price rows: expected an array');
  const fail = (i:number,field:string):never => { throw new Error(`Invalid price row ${i}: ${field}`); };
  const amount = (v:unknown):boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const columns = (v:unknown,i:number,field:string):void => {
    if (!object(v) || !['in','cacheWrite5m','cacheWrite1h','cacheRead','out'].every(k=>amount(v[k]))) fail(i,field);
  };
  const derived = (v:unknown,i:number,field:string):void => {
    if (v !== undefined && (!Array.isArray(v) || !v.every(k=>k==='cacheWrite5m'||k==='cacheWrite1h'))) fail(i,field);
  };
  for (let i=0;i<rows.length;i++) {
    const r=rows[i];if (!object(r)) fail(i,'object');
    if (typeof r.id !== 'string' || !r.id.length) fail(i,'id');
    if (typeof r.match !== 'string' || !r.match.length) fail(i,'match');
    try { new RegExp(r.match as string,'i'); } catch { fail(i,'match syntax'); }
    if (!['anthropic','openai','local','unknown'].includes(r.provider as string)) fail(i,'provider');
    if (!['LIST','ESTIMATE'].includes(r.status as string)) fail(i,'status');
    if (typeof r.local !== 'boolean') fail(i,'local');
    if (typeof r.displayName !== 'string' || !r.displayName.length) fail(i,'display name');
    columns(r.rates,i,'rates');derived(r.derivedColumns,i,'derived columns');
    if (r.longContext !== undefined) {
      columns(r.longContext,i,'long-context rates');const threshold=(r.longContext as Record<string,unknown>).thresholdInput;
      if (!Number.isSafeInteger(threshold) || (threshold as number)<0) fail(i,'context threshold');
    }
    if (r.geoMultiplierUs !== undefined && (!amount(r.geoMultiplierUs) || (r.geoMultiplierUs as number)<1)) fail(i,'geo multiplier');
    for (const name of ['fast','ultrafast']) {
      const tier=r[name];if (tier===undefined) continue;columns(tier,i,name+' rates');
      const t=tier as Record<string,unknown>;if (!['LIST','ESTIMATE'].includes(t.status as string)) fail(i,name+' status');
      derived(t.derivedColumns,i,name+' derived columns');
      if (t.longContext!==undefined) { columns(t.longContext,i,name+' long-context rates');derived((t.longContext as Record<string,unknown>).derivedColumns,i,name+' long derived columns'); }
    }
  }
}

export function loadPriceRows(filePath: string = DEFAULT_PRICES_PATH): PriceRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as PricesFile;
  const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
  validatePriceRows(rows);
  return rows;
}

/** Reads `rates/prices.json`'s `_unpriced` documentation block (ids with no official vendor price,
 * intentionally left unmatched rather than invented — see DESIGN §5/§15.4). Empty array when the
 * file predates the block or is the bare-array shape. */
export function loadUnpricedNotes(filePath: string = DEFAULT_PRICES_PATH): UnpricedNote[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as PricesFile;
  return Array.isArray(parsed) ? [] : (parsed._unpriced ?? []);
}

/**
 * Deterministic canonical JSON for hashing: object keys sorted recursively, no whitespace.
 * Not full RFC 8785 JCS (no number/string normalization beyond `JSON.stringify`'s own). This is
 * enough for a stable, OS-independent `priceVersion` over a plain data file with no floats
 * needing exponent normalization.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      out[key] = sortDeep(input[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** `priceVersion` = sha256 of the canonical JSON of the rows array (DESIGN §5: "sha256 of
 * canonical `prices.json`"). Any change to any row — a rate, a status, a new model — changes
 * this, so a stored `UsageEvent.priceVersion` always tells you exactly which rate table priced it. */
export function priceRowsVersion(rows: PriceRow[]): string {
  return sha256Hex(canonicalJson(rows));
}

const PRICE_STATUS_RANK: Record<PriceStatus, number> = { LIST: 0, ESTIMATE: 1, UNPRICED: 2 };

function dedupeFlags(flags: EventFlag[]): EventFlag[] {
  return Array.from(new Set(flags));
}

interface CompiledRow {
  row: PriceRow;
  re: RegExp;
}

/** Builds a `PricingEngine` from an already-loaded rows array (pure — no filesystem access, so
 * tests can construct one from an in-memory fixture array without touching `rates/prices.json`). */
/** A weights-table display name may imply local execution. Do not give that label to
 * recorded usage whose provider is unknown or hosted; preserve the recorded model ID. */
export function recordedModelDisplayName(pricing: Pick<PricingEngine, 'resolve'>, model: string, provider: Provider): string {
  const row = pricing.resolve(model);
  return row?.local && provider !== 'local' ? model : row?.displayName ?? model;
}

export function createPricingEngine(rows: PriceRow[]): PricingEngine {
  validatePriceRows(rows);
  // A caller cannot mutate the captured rates while the engine keeps their old hash.
  rows = structuredClone(rows);
  const frozen = new WeakSet<object>();
  const freeze = (value:unknown):void => {
    if (!value || typeof value !== 'object' || frozen.has(value)) return;
    frozen.add(value);for (const child of Object.values(value)) freeze(child);Object.freeze(value);
  };
  freeze(rows);
  const compiled: CompiledRow[] = rows.map((row) => ({ row, re: new RegExp(row.match, 'i') }));
  const version = priceRowsVersion(rows);

  function resolve(model: string): PriceRow | null {
    if (!model) return null;
    for (const { row, re } of compiled) {
      if (re.test(model)) return row;
    }
    return null;
  }

  function providerOf(model: string, route?: import('./types.js').ServingRouteEvidence): Provider {
    const row = resolve(model);
    if (row?.local && route !== undefined && !allowsLocalRatePolicy(reportedRouteState(route))) return 'unknown';
    return row?.provider ?? 'unknown';
  }

  function priceComponent(
    c: UsageComponent,
    ctx?: { inferenceGeo?: string; batch?: boolean },
  ): PriceResult {
    const row = resolve(c.model);
    if (!row) {
      return { usd: null, status: 'UNPRICED', rowId: null, flags: ['unpricedModel'] };
    }

    // Explicit request provenance takes precedence over a weights-name match. Retain the
    // model row for classification; its local zero rate is not a hosted/unknown price.
    // Legacy components without route evidence retain their historical pricing policy.
    if (row.local && !allowsLocalRatePolicy(componentRouteState(c))) {
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['servingRouteUnpriced'] };
    }

    // Rate-table status and source/count evidence are separate. A zero local list rate
    // can price known work with unknown TTL; it cannot prove unresolved work counts.
    if (c.countEvidence && !isSupportedCountPolicy(c.countEvidence.policy))
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['countPolicyUnsupported'] };
    const countBasis = c.countEvidence ? componentCountProjection(c.countEvidence) : null;
    const invalidPriceBasis = countBasis && (countBasis.ttlHistoryInvalid || !['reported-ttl', 'no-cache-work', 'assumed-1h'].includes(countBasis.cache.priceBasis));
    const zeroColumns = (cols: RateColumns) => (['in', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'out'] as const).every(k => cols[k] === 0);
    const zeroLocalRates = row.local && zeroColumns(row.rates)
      && [row.fast, row.ultrafast].every(t => !t || (zeroColumns(t) && (!t.longContext || zeroColumns(t.longContext))))
      && (!row.longContext || ['in', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'out'].every(k => row.longContext![k as keyof RateColumns] === 0));
    if (hasInvalidTokenValues(c.tokens) || (countBasis && hasInvalidTokenValues(countBasis.tokens)))
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['priceContextInvalid'] };

    const flags: EventFlag[] = [];
    let columns: RateColumns = row.rates;
    let status: PriceStatus = row.status;
    // Columns with no primary figure, for the tier that is billed (base and long-context use the base list; fast its own).
    let derived: readonly ('cacheWrite5m' | 'cacheWrite1h')[] = row.derivedColumns ?? [];

    // GPT-6 long-context bracket (DESIGN §5/§15.4): the WHOLE request prices at the bracket's
    // rates once requestInput exceeds the threshold. requestInput is "total prompt size of this
    // request incl. cached" (types.ts UsageComponent doc); fall back to this component's own
    // input-side token sum when the collector didn't record it (Claude/Ollama components never
    // set requestInput — only Codex GPT-6 components do, per DESIGN §15.2.9).
    const ownInputSize = c.tokens.inputFresh + c.tokens.cacheWrite5m + c.tokens.cacheWrite1h
      + (c.tokens.cacheWriteUnassigned ?? 0) + c.tokens.cacheRead;
    if (c.requestInput !== undefined && (!Number.isSafeInteger(c.requestInput) || c.requestInput < 0))
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['priceContextInvalid'] };
    const requestInputSize = c.requestInput ?? ownInputSize;

    if (!Number.isSafeInteger(ownInputSize) || !Number.isSafeInteger(requestInputSize)
      || requestInputSize < ownInputSize)
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['priceContextInvalid'] };
    const speed = c.speed ?? 'standard';
    if (!['standard', 'fast', 'ultrafast'].includes(speed) || ctx?.batch)
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['priceTierUnsupported'] };
    const long = !!row.longContext && requestInputSize > row.longContext.thresholdInput;
    const tier = speed === 'standard' ? undefined : row[speed];
    // Missing Codex speed retains the established Standard API-equivalent basis; it
    // does not identify the served tier or an invoice. Never invent a known tier's
    // missing prices. Claude's legacy no-fast rows retain their documented policy.
    const documentedStandardFast = speed === 'fast' && row.id === 'claude-opus-4-6';
    if (speed !== 'standard' && !tier && !documentedStandardFast && !(row.local && zeroLocalRates))
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['priceTierUnsupported'] };
    if (long && tier && !tier.longContext)
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['longContextBracket', 'priceTierUnsupported'] };

    if (tier) {
      const { status: tierStatus, derivedColumns: tierDerived, longContext: tierLong, ...tierCols } = tier;
      columns = tierCols;
      status = tierStatus;
      derived = tierDerived ?? [];
      if (long && tierLong) {
        const { derivedColumns: longDerived, ...longCols } = tierLong;
        columns = longCols;
        derived = longDerived ?? derived;
        flags.push('longContextBracket');
      }
    } else if (long && row.longContext) {
      const { thresholdInput: _thresholdInput, ...longCols } = row.longContext;
      columns = longCols;
      flags.push('longContextBracket');
      // longContext carries no status of its own; the base row's LIST/ESTIMATE status stands.
    }

    if (hasUnresolvedCounts(c.tokens) || (countBasis && hasUnresolvedCounts(countBasis.tokens))
      || (!zeroLocalRates && (invalidPriceBasis || (c.tokens.cacheWriteUnassigned ?? 0) > 0)))
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: [] };


    let usd =
      (c.tokens.inputFresh * columns.in +
        c.tokens.cacheWrite5m * columns.cacheWrite5m +
        c.tokens.cacheWrite1h * columns.cacheWrite1h +
        c.tokens.cacheRead * columns.cacheRead +
        c.tokens.output * columns.out) /
      1e6;

    // Data residency (Claude 4.6+, first-party/AWS/Foundry): ×1.1 on every token category when
    // inference_geo === 'us' and the row is flagged for it (DESIGN §5; older rows below the 4.6
    // cutoff carry no geoMultiplierUs, so this is a no-op for them).
    if (ctx?.inferenceGeo === 'us' && row.geoMultiplierUs) {
      usd *= row.geoMultiplierUs;
    }

    // A derived column (no primary figure for the tier billed) that this component bills makes the price ESTIMATE, not LIST.
    const billsDerived = derived.some((col) => (col === 'cacheWrite5m' ? c.tokens.cacheWrite5m : c.tokens.cacheWrite1h) > 0);
    if (billsDerived && status === 'LIST') status = 'ESTIMATE';
    if (!Number.isFinite(usd) || usd < 0)
      return { usd: null, status: 'UNPRICED', rowId: row.id, flags: ['priceContextInvalid'] };
    return { usd, status, rowId: row.id, flags };
  }

  function priceEvent(e: Pick<UsageEvent, 'components' | 'inferenceGeo'> & { tokens?: import('./types.js').TokenCounts; flags?: EventFlag[] }): PriceResult {
    if (!e.components?.length) return { usd:null,status:'UNPRICED',rowId:null,
      flags: dedupeFlags(['unpricedModel', ...(e.flags?.includes('servingRouteMisaligned') ? ['servingRouteMisaligned' as const] : [])]) };
    const invalidEvent = !!e.tokens && hasInvalidTokenValues(e.tokens);
    const unresolvedEvent = !!e.tokens && hasUnresolvedCounts(e.tokens);
    const misalignedRoute = !!e.flags?.includes('servingRouteMisaligned');
    let total = 0;
    let rowId: string | null = null;
    let status: PriceStatus = 'LIST';
    const flags: EventFlag[] = [];
    let unpriced = false;

    for (const c of e.components) {
      const r = priceComponent(c, { inferenceGeo: e.inferenceGeo });
      flags.push(...r.flags);
      if (r.usd === null) {
        // Continue only to collect diagnostics. Never expose the partial sum.
        unpriced = true;
        continue;
      }
      total += r.usd;
      if (!Number.isFinite(total) || total < 0) { unpriced = true; flags.push('priceContextInvalid'); }
      rowId = r.rowId;
      if (PRICE_STATUS_RANK[r.status] > PRICE_STATUS_RANK[status]) status = r.status;
    }

    if (invalidEvent) flags.push('priceContextInvalid');
    if (misalignedRoute) flags.push('servingRouteMisaligned');
    if (unpriced || invalidEvent || unresolvedEvent || misalignedRoute)
      return { usd: null, status: 'UNPRICED', rowId: null, flags: dedupeFlags(flags) };
    return { usd: total, status, rowId, flags: dedupeFlags(flags) };
  }

  return { version, resolve, providerOf, priceComponent, priceEvent };
}

/** Convenience: load `rates/prices.json` (or an override path) and build the engine in one call. */
export function defaultPricingEngine(filePath?: string): PricingEngine {
  return createPricingEngine(loadPriceRows(filePath));
}
