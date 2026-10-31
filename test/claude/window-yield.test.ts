/**
 * Parsing yields every 500 lines; each atomic batch has at most 2,000 records
 * and yields before the next batch. 3,000 records therefore give six parse
 * yields and two commit yields. Transaction sizes and inter-batch scheduling
 * are also asserted directly, rather than relying only on a turn count.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { baseTestConfig, makeHarness, type TestHarness } from './helpers.js';

describe('ClaudeCollector — a large window yields inside parse and write', () => {
  let h: TestHarness | undefined;
  afterEach(() => {
    h?.close();
    h = undefined;
  });

  it('a 3,000-line window yields every 500 lines and between event batches, and loses no event', { timeout: 30_000 }, async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-window-yield-'));
    try {
      const projDir = path.join(tmpRoot, '-fixture-window');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) {
        lines.push(
          JSON.stringify({
            type: 'assistant', uuid: `w-${i}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/window',
            message: { id: `win-${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
          })
        );
      }
      fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      const transaction = h.ledger.transaction.bind(h.ledger);
      const batchSizes: number[] = [];
      let afterFirstCommit = false;
      let transactionDepth = 0;
      h.ledger.transaction = (work) => {
        if (transactionDepth > 0) return transaction(work);
        const before = h!.ledger.getEvents({}).length;
        if (batchSizes.length === 1) expect(afterFirstCommit).toBe(true);
        transactionDepth++;
        try { transaction(work); } finally { transactionDepth--; }
        batchSizes.push(h!.ledger.getEvents({}).length - before);
        if (batchSizes.length === 1) setImmediate(() => { afterFirstCommit = true; });
      };
      let spins = 0;
      let running = true;
      const spin = (): void => {
        if (!running) return;
        spins++;
        setImmediate(spin);
      };
      spin();
      const stats = await new ClaudeCollector().scan(h.ctx);
      running = false;

      expect(stats.warnings).toEqual([]);
      expect(h.ledger.getEvents({})).toHaveLength(3000);
      expect(spins).toBeGreaterThanOrEqual(8);
      expect(batchSizes).toEqual([2000, 1000]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  /**
   * Activity, usage and cursor are one bounded atomic batch. A failure after
   * writing activity rolls back the failing batch while earlier whole batches
   * remain committed. Resume must match an uninterrupted control without duplicates.
   */
  it.each([1, 2])('an interruption in atomic batch %i rolls back its activity, usage and cursor and resumes to the control', { timeout: 30_000 }, async failBatch => {
    const roots: string[] = [];
    try {
      const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const lines: string[] = [];
      for (let i = 0; i < 3000; i++) {
        lines.push(
          JSON.stringify({
            type: 'assistant', uuid: `b-${i}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/boundary',
            message: { id: `bnd-${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 2 + (i % 7), output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: i } },
          })
        );
      }
      const body = lines.join('\n') + '\n';
      const makeRoot = (): string => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-boundary-'));
        roots.push(root);
        const projDir = path.join(root, '-fixture-boundary');
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, `${sessionId}.jsonl`), body);
        return root;
      };

      // Control: uninterrupted.
      const controlRoot = makeRoot();
      const control = makeHarness(baseTestConfig({ roots: [controlRoot] }));
      try {
        await new ClaudeCollector().scan(control.ctx);
        const controlFp = semanticFingerprint(control);

        // Inject failure after activity writes inside the selected atomic batch.
        const crashRoot = makeRoot();
        const crash = makeHarness(baseTestConfig({ roots: [crashRoot] }));
        try {
          const realRecordActivity = crash.ledger.recordActivity.bind(crash.ledger);
          let batches = 0;
          crash.ledger.recordActivity = (marks) => {
            realRecordActivity(marks);
            if (++batches === failBatch) {
              throw new Error('simulated interruption before the activity commit');
            }
          };
          await expect(new ClaudeCollector().scan(crash.ctx)).rejects.toThrow('simulated interruption');

          // Only earlier complete batches are visible; the failing batch has no partial state.
          const filePath = path.join(crashRoot, '-fixture-boundary', `${sessionId}.jsonl`);
          const committed = failBatch === 1 ? 0 : 2000;
          const prefixBytes = Buffer.byteLength(lines.slice(0, committed).map(line => line + '\n').join(''));
          expect(crash.ledger.getEvents({})).toHaveLength(committed);
          if (committed === 0) expect(crash.ledger.getState(filePath)).toBeUndefined();
          else expect(crash.ledger.getState(filePath)?.offset).toBe(prefixBytes);
          expect((crash.db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number }).n).toBe(committed);

          // Resume from the exact byte cursor of the last complete batch.
          crash.ledger.recordActivity = realRecordActivity;
          const resumed = await new ClaudeCollector().scan(crash.ctx);
          expect(resumed.warnings).toEqual([]);
          expect(resumed.bytesRead).toBe(Buffer.byteLength(body) - prefixBytes);
          expect(crash.ledger.getState(filePath)?.offset).toBe(Buffer.byteLength(body));

          // Same semantic state as the uninterrupted control, with no duplicates.
          expect(semanticFingerprint(crash)).toEqual(controlFp);
        } finally {
          crash.close();
        }
      } finally {
        control.close();
      }
    } finally {
      for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Semantic fingerprint of a harness's ledger: every event column, every non-id activity column and token totals.
 * Cursor offsets are asserted separately against the complete input byte length. Nothing raw is returned. */
function semanticFingerprint(h: TestHarness): { events: number; activity: number; eventsSha256: string; activitySha256: string; tokens: Record<string, number> } {
  const events = h.db.prepare('SELECT * FROM events ORDER BY id').all();
  const activity = h.db
    .prepare('SELECT source, session_id, ts, uuid, host, project, kind, duration_ms FROM activity ORDER BY source, session_id, ts, COALESCE(uuid, \'\'), COALESCE(kind, \'\')')
    .all();
  const tokens = h.db
    .prepare('SELECT COALESCE(SUM(input_fresh),0) AS inputFresh, COALESCE(SUM(cache_read),0) AS cacheRead, COALESCE(SUM(output),0) AS output FROM events')
    .get() as Record<string, number>;
  return {
    events: events.length,
    activity: activity.length,
    eventsSha256: crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex'),
    activitySha256: crypto.createHash('sha256').update(JSON.stringify(activity)).digest('hex'),
    tokens,
  };
}
