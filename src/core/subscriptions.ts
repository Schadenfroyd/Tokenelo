/**
 * Subscription leverage (DESIGN §8): the API-equivalent value of a range divided by the configured
 * plan price prorated to that range. Pure arithmetic over dollars the ledger already holds and a
 * price the user entered; no engine, rate or repository is involved.
 */
import type { AccountConfig, SubscriptionRow } from './types.js';
import type { PriceQuality } from './price-quality.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const AVG_DAYS_PER_MONTH = 30; // [decision] simple flat proration, matches DESIGN's "prorate ... to a range"

/** Prorates a flat monthly price to an arbitrary [rangeStartMs, rangeEndMs) range by day-count
 * (30-day month [decision]). Zero or negative-length ranges prorate to 0, never negative. */
export function prorateMonthlyUsd(monthlyUsd: number, rangeStartMs: number, rangeEndMs: number): number {
  const days = Math.max(0, rangeEndMs - rangeStartMs) / DAY_MS;
  return monthlyUsd * (days / AVG_DAYS_PER_MONTH);
}

/**
 * Subscription leverage = API-equivalent value ÷ configured plan-cost proration (DESIGN §8).
 * The legacy `billedUsd` field is an estimate from the configured monthly price and a declared
 * window, not a verified invoice. Missing/invalid prices or periods have no denominator;
 * an unknown historical start stays null rather than becoming epoch zero. Zero cost is known
 * zero but has no ratio. Plan prices are never guessed or defaulted.
 *
 * `unpricedEvents` is the number of events in the range with no price (their dollars are missing from apiEquivUsd). Null = unknown
 * (not counted); it is never read as zero. `partial` is true when any event is unpriced, false when none is, null when unknown.
 */
export function computeSubscriptionLeverage(
  account: AccountConfig,
  apiEquivUsd: number,
  rangeStartMs: number | null,
  rangeEndMs: number,
  quality: PriceQuality | null = null
): SubscriptionRow {
  const validPrice = account.monthlyUsd != null && Number.isFinite(account.monthlyUsd) && account.monthlyUsd >= 0;
  const costBasis: NonNullable<SubscriptionRow['costBasis']> = {
    state: account.monthlyUsd == null ? 'price-unconfigured' : !validPrice ? 'price-invalid'
      : rangeStartMs === null ? 'period-unavailable'
      : !Number.isFinite(rangeStartMs) || !Number.isFinite(rangeEndMs) || rangeEndMs < rangeStartMs ? 'period-invalid' : 'configured-proration',
    monthlyUsd: validPrice ? account.monthlyUsd! : null,
    rangeStartMs, rangeEndMs, prorationDays: 30, origin: 'configured-plan-price', invoiceVerified: false,
  };
  const estimate = costBasis.state === 'configured-proration' ? prorateMonthlyUsd(account.monthlyUsd!, rangeStartMs!, rangeEndMs) : null;
  const billedUsd = estimate !== null && Number.isFinite(estimate) ? estimate : null;
  if (estimate !== null && billedUsd === null) costBasis.state = 'period-invalid';
  const ratio = billedUsd !== null && billedUsd > 0 ? apiEquivUsd / billedUsd : null;
  const invalidEvidence = quality?.priceEvidence && (quality.priceEvidence.issuesEvents > 0 || quality.priceEvidence.aggregateAmountInvalid);
  const leverage = !invalidEvidence && ratio !== null && Number.isFinite(ratio) ? ratio : null;
  // Quality is the account's own events on its hosts and kind; null (no hosts queried) stays unknown everywhere.
  return {
    account: account.id,
    kind: account.kind,
    planName: account.planName,
    billedUsd,
    costBasis,
    apiEquivUsd,
    leverage,
    unpricedEvents: quality ? quality.unpricedEvents : null,
    estimatedPriceEvents: quality ? quality.estimatedPriceEvents : null,
    priceStatus: quality ? quality.priceStatus : null,
    ...(quality?.priceEvidence ? { priceEvidence: quality.priceEvidence } : {}),
    partial: quality ? quality.unpricedEvents > 0 : null,
  };
}
