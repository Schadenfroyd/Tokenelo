/**
 * Contract tests for the optional Fleet surface being AGGREGATE-ONLY and AUTHENTICATED, at three boundaries:
 *
 *   - the listener (src/daemon/fleet.ts): one data route, strict admission order, closed projection;
 *   - the data it is built from (src/store/queries.ts getSummary, real ledger + real Queries): every key
 *     and every string value that can cross the boundary belongs to a closed set, so a new field or a leaked
 *     identifier (path, branch, session, parent session, entrypoint) fails here and needs a reviewed decision;
 *   - the client (src/tray/api-client.ts getFleetOverview) talking to REAL in-process listeners: a token is
 *     only ever sent to the peer it belongs to, only after that peer proved it holds it, and never to an
 *     endpoint outside the Tailnet range.
 *
 * Everything runs in this process on 127.0.0.1 with ephemeral ports and fabricated data. The Tailnet
 * addresses below are only Host-header labels routed to loopback by a test shim; no Tailscale, no network,
 * no real host, token, path or identity is involved. Three in-process listeners are NOT the authenticated
 * three-host Fleet acceptance, which needs three real hosts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFleetHttpServer, FLEET_PORT, getFleetPeerTokenPath, isTailnetPeerUrl } from '../../src/daemon/fleet.js';
import { createHttpServer } from '../../src/daemon/http.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { ReportReadError } from '../../src/daemon/report-read-protocol.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries, type Queries } from '../../src/store/queries.js';
import { createApiClient } from '../../src/tray/api-client.js';
import { USAGE_SOURCES, type Range, type SummaryResponse, type UsageEvent } from '../../src/core/types.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { makeEvent } from '../store/stubs.js';

const ADDRESS = '100.64.0.7';
const TOKEN = 'a'.repeat(64);
const RANGES: Range[] = ['today', '24h', '7d', '30d', 'all'];

const stubSummary = {
  host: 'M4a', range: '7d', generatedAt: 100,
  totals: { events: 2, tokens: { inputFresh: 10, cacheWrite5m: 1, cacheWrite1h: 0, cacheRead: 2, output: 4, reasoning: 1 }, apiEquivUsd: 0.25, unpricedEvents: 0 },
  bySource: {}, activeTime: { agentMs: 40, wallMs: 30 },
} as unknown as SummaryResponse;

/** A Queries whose every method except getSummary is forbidden and recorded: the listener must never call them. */
function recordingQueries(getSummary: Queries['getSummary'] = async () => stubSummary) {
  const calls: string[] = [];
  const queries = new Proxy({}, {
    get: (_t, prop) => (...args: unknown[]) => {
      calls.push(String(prop));
      if (prop === 'getSummary') return (getSummary as (...a: unknown[]) => unknown)(...args);
      throw new Error(`the Fleet listener must not call ${String(prop)}`);
    },
  }) as unknown as Queries;
  return { queries, calls };
}

interface Listener { port: number; calls: string[]; close(): Promise<void> }
async function startListener(opts: { queries?: Queries; calls?: string[]; token?: string; host?: string; address?: string } = {}): Promise<Listener> {
  const rec = opts.queries ? { queries: opts.queries, calls: opts.calls ?? [] } : recordingQueries();
  const server = createFleetHttpServer({ address: opts.address ?? ADDRESS, port: FLEET_PORT, token: opts.token ?? TOKEN, queries: rec.queries, host: opts.host ?? 'M4a' });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  return { port: (server.address() as AddressInfo).port, calls: rec.calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); } };
}

interface Result { status: number; text: string; json: unknown }
function call(l: Listener, p: string, o: { method?: string; host?: string | null; auth?: string | null; origin?: string } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (o.host !== null) headers.host = o.host ?? `${ADDRESS}:${FLEET_PORT}`;
    if (o.auth !== null) headers.authorization = o.auth ?? `Bearer ${TOKEN}`;
    if (o.origin !== undefined) headers.origin = o.origin;
    const req = http.request({ host: '127.0.0.1', port: l.port, path: p, method: o.method ?? 'GET', headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode ?? 0, text, json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

let listeners: Listener[] = [];
afterEach(async () => { await Promise.all(listeners.map(l => l.close())); listeners = []; });
async function listener(opts: Parameters<typeof startListener>[0] = {}): Promise<Listener> { const l = await startListener(opts); listeners.push(l); return l; }

// ── Listener: routes, order of checks, credentials ───────────────────────────────────────────

describe('Fleet listener admission', () => {
  const LOCAL_ONLY_ROUTES = ['/v1/summary', '/v1/usage', '/v1/sessions', '/v1/sessions/detail?source=claude&sessionId=x', '/v1/limits', '/v1/limits/history',
    '/v1/processes', '/v1/coverage', '/v1/timeseries', '/v1/doctor', '/v1/health', '/v1/summary/read', '/v1/fleet', '/v1/fleet/sessions',
    '/v1/fleet/summary/extra', '/v1/fleet/summary/'];

  it('serves exactly one data route: every other route 404s for a valid credential and runs no query', async () => {
    const l = await listener();
    for (const route of LOCAL_ONLY_ROUTES) expect((await call(l, route)).status, route).toBe(404);
    expect(l.calls).toEqual([]);
    expect((await call(l, '/v1/fleet/summary?range=7d')).status).toBe(200);
    expect(l.calls).toEqual(['getSummary']);
  });

  it('answers the same routes without a credential with 401, so the route set is not revealed, and runs no query', async () => {
    const l = await listener();
    for (const route of [...LOCAL_ONLY_ROUTES, '/v1/fleet/summary', '/nonexistent']) expect((await call(l, route, { auth: null })).status, route).toBe(401);
    expect(l.calls).toEqual([]);
  });

  it('refuses every method other than GET before authentication or any query', async () => {
    const l = await listener();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      expect((await call(l, '/v1/fleet/summary?range=7d', { method })).status, method).toBe(405);
      expect((await call(l, '/v1/fleet/summary?range=7d', { method, auth: null })).status, `${method} without credential`).toBe(405);
    }
    expect(l.calls).toEqual([]);
  });

  it('checks Host, then Origin, then credential, then range, and the unauthenticated hello obeys the Host and Origin guards', async () => {
    const l = await listener();
    const nonce = 'f'.repeat(32);
    expect((await call(l, '/v1/fleet/summary?range=forever', { host: 'evil.example:47822' })).status).toBe(403);
    expect((await call(l, '/v1/fleet/summary', { host: `${ADDRESS}:${FLEET_PORT + 1}` })).status).toBe(403);
    expect((await call(l, '/v1/fleet/summary?range=forever', { origin: 'http://localhost' })).status).toBe(403);
    expect((await call(l, `/v1/fleet/hello?nonce=${nonce}`, { auth: null, host: 'evil.example:47822' })).status).toBe(403);
    expect((await call(l, `/v1/fleet/hello?nonce=${nonce}`, { auth: null, origin: 'http://localhost' })).status).toBe(403);
    expect((await call(l, '/v1/fleet/summary?range=forever', { auth: 'Bearer wrong' })).status).toBe(401); // credential before range
    expect((await call(l, '/v1/fleet/summary?range=forever')).status).toBe(400);
    expect(l.calls).toEqual([]);
  });

  it('rejects every malformed or foreign credential form, and never accepts a credential in the query string, running no query', async () => {
    const l = await listener();
    const forms: [string, string][] = [
      ['a lowercase scheme', `bearer ${TOKEN}`], ['a doubled space after the scheme', `Bearer  ${TOKEN}`], ['another scheme', `Basic ${TOKEN}`],
      ['the bare token', TOKEN], ['a one-character difference', `Bearer ${TOKEN.slice(0, -1)}b`], ['an empty bearer', 'Bearer '],
    ];
    for (const [name, header] of forms) expect((await call(l, '/v1/fleet/summary?range=7d', { auth: header })).status, name).toBe(401);
    expect((await call(l, `/v1/fleet/summary?range=7d&token=${TOKEN}`, { auth: null })).status, 'query-string credential').toBe(401);
    expect(l.calls).toEqual([]);
  });

  it('admits only the five documented ranges (default today) and forwards the validated range unchanged', async () => {
    const l = await listener();
    expect((await call(l, '/v1/fleet/summary')).status).toBe(200);
    for (const range of RANGES) expect((await call(l, `/v1/fleet/summary?range=${range}`)).status, range).toBe(200);
    for (const bad of ['', '7D', 'all%20', '7d,30d', 'week', '../all']) expect((await call(l, `/v1/fleet/summary?range=${bad}`)).status, `range=${bad}`).toBe(400);
    expect(l.calls).toEqual(Array(1 + RANGES.length).fill('getSummary'));
  });

  it('the identity challenge returns only a keyed proof of the nonce, for a strict 32-hex nonce, and needs no credential', async () => {
    const l = await listener();
    const a = (await call(l, `/v1/fleet/hello?nonce=${'0'.repeat(32)}`, { auth: null })).json as Record<string, string>;
    const b = (await call(l, `/v1/fleet/hello?nonce=${'1'.repeat(32)}`, { auth: null })).json as Record<string, string>;
    expect(Object.keys(a)).toEqual(['proof']);
    expect(a.proof).toBe(crypto.createHmac('sha256', TOKEN).update('0'.repeat(32)).digest('hex'));
    expect(a.proof).not.toBe(b.proof);
    expect(JSON.stringify([a, b])).not.toContain(TOKEN);
    for (const bad of ['', `nonce=${'0'.repeat(31)}`, `nonce=${'0'.repeat(33)}`, `nonce=${'g'.repeat(32)}`, `nonce=${'0'.repeat(32)}00`])
      expect((await call(l, `/v1/fleet/hello?${bad}`, { auth: null })).status, bad).toBe(400);
  });
});

describe('Fleet listener failure handling', () => {
  it('maps each read failure to its HTTP status (capacity 429, timeout 504, unavailable and failed 503) and keeps serving', async () => {
    let failure: ReportReadError | null = null;
    const { queries, calls } = recordingQueries(async () => { if (failure) throw failure; return stubSummary; });
    const l = await listener({ queries, calls });
    for (const [code, status] of [['read_capacity', 429], ['read_timeout', 504], ['read_unavailable', 503], ['query_failed', 503]] as const) {
      failure = new ReportReadError(code);
      const r = await call(l, '/v1/fleet/summary?range=7d');
      expect(r.status, code).toBe(status);
      expect((r.json as { error: string }).error, code).toBe(code);
      failure = null;
      expect((await call(l, '/v1/fleet/summary?range=7d')).status, `after ${code}`).toBe(200);
    }
  });

  it('turns an unexpected error into a bare 500 that does not echo the error text, and keeps serving', async () => {
    let fail = true;
    const { queries, calls } = recordingQueries(async () => { if (fail) throw new Error('SYNTH-INTERNAL /synthetic/path stack'); return stubSummary; });
    const l = await listener({ queries, calls });
    const r = await call(l, '/v1/fleet/summary?range=7d');
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: 'internal_error' });
    expect(r.text).not.toContain('SYNTH-INTERNAL');
    fail = false;
    expect((await call(l, '/v1/fleet/summary?range=7d')).status).toBe(200);
  });

  it('aborts the read when the peer disconnects, and never aborts a read that finished', async () => {
    let signal: AbortSignal | undefined, release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let hold = true;
    const { queries, calls } = recordingQueries(async (_range, control) => {
      signal = control?.signal;
      if (hold) await new Promise<void>((_ok, no) => control?.signal?.addEventListener('abort', () => no(new ReportReadError('read_cancelled')), { once: true }));
      await gate;
      return stubSummary;
    });
    const l = await listener({ queries, calls });
    const req = http.get({ host: '127.0.0.1', port: l.port, path: '/v1/fleet/summary?range=7d', headers: { host: `${ADDRESS}:${FLEET_PORT}`, authorization: `Bearer ${TOKEN}` } });
    req.on('error', () => {});
    const end = Date.now() + 3000;
    while (!signal && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    expect(signal?.aborted).toBe(false);
    req.destroy();
    while (!signal!.aborted && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    expect(signal!.aborted).toBe(true);
    expect(String((signal!.reason as Error).message)).toBe('read_cancelled');

    hold = false; release();
    const finished = await call(l, '/v1/fleet/summary?range=7d');
    expect(finished.status).toBe(200);
    await new Promise(r => setTimeout(r, 40));
    expect(signal!.aborted).toBe(false); // the signal of the completed read; a new signal per request
  });

  it('refuses to be constructed for any address outside the Tailscale ranges', () => {
    const { queries } = recordingQueries();
    for (const address of ['', '0.0.0.0', '::', '::1', '127.0.0.1', '192.168.1.5', '10.0.0.1', '100.63.255.255', '100.128.0.0', 'localhost', ' 100.64.0.7', '100.64.0.7/32', 'fd7b:115c:a1e0::1'])
      expect(() => createFleetHttpServer({ address, token: TOKEN, queries, host: 'M4a' }), JSON.stringify(address)).toThrow(/Tailscale/);
  });
});

// ── Closed projection over REAL data ─────────────────────────────────────────────────────────

const SENTINEL = 'SYNTH-PRIVATE';
/** Every object key allowed anywhere in a Fleet summary. A new key from Queries must be added here on purpose. */
const ALLOWED_KEYS = new Set([
  'host', 'range', 'generatedAt', 'totals', 'bySource', 'activeTime', 'agentMs', 'wallMs',
  'events', 'tokens', 'apiEquivUsd', 'unpricedEvents', 'estimatedPriceEvents', 'priceStatus', 'priceEvidence',
  'inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnassigned', 'cacheWriteAssumed1h', 'cacheRead', 'output', 'reasoning', 'countQuality', 'ucuCountQuality', 'fieldEvidence',
  'version', 'invalidAmountEvents', 'unknownStatusEvents', 'statusAmountConflictEvents', 'issuesEvents', 'aggregateAmountInvalid',
  ...USAGE_SOURCES,
  // fieldEvidence counters
  'knownValue', 'knownParts', 'reportedParts', 'derivedParts', 'normalizedParts', 'assumedParts', 'notApplicableParts', 'missingParts', 'invalidParts', 'unrecordedParts',
]);
const ALLOWED_STRING_VALUES = new Set(['LIST', 'ESTIMATE', 'UNPRICED', 'NONE',
  'complete', 'incomplete', 'invalid', 'conflict', 'unrecorded', 'today', '24h', '7d', '30d', 'all', ...USAGE_SOURCES]);

function walk(value: unknown, onKey: (k: string) => void, onString: (s: string, at: string) => void, at = ''): void {
  if (Array.isArray(value)) value.forEach(v => walk(v, onKey, onString, `${at}[]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { onKey(k); walk(v, onKey, onString, `${at}.${k}`); }
  else if (typeof value === 'string') onString(value, at);
}

/** A ledger whose events carry identifying metadata a Fleet peer must never receive. */
function seededQueries(hostLabel: string, now: number) {
  const db = openDb({ file: ':memory:' });
  const ledger = new SqliteLedger(db, defaultPricingEngine(), createNullEngine());
  const meta = (e: UsageEvent, i: number): UsageEvent => ({ ...e, project: `/${SENTINEL}/project-${i}`, repoRoot: `/${SENTINEL}/repo-${i}`, gitBranch: `${SENTINEL}-branch-${i}`,
    entrypoint: `${SENTINEL}-entry-${i}`, parentSessionId: `${SENTINEL}-parent-${i}`, sessionId: `${SENTINEL}-session-${i}` });
  const events = [
    meta(makeEvent({ id: `${hostLabel}-1`, ts: now - 5_000, inputFresh: 100, output: 20, source: 'claude', model: 'claude-sonnet-5' }), 1),
    meta(makeEvent({ id: `${hostLabel}-2`, ts: now - 4_000, inputFresh: 40, output: 10, source: 'codex', model: 'gpt-6-sol' }), 2),
    meta({ ...makeEvent({ id: `${hostLabel}-3`, ts: now - 3_000, inputFresh: 7, output: 3, source: 'qwen-code', model: `${SENTINEL}-model` }),
      components: [{ model: 'qwen3:8b', tokens: { inputFresh: 7, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 3, reasoning: 0 }, servingRoute: { kind: 'hosted', evidence: 'qwen-oauth' } }] }, 3),
  ];
  ledger.upsertEvents(events);
  ledger.recordActivity([{ source: 'claude', sessionId: `${SENTINEL}-session-1`, ts: now - 5_500, kind: 'assistant', uuid: `${SENTINEL}-uuid`, host: hostLabel, project: `/${SENTINEL}/project-1` } as never]);
  const queries = createQueries(db, defaultConfig({ hostLabel }), { now: () => now, probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }) });
  return { db, queries };
}

describe('Fleet summary built from real ledger data', () => {
  it('carries only aggregate keys and aggregate vocabulary for every range, and none of the seeded identifiers', async () => {
    const now = Date.now();
    const { db, queries } = seededQueries('M4a', now);
    try {
      const l = await listener({ queries });
      for (const range of RANGES) {
        const r = await call(l, `/v1/fleet/summary?range=${range}`);
        expect(r.status, range).toBe(200);
        const body = r.json as Record<string, unknown>;
        expect(Object.keys(body).sort(), range).toEqual(['activeTime', 'bySource', 'generatedAt', 'host', 'range', 'totals']);
        expect(r.text, range).not.toContain(SENTINEL);
        expect(r.text, range).not.toMatch(/project|repoRoot|gitBranch|sessionId|parentSession|entrypoint|uuid|byModel|subscriptions|qwen3:8b|claude-sonnet|gpt-6/);
        const strangeKeys: string[] = [], strangeStrings: string[] = [];
        walk(body, k => { if (!ALLOWED_KEYS.has(k)) strangeKeys.push(k); },
          (s, at) => { if (!(ALLOWED_STRING_VALUES.has(s) || (at === '.host' && s === 'M4a'))) strangeStrings.push(`${at}=${s}`); });
        expect(strangeKeys, range).toEqual([]);
        expect(strangeStrings, range).toEqual([]);
        expect(Object.keys(body.bySource as object).every(k => (USAGE_SOURCES as readonly string[]).includes(k)), range).toBe(true);
        if (range !== 'today') expect((body.totals as { events: number }).events, range).toBe(3);
      }
    } finally { db.close(); }
  });

  it('keeps unrecorded counts and unpriced work distinct from zero in what it exposes', async () => {
    const now = Date.now();
    const { db, queries } = seededQueries('M4a', now);
    try {
      const l = await listener({ queries });
      const totals = ((await call(l, '/v1/fleet/summary?range=7d')).json as { totals: Record<string, unknown> & { tokens: Record<string, unknown> } }).totals;
      expect(totals.events).toBe(3);
      expect(totals.unpricedEvents).toBe(1); // the hosted-reported open-weight component is not priced as free local work
      expect(totals.priceStatus).toBe('UNPRICED');
      expect(totals.tokens.countQuality).toBe('unrecorded'); // legacy fixture rows carry no count provenance: not "complete"
    } finally { db.close(); }
  });
});

describe('Fleet listener and a legacy figure from an older daemon', () => {
  // A summary as an older edition's daemon returned it: the totals and a source entry each still carry a figure object.
  // This edition's listener rebuilds every aggregate field by field, so the figure must not reach a Fleet reader.
  const legacyFigure = { value: 12, status: 'MEASURED', mix: { MEASURED: 100 }, displayable: true };
  const legacyTokens = { inputFresh: 10, cacheWrite5m: 1, cacheWrite1h: 0, cacheRead: 2, output: 4, reasoning: 1 };
  const legacySummary = {
    host: 'M4a', range: '7d', generatedAt: 100,
    totals: { events: 2, tokens: { ...legacyTokens }, apiEquivUsd: 0.25, unpricedEvents: 0, ucu: { ...legacyFigure } },
    bySource: { claude: { events: 2, tokens: { ...legacyTokens }, apiEquivUsd: 0.25, ucu: { ...legacyFigure } } },
    activeTime: { agentMs: 40, wallMs: 30 },
  } as unknown as SummaryResponse;

  it('ignores the legacy figure on the totals and on a source entry, and still reports every other aggregate field correctly', async () => {
    const { queries, calls } = recordingQueries(async () => legacySummary);
    const l = await listener({ queries, calls });
    const r = await call(l, '/v1/fleet/summary?range=7d');
    expect(r.status).toBe(200);
    expect(calls).toEqual(['getSummary']);
    expect(r.text).not.toContain('ucu');
    for (const member of ['value', 'status', 'mix', 'displayable']) expect(r.text, `figure member ${member}`).not.toContain(`"${member}"`);
    expect(r.text).not.toContain('MEASURED');

    const body = r.json as { totals: Record<string, unknown>; bySource: Record<string, Record<string, unknown>> };
    expect(body.totals.events).toBe(2);
    expect(body.totals.apiEquivUsd).toBe(0.25);
    expect(body.totals.tokens).toEqual(legacyTokens);
    expect(body.bySource.claude!.events).toBe(2);
    expect(body.bySource.claude!.apiEquivUsd).toBe(0.25);
    expect(body.bySource.claude!.tokens).toEqual(legacyTokens);
    expect(r.json).toEqual({
      host: 'M4a', range: '7d', generatedAt: 100,
      totals: { events: 2, tokens: legacyTokens, apiEquivUsd: 0.25, unpricedEvents: 0 },
      bySource: { claude: { events: 2, tokens: legacyTokens, apiEquivUsd: 0.25 } },
      activeTime: { agentMs: 40, wallMs: 30 },
    });

    // The closed key set still holds for this response: nothing outside it crossed the boundary.
    const strangeKeys: string[] = [];
    walk(body, k => { if (!ALLOWED_KEYS.has(k)) strangeKeys.push(k); }, () => {});
    expect(strangeKeys).toEqual([]);
  });
});

// ── Client <-> real listeners ────────────────────────────────────────────────────────────────

describe('Fleet client against real in-process listeners', () => {
  const LOCAL_TOKEN = 'c'.repeat(64);
  const PEERS = [
    { label: 'ryzen', ip: '100.64.0.8', token: 'b'.repeat(64) },
    { label: 'a2000', ip: '100.64.0.9', token: 'd'.repeat(64) },
  ];
  interface Sent { url: URL; authorization?: string; method: string; hasBody: boolean }
  const homes: string[] = [];
  afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

  async function harness(opts: { peers?: { label: string; url: string }[]; serverTokens?: Record<string, string>; writeTokens?: boolean } = {}) {
    const now = Date.now();
    const closers: (() => Promise<void>)[] = [];
    const seeded: { db: ReturnType<typeof openDb> }[] = [];
    const sent: Sent[] = [];
    const ports = new Map<string, number>();
    const peers = opts.peers ?? PEERS.map(p => ({ label: p.label, url: `http://${p.ip}:${FLEET_PORT}` }));
    for (const p of PEERS) {
      const s = seededQueries(p.label, now); seeded.push(s);
      const l = await startListener({ queries: s.queries, token: opts.serverTokens?.[p.label] ?? p.token, host: p.label, address: p.ip });
      ports.set(p.ip, l.port); closers.push(l.close);
    }
    const local = seededQueries('M4a', now); seeded.push(local);
    const settings: Parameters<typeof createHttpServer>[0] = { port: 0, token: LOCAL_TOKEN, host: 'M4a', queries: local.queries };
    const daemon = createHttpServer(settings);
    await new Promise<void>(ok => daemon.listen(0, '127.0.0.1', ok));
    const daemonPort = (daemon.address() as AddressInfo).port; settings.port = daemonPort;
    closers.push(async () => { daemon.closeAllConnections(); await new Promise<void>(ok => daemon.close(() => ok())); });

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-contract-'));
    homes.push(tmpHome);
    const dataDir = path.join(tmpHome, 'data'), configDir = path.join(tmpHome, 'config');
    fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ hostLabel: 'M4a', fleet: { peers } }));
    fs.writeFileSync(path.join(dataDir, 'api-token'), `${LOCAL_TOKEN}\n`);
    if (opts.writeTokens !== false) for (const p of PEERS) {
      const file = getFleetPeerTokenPath({ dataDir } as never, p.label);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${p.token}\n`, { mode: 0o600 });
    }
    // Routes a Tailnet address to its loopback listener with the Tailnet Host header; everything else is the local daemon.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      sent.push({ url, authorization: auth, method: init?.method ?? 'GET', hasBody: init?.body !== undefined && init?.body !== null });
      const port = ports.get(url.hostname);
      if (port === undefined) return fetch(input, init);
      return new Promise<Response>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: url.pathname + url.search, method: init?.method ?? 'GET',
          headers: { host: url.host, ...(auth ? { authorization: auth } : {}) } }, res => {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
        });
        req.on('error', reject);
        init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
        req.end();
      });
    }) as typeof fetch;
    const client = createApiClient({ tokenFile: path.join(dataDir, 'api-token'), baseUrl: `http://127.0.0.1:${daemonPort}`, fetchImpl, env: { TOKENELO_HOME: tmpHome } });
    return { client, sent, ports, close: async () => { await Promise.all(closers.map(c => c())); for (const s of seeded) s.db.close(); } };
  }

  it('returns aggregates for the local daemon and two authenticated peers, and nothing identifying from any of them', async () => {
    const h = await harness();
    try {
      const overview = await h.client.getFleetOverview('7d');
      expect(overview.hosts.map(x => [x.label, x.kind, x.status])).toEqual([['M4a', 'local', 'online'], ['ryzen', 'peer', 'online'], ['a2000', 'peer', 'online']]);
      for (const host of overview.hosts) expect(host.summary!.totals.events, host.label).toBe(3);
      const text = JSON.stringify(overview);
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toMatch(/gitBranch|repoRoot|sessionId|parentSession|byModel/);
      for (const host of overview.hosts) expect(Object.keys(host.summary!).sort(), host.label).toEqual(['activeTime', 'bySource', 'generatedAt', 'host', 'range', 'totals']);
    } finally { await h.close(); }
  });

  it('sends each token only to the peer that owns it, only after that peer proved it holds it, and no request carries a body or local data', async () => {
    const h = await harness();
    try {
      await h.client.getFleetOverview('30d');
      for (const p of PEERS) {
        const mine = h.sent.filter(s => s.url.hostname === p.ip);
        expect(mine.map(s => s.url.pathname), p.label).toEqual(['/v1/fleet/hello', '/v1/fleet/summary']); // hello strictly before the credential
        expect(mine[0]!.authorization, `${p.label} hello`).toBeUndefined();
        expect(mine[1]!.authorization, `${p.label} summary`).toBe(`Bearer ${p.token}`);
        expect(mine[1]!.url.search).toBe('?range=30d');
        expect(mine[0]!.url.search).toMatch(/^\?nonce=[0-9a-f]{32}$/);
      }
      const everything = JSON.stringify(h.sent.map(s => [s.url.href, s.authorization ?? '']));
      expect(everything).not.toContain(SENTINEL);
      expect(h.sent.filter(s => s.url.hostname !== '127.0.0.1' && s.authorization?.includes(LOCAL_TOKEN))).toEqual([]);
      expect(h.sent.every(s => s.method === 'GET' && !s.hasBody)).toBe(true);
    } finally { await h.close(); }
  });

  it('treats a peer that cannot prove the shared token as untrusted: it never receives the credential and serves no data', async () => {
    const h = await harness({ serverTokens: { ryzen: 'e'.repeat(64) } });
    try {
      const overview = await h.client.getFleetOverview('7d');
      expect(overview.hosts.map(x => [x.label, x.status])).toEqual([['M4a', 'online'], ['ryzen', 'untrusted'], ['a2000', 'online']]);
      expect(overview.hosts[1]!.summary).toBeUndefined();
      const toRyzen = h.sent.filter(s => s.url.hostname === '100.64.0.8');
      expect(toRyzen.map(s => s.url.pathname)).toEqual(['/v1/fleet/hello']);
      expect(toRyzen.every(s => s.authorization === undefined)).toBe(true);
    } finally { await h.close(); }
  });

  it('makes no request at all to a configured peer outside the Tailnet range, or to a peer with no stored token', async () => {
    const outside = [
      { label: 'ryzen', url: 'http://127.0.0.1:47822' },
      { label: 'a2000', url: `http://user:pw@100.64.0.9:${FLEET_PORT}` },
      { label: 'public', url: 'http://203.0.113.9:47822' },
    ];
    const h = await harness({ peers: outside });
    try {
      const overview = await h.client.getFleetOverview('7d');
      expect(overview.hosts.map(x => [x.label, x.status])).toEqual([['M4a', 'online'], ['ryzen', 'not-configured'], ['a2000', 'not-configured'], ['public', 'not-configured']]);
      expect(h.sent.filter(s => s.url.hostname !== '127.0.0.1' || s.url.port === '47822')).toEqual([]);
    } finally { await h.close(); }
    const h2 = await harness({ writeTokens: false });
    try {
      const overview = await h2.client.getFleetOverview('7d');
      expect(overview.hosts.map(x => [x.label, x.status])).toEqual([['M4a', 'online'], ['ryzen', 'not-configured'], ['a2000', 'not-configured']]);
      expect(h2.sent.filter(s => s.url.hostname.startsWith('100.'))).toEqual([]);
    } finally { await h2.close(); }
  });

  it('accepts only Tailnet peer URLs of the exact documented shape', () => {
    expect(isTailnetPeerUrl(`http://100.64.0.8:${FLEET_PORT}`)).toBe(true);
    for (const url of [`https://100.64.0.8:${FLEET_PORT}`, `http://100.64.0.8:${FLEET_PORT}/v1`, `http://100.64.0.8:${FLEET_PORT}/?x=1`, `http://100.64.0.8:${FLEET_PORT}/#f`,
      `http://u:p@100.64.0.8:${FLEET_PORT}`, `http://user@100.64.0.8:${FLEET_PORT}`, `http://:pw@100.64.0.8:${FLEET_PORT}`, `http://100.64.0.8:${FLEET_PORT}@127.0.0.1:${FLEET_PORT}`, `http://peer.example:${FLEET_PORT}`, 'http://100.64.0.8',
      `http://100.128.0.1:${FLEET_PORT}`, `http://localhost:${FLEET_PORT}`, 'not a url', ''])
      expect(isTailnetPeerUrl(url), url).toBe(false);
  });
});
