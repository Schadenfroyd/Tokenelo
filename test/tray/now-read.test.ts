import { describe, expect, it, vi } from 'vitest';
import { readNowData } from '../../src/tray/renderer/now-read.js';
import type { ProcessesResponse, SessionRow, SummaryResponse } from '../../src/tray/renderer/api-types.js';
import summaryFixture from '../fixtures/api/summary-today.json';
import processFixture from '../fixtures/api/processes.json';

const summary = summaryFixture as unknown as SummaryResponse;
const processes = processFixture as unknown as ProcessesResponse;
const sessions: SessionRow[] = [];

describe('independent Now reads', () => {
  for (let failed = 0; failed < 8; failed++) {
    it(`keeps each successful response and marks each failed read explicitly (mask ${failed})`, async () => {
      const read = <T>(value: T, bit: number) => vi.fn(async () => {
        if (failed & bit) throw new Error('private-path must not become response data');
        return value;
      });
      const reads = { sessions: read(sessions, 1), processes: read(processes, 2), summary: read(summary, 4) };
      const result = await readNowData(reads, () => 12345);
      for (const [name, bit, value] of [
        ['sessions', 1, sessions], ['processes', 2, processes], ['summary', 4, summary],
      ] as const) {
        expect(reads[name]).toHaveBeenCalledTimes(1);
        const panel = result[name];
        expect(panel.completedAt).toBe(12345);
        if (failed & bit) expect(panel).toEqual({ state: 'unavailable', completedAt: 12345 });
        else {
          expect(panel.state).toBe('available');
          if (panel.state === 'available') expect(panel.value).toBe(value);
        }
      }
      expect(JSON.stringify(result)).not.toContain('private-path');
    });
  }

  it('starts all reads even when one throws synchronously', async () => {
    const processRead = vi.fn(async () => processes);
    const summaryRead = vi.fn(async () => summary);
    const result = await readNowData({
      sessions: () => { throw new Error('synchronous bridge failure'); },
      processes: processRead, summary: summaryRead,
    });
    expect(result.sessions.state).toBe('unavailable');
    expect(result.processes.state).toBe('available');
    expect(result.summary.state).toBe('available');
    expect(processRead).toHaveBeenCalledTimes(1);
    expect(summaryRead).toHaveBeenCalledTimes(1);
  });

  it('retains the process read-completion clock when a later sessions failure finishes the view', async () => {
    let clock = 100;
    let completeProcess!: (value: ProcessesResponse) => void;
    let failSessions!: (reason: Error) => void;
    const pending = readNowData({
      processes: () => new Promise(ok => { completeProcess = ok; }),
      sessions: () => new Promise((_ok, reject) => { failSessions = reject; }),
      summary: async () => summary,
    }, () => clock);
    await Promise.resolve(); await Promise.resolve();
    completeProcess(processes);
    await Promise.resolve(); await Promise.resolve();
    clock = 500;
    failSessions(new Error('late stored detail failure'));
    const result = await pending;
    expect(result.processes.completedAt).toBe(100);
    expect(result.sessions.completedAt).toBe(500);
    expect(result.summary.state).toBe('available');
  });
});
