import { beforeEach, describe, expect, it, vi } from 'vitest';

// No real runtime, token file, collector, daemon or installed home is used by
// these argument-intent regressions, including when run against the old CLI.
const bootstrap = vi.hoisted(() => ({
  buildRuntime: vi.fn(),
  runIngestOnce: vi.fn(),
  main: vi.fn(),
  ensureApiToken: vi.fn(),
  isEntryModule: vi.fn(() => false),
}));
vi.mock('../../src/daemon/main.js', () => bootstrap);

import { runCli } from '../../src/cli/index.js';

const fakeTokenPath = 'OWNED-FILED-API-TOKEN-PATH';
const fakeTokenValue = 'OWNED-FILED-SYNTHETIC-TOKEN-NOT-A-CREDENTIAL';
const paths = { apiTokenFile: fakeTokenPath };
const close = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  bootstrap.buildRuntime.mockResolvedValue({ paths, close });
  bootstrap.ensureApiToken.mockReturnValue(fakeTokenValue);
  close.mockResolvedValue(undefined);
});

async function capture(args: string[]) {
  let stdout = '', stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk); return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk); return true;
  });
  try { return { code: await runCli(['token', ...args]), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}

const unsupported = [
  ['--show=false'], ['--show', 'false'], ['--show=0'], ['--show=true'], ['--show='],
  ['--unknown'], ['unexpected'], ['--dry-run'], ['--help=false'], ['--help', 'unexpected'],
  ['--show', '--show'], ['--help', '--help'], ['--show', '--help'], ['--help', '--show'],
  ['--', '--show'], ['-h'], ['--show', 'unexpected'],
].map(args => ({ label: args.join(' '), args }));

describe('token command requires explicit raw argument intent', () => {
  it.each(unsupported)('rejects $label before bootstrap or token creation', async ({ args }) => {
    const result = await capture(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('token');
    expect(bootstrap.buildRuntime).not.toHaveBeenCalled();
    expect(bootstrap.ensureApiToken).not.toHaveBeenCalled();
    expect(bootstrap.runIngestOnce).not.toHaveBeenCalled();
    expect(bootstrap.main).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('--help returns token help without opening a runtime or exposing a token', async () => {
    const result = await capture(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tokenelo token');
    expect(result.stdout).toContain('--show');
    expect(result.stdout).toContain('--help');
    expect(result.stdout).not.toContain(fakeTokenPath);
    expect(result.stdout).not.toContain(fakeTokenValue);
    expect(result.stderr).toBe('');
    expect(bootstrap.buildRuntime).not.toHaveBeenCalled();
    expect(bootstrap.ensureApiToken).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('the default retains path-only output and closes its mocked runtime', async () => {
    expect(await capture([])).toEqual({ code: 0, stdout: fakeTokenPath + '\n', stderr: '' });
    expect(bootstrap.buildRuntime).toHaveBeenCalledExactlyOnceWith();
    expect(bootstrap.ensureApiToken).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it('bare --show retains path/value output and closes its mocked runtime', async () => {
    expect(await capture(['--show'])).toEqual({ code: 0, stdout: fakeTokenPath + '\n' + fakeTokenValue + '\n', stderr: '' });
    expect(bootstrap.buildRuntime).toHaveBeenCalledExactlyOnceWith();
    expect(bootstrap.ensureApiToken).toHaveBeenCalledExactlyOnceWith(paths);
    expect(close).toHaveBeenCalledExactlyOnceWith();
  });

  it('closes the mocked runtime if explicit token display fails', async () => {
    bootstrap.ensureApiToken.mockImplementationOnce(() => { throw new Error('synthetic token display failure'); });
    let stdout = '';
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk); return true;
    });
    try {
      await expect(runCli(['token', '--show'])).rejects.toThrow('synthetic token display failure');
      expect(stdout).toBe(fakeTokenPath + '\n');
      expect(close).toHaveBeenCalledExactlyOnceWith();
    } finally {
      out.mockRestore();
    }
  });
});
