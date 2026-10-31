import crypto from 'node:crypto';
import type { Range } from '../core/types.js';
import type { ReadControl, ReadProgressPhase } from '../core/read-control.js';
import { ReportReadError } from './report-read-protocol.js';

export const READ_JOB_LEASE_MS = 15_000;
export type ReadJobVariant = 'default' | 'usage';
export type ReadJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface RangeJobReply<T> {
  budgetMs: number;
  id: string; range: Range; status: ReadJobStatus; phase?: ReadProgressPhase;
  result?: T; error?: 'read_timeout' | 'query_failed' | 'result_too_large';
}
interface Job<T> {
  id: string; range: Range; variant: ReadJobVariant; key: string; status: ReadJobStatus; controller: AbortController;
  created: number; finished?: number; phase?: ReadProgressPhase; result?: T;
  error?: RangeJobReply<T>['error']; bytes: number; leases: Map<string, number>;
}
export class RangeJobCapacityError extends Error {}

/** Ephemeral computation only: one active report, two waiting, eight records, 16 MiB retained results. */
export class RangeReadJobs<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private readonly byRange = new Map<string, Job<T>>();
  private readonly leases = new Map<string, Job<T>>();
  private active: Promise<void> | undefined;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly read: (range: Range, control: ReadControl, variant?: ReadJobVariant) => Promise<T>,
    private readonly budgetMs: number, private readonly now: () => number = Date.now) {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000) throw new RangeError('invalid report job budget');
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }
  admit(range: Range, lease: string, variant: ReadJobVariant = 'default'): RangeJobReply<T> {
    if (variant !== 'default' && variant !== 'usage') throw new RangeError('invalid report job variant');
    const key = `${variant}:${range}`;
    this.sweep();
    if (this.closed) throw new RangeJobCapacityError('read service is closing');
    const existingLease = this.leases.get(lease);
    if (existingLease) {
      if (existingLease.range !== range || existingLease.variant !== variant) throw new RangeJobCapacityError('lease already belongs to another range');
      existingLease.leases.set(lease, this.now()); return this.reply(existingLease);
    }
    let job = this.byRange.get(key);
    if (this.leases.size >= 32 || (job && job.leases.size >= 8)) throw new RangeJobCapacityError('read subscriber capacity reached');
    if (!job) {
      if (this.jobs.size >= 8 || [...this.jobs.values()].filter(j => j.status === 'queued').length >= 2)
        throw new RangeJobCapacityError('read capacity reached');
      job = { id: crypto.randomBytes(16).toString('hex'), range, variant, key, status: 'queued',
        controller: new AbortController(), created: this.now(), bytes: 0, leases: new Map() };
      this.jobs.set(job.id, job); this.byRange.set(key, job);
    }
    job.leases.set(lease, this.now()); this.leases.set(lease, job);
    setImmediate(() => this.drain());
    return this.reply(job);
  }
  poll(id: string, lease: string, variant: ReadJobVariant = 'default'): RangeJobReply<T> | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.variant !== variant || this.leases.get(lease) !== job) return undefined;
    job.leases.set(lease, this.now()); return this.reply(job);
  }
  release(lease: string, variant: ReadJobVariant = 'default'): void {
    const job = this.leases.get(lease);
    if (!job || job.variant !== variant) return;
    this.leases.delete(lease); job.leases.delete(lease);
    if (!job.leases.size) {
      if (job.status === 'queued' || job.status === 'running') this.cancel(job);
      else this.forget(job);
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    for (const job of this.jobs.values()) this.cancel(job);
    await this.active;
    this.jobs.clear(); this.leases.clear(); this.byRange.clear();
  }
  private reply(job: Job<T>): RangeJobReply<T> {
    return { id: job.id, range: job.range, status: job.status, budgetMs: this.budgetMs,
      ...(job.phase ? { phase: job.phase } : {}), ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}) };
  }
  private cancel(job: Job<T>, error?: RangeJobReply<T>['error']): void {
    if (job.status !== 'queued' && job.status !== 'running') return;
    job.status = error ? 'failed' : 'cancelled'; job.error = error; job.finished = this.now();
    if (this.byRange.get(job.key) === job) this.byRange.delete(job.key);
    job.controller.abort(new Error(error ?? 'read_cancelled'));
  }
  private forget(job: Job<T>): void {
    this.jobs.delete(job.id);
    if (this.byRange.get(job.key) === job) this.byRange.delete(job.key);
    for (const lease of job.leases.keys()) this.leases.delete(lease);
    job.leases.clear(); job.result = undefined; job.bytes = 0;
  }
  private sweep(): void {
    const now = this.now();
    for (const job of this.jobs.values()) {
      for (const [lease, seen] of job.leases) if (now - seen >= READ_JOB_LEASE_MS) this.release(lease, job.variant);
      if ((job.status === 'queued' || job.status === 'running') && now - job.created >= this.budgetMs)
        this.cancel(job, 'read_timeout');
      if (job.finished !== undefined && now - job.finished >= 30_000) this.forget(job);
    }
  }
  private drain(): void {
    if (this.closed || this.active) return;
    const job = [...this.jobs.values()].find(j => j.status === 'queued' && j.leases.size);
    if (!job) return;
    job.status = 'running';
    this.active = (async () => {
      try {
        const control = { signal: job.controller.signal,
          onProgress: (phase: ReadProgressPhase) => { if (job.status === 'running') job.phase = phase; } };
        const result = job.variant === 'default' ? await this.read(job.range, control)
          : await this.read(job.range, control, job.variant);
        if (job.controller.signal.aborted) return;
        const bytes = Buffer.byteLength(JSON.stringify(result));
        const retained = [...this.jobs.values()].reduce((sum, j) => sum + j.bytes, 0);
        if (bytes > 8 * 1024 ** 2 || retained + bytes > 16 * 1024 ** 2) {
          job.status = 'failed'; job.error = 'result_too_large';
        } else { job.result = result; job.bytes = bytes; job.status = 'completed'; }
      } catch (error) {
        if (!job.controller.signal.aborted) {
          job.status = 'failed';
          job.error = error instanceof ReportReadError && (error.code === 'read_timeout' || error.code === 'result_too_large')
            ? error.code : 'query_failed';
        }
      } finally {
        job.finished = this.now();
        if (this.byRange.get(job.key) === job) this.byRange.delete(job.key);
        if (!job.leases.size) this.forget(job);
      }
    })().finally(() => { this.active = undefined; this.drain(); });
  }
}
