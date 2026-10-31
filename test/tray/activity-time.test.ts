import { describe, expect, it } from 'vitest';
import { activityTimeLabel } from '../../src/tray/renderer/activity-time.js';
import type { ActivityTimeEvidence, SessionRow } from '../../src/tray/renderer/api-types.js';

const row = (activityEvidence?: ActivityTimeEvidence, activeMs = 0, source: SessionRow['source'] = 'claude') => ({ source, activeMs, activityEvidence });
const gaps: ActivityTimeEvidence = { version: 1, basis: 'activity-gaps', markCount: 3, durationMarkCount: 0, idleGapMs: 300_000 };
describe('qualified active-time display', () => {
  it('shows missing marks as unavailable rather than less than one minute of runtime', () => {
    const label = activityTimeLabel(row({ ...gaps, basis: 'no-marks', markCount: 0 }));
    expect(label.text).toBe('active — · no activity marks');
    expect(label.title).toContain('Active process time is unavailable');
  });

  it('keeps older-peer evidence unknown and qualifies any nonzero recorded active time', () => {
    expect(activityTimeLabel(row()).text).toBe('active — · basis unrecorded');
    expect(activityTimeLabel(row(undefined, 60_000)).text).toContain('1m · basis unrecorded');
  });

  it('identifies the same mark-gap estimate and threshold for list and detail consumers', () => {
    const label = activityTimeLabel(row(gaps, 60_000));
    expect(label.text).toBe('active 1m · activity estimate');
    expect(label.title).toContain('3 recorded marks');
    expect(label.title).toContain('up to 5m');
    expect(label.title).toContain('not process runtime');
  });

  it('distinguishes reported turn durations and their partial mark population from process runtime', () => {
    const label = activityTimeLabel(row({ ...gaps, basis: 'reported-turn-durations', durationMarkCount: 1 }, 60_000, 'codex'));
    expect(label.text).toBe('turn time 1m · summed');
    expect(label.title).toContain('1 reported turn durations among 3 recorded marks');
    expect(label.title).toContain('Other marks contribute no duration');
  });

  it('refuses to infer a valid basis from unsupported, incoherent or malformed remote evidence', () => {
    for (const evidence of [{ ...gaps, version: 2 }, { ...gaps, markCount: -1 }, { ...gaps, markCount: 1.5 }, { ...gaps, durationMarkCount: 4 }, { ...gaps, idleGapMs: NaN }, { ...gaps, basis: 'no-marks' }, { ...gaps, basis: 'reported-turn-durations', durationMarkCount: 1 }]) {
      expect(activityTimeLabel(row(evidence as ActivityTimeEvidence)).text).toContain('basis unrecorded');
    }
    expect(activityTimeLabel(row(gaps, Infinity)).text).toContain('basis unrecorded');
    expect(activityTimeLabel(row({ ...gaps, basis: 'no-marks', markCount: 0 }, 100)).text).toContain('basis unrecorded');
  });
});
