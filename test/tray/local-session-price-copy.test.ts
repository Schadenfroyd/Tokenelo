import { describe, expect, it } from 'vitest';
import { localSessionPriceCopy } from '../../src/tray/renderer/local-session-price-copy.js';
import { API_EQUIVALENT_BASIS_NOTE } from '../../src/tray/renderer/quality.js';

describe('Local session API-equivalent copy', () => {
  it('labels recorded finite values, including a genuine zero, with the reference-price basis', () => {
    expect(localSessionPriceCopy({ apiEquivUsd: 12.5 })).toEqual({ value: '$12.50', label: 'Recorded API-equivalent', title: API_EQUIVALENT_BASIS_NOTE });
    expect(localSessionPriceCopy({ apiEquivUsd: 0 }).value).toBe('$0.00');
    expect(localSessionPriceCopy({ apiEquivUsd: 0 }).label).toBe('Recorded API-equivalent');
  });

  it('does not label absent, non-finite or conflicting values as recorded', () => {
    const conflict = { version: 1, events: 1, invalidAmountEvents: 1, unknownStatusEvents: 0, statusAmountConflictEvents: 0, issuesEvents: 1, aggregateAmountInvalid: false };
    const cases = [{ apiEquivUsd: null }, {}, { apiEquivUsd: Number.NaN }, { apiEquivUsd: Number.POSITIVE_INFINITY }, { events: 1, apiEquivUsd: 4.5, priceEvidence: conflict }];
    for (const figure of cases) {
      const copy = localSessionPriceCopy(figure);
      expect(copy.value).toBe('—');
      expect(copy.label).toBe('API-equivalent value unavailable');
      expect(copy.title).toBe('API-equivalent value is unavailable or cannot be trusted for this session.');
    }
    expect(conflict.invalidAmountEvents).toBe(1);
  });
});
