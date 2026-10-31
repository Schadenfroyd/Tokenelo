/**
 * Snapshot data source (src/tray/snapshot-data.ts), exercised without Electron or a daemon. Each expected value is written here.
 */
import crypto from 'node:crypto';
import util from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiError,
  ApiTokenFileError,
  createApiClient,
  DaemonIdentityError,
  DaemonTimeoutError,
  LOCAL_TIMEOUT_MARKER,
  SummaryReadRetiredError,
  type ApiClient,
} from '../../src/tray/api-client.js';
import { parseArgv } from '../../src/tray/argv.js';
import {
  describeReadFailure,
  failurePhaseOf,
  READ_METHODS,
  readFailureLine,
  recordReads,
  resolveSnapshotData,
  snapshotReceipt,
  SNAPSHOT_TIMEOUT_MS,
  SnapshotTimeout,
  runBounded,
  safeErrorName,
  safeReadError,
  settleThenRender,
  whenReadsSettle,
  withDeadline,
} from '../../src/tray/snapshot-data.js';

const DEFAULT_FIXTURES = '/repo/test/fixtures/api';
const PORT = 47821;

describe('snapshot operation policy', () => {
  it('bounds every snapshot by one fixed whole-snapshot policy, including the wait for Electron', () => {
    expect(SNAPSHOT_TIMEOUT_MS).toBe(60_000);
  });
});

describe('argv: --data', () => {
  it('defaults to fixtures, and accepts live and fixtures explicitly', () => {
    expect(parseArgv(['--snapshot', 'a.png']).data).toBe('fixtures');
    expect(parseArgv(['--snapshot', 'a.png', '--data', 'live']).data).toBe('live');
    expect(parseArgv(['--snapshot', 'a.png', '--data', 'fixtures']).data).toBe('fixtures');
  });

  it('an unknown or missing value is an error, never a silent default', () => {
    expect(parseArgv(['--snapshot', 'a.png', '--data', 'LIVE']).dataError).not.toBeNull();
    expect(parseArgv(['--snapshot', 'a.png', '--data']).dataError).not.toBeNull();
    const later = parseArgv(['--snapshot', 'a.png', '--data', 'bogus', '--data', 'live']);
    expect(later.data).toBe('live');
    expect(later.dataError).toBeNull();
  });
});

describe('resolveSnapshotData: the source is explicit, and conflicts are refused', () => {
  it('no flag and no inherited mock: fixtures from the default directory, labelled as fixtures', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', 'a.png']), {}, DEFAULT_FIXTURES);
    expect(choice).toEqual({ ok: true, data: { mode: 'fixtures', mockDir: DEFAULT_FIXTURES } });
  });

  it('fixtures honour an inherited TOKENELO_MOCK, as before, and stay fixtures', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', 'a.png']), { TOKENELO_MOCK: '/other/fixtures' }, DEFAULT_FIXTURES);
    expect(choice).toEqual({ ok: true, data: { mode: 'fixtures', mockDir: '/other/fixtures' } });
  });

  it('live with no mock in the environment selects the live client (no mock directory)', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', 'a.png', '--data', 'live']), {}, DEFAULT_FIXTURES);
    expect(choice).toEqual({ ok: true, data: { mode: 'live' } });
  });

  it('an empty TOKENELO_MOCK is not a mock, so live still selects the live client', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', 'a.png', '--data', 'live']), { TOKENELO_MOCK: '' }, DEFAULT_FIXTURES);
    expect(choice).toEqual({ ok: true, data: { mode: 'live' } });
  });

  it('live with an inherited TOKENELO_MOCK is refused: it never silently uses the mock', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', 'a.png', '--data', 'live']), { TOKENELO_MOCK: '/inherited' }, DEFAULT_FIXTURES);
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.message).toMatch(/TOKENELO_MOCK/);
  });

  it('a bad --data value is refused, with no fallback source', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', 'a.png', '--data', 'nope']), {}, DEFAULT_FIXTURES);
    expect(choice.ok).toBe(false);
  });
});

describe('failure categories: actionable, and never carrying the raw error', () => {
  it('a daemon identity failure is named as one, without the secret in the message', () => {
    const text = describeReadFailure(new DaemonIdentityError('could not prove it holds sekret-token'), PORT);
    expect(text).toMatch(/did not prove/);
    expect(text).not.toMatch(/sekret-token/);
  });

  it('an HTTP status is reported as a status, without the response text', () => {
    const text = describeReadFailure(new ApiError('GET /v1/summary → HTTP 503 with prompt: write my essay', 503), PORT);
    expect(text).toBe('the local API answered HTTP 503 for a read');
  });

  it('a local timeout is a missed deadline, never a missing token, and repeats no route or duration', () => {
    const text = describeReadFailure(new DaemonTimeoutError('/v1/summary', 20000), PORT);
    expect(text).toBe('a local API read did not complete within its deadline');
  });

  it('an ordinary error that mentions Tokenelo or a token is not declared a missing token file', () => {
    expect(describeReadFailure(new Error('tokenelo token refresh went wrong'), PORT)).toBe('a read failed (Error)');
    expect(describeReadFailure(new ApiError('token budget exceeded'), PORT)).toBe('a read failed (unknown error)');
    // The timeout marker alone is text, not a timeout: only the typed error is reported as one.
    expect(describeReadFailure(new Error(`${LOCAL_TIMEOUT_MARKER} GET /v1/summary`), PORT)).toBe('a read failed (Error)');
  });

  it('an unreachable endpoint tells the operator the configured loopback address, and what to do', () => {
    const text = describeReadFailure(new TypeError('fetch failed'), PORT);
    expect(text).toBe('the local API is not reachable at 127.0.0.1:47821; start the daemon, then retry');
  });

  it('any other failure reports only the error class', () => {
    const text = describeReadFailure(new Error('boom with secret-abc'), PORT);
    expect(text).toBe('a read failed (Error)');
    expect(text).not.toMatch(/secret-abc/);
  });
});

describe('the read recorder', () => {
  function fakeClient(overrides: Partial<Record<'getSummary' | 'getSessions', () => Promise<unknown>>>): ApiClient {
    return {
      getSummary: overrides.getSummary ?? (async () => ({ ok: true })),
      getSessions: overrides.getSessions ?? (async () => ({ sessions: [] })),
    } as unknown as ApiClient;
  }

  it('counts successful reads; a failing read reaches the caller as the fixed boundary error, not the raw error', async () => {
    const { client, record } = recordReads(
      fakeClient({ getSessions: async () => Promise.reject(new ApiError('x', 503)) }),
      PORT
    );
    await expect(client.getSummary('today')).resolves.toEqual({ ok: true });
    const thrown = await client.getSessions('today').catch((err: unknown) => err);
    expect(thrown).not.toBeInstanceOf(ApiError);
    expect((thrown as Error).name).toBe('SnapshotReadError');
    expect((thrown as Error).message).toBe('the local API answered HTTP 503 for a read');
    expect(record).toEqual({
      reads: 1,
      started: 2,
      pending: 0,
      failure: 'the local API answered HTTP 503 for a read',
      failureMethod: 'getSessions',
      failurePhase: 'other', // an HTTP status alone does not say whether the challenge or the read answered it
    });
  });

  it('keeps the first failure, not the last', async () => {
    const { client, record } = recordReads(
      fakeClient({
        getSummary: async () => Promise.reject(new ApiError('x', 500)),
        getSessions: async () => Promise.reject(new ApiError('y', 404)),
      }),
      PORT
    );
    await expect(client.getSummary('today')).rejects.toThrow();
    await expect(client.getSessions('today')).rejects.toThrow();
    expect(record.failure).toBe('the local API answered HTTP 500 for a read');
  });

  it('records a typed report cancellation without implying worker exit', async () => {
    const { client, record } = recordReads({ ...fakeClient({}),
      getSummaryReport: async () => { throw new SummaryReadRetiredError(); },
    }, PORT);
    const retired = await client.getSummaryReport('all').catch((err: unknown) => err);
    expect(retired).toBeInstanceOf(SummaryReadRetiredError);
    expect((retired as Error).stack).toBeUndefined();
    await expect(client.getSummary('7d')).resolves.toEqual({ ok: true });
    expect(record).toEqual({ reads: 1, started: 2, pending: 0, retired: 1,
      failure: null, failureMethod: null, failurePhase: null });
    expect(snapshotReceipt({ mode: 'live' }, record.reads, PORT, record.retired)).toBe(
      'tray snapshot: data mode live (authenticated local API at 127.0.0.1:47821; 1 reads ok; 1 report read cancelled (worker retirement not reported))');
  });

  it('does not mask generic aborts, matching text or a typed retirement from another method', async () => {
    for (const failure of [new DOMException('cancelled', 'AbortError'),
      new Error('[tokenelo:summary-cancelled] Historical usage report cancelled.'), new DaemonTimeoutError('/v1/summary/read', 50000)]) {
      const { client, record } = recordReads({ ...fakeClient({}), getSummaryReport: async () => { throw failure; } }, PORT);
      await expect(client.getSummaryReport('all')).rejects.toHaveProperty('name', 'SnapshotReadError');
      expect(record.failure).not.toBeNull();
      expect(record.retired).toBeUndefined();
    }
    const { client, record } = recordReads(fakeClient({ getSummary: async () => { throw new SummaryReadRetiredError(); } }), PORT);
    await expect(client.getSummary('7d')).rejects.toHaveProperty('name', 'SnapshotReadError');
    expect(record.failureMethod).toBe('getSummary');
    expect(record.retired).toBeUndefined();
  });

  it('keeps a genuine earlier failure when a later historical report is intentionally retired', async () => {
    const { client, record } = recordReads({ ...fakeClient({ getSummary: async () => { throw new ApiError('private', 503); } }),
      getSummaryReport: async () => { throw new SummaryReadRetiredError(); },
    }, PORT);
    await expect(client.getSummary('30d')).rejects.toThrow();
    await expect(client.getSummaryReport('all')).rejects.toBeInstanceOf(SummaryReadRetiredError);
    expect(record.failure).toBe('the local API answered HTTP 503 for a read');
    expect(record.failureMethod).toBe('getSummary');
    expect(record.retired).toBe(1);
    expect(record.reads).toBe(0);
  });
});

describe('a live read goes only to the configured endpoint, as authenticated GETs', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('the real client, with an injected fetch, sends only the identity challenge and the read, to 127.0.0.1', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-snapshot-data-'));
    const tokenFile = path.join(dir, 'api-token');
    const token = 'test-token-value';
    fs.writeFileSync(tokenFile, token);
    const calls: Array<{ url: string; method: string; auth: string | null }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const headers = new Headers(init?.headers);
      calls.push({ url: `${u.origin}${u.pathname}`, method: init?.method ?? 'GET', auth: headers.get('Authorization') });
      if (u.pathname === '/v1/hello') {
        const nonce = u.searchParams.get('nonce') ?? '';
        const proof = crypto.createHmac('sha256', token).update(nonce).digest('hex');
        return new Response(JSON.stringify({ proof }), { status: 200 });
      }
      return new Response(JSON.stringify({ host: 'M4a', range: 'today', generatedAt: 1, totals: {} }), { status: 200 });
    }) as typeof fetch;
    const client = createApiClient({ fetchImpl, tokenFile, env: {} });
    await client.getSummary('today');

    expect(calls.map((c) => c.url)).toEqual([`http://127.0.0.1:${PORT}/v1/hello`, `http://127.0.0.1:${PORT}/v1/summary`]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls[0]!.auth).toBeNull(); // the challenge is sent before the token
    expect(calls[1]!.auth).toBe(`Bearer ${token}`);
  });
});

describe('failure categories from the real client: token file and local deadline', () => {
  const TOKEN = 'test-token-value';
  const SECRET = 'sk-PRIVATE-session-42';
  const TIMEOUT = 'a local API read did not complete within its deadline';
  const NO_TOKEN = 'no readable API token file: it is missing or could not be read';
  let dir: string | null = null;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function tempDir(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-snapshot-failure-'));
    return dir;
  }

  /** Answers the identity challenge correctly; every other request never settles. Records each URL it is given. */
  function challengeThenHang(calls: string[]): typeof fetch {
    return (async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname === '/v1/hello') {
        const proof = crypto.createHmac('sha256', TOKEN).update(u.searchParams.get('nonce') ?? '').digest('hex');
        return new Response(JSON.stringify({ proof }), { status: 200 });
      }
      return new Promise<Response>(() => {});
    }) as typeof fetch;
  }

  /** Runs one wrapped read and returns what the recorder saw and what Electron's handler log would print. */
  async function failOnce(client: ApiClient, read: (c: ApiClient) => Promise<unknown>) {
    const { client: wrapped, record } = recordReads(client, PORT);
    const thrown = await read(wrapped).catch((err: unknown) => err);
    return { thrown: thrown as Error, record, logged: util.format("Error occurred in handler for 'tokenelo:read':", thrown) };
  }

  it('a missing token file is typed, sends no request, and is reported without its path', async () => {
    const base = tempDir();
    const calls: string[] = [];
    const tokenFile = path.join(base, 'api-token');
    const client = createApiClient({ fetchImpl: challengeThenHang(calls), tokenFile, env: {} });
    const raw = await client.getSummary('today').catch((err: unknown) => err);
    expect(raw).toBeInstanceOf(ApiTokenFileError);
    expect(raw).toBeInstanceOf(ApiError);
    expect((raw as Error).name).toBe('ApiError'); // the IPC string the normal tray sees is unchanged

    const { thrown, record, logged } = await failOnce(client, (c) => c.getSummary('today'));
    expect(thrown.message).toBe(NO_TOKEN);
    expect(record).toEqual({ reads: 0, started: 1, pending: 0, failure: NO_TOKEN, failureMethod: 'getSummary', failurePhase: 'token-file' });
    expect(logged).not.toContain(base);
    expect(calls).toEqual([]);
  });

  it('a token path that exists but cannot be read is typed the same way, and sends no request', async () => {
    const base = tempDir();
    const calls: string[] = [];
    // A directory exists but cannot be read as a file, on every platform.
    const client = createApiClient({ fetchImpl: challengeThenHang(calls), tokenFile: base, env: {} });
    await expect(client.getSummary('today')).rejects.toBeInstanceOf(ApiTokenFileError);
    const { thrown, record, logged } = await failOnce(client, (c) => c.getSummary('today'));
    expect(thrown.message).toBe(NO_TOKEN);
    expect(record.failure).toBe(NO_TOKEN);
    expect(logged).not.toContain(base);
    expect(calls).toEqual([]);
  });

  it('an identity challenge that never answers is a missed deadline, not a missing token', async () => {
    const base = tempDir();
    const tokenFile = path.join(base, 'api-token');
    fs.writeFileSync(tokenFile, TOKEN);
    const fetchImpl = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const client = createApiClient({ fetchImpl, tokenFile, env: {}, localTimeoutMs: 20 });
    await expect(client.getSummary('today')).rejects.toBeInstanceOf(DaemonTimeoutError);

    const { thrown, record, logged } = await failOnce(client, (c) => c.getSummary('today'));
    expect(thrown.message).toBe(TIMEOUT);
    expect(thrown.name).toBe('SnapshotReadError');
    expect(record).toEqual({ reads: 0, started: 1, pending: 0, failure: TIMEOUT, failureMethod: 'getSummary', failurePhase: 'identity-challenge' });
    for (const text of [thrown.message, logged]) {
      expect(text).not.toMatch(/token file|tokenelo:local-timeout|\/v1\/|20ms/);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(base);
    }
  }, 2000);

  it('a read that never answers after a good challenge is a missed deadline, and its secret query is not echoed', async () => {
    const base = tempDir();
    const tokenFile = path.join(base, 'api-token');
    fs.writeFileSync(tokenFile, TOKEN);
    const calls: string[] = [];
    const client = createApiClient({ fetchImpl: challengeThenHang(calls), tokenFile, env: {}, localTimeoutMs: 20 });

    const { thrown, record, logged } = await failOnce(client, (c) => c.getSessionDetail('codex' as never, SECRET));
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/v1/hello', '/v1/sessions/detail']);
    expect(calls[1]).toContain(SECRET); // control: the secret was in the request the deadline cut off
    expect(thrown.message).toBe(TIMEOUT);
    expect(record).toEqual({ reads: 0, started: 1, pending: 0, failure: TIMEOUT, failureMethod: 'getSessionDetail', failurePhase: 'local-read' });
    for (const text of [thrown.message, logged, readFailureLine(record)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(base);
    }
  }, 2000);

  it('the same optional Doctor read is told apart by phase: a hung challenge versus a hung read after a good challenge', async () => {
    const base = tempDir();
    const tokenFile = path.join(base, 'api-token');
    fs.writeFileSync(tokenFile, TOKEN);
    const hangAll = (async () => new Promise<Response>(() => {})) as typeof fetch;

    const challenge = await failOnce(createApiClient({ fetchImpl: hangAll, tokenFile, env: {}, localTimeoutMs: 20 }), (c) => c.getDoctor());
    const calls: string[] = [];
    const read = await failOnce(
      createApiClient({ fetchImpl: challengeThenHang(calls), tokenFile, env: {}, localTimeoutMs: 20 }),
      (c) => c.getDoctor()
    );
    expect(calls.map((u) => new URL(u).pathname)).toEqual(['/v1/hello', '/v1/doctor']); // control: the challenge passed, the read hung

    // Both are the same category, and both are failures: an optional read is not accepted because it is optional.
    expect(challenge.record).toEqual({ reads: 0, started: 1, pending: 0, failure: TIMEOUT, failureMethod: 'getDoctor', failurePhase: 'identity-challenge' });
    expect(read.record).toEqual({ reads: 0, started: 1, pending: 0, failure: TIMEOUT, failureMethod: 'getDoctor', failurePhase: 'local-read' });
    expect(readFailureLine(challenge.record)).toBe(
      `tray snapshot failed: ${TIMEOUT} (first failed read: getDoctor, during the identity challenge). No image was written.`
    );
    expect(readFailureLine(read.record)).toBe(
      `tray snapshot failed: ${TIMEOUT} (first failed read: getDoctor, during the local read). No image was written.`
    );
    // The error that crosses IPC to the renderer is unchanged: the category alone.
    expect(challenge.thrown.message).toBe(TIMEOUT);
    expect(read.thrown.message).toBe(TIMEOUT);
  }, 2000);

  it('a run stopped by its deadline keeps the deadline line and adds the optional Doctor read that had already failed', async () => {
    const base = tempDir();
    const tokenFile = path.join(base, 'api-token');
    fs.writeFileSync(tokenFile, TOKEN);
    const hangAll = (async () => new Promise<Response>(() => {})) as typeof fetch;
    let record: ReturnType<typeof recordReads>['record'] | null = null;
    const reports: Array<[number, string]> = [];
    await runBounded(
      async () => {
        const recorded = recordReads(createApiClient({ fetchImpl: hangAll, tokenFile, env: {}, localTimeoutMs: 20 }), PORT);
        record = recorded.record;
        void recorded.client.getDoctor().catch(() => undefined); // the boot Doctor read hits its own 20 ms deadline
        await new Promise<void>(() => {}); // the rest of the body never settles
      },
      200,
      (code, line) => reports.push([code, line]),
      () => record
    );
    expect(record).toMatchObject({ failure: TIMEOUT, failureMethod: 'getDoctor', failurePhase: 'identity-challenge' }); // control
    expect(reports).toEqual([
      [
        1,
        `tray snapshot failed: snapshot did not finish within 0.2 s; a read had already failed: ${TIMEOUT} (first failed read: getDoctor, during the identity challenge). No image was written.`,
      ],
    ]);
    expect(reports[0]![1]).not.toMatch(/\/v1\/|20ms|nonce/);
    expect(reports[0]![1]).not.toContain(TOKEN);
    expect(reports[0]![1]).not.toContain(base);
  }, 2000);

  it('concurrent reads: the first to fail supplies category, method and phase together, whatever the start order', async () => {
    const base = tempDir();
    const tokenFile = path.join(base, 'api-token');
    fs.writeFileSync(tokenFile, TOKEN);
    /** Answers the challenge; `hung` never answers; every other read answers HTTP 503 at once. */
    const fetchWith = (hung: string) =>
      (async (url: string) => {
        const u = new URL(url);
        if (u.pathname === '/v1/hello') {
          const proof = crypto.createHmac('sha256', TOKEN).update(u.searchParams.get('nonce') ?? '').digest('hex');
          return new Response(JSON.stringify({ proof }), { status: 200 });
        }
        if (u.pathname === hung) return new Promise<Response>(() => {});
        return new Response('private body', { status: 503 });
      }) as typeof fetch;
    const HTTP_503 = 'the local API answered HTTP 503 for a read';

    for (const [hung, firstMethod] of [['/v1/summary', 'getDoctor'], ['/v1/doctor', 'getSummary']] as const) {
      const { client, record } = recordReads(createApiClient({ fetchImpl: fetchWith(hung), tokenFile, env: {}, localTimeoutMs: 50 }), PORT);
      // getSummary always starts first; the one whose route answers 503 fails first, and the hung one times out later.
      const both = Promise.allSettled([client.getSummary('today'), client.getDoctor()]);
      expect(record.pending).toBe(2);
      await both;
      expect(record).toEqual({ reads: 0, started: 2, pending: 0, failure: HTTP_503, failureMethod: firstMethod, failurePhase: 'other' });
    }
  }, 2000);
});

describe('the failure method and phase are fixed identifiers only', () => {
  const SECRET = 'sk-PRIVATE-session-42';
  const TOKEN = 'test-token-value';
  const TIMEOUT = 'a local API read did not complete within its deadline';

  it('every ApiClient method is a known identifier, and nothing else is', () => {
    expect(Object.keys(createApiClient({ mockDir: '/unused-fixtures' })).sort()).toEqual([...READ_METHODS].sort());
  });

  it('a sessions envelope failure keeps its fixed method and local-read phase', async () => {
    const source = { getSessionsResponse: async () => { throw new DaemonTimeoutError('/v1/sessions', 20); } } as unknown as ApiClient;
    const { client, record } = recordReads(source, PORT);
    await expect(client.getSessionsResponse('today')).rejects.toMatchObject({ name: 'SnapshotReadError', message: TIMEOUT });
    expect(record).toEqual({ reads: 0, started: 1, pending: 0, failure: TIMEOUT, failureMethod: 'getSessionsResponse', failurePhase: 'local-read' });
    expect(readFailureLine(record)).toBe(`tray snapshot failed: ${TIMEOUT} (first failed read: getSessionsResponse, during the local read). No image was written.`);
  });

  it('the phase is decided by type and an exact route, never by a route that merely resembles one, or by message text', () => {
    expect(failurePhaseOf(new DaemonTimeoutError('/v1/hello', 20))).toBe('identity-challenge');
    expect(failurePhaseOf(new DaemonTimeoutError('/v1/doctor', 20))).toBe('local-read');
    expect(failurePhaseOf(new DaemonTimeoutError('/v1/sessions/detail', 20))).toBe('local-read');
    for (const route of ['/v1/hello?nonce=abc', '/V1/HELLO', '/v1/hello/', '/v1/doctor?x=1', '/v1/fleet/hello', '/private/home/api-token', '']) {
      expect(failurePhaseOf(new DaemonTimeoutError(route, 20))).toBe('other');
    }
    expect(failurePhaseOf(new DaemonIdentityError('x'))).toBe('identity-challenge');
    expect(failurePhaseOf(new ApiTokenFileError('x'))).toBe('token-file');
    // Text that names the challenge is not a typed challenge failure.
    expect(failurePhaseOf(new ApiError('daemon identity challenge failed: GET /v1/hello → HTTP 503', 503))).toBe('other');
    expect(failurePhaseOf(new Error('GET /v1/hello did not complete'))).toBe('other');
  });

  it('an arbitrary method key, route, query, path or secret never reaches the record or the line', async () => {
    const key = `/private/home/${SECRET}?token=${TOKEN}`;
    const client = {
      [key]: async () => Promise.reject(new DaemonTimeoutError(`/v1/sessions/detail?sessionId=${SECRET}&token=${TOKEN}`, 20)),
    } as unknown as ApiClient;
    const { client: wrapped, record } = recordReads(client, PORT);
    const thrown = await (wrapped as unknown as Record<string, () => Promise<unknown>>)[key]!().catch((err: unknown) => err);
    expect((thrown as Error).message).toBe(TIMEOUT);
    expect(record).toEqual({ reads: 0, started: 1, pending: 0, failure: TIMEOUT, failureMethod: 'other', failurePhase: 'other' });
    const line = readFailureLine(record);
    expect(line).toBe(`tray snapshot failed: ${TIMEOUT} (first failed read: other, during an undetermined phase). No image was written.`);
    for (const text of [line, JSON.stringify(record)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/\/private|\/v1\/|20ms/);
    }
  });

  it('a record altered after the fact still prints only fixed identifiers', () => {
    for (const bad of [SECRET, 'toString', '__proto__', 'constructor', undefined]) {
      const line = readFailureLine({ failure: TIMEOUT, failureMethod: bad as never, failurePhase: bad as never });
      expect(line).toBe(`tray snapshot failed: ${TIMEOUT} (first failed read: other, during an undetermined phase). No image was written.`);
    }
  });
});

describe('the receipt states the data mode', () => {
  it('a live receipt names the authenticated loopback endpoint and the read count, and no path', () => {
    expect(snapshotReceipt({ mode: 'live' }, 9, PORT)).toBe(
      'tray snapshot: data mode live (authenticated local API at 127.0.0.1:47821; 9 reads ok)'
    );
  });

  it('a fixture receipt says it is not live data', () => {
    expect(snapshotReceipt({ mode: 'fixtures', mockDir: DEFAULT_FIXTURES }, 0, PORT)).toBe(
      'tray snapshot: data mode fixtures (canned fixture set, not live data)'
    );
  });
});

describe('the whole snapshot run is bounded', () => {
  it('work that never settles is reported as a timeout', async () => {
    await expect(withDeadline(new Promise<never>(() => {}), 20)).rejects.toBeInstanceOf(SnapshotTimeout);
  }, 2000);

  it('work that settles in time returns its value', async () => {
    await expect(withDeadline(Promise.resolve(42), 1000)).resolves.toBe(42);
  });
});

describe('the capture waits for reads that are still in flight', () => {
  it('a background read that has not settled keeps the capture waiting, and its failure is then visible', async () => {
    let release: (() => void) | null = null;
    const slow = new Promise<unknown>((_, reject) => {
      release = () => reject(new ApiError('late', 500));
    });
    const client = { getDoctor: () => slow } as unknown as ApiClient;
    const { client: wrapped, record } = recordReads(client, PORT);
    const background = wrapped.getDoctor().catch(() => undefined);
    let settled = false;
    const waiting = whenReadsSettle(record).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(settled).toBe(false);
    release!();
    await background;
    await waiting;
    expect(settled).toBe(true);
    expect(record.failure).toBe('the local API answered HTTP 500 for a read');
  });
});

describe('the capture renders only after the reads are quiet', () => {
  function slowClient(): ApiClient {
    return { getDoctor: () => new Promise((resolve) => setTimeout(() => resolve({ warnings: [] }), 30)) } as unknown as ApiClient;
  }

  it('a read that a render turn starts is waited for before the final render: two turns, and nothing pending at the end', async () => {
    const { client, record } = recordReads(slowClient(), PORT);
    let turns = 0;
    await settleThenRender(record, async () => {
      turns++;
      if (turns === 1) void client.getDoctor(); // the renderer's continuation starts a read after the first turn
    });
    expect(turns).toBe(2);
    expect(record).toEqual({ reads: 1, started: 1, pending: 0, failure: null, failureMethod: null, failurePhase: null });
  });

  it('with no reads, exactly one render turn is taken', async () => {
    let turns = 0;
    await settleThenRender(null, async () => {
      turns++;
    });
    expect(turns).toBe(1);
  });
});

describe('private names are never echoed', () => {
  const SECRET = 'sk-PRIVATE-session-42';

  it('a custom error name carrying private text is reported as unknown, by the read categories too', () => {
    const err = new Error('ignored');
    err.name = SECRET;
    expect(safeErrorName(err)).toBe('unknown error');
    const text = describeReadFailure(err, PORT);
    expect(text).toBe('a read failed (unknown error)');
    expect(text).not.toContain(SECRET);
  });

  it('a standard name is kept; a standard-named error with private message text is still contained', () => {
    const err = new TypeError('private prompt text ' + SECRET);
    expect(safeErrorName(err)).toBe('TypeError');
    expect(describeReadFailure(err, PORT)).toBe('a read failed (TypeError)');
  });

  it('the bounded run reports a private-named failure as one fixed line, with exit code 1', async () => {
    const reports: Array<[number, string]> = [];
    const err = new Error('x');
    err.name = SECRET;
    await runBounded(
      async () => {
        throw err;
      },
      1000,
      (code, line) => reports.push([code, line])
    );
    expect(reports).toEqual([[1, 'tray snapshot failed: an unexpected error (unknown error). No image was written.']]);
  });
});

describe('the bounded run contains every early failure', () => {
  it('a body that succeeds reports nothing', async () => {
    const reports: Array<[number, string]> = [];
    await runBounded(async () => {}, 1000, (code, line) => reports.push([code, line]));
    expect(reports).toEqual([]);
  });

  it('a synchronous throw before any await is contained, not raised to the caller', async () => {
    const reports: Array<[number, string]> = [];
    await expect(
      runBounded(
        () => {
          throw new TypeError('token-private');
        },
        1000,
        (code, line) => reports.push([code, line])
      )
    ).resolves.toBeUndefined();
    expect(reports).toEqual([[1, 'tray snapshot failed: an unexpected error (TypeError). No image was written.']]);
  });

  it('a run that never settles is reported as the deadline, with exit code 1', async () => {
    const reports: Array<[number, string]> = [];
    await runBounded(
      () => new Promise<void>(() => {}),
      20,
      (code, line) => reports.push([code, line])
    );
    expect(reports).toEqual([[1, 'tray snapshot failed: snapshot did not finish within 0.02 s. No image was written.']]);
  });

  it('with no record, an absent record, or a record with no failure, the deadline line is unchanged', async () => {
    const empty = { failure: null, failureMethod: null, failurePhase: null };
    for (const recorded of [() => null, () => undefined, () => empty]) {
      const reports: Array<[number, string]> = [];
      await runBounded(() => new Promise<void>(() => {}), 20, (code, line) => reports.push([code, line]), recorded);
      expect(reports).toEqual([[1, 'tray snapshot failed: snapshot did not finish within 0.02 s. No image was written.']]);
    }
  }, 2000);

  it('an unexpected stop keeps its own reason first; an altered method and phase still print only fixed identifiers', async () => {
    const SECRET = 'sk-PRIVATE-session-42';
    const TIMEOUT = 'a local API read did not complete within its deadline';
    for (const bad of [SECRET, '/v1/hello?nonce=abc', '__proto__', undefined]) {
      const reports: Array<[number, string]> = [];
      await runBounded(
        async () => {
          throw new TypeError(SECRET);
        },
        1000,
        (code, line) => reports.push([code, line]),
        () => ({ failure: TIMEOUT, failureMethod: bad as never, failurePhase: bad as never })
      );
      expect(reports).toEqual([
        [
          1,
          `tray snapshot failed: an unexpected error (TypeError); a read had already failed: ${TIMEOUT} (first failed read: other, during an undetermined phase). No image was written.`,
        ],
      ]);
    }
  });
});

describe('a failed live read crosses the IPC boundary with no raw error or stack', () => {
  // The paths below stand in for the private locations the compiled acceptance found in stderr.
  const REPO_DIST = '/private/checkout/dist/tray/main.js';
  const TOKEN_FILE = '/private/isolated-home/data/api-token';

  /** What Electron's handler logging prints for a rejected handler: console.error(message, error). */
  function electronHandlerLog(channel: string, err: unknown): string {
    return util.format(`Error occurred in handler for '${channel}':`, err);
  }

  it('a raw client error has a stack with repository paths, and the boundary error logs none of it', async () => {
    const raw = new ApiError(`GET /v1/summary → HTTP 503 ${TOKEN_FILE}`, 503);
    raw.stack = `ApiError: GET /v1/summary → HTTP 503\n    at fetchJson (${REPO_DIST}:10:3)\n    at ${TOKEN_FILE}:4:1`;
    // control: the raw error, logged the way Electron logs it, does carry the private paths
    expect(electronHandlerLog('tokenelo:getSummary', raw)).toContain(REPO_DIST);

    const { client } = recordReads({ getSummary: async () => Promise.reject(raw) } as unknown as ApiClient, PORT);
    let thrown: unknown;
    try {
      await client.getSummary('today');
    } catch (err) {
      thrown = err;
    }
    const logged = electronHandlerLog('tokenelo:getSummary', thrown);
    expect(logged).toBe("Error occurred in handler for 'tokenelo:getSummary': [Error [SnapshotReadError]: the local API answered HTTP 503 for a read]");
    expect(logged).not.toContain(REPO_DIST);
    expect(logged).not.toContain(TOKEN_FILE);
    expect(logged).not.toContain('\n    at ');
    expect((thrown as Error).message).toBe('the local API answered HTTP 503 for a read');
  });

  it('a missing-token read logs the category only, without the token path', async () => {
    const raw = new ApiTokenFileError(`daemon API token not found at ${TOKEN_FILE}`);
    raw.stack = `ApiError: daemon API token not found at ${TOKEN_FILE}\n    at readToken (${REPO_DIST}:2:1)`;
    const { client } = recordReads({ getSummary: async () => Promise.reject(raw) } as unknown as ApiClient, PORT);
    const thrown = await client.getSummary('today').catch((err: unknown) => err);
    const logged = electronHandlerLog('tokenelo:getSummary', thrown);
    expect(logged).toContain('no readable API token file');
    expect(logged).not.toContain(TOKEN_FILE);
    expect(logged).not.toContain(REPO_DIST);
  });

  it('the boundary error keeps the category as its message and has no stack', () => {
    const err = safeReadError('a read failed (TypeError)');
    expect(err.message).toBe('a read failed (TypeError)');
    expect(err.name).toBe('SnapshotReadError');
    expect(err.stack).toBeUndefined();
  });
});

describe('a snapshot request with no usable path is refused before any source is chosen', () => {
  it('a bare --snapshot is refused with exit-2 wording and no source, even when fixtures would be the default', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot']), {}, DEFAULT_FIXTURES);
    expect(choice.ok).toBe(false);
    if (!choice.ok) expect(choice.message).toMatch(/needs an output image path/);
  });

  it('a --snapshot followed by --data live is refused as a missing path, not run as live', () => {
    const choice = resolveSnapshotData(parseArgv(['--snapshot', '--data', 'live']), {}, DEFAULT_FIXTURES);
    expect(choice.ok).toBe(false);
  });
});

