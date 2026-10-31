import { describe, expect, it } from 'vitest';
import { formatApiEquivSubtotal } from '../../src/tray/renderer/format.js';

describe('API-equivalent priced subtotal', () => {
  it('withholds the empty numeric subtotal when every event is unpriced', () => {
    expect(formatApiEquivSubtotal({ events: 1, unpricedEvents: 1, apiEquivUsd: 0 })).toBe('—');
  });
  it('keeps an explicitly priced zero distinct from an unavailable value', () => {
    expect(formatApiEquivSubtotal({ events: 1, unpricedEvents: 0, apiEquivUsd: 0 })).toBe('$0.00');
    expect(formatApiEquivSubtotal({ events: 1, unpricedEvents: 0, apiEquivUsd: null })).toBe('—');
  });
  it('keeps a mixed priced subtotal and its nonzero magnitude', () => {
    expect(formatApiEquivSubtotal({ events: 2, unpricedEvents: 1, apiEquivUsd: .000158 })).toBe('<$0.01');
    expect(formatApiEquivSubtotal({ events: 2, unpricedEvents: 1, apiEquivUsd: 0 })).toBe('$0.00');
  });
  it('does not infer that a legacy peer with unknown price coverage is all unpriced', () => {
    expect(formatApiEquivSubtotal({ events: 1, unpricedEvents: null, apiEquivUsd: 0 })).toBe('$0.00');
  });

  it('withholds the Now headline when stored price evidence reports invalid amounts', () => {
    expect(formatApiEquivSubtotal({ events: 1, unpricedEvents: 0, apiEquivUsd: 100,
      priceEvidence: { version: 1, events: 1, invalidAmountEvents: 1, unknownStatusEvents: 0,
        statusAmountConflictEvents: 0, issuesEvents: 1, aggregateAmountInvalid: true },
    })).toBe('—');
  });
});
