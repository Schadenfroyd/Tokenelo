/**
 * Unit tests for src/core/pricing.ts against rates/prices.json (the real, shipped table — not a
 * stub), per DESIGN.md §5/§15.4. Every expected $ figure below is hand-computed in the comment
 * next to it from the row's own rates in rates/prices.json, so a wrong number in the data file or
 * a wrong formula in pricing.ts both show up as a failing assertion here, not just a golden diff.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  createPricingEngine,
  defaultPricingEngine,
  loadPriceRows,
  loadUnpricedNotes,
  priceRowsVersion,
} from '../../src/core/pricing.js';
import type { PriceRow, UsageComponent, UsageEvent } from '../../src/core/types.js';

const engine = defaultPricingEngine();

function component(model: string, tokens: Partial<UsageComponent['tokens']>, extra?: Partial<UsageComponent>): UsageComponent {
  return {
    model,
    tokens: {
      inputFresh: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
      reasoning: 0,
      ...tokens,
    },
    ...extra,
  };
}

describe('resolve() / providerOf() / first-match ordering', () => {
  it('retains weights classification without applying a local zero price to hosted/unknown serving', () => {
    const model = 'qwen3-coder-plus';
    expect(engine.resolve(model)?.eacsClass).toBe('ELO_LMA');
    const hosted = { kind: 'hosted', evidence: 'qwen-oauth' } as const;
    const unknown = { kind: 'unknown', evidence: 'qwen-openai-compatible' } as const;
    for (const servingRoute of [hosted, unknown]) {
      const c = component(model, { inputFresh: 100, output: 10 }, { servingRoute });
      expect(engine.providerOf(model, servingRoute)).toBe('unknown');
      expect(engine.priceComponent(c)).toMatchObject({ usd: null, status: 'UNPRICED', flags: ['servingRouteUnpriced'] });
      expect(engine.priceEvent({ components: [component('gpt-6-sol', { inputFresh: 100 }), c] }).usd).toBeNull();
    }
    // A recorded metered local route may use the table's local zero rate. This fixture is
    // policy verification, not evidence that an installed engine was metered or authenticated.
    const servingRoute = { kind: 'local', evidence: 'metered-engine' } as const;
    expect(engine.priceComponent(component(model, { inputFresh: 100, output: 10 }, { servingRoute })).usd).toBe(0);
    expect(engine.providerOf(model, servingRoute)).toBe('local');
    // Existing historical components are not silently rewritten by this forward-only repair.
    expect(engine.priceComponent(component(model, { inputFresh: 100 })).usd).toBe(0);
  });
  it('resolves each Claude 5-family id to its own row, not a more general one that is also a substring match', () => {
    // claude-fable-5-1 contains the substring "fable-5", so the 5-1 row MUST be checked first.
    expect(engine.resolve('claude-fable-5-1')?.id).toBe('claude-fable-5-1');
    expect(engine.resolve('claude-fable-5')?.id).toBe('claude-fable-5');
    expect(engine.resolve('claude-mythos-5-1')?.id).toBe('claude-mythos-5-1');
    expect(engine.resolve('claude-mythos-5')?.id).toBe('claude-mythos-5');
    // claude-opus-5-5 contains the substring "opus-5", so the 5-5 row MUST be checked first.
    expect(engine.resolve('claude-opus-5-5')?.id).toBe('claude-opus-5-5');
    expect(engine.resolve('claude-opus-5')?.id).toBe('claude-opus-5');
    expect(engine.resolve('claude-sonnet-5')?.id).toBe('claude-sonnet-5');
    expect(engine.resolve('claude-haiku-4-5')?.id).toBe('claude-haiku-4-5');
  });

  it('matches a dated model id as a substring (real Claude Code ids carry a date suffix)', () => {
    expect(engine.resolve('claude-haiku-4-5-20251001')?.id).toBe('claude-haiku-4-5');
    expect(engine.resolve('claude-sonnet-4-5-20250929')?.id).toBe('claude-sonnet-4-5');
  });

  it('resolves the older Claude rows seen in real logs / golden fixtures (LIST as of 2026-09-26 — flipped from ESTIMATE after direct platform.claude.com re-verification; task: SOURCE MISSING PRICES)', () => {
    for (const id of [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
    ]) {
      expect(engine.resolve(id)?.id, id).toBe(id);
      expect(engine.resolve(id)?.status, id).toBe('LIST');
    }
  });

  it('resolves GPT-6 ids anchored at the start (never a false match on an unrelated id containing "sol")', () => {
    expect(engine.resolve('gpt-6-astra')?.id).toBe('gpt-6-astra');
    expect(engine.resolve('gpt-6-sol')?.id).toBe('gpt-6-sol');
    expect(engine.resolve('gpt-6-luna')?.id).toBe('gpt-6-luna');
    expect(engine.resolve('gpt-6-sol-2026-09-01')?.id).toBe('gpt-6-sol');
    expect(engine.resolve('not-a-console')).toBeNull(); // "sol" substring, but no gpt-6- prefix
  });

  it('resolves GPT-5.6 ids distinctly from GPT-6 ids (a naive "sol"/"terra"/"luna" substring match would confuse the two families)', () => {
    expect(engine.resolve('gpt-5.6-sol')?.id).toBe('gpt-5.6-sol');
    expect(engine.resolve('gpt-5.6-terra')?.id).toBe('gpt-5.6-terra');
    expect(engine.resolve('gpt-5.6-luna')?.id).toBe('gpt-5.6-luna');
    // dash-normalized id form (a collector might not preserve the dot)
    expect(engine.resolve('gpt-5-6-sol')?.id).toBe('gpt-5.6-sol');
    // dated-suffix id form, like the gpt-6-* rows
    expect(engine.resolve('gpt-5.6-terra-2026-07-30')?.id).toBe('gpt-5.6-terra');
    // gpt-6-sol must NOT resolve to the gpt-5.6-sol row (and vice versa) despite sharing "sol"
    expect(engine.resolve('gpt-6-sol')?.id).toBe('gpt-6-sol');
    expect(engine.resolve('gpt-5.6-sol')?.id).not.toBe('gpt-6-sol');
  });

  it('resolves local model ids by weights provenance (DESIGN §15.5: Gemma -> ELO_GEM, other local -> ELO_LMA)', () => {
    const gemma = engine.resolve('gemma4:26b');
    expect(gemma?.eacsClass).toBe('ELO_GEM');
    expect(gemma?.provider).toBe('local');
    expect(gemma?.local).toBe(true);

    const qwenHf = engine.resolve('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL');
    expect(qwenHf?.eacsClass).toBe('ELO_LMA');
    const qwenGguf = engine.resolve('Qwen3.8-27B-UD-Q4_K_M.gguf');
    expect(qwenGguf?.eacsClass).toBe('ELO_LMA');
    const llama = engine.resolve('llama-3.3-70b-instruct');
    expect(llama?.eacsClass).toBe('ELO_LMA');
    const otherGguf = engine.resolve('some-other-model.gguf');
    expect(otherGguf?.eacsClass).toBe('ELO_LMA');
    expect(otherGguf?.id).toBe('local-gguf');
  });

  it('providerOf falls back to "unknown" (never a silent default tier) for an unmatched model', () => {
    expect(engine.providerOf('claude-sonnet-5')).toBe('anthropic');
    expect(engine.providerOf('gpt-6-sol')).toBe('openai');
    expect(engine.providerOf('gemma4:26b')).toBe('local');
    expect(engine.providerOf('totally-unknown-model-id')).toBe('unknown');
  });
});

describe('priceComponent — hand-computed per family (GATE per task spec)', () => {
  it('Claude Fable 5.1: cache read is $0.25/M, NOT the 0.1x-of-input default (1,000,000 in + 1,000,000 cache-read)', () => {
    // usd = (1_000_000*10 + 1_000_000*0.25) / 1e6 = 10 + 0.25 = 10.25
    const r = engine.priceComponent(component('claude-fable-5-1', { inputFresh: 1_000_000, cacheRead: 1_000_000 }));
    expect(r.status).toBe('LIST');
    expect(r.rowId).toBe('claude-fable-5-1');
    expect(r.usd).toBeCloseTo(10.25, 9);
  });

  it('Claude Fable 5 (no .1): cache read is the standard $1.00/M, distinct from Fable 5.1', () => {
    // usd = (1_000_000*10 + 1_000_000*1.00) / 1e6 = 10 + 1 = 11
    const r = engine.priceComponent(component('claude-fable-5', { inputFresh: 1_000_000, cacheRead: 1_000_000 }));
    expect(r.usd).toBeCloseTo(11, 9);
  });

  it('Claude Opus 5.5: cache read is $0.20/M (1,000,000 in + 1,000,000 cache-read)', () => {
    // usd = (1_000_000*4 + 1_000_000*0.20) / 1e6 = 4 + 0.20 = 4.20
    const r = engine.priceComponent(component('claude-opus-5-5', { inputFresh: 1_000_000, cacheRead: 1_000_000 }));
    expect(r.status).toBe('LIST');
    expect(r.usd).toBeCloseTo(4.2, 9);
  });

  it('Claude Sonnet 5: full column mix (in/w5m/w1h/cacheRead/out, each 1,000,000 tokens)', () => {
    // usd = (1e6*2 + 1e6*2.5 + 1e6*4 + 1e6*0.20 + 1e6*10) / 1e6 = 2+2.5+4+0.2+10 = 18.7
    const r = engine.priceComponent(
      component('claude-sonnet-5', {
        inputFresh: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
    );
    expect(r.usd).toBeCloseTo(18.7, 9);
  });

  it('Claude Haiku 4.5: full column mix (each 1,000,000 tokens)', () => {
    // usd = 1 + 1.25 + 2 + 0.10 + 5 = 9.35
    const r = engine.priceComponent(
      component('claude-haiku-4-5', {
        inputFresh: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        cacheRead: 1_000_000,
        output: 1_000_000,
      }),
    );
    expect(r.usd).toBeCloseTo(9.35, 9);
  });

  it('GPT-6 Sol: long-context bracket applies to the WHOLE request once requestInput > 272,000', () => {
    // Below the threshold: base rates in=2/out=10. usd = (200_000*2 + 100_000*10)/1e6 = 0.4+1.0 = 1.4
    const below = engine.priceComponent(
      component('gpt-6-sol', { inputFresh: 200_000, output: 100_000 }, { requestInput: 200_000 }),
    );
    expect(below.usd).toBeCloseTo(1.4, 9);
    expect(below.flags).not.toContain('longContextBracket');

    // Above the threshold: long-context rates in=4/out=15 apply to the WHOLE request.
    // usd = (300_000*4 + 100_000*15)/1e6 = 1.2 + 1.5 = 2.7
    const above = engine.priceComponent(
      component('gpt-6-sol', { inputFresh: 300_000, output: 100_000 }, { requestInput: 300_000 }),
    );
    expect(above.usd).toBeCloseTo(2.7, 9);
    expect(above.flags).toContain('longContextBracket');
  });

  it('GPT-6 Astra / Luna long-context brackets (threshold 272,000, exact vendor figures)', () => {
    // Astra long-context: in=20, out=75. requestInput 500_000 > 272_000.
    // usd = (500_000*20 + 0*75)/1e6 = 10
    const astra = engine.priceComponent(
      component('gpt-6-astra', { inputFresh: 500_000 }, { requestInput: 500_000 }),
    );
    expect(astra.usd).toBeCloseTo(10, 9);
    expect(astra.flags).toContain('longContextBracket');

    // Luna long-context: cacheRead=0.02, out=0.75. requestInput 280_000 (just above threshold).
    // usd = (0*0.20 + 280_000*0.02 + 100_000*0.75)/1e6 = (5600+75000)/1e6 = 0.0806
    const luna = engine.priceComponent(
      component('gpt-6-luna', { cacheRead: 280_000, output: 100_000 }, { requestInput: 280_000 }),
    );
    expect(luna.usd).toBeCloseTo(0.0806, 9);
  });

  it('an unmatched model id is UNPRICED (null $, never a silent default tier)', () => {
    const r = engine.priceComponent(component('totally-unknown-model-id', { inputFresh: 1000, output: 1000 }));
    expect(r.usd).toBeNull();
    expect(r.status).toBe('UNPRICED');
    expect(r.rowId).toBeNull();
    expect(r.flags).toEqual(['unpricedModel']);
  });

  it('gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna are now LIST-priced (sourced from developers.openai.com this session — task: SOURCE MISSING PRICES)', () => {
    for (const m of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const r = engine.priceComponent(component(m, { inputFresh: 1000, output: 1000 }));
      expect(r.usd, m).not.toBeNull();
      expect(r.status, m).toBe('LIST');
    }
  });

  it('codex-auto-review / gpt-reserve / gpt-5.3-codex-spark are UNPRICED (no official vendor price exists — documented in prices.json._unpriced, never invented)', () => {
    for (const m of ['codex-auto-review', 'gpt-reserve', 'gpt-5.3-codex-spark']) {
      const r = engine.priceComponent(component(m, { inputFresh: 1000, output: 1000 }));
      expect(r.usd, m).toBeNull();
      expect(r.status, m).toBe('UNPRICED');
      expect(r.rowId, m).toBeNull();
    }
  });

  it('fast mode selects the fast columns (Opus 5.5: standard $4/$20 vs fast $8/$40) and is now LIST (confirmed directly on platform.claude.com this session)', () => {
    const standard = engine.priceComponent(
      component('claude-opus-5-5', { inputFresh: 1_000_000, output: 1_000_000 }),
    );
    expect(standard.usd).toBeCloseTo(4 + 20, 9);
    expect(standard.status).toBe('LIST');

    const fast = engine.priceComponent(
      component('claude-opus-5-5', { inputFresh: 1_000_000, output: 1_000_000 }, { speed: 'fast' }),
    );
    expect(fast.usd).toBeCloseTo(8 + 40, 9);
    expect(fast.status).toBe('LIST');
  });

  describe('GPT-5.6 family — hand-computed (task: SOURCE MISSING PRICES, sourced 2026-09-26)', () => {
    it('GPT-5.6 Sol: standard $4/$20, full column mix (each 10,000 tokens, with a consistent 100,000-token prompt)', () => {
      // Each billed column is 10,000 tokens; all input-side columns total 40,000.
      // The reported full prompt of 100,000 is consistent and below 272,000.
      // usd = (10,000*4 + 10,000*5 + 10,000*5 + 10,000*0.40 + 10,000*20)/1e6 = 0.344.
      const r = engine.priceComponent(
        component(
          'gpt-5.6-sol',
          {
            inputFresh: 10_000,
            cacheWrite5m: 10_000,
            cacheWrite1h: 10_000,
            cacheRead: 10_000,
            output: 10_000,
          },
          { requestInput: 100_000 },
        ),
      );
      // 2026-10-04 primary source: Sol base cache writes are $5 (rendered page), so the base row is LIST. Derived-column status applies to Terra/Luna and the Sol fast tier only.
      expect(r.status).toBe('LIST');
      expect(r.rowId).toBe('gpt-5.6-sol');
      expect(r.flags).not.toContain('longContextBracket');
      expect(r.usd).toBeCloseTo(0.344, 9);
    });

    it('GPT-5.6 Sol fast tier: its cache-write columns are not in the 2026-10-04 evidence, so a fast component that bills them is ESTIMATE', () => {
      const r = engine.priceComponent(component('gpt-5.6-sol', { inputFresh: 10_000, cacheWrite5m: 10_000, output: 10_000 }, { requestInput: 100_000, speed: 'fast' }));
      expect(r.status).toBe('ESTIMATE');
      expect(r.usd).toBeCloseTo((8 + 10 + 40) / 100, 9);
    });

    it('GPT-5.6 Terra: a base component billing the derived cache writes is ESTIMATE; the same component without cache writes is LIST', () => {
      const withCw = engine.priceComponent(component('gpt-5.6-terra', { inputFresh: 10_000, cacheWrite5m: 10_000, output: 10_000 }, { requestInput: 100_000 }));
      expect(withCw.status).toBe('ESTIMATE');
      expect(withCw.usd).toBeCloseTo((2 + 2.5 + 12) / 100, 9);
      const noCw = engine.priceComponent(component('gpt-5.6-terra', { inputFresh: 10_000, cacheRead: 10_000, output: 10_000 }, { requestInput: 100_000 }));
      expect(noCw.status).toBe('LIST');
    });

    it('GPT-5.6 Sol: a component with no cache write stays LIST (only the derived columns downgrade the price)', () => {
      // The full prompt is consistent with the 20,000 billed input tokens and below the threshold.
      const r = engine.priceComponent(component('gpt-5.6-sol', { inputFresh: 10_000, cacheRead: 10_000, output: 10_000 }, { requestInput: 100_000 }));
      expect(r.status).toBe('LIST');
      expect(r.usd).toBeCloseTo((4 + 0.4 + 20) / 100, 9);
    });

    it('GPT-5.6 Sol: long-context bracket (>272,000) prices the WHOLE request at 2x in-side / 1.5x out', () => {
      // Below: in=4, out=20. usd = (200_000*4 + 100_000*20)/1e6 = 0.8 + 2.0 = 2.8
      const below = engine.priceComponent(
        component('gpt-5.6-sol', { inputFresh: 200_000, output: 100_000 }, { requestInput: 200_000 }),
      );
      expect(below.usd).toBeCloseTo(2.8, 9);
      expect(below.flags).not.toContain('longContextBracket');

      // Above: in=8, out=30. usd = (300_000*8 + 100_000*30)/1e6 = 2.4 + 3.0 = 5.4
      const above = engine.priceComponent(
        component('gpt-5.6-sol', { inputFresh: 300_000, output: 100_000 }, { requestInput: 300_000 }),
      );
      expect(above.usd).toBeCloseTo(5.4, 9);
      expect(above.flags).toContain('longContextBracket');
    });

    it('GPT-5.6 Sol: fast mode is 2x every standard column and is LIST (confirmed directly on the pricing page)', () => {
      // 10,000 input tokens fit the reported 100,000-token standard prompt.
      const r = engine.priceComponent(
        component('gpt-5.6-sol', { inputFresh: 10_000, output: 10_000 }, { speed: 'fast', requestInput: 100_000 }),
      );
      // usd = (10,000*8 + 10,000*40)/1e6 = 0.48
      expect(r.usd).toBeCloseTo(0.48, 9);
      expect(r.status).toBe('LIST');
      expect(r.flags).not.toContain('longContextBracket');
    });

    it('GPT-5.6 Terra: standard $2/$12 and long-context $4/$18', () => {
      // usd = (10,000*2 + 10,000*12)/1e6 = 0.14; prompt size is consistent.
      const standard = engine.priceComponent(
        component('gpt-5.6-terra', { inputFresh: 10_000, output: 10_000 }, { requestInput: 100_000 }),
      );
      expect(standard.usd).toBeCloseTo(0.14, 9);
      expect(standard.flags).not.toContain('longContextBracket');

      // usd = (300_000*4 + 100_000*18)/1e6 = 1.2 + 1.8 = 3.0
      const longCtx = engine.priceComponent(
        component('gpt-5.6-terra', { inputFresh: 300_000, output: 100_000 }, { requestInput: 300_000 }),
      );
      expect(longCtx.usd).toBeCloseTo(3.0, 9);
      expect(longCtx.flags).toContain('longContextBracket');
    });

    it('GPT-5.6 Luna: standard $0.20/$1.20 and long-context cache-read + output mix', () => {
      // usd = (10,000*0.20 + 10,000*1.20)/1e6 = 0.014; prompt size is consistent.
      const standard = engine.priceComponent(
        component('gpt-5.6-luna', { inputFresh: 10_000, output: 10_000 }, { requestInput: 100_000 }),
      );
      expect(standard.usd).toBeCloseTo(0.014, 9);
      expect(standard.flags).not.toContain('longContextBracket');

      // requestInput 280_000 (just above 272_000 threshold): usd = (280_000*0.04 + 100_000*1.80)/1e6
      // = (11_200 + 180_000)/1e6 = 0.1912
      const longCtx = engine.priceComponent(
        component('gpt-5.6-luna', { cacheRead: 280_000, output: 100_000 }, { requestInput: 280_000 }),
      );
      expect(longCtx.usd).toBeCloseTo(0.1912, 9);
      expect(longCtx.flags).toContain('longContextBracket');
    });

    it('resolves a dated GPT-5.6 id as a substring, same convention as the gpt-6-* rows', () => {
      expect(engine.resolve('gpt-5.6-luna-2026-07-30')?.id).toBe('gpt-5.6-luna');
    });
  });

  it('geo multiplier ×1.1 applies only when inference_geo is "us" AND the row is flagged for it', () => {
    // Sonnet 5 carries geoMultiplierUs (Claude 4.6+ per DESIGN §5).
    const base = engine.priceComponent(component('claude-sonnet-5', { inputFresh: 1_000_000, output: 1_000_000 }));
    expect(base.usd).toBeCloseTo(12, 9); // 2 + 10
    const us = engine.priceComponent(
      component('claude-sonnet-5', { inputFresh: 1_000_000, output: 1_000_000 }),
      { inferenceGeo: 'us' },
    );
    expect(us.usd).toBeCloseTo(13.2, 9); // 12 * 1.1

    // Opus 4.5 is below the "4.6+" cutoff and carries no geoMultiplierUs — no-op even with us geo.
    const opus45Base = engine.priceComponent(component('claude-opus-4-5', { inputFresh: 1_000_000, output: 1_000_000 }));
    const opus45Us = engine.priceComponent(
      component('claude-opus-4-5', { inputFresh: 1_000_000, output: 1_000_000 }),
      { inferenceGeo: 'us' },
    );
    expect(opus45Us.usd).toBeCloseTo(opus45Base.usd as number, 9);
  });
});

describe('priceEvent — sums components, null propagation, worst-status propagation', () => {
  function event(components: UsageComponent[], inferenceGeo?: string): Pick<UsageEvent, 'components' | 'inferenceGeo'> {
    return { components, inferenceGeo };
  }

  it('sums two priced components (hand-computed)', () => {
    // sonnet-5 leg: (1e6*2 + 1e6*10)/1e6 = 12. haiku-4-5 leg: (1e6*1 + 1e6*5)/1e6 = 6. Total 18.
    const r = engine.priceEvent(
      event([
        component('claude-sonnet-5', { inputFresh: 1_000_000, output: 1_000_000 }),
        component('claude-haiku-4-5', { inputFresh: 1_000_000, output: 1_000_000 }),
      ]),
    );
    expect(r.usd).toBeCloseTo(18, 9);
    expect(r.status).toBe('LIST');
  });

  it('any single unpriced component makes the WHOLE event unpriced (never silently sums only the priced legs)', () => {
    const r = engine.priceEvent(
      event([
        component('claude-sonnet-5', { inputFresh: 1_000_000, output: 1_000_000 }),
        component('some-unknown-model', { inputFresh: 1_000_000, output: 1_000_000 }),
      ]),
    );
    expect(r.usd).toBeNull();
    expect(r.status).toBe('UNPRICED');
    expect(r.flags).toContain('unpricedModel');
  });

  it('propagates the worst (least-certain) status across components: LIST + ESTIMATE -> ESTIMATE', () => {
    // Every Claude row is LIST as of this session's re-verification (see the "flipped ESTIMATE ->
    // LIST" test above), so this needs a component whose *own* status is genuinely still ESTIMATE:
    // gpt-6-sol's fast row (unexercised — no Codex log field has ever proven fast mode was used,
    // DESIGN §15.4 — unlike the GPT-5.6 fast rows above, which this session confirmed directly).
    // (gpt-6-astra fast was promoted to LIST on 2026-10-12: every number is on the vendor Fast table.)
    const r = engine.priceEvent(
      event([
        component('claude-sonnet-5', { inputFresh: 1000, output: 1000 }), // LIST
        component('gpt-6-sol', { inputFresh: 1000, output: 1000 }, { speed: 'fast' }), // ESTIMATE
      ]),
    );
    expect(r.status).toBe('ESTIMATE');
    expect(r.usd).not.toBeNull();
  });
});

describe('priceRowsVersion — content-addressed priceVersion', () => {
  it('is a deterministic 64-char hex sha256, stable across repeated calls on the same rows', () => {
    const rows = loadPriceRows();
    const v1 = priceRowsVersion(rows);
    const v2 = priceRowsVersion(rows);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(v1).toBe(v2);
    expect(defaultPricingEngine().version).toBe(v1);
  });

  it('changes when a single row changes (canonicalJson is not a no-op / sha256 is content-sensitive)', () => {
    const rows = loadPriceRows();
    const v1 = priceRowsVersion(rows);
    const mutated: PriceRow[] = rows.map((r, i) => (i === 0 ? { ...r, rates: { ...r.rates, in: r.rates.in + 0.01 } } : r));
    const v2 = priceRowsVersion(mutated);
    expect(v2).not.toBe(v1);
  });

  it('canonicalJson sorts object keys regardless of insertion order (order-independence of the hash)', () => {
    const a = canonicalJson({ b: 1, a: 2, nested: { z: 1, y: 2 } });
    const b = canonicalJson({ a: 2, nested: { y: 2, z: 1 }, b: 1 });
    expect(a).toBe(b);
  });
});

describe('loadUnpricedNotes — prices.json._unpriced documentation block (task: SOURCE MISSING PRICES)', () => {
  it('documents exactly the three ids left UNPRICED this session, each with a reason', () => {
    const notes = loadUnpricedNotes();
    const ids = notes.map((n) => n.id).sort();
    expect(ids).toEqual(['codex-auto-review', 'gpt-5.3-codex-spark', 'gpt-reserve'].sort());
    for (const n of notes) {
      expect(n.reason.length, n.id).toBeGreaterThan(20);
    }
  });

  it('guard: every documented _unpriced id is actually unmatched by every row (a documented id that some row secretly matches would be a lie)', () => {
    const rows = loadPriceRows();
    const notes = loadUnpricedNotes();
    for (const note of notes) {
      const matched = rows.some((row) => new RegExp(row.match, 'i').test(note.id));
      expect(matched, `${note.id} should not match any priced row`).toBe(false);
    }
    // Mutation check: if a row's match were loosened to catch one of these ids, this guard would
    // catch it. Proven here by asserting the inverse on a deliberately-broadened fixture pattern.
    const broadened = { ...rows[0], match: '.*' }; // matches anything, including every _unpriced id
    for (const note of notes) {
      expect(new RegExp(broadened.match, 'i').test(note.id)).toBe(true);
    }
  });

  it('loadPriceRows accepts the current wrapped {rows,_unpriced} shape and a bare-array fallback shape', () => {
    const wrapped = loadPriceRows(); // real file: {rows, _unpriced}
    expect(Array.isArray(wrapped)).toBe(true);
    expect(wrapped.length).toBeGreaterThan(0);
    expect(wrapped.every((r) => typeof r.id === 'string')).toBe(true);

    const tmp = path.join(os.tmpdir(), `tokenelo-bare-prices-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(wrapped));
    try {
      const bareRows = loadPriceRows(tmp);
      expect(bareRows.length).toBe(wrapped.length);
      expect(loadUnpricedNotes(tmp)).toEqual([]); // bare-array shape has no _unpriced block
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

describe('createPricingEngine — pure construction from an in-memory row array (no fs access)', () => {
  it('builds a working engine from a tiny fixture table, independent of rates/prices.json', () => {
    const rows: PriceRow[] = [
      {
        id: 'fixture-model',
        match: 'fixture-model',
        displayName: 'Fixture Model',
        provider: 'anthropic',
        eacsClass: 'ELO_CLD',
        local: false,
        rates: { in: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, out: 2 },
        status: 'LIST',
        source: 'unit test fixture',
        verifiedAt: '2026-01-01',
      },
    ];
    const fixtureEngine = createPricingEngine(rows);
    const r = fixtureEngine.priceComponent(component('fixture-model', { inputFresh: 1_000_000, output: 1_000_000 }));
    expect(r.usd).toBeCloseTo(3, 9); // 1 + 2
    expect(fixtureEngine.version).toBe(priceRowsVersion(rows));
  });
});
