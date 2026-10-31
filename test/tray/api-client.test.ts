/**
 * src/tray/api-client.ts — mock mode against the real committed fixtures (test/fixtures/api),
 * plus the real-HTTP path against an injected fetch stub (no network, no Electron).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetOverviewResponse } from '../../src/core/types.js';
import { createApiClient, isDaemonReachable } from '../../src/tray/api-client.js';
import { getFleetPeerTokenPath } from '../../src/daemon/fleet.js';
import { recordedWindowDisclosure } from '../../src/tray/renderer/recorded-window.js';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'fixtures', 'api');

/**
 * Wraps a test's own fetch stub with a correct GET /v1/hello handshake response for `token`
 * (security audit #4 — createApiClient now verifies this BEFORE sending the real bearer token, so
 * every "real HTTP mode" test needs a stub that can actually answer that challenge; a genuine
 * squatter that answers this endpoint incorrectly is exercised by its own dedicated test below).
 */
function withHello(token: string, handler: typeof fetch): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname === '/v1/hello') {
      const nonce = u.searchParams.get('nonce') ?? '';
      const proof = crypto.createHmac('sha256', token).update(nonce).digest('hex');
      return new Response(JSON.stringify({ proof }), { status: 200 });
    }
    return handler(url, init);
  }) as typeof fetch;
}

describe('createApiClient — mock mode (TOKENELO_MOCK)', () => {
  it('preserves the exact fixture Doctor envelope without reading a token or contacting the daemon', async () => {
    let networkCalls = 0;
    const client = createApiClient({
      mockDir: FIXTURES_DIR,
      tokenFile: path.join(os.tmpdir(), 'tokenelo-missing-doctor-token'),
      fetchImpl: (async () => { networkCalls++; throw new Error('fixture Doctor must not use the network'); }) as typeof fetch,
    });
    const report = await client.getDoctor();
    expect(report.runtimeBuildIdentity).toBeUndefined();
    expect(networkCalls).toBe(0);
  });

  it('loads the exact-range Fleet fixture as a closed three-host aggregate overview', async () => {
    let networkCalls = 0;
    const client = createApiClient({
      mockDir: FIXTURES_DIR,
      strictMockRanges: true,
      tokenFile: path.join(os.tmpdir(), 'tokenelo-missing-fleet-token'),
      fetchImpl: (async () => { networkCalls++; throw new Error('network must not run'); }) as typeof fetch,
    });
    const overview: FleetOverviewResponse = await client.getFleetOverview('today');
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'fleet-today.json'), 'utf8')) as FleetOverviewResponse;

    expect(overview).toEqual(expected);
    expect(overview.hosts.map(host => [host.label, host.kind, host.status])).toEqual([
      ['M4a', 'local', 'online'], ['A2000', 'peer', 'online'], ['ryzen', 'peer', 'online'],
    ]);
    expect(Object.keys(overview).sort()).toEqual(['generatedAt', 'hosts', 'range']);
    const forbiddenKeys = /^(?:project|projectPath|repoRoot|branch|sessionId|parentSessionId|models?|account|subscriptions|billedUsd|invoice|processes|tokenFile|apiToken|fleetToken|credentials|rawEvents|eventDetails)$/i;
    const visit = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(visit);
      if (!value || typeof value !== 'object') return [];
      return Object.entries(value).flatMap(([key, child]) => [key, ...visit(child)]);
    };
    expect(visit(overview).filter(key => forbiddenKeys.test(key))).toEqual([]);
    expect(JSON.stringify(overview)).not.toMatch(/(?:[A-Z]:\\|\/(?:Users|home|workspace|fixture)\/|[\w.+-]+@[\w.-]+)/i);
    expect(JSON.stringify(overview)).not.toMatch(/claude-(?:sonnet|opus|haiku)-|gpt-\d|qwen\d|llama\d/i);

    const summaries = overview.hosts.map(host => host.summary!);
    expect(summaries.every(summary => summary.range === 'today')).toBe(true);
    const tokenFields = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const;
    for (const summary of summaries) {
      const sourceRows = Object.values(summary.bySource);
      expect(sourceRows.reduce((sum, row) => sum + row.events, 0)).toBe(summary.totals.events);
      for (const field of tokenFields) {
        expect(sourceRows.reduce((sum, row) => sum + row.tokens[field], 0), `${summary.host} ${field}`).toBe(summary.totals.tokens[field]);
      }
      expect(sourceRows.reduce((sum, row) => sum + row.apiEquivUsd, 0)).toBeCloseTo(summary.totals.apiEquivUsd, 10);
    }
    expect(overview.hosts[1]!.summary!.totals.unpricedEvents).toBe(0);
    expect(overview.hosts[1]!.summary!.totals.estimatedPriceEvents).toBe(0);
    expect(overview.hosts[2]!.summary!.totals.unpricedEvents).toBeNull();
    expect(overview.hosts[2]!.summary!.totals.estimatedPriceEvents).toBeNull();
    expect(overview.hosts[2]!.summary!.totals.priceStatus).toBeNull();
    expect(overview.hosts[2]!.summary!.totals.apiEquivUsd).toBe(12.75);
    expect(networkCalls).toBe(0);
  });

  it.each(['today', '24h', '7d', '30d', 'all'] as const)(
    'loads only the exact %s Fleet fixture with independent aggregate report clocks', async (range) => {
      let networkCalls = 0;
      const client = createApiClient({
        mockDir: FIXTURES_DIR,
        strictMockRanges: true,
        tokenFile: path.join(os.tmpdir(), 'tokenelo-missing-fleet-token'),
        fetchImpl: (async () => { networkCalls++; throw new Error('network must not run'); }) as typeof fetch,
      });
      const overview = await client.getFleetOverview(range);
      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `fleet-${range}.json`), 'utf8')) as FleetOverviewResponse;
      expect(overview).toEqual(expected);
      expect(overview.range).toBe(range);
      expect(overview.hosts.map(host => [host.label, host.kind, host.status])).toEqual([
        ['M4a', 'local', 'online'], ['A2000', 'peer', 'online'], ['ryzen', 'peer', 'online'],
      ]);
      const summaries = overview.hosts.map(host => host.summary!);
      expect(summaries.every(summary => summary.range === range && summary.generatedAt < overview.generatedAt)).toBe(true);
      expect(new Set(summaries.map(summary => summary.generatedAt)).size).toBe(3);
      const forbiddenKeys = /^(?:project|projectPath|repoRoot|branch|sessionId|parentSessionId|models?|account|subscriptions|billedUsd|invoice|processes|tokenFile|apiToken|fleetToken|credentials|rawEvents|eventDetails)$/i;
      const visit = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.flatMap(visit);
        if (!value || typeof value !== 'object') return [];
        return Object.entries(value).flatMap(([key, child]) => [key, ...visit(child)]);
      };
      expect(visit(overview).filter(key => forbiddenKeys.test(key))).toEqual([]);
      const tokenFields = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const;
      for (const summary of summaries) {
        const sourceRows = Object.values(summary.bySource);
        expect(sourceRows.reduce((sum, row) => sum + row.events, 0), `${range} ${summary.host} events`).toBe(summary.totals.events);
        for (const field of tokenFields) {
          expect(sourceRows.reduce((sum, row) => sum + row.tokens[field], 0), `${range} ${summary.host} ${field}`)
            .toBe(summary.totals.tokens[field]);
        }
        expect(sourceRows.reduce((sum, row) => sum + row.apiEquivUsd, 0), `${range} ${summary.host} API-equivalent`)
          .toBeCloseTo(summary.totals.apiEquivUsd, 10);
      }
      expect(networkCalls).toBe(0);
    },
  );

  it('does not use a Fleet fixture from another range for a strict mock request', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-exact-range-'));
    fs.copyFileSync(path.join(FIXTURES_DIR, 'fleet-today.json'), path.join(dir, 'fleet-today.json'));
    const client = createApiClient({
      mockDir: dir,
      strictMockRanges: true,
      tokenFile: path.join(dir, 'absent-token'),
      fetchImpl: async () => { throw new Error('network must not run'); },
    });
    try {
      await expect(client.getFleetOverview('7d')).rejects.toThrow(/summary-7d\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an exact-range Fleet fixture with host-local fields', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-closed-shape-'));
    const unsafe = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'fleet-today.json'), 'utf8')) as Record<string, any>;
    unsafe.hosts[0].summary.repoRoot = '/fixture/private-repo';
    fs.writeFileSync(path.join(dir, 'fleet-today.json'), JSON.stringify(unsafe));
    const client = createApiClient({
      mockDir: dir,
      strictMockRanges: true,
      tokenFile: path.join(dir, 'absent-token'),
      fetchImpl: async () => { throw new Error('network must not run'); },
    });
    try {
      await expect(client.getFleetOverview('today')).rejects.toThrow(/aggregate-only/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the legacy one-host summary fallback when no exact Fleet fixture exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-legacy-fallback-'));
    fs.copyFileSync(path.join(FIXTURES_DIR, 'summary-today.json'), path.join(dir, 'summary-today.json'));
    const client = createApiClient({ mockDir: dir, fetchImpl: async () => { throw new Error('network must not run'); } });
    try {
      const overview = await client.getFleetOverview('7d');
      expect(overview.range).toBe('7d');
      expect(overview.hosts).toHaveLength(1);
      expect(overview.hosts[0]!.summary?.range).toBe('today');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getSummary(range) uses its exact fixture for every supported range', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    for (const range of ['today', '24h', '7d', '30d', 'all'] as const) {
      expect((await client.getSummary(range)).range).toBe(range);
    }
  });

  it('getSessions / getLimits / getDoctor read their fixed-name fixtures', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    const sessions = await client.getSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);
    const limits = await client.getLimits();
    expect(limits.snapshots.length).toBeGreaterThan(0);
    const doctor = await client.getDoctor();
    expect(doctor.host).toBe('M4a');
  });

  it('getSessionsResponse wraps the legacy array sessions.json as {range, sessions} with no clock (unknown)', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    const rows = await client.getSessions();
    const res = await client.getSessionsResponse('7d');
    expect(res).toEqual({ range: '7d', sessions: rows });
    expect('generatedAt' in res).toBe(false);
    expect((await client.getSessionsResponse()).range).toBe('today');
  });

  it('keeps the declared window from an exact mock envelope without reading a token or using the network', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-session-window-'));
    const timeBasis = { startMs: 0, asOfMs: 1_700_000_000_000, endInclusive: true, timestampBasis: 'recorded-timestamps', excludedFutureEvents: 3, excludedFutureActivity: 4 };
    const body = { range: '24h', timeBasis, sessions: [] };
    try {
      fs.writeFileSync(path.join(dir, 'sessions-24h.json'), JSON.stringify(body));
      const client = createApiClient({ mockDir: dir, strictMockRanges: true, tokenFile: path.join(dir, 'absent-token'), fetchImpl: async () => { throw new Error('network must not run'); } });
      const response = await client.getSessionsResponse('24h');
      expect(response).toEqual(body);
      expect('generatedAt' in response).toBe(false);
      expect(recordedWindowDisclosure(response.timeBasis)).toMatchObject({ state: 'available', exclusions: 'Later timestamps excluded — events: 3; activity records: 4.' });
    } finally { fs.rmSync(dir, { recursive: true }); }
  });

  it('getTimeseries(range) reads timeseries-<range>.json', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    const ts = await client.getTimeseries('7d');
    expect(ts.range).toBe('7d');
    expect(ts.bucket).toBe('day');
  });

  it('getSessionDetail(source, sessionId) reads the dedicated session-detail-<source>-<id>.json fixture', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    const detail = await client.getSessionDetail('claude', 'a1b2c3d4-1111-4a4a-8b8b-000000000001');
    expect(detail.sessionId).toBe('a1b2c3d4-1111-4a4a-8b8b-000000000001');
    expect(detail.source).toBe('claude');
    expect(detail.byModel.length).toBeGreaterThan(0);
  });

  it('getSessionDetail falls back to the generic session-detail.json for an id with no dedicated fixture', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    const detail = await client.getSessionDetail('codex', 'some-other-session-id');
    expect(detail.sessionId).toBe('a1b2c3d4-1111-4a4a-8b8b-000000000001'); // the fallback fixture's own id
  });

  it('getSessionDetail sanitizes an id with filename-unsafe characters before building the fixture path', async () => {
    const client = createApiClient({ mockDir: FIXTURES_DIR });
    // Contains ':' — must not throw as an invalid path, and must fall through to the generic fixture.
    const detail = await client.getSessionDetail('ollama-proxy', 'ollama:M4a:gemma4:26b:2026-09-26');
    expect(detail).toBeTruthy();
  });

  it('throws a clear error when a required fixture is missing entirely', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-mock-empty-'));
    const client = createApiClient({ mockDir: emptyDir });
    await expect(client.getDoctor()).rejects.toThrow(/no mock fixture found/);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('respects TOKENELO_MOCK from the env when mockDir is not explicitly passed', async () => {
    const client = createApiClient({ env: { TOKENELO_MOCK: FIXTURES_DIR } });
    const today = await client.getSummary('today');
    expect(today.host).toBe('M4a');
  });
});

describe('createApiClient — real HTTP mode', () => {
  let tokenDir: string;
  let tokenFile: string;

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-token-'));
    tokenFile = path.join(tokenDir, 'api-token');
    fs.writeFileSync(tokenFile, 'test-token-abc123\n');
  });

  afterEach(() => {
    fs.rmSync(tokenDir, { recursive: true, force: true });
  });

  it('refuses a compressed pre-auth local port-squatter response before sending the bearer token', async () => {
    const requests: { url: string; authorization: string | undefined; acceptEncoding: string | undefined }[] = [];
    const compressed = brotliCompressSync(Buffer.from(JSON.stringify({ proof: 'not-the-token-proof' }), 'utf8'));
    const server = http.createServer((request, response) => {
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        acceptEncoding: request.headers['accept-encoding'],
      });
      response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
      response.end(compressed);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('loopback squatter fixture unavailable');
    try {
      const client = createApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, tokenFile });
      await expect(client.getSummary('today')).rejects.toThrow(/daemon identity challenge failed/);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/^\/v1\/hello\?nonce=[0-9a-f]{32}$/);
      expect(requests[0]!.authorization).toBeUndefined();
      expect(requests[0]!.acceptEncoding).toBe('identity');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('sends the bearer token from the token file and hits the expected route', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = withHello('test-token-abc123', (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      return new Response(JSON.stringify({ ok: true, url }), { status: 200 });
    }) as typeof fetch);

    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await client.getSummary('today');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:47821/v1/summary?range=today');
    expect(calls[0].headers.Authorization).toBe('Bearer test-token-abc123');
  });

  it('getSessions unwraps the daemon\'s {range, sessions} envelope into a bare array', async () => {
    const fetchImpl = withHello(
      'test-token-abc123',
      (async () =>
        new Response(JSON.stringify({ range: 'today', sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] }), {
          status: 200,
        })) as typeof fetch
    );
    const client = createApiClient({ tokenFile, fetchImpl });
    const sessions = await client.getSessions();
    expect(sessions).toEqual([{ sessionId: 'a' }, { sessionId: 'b' }]);
  });

  it('getSessionsResponse keeps range, rows and a valid query clock from the same route; getSessions rows are unchanged', async () => {
    const calls: string[] = [];
    const body = { range: '7d', generatedAt: 1_700_000_000_000,
      timeBasis: { startMs: 1_699_996_400_000, asOfMs: 1_700_000_000_000, endInclusive: true, timestampBasis: 'recorded-timestamps', excludedFutureEvents: 0, excludedFutureActivity: 0 },
      sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] };
    const fetchImpl = withHello('test-token-abc123', (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch);
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    expect(await client.getSessionsResponse('7d')).toEqual(body);
    expect(await client.getSessions('7d')).toEqual(body.sessions);
    expect(calls).toEqual(['http://127.0.0.1:47821/v1/sessions?range=7d', 'http://127.0.0.1:47821/v1/sessions?range=7d']);
  });

  it('keeps supplied invalid evidence visible to the window validator and never invents missing legacy cutoffs', async () => {
    const basis = { startMs: 0, asOfMs: 1_700_000_000_000, endInclusive: true, timestampBasis: 'recorded-timestamps', excludedFutureEvents: 0, excludedFutureActivity: 0 };
    for (const timeBasis of [undefined, { ...basis, startMs: basis.asOfMs + 1 }, { ...basis, endInclusive: false }, { ...basis, timestampBasis: 'source-verified' }, { ...basis, asOfMs: -1 }]) {
      const fetchImpl = withHello('test-token-abc123', (async () => new Response(JSON.stringify({ range: '7d', generatedAt: basis.asOfMs, timeBasis, sessions: [] }), { status: 200 })) as typeof fetch);
      const response = await createApiClient({ tokenFile, fetchImpl }).getSessionsResponse('7d');
      expect(response.timeBasis).toEqual(timeBasis);
      expect(recordedWindowDisclosure(response.timeBasis).state).toBe(timeBasis === undefined ? 'unavailable' : 'invalid');
    }
    const fetchImpl = withHello('test-token-abc123', (async () => new Response(JSON.stringify({ range: '7d', timeBasis: { ...basis, excludedFutureEvents: undefined }, sessions: [] }), { status: 200 })) as typeof fetch);
    const response = await createApiClient({ tokenFile, fetchImpl }).getSessionsResponse('7d');
    expect('generatedAt' in response).toBe(false);
    expect(recordedWindowDisclosure(response.timeBasis)).toMatchObject({ state: 'available', exclusions: 'Later timestamps excluded — events: unavailable; activity records: 0.' });
  });

  it('getSessionsResponse omits a missing (older daemon) or invalid clock, never substituting the receipt time', async () => {
    const clocks: unknown[] = [undefined, 1.5, -1, 8.64e15 + 1, '1700000000000', null, Number.NaN];
    for (const generatedAt of clocks) {
      const fetchImpl = withHello(
        'test-token-abc123',
        (async () => new Response(JSON.stringify({ range: 'today', generatedAt, sessions: [{ sessionId: 'a' }] }), { status: 200 })) as typeof fetch
      );
      const res = await createApiClient({ tokenFile, fetchImpl }).getSessionsResponse();
      expect(res).toEqual({ range: 'today', sessions: [{ sessionId: 'a' }] });
      expect('generatedAt' in res).toBe(false);
    }
    // Both ends of the accepted range are kept.
    for (const generatedAt of [0, 8.64e15]) {
      const fetchImpl = withHello(
        'test-token-abc123',
        (async () => new Response(JSON.stringify({ range: 'today', generatedAt, sessions: [] }), { status: 200 })) as typeof fetch
      );
      expect((await createApiClient({ tokenFile, fetchImpl }).getSessionsResponse()).generatedAt).toBe(generatedAt);
    }
  });

  it('getTimeseries picks bucket=hour for today/24h and bucket=day for 7d/30d/all', async () => {
    const calls: string[] = [];
    const fetchImpl = withHello('test-token-abc123', (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await client.getTimeseries('today');
    await client.getTimeseries('24h');
    await client.getTimeseries('7d');
    await client.getTimeseries('30d');
    expect(calls).toEqual([
      'http://127.0.0.1:47821/v1/timeseries?range=today&bucket=hour',
      'http://127.0.0.1:47821/v1/timeseries?range=24h&bucket=hour',
      'http://127.0.0.1:47821/v1/timeseries?range=7d&bucket=day',
      'http://127.0.0.1:47821/v1/timeseries?range=30d&bucket=day',
    ]);
  });

  it('getSessionDetail encodes source/sessionId and hits the expected route', async () => {
    const calls: string[] = [];
    const fetchImpl = withHello('test-token-abc123', (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch);
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await client.getSessionDetail('ollama-proxy', 'ollama:M4a:gemma4:26b:2026-09-26');
    expect(calls).toEqual([
      'http://127.0.0.1:47821/v1/sessions/detail?source=ollama-proxy&sessionId=ollama%3AM4a%3Agemma4%3A26b%3A2026-09-26',
    ]);
  });

  it.each([
    ['matching', false, false, { state: 'matching', observedAt: 1_700_000_000_000 }],
    ['matching but dirty', true, true, { state: 'matching-dirty', observedAt: 1_700_000_000_000 }],
    ['different manifest', false, false, { state: 'mismatch', observedAt: 1_700_000_000_000 }],
  ] as const)('checks tray/daemon build identity (%s) through authenticated health', async (_name, localDirty, daemonDirty, expected) => {
    const local = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: localDirty, distManifestSha256: 'b'.repeat(64) };
    const daemon = { ...local, sourceDirty: daemonDirty, ...(expected.state === 'mismatch' ? { distManifestSha256: 'c'.repeat(64) } : {}) };
    const calls: { path: string; authorization: string | null }[] = [];
    const fetchImpl = withHello('test-token-abc123', (async (url: string, init?: RequestInit) => {
      const pathname = new URL(url).pathname;
      calls.push({ path: pathname, authorization: new Headers(init?.headers).get('authorization') });
      const body = pathname === '/v1/doctor' ? { warnings: [] } : { generatedAt: 1_700_000_000_000, buildIdentity: daemon };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch);
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl, buildIdentity: local });
    const report = await client.getDoctor();
    expect(report.runtimeBuildIdentity).toEqual(expected);
    expect(calls).toEqual([
      { path: '/v1/doctor', authorization: 'Bearer test-token-abc123' },
      { path: '/v1/health', authorization: 'Bearer test-token-abc123' },
    ]);
  });

  it('keeps identity unknown for an older daemon without failing the Doctor report', async () => {
    const calls: string[] = [];
    const local = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) };
    const fetchImpl = withHello('test-token-abc123', (async (url: string) => {
      const pathname = new URL(url).pathname;
      calls.push(pathname);
      return new Response(JSON.stringify(pathname === '/v1/doctor' ? { warnings: [] } : { generatedAt: 1_700_000_000_000 }), { status: 200 });
    }) as typeof fetch);
    const report = await createApiClient({ tokenFile, fetchImpl, buildIdentity: local }).getDoctor();
    expect(report.warnings).toEqual([]);
    expect(report.runtimeBuildIdentity).toEqual({ state: 'unknown', observedAt: 1_700_000_000_000 });
    expect(calls).toEqual(['/v1/doctor', '/v1/health']);
  });

  it('keeps Doctor available with unknown identity when the health check fails', async () => {
    const local = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) };
    const fetchImpl = withHello('test-token-abc123', (async (url: string) => new URL(url).pathname === '/v1/doctor'
      ? new Response(JSON.stringify({ warnings: [] }), { status: 200 })
      : new Response('unavailable', { status: 503 })) as typeof fetch);
    const report = await createApiClient({ tokenFile, fetchImpl, buildIdentity: local }).getDoctor();
    expect(report.warnings).toEqual([]);
    expect(report.runtimeBuildIdentity).toEqual({ state: 'unknown', observedAt: null });
  });

  it('keeps identity unknown when the tray build identity is unavailable and skips the extra health read', async () => {
    const calls: string[] = [];
    const fetchImpl = withHello('test-token-abc123', (async (url: string) => {
      calls.push(new URL(url).pathname);
      return new Response(JSON.stringify({ warnings: [] }), { status: 200 });
    }) as typeof fetch);
    const report = await createApiClient({ tokenFile, fetchImpl, buildIdentity: null }).getDoctor();
    expect(report.runtimeBuildIdentity).toEqual({ state: 'unknown', observedAt: null });
    expect(calls).toEqual(['/v1/doctor']);
  });

  it('isDaemonReachable probes /v1/health', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 401 });
    }) as typeof fetch;
    expect(await isDaemonReachable({ baseUrl: 'http://127.0.0.1:47821', fetchImpl })).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:47821/v1/health']);
  });

  it('rejects with a descriptive error on a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as typeof fetch;
    const client = createApiClient({ tokenFile, fetchImpl });
    await expect(client.getDoctor()).rejects.toThrow(/HTTP 401/);
  });

  it('throws before making any request when the token file does not exist', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    const client = createApiClient({ tokenFile: path.join(tokenDir, 'missing'), fetchImpl });
    await expect(client.getSessions()).rejects.toThrow(/token/);
  });
});

// ── Security audit #4: read the port from config, and verify daemon identity before sending the token ──
describe('createApiClient — daemon identity challenge (security audit #4)', () => {
  let tokenDir: string;
  let tokenFile: string;

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-token-'));
    tokenFile = path.join(tokenDir, 'api-token');
    fs.writeFileSync(tokenFile, 'the-real-token-abc123\n');
  });

  afterEach(() => {
    fs.rmSync(tokenDir, { recursive: true, force: true });
  });

  it('calls GET /v1/hello before ever sending the Authorization header, and never sends the token if the proof is wrong (a squatter that does not know it)', async () => {
    const calls: { path: string; hadAuth: boolean }[] = [];
    // A squatter: answers /v1/hello, but with a bogus/made-up proof (it doesn't know the token).
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ path: u.pathname, hadAuth: !!(init?.headers as Record<string, string> | undefined)?.Authorization });
      if (u.pathname === '/v1/hello') {
        return new Response(JSON.stringify({ proof: 'not-the-real-proof' }), { status: 200 });
      }
      return new Response(JSON.stringify({ host: 'squatted' }), { status: 200 });
    }) as typeof fetch;

    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await expect(client.getSummary('today')).rejects.toThrow(/possible port squatter/);

    expect(calls).toHaveLength(1); // never got past /v1/hello to the real route
    expect(calls[0].path).toBe('/v1/hello');
    expect(calls[0].hadAuth).toBe(false); // the bearer token was never sent
  });

  it('mutation check: a proof that is merely a DIFFERENT valid-length hex string (not computed from the real token) is still rejected, not accepted just because it "looks like" a proof', async () => {
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === '/v1/hello') {
        // 64 lowercase hex chars, exactly like a real HMAC-SHA256 digest — just the WRONG one.
        return new Response(JSON.stringify({ proof: 'a'.repeat(64) }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await expect(client.getSummary('today')).rejects.toThrow(/possible port squatter/);
  });

  it('succeeds and sends the real token once the server proves it holds it (correct HMAC over the nonce we sent)', async () => {
    const calls: { path: string; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      calls.push({ path: u.pathname, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
      if (u.pathname === '/v1/hello') {
        const nonce = u.searchParams.get('nonce') ?? '';
        const proof = crypto.createHmac('sha256', 'the-real-token-abc123').update(nonce).digest('hex');
        return new Response(JSON.stringify({ proof }), { status: 200 });
      }
      return new Response(JSON.stringify({ host: 'M4a' }), { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await client.getSummary('today');

    expect(calls.map((c) => c.path)).toEqual(['/v1/hello', '/v1/summary']);
    expect(calls[1].auth).toBe('Bearer the-real-token-abc123');
  });

  it('re-challenges identity before every local API request', async () => {
    const paths: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      paths.push(u.pathname);
      if (u.pathname === '/v1/hello') {
        const nonce = u.searchParams.get('nonce') ?? '';
        const proof = crypto.createHmac('sha256', 'the-real-token-abc123').update(nonce).digest('hex');
        return new Response(JSON.stringify({ proof }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });
    await client.getSummary('today');
    await client.getSummary('7d');
    expect(paths.filter((p) => p === '/v1/hello')).toHaveLength(2);
    expect(paths.filter((p) => p === '/v1/summary')).toHaveLength(2);
  });

  it('does not send a cached bearer to a same-port replacement that cannot prove identity', async () => {
    let serverRole: 'trusted-daemon' | 'replacement' = 'trusted-daemon';
    const calls: { path: string; authorization: string | undefined }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const authorization = new Headers(init?.headers).get('Authorization') ?? undefined;
      calls.push({ path: u.pathname, authorization });
      if (u.pathname === '/v1/hello') {
        if (serverRole === 'replacement') {
          return new Response(JSON.stringify({ proof: '0'.repeat(64) }), { status: 200 });
        }
        const nonce = u.searchParams.get('nonce') ?? '';
        const proof = crypto.createHmac('sha256', 'the-real-token-abc123').update(nonce).digest('hex');
        return new Response(JSON.stringify({ proof }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:47821', tokenFile, fetchImpl });

    await client.getSummary('today');
    serverRole = 'replacement';
    await expect(client.getSummary('7d')).rejects.toThrow(/possible port squatter/);

    expect(calls.map((call) => call.path)).toEqual(['/v1/hello', '/v1/summary', '/v1/hello']);
    expect(calls.map((call) => call.authorization)).toEqual([
      undefined,
      'Bearer the-real-token-abc123',
      undefined,
    ]);
  });
});

describe('createApiClient / isDaemonReachable — reads the port from config, not a hardcoded constant', () => {
  let tmpHome: string;

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('createApiClient (no explicit baseUrl) hits the port from config.api.port', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cfgport-'));
    const configDir = path.join(tmpHome, 'config');
    const dataDir = path.join(tmpHome, 'data');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ api: { port: 55123 } }));
    const tokenFile = path.join(dataDir, 'api-token');
    fs.writeFileSync(tokenFile, 'cfg-port-token\n');

    const calls: string[] = [];
    const fetchImpl = withHello('cfg-port-token', (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch);

    const client = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } });
    await client.getSummary('today');
    expect(calls.some((u) => u.startsWith('http://127.0.0.1:55123/'))).toBe(true);
  });

  it('isDaemonReachable (no explicit baseUrl) probes the port from config.api.port', async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cfgport-'));
    const configDir = path.join(tmpHome, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ api: { port: 55124 } }));

    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const reachable = await isDaemonReachable({ fetchImpl, env: { TOKENELO_HOME: tmpHome } });
    expect(reachable).toBe(true);
    expect(calls).toEqual([`http://127.0.0.1:55124/v1/health`]);
  });
});

describe('createApiClient — fleet overview credentials and privacy boundary', () => {
  let tmpHome: string;
  const localToken = 'a'.repeat(64);
  const peerToken = 'b'.repeat(64);
  const peerUrl = 'http://100.64.0.8:47822';

  function prepareFleetConfig(peer = { label: 'ryzen', url: peerUrl }): string {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-client-'));
    const configDir = path.join(tmpHome, 'config');
    const dataDir = path.join(tmpHome, 'data');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      hostLabel: 'A2000',
      fleet: { peers: [peer] },
    }));
    const localTokenFile = path.join(dataDir, 'api-token');
    fs.writeFileSync(localTokenFile, `${localToken}\n`);
    fs.mkdirSync(path.dirname(getFleetPeerTokenPath({ dataDir } as never, peer.label)), { recursive: true });
    fs.writeFileSync(getFleetPeerTokenPath({ dataDir } as never, peer.label), `${peerToken}\n`);
    return localTokenFile;
  }

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('verifies each Tailscale peer before sending its separate bearer token and returns aggregate-only data', async () => {
    const tokenFile = prepareFleetConfig();
    const calls: { url: string; authorization?: string }[] = [];
    const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')) as Record<string, unknown>;
    const peerSummary = { ...localSummary, host: 'ryzen' };
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, authorization: headers.Authorization });
      if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/hello') {
        const nonce = parsed.searchParams.get('nonce') ?? '';
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', localToken).update(nonce).digest('hex') }), { status: 200 });
      }
      if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/summary') {
        return new Response(JSON.stringify(localSummary), { status: 200 });
      }
      if (parsed.pathname === '/v1/fleet/hello') {
        const nonce = parsed.searchParams.get('nonce') ?? '';
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', peerToken).update(nonce).digest('hex') }), { status: 200 });
      }
      if (parsed.pathname === '/v1/fleet/summary') return new Response(JSON.stringify(peerSummary), { status: 200 });
      throw new Error(`unexpected request: ${url}`);
    }) as typeof fetch;
    const client = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } });

    const overview = await client.getFleetOverview('7d');
    expect(overview.hosts.map((host) => [host.label, host.kind, host.status])).toEqual([
      ['M4a', 'local', 'online'],
      ['ryzen', 'peer', 'online'],
    ]);
    expect(overview.hosts[1].summary?.host).toBe('ryzen');
    const peerHello = calls.find((call) => call.url.includes('/v1/fleet/hello'));
    const peerSummaryCall = calls.find((call) => call.url.includes('/v1/fleet/summary'));
    expect(peerHello?.authorization).toBeUndefined();
    expect(peerSummaryCall?.authorization).toBe(`Bearer ${peerToken}`);
    expect(peerSummaryCall?.url).toBe(`${peerUrl}/v1/fleet/summary?range=7d`);
    expect(JSON.stringify(overview.hosts[1].summary)).not.toContain('project');
  });

  describe('a peer that still sends the legacy figure member of an older daemon', () => {
    // Compatibility only: the figure is not part of this edition's contract, so it is ignored, never validated or forwarded.
    const legacyFigure = { value: 12, status: 'MEASURED', mix: { MEASURED: 100 }, displayable: true };

    async function readPeer(mutate: (summary: Record<string, any>) => void = () => undefined) {
      const tokenFile = prepareFleetConfig();
      const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')) as Record<string, any>;
      const peerSummary = {
        host: 'ryzen', range: '7d', generatedAt: localSummary.generatedAt, activeTime: localSummary.activeTime,
        totals: { ...localSummary.totals, ucu: legacyFigure },
        bySource: Object.fromEntries(Object.entries(localSummary.bySource as Record<string, object>).map(([source, row]) => [source, { ...row, ucu: legacyFigure }])),
      };
      mutate(peerSummary);
      const fetchImpl = (async (url: string) => {
        const parsed = new URL(url);
        const proof = (token: string) => crypto.createHmac('sha256', token).update(parsed.searchParams.get('nonce') ?? '').digest('hex');
        if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/hello') return new Response(JSON.stringify({ proof: proof(localToken) }));
        if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/summary') return new Response(JSON.stringify(localSummary));
        if (parsed.pathname === '/v1/fleet/hello') return new Response(JSON.stringify({ proof: proof(peerToken) }));
        if (parsed.pathname === '/v1/fleet/summary') return new Response(JSON.stringify(peerSummary));
        throw new Error(`unexpected request: ${url}`);
      }) as typeof fetch;
      const overview = await createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('7d');
      return { peer: overview.hosts[1], localSummary };
    }

    it('keeps the peer online with its aggregate fields intact and forwards no figure member', async () => {
      const { peer, localSummary } = await readPeer();
      expect(peer.status).toBe('online');
      const summary = peer.summary!;
      expect(summary.totals.events).toBe(localSummary.totals.events);
      expect(summary.totals.tokens).toEqual(localSummary.totals.tokens);
      expect(summary.totals.apiEquivUsd).toBe(localSummary.totals.apiEquivUsd);
      expect(Object.keys(summary.totals)).not.toContain('ucu');
      for (const row of Object.values(summary.bySource)) expect(Object.keys(row)).not.toContain('ucu');
      expect(JSON.stringify(summary)).not.toContain('MEASURED');
    });

    it('still refuses the peer when a field that remains in the contract is invalid', async () => {
      const { peer } = await readPeer(summary => { summary.totals.events = -1; });
      expect(peer.status).toBe('untrusted');
      expect(peer.summary).toBeUndefined();
    });
  });

  it('proves the local daemon before contacting any configured peers', async () => {
    const tokenFile = prepareFleetConfig();
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ proof: '0'.repeat(64) }), { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } });

    await expect(client.getFleetOverview('7d')).rejects.toThrow(/possible port squatter/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/v1/hello');
  });

  it('loads the local summary concurrently with peer summaries', async () => {
    vi.useFakeTimers();
    try {
      const tokenFile = prepareFleetConfig();
      const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')) as Record<string, unknown>;
      const peerSummary = { ...localSummary, host: 'ryzen' };
      let localPending = false;
      let peerPending = false;
      let summariesOverlapped = false;
      const fetchImpl = (async (url: string) => {
        const parsed = new URL(url);
        if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/hello') {
          const nonce = parsed.searchParams.get('nonce') ?? '';
          return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', localToken).update(nonce).digest('hex') }), { status: 200 });
        }
        if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/summary') {
          localPending = true;
          if (peerPending) summariesOverlapped = true;
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              localPending = false;
              resolve(new Response(JSON.stringify(localSummary), { status: 200 }));
            }, 6000);
          });
        }
        if (parsed.pathname === '/v1/fleet/hello') {
          const nonce = parsed.searchParams.get('nonce') ?? '';
          return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', peerToken).update(nonce).digest('hex') }), { status: 200 });
        }
        if (parsed.pathname === '/v1/fleet/summary') {
          peerPending = true;
          if (localPending) summariesOverlapped = true;
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              peerPending = false;
              resolve(new Response(JSON.stringify(peerSummary), { status: 200 }));
            }, 6000);
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }) as typeof fetch;
      const client = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } });

      const overviewPromise = client.getFleetOverview('7d');
      await vi.advanceTimersByTimeAsync(12_000);
      const overview = await overviewPromise;
      expect(summariesOverlapped).toBe(true);
      expect(overview.hosts.map((host) => host.status)).toEqual(['online', 'online']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never sends a peer token when the configured endpoint cannot prove its identity', async () => {
    const tokenFile = prepareFleetConfig();
    const peerRequests: { url: string; authorization?: string }[] = [];
    const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')) as Record<string, unknown>;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      const authorization = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/hello') {
        const nonce = parsed.searchParams.get('nonce') ?? '';
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', localToken).update(nonce).digest('hex') }), { status: 200 });
      }
      if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/summary') return new Response(JSON.stringify(localSummary), { status: 200 });
      peerRequests.push({ url, authorization });
      return new Response(JSON.stringify({ proof: '0'.repeat(64) }), { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } });

    const overview = await client.getFleetOverview('7d');
    expect(overview.hosts[1].status).toBe('untrusted');
    expect(peerRequests).toHaveLength(1);
    expect(peerRequests[0].url).toContain('/v1/fleet/hello');
    expect(peerRequests[0].authorization).toBeUndefined();
  });

  it('keeps a healthy peer online when its summary takes longer than five seconds', async () => {
    vi.useFakeTimers();
    try {
      const tokenFile = prepareFleetConfig();
      const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')) as Record<string, unknown>;
      const peerSummary = { ...localSummary, host: 'ryzen' };
      let markSummaryStarted: (() => void) | undefined;
      const summaryStarted = new Promise<void>((resolve) => { markSummaryStarted = resolve; });
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const parsed = new URL(url);
        if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/hello') {
          const nonce = parsed.searchParams.get('nonce') ?? '';
          return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', localToken).update(nonce).digest('hex') }), { status: 200 });
        }
        if (parsed.hostname === '127.0.0.1' && parsed.pathname === '/v1/summary') {
          return new Response(JSON.stringify(localSummary), { status: 200 });
        }
        if (parsed.pathname === '/v1/fleet/hello') {
          const nonce = parsed.searchParams.get('nonce') ?? '';
          return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', peerToken).update(nonce).digest('hex') }), { status: 200 });
        }
        if (parsed.pathname === '/v1/fleet/summary') {
          markSummaryStarted?.();
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(new Response(JSON.stringify(peerSummary), { status: 200 })), 6000);
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }) as typeof fetch;
      const client = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } });

      const overviewPromise = client.getFleetOverview('7d');
      await summaryStarted;
      await vi.advanceTimersByTimeAsync(6000);
      const overview = await overviewPromise;
      expect(overview.hosts[1].status).toBe('online');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [504, 'report-timeout'], [429, 'report-unavailable'], [503, 'report-unavailable'],
    [401, 'unauthorized'], [200, 'untrusted'],
  ] as const)('preserves a proved peer identity when the selected report returns HTTP %i', async (httpStatus, expectedStatus) => {
    const tokenFile = prepareFleetConfig();
    const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8'));
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      if (u.pathname.endsWith('/hello')) {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        const token = u.hostname === '127.0.0.1' ? localToken : peerToken;
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', token).update(u.searchParams.get('nonce')!).digest('hex') }));
      }
      if (u.hostname === '127.0.0.1') return new Response(JSON.stringify(localSummary));
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${peerToken}`);
      return new Response('{}', { status: httpStatus });
    }) as typeof fetch;
    const overview = await createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('7d');
    expect(overview.hosts[1]).toEqual({ label: 'ryzen', kind: 'peer', status: expectedStatus });
    expect(overview.hosts[1].summary).toBeUndefined();
  });

  it.each([false, true])('bounds a peer response body that ignores abort, identity already proved: %s', async (summaryBody) => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      const tokenFile = prepareFleetConfig();
      const localSummary = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8'));
      const peerRequests: { path: string; auth: boolean }[] = [];
      const fetchImpl = (async (input: string, init?: RequestInit) => {
        const u = new URL(input), isPeer = u.hostname !== '127.0.0.1';
        if (isPeer) peerRequests.push({ path: u.pathname, auth: new Headers(init?.headers).has('Authorization') });
        if (isPeer && u.pathname === (summaryBody ? '/v1/fleet/summary' : '/v1/fleet/hello')) {
          return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
        }
        if (u.pathname.endsWith('/hello')) {
          const token = isPeer ? peerToken : localToken;
          return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', token).update(u.searchParams.get('nonce')!).digest('hex') }));
        }
        return new Response(JSON.stringify(localSummary));
      }) as typeof fetch;
      const pending = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('7d');
      await vi.advanceTimersByTimeAsync(15_000);
      const overview = await pending;
      expect(overview.hosts[1]).toEqual({ label: 'ryzen', kind: 'peer', status: summaryBody ? 'report-timeout' : 'offline' });
      expect(peerRequests).toEqual(summaryBody ? [{ path: '/v1/fleet/hello', auth: false }, { path: '/v1/fleet/summary', auth: true }] : [{ path: '/v1/fleet/hello', auth: false }]);
    } finally { controller?.close(); vi.useRealTimers(); }
  });

  it('retains an authenticated peer when the local leased report times out, without fabricated local totals', async () => {
    const tokenFile = prepareFleetConfig();
    const peerSummary = { ...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')), host: 'ryzen', range: 'all' };
    const id = 'd'.repeat(32); let lease = '', released = false;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const u = new URL(input), headers = new Headers(init?.headers);
      if (u.pathname.endsWith('/hello')) {
        expect(headers.has('Authorization')).toBe(false);
        const token = u.hostname === '127.0.0.1' ? localToken : peerToken;
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', token).update(u.searchParams.get('nonce')!).digest('hex') }));
      }
      if (u.hostname !== '127.0.0.1') {
        expect(headers.get('Authorization')).toBe(`Bearer ${peerToken}`);
        return new Response(JSON.stringify(peerSummary));
      }
      expect(headers.get('Authorization')).toBe(`Bearer ${localToken}`);
      if (u.pathname === '/v1/health') return new Response(JSON.stringify({ capabilities: { summaryReadJobs: 1 } }));
      if (init?.method === 'POST') { lease = headers.get('X-Tokenelo-Read-Lease')!; return new Response(JSON.stringify({ id })); }
      if (init?.method === 'DELETE') { expect(u.pathname.endsWith(lease)).toBe(true); released = true; return new Response('{}'); }
      expect(u.searchParams.get('lease')).toBe(lease);
      return new Response(JSON.stringify({ id, range: 'all', status: 'failed', error: 'read_timeout', budgetMs: 45_000 }));
    }) as typeof fetch;
    const overview = await createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('all');
    expect(overview.hosts[0]).toEqual({ label: 'A2000', kind: 'local', status: 'report-timeout' });
    expect(overview.hosts[0].summary).toBeUndefined();
    expect(overview.hosts[1].status).toBe('online');
    expect(overview.hosts[1].summary?.totals.tokens).toEqual(peerSummary.totals.tokens);
    expect(overview.hosts[1].summary?.totals.apiEquivUsd).toBe(peerSummary.totals.apiEquivUsd);
    expect(released).toBe(true);
  });

  it('retains an authenticated peer when a local report body ignores abort at the original deadline', async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      const tokenFile = prepareFleetConfig();
      const peerSummary = { ...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')), host: 'ryzen' };
      const fetchImpl = (async (input: string, init?: RequestInit) => {
        const u = new URL(input);
        if (u.pathname.endsWith('/hello')) {
          expect(new Headers(init?.headers).has('Authorization')).toBe(false);
          const token = u.hostname === '127.0.0.1' ? localToken : peerToken;
          return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', token).update(u.searchParams.get('nonce')!).digest('hex') }));
        }
        if (u.hostname === '127.0.0.1') return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }));
        return new Response(JSON.stringify(peerSummary));
      }) as typeof fetch;
      const pending = createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('7d');
      await vi.advanceTimersByTimeAsync(19_999);
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const overview = await pending;
      expect(overview.hosts[0]).toEqual({ label: 'A2000', kind: 'local', status: 'report-timeout' });
      expect(overview.hosts[1].status).toBe('online');
      expect(overview.hosts[1].summary?.totals.tokens).toEqual(peerSummary.totals.tokens);
    } finally { controller?.close(); vi.useRealTimers(); }
  });

  it('still rejects local report authorization failure after identity proof', async () => {
    const tokenFile = prepareFleetConfig();
    const peerSummary = { ...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')), host: 'ryzen' };
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      if (u.pathname.endsWith('/hello')) {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        const token = u.hostname === '127.0.0.1' ? localToken : peerToken;
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', token).update(u.searchParams.get('nonce')!).digest('hex') }));
      }
      return u.hostname === '127.0.0.1' ? new Response('{}', { status: 401 }) : new Response(JSON.stringify(peerSummary));
    }) as typeof fetch;
    await expect(createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('7d')).rejects.toThrow();
  });

  it('loads the local all-history fleet total through a leased report and releases it', async () => {
    const tokenFile = prepareFleetConfig();
    const localSummary = { ...JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'summary-7d.json'), 'utf8')), range: 'all', generatedAt: 34,
      timeBasis: { startMs: null, asOfMs: 34, endInclusive: true, timestampBasis: 'recorded-timestamps', excludedFutureEvents: 0, excludedFutureActivity: 0 } };
    const calls: string[] = [], id = 'c'.repeat(32); let lease = '', released = false;
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      const u = new URL(input); calls.push(u.pathname);
      if (u.pathname.endsWith('/hello')) {
        expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        const token = u.hostname === '127.0.0.1' ? localToken : peerToken;
        return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', token).update(u.searchParams.get('nonce')!).digest('hex') }));
      }
      if (u.hostname !== '127.0.0.1') return new Response(JSON.stringify({ ...localSummary, host: 'ryzen' }));
      if (u.pathname === '/v1/health') return new Response(JSON.stringify({ capabilities: { summaryReadJobs: 1 } }));
      if (init?.method === 'POST') { lease = new Headers(init.headers).get('X-Tokenelo-Read-Lease')!; return new Response(JSON.stringify({ id })); }
      if (init?.method === 'DELETE') { expect(u.pathname.endsWith(lease)).toBe(true); released = true; return new Response('{}'); }
      expect(u.searchParams.get('lease')).toBe(lease);
      return new Response(JSON.stringify({ id, range: 'all', status: 'completed', result: localSummary }));
    }) as typeof fetch;
    const overview = await createApiClient({ tokenFile, fetchImpl, env: { TOKENELO_HOME: tmpHome } }).getFleetOverview('all');
    expect(overview.hosts.map(h => h.status)).toEqual(['online', 'online']);
    expect(overview.hosts[0].summary?.totals).toEqual(localSummary.totals);
    expect(calls).not.toContain('/v1/summary'); expect(released).toBe(true);
  });
});

describe('isDaemonReachable', () => {
  it('true when fetch resolves (any HTTP status, even 401, proves a server is listening)', async () => {
    const fetchImpl = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    expect(await isDaemonReachable({ fetchImpl })).toBe(true);
  });

  it('false when fetch throws (connection refused / no daemon running)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await isDaemonReachable({ fetchImpl })).toBe(false);
  });
});
