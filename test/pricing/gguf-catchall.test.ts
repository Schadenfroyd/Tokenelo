import { describe, it, expect } from 'vitest';
import { defaultPricingEngine } from '../../src/core/pricing.js';

describe('local GGUF catch-all', () => {
  it('prices any GGUF-tagged model id as local $0 (not unknown)', () => {
    const p = defaultPricingEngine();
    for (const id of ['hf.co/bartowski/Mistral-Small-3.2-24B-GGUF:Q4_K_M', 'some-model.gguf', 'x-GGUF:Q8_0']) {
      expect(p.providerOf(id)).toBe('local');
      const r = p.priceComponent({ model: id, tokens: { inputFresh: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1000, reasoning: 0 } });
      expect(r.usd).toBe(0);
    }
  });
});
