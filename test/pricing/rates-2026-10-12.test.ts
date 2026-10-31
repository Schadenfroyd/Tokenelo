import { describe, expect, it } from 'vitest';
import { createPricingEngine, defaultPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import type { PriceRow, RateColumns, UsageComponent } from '../../src/core/types.js';

// Rate fixes ported onto the alpha pricing structure (2026-10-12). Every number below is read from
// the vendor pages: platform.claude.com/docs/en/about-claude/pricing and developers.openai.com/api/docs/pricing
// (Fast / Ultrafast tables and the page script's long-context maps), fetched 2026-10-11.

const engine = defaultPricingEngine();
const KEYS = ['in', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'out'] as const;
const tok = (extra: Partial<UsageComponent['tokens']> = {}): UsageComponent['tokens'] =>
  ({ inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, ...extra });
const comp = (model: string, tokens: Partial<UsageComponent['tokens']>, extra: Partial<UsageComponent> = {}): UsageComponent =>
  ({ model, tokens: tok(tokens), ...extra });
// 1,000 tokens in every billed category: usd = 1000 * (in + w5m + w1h + cacheRead + out) / 1e6.
const MIX = { inputFresh: 1000, cacheWrite5m: 1000, cacheWrite1h: 1000, cacheRead: 1000, output: 1000 };
const mixUsd = (c: RateColumns): number => (1000 * (c.in + c.cacheWrite5m + c.cacheWrite1h + c.cacheRead + c.out)) / 1e6;
const cols = (inn: number, w: number, r: number, out: number): RateColumns =>
  ({ in: inn, cacheWrite5m: w, cacheWrite1h: w, cacheRead: r, out });

describe('Claude Sonnet 5.5 cache read (page footnote: Opus 5.5 and Sonnet 5.5 cache reads are 0.05x base input)', () => {
  it('1,000,000 cache-read tokens cost $0.10, half of Sonnet 5', () => {
    expect(engine.priceComponent(comp('claude-sonnet-5-5', { cacheRead: 1_000_000 })).usd).toBeCloseTo(0.1, 12);
    expect(engine.priceComponent(comp('claude-sonnet-5', { cacheRead: 1_000_000 })).usd).toBeCloseTo(0.2, 12);
  });
  it('full column mix: 2 + 2.5 + 4 + 0.10 + 10 per million = 18.6', () => {
    const r = engine.priceComponent(comp('claude-sonnet-5-5', { inputFresh: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 }));
    expect(r.usd).toBeCloseTo(18.6, 9);
    expect(r.status).toBe('LIST');
  });
  it('Opus 5.5 cache read stays 0.20 (0.05x of its $4 input)', () => {
    expect(engine.priceComponent(comp('claude-opus-5-5', { cacheRead: 1_000_000 })).usd).toBeCloseTo(0.2, 12);
  });
});

describe('Claude Haiku 5.5 prompt-length tiers (prompt = input + cache reads + cache writes)', () => {
  const short = cols(0.10, 0, 0.01, 0.50); short.cacheWrite5m = 0.125; short.cacheWrite1h = 0.20;
  const long = cols(0.50, 0, 0.05, 2.50); long.cacheWrite5m = 0.625; long.cacheWrite1h = 1.00;
  const price = (t: Partial<UsageComponent['tokens']>, ctx?: { inferenceGeo?: string }) =>
    engine.priceComponent(comp('claude-haiku-5-5', t), ctx);

  it('resolves under its own row, anchored like every Claude row', () => {
    expect(engine.resolve('claude-haiku-5-5')?.id).toBe('claude-haiku-5-5');
    expect(engine.resolve('claude-haiku-5-5-20261001')?.id).toBe('claude-haiku-5-5');
    expect(engine.resolve('claude-haiku-5-5[1m]')?.id).toBe('claude-haiku-5-5');
    expect(engine.resolve('claude-haiku-5-5-preview')).toBeNull();
    expect(engine.resolve('claude-haiku-5-55')).toBeNull();
    expect(engine.resolve('claude-haiku-4-5')?.id).toBe('claude-haiku-4-5');
  });

  it('at exactly 100,000 prompt tokens the short tier applies; at 100,001 the whole request reprices', () => {
    const at = price({ inputFresh: 100_000, output: 1000 });
    expect(at.usd).toBeCloseTo((100_000 * 0.10 + 1000 * 0.50) / 1e6, 12);
    expect(at.flags).not.toContain('longContextBracket');
    const over = price({ inputFresh: 100_001, output: 1000 });
    expect(over.usd).toBeCloseTo((100_001 * 0.50 + 1000 * 2.50) / 1e6, 12);
    expect(over.flags).toContain('longContextBracket');
    expect(over.status).toBe('LIST');
  });

  it('99,999 stays short', () => {
    expect(price({ inputFresh: 99_999 }).usd).toBeCloseTo((99_999 * 0.10) / 1e6, 12);
  });

  it('counts cache reads and cache writes in the prompt, not output', () => {
    // 60,000 fresh + 30,000 read + 10,001 5m-write = 100,001 prompt
    const t = { inputFresh: 60_000, cacheRead: 30_000, cacheWrite5m: 10_001, output: 500_000 };
    expect(price(t).usd).toBeCloseTo((60_000 * 0.50 + 30_000 * 0.05 + 10_001 * 0.625 + 500_000 * 2.50) / 1e6, 12);
    // same prompt split across the 1h write column
    const t1h = { inputFresh: 60_000, cacheRead: 30_000, cacheWrite1h: 10_001 };
    expect(price(t1h).usd).toBeCloseTo((60_000 * 0.50 + 30_000 * 0.05 + 10_001 * 1.00) / 1e6, 12);
    // 100,000 prompt with huge output is still the short tier
    expect(price({ inputFresh: 40_000, cacheRead: 60_000, output: 900_000 }).flags).not.toContain('longContextBracket');
  });

  it('a request over the threshold pays long prices even when most of its prompt is a cache hit', () => {
    expect(price({ inputFresh: 1, cacheRead: 100_000 }).usd).toBeCloseTo((1 * 0.50 + 100_000 * 0.05) / 1e6, 12);
  });

  it('prices each column from the page tables', () => {
    expect(price(MIX).usd).toBeCloseTo(mixUsd(short), 12);
    const big = { inputFresh: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 };
    expect(price(big).usd).toBeCloseTo((long.in + long.cacheWrite5m + long.cacheWrite1h + long.cacheRead + long.out), 9);
  });

  it('US data residency 1.1x applies on both tiers (page: also on the over-100,000 prices)', () => {
    expect(price({ inputFresh: 100_000 }, { inferenceGeo: 'us' }).usd).toBeCloseTo((100_000 * 0.10 * 1.1) / 1e6, 12);
    expect(price({ inputFresh: 100_001 }, { inferenceGeo: 'us' }).usd).toBeCloseTo((100_001 * 0.50 * 1.1) / 1e6, 12);
  });

  it('has no fast tier, so a fast request is refused rather than priced at Standard', () => {
    expect(engine.priceComponent(comp('claude-haiku-5-5', { inputFresh: 10 }, { speed: 'fast' }))).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['priceTierUnsupported'] });
  });
});

describe('fast and ultrafast long-context columns (over 272K the WHOLE request uses the tier\'s own long-context prices)', () => {
  // [model, speed, short columns, long columns, expected status]; long = page long-context maps.
  const cases: Array<[string, 'fast' | 'ultrafast', RateColumns, RateColumns, 'LIST' | 'ESTIMATE']> = [
    ['gpt-6-sol', 'fast', cols(4, 5, 0.4, 20), cols(8, 10, 0.8, 30), 'ESTIMATE'],
    ['gpt-6-luna', 'fast', cols(0.2, 0.25, 0.02, 1.0), cols(0.4, 0.5, 0.04, 1.5), 'ESTIMATE'],
    ['gpt-6-astra', 'fast', cols(20, 25, 2, 100), cols(40, 50, 4, 150), 'LIST'],
    ['gpt-6-astra', 'ultrafast', cols(60, 75, 6, 300), cols(120, 150, 12, 450), 'LIST'],
    ['gpt-6.1-sol', 'fast', cols(4, 5, 0.2, 20), cols(8, 10, 0.4, 30), 'LIST'],
    ['gpt-6.1-sol', 'ultrafast', cols(12, 15, 0.6, 60), cols(24, 30, 1.2, 90), 'LIST'],
    ['gpt-5.6-sol', 'fast', cols(8, 10, 0.8, 40), cols(16, 20, 1.6, 60), 'ESTIMATE'],
    ['gpt-5.6-terra', 'fast', cols(4, 5, 0.4, 24), cols(8, 10, 0.8, 36), 'ESTIMATE'],
    ['gpt-5.6-luna', 'fast', cols(0.4, 0.5, 0.04, 2.4), cols(0.8, 1, 0.08, 3.6), 'ESTIMATE'],
  ];
  it.each(cases)('%s %s: short at 272,000, tier long-context columns at 272,001', (model, speed, shortCols, longCols, status) => {
    const atEdge = engine.priceComponent(comp(model, MIX, { speed, requestInput: 272_000 }));
    expect(atEdge.usd).toBeCloseTo(mixUsd(shortCols), 12);
    expect(atEdge.flags).not.toContain('longContextBracket');
    const over = engine.priceComponent(comp(model, MIX, { speed, requestInput: 272_001 }));
    expect(over.usd).toBeCloseTo(mixUsd(longCols), 12);
    expect(over.flags).toContain('longContextBracket');
    // Status: LIST rows stay LIST; a tier whose cache-write column is derived or whose row is ESTIMATE stays ESTIMATE.
    if (status === 'ESTIMATE') expect(over.status).toBe('ESTIMATE'); else expect(over.status).toBe('LIST');
  });

});

describe('table invariants read from rates/prices.json', () => {
  const rows = loadPriceRows();
  const withLong = rows.filter(r => r.longContext);
  it('every row with a long-context bracket publishes long-context columns for each speed tier it has', () => {
    for (const r of withLong) for (const t of ['fast', 'ultrafast'] as const) {
      if (r[t]) expect(r[t]!.longContext, `${r.id} ${t}`).toBeDefined();
    }
  });
  it('a tier\'s long-context column is never below Standard long-context, and the tier is never below Standard short', () => {
    for (const r of withLong) {
      const std = r.longContext!;
      for (const t of ['fast', 'ultrafast'] as const) {
        const tier = r[t]; if (!tier?.longContext) continue;
        for (const k of KEYS) {
          expect(tier.longContext[k], `${r.id} ${t}.longContext.${k} >= standard long`).toBeGreaterThanOrEqual(std[k]);
          expect(tier[k], `${r.id} ${t}.${k} >= standard short`).toBeGreaterThanOrEqual(r.rates[k]);
        }
      }
      if (r.fast?.longContext && r.ultrafast?.longContext) for (const k of KEYS)
        expect(r.ultrafast.longContext[k], `${r.id} ultrafast >= fast long ${k}`).toBeGreaterThanOrEqual(r.fast.longContext[k]);
    }
  });
  it('gpt-6-astra fast and ultrafast are LIST (every number is on the vendor Fast and Ultrafast tables)', () => {
    const astra = rows.find(r => r.id === 'gpt-6-astra')!;
    expect(astra.fast?.status).toBe('LIST');
    expect(astra.ultrafast?.status).toBe('LIST');
    expect(astra.ultrafast).toMatchObject({ in: 60, cacheWrite5m: 75, cacheWrite1h: 75, cacheRead: 6, out: 300 });
  });
});

describe('a speed tier the row does not publish is never silently priced at Standard (alpha policy: UNPRICED, flagged)', () => {
  it('Claude Opus 4.6 fast is the documented exception: billed at Standard, LIST', () => {
    const r = engine.priceComponent(comp('claude-opus-4-6', { inputFresh: 1e6 }, { speed: 'fast' }));
    expect(r.usd).toBeCloseTo(5, 12);
    expect(r.status).toBe('LIST');
  });
  it.each([
    ['claude-sonnet-5', 'fast'], ['claude-opus-4-6', 'ultrafast'], ['claude-opus-4-7', 'fast'], ['gpt-6-luna', 'ultrafast'], ['gpt-5.6-sol', 'ultrafast'],
  ] as const)('%s %s is UNPRICED with priceTierUnsupported', (model, speed) => {
    expect(engine.priceComponent(comp(model, { inputFresh: 10 }, { speed }))).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['priceTierUnsupported'] });
  });
  it('a tier that publishes no long-context columns is refused above the threshold, never priced at the cheaper Standard long-context columns', () => {
    const base = engine.resolve('gpt-6-astra')!;
    const { longContext: _drop, ...fastShort } = base.fast!;
    const custom: PriceRow = { ...base, fast: fastShort };
    const r = createPricingEngine([custom]).priceComponent(comp('gpt-6-astra', MIX, { speed: 'fast', requestInput: 272_001 }));
    expect(r).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['longContextBracket', 'priceTierUnsupported'] });
  });
});
