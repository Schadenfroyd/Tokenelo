import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, LockHeldError, isProcessAlive, readLockInfo } from '../../src/daemon/lock.js';
import { getPaths } from '../../src/daemon/paths.js';

describe('lock', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshPaths() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-lock-'));
    return getPaths({ env: { TOKENELO_HOME: tmpDir } });
  }

  it('acquires the lock and writes {pid, port, startedAt} to the lock file', () => {
    const paths = freshPaths();
    const handle = acquireLock(paths, 47821, { pid: 4242, now: () => 1_700_000_000_000 });
    expect(handle.info).toEqual({ pid: 4242, port: 47821, startedAt: 1_700_000_000_000 });
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(readLockInfo(paths)).toEqual({ pid: 4242, port: 47821, startedAt: 1_700_000_000_000 });
    handle.release();
  });

  it('lock contention: a second acquire against a live pid throws LockHeldError, naming the holder', () => {
    const paths = freshPaths();
    const first = acquireLock(paths, 47821, { pid: process.pid }); // our own pid is definitely alive
    expect(() => acquireLock(paths, 47821, { pid: process.pid })).toThrow(LockHeldError);
    try {
      acquireLock(paths, 47821, { pid: process.pid });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      expect((err as LockHeldError).info.pid).toBe(process.pid);
      expect((err as LockHeldError).message).toContain(String(process.pid));
    }
    first.release();
  });

  it('release() then acquire() succeeds again (no stale contention)', () => {
    const paths = freshPaths();
    const first = acquireLock(paths, 47821, { pid: process.pid });
    first.release();
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    const second = acquireLock(paths, 47821, { pid: process.pid });
    expect(second.info.pid).toBe(process.pid);
    second.release();
  });

  it('a lock file whose pid is dead is stale: acquireLock removes it and succeeds instead of throwing', () => {
    const paths = freshPaths();
    // A pid essentially guaranteed not to exist on this machine.
    const deadPid = 999_999;
    expect(isProcessAlive(deadPid)).toBe(false);
    // Seed an actual ownerless diagnostic file. A live handle with a fake dead
    // PID still holds an OS lease, so it cannot represent a process crash.
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, JSON.stringify({ pid: deadPid, port: 47821, startedAt: 1 }));
    expect(fs.existsSync(paths.lockFile)).toBe(true);

    const recovered = acquireLock(paths, 47821, { pid: process.pid, now: () => 2 });
    expect(recovered.info.pid).toBe(process.pid);
    expect(readLockInfo(paths)?.pid).toBe(process.pid);
    recovered.release();
  });

  it('mutation check: if the stale-lock path were removed, a dead-pid lock would incorrectly throw LockHeldError', () => {
    // This isn't a source mutation, but it directly exercises the discriminating condition
    // (isProcessAlive) that the stale-recovery branch depends on: a dead pid must NOT be treated
    // as held, while a live one (previous tests) must be.
    expect(isProcessAlive(999_999)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('readLockInfo returns null when no lock file exists', () => {
    const paths = freshPaths();
    expect(readLockInfo(paths)).toBeNull();
  });

  it('a corrupt lock file is treated as stale and overwritten rather than crashing', () => {
    const paths = freshPaths();
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.lockFile, 'not json{{{');
    const handle = acquireLock(paths, 47821, { pid: process.pid });
    expect(handle.info.pid).toBe(process.pid);
    handle.release();
  });
});
