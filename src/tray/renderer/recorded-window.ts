import { formatQueryClock } from './format.js';
import type { QueryTimeBasis } from './api-types.js';

export interface RecordedWindowDisclosure {
  state: 'available' | 'unavailable' | 'invalid';
  window: string;
  exclusions: string | null;
}

/** Cutoff metadata describes recorded timestamps, never source-clock accuracy or a shared snapshot. */
export const RECORDED_WINDOW_QUALIFICATION = 'Source clocks and capture completeness are unverified. Later-record counts cover this database.';

function clock(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}

function count(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'unavailable';
}

/** Missing older-daemon fields stay unavailable; neither browser time nor a generation timestamp supplies a cutoff. */
export function recordedWindowDisclosure(basis: QueryTimeBasis | undefined): RecordedWindowDisclosure {
  if (!basis) return { state: 'unavailable', window: 'Recorded timestamp cutoff unavailable from this daemon.', exclusions: null };
  if (basis.timestampBasis !== 'recorded-timestamps' || basis.endInclusive !== true || !clock(basis.asOfMs)
    || basis.startMs !== null && (!clock(basis.startMs) || basis.startMs > basis.asOfMs)) {
    return { state: 'invalid', window: 'Recorded timestamp window is invalid; cutoff evidence unavailable.', exclusions: null };
  }
  const end = new Date(basis.asOfMs).toISOString();
  return {
    state: 'available',
    window: basis.startMs === null ? `Recorded history through ${end} (inclusive); start unspecified.`
      : `Recorded timestamps ${new Date(basis.startMs).toISOString()} to ${end} (both boundaries included).`,
    exclusions: `Later timestamps excluded — events: ${count(basis.excludedFutureEvents)}; activity records: ${count(basis.excludedFutureActivity)}.`,
  };
}

/** Surface unknown query clocks or recorded cutoffs without making the user open the evidence details. */
export function responseTimingWarning(queryClock: unknown, basis: QueryTimeBasis | undefined): string | null {
  const warnings: string[] = [];
  if (!clock(queryClock)) warnings.push(`Query clock · ${formatQueryClock(queryClock)}`);
  const disclosure = recordedWindowDisclosure(basis);
  if (disclosure.state !== 'available') warnings.push(disclosure.window);
  return warnings.length ? warnings.join(' · ') : null;
}
