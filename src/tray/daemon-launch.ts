import type { SpawnOptions } from 'node:child_process';

const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

export interface DaemonSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * Build a detached, headless Node launch using the bundled Electron executable.
 * Electron only acts as Node when the child environment opts in; keep that switch
 * local to the child so the tray process environment is never mutated.
 */
export function createDaemonSpawnSpec(
  electronExecutable: string,
  daemonEntry: string,
  parentEnvironment: NodeJS.ProcessEnv,
): DaemonSpawnSpec {
  return {
    command: electronExecutable,
    args: [daemonEntry],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...parentEnvironment,
        [ELECTRON_RUN_AS_NODE]: '1',
      },
    },
  };
}