/**
 * Minimal structured logger + the node:sqlite ExperimentalWarning filter (DESIGN §15.7.4,
 * spikes-2026-09-26.md S1: node 22.x prints
 *   "ExperimentalWarning: SQLite is an experimental feature and might change at any time"
 * to stderr on every process start; node 24.x/26.x are silent. `doctor` must not treat that
 * line as an error, and the daemon's own logs should not be spammed with it on ryzen (node
 * 22.x) while every *other* process warning still surfaces normally.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  (level: LogLevel, msg: string, data?: Record<string, unknown>): void;
}

/**
 * A small, dependency-free structured logger. Writes one JSON line per call to `sink`. The default
 * sink is **stderr** for every level (DESIGN §15.9.6): stdout is reserved for the CLI's JSON/CSV
 * payloads (`tokenelo report | jq`, `export --format csv`), so a log line must never land there.
 * Not a general-purpose logging framework — Tokenelo's daemon only needs "one line per event",
 * per DESIGN's "no prompt/response content" minimalism.
 */
export function createLogger(opts?: {
  sink?: (line: string) => void;
  now?: () => number;
}): Logger {
  const now = opts?.now ?? (() => Date.now());
  const sink = opts?.sink ?? defaultStderrSink;
  return (level, msg, data) => {
    sink(JSON.stringify({ ts: now(), level, msg, ...(data ? { data } : {}) }));
  };
}

/** The default sink: one line to process.stderr (looked up at call time so tests can intercept it). */
export function defaultStderrSink(line: string): void {
  process.stderr.write(line + '\n');
}

const SQLITE_EXPERIMENTAL_WARNING_NAME = 'ExperimentalWarning';
const SQLITE_EXPERIMENTAL_WARNING_PATTERN = /SQLite is an experimental feature/i;

function isSqliteExperimentalWarning(warning: unknown): boolean {
  if (!(warning instanceof Error)) return false;
  return (
    warning.name === SQLITE_EXPERIMENTAL_WARNING_NAME &&
    SQLITE_EXPERIMENTAL_WARNING_PATTERN.test(warning.message)
  );
}

let installed = false;

/**
 * Installs a process-wide `warning` listener that drops ONLY the node:sqlite
 * ExperimentalWarning and re-emits every other warning to whatever listener(s) were already
 * registered (Node's own default stderr printer, or anything user code added before this
 * call). Node's default warning behaviour is itself just a `process.on('warning', ...)`
 * listener installed at startup, so adding our own listener does not by itself suppress
 * stderr — we have to take over the existing listener(s), filter, and re-dispatch. Idempotent:
 * calling this more than once is a no-op after the first call.
 *
 * Verified (spikes-2026-09-26.md S1): only node 22.x (ryzen) prints this warning; node 24.x/26.x
 * (A2000/M4a) are silent, so on those hosts this filter simply has nothing to drop.
 */
export function installSqliteWarningFilter(target: NodeJS.Process = process): void {
  if (installed) return;
  installed = true;

  const previousListeners = target.listeners('warning') as ((warning: Error) => void)[];
  target.removeAllListeners('warning');
  target.on('warning', (warning: Error) => {
    if (isSqliteExperimentalWarning(warning)) return; // drop: expected, not an error
    for (const listener of previousListeners) listener(warning);
  });
}

/** Test/teardown helper: undoes installSqliteWarningFilter's `installed` guard. */
export function _resetSqliteWarningFilterForTests(): void {
  installed = false;
}
