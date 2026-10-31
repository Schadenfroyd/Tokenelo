import { describe, expect, it } from 'vitest';
import { normalizeFleetTotals, priceQualityTotalsOk } from '../../src/tray/api-client.js';

// A peer built before the price-quality fields omits them: they are unknown (null) after normalisation, never zero or LIST.
describe('fleet peers: price-quality totals are validated and unknown when absent (M3e)', () => {
  const base = { events: 10, apiEquivUsd: 3.5, tokens: {} };

  it('an older peer with no price-quality fields is accepted, and normalises to unknown (null)', () => {
    expect(priceQualityTotalsOk(base)).toBe(true);
    expect(normalizeFleetTotals(base)).toMatchObject({ unpricedEvents: null, estimatedPriceEvents: null, priceStatus: null });
  });

  it('an older peer with only the unpriced count keeps it and leaves the new fields unknown', () => {
    const t = { ...base, unpricedEvents: 2 };
    expect(priceQualityTotalsOk(t)).toBe(true);
    expect(normalizeFleetTotals(t)).toMatchObject({ unpricedEvents: 2, estimatedPriceEvents: null, priceStatus: null });
  });

  it('a consistent full block is accepted and kept', () => {
    const t = { ...base, unpricedEvents: 1, estimatedPriceEvents: 2, priceStatus: 'UNPRICED' };
    expect(priceQualityTotalsOk(t)).toBe(true);
    expect(normalizeFleetTotals(t)).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 2, priceStatus: 'UNPRICED' });
  });

  it.each([
    ['a negative unpriced count', { ...base, unpricedEvents: -1, estimatedPriceEvents: 0, priceStatus: 'LIST' }],
    ['a fractional estimated count', { ...base, unpricedEvents: 0, estimatedPriceEvents: 1.5, priceStatus: 'ESTIMATE' }],
    ['an unknown status label', { ...base, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'MAYBE' }],
    ['a status that contradicts the counts', { ...base, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'ESTIMATE' }],
    ['a partial block (status without its counts)', { ...base, priceStatus: 'LIST' }],
  ])('a peer with %s is untrusted (rejected)', (_, t) => {
    expect(priceQualityTotalsOk(t)).toBe(false);
  });
});

