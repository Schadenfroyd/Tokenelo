import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { createOllamaProxy } from '../../src/collectors/ollama-proxy.js';
import type { UsageEvent } from '../../src/core/types.js';

it.each([
  { label: 'reported cache hit', raw: { prompt_eval_count: 18, prompt_eval_cached_count: 13 }, expected: 50 },
  { label: 'all prompt cached', raw: { prompt_eval_count: 18, prompt_eval_cached_count: 18 }, expected: 0 },
  { label: 'legacy cache-zero policy', raw: { prompt_eval_count: 18 }, expected: 180 },
  { label: 'invalid cache counter', raw: { prompt_eval_count: 18, prompt_eval_cached_count: 'BAD' }, expected: undefined },
  { label: 'cache exceeds prompt', raw: { prompt_eval_count: 18, prompt_eval_cached_count: 19 }, expected: undefined },
])('uses known uncached prompt quantity for prefill throughput: $label', async sample => {
  const body = JSON.stringify({ model: 'OWNED-NONGENERATING-FIXTURE', done: true, eval_count: 8,
    prompt_eval_duration: 100000000, eval_duration: 100000000, ...sample.raw });
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const events: UsageEvent[] = [];
  const proxy = createOllamaProxy({ host: 'OWNED', upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    port: 0, injectUsage: false, onEvent: event => events.push(event) });
  try {
    await proxy.listen();
    const response = await fetch(`http://127.0.0.1:${(proxy.server.address() as AddressInfo).port}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"OWNED-NONGENERATING-FIXTURE","stream":false}',
    });
    expect(await response.text()).toBe(body);
    await proxy.close();
    expect(events).toHaveLength(1);
    expect(events[0]!.perf!.prefillTokPerSec).toBe(sample.expected);
    expect(events[0]!.perf!.decodeTokPerSec).toBe(80);
  } finally { await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
