import { formatMoney } from './format.js';
import { priceFieldsUsable } from './price-evidence.js';
import { API_EQUIVALENT_BASIS_NOTE } from './quality.js';

/** Copy for an already-recorded Local session value; this does not calculate a price. */
export function localSessionPriceCopy(figure: { events?: number; apiEquivUsd?: number | null; priceEvidence?: unknown }): { value: string; label: string; title: string } {
  const amount = figure.apiEquivUsd;
  const value = priceFieldsUsable(figure) && typeof amount === 'number' ? formatMoney(amount) : '—';
  const available = value !== '—';
  return {
    value,
    label: available ? 'Recorded API-equivalent' : 'API-equivalent value unavailable',
    title: available ? API_EQUIVALENT_BASIS_NOTE : 'API-equivalent value is unavailable or cannot be trusted for this session.',
  };
}
