import { describe, expect, it } from 'vitest';
import { observeClaudeMessage } from '../../src/measurement/claude-observation.js';
import { CACHE_CREATION_RECONCILIATION_VERSION, reconcileCacheCreation } from '../../src/measurement/cache-creation-evidence.js';

const fromUsage = (usage: unknown) => {
  const observed = observeClaudeMessage({ usage }).topLevel.cacheCreation;
  return reconcileCacheCreation(observed);
};

describe('private cache-count evidence: flat total and TTL partition remain separate', () => {
  it('retains 100 total and 60 unknown TTL beside the known 40 five-minute tokens', () => {
    const result = fromUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40 } });
    expect(result.policyVersion).toBe(CACHE_CREATION_RECONCILIATION_VERSION);
    expect(result.total).toEqual({ state: 'reported', value: 100 });
    expect(result.knownTtlSubtotal).toBe(40);
    expect(result.unknownTtlResidual).toBe(60);
    expect(result.ttlPartition).toBe('partial');
    expect(result.observations.ephemeral1h).toEqual({ state: 'missing', value: null });
    expect(result.issues).toEqual([]);
  });

  it('keeps a reported zero split from discarding a positive flat total or inventing a TTL', () => {
    const result = fromUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    expect(result.total).toEqual({ state: 'reported', value: 100 });
    expect(result.knownTtlSubtotal).toBe(0);
    expect(result.unknownTtlResidual).toBe(100);
    expect(result.ttlPartition).toBe('partial');
  });

  it('complete reported splits count once, and true zero remains explicitly reported', () => {
    const full = fromUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } });
    expect([full.total, full.knownTtlSubtotal, full.unknownTtlResidual, full.ttlPartition]).toEqual([{ state: 'reported', value: 100 }, 100, 0, 'complete']);
    const zero = fromUsage({ cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
    expect([zero.total, zero.knownTtlSubtotal, zero.unknownTtlResidual, zero.ttlPartition]).toEqual([{ state: 'reported', value: 0 }, 0, 0, 'complete']);
  });

  it('without a flat total even two reported TTL fields supply only a lower bound', () => {
    const result = fromUsage({ cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } });
    expect(result.total).toEqual({ state: 'lower-bound', value: 100 });
    expect(result.unknownTtlResidual).toBeNull();
    expect(result.ttlPartition).toBe('partial');
    expect(result.observations.flatTotal).toEqual({ state: 'missing', value: null });
  });

  it('missing is not reported zero; absent and null containers remain distinguishable', () => {
    for (const usage of [{}, { cache_creation: null }]) {
      const result = fromUsage(usage);
      expect(result.total).toEqual({ state: 'missing', value: null });
      expect(result.knownTtlSubtotal).toBeNull();
      expect(result.unknownTtlResidual).toBeNull();
      expect(result.ttlPartition).toBe('not-reported');
    }
    expect(fromUsage({}).observations.container).toBe('absent');
    expect(fromUsage({ cache_creation: null }).observations.container).toBe('null');
    expect(fromUsage({ cache_creation_input_tokens: 0 }).total).toEqual({ state: 'reported', value: 0 });
  });

  it('known TTL above the flat report is conflict; keeps both reports without clamp', () => {
    const result = fromUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 30 } });
    expect(result.total).toEqual({ state: 'conflict', value: null });
    expect(result.knownTtlSubtotal).toBe(110);
    expect(result.unknownTtlResidual).toBeNull();
    expect(result.ttlPartition).toBe('conflict');
    expect(result.observations.flatTotal).toEqual({ state: 'reported', value: 100 });
    expect(result.issues).toContain('known-ttl-exceeds-flat-total');
  });

  it('invalid flat count cannot become zero; usable splits remain a qualified lower bound', () => {
    const result = fromUsage({ cache_creation_input_tokens: '100', cache_creation: { ephemeral_5m_input_tokens: 40 } });
    expect(result.total).toEqual({ state: 'lower-bound', value: 40 });
    expect(result.unknownTtlResidual).toBeNull();
    expect(result.issues).toEqual(['flat-total-invalid-for-count']);
    expect(result.observations.flatTotal).toEqual({ state: 'invalid', value: null });
  });

  it('invalid TTL detail does not discard a valid flat count; it remains qualified', () => {
    const result = fromUsage({ cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: '40', ephemeral_1h_input_tokens: 20 } });
    expect(result.total).toEqual({ state: 'reported', value: 100 });
    expect(result.knownTtlSubtotal).toBe(20);
    expect(result.unknownTtlResidual).toBe(80);
    expect(result.ttlPartition).toBe('invalid');
    expect(result.issues).toEqual(['ttl-5m-invalid-for-count']);
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])('raw finite %s survives observation but is unavailable under the exact-count convention', value => {
    const result = fromUsage({ cache_creation_input_tokens: value });
    expect(result.countConvention).toBe('nonnegative-safe-integer');
    expect(result.total).toEqual({ state: 'invalid', value: null });
    expect(result.observations.flatTotal).toEqual({ state: 'reported', value });
    expect(result.issues).toEqual(['flat-total-invalid-for-count']);
  });

  it('refuses an unsafe TTL sum instead of exposing a rounded exact count', () => {
    const result = fromUsage({ cache_creation: { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 1 } });
    expect(result.total).toEqual({ state: 'invalid', value: null });
    expect(result.knownTtlSubtotal).toBeNull();
    expect(result.ttlPartition).toBe('invalid');
    expect(result.issues).toEqual(['ttl-subtotal-out-of-safe-range']);
  });

  it('malformed container is not silent TTL absence; flat work count stays recorded', () => {
    const result = fromUsage({ cache_creation_input_tokens: 100, cache_creation: [] });
    expect(result.total).toEqual({ state: 'reported', value: 100 });
    expect(result.ttlPartition).toBe('invalid');
    expect(result.issues).toEqual(['cache-container-malformed']);
  });

  it('does not mutate frozen observations, alias returned fields, or retain message content', () => {
    const input = observeClaudeMessage({ usage: { cache_creation_input_tokens: 100 }, content: [{ type: 'text', text: 'private fixture sentinel' }] }).topLevel.cacheCreation;
    Object.freeze(input.flatTotal); Object.freeze(input.ephemeral5m); Object.freeze(input.ephemeral1h); Object.freeze(input);
    const before = JSON.stringify(input), result = reconcileCacheCreation(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(result.observations).not.toBe(input);
    expect(result.observations.flatTotal).not.toBe(input.flatTotal);
    expect(JSON.stringify(result)).not.toContain('private fixture sentinel');
    expect(result).not.toHaveProperty('reservedValue');
    expect(result).not.toHaveProperty('apiEquivUsd');
  });
});
