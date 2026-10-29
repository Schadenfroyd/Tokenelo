import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { captureNativeCounters, nativeCounterProjection } from '../../src/measurement/native-counter-evidence.js';
import { nativeTokenFieldCoverage, validTokenFieldCoverage } from '../../src/core/token-field-evidence.js';
import { addTokenCounts } from '../../src/core/token-counts.js';
import { ZERO_TOKENS, type Range, type TokenCounts } from '../../src/core/types.js';
import { tokenCountDetails, countBasisLabel, tokenCategoryText } from '../../src/tray/renderer/token-counts.js';
import { buildOllamaUsageEvent } from '../../src/collectors/ollama-proxy.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { StubEacsEngine, StubPricingEngine } from '../store/stubs.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { createQueries } from '../../src/store/queries.js';
import { readUsageAggregate } from '../../src/store/usage-aggregate.js';
import { buildShareReport } from '../../src/cli/share-report.js';

function counts(raw: Record<string, unknown>): TokenCounts {
  const nativeCounterEvidence = captureNativeCounters(raw);
  const tokens = nativeCounterProjection(nativeCounterEvidence);
  return { ...tokens, fieldEvidence: nativeTokenFieldCoverage([{ model: 'OWNED', tokens, nativeCounterEvidence }], tokens) };
}
it.each([
  { raw: { prompt_eval_count: 3 }, output: null, note: 'Not reported' },
  { raw: { prompt_eval_count: 3, eval_count: 0 }, output: 0, note: 'Reported counter' },
  { raw: { prompt_eval_count: 3, eval_count: 'PRIVATE-TEXT' }, output: null, note: 'Invalid count observations' },
])('distinguishes missing, explicit zero and invalid output $raw', sample => {
  const t = counts(sample.raw), detail = tokenCountDetails(t);
  expect(detail.components.find(c => c.key === 'output')!.value).toBe(sample.output);
  expect(tokenCategoryText(t, 'output')).toContain(sample.note);
  expect(detail.components.find(c => c.key === 'inputFresh')!.value).toBe(3);
  expect(detail.reasoning).toBeNull();
  expect(countBasisLabel(t)).toContain('cache reads include an assumed-zero policy');
  expect(JSON.stringify(t.fieldEvidence)).not.toContain('PRIVATE-TEXT');
});
it('retains gross prompt evidence without misrepresenting invalid-cache fresh input as zero', () => {
  const t = counts({ prompt_eval_count: 18, prompt_eval_cached_count: 'BAD', eval_count: 8 });
  expect(tokenCategoryText(t, 'inputFresh')).toContain('Unavailable');
  expect(tokenCountDetails(t).components.find(c => c.key === 'output')!.value).toBe(8);
  expect(t.fieldEvidence!.inputFresh.invalidParts).toBe(1);
  expect(t.fieldEvidence!.cacheRead.assumedParts).toBe(0);
});
it.each([true, false])('preserves unknown legacy contributions regardless of fold order %s', nativeFirst => {
  const t = counts({ prompt_eval_count: 3, eval_count: 0 });
  const legacy = { ...ZERO_TOKENS, output: 9, countQuality: 'unrecorded' as const };
  const aggregate = { ...ZERO_TOKENS };
  for (const row of nativeFirst ? [t, legacy] : [legacy, t]) addTokenCounts(aggregate, row);
  expect(aggregate.output).toBe(9);
  expect(aggregate.fieldEvidence!.output).toMatchObject({ knownValue: 0, knownParts: 1, unrecordedParts: 1 });
  expect(tokenCountDetails(aggregate).totalAvailable).toBe(false);
  expect(tokenCategoryText(aggregate, 'output')).toContain('field presence unrecorded');
});
it('rejects malformed or extra field metadata in both core and renderer', () => {
  for (const mutate of [(t: TokenCounts) => { t.fieldEvidence!.output.knownValue = Infinity; },
    (t: TokenCounts) => { (t.fieldEvidence!.output as unknown as Record<string, unknown>).privateText = 'SECRET'; }]) {
    const t = counts({ prompt_eval_count: 3, eval_count: 0 }); mutate(t);
    expect(validTokenFieldCoverage(t)).toBe(false);
    expect(tokenCountDetails(t).subtotal).toBeNull();
    expect(tokenCategoryText(t, 'output')).toContain('Field evidence invalid');
  }
});

it.each(['today', '24h', '7d', '30d', 'all'] as Range[])('carries exact persisted field presence through summary, session and aggregate export %s', async range => {
  const now = Date.UTC(2026, 9, 13, 14), root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-field-disclosure-'));
  const file = path.join(root, 'ledger.db'), db = openDb({ file });
  try {
    const raw = captureNativeCounters({ prompt_eval_count: 3 });
    const e = buildOllamaUsageEvent({ host: 'OWNED', model: 'OWNED', ts: now - 1, requestStartNs: 1n, entrypoint: 'owned',
      tokens: nativeCounterProjection(raw), nativeCounterEvidence: raw });
    new SqliteLedger(db, new StubPricingEngine(), new StubEacsEngine()).upsertEvents([e]);
    const before = db.prepare('SELECT * FROM main.events ORDER BY rowid').all();
    const queries = createQueries(db, defaultConfig({ hostLabel: 'OWNED' }), { now: () => now, readSnapshotFile: file, pageRows: 1 });
    const summary = await queries.getSummary(range);
    const aggregate = await readUsageAggregate(file, range, { now: () => now, pageRows: 1 });
    const session = await queries.getSessionDetail('ollama-proxy', e.sessionId);
    for (const t of [summary.totals.tokens, summary.byModel[0]!.tokens, aggregate.totals.tokens, session!.tokens]) {
      expect(t.fieldEvidence!.output).toMatchObject({ knownParts: 0, missingParts: 1 });
      expect(tokenCountDetails(t).components.find(c => c.key === 'output')!.value).toBeNull();
      expect(tokenCountDetails(t).components.find(c => c.key === 'inputFresh')!.value).toBe(3);
    }
    const report = buildShareReport(aggregate, range);
    expect(report.totals.tokens.components.output).toBeNull();
    expect(report.totals.tokens.knownCategorySubtotal).toBe(3);
    expect(report.totals.tokens.normalizedCategorySubtotal).toBeNull();
    expect(report.totals.tokens.completeTotal).toBeNull();
    expect(report.totals.tokens.fieldEvidence!.cacheRead.assumedParts).toBe(1);
    expect(db.prepare('SELECT * FROM main.events ORDER BY rowid').all()).toEqual(before);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
