/**
 * Usage API oracle, HTTP layer: the real daemon handler (src/daemon/http.ts) on 127.0.0.1, in-process, fed by the daemon's
 * wiring (report reads through a pinned read-only snapshot, the rest through the writable handle), and the real tray
 * api-client (src/tray/api-client.ts) talking to it over loopback. Every response is compared with the oracle and with the
 * synchronous query path. Data is the fabricated cohort; the token is a test string. No authentication, Host, Origin or
 * admission behavior is asserted here (those boundaries belong to the API/proxy contract tests).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/tray/api-client.js';
import { COHORT, HOST_A, HOST_B, NOW, RANGES } from './cohort.js';
import { expectedBlock, expectedLimitContributors, expectedSessions, expectedSummary, expectedTimeseries, usageBucketMs } from './oracle.js';
import { expectMoney, expectPriceAndCounts, expectSessionsResponse } from './expectations.js';
import { API_TOKEN, json, openFileCohort, openMemoryCohort, startServer, usagePair, type Cohort, type FileCohort } from './harness.js';

const savedTz = process.env.TZ;
process.env.TZ = 'UTC';
afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });

let mem: Cohort;
let file: FileCohort;
let server: Awaited<ReturnType<typeof startServer>>;
let tokenDir: string;
let client: ReturnType<typeof createApiClient>;
beforeAll(async () => {
  mem = openMemoryCohort();
  file = openFileCohort();
  server = await startServer(file.daemonQueries());
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-usage-oracle-token-'));
  const tokenFile = path.join(tokenDir, 'api-token');
  fs.writeFileSync(tokenFile, API_TOKEN + '\n');
  client = createApiClient({ baseUrl: server.base, tokenFile, fetchImpl: fetch, env: {}, localTimeoutMs: 15_000 });
});
afterAll(async () => { await server?.close(); mem?.close(); file?.close(); if (tokenDir) fs.rmSync(tokenDir, { recursive: true, force: true }); });

describe('GET /v1/health advertises the paired Usage read', () => {
  it('declares atomic Usage and the historical read jobs the tray uses for "all"', async () => {
    const { status, body } = await server.get('/v1/health');
    expect(status).toBe(200);
    expect(body.capabilities).toMatchObject({ atomicUsage: 1, usageReadJobs: 1, summaryReadJobs: 1 });
  });
});

describe.each(RANGES)('HTTP data for range %s equals the oracle and the synchronous path', (range) => {
  it('GET /v1/summary', async () => {
    const { status, body } = await server.get(`/v1/summary?range=${range}`);
    expect(status).toBe(200);
    expect(body.range).toBe(range);
    expectPriceAndCounts(body.totals, expectedSummary(range).totals, { nullWhenAllUnpriced: false });
    expect(body).toEqual(json(await mem.queries.getSummary(range)));
  });

  it('GET /v1/sessions', async () => {
    const { status, body } = await server.get(`/v1/sessions?range=${range}`);
    expect(status).toBe(200);
    expectSessionsResponse(body, range);
    expect(body).toEqual(json(await mem.queries.getSessions({ range, activeOnly: false })));
  });

  it('GET /v1/sessions?active=1 keeps only the sessions whose last record is inside the five-minute live window', async () => {
    const { body } = await server.get(`/v1/sessions?range=${range}&active=1`);
    const live = expectedSessions(range).filter((s) => s.live).map((s) => `${s.host}|${s.source}|${s.sessionId}`).sort();
    expect(body.sessions.map((s: any) => `${s.host}|${s.source}|${s.sessionId}`).sort()).toEqual(live);
    expect(live.length).toBeGreaterThan(0);
  });

  it.each(['hour', 'day'] as const)('GET /v1/timeseries?bucket=%s', async (bucket) => {
    const { status, body } = await server.get(`/v1/timeseries?range=${range}&bucket=${bucket}`);
    expect(status).toBe(200);
    const x = expectedTimeseries(range, bucket === 'hour' ? 3_600_000 : 86_400_000);
    expect(body.points.map((p: any) => [p.t, p.unpricedEvents, p.estimatedPriceEvents, p.countQuality])).toEqual(x.map((p) => [p.t, p.unpricedEvents, p.estimatedPriceEvents, p.countQuality]));
    expect(body).toEqual(json(await mem.queries.getTimeseries(bucket, range)));
  });

  it('GET /v1/usage is one pair with one clock, equal to the synchronous reads', async () => {
    const { status, body } = await server.get(`/v1/usage?range=${range}`);
    expect(status).toBe(200);
    expect(body.snapshotScope).toBe('shared-read-transaction');
    expect(body.summary.generatedAt).toBe(NOW);
    expect(body.timeseries.generatedAt).toBe(NOW);
    expect(body.timeseries.bucket).toBe(usageBucketMs(range) === 3_600_000 ? 'hour' : 'day');
    expectPriceAndCounts(body.summary.totals, expectedSummary(range).totals, { nullWhenAllUnpriced: false });
    expect(body).toEqual(json(await usagePair(mem.queries, range)));
  });
});

describe('the other tab reads over HTTP', () => {
  it('GET /v1/limits returns the block estimates the oracle derives for both hosts', async () => {
    const { status, body } = await server.get('/v1/limits');
    expect(status).toBe(200);
    for (const host of [HOST_A, HOST_B]) {
      const snap = body.snapshots.find((s: any) => s.source === 'claude-block-estimate' && s.host === host);
      const x = expectedBlock(host)!;
      expect(snap.windows[0]).toMatchObject({ startedAt: x.startedAt, resetsAt: x.resetsAt, tokens: x.tokens, usedPercent: null });
      expectMoney(snap.windows[0].apiEquivUsd, x.apiEquivUsd, `${host} block usd`);
      expect(snap.contributors).toMatchObject(expectedLimitContributors(host));
      expect(Object.keys(snap.contributors[0]).sort()).toEqual([
        'events', 'firstEventAt', 'host', 'knownApiEquivUsd', 'lastEventAt', 'model', 'priceEvidence',
        'priceStatusCounts', 'priceVersion', 'provider', 'servingRoutes', 'tokens', 'tsSource',
      ]);
    }
    expect(body).toEqual(json(await mem.queries.getLimits()));
  });

  it('GET /v1/processes with no listed process is an observed empty list with an explicit listing status, not a failure', async () => {
    const { status, body } = await server.get('/v1/processes');
    expect(status).toBe(200);
    expect(body).toMatchObject({ host: HOST_A, generatedAt: NOW, processes: [] });
    expect(body.listing).toBeDefined();
  });

  it('GET /v1/coverage: a tool is "captured" exactly when a recorded event timestamp backs it', async () => {
    const { status, body } = await server.get('/v1/coverage');
    expect(status).toBe(200);
    const recorded = new Set(COHORT.map((c) => c.ts));
    const byId = new Map<string, any>(body.tools.map((t: any) => [t.id, t]));
    for (const tool of body.tools) {
      expect(tool.captured, `${tool.id}: captured must equal "has a last event time"`).toBe(tool.lastEventAt !== null);
      if (tool.lastEventAt !== null) {
        expect(recorded.has(tool.lastEventAt), `${tool.id} lastEventAt ${tool.lastEventAt} must be a recorded cohort timestamp`).toBe(true);
        expect(tool.lastTelemetryTimeBasis).toBe('event-recorded');
      }
    }
    // Feeds with a single unambiguous latest record. (Whether Coverage fences the query clock is a separate observation, see NOTES.md.)
    expect(byId.get('claude-code-cli')).toMatchObject({ captured: true, lastEventAt: NOW });
    expect(byId.get('ollama')).toMatchObject({ captured: true, lastEventAt: COHORT.find((c) => c.id === 'l01')!.ts });
    expect(body.tools.filter((t: any) => !t.captured).length, 'tools with no recorded event stay uncaptured (null), not "captured with zero"').toBeGreaterThan(0);
    expect(body.generatedAt).toBe(NOW);
  });
});

describe('the real tray api-client over loopback returns the same cohort the oracle expects', () => {
  it.each(RANGES)('getUsage(%s) passes the client validation (one clock, one time basis) and matches the oracle', async (range) => {
    const usage = await client.getUsage(range);
    expect(usage.snapshotScope).toBe('shared-read-transaction');
    expect(usage.summary.range).toBe(range);
    expect(usage.timeseries.range).toBe(range);
    expect(usage.timeseries.timeBasis).toEqual(usage.summary.timeBasis);
    expectPriceAndCounts(usage.summary.totals, expectedSummary(range).totals, { nullWhenAllUnpriced: false });
    expect(json(usage)).toEqual(json(await usagePair(mem.queries, range)));
  });

  it.each(RANGES)('getSessionsResponse(%s) keeps the response clock and the recorded window', async (range) => {
    const res = await client.getSessionsResponse!(range);
    expectSessionsResponse(res, range);
    expect(res.generatedAt).toBe(NOW);
  });

  it('getLimits and getProcesses pass through unchanged', async () => {
    expect(json(await client.getLimits())).toEqual(json(await mem.queries.getLimits()));
    expect((await client.getProcesses()).processes).toEqual([]);
  });
});
