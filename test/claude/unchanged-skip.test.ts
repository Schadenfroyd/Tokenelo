/**
 * The collector skips the cursor read of a file its previous completed scan found fully read, while the file's stat
 * identity (size, mtime, inode) is unchanged. Every other file is read as before. Each test below fails under one mutant:
 *   - the skip ignores the identity (path only): the append and the same-size rename are never read;
 *   - the skip ignores the size: the append is never read;
 *   - the skip ignores the mtime: a same-size in-place rewrite never refreshes the stored stat;
 *   - the skip ignores the inode: the same-size rename with the mtime preserved is never read;
 *   - the entries are not reset for a different store: the second ledger receives nothing;
 *   - a missed file is not dropped before it is processed: after a scan that throws, the cursor row stays stale.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import type { IngestStats } from '../../src/core/types.js';
import { baseTestConfig, makeHarness, type TestHarness } from './helpers.js';

const SESSION_ID = '12121212-1212-4121-8121-121212121212';

/** One assistant line. Ids of the same length give lines of the same byte length. */
function line(msgId: string): string {
  return (
    JSON.stringify({
      type: 'assistant', uuid: `u-${msgId}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId: SESSION_ID, cwd: '/fixture/skip',
      message: { id: msgId, model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }) + '\n'
  );
}

/** Counts the cursor reads the collector makes through the harness's store. */
function countCursorReads(h: TestHarness): string[] {
  const keys: string[] = [];
  const real = h.ledger.getState.bind(h.ledger);
  h.ledger.getState = (key) => {
    keys.push(key);
    return real(key);
  };
  return keys;
}

function cursorRows(h: TestHarness): unknown[] {
  return h.db.prepare('SELECT key, size, mtime_ms, offset, ino, extra_json FROM ingest_state ORDER BY key').all();
}

function withoutDuration(stats: IngestStats): Omit<IngestStats, 'durationMs'> {
  const { durationMs, ...rest } = stats;
  void durationMs;
  return rest;
}

function eventIds(h: TestHarness): string[] {
  return h.ledger.getEvents({}).map((e) => e.id).sort();
}

describe('ClaudeCollector — unchanged files skip the cursor read', () => {
  const roots: string[] = [];
  const harnesses: TestHarness[] = [];
  afterEach(() => {
    for (const h of harnesses.splice(0)) h.close();
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  function makeRoot(files: Record<string, string>): { root: string; paths: string[] } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-unchanged-skip-'));
    roots.push(root);
    const projDir = path.join(root, '-fixture-skip');
    fs.mkdirSync(projDir, { recursive: true });
    const paths = Object.entries(files).map(([name, body]) => {
      const p = path.join(projDir, `${name}.jsonl`);
      fs.writeFileSync(p, body);
      return p;
    });
    return { root, paths };
  }

  function harness(root: string): TestHarness {
    const h = makeHarness(baseTestConfig({ roots: [root] }));
    harnesses.push(h);
    return h;
  }

  it('reads each cursor until the file is confirmed unchanged, then skips it with the same stats and no ledger change', async () => {
    const ids = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
    const { root } = makeRoot(Object.fromEntries(ids.map((id, i) => [id, line(`m-${i}`)])));
    const h = harness(root);
    const collector = new ClaudeCollector();
    const reads = countCursorReads(h);

    await collector.scan(h.ctx); // ingests every file
    expect(reads).toHaveLength(3);
    const second = await collector.scan(h.ctx); // reads every cursor and confirms every file unchanged
    expect(reads).toHaveLength(6);
    const rows = cursorRows(h);
    const events = eventIds(h);

    const third = await collector.scan(h.ctx);
    expect(reads).toHaveLength(6); // no cursor read for an unchanged file
    expect(withoutDuration(third)).toEqual(withoutDuration(second));
    expect(third).toMatchObject({ filesScanned: 3, filesSkipped: 0, eventsEmitted: 0, bytesRead: 0, warnings: [] });
    expect(cursorRows(h)).toEqual(rows);
    expect(eventIds(h)).toEqual(events);

    // A new collector instance (a restart) has no entries and reads every cursor again, with the same result.
    const fresh = await new ClaudeCollector().scan(h.ctx);
    expect(reads).toHaveLength(9);
    expect(withoutDuration(fresh)).toEqual(withoutDuration(third));
  });

  it('an append to a skipped file is read even with its mtime reset, and only that file\'s cursor is read', async () => {
    const { root, paths } = makeRoot({
      'bbbbbbbb-0000-4000-8000-000000000001': line('a-1'),
      'bbbbbbbb-0000-4000-8000-000000000002': line('b-1'),
    });
    const base = new Date(1_700_000_000_000);
    fs.utimesSync(paths[0]!, base, base);
    const h = harness(root);
    const collector = new ClaudeCollector();
    await collector.scan(h.ctx);
    await collector.scan(h.ctx);
    const reads = countCursorReads(h);

    // Only the size differs from the confirmed identity.
    fs.appendFileSync(paths[0]!, line('a-2'));
    fs.utimesSync(paths[0]!, base, base);
    const appended = await collector.scan(h.ctx);
    expect(reads).toEqual([paths[0]]);
    expect(appended.eventsEmitted).toBe(1);
    expect(appended.bytesRead).toBe(Buffer.byteLength(line('a-2')));
    expect(eventIds(h)).toEqual(['claude:a-1', 'claude:a-2', 'claude:b-1']);
    expect(h.ledger.getState(paths[0]!)?.offset).toBe(fs.statSync(paths[0]!).size);
  });

  it('a same-size in-place rewrite with a new mtime persists the new stat, as a scan without the skip does', async () => {
    const { root, paths } = makeRoot({ 'ffffffff-0000-4000-8000-000000000001': line('w-aaaa') });
    const filePath = paths[0]!;
    const base = new Date(1_700_000_000_000);
    fs.utimesSync(filePath, base, base);
    const h = harness(root);
    const collector = new ClaudeCollector();
    await collector.scan(h.ctx);
    await collector.scan(h.ctx);

    fs.writeFileSync(filePath, line('w-bbbb')); // same size, same inode
    const later = new Date(1_700_000_060_000);
    fs.utimesSync(filePath, later, later);
    const rescan = await collector.scan(h.ctx);
    // Existing cursor rule: the offset is already at the (unchanged) size, so nothing is read; the stored stat is refreshed.
    expect(rescan.bytesRead).toBe(0);
    expect(h.ledger.getState(filePath)).toMatchObject({ size: fs.statSync(filePath).size, mtimeMs: later.getTime() });
  });

  it('a same-size replacement by rename with the original mtime preserved (only the inode differs) is re-read', async () => {
    const { root, paths } = makeRoot({ 'cccccccc-0000-4000-8000-000000000001': line('r-aaaa') });
    const filePath = paths[0]!;
    // Whole-second mtime: representable exactly on both sides, so the preserved value compares equal.
    const base = new Date(1_700_000_000_000);
    fs.utimesSync(filePath, base, base);
    const h = harness(root);
    const collector = new ClaudeCollector();
    await collector.scan(h.ctx);
    await collector.scan(h.ctx); // confirmed unchanged: skipped from the next scan on
    const oldIno = fs.statSync(filePath, { bigint: true }).ino;

    const tmp = `${filePath}.replacement`;
    fs.writeFileSync(tmp, line('r-bbbb'));
    fs.utimesSync(tmp, base, base);
    fs.renameSync(tmp, filePath);
    const after = fs.statSync(filePath, { bigint: true });
    expect(Number(after.size)).toBe(Buffer.byteLength(line('r-aaaa')));
    expect(Number(after.mtimeMs)).toBe(base.getTime());
    expect(after.ino).not.toBe(oldIno);

    const rescan = await collector.scan(h.ctx);
    expect(rescan.eventsEmitted).toBe(1);
    expect(eventIds(h)).toEqual(['claude:r-aaaa', 'claude:r-bbbb']);
  });

  it('entries from one store are never used for another store', async () => {
    const { root } = makeRoot({ 'dddddddd-0000-4000-8000-000000000001': line('s-1') + line('s-2') });
    const first = harness(root);
    const collector = new ClaudeCollector();
    await collector.scan(first.ctx);
    await collector.scan(first.ctx);

    const second = harness(root);
    const stats = await collector.scan(second.ctx);
    expect(stats.eventsEmitted).toBe(2);
    expect(eventIds(second)).toEqual(['claude:s-1', 'claude:s-2']);
  });

  it('a scan that throws after a file\'s cursor moved leaves no stale entry for it', async () => {
    const { root, paths } = makeRoot({ 'eeeeeeee-0000-4000-8000-000000000001': line('t-1') });
    const filePath = paths[0]!;
    const base = new Date(1_700_000_000_000);
    fs.utimesSync(filePath, base, base);
    const originalSize = fs.statSync(filePath).size;
    const h = harness(root);
    const collector = new ClaudeCollector();
    await collector.scan(h.ctx);
    await collector.scan(h.ctx); // confirmed unchanged at (originalSize, base, inode)

    // A failure after the cursor statement rolls back usage and cursor together.
    fs.appendFileSync(filePath, line('t-2'));
    const realSetState = h.ledger.setState.bind(h.ledger);
    h.ledger.setState = (state) => {
      realSetState(state);
      throw new Error('simulated failure after the cursor commit');
    };
    await expect(collector.scan(h.ctx)).rejects.toThrow('simulated failure');
    h.ledger.setState = realSetState;
    expect(h.ledger.getState(filePath)?.offset).toBe(originalSize);
    expect(eventIds(h)).toEqual(['claude:t-1']);
    const resumed = await collector.scan(h.ctx);
    expect(resumed.bytesRead).toBe(Buffer.byteLength(line('t-2')));
    expect(h.ledger.getState(filePath)?.offset).toBe(fs.statSync(filePath).size);
    expect(eventIds(h)).toEqual(['claude:t-1', 'claude:t-2']);

    // Back to the confirmed identity in place (same inode), while the cursor row is past the end.
    fs.truncateSync(filePath, originalSize);
    fs.utimesSync(filePath, base, base);
    const rescan = await collector.scan(h.ctx);
    // The shrink is seen: the file is re-read from 0 and the cursor matches the file again.
    expect(rescan.bytesRead).toBe(originalSize);
    expect(h.ledger.getState(filePath)).toMatchObject({ size: originalSize, offset: originalSize, mtimeMs: base.getTime() });
    expect(eventIds(h)).toEqual(['claude:t-1', 'claude:t-2']);
  });
});
