/**
 * Recent burn line for the session-detail Details card (R44). Pure: no DOM, so it is tested directly.
 *
 * `burn.priceQuality` counts the same events as `burn.usdPerHour` (core computeBurn's trailing window), never the whole session. The check
 * below mirrors core/price-quality.ts#priceQualityProblem, duplicated because the renderer cannot import core (tsconfig.tray.json rootDir).
 *  - absent (older daemon): the recorded rate is shown with "Price coverage unknown", never read as zero or LIST.
 *  - malformed or contradictory: no money figure, "Price coverage unavailable".
 *  - every window event unpriced: no money figure (the 0 sum is not a measured zero), only the unpriced count.
 *  - some unpriced: the recorded sum of the priced events, marked partial with the missing count.
 *  - estimated: the count of included estimated-price events.
 * Token throughput uses its own full-count qualification, independently of price coverage.
 */
import type { PriceStatus, TokenCounts } from './api-types.js';
import { formatCompactNumber, formatMoney } from './format.js';
import { unresolvedCounts } from './token-counts.js';
import { priceFieldState } from './price-evidence.js';

export interface BurnQuality {
  events: number;
  unpricedEvents: number;
  estimatedPriceEvents: number;
  priceStatus: PriceStatus;
}

/** SessionRow['burn'] plus the optional window quality; read as unknown until validated. */
export interface BurnInput {
  tokensPerMin: number;
  usdPerHour: number;
  priceQuality?: unknown;
  countQuality?: TokenCounts['countQuality'];
}

function isCount(n: unknown): n is number {
  return Number.isSafeInteger(n) && (n as number) >= 0;
}

/** The window's quality when consistent, else null. Same rules as core priceQualityProblem, plus a burn window always has an event. */
export function validBurnQuality(q: unknown): BurnQuality | null {
  if (!q || typeof q !== 'object') return null;
  const { events, unpricedEvents, estimatedPriceEvents, priceStatus } = q as Record<string, unknown>;
  if (!isCount(events) || !isCount(unpricedEvents) || !isCount(estimatedPriceEvents)) return null;
  if (events === 0 || unpricedEvents + estimatedPriceEvents > events) return null;
  const implied: PriceStatus = unpricedEvents > 0 ? 'UNPRICED' : estimatedPriceEvents > 0 ? 'ESTIMATE' : 'LIST';
  if (priceStatus !== implied) return null;
  return { events, unpricedEvents, estimatedPriceEvents, priceStatus: implied };
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function burnLine(burn: BurnInput | null | undefined): string | null {
  if (!burn) return null;
  const tokens = Number.isFinite(burn.tokensPerMin) ? formatCompactNumber(burn.tokensPerMin) : '—';
  const throughput = unresolvedCounts(burn) ? `token rate unavailable · ${burn.countQuality} count evidence` : `${tokens} tok/min`;
  return `Burn (last 15m): ${throughput} · API-equiv ${burnMoneyText(burn)}`;
}

/** Reuse the same recent-window money qualification on Sessions cards and Details. */
export function burnMoneyText(burn: BurnInput): string {
  if (burn.priceQuality && typeof burn.priceQuality === 'object') {
    const state = priceFieldState(burn.priceQuality);
    if (state === 'conflict') return '—/h · Price evidence conflicts';
    if (state === 'invalid') return '—/h · Price field evidence unavailable';
  }
  const rate = Number.isFinite(burn.usdPerHour) ? `${formatMoney(burn.usdPerHour)}/h` : null;
  if (burn.priceQuality === undefined) return `${rate ?? '—/h'} · Price coverage unknown`;
  const q = validBurnQuality(burn.priceQuality);
  if (!q || rate === null) return '—/h · Price coverage unavailable';
  if (q.unpricedEvents === q.events) return `—/h · ${plural(q.unpricedEvents, 'unpriced event', 'unpriced events')}`;
  const notes: string[] = [];
  if (q.unpricedEvents > 0) notes.push(`Partial · ${plural(q.unpricedEvents, 'unpriced event', 'unpriced events')}`);
  if (q.estimatedPriceEvents > 0) notes.push(plural(q.estimatedPriceEvents, 'event uses estimated prices', 'events use estimated prices'));
  return [rate, ...notes].join(' · ');
}
