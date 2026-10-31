import { describe, expect, it } from 'vitest';
import { limitWindowTimingLabels } from '../../src/tray/renderer/limit-window-timing.js';

describe('limit window timing labels', () => {
  it('keeps the estimated block start and active reset visible without a percentage meter', () => {
    const now = Date.UTC(2026, 9, 20, 15, 0, 0);
    const labels = limitWindowTimingLabels({ startedAt: now - 3_600_000, resetsAt: now + 120_000 }, true, now);
    expect(labels.started).toBe(`Block started ${new Date(now - 3_600_000).toLocaleString()}`);
    expect(labels.reset).toBe('resets in 00:02:00');
  });

  it('distinguishes a measured window start and an already-passed reset', () => {
    const now = Date.UTC(2026, 9, 20, 15, 0, 0);
    const labels = limitWindowTimingLabels({ startedAt: now - 86_400_000, resetsAt: now - 65_000 }, false, now);
    expect(labels.started).toBe(`Window started ${new Date(now - 86_400_000).toLocaleString()}`);
    expect(labels.reset).toBe('reset passed 1m ago');
  });

  it('labels missing reset evidence explicitly and does not invent a start time', () => {
    expect(limitWindowTimingLabels({}, true, Date.UTC(2026, 9, 20))).toEqual({
      started: null,
      reset: 'reset time unavailable',
    });
  });
});
