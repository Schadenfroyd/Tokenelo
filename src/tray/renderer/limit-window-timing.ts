import { formatClock, formatDuration } from './format.js';
import type { LimitWindow } from './api-types.js';

export function limitWindowTimingLabels(
  window: Pick<LimitWindow, 'startedAt' | 'resetsAt'>,
  estimate: boolean,
  nowMs: number
): { started: string | null; reset: string } {
  const started = typeof window.startedAt === 'number' && Number.isFinite(window.startedAt)
    ? `${estimate ? 'Block' : 'Window'} started ${new Date(window.startedAt).toLocaleString()}`
    : null;
  const untilReset = typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)
    ? window.resetsAt - nowMs
    : null;
  const reset = untilReset === null
    ? 'reset time unavailable'
    : untilReset > 0
      ? `resets in ${formatClock(untilReset)}`
      : `reset passed ${formatDuration(-untilReset)} ago`;
  return { started, reset };
}
