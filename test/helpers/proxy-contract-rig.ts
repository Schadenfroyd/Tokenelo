/**
 * Shared harness for the proxy contract tests (admission, cancellation, replay). Not a test file.
 *
 * Everything is in-process on 127.0.0.1 with ephemeral ports. The "upstream" is a fake HTTP server
 * that returns fabricated, content-free bodies; no real engine, model, vendor, network or data is
 * involved. Every value below is synthetic.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createOllamaProxy, type OllamaProxyDeps, type OllamaProxyHandle } from '../../src/collectors/ollama-proxy.js';
import type { UsageEvent } from '../../src/core/types.js';

export interface SeenRequest { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
export type UpstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void;
export interface LogRecord { level: string; msg: string; data?: Record<string, unknown> }

export interface Rig {
  proxy: OllamaProxyHandle;
  proxyPort: number;
  upstreamPort: number;
  /** Requests that actually reached the fake upstream, after the proxy admitted and forwarded them. */
  upstreamSeen: SeenRequest[];
  events: UsageEvent[];
  unmetered: { path: string; model?: string }[];
  annotated: { path: string; model?: string }[];
  logs: LogRecord[];
  setUpstream(handler: UpstreamHandler): void;
  /** Closes proxy (drains) and the fake upstream; safe to call twice. */
  stop(): Promise<void>;
}

export const OK_JSON: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"models":[]}');
};

/** A done:true line in Ollama's native shape, with fabricated counters. */
export function nativeFinal(fields: Record<string, unknown> = {}, model = 'synthetic-model'): string {
  return JSON.stringify({ model, done: true, prompt_eval_count: 7, eval_count: 3, ...fields });
}

export async function startRig(opts: {
  injectUsage?: boolean; maxBodyBytes?: number; upstream?: UpstreamHandler; deadUpstream?: boolean;
  proxyDeps?: Partial<OllamaProxyDeps>;
} = {}): Promise<Rig> {
  const upstreamSeen: SeenRequest[] = [];
  let handler: UpstreamHandler = opts.upstream ?? OK_JSON;
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      upstreamSeen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  let target = upstreamPort;
  if (opts.deadUpstream) {
    // A port that was bound a moment ago and is now closed: connection refused.
    const dead = http.createServer();
    await new Promise<void>(resolve => dead.listen(0, '127.0.0.1', resolve));
    target = (dead.address() as AddressInfo).port;
    await new Promise<void>(resolve => dead.close(() => resolve()));
  }

  const events: UsageEvent[] = [], unmetered: Rig['unmetered'] = [], annotated: Rig['annotated'] = [], logs: LogRecord[] = [];
  const proxy = createOllamaProxy({
    upstream: `http://127.0.0.1:${target}`, port: 0, host: 'SYNTH', injectUsage: opts.injectUsage ?? false,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    onEvent: event => events.push(event),
    onUnmetered: info => unmetered.push(info),
    onAnnotateOnly: info => annotated.push(info),
    log: (level, msg, data) => logs.push({ level, msg, data }),
    ...opts.proxyDeps,
  });
  await proxy.listen();
  const proxyPort = (proxy.server.address() as AddressInfo).port;
  let stopped: Promise<void> | undefined;
  return {
    proxy, proxyPort, upstreamPort, upstreamSeen, events, unmetered, annotated, logs,
    setUpstream: next => { handler = next; },
    stop: () => stopped ??= (async () => {
      upstream.closeAllConnections();
      proxy.server.closeAllConnections();
      await proxy.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    })(),
  };
}

export interface ClientResult {
  status: number; headers: http.IncomingHttpHeaders; body: string;
  /** True when the response ended abnormally (reset/aborted) rather than with a clean end. */
  aborted: boolean; error?: string;
}

/** One request with fully controlled headers; resolves on end, abort or error and never rejects. */
export function send(port: number, init: {
  method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; agent?: http.Agent;
}): Promise<ClientResult> {
  return new Promise(resolve => {
    let settled = false;
    const done = (r: ClientResult) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({ host: '127.0.0.1', port, path: init.path, method: init.method ?? 'GET', headers: init.headers,
      ...(init.agent ? { agent: init.agent } : {}) }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: !res.complete }));
      res.on('aborted', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true }));
      res.on('error', e => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), aborted: true, error: String(e) }));
    });
    req.on('error', e => done({ status: 0, headers: {}, body: '', aborted: true, error: String(e) }));
    if (init.body !== undefined) req.end(init.body); else req.end();
  });
}

/** Raw TCP: for request lines Node's client will not emit (absolute-form, CONNECT, truncated bodies). */
export function rawExchange(port: number, raw: string, opts: { holdOpenMs?: number } = {}): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    const s = net.connect(port, '127.0.0.1', () => s.write(raw));
    s.on('data', c => { data += c.toString('utf8'); });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    setTimeout(() => { s.destroy(); resolve(data); }, opts.holdOpenMs ?? 400);
  });
}

export async function waitFor(condition: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
