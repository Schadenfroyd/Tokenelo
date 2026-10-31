/**
 * http.ts is tested against a hand-written fake `Queries` — never a real database or a real
 * pricing engine — so these tests cover exactly what http.ts owns: method/Host/Origin/auth
 * gating and route dispatch, independent of anything store/queries.ts or core/* actually compute.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createHttpServer, stopHttpReadAdmission } from '../../src/daemon/http.js';
import { ReportReadError } from '../../src/daemon/report-read-protocol.js';
import type { Queries } from '../../src/store/queries.js';
import type {
  DoctorReport,
  CoverageResponse,
  LimitsResponse,
  SessionDetail,
  SummaryResponse,
  TimeseriesResponse,
} from '../../src/core/types.js';

const TOKEN = 'test-token-abc123';
const PORT = 47922; // dedicated test port, unlikely to collide with a real daemon (47821)

function fakeSummary(range: SummaryResponse['range']): SummaryResponse {
  return {
    host: 'M4a',
    range,
    generatedAt: 1000,
    totals: { events: 1, tokens: { inputFresh: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 }, apiEquivUsd: 0.01, unpricedEvents: 0 },
    bySource: {} as SummaryResponse['bySource'],
    byModel: [],
    local: { captured: false, reason: 'local capture not configured', valueVsClaude: { usd: null, comparator: 'claude-sonnet-5', status: 'NONE', unratedEvents: 0 }, valueVsGpt: { usd: null, comparator: 'gpt-6-sol', status: 'NONE', unratedEvents: 0 }, energy: { kwh: null, usd: null, status: 'NONE' }, netSavingsVsClaude: null, netSavingsVsGpt: null },
    subscriptions: [],
    activeTime: { agentMs: 0, wallMs: 0 },
  };
}

function fakeSessionDetail(source: SessionDetail['source'], sessionId: string): SessionDetail {
  return {
    source,
    sessionId,
    host: 'M4a',
    models: ['claude-sonnet-5'],
    start: 1000,
    end: 2000,
    activeMs: 500,
    live: false,
    subagents: 0,
    tokens: { inputFresh: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 },
    apiEquivUsd: 0.01,
    burn: null,
    byModel: [],
    timeseries: { bucketMs: 300_000, points: [] },
    subagentSessions: [],
    cacheReadShare: null,
    thinkingShare: null,
    thinkingUnknownEvents: 0,
    events: 1,
    firstEventTs: 1000,
    lastEventTs: 2000,
    wallMs: 1000,
    flags: {},
  };
}

let getSummaryCalls: SummaryResponse['range'][] = [];
let sessionsThrows: unknown = null;
let sessionDetailCalls: { source: string; sessionId: string }[] = [];
let sessionDetailReturns: SessionDetail | null | 'default' = 'default';
let doctorIncompleteCapture: DoctorReport['incompleteCapture'] | undefined;
let coverageIncompleteCapture: CoverageResponse['incompleteCapture'] | undefined;

const fakeQueries: Queries = {
  async getSummary(range) {
    getSummaryCalls.push(range);
    return fakeSummary(range);
  },
  async getSessions(opts) {
    if (sessionsThrows) throw sessionsThrows;
    return { range: opts.range, sessions: [] };
  },
  async getLimits(): Promise<LimitsResponse> {
    return { snapshots: [] };
  },
  async getTimeseries(bucket, range): Promise<TimeseriesResponse> {
    return { bucket, range, points: [] };
  },
  async getDoctor(): Promise<DoctorReport> {
    return {
      host: 'M4a',
      generatedAt: 1000,
      skippedPaths: [],
      unmatchedModels: [],
      thinkingUnknownEvents: 0,
      codex: { resetFiles: 0, inheritedBaselineFiles: 0, suspectFiles: 0, recordReconciledFiles: 0, nonZeroCacheWrite: 0, ownInWrapperFiles: 0, ownInWrapperEvents: 0, trailingRecordFiles: 0 },
      claude: { speedAssumed: 0, cacheSplitAssumed: 0, iterationEvents: 0, reasoningClamped: 0 },
      ollama: { servers: [], unmeteredRequests: 0, capture: 'proxy' },
      ...(doctorIncompleteCapture === undefined ? {} : { incompleteCapture: doctorIncompleteCapture }),
      warnings: [],
    };
  },
  async exportEvents() {
    return [];
  },
  async getProcesses() {
    return { host: 'M4a', generatedAt: 1000, processes: [] };
  },
  async getCoverage() {
    return { host: 'M4a', generatedAt: 1000, tools: [],
      ...(coverageIncompleteCapture === undefined ? {} : { incompleteCapture: coverageIncompleteCapture }) };
  },
  async getPlanUsageHistory() {
    return { host: 'M4a', series: [] };
  },
  async getSessionDetail(source, sessionId) {
    sessionDetailCalls.push({ source, sessionId });
    if (sessionDetailReturns === 'default') return fakeSessionDetail(source, sessionId);
    return sessionDetailReturns;
  },
};

it('Doctor authenticates before admission and forwards HTTP disconnect cancellation to its read', async () => {
  let calls = 0, ready!: () => void, aborted!: () => void;
  const admitted = new Promise<void>(ok => { ready = ok; });
  const cancelled = new Promise<void>(ok => { aborted = ok; });
  const settings: Parameters<typeof createHttpServer>[0] = { port: 0, token: TOKEN, host: 'fixture', queries: { ...fakeQueries,
    getDoctor: control => {
      calls++; ready();
      return new Promise((_ok, no) => {
        control!.signal!.addEventListener('abort', () => { aborted(); no(new ReportReadError('read_cancelled')); }, { once: true });
      });
    },
  } };
  const owned = createHttpServer(settings);
  await new Promise<void>(ok => owned.listen(0, '127.0.0.1', ok));
  const port = (owned.address() as import('node:net').AddressInfo).port;
  settings.port = port;
  try {
    expect((await fetch(`http://127.0.0.1:${port}/v1/doctor`)).status).toBe(401); expect(calls).toBe(0);
    const request = http.get(`http://127.0.0.1:${port}/v1/doctor`, { headers: { authorization: `Bearer ${TOKEN}` } });
    request.on('error', () => {});
    await admitted; request.destroy(); await cancelled; expect(calls).toBe(1);
  } finally { owned.closeAllConnections(); await new Promise<void>(ok => owned.close(() => ok())); }
});

let server: http.Server;
const base = `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
  server = createHttpServer({ port: PORT, token: TOKEN, queries: fakeQueries, host: 'M4a', buildIdentity: { schemaVersion: 1, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) } });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface RawResponse {
  status: number;
  body: unknown;
}

async function raw(pathAndQuery: string, opts?: { method?: string; token?: string | null; host?: string; origin?: string }): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  if (opts?.token !== null) headers['authorization'] = `Bearer ${opts?.token ?? TOKEN}`;
  if (opts?.origin !== undefined) headers['origin'] = opts.origin;
  const res = await fetch(`${base}${pathAndQuery}`, {
    method: opts?.method ?? 'GET',
    headers: { ...headers, host: opts?.host ?? `127.0.0.1:${PORT}` },
    // Node's fetch always sets its own Host from the URL; to actually control the Host header
    // sent over the wire we use raw http.request instead (see rawHttp below). fetch() is kept
    // only for readability in tests that don't touch Host.
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body };
}

/** Like `raw`, but sends the exact Host header given (Node's global `fetch` always derives Host
 * from the URL and ignores a caller-supplied one, so the Host-rejection tests need `http.request`
 * directly). */
function rawWithHost(pathAndQuery: string, hostHeader: string, opts?: { token?: string | null; origin?: string }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: hostHeader };
    if (opts?.token !== null) headers['authorization'] = `Bearer ${opts?.token ?? TOKEN}`;
    if (opts?.origin !== undefined) headers['origin'] = opts.origin;
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathAndQuery, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body: unknown = data;
        try {
          body = JSON.parse(data);
        } catch {
          /* leave as text */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('createHttpServer: auth', () => {
  it('401s a request with no Authorization header', async () => {
    const res = await raw('/v1/health', { token: null });
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toBe('unauthorized');
  });

  it('401s a request with the wrong token', async () => {
    const res = await raw('/v1/health', { token: 'totally-wrong' });
    expect(res.status).toBe(401);
  });

  it('401s a Latin-1 bearer value whose JavaScript length matches but UTF-8 byte length does not', async () => {
    const res = await rawWithHost('/v1/health', `127.0.0.1:${PORT}`, { token: 'é'.repeat(TOKEN.length) });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
    expect((await raw('/v1/health')).status).toBe(200);
  });

  it('200s a request with the correct bearer token', async () => {
    const res = await raw('/v1/health');
    expect(res.status).toBe(200);
    expect((res.body as { status: string; buildIdentity: unknown }).status).toBe('ok');
    expect((res.body as { buildIdentity: unknown }).buildIdentity).toEqual({ schemaVersion: 1, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) });
  });

  it('mutation check: a token differing only in its last character is still rejected (not a prefix match)', async () => {
    const res = await raw('/v1/health', { token: TOKEN.slice(0, -1) + 'X' });
    expect(res.status).toBe(401);
  });
});

describe('createHttpServer: unavailable build identity', () => {
  it('returns explicit unknown when no compiled build identity was supplied', async () => {
    const settings: Parameters<typeof createHttpServer>[0] = { port: 0, token: TOKEN, queries: fakeQueries, host: 'M4a' };
    const absent = createHttpServer(settings);
    await new Promise<void>(resolve => absent.listen(0, '127.0.0.1', resolve));
    const port = (absent.address() as import('node:net').AddressInfo).port;
    settings.port = port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      expect((await res.json() as { buildIdentity: unknown }).buildIdentity).toBeNull();
    } finally {
      await new Promise<void>(resolve => absent.close(() => resolve()));
    }
  });
});

describe('createHttpServer: Host guard', () => {
  it('403s a request whose Host header is not this daemon', async () => {
    const res = await rawWithHost('/v1/health', 'evil.example.com:80');
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('forbidden_host');
  });

  it('accepts Host: 127.0.0.1:<port>', async () => {
    const res = await rawWithHost('/v1/health', `127.0.0.1:${PORT}`);
    expect(res.status).toBe(200);
  });

  it('accepts Host: localhost:<port>', async () => {
    const res = await rawWithHost('/v1/health', `localhost:${PORT}`);
    expect(res.status).toBe(200);
  });

  it('mutation check: the same port number on the wrong hostname is still rejected', async () => {
    const res = await rawWithHost('/v1/health', `attacker.local:${PORT}`);
    expect(res.status).toBe(403);
  });

  it('accepts Host: [::1]:<port> (shared loopback helper, daemon/loopback.ts)', async () => {
    const res = await rawWithHost('/v1/health', `[::1]:${PORT}`);
    expect(res.status).toBe(200);
  });
});

describe('createHttpServer: GET /v1/hello (unauthenticated identity challenge)', () => {
  it('answers a well-formed nonce with a valid HMAC proof, with no Authorization header at all', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await raw(`/v1/hello?nonce=${nonce}`, { token: null });
    expect(res.status).toBe(200);
    const expected = crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex');
    expect((res.body as { proof: string }).proof).toBe(expected);
  });

  it('mutation check: a proof computed with the wrong token does not match what the real server returns', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await raw(`/v1/hello?nonce=${nonce}`, { token: null });
    const wrongProof = crypto.createHmac('sha256', 'not-the-real-token').update(nonce).digest('hex');
    expect((res.body as { proof: string }).proof).not.toBe(wrongProof);
  });

  it('400s a missing nonce', async () => {
    const res = await raw('/v1/hello', { token: null });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('bad_request');
  });

  it('400s a malformed nonce (not exactly 32 hex chars)', async () => {
    expect((await raw('/v1/hello?nonce=short', { token: null })).status).toBe(400);
    expect((await raw(`/v1/hello?nonce=${'a'.repeat(31)}`, { token: null })).status).toBe(400);
    expect((await raw(`/v1/hello?nonce=${'g'.repeat(32)}`, { token: null })).status).toBe(400); // not hex
  });

  it('still enforces the Host guard (Host/Origin checks run before the /v1/hello route)', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await rawWithHost(`/v1/hello?nonce=${nonce}`, 'evil.example.com:80', { token: null });
    expect(res.status).toBe(403);
  });

  it('still enforces the Origin guard', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await rawWithHost(`/v1/hello?nonce=${nonce}`, `127.0.0.1:${PORT}`, {
      token: null,
      origin: 'http://127.0.0.1:1234',
    });
    expect(res.status).toBe(403);
  });
});

describe('createHttpServer: Origin guard', () => {
  it('403s any request carrying an Origin header, even a same-looking one', async () => {
    const res = await rawWithHost('/v1/health', `127.0.0.1:${PORT}`, { origin: 'http://127.0.0.1:1234' });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('forbidden_origin');
  });

  it('mutation check: an empty-string Origin header is still "present" and still rejected', async () => {
    const res = await rawWithHost('/v1/health', `127.0.0.1:${PORT}`, { origin: '' });
    expect(res.status).toBe(403);
  });
});

describe('createHttpServer: method guard', () => {
  it('405s POST', async () => {
    const res = await raw('/v1/health', { method: 'POST' });
    expect(res.status).toBe(405);
    expect((res.body as { error: string }).error).toBe('method_not_allowed');
  });

  it('405s DELETE', async () => {
    const res = await raw('/v1/summary', { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('createHttpServer: routes', () => {
  it('GET /v1/summary defaults range to "today" and forwards it to Queries', async () => {
    getSummaryCalls = [];
    const res = await raw('/v1/summary');
    expect(res.status).toBe(200);
    expect(getSummaryCalls).toEqual(['today']);
    expect((res.body as SummaryResponse).host).toBe('M4a');
  });

  it('GET /v1/summary?range=7d forwards the explicit range', async () => {
    getSummaryCalls = [];
    const res = await raw('/v1/summary?range=7d');
    expect(res.status).toBe(200);
    expect(getSummaryCalls).toEqual(['7d']);
  });

  it('GET /v1/summary?range=bogus is a 400, never silently defaulted', async () => {
    const res = await raw('/v1/summary?range=bogus');
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('bad_request');
  });

  it('GET /v1/sessions?active=1 parses the active flag', async () => {
    const res = await raw('/v1/sessions?active=1');
    expect(res.status).toBe(200);
    expect((res.body as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('GET /v1/limits, /v1/timeseries, /v1/doctor all 200', async () => {
    for (const path of ['/v1/limits', '/v1/timeseries', '/v1/doctor']) {
      const res = await raw(path);
      expect(res.status).toBe(200);
    }
  });

  it('a route outside the fixed table is an authenticated 404, including a read-job path nothing serves', async () => {
    for (const path of ['/v1/not-a-route', '/v1/not-a-route/read?range=today']) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
      expect((res.body as { error: string }).error, path).toBe('not_found');
    }
  });

  it('GET /v1/coverage and /v1/doctor preserve unavailable, explicit zero and positive Claude hold states', async () => {
    const priorDoctor = doctorIncompleteCapture, priorCoverage = coverageIncompleteCapture;
    const zero: NonNullable<DoctorReport['incompleteCapture']> = [
      { collector: 'claude', heldFiles: 0, oldestHeldAt: null, maxLineBytes: null },
    ];
    const positive: NonNullable<DoctorReport['incompleteCapture']> = [
      { collector: 'claude', heldFiles: 2, oldestHeldAt: 1234, maxLineBytes: 4096, storedComponentEvidenceHeldFiles: 1 },
    ];
    try {
      const variants: Array<DoctorReport['incompleteCapture']> = [undefined, zero, positive];
      for (const holds of variants) {
        doctorIncompleteCapture = holds;
        coverageIncompleteCapture = holds;
        const [doctor, coverage] = await Promise.all([raw('/v1/doctor'), raw('/v1/coverage')]);
        expect(doctor.status).toBe(200);
        expect(coverage.status).toBe(200);
        if (holds === undefined) {
          expect(doctor.body).not.toHaveProperty('incompleteCapture');
          expect(coverage.body).not.toHaveProperty('incompleteCapture');
        } else {
          expect((doctor.body as DoctorReport).incompleteCapture).toEqual(holds);
          expect((coverage.body as CoverageResponse).incompleteCapture).toEqual(holds);
        }
      }
    } finally {
      doctorIncompleteCapture = priorDoctor;
      coverageIncompleteCapture = priorCoverage;
    }
  });

  it('GET /v1/timeseries?bucket=week is a 400 (only hour|day allowed)', async () => {
    const res = await raw('/v1/timeseries?bucket=week');
    expect(res.status).toBe(400);
  });

  it('unknown path is 404', async () => {
    const res = await raw('/v1/nope');
    expect(res.status).toBe(404);
  });

  it('an error thrown by Queries becomes a 500 JSON error (no crash, no stack/message leak), and the server keeps serving', async () => {
    sessionsThrows = new Error('secret internal detail /Users/x/path');
    const res = await raw('/v1/sessions');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error' });
    sessionsThrows = null;
    const after = await raw('/v1/sessions');
    expect(after.status).toBe(200);
  });

  it('every response sets Cache-Control: no-store', async () => {
    const res = await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${TOKEN}`, host: `127.0.0.1:${PORT}` } });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('createHttpServer: GET /v1/sessions/detail', () => {
  beforeAll(() => {
    sessionDetailCalls = [];
    sessionDetailReturns = 'default';
  });

  it('forwards source/sessionId to Queries and returns its SessionDetail', async () => {
    sessionDetailCalls = [];
    const res = await raw('/v1/sessions/detail?source=claude&sessionId=abc-123');
    expect(res.status).toBe(200);
    expect(sessionDetailCalls).toEqual([{ source: 'claude', sessionId: 'abc-123' }]);
    expect((res.body as SessionDetail).sessionId).toBe('abc-123');
    expect((res.body as SessionDetail).source).toBe('claude');
  });

  it('opens drill-downs for every supported collector, including Qwen Code', async () => {
    for (const source of ['claude', 'codex', 'ollama-proxy', 'ollama-log', 'qwen-code', 'bench']) {
      const res = await raw(`/v1/sessions/detail?source=${source}&sessionId=collector-session`);
      expect(res.status).toBe(200);
      expect((res.body as SessionDetail).source).toBe(source);
    }
  });

  it('400s a missing source', async () => {
    const res = await raw('/v1/sessions/detail?sessionId=abc-123');
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('bad_request');
  });

  it('400s an invalid source (not in the Source union)', async () => {
    const res = await raw('/v1/sessions/detail?source=gemini&sessionId=abc-123');
    expect(res.status).toBe(400);
  });

  it('400s a missing sessionId', async () => {
    const res = await raw('/v1/sessions/detail?source=claude');
    expect(res.status).toBe(400);
  });

  it('400s an empty sessionId', async () => {
    const res = await raw('/v1/sessions/detail?source=claude&sessionId=');
    expect(res.status).toBe(400);
  });

  it('400s a sessionId longer than 512 characters (mutation check: not merely "reasonably long")', async () => {
    const res = await raw(`/v1/sessions/detail?source=claude&sessionId=${'a'.repeat(513)}`);
    expect(res.status).toBe(400);
    const ok = await raw(`/v1/sessions/detail?source=claude&sessionId=${'a'.repeat(512)}`);
    expect(ok.status).toBe(200); // exactly at the boundary is still accepted
  });

  it('404s when Queries.getSessionDetail resolves null (no such session)', async () => {
    sessionDetailReturns = null;
    const res = await raw('/v1/sessions/detail?source=claude&sessionId=nope');
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe('not_found');
    sessionDetailReturns = 'default';
  });

  it('still enforces auth/Host/Origin like every other route', async () => {
    expect((await raw('/v1/sessions/detail?source=claude&sessionId=x', { token: null })).status).toBe(401);
    expect((await rawWithHost('/v1/sessions/detail?source=claude&sessionId=x', 'evil.example.com:80')).status).toBe(403);
  });

  it('refuses new report reads after shutdown admission stops while health remains available', async () => {
    const callsBefore = getSummaryCalls.length;
    stopHttpReadAdmission(server);
    const summary = await raw('/v1/summary');
    expect(summary.status).toBe(503);
    expect((summary.body as { error: string }).error).toBe('read_unavailable');
    expect(getSummaryCalls).toHaveLength(callsBefore);
    const admission = await raw('/v1/summary/read?range=all', { method: 'POST' });
    expect(admission.status).toBe(503);
    expect((await raw('/v1/health')).status).toBe(200);
  });
});
