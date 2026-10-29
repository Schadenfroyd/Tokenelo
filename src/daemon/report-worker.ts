import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { openLedgerReadOnly } from '../store/db.js';
import { createPricingEngine } from '../core/pricing.js';
import { checkRead } from '../core/read-control.js';
import { compareBuildIdentities, hasCompleteBuildIdentity, loadBuildIdentity } from './build-identity.js';
import type { ReportReadConfiguration, ReportTask } from './report-read-protocol.js';

const port = parentPort;
if (!port) throw new Error('report-worker requires its owned parent');
const { configuration, task, asOf, maxResultBytes } = workerData as {
  configuration: ReportReadConfiguration; task: ReportTask; asOf: number; maxResultBytes: number;
};
const buildIdentity = loadBuildIdentity();
const buildIdentityRequired = hasCompleteBuildIdentity(configuration.buildIdentity);
const buildIdentityState = compareBuildIdentities(configuration.buildIdentity, buildIdentity);
const controller = new AbortController();
const children = new Set<ReturnType<typeof childProcess.execFile>>();
// Reports use read-only discovery children. Track only this worker's execFile calls;
// stop and await those direct children before retiring the thread. Nothing in the daemon's
// collector process is patched or killed. Builtin export synchronization is worker-local.
const execFile = childProcess.execFile;
const trackChild = (child: ReturnType<typeof childProcess.execFile>) => {
  children.add(child); child.once('close', () => children.delete(child));
  if (controller.signal.aborted) child.kill('SIGKILL');
  return child;
};
childProcess.execFile = function (...args: Parameters<typeof childProcess.execFile>) {
  return trackChild(Reflect.apply(execFile, childProcess, args));
} as typeof childProcess.execFile;
// Use the tracked callback form for promisification as well. A process preload may already
// provide a compatible {stdout, stderr} Promise without Node's optional `.child` property;
// invoking that custom Promise would bypass tracking or misidentify an absent child.
Object.defineProperty(childProcess.execFile, promisify.custom, {
  value: (...args: unknown[]) => {
    let child!: ReturnType<typeof childProcess.execFile>;
    const pending = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolve, reject) => {
      child = Reflect.apply(childProcess.execFile, childProcess, [...args,
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          if (error) { Object.assign(error, { stdout, stderr }); reject(error); }
          else resolve({ stdout, stderr });
        },
      ]);
    });
    return Object.assign(pending, { child });
  },
});
syncBuiltinESMExports();
port.on('message', (message: { type?: string }) => {
  if (message.type !== 'cancel') return;
  controller.abort(new Error('read_cancelled'));
  for (const child of children) child.kill('SIGKILL');
});

let db: ReturnType<typeof openLedgerReadOnly> | undefined;
const operationStarted = performance.now();
let reply: { type: 'result'; json: string; buildIdentity: typeof buildIdentity }
  | { type: 'failure'; code: string; buildIdentity: typeof buildIdentity };
try {
  // A revision-bound parent must never accept a report from a missing or different package.
  // Unknown development identities remain usable but are never represented as a match.
  if (buildIdentityRequired && buildIdentityState !== 'matching' && buildIdentityState !== 'matching-dirty') {
    throw new Error('report worker build identity mismatch');
  }
  // Load consumers after installing the worker-local wrapper, so their module-level
  // promisify(execFile) captures the tracked custom implementation.
  const { createQueries } = await import('../store/queries.js');
  const pricing = createPricingEngine(configuration.priceRows);
  if (pricing.version !== configuration.pricesVersion) throw new Error('read pricing identity mismatch');
  db = openLedgerReadOnly(configuration.dbFile,{snapshot:true});
  db.exec('PRAGMA query_only=ON');
  db.prepare('SELECT 1 FROM events LIMIT 1').get();
  // This one worker-owned handle and transaction backs every phase, including legacy detail
  // and Timeseries queries. Paging/yields occur on the worker, never on capture's event loop.
  const queries = createQueries(db, configuration.config, { now: () => asOf, pricing,
    readSnapshotDb: db, readSignal: controller.signal, fixedSessionReportAsOf: asOf });
  const control = { signal: controller.signal,
    onProgress: (phase: import('../core/read-control.js').ReadProgressPhase) => port.postMessage({ type: 'progress', phase }),
    onDiagnosticPhase: (phase: import('../core/read-control.js').DiagnosticReadPhase) => port.postMessage({
      type: 'diagnostic', phase, workerElapsedMs: performance.now() - operationStarted }) };
  checkRead(controller.signal);
  let result;
  switch (task.kind) {
    case 'summary': result = await queries.getSummary(task.range, control); break;
    case 'usage': {
      // Both consumers use this same already-pinned read-only handle, configuration and asOf.
      const summary = await queries.getSummary(task.range, control);
      checkRead(controller.signal);
      const bucket = task.range === 'today' || task.range === '24h' ? 'hour' : 'day';
      const timeseries = await queries.getTimeseries(bucket, task.range, control);
      result = { snapshotScope: 'shared-read-transaction', summary, timeseries };
      break;
    }
    case 'sessions': result = await queries.getSessions(task.opts, control); break;
    case 'timeseries': result = await queries.getTimeseries(task.bucket, task.range, control); break;
    case 'doctor': result = await queries.getDoctor(control); break;
    case 'detail': result = await queries.getSessionDetail(task.source, task.sessionId, control); break;
    default: throw new Error('unsupported report read');
  }
  checkRead(controller.signal);
  const json = JSON.stringify(result);
  reply = Buffer.byteLength(json) > maxResultBytes
    ? { type: 'failure', code: 'result_too_large', buildIdentity }
    : { type: 'result', json, buildIdentity };
} catch {
  reply = { type: 'failure', code: 'query_failed', buildIdentity };
} finally {
  try { if (db) { try { db.exec('ROLLBACK'); } finally { db.close(); } } }
  catch { reply = { type: 'failure', code: 'query_failed', buildIdentity }; }
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => new Promise<void>(resolve => child.once('close', () => resolve()))));
}
port.postMessage({ ...reply!, workerOperationMs: performance.now() - operationStarted });
port.close();
