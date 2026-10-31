import { describe, expect, it, vi } from 'vitest';

const command = vi.hoisted(() => vi.fn(async () => ({
  stdout: JSON.stringify([{ ProcessId: 42, ParentProcessId: 1,
    CreationDate: '2026-10-08T12:00:00Z', ExecutablePath: 'C:\\tools\\codex.exe',
    CommandLine: 'codex.exe exec --model gpt-6-sol' }]), stderr: '',
})));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: command }) };
});

import { listProcessesWindows } from '../../src/collectors/processes.js';

describe('default process-discovery launch', () => {
  it('hides the Windows console while retaining the bounded command and result', async () => {
    const rows = await listProcessesWindows('TEST');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 42, ppid: 1, model: 'gpt-6-sol' });
    expect(command).toHaveBeenCalledExactlyOnceWith('powershell',
      ['-NoProfile', '-NonInteractive', '-Command', expect.stringContaining('Get-CimInstance Win32_Process')],
      { maxBuffer: 16 * 1024 * 1024, timeout: 3000, windowsHide: true });
  });
});
