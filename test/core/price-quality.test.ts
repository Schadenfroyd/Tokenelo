import { describe, expect, it } from 'vitest';
import { priceFieldsOf, priceQualityFromCounts, priceQualityOf, priceQualityProblem, priceStatusOfCounts } from '../../src/core/price-quality.js';
import { priceEvidenceOf } from '../../src/core/price-evidence.js';

describe('price quality (M3e): one definition for every layer', () => {
  it('missing dollars are unpriced even under LIST/ESTIMATE annotations and never counted twice', () => {
    const q = priceQualityOf([{ apiEquivUsd: null, priceStatus: 'LIST' }, { apiEquivUsd: null, priceStatus: 'ESTIMATE' },
      { apiEquivUsd: 0, priceStatus: 'ESTIMATE' }]);
    expect(q).toMatchObject({ events: 3, unpricedEvents: 2, estimatedPriceEvents: 1, priceStatus: null, priceEvidence: { events: 3, issuesEvents: 2, statusAmountConflictEvents: 2 } });
    expect(priceQualityProblem(q)).toBeNull();
  });
  it('mixed priced, estimated and unpriced events: counts from the events and the weakest status (UNPRICED dominates)', () => {
    const q = priceQualityOf([
      { apiEquivUsd: 1, priceStatus: 'LIST' },
      { apiEquivUsd: 2, priceStatus: 'ESTIMATE' },
      { apiEquivUsd: null, priceStatus: 'UNPRICED' },
    ]);
    expect(q).toEqual({ events: 3, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
  });

  it('estimated but nothing unpriced: ESTIMATE, and the estimated dollars are still counted', () => {
    expect(priceQualityOf([{ apiEquivUsd: 2, priceStatus: 'ESTIMATE' }, { apiEquivUsd: 1, priceStatus: 'LIST' }])).toEqual({
      events: 2,
      unpricedEvents: 0,
      estimatedPriceEvents: 1,
      priceStatus: 'ESTIMATE',
    });
  });

  it('all LIST: LIST with zero estimated; no events: status null (nothing is claimed)', () => {
    expect(priceQualityOf([{ apiEquivUsd: 1, priceStatus: 'LIST' }])).toMatchObject({ priceStatus: 'LIST', estimatedPriceEvents: 0 });
    expect(priceQualityOf([])).toEqual({ events: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null });
  });

  it('row fields are the same numbers as the quality (what a session row spreads)', () => {
    expect(priceFieldsOf([{ apiEquivUsd: null, priceStatus: 'UNPRICED' }])).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 0, priceStatus: 'UNPRICED', priceEvidence: { events: 1, issuesEvents: 0 } });
  });

  it('the status function agrees with the event definition on every combination of counts', () => {
    expect(priceStatusOfCounts(0, 0, 0)).toBeNull();
    expect(priceStatusOfCounts(2, 0, 0)).toBe('LIST');
    expect(priceStatusOfCounts(2, 0, 1)).toBe('ESTIMATE');
    expect(priceStatusOfCounts(2, 1, 1)).toBe('UNPRICED');
  });
});

describe('quality and evidence edge contracts', () => {
  it('does not trust a single price-evidence issue when assigning an aggregate label', () => {
    const q = priceQualityOf([{ apiEquivUsd: null, priceStatus: 'LIST' }]);
    expect(q).toMatchObject({ events: 1, unpricedEvents: 1, estimatedPriceEvents: 0, priceStatus: null, priceEvidence: { events: 1, issuesEvents: 1, statusAmountConflictEvents: 1 } });
  });

  it('preserves optional evidence on count-derived quality results', () => {
    const clean = priceEvidenceOf(2, 'LIST');
    const conflict = priceEvidenceOf(null, 'LIST');
    expect(priceQualityFromCounts(1, 0, 0, clean)).toEqual({ events: 1, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST', priceEvidence: clean });
    expect(priceQualityFromCounts(1, 1, 0, conflict)).toEqual({ events: 1, unpricedEvents: 1, estimatedPriceEvents: 0, priceStatus: null, priceEvidence: conflict });
    expect(priceQualityFromCounts(1, 0, 0)).toEqual({ events: 1, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });

  it('marks a negative event amount as an invalid aggregate as well as invalid input evidence', () => {
    const q = priceQualityOf([{ apiEquivUsd: -1, priceStatus: 'LIST' }]);
    expect(q.priceStatus).toBeNull();
    expect(q.priceEvidence).toMatchObject({ events: 1, invalidAmountEvents: 1, issuesEvents: 1, aggregateAmountInvalid: true });
  });

  it('does not let an unpriced event mask a negative amount during aggregate validation', () => {
    const q = priceQualityOf([{ apiEquivUsd: -1, priceStatus: 'LIST' }, { apiEquivUsd: null, priceStatus: 'UNPRICED' }]);
    expect(q.priceStatus).toBeNull();
    expect(q.priceEvidence).toMatchObject({ events: 2, invalidAmountEvents: 1, issuesEvents: 1, aggregateAmountInvalid: true });
  });

  it('does not coerce a non-finite event amount to zero before aggregate validation', () => {
    const q = priceQualityOf([{ apiEquivUsd: Number.NaN, priceStatus: 'LIST' }]);
    expect(q.priceStatus).toBeNull();
    expect(q.priceEvidence).toMatchObject({ events: 1, invalidAmountEvents: 1, issuesEvents: 1, aggregateAmountInvalid: true });
  });
});
describe('payload validation (M3e): corrupt price-quality blocks are rejected; a consistent block passes', () => {
  const ok = { events: 3, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' };

  it('a consistent block passes, and so does an empty one', () => {
    expect(priceQualityProblem(ok)).toBeNull();
    expect(priceQualityProblem({ events: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null })).toBeNull();
  });

  it.each([
    ['a negative count', { ...ok, unpricedEvents: -1 }],
    ['a fractional count', { ...ok, estimatedPriceEvents: 0.5 }],
    ['an unsafe count', { ...ok, unpricedEvents: Number.MAX_SAFE_INTEGER + 2 }],
    ['a string count', { ...ok, estimatedPriceEvents: '1' }],
    ['an unknown label', { ...ok, priceStatus: 'PARTIAL' }],
    ['LIST with unpriced events', { ...ok, priceStatus: 'LIST' }],
    ['null status with events', { ...ok, priceStatus: null }],
    ['more unpriced and estimated than events', { events: 1, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' }],
  ])('rejects %s', (_, block) => {
    expect(priceQualityProblem(block)).not.toBeNull();
  });

  it('rejects a non-object', () => {
    expect(priceQualityProblem(null)).not.toBeNull();
    expect(priceQualityProblem('x')).not.toBeNull();
  });
});
