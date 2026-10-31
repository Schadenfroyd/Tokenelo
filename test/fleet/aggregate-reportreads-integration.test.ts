import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { HostLabel, Range, SummaryResponse } from '../../src/core/types.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { createPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import { createApiClient } from '../../src/tray/api-client.js';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries, type Queries } from '../../src/store/queries.js';
import { makeEvent } from '../store/stubs.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { closeHttpReads, createHttpServer } from '../../src/daemon/http.js';
import { createFleetHttpServer, FLEET_PORT, getFleetPeerTokenPath } from '../../src/daemon/fleet.js';
import { ReportReads, isolatedReportQueries, type ReportReadObservation, type ReportReadsOptions } from '../../src/daemon/report-reads.js';
import type { ReportReadConfiguration } from '../../src/daemon/report-read-protocol.js';
import { SUMMARY_JOB_BUDGET_MS } from '../../src/daemon/summary-read-jobs.js';

const PRIVATE = 'SYNTHETIC-FLEET-PRIVATE';
const API_TOKEN = 'a'.repeat(64);
const PEERS = [
  { label: 'ryzen' as HostLabel, ip: '100.64.0.8', token: 'b'.repeat(64) },
  { label: 'a2000' as HostLabel, ip: '100.64.0.9', token: 'c'.repeat(64) },
];
const RANGES: Range[] = ['today', '24h', '7d', '30d', 'all'];
const DAY = 24 * 60 * 60 * 1000;

interface TestHost {
  label: HostLabel;
  db: TokeneloDb;
  file: string;
  config: ReturnType<typeof defaultConfig>;
  configuration: ReportReadConfiguration;
  queries: Queries;
}

interface CapturedRequest { host: string; path: string; method: string; authorization: string | null }
interface CapturedResponse { host: string; path: string; status: number; cacheControl: string | null; body: string }

const tempDirs: string[] = [];
const servers: http.Server[] = [];
const localApiServers: http.Server[] = [];
const reportPools: ReportReads[] = [];
const databases: TokeneloDb[] = [];
afterEach(async () => {
  for (const server of localApiServers.splice(0)) await closeHttpReads(server).catch(() => {});
  for (const server of servers.splice(0)) await closeServer(server);
  for (const reads of reportPools.splice(0)) await reads.close().catch(() => {});
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeHost(label: HostLabel): TestHost {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-reportreads-'));
  tempDirs.push(root);
  const file = path.join(root, 'ledger.sqlite');
  const db = openDb({ file });
  databases.push(db);
  const config = defaultConfig({ hostLabel: label });
  const priceRows = loadPriceRows();
  const pricing = createPricingEngine(priceRows);
  const valuationEngine = createNullEngine();
  const ledger = new SqliteLedger(db, pricing, valuationEngine);
  const now = Date.now();
  const offsets = [60_000, 2 * 60 * 60_000, 2 * DAY, 10 * DAY, 45 * DAY];
  const rows = offsets.map((offset, index) => {
    const source = index % 2 === 0 ? 'codex' : 'claude';
    const model = source === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-5';
    return {
      ...makeEvent({ id: `${PRIVATE}-${label}-${index}`, host: label, source, model,
        ts: now - offset, sessionId: `${PRIVATE}-session-${label}-${index}`,
        inputFresh: 100 + index * 100, cacheWrite5m: index, cacheWrite1h: index * 2,
        cacheRead: index * 3, output: 20 + index * 10, reasoning: index }),
      project: `${PRIVATE}/project/${index}`,
      repoRoot: `${PRIVATE}/repo/${index}`,
      gitBranch: `${PRIVATE}/branch/${index}`,
      entrypoint: `${PRIVATE}/entry/${index}`,
      parentSessionId: `${PRIVATE}-parent-${index}`,
    };
  });
  ledger.upsertEvents(rows);
  return {
    label, db, file, config,
    configuration: { dbFile: file, config, priceRows, pricesVersion: pricing.version },
    queries: createQueries(db, config, { pricing }),
  };
}

function makeReads(host: TestHost, options: ReportReadsOptions = {}): ReportReads {
  const reads = new ReportReads(host.configuration, options);
  reportPools.push(reads);
  return reads;
}

async function startLocalApi(host: TestHost, token: string): Promise<{ server: http.Server; port: number }> {
  const reads = makeReads(host);
  const history = makeReads(host, { workers: 1, waiting: 2, budgetMs: SUMMARY_JOB_BUDGET_MS, maxResultBytes: 8 * 1024 ** 2 });
  const queries = isolatedReportQueries(host.queries, reads, history);
  const opts = { port: 0, token, queries, host: host.label };
  const server = createHttpServer(opts);
  servers.push(server);
  localApiServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  opts.port = (server.address() as import('node:net').AddressInfo).port;
  return { server, port: opts.port };
}

async function startImmediateLocalApi(host: TestHost, token: string): Promise<{ server: http.Server; port: number }> {
  // The disconnected-peer test isolates the peer worker's one-second cancellation grace.
  // Keep the local side on the same authenticated HTTP API but use its synthetic direct query.
  const opts = { port: 0, token, queries: host.queries, host: host.label };
  const server = createHttpServer(opts);
  servers.push(server);
  localApiServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  opts.port = (server.address() as import('node:net').AddressInfo).port;
  return { server, port: opts.port };
}

async function startFleetPeer(host: TestHost, ip: string, token: string, options: ReportReadsOptions = {}): Promise<number> {
  const reads = makeReads(host, options);
  const queries = isolatedReportQueries(host.queries, reads);
  const server = createFleetHttpServer({ address: ip, token, queries, host: host.label });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return (server.address() as import('node:net').AddressInfo).port;
}

function createFetchHarness(ports: Map<string, number>) {
  const requests: CapturedRequest[] = [];
  const responses: CapturedResponse[] = [];
  const activeSummaries = new Map<string, http.ClientRequest>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === '127.0.0.1') return globalThis.fetch(input, init);
    const port = ports.get(url.hostname);
    if (port === undefined) throw new Error(`blocked non-fixture network target: ${url.hostname}`);
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization');
    const method = init?.method ?? 'GET';
    const request: CapturedRequest = { host: url.hostname, path: url.pathname + url.search, method, authorization };
    requests.push(request);
    return new Promise<Response>((resolve, reject) => {
      const nodeHeaders: Record<string, string> = { host: url.host };
      headers.forEach((value, key) => { nodeHeaders[key] = value; });
      const req = http.request({ host: '127.0.0.1', port, path: request.path, method, headers: nodeHeaders }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const cacheControl = typeof res.headers['cache-control'] === 'string' ? res.headers['cache-control'] : null;
          responses.push({ host: url.hostname, path: url.pathname + url.search, status: res.statusCode ?? 0, cacheControl, body });
          if (activeSummaries.get(url.hostname) === req) activeSummaries.delete(url.hostname);
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') responseHeaders.set(key, value);
            else if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
          }
          resolve(new Response(body, { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      });
      if (url.pathname === '/v1/fleet/summary') {
        activeSummaries.set(url.hostname, req);
      }
      req.once('error', error => {
        if (activeSummaries.get(url.hostname) === req) activeSummaries.delete(url.hostname);
        reject(error);
      });
      const abort = () => req.destroy(new Error('synthetic fetch aborted'));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort, { once: true });
      req.end();
    });
  }) as typeof fetch;
  return { fetchImpl, requests, responses, activeSummaries };
}

function createClient(localPort: number, peers: typeof PEERS, transport: ReturnType<typeof createFetchHarness>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-client-'));
  tempDirs.push(home);
  const dataDir = path.join(home, 'data'), configDir = path.join(home, 'config');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const tokenFile = path.join(dataDir, 'api-token');
  fs.writeFileSync(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    hostLabel: 'M4a',
    fleet: { peers: peers.map(peer => ({ label: peer.label, url: `http://${peer.ip}:${FLEET_PORT}` })) },
  }));
  for (const peer of peers) {
    const file = getFleetPeerTokenPath({ dataDir } as never, peer.label);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${peer.token}\n`, { mode: 0o600 });
  }
  return createApiClient({ baseUrl: `http://127.0.0.1:${localPort}`, tokenFile,
    fetchImpl: transport.fetchImpl, env: { TOKENELO_HOME: home } });
}

function fixture(body: string): URL {
  const root = tempDirs.at(-1)!;
  const file = path.join(root, 'fleet-report-worker-fixture.mjs');
  fs.writeFileSync(file, `import { parentPort, workerData } from 'node:worker_threads';\n${body}\n`);
  return pathToFileURL(file);
}

function ledgerSnapshot(db: TokeneloDb): string {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string | null }[];
  const contents: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    const quote = `"${name.replaceAll('"', '""')}"`;
    const columns = (db.prepare(`PRAGMA table_info(${quote})`).all() as { name: string }[]).map(row => row.name);
    const order = columns.map(column => `"${column.replaceAll('"', '""')}"`).join(', ');
    contents[name] = db.prepare(`SELECT * FROM ${quote} ORDER BY ${order}`).all();
  }
  const sequence = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get()
    ? db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all() : [];
  return JSON.stringify({ schema: tables, contents, sequence }, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
}

function expectedTotals(db: TokeneloDb, range: Range, asOf: number) {
  const rows = db.prepare('SELECT source, ts, input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, api_equiv_usd FROM events ORDER BY rowid').all() as {
    source: string; ts: number; input_fresh: number; cache_write_5m: number; cache_write_1h: number;
    cache_read: number; output: number; reasoning: number; api_equiv_usd: number | null;
  }[];
  let since: number | undefined;
  if (range === 'today') { const start = new Date(asOf); start.setHours(0, 0, 0, 0); since = start.getTime(); }
  else if (range === '24h') since = asOf - DAY;
  else if (range === '7d') since = asOf - 7 * DAY;
  else if (range === '30d') since = asOf - 30 * DAY;
  const selected = rows.filter(row => since === undefined || row.ts >= since);
  const sums = (sourceRows: typeof selected) => ({
    events: sourceRows.length,
    inputFresh: sourceRows.reduce((sum, row) => sum + row.input_fresh, 0),
    cacheWrite5m: sourceRows.reduce((sum, row) => sum + row.cache_write_5m, 0),
    cacheWrite1h: sourceRows.reduce((sum, row) => sum + row.cache_write_1h, 0),
    cacheRead: sourceRows.reduce((sum, row) => sum + row.cache_read, 0),
    output: sourceRows.reduce((sum, row) => sum + row.output, 0),
    reasoning: sourceRows.reduce((sum, row) => sum + row.reasoning, 0),
    apiEquivUsd: sourceRows.reduce((sum, row) => sum + (row.api_equiv_usd ?? 0), 0),
  });
  return { totals: sums(selected), bySource: new Map([...new Set(selected.map(row => row.source))]
    .map(source => [source, sums(selected.filter(row => row.source === source))])) };
}

function assertSummary(summary: SummaryResponse, host: TestHost, range: Range): void {
  expect(Object.keys(summary).sort()).toEqual(['activeTime', 'bySource', 'generatedAt', 'host', 'range', 'totals']);
  expect(summary.host).toBe(host.label);
  expect(summary.range).toBe(range);
  const text = JSON.stringify(summary);
  expect(text).not.toContain(PRIVATE);
  const keys = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { keys.add(key); collect(child); }
  };
  collect(summary);
  for (const forbidden of ['project', 'repoRoot', 'gitBranch', 'entrypoint', 'sessionId', 'parentSessionId', 'byModel', 'subscriptions', 'local', 'processes', 'account'])
    expect(keys.has(forbidden), `${host.label}/${range} leaked ${forbidden}`).toBe(false);
}

function assertAggregate(summary: SummaryResponse, host: TestHost, range: Range): void {
  const expected = expectedTotals(host.db, range, summary.generatedAt);
  expect(summary.totals.events, `${host.label}/${range} events`).toBe(expected.totals.events);
  for (const key of ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const)
    expect(summary.totals.tokens[key], `${host.label}/${range} ${key}`).toBe(expected.totals[key]);
  expect(summary.totals.apiEquivUsd, `${host.label}/${range} API-equivalent`).toBeCloseTo(expected.totals.apiEquivUsd, 12);
  for (const [source, sourceExpected] of expected.bySource) {
    const actual = summary.bySource[source as keyof SummaryResponse['bySource']];
    expect(actual?.events, `${host.label}/${range}/${source} events`).toBe(sourceExpected.events);
    for (const key of ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const)
      expect(actual?.tokens[key], `${host.label}/${range}/${source} ${key}`).toBe(sourceExpected[key]);
    expect(actual?.apiEquivUsd, `${host.label}/${range}/${source} API-equivalent`).toBeCloseTo(sourceExpected.apiEquivUsd, 12);
  }
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function assertCheckpointFree(db: TokeneloDb): void {
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number; log?: number } | undefined;
  expect(checkpoint?.busy).toBe(0);
  expect(checkpoint?.log).toBe(0);
}

it('composes the Fleet client and HTTP handlers with real report workers for all ranges and hosts', async () => {
  const local = makeHost('M4a');
  const ryzen = makeHost('ryzen');
  const a2000 = makeHost('a2000');
  const before = new Map([local, ryzen, a2000].map(host => [host.label, ledgerSnapshot(host.db)]));
  const localApi = await startLocalApi(local, API_TOKEN);
  const ports = new Map<string, number>();
  ports.set(PEERS[0]!.ip, await startFleetPeer(ryzen, PEERS[0]!.ip, PEERS[0]!.token));
  ports.set(PEERS[1]!.ip, await startFleetPeer(a2000, PEERS[1]!.ip, PEERS[1]!.token));
  const transport = createFetchHarness(ports);
  const client = createClient(localApi.port, PEERS, transport);

  for (const range of RANGES) {
    const overview = await client.getFleetOverview(range);
    expect(overview.hosts.map(host => [host.label, host.status])).toEqual([
      ['M4a', 'online'], ['ryzen', 'online'], ['a2000', 'online'],
    ]);
    expect(overview.range).toBe(range);
    for (const hostResult of overview.hosts) {
      expect(hostResult.summary).toBeDefined();
      const host = [local, ryzen, a2000].find(candidate => candidate.label === hostResult.label)!;
      assertSummary(hostResult.summary as SummaryResponse, host, range);
      assertAggregate(hostResult.summary as SummaryResponse, host, range);
    }
  }

  const fleetResponses = transport.responses.filter(response => response.path.startsWith('/v1/fleet/summary'));
  expect(fleetResponses).toHaveLength(RANGES.length * PEERS.length);
  expect(fleetResponses.every(response => response.status === 200 && response.cacheControl === 'no-store')).toBe(true);
  for (const peer of PEERS) {
    const sent = transport.requests.filter(request => request.host === peer.ip);
    expect(sent.filter(request => request.path.startsWith('/v1/fleet/hello')).map(request => request.method).every(method => method === 'GET')).toBe(true);
    expect(sent.filter(request => request.path.startsWith('/v1/fleet/summary')).map(request => request.authorization))
      .toEqual(RANGES.map(() => `Bearer ${peer.token}`));
    expect(sent.filter(request => request.path.startsWith('/v1/fleet/hello')).every(request => request.authorization === null)).toBe(true);
  }
  for (const host of [local, ryzen, a2000]) {
    expect(ledgerSnapshot(host.db), `${host.label} ledger`).toBe(before.get(host.label));
    assertCheckpointFree(host.db);
  }
}, 30_000);

it('cancels a disconnected Fleet read, holds capacity through worker retirement, then admits the next read', async () => {
  const local = makeHost('M4a');
  const peer = makeHost('ryzen');
  const localApi = await startImmediateLocalApi(local, API_TOKEN);
  const root = tempDirs.at(-1)!;
  const startedFile = path.join(root, 'worker-started.txt');
  const cancelFile = path.join(root, 'worker-cancelled.txt');
  const allowRetirementFile = path.join(root, 'allow-retirement.txt');
  const summaryFile = path.join(root, 'successful-summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(await peer.queries.getSummary('all')));
  const workerUrl = fixture(`
import fs from 'node:fs';
import { createRequire } from 'node:module';
const started = ${JSON.stringify(startedFile)};
const cancelled = ${JSON.stringify(cancelFile)};
const allow = ${JSON.stringify(allowRetirementFile)};
const success = ${JSON.stringify(summaryFile)};
const count = fs.existsSync(started) ? fs.readFileSync(started, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(started, 'start\\n');
if (count > 0) {
  const result = JSON.parse(fs.readFileSync(success, 'utf8'));
  result.range = workerData.task.range;
  parentPort.postMessage({ type: 'result', json: JSON.stringify(result) });
  parentPort.close();
} else {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(workerData.configuration.dbFile, { readOnly: true });
  db.exec('PRAGMA query_only=ON; BEGIN');
  db.prepare('SELECT COUNT(*) FROM events').get();
  fs.writeFileSync(started + '.snapshot', 'held');
  let cancelSeen = false;
  parentPort.on('message', message => {
    if (message.type === 'cancel') { cancelSeen = true; fs.writeFileSync(cancelled, 'seen'); }
  });
  const timer = setInterval(() => {
    if (cancelSeen && fs.existsSync(allow)) {
      clearInterval(timer);
      db.exec('ROLLBACK');
      db.close();
      parentPort.close();
    }
  }, 5);
}`);
  const retired: ReportReadObservation[] = [];
  let retireFirst!: () => void;
  const firstRetirement = new Promise<void>(resolve => { retireFirst = resolve; });
  const peerReads = makeReads(peer, { workers: 1, waiting: 0, workerUrl,
    onRetired: observation => { retired.push(observation); if (retired.length === 1) retireFirst(); } });
  const peerQueries = isolatedReportQueries(peer.queries, peerReads);
  const peerServer = createFleetHttpServer({ address: PEERS[0]!.ip, token: PEERS[0]!.token, queries: peerQueries, host: peer.label });
  servers.push(peerServer);
  await new Promise<void>((resolve, reject) => {
    peerServer.once('error', reject);
    peerServer.listen(0, '127.0.0.1', () => { peerServer.off('error', reject); resolve(); });
  });
  const ports = new Map([[PEERS[0]!.ip, (peerServer.address() as import('node:net').AddressInfo).port]]);
  const transport = createFetchHarness(ports);
  const client = createClient(localApi.port, [PEERS[0]!], transport);

  try {
    const interruptedOverview = client.getFleetOverview('all');
    await waitFor(() => fs.existsSync(startedFile + '.snapshot'), 'Fleet worker snapshot');
    await waitFor(() => transport.activeSummaries.has(PEERS[0]!.ip), 'peer summary HTTP request');
    transport.activeSummaries.get(PEERS[0]!.ip)!.destroy(new Error('synthetic caller disconnect'));
    const interrupted = await interruptedOverview;
    expect(interrupted.hosts.find(host => host.label === peer.label)?.status).toBe('offline');
    await waitFor(() => fs.existsSync(cancelFile), 'worker cancellation');
    expect(retired).toHaveLength(0);

    // The Fleet client is exercised again while the owned SQLite snapshot remains open.
    const whileRetiring = await client.getFleetOverview('all');
    expect(whileRetiring.hosts.find(host => host.label === peer.label)?.status).toBe('report-unavailable');
    expect(fs.readFileSync(startedFile, 'utf8').trim().split(/\r?\n/)).toEqual(['start']);
    expect(retired).toHaveLength(0);

    fs.writeFileSync(allowRetirementFile, 'release');
    await firstRetirement;
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ kind: 'summary', range: 'all', outcome: 'read_cancelled', workerStarted: true });
    assertCheckpointFree(peer.db);

    const afterRetirement = await client.getFleetOverview('all');
    expect(afterRetirement.hosts.find(host => host.label === peer.label)?.status).toBe('online');
    expect(fs.readFileSync(startedFile, 'utf8').trim().split(/\r?\n/)).toEqual(['start', 'start']);
  } finally {
    fs.writeFileSync(allowRetirementFile, 'release');
  }
}, 30_000);

it('keeps a report worker failure bounded at the Fleet HTTP and client boundaries', async () => {
  const local = makeHost('M4a');
  const peer = makeHost('ryzen');
  const localApi = await startLocalApi(local, API_TOKEN);
  const workerUrl = fixture(`parentPort.postMessage({ type: 'failure', code: 'query_failed', privateDetail: '${PRIVATE}/path' }); parentPort.close();`);
  const peerReads = makeReads(peer, { workerUrl });
  const peerQueries = isolatedReportQueries(peer.queries, peerReads);
  const server = createFleetHttpServer({ address: PEERS[0]!.ip, token: PEERS[0]!.token, queries: peerQueries, host: peer.label });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const ports = new Map([[PEERS[0]!.ip, (server.address() as import('node:net').AddressInfo).port]]);
  const transport = createFetchHarness(ports);
  const client = createClient(localApi.port, [PEERS[0]!], transport);

  const before = ledgerSnapshot(peer.db);
  const overview = await client.getFleetOverview('7d');
  expect(overview.hosts.find(host => host.label === peer.label)?.status).toBe('report-unavailable');
  const errorResponse = transport.responses.find(response => response.path === '/v1/fleet/summary?range=7d');
  expect(errorResponse?.status).toBe(503);
  expect(errorResponse?.cacheControl).toBe('no-store');
  expect(errorResponse?.body).toContain('query_failed');
  expect(errorResponse?.body).not.toContain(PRIVATE);
  expect(ledgerSnapshot(peer.db)).toBe(before);
}, 20_000);
