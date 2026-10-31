import { expect, it } from 'vitest';
import { completeOwnedShutdown, type OwnedShutdownPlan } from '../../src/daemon/main.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

it('keeps listeners, ledger, and startup ownership open until report retirement is proved', async () => {
  const drain = deferred<void>();
  const retirement = deferred<void>();
  const started = deferred<void>();
  const events: string[] = [];
  const plan: OwnedShutdownPlan = {
    stopReadAdmission: () => { events.push('read-admission-stopped'); },
    drain: [() => { events.push('drain-started'); return drain.promise; }],
    reportReaders: [() => { started.resolve(); return retirement.promise; }],
    readServices: [async () => { events.push('read-services-closed'); }],
    listeners: [async () => { events.push('listeners-closed'); }],
    closeRuntime: async () => { events.push('database-closed'); },
    releaseLock: () => { events.push('lock-released'); },
    retainOwnership: () => { events.push('ownership-retained'); },
  };
  const shutdown = completeOwnedShutdown(plan).then(() => { events.push('successful-exit'); });
  await started.promise;
  expect(events).toEqual(['read-admission-stopped', 'drain-started']);
  retirement.resolve();
  await Promise.resolve();
  expect(events).toEqual(['read-admission-stopped', 'drain-started']);
  drain.resolve();
  await shutdown;
  expect(events).toEqual(['read-admission-stopped', 'drain-started', 'read-services-closed', 'listeners-closed', 'database-closed', 'lock-released', 'successful-exit']);
});

it('remains fail-closed when a held reader is quarantined without retirement proof', async () => {
  const retirement = deferred<void>();
  const started = deferred<void>();
  const events: string[] = [];
  const plan: OwnedShutdownPlan = {
    stopReadAdmission: () => { events.push('read-admission-stopped'); },
    drain: [],
    reportReaders: [() => { started.resolve(); return retirement.promise; }],
    readServices: [async () => { events.push('read-services-closed'); }],
    listeners: [async () => { events.push('listeners-closed'); }],
    closeRuntime: async () => { events.push('database-closed'); },
    releaseLock: () => { events.push('lock-released'); },
    retainOwnership: () => { events.push('ownership-retained'); },
  };
  let successfulExit = false;
  const shutdown = completeOwnedShutdown(plan).then(() => { successfulExit = true; });
  await started.promise;
  expect(events).toEqual(['read-admission-stopped']);
  retirement.reject(new Error('owned reader quarantined'));
  await expect(shutdown).rejects.toThrow('Report worker retirement unproved');
  expect(events).toEqual(['read-admission-stopped', 'ownership-retained']);
  expect(successfulExit).toBe(false);
});

