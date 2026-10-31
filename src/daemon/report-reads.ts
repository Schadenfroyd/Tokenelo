import { performance } from 'node:perf_hooks';
import { ReportProcess } from './report-process.js';
import { DETAIL_READ_PHASES, DOCTOR_READ_PHASES, SESSION_READ_PHASES, SUMMARY_READ_PHASES, TIMESERIES_READ_PHASES, type DiagnosticReadPhase, type ReadControl } from '../core/read-control.js';
const DIAGNOSTIC_READ_PHASES = [...DETAIL_READ_PHASES, ...DOCTOR_READ_PHASES, ...SESSION_READ_PHASES, ...SUMMARY_READ_PHASES, ...TIMESERIES_READ_PHASES];
import type { Queries } from '../store/queries.js';
import type { Range } from '../core/types.js';
import { compareBuildIdentities, hasCompleteBuildIdentity } from './build-identity.js';
import { ReportReadError, type ReportReadConfiguration, type ReportTask, type ReportResults, type ReportReadErrorCode } from './report-read-protocol.js';

/** Admission budgets include queue/start/operation. Cancellation cleanup can outlast the
 * response deadline and holds capacity until proved retirement or quarantine. No SLO; client20s. */
export const REPORT_READ_BUDGET_MS = 18_500;
export const REPORT_READ_CANCEL_GRACE_MS = 1_000;
export const REPORT_READ_MAX_BYTES = 64 * 1024 ** 2;
/** Content-free wall-duration observations. Different threads' clocks are never subtracted.
 * Worker time excludes module startup; admission-to-retirement includes queueing, startup,
 * parent delivery and cleanup. Neither value is CPU attribution or an SLO. */
export interface ReportReadObservation {
  kind: ReportTask['kind'];
  /** Allowlisted requested period only; no dates, filters, sessions or caller/worker contents. */
  range: Range | null;
  outcome: 'completed' | ReportReadErrorCode;
  budgetMs: number;
  admissionToRetirementMs: number;
  queuedMs: number;
  workerOperationMs: number | null;
  workerStarted: boolean;
  lastDiagnosticPhase: DiagnosticReadPhase | null;
  /** Parent receipt-to-retirement wall time, not worker CPU or phase duration. */
  sinceLastDiagnosticMs: number | null;
  /** Bounded static labels, with elapsed times measured separately on each thread.
   * Worker elapsed is measured at phase entry; parent elapsed is measured at receipt.
   * Includes receipts during cancellation cleanup. Neither is CPU attribution. */
  diagnosticPhases: Array<{ phase: DiagnosticReadPhase; workerElapsedMs: number; parentElapsedMs: number }>;
}
export interface ReportReadsOptions {
  workers?: number;
  waiting?: number;
  budgetMs?: number;
  cancelGraceMs?: number;
  maxResultBytes?: number;
  /** Test seam for real worker fixtures; production always uses report-worker. */
  workerUrl?: URL;
  /** One observation after each admitted read actually retires, including cancelled queued work. */
  onRetired?: (observation: ReportReadObservation) => void;
}
interface ReadJob {
  task: ReportTask;
  asOf: number;
  worker?: ReportProcess;
  result?: string;
  failed?: ReportReadError;
  admittedAt: number;
  dispatchedAt?: number;
  workerOperationMs?: number;
  lastDiagnosticPhase?: DiagnosticReadPhase;
  lastDiagnosticAt?: number;
  diagnosticPhases?: Map<DiagnosticReadPhase, { phase: DiagnosticReadPhase; workerElapsedMs: number; parentElapsedMs: number }>;
  lastDiagnosticWorkerElapsedMs?: number;
  budgetMs: number;
  cancelling?: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  control?: ReadControl;
  resolve: (value: unknown) => void;
  reject: (error: ReportReadError) => void;
  finished: Promise<void>;
  finish: () => void;
  cleanupFault: Promise<ReportReadError>;
  failCleanup: (error: ReportReadError) => void;
}

/** Independent reads; capacity retires only after the owned report process tree/group. */
export class ReportReads {
  private readonly jobs = new Set<ReadJob>();
  private readonly queue: ReadJob[] = [];
  private readonly configuration: ReportReadConfiguration;
  private closed = false;
  private quarantined = false;
  private draining = false;
  private readonly workers: number;
  private readonly waiting: number;
  private readonly budgetMs: number;
  private readonly cancelGraceMs: number;
  private readonly maxResultBytes: number;
  private readonly buildIdentityRequired: boolean;
  constructor(configuration: ReportReadConfiguration, private readonly opts: ReportReadsOptions = {}) {
    this.configuration = structuredClone(configuration);
    this.buildIdentityRequired = hasCompleteBuildIdentity(this.configuration.buildIdentity);
    this.workers = bounded(opts.workers ?? 2, 1, 4);
    this.waiting = bounded(opts.waiting ?? 4, 0, 16);
    this.budgetMs = bounded(opts.budgetMs ?? REPORT_READ_BUDGET_MS, 1, 60_000);
    this.cancelGraceMs = bounded(opts.cancelGraceMs ?? REPORT_READ_CANCEL_GRACE_MS, 1, 10_000);
    this.maxResultBytes = bounded(opts.maxResultBytes ?? REPORT_READ_MAX_BYTES, 1, REPORT_READ_MAX_BYTES);
  }
  read<T extends ReportTask>(task: T, control?: ReadControl, budgetMs = this.budgetMs): Promise<ReportResults[T['kind']]> {
    return this.enqueue(task, control, budgetMs, false);
  }
  /** Range-job serialization must wait for cancellation cleanup, even though its subscriber
   * status/deadline is already settled. Ordinary HTTP reads keep their immediate rejection. */
  readAfterRetirement<T extends ReportTask>(task: T, control?: ReadControl, budgetMs = this.budgetMs): Promise<ReportResults[T['kind']]> {
    return this.enqueue(task, control, budgetMs, true);
  }
  private enqueue<T extends ReportTask>(task: T, control: ReadControl | undefined, budgetMs: number, waitForRetirement: boolean): Promise<ReportResults[T['kind']]> {
    if (control?.signal?.aborted) return Promise.reject(new ReportReadError('read_cancelled'));
    if (this.closed || this.quarantined) return Promise.reject(new ReportReadError('read_unavailable'));
    if (this.jobs.size >= this.workers + this.waiting) return Promise.reject(new ReportReadError('read_capacity'));
    bounded(budgetMs, 1, 60_000);
    let resolve!: ReadJob['resolve'], reject!: ReadJob['reject'], finish!: () => void;
    const response = new Promise<unknown>((ok, no) => { resolve = ok; reject = no; });
    const finished = new Promise<void>(ok => { finish = ok; });
    let failCleanup!: ReadJob['failCleanup'];
    const cleanupFault = new Promise<ReportReadError>(resolve => { failCleanup = resolve; });
    const job: ReadJob = { task: structuredClone(task), asOf: Date.now(), control, resolve, reject, finished, finish, settled: false,
      admittedAt: performance.now(), budgetMs, cleanupFault, failCleanup };
    this.jobs.add(job); this.queue.push(job);
    job.abort = () => this.cancel(job, new ReportReadError('read_cancelled'));
    control?.signal?.addEventListener('abort', job.abort, { once: true });
    job.timer = setTimeout(() => this.cancel(job, new ReportReadError('read_timeout')), budgetMs);
    if (control?.signal?.aborted) job.abort();
    this.drain();
    const reply = response as Promise<ReportResults[T['kind']]>;
    return waitForRetirement ? reply.then(
      async value => { await this.waitForRetirement(job); return value; },
      async error => { await this.waitForRetirement(job); throw error; },
    ) : reply;
  }
  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.jobs];
    for (const job of pending) this.cancel(job, new ReportReadError('read_cancelled'));
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(pending.map(job => this.waitForRetirement(job))),
        new Promise<never>((_resolve, reject) => { guard = setTimeout(() => {
          this.quarantined = true;
          const error = new ReportReadError('read_unavailable');
          for (const job of pending) job.failCleanup(error);
          reject(error);
        }, REPORT_READ_BUDGET_MS); })]);
    } finally { clearTimeout(guard); }
  }
  private async waitForRetirement(job: ReadJob): Promise<void> {
    const fault = await Promise.race([job.finished.then(() => undefined), job.cleanupFault]);
    if (fault) throw fault;
  }
  private cancel(job: ReadJob, error: ReportReadError): void {
    if (!this.jobs.has(job) || job.cancelling) return;
    job.cancelling = true; job.failed ??= error;
    if (!job.settled) { job.settled = true; job.reject(job.failed); }
    if (!job.worker) { this.retire(job); return; }
    job.worker.postMessage({ type: 'cancel' });
    // Cooperative cancellation closes snapshots and owned Git/probe children first. If a worker cannot
    // yield, stop its owned process tree; keep its slot until native job/group retirement.
    job.killTimer = setTimeout(() => { void job.worker?.terminate().catch(() => {}); }, this.cancelGraceMs);
  }
  private drain(): void {
    if (this.closed || this.quarantined || this.draining) return;
    this.draining = true;
    try { while ([...this.jobs].filter(job => job.worker !== undefined).length < this.workers && this.queue.length) {
      const job = this.queue.shift()!;
      if (!this.jobs.has(job)) continue;
      try {
        const workerData = { configuration: this.configuration, task: job.task, asOf: job.asOf, maxResultBytes: this.maxResultBytes };
        const url = this.opts.workerUrl ?? new URL('./report-worker.js', import.meta.url);
        job.dispatchedAt = performance.now();
        // A helper owns containment outside the Worker and survives a blocked native call.
        // Compiled daemons need no loader; isolated development uses declared tsx only.
        const worker = new ReportProcess(url, workerData, this.maxResultBytes);
        job.worker = worker;
        worker.on('message', (message: { type: string; json?: string; code?: string; workerOperationMs?: number;
          phase?: string; workerElapsedMs?: number; buildIdentity?: unknown }) => {
          if ((message.type === 'result' || message.type === 'failure') && typeof message.workerOperationMs === 'number'
            && Number.isFinite(message.workerOperationMs) && message.workerOperationMs >= 0) job.workerOperationMs = message.workerOperationMs;
          if (message.type === 'diagnostic' && DIAGNOSTIC_READ_PHASES.some(phase => phase === message.phase)) {
            job.lastDiagnosticPhase = message.phase as DiagnosticReadPhase;
            job.lastDiagnosticAt = performance.now();
            if (typeof message.workerElapsedMs === 'number' && Number.isFinite(message.workerElapsedMs)
              && message.workerElapsedMs >= (job.lastDiagnosticWorkerElapsedMs ?? 0)) {
              job.lastDiagnosticWorkerElapsedMs = message.workerElapsedMs;
              job.diagnosticPhases ??= new Map();
              job.diagnosticPhases.set(job.lastDiagnosticPhase, { phase: job.lastDiagnosticPhase,
                workerElapsedMs: message.workerElapsedMs, parentElapsedMs: job.lastDiagnosticAt - job.admittedAt });
            }
          } else if (message.type === 'progress' && message.phase && !job.failed) {
            try { job.control?.onProgress?.(message.phase as import('../core/read-control.js').ReadProgressPhase); }
            catch { this.cancel(job, new ReportReadError('query_failed')); }
          } else if (message.type === 'result' && typeof message.json === 'string') {
            if (this.buildIdentityRequired) {
              const identityState = compareBuildIdentities(this.configuration.buildIdentity, message.buildIdentity);
              if (identityState !== 'matching' && identityState !== 'matching-dirty') {
                job.failed ??= new ReportReadError('query_failed');
                return;
              }
            }
            if (Buffer.byteLength(message.json) > this.maxResultBytes) job.failed = new ReportReadError('result_too_large');
            else job.result = message.json;
          } else if (message.type === 'failure') job.failed ??= new ReportReadError(message.code === 'result_too_large' ? 'result_too_large' : 'query_failed');
        });
        worker.on('error', () => { job.failed ??= new ReportReadError('read_unavailable'); });
        worker.once('quarantined', () => {
          this.quarantined = true;
          const error = new ReportReadError('read_unavailable'); job.failed ??= error;
          if (!job.settled) { job.settled = true; job.reject(error); }
          job.failCleanup(error);
          for (const waiting of [...this.queue]) this.cancel(waiting, error);
          // The owned job stays in capacity. No successor is spawned without cleanup proof.
        });
        worker.once('exit', code => {
          if (code !== 0 || job.result === undefined) job.failed ??= new ReportReadError('read_unavailable');
          if (!job.settled) {
            job.settled = true;
            if (job.failed || code !== 0 || job.result === undefined) job.reject(job.failed ?? new ReportReadError('read_unavailable'));
            else { try { job.resolve(JSON.parse(job.result)); } catch { job.failed = new ReportReadError('query_failed'); job.reject(job.failed); } }
          }
          this.retire(job);
        });
      } catch { job.failed = new ReportReadError('read_unavailable'); job.settled = true; job.reject(job.failed); this.retire(job); }
    } } finally { this.draining = false; }
  }
  private retire(job: ReadJob): void {
    if (!this.jobs.has(job)) return;
    clearTimeout(job.timer); clearTimeout(job.killTimer);
    if (job.abort) job.control?.signal?.removeEventListener('abort', job.abort);
    const queued = this.queue.indexOf(job); if (queued >= 0) this.queue.splice(queued, 1);
    this.jobs.delete(job); job.finish();
    const retiredAt = performance.now();
    try { this.opts.onRetired?.({ kind: job.task.kind, range: diagnosticRange(job.task), outcome: job.failed?.code ?? 'completed', budgetMs: job.budgetMs,
      admissionToRetirementMs: retiredAt - job.admittedAt, queuedMs: (job.dispatchedAt ?? retiredAt) - job.admittedAt,
      workerOperationMs: job.workerOperationMs ?? null, workerStarted: job.worker !== undefined,
      lastDiagnosticPhase: job.lastDiagnosticPhase ?? null,
      sinceLastDiagnosticMs: job.lastDiagnosticAt === undefined ? null : retiredAt - job.lastDiagnosticAt,
      diagnosticPhases: [...(job.diagnosticPhases?.values() ?? [])] }); }
    catch { /* Diagnostic sinks cannot change a report's result, cancellation, or slot cleanup. */ }
    this.drain();
  }
}
/** Diagnostics may record only the five public period labels, never arbitrary task strings. */
function diagnosticRange(task: ReportTask): Range | null {
  const candidate = task.kind === 'sessions' ? task.opts.range
    : task.kind === 'summary' || task.kind === 'usage' || task.kind === 'timeseries' ? task.range : undefined;
  return candidate === 'today' || candidate === '24h' || candidate === '7d' || candidate === '30d' || candidate === 'all'
    ? candidate : null;
}
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError('invalid report read budget or capacity');
  return value;
}

/** CLI/light operational queries retain their existing implementation. */
export function isolatedReportQueries(queries: Queries, reads: ReportReads, historicalReads?: ReportReads): Queries {
  return { ...queries,
    getUsage: (range, control) => reads.read({ kind: 'usage', range }, control),
    ...(historicalReads ? { getUsageReport: (range: import('../core/types.js').Range, control?: ReadControl) => historicalReads.readAfterRetirement({ kind: 'usage', range }, control) } : {}),
    ...(historicalReads ? { getSummaryReport: (range: import('../core/types.js').Range, control?: ReadControl) => historicalReads.readAfterRetirement({ kind: 'summary', range }, control) } : {}),
    getSummary: (range, control) => reads.read({ kind: 'summary', range }, control),
    getSessions: (opts, control) => reads.read({ kind: 'sessions', opts }, control),
    getTimeseries: (bucket, range, control) => reads.read({ kind: 'timeseries', bucket, range }, control),
    getSessionDetail: (source, sessionId, control) => reads.read({ kind: 'detail', source, sessionId }, control),
    getDoctor: control => reads.read({ kind: 'doctor' }, control),
  };
}

