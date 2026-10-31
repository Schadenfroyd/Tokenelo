import { describe, expect, it } from 'vitest';
import { SummaryReadJobs } from '../../src/daemon/summary-read-jobs.js';
import { ReportReads, isolatedReportQueries } from '../../src/daemon/report-reads.js';
import { ReportReadError, type ReportTask } from '../../src/daemon/report-read-protocol.js';
import type { ReadControl } from '../../src/core/read-control.js';
import type { Queries } from '../../src/store/queries.js';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}

describe('historical Summary/Usage range-job retirement adapter', () => {
  for (const variant of ['default', 'usage'] as const) {
    it('keeps a successor queued until the held read-after-retirement hook settles (' + variant + ')', async () => {
      const taskKind = variant === 'usage' ? 'usage' : 'summary';
      const calls: string[] = [];
      let firstCall = true, firstStartedAlready = false, cancellationSeen = false, successorStarted = false;
      let finishFirstRetirement: (() => void) | undefined;

      const historicalReads = {
        read(task: ReportTask, control?: ReadControl): Promise<unknown> {
          calls.push('read:' + task.kind);
          if (!firstCall) {
            successorStarted = true;
            return Promise.resolve({});
          }
          firstCall = false;
          firstStartedAlready = true;
          return new Promise((_resolve, reject) => {
            const cancel = () => {
              cancellationSeen = true;
              reject(new ReportReadError('read_cancelled'));
            };
            if (control?.signal?.aborted) cancel();
            else control?.signal?.addEventListener('abort', cancel, { once: true });
          });
        },
        readAfterRetirement(task: ReportTask, control?: ReadControl): Promise<unknown> {
          calls.push('readAfterRetirement:' + task.kind);
          if (!firstCall) {
            successorStarted = true;
            return Promise.resolve({});
          }
          firstCall = false;
          firstStartedAlready = true;
          return new Promise((_resolve, reject) => {
            finishFirstRetirement = () => reject(new ReportReadError('read_cancelled'));
            const cancel = () => { cancellationSeen = true; };
            if (control?.signal?.aborted) cancel();
            else control?.signal?.addEventListener('abort', cancel, { once: true });
          });
        },
      } as unknown as ReportReads;
      const queries = isolatedReportQueries({} as Queries, {} as ReportReads, historicalReads);
      const jobs = new SummaryReadJobs<unknown>((range, control, requestedVariant) =>
        requestedVariant === 'usage'
          ? queries.getUsageReport!(range, control) as Promise<unknown>
          : queries.getSummaryReport!(range, control) as Promise<unknown>);
      const firstLease = 'first-' + variant, nextLease = 'next-' + variant;
      try {
        const first = jobs.admit('30d', firstLease, variant);
        expect(first.status).toBe('queued');
        await until(() => firstStartedAlready);
        expect(firstStartedAlready).toBe(true);
        jobs.release(firstLease, variant);
        await until(() => cancellationSeen);
        expect(cancellationSeen).toBe(true);

        const next = jobs.admit('7d', nextLease, variant);
        expect(next.status).toBe('queued');
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(successorStarted).toBe(false);
        expect(jobs.poll(next.id, nextLease, variant)?.status).toBe('queued');
        expect(calls).toEqual(['readAfterRetirement:' + taskKind]);

        finishFirstRetirement?.();
        await until(() => successorStarted);
        expect(calls).toEqual(['readAfterRetirement:' + taskKind, 'readAfterRetirement:' + taskKind]);
      } finally {
        jobs.release(firstLease, variant);
        if (firstStartedAlready) finishFirstRetirement?.();
        jobs.release(nextLease, variant);
        await jobs.close();
      }
    });
  }
});
