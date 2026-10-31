import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// CI builds dist before running Vitest. Local test runs without a build skip these
// entrypoint checks so testing the source never writes or bootstraps an app profile.
const compiledCli = path.resolve(process.cwd(), 'dist/cli/index.js');
const compiledCliHasCandidateGuard = existsSync(compiledCli)
  && readFileSync(compiledCli, 'utf8').includes('token accepts only bare --show or --help');

describe.skipIf(!compiledCliHasCandidateGuard)('compiled token CLI entrypoint', () => {
  function runInEmptyProfile(args: string[]) {
    const profile = mkdtempSync(path.join(os.tmpdir(), 'tokenelo-token-cli-'));
    try {
      const env = {
        ...process.env,
        HOME: profile,
        USERPROFILE: profile,
        APPDATA: path.join(profile, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
        XDG_CONFIG_HOME: path.join(profile, '.config'),
        XDG_DATA_HOME: path.join(profile, '.local', 'share'),
      };
      const result = spawnSync(process.execPath, [compiledCli, 'token', ...args], {
        cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000,
      });
      return { result, profile, profileEntries: readdirSync(profile) };
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }

  it('handles token help without opening an app profile or exposing a token path', () => {
    const { result, profile, profileEntries } = runInEmptyProfile(['--help']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: tokenelo token');
    expect(result.stdout).not.toContain(profile);
    expect(profileEntries).toEqual([]);
    // Node 22 emits its existing ExperimentalWarning for the CLI's static
    // SQLite imports even though this help path never opens the runtime.
    expect(result.stderr).not.toContain(profile);
    expect(result.stderr).not.toContain('token accepts only');
  });

  it('rejects truthy string values before the compiled entrypoint bootstraps', () => {
    const { result, profile, profileEntries } = runInEmptyProfile(['--show=false']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('token accepts only bare --show or --help');
    expect(result.stderr).not.toContain(profile);
    expect(profileEntries).toEqual([]);
  });
});
