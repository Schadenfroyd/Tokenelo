import { describe, expect, it } from 'vitest';
import type { IncompleteCaptureStatus } from '../../src/tray/renderer/api-types.js';
import { claudeCaptureHoldView } from '../../src/tray/renderer/capture-completeness.js';

const clear: IncompleteCaptureStatus = {
  collector: 'claude', heldFiles: 0, oldestHeldAt: null, maxLineBytes: null,
};
const lineHold: IncompleteCaptureStatus = {
  collector: 'claude', heldFiles: 2, oldestHeldAt: 100, maxLineBytes: 4096,
  storedComponentEvidenceHeldFiles: 0,
};

describe('Claude capture hold evidence', () => {
  it('keeps an absent aggregate or Claude collector entry unavailable', () => {
    expect(claudeCaptureHoldView(undefined)).toMatchObject({
      state: 'unavailable', label: 'Hold status unavailable', heldFiles: null,
    });
    expect(claudeCaptureHoldView([]).state).toBe('unavailable');
  });

  it('keeps an explicit zero separate from unavailable and from complete capture', () => {
    const view = claudeCaptureHoldView([clear]);
    expect(view).toMatchObject({ state: 'clear', label: 'No holds', tone: 'neutral', heldFiles: 0 });
    expect(view.detail).toContain('Review scan results');
    expect(view.detail).not.toContain('complete');
  });

  it('shows positive line holds with a warning and precise recovery copy', () => {
    const view = claudeCaptureHoldView([lineHold]);
    expect(view).toMatchObject({
      state: 'incomplete', label: 'Incomplete', tone: 'warn',
      heldFiles: 2, storedComponentEvidenceHeldFiles: 0, oldestHeldAt: 100, maxLineBytes: 4096,
    });
    expect(view.detail).toContain('held Claude files');
    expect(view.detail).toContain('later records remain unread');
  });

  it('does not treat an absent optional hold subtype as zero', () => {
    const view = claudeCaptureHoldView([{ collector: 'claude', heldFiles: 1, oldestHeldAt: 10, maxLineBytes: null }]);
    expect(view.state).toBe('incomplete');
    expect(view.storedComponentEvidenceHeldFiles).toBeNull();
    expect(view.detail).toContain('hold subtype is unavailable');
  });

  it('uses a separate recovery explanation when every positive hold is a stored-evidence batch', () => {
    const view = claudeCaptureHoldView([{
      collector: 'claude', heldFiles: 1, oldestHeldAt: 10, maxLineBytes: null,
      storedComponentEvidenceHeldFiles: 1,
    }]);
    expect(view.state).toBe('incomplete');
    expect(view.detail).toContain('batches and later records remain uncommitted');
  });
});
