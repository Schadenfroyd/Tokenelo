/**
 * Price quality of a set of dollars (M3e data propagation). Every count is derived from the same events as the dollar figure it qualifies;
 * a parent never borrows a whole-host count. Definitions:
 *  - unpricedEvents: events with no dollar figure (apiEquivUsd null). Their dollars are missing from the sum.
 *  - estimatedPriceEvents: priced events whose price used a derived rate column (price status ESTIMATE). Their dollars are included.
 *  - priceStatus: the weakest status of the dollars: UNPRICED if any event is unpriced, else ESTIMATE if any is estimated, else LIST.
 *    null when there are no events: nothing was priced, so no status is claimed (unknown is never shown as LIST).
 */
export type PriceStatusLabel = 'LIST' | 'ESTIMATE' | 'UNPRICED';
import { addPriceEvidence, emptyPriceEvidence, priceEvidenceProblem, qualifyAggregateAmount, type PriceEvidence } from './price-evidence.js';

export interface PriceQuality {
  events: number;
  unpricedEvents: number;
  estimatedPriceEvents: number;
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
}

export const PRICE_STATUS_LABELS: readonly PriceStatusLabel[] = ['LIST', 'ESTIMATE', 'UNPRICED'];

/** An estimate counts only when its dollars are included in the stored sum. */
export function hasEstimatedDollars(apiEquivUsd: number | null, priceStatus: string): boolean {
  return apiEquivUsd !== null && priceStatus === 'ESTIMATE';
}

/** The status a set of counts implies. Pure: the single definition every layer uses. */
export function priceStatusOfCounts(events: number, unpricedEvents: number, estimatedPriceEvents: number, evidence?: PriceEvidence): PriceStatusLabel | null {
  if (evidence && (priceEvidenceProblem(evidence, events) !== null || evidence.issuesEvents > 0 || evidence.aggregateAmountInvalid)) return null;
  if (events === 0) return null;
  if (unpricedEvents > 0) return 'UNPRICED';
  if (estimatedPriceEvents > 0) return 'ESTIMATE';
  return 'LIST';
}

/** Quality from event-level fields (UsageEvent: apiEquivUsd, priceStatus). */
export function priceQualityOf(events: readonly { apiEquivUsd: number | null; priceStatus: string }[], opts?: { includeEvidence?: boolean }): PriceQuality {
  let unpricedEvents = 0;
  let estimatedPriceEvents = 0;
  let sum = 0;
  const evidence = emptyPriceEvidence();
  for (const e of events) {
    if (e.apiEquivUsd === null) unpricedEvents++;
    if (hasEstimatedDollars(e.apiEquivUsd, e.priceStatus)) estimatedPriceEvents++;
    addPriceEvidence(evidence, e.apiEquivUsd, e.priceStatus);
    sum += e.apiEquivUsd ?? 0;
  }
  qualifyAggregateAmount(evidence, sum);
  return { events: events.length, unpricedEvents, estimatedPriceEvents, priceStatus: priceStatusOfCounts(events.length, unpricedEvents, estimatedPriceEvents, evidence),
    ...(opts?.includeEvidence || evidence.issuesEvents > 0 || evidence.aggregateAmountInvalid ? { priceEvidence: evidence } : {}) };
}

/** Quality from aggregate counts (SQL): the same definition, so a host total and an account total agree on what "estimated" means. */
export function priceQualityFromCounts(events: number, unpricedEvents: number, estimatedPriceEvents: number, evidence?: PriceEvidence): PriceQuality {
  return { events, unpricedEvents, estimatedPriceEvents, priceStatus: priceStatusOfCounts(events, unpricedEvents, estimatedPriceEvents, evidence), ...(evidence ? { priceEvidence: evidence } : {}) };
}

/**
 * Validation for payloads from another daemon. Returns the problem, or null when the block is consistent. Negative, fractional, non-finite or
 * unsafe counts are rejected; so are unknown status labels and a status that contradicts its counts. A missing block is not an error here:
 * callers decide whether absence is unknown (older peers), and must never turn it into zero or LIST.
 */
export function priceQualityProblem(q: unknown): string | null {
  if (!q || typeof q !== 'object') return 'not an object';
  const o = q as Record<string, unknown>;
  for (const k of ['events', 'unpricedEvents', 'estimatedPriceEvents'] as const) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return `${k} must be a non-negative safe integer`;
  }
  const { events, unpricedEvents, estimatedPriceEvents } = o as unknown as PriceQuality;
  if (unpricedEvents + estimatedPriceEvents > events) return 'unpriced and estimated events exceed events';
  const label = o.priceStatus;
  if (label !== null && !PRICE_STATUS_LABELS.includes(label as PriceStatusLabel)) return 'priceStatus is not a known label';
  if (o.priceEvidence !== undefined && priceEvidenceProblem(o.priceEvidence, events) !== null) return 'price evidence invalid';
  if (label !== priceStatusOfCounts(events, unpricedEvents, estimatedPriceEvents, o.priceEvidence as PriceEvidence | undefined)) return 'priceStatus contradicts its counts';
  return null;
}

/** The three fields every row carries, derived from the same events as its dollars. */
export function priceFieldsOf(events: readonly { apiEquivUsd: number | null; priceStatus: string }[]): {
  unpricedEvents: number;
  estimatedPriceEvents: number;
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
} {
  const q = priceQualityOf(events, { includeEvidence: true });
  return { unpricedEvents: q.unpricedEvents, estimatedPriceEvents: q.estimatedPriceEvents, priceStatus: q.priceStatus, priceEvidence: q.priceEvidence };
}
