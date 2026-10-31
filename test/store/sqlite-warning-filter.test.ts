import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { installSqliteWarningFilter, _resetSqliteWarningFilterForTests } from '../../src/core/log.js';

/**
 * spikes-2026-09-26.md S1: node 22.x (ryzen) prints
 *   "ExperimentalWarning: SQLite is an experimental feature and might change at any time"
 * on every process start; node 24.x/26.x (A2000/M4a) are silent. installSqliteWarningFilter must
 * drop only that specific warning and pass every other 'warning' event through untouched — it
 * must not use `removeAllListeners` + never re-add (which would silently eat unrelated warnings
 * too, e.g. deprecation warnings doctor should still see).
 */
function fakeProcess() {
  return new EventEmitter() as unknown as NodeJS.Process;
}

function sqliteExperimentalWarning(): Error {
  const w = new Error('SQLite is an experimental feature and might change at any time');
  w.name = 'ExperimentalWarning';
  return w;
}

describe('installSqliteWarningFilter', () => {
  beforeEach(() => {
    _resetSqliteWarningFilterForTests();
  });

  it('drops the node:sqlite ExperimentalWarning', () => {
    const proc = fakeProcess();
    const seen: Error[] = [];
    proc.on('warning', (w: Error) => seen.push(w));

    installSqliteWarningFilter(proc);
    proc.emit('warning', sqliteExperimentalWarning());

    expect(seen).toHaveLength(0);
  });

  it('passes every other warning through to the previously-registered listener(s)', () => {
    const proc = fakeProcess();
    const seen: Error[] = [];
    proc.on('warning', (w: Error) => seen.push(w));

    installSqliteWarningFilter(proc);

    const deprecation = new Error('something else is deprecated');
    deprecation.name = 'DeprecationWarning';
    proc.emit('warning', deprecation);

    const otherExperimental = new Error('WebSocket is an experimental feature');
    otherExperimental.name = 'ExperimentalWarning';
    proc.emit('warning', otherExperimental);

    expect(seen).toEqual([deprecation, otherExperimental]);
  });

  it('preserves multiple pre-existing listeners (re-dispatches to all of them)', () => {
    const proc = fakeProcess();
    const seenA: Error[] = [];
    const seenB: Error[] = [];
    proc.on('warning', (w: Error) => seenA.push(w));
    proc.on('warning', (w: Error) => seenB.push(w));

    installSqliteWarningFilter(proc);
    const deprecation = new Error('x');
    deprecation.name = 'DeprecationWarning';
    proc.emit('warning', deprecation);

    expect(seenA).toEqual([deprecation]);
    expect(seenB).toEqual([deprecation]);
  });

  it('is idempotent: a second install call does not double-dispatch', () => {
    const proc = fakeProcess();
    const seen: Error[] = [];
    proc.on('warning', (w: Error) => seen.push(w));

    installSqliteWarningFilter(proc);
    installSqliteWarningFilter(proc); // no-op per the `installed` guard

    const deprecation = new Error('x');
    deprecation.name = 'DeprecationWarning';
    proc.emit('warning', deprecation);

    expect(seen).toEqual([deprecation]);
  });
});
