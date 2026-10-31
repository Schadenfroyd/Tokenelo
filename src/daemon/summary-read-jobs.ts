import type { Range, SummaryResponse } from '../core/types.js';
import type { ReadControl } from '../core/read-control.js';
import { RangeReadJobs } from './range-read-jobs.js';
export { RangeJobCapacityError as SummaryJobCapacityError } from './range-read-jobs.js';
export const SUMMARY_JOB_BUDGET_MS = 45_000;
export type SummaryJobReply = import('./range-read-jobs.js').RangeJobReply<SummaryResponse>;
/** Explicit historical computation; ordinary request and fetch budgets are unchanged. */
export class SummaryReadJobs<T = SummaryResponse> extends RangeReadJobs<T> {
  constructor(read: (range: Range, control: ReadControl, variant?: import('./range-read-jobs.js').ReadJobVariant) => Promise<T>, now: () => number = Date.now) {
    super(read, SUMMARY_JOB_BUDGET_MS, now);
  }
}
