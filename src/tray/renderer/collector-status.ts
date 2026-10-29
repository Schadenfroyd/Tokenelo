import type { CollectorScanStatus } from './api-types.js';

/** Three scheduled intervals (at least a minute) is an attention threshold, not proof
 * that a collector stopped or lost data. Compare with the daemon's snapshot time. */
export function collectorScanStatus(scan: CollectorScanStatus, observedAt: number): {
  label: string; tone: 'good' | 'warn' | 'bad' | 'neutral';
} {
  const attentionAfterMs = Math.max(60_000, scan.intervalMs * 3);
  if (scan.running) {
    return scan.currentStartedAt !== null && observedAt - scan.currentStartedAt > attentionAfterMs
      ? { label: 'Long scan', tone: 'warn' }
      : { label: 'Scanning', tone: 'neutral' };
  }
  if (scan.lastOutcome === 'failed') return { label: 'Failed', tone: 'bad' };
  if (scan.lastFinishedAt === null || scan.lastOutcome === null) return { label: 'Not run', tone: 'neutral' };
  if (observedAt - scan.lastFinishedAt > attentionAfterMs) return { label: 'Check overdue', tone: 'warn' };
  if (scan.lastOutcome === 'warnings') return { label: 'Warnings', tone: 'warn' };
  return { label: 'Completed', tone: 'good' };
}
