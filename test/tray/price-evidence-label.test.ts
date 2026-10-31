import { describe, expect, it } from 'vitest';
import { priceEvidenceLabel } from '../../src/tray/renderer/quality.js';

const checkedPriceFields = {
  version: 1,
  events: 2,
  invalidAmountEvents: 0,
  unknownStatusEvents: 0,
  statusAmountConflictEvents: 0,
  issuesEvents: 0,
  aggregateAmountInvalid: false,
};

describe('price evidence label for a recorded figure', () => {
  it('keeps every unknown visible for a legacy figure that carries no price-quality fields', () => {
    expect(priceEvidenceLabel({ events: 2 })).toBe('Price field checks unavailable · Unpriced count unknown · Estimated price count unknown');
  });

  it('lists the partial-price count before the estimated-price count', () => {
    const row = { events: 2, priceEvidence: checkedPriceFields, unpricedEvents: 3, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' };
    expect(priceEvidenceLabel(row)).toBe('Partial · 3 unpriced · 1 event uses estimated prices');
  });

  it('keeps a price-field conflict ahead of the secondary count details', () => {
    const row = {
      events: 2,
      priceEvidence: { ...checkedPriceFields, unknownStatusEvents: 1, issuesEvents: 1 },
      unpricedEvents: 4,
      estimatedPriceEvents: 2,
      priceStatus: 'ESTIMATE',
    };
    expect(priceEvidenceLabel(row)).toBe('Price evidence conflicts · 1 event · Partial · 4 unpriced · 2 events use estimated prices');
  });

  it('keeps an unknown estimated-price count visible when the unpriced count is a known zero', () => {
    const row = { events: 2, priceEvidence: checkedPriceFields, unpricedEvents: 0, estimatedPriceEvents: null, priceStatus: null };
    expect(priceEvidenceLabel(row)).toBe('Estimated price count unknown');
  });

  it('keeps an unknown unpriced count visible when field checks are available', () => {
    const row = { events: 2, priceEvidence: checkedPriceFields, unpricedEvents: null, estimatedPriceEvents: 0, priceStatus: 'LIST' };
    expect(priceEvidenceLabel(row)).toBe('Unpriced count unknown');
  });

  it('shows no warning for checked list-priced fields with complete counts', () => {
    const row = { events: 2, priceEvidence: checkedPriceFields, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' };
    expect(priceEvidenceLabel(row)).toBeNull();
  });
});
