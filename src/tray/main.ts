/**
 * Electron main process for the Tokenelo tray (DESIGN §10, §15.7.5-6). Owns: the single-instance
 * lock, the Tray icon + context menu, the popover BrowserWindow, starting the daemon when it is
 * not already reachable and no service unit is installed for it, and the IPC handlers backing
 * preload.ts's bridge. Never touches SQLite directly — everything goes through api-client.ts.
 *
 * `--snapshot <png> [--tab <name>] [--theme light|dark] [--session <source>:<id>]`: renders the
 * popover offscreen with the data source named by `--data live|fixtures` (default fixtures: the
 * TOKENELO_MOCK directory, or test/fixtures/api relative to this file; live: the already-running
 * local API, see snapshot-data.ts) and writes a fresh software-offscreen paint to a PNG, then exits — UNLESS `--session` is
 * given, in which case the session-DETAIL window is rendered instead (`--tab` is ignored in that
 * case). No Tray icon, no daemon spawn, no single-instance lock in this mode — it is a
 * short-lived headless render used for verification.
 *
 * The session-detail window (founder req. 2026-09-27 "session listing should open to more data
 * when clicked, in a larger window", DESIGN §10): a separate, larger (960×720, resizable)
 * BrowserWindow with the SAME security posture as the popover (contextIsolation, sandbox, strict
 * CSP via renderer/detail.html, navigation lockdown to its own file, IPC arg + sender
 * validation). One instance is reused across clicks (focus + `tokenelo:loadSession` IPC to swap
 * data in place) rather than spawning a new window per click; clicking a subagent row INSIDE the
 * detail window calls `getSessionDetail` again directly (no IPC back to main.ts needed for that
 * — it's the same window, same preload bridge).
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Tray,
  ipcMain,
  screen,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createDaemonSpawnSpec } from './daemon-launch.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiClient, isDaemonReachable, resolveConfiguredPort, SummaryReadRetiredError, type ApiClient } from './api-client.js';
import {
  readFailureLine,
  recordReads,
  resolveSnapshotData,
  runBounded,
  SNAPSHOT_TIMEOUT_MS,
  settleThenRender,
  snapshotReceipt,
  sanitizeFixtureReads,
  type ReadRecord,
} from './snapshot-data.js';
import { parseArgv } from './argv.js';
import { nextSnapshotPaint } from './snapshot-frame.js';
import { assertSnapshotOutcome, SNAPSHOT_OUTCOME_WAIT_SCRIPT } from './renderer/snapshot-outcome.js';
import { formatTrayLine } from './format.js';
import { renderTrayIconPng } from './icons.js';
import { serviceUnitInstalled, windowsScheduledTaskInstalled } from './service-detect.js';
import { createNodeLinuxServiceRuntimeHost, inspectLinuxServiceRecovery, runLinuxBackgroundActivation, terminateOwnedTransientDaemon, type LinuxDaemonQuiescence } from './linux-service-runtime.js';
import {
  recordLinuxTransientChildError,
  recordLinuxTransientChildExit,
  requestLinuxTrayQuit,
  type LinuxTransientDaemonState,
  type LinuxTrayQuitPrompt,
} from './transient-daemon-quit.js';
import { ipcRefusal, isAllowedNavigation, isAllowedRange, isAllowedSource, isMainFrame, isReasonableSessionId, isReadRequestId } from './ipc-guard.js';
import type { Range, Source } from '../core/types.js';
import { getPaths } from '../daemon/paths.js';
import { configureTrayProfile } from './profile.js';
import { writeTrayLifecycleEvent } from './lifecycle-log.js';
import { snapshotFixtureMarker } from './fixture-example.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..'); // dist/tray/.. .. (or src/tray/.. .. under tsx)

const parsedArgv = parseArgv(process.argv.slice(1));
// A request with no usable path is still snapshot mode, so it is refused below and never reaches the normal tray start.
const SNAPSHOT_MODE = parsedArgv.snapshotRequested;
// Snapshot verification must never show or focus a window. Use Electron's software output device;
// normal interactive tray rendering keeps its existing acceleration and window behavior.
if (SNAPSHOT_MODE) app.disableHardwareAcceleration();
// The snapshot's data source is decided here, once, and a conflicting request is refused (see snapshot-data.ts). Fixtures keep
// the mock directory they always had (an inherited TOKENELO_MOCK, else test/fixtures/api). Live leaves the mock variable unset, so
// the client reads the running local API.
const SNAPSHOT_SOURCE = SNAPSHOT_MODE
  ? resolveSnapshotData(parsedArgv, process.env, path.join(REPO_ROOT, 'test', 'fixtures', 'api'))
  : null;
if (SNAPSHOT_SOURCE?.ok && SNAPSHOT_SOURCE.data.mode === 'fixtures') {
  process.env.TOKENELO_MOCK = SNAPSHOT_SOURCE.data.mockDir;
}

const transientDaemonState: LinuxTransientDaemonState<ChildProcess> = { child: null, ownership: 'not-started' };
let linuxActivationPromise: Promise<void> | null = null;
let linuxTrayQuitInProgress = false;

// ── daemon reachability (DESIGN §15.7.5; see ./service-detect.ts for the unit-detection logic) ─

async function startDaemonIfNeeded(): Promise<void> {
  const reachable = await isDaemonReachable();
  if (reachable) {
    if (transientDaemonState.ownership !== 'owned-running') transientDaemonState.ownership = 'unknown-existing';
    return;
  }
  if (transientDaemonState.child && transientDaemonState.child.exitCode === null && transientDaemonState.child.signalCode === null) return;
  const hasUnit = process.platform === 'win32' ? windowsScheduledTaskInstalled() : serviceUnitInstalled();
  if (hasUnit) return; // a service unit exists but isn't up yet — not ours to start
  const daemonEntry = path.join(REPO_ROOT, 'dist', 'daemon', 'main.js');
  if (!fs.existsSync(daemonEntry)) return; // not built yet; nothing to spawn
  const spec = createDaemonSpawnSpec(process.execPath, daemonEntry, process.env);
  const child = spawn(spec.command, spec.args, spec.options);
  transientDaemonState.child = child;
  transientDaemonState.ownership = 'owned-running';
  child.once('exit', () => { recordLinuxTransientChildExit(transientDaemonState, child); });
  child.once('error', () => {
    const disposition = recordLinuxTransientChildError(transientDaemonState, child);
    if (disposition === 'pre-spawn-failed') writeTrayLifecycleEvent('daemon-start-failed');
  });
  child.unref();
}

function waitForOwnedChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function quiesceForLinuxServiceActivation(): Promise<LinuxDaemonQuiescence> {
  const child = transientDaemonState.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    if (transientDaemonState.ownership !== 'owned-exited' && transientDaemonState.ownership !== 'spawn-failed') {
      return { quiescent: false, stoppedOwnedTransient: false };
    }
    try { return { quiescent: !(await isDaemonReachable()), stoppedOwnedTransient: false }; }
    catch { return { quiescent: false, stoppedOwnedTransient: false }; }
  }
  let exited = false;
  try { exited = await terminateOwnedTransientDaemon(child, timeoutMs => waitForOwnedChildExit(child, timeoutMs)); }
  catch { exited = child.exitCode !== null || child.signalCode !== null; }
  if (!exited) return { quiescent: false, stoppedOwnedTransient: false };
  recordLinuxTransientChildExit(transientDaemonState, child);
  try { return { quiescent: !(await isDaemonReachable()), stoppedOwnedTransient: true }; }
  catch { return { quiescent: false, stoppedOwnedTransient: true }; }
}

async function enableLinuxBackgroundCollection(): Promise<void> {
  let result;
  try {
    result = await runLinuxBackgroundActivation(createNodeLinuxServiceRuntimeHost(REPO_ROOT, path.join(__dirname, 'main.js')), {
      confirm: async () => {
        const answer = await dialog.showMessageBox({
          type: 'question',
          title: 'Enable Tokenelo background collection?',
          message: 'Enable Tokenelo background collection now and at login?',
          detail: 'This starts the daemon now and registers a user-level systemd unit and desktop autostart entry. Tokenelo’s existing ledger and pricing files are not modified.',
          buttons: ['Enable at login', 'Not now'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return answer.response === 0;
      },
      ensureDaemonQuiescent: quiesceForLinuxServiceActivation,
      resumeTransientDaemon: startDaemonIfNeeded,
    });
  } catch {
    await dialog.showMessageBox({ type: 'warning', title: 'Background activation needs review',
      message: 'Tokenelo could not verify the packaged Linux service prerequisites. No activation was accepted.',
      buttons: ['Close'], defaultId: 0 });
    return;
  }
  if (result.status === 'cancelled' || result.status === 'already-current') return;
  if (result.status === 'activated') {
    tray?.setContextMenu(buildContextMenu());
    await refreshTrayLine();
    return;
  }
  const detail = result.status === 'needs-review'
    ? 'Tokenelo could not prove it was safe to change the background service. No service activation was accepted.'
    : result.recoveryRetained
      ? 'Activation failed and rollback could not be verified. Private recovery files were retained; review is required before retrying.'
      : 'Activation failed. The prior service configuration was restored.';
  const recoveryPath = result.status === 'failed' && result.recoveryRetained ? result.recoveryPath
    : result.status === 'needs-review' && result.reason === 'transaction-owned' ? result.recoveryPath : undefined;
  const recoveryDetail = recoveryPath
    ? `\n\nRecovery location: ${recoveryPath}\nStatus: ${result.status === 'failed' ? 'rollback incomplete; manual review required' : 'existing transaction lock; inspect before retrying'}. No automatic recovery was performed.`
    : '';
  const response = await dialog.showMessageBox({ type: 'warning', title: 'Background activation needs review',
    message: detail + recoveryDetail,
    buttons: recoveryPath ? ['Copy recovery details', 'Close'] : ['Close'],
    defaultId: recoveryPath ? 1 : 0, cancelId: recoveryPath ? 1 : 0, noLink: true });
  if (recoveryPath && response.response === 0) {
    const reason = result.reason;
    clipboard.writeText(`Tokenelo Linux background activation\nStatus: ${result.status}\nReason: ${reason}\nRecovery location: ${recoveryPath}\nAutomatic recovery: none`);
  }
}

function beginLinuxBackgroundCollection(): void {
  if (linuxTrayQuitInProgress || linuxActivationPromise) return;
  const activation = enableLinuxBackgroundCollection();
  linuxActivationPromise = activation;
  const clear = () => { if (linuxActivationPromise === activation) linuxActivationPromise = null; };
  void activation.then(clear, clear);
}

async function confirmLinuxTrayQuit(prompt: LinuxTrayQuitPrompt): Promise<boolean> {
  const copy = prompt === 'pause-owned-transient'
    ? {
      title: 'Quit Tokenelo and pause tracking?',
      message: 'Quit and pause tracking?',
      detail: 'Tokenelo will gracefully stop only the temporary daemon this tray started. Saved usage, pricing, and settings will be preserved. Reopen the tray later to resume tracking.',
      action: 'Quit and pause tracking',
    }
    : prompt === 'pause-owned-transient-and-leave-service'
      ? {
        title: 'Quit the Tokenelo tray?',
        message: 'The temporary daemon this tray started will be stopped; the configured user service will remain untouched and may continue collecting usage.',
        detail: 'Saved usage, pricing, and settings remain on disk.',
        action: 'Quit tray',
      }
    : prompt === 'leave-configured-service'
      ? {
        title: 'Quit the Tokenelo tray?',
        message: 'The configured user service will be left untouched and may continue collecting usage.',
        detail: 'Saved usage, pricing, and settings remain on disk.',
        action: 'Quit tray',
      }
      : {
        title: 'Quit the Tokenelo tray?',
        message: 'Tokenelo cannot confirm ownership of an existing background daemon, so it will be left running.',
        detail: 'Saved usage, pricing, and settings remain on disk. The tray will not signal a daemon started by an older or crashed tray.',
        action: 'Quit tray',
      };
  const answer = await dialog.showMessageBox({
    type: 'question',
    title: copy.title,
    message: copy.message,
    detail: copy.detail,
    buttons: [copy.action, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return answer.response === 0;
}

async function quitFromTrayMenu(): Promise<void> {
  writeTrayLifecycleEvent('quit-requested');
  if (process.platform !== 'linux') {
    app.quit();
    return;
  }
  if (linuxTrayQuitInProgress) return;
  linuxTrayQuitInProgress = true;

  try {
    // Do not race a package activation that is already stopping/restarting the transient daemon.
    // If activation succeeds, the following prompt leaves the now-configured service untouched.
    if (linuxActivationPromise) await linuxActivationPromise;

    let configuredService = false;
    try { configuredService = serviceUnitInstalled(); }
    catch { configuredService = true; } // uncertainty must not be represented as no configured service
    const child = transientDaemonState.child;
    const result = await requestLinuxTrayQuit({
      ownership: transientDaemonState.ownership,
      child,
      configuredService,
      confirm: confirmLinuxTrayQuit,
      waitForExit: timeoutMs => child ? waitForOwnedChildExit(child, timeoutMs) : Promise.resolve(false),
      stopFailure: async reason => {
        lastStatusLabel = reason === 'child-identity-unavailable'
          ? 'Daemon process identity needs review'
          : 'Tracking stop not confirmed — daemon may still be draining';
        tray?.setToolTip(lastStatusLabel);
        await dialog.showMessageBox({
          type: 'warning',
          title: reason === 'child-identity-unavailable' ? 'Daemon identity needs review' : 'Tracking is still stopping',
          message: reason === 'child-identity-unavailable'
            ? 'Tokenelo could not verify a process identity for the tray-owned daemon and did not signal it.'
            : 'Tokenelo could not confirm that the tray-owned daemon stopped within 30 seconds.',
          detail: 'The tray remains open and keeps its process ownership. No forced kill was sent. You can retry Quit after checking the current tracking state.',
          buttons: ['Keep Tokenelo open'], defaultId: 0, cancelId: 0, noLink: true,
        });
      },
      quit: () => app.quit(),
    });
    if (result === 'cancelled' || result === 'confirmation-failed' || result === 'stop-unconfirmed') {
      linuxTrayQuitInProgress = false;
    }
  } catch {
    linuxTrayQuitInProgress = false;
    try {
      await dialog.showMessageBox({ type: 'warning', title: 'Tokenelo remains open',
        message: 'Tokenelo could not verify a safe tray shutdown. No unowned background process was stopped.',
        buttons: ['Keep Tokenelo open'], defaultId: 0, cancelId: 0, noLink: true });
    } catch { /* Retain the tray and child even when the warning surface is unavailable. */ }
  }
}

async function reviewLinuxBackgroundRecovery(): Promise<void> {
  let inspection: ReturnType<typeof inspectLinuxServiceRecovery>;
  try {
    inspection = inspectLinuxServiceRecovery(createNodeLinuxServiceRuntimeHost(REPO_ROOT, path.join(__dirname, 'main.js')));
  } catch {
    await dialog.showMessageBox({ type: 'warning', title: 'Background recovery needs review',
      message: 'Tokenelo could not inspect the Linux service recovery state. No files were changed.',
      buttons: ['Close'], defaultId: 0, cancelId: 0, noLink: true });
    return;
  }
  if (inspection.status === 'none') {
    await dialog.showMessageBox({ type: 'info', title: 'Background recovery',
      message: 'No retained Linux service recovery files were found. No files were changed.',
      buttons: ['Close'], defaultId: 0, cancelId: 0, noLink: true });
    return;
  }
  const message = inspection.status === 'verified-manual-review'
    ? `The receipt, backups, and current managed files are consistent. Tokenelo cannot prove whether another process still holds this transaction, so do not retry or remove it yet. This inspection is read-only; Tokenelo will not restore or remove files automatically.\n\nRecovery location: ${inspection.recoveryPath}`
    : `Tokenelo cannot verify the retained recovery state (${inspection.reason}). Do not retry activation until it has been reviewed. No files were changed.\n\nRecovery location: ${inspection.recoveryPath}`;
  const response = await dialog.showMessageBox({ type: inspection.status === 'verified-manual-review' ? 'info' : 'warning',
    title: 'Background recovery review', message, buttons: ['Copy recovery details', 'Close'],
    defaultId: 1, cancelId: 1, noLink: true });
  if (response.response === 0) {
    clipboard.writeText(`Tokenelo Linux background recovery\nStatus: ${inspection.status}\n${inspection.status === 'needs-review' ? `Reason: ${inspection.reason}\n` : ''}Recovery location: ${inspection.recoveryPath}\nAction taken: read-only inspection; no restore or deletion`);
  }
}

// ── tray icon + line ────────────────────────────────────────────────────────────────────────────

function buildTrayImage(): NativeImage {
  const variant = process.platform === 'darwin' ? 'template' : 'accent';
  const size = process.platform === 'darwin' ? 18 : 16;
  const png1x = renderTrayIconPng(size, variant);
  const png2x = renderTrayIconPng(size * 2, variant);
  const image = nativeImage.createFromBuffer(png1x, { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: png2x });
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

let tray: Tray | null = null;
let popover: BrowserWindow | null = null;
let detailWindow: BrowserWindow | null = null;
let lastStatusLabel = 'Starting…';
let apiClient: ApiClient;

async function refreshTrayLine(): Promise<void> {
  if (!tray) return;
  try {
    const summary = await apiClient.getSummary('today');
    const line = formatTrayLine(summary.totals);
    if (process.platform === 'darwin') tray.setTitle(line);
    tray.setToolTip(line);
    lastStatusLabel = `Tokenelo — ${summary.host} — ${line}`;
  } catch (err) {
    if (process.platform === 'darwin') tray.setTitle('');
    tray.setToolTip('Tokenelo — daemon unreachable');
    lastStatusLabel = `Daemon unreachable: ${(err as Error).message}`;
  }
  tray.setContextMenu(buildContextMenu());
}

function buildContextMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    { label: 'Open Tokenelo', click: () => showPopover() },
    ...(process.platform === 'linux' && app.isPackaged && !serviceUnitInstalled()
      ? [{ label: 'Enable background collection at login…', click: () => {
        beginLinuxBackgroundCollection();
      } }]
      : []),
    ...(process.platform === 'linux' && app.isPackaged
      ? [{ label: 'Review background recovery…', click: () => {
        void reviewLinuxBackgroundRecovery().catch(() => { /* The native dialog can reject if the app is quitting. */ });
      } }]
      : []),
    { type: 'separator' },
    { label: lastStatusLabel, enabled: false },
    { type: 'separator' },
    { label: 'Refresh', click: () => void refreshTrayLine() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        void quitFromTrayMenu();
      },
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ── popover ─────────────────────────────────────────────────────────────────────────────────────

const POPOVER_WIDTH = 400;
const POPOVER_HEIGHT = 600;

// The only file this app's popover BrowserWindow ever legitimately loads (see popoverUrl()) —
// computed once so createPopover()'s will-navigate guard and popoverUrl() share the same value.
const POPOVER_FILE_PATH = path.join(__dirname, 'renderer', 'index.html');

function createPopover(opts?: { keepHiddenOnBlur?: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    useContentSize: true,
    show: false,
    focusable: !SNAPSHOT_MODE,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: SNAPSHOT_MODE,
      backgroundThrottling: !SNAPSHOT_MODE,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit even though Electron's renderer sandbox is on by default in modern versions —
      // states the requirement so a future Electron upgrade or config change can't silently
      // disable it without the change being visible here.
      sandbox: true,
    },
  });
  win.setContentSize(POPOVER_WIDTH, POPOVER_HEIGHT);
  containSnapshotWindow(win);
  win.on('blur', () => {
    if (!opts?.keepHiddenOnBlur) win.hide();
  });
  // This window's only legitimate destination is its own local renderer/index.html (built by
  // popoverUrl() below) — never anywhere else, whether reached by a link, a redirect, or a
  // compromised renderer trying to navigate itself. The actual allow/deny decision lives in
  // ipc-guard.ts's isAllowedNavigation() so it's unit-tested without Electron.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, POPOVER_FILE_PATH)) event.preventDefault();
  });
  // This is a local read-only viewer — it should never open new windows/tabs (window.open,
  // target=_blank, etc.).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

function popoverUrl(tab: string, theme: 'light' | 'dark' | null, range: Range = 'today'): string {
  const params = new URLSearchParams({ tab });
  if (theme) params.set('theme', theme);
  params.set('range', range);
  return `file://${POPOVER_FILE_PATH}?${params.toString()}`;
}

function positionPopover(win: BrowserWindow): void {
  const bounds = tray?.getBounds();
  if (bounds && (bounds.width > 0 || bounds.height > 0)) {
    const x = Math.round(bounds.x + bounds.width / 2 - POPOVER_WIDTH / 2);
    const y = process.platform === 'darwin' ? bounds.y + bounds.height : bounds.y - POPOVER_HEIGHT;
    win.setPosition(Math.max(0, x), Math.max(0, y));
    return;
  }
  // Tray bounds unavailable (e.g. some Linux desktop environments) → center on the primary display.
  const { workArea } = screen.getPrimaryDisplay();
  win.setPosition(
    Math.round(workArea.x + workArea.width / 2 - POPOVER_WIDTH / 2),
    Math.round(workArea.y + workArea.height / 2 - POPOVER_HEIGHT / 2)
  );
}

function showPopover(): void {
  if (!popover || popover.isDestroyed()) popover = createPopover();
  positionPopover(popover);
  popover.loadURL(popoverUrl('now', null));
  popover.show();
  popover.focus();
}

// ── session-detail window ──────────────────────────────────────────────────────────────────────

const DETAIL_WIDTH = 960;
const DETAIL_HEIGHT = 720;
const DETAIL_MIN_WIDTH = 640;
const DETAIL_MIN_HEIGHT = 420;

// The only file the detail window ever legitimately loads (see detailUrl()) — its own value,
// separate from POPOVER_FILE_PATH, so a compromised detail renderer can't navigate itself to the
// popover's file (or vice versa) and inherit that window's IPC-handler trust.
const DETAIL_FILE_PATH = path.join(__dirname, 'renderer', 'detail.html');

/** Normal resizable app window (unlike the popover, it does NOT hide on blur — it's a real
 * window the founder spec asks for, not a menu-bar dropdown), with the identical security posture
 * as the popover: contextIsolation, sandbox, no Node integration, navigation locked to its own
 * file, no new windows. */
function createDetailWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: DETAIL_WIDTH,
    height: DETAIL_HEIGHT,
    useContentSize: true,
    minWidth: DETAIL_MIN_WIDTH,
    minHeight: DETAIL_MIN_HEIGHT,
    show: false,
    focusable: !SNAPSHOT_MODE,
    skipTaskbar: SNAPSHOT_MODE,
    resizable: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: SNAPSHOT_MODE,
      backgroundThrottling: !SNAPSHOT_MODE,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setContentSize(DETAIL_WIDTH, DETAIL_HEIGHT);
  containSnapshotWindow(win);
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, DETAIL_FILE_PATH)) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    if (detailWindow === win) detailWindow = null;
  });
  return win;
}

function detailUrl(source: string, sessionId: string, theme: 'light' | 'dark' | null): string {
  const params = new URLSearchParams({ source, sessionId });
  if (theme) params.set('theme', theme);
  return `file://${DETAIL_FILE_PATH}?${params.toString()}`;
}

/** Opens the detail window for `(source, sessionId)`, or — if one is already open — focuses it
 * and swaps its data in place via the `tokenelo:loadSession` IPC event (founder spec: "One detail
 * window reused (focus + update if already open)"), rather than spawning a second window. */
function showSessionDetail(source: Source, sessionId: string): void {
  if (detailWindow && !detailWindow.isDestroyed()) {
    if (!SNAPSHOT_MODE) detailWindow.focus();
    detailWindow.webContents.send('tokenelo:loadSession', { source, sessionId });
    return;
  }
  detailWindow = createDetailWindow();
  detailWindow.loadURL(detailUrl(source, sessionId, parsedArgv.theme ?? null));
  if (!SNAPSHOT_MODE) {
    detailWindow.once('ready-to-show', () => detailWindow?.show());
    detailWindow.show();
    detailWindow.focus();
  }
}

// ── IPC bridge (backs preload.ts's TokeneloBridge) ─────────────────────────────────────────────

/** Throws unless `event.senderFrame` is the main frame of EITHER known window (the popover or the
 * session-detail window) — rejects an IPC message that somehow arrived from anything else (e.g. a
 * subframe, or a window this process never created). ipcMain.handle propagates a thrown error
 * back to the renderer as a rejected promise, which is the correct behavior here. */
function assertKnownFrame(event: IpcMainInvokeEvent): void {
  const fromPopover = isMainFrame(event.senderFrame, popover?.webContents.mainFrame);
  const fromDetail = isMainFrame(event.senderFrame, detailWindow?.webContents.mainFrame);
  if (!fromPopover && !fromDetail) {
    throw ipcRefusal('frame');
  }
}

const summaryReads = new Map<number, { id: string; controller: AbortController }>();
const usageReads = new Map<number, { id: string; controller: AbortController }>();
function registerIpcHandlers(): void {
  ipcMain.handle('tokenelo:getSnapshotFixtureMarker', (e) => {
    assertKnownFrame(e);
    return snapshotFixtureMarker(SNAPSHOT_MODE, SNAPSHOT_SOURCE?.ok ? SNAPSHOT_SOURCE.data.mode : null);
  });
  ipcMain.handle('tokenelo:getSummary', async (e, range: Range, requestId?: string) => {
    assertKnownFrame(e);
    if (!isAllowedRange(range)) throw ipcRefusal('range');
    if (requestId !== undefined && !isReadRequestId(requestId)) throw ipcRefusal('request');
    summaryReads.get(e.sender.id)?.controller.abort(new SummaryReadRetiredError());
    if (range !== 'all') return apiClient.getSummary(range);
    const read = { id: requestId ?? crypto.randomBytes(16).toString('hex'), controller: new AbortController() };
    summaryReads.set(e.sender.id, read);
    const cancel = () => read.controller.abort(new SummaryReadRetiredError());
    e.sender.once('destroyed', cancel);
    try {
      return await apiClient.getSummaryReport(range, { signal: read.controller.signal, onProgress: progress => {
        if (summaryReads.get(e.sender.id) === read && !e.sender.isDestroyed()) e.sender.send('tokenelo:summary-progress', { ...progress, range, requestId: read.id });
      } });
    } finally {
      e.sender.removeListener('destroyed', cancel);
      if (summaryReads.get(e.sender.id) === read) summaryReads.delete(e.sender.id);
    }
  });
  ipcMain.handle('tokenelo:cancelSummary', (e, requestId: string) => {
    assertKnownFrame(e);
    if (!isReadRequestId(requestId)) throw ipcRefusal('request');
    const read = summaryReads.get(e.sender.id);
    if (read?.id === requestId) read.controller.abort(new SummaryReadRetiredError());
  });
  ipcMain.handle('tokenelo:getUsage', async (e, range: Range, requestId?: string) => {
    assertKnownFrame(e);
    if (!isAllowedRange(range)) throw ipcRefusal('range');
    if (requestId !== undefined && !isReadRequestId(requestId)) throw ipcRefusal('request');
    usageReads.get(e.sender.id)?.controller.abort(new SummaryReadRetiredError());
    const read = { id: requestId ?? crypto.randomBytes(16).toString('hex'), controller: new AbortController() };
    usageReads.set(e.sender.id, read);
    const cancel = () => read.controller.abort(new SummaryReadRetiredError());
    e.sender.once('destroyed', cancel);
    try {
      return await apiClient.getUsage(range, { signal: read.controller.signal, onProgress: progress => {
        if (usageReads.get(e.sender.id) === read && !e.sender.isDestroyed()) e.sender.send('tokenelo:usage-progress', { ...progress, range, requestId: read.id });
      } });
    } finally {
      e.sender.removeListener('destroyed', cancel);
      if (usageReads.get(e.sender.id) === read) usageReads.delete(e.sender.id);
    }
  });
  ipcMain.handle('tokenelo:cancelUsage', (e, requestId: string) => {
    assertKnownFrame(e);
    if (!isReadRequestId(requestId)) throw ipcRefusal('request');
    const read = usageReads.get(e.sender.id);
    if (read?.id === requestId) read.controller.abort(new SummaryReadRetiredError());
  });
  ipcMain.handle('tokenelo:getSessions', (e, range?: Range) => {
    assertKnownFrame(e);
    if (range !== undefined && !isAllowedRange(range)) throw ipcRefusal('range');
    return apiClient.getSessions(range);
  });
  ipcMain.handle('tokenelo:getSessionsResponse', (e, range?: Range) => {
    assertKnownFrame(e);
    if (range !== undefined && !isAllowedRange(range)) throw ipcRefusal('range');
    return apiClient.getSessionsResponse(range);
  });
  ipcMain.handle('tokenelo:getLimits', (e) => {
    assertKnownFrame(e);
    return apiClient.getLimits();
  });
  ipcMain.handle('tokenelo:getTimeseries', (e, range: Range) => {
    assertKnownFrame(e);
    if (!isAllowedRange(range)) throw ipcRefusal('range');
    return apiClient.getTimeseries(range);
  });
  ipcMain.handle('tokenelo:getDoctor', (e) => {
    assertKnownFrame(e);
    return apiClient.getDoctor();
  });
  ipcMain.handle('tokenelo:getCoverage', (e) => {
    assertKnownFrame(e);
    return apiClient.getCoverage();
  });
  ipcMain.handle('tokenelo:getProcesses', (e) => {
    assertKnownFrame(e);
    return apiClient.getProcesses();
  });
  ipcMain.handle('tokenelo:getFleetOverview', (e, range: Range) => {
    assertKnownFrame(e);
    if (!isAllowedRange(range)) throw ipcRefusal('range');
    return apiClient.getFleetOverview(range);
  });
  ipcMain.handle('tokenelo:getSessionDetail', (e, source: Source, sessionId: string) => {
    assertKnownFrame(e);
    if (!isAllowedSource(source)) throw ipcRefusal('source');
    if (!isReasonableSessionId(sessionId)) throw ipcRefusal('session');
    return apiClient.getSessionDetail(source, sessionId);
  });
  ipcMain.handle('tokenelo:openSessionDetail', (e, source: Source, sessionId: string) => {
    assertKnownFrame(e);
    if (!isAllowedSource(source)) throw ipcRefusal('source');
    if (!isReasonableSessionId(sessionId)) throw ipcRefusal('session');
    showSessionDetail(source, sessionId);
  });
  ipcMain.handle('tokenelo:closeSessionDetail', (e) => {
    assertKnownFrame(e);
    if (detailWindow && !detailWindow.isDestroyed()) detailWindow.close();
  });
  ipcMain.handle('tokenelo:getTheme', (e): 'light' | 'dark' => {
    assertKnownFrame(e);
    return parsedArgv.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  nativeTheme.on('updated', () => {
    const theme: 'light' | 'dark' = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    popover?.webContents.send('tokenelo:themeChanged', theme);
    detailWindow?.webContents.send('tokenelo:themeChanged', theme);
  });
}

// ── snapshot mode ───────────────────────────────────────────────────────────────────────────────

/** The live snapshot's reads and the port they went to. Null for fixtures, whose reads are not checked (see snapshot-data.ts). */
let liveReads: { record: ReadRecord; port: number } | null = null;
/** A partial interactive view is useful; a failed fixture read cannot certify a snapshot. */
let fixtureReadFailed = false;

/** Fail closed if a snapshot window is ever shown or focused; no opacity-based workaround. */
function containSnapshotWindow(win: BrowserWindow): void {
  if (!SNAPSHOT_MODE) return;
  const refuse = () => exitSnapshot(1, 'tray snapshot: window visibility containment failed');
  win.on('show', refuse);
  win.on('focus', refuse);
}

/** Wait for renderer reads/DOM updates, explicitly invalidate the offscreen compositor, then
 * write the resulting paint. Unlike capturePage(), this does not sample an earlier backing store. */
async function captureAndExit(win: BrowserWindow, outPath: string): Promise<void> {
  assertSnapshotOutcome(await win.webContents.executeJavaScript(SNAPSHOT_OUTCOME_WAIT_SCRIPT));
  // The reads settle first; the frames run after every read has settled and no read started during a frame, so the image shows the
  // DOM after the last background update (the boot Doctor badge included). The extra timeout lets the renderer's own IPC continuation run.
  await settleThenRender(liveReads?.record ?? null, () =>
    win.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)))))'
    )
  );
  if (liveReads?.record.failure) {
    exitSnapshot(1, readFailureLine(liveReads.record));
    return;
  }
  if (fixtureReadFailed) {
    exitSnapshot(1, 'tray snapshot failed: a fixture read failed. No image was written.');
    return;
  }
  assertSnapshotOutcome(await win.webContents.executeJavaScript('({ ok: window.__tokeneloReady === true, category: window.__tokeneloFailure })'));
  if (!win.webContents.isOffscreen() || win.isVisible() || win.isFocused()) {
    throw new Error('snapshot window is not hidden and offscreen');
  }
  const image = await nextSnapshotPaint<NativeImage>({
    subscribePaint: (listener) => {
      const paint = (_event: unknown, _dirty: unknown, next: NativeImage) => listener(next);
      win.webContents.on('paint', paint);
      return () => win.webContents.removeListener('paint', paint);
    },
    invalidate: () => win.webContents.invalidate(),
  });
  if (image.isEmpty() || win.isVisible() || win.isFocused()) throw new Error('invalid hidden snapshot frame');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, image.toPNG());
  if (SNAPSHOT_SOURCE?.ok) {
    const rangeReceipt = parsedArgv.rangeRequested ? ` range=${parsedArgv.range}` : '';
    process.stdout.write(`${snapshotReceipt(SNAPSHOT_SOURCE.data, liveReads?.record.reads ?? 0, liveReads?.port ?? 0, liveReads?.record.retired ?? 0)} render=software-offscreen visible=false focused=false${rangeReceipt}\n`);
  }
  win.destroy();
  app.quit();
}

async function runSnapshot(outPath: string): Promise<void> {
  registerIpcHandlers();
  if (parsedArgv.session) {
    await runDetailSnapshot(outPath, parsedArgv.session);
    return;
  }
  await runPopoverSnapshot(outPath);
}

/** Renders the session-detail window without showing or focusing it (`--session <source>:<id>`). */
async function runDetailSnapshot(outPath: string, session: NonNullable<typeof parsedArgv.session>): Promise<void> {
  const win = createDetailWindow();
  // assertKnownFrame() (used by every IPC handler registered above) checks the sender against the
  // module-level `detailWindow` — assign it here too, exactly like the popover flow below, or
  // every IPC call this offscreen renderer makes while rendering would be wrongly rejected.
  detailWindow = win;
  await win.loadURL(detailUrl(session.source, session.sessionId, parsedArgv.theme ?? 'light'));
  await captureAndExit(win, outPath);
}

async function runPopoverSnapshot(outPath: string): Promise<void> {
  const win = createPopover({ keepHiddenOnBlur: true });
  // assertMainFrame() (used by every IPC handler registered above) checks the sender against the
  // module-level `popover` window — snapshot mode never calls showPopover() (the only other place
  // that assigns it), so it must be assigned here too, or every IPC call this offscreen renderer
  // makes while rendering would be wrongly rejected as "not the main frame".
  popover = win;
  await win.loadURL(popoverUrl(parsedArgv.tab, parsedArgv.theme ?? 'light', parsedArgv.range));
  await captureAndExit(win, outPath);
}

/** The `--snapshot` entry. Refuses a bad source before anything starts, routes live reads through the recorder, and bounds the run.
 * It starts no daemon, registers no service and runs no collector: the live client only reads the running local API. */
async function runSnapshotEntry(): Promise<void> {
  const source = SNAPSHOT_SOURCE;
  if (!source || !source.ok) {
    exitSnapshot(2, `tray snapshot: ${source && !source.ok ? source.message : 'no data source'}`);
    return;
  }
  await runBounded(
    async () => {
      const port = resolveConfiguredPort(process.env);
      const base = createApiClient({ strictMockRanges: source.data.mode === 'fixtures' && parsedArgv.rangeRequested });
      if (source.data.mode === 'live') {
        const recorded = recordReads(base, port);
        apiClient = recorded.client;
        liveReads = { record: recorded.record, port };
      } else {
        apiClient = sanitizeFixtureReads(base, () => { fixtureReadFailed = true; });
      }
      await app.whenReady();
      await runSnapshot(path.resolve(parsedArgv.snapshotPath as string));
    },
    SNAPSHOT_TIMEOUT_MS,
    exitSnapshot,
    // Read at report time: a first read failure recorded before the deadline is printed with the deadline line, not lost.
    () => liveReads?.record
  );
}

/** Prints the one line for the run, then exits: stdout for success, stderr for a refused or failed snapshot. */
function exitSnapshot(code: number, line: string): void {
  (code === 0 ? process.stdout : process.stderr).write(`${line}\n`);
  app.exit(code);
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  configureTrayProfile(app);
  if (SNAPSHOT_MODE) {
    await runSnapshotEntry();
    return;
  }
  apiClient = createApiClient();
  app.on('before-quit', () => writeTrayLifecycleEvent('app-before-quit'));

  if (!app.requestSingleInstanceLock()) {
    writeTrayLifecycleEvent('instance-lock-refused');
    app.quit();
    return;
  }
  app.on('second-instance', () => showPopover());

  await app.whenReady();
  await startDaemonIfNeeded();

  try {
    const paths = getPaths();
    fs.mkdirSync(paths.dataDir, { recursive: true });
  } catch {
    // best-effort; not fatal to the tray
  }

  tray = new Tray(buildTrayImage());
  tray.setToolTip('Tokenelo');
  tray.setContextMenu(buildContextMenu());
  writeTrayLifecycleEvent('tray-created');
  // Left-click behavior on Linux is not guaranteed by every desktop environment (DESIGN
  // §15.7.5) — some DEs only ever open the context menu on click, ignoring this handler — so
  // the context menu's "Open Tokenelo" item (always present, bound above) is the one guaranteed
  // path to the popover there; this handler is still wired for the DEs that do fire click.
  tray.on('click', () => showPopover());

  registerIpcHandlers();
  await refreshTrayLine();
  setInterval(() => void refreshTrayLine(), 60_000);

  // No `window-all-closed` handler: Electron only auto-quits on that event when the app never
  // disables it AND has no other reason to stay alive; a Tray instance alone keeps the app
  // running on every platform once created, so the popover being hidden/closed is not "all
  // windows closed" in the sense that would quit us. Quitting is `app.quit()` from the menu only.
}

// This module is the Electron main-process entry point, never imported by tests (importing
// 'electron' outside Electron's own runtime throws — see argv.ts's header comment); its testable
// logic lives in modules such as argv.ts, service-detect.ts and profile.ts instead.
void main().catch((err: unknown) => {
  if (!SNAPSHOT_MODE) writeTrayLifecycleEvent('startup-failed');
  process.stderr.write(`${(err as Error).message}\n`);
  app.exit(1);
});
