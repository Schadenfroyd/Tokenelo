/**
 * Data source and run containment for `--snapshot` (src/tray/main.ts). Pure apart from the read recorder's own calls, so the tests
 * drive it without Electron, without a daemon, and without touching the filesystem.
 *
 * Sources. `fixtures` (the default) renders the canned fixture set, exactly as before. `live` reads the already-running local API with
 * the configured token, through the same client the tray uses. A live snapshot never spawns or restarts a daemon, never registers a
 * service, and never runs a collector: the snapshot branch returns before any of that in main.ts. A live snapshot's reads are the reads
 * the captured tab makes. Those can include the configured Fleet peers when the captured tab is Fleet (`--tab fleet`), because Fleet
 * uses the normal Fleet client; that path is not loopback-only.
 *
 * Conflicts are refused, not resolved. `--data live` with TOKENELO_MOCK set (non-empty) is an error, because an inherited mock would
 * otherwise decide the source silently. `--data fixtures` honours TOKENELO_MOCK, as it always has, and is labelled as fixtures.
 *
 * Failures. Every failure of a snapshot run is reported as one fixed sentence built from a fixed category, with the exit code 1 (or 2 for
 * a refused source), and no image is written. A failed live read also names the first failed read's ApiClient method and phase, both
 * from fixed sets (readFailureLine). The sentences never contain a token, a session or prompt text, a repository path, a raw
 * error message, or an error name other than a standard JavaScript one. Successful fixture values/rendering stay unchanged; fixture
 * read rejections are sanitized before Electron logs IPC errors. A failed current renderer outcome refuses the snapshot promptly,
 * including a detail identity mismatch; it does not signal successful readiness or write an error-state image.
 */
import { ApiError, ApiTokenFileError, DaemonIdentityError, DaemonTimeoutError, ReportReadRetiredError, type ApiClient } from './api-client.js';
import type { TrayArgv } from './argv.js';
import { SnapshotRendererError, snapshotRendererFailureText } from './renderer/snapshot-outcome.js';

/** Default policy for one whole snapshot, including the wait for Electron. */
export const SNAPSHOT_TIMEOUT_MS = 60_000;

export type SnapshotData = { mode: 'fixtures'; mockDir: string } | { mode: 'live' };
export type SnapshotDataChoice = { ok: true; data: SnapshotData } | { ok: false; message: string };

/** Chooses the data source for `--snapshot`. No I/O: the caller passes the environment and the default fixture directory. */
export function resolveSnapshotData(
  argv: Pick<TrayArgv, 'snapshotError' | 'data' | 'dataError' | 'rangeError'>,
  env: Record<string, string | undefined>,
  defaultFixtureDir: string
): SnapshotDataChoice {
  if (argv.snapshotError) return { ok: false, message: argv.snapshotError };
  if (argv.dataError) return { ok: false, message: argv.dataError };
  if (argv.rangeError) return { ok: false, message: argv.rangeError };
  const mock = env.TOKENELO_MOCK ?? '';
  if (argv.data === 'live') {
    if (mock !== '') {
      return {
        ok: false,
        message: '--data live cannot be used while TOKENELO_MOCK is set. Unset TOKENELO_MOCK, or pass --data fixtures to render the fixture set.',
      };
    }
    return { ok: true, data: { mode: 'live' } };
  }
  return { ok: true, data: { mode: 'fixtures', mockDir: mock !== '' ? mock : defaultFixtureDir } };
}

/** The standard JavaScript error names. Any other name, including one a library or a message sets, is reported as unknown. */
const STANDARD_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
]);

/** The error's name if it is a standard one, else 'unknown error'. An error's name is data that can carry anything, so it is never echoed raw. */
export function safeErrorName(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  return STANDARD_ERROR_NAMES.has(name) ? name : 'unknown error';
}

/**
 * The category of a failed read, as a sentence for the CLI. Deliberately never quotes the error: a token-file error names a path, an HTTP
 * error can carry response text, and a name can carry anything. The port is a number from configuration, so it is safe to show.
 */
export function describeReadFailure(err: unknown, port: number): string {
  // Typed cases first. A timeout message carries a route and the word "tokenelo", so it must never reach the text checks below.
  if (err instanceof DaemonTimeoutError) {
    return 'a local API read did not complete within its deadline';
  }
  if (err instanceof ApiTokenFileError) {
    return 'no readable API token file: it is missing or could not be read';
  }
  if (err instanceof DaemonIdentityError) {
    return 'the local API did not prove that it holds the API token (possible port squatter, or a daemon from another data directory)';
  }
  if (err instanceof ApiError && typeof err.status === 'number') {
    return `the local API answered HTTP ${err.status} for a read`;
  }
  const message = err instanceof Error ? err.message : '';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|identity challenge failed/i.test(message)) {
    return `the local API is not reachable at 127.0.0.1:${port}; start the daemon, then retry`;
  }
  return `a read failed (${safeErrorName(err)})`;
}

/** The category of a failure that is not a read: anything else that stops the run. */
export function describeUnexpectedFailure(err: unknown): string {
  if (err instanceof SnapshotRendererError) return snapshotRendererFailureText(err.category);
  return `an unexpected error (${safeErrorName(err)})`;
}

/**
 * The error a failed live read throws across the IPC boundary. Electron logs every handler rejection with its stack, and a stack of a
 * client error contains repository and data-directory paths. This error carries only the fixed category: its stack is removed, so
 * the log line is `SnapshotReadError: <category>`. Only the live snapshot uses it (recordReads); the normal tray is unchanged.
 */
export function safeReadError(category: string): Error {
  const err = new Error(category);
  err.name = 'SnapshotReadError';
  Object.defineProperty(err, 'stack', { value: undefined, enumerable: false, configurable: true, writable: true });
  return err;
}

/** The ApiClient method names a failure may be reported under. Any other key a wrapped object has is reported as 'other'. */
export const READ_METHODS = [
  'getSummary',
  'getSummaryReport',
  'getUsage',
  'getSessions',
  'getSessionsResponse',
  'getLimits',
  'getTimeseries',
  'getDoctor',
  'getCoverage',
  'getProcesses',
  'getSessionDetail',
  'getFleetOverview',
] as const satisfies ReadonlyArray<keyof ApiClient>;
export type ReadMethod = (typeof READ_METHODS)[number] | 'other';
const READ_METHOD_SET: ReadonlySet<string> = new Set(READ_METHODS);

/** Electron prints rejected IPC errors before the renderer can qualify them. Canned snapshots
 * therefore strip fixture paths/parse text at the main-process read boundary too. This wrapper
 * reports failures to the snapshot owner, does not validate fixture values, and does not
 * change normal interactive reads. */
export function sanitizeFixtureReads(client: ApiClient, onFailure?: () => void): ApiClient {
  const wrapped: Record<string, unknown> = { ...client };
  for (const name of READ_METHODS) {
    const method = client[name];
    if (typeof method !== 'function') continue;
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await Reflect.apply(method, client, args);
      } catch {
        onFailure?.();
        throw safeReadError(`a fixture read failed (${name})`);
      }
    };
  }
  return wrapped as unknown as ApiClient;
}

/**
 * Where the first failure happened. Only typed errors decide it: a timeout's route, the identity error, the token-file error. Everything
 * else (an HTTP status, a refused connection, an unknown error) is 'other', because its phase is not known from its type.
 */
export type FailurePhase = 'identity-challenge' | 'local-read' | 'token-file' | 'other';
const PHASE_TEXT: Readonly<Record<FailurePhase, string>> = {
  'identity-challenge': 'the identity challenge',
  'local-read': 'the local read',
  'token-file': 'the token file read',
  other: 'an undetermined phase',
};

/** The routes the local client reads, without query. A timeout on any route not listed here, including one with a query, is 'other'. */
const LOCAL_READ_ROUTES: ReadonlySet<string> = new Set([
  '/v1/health',
  '/v1/summary',
  '/v1/usage',
  '/v1/sessions',
  '/v1/limits',
  '/v1/timeseries',
  '/v1/doctor',
  '/v1/coverage',
  '/v1/processes',
  '/v1/sessions/detail',
]);

/** The fixed method identifier for a wrapped key. The key itself is never reported unless it is one of READ_METHODS. */
export function readMethodOf(name: string): ReadMethod {
  return READ_METHOD_SET.has(name) ? (name as ReadMethod) : 'other';
}

/** The phase of a failed read, from the error's type alone (and a timeout's route, compared exactly). Never reads a message. */
export function failurePhaseOf(err: unknown): FailurePhase {
  if (err instanceof DaemonTimeoutError) {
    if (err.route === '/v1/hello') return 'identity-challenge';
    return typeof err.route === 'string' && LOCAL_READ_ROUTES.has(err.route) ? 'local-read' : 'other';
  }
  if (err instanceof ApiTokenFileError) return 'token-file';
  if (err instanceof DaemonIdentityError) return 'identity-challenge';
  return 'other';
}

/** What a live snapshot's reads did, for its receipt, its failure check and the capture's settle wait. */
export interface ReadRecord {
  /** Reads that completed successfully. */
  reads: number;
  /** Reads that have started, including those still running. */
  started: number;
  /** Reads started and not yet settled. */
  pending: number;
  /** Client-observed report cancellation count; it is not a lease-release acknowledgement or worker-retirement count. */
  retired?: number;
  /** The first failure's category, or null while every read has succeeded. */
  failure: string | null;
  /** The method of that same first failure, or null while every read has succeeded. */
  failureMethod: ReadMethod | null;
  /** The phase of that same first failure, or null while every read has succeeded. */
  failurePhase: FailurePhase | null;
}

/**
 * The CLI line for a failed live snapshot: the first failure's category, then its method and phase. The method and phase are checked
 * against the fixed sets again here, so a record changed after the fact still prints only fixed identifiers.
 */
export function readFailureLine(record: FailureRecord): string {
  return `tray snapshot failed: ${firstFailureText(record)}. No image was written.`;
}

type FailureRecord = Pick<ReadRecord, 'failure' | 'failureMethod' | 'failurePhase'>;

/** The first failure's category with its method and phase, each re-checked against the fixed sets. Shared by both failure lines. */
function firstFailureText(record: FailureRecord): string {
  const method = readMethodOf(String(record.failureMethod));
  const phase: FailurePhase = Object.hasOwn(PHASE_TEXT, String(record.failurePhase)) ? (record.failurePhase as FailurePhase) : 'other';
  return `${record.failure} (first failed read: ${method}, during ${PHASE_TEXT[phase]})`;
}

/**
 * The CLI line for a run stopped by its deadline or an unexpected error. The reason the run stopped always comes first and is kept as
 * is; a first read failure already recorded is appended after it, so a stalled run still names the read that failed first.
 */
export function runFailureLine(reason: string, record: FailureRecord | null | undefined): string {
  if (!record?.failure) return `tray snapshot failed: ${reason}. No image was written.`;
  return `tray snapshot failed: ${reason}; a read had already failed: ${firstFailureText(record)}. No image was written.`;
}

/**
 * Wraps every method of the client so each call is counted, and the first failing call is recorded with its method and phase (the error
 * is still thrown, so the renderer's own error handling runs unchanged). Used for live snapshots only.
 */
export function recordReads(client: ApiClient, port: number): { client: ApiClient; record: ReadRecord } {
  const record: ReadRecord = { reads: 0, started: 0, pending: 0, failure: null, failureMethod: null, failurePhase: null };
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(client)) {
    if (typeof value !== 'function') {
      wrapped[name] = value;
      continue;
    }
    wrapped[name] = async (...args: unknown[]) => {
      record.started++;
      record.pending++;
      try {
        const result: unknown = await (value as (...a: unknown[]) => unknown).apply(client, args);
        record.reads++;
        return result;
      } catch (err) {
        // Only the trusted typed report lifecycle can record a client-side cancellation. This
        // does not attest lease release or worker retirement; generic aborts remain failures.
        if ((name === 'getSummaryReport' || name === 'getUsage') && err instanceof ReportReadRetiredError) {
          record.retired = (record.retired ?? 0) + 1;
          throw err;
        }
        const category = describeReadFailure(err, port);
        // Category, method and phase are set together, from the same failure, so they always describe one read.
        if (record.failure === null) {
          record.failure = category;
          record.failureMethod = readMethodOf(name);
          record.failurePhase = failurePhaseOf(err);
        }
        // The original error (with its stack and paths) stops here. Only the category crosses to the IPC handler.
        throw safeReadError(category);
      } finally {
        record.pending--;
      }
    };
  }
  // The keys of `wrapped` are exactly those of `client`; each function is replaced by a wrapper with the same arguments.
  return { client: wrapped as unknown as ApiClient, record };
}

/** Resolves when no read is pending. Polls, because the recorder is a plain counter. */
export async function whenReadsSettle(record: ReadRecord, pollMs = 25): Promise<void> {
  while (record.pending > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
}

/**
 * Runs `renderTurn` (which lets the renderer and the compositor catch up) only until a turn passes with no read pending and no read
 * started during it. A renderer's own continuation after an IPC answer can start the next read, so one turn is not enough; the loop
 * repeats until the reads are quiet. With no record (fixtures), one turn is taken. The overall bound is the run's deadline, not this loop.
 */
export async function settleThenRender(record: ReadRecord | null, renderTurn: () => Promise<unknown>): Promise<void> {
  if (!record) {
    await renderTurn();
    return;
  }
  for (;;) {
    await whenReadsSettle(record);
    const started = record.started;
    await renderTurn();
    if (record.pending === 0 && record.started === started) return;
  }
}

/** The receipt line that states which data mode produced the image. */
export function snapshotReceipt(data: SnapshotData, reads: number, port: number, clientCancelled = 0): string {
  if (data.mode === 'live') {
    const cancellation = clientCancelled > 0 ? `; ${clientCancelled} report ${clientCancelled === 1 ? 'read' : 'reads'} cancelled (worker retirement not reported)` : '';
    return `tray snapshot: data mode live (authenticated local API at 127.0.0.1:${port}; ${reads} reads ok${cancellation})`;
  }
  return 'tray snapshot: data mode fixtures (canned fixture set, not live data)';
}

export class SnapshotTimeout extends Error {}

/** Rejects with SnapshotTimeout if `work` does not settle within `ms`. The work itself is not cancelled; the caller exits. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SnapshotTimeout(`snapshot did not finish within ${ms / 1000} s`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the whole snapshot body under the run's deadline. The body is started inside the deadline, so a rejection, a synchronous throw,
 * and a hang are all contained: each produces one report with exit code 1, and the function itself never rejects. `recorded` returns
 * the live read record at report time (null for fixtures), so a first read failure recorded before the stop is reported with it.
 */
export async function runBounded(
  body: () => Promise<void>,
  ms: number,
  report: (code: number, line: string) => void,
  recorded: () => FailureRecord | null | undefined = () => null
): Promise<void> {
  try {
    await withDeadline(Promise.resolve().then(body), ms);
  } catch (err) {
    const reason = err instanceof SnapshotTimeout ? err.message : describeUnexpectedFailure(err);
    report(1, runFailureLine(reason, recorded()));
  }
}

