import { describe, expect, it } from 'vitest';
import { createPricingEngine, defaultPricingEngine } from '../../src/core/pricing.js';
import type { PriceRow, UsageComponent } from '../../src/core/types.js';

const engine = defaultPricingEngine();
const component = (extra: Partial<UsageComponent> = {}): UsageComponent => ({
  model: 'gpt-6.1-sol',
  tokens: { inputFresh: 200_000, cacheRead: 50_000, cacheWrite5m: 10_000,
    cacheWrite1h: 2_000, output: 9_000, reasoning: 1_000 },
  ...extra,
});

describe('verified processing tier and whole-request context pricing', () => {
  // All five billed categories. Standard short:
  // .4 fresh + .005 reads + .025 5m writes + .005 1h writes + .09 output = .525.
  // Standard long: .8 + .01 + .05 + .01 + .135 = 1.005.
  // Fast is2x each bracket; Ultrafast6x. Reasoning is a subset, not billed twice.
  it.each([
    ['standard', 272_000, .525, false], ['standard', 272_001, 1.005, true],
    ['fast', 272_000, 1.05, false], ['fast', 272_001, 2.01, true],
    ['ultrafast', 272_000, 3.15, false], ['ultrafast', 272_001, 6.03, true],
  ] as const)('%s requestInput=%s uses the explicit whole-request prices', (speed, requestInput, usd, long) => {
    const result = engine.priceComponent(component({ speed, requestInput }));
    expect(result.usd).toBeCloseTo(usd, 12);
    expect(result.status).toBe('LIST');
    expect(result.rowId).toBe('gpt-6.1-sol');
    expect(result.flags.includes('longContextBracket')).toBe(long);
  });

  it('includes cached input and creation in the fallback context size, excluding output', () => {
    const c = component();
    c.tokens.cacheRead = 73_001; // prompt200K+73,001+12K exceeds272K
    c.tokens.output = 900_000;
    const result = engine.priceComponent(c);
    // .8 + .0146002 reads + .05 + .01 +13.5 output =14.3746002
    expect(result.usd).toBeCloseTo(14.3746002, 12);
    expect(result.flags).toContain('longContextBracket');
    const short = component();short.tokens.output = 900_000;
    expect(engine.priceComponent(short).flags).not.toContain('longContextBracket');
  });

  it('preserves Standard API-equivalent basis for absent speed without claiming the served tier', () => {
    expect(engine.priceComponent(component()).usd).toBeCloseTo(.525, 12);
  });

  it.each(['xgpt-6.1-sol', 'gpt-6x1-sol', 'gpt-6.1-sol-preview', 'gpt-6.1-sol-2026-10-09-extra'])('does not borrow prices for %s', model => {
    expect(engine.resolve(model)).toBeNull();
  });

  it('matches only the exact model and the established dated-revision family', () => {
    expect(engine.resolve('gpt-6.1-sol-2026-10-09')?.id).toBe('gpt-6.1-sol');
    expect(engine.resolve('gpt-6-sol')?.id).toBe('gpt-6-sol');
  });

  it.each([NaN, Infinity, -1])('leaves invalid requestInput=%s unpriced', requestInput => {
    expect(engine.priceComponent(component({ requestInput }))).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['priceContextInvalid'] });
  });

  it('leaves unsupported runtime speed and explicit Batch unpriced', () => {
    expect(engine.priceComponent(component({ speed: 'turbo' as UsageComponent['speed'] })).flags).toEqual(['priceTierUnsupported']);
    expect(engine.priceComponent(component(), { batch: true }).usd).toBeNull();
  });

  // A tier that publishes no long-context columns (a row edited to drop them) is refused, never priced at the
  // cheaper Standard+long or Fast+short columns. gpt-6-sol itself now publishes its Fast long-context prices.
  const withoutFastLong = (): PriceRow => {
    const base = engine.resolve('gpt-6-sol')!;
    const { longContext: _drop, ...fastShort } = base.fast!;
    return { ...base, fast: fastShort };
  };

  it('refuses an unverified Fast+long combination instead of using Standard+long or Fast+short', () => {
    const result = createPricingEngine([withoutFastLong()]).priceComponent(component({ model: 'gpt-6-sol', speed: 'fast', requestInput: 272_001 }));
    expect(result).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['longContextBracket', 'priceTierUnsupported'] });
  });

  it('prices gpt-6-sol Fast+long at the published Fast long-context columns', () => {
    const result = engine.priceComponent(component({ model: 'gpt-6-sol', speed: 'fast', requestInput: 272_001 }));
    // 200,000 x 8 + 50,000 x .80 + 10,000 x 10 + 2,000 x 10 + 9,000 x 30 = 1.6 + .04 + .1 + .02 + .27 per million-scaled
    expect(result.usd).toBeCloseTo((200_000 * 8 + 50_000 * 0.8 + 10_000 * 10 + 2_000 * 10 + 9_000 * 30) / 1e6, 12);
    expect(result.status).toBe('ESTIMATE');
    expect(result.flags).toEqual(['longContextBracket']);
  });

  it('preserves derived-column qualification on the selected long tier', () => {
    const base = engine.resolve('gpt-6.1-sol')!;
    const custom: PriceRow = { ...base, fast: { ...base.fast!, longContext: { ...base.fast!.longContext!, derivedColumns: ['cacheWrite1h'] } } };
    const result = createPricingEngine([custom]).priceComponent(component({ speed: 'fast', requestInput: 272_001 }));
    expect(result.usd).toBeCloseTo(2.01, 12);
    expect(result.status).toBe('ESTIMATE');
  });

  it('never reports a partial event total when one tier/context combination is unpriced', () => {
    const result = createPricingEngine([engine.resolve('gpt-6.1-sol')!, withoutFastLong()]).priceEvent({ components: [component(), component({ model: 'gpt-6-sol', speed: 'fast', requestInput: 272_001 })] });
    expect(result.usd).toBeNull();expect(result.status).toBe('UNPRICED');
  });
});
