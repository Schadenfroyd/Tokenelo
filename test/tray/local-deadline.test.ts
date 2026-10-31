/**
 * src/tray/api-client.ts — the local request deadline. Synthetic fetch stubs only (no network, no daemon), on fake timers, so a
 * request that never settles costs no wall time. Each stalled stub below hangs forever under the client without a deadline, so its
 * outcome would stay pending and the test would fail.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  DaemonTimeoutError,
  LOCAL_REQUEST_TIMEOUT_MS,
  LOCAL_TIMEOUT_MARKER,
  createApiClient,
} from '../../src/tray/api-client.js';

const BASE = 'http://127.0.0.1:47821';
const TOKEN = 'deadline-test-token';
const SUMMARY = { host: 'M4a', range: 'today' };

interface Requested {
  path: string;
  authorization?: string;
  signal?: AbortSignal;
}

/** A fetch stub that records each request, then answers with `respond`. */
function recording(requests: Requested[], respond: (url: URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return ((input: string, init?: RequestInit) => {
    const url = new URL(input);
    requests.push({
      path: url.pathname,
      authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      signal: init?.signal ?? undefined,
    });
    return respond(url, init);
  }) as typeof fetch;
}

function helloProof(url: URL): Response {
  const nonce = url.searchParams.get('nonce') ?? '';
  return new Response(JSON.stringify({ proof: crypto.createHmac('sha256', TOKEN).update(nonce).digest('hex') }), { status: 200 });
}

/** Never settles, and ignores any abort signal. */
const never = (): Promise<Response> => new Promise<Response>(() => undefined);

/** Headers arrive (200), then the body never ends; the stream is not tied to the abort signal. */
const stalledBody = (): Response => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });

function track<T>(promise: Promise<T>) {
  const outcome: { state: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { state: 'pending' };
  promise.then(
    (value) => Object.assign(outcome, { state: 'resolved', value }),
    (error: unknown) => Object.assign(outcome, { state: 'rejected', error })
  );
  return outcome;
}

let tmp: string;
let tokenFile: string;

beforeEach(() => {
  vi.useFakeTimers();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-deadline-'));
  tokenFile = path.join(tmp, 'api-token');
  fs.writeFileSync(tokenFile, `${TOKEN}\n`);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a stalled local request ends at its deadline', () => {
  it('a /v1/hello that never answers (and ignores abort) fails at the deadline, and the bearer token is never sent', async () => {
    const requests: Requested[] = [];
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl: recording(requests, never) });

    const outcome = track(client.getSummary('today'));
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS - 1);
    expect(outcome.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(DaemonTimeoutError);
    expect((outcome.error as DaemonTimeoutError).route).toBe('/v1/hello');
    expect((outcome.error as Error).message.startsWith(`${LOCAL_TIMEOUT_MARKER} `)).toBe(true);
    expect((outcome.error as Error).message).not.toContain('nonce'); // the route is named without its query
    expect(requests.map((r) => r.path)).toEqual(['/v1/hello']);
    expect(requests[0].authorization).toBeUndefined();
  });

  it('a read whose headers arrive but whose body never ends fails at the deadline (the body parse is inside it)', async () => {
    const requests: Requested[] = [];
    const fetchImpl = recording(requests, async (url) => (url.pathname === '/v1/hello' ? helloProof(url) : stalledBody()));
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl });

    const outcome = track(client.getCoverage());
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS);

    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(DaemonTimeoutError);
    expect((outcome.error as DaemonTimeoutError).route).toBe('/v1/coverage');
    // The headers had arrived, so this is the deadline covering the body, not the fetch.
    expect(requests.find((r) => r.path === '/v1/coverage')?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('a read that never answers and ignores abort still fails at the deadline; the query is not in the error', async () => {
    const requests: Requested[] = [];
    const fetchImpl = recording(requests, async (url) => (url.pathname === '/v1/hello' ? helloProof(url) : never()));
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl });

    const outcome = track(client.getSessionDetail('claude', 'session-with-private-id'));
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS);

    expect(outcome.state).toBe('rejected');
    expect((outcome.error as DaemonTimeoutError).route).toBe('/v1/sessions/detail');
    expect((outcome.error as Error).message).not.toContain('session-with-private-id');
  });

  it('a fetch that honours abort is aborted at the deadline, and the caller sees the timeout, not the abort', async () => {
    const requests: Requested[] = [];
    const fetchImpl = recording(requests, (url, init) => {
      if (url.pathname === '/v1/hello') return Promise.resolve(helloProof(url));
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    });
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl });

    const outcome = track(client.getDoctor());
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS);

    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(DaemonTimeoutError);
    expect(requests.find((r) => r.path === '/v1/doctor')?.signal?.aborted).toBe(true);
  });

  it('a stalled local summary becomes a timed-out Fleet host at the original deadline, never an online or zero-total host', async () => {
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'config.json'), JSON.stringify({ hostLabel: 'A2000' }));
    const fetchImpl = recording([], async (url) => (url.pathname === '/v1/hello' ? helloProof(url) : stalledBody()));
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl, env: { TOKENELO_HOME: tmp } });

    const pending = client.getFleetOverview('7d');
    const outcome = track(pending);
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS - 1);
    expect(outcome.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.state).toBe('resolved');
    expect((await pending).hosts).toEqual([{ label: 'A2000', kind: 'local', status: 'report-timeout' }]);
  });
});

describe('identity after a timeout', () => {
  it('a challenge that proves itself only after its deadline does not verify identity: no automatic retry, and the next call re-challenges before the token', async () => {
    const requests: Requested[] = [];
    let answerLateHello: (() => void) | undefined;
    let hellos = 0;
    const fetchImpl = recording(requests, (url) => {
      if (url.pathname === '/v1/hello') {
        hellos += 1;
        if (hellos === 1) return new Promise<Response>((resolve) => { answerLateHello = () => resolve(helloProof(url)); });
        return Promise.resolve(helloProof(url));
      }
      return Promise.resolve(new Response(JSON.stringify(SUMMARY), { status: 200 }));
    });
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl });

    const first = track(client.getSummary('today'));
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS);
    expect(first.error).toBeInstanceOf(DaemonTimeoutError);

    // The abandoned challenge now answers with a valid proof. Nothing follows from it: no request, no token.
    answerLateHello?.();
    await vi.advanceTimersByTimeAsync(LOCAL_REQUEST_TIMEOUT_MS);
    expect(requests.map((r) => r.path)).toEqual(['/v1/hello']);

    // The user's Try again: identity is challenged again before the token is sent.
    expect(await client.getSummary('today')).toEqual(SUMMARY);
    const retry = requests.slice(1);
    expect(retry.map((r) => r.path)).toEqual(['/v1/hello', '/v1/summary']);
    expect(retry[0].authorization).toBeUndefined();
    expect(retry[1].authorization).toBe(`Bearer ${TOKEN}`);
    // A completed request leaves no deadline timer behind to abort anything later.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('other failures keep their messages', () => {
  it('an HTTP error is still the ApiError it was, with no timeout marker', async () => {
    const fetchImpl = recording([], async (url) => (url.pathname === '/v1/hello' ? helloProof(url) : new Response('busy', { status: 503 })));
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl });
    const err = await client.getSummary('today').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as Error).message).toBe('GET /v1/summary?range=today → HTTP 503');
  });

  it('a refused identity challenge is still wrapped as before', async () => {
    const fetchImpl = recording([], async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = createApiClient({ baseUrl: BASE, tokenFile, fetchImpl });
    await expect(client.getSummary('today')).rejects.toThrow('daemon identity challenge failed: GET /v1/hello — ECONNREFUSED');
  });

  it('a missing token file still fails before any request', async () => {
    const requests: Requested[] = [];
    const client = createApiClient({ baseUrl: BASE, tokenFile: path.join(tmp, 'missing'), fetchImpl: recording(requests, never) });
    await expect(client.getSummary('today')).rejects.toThrow(/daemon API token not found/);
    expect(requests).toEqual([]);
  });
});
