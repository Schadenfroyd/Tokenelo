import type { ProcessesResponse, SessionRow, SummaryResponse } from './api-types.js';

/** Read-completion clocks belong to this window, not to the observation or ledger snapshot. */
export type NowRead<T> =
  | { state: 'available'; value: T; completedAt: number }
  | { state: 'unavailable'; completedAt: number };

export async function readNowData(reads: {
  sessions(): Promise<SessionRow[]>;
  processes(): Promise<ProcessesResponse>;
  summary(): Promise<SummaryResponse>;
}, clock: () => number = Date.now): Promise<{
  sessions: NowRead<SessionRow[]>;
  processes: NowRead<ProcessesResponse>;
  summary: NowRead<SummaryResponse>;
}> {
  const settle = <T>(read: () => Promise<T>): Promise<NowRead<T>> =>
    Promise.resolve().then(read).then(
      value => ({ state: 'available' as const, value, completedAt: clock() }),
      () => ({ state: 'unavailable' as const, completedAt: clock() }),
    );
  // Preserve each existing request/deadline. No failure becomes an empty result or a retry.
  const [sessions, processes, summary] = await Promise.all([
    settle(reads.sessions), settle(reads.processes), settle(reads.summary),
  ]);
  return { sessions, processes, summary };
}
