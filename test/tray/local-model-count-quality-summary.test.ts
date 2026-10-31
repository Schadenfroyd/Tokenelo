import { describe, expect, it } from 'vitest';
import type { ModelRow, TokenCounts } from '../../src/tray/renderer/api-types.js';
import { usageModelRowCopy, usageModelToggleLabel } from '../../src/tray/renderer/usage-model-copy.js';

const baseTokens: TokenCounts = {
  inputFresh: 30,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 15,
  reasoning: 0,
};

function modelRow(tokens: TokenCounts, source: ModelRow['source'] = 'ollama-proxy'): ModelRow {
  return {
    model: 'qwen3:8b',
    displayName: 'Qwen3 8B',
    provider: 'local',
    source,
    thinking: 'unknown',
    events: 2,
    tokens,
    apiEquivUsd: null,
    priceStatus: 'ESTIMATE',
  };
}

describe('Local collapsed model count-quality summary', () => {
  it('keeps the default reported basis concise', () => {
    const copy = usageModelRowCopy(modelRow({ ...baseTokens, countQuality: 'complete' }), 'local');
    expect(copy.summaryCount).toBe('2');
    expect(copy.summaryCountTitle).toBe('Reported count basis');
    expect(copy.summaryCountQualification).toBe('');
    expect(copy.summarySourceQualification).toBe('');
    expect(usageModelToggleLabel(copy)).toBe('Usage breakdown for Qwen3 8B · mode unknown, qwen3:8b, Local proxy');
  });

  it('shows unrecorded count quality on the collapsed Local row', () => {
    const copy = usageModelRowCopy(modelRow({ ...baseTokens, countQuality: 'unrecorded' }), 'local');
    expect(copy.summaryCountQualification).toBe('Count evidence unrecorded · normalized categories only');
    expect(copy.summaryCountQualificationTone).toBe('neutral');
    expect(usageModelToggleLabel(copy)).toBe('Usage breakdown for Qwen3 8B · mode unknown, qwen3:8b, Local proxy · Count evidence unrecorded · normalized categories only');
  });

  it.each(['incomplete', 'invalid', 'conflict'] as const)(
    'shows %s count evidence with an unavailable-total warning', (countQuality) => {
      const copy = usageModelRowCopy(modelRow({ ...baseTokens, countQuality }), 'local');
      expect(copy.summaryValue).toBe('Unavailable');
      expect(copy.summaryCountQualification).toContain(`Complete token total unavailable · ${countQuality} count evidence`);
      expect(copy.summaryCountQualificationTone).toBe('warn');
    },
  );

  it('makes cache assumptions and unknown TTL visible without changing the count', () => {
    const tokens: TokenCounts = { ...baseTokens, countQuality: 'complete', cacheWriteUnassigned: 4, cacheWriteAssumed1h: 3 };
    const copy = usageModelRowCopy(modelRow(tokens), 'local');
    expect(copy.summaryCountQualification).toBe('Reported count basis · 4 cache writes with unknown TTL · 3 cache writes assumed 1 hour');
  });

  it('does not add the Local-only qualification to Usage rows', () => {
    const copy = usageModelRowCopy(modelRow({ ...baseTokens, countQuality: 'unrecorded' }, 'ollama-log'), 'usage');
    expect(copy.summaryCountQualification).toBe('');
    expect(copy.summarySourceQualification).toBe('');
  });

  it('keeps server-log estimate provenance in the collapsed disclosure name', () => {
    const copy = usageModelRowCopy(modelRow({ ...baseTokens, countQuality: 'complete' }, 'ollama-log'), 'local');
    expect(copy.source).toBe('Local server log');
    expect(copy.summaryCountQualification).toBe('');
    expect(copy.summarySourceQualification).toBe('Server-log counts are estimates');
    expect(usageModelToggleLabel(copy)).toBe('Usage breakdown for Qwen3 8B · mode unknown, qwen3:8b, Local server log · Server-log counts are estimates');
  });
});
