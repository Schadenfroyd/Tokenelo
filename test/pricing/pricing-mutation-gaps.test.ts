/**
 * Regression tests for behaviour of src/core/pricing.ts that a mutation run showed to be unasserted.
 * Each group names the property it pins. All cases use the shipped rate table or synthetic rows.
 *
 * Two cases are titled "[pins current legacy policy]": they price a component that carries no route evidence on
 * a zero-rate local row ('qwen3-coder:30b'), which today is allowed. The integration owner's decision D4
 * (2026-10-17) is that new unrecorded routes should stay unpriced; change those two cases when that lands.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPricingEngine, defaultPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import type { PriceRow, UsageComponent } from '../../src/core/types.js';

const tokens = (o: Partial<UsageComponent['tokens']> = {}): UsageComponent['tokens'] =>
  ({ inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, ...o });
const rows = (): PriceRow[] => structuredClone(loadPriceRows());
const withRow = (id: string, edit: (r: any) => void): PriceRow[] => { const all = rows(); edit(all.find((r) => r.id === id)); return all; };

describe('derived cache-write columns', () => {
  const eng = defaultPricingEngine();
  const price = (t: Partial<UsageComponent['tokens']>) => eng.priceComponent({ model: 'gpt-5.6-terra', tokens: tokens(t) });
  it('label the price ESTIMATE when the 5m column is billed, even for a single token', () => {
    expect(price({ cacheWrite5m: 1 }).status).toBe('ESTIMATE');
  });
  it('label the price ESTIMATE when only the 1h column is billed, even for a single token', () => {
    expect(price({ cacheWrite1h: 1 }).status).toBe('ESTIMATE');
  });
  it('stay LIST when neither derived column is billed', () => {
    expect(price({ inputFresh: 1000, output: 1000 }).status).toBe('LIST');
  });
});

describe('unknown cache-write TTL', () => {
  const eng = defaultPricingEngine();
  it('a single token of unassigned-TTL cache creation makes a hosted component unpriced', () => {
    const r = eng.priceComponent({ model: 'claude-sonnet-5-5', tokens: tokens({ inputFresh: 1000, cacheWriteUnassigned: 1 }) });
    expect(r.usd).toBeNull();
    expect(r.status).toBe('UNPRICED');
  });
  it('the same token on a zero-rate local row still prices at zero (documented policy) [pins current legacy policy]', () => {
    const r = eng.priceComponent({ model: 'qwen3-coder:30b', tokens: tokens({ inputFresh: 1000, cacheWriteUnassigned: 1 }) });
    expect(r.usd).toBe(0);
  });
});

describe('speed tiers', () => {
  const eng = defaultPricingEngine();
  const t = tokens({ inputFresh: 1_000_000, output: 1_000_000 });
  it('Opus 4.6 "fast" is billed at standard rates (vendor-documented)', () => {
    expect(eng.priceComponent({ model: 'claude-opus-4-6', speed: 'fast', tokens: t }).usd).toBe(5 + 25);
  });
  it('Opus 4.7 has no fast mode, so "fast" is refused rather than priced', () => {
    const r = eng.priceComponent({ model: 'claude-opus-4-7', speed: 'fast', tokens: t });
    expect(r.usd).toBeNull();
    expect(r.flags).toContain('priceTierUnsupported');
  });
  it('an unknown speed is refused', () => {
    const r = eng.priceComponent({ model: 'claude-opus-5-5', speed: 'turbo' as never, tokens: t });
    expect(r.usd).toBeNull();
    expect(r.flags).toContain('priceTierUnsupported');
  });
  it('a zero-rate local row prices a fast request at zero instead of refusing it [pins current legacy policy]', () => {
    expect(eng.priceComponent({ model: 'qwen3-coder:30b', speed: 'fast', tokens: t }).usd).toBe(0);
  });
  it('Opus 5.5 fast uses the fast row', () => {
    expect(eng.priceComponent({ model: 'claude-opus-5-5', speed: 'fast', tokens: t }).usd).toBe(8 + 40);
  });
});

describe('captured rate rows', () => {
  it('later edits to the caller\'s rows do not change what the engine prices', () => {
    const input = rows();
    const eng = createPricingEngine(input);
    const c = { model: 'claude-sonnet-5-5', tokens: tokens({ inputFresh: 1_000_000 }) };
    const before = eng.priceComponent(c).usd;
    (input.find((r) => r.id === 'claude-sonnet-5-5') as PriceRow).rates.in = 999;
    expect(eng.priceComponent(c).usd).toBe(before);
  });
  it('resolved rows are deeply frozen, so a caller cannot alter rates under the engine\'s version hash', () => {
    const row = createPricingEngine(rows()).resolve('claude-sonnet-5-5') as PriceRow;
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.rates)).toBe(true);
    expect(() => { (row.rates as { in: number }).in = 0; }).toThrow(TypeError);
  });
  it('the version hash tracks the rows', () => {
    const a = createPricingEngine(rows()).version;
    expect(createPricingEngine(withRow('claude-sonnet-5-5', (r) => { r.rates.in += 0.5; })).version).not.toBe(a);
  });
});

describe('event-level route misalignment', () => {
  const eng = defaultPricingEngine();
  const component = { model: 'claude-sonnet-5-5', tokens: tokens({ inputFresh: 1000 }) };
  it('an event with no components and a misaligned route keeps the misalignment flag', () => {
    const r = eng.priceEvent({ components: [], flags: ['servingRouteMisaligned'] });
    expect(r.usd).toBeNull();
    expect(r.flags).toEqual(expect.arrayContaining(['unpricedModel', 'servingRouteMisaligned']));
  });
  it('an event with no components and no misalignment does not gain that flag', () => {
    expect(eng.priceEvent({ components: [], flags: [] }).flags).not.toContain('servingRouteMisaligned');
  });
  it('a priced event whose route is misaligned is refused and flagged', () => {
    const r = eng.priceEvent({ components: [component], flags: ['servingRouteMisaligned'] });
    expect(r.usd).toBeNull();
    expect(r.status).toBe('UNPRICED');
    expect(r.flags).toContain('servingRouteMisaligned');
  });
  it('the same event without the flag prices normally', () => {
    expect(eng.priceEvent({ components: [component], flags: [] }).usd).toBeCloseTo(0.002, 12);
  });
});

describe('price-row validation', () => {
  const bad = (rowsIn: unknown, message: RegExp) => expect(() => createPricingEngine(rowsIn as PriceRow[])).toThrow(message);
  it.each([[null], [[]], ['text'], [7]])('rejects a non-object row %j', (row) => bad([row], /Invalid price row 0: object/));
  it('rejects an empty or missing id', () => {
    bad(withRow('claude-sonnet-5-5', (r) => { r.id = ''; }), /: id/);
    bad(withRow('claude-sonnet-5-5', (r) => { delete r.id; }), /: id/);
  });
  it('rejects an empty, non-string or unparsable match', () => {
    bad(withRow('claude-sonnet-5-5', (r) => { r.match = ''; }), /: match/);
    bad(withRow('claude-sonnet-5-5', (r) => { r.match = 5; }), /: match/);
    bad(withRow('claude-sonnet-5-5', (r) => { r.match = '('; }), /match syntax/);
  });
  it('rejects an empty display name', () => {
    bad(withRow('claude-sonnet-5-5', (r) => { r.displayName = ''; }), /display name/);
  });
  it('rejects malformed long-context rates and thresholds, but accepts a zero threshold', () => {
    bad(withRow('claude-haiku-5-5', (r) => { delete r.longContext.out; }), /long-context rates/);
    bad(withRow('claude-haiku-5-5', (r) => { r.longContext.thresholdInput = -1; }), /context threshold/);
    bad(withRow('claude-haiku-5-5', (r) => { r.longContext.thresholdInput = 1.5; }), /context threshold/);
    expect(() => createPricingEngine(withRow('claude-haiku-5-5', (r) => { r.longContext.thresholdInput = 0; }))).not.toThrow();
  });
  it('rejects a geo multiplier below one, but accepts exactly one', () => {
    bad(withRow('claude-sonnet-5-5', (r) => { r.geoMultiplierUs = 0.9; }), /geo multiplier/);
    bad(withRow('claude-sonnet-5-5', (r) => { r.geoMultiplierUs = Number.NaN; }), /geo multiplier/);
    expect(() => createPricingEngine(withRow('claude-sonnet-5-5', (r) => { r.geoMultiplierUs = 1; }))).not.toThrow();
  });
  it('rejects malformed fast-tier fields', () => {
    bad(withRow('claude-opus-5-5', (r) => { r.fast.status = 'GUESS'; }), /fast status/);
    bad(withRow('gpt-5.6-terra', (r) => { r.fast.derivedColumns = ['cacheRead']; }), /fast derived columns/);
    bad(withRow('gpt-5.6-terra', (r) => { r.fast.longContext = { in: 1 }; }), /fast long-context rates/);
    bad(withRow('gpt-5.6-terra', (r) => { r.fast.longContext.derivedColumns = ['out']; }), /fast long derived columns/);
  });
  it('rejects negative, non-finite and non-numeric rates', () => {
    for (const bad_ of [-1, Number.POSITIVE_INFINITY, Number.NaN, '2'])
      bad(withRow('claude-sonnet-5-5', (r) => { r.rates.in = bad_; }), /: rates/);
  });
  it('loadPriceRows validates a file, not just an in-memory array', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-prices-')), 'prices.json');
    fs.writeFileSync(file, JSON.stringify({ rows: withRow('claude-sonnet-5-5', (r) => { r.displayName = ''; }) }));
    try { expect(() => loadPriceRows(file)).toThrow(/display name/); } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
  });
});

describe('request-size and speed edge cases', () => {
  const eng = defaultPricingEngine();
  const t = tokens({ inputFresh: 1000, output: 1000 });
  it('a recorded request size of zero is an invalid context, not an absent one', () => {
    const r = eng.priceComponent({ model: 'claude-sonnet-5-5', requestInput: 0, tokens: t });
    expect(r.usd).toBeNull();
    expect(r.flags).toContain('priceContextInvalid');
  });
  it('an empty-string speed is refused instead of defaulting to standard', () => {
    const r = eng.priceComponent({ model: 'claude-sonnet-5-5', speed: '' as never, tokens: t });
    expect(r.usd).toBeNull();
    expect(r.flags).toContain('priceTierUnsupported');
  });
  it('unassigned-TTL tokens count toward the prompt size, so a smaller recorded request size is invalid even on a local row', () => {
    const r = eng.priceComponent({ model: 'qwen3-coder:30b', requestInput: 100, tokens: tokens({ inputFresh: 60, cacheWriteUnassigned: 80 }) });
    expect(r.usd).toBeNull();
    expect(r.flags).toContain('priceContextInvalid');
  });
});

describe('what counts as a zero-rate local row', () => {
  const zero = { in: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: 0 };
  const synth = (edit: (r: any) => void): ReturnType<typeof defaultPricingEngine> => {
    const all = rows();
    const row: any = structuredClone(all.find((r) => r.id === 'local-qwen'));
    row.id = 'synthetic-free'; row.match = '^synthetic-free$'; row.rates = { ...zero }; edit(row);
    return createPricingEngine([...all, row]);
  };
  const unassigned = tokens({ inputFresh: 1000, cacheWriteUnassigned: 7 });
  it('a local row with all-zero rates prices unknown-TTL work at zero', () => {
    expect(synth(() => {}).priceComponent({ model: 'synthetic-free', tokens: unassigned }).usd).toBe(0);
  });
  it('a local row with a non-zero fast tier is not a zero-rate row: unknown-TTL work stays unpriced', () => {
    const eng = synth((r) => { r.fast = { ...zero, out: 1, status: 'ESTIMATE' }; });
    expect(eng.priceComponent({ model: 'synthetic-free', tokens: unassigned }).usd).toBeNull();
  });
  it('a local row whose long-context bracket is also all zero is still a zero-rate row', () => {
    const eng = synth((r) => { r.longContext = { ...zero, thresholdInput: 1_000_000 }; });
    expect(eng.priceComponent({ model: 'synthetic-free', tokens: unassigned }).usd).toBe(0);
  });
  it('a local row with a non-zero long-context bracket is not a zero-rate row', () => {
    const eng = synth((r) => { r.longContext = { ...zero, in: 1, thresholdInput: 1_000_000 }; });
    expect(eng.priceComponent({ model: 'synthetic-free', tokens: unassigned }).usd).toBeNull();
  });
  it('a hosted row with all-zero rates is never treated as a free local row', () => {
    const eng = synth((r) => { r.local = false; r.provider = 'openai'; });
    expect(eng.priceComponent({ model: 'synthetic-free', tokens: unassigned }).usd).toBeNull();
    expect(eng.priceComponent({ model: 'synthetic-free', speed: 'fast', tokens: tokens({ inputFresh: 1000 }) }).flags).toContain('priceTierUnsupported');
  });
});

describe('derived columns on a single column', () => {
  const synth = () => {
    const all = rows();
    const row: any = structuredClone(all.find((r) => r.id === 'claude-sonnet-5-5'));
    row.id = 'synthetic-derived'; row.match = '^synthetic-derived$'; row.derivedColumns = ['cacheWrite5m'];
    return createPricingEngine([...all, row]);
  };
  it('only the derived column\'s own tokens make the price an ESTIMATE', () => {
    const eng = synth();
    expect(eng.priceComponent({ model: 'synthetic-derived', tokens: tokens({ cacheWrite5m: 1 }) }).status).toBe('ESTIMATE');
    expect(eng.priceComponent({ model: 'synthetic-derived', tokens: tokens({ cacheWrite1h: 1 }) }).status).toBe('LIST');
    expect(eng.priceComponent({ model: 'synthetic-derived', tokens: tokens({ inputFresh: 1 }) }).status).toBe('LIST');
  });
});

describe('arithmetic overflow', () => {
  it('a component whose dollars overflow to infinity is refused, not priced', () => {
    const all = rows();
    const row: any = structuredClone(all.find((r) => r.id === 'claude-sonnet-5-5'));
    row.id = 'synthetic-huge'; row.match = '^synthetic-huge$'; row.rates = { ...row.rates, out: 1e308 };
    const eng = createPricingEngine([...all, row]);
    const r = eng.priceComponent({ model: 'synthetic-huge', tokens: tokens({ output: 1e10 }) });
    expect(r.usd).toBeNull();
    expect(r.flags).toContain('priceContextInvalid');
  });
});
