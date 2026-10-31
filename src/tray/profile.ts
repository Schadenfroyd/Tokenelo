/** Electron storage must follow an explicit TOKENELO_HOME before ready or the instance lock. */
import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from '../daemon/paths.js';

export interface TrayProfilePaths {
  userData: string;
  sessionData: string;
  crashDumps: string;
  logs: string;
}

// No Electron runtime import: the filesystem policy can be tested under ordinary Node.
interface ProfileApp {
  isReady(): boolean;
  setPath(name: 'userData' | 'sessionData' | 'crashDumps', value: string): void;
  setAppLogsPath(value: string): void;
}

export function configureTrayProfile(
  app: ProfileApp,
  env: Record<string, string | undefined> = process.env,
): TrayProfilePaths | null {
  // Preserve existing per-OS defaults, including any externally configured Electron profile.
  if (!env.TOKENELO_HOME) return null;
  if (app.isReady()) throw new Error('Tokenelo tray: TOKENELO_HOME profile must be configured before Electron is ready');

  const tracker = getPaths({ env });
  const root = path.resolve(tracker.dataDir, 'electron');
  const paths: TrayProfilePaths = {
    userData: path.join(root, 'user-data'),
    sessionData: path.join(root, 'session-data'),
    crashDumps: path.join(root, 'crash-dumps'),
    logs: path.resolve(tracker.logsDir, 'electron'),
  };
  try {
    // Prepare every location before overriding any path. Refuse an unusable home instead of
    // silently putting browser state into the default profile. No old profile is migrated/deleted.
    for (const dir of Object.values(paths)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    }
    app.setPath('userData', paths.userData);
    app.setPath('sessionData', paths.sessionData);
    app.setPath('crashDumps', paths.crashDumps);
    app.setAppLogsPath(paths.logs);
  } catch (err) {
    throw new Error(`Tokenelo tray: cannot use TOKENELO_HOME profile: ${(err as Error).message}`, { cause: err });
  }
  return paths;
}
