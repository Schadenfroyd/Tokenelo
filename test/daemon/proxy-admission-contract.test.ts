/**
 * Contract tests for the local metering proxy's ADMISSION and FORWARDING boundary
 * (src/collectors/ollama-proxy.ts). They add what the existing proxy tests do not pin:
 *   - a rejected request is side-effect free (never reaches the upstream, never becomes a usage
 *     event or an "unmetered" diagnostic) and does not poison the next request;
 *   - the exact loopback Host/Origin allow-lists, including lookalike names;
 *   - the body-size cap at its exact boundary, for declared and undeclared (chunked) lengths;
 *   - route classification is exact (lookalike paths are never metered) and the query string is forwarded verbatim;
 *   - credentials of the proxy hop are never forwarded upstream;
 *   - upstream error responses and unreachable upstreams never become usage (no invented zero);
 *   - usage injection happens only for a streaming /v1 chat or text completion that did not ask for usage;
 *   - the emitted UsageEvent and the logs carry no prompt, response or credential text.
 *
 * Everything is in-process on 127.0.0.1 with ephemeral ports and fabricated payloads. No engine,
 * model, vendor, network or real data. These cases are contract regressions for admission
 * behavior; they do not exercise a real proxy deployment, real authentication or the farm.
 */
import { describe, expect, it } from 'vitest';
import {
  nativeFinal, rawExchange, send, startRig, sleep, type Rig, type UpstreamHandler,
} from '../helpers/proxy-contract-rig.js';

const GEN_BODY = JSON.stringify({ model: 'synthetic-model', stream: false });
const JSON_HEADERS = { 'content-type': 'application/json' };
const nativeOk: UpstreamHandler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(nativeFinal()); };

const sse = (...payloads: string[]) => payloads.map(p => `data: ${p}\n\n`).join('') + 'data: [DONE]\n\n';
const contentChunk = JSON.stringify({ id: 'c1', model: 'synthetic-model', choices: [{ index: 0, delta: { content: 'x' } }] });
const usageChunk = JSON.stringify({ id: 'c1', model: 'synthetic-model', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
const sseOk: UpstreamHandler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse(contentChunk, usageChunk)); };

async function withRig<T>(opts: Parameters<typeof startRig>[0], fn: (rig: Rig) => Promise<T>): Promise<T> {
  const rig = await startRig(opts);
  try { return await fn(rig); } finally { await rig.stop(); }
}

/** A well-formed metered request, used to prove the proxy still works after a rejection. */
async function validRequestIsMeteredOnce(rig: Rig): Promise<void> {
  rig.setUpstream(nativeOk);
  const before = rig.events.length, seen = rig.upstreamSeen.length;
  const ok = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: GEN_BODY });
  expect(ok.status).toBe(200);
  expect(rig.events.length).toBe(before + 1);
  expect(rig.upstreamSeen.length).toBe(seen + 1);
}

describe('rejected admission is side-effect free', () => {
  const rows: { name: string; status: number; attempt: (rig: Rig) => Promise<{ status: number; text: string }> }[] = [
    { name: 'a Host naming another machine', status: 403,
      attempt: async rig => { const r = await send(rig.proxyPort, { method: 'POST', path: '/api/chat', headers: { ...JSON_HEADERS, host: `evil.example:${rig.proxyPort}` }, body: GEN_BODY }); return { status: r.status, text: r.body }; } },
    { name: 'a loopback Host on the wrong port', status: 403,
      attempt: async rig => { const r = await send(rig.proxyPort, { method: 'POST', path: '/api/chat', headers: { ...JSON_HEADERS, host: '127.0.0.1:1' }, body: GEN_BODY }); return { status: r.status, text: r.body }; } },
    { name: 'a lookalike loopback Origin (localhost.evil.example)', status: 403,
      attempt: async rig => { const r = await send(rig.proxyPort, { method: 'POST', path: '/api/chat', headers: { ...JSON_HEADERS, origin: 'http://localhost.evil.example' }, body: GEN_BODY }); return { status: r.status, text: r.body }; } },
    { name: 'the literal Origin "null"', status: 403,
      attempt: async rig => { const r = await send(rig.proxyPort, { method: 'POST', path: '/api/chat', headers: { ...JSON_HEADERS, origin: 'null' }, body: GEN_BODY }); return { status: r.status, text: r.body }; } },
    { name: 'an absolute-form request target (forward-proxy use)', status: 400,
      attempt: async rig => {
        const text = await rawExchange(rig.proxyPort, `POST http://evil.invalid/api/chat HTTP/1.1\r\nHost: 127.0.0.1:${rig.proxyPort}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
        return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text };
      } },
    { name: 'a CONNECT tunnel request', status: 0,
      attempt: async rig => { const text = await rawExchange(rig.proxyPort, 'CONNECT evil.invalid:443 HTTP/1.1\r\nHost: evil.invalid:443\r\n\r\n'); return { status: 0, text }; } },
  ];
  it.each(rows)('$name never reaches the upstream, is not metered, and the proxy keeps serving', async row => {
    await withRig({}, async rig => {
      const result = await row.attempt(rig);
      expect(result.status).toBe(row.status);
      if (row.status === 0) expect(result.text).toBe(''); // the tunnel is destroyed without any response bytes
      await sleep(30); // a forwarded request would have reached the upstream by now
      expect(rig.upstreamSeen).toEqual([]);
      expect(rig.events).toEqual([]);
      expect(rig.unmetered).toEqual([]);
      expect(rig.annotated).toEqual([]);
      expect(rig.proxy.unmeteredCount()).toBe(0);
      await validRequestIsMeteredOnce(rig);
    });
  });
});

describe('accepted loopback forms', () => {
  it('forwards and meters a request with each allowed Host form and each loopback Origin form', async () => {
    await withRig({ upstream: nativeOk }, async rig => {
      const hosts = [`127.0.0.1:${rig.proxyPort}`, `localhost:${rig.proxyPort}`, `[::1]:${rig.proxyPort}`];
      const origins = ['http://localhost:3000', 'https://127.0.0.1', 'http://[::1]:8080', 'HTTP://LOCALHOST:1'];
      let n = 0;
      for (const host of hosts) {
        const r = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: { ...JSON_HEADERS, host }, body: GEN_BODY });
        expect(r.status, `Host ${host}`).toBe(200); n++;
      }
      for (const origin of origins) {
        const r = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: { ...JSON_HEADERS, origin }, body: GEN_BODY });
        expect(r.status, `Origin ${origin}`).toBe(200); n++;
      }
      expect(rig.upstreamSeen).toHaveLength(n);
      expect(rig.events).toHaveLength(n);
    });
  });
});

describe('request-body cap boundary', () => {
  const CAP = 256;
  const bodyOfSize = (size: number) => {
    const head = '{"model":"synthetic-model","stream":false,"pad":"', tail = '"}';
    const body = head + 'p'.repeat(size - head.length - tail.length) + tail;
    expect(Buffer.byteLength(body)).toBe(size);
    return body;
  };
  it('accepts a declared body of exactly the cap byte-for-byte and rejects cap+1 before the upstream is contacted', async () => {
    await withRig({ maxBodyBytes: CAP, upstream: nativeOk }, async rig => {
      const exact = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: bodyOfSize(CAP) });
      expect(exact.status).toBe(200);
      expect(rig.upstreamSeen).toHaveLength(1);
      expect(rig.upstreamSeen[0]!.body.toString('utf8')).toBe(bodyOfSize(CAP));
      expect(rig.events).toHaveLength(1);
      const over = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: JSON_HEADERS, body: bodyOfSize(CAP + 1) });
      expect(over.status).toBe(413);
      expect(rig.upstreamSeen).toHaveLength(1);
      expect(rig.events).toHaveLength(1);
    });
  });
  it('applies the same boundary to a chunked body that declares no length', async () => {
    await withRig({ maxBodyBytes: CAP, upstream: nativeOk }, async rig => {
      const chunked = { 'content-type': 'application/json', 'transfer-encoding': 'chunked' };
      const exact = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: chunked, body: bodyOfSize(CAP) });
      expect(exact.status).toBe(200);
      expect(rig.upstreamSeen).toHaveLength(1);
      expect(rig.upstreamSeen[0]!.body.byteLength).toBe(CAP);
      const over = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', headers: chunked, body: bodyOfSize(CAP + 1) });
      expect(over.status).toBe(413);
      expect(rig.upstreamSeen).toHaveLength(1);
      expect(rig.events).toHaveLength(1);
      expect(rig.unmetered).toEqual([]);
    });
  });
});

describe('route classification is exact', () => {
  it('never meters a lookalike path even when the upstream answers with a usage-shaped body, and forwards the target verbatim', async () => {
    await withRig({ upstream: nativeOk }, async rig => {
      const lookalikes = ['/api/chat/', '/API/chat', '/api/chats', '/v1/chat/completions/', '/api//chat', '/api/chat%2F'];
      for (const path of lookalikes) {
        const r = await send(rig.proxyPort, { method: 'POST', path, headers: JSON_HEADERS, body: GEN_BODY });
        expect(r.status, path).toBe(200);
        expect(r.body, path).toBe(nativeFinal());
      }
      expect(rig.upstreamSeen.map(s => s.url)).toEqual(lookalikes);
      expect(rig.events).toEqual([]);
      expect(rig.unmetered).toEqual([]);
      // The positive control: the real path with a query string is metered and its query is forwarded unchanged.
      const metered = await send(rig.proxyPort, { method: 'POST', path: '/api/chat?x=1&y=two', headers: JSON_HEADERS, body: GEN_BODY });
      expect(metered.status).toBe(200);
      expect(rig.upstreamSeen.at(-1)!.url).toBe('/api/chat?x=1&y=two');
      expect(rig.events).toHaveLength(1);
    });
  });
});

describe('header forwarding', () => {
  it('forwards end-to-end headers, replaces Host, and never forwards proxy-hop credentials in either direction', async () => {
    await withRig({
      upstream: (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-note': 'n1', 'set-cookie': 'a=b', 'proxy-authenticate': 'Basic realm=SYNTH' });
        res.end(nativeFinal());
      },
    }, async rig => {
      const r = await send(rig.proxyPort, { method: 'POST', path: '/api/generate', body: GEN_BODY, headers: {
        ...JSON_HEADERS, authorization: 'Bearer SYNTH-CLIENT-CREDENTIAL', 'x-synth-trace': 'abc', 'user-agent': 'synth-agent/1',
        'proxy-authorization': 'Basic SYNTH-PROXY-CREDENTIAL', 'proxy-connection': 'keep-alive',
      } });
      expect(r.status).toBe(200);
      const seen = rig.upstreamSeen[0]!.headers;
      expect(seen.authorization).toBe('Bearer SYNTH-CLIENT-CREDENTIAL');
      expect(seen['x-synth-trace']).toBe('abc');
      expect(seen['content-type']).toBe('application/json');
      expect(seen['proxy-authorization']).toBeUndefined();
      expect(seen['proxy-connection']).toBeUndefined();
      expect(seen.host).toBe(`127.0.0.1:${rig.upstreamPort}`);
      expect(r.headers['x-upstream-note']).toBe('n1');
      expect(r.headers['set-cookie']).toEqual(['a=b']);
      expect(r.headers['proxy-authenticate']).toBeUndefined();
      expect(rig.events[0]!.entrypoint).toBe('synth-agent/1');
    });
  });
});

describe('upstream failure never becomes usage', () => {
  it('an HTTP error from the upstream is relayed verbatim on every metered path and yields no usage event, even when its body looks like a usage report', async () => {
    const cases = [
      { path: '/api/chat', status: 500, body: nativeFinal() },
      { path: '/v1/chat/completions', status: 404, body: JSON.stringify({ model: 'synthetic-model', usage: { prompt_tokens: 7, completion_tokens: 3 } }) },
      { path: '/v1/embeddings', status: 503, body: JSON.stringify({ model: 'synthetic-model', usage: { prompt_tokens: 7 } }) },
    ];
    for (const { path, status, body } of cases) {
      await withRig({ upstream: (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); } }, async rig => {
        const r = await send(rig.proxyPort, { method: 'POST', path, headers: JSON_HEADERS, body: JSON.stringify({ model: 'synthetic-model', stream: false, input: 'x' }) });
        expect(r.status, path).toBe(status);
        expect(r.body, path).toBe(body);
        await rig.proxy.close();
        expect(rig.events, path).toEqual([]);
        expect(rig.unmetered, path).toEqual([]); // current behavior: a failed request is not reported as unmetered usage either
        expect(rig.proxy.unmeteredCount(), path).toBe(0);
      });
    }
  });

  it('an unreachable upstream is a 502 with no event, logs no request content, and leaves the proxy serving', async () => {
    await withRig({ deadUpstream: true }, async rig => {
      const r = await send(rig.proxyPort, { method: 'POST', path: '/api/chat', headers: { ...JSON_HEADERS, authorization: 'Bearer SYNTH-SECRET' },
        body: JSON.stringify({ model: 'synthetic-model', stream: false, prompt: 'SYNTH-PROMPT-TEXT' }) });
      expect(r.status).toBe(502);
      expect(rig.events).toEqual([]);
      expect(rig.unmetered).toEqual([]);
      expect(rig.logs.some(l => l.level === 'error')).toBe(true);
      expect(JSON.stringify(rig.logs)).not.toMatch(/SYNTH-PROMPT-TEXT|SYNTH-SECRET/);
      const again = await send(rig.proxyPort, { method: 'POST', path: '/api/chat', headers: JSON_HEADERS, body: GEN_BODY });
      expect(again.status).toBe(502);
    });
  });
});

describe('usage injection admission', () => {
  const STREAM = (extra: Record<string, unknown> = {}) => JSON.stringify({ model: 'synthetic-model', stream: true, ...extra });
  const post = (rig: Rig, path: string, body: string) => send(rig.proxyPort, { method: 'POST', path, headers: JSON_HEADERS, body });

  it('does not touch a request that already asked for usage, and the client still receives the usage chunk', async () => {
    await withRig({ injectUsage: true, upstream: sseOk }, async rig => {
      const body = STREAM({ stream_options: { include_usage: true } });
      const r = await post(rig, '/v1/chat/completions', body);
      expect(rig.upstreamSeen[0]!.body.toString('utf8')).toBe(body);
      expect(r.body).toBe(sse(contentChunk, usageChunk)); // not stripped: the client asked for it
      expect(rig.events).toHaveLength(1);
    });
  });

  it('adds include_usage next to foreign stream_options, keeps the length header exact, and strips only the added chunk from the client', async () => {
    await withRig({ injectUsage: true, upstream: sseOk }, async rig => {
      const r = await post(rig, '/v1/chat/completions', STREAM({ stream_options: { foo: 1 } }));
      const forwarded = rig.upstreamSeen[0]!;
      expect(JSON.parse(forwarded.body.toString('utf8')).stream_options).toEqual({ foo: 1, include_usage: true });
      expect(forwarded.headers['content-length']).toBe(String(forwarded.body.byteLength));
      expect(r.body).toBe(sse(contentChunk)); // the usage-only chunk never reaches a client that did not ask
      expect(rig.events).toHaveLength(1);
      expect(rig.events[0]!.tokens).toMatchObject({ inputFresh: 7, output: 3 });
    });
  });

  it('leaves a non-streaming request byte-identical', async () => {
    await withRig({ injectUsage: true, upstream: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'synthetic-model', choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    } }, async rig => {
      const body = JSON.stringify({ model: 'synthetic-model', stream: false });
      await post(rig, '/v1/chat/completions', body);
      expect(rig.upstreamSeen[0]!.body.toString('utf8')).toBe(body);
      expect(rig.events).toHaveLength(1);
    });
  });

  it('injects only on the two /v1 completion endpoints: native chat and embeddings requests stay byte-identical', async () => {
    await withRig({ injectUsage: true, upstream: nativeOk }, async rig => {
      for (const path of ['/api/chat', '/v1/embeddings', '/v1/messages']) {
        const body = STREAM({ input: 'x' });
        await post(rig, path, body);
        expect(rig.upstreamSeen.at(-1)!.body.toString('utf8'), path).toBe(body);
        expect(rig.upstreamSeen.at(-1)!.body.toString('utf8'), path).not.toContain('include_usage');
      }
    });
  });

  it('forwards a malformed JSON body byte-identically, relays the reply and records no usage or diagnostic', async () => {
    await withRig({ injectUsage: true, upstream: sseOk }, async rig => {
      const body = '{"model":"synthetic-model","stream":true,';
      const r = await post(rig, '/v1/chat/completions', body);
      expect(r.status).toBe(200);
      expect(rig.upstreamSeen[0]!.body.toString('utf8')).toBe(body);
      expect(r.body).toBe(sse(contentChunk, usageChunk)); // nothing was injected, so nothing is stripped
      expect(rig.events).toEqual([]); // the request was not parseable, so it was not classified as a stream and not metered
      expect(rig.unmetered).toEqual([]);
    });
  });
});

describe('what the proxy records', () => {
  const SENTINELS = ['SYNTH-PROMPT-TEXT', 'SYNTH-RESPONSE-TEXT', 'SYNTH-CREDENTIAL', 'SYNTH-COOKIE'];
  const requestHeaders = { ...JSON_HEADERS, authorization: 'Bearer SYNTH-CREDENTIAL', cookie: 'session=SYNTH-COOKIE', 'user-agent': 'synth-agent/1' };
  const ALLOWED_EVENT_KEYS = ['id', 'host', 'source', 'ts', 'tsSource', 'sessionId', 'isSubagent', 'entrypoint', 'model', 'provider', 'engine', 'thinking',
    'components', 'tokens', 'durationMs', 'perf', 'flags', 'apiEquivUsd', 'priceStatus', 'priceVersion', 'reservedValue', 'ucuRateStatus', 'eacsDefSha256'];
  const rows: { name: string; path: string; body: object; reply: UpstreamHandler }[] = [
    { name: 'native chat', path: '/api/chat', body: { model: 'synthetic-model', stream: false, messages: [{ role: 'user', content: 'SYNTH-PROMPT-TEXT' }] },
      reply: (_r, res) => { res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'synthetic-model', message: { role: 'assistant', content: 'SYNTH-RESPONSE-TEXT' }, done: true, prompt_eval_count: 7, eval_count: 3 })); } },
    { name: 'streaming /v1 completion', path: '/v1/chat/completions', body: { model: 'synthetic-model', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'SYNTH-PROMPT-TEXT' }] },
      reply: (_r, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse(JSON.stringify({ id: 'c1', model: 'synthetic-model', choices: [{ index: 0, delta: { content: 'SYNTH-RESPONSE-TEXT' } }] }), usageChunk)); } },
  ];
  it('a recorded event carries counts and identity only: no prompt, response, credential or cookie text, on the native and the streaming /v1 path', async () => {
    for (const row of rows) {
      await withRig({ upstream: row.reply }, async rig => {
        const r = await send(rig.proxyPort, { method: 'POST', path: row.path, headers: requestHeaders, body: JSON.stringify(row.body) });
        expect(r.status, row.name).toBe(200);
        expect(rig.events, row.name).toHaveLength(1);
        const event = rig.events[0]!;
        const text = JSON.stringify({ event, logs: rig.logs });
        for (const s of SENTINELS) expect(text, `${row.name}: ${s}`).not.toContain(s);
        expect(Object.keys(event).filter(k => !ALLOWED_EVENT_KEYS.includes(k)), row.name).toEqual([]);
        expect(event.components.flatMap(c => Object.keys(c)).filter(k => !['model', 'tokens', 'nativeCounterEvidence'].includes(k)), row.name).toEqual([]);
        expect(event.tokens, row.name).toMatchObject({ inputFresh: 7, output: 3 });
      });
    }
  });
});
