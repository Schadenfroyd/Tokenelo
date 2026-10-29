/**
 * Preload script for the popover BrowserWindow. `contextIsolation: true` + `nodeIntegration:
 * false` (set in main.ts's BrowserWindow webPreferences) mean the renderer has no Node/Electron
 * access at all except through this bridge — a minimal, typed, read-only surface mirroring
 * ApiClient (src/tray/api-client.ts). Every call is proxied to the main process via
 * `ipcRenderer.invoke`, which in turn calls the real ApiClient (main.ts owns that instance so the
 * renderer never sees the bearer token or the mock-dir path).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { SnapshotFixtureMarker } from './fixture-example.js';
import type {
  CoverageResponse,
  DoctorReport,
  FleetOverviewResponse,
  LimitsResponse,
  ProcessesResponse,
  Range,
  SessionDetail,
  SessionRow,
  SessionsResponse,
  Source,
  SummaryResponse,
  UsageResponse,
  TimeseriesResponse,
} from '../core/types.js';

/** The shape exposed on `window.tokenelo` in the renderer (see renderer/app.ts for the consumer
 * and a matching `declare global` augmentation). Channel names are namespaced `tokenelo:*` so
 * they cannot collide with any other IPC traffic added later. This same preload script is loaded
 * by BOTH the popover window and the session-detail window (main.ts) — every method here works
 * from either, since main.ts's handlers accept a message from either window's main frame. */
export interface TokeneloBridge {
  /** Fixed fixture label only for an offscreen fixture snapshot; never includes its source path or credentials. */
  getSnapshotFixtureMarker(): Promise<SnapshotFixtureMarker>;
  getSummary(range: Range, requestId?: string): Promise<SummaryResponse>;
  getUsage(range: Range, requestId?: string): Promise<UsageResponse>;
  cancelUsage(requestId: string): Promise<void>;
  onUsageProgress(cb: (progress: { requestId: string; range: Range; status: 'queued' | 'running'; phase?: string }) => void): void;
  cancelSummary(requestId: string): Promise<void>;
  onSummaryProgress(cb: (progress: { requestId: string; range: Range; status: 'queued' | 'running'; phase?: string }) => void): void;
  /** `range` defaults to 'today' (matching the daemon's own `?range=` default) — the Now tab
   * calls this with no argument; the Sessions tab (task item 3) passes its own range selector. */
  getSessions(range?: Range): Promise<SessionRow[]>;
  /** Same route and rows as getSessions, as the full envelope with its optional query clock (`generatedAt`, absent = unknown). */
  getSessionsResponse(range?: Range): Promise<SessionsResponse>;
  getLimits(): Promise<LimitsResponse>;
  getTimeseries(range: Range): Promise<TimeseriesResponse>;
  getDoctor(): Promise<DoctorReport>;
  getCoverage(): Promise<CoverageResponse>;
  getProcesses(): Promise<ProcessesResponse>;
  getSessionDetail(source: Source, sessionId: string): Promise<SessionDetail>;
  getFleetOverview(range: Range): Promise<FleetOverviewResponse>;
  /** Opens (or focuses+updates, if already open) the larger session-detail window for a session
   * clicked from the popover (Now tab or the Sessions tab). */
  openSessionDetail(source: Source, sessionId: string): Promise<void>;
  /** The detail window's own "load a different session in place" subscription — fired when
   * main.ts reuses an already-open detail window for a newly-clicked session (from the popover),
   * so the detail renderer never needs a full page reload for that case. Clicking a subagent row
   * INSIDE the detail window itself calls `getSessionDetail` directly instead — no IPC round trip
   * back through main.ts, since that's a same-window, same-preload-surface navigation. */
  onLoadSession(cb: (session: { source: Source; sessionId: string }) => void): void;
  /** Closes the detail window (Esc key, per the founder spec) — a no-op if it isn't open. */
  closeSessionDetail(): Promise<void>;
  /** Current OS-level theme ('dark' | 'light'), plus a subscription for live changes. */
  getTheme(): Promise<'light' | 'dark'>;
  onThemeChanged(cb: (theme: 'light' | 'dark') => void): void;
}

const bridge: TokeneloBridge = {
  getSnapshotFixtureMarker: () => ipcRenderer.invoke('tokenelo:getSnapshotFixtureMarker'),
  getSummary: (range, requestId) => requestId === undefined ? ipcRenderer.invoke('tokenelo:getSummary', range) : ipcRenderer.invoke('tokenelo:getSummary', range, requestId),
  getUsage: (range, requestId) => ipcRenderer.invoke('tokenelo:getUsage', range, requestId),
  cancelUsage: (requestId) => ipcRenderer.invoke('tokenelo:cancelUsage', requestId),
  onUsageProgress: (cb) => { ipcRenderer.on('tokenelo:usage-progress', (_event, progress) => cb(progress)); },
  cancelSummary: (requestId) => ipcRenderer.invoke('tokenelo:cancelSummary', requestId),
  onSummaryProgress: (cb) => { ipcRenderer.on('tokenelo:summary-progress', (_event, progress) => cb(progress)); },
  getSessions: (range) => ipcRenderer.invoke('tokenelo:getSessions', range),
  getSessionsResponse: (range) => ipcRenderer.invoke('tokenelo:getSessionsResponse', range),
  getLimits: () => ipcRenderer.invoke('tokenelo:getLimits'),
  getTimeseries: (range) => ipcRenderer.invoke('tokenelo:getTimeseries', range),
  getDoctor: () => ipcRenderer.invoke('tokenelo:getDoctor'),
  getCoverage: () => ipcRenderer.invoke('tokenelo:getCoverage'),
  getProcesses: () => ipcRenderer.invoke('tokenelo:getProcesses'),
  getSessionDetail: (source, sessionId) => ipcRenderer.invoke('tokenelo:getSessionDetail', source, sessionId),
  getFleetOverview: (range) => ipcRenderer.invoke('tokenelo:getFleetOverview', range),
  openSessionDetail: (source, sessionId) => ipcRenderer.invoke('tokenelo:openSessionDetail', source, sessionId),
  onLoadSession: (cb) => {
    ipcRenderer.on('tokenelo:loadSession', (_event, session: { source: Source; sessionId: string }) => cb(session));
  },
  closeSessionDetail: () => ipcRenderer.invoke('tokenelo:closeSessionDetail'),
  getTheme: () => ipcRenderer.invoke('tokenelo:getTheme'),
  onThemeChanged: (cb) => {
    ipcRenderer.on('tokenelo:themeChanged', (_event, theme: 'light' | 'dark') => cb(theme));
  },
};

contextBridge.exposeInMainWorld('tokenelo', bridge);
