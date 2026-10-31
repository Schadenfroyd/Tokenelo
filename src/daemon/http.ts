/**
 * The daemon's read-only local HTTP API (DESIGN §15.7.3): `node:http` on 127.0.0.1:<config.api.port>.
 *
 * Security model (every one of these is verified by test/daemon/http.test.ts, including a
 * mutation-test style check that the guard actually rejects when it should — not just "the happy
 * path returns 200"):
 *   - Bearer token from the token file, created on first run (see daemon/main.ts; this module just
 *     compares against whatever token string it is given).
 *   - `Host` header must be exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`
 *     (daemon/loopback.ts, shared with the Ollama proxy's own Host check) — rejects DNS-rebinding
 *     and any request that arrived via a different vhost/proxy.
 *   - Any request carrying an `Origin` header is rejected outright — this is a plain HTTP API for
 *     the CLI/tray, never a browser XHR target, so a same-origin browser tab is not a valid client
 *     and an Origin header is itself the CSRF signal.
 *   - Ledger/configuration routes remain GET-only. POST/DELETE controls exist only for temporary
 *     historical report read jobs; they cannot ingest, reprice or modify persisted data.
 * Check order is method → Host → Origin → auth → route, so a cross-site request is rejected before
 * we even look at whether it carries a valid token (an attacker who somehow captured the token
 * still cannot use it from a browser context; a same-network request without a browser still needs
 * the right Host and the token).
 *
 * ONE exception to the auth check: `GET /v1/hello?nonce=<32 hex>` (still gated by Host/Origin) is
 * unauthenticated by design — it is the identity challenge the tray uses to prove it is really
 * talking to the daemon that holds the token BEFORE sending that token (src/tray/api-client.ts) —
 * see `handleHello` below for why revealing `HMAC-SHA256(token, nonce)` is safe.
 *
 * Route handlers depend only on the `Queries` abstraction (store/queries.ts) — never on
 * `node:sqlite`, `TokeneloConfig`, or any core/* engine directly — so this module is fully
 * testable with a hand-written fake Queries and no real database.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import type { Queries } from '../store/queries.js';
import type { HostLabel, Range, Source } from '../core/types.js';
import { USAGE_SOURCES } from '../core/types.js';
import { isAllowedLoopbackHost } from './loopback.js';
import { SummaryReadJobs, SummaryJobCapacityError } from './summary-read-jobs.js';
import { ReportReadError } from './report-read-protocol.js';
import type { ReadControl } from '../core/read-control.js';
import type { BuildIdentity } from './build-identity.js';

/** `nonce` query param format required by GET /v1/hello: 32 hex chars (16 random bytes). */
const HELLO_NONCE_RE = /^[0-9a-f]{32}$/i;

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;

export interface CreateHttpServerOpts {
  port: number;
  token: string;
  queries: Queries;
  host: HostLabel;
  log?: Logger;
  /** First local-history scan only; API identity/read readiness is separate from capture evidence. */
  initialCaptureState?: () => 'pending' | 'running' | 'complete' | 'failed' | 'stopping';
  /** Build metadata loaded once from the compiled package. null means unavailable, never a guessed version. */
  buildIdentity?: BuildIdentity | null;
}

const VALID_RANGES: readonly Range[] = ['today', '24h', '7d', '30d', 'all'];

function isRange(v: string | null): v is Range {
  return v !== null && (VALID_RANGES as readonly string[]).includes(v);
}

const VALID_SOURCES: readonly Source[] = USAGE_SOURCES;

function isSource(v: string | null): v is Source {
  return v !== null && (VALID_SOURCES as readonly string[]).includes(v);
}

/** `sessionId` query params are opaque collector-assigned strings (Claude UUIDs, Codex thread
 * ids, proxy `<client>:<model>:<date>` keys, …) — no format to validate beyond "present and not
 * absurdly long" (a length cap is still worth enforcing: an unbounded query string is a cheap
 * DoS/log-noise vector for a local API with no other size limit on this param). */
const MAX_SESSION_ID_LEN = 512;

function isReasonableSessionId(v: string | null): v is string {
  return v !== null && v.length > 0 && v.length <= MAX_SESSION_ID_LEN;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Belt-and-suspenders: even though we never accept an Origin header (so no browser page can
    // read this via CORS anyway), make sure nothing downstream ever treats these responses as
    // cross-origin-shareable.
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendError(res: http.ServerResponse, status: number, error: string, message?: string): void {
  sendJson(res, status, { error, ...(message ? { message } : {}) });
}

export function createHttpServer(opts: CreateHttpServerOpts): http.Server {
  const log: Logger = opts.log ?? (() => {});
  let acceptingReportReads = true;
  const summaryJobs = opts.queries.getSummaryReport || opts.queries.getUsageReport
    ? new SummaryReadJobs<import('../core/types.js').SummaryResponse | import('../core/types.js').UsageResponse>((range, control, variant) => {
      if (variant === 'usage') {
        if (!opts.queries.getUsageReport) throw new ReportReadError('read_unavailable');
        return opts.queries.getUsageReport(range, control);
      }
      if (!opts.queries.getSummaryReport) throw new ReportReadError('read_unavailable');
      return opts.queries.getSummaryReport(range, control);
    }) : undefined;

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (res.destroyed || res.writableEnded) return;
      if (err instanceof ReportReadError) {
        const status = err.code === 'read_capacity' ? 429 : err.code === 'read_timeout' ? 504
          : err.code === 'result_too_large' ? 413 : 503;
        sendError(res, status, err.code, err.message); return;
      }
      log('error', 'unhandled error in http handler', { error: String(err) });
      if (!res.headersSent) sendError(res, 500, 'internal_error');
      else res.end();
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? '';
    const url = new URL(req.url ?? '/', 'http://internal.invalid');

    // Report controls only manipulate ephemeral read jobs, never ledger/configuration data.
    const summaryRoute = url.pathname.startsWith('/v1/summary/read');
    const usageRoute = url.pathname.startsWith('/v1/usage/read');
    const variant = usageRoute ? 'usage' : 'default';
    const jobs = summaryRoute || usageRoute ? summaryJobs : undefined;
    const admission = (url.pathname === '/v1/summary/read' || url.pathname === '/v1/usage/read') && method === 'POST';
    const release = /^\/v1\/(summary|usage)\/read\/lease\/[0-9a-f]{32}$/.test(url.pathname) && method === 'DELETE';
    if (method !== 'GET' && !admission && !release) {
      sendError(res, 405, 'method_not_allowed', `${method} is not supported on this route`);
      return;
    }

    // 2. Host — reject anything not addressed to exactly this daemon's own local endpoint.
    const hostHeader = req.headers.host ?? '';
    if (!isAllowedLoopbackHost(hostHeader, opts.port)) {
      sendError(res, 403, 'forbidden_host', `Host "${hostHeader}" is not this daemon`);
      return;
    }

    // 3. Origin — presence alone is disqualifying (DESIGN §15.7.3: "reject any request with an
    // Origin header"); this is never a browser-fetch API.
    if (req.headers.origin !== undefined) {
      sendError(res, 403, 'forbidden_origin', 'requests with an Origin header are not accepted');
      return;
    }

    // 3b. /v1/hello — the ONE unauthenticated route (Host/Origin checks above still apply). It
    // lets a client (the tray) verify it is really talking to the daemon that holds the real
    // bearer token — see src/tray/api-client.ts's identity challenge — BEFORE that client ever
    // sends the token itself. It reveals nothing an attacker can invert: HMAC-SHA256 keyed by the
    // token, over a client-supplied nonce, is a one-way proof of "I hold the token", not the token.
    if (url.pathname === '/v1/hello') {
      handleHello(url, res, opts.token);
      return;
    }

    // 4. Auth.
    const authHeader = req.headers.authorization ?? '';
    const expected = `Bearer ${opts.token}`;
    if (!timingSafeEqualStrings(authHeader, expected)) {
      sendError(res, 401, 'unauthorized');
      return;
    }

    if (!acceptingReportReads && !release && url.pathname !== '/v1/health') {
      sendError(res, 503, 'read_unavailable'); return;
    }

    if (admission) {
      if (!jobs || (summaryRoute && !opts.queries.getSummaryReport) || (usageRoute && !opts.queries.getUsageReport)) { sendError(res, 404, 'not_found'); return; }
      if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
        sendError(res, 400, 'bad_request', 'read admission has no body'); return;
      }
      const range = parseRange(url, res); if (range === undefined) return;
      if ((summaryRoute || usageRoute) && range !== 'all') { sendError(res, 400, 'bad_request', 'historical report jobs require all history'); return; }
      const lease = req.headers['x-tokenelo-read-lease'];
      if (typeof lease !== 'string' || !/^[0-9a-f]{32}$/.test(lease)) { sendError(res, 400, 'bad_request', 'invalid read lease'); return; }
      try { sendJson(res, 202, jobs.admit(range, lease, variant)); }
      catch (error) { if (error instanceof SummaryJobCapacityError) sendError(res, 429, 'read_capacity'); else throw error; }
      return;
    }
    if (release) {
      if (!jobs || (summaryRoute && !opts.queries.getSummaryReport) || (usageRoute && !opts.queries.getUsageReport)) { sendError(res, 404, 'not_found'); return; }
      // This confirms lease detachment only; the owned report worker may still be retiring.
      jobs.release(url.pathname.split('/').at(-1)!, variant); sendJson(res, 200, { released: true }); return;
    }
    const jobPath = /^\/v1\/(?:summary|usage)\/read\/([0-9a-f]{32})$/.exec(url.pathname);
    if (jobPath) {
      if (!jobs || (summaryRoute && !opts.queries.getSummaryReport) || (usageRoute && !opts.queries.getUsageReport)) { sendError(res, 404, 'not_found'); return; }
      const lease = url.searchParams.get('lease');
      if (!lease || !/^[0-9a-f]{32}$/.test(lease)) { sendError(res, 400, 'bad_request', 'invalid read lease'); return; }
      const job = jobs.poll(jobPath[1]!, lease, variant);
      if (!job) sendError(res, 404, 'not_found'); else sendJson(res, 200, job);
      return;
    }
    // 5. Route (a thrown error becomes a 500 via the createServer wrapper above).
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(new Error('read_cancelled')); };
    res.once('close', cancel);
    try {
      if (res.destroyed) { cancel(); return; }
      await route(url, opts.queries, res, { signal: controller.signal }, opts.initialCaptureState, opts.buildIdentity);
    } finally { res.off('close', cancel); }
  }

  const services = {
    stopAdmission: () => { acceptingReportReads = false; },
    close: async () => { await summaryJobs?.close(); },
  };
  readServices.set(server, services);
  server.once('close', () => { void services.close(); });
  return server;
}

const readServices = new WeakMap<http.Server, { stopAdmission(): void; close(): Promise<void> }>();
/** Refuse new report work while owned readers are being retired; lease DELETE remains a detach only. */
export function stopHttpReadAdmission(server: http.Server): void { readServices.get(server)?.stopAdmission(); }
/** Drain cancelled work before closing the ledger. Does not stop any other server. */
export async function closeHttpReads(server: http.Server): Promise<void> { await readServices.get(server)?.close(); }

/**
 * GET /v1/hello?nonce=<32 hex> — unauthenticated identity challenge (Host/Origin checks still
 * apply). Returns `{proof: HMAC-SHA256(token, nonce) hex}`. A squatter bound to the port before
 * the real daemon starts (or any other local process) cannot produce the correct proof without
 * knowing the token, so a client that verifies this proof before sending its bearer token can
 * detect that impostor rather than handing it the token on the first real request.
 */
function handleHello(url: URL, res: http.ServerResponse, token: string): void {
  const nonce = url.searchParams.get('nonce') ?? '';
  if (!HELLO_NONCE_RE.test(nonce)) {
    sendError(res, 400, 'bad_request', 'nonce must be exactly 32 hex characters');
    return;
  }
  const proof = crypto.createHmac('sha256', token).update(nonce).digest('hex');
  sendJson(res, 200, { proof });
}

async function route(url: URL, queries: Queries, res: http.ServerResponse, control?: ReadControl, initialCaptureState?: CreateHttpServerOpts['initialCaptureState'], buildIdentity?: CreateHttpServerOpts['buildIdentity']): Promise<void> {
  const path = url.pathname;

  if (path === '/v1/health') {
    sendJson(res, 200, { status: 'ok', generatedAt: Date.now(), buildIdentity: buildIdentity ?? null, ...(initialCaptureState ? { initialCaptureState: initialCaptureState() } : {}), capabilities: {
      ...(queries.getSummaryReport ? { summaryReadJobs: 1 } : {}),
      ...(queries.getUsage ? { atomicUsage: 1 } : {}), ...(queries.getUsageReport ? { usageReadJobs: 1 } : {}) } });
    return;
  }

  if (path === '/v1/usage') {
    const range = parseRange(url, res); if (range === undefined) return;
    if (!queries.getUsage) { sendError(res, 404, 'not_found'); return; }
    sendJson(res, 200, await queries.getUsage(range, control)); return;
  }

  if (path === '/v1/summary') {
    const range = parseRange(url, res);
    if (range === undefined) return;
    sendJson(res, 200, await queries.getSummary(range, control));
    return;
  }

  if (path === '/v1/sessions') {
    const range = parseRange(url, res);
    if (range === undefined) return;
    const activeOnly = url.searchParams.get('active') === '1';
    sendJson(res, 200, await queries.getSessions({ range, activeOnly }, control));
    return;
  }

  if (path === '/v1/limits') {
    sendJson(res, 200, await queries.getLimits());
    return;
  }

  if (path === '/v1/limits/history') {
    sendJson(res, 200, await queries.getPlanUsageHistory());
    return;
  }

  if (path === '/v1/processes') {
    sendJson(res, 200, await queries.getProcesses());
    return;
  }

  if (path === '/v1/coverage') {
    sendJson(res, 200, await queries.getCoverage());
    return;
  }

  if (path === '/v1/timeseries') {
    const range = parseRange(url, res);
    if (range === undefined) return;
    const bucketParam = url.searchParams.get('bucket') ?? 'day';
    if (bucketParam !== 'hour' && bucketParam !== 'day') {
      sendError(res, 400, 'bad_request', `bucket must be "hour" or "day", got "${bucketParam}"`);
      return;
    }
    sendJson(res, 200, await queries.getTimeseries(bucketParam, range, control));
    return;
  }

  if (path === '/v1/doctor') {
    sendJson(res, 200, await queries.getDoctor(control));
    return;
  }

  if (path === '/v1/sessions/detail') {
    const sourceParam = url.searchParams.get('source');
    if (!isSource(sourceParam)) {
      sendError(res, 400, 'bad_request', `source must be one of ${VALID_SOURCES.join(', ')}, got "${sourceParam}"`);
      return;
    }
    const sessionIdParam = url.searchParams.get('sessionId');
    if (!isReasonableSessionId(sessionIdParam)) {
      sendError(
        res,
        400,
        'bad_request',
        `sessionId must be non-empty and at most ${MAX_SESSION_ID_LEN} characters`
      );
      return;
    }
    const detail = await queries.getSessionDetail(sourceParam, sessionIdParam, control);
    if (detail === null) {
      sendError(res, 404, 'not_found', `no session ${sourceParam}:${sessionIdParam}`);
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  sendError(res, 404, 'not_found');
}

/** Reads `range` from the query string, defaulting to 'today'; writes a 400 and returns
 * `undefined` if an unknown value was supplied. */
function parseRange(url: URL, res: http.ServerResponse): Range | undefined {
  const raw = url.searchParams.get('range');
  if (raw === null) return 'today';
  if (!isRange(raw)) {
    sendError(res, 400, 'bad_request', `range must be one of ${VALID_RANGES.join(', ')}, got "${raw}"`);
    return undefined;
  }
  return raw;
}

/** Constant-time string comparison for the bearer token check — avoids a timing side-channel on
 * how many leading characters matched. Falls back to false on any length mismatch (also in
 * constant time relative to the *expected* string's length, which is the only length that matters
 * here since it never varies at runtime). */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare against a same-length dummy so this branch takes comparable time either way,
    // rather than returning immediately.
    const dummy = Buffer.alloc(bufB.length);
    crypto.timingSafeEqual(dummy, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

