import { describe, expect, it } from 'vitest';
import { createDaemonSpawnSpec } from '../../src/tray/daemon-launch.js';

describe('tray daemon launch', () => {
  it('runs the daemon as Node in a detached, quiet child without mutating the tray environment', () => {
    const parentEnvironment: NodeJS.ProcessEnv = {
      PATH: 'fixture-path',
      ELECTRON_RUN_AS_NODE: '0',
      TOKENELO_TEST_ENV: 'preserved',
    };
    const originalEnvironment = { ...parentEnvironment };

    const spec = createDaemonSpawnSpec('electron.exe', 'daemon/main.js', parentEnvironment);

    expect(spec.command).toBe('electron.exe');
    expect(spec.args).toEqual(['daemon/main.js']);
    expect(spec.options.detached).toBe(true);
    expect(spec.options.stdio).toBe('ignore');
    expect(spec.options.windowsHide).toBe(true);
    expect(spec.options.env).toEqual({
      ...originalEnvironment,
      ELECTRON_RUN_AS_NODE: '1',
    });
    expect(spec.options.env).not.toBe(parentEnvironment);
    expect(parentEnvironment).toEqual(originalEnvironment);
  });
});