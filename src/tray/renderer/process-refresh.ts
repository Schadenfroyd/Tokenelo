import type { CoverageResponse, ProcessesResponse } from './api-types.js';

/** One follow-up for an explicitly pending observation, never an error/legacy retry loop. */
export const PROCESS_FOLLOWUP_MS = 3_000;

export function processProbePending(listing: ProcessesResponse['listing']): boolean {
  return listing?.status === 'unavailable' && listing.observedAt === null && listing.probePending === true;
}

/** A process-only response updates only process evidence. Installation, telemetry, holds and
 * collector clocks retain their original Coverage snapshot, and its cached response is never mutated. */
export function coverageWithProcessObservation(coverage: CoverageResponse, next: ProcessesResponse): CoverageResponse {
  if (next.host !== coverage.host || next.processes.some(process => process.host !== coverage.host))
    throw new Error('Coverage process host mismatch');
  const running = new Set(next.listing?.status === 'ok' ? next.processes.map(process => process.tool) : []);
  return { ...coverage, processListing: next.listing && { ...next.listing },
    tools: coverage.tools.map(tool => ({ ...tool, running: running.has(tool.id) })) };
}

/** Preserve the latest response independently of cached Coverage's installation/scan snapshot. */
export class ProcessObservations {
  private readonly byHost = new Map<string, ProcessesResponse>();
  remember(response: ProcessesResponse): void {
    if (response.processes.some(process => process.host !== response.host))
      throw new Error('Process observation host mismatch');
    this.byHost.set(response.host, { ...response,
      listing: response.listing && { ...response.listing },
      processes: response.processes.map(process => ({ ...process })),
    });
  }
  apply(coverage: CoverageResponse): CoverageResponse {
    const response = this.byHost.get(coverage.host);
    return response ? coverageWithProcessObservation(coverage, response) : coverage;
  }
  clear(): void { this.byHost.clear(); }
}

export type ProcessRefreshState = 'scheduled' | 'checking' | 'idle' | 'failed' | 'retired';

/** Process-only reads leave recorded sessions and their data caches untouched. Navigation/refresh disposes
 * the owner: its timer is cancelled and a late IPC result is ignored. The daemon probe itself is not aborted. */
export class ProcessRefresh {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private disposed = false;
  private started = false;

  constructor(private readonly options: {
    current(): boolean;
    read(): Promise<ProcessesResponse>;
    show(response: ProcessesResponse): void;
    status(state: ProcessRefreshState): void;
  }) {}

  start(initial: Pick<ProcessesResponse, 'listing'>): void {
    if (this.started || !this.current()) return;
    this.started = true;
    if (!processProbePending(initial.listing)) return;
    this.options.status('scheduled');
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, PROCESS_FOLLOWUP_MS);
  }

  /** Explicit actions may refresh again; overlapping reads are refused. A manual read consumes
   * any scheduled follow-up. Responses/errors never schedule another automatic request. */
  async refresh(): Promise<void> {
    if (!this.current() || this.busy) return;
    this.clearTimer();
    this.busy = true;
    this.options.status('checking');
    try {
      const result = await this.options.read();
      if (!this.current()) return;
      this.options.show(result);
      this.options.status('idle');
    } catch {
      if (this.current()) this.options.status('failed');
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (!this.disposed && this.options.current()) this.options.status('retired');
    this.disposed = true;
    this.clearTimer();
  }

  private current(): boolean { return !this.disposed && this.options.current(); }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
