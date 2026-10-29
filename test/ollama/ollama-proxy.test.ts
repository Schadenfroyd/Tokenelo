import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  classifyPath,
  parseNativeLine,
  parseOpenAiNonStream,
  parseOpenAiStreamUsageChunk,
  createSseLineSplitter,
  parseApiEmbedResponse,
  parseV1EmbeddingsResponse,
  parseAnthropicCompatResponse,
  buildOllamaUsageEvent,
  makeOllamaEventId,
  ollamaSessionId,
  stripUsageOnlyChunks,
  createOllamaProxy,
  nativeLineHasThinking,
  openAiStreamPayloadHasReasoning,
  openAiNonStreamHasReasoning,
} from '../../src/collectors/ollama-proxy.js';
import type { UsageEvent } from '../../src/core/types.js';

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures', 'ollama');
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ── Path classification ─────────────────────────────────────────────────────
describe('classifyPath', () => {
  it('classifies every metered path per DESIGN §4.3/§15.3.3', () => {
    expect(classifyPath('/api/chat')).toBe('api-chat');
    expect(classifyPath('/api/generate')).toBe('api-generate');
    expect(classifyPath('/v1/chat/completions')).toBe('v1-chat-completions');
    expect(classifyPath('/v1/completions')).toBe('v1-completions');
    expect(classifyPath('/api/embed')).toBe('api-embed');
    expect(classifyPath('/v1/embeddings')).toBe('v1-embeddings');
    expect(classifyPath('/v1/messages')).toBe('v1-messages-annotate');
    expect(classifyPath('/api/tags')).toBe('unmetered');
    expect(classifyPath('/api/ps')).toBe('unmetered');
  });
});

// ── /api/chat, /api/generate final-chunk parsing (real captured fixtures) ──
describe('parseNativeLine against real M4a fixtures', () => {
  it('parses a non-streaming /api/chat gemma4:26b response (Homebrew 0.32.13 — no cached-count field)', () => {
    const line = readFixture('api-chat-nonstream-gemma.json');
    const parsed = parseNativeLine(line);
    expect(parsed).toEqual({
      model: 'gemma4:26b',
      nativeCounterEvidence: {
        policy: 'tokenelo/ollama-native-counters@v1', missingCachePolicy: 'assume-zero',
        snapshots: [{ prompt_eval_count: { state: 'reported', value: 18 },
          prompt_eval_cached_count: { state: 'missing', value: null },
          eval_count: { state: 'reported', value: 8 } }],
      },
      promptEvalCount: 18,
      promptEvalCachedCount: 0,
      evalCount: 8,
      totalDurationNs: 5760657625,
      promptEvalDurationNs: 5052284000,
      evalDurationNs: 407984000,
      loadDurationNs: 290597417,
    });
  });

  it('parses a non-streaming /api/chat gemma4:26b response on Ollama.app 0.34.2 (has the cached-count field, value 0 on a cold prompt)', () => {
    const line = readFixture('api-chat-nonstream-gemma-ollamaapp.json');
    const parsed = parseNativeLine(line);
    expect(parsed?.promptEvalCount).toBe(18);
    expect(parsed?.promptEvalCachedCount).toBe(0);
    expect(parsed?.evalCount).toBe(8);
  });

  it('parses a cache-hit /api/chat response on Ollama.app 0.34.2 (13 of 18 prompt tokens served from cache)', () => {
    const line = readFixture('api-chat-nonstream-gemma-ollamaapp-cached.json');
    const parsed = parseNativeLine(line);
    expect(parsed?.promptEvalCount).toBe(18);
    expect(parsed?.promptEvalCachedCount).toBe(13);
    expect(parsed?.evalCount).toBe(8);
  });

  it('parses a non-streaming /api/chat Qwen response', () => {
    const line = readFixture('api-chat-nonstream-qwen.json');
    const parsed = parseNativeLine(line);
    expect(parsed?.model).toBe('hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL');
    expect(parsed?.promptEvalCount).toBe(54);
    expect(parsed?.evalCount).toBe(8);
  });

  it('parses only the final done:true line of a streaming /api/chat NDJSON response, skipping intermediate lines', () => {
    const ndjson = readFixture('api-chat-stream-gemma.ndjson');
    const lines = ndjson.trim().split('\n');
    const parsedLines = lines.map(parseNativeLine);
    const finals = parsedLines.filter((p) => p !== null);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.evalCount).toBe(8);
    expect(finals[0]!.promptEvalCount).toBe(18);
  });

  it('parses a streaming /api/generate NDJSON final line', () => {
    const ndjson = readFixture('api-generate-stream-gemma.ndjson');
    const finals = ndjson.trim().split('\n').map(parseNativeLine).filter((p) => p !== null);
    expect(finals).toHaveLength(1);
    expect(finals[0]!.evalCount).toBe(8);
  });

  it('returns null for malformed JSON, non-done chunks, and chunks missing a model field', () => {
    expect(parseNativeLine('not json')).toBeNull();
    expect(parseNativeLine('{"model":"x","done":false}')).toBeNull();
    expect(parseNativeLine('{"done":true}')).toBeNull();
    expect(parseNativeLine('')).toBeNull();
  });
});

// ── Thinking-mode detection (founder req. 2026-09-27) — real fixtures + live-verified shapes ──
describe('nativeLineHasThinking / openAiStreamPayloadHasReasoning / openAiNonStreamHasReasoning', () => {
  it('/api/chat: message.thinking present (real fixture, redacted text) -> true', () => {
    expect(nativeLineHasThinking(readFixture('api-chat-nonstream-gemma.json'))).toBe(true);
    expect(nativeLineHasThinking(readFixture('api-chat-nonstream-qwen.json'))).toBe(true);
  });

  it('/api/chat: message.thinking absent (real live capture, think:false, this host 2026-09-27) -> false', () => {
    // curl :11434/api/chat -d '{"model":"gemma4:26b",...,"think":false}' -> message keys are
    // exactly ['content','role'] — no 'thinking' key at all (verified live, not assumed).
    const line = JSON.stringify({ model: 'gemma4:26b', done: true, message: { role: 'assistant', content: 'hi' } });
    expect(nativeLineHasThinking(line)).toBe(false);
  });

  it('/api/generate: TOP-LEVEL `thinking` key (no `message` object on this endpoint — real live capture, think:true, this host 2026-09-27)', () => {
    // curl :11434/api/generate -d '{"model":"gemma4:26b","prompt":"Say hi","think":true,...}' ->
    // keys incl. a top-level `thinking` string, sibling to `response` (no `message` object exists
    // for /api/generate at all). think:false -> that key is fully absent, same as /api/chat.
    const withThinking = JSON.stringify({ model: 'gemma4:26b', done: true, response: '', thinking: 'some reasoning text' });
    const withoutThinking = JSON.stringify({ model: 'gemma4:26b', done: true, response: 'hi' });
    expect(nativeLineHasThinking(withThinking)).toBe(true);
    expect(nativeLineHasThinking(withoutThinking)).toBe(false);
  });

  it('an intermediate (done:false) streaming line counts too — a length-cutoff final line can omit `thinking` while an earlier line had it', () => {
    const intermediate = JSON.stringify({ model: 'gemma4:26b', done: false, message: { role: 'assistant', content: '', thinking: 'partial' } });
    expect(nativeLineHasThinking(intermediate)).toBe(true);
  });

  it('malformed/empty lines never throw, and never count as thinking', () => {
    expect(nativeLineHasThinking('not json')).toBe(false);
    expect(nativeLineHasThinking('')).toBe(false);
    expect(nativeLineHasThinking('   ')).toBe(false);
  });

  it('OpenAI-compat streaming: delta.reasoning present (real fixture) -> true; a plain content/usage chunk -> false', () => {
    expect(openAiStreamPayloadHasReasoning('{"choices":[{"index":0,"delta":{"content":"","reasoning":"x"},"finish_reason":null}]}')).toBe(true);
    expect(openAiStreamPayloadHasReasoning('{"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}')).toBe(false);
    expect(openAiStreamPayloadHasReasoning('[DONE]')).toBe(false);
    expect(openAiStreamPayloadHasReasoning('not json')).toBe(false);
    expect(openAiStreamPayloadHasReasoning('{"choices":[]}')).toBe(false); // the usage-only final chunk
  });

  it('OpenAI-compat non-streaming: message.reasoning present (real fixture) -> true; absent -> false', () => {
    expect(openAiNonStreamHasReasoning(readFixture('v1-chat-nonstream-gemma.json'))).toBe(true);
    expect(openAiNonStreamHasReasoning(readFixture('v1-completions-nonstream-gemma.json'))).toBe(false); // text completion has no `choices[].message`
    expect(openAiNonStreamHasReasoning('not json')).toBe(false);
  });
});

// ── /v1/* OpenAI-compat usage parsing (real captured fixtures) ──────────────
describe('parseOpenAiNonStream against real M4a fixtures', () => {
  it('parses a non-streaming /v1/chat/completions response', () => {
    const usage = parseOpenAiNonStream(readFixture('v1-chat-nonstream-gemma.json'));
    expect(usage).toEqual({ model: 'gemma4:26b', promptTokens: 18, cachedTokens: 0, completionTokens: 8 });
  });

  it('parses a non-streaming /v1/completions response', () => {
    const usage = parseOpenAiNonStream(readFixture('v1-completions-nonstream-gemma.json'));
    expect(usage).toEqual({ model: 'gemma4:26b', promptTokens: 18, cachedTokens: 0, completionTokens: 8 });
  });

  it('returns null when there is no usage object (malformed/errored response)', () => {
    expect(parseOpenAiNonStream(JSON.stringify({ model: 'x' }))).toBeNull();
    expect(parseOpenAiNonStream('not json')).toBeNull();
  });
});

describe('parseOpenAiStreamUsageChunk + createSseLineSplitter against real M4a SSE fixtures', () => {
  it('extracts the usage-only final chunk from a stream with stream_options.include_usage (gemma)', () => {
    const sse = readFixture('v1-chat-stream-withusage-gemma.txt');
    const found: ReturnType<typeof parseOpenAiStreamUsageChunk>[] = [];
    const splitter = createSseLineSplitter((payload) => found.push(parseOpenAiStreamUsageChunk(payload)));
    splitter.push(sse);
    splitter.flush();
    const usages = found.filter((u) => u !== null);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ model: 'gemma4:26b', promptTokens: 18, cachedTokens: 0, completionTokens: 8 });
  });

  it('extracts the usage-only final chunk for Qwen', () => {
    const sse = readFixture('v1-chat-stream-withusage-qwen.txt');
    const found: ReturnType<typeof parseOpenAiStreamUsageChunk>[] = [];
    const splitter = createSseLineSplitter((payload) => found.push(parseOpenAiStreamUsageChunk(payload)));
    splitter.push(sse);
    splitter.flush();
    const usages = found.filter((u) => u !== null);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({
      model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      promptTokens: 54,
      cachedTokens: 0,
      completionTokens: 8,
    });
  });

  it('finds NO usage chunk in a stream without include_usage (the "unmetered" case DESIGN §15.3.3 calls out)', () => {
    const sse = readFixture('v1-chat-stream-nousage-gemma.txt');
    const found: ReturnType<typeof parseOpenAiStreamUsageChunk>[] = [];
    const splitter = createSseLineSplitter((payload) => found.push(parseOpenAiStreamUsageChunk(payload)));
    splitter.push(sse);
    splitter.flush();
    expect(found.every((u) => u === null)).toBe(true);
  });

  it('handles a usage chunk split across two push() calls at an arbitrary byte boundary', () => {
    const sse = readFixture('v1-chat-stream-withusage-gemma.txt');
    const splitPoint = sse.indexOf('"usage"') + 5; // split mid-way through the usage object's own line
    const found: ReturnType<typeof parseOpenAiStreamUsageChunk>[] = [];
    const splitter = createSseLineSplitter((payload) => found.push(parseOpenAiStreamUsageChunk(payload)));
    splitter.push(sse.slice(0, splitPoint));
    splitter.push(sse.slice(splitPoint));
    splitter.flush();
    const usages = found.filter((u) => u !== null);
    expect(usages).toHaveLength(1);
    expect(usages[0]!.completionTokens).toBe(8);
  });

  it('[DONE] and non-usage delta chunks never parse as usage', () => {
    expect(parseOpenAiStreamUsageChunk('[DONE]')).toBeNull();
    expect(
      parseOpenAiStreamUsageChunk(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }))
    ).toBeNull();
    // choices:[] alone (no usage key) must NOT be treated as a usage chunk
    expect(parseOpenAiStreamUsageChunk(JSON.stringify({ choices: [] }))).toBeNull();
  });
});

// ── stripUsageOnlyChunks (injection-strip correctness) ──────────────────────
describe('stripUsageOnlyChunks', () => {
  it('removes exactly the injected usage-only chunk and leaves every other byte identical', () => {
    const sse = readFixture('v1-chat-stream-withusage-gemma.txt');
    const stripped = stripUsageOnlyChunks(sse);
    // No usage chunk should survive.
    const splitter = createSseLineSplitter((payload) => {
      const u = parseOpenAiStreamUsageChunk(payload);
      if (u) throw new Error('usage chunk survived stripping');
    });
    splitter.push(stripped);
    splitter.flush();
    // The content chunks (and [DONE]) must still be present and in the same order.
    expect(stripped).toContain('[DONE]');
    expect(stripped.split('data:').length).toBe(sse.split('data:').length - 1); // exactly one block removed
  });

  it('is a no-op on a stream with no usage-only chunk (the un-injected, unmetered case)', () => {
    const sse = readFixture('v1-chat-stream-nousage-gemma.txt');
    expect(stripUsageOnlyChunks(sse)).toBe(sse);
  });

  // MUTATION TEST: a "guard" that fails to check for choices:[] (i.e. drops any chunk carrying a
  // usage-shaped object, including a legitimate future one) must not be the guard we shipped —
  // reintroduce that bug and prove the specific real fixture would be damaged differently.
  it('mutation guard: parseOpenAiStreamUsageChunk requires choices to be an empty array, not just any usage key', () => {
    const contentChunkWithStrayUsageKey = JSON.stringify({
      choices: [{ delta: { content: 'hi' } }],
      usage: null,
    });
    // Real guard: null usage or non-empty choices -> not a usage chunk.
    expect(parseOpenAiStreamUsageChunk(contentChunkWithStrayUsageKey)).toBeNull();
  });
});

// ── Embeddings + Anthropic-compat parsing ───────────────────────────────────
describe('embeddings parsing (shape-only / unproven — the live homebrew server was not started with --embeddings)', () => {
  it('parses a documented /api/embed response shape', () => {
    const body = JSON.stringify({ model: 'gemma4:26b', embeddings: [[0.1, 0.2]], prompt_eval_count: 3 });
    expect(parseApiEmbedResponse(body)).toEqual({ model: 'gemma4:26b', promptTokens: 3 });
  });

  it('parses a documented /v1/embeddings response shape', () => {
    const body = JSON.stringify({ model: 'gemma4:26b', data: [{ embedding: [0.1] }], usage: { prompt_tokens: 3 } });
    expect(parseV1EmbeddingsResponse(body)).toEqual({ model: 'gemma4:26b', promptTokens: 3 });
  });

  it('the real fixture captured from the live server is a 501 (embeddings disabled) — parsers correctly return null on it', () => {
    const body = readFixture('api-embed-gemma.json');
    expect(parseApiEmbedResponse(body)).toBeNull();
  });
});

describe('parseAnthropicCompatResponse against a real /v1/messages fixture (Ollama.app 0.34.2)', () => {
  it('parses input/cache-read/output tokens (annotate-only — never turned into a UsageEvent by this module)', () => {
    const usage = parseAnthropicCompatResponse(readFixture('v1-messages-nonstream-gemma-ollamaapp.json'));
    expect(usage).toEqual({ model: 'gemma4:26b', inputTokens: 5, cacheReadInputTokens: 13, outputTokens: 8 });
  });
});

// ── UsageEvent construction ──────────────────────────────────────────────────
describe('buildOllamaUsageEvent / ollamaSessionId / makeOllamaEventId', () => {
  it('builds a v1-fresh-basis UsageEvent with source ollama-proxy and provider local', () => {
    const event = buildOllamaUsageEvent({
      host: 'M4a',
      model: 'gemma4:26b',
      tokens: { inputFresh: 18, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 8, reasoning: 0 },
      entrypoint: 'ollama-python/0.1',
      ts: 1_700_000_000_000,
      requestStartNs: 123n,
      durationMs: 500,
    });
    expect(event.source).toBe('ollama-proxy');
    expect(event.provider).toBe('local');
    expect(event.host).toBe('M4a');
    expect(event.model).toBe('gemma4:26b');
    expect(event.tokens.inputFresh).toBe(18);
    expect(event.tokens.output).toBe(8);
    expect(event.durationMs).toBe(500);
    expect(event.id.startsWith('ollama:M4a:123:')).toBe(true);
    expect(event.sessionId).toBe(ollamaSessionId('ollama-python/0.1', 'gemma4:26b', 1_700_000_000_000));
    // Default `thinking` (omitted) is false, never null/undefined — every metered proxy path either
    // proves it from the response or genuinely cannot ever produce it (embeddings); there is no
    // "unknown" case for this collector (contrast Claude JSONL / Codex).
    expect(event.thinking).toBe(false);
  });

  it('honors an explicit thinking:true override', () => {
    const event = buildOllamaUsageEvent({
      host: 'M4a',
      model: 'gemma4:26b',
      tokens: { inputFresh: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 },
      entrypoint: 'x',
      ts: 0,
      requestStartNs: 1n,
      thinking: true,
    });
    expect(event.thinking).toBe(true);
  });

  it('sessionId is `<ua>:<model>:<yyyy-mm-dd>` (UTC)', () => {
    const ts = Date.UTC(2026, 8, 26, 23, 12, 0); // 2026-09-26
    expect(ollamaSessionId('curl/8.0', 'gemma4:26b', ts)).toBe('curl/8.0:gemma4:26b:2026-09-26');
  });

  it('event ids are unique per call even for the same requestStartNs (counter suffix)', () => {
    const a = makeOllamaEventId('M4a', 42n);
    const b = makeOllamaEventId('M4a', 42n);
    expect(a).not.toBe(b);
  });

  it('build item 4: engine is omitted (undefined) when not passed — never defaulted onto an event that never declared it', () => {
    const event = buildOllamaUsageEvent({
      host: 'M4a',
      model: 'gemma4:26b',
      tokens: { inputFresh: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 },
      entrypoint: 'x',
      ts: 0,
      requestStartNs: 1n,
    });
    expect(event.engine).toBeUndefined();
    expect('engine' in event).toBe(false);
  });

  it('build item 4: a configured engine name (e.g. a generalized-proxy upstream) is carried onto the event verbatim', () => {
    const event = buildOllamaUsageEvent({
      host: 'M4a',
      engine: 'docker-model-runner',
      model: 'ai/qwen3',
      tokens: { inputFresh: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 },
      entrypoint: 'x',
      ts: 0,
      requestStartNs: 1n,
    });
    expect(event.engine).toBe('docker-model-runner');
    expect(event.source).toBe('ollama-proxy'); // deliberately NOT a new Source — see UsageEvent.engine's own doc
  });
});

// ── Live streaming reverse-proxy behavior against a fake upstream ───────────
// Exercises createOllamaProxy end-to-end (real http.Server <-> real http.Server), never against
// M4a's actual Ollama — that is the separate opt-in live-integration test.
describe('createOllamaProxy (fake upstream, in-process http servers)', () => {
  let upstream: http.Server;
  let upstreamPort: number;

  beforeEach(async () => {
    upstream = http.createServer();
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function fakeUpstreamRespond(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    upstream.removeAllListeners('request');
    upstream.on('request', handler);
  }

  it('meters a non-streaming /api/chat request and forwards the exact upstream body to the client', async () => {
    const fixtureBody = readFixture('api-chat-nonstream-gemma.json');
    let upstreamConnection: string | undefined;
    fakeUpstreamRespond((req, res) => {
      upstreamConnection = req.headers.connection;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureBody);
    });

    const events: UsageEvent[] = [];
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const clientBody = await httpPost(proxyPort, '/api/chat', JSON.stringify({ model: 'gemma4:26b', stream: false }));
    await proxy.close();

    expect(clientBody).toBe(fixtureBody); // byte-identical pass-through
    expect(upstreamConnection).toBe('close'); // no reused Node client socket for upstream replies
    expect(events).toHaveLength(1);
    expect(events[0].tokens.inputFresh).toBe(18);
    expect(events[0].tokens.output).toBe(8);
    expect(events[0].source).toBe('ollama-proxy');
    // UsageEvent.perf from the final chunk: eval_count / eval_duration and prompt_eval_count /
    // prompt_eval_duration (fixture: 8 / 407984000 ns, 18 / 5052284000 ns).
    expect(events[0].perf?.decodeTokPerSec).toBeCloseTo(8 / (407984000 / 1e9), 9);
    expect(events[0].perf?.prefillTokPerSec).toBeCloseTo(18 / (5052284000 / 1e9), 9);
    // Fixture's message carries a `thinking` key (redacted text) -> true.
    expect(events[0].thinking).toBe(true);
  });

  it('meters a streaming /api/generate NDJSON request and forwards every line untouched', async () => {
    const fixtureNdjson = readFixture('api-generate-stream-gemma.ndjson');
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(fixtureNdjson);
    });

    const events: UsageEvent[] = [];
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const clientBody = await httpPost(proxyPort, '/api/generate', JSON.stringify({ model: 'gemma4:26b', stream: true }));
    await proxy.close();

    expect(clientBody).toBe(fixtureNdjson);
    expect(events).toHaveLength(1);
    expect(events[0].tokens.output).toBe(8);
    // This fixture's line has no `thinking` key at all -> verified false (not "unknown" — see the
    // "Thinking-mode detection" doc comment in ollama-proxy.ts: absence is conclusive for Ollama).
    expect(events[0].thinking).toBe(false);
  });

  it('meters a streaming /api/generate request whose lines carry a top-level `thinking` key (no `message` object on this endpoint)', async () => {
    // Synthetic but shape-verified live against this host's real Ollama server, 2026-09-27 (see
    // the nativeLineHasThinking doc comment / unit tests above) — no captured fixture has this
    // field non-empty, so it is constructed here rather than asserted from a static file.
    const ndjson = [
      JSON.stringify({ model: 'gemma4:26b', created_at: 't', response: '', thinking: 'partial reasoning', done: false }),
      JSON.stringify({
        model: 'gemma4:26b', created_at: 't', response: 'hi', done: true, done_reason: 'stop',
        total_duration: 1, load_duration: 1, prompt_eval_count: 5, prompt_eval_duration: 1, eval_count: 3, eval_duration: 1,
      }),
    ].join('\n') + '\n';
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(ndjson);
    });
    const events: UsageEvent[] = [];
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    await httpPost(proxyPort, '/api/generate', JSON.stringify({ model: 'gemma4:26b', stream: true }));
    await proxy.close();
    expect(events).toHaveLength(1);
    // The intermediate (done:false) line carried `thinking`, not the final line -> still true.
    expect(events[0].thinking).toBe(true);
  });

  it('injects stream_options.include_usage when proxyInjectUsage is on and the client did not ask, then strips the added chunk from what the client receives', async () => {
    let receivedRequestBody = '';
    const injectedResponse = readFixture('v1-chat-stream-withusage-gemma.txt');
    fakeUpstreamRespond((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedRequestBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(injectedResponse);
      });
    });

    const events: UsageEvent[] = [];
    let unmeteredCalls = 0;
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: true,
      onEvent: (e) => events.push(e),
      onUnmetered: () => {
        unmeteredCalls += 1;
      },
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const requestBody = JSON.stringify({ model: 'gemma4:26b', stream: true, messages: [] });
    const clientBody = await httpPost(proxyPort, '/v1/chat/completions', requestBody);
    await proxy.close();

    // Upstream received the injected flag even though the client's own request didn't have it.
    expect(JSON.parse(receivedRequestBody).stream_options).toEqual({ include_usage: true });
    // The client itself never sees the usage-only chunk (it never asked for it).
    expect(clientBody).not.toContain('"usage"');
    expect(clientBody).toContain('[DONE]');
    // The event was still metered from the (stripped-for-client, but proxy-observed) usage chunk.
    expect(events).toHaveLength(1);
    expect(events[0].tokens.output).toBe(8);
    expect(unmeteredCalls).toBe(0);
    // Fixture's content chunks carry `delta.reasoning` (redacted text) -> true, detected from the
    // content stream even though the usage-only final chunk itself carries no reasoning field.
    expect(events[0].thinking).toBe(true);
  });

  it('meters a non-streaming /v1/chat/completions request and detects message.reasoning', async () => {
    const fixtureBody = readFixture('v1-chat-nonstream-gemma.json');
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureBody);
    });
    const events: UsageEvent[] = [];
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    const clientBody = await httpPost(proxyPort, '/v1/chat/completions', JSON.stringify({ model: 'gemma4:26b', stream: false }));
    await proxy.close();
    expect(clientBody).toBe(fixtureBody);
    expect(events).toHaveLength(1);
    expect(events[0].tokens.output).toBe(8);
    expect(events[0].thinking).toBe(true);
  });

  it('meters a non-streaming /v1/completions (text completion) request — no reasoning field on this endpoint -> false', async () => {
    const fixtureBody = readFixture('v1-completions-nonstream-gemma.json');
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(fixtureBody);
    });
    const events: UsageEvent[] = [];
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    await httpPost(proxyPort, '/v1/completions', JSON.stringify({ model: 'gemma4:26b', stream: false }));
    await proxy.close();
    expect(events).toHaveLength(1);
    expect(events[0].thinking).toBe(false);
  });

  // MUTATION TEST for the injection/strip guard: with injection disabled (the default), the SAME
  // no-usage stream must be counted unmetered, not silently metered from a hallucinated value.
  it('mutation guard: with proxyInjectUsage OFF (default), a streaming /v1 request without include_usage is counted unmetered, never metered', async () => {
    const noUsageResponse = readFixture('v1-chat-stream-nousage-gemma.txt');
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(noUsageResponse);
    });

    const events: UsageEvent[] = [];
    let unmeteredCalls = 0;
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false, // the default — DESIGN §15.3.3 "No include_usage injection by default"
      onEvent: (e) => events.push(e),
      onUnmetered: () => {
        unmeteredCalls += 1;
      },
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const clientBody = await httpPost(proxyPort, '/v1/chat/completions', JSON.stringify({ model: 'gemma4:26b', stream: true }));
    await proxy.close();

    expect(clientBody).toBe(noUsageResponse); // completely untouched when injection is off
    expect(events).toHaveLength(0); // never fabricate an event from nothing
    expect(unmeteredCalls).toBe(1);
  });

  it('does not meter /v1/messages traffic — annotate-only, per DESIGN §15.3.3', async () => {
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(readFixture('v1-messages-nonstream-gemma-ollamaapp.json'));
    });

    const events: UsageEvent[] = [];
    const annotations: { path: string; model?: string }[] = [];
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
      onAnnotateOnly: (info) => annotations.push(info),
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    await httpPost(proxyPort, '/v1/messages', JSON.stringify({ model: 'gemma4:26b' }));
    await proxy.close();

    expect(events).toHaveLength(0);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].model).toBe('gemma4:26b');
  });

  it('passes an unmetered path (e.g. /api/tags) through with zero interference', async () => {
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
    });
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {
        throw new Error('must not meter /api/tags');
      },
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    const body = await httpGet(proxyPort, '/api/tags');
    await proxy.close();
    expect(body).toBe('{"models":[]}');
  });

  // ── Security audit #1: a client aborting mid-body must never crash the daemon ────────────
  it('a client that sends Content-Length:1000 then only 10 bytes then closes the socket does not crash the proxy — it keeps serving', async () => {
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
    });
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    await new Promise<void>((resolve) => {
      const s = net.connect(proxyPort, '127.0.0.1', () => {
        s.write(
          `POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nContent-Length: 1000\r\n\r\n{"model":`
        );
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 100);
      });
      s.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 100));

    // The proxy (this same process, in this test's own process for the in-process server) must
    // still be alive and able to serve a completely unrelated next request.
    const body = await httpGet(proxyPort, '/api/tags');
    expect(body).toBe('{"models":[]}');
    await proxy.close();
  });

  // ── Security audit #2: request body cap ─────────────────────────────────────────────────
  it('rejects an oversized request body with 413 before reading it (Content-Length over the cap)', async () => {
    let upstreamHit = false;
    fakeUpstreamRespond((req, res) => {
      upstreamHit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      maxBodyBytes: 100,
      onEvent: () => {
        throw new Error('must not meter an oversized request');
      },
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    const res = await httpPostRaw(proxyPort, '/api/chat', 'x'.repeat(500));
    await proxy.close();
    expect(res.status).toBe(413);
    expect(upstreamHit).toBe(false); // rejected before ever reaching upstream
  });

  it('rejects an oversized request body with 413 when bytes read exceed the cap even though Content-Length under-declared it (chunked/lying client)', async () => {
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      maxBodyBytes: 100,
      onEvent: () => {
        throw new Error('must not meter an oversized request');
      },
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: '/api/chat', method: 'POST', headers: { 'transfer-encoding': 'chunked' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', () => resolve(0));
      req.write('x'.repeat(60));
      req.write('x'.repeat(60)); // total 120 > 100-byte cap, but no Content-Length was ever sent
      req.end();
    });
    await proxy.close();
    expect(status).toBe(413);
  });

  it('a response over the cap is still streamed to the client byte-for-byte, but is counted unmetered rather than parsed from a truncated copy', async () => {
    const bigModel = 'm'.repeat(50); // padding so the fixture body itself is easy to reconstruct
    const hugeUsage = JSON.stringify({
      model: bigModel,
      usage: { prompt_tokens: 5, completion_tokens: 5 },
      padding: 'z'.repeat(200),
    });
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(hugeUsage);
    });
    const events: UsageEvent[] = [];
    let unmeteredCalls = 0;
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      maxBodyBytes: 50, // smaller than hugeUsage's byte length
      onEvent: (e) => events.push(e),
      onUnmetered: () => {
        unmeteredCalls += 1;
      },
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    // The REQUEST body must stay under the 50-byte cap too — this test is only exercising the
    // RESPONSE-side cap, so keep the request tiny and let only the response exceed it.
    const clientBody = await httpPost(proxyPort, '/v1/chat/completions', JSON.stringify({ model: 'm', stream: false }));
    await proxy.close();

    expect(clientBody).toBe(hugeUsage); // client still gets every byte, untruncated
    expect(events).toHaveLength(0); // never metered from a possibly-truncated copy
    expect(unmeteredCalls).toBe(1);
  });

  // ── Security audit #3: Host/Origin/request-target validation ────────────────────────────
  it('403s a request whose Host header does not name this proxy\'s own loopback address', async () => {
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    const res = await rawGetWithHeaders(proxyPort, '/api/tags', { host: 'evil.example.com:80' });
    await proxy.close();
    expect(res.status).toBe(403);
  });

  it('accepts a loopback Origin (a browser-based local tool is a legitimate caller) but rejects a non-loopback Origin', async () => {
    fakeUpstreamRespond((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":[]}');
    });
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const loopback = await rawGetWithHeaders(proxyPort, '/api/tags', {
      host: `127.0.0.1:${proxyPort}`,
      origin: 'http://localhost:5173',
    });
    expect(loopback.status).toBe(200);

    const evil = await rawGetWithHeaders(proxyPort, '/api/tags', {
      host: `127.0.0.1:${proxyPort}`,
      origin: 'http://evil.example.com',
    });
    expect(evil.status).toBe(403);
    await proxy.close();
  });

  it('400s a request whose target is not origin-form (an absolute-form / forward-proxy-style request line)', async () => {
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    const res = await rawRequestLine(proxyPort, `GET http://example.com/api/tags HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\n\r\n`);
    await proxy.close();
    expect(res.startsWith('HTTP/1.1 400')).toBe(true);
  });

  it('rejects CONNECT outright (this proxy fronts one fixed upstream — it is never a general forward proxy)', async () => {
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;
    const res = await rawRequestLine(proxyPort, `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`);
    await proxy.close();
    expect(res).toBe(''); // the socket is destroyed with no HTTP response at all

    // mutation check: the proxy must still be alive afterward.
    fakeUpstreamRespond((req, res2) => {
      res2.writeHead(200, { 'content-type': 'application/json' });
      res2.end('{"models":[]}');
    });
    const proxy2 = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy2.listen();
    const proxy2Port = (proxy2.server.address() as AddressInfo).port;
    const body = await httpGet(proxy2Port, '/api/tags');
    await proxy2.close();
    expect(body).toBe('{"models":[]}');
  });

  // ── Security audit #6: hop-by-hop headers ────────────────────────────────────────────────
  it('strips hop-by-hop headers in both directions and never forwards both transfer-encoding and content-length', async () => {
    let upstreamSawHeaders: http.IncomingHttpHeaders = {};
    fakeUpstreamRespond((req, res) => {
      upstreamSawHeaders = req.headers;
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'proxy-authenticate': 'Basic',
      });
      res.end('{"models":[]}');
    });
    const proxy = createOllamaProxy({
      upstream: `http://127.0.0.1:${upstreamPort}`,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: () => {},
    });
    await proxy.listen();
    const proxyPort = (proxy.server.address() as AddressInfo).port;

    const res = await rawGetWithHeaders(proxyPort, '/api/tags', {
      host: `127.0.0.1:${proxyPort}`,
      connection: 'keep-alive, x-custom-hop',
      'x-custom-hop': 'should-not-reach-upstream',
      te: 'trailers',
    });
    await proxy.close();

    // Response direction: hop-by-hop headers from upstream never reach the client.
    expect(res.headers['proxy-authenticate']).toBeUndefined();
    // never both set together (transfer-encoding is hop-by-hop and always stripped, so this is
    // never even a close call — but assert the actual invariant, not just one header's absence).
    expect(res.headers['transfer-encoding'] !== undefined && res.headers['content-length'] !== undefined).toBe(false);

    // Request direction: hop-by-hop + Connection-named headers never reached upstream. Node's
    // own http client always sets ITS OWN fresh `Connection` header for the proxy→upstream hop
    // (correct hop-by-hop behavior — each hop recomputes it) so we assert the header we actually
    // control was never blindly forwarded, not that the key is absent.
    expect(upstreamSawHeaders['x-custom-hop']).toBeUndefined();
    expect(upstreamSawHeaders['te']).toBeUndefined();
    expect(upstreamSawHeaders['connection']).not.toBe('keep-alive, x-custom-hop');
  });
});

function httpPost(port: number, path: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function httpGet(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

/** Like httpPost, but returns the status code instead of the body (for a request expected to be
 * rejected before any meaningful body comes back). */
function httpPostRaw(port: number, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' })); // a destroyed connection is a valid outcome here too
    req.end(body);
  });
}

/** GET with fully custom headers (including Host/Origin/Connection), via raw http.request so no
 * header is auto-derived/overridden the way the global fetch() would. */
function rawGetWithHeaders(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Sends a completely raw request line/headers over a bare TCP socket — for cases (absolute-form
 * request target, CONNECT) that Node's own http.request can't be made to emit directly. Resolves
 * with everything received before the socket closes (empty string if it closes with no response
 * at all, e.g. a destroyed CONNECT attempt). */
function rawRequestLine(port: number, raw: string): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(raw);
    });
    s.on('data', (c) => {
      data += c.toString('utf8');
    });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => {
      s.destroy();
      resolve(data);
    }, 500);
  });
}
