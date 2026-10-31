import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRefresh, ProcessObservations, PROCESS_FOLLOWUP_MS, processProbePending, coverageWithProcessObservation } from '../../src/tray/renderer/process-refresh.js';
import type { CoverageResponse, ProcessesResponse } from '../../src/tray/renderer/api-types.js';

const pending: ProcessesResponse = { host: 'test', generatedAt: 1, processes: [], listing: { status: 'unavailable', observedAt: null, probePending: true } };
const observed: ProcessesResponse = { host: 'test', generatedAt: 2, processes: [], listing: { status: 'ok', observedAt: 1 } };
const unavailable: ProcessesResponse = { host: 'test', generatedAt: 3, processes: [], listing: { status: 'unavailable', observedAt: null } };

function harness(read = vi.fn(async () => observed)) {
  let current = true;
  const show = vi.fn();
  const status = vi.fn();
  const controller = new ProcessRefresh({ current: () => current, read, show, status });
  return { controller, read, show, status, navigate: () => { current = false; } };
}

describe('process-only observation refresh ownership and finite follow-up', () => {
  afterEach(() => vi.useRealTimers());

  it('follows an explicitly pending probe once, preserves its completed observation time and stops', async () => {
    vi.useFakeTimers();
    const h = harness(); h.controller.start(pending);
    await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS - 1);
    expect(h.read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.show).toHaveBeenCalledWith(observed);
    expect(h.status.mock.calls.map(([value]) => value)).toEqual(['scheduled', 'checking', 'idle']);
    await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS * 10);
    expect(h.read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([unavailable, observed, { ...unavailable, listing: undefined }])('never automatically retries an unavailable, successful or legacy observation', async (initial) => {
    vi.useFakeTimers(); const h = harness(); h.controller.start(initial);
    await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS * 2);
    expect(h.read).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled();
    await h.controller.refresh(); expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('a manual action consumes the scheduled follow-up; an overlap is refused', async () => {
    vi.useFakeTimers();
    let release!: (response: ProcessesResponse) => void;
    const h = harness(vi.fn(() => new Promise<ProcessesResponse>((resolve) => { release = resolve; })));
    h.controller.start(pending);
    const action = h.controller.refresh();
    await h.controller.refresh(); await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS * 2);
    expect(h.read).toHaveBeenCalledTimes(1); expect(h.show).not.toHaveBeenCalled();
    release(observed); await action;
    expect(h.show).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('a pending follow-up response never schedules another automatic read', async () => {
    vi.useFakeTimers(); const h = harness(vi.fn(async () => pending));
    h.controller.start(pending); h.controller.start(pending);
    await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS * 10);
    expect(h.read).toHaveBeenCalledTimes(1); expect(h.show).toHaveBeenCalledWith(pending);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a transport error retains the previous observation and permits only an explicit new action', async () => {
    vi.useFakeTimers(); const read = vi.fn<() => Promise<ProcessesResponse>>().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(observed);
    const h = harness(read); h.controller.start(pending);
    await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS * 10);
    expect(read).toHaveBeenCalledTimes(1); expect(h.show).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenLastCalledWith('failed');
    await h.controller.refresh(); expect(h.show).toHaveBeenCalledWith(observed);
  });

  it('navigation prevents the pending timer from starting a request', async () => {
    vi.useFakeTimers(); const h = harness(); h.controller.start(pending); h.navigate();
    await vi.advanceTimersByTimeAsync(PROCESS_FOLLOWUP_MS);
    expect(h.read).not.toHaveBeenCalled(); expect(h.show).not.toHaveBeenCalled();
  });

  it('disposal cancels a timer and ignores both late success and late rejection', async () => {
    vi.useFakeTimers(); const cancelled = harness(); cancelled.controller.start(pending); cancelled.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    for (const reject of [false, true]) {
      let resolve!: (response: ProcessesResponse) => void; let fail!: (error: Error) => void;
      const h = harness(vi.fn(() => new Promise<ProcessesResponse>((r, j) => { resolve = r; fail = j; })));
      const action = h.controller.refresh(); h.controller.dispose();
      if (reject) fail(new Error('late')); else resolve(observed);
      await action;
      expect(h.show).not.toHaveBeenCalled(); expect(h.status.mock.calls.map(([value]) => value)).toEqual(['checking', 'retired']);
      await h.controller.refresh(); expect(h.read).toHaveBeenCalledTimes(1);
    }
  });

  it('accepts pending evidence only with unavailable/null and a literal true field', () => {
    expect(processProbePending(pending.listing)).toBe(true);
    for (const listing of [undefined, unavailable.listing, { status: 'ok', observedAt: 1, probePending: true }, { status: 'unavailable', observedAt: 1, probePending: true }, { status: 'unavailable', observedAt: null, probePending: 'true' }]) {
      expect(processProbePending(listing as ProcessesResponse['listing'])).toBe(false);
    }
  });

  it('retirement updates the still-visible control exactly once and cancels its pending follow-up', () => {
    vi.useFakeTimers(); const h = harness(); h.controller.start(pending);
    h.controller.dispose(); h.controller.dispose();
    expect(h.status.mock.calls.map(([value]) => value)).toEqual(['scheduled', 'retired']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Coverage process refresh preserves recorded snapshot evidence', () => {
  const coverage: CoverageResponse = {
    host: 'test', generatedAt: 100, processListing: pending.listing,
    tools: [{ id: 'cli', name: 'CLI', category: 'cloud-agent-cli', installed: false, running: false,
      captured: true, lastEventAt: 10, lastTelemetryTimeBasis: 'event-recorded', reason: 'recorded reason' }],
    collectorScans: [], incompleteCapture: [{ collector: 'claude', heldFiles: 2, oldestHeldAt: 8, maxLineBytes: 99 }],
  };
  const running: ProcessesResponse = { ...observed, processes: [{ pid: 7, ppid: null, startedAt: null,
    exe: 'cli', host: 'test', tool: 'cli' }] };

  it('updates the process snapshot without mutating installation, telemetry, clocks, scans or holds', () => {
    const saved = structuredClone(coverage);
    const result = coverageWithProcessObservation(coverage, running);
    expect(result).toEqual({ ...coverage, processListing: running.listing, tools: [{ ...coverage.tools[0], running: true }] });
    expect(coverage).toEqual(saved);
    expect(result.tools[0]).not.toBe(coverage.tools[0]);
    expect(result.processListing).not.toBe(running.listing);
    expect(result.collectorScans).toBe(coverage.collectorScans);
    expect(result.incompleteCapture).toBe(coverage.incompleteCapture);
  });

  it.each([pending.listing, unavailable.listing, undefined])('never treats an unavailable or legacy list as a measured running state', (listing) => {
    const result = coverageWithProcessObservation(coverage, { ...running, listing });
    expect(result.tools[0].running).toBe(false);
    expect(result.processListing).toEqual(listing);
    expect(result.tools[0].captured).toBe(true);
    expect(result.generatedAt).toBe(100);
  });

  it('refuses a foreign response host or a foreign process before changing Coverage evidence', () => {
    const saved = structuredClone(coverage);
    expect(() => coverageWithProcessObservation(coverage, { ...running, host: 'other' })).toThrow('host mismatch');
    expect(() => coverageWithProcessObservation(coverage, { ...running, processes: [{ ...running.processes[0], host: 'other' }] })).toThrow('host mismatch');
    expect(coverage).toEqual(saved);
  });

  it('reuses the newer process response on a cached Coverage revisit without changing its recorded clocks or holds', () => {
    const observations = new ProcessObservations(); const saved = structuredClone(coverage);
    observations.remember(running); const result = observations.apply(coverage);
    expect(result.processListing).toEqual(running.listing);
    expect(result.tools[0].running).toBe(true);
    expect(result.generatedAt).toBe(100);
    expect(result.collectorScans).toBe(coverage.collectorScans);
    expect(result.incompleteCapture).toBe(coverage.incompleteCapture);
    expect(coverage).toEqual(saved);
  });

  it('keeps host observations separate and refuses foreign process attribution', () => {
    const observations = new ProcessObservations(); observations.remember(running);
    const foreign = { ...coverage, host: 'other' };
    expect(observations.apply(foreign)).toBe(foreign);
    expect(() => observations.remember({ ...running, processes: [{ ...running.processes[0], host: 'other' }] })).toThrow('host mismatch');
    expect(observations.apply(coverage).tools[0].running).toBe(true);
  });

  it('retains its checked snapshot when the caller later mutates the response object', () => {
    const observations = new ProcessObservations(); const response = structuredClone(running);
    observations.remember(response); response.listing!.observedAt = null; response.processes[0].host = 'foreign';
    expect(observations.apply(coverage).processListing).toEqual(running.listing);
    expect(observations.apply(coverage).tools[0].running).toBe(true);
  });

  it('clears prior process observations when the whole recorded view is refreshed', () => {
    const observations = new ProcessObservations(); observations.remember(running); observations.clear();
    expect(observations.apply(coverage)).toBe(coverage);
  });
});
