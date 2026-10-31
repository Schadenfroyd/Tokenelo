import { expect, it } from 'vitest';
import { captureNativeCounters, nativeCounterProjection } from '../../src/measurement/native-counter-evidence.js';
import { nativeTokenFieldCoverage, storedNativeTokenFields } from '../../src/core/token-field-evidence.js';
import { ZERO_TOKENS, type TokenCounts } from '../../src/core/types.js';
import { addTokenCounts } from '../../src/core/token-counts.js';
import { countBasisLabel, tokenCountDetails } from '../../src/tray/renderer/token-counts.js';
import { buildShareReport } from '../../src/cli/share-report.js';

function native() {
  const e = captureNativeCounters({ prompt_eval_count: 3, eval_count: 0 });
  const tokens = { ...nativeCounterProjection(e), cacheWriteUnassigned: 0 };
  const components = [{ model: 'OWNED', tokens, nativeCounterEvidence: e }];
  return { components, tokens: { ...tokens, fieldEvidence: nativeTokenFieldCoverage(components, tokens) } };
}
it('keeps consistent mixed-source exports reconciled and does not omit validated non-native categories', () => {
  const n = native().tokens;
  const legacy: TokenCounts = { ...ZERO_TOKENS, inputFresh: 5, cacheRead: 6, output: 9, reasoning: 4, cacheWrite1h: 2,
    cacheWriteUnassigned: 0, cacheWriteAssumed1h: 2, countQuality: 'complete' };
  const total = { ...ZERO_TOKENS }; addTokenCounts(total, n); addTokenCounts(total, legacy);
  const row = (tokens: TokenCounts, events: number) => ({ tokens, events, apiEquivUsd: 0, unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST' as const });
  const report = buildShareReport({ range: 'all', generatedAt: 1, totals: row(total, 2), bySource: { 'ollama-proxy': row(n, 1), claude: row(legacy, 1) } }, 'all');
  expect(report.sourceReconciliation.status).toBe('match');
  expect(report.totals.tokens.subsets.consistent).toBe(true);
  expect(tokenCountDetails(total).components.find(c => c.key === 'output')!.value).toBe(9);
});
it('never crashes count-basis rendering on a missing metadata field', () => {
  for (const bad of [{}, { cacheRead: null }, 'wrong-shape']) {
    const t = { ...ZERO_TOKENS, countQuality: 'complete', fieldEvidence: bad } as unknown as TokenCounts;
    expect(() => countBasisLabel(t)).not.toThrow();
    expect(countBasisLabel(t)).toContain('field evidence invalid');
  }
});
it('holds legacy native field attribution when the materialization revision is missing', () => {
  const n = native(), totals = { ...n.tokens }; delete totals.fieldEvidence;
  const read = storedNativeTokenFields as unknown as (raw: string, t: TokenCounts, revision: number | null) => TokenCounts['fieldEvidence'];
  const f = read(JSON.stringify(n.components), totals, null)!;
  expect(totals.countQuality).toBe('incomplete');
  expect(f.output).toMatchObject({ knownParts: 0, unrecordedParts: 1 });
});
it.each(['not-json', '[null]', '[{"model":"OWNED","nativeCounterEvidence":{}}]'])('qualifies corrupted native component evidence instead of aborting the entire report %s', raw => {
  const t = { ...ZERO_TOKENS, inputFresh: 3, countQuality: 'complete' as const } as TokenCounts;
  expect(() => storedNativeTokenFields(raw, t)).not.toThrow();
  expect(storedNativeTokenFields(raw, t)!.output.invalidParts).toBeGreaterThan(0);
  expect(t.countQuality).toBe('invalid');
});
