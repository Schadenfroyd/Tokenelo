import type { DollarSourceEvidence } from './dollar-source-evidence.js';
import type { UsageResponseEvidence } from './response-evidence.js';
import { priceFieldState } from './price-evidence.js';
import { formatQueryClock } from './format.js';

/** Numeric agreement and stored-field consistency answer separate questions. */
export function usageComparisonCopy(evidence: UsageResponseEvidence, sources: DollarSourceEvidence,
  figures: { events?: number; priceEvidence?: unknown }[]): { label: string; warn: boolean } {
  const states = figures.map(priceFieldState);
  const fieldIssue = states.includes('conflict') || states.includes('invalid');
  const label = evidence.range.state === 'different' ? 'Chart and table cover different ranges'
    : evidence.numeric === 'mismatch' ? 'Chart and table figures differ'
    : evidence.numeric === 'unknown' ? 'Some comparison evidence is unavailable'
    : sources.state === 'mismatch' ? 'Compared figures agree · chart source breakdown differs'
    : sources.state === 'unavailable' ? 'Compared figures agree · chart source breakdown unavailable'
    : fieldIssue ? 'Compared figures agree · price fields need review'
    : states.includes('unchecked') ? 'Compared figures agree · price field checks unavailable'
    : 'Compared figures agree · stored price fields checked';
  return { label, warn: evidence.numeric === 'mismatch' || fieldIssue || ['mismatch', 'unavailable'].includes(sources.state) };
}

/** Query clock disclosure never changes a numeric verdict or claims a common snapshot. */
export function usageQueryClockCopy(evidence: UsageResponseEvidence): string | null {
  const difference = evidence.timestamps.differenceMs;
  return typeof difference === 'number' && Number.isFinite(difference) && difference !== 0
    ? 'Query times differ; table and chart are separate responses.'
    : null;
}

/** Compact always-visible line: the table and chart are independent responses, each with its own exact query clock. */
export function usageQueryClockLine(evidence: UsageResponseEvidence): string {
  return `Query times · Table ${formatQueryClock(evidence.timestamps.summaryGeneratedAt)} · Chart ${formatQueryClock(evidence.timestamps.timeseriesGeneratedAt)}`;
}
