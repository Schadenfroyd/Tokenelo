/**
 * The valuation seam of this edition: no valuation rates are configured, so nothing is ever
 * computed, ranked or aggregated here.
 *
 * Stored rows keep their reserved compatibility columns (the reserved value, its rate status, the
 * definition hash and the rate selection; see src/store/migrations.ts) so a ledger can move between
 * editions without a schema change. This module only decides what NEW rows put in them:
 *
 *   - a new event's reserved value is `null` with status `'NONE'` (unknown), never zero;
 *   - it carries no definition hash (empty string; the column is NOT NULL) and no rate selection (`null`).
 *
 * No response reports an aggregate of the reserved value. Nothing in this file interprets a stored value:
 * values already present in a user's ledger are passed through untouched by the readers that return raw rows.
 */
import type { EacsEngine, RateStatus } from './types.js';

/** The status of every value this edition produces: no rate was configured, so the value is unknown. */
export const NO_RATE_STATUS: RateStatus = 'NONE';

/**
 * The engine used by every writer and reader in this edition. `defSha256` is empty because there is no
 * definition to identify, and `rateBasisOf` records no selection (`null`), so a stored row can never
 * claim a calibration it did not use.
 */
export function createNullEngine(): EacsEngine {
  return {
    defSha256: '',
    ucuForEvent: () => ({ reservedValue: null, status: NO_RATE_STATUS }),
    rateBasisOf: () => ({ rateKey: null, resolvedSha256: null }),
  };
}

/** The value of local work against a named comparator is unavailable in this edition: unknown, never zero. */
export interface LocalValueUnavailable {
  usd: null;
  comparator: string;
  status: RateStatus;
  unratedEvents: number;
}

/** Explicit "unavailable" result for a comparator value. `unratedEvents` is the number of events that could not be valued. */
export function localValueUnavailable(comparator: string, unratedEvents: number): LocalValueUnavailable {
  return { usd: null, comparator, status: NO_RATE_STATUS, unratedEvents };
}
