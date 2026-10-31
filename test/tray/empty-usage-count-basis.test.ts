import { describe, expect, it } from 'vitest';
import type { TokenCounts } from '../../src/tray/renderer/api-types.js';
import { countBasisLabel } from '../../src/tray/renderer/token-counts.js';

const zero: TokenCounts = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };

describe('scoped empty usage count evidence', () => {
  it('explains an explicitly empty event scope without inferring capture completeness', () => {
    expect(countBasisLabel(zero, 0)).toBe('No usage events recorded in this scope');
  });
  it('preserves legacy evidence when the event count is unavailable or positive', () => {
    for (const events of [undefined, null, 1]) expect(countBasisLabel(zero, events)).toContain('Count evidence unrecorded');
  });
  it('does not accept malformed event counts as an empty scope', () => {
    for (const events of [-1, NaN, Infinity, 0.5, '0'] as unknown as number[]) {
      expect(countBasisLabel(zero, events)).toContain('Count evidence unrecorded');
    }
  });
  it('does not hide unresolved count evidence behind a contradictory zero event count', () => {
    for (const countQuality of ['incomplete', 'invalid', 'conflict'] as const) {
      expect(countBasisLabel({ ...zero, countQuality }, 0)).toContain(`${countQuality} count evidence`);
    }
  });
  it('does not hide nonzero or malformed counters behind a zero event count', () => {
    for (const field of ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'cacheWriteUnassigned', 'cacheWriteAssumed1h']) {
      for (const value of [1, NaN, null]) expect(countBasisLabel({ ...zero, [field]: value } as TokenCounts, 0)).not.toBe('No usage events recorded in this scope');
    }
  });
  it('keeps nonempty qualified counts and eligible work evidence unchanged', () => {
    expect(countBasisLabel({ ...zero, inputFresh: 7, countQuality: 'complete', cacheWriteAssumed1h: 3 }, 1)).toBe('Reported count basis · 3 cache writes assumed 1 hour');
    expect(countBasisLabel({ ...zero, countQuality: 'incomplete', ucuCountQuality: 'complete' }, 1)).toContain('v1-fresh work count known; excludes cache reads');
  });
});
