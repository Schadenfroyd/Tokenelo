import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { CLAUDE_HOLD_KEY, summarizeClaudeHolds } from '../../src/core/capture-holds.js';
import { openDb, transactionDepth } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';
import { baseTestConfig, makeHarness, type TestHarness } from './helpers.js';

const BAD_SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GOOD_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BAD_ID = 'claude:held-message';
const PRIVATE_TEXT = 'OWNED-NOT-A-PROMPT-SENTINEL';
function line(id: string, sid = BAD_SID, uuid = id): string {
  return JSON.stringify({ type: 'assistant', sessionId: sid, uuid, timestamp: '2026-09-01T00:00:00Z',
    privateText: PRIVATE_TEXT, message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 7, output_tokens: 2 } } }) + '\n';
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-stored-hold-'));
  const roots = [path.join(root, 'first-root'), path.join(root, 'second-root')];
  for (const r of roots) fs.mkdirSync(path.join(r, '-owned'), { recursive: true });
  return { root, config: baseTestConfig({ roots }), bad: path.join(roots[0], '-owned', BAD_SID + '.jsonl'),
    good: path.join(roots[1], '-owned', GOOD_SID + '.jsonl'), dbFile: path.join(root, 'owned.sqlite'),
    close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function durable(t: ReturnType<typeof fixture>): TestHarness {
  const seed = makeHarness(t.config); seed.close();
  const db = openDb({ file: t.dbFile }); const ledger = new SqliteLedger(db, seed.ctx.pricing, seed.ctx.computeUnits);
  return { ...seed, db, ledger, ctx: { ...seed.ctx, store: ledger }, close: () => db.close() };
}
const row = (h: TestHarness) => h.db.prepare('SELECT rowid,* FROM main.events WHERE id=?').get(BAD_ID);
const count = (h: TestHarness, table: 'events' | 'activity') => h.db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n;

describe('Claude stored component corruption holds only its atomic batch and file', () => {
  it.each(['not-json', 'null', '{}', '[null]', '[{"tokens":null}]'])('continues the independent root with malformed stored components %s', async malformed => {
    const t = fixture(); const h = makeHarness(t.config);
    try {
      fs.writeFileSync(t.bad, line('held-message'));
      await new ClaudeCollector().scan(h.ctx);
      const firstState = h.ledger.getState(t.bad)!;
      h.db.prepare('UPDATE events SET components_json=? WHERE id=?').run(malformed, BAD_ID);
      const badBefore = row(h);
      fs.appendFileSync(t.bad, line('fresh-before') + line('held-message', BAD_SID, 'copy') + line('fresh-after'));
      fs.writeFileSync(t.good, line('independent', GOOD_SID));
      const result = await new ClaudeCollector().scan(h.ctx);
      expect(result).toMatchObject({ filesScanned: 2, filesSkipped: 1, eventsEmitted: 1 });
      expect(row(h)).toEqual(badBefore);
      expect(count(h, 'events')).toBe(2); expect(count(h, 'activity')).toBe(2);
      expect(transactionDepth(h.db)).toBe(0);
      expect(h.ledger.getState(t.bad)?.offset).toBe(firstState.offset);
      expect(h.ledger.getState(t.good)?.offset).toBe(fs.statSync(t.good).size);
      const hold = h.ledger.getState(t.bad)?.extra?.[CLAUDE_HOLD_KEY];
      expect(hold).toMatchObject({ reason: 'stored-component-evidence' });
      expect(summarizeClaudeHolds([JSON.stringify(h.ledger.getState(t.bad)?.extra)])).toMatchObject({
        heldFiles: 1, storedComponentEvidenceHeldFiles: 1, maxLineBytes: null });
      const coverage = await createQueries(h.db, t.config, { listProcesses: async () => [], now: h.ctx.now,
        probeOllama: async () => ({ available: false }) }).getCoverage();
      expect(coverage.incompleteCapture?.[0]).toMatchObject({ heldFiles: 1, storedComponentEvidenceHeldFiles: 1 });
      expect(JSON.stringify(coverage.incompleteCapture)).not.toContain(t.root);
      expect(JSON.stringify(result.warnings) + JSON.stringify(h.logs)).not.toContain(PRIVATE_TEXT);
      expect(result.warnings.some(x => x.includes('stored component evidence'))).toBe(true);
    } finally { h.close(); t.close(); }
  });

  it.each([0, 2000])('durably preserves %i earlier committed records, retries the hold, and recovers without monetary or cursor loss', { timeout: 30_000 }, async prefixCount => {
    const t = fixture(); let h: TestHarness | null = durable(t);
    try {
      fs.writeFileSync(t.bad, line('held-message'));
      await new ClaudeCollector().scan(h.ctx);
      h.db.prepare("UPDATE events SET api_equiv_usd=0.125,price_version='OWNED-HISTORICAL-PRICE' WHERE id=?").run(BAD_ID);
      const original = row(h)!; const components = String(original.components_json);
      h.db.prepare("UPDATE events SET components_json='not-json' WHERE id=?").run(BAD_ID);
      const corrupted = row(h)!;
      const prefix = Array.from({ length: prefixCount }, (_, i) => line('prefix-' + i)).join('');
      fs.appendFileSync(t.bad, prefix + line('fresh-before') + line('held-message', BAD_SID, 'copy') + line('fresh-after'));
      fs.writeFileSync(t.good, line('independent', GOOD_SID));
      const committedOffset = Buffer.byteLength(line('held-message') + prefix);
      const scan = await new ClaudeCollector().scan(h.ctx);
      expect(scan.eventsEmitted).toBe(prefixCount + 1);
      expect(row(h)).toEqual(corrupted);
      expect(count(h, 'events')).toBe(prefixCount + 2); expect(count(h, 'activity')).toBe(prefixCount + 2);
      expect(h.ledger.getState(t.bad)?.offset).toBe(committedOffset);
      const hold = h.ledger.getState(t.bad)?.extra?.[CLAUDE_HOLD_KEY];
      h.close(); h = null; h = durable(t);
      expect(row(h)).toEqual(corrupted);
      expect(h.ledger.getState(t.bad)?.extra?.[CLAUDE_HOLD_KEY]).toEqual(hold);
      const retry = await new ClaudeCollector().scan(h.ctx);
      expect(retry.eventsEmitted).toBe(0); expect(retry.filesSkipped).toBe(1);
      expect(h.ledger.getState(t.bad)?.extra?.[CLAUDE_HOLD_KEY]).toEqual(hold);
      expect(h.ledger.getState(t.bad)?.offset).toBe(committedOffset);
      expect(transactionDepth(h.db)).toBe(0);
      // Repair is confined to this deliberately corrupted owned fixture.
      h.db.prepare('UPDATE events SET components_json=? WHERE id=?').run(components, BAD_ID);
      const recovered = await new ClaudeCollector().scan(h.ctx);
      expect(recovered).toMatchObject({ eventsEmitted: 3, filesSkipped: 0, warnings: [] });
      expect(row(h)).toEqual(original);
      expect(count(h, 'events')).toBe(prefixCount + 4); expect(count(h, 'activity')).toBe(prefixCount + 5);
      expect(h.ledger.getState(t.bad)?.offset).toBe(fs.statSync(t.bad).size);
      expect(h.ledger.getState(t.bad)?.extra).toBeUndefined();
      const again = await new ClaudeCollector().scan(h.ctx);
      expect(again.eventsEmitted).toBe(0);
      expect(count(h, 'events')).toBe(prefixCount + 4); expect(row(h)).toEqual(original);
    } finally { h?.close(); t.close(); }
  });

  it('propagates unrelated transactional errors and does not misclassify them as a stored-component hold', async () => {
    const t = fixture(); const h = makeHarness(t.config);
    try {
      fs.writeFileSync(t.bad, line('ordinary'));
      const record = h.ledger.recordActivity.bind(h.ledger);
      h.ledger.recordActivity = marks => { record(marks); throw new Error('OWNED-UNRELATED-FAULT'); };
      await expect(new ClaudeCollector().scan(h.ctx)).rejects.toThrow('OWNED-UNRELATED-FAULT');
      expect(transactionDepth(h.db)).toBe(0); expect(count(h, 'events')).toBe(0); expect(count(h, 'activity')).toBe(0);
      expect(h.ledger.getState(t.bad)).toBeUndefined();
    } finally { h.close(); t.close(); }
  });

  it.each(['append', 'touch'])('preserves the original rejected-prefix age after source %s', async change => {
    const t = fixture(); const h = makeHarness(t.config);
    try {
      fs.writeFileSync(t.bad, line('held-message')); await new ClaudeCollector().scan(h.ctx);
      h.db.prepare("UPDATE events SET components_json='not-json' WHERE id=?").run(BAD_ID);
      fs.appendFileSync(t.bad, line('held-message', BAD_SID, 'copy'));
      await new ClaudeCollector().scan(h.ctx);
      const before = h.ledger.getState(t.bad)!;
      if (change === 'append') fs.appendFileSync(t.bad, line('appended'));
      else fs.utimesSync(t.bad, new Date(), new Date(Date.now() + 60_000));
      const result = await new ClaudeCollector().scan(h.ctx);
      expect(result.eventsEmitted).toBe(0);
      expect(h.ledger.getState(t.bad)?.offset).toBe(before.offset);
      expect((h.ledger.getState(t.bad)?.extra?.[CLAUDE_HOLD_KEY] as { heldSince: number }).heldSince)
        .toBe((before.extra?.[CLAUDE_HOLD_KEY] as { heldSince: number }).heldSince);
    } finally { h.close(); t.close(); }
  });

  it('starts a new hold age for a changed rejected prefix even when its inode and size remain the same', async () => {
    const t = fixture(); const h = makeHarness(t.config);
    try {
      const seed = line('held-message'); const rejected = line('held-message', BAD_SID, 'copy');
      fs.writeFileSync(t.bad, seed); await new ClaudeCollector().scan(h.ctx);
      h.db.prepare("UPDATE events SET components_json='not-json' WHERE id=?").run(BAD_ID);
      fs.appendFileSync(t.bad, rejected); await new ClaudeCollector().scan(h.ctx);
      const before = h.ledger.getState(t.bad)!; const ino = fs.statSync(t.bad, { bigint: true }).ino;
      fs.writeFileSync(t.bad, seed + rejected.replace(PRIVATE_TEXT, PRIVATE_TEXT.slice(0, -1) + 'Q'));
      fs.utimesSync(t.bad, new Date(), new Date(Date.now() + 60_000));
      expect(fs.statSync(t.bad, { bigint: true }).ino).toBe(ino);
      expect(fs.statSync(t.bad).size).toBe(before.size);
      await new ClaudeCollector().scan(h.ctx);
      expect((h.ledger.getState(t.bad)?.extra?.[CLAUDE_HOLD_KEY] as { heldSince: number }).heldSince)
        .toBeGreaterThan((before.extra?.[CLAUDE_HOLD_KEY] as { heldSince: number }).heldSince);
      expect(h.ledger.getState(t.bad)?.offset).toBe(before.offset);
    } finally { h.close(); t.close(); }
  });

  it('retains an unresolved removed-file hold rather than reporting recovery or fresh capture', async () => {
    const t = fixture(); const h = makeHarness(t.config);
    try {
      fs.writeFileSync(t.bad, line('held-message')); await new ClaudeCollector().scan(h.ctx);
      h.db.prepare("UPDATE events SET components_json='not-json' WHERE id=?").run(BAD_ID);
      fs.appendFileSync(t.bad, line('held-message', BAD_SID, 'copy')); await new ClaudeCollector().scan(h.ctx);
      const before = h.ledger.getState(t.bad)!; fs.unlinkSync(t.bad);
      const result = await new ClaudeCollector().scan(h.ctx); expect(result.eventsEmitted).toBe(0);
      expect(h.ledger.getState(t.bad)).toEqual(before);
      const coverage = await createQueries(h.db, t.config, { listProcesses: async () => [], now: h.ctx.now,
        probeOllama: async () => ({ available: false }) }).getCoverage();
      expect(coverage.incompleteCapture?.[0]).toMatchObject({ heldFiles: 1, storedComponentEvidenceHeldFiles: 1 });
      expect(JSON.stringify(coverage.incompleteCapture)).not.toContain(PRIVATE_TEXT);
    } finally { h.close(); t.close(); }
  });

  it('aggregates mixed holds once per file without exposing private marker fields or inventing a line limit', () => {
    expect(summarizeClaudeHolds([
      JSON.stringify({ claudeHold: { reason: 'stored-component-evidence', heldSince: 10, arbitrary: PRIVATE_TEXT } }),
      JSON.stringify({ claudeHold: { heldSince: 20, maxLineBytes: 4_194_304 } }),
      JSON.stringify({ claudeHold: { reason: 'unknown', heldSince: 5 } }),
      JSON.stringify({ claudeHold: { reason: 'stored-component-evidence', heldSince: 'bad' } }),
    ])).toEqual({ collector: 'claude', heldFiles: 2, oldestHeldAt: 10, maxLineBytes: null, storedComponentEvidenceHeldFiles: 1 });
  });
});
