import { describe, expect, it } from 'vitest';
import { defaultPricingEngine } from '../../src/core/pricing.js';

// L1: the Claude price rows match a whole model id (name, optional snapshot date, optional [1m] suffix), never a substring.
describe('Claude price rows are anchored to the model id', () => {
  const pricing = defaultPricingEngine();
  const idOf = (model: string): string | null => pricing.resolve(model)?.id ?? null;

  it('the exact ids and their dated snapshots still price under their own row', () => {
    expect(idOf('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(idOf('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(idOf('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(idOf('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(idOf('claude-sonnet-5-20260101[1m]')).toBe('claude-sonnet-5');
  });

  it('Sonnet 5.5 has its own LIST row (page fetched 2026-10-11): Sonnet 5 money columns except cache read, which is 0.05x input = $0.10, and it does not borrow Sonnet 5 pricing by substring', () => {
    expect(idOf('claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(idOf('claude-sonnet-5-5-20260601')).toBe('claude-sonnet-5-5');
    expect(idOf('claude-sonnet-5-5[1m]')).toBe('claude-sonnet-5-5');
    const row = pricing.resolve('claude-sonnet-5-5');
    expect(row).toMatchObject({ status: 'LIST', verifiedAt: '2026-10-11', rates: { in: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, out: 10 } });
    expect(pricing.resolve('claude-sonnet-5')?.rates.cacheRead).toBe(0.2);
    expect(pricing.resolve('claude-sonnet-5')?.id).toBe('claude-sonnet-5');
  });

  it('an unknown future id is unpriced: it does not match the Sonnet 5 or Sonnet 5.5 rows by substring', () => {
    expect(idOf('claude-sonnet-5-99')).toBeNull();
    expect(idOf('claude-sonnet-5.99')).toBeNull();
    expect(idOf('claude-sonnet-5-5-5')).toBeNull();
    expect(pricing.priceComponent({ model: 'claude-sonnet-5-99', tokens: { inputFresh: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 } }).usd).toBeNull();
  });

  it('a Claude id with a stray suffix that is not a snapshot date does not match', () => {
    expect(idOf('claude-opus-5-5-preview')).toBeNull();
    expect(idOf('my-claude-sonnet-5')).toBeNull();
  });
});
