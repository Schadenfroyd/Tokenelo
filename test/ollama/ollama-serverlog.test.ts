import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLine,
  parseGinTimestamp,
  canonicalizeLogModelName,
  parseServerLogLines,
  initialServerLogState,
  isDoubleCounted,
  buildServerLogUsageEvent,
  tailServerLog,
  type ProxyEventForGuard,
} from '../../src/collectors/ollama-serverlog.js';

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'ollama');
// Real slice of /opt/homebrew/var/log/ollama.log captured on M4a 2026-09-26 (sanitized: the
// original capture window happened to include a full chat-template dump with real prompt/
// response text on lines 1-16 of the raw tail; those lines were removed entirely before this
// fixture was committed — verified zero matches for <|im_start|>/<|im_end|>/prompt or response
// text anywhere in this file. What remains is pure structural log lines: srv/slot debug chatter,
// template-selection, print_timing, and GIN access-log lines.)
const REAL_LOG_SLICE = fs.readFileSync(path.join(FIXTURES, 'serverlog-slice-homebrew.log'), 'utf8');

const DENVER_OFFSET_MINUTES = -360; // America/Denver, MDT, verified against real created_at timestamps in log-formats.md

describe('parseLine', () => {
  it('parses a [GIN] access-log line (real captured line)', () => {
    const parsed = parseLine('[GIN] 2026/09/26 - 17:11:34 | 200 | 12.723664208s |       127.0.0.1 | POST     "/api/chat"', {
      tzOffsetMinutes: DENVER_OFFSET_MINUTES,
    });
    expect(parsed).toEqual({
      kind: 'gin',
      ts: Date.UTC(2026, 8, 26, 23, 11, 34),
      statusCode: 200,
      durationMs: 12723.664208,
      method: 'POST',
      path: '/api/chat',
    });
  });

  it('parses microsecond and millisecond GIN durations correctly', () => {
    const us = parseLine('[GIN] 2026/09/26 - 16:17:47 | 200 |    3.147416ms |       127.0.0.1 | HEAD     "/"', {
      tzOffsetMinutes: DENVER_OFFSET_MINUTES,
    });
    expect(us?.kind).toBe('gin');
    expect((us as { durationMs: number }).durationMs).toBeCloseTo(3.147416, 5);

    const micro = parseLine('[GIN] 2026/09/26 - 16:17:47 | 200 |       1.927ms |       127.0.0.1 | GET      "/api/ps"', {
      tzOffsetMinutes: DENVER_OFFSET_MINUTES,
    });
    expect((micro as { durationMs: number }).durationMs).toBeCloseTo(1.927, 3);
  });

  it('parses a "loading model via llama-server" line and extracts the blob sha (real shape)', () => {
    const parsed = parseLine(
      'time=2026-09-26T15:39:42.982-06:00 level=INFO source=llama_server.go:1046 msg="loading model via llama-server" model=/Users/example/.ollama/models/blobs/sha256-dfd98d2734212d0c128e128e5d88edac764aaa4f4af2f4c196941f2354aab8da'
    );
    expect(parsed).toEqual({
      kind: 'load',
      ts: Date.parse('2026-09-26T15:39:42.982-06:00'),
      blobSha: 'dfd98d2734212d0c128e128e5d88edac764aaa4f4af2f4c196941f2354aab8da',
    });
  });

  it('parses a "template selection" line and canonicalizes the model name (real shape)', () => {
    const parsed = parseLine(
      'time=2026-09-26T15:40:14.898-06:00 level=INFO source=images.go:374 msg="template selection" model=registry.ollama.ai/library/gemma4:26b selected=renderer_parser'
    );
    expect(parsed).toEqual({
      kind: 'template',
      ts: Date.parse('2026-09-26T15:40:14.898-06:00'),
      model: 'gemma4:26b',
    });
  });

  it('parses the three print_timing lines this module cares about, ignoring "graphs reused"/"draft acceptance"/"acc per pos"', () => {
    expect(
      parseLine('slot print_timing: id  0 | task 6 | prompt eval time =     179.18 ms /    18 tokens (    9.95 ms per token,   100.46 tokens per second)')
    ).toEqual({ kind: 'prompt-eval', taskId: 6, ms: 179.18, tokens: 18 });
    expect(
      parseLine('slot print_timing: id  0 | task 6 |        eval time =     341.26 ms /    16 tokens (   21.33 ms per token,    46.88 tokens per second)')
    ).toEqual({ kind: 'eval', taskId: 6, ms: 341.26, tokens: 16 });
    expect(parseLine('slot print_timing: id  0 | task 6 |       total time =     520.44 ms /    34 tokens')).toEqual({
      kind: 'total',
      taskId: 6,
      ms: 520.44,
      tokens: 34,
    });
    expect(parseLine('slot print_timing: id  0 | task 6 |    graphs reused =          7')).toBeNull();
    expect(
      parseLine('slot print_timing: id  0 | task 6 | draft acceptance = 0.66667 (   10 accepted /    15 generated), mean len =  3.00')
    ).toBeNull();
    expect(parseLine('slot print_timing: id  0 | task 6 |      acc per pos = (1.000, 0.600, 0.400)')).toBeNull();
  });

  it('returns null for any other structural noise line (srv/slot debug chatter)', () => {
    expect(parseLine('srv  update_slots: all slots are idle')).toBeNull();
    expect(parseLine('slot launch_slot_: id  0 | task 0 | processing task, is_child = 0')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

describe('canonicalizeLogModelName', () => {
  it('drops the default registry.ollama.ai/library prefix (verified real value)', () => {
    expect(canonicalizeLogModelName('registry.ollama.ai/library/gemma4:26b')).toBe('gemma4:26b');
  });

  it('keeps a non-default registry/namespace verbatim (verified real value)', () => {
    expect(canonicalizeLogModelName('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL')).toBe(
      'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL'
    );
  });
});

describe('parseServerLogLines against a real sanitized log slice', () => {
  it('attributes both requests to the Qwen model from the single template-selection line, with correct prompt/eval counts and GIN-derived end time/duration', () => {
    const state = initialServerLogState();
    const blocks = parseServerLogLines(REAL_LOG_SLICE.split('\n'), state, new Map(), {
      tzOffsetMinutes: DENVER_OFFSET_MINUTES,
    });
    expect(blocks).toHaveLength(2);

    expect(blocks[0]).toEqual({
      model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      promptEvalCount: 54,
      evalCount: 8,
      totalMs: 2567.09,
      endTs: Date.UTC(2026, 8, 26, 23, 11, 34),
      durationMs: 12723.664208,
      path: '/api/chat',
    });

    expect(blocks[1]).toEqual({
      model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      promptEvalCount: 4,
      evalCount: 8,
      totalMs: 1136.53,
      endTs: Date.UTC(2026, 8, 26, 23, 11, 35),
      durationMs: 1300.145958,
      path: '/v1/chat/completions',
    });
  });

  it('resolves the model via blob-sha manifest lookup when no template-selection line is seen (fallback path)', () => {
    const state = initialServerLogState();
    const manifestMap = new Map([['abc123def', 'gemma4:26b']]);
    const lines = [
      'time=2026-09-26T15:39:42.982-06:00 level=INFO source=llama_server.go:1046 msg="loading model via llama-server" model=/Users/example/.ollama/models/blobs/sha256-abc123def',
      'slot print_timing: id  0 | task 0 | prompt eval time =     100.00 ms /    10 tokens (10.00 ms per token, 100.00 tokens per second)',
      'slot print_timing: id  0 | task 0 |        eval time =     100.00 ms /     5 tokens (20.00 ms per token, 50.00 tokens per second)',
      'slot print_timing: id  0 | task 0 |       total time =     200.00 ms /    15 tokens',
      '[GIN] 2026/09/26 - 15:39:45 | 200 |  300ms |       127.0.0.1 | POST     "/api/generate"',
    ];
    const blocks = parseServerLogLines(lines, state, manifestMap, { tzOffsetMinutes: DENVER_OFFSET_MINUTES });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].model).toBe('gemma4:26b');
    expect(blocks[0].promptEvalCount).toBe(10);
    expect(blocks[0].evalCount).toBe(5);
  });

  it('template-selection line wins over a stale blob-sha mapping when both are present (most recent wins)', () => {
    const state = initialServerLogState();
    const manifestMap = new Map([['abc123def', 'gemma4:26b']]);
    const lines = [
      'time=2026-09-26T15:39:42.982-06:00 level=INFO source=llama_server.go:1046 msg="loading model via llama-server" model=/Users/example/.ollama/models/blobs/sha256-abc123def',
      'time=2026-09-26T15:39:43.000-06:00 level=INFO source=images.go:374 msg="template selection" model=hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL selected=x',
      'slot print_timing: id  0 | task 0 | prompt eval time =     100.00 ms /    10 tokens (10.00 ms per token, 100.00 tokens per second)',
      'slot print_timing: id  0 | task 0 |        eval time =     100.00 ms /     5 tokens (20.00 ms per token, 50.00 tokens per second)',
      'slot print_timing: id  0 | task 0 |       total time =     200.00 ms /    15 tokens',
      '[GIN] 2026/09/26 - 15:39:45 | 200 |  300ms |       127.0.0.1 | POST     "/api/generate"',
    ];
    const blocks = parseServerLogLines(lines, state, manifestMap, { tzOffsetMinutes: DENVER_OFFSET_MINUTES });
    expect(blocks[0].model).toBe('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL');
  });

  it('never attributes a non-metered-path GIN line (e.g. /api/ps) as a request block', () => {
    const state = initialServerLogState();
    const lines = [
      'slot print_timing: id  0 | task 0 | prompt eval time =     100.00 ms /    10 tokens (10.00 ms per token, 100.00 tokens per second)',
      'slot print_timing: id  0 | task 0 |        eval time =     100.00 ms /     5 tokens (20.00 ms per token, 50.00 tokens per second)',
      'slot print_timing: id  0 | task 0 |       total time =     200.00 ms /    15 tokens',
      '[GIN] 2026/09/26 - 16:17:47 | 200 |    1.927ms |       127.0.0.1 | GET      "/api/ps"',
    ];
    const blocks = parseServerLogLines(lines, state, new Map(), { tzOffsetMinutes: DENVER_OFFSET_MINUTES });
    expect(blocks).toHaveLength(0);
    // the pending block must still be sitting there, ready for the NEXT metered GIN line
    expect(state.pendingPromptTokens).toBe(10);
  });

  it('skips a metered-path GIN line with nothing pending (best-effort, never throws)', () => {
    const state = initialServerLogState();
    const lines = ['[GIN] 2026/09/26 - 16:17:47 | 200 |    1.927ms |       127.0.0.1 | POST      "/api/chat"'];
    expect(() => parseServerLogLines(lines, state, new Map(), { tzOffsetMinutes: DENVER_OFFSET_MINUTES })).not.toThrow();
    expect(parseServerLogLines(lines, state, new Map(), { tzOffsetMinutes: DENVER_OFFSET_MINUTES })).toHaveLength(0);
  });
});

// ── Double-count guard (DESIGN §15.3.4) + MUTATION TEST ─────────────────────
describe('isDoubleCounted', () => {
  const block = { evalCount: 8, endTs: 1_000_000 };

  it('drops when a proxy event has the SAME eval_count within the ±2s window', () => {
    const proxyEvents: ProxyEventForGuard[] = [{ evalCount: 8, endTs: 1_000_000 + 1500 }];
    expect(isDoubleCounted(block, proxyEvents)).toBe(true);
  });

  it('keeps when eval_count differs, even at the exact same timestamp', () => {
    const proxyEvents: ProxyEventForGuard[] = [{ evalCount: 9, endTs: 1_000_000 }];
    expect(isDoubleCounted(block, proxyEvents)).toBe(false);
  });

  it('keeps when eval_count matches but the time delta exceeds the window', () => {
    const proxyEvents: ProxyEventForGuard[] = [{ evalCount: 8, endTs: 1_000_000 + 2001 }];
    expect(isDoubleCounted(block, proxyEvents)).toBe(false);
  });

  it('keeps exactly at the ±2000ms boundary (inclusive)', () => {
    expect(isDoubleCounted(block, [{ evalCount: 8, endTs: 1_000_000 + 2000 }])).toBe(true);
    expect(isDoubleCounted(block, [{ evalCount: 8, endTs: 1_000_000 - 2000 }])).toBe(true);
  });

  it('keeps when there are no proxy events at all', () => {
    expect(isDoubleCounted(block, [])).toBe(false);
  });
  it('ignores matching counts and timestamps from separately configured proxy engines', () => {
    for (const engine of ['vllm', 'docker-model-runner']) {
      expect(isDoubleCounted(block, [{ evalCount: 8, endTs: 1_000_000, engine }])).toBe(false);
    }
  });

  it('matches the primary Ollama engine and preserves legacy rows with no engine field', () => {
    expect(isDoubleCounted(block, [{ evalCount: 8, endTs: 1_000_000, engine: 'ollama' }])).toBe(true);
    expect(isDoubleCounted(block, [{ evalCount: 8, endTs: 1_000_000 }])).toBe(true);
  });


  // MUTATION TEST 1: reintroduce the OLD §4.4 guard ("prompt AND eval must both match, ±3s") —
  // it must fail to drop a real cache-hit case where the log's prompt count (uncached-only, per
  // llama.cpp) disagrees with the proxy's prompt_eval_count (includes cached tokens), even though
  // eval_count and timing agree — proving the *current* two-field guard is necessary.
  it('MUTATION: the old prompt+eval±3s guard would double-count a cache-hit case; the new eval-only±2s guard does not', () => {
    // Real-shaped scenario: proxy sees prompt_eval_count=18 (includes 13 cached), log sees only
    // the 5 uncached tokens it actually evaluated — same request, same eval_count, ~0.5s apart.
    const logBlock = { evalCount: 8, endTs: 1_000_000 };
    const proxyEvent = { evalCount: 8, endTs: 1_000_500 };
    // Current (correct) guard: drops it.
    expect(isDoubleCounted(logBlock, [proxyEvent])).toBe(true);

    // Simulated OLD guard (prompt_eval_count must ALSO match): would NOT drop it, because the
    // log's own uncached-only prompt count (5) never equals the proxy's cache-inclusive count (18).
    const oldGuard = (a: { promptCount: number; evalCount: number; endTs: number }, b: { promptCount: number; evalCount: number; endTs: number }) =>
      a.promptCount === b.promptCount && a.evalCount === b.evalCount && Math.abs(a.endTs - b.endTs) <= 3000;
    expect(oldGuard({ promptCount: 5, evalCount: 8, endTs: 1_000_000 }, { promptCount: 18, evalCount: 8, endTs: 1_000_500 })).toBe(
      false
    ); // proves the old rule would have let the double-count through
  });

  // MUTATION TEST 2: shrinking the window to 0ms (an "exact match only" bug) must fail to drop a
  // real-world case where the GIN line and the proxy's own response-complete timestamp differ by
  // a few hundred ms (normal clock/measurement skew) — proving the ±2000ms tolerance is load-bearing.
  it('MUTATION: a zero-tolerance window would fail to drop a real few-hundred-ms-skew duplicate', () => {
    const skewed = { evalCount: 8, endTs: 1_000_000 };
    const proxyEvents: ProxyEventForGuard[] = [{ evalCount: 8, endTs: 1_000_350 }];
    expect(isDoubleCounted(skewed, proxyEvents, 2000)).toBe(true); // real guard: dropped
    expect(isDoubleCounted(skewed, proxyEvents, 0)).toBe(false); // 0ms-window bug: NOT dropped -> would double-count
  });
});

// ── UsageEvent construction ──────────────────────────────────────────────────
describe('buildServerLogUsageEvent', () => {
  it('emits source ollama-log, provider local, flag serverlogEstimate, all prompt tokens as inputFresh (no cache signal in the log)', () => {
    const event = buildServerLogUsageEvent('M4a', {
      model: 'gemma4:26b',
      promptEvalCount: 18,
      evalCount: 8,
      totalMs: 500,
      endTs: 1_700_000_000_000,
      durationMs: 818,
      path: '/api/chat',
    });
    expect(event.source).toBe('ollama-log');
    expect(event.provider).toBe('local');
    expect(event.flags).toEqual(['serverlogEstimate', 'thinkingUnknown']);
    expect(event.tokens).toEqual({ inputFresh: 18, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 8, reasoning: 0 });
    expect(event.durationMs).toBe(818);
    expect(event.ts).toBe(1_700_000_000_000 - 818);
    // Founder req. 2026-09-27: the server log exposes only a per-MODEL-LOAD thinking hint (the
    // template-selection/`chat template, thinking = 1` lines fire once per load, not per request —
    // verified live, this host, 2026-09-27: `grep -i think /opt/homebrew/var/log/ollama.log`), so
    // thinking is NEVER determinable per request from this source — always null, never guessed.
    expect(event.thinking).toBeNull();
  });
});

// ── Incremental tailing ──────────────────────────────────────────────────────
describe('tailServerLog', () => {
  function tmpLogFile(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-serverlog-')), 'ollama.log');
  }

  it('parses only newly-appended complete lines on each call and persists the offset', async () => {
    const file = tmpLogFile();
    const block1 = [
      'time=2026-09-26T15:39:43.000-06:00 level=INFO source=images.go:374 msg="template selection" model=registry.ollama.ai/library/gemma4:26b selected=x',
      'slot print_timing: id  0 | task 0 | prompt eval time =     100.00 ms /    10 tokens (10 ms per token, 100 tokens per second)',
      'slot print_timing: id  0 | task 0 |        eval time =     100.00 ms /     5 tokens (20 ms per token, 50 tokens per second)',
      'slot print_timing: id  0 | task 0 |       total time =     200.00 ms /    15 tokens',
      '[GIN] 2026/09/26 - 15:39:45 | 200 |  300ms |       127.0.0.1 | POST     "/api/chat"',
      '', // trailing newline
    ].join('\n');
    fs.writeFileSync(file, block1);

    const state = initialServerLogState();
    const result1 = await tailServerLog(file, state, new Map(), () => [], {
      tzOffsetMinutes: DENVER_OFFSET_MINUTES,
      host: 'M4a',
    });
    expect(result1.events).toHaveLength(1);
    expect(result1.events[0].tokens.output).toBe(5);
    expect(result1.events[0].host).toBe('M4a');

    // Calling again with nothing new appended must find nothing.
    const result2 = await tailServerLog(file, state, new Map(), () => [], { host: 'M4a' });
    expect(result2.events).toHaveLength(0);

    // Append a second request; only the NEW block should be parsed (model carries over, since no new template-selection line).
    const block2 = [
      'slot print_timing: id  0 | task 6 | prompt eval time =     50.00 ms /     4 tokens (12.5 ms per token, 80 tokens per second)',
      'slot print_timing: id  0 | task 6 |        eval time =     50.00 ms /     3 tokens (16.7 ms per token, 60 tokens per second)',
      'slot print_timing: id  0 | task 6 |       total time =     100.00 ms /     7 tokens',
      '[GIN] 2026/09/26 - 15:39:50 | 200 |  150ms |       127.0.0.1 | POST     "/api/chat"',
      '',
    ].join('\n');
    fs.appendFileSync(file, block2);
    const result3 = await tailServerLog(file, state, new Map(), () => [], { host: 'M4a' });
    expect(result3.events).toHaveLength(1);
    expect(result3.events[0].tokens.output).toBe(3);
    expect(result3.events[0].model).toBe('gemma4:26b');
  });

  it('applies the double-count guard against getRecentProxyEvents and drops the matching block', async () => {
    const file = tmpLogFile();
    const lines = [
      'time=2026-09-26T15:39:43.000-06:00 level=INFO source=images.go:374 msg="template selection" model=registry.ollama.ai/library/gemma4:26b selected=x',
      'slot print_timing: id  0 | task 0 | prompt eval time =     100.00 ms /    10 tokens (10 ms per token, 100 tokens per second)',
      'slot print_timing: id  0 | task 0 |        eval time =     100.00 ms /     5 tokens (20 ms per token, 50 tokens per second)',
      'slot print_timing: id  0 | task 0 |       total time =     200.00 ms /    15 tokens',
      '[GIN] 2026/09/26 - 15:39:45 | 200 |  300ms |       127.0.0.1 | POST     "/api/chat"',
      '',
    ].join('\n');
    fs.writeFileSync(file, lines);

    const state = initialServerLogState();
    const endTs = parseGinTimestamp('2026/09/26', '15:39:45', DENVER_OFFSET_MINUTES);
    const getRecentProxyEvents = () => [{ evalCount: 5, endTs }];
    const result = await tailServerLog(file, state, new Map(), getRecentProxyEvents, {
      tzOffsetMinutes: DENVER_OFFSET_MINUTES,
      host: 'M4a',
    });
    expect(result.events).toHaveLength(0); // dropped by the guard
  });

  it('returns no events for a file that does not exist (best-effort, never throws)', async () => {
    const state = initialServerLogState();
    const result = await tailServerLog('/does/not/exist/ollama.log', state, new Map(), () => []);
    expect(result.events).toHaveLength(0);
  });

  it('does not parse an incomplete trailing line (no newline yet) until it is completed', async () => {
    const file = tmpLogFile();
    fs.writeFileSync(file, '[GIN] 2026/09/26 - 15:39:45 | 200 |  300ms |       127.0.0.1 | POST     "/api/ch'); // deliberately cut mid-line, no \n
    const state = initialServerLogState();
    const result = await tailServerLog(file, state, new Map(), () => []);
    expect(result.events).toHaveLength(0);
    expect(state.offset).toBe(0); // nothing consumed — the incomplete line stays for next time
  });
});
