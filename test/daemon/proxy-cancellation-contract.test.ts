/**
 * Contract tests for CANCELLATION and ABORT handling, at two boundaries:
 *
 *   1. The local metering proxy (src/collectors/ollama-proxy.ts): a client that goes away, an upstream that
 *      goes away, a response that ends without a complete count, and close() while work is in flight.
 *      What must hold: the other side of the hop is torn down, nothing is invented (a request with no
 *      complete count is "unmetered", never a zero), and the handler always settles so close() can drain.
 *
 *   2. The daemon read API (src/daemon/http.ts): an HTTP disconnect aborts exactly the read it started, and
 *      a normally finished read is never aborted afterwards.
 *
 * In-process, 127.0.0.1, ephemeral ports, fabricated payloads. These are source-level contract tests; they
 * do not replace the compiled-runtime shutdown tests or any farm acceptance.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/daemon/http.js';
import { ReportReadError } from '../../src/daemon/report-read-protocol.js';
import type { Queries } from '../../src/store/queries.js';
import { nativeFinal, rawExchange, send, sleep, startRig, waitFor, type Rig } from '../helpers/proxy-contract-rig.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const GEN_BODY = JSON.stringify({ model: 'synthetic-model', stream: true });
const NDJSON_LINE = '{"model":"synthetic-model","response":"a","done":false}\n';

async function withRig<T>(opts: Parameters<typeof startRig>[0], fn: (rig: Rig) => Promise<T>): Promise<T> {
  const rig = await startRig(opts);
  try { return await fn(rig); } finally { await rig.stop(); }
}
const settlesWithin = async (p: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([p.then(() => 'settled' as const), new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), ms); })]);
  clearTimeout(timer);
  return result;
};
/** POST, then destroy the client connection as soon as the first response byte has arrived. */
function postThenAbortOnFirstByte(port: number, path: string, body: string): Promise<void> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: JSON_HEADERS }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => {});
    req.end(body);
  });
}

describe('proxy: a client that goes away', () => {
  it('mid-body never reaches the upstream, records nothing, and lets close() drain', async () => {
    await withRig({}, async rig => {
      const response = await rawExchange(rig.proxyPort,
        `POST /api/chat HTTP/1.1\r\nHost: 127.0.0.1:${rig.proxyPort}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":"synthetic-m`, { holdOpenMs: 80 });
      expect(response).toBe(''); // nobody was left to answer
      await sleep(50);
      expect(rig.upstreamSeen).toEqual([]);
      expect(rig.events).toEqual([]);
      expect(rig.unmetered).toEqual([]);
      expect(await settlesWithin(rig.proxy.close(), 2000)).toBe('settled');
    });
  });

  it('mid-stream tears down the upstream request, reports one unmetered request, invents no event, and keeps serving', async () => {
    await withRig({}, async rig => {
      let upstreamClosed = false;
      rig.setUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(NDJSON_LINE);
        res.on('close', () => { upstreamClosed = true; });
      });
      await postThenAbortOnFirstByte(rig.proxyPort, '/api/generate', GEN_BODY);
      await waitFor(() => upstreamClosed, 'the upstream connection to be torn down');
      await waitFor(() => rig.unmetered.length === 1, 'the unmetered diagnostic');
      expect(rig.unmetered).toEqual([{ path: '/api/generate', model: 'synthetic-model' }]);
      expect(rig.proxy.unmeteredCount()).toBe(1);
      expect(rig.events).toEqual([]);
      rig.setUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(nativeFinal()); });
      const next = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: JSON.stringify({ model: 'synthetic-model', stream: false }) });
      expect(next.status).toBe(200);
      expect(rig.events).toHaveLength(1);
    });
  });

  it('before the upstream has answered tears down the pending upstream request, with no event and no diagnostic', async () => {
    await withRig({}, async rig => {
      let upstreamClosed = false;
      rig.setUpstream((_req, res) => { res.on('close', () => { upstreamClosed = true; }); /* never answers */ });
      const req = http.request({ host: '127.0.0.1', port: rig.proxyPort, path: '/api/generate', method: 'POST', headers: JSON_HEADERS });
      req.on('error', () => {});
      req.end(GEN_BODY);
      await waitFor(() => rig.upstreamSeen.length === 1, 'the request to reach the upstream');
      req.destroy();
      await waitFor(() => upstreamClosed, 'the pending upstream request to be torn down');
      expect(await settlesWithin(rig.proxy.close(), 2000)).toBe('settled'); // the handler settled; nothing is stuck
      expect(rig.events).toEqual([]);
      expect(rig.unmetered).toEqual([]);
    });
  });
});

describe('proxy: an upstream that goes away', () => {
  it('mid-stream is an error for the client, not a clean end, with no event and one unmetered request', async () => {
    await withRig({}, async rig => {
      rig.setUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(NDJSON_LINE, () => setTimeout(() => res.socket?.destroy(), 20));
      });
      const r = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: GEN_BODY });
      expect(r.aborted).toBe(true); // a truncated body must never look like a finished reply
      await waitFor(() => rig.unmetered.length === 1, 'the unmetered diagnostic');
      expect(rig.events).toEqual([]);
    });
  });

  it.each([
    { name: 'after some content', writeContent: true, unmetered: 1 },
    { name: 'before any content', writeContent: false, unmetered: 0 },
  ])('during a streaming /v1 completion $name counts $unmetered unmetered request(s) and never an event', async ({ writeContent, unmetered }) => {
    await withRig({}, async rig => {
      rig.setUpstream((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (writeContent) res.write('data: {"id":"c1","model":"synthetic-model","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n', () => setTimeout(() => res.socket?.destroy(), 20));
        else { res.flushHeaders(); setTimeout(() => res.socket?.destroy(), 20); }
      });
      const r = await send(rig.proxyPort, { method: 'POST', path: '/v1/chat/completions', headers: JSON_HEADERS,
        body: JSON.stringify({ model: 'synthetic-model', stream: true, stream_options: { include_usage: true } }) });
      expect(r.aborted).toBe(true);
      await rig.proxy.close(); // drains: the observation has settled
      expect(rig.unmetered).toHaveLength(unmetered);
      expect(rig.events).toEqual([]);
    });
  });
});

describe('proxy: a reply that ends without a complete count', () => {
  it('keeps a missing completion counter missing (never zero) and reports the request unmetered, while a reported zero is complete', async () => {
    await withRig({}, async rig => {
      const reply = (line: string) => rig.setUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(line); });
      const ask = () => send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: JSON.stringify({ model: 'synthetic-model', stream: false }) });

      reply(JSON.stringify({ model: 'synthetic-model', done: true, prompt_eval_count: 7 })); // no eval_count at all
      await ask();
      await rig.proxy.close(); // drain; also proves the accepted request completed
      expect(rig.events).toHaveLength(1);
      const held = rig.events[0]!;
      expect(held.tokens.countQuality).toBe('incomplete');
      expect(held.components[0]!.nativeCounterEvidence!.snapshots[0]!.eval_count).toEqual({ state: 'missing', value: null });
      expect(rig.unmetered).toEqual([{ path: '/api/generate', model: 'synthetic-model' }]);
    });
    await withRig({}, async rig => {
      rig.setUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'synthetic-model', done: true, prompt_eval_count: 7, eval_count: 0 })); });
      await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: JSON.stringify({ model: 'synthetic-model', stream: false }) });
      await rig.proxy.close();
      expect(rig.events).toHaveLength(1);
      expect(rig.events[0]!.tokens.countQuality).toBe('complete');
      expect(rig.events[0]!.components[0]!.nativeCounterEvidence!.snapshots[0]!.eval_count).toEqual({ state: 'reported', value: 0 });
      expect(rig.unmetered).toEqual([]);
    });
  });
});

describe('proxy: close() with work in flight', () => {
  it('is idempotent, waits for the accepted request and its observation, then refuses new connections', async () => {
    await withRig({}, async rig => {
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      rig.setUpstream((_req, res) => { void gate.then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(nativeFinal()); }); });
      const first = send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: JSON.stringify({ model: 'synthetic-model', stream: false }) });
      await waitFor(() => rig.upstreamSeen.length === 1, 'the request to reach the upstream');
      const closing = rig.proxy.close();
      expect(rig.proxy.close()).toBe(closing);
      let drained = false;
      void closing.then(() => { drained = true; });
      await sleep(40);
      expect(drained).toBe(false); // still waiting for the accepted request
      release();
      expect((await first).status).toBe(200);
      await closing;
      expect(rig.events).toHaveLength(1); // delivered before close() resolved
      const late = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: GEN_BODY });
      expect(late.status).toBe(0); // connection refused
      expect(rig.upstreamSeen).toHaveLength(1);
    });
  });
});

describe('daemon read API: disconnect cancels the read it started', () => {
  const TOKEN = 'synthetic-token-0123456789abcdef';
  type Control = { signal?: AbortSignal } | undefined;
  const ROUTES = [
    { name: 'usage', path: '/v1/usage?range=7d', method: 'getUsage' },
    { name: 'summary', path: '/v1/summary?range=7d', method: 'getSummary' },
    { name: 'sessions', path: '/v1/sessions?range=7d', method: 'getSessions' },
    { name: 'timeseries', path: '/v1/timeseries?range=7d&bucket=day', method: 'getTimeseries' },
    { name: 'doctor', path: '/v1/doctor', method: 'getDoctor' },
    { name: 'session detail', path: '/v1/sessions/detail?source=claude&sessionId=synthetic-session', method: 'getSessionDetail' },
  ] as const;

  async function withApi<T>(mode: 'hang' | 'complete', fn: (api: { port: number; next(method: string): Promise<Control> }) => Promise<T>): Promise<T> {
    const waiters = new Map<string, ((c: Control) => void)[]>();
    const handle = (method: string, control: Control) => {
      for (const w of waiters.get(method) ?? []) w(control);
      waiters.delete(method);
      if (mode === 'complete') return Promise.resolve({});
      return new Promise((_ok, no) => control?.signal?.addEventListener('abort', () => no(new ReportReadError('read_cancelled')), { once: true }));
    };
    const queries = Object.fromEntries(ROUTES.map(r => [r.method, (...args: unknown[]) => handle(r.method, args.at(-1) as Control)])) as unknown as Queries;
    const settings: Parameters<typeof createHttpServer>[0] = { port: 0, token: TOKEN, host: 'SYNTH', queries };
    const server = createHttpServer(settings);
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    settings.port = port;
    try {
      return await fn({ port, next: method => new Promise(ok => waiters.set(method, [...(waiters.get(method) ?? []), ok])) });
    } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); }
  }

  it('aborts the signal handed to the query when the HTTP client disconnects, for every cancellable read route', async () => {
    await withApi('hang', async api => {
      const seenSignals: AbortSignal[] = [];
      for (const route of ROUTES) {
        const control = api.next(route.method);
        const req = http.get({ host: '127.0.0.1', port: api.port, path: route.path, headers: { authorization: `Bearer ${TOKEN}` } });
        req.on('error', () => {});
        const c = await control;
        expect(c?.signal, route.name).toBeInstanceOf(AbortSignal);
        expect(c!.signal!.aborted, `${route.name} must start un-aborted (no signal shared with an earlier request)`).toBe(false);
        seenSignals.push(c!.signal!);
        req.destroy();
        await waitFor(() => c!.signal!.aborted, `${route.name} read to be cancelled`);
        expect(String((c!.signal!.reason as Error).message), route.name).toBe('read_cancelled');
      }
      expect(new Set(seenSignals).size).toBe(ROUTES.length);
    });
  });

  it('never aborts the signal of a read that completed normally, even after the connection closes', async () => {
    await withApi('complete', async api => {
      const signals: { name: string; signal: AbortSignal }[] = [];
      for (const route of ROUTES) {
        const control = api.next(route.method);
        const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: api.port, path: route.path, headers: { authorization: `Bearer ${TOKEN}`, connection: 'close' } }, resolve).on('error', reject);
        });
        res.resume();
        await new Promise(ok => res.once('close', ok));
        expect(res.statusCode, route.name).toBe(200);
        signals.push({ name: route.name, signal: (await control)!.signal! });
      }
      await sleep(40);
      for (const { name, signal } of signals) expect(signal.aborted, name).toBe(false);
    });
  });
});
