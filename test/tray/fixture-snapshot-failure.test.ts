import { describe, expect, it, vi } from 'vitest';
import { sanitizeFixtureReads } from '../../src/tray/snapshot-data.js';
import type { ApiClient } from '../../src/tray/api-client.js';

describe('fixture read failures remain visible to the snapshot owner', () => {
  it('reports failure even if an interactive renderer catches the sanitized rejection', async () => {
    const failed = vi.fn();
    const client = sanitizeFixtureReads({ getProcesses: async () => { throw new Error('private-path and response text'); } } as unknown as ApiClient, failed);
    let message = '';
    try { await client.getProcesses(); } catch (error) { message = (error as Error).message; }
    expect(failed).toHaveBeenCalledTimes(1);
    expect(message).toBe('a fixture read failed (getProcesses)');
    expect(message).not.toContain('private-path');
  });

  it('preserves successful fixture values and does not report a false failure', async () => {
    const failed = vi.fn(); const response = { host: 'filed', generatedAt: 1, processes: [] };
    const client = sanitizeFixtureReads({ getProcesses: async () => response } as unknown as ApiClient, failed);
    expect(await client.getProcesses()).toBe(response);
    expect(failed).not.toHaveBeenCalled();
  });
});
