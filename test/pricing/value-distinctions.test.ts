/**
 * Value distinctions: which quantity is which (2026-10-18).
 *
 * Keeps three things apart, with hand-computed numbers from the FABRICATED price rows in
 * test/fixtures/price-history-2026-10-18/ (never rates/prices.json):
 *   - the Standard API-equivalent list value of a row,
 *   - the served/processing tier or residency that was reported for it (fast, ultrafast, long context, geo,
 *     a descriptive service tier), and
 *   - an invoice or plan cost, which the code never derives and which is absent unless a plan price is configured.
 * And it pins how count quality changes what can be priced, and how provisional labels are carried
 * (LIST / ESTIMATE / UNPRICED). All "synth-*" ids are invented; no result here is a vendor price, a
 * measurement or a bill.
 *
 * Old-world rate card used below ($ per million tokens; in / 5m write / 1h write / cache read / out):
 *   synth-hosted   standard 2 / 2.5 / 4 / 0.2 / 10       geo us x1.1
 *                  fast 4 / 5 / 8 / 0.4 / 20 (LIST)       ultrafast 6 / 7.5 / 12 / 0.6 / 30 (ESTIMATE)
 *   synth-derived  1 / 1.25 / 2 / 0.1 / 5, the 1h-write column is derived by convention -> billing it makes ESTIMATE
 *   synth-estimate-row  1 / 1.25 / 2 / 0.1 / 5, row status ESTIMATE
 *   synth-long     2 / 2.5 / 2.5 / 0.2 / 10, whole request at 4 / 5 / 5 / 0.4 / 15 above 100,000 input-side tokens
 *   synth-local-a  local weights row, every column 0
 */
import { describe, expect, it } from 'vitest';
import { eventsToCsv, EXPORT_COLUMNS } from '../../src/cli/csv.js';
import { computeSubscriptionLeverage } from '../../src/core/subscriptions.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { createPricingEngine } from '../../src/core/pricing.js';
import { priceQualityOf } from '../../src/core/price-quality.js';
import { hasUnresolvedCounts, hasUnresolvedUcuCounts } from '../../src/core/token-counts.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { captureComponentCounts, componentCountProjection } from '../../src/measurement/component-count-evidence.js';
import type { TokenCounts, UsageComponent } from '../../src/core/types.js';
import { buildWorld, synthEvent, tokens } from '../helpers/price-history-world.js';

const old = buildWorld('old');
const today = buildWorld('today');

/** The hosted row's reference workload: 100,000 in / 20,000 5m / 10,000 1h / 400,000 cache read / 50,000 out. */
const WORK: TokenCounts = tokens({ inputFresh: 100_000, cacheWrite5m: 20_000, cacheWrite1h: 10_000, cacheRead: 400_000, output: 50_000 });
const component = (model: string, t: Partial<TokenCounts>, extra: Partial<UsageComponent> = {}): UsageComponent => ({ model, tokens: tokens(t), ...extra });

describe('Standard API-equivalent value is a list-price quantity, distinct from the tier a request was served on', () => {
  it('Standard: 100,000*2 + 20,000*2.5 + 10,000*4 + 400,000*0.2 + 50,000*10 = 870,000 / 1e6 = $0.87, LIST', () => {
    const r = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'standard' }));
    expect(r.usd).toBeCloseTo(0.87, 12);
    expect(r).toMatchObject({ status: 'LIST', rowId: 'synth-hosted', flags: [] });
  });

  it('fast tier uses its own columns: 400,000 + 100,000 + 80,000 + 160,000 + 1,000,000 = 1,740,000 -> $1.74; it is not "Standard times something"', () => {
    const fast = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'fast' }));
    expect(fast.usd).toBeCloseTo(1.74, 12);
    expect(fast.status).toBe('LIST'); // the tier's own status
    // Moving only the fast row's output column moves the fast price and leaves Standard untouched.
    const rows = structuredClone(old.priceRows);
    rows[0].fast!.out = 25;
    const moved = createPricingEngine(rows);
    expect(moved.priceComponent(component('synth-hosted', WORK, { speed: 'fast' })).usd).toBeCloseTo(1.74 + 50_000 * 5 / 1e6, 12); // +$0.25
    expect(moved.priceComponent(component('synth-hosted', WORK, { speed: 'standard' })).usd).toBeCloseTo(0.87, 12);
  });

  it('ultrafast takes the tier\'s ESTIMATE status even though the base row is LIST: 600,000+150,000+120,000+240,000+1,500,000 = $2.61', () => {
    const r = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'ultrafast' }));
    expect(r.usd).toBeCloseTo(2.61, 12);
    expect(r.status).toBe('ESTIMATE');
  });

  it('US data residency multiplies every category by 1.1 and stacks with the tier: 0.87 -> 0.957, fast 1.74 -> 1.914, both still LIST', () => {
    const geo = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'standard' }), { inferenceGeo: 'us' });
    expect(geo.usd).toBeCloseTo(0.957, 12);
    const fastGeo = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'fast' }), { inferenceGeo: 'us' });
    expect(fastGeo.usd).toBeCloseTo(1.914, 12);
    // A different geography string is not residency and adds nothing.
    expect(old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'standard' }), { inferenceGeo: 'eu' }).usd).toBeCloseTo(0.87, 12);
  });

  it('a tier the row does not define is UNPRICED, never silently priced at Standard; batch and unknown speeds are refused too', () => {
    const noFast = old.pricing.priceComponent(component('synth-derived', { inputFresh: 1000, output: 1000 }, { speed: 'fast' }));
    expect(noFast).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['priceTierUnsupported'] });
    const batch = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'standard' }), { batch: true });
    expect(batch).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['priceTierUnsupported'] }); // never "half price"
    const turbo = old.pricing.priceComponent(component('synth-hosted', WORK, { speed: 'turbo' as never }));
    expect(turbo).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['priceTierUnsupported'] });
  });

  it('a local zero-rate row prices any claimed tier at a known $0 list rate; that is a rate fact, not a tier claim', () => {
    for (const speed of ['standard', 'fast', 'ultrafast'] as const) {
      expect(old.pricing.priceComponent(component('synth-local-a', { inputFresh: 3000, output: 1000 }, { speed }))).toMatchObject({ usd: 0, status: 'LIST' });
    }
  });

  it('long context prices the WHOLE request at the bracket, strictly above the threshold: 100,000 is Standard, 100,001 is the bracket', () => {
    // 90,000 in + 10,000 cache read + 1,000 out.
    //   standard: 90,000*2 + 10,000*0.2 + 1,000*10  = 180,000 + 2,000 + 10,000 = 192,000 / 1e6 = $0.192
    //   bracket : 90,000*4 + 10,000*0.4 + 1,000*15  = 360,000 + 4,000 + 15,000 = 379,000 / 1e6 = $0.379
    const t = { inputFresh: 90_000, cacheRead: 10_000, output: 1_000 };
    const at = old.pricing.priceComponent(component('synth-long', t)); // own input-side size = 100,000
    expect(at.usd).toBeCloseTo(0.192, 12);
    expect(at.flags).not.toContain('longContextBracket');
    const over = old.pricing.priceComponent(component('synth-long', t, { requestInput: 100_001 }));
    expect(over.usd).toBeCloseTo(0.379, 12);
    expect(over.flags).toContain('longContextBracket');
    // A request size smaller than the component's own input is incoherent: refused, not guessed.
    expect(old.pricing.priceComponent(component('synth-long', t, { requestInput: 99_999 }))).toMatchObject({ usd: null, flags: ['priceContextInvalid'] });
  });
});
describe('through the ledger: the served tier is kept as reported, the price stays the Standard list value, and no invoice exists', () => {
  function ingest(events: ReturnType<typeof synthEvent>[]) {
    const db = openDb({ file: ':memory:' });
    const ledger = new SqliteLedger(db, old.pricing, createNullEngine());
    ledger.upsertEvents(events);
    const rows = Object.fromEntries(ledger.getEvents({}).map(e => [e.id, e]));
    db.close();
    return rows;
  }
  const hosted = (id: string, o: Partial<Parameters<typeof synthEvent>[0]> = {}) => synthEvent({
    id, model: 'synth-hosted', provider: 'anthropic', source: 'claude', thinking: false, tokens: WORK, ...o });

  it('a descriptive serviceTier (standard, priority, batch) is retained verbatim and does not change the Standard value of identical tokens', () => {
    const rows = ingest([
      hosted('t:std', { serviceTier: 'standard', component: { speed: 'standard' } }),
      hosted('t:prio', { serviceTier: 'priority', component: { speed: 'standard' } }),
      hosted('t:batch', { serviceTier: 'batch', component: { speed: 'standard' } }),
    ]);
    for (const id of ['t:std', 't:prio', 't:batch']) {
      expect(rows[id].apiEquivUsd).toBeCloseTo(0.87, 12);
      expect(rows[id].priceStatus).toBe('LIST');
    }
    expect([rows['t:std'].serviceTier, rows['t:prio'].serviceTier, rows['t:batch'].serviceTier]).toEqual(['standard', 'priority', 'batch']);
    // The value is not an invoice: a batch-served row is still the full Standard list figure, not a discounted one.
  });

  it('the component speed, not the descriptive tier, selects the tier price: fast -> $1.74, ultrafast -> $2.61 ESTIMATE', () => {
    const rows = ingest([
      hosted('s:fast', { serviceTier: 'standard', component: { speed: 'fast' } }),
      hosted('s:ultra', { serviceTier: 'standard', component: { speed: 'ultrafast' } }),
    ]);
    expect(rows['s:fast'].apiEquivUsd).toBeCloseTo(1.74, 12);
    expect(rows['s:fast'].priceStatus).toBe('LIST');
    expect(rows['s:ultra'].apiEquivUsd).toBeCloseTo(2.61, 12);
    expect(rows['s:ultra'].priceStatus).toBe('ESTIMATE');
  });

  it('a Claude row with no reported speed is priced Standard and says so (speedAssumed); a reported speed carries no such flag', () => {
    const rows = ingest([hosted('a:none'), hosted('a:std', { component: { speed: 'standard' } })]);
    expect(rows['a:none'].apiEquivUsd).toBeCloseTo(0.87, 12);
    expect(rows['a:none'].flags).toContain('speedAssumed');
    expect(rows['a:std'].flags).not.toContain('speedAssumed');
  });

  it('no stored field is an invoice or billed amount, and the CSV export labels every row api-equivalent-not-billed', () => {
    const rows = ingest([hosted('e:batch', { serviceTier: 'batch', component: { speed: 'standard' } })]);
    const row = rows['e:batch'];
    expect(Object.keys(row).filter(k => /invoice|billed|paid|charge/i.test(k))).toEqual([]);
    expect(EXPORT_COLUMNS.filter(c => /invoice|billed|paid|charge/i.test(c))).toEqual([]);
    const [header, line] = eventsToCsv([row]).trimEnd().split('\n');
    const cols = header.split(',');
    const cells = splitCsvLine(line);
    expect(cells[cols.indexOf('costBasis')]).toBe('api-equivalent-not-billed');
    expect(cells[cols.indexOf('priceStatus')]).toBe('LIST');
    expect(Number(cells[cols.indexOf('apiEquivUsd')])).toBeCloseTo(0.87, 12);
    expect(cells[cols.indexOf('serviceTier')]).toBe('batch');
  });

  it('an unpriced row exports a BLANK dollar cell with status UNPRICED, never 0; an unrecorded count basis exports as unrecorded, never complete', () => {
    const rows = ingest([synthEvent({ id: 'u:1', model: 'synth-new-model', provider: 'anthropic', source: 'claude', thinking: false,
      tokens: { inputFresh: 1000, output: 1000 }, component: { speed: 'standard' } })]);
    const [header, line] = eventsToCsv([rows['u:1']]).trimEnd().split('\n');
    const cols = header.split(','); const cells = splitCsvLine(line);
    expect(cells[cols.indexOf('apiEquivUsd')]).toBe('');
    expect(cells[cols.indexOf('priceStatus')]).toBe('UNPRICED');
    expect(cells[cols.indexOf('countQuality')]).toBe('unrecorded');
    expect(cells[cols.indexOf('ucuCountQuality')]).toBe('unrecorded');
  });
});
function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

describe('plan cost is a separately configured input, never an invoice and never inferred from API-equivalent value', () => {
  const account = { id: 'synthetic-account', kind: 'claude' as const, hosts: ['H1'] };
  const DAY = 86_400_000;

  it('no plan price configured: billed and leverage are null (not 0), the state says why, and the dollar value passes through unchanged', () => {
    const row = computeSubscriptionLeverage(account, 12.5, 0, 15 * DAY);
    expect(row.billedUsd).toBeNull();
    expect(row.leverage).toBeNull();
    expect(row.costBasis).toMatchObject({ state: 'price-unconfigured', monthlyUsd: null, invoiceVerified: false, origin: 'configured-plan-price' });
    expect(row.apiEquivUsd).toBe(12.5);
  });

  it('a configured $200/month plan over 15 days is a $100 proration (200 * 15/30); leverage = 12.5 / 100 = 0.125; still not an invoice', () => {
    const row = computeSubscriptionLeverage({ ...account, monthlyUsd: 200 }, 12.5, 0, 15 * DAY);
    expect(row.billedUsd).toBeCloseTo(100, 12);
    expect(row.leverage).toBeCloseTo(0.125, 12);
    expect(row.costBasis).toMatchObject({ state: 'configured-proration', monthlyUsd: 200, prorationDays: 30, invoiceVerified: false });
    // Same API-equivalent value with a different plan price: the value does not depend on what the plan costs.
    expect(computeSubscriptionLeverage({ ...account, monthlyUsd: 20 }, 12.5, 0, 15 * DAY).apiEquivUsd).toBe(12.5);
  });

  it('an unknown range start never becomes epoch zero: the cost basis is unavailable, not a huge proration', () => {
    const row = computeSubscriptionLeverage({ ...account, monthlyUsd: 200 }, 12.5, null, 15 * DAY);
    expect(row.billedUsd).toBeNull();
    expect(row.leverage).toBeNull();
    expect(row.costBasis?.state).toBe('period-unavailable');
  });
});

describe('price status labels: LIST, ESTIMATE and UNPRICED are different claims', () => {
  it('a row-level ESTIMATE stays ESTIMATE: 1,000*1 + 1,000*5 = 6,000 / 1e6 = $0.006', () => {
    const r = old.pricing.priceComponent(component('synth-estimate-row', { inputFresh: 1000, output: 1000 }));
    expect(r.usd).toBeCloseTo(0.006, 12);
    expect(r.status).toBe('ESTIMATE');
  });

  it('a derived column makes ESTIMATE only when that column is billed: 5m writes stay LIST, 1h writes turn ESTIMATE', () => {
    // 5m: 1,000*1 + 1,000*1.25 + 1,000*5 = 7,250 / 1e6 = $0.00725 LIST.   1h: 1,000*1 + 1,000*2 + 1,000*5 = 8,000 / 1e6 = $0.008 ESTIMATE.
    const w5 = old.pricing.priceComponent(component('synth-derived', { inputFresh: 1000, cacheWrite5m: 1000, output: 1000 }));
    expect(w5.usd).toBeCloseTo(0.00725, 12); expect(w5.status).toBe('LIST');
    const w1 = old.pricing.priceComponent(component('synth-derived', { inputFresh: 1000, cacheWrite1h: 1000, output: 1000 }));
    expect(w1.usd).toBeCloseTo(0.008, 12); expect(w1.status).toBe('ESTIMATE');
  });

  it('an unknown model is UNPRICED with a null amount; one unpriced component withholds the whole event total', () => {
    const lone = old.pricing.priceComponent(component('synth-not-a-model', { inputFresh: 1000, output: 1000 }));
    expect(lone).toMatchObject({ usd: null, status: 'UNPRICED', rowId: null, flags: ['unpricedModel'] });
    const t = tokens({ inputFresh: 2000, output: 2000 });
    const mixed = old.pricing.priceEvent({ tokens: t, components: [component('synth-hosted', { inputFresh: 1000, output: 1000 }, { speed: 'standard' }), component('synth-not-a-model', { inputFresh: 1000, output: 1000 })] });
    expect(mixed.usd).toBeNull(); // the priced half ($0.012) is never exposed as a partial total
    expect(mixed.status).toBe('UNPRICED');
  });

  it('aggregation keeps the weakest label and counts: LIST+ESTIMATE -> ESTIMATE, +UNPRICED -> UNPRICED, no events -> no label (null, not LIST)', () => {
    const list = { apiEquivUsd: 1, priceStatus: 'LIST' }, est = { apiEquivUsd: 2, priceStatus: 'ESTIMATE' }, none = { apiEquivUsd: null, priceStatus: 'UNPRICED' };
    expect(priceQualityOf([list, list])).toMatchObject({ priceStatus: 'LIST', unpricedEvents: 0, estimatedPriceEvents: 0 });
    expect(priceQualityOf([list, est])).toMatchObject({ priceStatus: 'ESTIMATE', unpricedEvents: 0, estimatedPriceEvents: 1 });
    expect(priceQualityOf([list, est, none])).toMatchObject({ priceStatus: 'UNPRICED', unpricedEvents: 1, estimatedPriceEvents: 1 });
    expect(priceQualityOf([]).priceStatus).toBeNull();
  });
});

describe('count quality decides what can be priced (hosted row, old world)', () => {
  const raw = { input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 500 };
  const fromUsage = (usage: Record<string, unknown>, model = 'synth-hosted'): UsageComponent => {
    const countEvidence = captureComponentCounts(usage);
    return { model, tokens: componentCountProjection(countEvidence).tokens, countEvidence, speed: 'standard' };
  };

  it('reported TTL split: 1,000*2 + 200*2.5 + 100*4 + 4,000*0.2 + 500*10 = 8,700 / 1e6 = $0.0087 LIST; neither count basis is held', () => {
    const c = fromUsage({ ...raw, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 } });
    expect(c.tokens).toMatchObject({ countQuality: 'complete', cacheWrite5m: 200, cacheWrite1h: 100, cacheWriteUnassigned: 0, cacheWriteAssumed1h: 0 });
    const p = old.pricing.priceComponent(c);
    expect(p.usd).toBeCloseTo(0.0087, 12); expect(p.status).toBe('LIST');
    expect(hasUnresolvedCounts(c.tokens)).toBe(false); expect(hasUnresolvedUcuCounts(c.tokens)).toBe(false);
  });

  it('a REPORTED zero cache write is priced (2,000 + 800 + 5,000 = 7,800 -> $0.0078); a MISSING cache field is incomplete and unpriced, not zero', () => {
    const zero = fromUsage({ ...raw, cache_creation_input_tokens: 0 });
    expect(zero.tokens.countQuality).toBe('complete');
    expect(old.pricing.priceComponent(zero).usd).toBeCloseTo(0.0078, 12);
    const missing = fromUsage({ ...raw });
    expect(missing.tokens.countQuality).toBe('incomplete');
    expect(old.pricing.priceComponent(missing)).toMatchObject({ usd: null, status: 'UNPRICED' });
    expect(hasUnresolvedUcuCounts(missing.tokens)).toBe(true);
  });

  it('assumed 1h: a flat total with no TTL split is priced at the 1h column (300*4 = 1,200 -> $0.009) and recorded as an assumption, not as reported 1h work', () => {
    // 1,000*2 + 300*4 + 4,000*0.2 + 500*10 = 2,000 + 1,200 + 800 + 5,000 = 9,000 / 1e6
    const c = fromUsage({ ...raw, cache_creation_input_tokens: 300 });
    expect(c.tokens).toMatchObject({ cacheWrite5m: 0, cacheWrite1h: 300, cacheWriteAssumed1h: 300, cacheWriteUnassigned: 0, countQuality: 'complete' });
    expect(old.pricing.priceComponent(c).usd).toBeCloseTo(0.009, 12);
    // The assumption is the dearer column: had the 300 been 5m writes: 2,000 + 300*2.5 + 800 + 5,000 = 8,550 / 1e6 = 0.00855.
    expect(old.pricing.priceComponent({ ...c, countEvidence: undefined, tokens: { ...c.tokens, cacheWrite5m: 300, cacheWrite1h: 0, cacheWriteAssumed1h: 0 } }).usd).toBeCloseTo(0.00855, 12);
  });

  it('unassigned TTL: 50 of 300 cache-write tokens have no TTL, so the price is withheld (null) while the subset count basis is not held', () => {
    const c = fromUsage({ ...raw, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 50 } });
    expect(c.tokens).toMatchObject({ cacheWrite5m: 200, cacheWrite1h: 50, cacheWriteUnassigned: 50, countQuality: 'complete' });
    expect(old.pricing.priceComponent(c)).toMatchObject({ usd: null, status: 'UNPRICED' }); // no invented split
    expect(hasUnresolvedUcuCounts(c.tokens)).toBe(false);
  });

  it('incomplete (input_tokens missing): the price is unknown and both count bases are held, and the zero in the projection is not a reported zero', () => {
    const c = fromUsage({ cache_read_input_tokens: 4000, output_tokens: 500, cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 } });
    expect(c.tokens.countQuality).toBe('incomplete');
    expect(c.tokens.inputFresh).toBe(0);
    expect(old.pricing.priceComponent(c)).toMatchObject({ usd: null, status: 'UNPRICED' });
    expect(hasUnresolvedCounts(c.tokens)).toBe(true); expect(hasUnresolvedUcuCounts(c.tokens)).toBe(true);
  });

  it('conflict, invalid and incomplete counts are unpriced and held; unrecorded and absent (legacy) are priced with no completeness claim', () => {
    const base = tokens({ inputFresh: 1000, output: 500 }); // 1,000*2 + 500*10 = 7,000 / 1e6 = $0.007
    for (const q of ['conflict', 'invalid', 'incomplete'] as const) {
      const c = component('synth-hosted', { ...base, countQuality: q }, { speed: 'standard' });
      expect(old.pricing.priceComponent(c)).toMatchObject({ usd: null, status: 'UNPRICED' });
      expect(hasUnresolvedCounts(c.tokens)).toBe(true); expect(hasUnresolvedUcuCounts(c.tokens)).toBe(true);
    }
    for (const q of ['unrecorded', undefined] as const) {
      const c = component('synth-hosted', { ...base, ...(q ? { countQuality: q } : {}) }, { speed: 'standard' });
      expect(old.pricing.priceComponent(c).usd).toBeCloseTo(0.007, 12);
      expect(hasUnresolvedCounts(c.tokens)).toBe(false); expect(hasUnresolvedUcuCounts(c.tokens)).toBe(false);
    }
  });

  it('a subset-only count hold leaves the price known: the overall and subset count qualities are separate', () => {
    const c = component('synth-hosted', { inputFresh: 1000, output: 500, countQuality: 'complete', ucuCountQuality: 'incomplete' }, { speed: 'standard' });
    expect(old.pricing.priceComponent(c).usd).toBeCloseTo(0.007, 12);
    expect(hasUnresolvedCounts(c.tokens)).toBe(false); expect(hasUnresolvedUcuCounts(c.tokens)).toBe(true);
  });

  it('through the ledger the disclosures are stored as flags and survive a replay under today\'s table', () => {
    const db = openDb({ file: ':memory:' });
    const first = new SqliteLedger(db, old.pricing, createNullEngine());
    const claude = (id: string, usage: Record<string, unknown>) => {
      const c = fromUsage(usage);
      return synthEvent({ id, model: 'synth-hosted', provider: 'anthropic', source: 'claude', thinking: false, tokens: c.tokens, component: { countEvidence: c.countEvidence, speed: 'standard' } });
    };
    const events = [
      claude('q:reported', { ...raw, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 } }),
      claude('q:assumed', { ...raw, cache_creation_input_tokens: 300 }),
      claude('q:unassigned', { ...raw, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 50 } }),
      claude('q:incomplete', { ...raw }),
    ];
    first.upsertEvents(events);
    const read = (ledger: SqliteLedger) => Object.fromEntries(ledger.getEvents({}).map(e => [e.id, e]));
    const rows = read(first);
    expect(rows['q:reported'].apiEquivUsd).toBeCloseTo(0.0087, 12);
    expect(rows['q:reported'].flags).not.toContain('cacheSplitAssumed');
    expect(rows['q:assumed'].apiEquivUsd).toBeCloseTo(0.009, 12);
    expect(rows['q:assumed'].flags).toContain('cacheSplitAssumed');
    expect(rows['q:assumed'].tokens.cacheWriteAssumed1h).toBe(300);
    expect(rows['q:unassigned'].apiEquivUsd).toBeNull();
    expect(rows['q:unassigned'].flags).toContain('cacheTtlUnassigned');
    expect(rows['q:incomplete'].apiEquivUsd).toBeNull();
    expect(rows['q:incomplete'].reservedValue).toBeNull();
    expect(rows['q:incomplete'].ucuRateStatus).toBe('NONE');
    expect(rows['q:incomplete'].flags).toContain('countBasisIncomplete');
    // Today's table would price the first two at x1.5; a replay keeps what was recorded.
    const replay = new SqliteLedger(db, today.pricing, createNullEngine());
    expect(replay.upsertEvents(events)).toEqual({ inserted: 0, updated: 0, unchanged: 4 });
    expect(read(replay)['q:reported'].apiEquivUsd).toBeCloseTo(0.0087, 12);
    expect(read(replay)['q:unassigned'].apiEquivUsd).toBeNull();
    expect(read(replay)['q:incomplete'].reservedValue).toBeNull();
    db.close();
  });
});
