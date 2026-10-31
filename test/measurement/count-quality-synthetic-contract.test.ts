import { describe, expect, it } from 'vitest';
import type { TokenCounts } from '../../src/core/types.js';
import { captureCountEnvelope } from '../../src/measurement/count-envelope.js';
import type { CountEnvelope } from '../../src/measurement/count-envelope-types.js';
import { buildShareReport } from '../../src/cli/share-report.js';
import type { UsageAggregateResponse } from '../../src/store/usage-aggregate.js';
import { countBasisLabel, tokenCountDetails } from '../../src/tray/renderer/token-counts.js';

// Synthetic FILED-EXAMPLE contract data only. This does not read a ledger or attest live acceptance.
const synthetic = (patch: Record<string, unknown> = {}) => ({
  input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, ...patch,
});

function envelope(raw: unknown): CountEnvelope {
  const result = captureCountEnvelope(raw);
  expect(result.kind).toBe('count-envelope');
  if (result.kind !== 'count-envelope') throw new Error('Expected a synthetic single-component envelope');
  return result;
}

function tokensOf(e: CountEnvelope): TokenCounts {
  const tokens: TokenCounts = {
    inputFresh: e.categories.inputFresh, output: e.categories.output, cacheRead: e.categories.cacheRead,
    cacheWrite5m: e.categories.cacheWrite5m, cacheWrite1h: e.categories.cacheWrite1h,
    cacheWriteUnassigned: e.categories.cacheWriteUnassigned, cacheWriteAssumed1h: e.categories.cacheWriteAssumed1h,
    reasoning: 0, countQuality: e.totals.full.quality,
  };
  if (e.totals.freshWork.quality !== e.totals.full.quality) tokens.ucuCountQuality = e.totals.freshWork.quality;
  return tokens;
}

function pricedDisclosure(tokens: TokenCounts) {
  const summary: UsageAggregateResponse = {
    range: 'all', generatedAt: 1,
    totals: { events: 1, tokens, apiEquivUsd: 0.125, unpricedEvents: 0, estimatedPriceEvents: 1, priceStatus: 'ESTIMATE' },
    bySource: {},
  };
  return buildShareReport(summary, 'all');
}

const cases = [
  { label: 'complete explicit zero', raw: synthetic({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }),
    fullQuality: 'complete', fullValue: 0, freshQuality: 'complete' },
  { label: 'missing cache read', raw: (() => { const value = synthetic(); delete (value as Record<string, unknown>).cache_read_input_tokens; return value; })(),
    fullQuality: 'incomplete', fullValue: null, freshQuality: 'complete' },
  { label: 'invalid input counter', raw: synthetic({ input_tokens: 1.5 }),
    fullQuality: 'invalid', fullValue: null, freshQuality: 'invalid' },
  { label: 'conflicting cache split', raw: synthetic({ cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 11 } }),
    fullQuality: 'conflict', fullValue: null, freshQuality: 'conflict' },
] as const;

describe('synthetic count-quality contract through measurement and price disclosure', () => {
  it.each(cases)('retains $label quality and keeps price disclosure independent', sample => {
    const e = envelope(sample.raw);
    expect(e.totals.full).toEqual({ quality: sample.fullQuality, value: sample.fullValue });
    expect(e.totals.freshWork.quality).toBe(sample.freshQuality);

    const tokens = tokensOf(e);
    const details = tokenCountDetails(tokens);
    expect(details.totalAvailable).toBe(sample.fullQuality === 'complete');
    if (sample.fullQuality === 'complete') expect(details.subtotal).toBe(sample.fullValue);
    else expect(details.subtotal).not.toBeNull();

    const report = pricedDisclosure(tokens);
    expect(report.totals.tokens.countQuality).toBe(sample.fullQuality);
    expect(report.totals.tokens.completeTotal).toBe(sample.fullValue);
    expect(report.totals.pricing).toMatchObject({ storedApiEquivalentUsd: 0.125, priceStatus: 'ESTIMATE' });
  });

  it.each([
    ['missing cache read', (() => { const value = synthetic(); delete (value as Record<string, unknown>).cache_read_input_tokens; return value; })(), 'incomplete'],
    ['invalid cache read', synthetic({ cache_read_input_tokens: 'SYNTHETIC-INVALID' }), 'invalid'],
  ] as const)('keeps fresh-work quality independently complete with %s', (_label, raw, fullQuality) => {
    const e = envelope(raw);
    expect(e.totals.full).toEqual({ quality: fullQuality, value: null });
    expect(e.totals.freshWork).toEqual({ quality: 'complete', value: 5 });

    const tokens = tokensOf(e);
    expect(tokens.countQuality).toBe(fullQuality);
    expect(tokens.ucuCountQuality).toBe('complete');
    expect(countBasisLabel(tokens)).toContain('v1-fresh work count known; excludes cache reads');
    expect(pricedDisclosure(tokens).totals.tokens.completeTotal).toBeNull();
  });

  it('keeps legacy unrecorded zero categories distinct from a complete zero total', () => {
    const legacy: TokenCounts = { inputFresh: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
      cacheWriteUnassigned: 0, cacheWriteAssumed1h: 0, reasoning: 0 };
    const report = pricedDisclosure(legacy);
    expect(countBasisLabel(legacy)).toContain('Count evidence unrecorded');
    expect(report.totals.tokens).toMatchObject({ countQuality: 'unrecorded', normalizedCategorySubtotal: 0, completeTotal: null });
    expect(report.totals.pricing).toMatchObject({ storedApiEquivalentUsd: 0.125, priceStatus: 'ESTIMATE' });
  });
});
