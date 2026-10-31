import type { SessionRow } from './api-types.js';
import { formatDuration } from './format.js';

/** Qualify recorded active time without treating marks or turn durations as process runtime. */
export function activityTimeLabel(row: Pick<SessionRow, 'source' | 'activeMs' | 'activityEvidence'>): { text: string; title: string } {
  const duration = Number.isFinite(row.activeMs) && row.activeMs >= 0 ? formatDuration(row.activeMs) : '—';
  const unknown = { text: `active ${row.activeMs > 0 ? duration : '—'} · basis unrecorded`, title: 'Active-time evidence is unrecorded or unsupported. Recorded active time does not establish process runtime or energy.' };
  const evidence = row.activityEvidence;
  if (!evidence || evidence.version !== 1 || !Number.isFinite(row.activeMs) || row.activeMs < 0 ||
      !Number.isSafeInteger(evidence.markCount) || evidence.markCount < 0 ||
      !Number.isSafeInteger(evidence.durationMarkCount) || evidence.durationMarkCount < 0 || evidence.durationMarkCount > evidence.markCount ||
      !Number.isFinite(evidence.idleGapMs) || evidence.idleGapMs <= 0) return unknown;
  if (evidence.basis === 'no-marks' && evidence.markCount === 0 && evidence.durationMarkCount === 0 && row.activeMs === 0) {
    return { text: 'active — · no activity marks', title: 'No activity marks were recorded in this session. Active process time is unavailable.' };
  }
  if (evidence.basis === 'reported-turn-durations' && row.source === 'codex' && evidence.durationMarkCount > 0) {
    return { text: `turn time ${duration} · summed`, title: `Sum of ${evidence.durationMarkCount} reported turn durations among ${evidence.markCount} recorded marks. Turns can overlap across subagents or start before the selected date range, so this sum can exceed elapsed time. Other marks contribute no duration; this is not process runtime or energy.` };
  }
  if (evidence.basis === 'activity-gaps' && evidence.markCount > 0 && evidence.durationMarkCount === 0) {
    return { text: `active ${duration} · activity estimate`, title: `Estimated from ${evidence.markCount} recorded marks, summing gaps up to ${formatDuration(evidence.idleGapMs)}. This is not process runtime or capture completeness.` };
  }
  return unknown;
}
