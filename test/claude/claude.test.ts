import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeCollector,
  resolveClaudeRoots,
  readNewCompleteLines,
} from '../../src/collectors/claude.js';
import type { UsageEvent } from '../../src/core/types.js';
import { readClaudeHold } from '../../src/core/capture-holds.js';
import { safeIno } from '../../src/collectors/fswalk.js';
import { baseTestConfig, makeHarness, PROJECTS_ROOT, SYNC_VAULT_ROOT, type TestHarness } from './helpers.js';

function eventsBySessionId(events: UsageEvent[]): Map<string, UsageEvent[]> {
  const map = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const arr = map.get(e.sessionId) ?? [];
    arr.push(e);
    map.set(e.sessionId, arr);
  }
  return map;
}

/** All projected UsageEvent fields and activity row count for exact before/after comparison. */
function ledgerSnapshot(h: TestHarness): { events: UsageEvent[]; activityRows: number } {
  const events = [...h.ledger.getEvents({})].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { n } = h.db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number };
  return { events, activityRows: n };
}

describe('resolveClaudeRoots', () => {
  it('uses config.claude.roots verbatim when set, ignoring env/home entirely', () => {
    const cfg = baseTestConfig({ roots: ['/explicit/root'] });
    expect(resolveClaudeRoots(cfg, {}, '/home/x')).toEqual(['/explicit/root']);
  });

  it('defaults to $CLAUDE_CONFIG_DIR/projects when set', () => {
    const cfg = baseTestConfig({ roots: undefined });
    expect(resolveClaudeRoots(cfg, { CLAUDE_CONFIG_DIR: '/custom/claude-home' }, '/home/x')).toEqual([
      path.join('/custom/claude-home', 'projects'),
    ]);
  });

  it('defaults to ~/.claude/projects when CLAUDE_CONFIG_DIR is unset', () => {
    const cfg = baseTestConfig({ roots: undefined });
    expect(resolveClaudeRoots(cfg, {}, '/home/x')).toEqual([path.join('/home/x', '.claude', 'projects')]);
  });

  it('additionally includes ~/.config/claude/projects only when it exists on disk', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-roots-'));
    const alt = path.join(tmp, '.config', 'claude', 'projects');
    fs.mkdirSync(alt, { recursive: true });
    const cfg = baseTestConfig({ roots: undefined });
    const roots = resolveClaudeRoots(cfg, {}, tmp);
    expect(roots).toEqual([path.join(tmp, '.claude', 'projects'), alt]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('readNewCompleteLines', () => {
  it('never returns a trailing partial line, and reports the offset landing exactly on the last \\n', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-readlines-'));
    const file = path.join(tmp, 'f.jsonl');
    fs.writeFileSync(file, 'line1\nline2\nline3-partial-no-newline');
    const size = fs.statSync(file).size;
    const { lines, newOffset } = readNewCompleteLines(file, 0, size);
    expect(lines).toEqual(['line1', 'line2']);
    expect(newOffset).toBeLessThan(size); // the partial tail was NOT consumed
    expect(Buffer.byteLength('line1\nline2\n', 'utf8')).toBe(newOffset);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('ClaudeCollector.scan — end-to-end over the real, sanitized M4a-derived fixtures', () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  it('reports skip counts for the non-whitelisted stray file and the sync-conflict copy', async () => {
    h = makeHarness(baseTestConfig());
    const collector = new ClaudeCollector();
    const stats = await collector.scan(h.ctx);
    expect(stats.collector).toBe('claude');
    // 5 session files + 1 subagent file are whitelisted; notes.jsonl + the sync-conflict copy are not.
    expect(stats.filesScanned).toBe(6);
    expect(stats.filesSkipped).toBe(2);

    const skippedRows = h.db.prepare('SELECT path, reason FROM skipped').all() as {
      path: string;
      reason: string;
    }[];
    expect(skippedRows.find((r) => r.path.endsWith('notes.jsonl'))?.reason).toBe('not-whitelisted');
    expect(skippedRows.find((r) => r.path.includes('sync-conflict'))?.reason).toBe('sync-conflict');
  });

  it('the ryzen vault root yields zero events and zero files scanned', async () => {
    h = makeHarness(baseTestConfig({ roots: [SYNC_VAULT_ROOT] }));
    const collector = new ClaudeCollector();
    const stats = await collector.scan(h.ctx);
    expect(stats.filesScanned).toBe(0);
    expect(stats.eventsEmitted).toBe(0);
    expect(h.ledger.getEvents({})).toHaveLength(0);
  });

  it('skips the <synthetic> line entirely (no UsageEvent) but still records its activity mark', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    const events = h.ledger.getEvents({ sessionId: 'f5555555-5555-4555-8555-555555555555' });
    expect(events).toHaveLength(0);
    const marks = h.db
      .prepare('SELECT * FROM activity WHERE session_id = ?')
      .all('f5555555-5555-4555-8555-555555555555') as { uuid: string | null }[];
    expect(marks).toHaveLength(1);
    expect(marks[0]!.uuid).toBe('d40860f7-40e9-41b9-96ee-01db787356e0');
  });

  it('merges the growing-output streaming-snapshot duplicate (same message.id) via the store MAX-merge, never a sum or first-seen-wins', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    const events = h.ledger.getEvents({ sessionId: 'd1111111-1111-4111-8111-111111111111' });
    expect(events).toHaveLength(1); // both lines shared one message.id -> one row
    const e = events[0]!;
    expect(e.id).toBe('claude:msg_011Cdn6BqEcnHHgWrnxUV6VR');
    // Real values: line1 output=5, line2 output=144 (grew) -- MAX must be 144, never 5+144=149,
    // and never the first-seen 5.
    expect(e.tokens.output).toBe(144);
    expect(e.tokens.inputFresh).toBe(2);
    expect(e.tokens.cacheWrite5m).toBe(32674);
    expect(e.tokens.cacheWrite1h).toBe(0);
    expect(e.model).toBe('claude-sonnet-5');

    // Hand-computed (rates/prices.json claude-sonnet-5: in=2, cacheWrite5m=2.5, out=10 per 1e6):
    const expectedUsd = (2 * 2.0 + 32674 * 2.5 + 0 * 4.0 + 0 * 0.2 + 144 * 10.0) / 1e6;
    expect(e.apiEquivUsd).toBeCloseTo(expectedUsd, 10);
    // The reserved valuation fields of a new row are unknown, never zero.
    expect(e.reservedValue).toBeNull();
    expect(e.ucuRateStatus).toBe('NONE');
    expect(e.priceStatus).toBe('LIST');
    // Neither real line carries `output_tokens_details` at all (real M4a evidence: ~32% of lines
    // don't) and no content block is a thinking block -> not determinable, never guessed as false.
    expect(e.thinking).toBeNull();
    expect(e.flags).toContain('thinkingUnknown');
  });

  it('prices a Fable->Opus usage.iterations fallback as one component PER ITERATION, summed, not the top-level-only snapshot', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    const events = h.ledger.getEvents({ sessionId: 'c3333333-3333-4333-8333-333333333333' });
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.components).toHaveLength(2);
    expect(e.components[0]!.model).toBe('claude-fable-5-1');
    expect(e.components[1]!.model).toBe('claude-opus-4-8');
    expect(e.model).toBe('claude-opus-4-8'); // primary = last component's model

    // event totals = Σ iterations (DESIGN §15.1.3), never the top-level snapshot alone.
    expect(e.tokens).toEqual({
      inputFresh: 56 + 56,
      cacheWrite5m: 0,
      cacheWrite1h: 7615 + 0,
      cacheRead: 905579 + 906407,
      output: 303 + 6981,
      reasoning: 4683, // top-level thinking_tokens attributed to the LAST component only
      cacheWriteUnassigned: 0,
      cacheWriteAssumed1h: 0, // the fixture explicitly reports both TTL counters.
      countQuality: 'complete',
    });

    // Hand-computed per component (rates/prices.json):
    //   claude-fable-5-1: in=10, cacheWrite1h=20, cacheRead=0.25, out=50 (per 1e6)
    const usd0 = (56 * 10 + 7615 * 20 + 905579 * 0.25 + 303 * 50) / 1e6;
    //   claude-opus-4-8: in=5, cacheRead=0.5, out=25 (per 1e6)
    const usd1 = (56 * 5 + 906407 * 0.5 + 6981 * 25) / 1e6;
    expect(e.apiEquivUsd).toBeCloseTo(usd0 + usd1, 9);

    // The reserved valuation field of a new row is unknown, never zero.
    expect(e.reservedValue).toBeNull();
    // top-level output_tokens_details.thinking_tokens = 4683 > 0 -> verified thinking, no content block needed.
    expect(e.thinking).toBe(true);
    expect(e.flags).not.toContain('thinkingUnknown');

    // ── Mutation-guard evidence: "top-level-only pricing of an iterations message must fail" ──
    // Also demonstrated inline here (arithmetic, not calling the collector): pricing using ONLY
    // the top-level usage snapshot (model=claude-opus-4-8, the fallback's own fields) silently
    // drops the entire first (Fable) iteration's cost -- spikes-2026-09-26.md's critical finding.
    const topLevelOnlyUsd = (56 * 5 + 7615 * 10 + 906407 * 0.5 + 6981 * 25) / 1e6; // wrong: uses fallback rates for the 1h write too, and drops iteration 0 entirely
    expect(topLevelOnlyUsd).not.toBeCloseTo(e.apiEquivUsd!, 2);
    expect(topLevelOnlyUsd).toBeLessThan(e.apiEquivUsd!); // undercounts, matching the spike's finding

    // And actually applied to src/collectors/claude.ts in this session (not just the inline
    // arithmetic above): in `buildComponents`, `iterationsRaw` was hardcoded to `[]` (forcing the
    // top-level-usage-only branch even when `usage.iterations` is non-empty). Re-running
    // `npx vitest run test/claude/claude.test.ts` then failed exactly this test:
    //   "expected [ { model: 'claude-opus-4-8', ... } ] to have a length of 2 but got 1"
    // (only 1 component instead of 2 -- the Fable iteration silently vanished). 17/18 other tests
    // still passed, confirming the mutation was isolated to this one code path. Reverted with
    // `cp /tmp/claude.ts.bak src/collectors/claude.ts`; re-ran green (18/18, 31/31 for test/claude)
    // afterward.
  });

  it('local models (gemma4:26b, Qwen GGUF) served through Claude JSONL price at $0 and get provider=local + localViaClaudeJsonl', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    const events = h.ledger.getEvents({ sessionId: 'e4444444-4444-4444-8444-444444444444' });
    expect(events).toHaveLength(2);

    const gemma = events.find((e) => e.model === 'gemma4:26b')!;
    expect(gemma.provider).toBe('local');
    expect(gemma.flags).toContain('localViaClaudeJsonl');
    expect(gemma.apiEquivUsd).toBe(0);
    expect(gemma.priceStatus).toBe('LIST');
    // The reserved valuation fields of a new row are unknown, never zero.
    expect(gemma.reservedValue).toBeNull();
    expect(gemma.ucuRateStatus).toBe('NONE');
    // gemma's line carries output_tokens_details = {thinking_tokens: 0} (the field IS present, the
    // model just didn't reason this turn) -> verified non-thinking, not "unknown".
    expect(gemma.thinking).toBe(false);
    expect(gemma.flags).not.toContain('thinkingUnknown');

    const qwen = events.find((e) => e.model.includes('Qwen'))!;
    expect(qwen.provider).toBe('local');
    expect(qwen.flags).toContain('localViaClaudeJsonl');
    expect(qwen.apiEquivUsd).toBe(0);
    // The reserved valuation field of a new row is unknown, never zero.
    expect(qwen.reservedValue).toBeNull();
    // qwen's line has no output_tokens_details at all -> not determinable.
    expect(qwen.thinking).toBeNull();
    expect(qwen.flags).toContain('thinkingUnknown');
  });

  it('a subagent file is tagged isSubagent with parentSessionId = the <uuid> dir name from the path, and merges its own duplicate message.id', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    const events = h.ledger.getEvents({ sessionId: 'a1111111-1111-4111-8111-111111111111' });
    expect(events).toHaveLength(1); // 2 lines, identical message.id -> 1 row
    const e = events[0]!;
    expect(e.isSubagent).toBe(true);
    expect(e.parentSessionId).toBe('a1111111-1111-4111-8111-111111111111');
    expect(e.tokens.output).toBe(145);
    // Neither of this fixture's 2 duplicate lines carries output_tokens_details.
    expect(e.thinking).toBeNull();
    expect(e.flags).toContain('thinkingUnknown');
  });

  it('groups a resumed/forked session file by the sessionId FIELD, not by the file\'s own uuid name', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    // File is named a1234567-....jsonl, but its 3 lines carry 3 DIFFERENT sessionId values.
    const bySession = eventsBySessionId(h.ledger.getEvents({}));
    expect(bySession.has('1e14543c-6f9c-4d32-b458-c5cff032dba2')).toBe(true);
    expect(bySession.has('5edecbcf-29d5-48e7-9c2c-d00460aca456')).toBe(true);
    // The file's own uuid (a1234567-...) only had a <synthetic> line -> no event under it, but it
    // must never be treated as "the" session for the other two real usage lines in the same file.
    expect(bySession.has('a1234567-89ab-4cde-8f01-234567890abc')).toBe(false);
    expect(bySession.get('1e14543c-6f9c-4d32-b458-c5cff032dba2')).toHaveLength(1);
    expect(bySession.get('5edecbcf-29d5-48e7-9c2c-d00460aca456')).toHaveLength(1);
    // Both real lines carry a non-zero output_tokens_details.thinking_tokens (1592, 494).
    expect(bySession.get('1e14543c-6f9c-4d32-b458-c5cff032dba2')![0]!.thinking).toBe(true);
    expect(bySession.get('5edecbcf-29d5-48e7-9c2c-d00460aca456')![0]!.thinking).toBe(true);
  });

  it('records an ActivityMark for every line type with a timestamp, not just assistant lines', async () => {
    h = makeHarness(baseTestConfig());
    await new ClaudeCollector().scan(h.ctx);
    // The subagent fixture has 2 'user' lines (no usage) plus 2 duplicate-id 'assistant' lines.
    const marks = h.db
      .prepare('SELECT kind FROM activity WHERE session_id = ?')
      .all('a1111111-1111-4111-8111-111111111111') as { kind: string | null }[];
    expect(marks.filter((m) => m.kind === 'user')).toHaveLength(2);
    expect(marks.filter((m) => m.kind === 'assistant')).toHaveLength(2); // both lines marked (deduped by uuid, which differs per line)
  });

  it('thinking detection: a `thinking`/`redacted_thinking` content block is true even when output_tokens_details is entirely absent', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-thinking-block-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const line = (sessionId: string, msgId: string, contentTypes: string[]) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `u-${msgId}`,
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId,
        cwd: '/fixture/thinking-block',
        message: {
          id: msgId,
          model: 'claude-sonnet-5',
          content: contentTypes.map((t) => ({ type: t })),
          // Deliberately NO output_tokens_details at all — the content block alone must be enough.
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + '\n';
    const sThinking = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sRedacted = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    fs.writeFileSync(
      path.join(projDir, `${sThinking}.jsonl`),
      line(sThinking, 'msg-thinking', ['thinking', 'text'])
    );
    fs.writeFileSync(
      path.join(projDir, `${sRedacted}.jsonl`),
      line(sRedacted, 'msg-redacted', ['redacted_thinking'])
    );

    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    await new ClaudeCollector().scan(h.ctx);
    const thinkingEvent = h.ledger.getEvents({ sessionId: sThinking })[0]!;
    const redactedEvent = h.ledger.getEvents({ sessionId: sRedacted })[0]!;
    expect(thinkingEvent.thinking).toBe(true);
    expect(thinkingEvent.flags).not.toContain('thinkingUnknown');
    expect(redactedEvent.thinking).toBe(true);
    expect(redactedEvent.flags).not.toContain('thinkingUnknown');
    // MUTATION GUARD: if detectLineThinking only checked output_tokens_details (dropping the
    // content-block check entirely), both of the above would be `null` + `thinkingUnknown` instead
    // of `true` — this line's absent output_tokens_details is the whole point of the fixture.
  });

  it('incremental offsets: a second scan with no new bytes emits no new events; appending one line emits exactly one more', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-incremental-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    const lineFor = (msgId: string, output: number) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `u-${msgId}`,
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId,
        cwd: '/fixture/incremental',
        message: {
          id: msgId,
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + '\n';
    fs.writeFileSync(filePath, lineFor('msg-1', 5));

    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    const collector = new ClaudeCollector();

    const first = await collector.scan(h.ctx);
    expect(first.eventsEmitted).toBe(1);

    const second = await collector.scan(h.ctx);
    expect(second.eventsEmitted).toBe(0); // no new bytes -> nothing re-read
    expect(h.ledger.getEvents({})).toHaveLength(1);

    fs.appendFileSync(filePath, lineFor('msg-2', 7));
    const third = await collector.scan(h.ctx);
    expect(third.eventsEmitted).toBe(1);
    expect(h.ledger.getEvents({})).toHaveLength(2);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('a shrunk or inode-changed file is reparsed from offset 0 (dedup makes this idempotent)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-shrink-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    const line = (msgId: string, output: number) =>
      JSON.stringify({
        type: 'assistant',
        uuid: `u-${msgId}`,
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId,
        cwd: '/fixture/shrink',
        message: {
          id: msgId,
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + '\n';
    fs.writeFileSync(filePath, line('m1', 1) + line('m2', 2) + line('m3', 3));

    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    const collector = new ClaudeCollector();
    await collector.scan(h.ctx);
    expect(h.ledger.getEvents({})).toHaveLength(3);

    // Truncate to just the first line ("rotated" log) then write a brand-new set of lines --
    // simulating log rotation, which a naive offset-only reader would otherwise misread by
    // seeking past the new, shorter content.
    fs.writeFileSync(filePath, line('m4', 4));
    const rescan = await collector.scan(h.ctx);
    expect(rescan.eventsEmitted).toBe(1);
    const events = h.ledger.getEvents({});
    expect(events.map((e) => e.id).sort()).toEqual(
      ['claude:m1', 'claude:m2', 'claude:m3', 'claude:m4'].sort()
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('stores the bigint-stat safe ino (NTFS ids > 2^53, DESIGN §15.9.6); a legacy raw-NTFS-id state row is read, not thrown on, and triggers one idempotent re-read', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-ino-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant', uuid: 'u-i1', timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/ino',
        message: { id: 'ino-1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }) + '\n'
    );
    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    await new ClaudeCollector().scan(h.ctx);
    const expectedIno = safeIno(fs.statSync(filePath, { bigint: true }).ino);
    expect(h.ledger.getState(filePath)?.ino).toBe(expectedIno);

    // Simulate a row written by the old build on A2000: raw NTFS id (> 2^53) in the ino column.
    h.db.prepare('UPDATE ingest_state SET ino = ? WHERE key = ?').run(9851624185066820n, filePath);
    const rescan = await new ClaudeCollector().scan(h.ctx); // must not throw RangeError
    expect(rescan.filesScanned).toBe(1);
    expect(h.ledger.getEvents({})).toHaveLength(1); // re-read is idempotent (dedup by message id)
    expect(h.ledger.getState(filePath)?.ino).toBe(expectedIno);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('ino comes from the EXACT bigint stat (an odd NTFS id > 2^53 is not rounded by a lossy number stat)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-ino2-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const filePath = path.join(projDir, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl');
    fs.writeFileSync(filePath, '{}\n');
    const ODD = 9851624185066821n; // Number(ODD) rounds to …820 — a lossy number stat would differ
    const nativeAsyncStat = fs.promises.stat.bind(fs.promises);
    const asyncSpy = vi.spyOn(fs.promises, 'stat').mockImplementation((...args) => Reflect.apply(nativeAsyncStat, fs.promises, args).then((st: fs.Stats | fs.BigIntStats) => String(args[0]) !== filePath ? st : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: args[1]?.bigint ? ODD : Number(ODD) })));
    const realStat = fs.statSync;
    const realFStat = fs.fstatSync;
    const physicalIno = realStat(filePath, { bigint: true }).ino;
    const fdSpy = vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, o?: fs.StatSyncOptions) => {
      const st = realFStat(fd, o as never) as fs.Stats | fs.BigIntStats;
      if (!(o as { bigint?: boolean } | undefined)?.bigint || st.ino !== physicalIno) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: ODD });
    }) as typeof fs.fstatSync);
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      const st = realStat(p, o as never) as fs.Stats | fs.BigIntStats;
      if (String(p) !== filePath) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
        ino: (o as { bigint?: boolean } | undefined)?.bigint ? ODD : Number(ODD),
      });
    }) as typeof fs.statSync);
    try {
      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      await new ClaudeCollector().scan(h.ctx);
      expect(h.ledger.getState(filePath)?.ino).toBe(safeIno(ODD)); // 844424930325830
      expect(safeIno(ODD)).toBe(844424930325830);
      expect(asyncSpy.mock.calls.some(([p, options]) => String(p) === filePath && options?.bigint === true)).toBe(true);
      expect(fdSpy.mock.calls.some(([, options]) => (options as { bigint?: boolean } | undefined)?.bigint)).toBe(true);
    } finally {
      spy.mockRestore(); asyncSpy.mockRestore();
      fdSpy.mockRestore();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── Cache-split-assumed / speed-assumed flags (constructed edge cases; the required real-
  // fixture scenarios above all happened to carry an explicit cache_creation split and an
  // explicit speed field, so these two flags need a minimal synthetic line each to exercise). ──
  it('cache_creation split missing -> all treated as 1h writes, cacheSplitAssumed:true (DESIGN §15.1.4)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cachesplit-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-split',
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId,
        cwd: '/fixture/split',
        message: {
          id: 'msg-split',
          model: 'claude-sonnet-5',
          // No `cache_creation` split object at all -- only the flat field.
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 0 },
        },
      }) + '\n'
    );
    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    await new ClaudeCollector().scan(h.ctx);
    const [e] = h.ledger.getEvents({});
    expect(e!.tokens.cacheWrite1h).toBe(1000);
    expect(e!.tokens.cacheWrite5m).toBe(0);
    expect(e!.flags).toContain('cacheSplitAssumed');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('speed missing -> standard, speedAssumed:true', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-speed-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-speed',
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId,
        cwd: '/fixture/speed',
        message: {
          id: 'msg-speed',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, // no `speed` key
        },
      }) + '\n'
    );
    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    await new ClaudeCollector().scan(h.ctx);
    const [e] = h.ledger.getEvents({});
    expect(e!.speed).toBe('standard');
    expect(e!.flags).toContain('speedAssumed');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });


  it('clamps thinking_tokens to output and records reasoningClamped when it exceeds output (DESIGN §15.1.5)', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-reasoning-clamp-'));
    const projDir = path.join(tmpRoot, '-fixture-reasoning-clamp');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'f1111111-1111-4111-8111-111111111111';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-reasoning-clamp',
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId,
        cwd: '/fixture/reasoning-clamp',
        message: {
          id: 'msg-reasoning-clamp',
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            cache_read_input_tokens: 0,
            output_tokens_details: { thinking_tokens: 9 },
          },
        },
      }) + '\n'
    );
    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    try {
      await new ClaudeCollector().scan(h.ctx);
      const events = h.ledger.getEvents({});
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e.speed).toBe('standard');
      expect(e.flags).toContain('speedAssumed');
      expect(e.tokens.output).toBe(5);
      expect(e.tokens.reasoning).toBe(5);
      expect(e.components[0]!.tokens.reasoning).toBe(5);
      expect(e.flags).toContain('reasoningClamped');
      expect(e.thinking).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('counts an sdk-* Claude JSONL turn once and does not add ~/.example-agent/spend.jsonl (DESIGN §15.1.7)', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-sdk-home-'));
    const claudeRoot = path.join(tmpHome, '.claude', 'projects');
    const projDir = path.join(claudeRoot, '-fixture-sdk-project');
    const otherAgentDir = path.join(tmpHome, '.example-agent');
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(otherAgentDir, { recursive: true });
    const sessionId = 'a2222222-2222-4222-8222-222222222222';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    const otherAgentSpendPath = path.join(otherAgentDir, 'spend.jsonl');
    fs.writeFileSync(
      otherAgentSpendPath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-other-agent-decoy',
        timestamp: '2026-09-01T00:00:00.000Z',
        sessionId: 'b3333333-3333-4333-8333-333333333333',
        cwd: '/fixture/other-agent',
        entrypoint: 'sdk-decoy',
        message: {
          id: 'other-agent-spend-should-not-be-counted',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 999, output_tokens: 999, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }) + '\n'
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'assistant',
        uuid: 'u-sdk-turn',
        timestamp: '2026-09-01T00:01:00.000Z',
        sessionId,
        cwd: '/fixture/sdk',
        entrypoint: 'sdk-agent',
        message: {
          id: 'msg-sdk-turn',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, speed: 'standard' },
        },
      }) + '\n'
    );
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    const config = baseTestConfig({ roots: undefined });
    h = makeHarness(config);
    try {
      expect(resolveClaudeRoots(config)).toEqual([claudeRoot]);
      await new ClaudeCollector().scan(h.ctx);
      const events = h.ledger.getEvents({});
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe('claude:msg-sdk-turn');
      expect(events[0]!.source).toBe('claude');
      expect(events[0]!.entrypoint).toBe('sdk-agent');
      expect(events[0]!.sessionId).toBe(sessionId);
      expect(events.some((event) => event.id === 'claude:other-agent-spend-should-not-be-counted')).toBe(false);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('a malformed JSONL line never leaks its raw text (or the parse error message) into warnings or logs', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-parseerr-'));
    const projDir = path.join(tmpRoot, '-fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    // Deliberately invalid JSON that embeds a marker standing in for sensitive prompt/response text.
    // `String(err)`/`err.message` from V8's JSON.parse on this line includes the marker (e.g.
    // `SyntaxError: Unexpected token o in JSON at position 5, "...SECRET_PROMPT_TOKEN_XYZZY..."`).
    const marker = 'SECRET_PROMPT_TOKEN_XYZZY';
    fs.writeFileSync(filePath, `{"type":"assistant","message":{"usage":SECRET_PROMPT_TOKEN_XYZZY BROKEN JSON HERE\n`);

    h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
    const stats = await new ClaudeCollector().scan(h.ctx);

    // The warning/log must still fire -- the failure is never silently swallowed.
    expect(stats.warnings.some((w) => w.includes(filePath))).toBe(true);
    const warnLog = h.logs.find((l) => l.msg === 'claude: line parse error');
    expect(warnLog).toBeDefined();

    // Nothing beyond path + error name may appear: the marker must never leak, and the recorded
    // detail must be the bare error name, not `String(err)`/`err.message` (which, depending on the
    // engine, may embed a snippet of the offending line -- including the marker above).
    const warning = stats.warnings.find((w) => w.includes(filePath))!;
    expect(warning).toBe(`parse error in ${filePath}: SyntaxError`);
    expect(warnLog!.data).toEqual({ path: filePath, error: 'SyntaxError' });

    for (const w of stats.warnings) expect(w).not.toContain(marker);
    for (const l of h.logs) expect(JSON.stringify(l)).not.toContain(marker);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});

describe('ClaudeCollector.scan — large backlog is read in bounded windows', () => {
  let h: TestHarness;
  afterEach(() => h?.close());

  /** ~5 MB transcript: 1,000 ordinary messages plus one line just over a read window. */
  function writeBacklog(tmpRoot: string): { filePath: string; expectedEvents: number } {
    const projDir = path.join(tmpRoot, '-fixture-backlog');
    fs.mkdirSync(projDir, { recursive: true });
    const sessionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const filePath = path.join(projDir, `${sessionId}.jsonl`);
    const lines: string[] = [];
    const assistant = (i: number, padChars: number): string =>
      JSON.stringify({
        type: 'assistant', uuid: `u-w${i}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/backlog',
        pad: 'x'.repeat(padChars),
        message: { id: `win-${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      });
    for (let i = 0; i < 1000; i++) lines.push(assistant(i, 256));
    // Keep the line over 4 MiB so it crosses a read-window seam, but avoid spending
    // the whole default 5-second test budget on padding rather than the seam behavior.
    lines.splice(500, 0, assistant(9000, 4 * 1024 * 1024 + 1));
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
    return { filePath, expectedEvents: 1001 };
  }

  it('ingests every line exactly once across the read-window seam, including a line longer than one window', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-backlog-'));
    try {
      const { filePath, expectedEvents } = writeBacklog(tmpRoot);
      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      const stats = await new ClaudeCollector().scan(h.ctx);
      expect(stats.warnings).toEqual([]);
      expect(stats.bytesRead).toBe(fs.statSync(filePath).size);
      expect(h.ledger.getEvents({})).toHaveLength(expectedEvents);
      expect(h.ledger.getState(filePath)?.offset).toBe(fs.statSync(filePath).size);

      // A second scan of the unchanged file reads nothing and changes no ledger content.
      const before = ledgerSnapshot(h);
      const second = await new ClaudeCollector().scan(h.ctx);
      expect(second.bytesRead).toBe(0);
      expect(second.eventsEmitted).toBe(0);
      assert.deepStrictEqual(ledgerSnapshot(h), before);

      // Replaying the whole file from offset 0 (a crash before the checkpoint) re-parses every line
      // but must leave the ledger identical: upserts merge by message id, activity dedups.
      h.db.prepare('UPDATE ingest_state SET offset = 0 WHERE key = ?').run(filePath);
      const replay = await new ClaudeCollector().scan(h.ctx);
      expect(replay.eventsEmitted).toBe(expectedEvents);
      expect(h.ledger.getState(filePath)?.offset).toBe(fs.statSync(filePath).size);
      assert.deepStrictEqual(ledgerSnapshot(h), before);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('yields to the event loop between windows, so the API can be served during a backlog scan', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-yield-'));
    try {
      writeBacklog(tmpRoot);
      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      // A synchronous scan never returns to the event loop, so this counter stays at 0 until it ends.
      let spins = 0;
      let running = true;
      const spin = (): void => {
        if (!running) return;
        spins++;
        setImmediate(spin);
      };
      spin();
      await new ClaudeCollector().scan(h.ctx);
      running = false;
      expect(spins).toBeGreaterThan(2);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('holds a file at an over-cap line: earlier data and offset survive repeated scans, and recovery resumes there', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-overcap-'));
    try {
      const projDir = path.join(tmpRoot, '-fixture-overcap');
      fs.mkdirSync(projDir, { recursive: true });
      const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const filePath = path.join(projDir, `${sessionId}.jsonl`);
      const line = (id: string, padChars: number): string =>
        JSON.stringify({
          type: 'assistant', uuid: `u-${id}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/overcap',
          pad: 'x'.repeat(padChars),
          message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        });
      const MiB = 1024 * 1024;
      const beforeLine = line('before', 10) + '\n';
      fs.writeFileSync(filePath, beforeLine + line('oversize', 9 * MiB) + '\n' + line('after', 10) + '\n');
      const heldAt = Buffer.byteLength(beforeLine);
      const heldText = `incomplete capture: line longer than ${8 * MiB} bytes at offset ${heldAt}; file held, later records not ingested: ${filePath}`;

      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      const collector = new ClaudeCollector({ maxLineBytes: 8 * MiB });

      // Scan 1: the line before the cap is ingested; the file stops at the over-cap line.
      const s1 = await collector.scan(h.ctx);
      expect(h.ledger.getEvents({})).toHaveLength(1);
      expect(h.ledger.getState(filePath)?.offset).toBe(heldAt);
      expect(s1.warnings).toEqual([heldText]);
      const held = ledgerSnapshot(h);

      // Scan 2, unchanged file: same data, same offset, warning repeated (not dropped as "quiet").
      const s2 = await collector.scan(h.ctx);
      expect(s2.warnings).toEqual([heldText]);
      expect(s2.bytesRead).toBe(0);
      expect(ledgerSnapshot(h)).toEqual(held);
      expect(h.ledger.getState(filePath)?.offset).toBe(heldAt);

      // Scan 3, a later record is appended behind the held line: still held, nothing behind it ingested.
      fs.appendFileSync(filePath, line('later', 10) + '\n');
      const s3 = await collector.scan(h.ctx);
      expect(s3.warnings).toEqual([heldText]);
      expect(ledgerSnapshot(h)).toEqual(held);
      expect(h.ledger.getState(filePath)?.offset).toBe(heldAt);

      // Recovery: raising the cap (config claude.maxLineBytes, then restart) resumes at the held
      // offset and ingests the held line and every record behind it. Nothing is re-read or lost.
      const s4 = await new ClaudeCollector({ maxLineBytes: 16 * MiB }).scan(h.ctx);
      expect(s4.warnings).toEqual([]);
      expect(h.ledger.getEvents({})).toHaveLength(4); // before, oversize, after, later
      expect(h.ledger.getState(filePath)?.offset).toBe(fs.statSync(filePath).size);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  describe('held file identity', () => {
    const MiB = 1024 * 1024;
    const cap = 8 * MiB;
    const sessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const line = (id: string, padChars: number): string =>
      JSON.stringify({
        type: 'assistant', uuid: `u-${id}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/held',
        pad: 'x'.repeat(padChars),
        message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      });
    const oversize = line('oversize', 9 * MiB) + '\n';
    const size = Buffer.byteLength(oversize);
    /** Eligible replacement with exactly the same byte size as the held oversize file: two small lines. */
    const replacement = (() => {
      const half = Math.floor(size / 2);
      const a = line('replA', half - 1 - Buffer.byteLength(line('replA', 0))) + '\n';
      const b = line('replB', size - half - 1 - Buffer.byteLength(line('replB', 0))) + '\n';
      return a + b;
    })();

    it('recovers after a same-size in-place rewrite (mtime changed, same inode)', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-heldrewrite-'));
      try {
        const projDir = path.join(tmpRoot, '-fixture-held');
        fs.mkdirSync(projDir, { recursive: true });
        const filePath = path.join(projDir, `${sessionId}.jsonl`);
        fs.writeFileSync(filePath, oversize);
        h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
        const collector = new ClaudeCollector({ maxLineBytes: cap });
        const held = await collector.scan(h.ctx);
        expect(held.warnings).toHaveLength(1);

        fs.writeFileSync(filePath, replacement); // same size, same path, same inode
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(filePath, later, later);
        expect(fs.statSync(filePath).size).toBe(size);

        const recovered = await collector.scan(h.ctx);
        expect(recovered.warnings).toEqual([]);
        expect(h.ledger.getEvents({})).toHaveLength(2); // replA, replB
        expect(h.ledger.getState(filePath)?.offset).toBe(size);
        expect(readClaudeHold(h.ledger.getState(filePath)?.extra)).toBeNull(); // hold cleared with the identity change
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });

    it('recovers after a same-size replacement by rename, with the original mtime preserved (only the inode differs)', async () => {
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-heldrename-'));
      try {
        const projDir = path.join(tmpRoot, '-fixture-held');
        fs.mkdirSync(projDir, { recursive: true });
        const filePath = path.join(projDir, `${sessionId}.jsonl`);
        fs.writeFileSync(filePath, oversize);
        // Whole-second mtime: representable exactly on both sides, so the preserved value compares equal.
        const base = new Date(1_700_000_000_000);
        fs.utimesSync(filePath, base, base);
        h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
        const collector = new ClaudeCollector({ maxLineBytes: cap });
        await collector.scan(h.ctx);
        const oldIno = safeIno(fs.statSync(filePath, { bigint: true }).ino);

        const tmp = `${filePath}.replacement`;
        fs.writeFileSync(tmp, replacement);
        fs.utimesSync(tmp, base, base);
        fs.renameSync(tmp, filePath);
        const after = fs.statSync(filePath);
        expect(after.size).toBe(size);
        expect(after.mtimeMs).toBe(base.getTime()); // identity differs only by inode
        expect(safeIno(fs.statSync(filePath, { bigint: true }).ino)).not.toBe(oldIno);

        const recovered = await collector.scan(h.ctx);
        expect(recovered.warnings).toEqual([]);
        expect(h.ledger.getEvents({})).toHaveLength(2);
        expect(h.ledger.getState(filePath)?.offset).toBe(size);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });

  it('a persisted hold survives a restart with its heldSince, and recovery clears the marker', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-persisthold-'));
    try {
      const MiB = 1024 * 1024;
      const sessionId = 'abababab-abab-4aba-8aba-abababababab';
      const line = (id: string, padChars: number): string =>
        JSON.stringify({
          type: 'assistant', uuid: `u-${id}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/persist',
          pad: 'x'.repeat(padChars),
          message: { id, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        });
      const projDir = path.join(tmpRoot, '-fixture-persist');
      fs.mkdirSync(projDir, { recursive: true });
      const filePath = path.join(projDir, `${sessionId}.jsonl`);
      const oversize = line('oversize', 9 * MiB) + '\n';
      fs.writeFileSync(filePath, line('before', 10) + '\n' + oversize + line('after', 10) + '\n');
      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));

      await new ClaudeCollector({ maxLineBytes: 8 * MiB }).scan(h.ctx);
      const first = readClaudeHold(h.ledger.getState(filePath)?.extra);
      expect(first).toEqual({ heldSince: expect.any(Number), maxLineBytes: 8 * MiB, prefixSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

      // A new collector instance (a restart) reads the persisted hold: reported again, nothing re-read.
      const restarted = await new ClaudeCollector({ maxLineBytes: 8 * MiB }).scan(h.ctx);
      expect(restarted.bytesRead).toBe(0);
      expect(restarted.warnings).toHaveLength(1);
      expect(readClaudeHold(h.ledger.getState(filePath)?.extra)).toEqual(first);

      // Raising the cap re-checks the file, ingests the held line and everything behind it, and clears the marker.
      const recovered = await new ClaudeCollector({ maxLineBytes: 16 * MiB }).scan(h.ctx);
      expect(recovered.warnings).toEqual([]);
      expect(h.ledger.getEvents({})).toHaveLength(3);
      expect(readClaudeHold(h.ledger.getState(filePath)?.extra)).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // Fixture-scale budget, not API latency: this test writes 1,000 transcript files and runs an ingest scan plus an
  // unchanged scan. It takes about 1.4 s alone and exceeded vitest's default 5 s under full-suite contention.
  it('an unchanged inventory is scanned in batches that yield to the event loop', { timeout: 30_000 }, async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-inventory-'));
    try {
      const FILES = 1000;
      for (let p = 0; p < 4; p++) {
        const projDir = path.join(tmpRoot, `-fixture-inventory-${p}`);
        fs.mkdirSync(projDir, { recursive: true });
        for (let i = 0; i < FILES / 4; i++) {
          const sessionId = `00000000-0000-4000-8000-${String(p * 1000 + i).padStart(12, '0')}`;
          fs.writeFileSync(
            path.join(projDir, `${sessionId}.jsonl`),
            JSON.stringify({
              type: 'assistant', uuid: `u-${sessionId}`, timestamp: '2026-09-01T00:00:00.000Z', sessionId, cwd: '/fixture/inv',
              message: { id: `inv-${sessionId}`, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
            }) + '\n'
          );
        }
      }
      h = makeHarness(baseTestConfig({ roots: [tmpRoot] }));
      await new ClaudeCollector().scan(h.ctx); // first scan ingests everything

      // Second scan: every file is unchanged. A synchronous stat loop would never return to the loop.
      let spins = 0;
      let running = true;
      const spin = (): void => {
        if (!running) return;
        spins++;
        setImmediate(spin);
      };
      spin();
      const before = ledgerSnapshot(h);
      const second = await new ClaudeCollector().scan(h.ctx);
      running = false;
      expect(second.filesScanned).toBe(FILES);
      expect(second.bytesRead).toBe(0);
      expect(ledgerSnapshot(h)).toEqual(before);
      expect(spins).toBeGreaterThanOrEqual(FILES / 200);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
