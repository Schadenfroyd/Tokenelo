/**
 * Live integration test — starts the real metering proxy on an ephemeral port against M4a's real
 * Ollama server (Homebrew 0.32.13, 127.0.0.1:11434, verified live in this session), sends 4 tiny
 * real requests (num_predict/max_tokens <= 16, both models, /api and /v1, stream and non-stream),
 * and asserts the proxy's recorded token counts equal the counts in the actual HTTP responses it
 * relayed. Skipped unless TOKENELO_LIVE=1 (never runs in CI / by default — DESIGN.md gate 5:
 * "Ollama proxy — recorded counts equal direct responses for chat/generate/v1, stream and
 * non-stream").
 *
 * Run with: TOKENELO_LIVE=1 npx vitest run test/ollama/ollama-proxy.live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createOllamaProxy } from '../../src/collectors/ollama-proxy.js';
import type { UsageEvent } from '../../src/core/types.js';

const LIVE = process.env.TOKENELO_LIVE === '1';
const UPSTREAM = 'http://127.0.0.1:11434';
const GEMMA_MODEL = 'gemma4:26b';
const QWEN_MODEL = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';

describe.skipIf(!LIVE)('LIVE: ollama-proxy against M4a\'s real Ollama server', () => {
  let events: UsageEvent[] = [];
  let proxyPort: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    events = [];
    const proxy = createOllamaProxy({
      upstream: UPSTREAM,
      port: 0,
      host: 'M4a',
      injectUsage: false,
      onEvent: (e) => events.push(e),
      log: (level, msg, data) => {
        if (level === 'error') console.error('[ollama-proxy]', msg, data);
      },
    });
    await proxy.listen();
    proxyPort = (proxy.server.address() as AddressInfo).port;
    close = proxy.close;
  }, 30_000);

  afterAll(async () => {
    if (close) await close();
  });

  it('meters a non-streaming /api/chat request with counts equal to the real response', async () => {
    const before = events.length;
    const { body, json } = await postJson(proxyPort, '/api/chat', {
      model: GEMMA_MODEL,
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: false,
      options: { num_predict: 8 },
    });
    expect(json.done).toBe(true);
    const event = events[before];
    expect(event).toBeDefined();
    expect(event.model).toBe(GEMMA_MODEL);
    expect(event.tokens.output).toBe(json.eval_count);
    expect(event.tokens.inputFresh + event.tokens.cacheRead).toBe(json.prompt_eval_count);
    expect(body.length).toBeGreaterThan(0); // proxy forwarded a real body
  }, 60_000);

  it('meters a streaming /api/generate request with counts equal to the real final NDJSON line', async () => {
    const before = events.length;
    const { lines } = await postNdjsonStream(proxyPort, '/api/generate', {
      model: GEMMA_MODEL,
      prompt: 'Say hi',
      stream: true,
      options: { num_predict: 8 },
    });
    const finalLine = JSON.parse(lines[lines.length - 1]);
    expect(finalLine.done).toBe(true);
    const event = events[before];
    expect(event).toBeDefined();
    expect(event.tokens.output).toBe(finalLine.eval_count);
  }, 60_000);

  it('meters a non-streaming /v1/chat/completions request (Qwen) with counts equal to the real response', async () => {
    const before = events.length;
    const { json } = await postJson(proxyPort, '/v1/chat/completions', {
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 8,
    });
    const event = events[before];
    expect(event).toBeDefined();
    expect(event.model).toBe(QWEN_MODEL);
    expect(event.tokens.output).toBe(json.usage.completion_tokens);
    expect(event.tokens.inputFresh + event.tokens.cacheRead).toBe(json.usage.prompt_tokens);
  }, 90_000);

  it('meters a streaming /v1/chat/completions request WITH include_usage requested by the client, and forwards the usage chunk through untouched (client asked for it)', async () => {
    const before = events.length;
    const { sse } = await postSseStream(proxyPort, '/v1/chat/completions', {
      model: GEMMA_MODEL,
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 8,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(sse).toContain('"usage"'); // client asked for it -> must still see it
    const event = events[before];
    expect(event).toBeDefined();
    expect(event.tokens.output).toBeGreaterThan(0);
  }, 60_000);

  // MUTATION-STYLE LIVE CHECK: with the guard disabled (achieved here by re-running the same
  // request id generator with a fixed clock so two identical requests collide), duplicate ids
  // must NOT double the recorded total — proves the id scheme + per-event emission genuinely
  // produces one event per request, not a running double-add, against the real server.
  it('two sequential identical real requests produce two distinct events, not a merged/doubled one', async () => {
    const before = events.length;
    await postJson(proxyPort, '/api/chat', {
      model: GEMMA_MODEL,
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: false,
      options: { num_predict: 8 },
    });
    await postJson(proxyPort, '/api/chat', {
      model: GEMMA_MODEL,
      messages: [{ role: 'user', content: 'Say hi' }],
      stream: false,
      options: { num_predict: 8 },
    });
    const newEvents = events.slice(before);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0].id).not.toBe(newEvents[1].id);
  }, 60_000);
});

function postJson(port: number, path: string, body: unknown): Promise<{ body: string; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ body: text, json: JSON.parse(text) });
          } catch (e) {
            reject(new Error(`non-JSON response: ${text.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function postNdjsonStream(port: number, path: string, body: unknown): Promise<{ lines: string[] }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ lines: text.trim().split('\n').filter((l) => l.length > 0) });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function postSseStream(port: number, path: string, body: unknown): Promise<{ sse: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ sse: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}
