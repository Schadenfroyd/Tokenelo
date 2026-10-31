import { describe, expect, it } from 'vitest';
import { summarizeSessionTelemetry } from '../../src/core/sessions.js';
import type { UsageEvent } from '../../src/core/types.js';
import { bucketTimeseries } from '../../src/store/queries.js';
import { summaryAggregateSteps, type RawEventAgg } from '../../src/store/summary-aggregate.js';
import { makeEvent } from '../store/stubs.js';

// M3e propagation (2026-10-04): every monetary breakdown carries the price quality of ITS OWN events. An absent count is unknown; a
// count of zero is a known zero; no breakdown borrows a whole-host count or reports LIST for unknown events.

function ev(id: string, p: { apiEquivUsd: number | null; priceStatus: UsageEvent['priceStatus']; provider?: string; engine?: string; ts?: number }): UsageEvent {
  return {
    ...makeEvent({ id, inputFresh: 100, output: 10, ts: p.ts ?? 1_000, source: 'ollama-proxy' }),
    provider: p.provider ?? 'local',
    engine: p.engine ?? 'ollama',
    apiEquivUsd: p.apiEquivUsd,
    priceStatus: p.priceStatus,
  } as UsageEvent;
}

describe('capture feeds carry the price quality of their own events', () => {
  it('a mixed feed reports its estimated and unpriced counts and the weakest status', () => {
    const feeds = summarizeSessionTelemetry([
      ev('a', { apiEquivUsd: 1, priceStatus: 'LIST' }),
      ev('b', { apiEquivUsd: 2, priceStatus: 'ESTIMATE' }),
      ev('c', { apiEquivUsd: null, priceStatus: 'UNPRICED' }),
    ]);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ events: 3, unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
  });

  it('a feed with only estimated and listed events is KNOWN unpriced 0 (not unknown), status ESTIMATE', () => {
    const [feed] = summarizeSessionTelemetry([ev('a', { apiEquivUsd: 1, priceStatus: 'LIST' }), ev('b', { apiEquivUsd: 2, priceStatus: 'ESTIMATE' })]);
    expect(feed).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' });
  });

  it('a fully listed feed is a known zero and LIST, never null', () => {
    const [feed] = summarizeSessionTelemetry([ev('a', { apiEquivUsd: 1, priceStatus: 'LIST' })]);
    expect(feed).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });

  it('counts are scoped per feed: an unpriced event in one provider does not touch another feed', () => {
    const feeds = summarizeSessionTelemetry([
      ev('a', { apiEquivUsd: null, priceStatus: 'UNPRICED', provider: 'anthropic', engine: undefined }),
      ev('b', { apiEquivUsd: 3, priceStatus: 'LIST', provider: 'local', engine: 'ollama' }),
    ]);
    const byProvider = Object.fromEntries(feeds.map((f) => [f.provider, f]));
    expect(byProvider.anthropic).toMatchObject({ unpricedEvents: 1, priceStatus: 'UNPRICED' });
    expect(byProvider.local).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });
});

describe('chart buckets carry the price quality of their own rows', () => {
  // Every row states its price inputs: an omitted input is unknown, not false.
  const row = (ts: number, extra: { unpriced?: boolean; estimated?: boolean }) => ({ ts, source: 'claude' as const, tok: 10, totalTok: 10, usd: 1, unpriced: false, estimated: false, ...extra });

  it('a bucket with an unpriced row is UNPRICED with its own counts; the next bucket is a known LIST', () => {
    const points = bucketTimeseries(
      [row(0, { estimated: true }), row(10, { unpriced: true }), row(3_600_000, {}), row(3_600_010, {})],
      3_600_000,
    );
    expect(points[0]).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
    expect(points[1]).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });

  it('an estimated-only bucket is ESTIMATE, not LIST', () => {
    const [p] = bucketTimeseries([row(0, { estimated: true })], 3_600_000);
    expect(p).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' });
  });
});

describe('source breakdowns carry the price quality of their own rows', () => {
  const raw = (source: RawEventAgg['source'], price: { api_equiv_usd: number | null; price_status: string }): RawEventAgg => ({
    source,
    model: 'm',
    provider: 'p',
    price_status: price.price_status,
    api_equiv_usd: price.api_equiv_usd,
    input_fresh: 10,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: 1,
    reasoning: 0,
    thinking: null,
  });

  it('bySource: each source counts its own unpriced and estimated rows; the totals still reflect all rows', () => {
    const rows = [
      raw('claude', { api_equiv_usd: 1, price_status: 'ESTIMATE' }),
      raw('claude', { api_equiv_usd: null, price_status: 'UNPRICED' }),
      raw('codex', { api_equiv_usd: 2, price_status: 'LIST' }),
    ];
    const g = summaryAggregateSteps(rows, (m) => m);
    let r = g.next();
    while (!r.done) r = g.next();
    const parts = r.value;
    expect(parts.bySource.claude).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED' });
    expect(parts.bySource.codex).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' });
  });
});
