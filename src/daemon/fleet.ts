/**
 * Optional read-only fleet surface (DESIGN §2.2 / §15.7.3 / M5). It is intentionally a separate
 * listener and secret from the loopback API: it binds only to a configured Tailscale IP, accepts
 * only one aggregate route, rejects browser Origins, and never serializes session/project data.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  USAGE_SOURCES,
  type FleetSummaryResponse,
  type HostLabel,
  type Range,
  type SummaryResponse,
  type TokenCounts,
} from '../core/types.js';
import { TOKEN_FIELD_KEYS, type TokenFieldCoverage, type TokenFieldEvidence } from '../core/token-field-evidence.js';
import { hasInvalidTokenValues } from '../core/token-counts.js';
import { priceEvidenceProblem, type PriceEvidence } from '../core/price-evidence.js';
import { priceQualityProblem } from '../core/price-quality.js';
import type { Queries } from '../store/queries.js';
import { tightenSecretFilePermissions, verifySecretDirectoryPermissions, writeSecretFileAtomically, type SecretDirectoryPermissionCheck, type TokeneloPaths } from './paths.js';
import { ReportReadError } from './report-read-protocol.js';

export const FLEET_PORT = 47822;
const HELLO_NONCE_RE = /^[0-9a-f]{32}$/i;
const VALID_RANGES: readonly Range[] = ['today', '24h', '7d', '30d', 'all'];

export type FleetLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void;

export function isTailnetIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  return net.isIPv4(address) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function isTailnetAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (isTailnetIpv4(address)) return true;
  return net.isIPv6(address) && (lower === 'fd7a:115c:a1e0' || lower.startsWith('fd7a:115c:a1e0:'));
}

/** Peer URLs are configuration, but only Tailnet IPs are allowed to receive a fleet credential. */
export function isTailnetPeerUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    return (
      url.protocol === 'http:' &&
      url.port === String(FLEET_PORT) &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      isTailnetAddress(hostname)
    );
  } catch {
    return false;
  }
}

/** Permission checker can be replaced by a synthetic result in failure-path tests. */
export type SecretPermissionCheck = (filePath: string) => boolean;

/** Stable, traversal-safe path for a peer's separately copied fleet token. */
export function getFleetPeerTokenPath(paths: TokeneloPaths, label: HostLabel): string {
  const safe = label.replace(/[^a-z0-9_-]/gi, '_').slice(0, 48) || 'peer';
  const digest = crypto.createHash('sha256').update(label).digest('hex').slice(0, 12);
  return path.join(paths.dataDir, 'fleet-peers', `${safe}-${digest}.token`);
}

/** Stores a peer's distinct fleet token in its user-only data directory, never in config.json. */
export function writeFleetPeerToken(
  paths: TokeneloPaths,
  label: HostLabel,
  token: string,
  checkPermissions: SecretPermissionCheck = tightenSecretFilePermissions,
  checkDirectoryPermissions: SecretDirectoryPermissionCheck = verifySecretDirectoryPermissions,
): string {
  if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error('peer fleet token must be 64 hex characters');
  const file = getFleetPeerTokenPath(paths, label);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!writeSecretFileAtomically(file, `${token}\n`, checkPermissions, fs.existsSync(file), checkDirectoryPermissions)) {
    throw new Error(`could not restrict peer token permissions: ${label}`);
  }
  return file;
}

/** Reads and re-locks a peer secret before it can be used for an outbound request. */
export function readFleetPeerToken(
  paths: TokeneloPaths,
  label: HostLabel,
  checkPermissions: SecretPermissionCheck = tightenSecretFilePermissions,
): string | null {
  try {
    const file = getFleetPeerTokenPath(paths, label);
    if (!fs.existsSync(file)) return null;
    const token = fs.readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(token) || !checkPermissions(file)) return null;
    return token;
  } catch {
    return null;
  }
}

export function ensureFleetToken(
  paths: TokeneloPaths,
  checkPermissions: SecretPermissionCheck = tightenSecretFilePermissions,
  checkDirectoryPermissions: SecretDirectoryPermissionCheck = verifySecretDirectoryPermissions,
): string {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  let token: string;
  if (fs.existsSync(paths.fleetTokenFile)) {
    token = fs.readFileSync(paths.fleetTokenFile, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error('fleet-token is malformed; replace it before enabling the listener');
    if (!checkPermissions(paths.fleetTokenFile)) {
      throw new Error('could not restrict fleet-token permissions to the current user');
    }
    return token;
  }

  token = crypto.randomBytes(32).toString('hex');
  if (!writeSecretFileAtomically(paths.fleetTokenFile, `${token}\n`, checkPermissions, false, checkDirectoryPermissions)) {
    throw new Error('could not restrict fleet-token permissions to the current user');
  }
  return token;
}

export interface CreateFleetHttpServerOptions {
  address: string;
  port?: number;
  token: string;
  queries: Queries;
  host: HostLabel;
  log?: FleetLogger;
}

export function createFleetHttpServer(opts: CreateFleetHttpServerOptions): http.Server {
  const port = opts.port ?? FLEET_PORT;
  const logger: FleetLogger = opts.log ?? (() => {});
  if (!isTailnetAddress(opts.address)) throw new Error('fleet listener address must be a Tailscale IPv4 or IPv6 address');
  let acceptingReportReads = true;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      if (res.destroyed || res.writableEnded) return;
      if (err instanceof ReportReadError) {
        sendJson(res, err.code === 'read_capacity' ? 429 : err.code === 'read_timeout' ? 504 : 503,
          { error: err.code, message: err.message }); return;
      }
      logger('error', 'unhandled error in fleet HTTP handler', { error: String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.end();
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const canonicalAddress = net.isIPv6(opts.address)
      ? new URL(`http://[${opts.address}]/`).hostname
      : opts.address;
    const expectedHost = `${canonicalAddress}:${port}`;
    if ((req.headers.host ?? '').toLowerCase() !== expectedHost.toLowerCase()) {
      sendJson(res, 403, { error: 'forbidden_host' });
      return;
    }
    if (req.headers.origin !== undefined) {
      sendJson(res, 403, { error: 'forbidden_origin' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.pathname === '/v1/fleet/hello') {
      const nonce = url.searchParams.get('nonce') ?? '';
      if (!HELLO_NONCE_RE.test(nonce)) {
        sendJson(res, 400, { error: 'bad_request' });
        return;
      }
      const proof = crypto.createHmac('sha256', opts.token).update(nonce).digest('hex');
      sendJson(res, 200, { proof });
      return;
    }

    if (!timingSafeEqualStrings(req.headers.authorization ?? '', `Bearer ${opts.token}`)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (!acceptingReportReads && url.pathname === '/v1/fleet/summary') {
      sendJson(res, 503, { error: 'read_unavailable' });
      return;
    }
    if (url.pathname !== '/v1/fleet/summary') {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const rawRange = url.searchParams.get('range');
    const range = rawRange === null ? 'today' : VALID_RANGES.includes(rawRange as Range) ? (rawRange as Range) : null;
    if (!range) {
      sendJson(res, 400, { error: 'bad_request' });
      return;
    }

    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(new Error('read_cancelled')); };
    res.once('close', cancel);
    let summary;
    try {
      if (res.destroyed) { cancel(); return; }
      summary = await opts.queries.getSummary(range, { signal: controller.signal });
    } finally { res.off('close', cancel); }
    const safeSummary = projectFleetSummary(summary, opts.host, range);
    if (!safeSummary) {
      sendJson(res, 503, { error: 'read_unavailable' });
      return;
    }
    sendJson(res, 200, safeSummary);
  }

  fleetReadAdmissions.set(server, () => { acceptingReportReads = false; });
  return server;
}

const fleetReadAdmissions = new WeakMap<http.Server, () => void>();
/** Refuse new report work while the daemon is shutting down; this does not signal worker retirement. */
export function stopFleetReadAdmission(server: http.Server): void { fleetReadAdmissions.get(server)?.(); }

type DataRecord = Record<string, unknown>;

const COUNT_QUALITIES = ['complete', 'incomplete', 'invalid', 'conflict', 'unrecorded'] as const;
const PRICE_STATUSES = ['LIST', 'ESTIMATE', 'UNPRICED'] as const;
const TOKEN_FIELD_COUNTERS = [
  'knownValue', 'knownParts', 'reportedParts', 'derivedParts', 'normalizedParts', 'assumedParts',
  'notApplicableParts', 'missingParts', 'invalidParts', 'unrecordedParts',
] as const;

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Explicit undefined serializes as omission, just like a genuinely absent legacy optional. */
function isProvided(value: DataRecord, key: string): boolean {
  return Object.hasOwn(value, key) && value[key] !== undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonnegativeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPriceStatus(value: unknown): value is (typeof PRICE_STATUSES)[number] {
  return typeof value === 'string' && (PRICE_STATUSES as readonly string[]).includes(value);
}

function projectPriceEvidence(value: unknown, expectedEvents: number): PriceEvidence | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.aggregateAmountInvalid !== 'boolean'
    || !isNonnegativeCount(value.events) || !isNonnegativeCount(value.invalidAmountEvents)
    || !isNonnegativeCount(value.unknownStatusEvents) || !isNonnegativeCount(value.statusAmountConflictEvents)
    || !isNonnegativeCount(value.issuesEvents) || priceEvidenceProblem(value, expectedEvents) !== null) return undefined;
  return {
    version: 1,
    events: value.events,
    invalidAmountEvents: value.invalidAmountEvents,
    unknownStatusEvents: value.unknownStatusEvents,
    statusAmountConflictEvents: value.statusAmountConflictEvents,
    issuesEvents: value.issuesEvents,
    aggregateAmountInvalid: value.aggregateAmountInvalid,
  };
}

function projectTokenFieldEvidence(value: unknown): TokenFieldEvidence | undefined {
  if (!isRecord(value) || !TOKEN_FIELD_COUNTERS.every(key => isNonnegativeCount(value[key]))) return undefined;
  return {
    knownValue: value.knownValue as number,
    knownParts: value.knownParts as number,
    reportedParts: value.reportedParts as number,
    derivedParts: value.derivedParts as number,
    normalizedParts: value.normalizedParts as number,
    assumedParts: value.assumedParts as number,
    notApplicableParts: value.notApplicableParts as number,
    missingParts: value.missingParts as number,
    invalidParts: value.invalidParts as number,
    unrecordedParts: value.unrecordedParts as number,
  };
}

function projectTokenFieldCoverage(value: unknown): TokenFieldCoverage | undefined {
  if (!isRecord(value) || !TOKEN_FIELD_KEYS.every(key => Object.hasOwn(value, key))) return undefined;
  const projected: Partial<TokenFieldCoverage> = {};
  for (const key of TOKEN_FIELD_KEYS) {
    const field = projectTokenFieldEvidence(value[key]);
    if (!field) return undefined;
    projected[key] = field;
  }
  return projected as TokenFieldCoverage;
}

function projectTokenCounts(value: unknown): TokenCounts | null {
  if (!isRecord(value)
    || !isNonnegativeCount(value.inputFresh)
    || !isNonnegativeCount(value.cacheWrite5m)
    || !isNonnegativeCount(value.cacheWrite1h)
    || !isNonnegativeCount(value.cacheRead)
    || !isNonnegativeCount(value.output)
    || !isNonnegativeCount(value.reasoning)) return null;
  const projected: TokenCounts = {
    inputFresh: value.inputFresh, cacheWrite5m: value.cacheWrite5m, cacheWrite1h: value.cacheWrite1h,
    cacheRead: value.cacheRead, output: value.output, reasoning: value.reasoning,
  };
  for (const key of ['cacheWriteUnassigned', 'cacheWriteAssumed1h'] as const) {
    if (!isProvided(value, key)) continue;
    if (!isNonnegativeCount(value[key])) return null;
    projected[key] = value[key];
  }
  for (const key of ['countQuality', 'ucuCountQuality'] as const) {
    if (!isProvided(value, key)) continue;
    const quality = value[key];
    if (typeof quality !== 'string' || !COUNT_QUALITIES.includes(quality as (typeof COUNT_QUALITIES)[number])) return null;
    projected[key] = quality as NonNullable<TokenCounts['countQuality']>;
  }
  if (isProvided(value, 'fieldEvidence')) {
    const evidence = projectTokenFieldCoverage(value.fieldEvidence);
    if (!evidence) return null;
    projected.fieldEvidence = evidence;
  }
  if (hasInvalidTokenValues(projected)) return null;
  return projected;
}

/*
 * Aggregates are rebuilt field by field from the fixed lists below. Any other key a peer sends (for example a
 * legacy figure member from an older daemon) is ignored here and never forwarded.
 */
type SourceAggregate = SummaryResponse['bySource'][keyof SummaryResponse['bySource']];

/** Preserve legacy omissions, but reject present price-quality fields that contradict one another. */
function projectPriceQuality(value: DataRecord, projected: DataRecord, events: number): boolean {
  const evidence = projected.priceEvidence;
  if (isProvided(value, 'priceEvidence')
    && (evidence === undefined || priceEvidenceProblem(evidence, events) !== null)) return false;
  const hasEstimateCount = isProvided(value, 'estimatedPriceEvents');
  const hasStatus = isProvided(value, 'priceStatus');
  if (!hasEstimateCount && !hasStatus) {
    return !isProvided(value, 'unpricedEvents')
      || (isNonnegativeCount(projected.unpricedEvents) && projected.unpricedEvents <= events);
  }
  if (events === 0 && !isProvided(value, 'priceEvidence') && projected.priceStatus === 'LIST'
    && (projected.unpricedEvents ?? 0) === 0 && (projected.estimatedPriceEvents ?? 0) === 0) return true;
  return priceQualityProblem({
    events,
    unpricedEvents: projected.unpricedEvents,
    estimatedPriceEvents: projected.estimatedPriceEvents,
    priceStatus: projected.priceStatus,
    ...(evidence !== undefined ? { priceEvidence: evidence } : {}),
  }) === null;
}

function projectSourceAggregate(value: unknown): SourceAggregate | null {
  if (!isRecord(value) || !isNonnegativeCount(value.events)
    || !isFiniteNumber(value.apiEquivUsd) || value.apiEquivUsd < 0) return null;
  const tokens = projectTokenCounts(value.tokens);
  if (!tokens) return null;
  const projected: SourceAggregate = { events: value.events, tokens, apiEquivUsd: value.apiEquivUsd };
  for (const key of ['unpricedEvents', 'estimatedPriceEvents'] as const) {
    if (!isProvided(value, key)) continue;
    if (!isNonnegativeCount(value[key])) return null;
    projected[key] = value[key];
  }
  if (isProvided(value, 'priceStatus')) {
    if (!(value.priceStatus === null || isPriceStatus(value.priceStatus))) return null;
    projected.priceStatus = value.priceStatus;
  }
  if (isProvided(value, 'priceEvidence')) {
    const evidence = projectPriceEvidence(value.priceEvidence, value.events);
    if (!evidence) return null;
    projected.priceEvidence = evidence;
  }
  if (!projectPriceQuality(value, projected as unknown as DataRecord, value.events)) return null;
  return projected;
}

function projectFleetTotals(value: unknown): FleetSummaryResponse['totals'] | null {
  if (!isRecord(value) || !isNonnegativeCount(value.events)
    || !isFiniteNumber(value.apiEquivUsd) || value.apiEquivUsd < 0) return null;
  const tokens = projectTokenCounts(value.tokens);
  if (!tokens) return null;
  // Legacy omission remains unknown; malformed supplied quality evidence withholds the report.
  const projected = { events: value.events, tokens, apiEquivUsd: value.apiEquivUsd } as FleetSummaryResponse['totals'];
  for (const key of ['unpricedEvents', 'estimatedPriceEvents'] as const) {
    if (!isProvided(value, key)) continue;
    if (!(value[key] === null || isNonnegativeCount(value[key]))) return null;
    projected[key] = value[key];
  }
  if (isProvided(value, 'priceStatus')) {
    if (!(value.priceStatus === null || isPriceStatus(value.priceStatus))) return null;
    projected.priceStatus = value.priceStatus;
  }
  if (isProvided(value, 'priceEvidence')) {
    const evidence = projectPriceEvidence(value.priceEvidence, value.events);
    if (!evidence) return null;
    projected.priceEvidence = evidence;
  }
  if (!projectPriceQuality(value, projected as unknown as DataRecord, value.events)) return null;
  return projected;
}

function projectBySource(value: unknown): SummaryResponse['bySource'] | null {
  if (!isRecord(value)) return null;
  const projected: Partial<SummaryResponse['bySource']> = {};
  for (const source of USAGE_SOURCES) {
    if (!Object.hasOwn(value, source)) continue;
    const aggregate = projectSourceAggregate(value[source]);
    if (!aggregate) return null;
    projected[source] = aggregate;
  }
  return projected as SummaryResponse['bySource'];
}

function projectActiveTime(value: unknown): SummaryResponse['activeTime'] | null {
  if (!isRecord(value) || !isFiniteNumber(value.agentMs) || value.agentMs < 0
    || !isFiniteNumber(value.wallMs) || value.wallMs < 0) return null;
  return { agentMs: value.agentMs, wallMs: value.wallMs };
}

/** Deeply reconstructs the fixed aggregate contract; no query-owned object is serialized directly. */
function projectFleetSummary(value: unknown, host: HostLabel, range: Range): FleetSummaryResponse | null {
  if (!isRecord(value) || !isFiniteNumber(value.generatedAt)) return null;
  const totals = projectFleetTotals(value.totals);
  const bySource = projectBySource(value.bySource);
  const activeTime = projectActiveTime(value.activeTime);
  if (!totals || !bySource || !activeTime) return null;
  return { host, range, generatedAt: value.generatedAt, totals, bySource, activeTime };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(Buffer.alloc(right.length), right);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}
