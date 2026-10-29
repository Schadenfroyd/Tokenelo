import { describe, expect, it } from 'vitest';
import { collectorScanStatus } from '../../src/tray/renderer/collector-status.js';
import type { CollectorScanStatus } from '../../src/tray/renderer/api-types.js';

const quiet: CollectorScanStatus = {
  name: 'claude', intervalMs: 30_000, running: false, rerunQueued: false, currentStartedAt: null,
  lastStartedAt: 900, lastFinishedAt: 1000, lastCompletedAt: 1000, lastFailedAt: null,
  lastOutcome: 'completed', lastDurationMs: 100,
  lastStats: { filesScanned: 1, filesSkipped: 0, recordsEmitted: 0, bytesRead: 0, warningCount: 0 },
};

describe('collector scan attention states', () => {
  it('a recent quiet scan is completed, independent of usage counts', () => {
    expect(collectorScanStatus(quiet, 1000)).toEqual({ label: 'Completed', tone: 'good' });
  });
  it('unrun, failed, and warning-bearing attempts never appear completed', () => {
    expect(collectorScanStatus({ ...quiet, lastFinishedAt: null, lastOutcome: null }, 1000).label).toBe('Not run');
    expect(collectorScanStatus({ ...quiet, lastOutcome: 'failed' }, 1000)).toEqual({ label: 'Failed', tone: 'bad' });
    expect(collectorScanStatus({ ...quiet, lastOutcome: 'warnings' }, 1000)).toEqual({ label: 'Warnings', tone: 'warn' });
  });
  it('a 30-second job is overdue only after three intervals, and a 10-second job gets a minute', () => {
    expect(collectorScanStatus(quiet, 91_000).label).toBe('Completed'); // 90,000 ms old, exact boundary
    expect(collectorScanStatus(quiet, 91_001).label).toBe('Check overdue');
    expect(collectorScanStatus({ ...quiet, intervalMs: 10_000 }, 61_000).label).toBe('Completed');
    expect(collectorScanStatus({ ...quiet, intervalMs: 10_000 }, 61_001).label).toBe('Check overdue');
  });
  it('an in-flight job stays scanning and becomes long without being declared failed or stopped', () => {
    const running = { ...quiet, running: true, currentStartedAt: 1000 };
    expect(collectorScanStatus(running, 50_000).label).toBe('Scanning');
    expect(collectorScanStatus(running, 91_001)).toEqual({ label: 'Long scan', tone: 'warn' });
    expect(collectorScanStatus({ ...running, lastOutcome: 'failed' }, 50_000).label).toBe('Scanning');
  });
});
