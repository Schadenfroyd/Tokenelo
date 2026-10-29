/**
 * Detects whether a per-OS service unit for the daemon is already installed (DESIGN §12,
 * §15.7.5: "tray starts the daemon only if no service unit is installed"). We only ever check —
 * installing/uninstalling is scripts/install-service-*.* and is explicitly out of scope for the
 * tray. Split out of main.ts so it can be unit-tested without importing 'electron' (see the
 * comment at the top of argv.ts for why that import is untestable under plain Node/vitest).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** macOS LaunchAgent plist / Linux systemd --user unit file existence check. Windows scheduled
 * tasks aren't a stat-able file, so this always returns false on win32 — callers should also
 * check `windowsScheduledTaskInstalled()` there. */
export function serviceUnitInstalled(opts?: { platform?: NodeJS.Platform; home?: string; env?: Record<string, string | undefined> }): boolean {
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? os.homedir();
  const env = opts?.env ?? process.env;
  try {
    if (platform === 'darwin') {
      return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', 'co.eloai.tokenelo.daemon.plist'));
    }
    if (platform === 'linux') {
      const xdgConfig = env.XDG_CONFIG_HOME || path.join(home, '.config');
      return fs.existsSync(path.join(xdgConfig, 'systemd', 'user', 'tokenelo-daemon.service'));
    }
  } catch {
    return false;
  }
  return false;
}

/** `schtasks /query /tn TokeneloDaemon` — the only way to check a Windows scheduled task exists
 * (it isn't a file on disk). Injectable `runner` for tests; real callers use the default, which
 * shells out and is therefore only meaningfully exercised on win32 in practice. */
export function windowsScheduledTaskInstalled(opts?: {
  platform?: NodeJS.Platform;
  runner?: (cmd: string, args: string[]) => void;
}): boolean {
  const platform = opts?.platform ?? process.platform;
  if (platform !== 'win32') return false;
  const runner = opts?.runner ?? ((cmd, args) => void execFileSync(cmd, args, { stdio: 'ignore', windowsHide: true }));
  try {
    runner('schtasks', ['/query', '/tn', 'TokeneloDaemon']);
    return true;
  } catch {
    return false;
  }
}
