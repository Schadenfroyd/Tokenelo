/** Shared evidence presentation for recorded figures. No recalculation or implied current definition. */
import { priceFieldLabel } from './price-evidence.js';

export const API_EQUIVALENT_BASIS_NOTE = 'API-equivalent uses Standard API reference prices; it is not a provider invoice or served-tier charge.';
export const LOCAL_COMPARATOR_BASIS_NOTE = 'These local comparator values are counterfactual estimates, not provider invoices or realized savings.';
export const LOCAL_SAVINGS_BASIS_NOTE = 'Net savings are counterfactual estimates against configured local marginal cost, not realized cash savings.';

export function unpricedLabel(count: number | null | undefined): string | null {
  if (count === null || count === undefined) return 'Unpriced count unknown';
  return count > 0 ? `Partial · ${count.toLocaleString()} unpriced` : null;
}

/** Scope-matched price evidence; absent peer fields remain unknown. */
export function priceEvidenceLabel(figure: { events?: number; priceEvidence?: unknown; unpricedEvents?: number | null; estimatedPriceEvents?: number | null; priceStatus?: string | null }): string | null {
  const parts: string[] = [];
  const fields = priceFieldLabel(figure);
  if (fields) parts.push(fields);
  const unpriced = unpricedLabel(figure.unpricedEvents);
  if (unpriced) parts.push(unpriced);
  if ((figure.estimatedPriceEvents ?? 0) > 0) parts.push(`${figure.estimatedPriceEvents!.toLocaleString()} ${figure.estimatedPriceEvents === 1 ? 'event uses' : 'events use'} estimated prices`);
  else if (figure.priceStatus === 'ESTIMATE') parts.push('Includes estimated prices');
  else if (figure.priceStatus === 'UNPRICED' && !unpriced) parts.push('Partial value');
  else if (figure.estimatedPriceEvents == null && figure.priceStatus !== 'LIST') parts.push('Estimated price count unknown');
  return parts.length ? parts.join(' · ') : null;
}
