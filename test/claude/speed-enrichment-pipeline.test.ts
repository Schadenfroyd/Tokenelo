import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { PriceRow } from '../../src/core/types.js';

const MODEL = 'owned-speed-control';
const SESSION = '00000000-0000-4000-8000-000000000001';
const NOW = 1_700_000_000_000;
const rows: PriceRow[] = [{ id: MODEL, match: '^owned-speed-control$', displayName: 'Owned speed control',
  provider: 'anthropic', local: false,
  rates: { in: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: .1, out: 1 },
  status: 'LIST', source: 'Owned synthetic conditional rates; not vendor pricing', verifiedAt: '2023-11-14' }];
const pricing = createPricingEngine(rows);
const valuationEngine = createNullEngine();
const owned: string[] = [];
afterEach(() => { for (const p of owned.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
function usage(output: number, speed?: string) {
  return { input_tokens: 3, output_tokens: output, cache_creation_input_tokens: 83280, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 83280, ephemeral_1h_input_tokens: 0 },
    ...(speed === undefined ? {} : { speed }) };
}
async function harness(inputs: { usage: Record<string, unknown>; model?: string }[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-speed-enrichment-')); owned.push(root);
  fs.mkdirSync(path.join(root, 'owned-project'));
  const file = path.join(root, 'owned-project', SESSION + '.jsonl');
  const text = inputs.map((r, i) => JSON.stringify({ type: 'assistant', timestamp: new Date(NOW + i * 235).toISOString(),
    sessionId: SESSION, requestId: 'owned-request', uuid: 'owned-record-' + i,
    message: { id: 'owned-speed-message', model: r.model ?? MODEL, usage: r.usage } })).join('\n') + '\n';
  fs.writeFileSync(file, text);
  const db = openDb({ file: ':memory:' }), ledger = new SqliteLedger(db, pricing, valuationEngine);
  const config = defaultConfig({ hostLabel: 'owned-speed-fixture' }); config.claude.roots = [root];
  try {
    await new ClaudeCollector().scan({ host: config.hostLabel, config, store: ledger, pricing, valuationEngine,
      log: () => {}, now: () => NOW + 1000 });
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    return { db, ledger };
  } catch (error) { db.close(); throw error; }
}
describe('single raw-component standard speed enrichment', () => {
  it.each([false, true])('growing raw snapshot is complete with speed absence in reverse order=%s', async reverse => {
    const inputs = [{ usage: usage(1) }, { usage: { ...usage(64, 'standard'), iterations: [] } }];
    const h = await harness(reverse ? inputs.reverse() : inputs);
    try {
      const [event] = h.ledger.getEvents();
      expect(event.flags).not.toContain('mergedComponentsMisaligned');
      expect(event.tokens.countQuality).toBe('complete');
      expect(event.tokens.inputFresh + event.tokens.cacheWrite5m + event.tokens.cacheRead + event.tokens.output).toBe(83347);
      expect(event.components[0].tokens).toEqual(event.tokens);
      expect(event.components[0].countEvidence!.snapshots).toHaveLength(2);
      expect(event.components[0].speed).toBe('standard');
      expect(event.apiEquivUsd).toBeCloseTo(.104167, 12);
      expect(event.reservedValue).toBeNull();
      expect(event.ucuRateStatus).toBe('NONE');
      const revision = h.db.prepare('SELECT count_revision FROM events').get()!.count_revision;
      expect(h.ledger.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });
      expect(h.db.prepare('SELECT count_revision FROM events').get()!.count_revision).toBe(revision);
    } finally { h.db.close(); }
  });
  it.each([
    { name: 'missing versus fast', inputs: [{ usage: usage(1) }, { usage: usage(64, 'fast') }] },
    { name: 'standard versus fast', inputs: [{ usage: usage(1, 'standard') }, { usage: usage(64, 'fast') }] },
    { name: 'different model', inputs: [{ usage: usage(1) }, { usage: usage(64, 'standard'), model: 'owned-other-model' }] },
    { name: 'multiple components', inputs: [
      { usage: { ...usage(1), iterations: [usage(1), usage(1)] } },
      { usage: { ...usage(64, 'standard'), iterations: [usage(32, 'standard'), usage(32, 'standard')] } },
    ] },
  ])('preserves conflict for $name', async c => {
    const h = await harness(c.inputs);
    try {
      const [event] = h.ledger.getEvents();
      expect(event.flags).toContain('mergedComponentsMisaligned');
      expect(event.tokens.countQuality).toBe('conflict');
      expect(event.apiEquivUsd).toBeNull(); expect(event.reservedValue).toBeNull();
    } finally { h.db.close(); }
  });
  it('keeps an existing misalignment flag conservative during re-ingest', async () => {
    const h = await harness([{ usage: usage(1) }, { usage: usage(64, 'standard') }]);
    try {
      const [event] = h.ledger.getEvents();
      h.ledger.upsertEvents([{ ...event, flags: [...event.flags, 'mergedComponentsMisaligned'] }]);
      h.ledger.upsertEvents([event]);
      const [kept] = h.ledger.getEvents();
      expect(kept.flags).toContain('mergedComponentsMisaligned');
      expect(kept.tokens.countQuality).toBe('conflict');
      expect(kept.apiEquivUsd).toBeNull(); expect(kept.reservedValue).toBeNull();
    } finally { h.db.close(); }
  });
});
