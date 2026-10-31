import { describe, expect, it } from 'vitest';
import { observeClaudeMessage } from '../../src/measurement/claude-observation.js';
import { mergeCacheWriteObservations, projectCacheWrites } from '../../src/measurement/cache-write-projection.js';

const observe = (flat: number | undefined, five?: number, hour?: number) => observeClaudeMessage({ usage: {
  ...(flat === undefined ? {} : { cache_creation_input_tokens: flat }),
  ...(five === undefined && hour === undefined ? {} : { cache_creation: {
    ...(five === undefined ? {} : { ephemeral_5m_input_tokens: five }),
    ...(hour === undefined ? {} : { ephemeral_1h_input_tokens: hour }),
  } }),
} }).topLevel.cacheCreation;

describe('cache assignment before integration: count once, unknown TTL stays separate', () => {
  it('partial and zero splits conserve all reported work without assigning residual to 1h', () => {
    for (const [five, hour, known, residual] of [[40, undefined, 40, 60], [0, 0, 0, 100]] as const) {
      const r = projectCacheWrites(observe(100, five, hour), 'assume-1h-if-no-ttl-reported');
      expect([r.exactCacheWork, r.known5m + r.known1h, r.assumed1h, r.unassignedTtl, r.priceBasis]).toEqual([100, known, 0, residual, 'unknown-ttl']);
      expect(r.known5m + r.known1h + r.assumed1h + r.unassignedTtl!).toBe(100);
    }
  });

  it('source fallback is opt-in and remains an assumption, not reported TTL', () => {
    const raw = observe(100), conservative = projectCacheWrites(raw), legacy = projectCacheWrites(raw, 'assume-1h-if-no-ttl-reported');
    expect([conservative.assumed1h, conservative.unassignedTtl, conservative.priceBasis]).toEqual([0, 100, 'unknown-ttl']);
    expect([legacy.known1h, legacy.assumed1h, legacy.unassignedTtl, legacy.priceBasis]).toEqual([0, 100, 0, 'assumed-1h']);
    expect(legacy.evidence.observations.ephemeral1h).toEqual({ state: 'missing', value: null });
  });

  it('absent flat, conflict and invalid never manufacture a resolved cache-work basis', () => {
    for (const raw of [observe(undefined, 40), observe(100, 80, 30), observe(1.5)]) {
      const r = projectCacheWrites(raw, 'assume-1h-if-no-ttl-reported');
      expect(r.exactCacheWork).toBeNull();
      expect(r.unassignedTtl).toBeNull();
      expect(r.assumed1h).toBe(0);
      expect(['incomplete', 'conflict', 'invalid']).toContain(r.priceBasis);
    }
    expect(projectCacheWrites(observe(undefined)).exactCacheWork).toBeNull();
  });

  it('invalid TTL prevents source fallback without discarding an independently valid flat count', () => {
    const raw = observeClaudeMessage({ usage: { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: '40' } } }).topLevel.cacheCreation;
    const r = projectCacheWrites(raw, 'assume-1h-if-no-ttl-reported');
    expect([r.exactCacheWork, r.assumed1h, r.unassignedTtl, r.priceBasis]).toEqual([100, 0, 100, 'invalid']);
  });

  it('explicit flat zero is no cache work, without claiming missing TTL fields were reported', () => {
    for (const raw of [observe(0), observe(0, 0, 0)]) {
      const r = projectCacheWrites(raw, 'assume-1h-if-no-ttl-reported');
      expect([r.exactCacheWork, r.assumed1h, r.unassignedTtl, r.priceBasis]).toEqual([0, 0, 0, 'no-cache-work']);
    }
  });

  it('refuses an unsupported runtime fallback policy instead of mislabeling a valid version', () => {
    expect(() => projectCacheWrites(observe(100), 'unsupported' as 'none')).toThrow(RangeError);
  });
});

describe('raw snapshot merge: assumptions/residuals are recomputed, not field-MAX counters', () => {
  it.each([
    ['assumed-to-explicit-five', observe(100), observe(100, 100, 0)],
    ['explicit-five-to-assumed', observe(100, 100, 0), observe(100)],
    ['partial-to-complete-five', observe(100, 40), observe(100, 100, 0)],
  ])('%s keeps exactly 100 cache work without double counting old assignments', (_name, a, b) => {
    const result = mergeCacheWriteObservations(a, b, 'assume-1h-if-no-ttl-reported');
    const r = result.projection;
    expect([r.exactCacheWork, r.known5m, r.known1h, r.assumed1h, r.unassignedTtl, r.priceBasis]).toEqual([100, 100, 0, 0, 0, 'reported-ttl']);
    expect(mergeCacheWriteObservations(b, a, 'assume-1h-if-no-ttl-reported')).toEqual(result);
  });

  it('contradictory category maxima remain conflict; no full-snapshot winner hides it', () => {
    const r = mergeCacheWriteObservations(observe(100, 40), observe(100, 0, 100)).projection;
    expect([r.known5m, r.known1h, r.exactCacheWork, r.unassignedTtl, r.priceBasis]).toEqual([40, 100, null, null, 'conflict']);
    expect(r.evidence.issues).toContain('known-ttl-exceeds-flat-total');
  });

  it('ordinary monotone and ordered-unknown decreases follow the explicit raw MAX contract', () => {
    const grown = mergeCacheWriteObservations(observe(100, 40, 60), observe(120, 60, 60)).projection;
    expect([grown.exactCacheWork, grown.known5m, grown.known1h]).toEqual([120, 60, 60]);
    const lower = mergeCacheWriteObservations(observe(100, 40, 60), observe(90, 40, 50)).projection;
    expect([lower.exactCacheWork, lower.known5m, lower.known1h]).toEqual([100, 40, 60]);
    // This function has no chronological proof; it does not claim a verified reset/decrease.
  });

  it('explicit-zero repetitions retain 100 unassigned work and never become zero usage', () => {
    const r = mergeCacheWriteObservations(observe(100, 0, 0), observe(100, 0, 0)).projection;
    expect([r.exactCacheWork, r.known5m + r.known1h, r.unassignedTtl]).toEqual([100, 0, 100]);
  });

  it('merge is associative/idempotent and does not mutate frozen observations', () => {
    const values = [observe(100), observe(100, 40), observe(100, 100, 0)];
    const before = JSON.stringify(values);
    for (const raw of values) { Object.freeze(raw.flatTotal); Object.freeze(raw.ephemeral5m); Object.freeze(raw.ephemeral1h); Object.freeze(raw); }
    const left = mergeCacheWriteObservations(mergeCacheWriteObservations(values[0], values[1]).mergedObservation, values[2]);
    const right = mergeCacheWriteObservations(values[0], mergeCacheWriteObservations(values[1], values[2]).mergedObservation);
    expect(left).toEqual(right);
    expect(mergeCacheWriteObservations(left.mergedObservation, left.mergedObservation)).toEqual(left);
    expect(JSON.stringify(values)).toBe(before);
  });

  it('invalid is absorbing and unsafe arithmetic remains unavailable', () => {
    const bad = observeClaudeMessage({ usage: { cache_creation_input_tokens: '100' } }).topLevel.cacheCreation;
    expect(mergeCacheWriteObservations(bad, observe(100)).projection.exactCacheWork).toBeNull();
    const unsafe = mergeCacheWriteObservations(observe(undefined, Number.MAX_SAFE_INTEGER), observe(undefined, undefined, 1)).projection;
    expect([unsafe.exactCacheWork, unsafe.unassignedTtl, unsafe.priceBasis]).toEqual([null, null, 'invalid']);
  });
});
