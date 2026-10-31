import { terminateOwnedTransientDaemon, type LinuxTransientChildHandle } from './linux-service-runtime.js';

export type LinuxTransientDaemonOwnership =
  | 'not-started'
  | 'owned-running'
  | 'owned-exited'
  | 'spawn-failed'
  | 'unknown-existing';

export interface LinuxTransientDaemonState<TChild extends LinuxTransientChildHandle = LinuxTransientChildHandle> {
  child: TChild | null;
  ownership: LinuxTransientDaemonOwnership;
}

export type LinuxTransientChildErrorDisposition = 'stale-child' | 'retained-owned-child' | 'pre-spawn-failed';

/** Keep a live, PID-bearing child as owned after an OS error; only a failed pre-spawn child is cleared. */
export function recordLinuxTransientChildError<TChild extends LinuxTransientChildHandle>(
  state: LinuxTransientDaemonState<TChild>,
  child: TChild,
): LinuxTransientChildErrorDisposition {
  if (state.child !== child) return 'stale-child';
  if (child.pid === undefined) {
    state.child = null;
    state.ownership = 'spawn-failed';
    return 'pre-spawn-failed';
  }
  return 'retained-owned-child';
}

/** Ignore late events from replaced children; only the current child's exit ends its ownership. */
export function recordLinuxTransientChildExit<TChild extends LinuxTransientChildHandle>(
  state: LinuxTransientDaemonState<TChild>,
  child: TChild,
): boolean {
  if (state.child !== child) return false;
  state.child = null;
  state.ownership = 'owned-exited';
  return true;
}

export type LinuxTrayQuitPrompt =
  | 'pause-owned-transient'
  | 'pause-owned-transient-and-leave-service'
  | 'leave-configured-service'
  | 'leave-unowned-daemon';

export interface LinuxTrayQuitOptions {
  ownership: LinuxTransientDaemonOwnership;
  child: LinuxTransientChildHandle | null;
  configuredService: boolean;
  confirm(prompt: LinuxTrayQuitPrompt): Promise<boolean>;
  waitForExit(timeoutMs: number): Promise<boolean>;
  quit(): void;
  stopFailure(reason: 'child-identity-unavailable' | 'graceful-stop-not-confirmed'): void | Promise<void>;
}

export type LinuxTrayQuitResult =
  | 'quit-after-pausing-transient'
  | 'quit-with-background-untouched'
  | 'cancelled'
  | 'confirmation-failed'
  | 'stop-unconfirmed';

const CHILD_STOP_TIMEOUT_MS = 30_000;

function hasExited(child: LinuxTransientChildHandle): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function pauseOwnedTransient(
  child: LinuxTransientChildHandle,
  waitForExit: (timeoutMs: number) => Promise<boolean>,
): Promise<'stopped' | 'child-identity-unavailable' | 'graceful-stop-not-confirmed'> {
  if (hasExited(child)) return 'stopped';
  if (!Number.isInteger(child.pid) || child.pid! <= 0) return 'child-identity-unavailable';

  // A prior explicit Quit may already have sent SIGTERM and timed out. Wait again without
  // sending a second signal; never force-kill a daemon whose graceful drain is still running.
  if (child.killed) {
    try {
      return await waitForExit(CHILD_STOP_TIMEOUT_MS) || hasExited(child)
        ? 'stopped' : 'graceful-stop-not-confirmed';
    } catch {
      return hasExited(child) ? 'stopped' : 'graceful-stop-not-confirmed';
    }
  }

  try {
    return await terminateOwnedTransientDaemon(child, waitForExit) || hasExited(child)
      ? 'stopped' : 'graceful-stop-not-confirmed';
  } catch {
    return hasExited(child) ? 'stopped' : 'graceful-stop-not-confirmed';
  }
}

/**
 * Handles only the explicit Linux tray-menu Quit action. It stops a daemon only when this tray
 * still has the exact ChildProcess handle it created. Persistent services and daemons from older
 * or crashed tray instances are left untouched.
 */
export async function requestLinuxTrayQuit(options: LinuxTrayQuitOptions): Promise<LinuxTrayQuitResult> {
  const child = options.child;
  const ownedTransientIsRunning = options.ownership === 'owned-running' && child !== null && !hasExited(child);

  if (ownedTransientIsRunning) {
    let confirmed = false;
    const prompt: LinuxTrayQuitPrompt = options.configuredService
      ? 'pause-owned-transient-and-leave-service'
      : 'pause-owned-transient';
    try { confirmed = await options.confirm(prompt); }
    catch { return 'confirmation-failed'; }
    if (!confirmed) return 'cancelled';

    const stopped = await pauseOwnedTransient(child, options.waitForExit);
    if (stopped !== 'stopped') {
      try { await options.stopFailure(stopped); } catch { /* Keep the tray open even if the warning cannot be shown. */ }
      return 'stop-unconfirmed';
    }

    options.quit();
    return 'quit-after-pausing-transient';
  }

  const mayBeUnownedDaemon = options.ownership === 'unknown-existing'
    || options.ownership === 'spawn-failed'
    || (options.ownership === 'owned-running' && child === null)
    || (child !== null && !hasExited(child));
  const prompt: LinuxTrayQuitPrompt | null = options.configuredService
    ? 'leave-configured-service'
    : mayBeUnownedDaemon ? 'leave-unowned-daemon' : null;

  if (prompt) {
    let confirmed = false;
    try { confirmed = await options.confirm(prompt); }
    catch { return 'confirmation-failed'; }
    if (!confirmed) return 'cancelled';
  }

  options.quit();
  return 'quit-with-background-untouched';
}
