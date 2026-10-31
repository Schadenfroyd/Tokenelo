import { describe, expect, it } from 'vitest';
import { drainSteps } from '../../src/core/event-loop.js';
import { summaryAggregateSteps, type RawEventAgg } from '../../src/store/summary-aggregate.js';

// M3e: the summary totals say how good their dollars are: how many events are ESTIMATE-priced, and the weakest price status.
const row = (price_status: string, api_equiv_usd: number | null): RawEventAgg =>
  ({
    source: 'codex',
    model: 'gpt-5.6-terra',
    provider: 'openai',
    price_status,
    api_equiv_usd,
    input_fresh: 1000,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: 10,
    reasoning: 0,
    thinking: null,
  }) as unknown as RawEventAgg;
const agg = (rows: RawEventAgg[]) => drainSteps(summaryAggregateSteps(rows, (m) => m));

describe('price quality of the summary totals (M3e)', () => {
  it('all LIST: zero estimated events, status LIST', () => {
    const p = agg([row('LIST', 1), row('LIST', 2)]);
    expect(p.estimatedEvents).toBe(0);
    expect(p.totalsPriceStatus).toBe('LIST');
  });

  it('ESTIMATE events are counted and the total is ESTIMATE; their dollars are included, not dropped', () => {
    const p = agg([row('LIST', 1), row('ESTIMATE', 2), row('ESTIMATE', 3)]);
    expect(p.estimatedEvents).toBe(2);
    expect(p.totalsPriceStatus).toBe('ESTIMATE');
    expect(p.apiEquivUsd).toBe(6);
  });

  it('UNPRICED dominates ESTIMATE in the weakest status, regardless of row order', () => {
    expect(agg([row('ESTIMATE', 2), row('UNPRICED', null)]).totalsPriceStatus).toBe('UNPRICED');
    expect(agg([row('UNPRICED', null), row('ESTIMATE', 2)]).totalsPriceStatus).toBe('UNPRICED');
    expect(agg([row('UNPRICED', null)]).unpricedEvents).toBe(1);
  });

  it('an empty range has no price status (null) and zero estimated events: nothing was priced, so no status is claimed', () => {
    const p = agg([]);
    expect(p.estimatedEvents).toBe(0);
    expect(p.totalsPriceStatus).toBeNull();
  });
});
