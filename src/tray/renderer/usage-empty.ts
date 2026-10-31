import type { SummaryResponse, TimeseriesResponse } from './api-types.js';
import { hasKnownEmptyUsage } from './token-counts.js';

/** Empty points are not automatically an empty event scope. Require mutually consistent zero
 * summary/count/price evidence, the same response range and the explicit series count capability.
 * This describes received records, never capture completeness or all activity. */
export function usageTimelineEmptyCaption(summary: SummaryResponse, series: TimeseriesResponse): string | null {
  if (series.points.length > 0) return null;
  const totals = summary.totals;
  const knownEmpty = summary.range === series.range && hasKnownEmptyUsage(totals.tokens, totals.events)
    && totals.apiEquivUsd === 0 && totals.unpricedEvents === 0 && totals.estimatedPriceEvents === 0
    && summary.byModel.length === 0 && series.priceQualityCounts === true;
  return knownEmpty ? 'No usage events recorded for this timeline.' : 'No API-equivalent timeline points were provided.';
}
