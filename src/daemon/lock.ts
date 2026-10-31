/**
 * Single-instance startup ownership (DESIGN15.7.5). A separate private SQLite
 * sidecar holds an EXCLUSIVE rollback-mode transaction before inspecting or
 * recovering the diagnostic JSON lock. The persistent sidecar is never unlinked;
 * OS process exit releases its kernel locks, without trusting a diagnostic PID.
 * The API's own exclusive port bind remains a separate required safeguard.
 * Legacy live JSON owners are respected. Stale/corrupt diagnostics are recovered
 * only while this connection owns the sidecar. Release checks the exact created
 * inode and JSON generation, then closes the lease. No metering DB is opened here.
 * Callers must retain ownership until capture/read/listener resources are closed.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { TokeneloPaths } from './paths.js';

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
}

export class LockHeldError extends Error {
  constructor(public readonly info: LockInfo, lockFile: string, kernelOwnerUnknown = false) {
    super(
      kernelOwnerUnknown ? `Tokenelo startup ownership is already held (lock file ${lockFile}); diagnostic owner information is unavailable or stale.`
        : `tokenelo daemon already running: pid ${info.pid}, port ${info.port}, started ${new Date(info.startedAt).toISOString()} (lock file ${lockFile}).`
    );
    this.name = 'LockHeldError';
  }
}

export interface LockHandle {
  readonly info: LockInfo;
  /** Retain this handle while owned resources run. Removes only its diagnostic
   * generation and closes its lease; safe to call more than once. */
  release(): void;
}

/** True if `pid` names a live process we (this OS user) can see. Never throws. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 does not deliver a signal; it only checks whether the process exists and is
    // signalable by us. Throws ESRCH (no such process) or EPERM (exists, owned by someone else —
    // still counts as "alive" for our purposes: we must not steal it).
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false; // ESRCH, or anything else we don't recognize as "alive"
  }
}

function readLockFileRaw(lockFile: string): LockInfo | null {
  let text: string;
  try {
    text = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt ?? 0 };
  } catch {
    return null; // corrupt lock file — treat like "no usable info", acquireLock will just steal it
  }
}

/** Reads the current lock file without acquiring anything (for `tokenelo doctor` / introspection). */
export function readLockInfo(paths: TokeneloPaths): LockInfo | null {
  return readLockFileRaw(paths.lockFile);
}

/**
 * Atomically creates `paths.lockFile`. Throws `LockHeldError` if a live process already holds it;
 * removes and retries once if the existing lock is stale (pid no longer alive). `port` is
 * recorded for diagnostics only — this function does not touch the network.
 */
export function acquireLock(
  paths: TokeneloPaths,
  port: number,
  opts?: { pid?: number; now?: () => number }
): LockHandle {
  const pid = opts?.pid ?? process.pid;
  const now = opts?.now ?? (() => Date.now());
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });

  // This separate, persistent sidecar carries OS-backed SQLite exclusion before
  // stale JSON inspection. Never unlink it: replacing a locked inode would let
  // another process obtain a different lease. No metering ledger is opened here.
  // On POSIX, do not raw-open/read/close this inode while this process owns it:
  // an unrelated fd close can drop fcntl locks. Exclude it from in-process backup
  // and support reads; metadata lstat does not open a descriptor.
  const leaseFile = paths.lockFile + '.lease.sqlite';
  let lease: DatabaseSync | undefined;
  try {
    try { const fd=fs.openSync(leaseFile,'wx',0o600);fs.closeSync(fd); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat=fs.lstatSync(leaseFile,{bigint:true});
    // This protocol never commits pages: a normal lease is an empty, single-link
    // file without journal siblings. Validate before chmod or SQLite recovery.
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size!==0n || stat.nlink!==1n
      || ['-journal','-wal','-shm'].some(suffix=>fs.existsSync(leaseFile+suffix))) {
      throw new Error('Unexpected startup ownership sidecar; preserve its bytes and siblings for recovery');
    }
    if (process.platform !== 'win32') fs.chmodSync(leaseFile,0o600);
    lease=new DatabaseSync(leaseFile,{timeout:0});
    // No pages are committed by this ownership connection. A memory journal
    // avoids transient disk journals while still retaining the OS file lock.
    const mode=lease.prepare('PRAGMA journal_mode=MEMORY').get();
    if(mode?.journal_mode!=='memory')throw new Error('Startup ownership memory journal mode unavailable; preserve sidecar for recovery');
    lease.exec('BEGIN EXCLUSIVE;');
    const current=fs.lstatSync(leaseFile,{bigint:true});
    if(current.isSymbolicLink()||current.dev!==stat.dev||current.ino!==stat.ino)throw new Error('Startup ownership sidecar identity changed; preserve it for recovery');
    // An unexpected database is recovery evidence, never a disposable lock.
    const schema=lease.prepare('SELECT count(*) AS count FROM sqlite_schema').get();
    if (schema?.count !== 0) throw new Error('Startup ownership sidecar contains unexpected schema; preserve it for recovery');
  } catch(error) {
    try { lease?.close(); } catch { /* retain the original acquisition error */ }
    const native=error as {code?:unknown;errcode?:unknown};
    const sqliteCode=typeof native.errcode==='number'?native.errcode&255:0;
    if(native.code==='ERR_SQLITE_ERROR'&&(sqliteCode===5||sqliteCode===6)) {
      let existing:LockInfo|null=null;try { existing=readLockFileRaw(paths.lockFile); } catch { /* owner unknown */ }
      throw new LockHeldError(existing??{pid:0,port,startedAt:0},paths.lockFile,!existing||!isProcessAlive(existing.pid));
    }
    throw error;
  }
  const ownershipLease=lease;

  const tryCreate = (): LockHandle => {
    const info: LockInfo = { pid, port, startedAt: now() };
    // O_EXCL: fails with EEXIST if the file already exists — the atomic test-and-set that makes
    // this a real mutual-exclusion primitive rather than a check-then-write race.
    const fd = fs.openSync(paths.lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    let identity:fs.BigIntStats|undefined;const ownedText=JSON.stringify(info);
    let writeError:unknown, closeError:unknown;
    try {
      identity=fs.fstatSync(fd,{bigint:true});
      fs.writeFileSync(fd, ownedText);
    } catch(error) { writeError=error; }
    // Never retry close: the descriptor may already have closed and been reused.
    try { fs.closeSync(fd); } catch(error) { closeError=error; }
    if(writeError!==undefined || closeError!==undefined) {
      // Cleanup remains under the kernel lease and only removes our inode.
      try { const current=fs.lstatSync(paths.lockFile,{bigint:true});if(identity&&current.dev===identity.dev&&current.ino===identity.ino)fs.rmSync(paths.lockFile,{force:true}); } catch { /* preserve uncertain evidence */ }
      if(writeError!==undefined && closeError!==undefined)throw new AggregateError([writeError,closeError],String(writeError),{cause:writeError});
      throw writeError ?? closeError;
    }
    let released = false;
    return {
      info,
      release() {
        if (released) return;
        released = true;
        try {
          const current=fs.lstatSync(paths.lockFile,{bigint:true});
          if(identity&&current.dev===identity.dev&&current.ino===identity.ino&&fs.readFileSync(paths.lockFile,'utf8')===ownedText)fs.rmSync(paths.lockFile,{force:true});
        } catch {
          // best-effort on shutdown
        } finally {
          ownershipLease.close();
        }
      },
    };
  };

  try {
    try {
      return tryCreate();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

  // Lock file exists — is its owner still alive?
  const existing = readLockFileRaw(paths.lockFile);
  if (existing && isProcessAlive(existing.pid)) {
    throw new LockHeldError(existing, paths.lockFile);
  }

  // Stale (dead pid, or unreadable/corrupt): remove and retry exactly once.
  try {
    fs.rmSync(paths.lockFile, { force: true });
  } catch {
    // ignore — the create below will surface any real problem
  }
    return tryCreate();
  } catch(error) {
    // Preserve the refusal/recovery error if cleanup itself fails. A close can
    // report failure after releasing the connection; never retry it.
    try { ownershipLease.close(); }
    catch(closeError) { throw new AggregateError([error,closeError],String(error),{cause:error}); }
    throw error;
  }
}
