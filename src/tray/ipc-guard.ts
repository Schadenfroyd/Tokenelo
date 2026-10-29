/**
 * Pure IPC-validation helpers for main.ts's `registerIpcHandlers()` and `createPopover()`, split
 * out (like argv.ts and service-detect.ts) so they can be unit-tested without importing the
 * `electron` module. No Electron import here — everything takes plain values/mock objects.
 *
 * Security model this backs (audit-driven):
 *   - `isAllowedRange`: an IPC handler's `range` argument is attacker-controlled the moment a
 *     renderer is ever compromised by some other bug, even though it's sandboxed/contextIsolated
 *     today — so it must be checked against an allowlist before it reaches api-client.ts, exactly
 *     like the daemon's own HTTP API validates `?range=` (see src/daemon/http.ts's `isRange`/
 *     `VALID_RANGES` — this is intentionally a small independent copy of that same list, not an
 *     import, since daemon/http.ts is Electron-agnostic-unsafe to pull into this test file and is
 *     being edited in parallel by someone else).
 *   - `isMainFrame`: an `ipcMain.handle` callback's `event.senderFrame` must be the popover's own
 *     main frame — rejects a message that somehow arrived from a subframe/child frame.
 *   - `isAllowedNavigation`: the popover BrowserWindow only ever legitimately loads its own local
 *     `file://.../renderer/index.html` (see main.ts's `popoverUrl()`); `will-navigate` must block
 *     everything else, including any `file://` path other than that exact one (e.g. `../` escapes).
 */

import { USAGE_SOURCES } from '../core/types.js';

/** The only `range` values any tray IPC handler accepts (mirrors daemon/http.ts's VALID_RANGES). */
export const ALLOWED_RANGES = ['today', '24h', '7d', '30d', 'all'] as const;

export type AllowedRange = (typeof ALLOWED_RANGES)[number];

/** Type guard: true only for an exact-match, exact-case member of ALLOWED_RANGES — no trimming,
 * no case-folding, no coercion. A near-miss (wrong case, trailing whitespace, wrong type) is
 * rejected, not silently normalized. */
export function isAllowedRange(v: unknown): v is AllowedRange {
  return typeof v === 'string' && (ALLOWED_RANGES as readonly string[]).includes(v);
}

/** Source identifiers share the collector contract so a newly supported collector can open
 * its detail window through both IPC and HTTP without a second allowlist falling behind. */
export const ALLOWED_SOURCES = USAGE_SOURCES;

export type AllowedSource = (typeof ALLOWED_SOURCES)[number];

export function isAllowedSource(v: unknown): v is AllowedSource {
  return typeof v === 'string' && (ALLOWED_SOURCES as readonly string[]).includes(v);
}

/** `sessionId` is an opaque collector-assigned string with no format to validate beyond
 * "present and not absurdly long" — same bound as daemon/http.ts's MAX_SESSION_ID_LEN, so a
 * renderer that somehow got compromised can't hand the main process an unbounded string to shell
 * out to the daemon (or a filesystem path, in --snapshot's mock mode) with. */
export const MAX_SESSION_ID_LEN = 512;

export function isReasonableSessionId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_SESSION_ID_LEN;
}

/** Electron logs main-process handler rejections. Refusals must not echo caller data or a
 * main-process stack. Validation remains with the existing guards; only reporting is qualified. */
export function isReadRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}
export function ipcRefusal(kind: 'frame' | 'range' | 'source' | 'session' | 'request'): Error {
  const messages = {
    frame: "rejected: sender is not a known window's main frame",
    range: 'invalid range',
    source: 'invalid source',
    session: 'invalid sessionId',
    request: 'invalid read request',
  } as const;
  const err = new Error(messages[kind]);
  err.name = 'TokeneloIpcRefusal';
  Object.defineProperty(err, 'stack', { value: undefined, enumerable: false, configurable: true, writable: true });
  return err;
}

/** True iff `senderFrame` is identity-equal to `mainFrame` — the check an `ipcMain.handle`
 * callback uses to reject a message from anything other than the popover's own main frame.
 * `isMainFrame(undefined, undefined)` is defined to be `true`: production code never passes
 * `undefined` for either side (both are always real WebFrameMain instances), so this edge case
 * only matters for pinning the comparison's exact semantics (`===`) in tests. */
export function isMainFrame(senderFrame: unknown, mainFrame: unknown): boolean {
  return senderFrame === mainFrame;
}

/**
 * True iff `targetUrl` is exactly the popover's own local file (protocol `file:`, no remote host,
 * and a pathname matching `allowedFilePath`, ignoring any query string — query strings legitimately
 * vary by tab and theme, see `popoverUrl()`). Used by main.ts's `will-navigate` handler to block
 * navigation to anything else, including a different local file reached via `..` traversal.
 *
 * Normalization: verified empirically (ipc-guard.test.ts) that WHATWG `URL`'s own path parser
 * already resolves `.`/`..` dot-segments into a `file:` URL's `.pathname` (e.g.
 * `file:///app/dist/tray/renderer/../../../etc/passwd` → pathname `/app/etc/passwd`, not the raw
 * unresolved string) — so a plain `pathname === allowedPath` comparison is already safe against
 * basic `../` traversal. This function still explicitly `decodeURIComponent`s and re-runs the
 * result through `normalizePosixPath` before comparing, as defense-in-depth: the guard's
 * correctness then doesn't silently depend on that parser behavior alone, and it stays correct
 * even for inputs (extra `.`/`..` segments, encoded separators) the parser might not collapse.
 */
export function isAllowedNavigation(targetUrl: string, allowedFilePath: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  if (parsed.hostname !== '' && parsed.hostname.toLowerCase() !== 'localhost') return false;

  let decodedTargetPath: string;
  try {
    decodedTargetPath = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }

  const targetPath = normalizePosixPath(decodedTargetPath);
  const allowedPath = normalizePosixPath(normalizeAllowedFilePath(allowedFilePath));
  return targetPath === allowedPath;
}

/** A native Windows drive path is converted to the URL pathname shape before POSIX normalization. */
function normalizeAllowedFilePath(filePath: string): string {
  const drivePath = /^([a-zA-Z]):[\\/]/.exec(filePath);
  if (!drivePath) return filePath;
  return `/${drivePath[1]}:${filePath.slice(2).replace(/\\/g, '/')}`;
}

/** Resolves `.`/`..` segments in a POSIX-style absolute path without touching the filesystem
 * (`path.normalize` alone is not enough on win32 hosts, since a `file:` URL's pathname is always
 * `/`-separated regardless of platform — this always treats the input as POSIX). A leading `..`
 * that would escape the root collapses to `/` rather than climbing above it, matching how a real
 * filesystem root behaves. */
function normalizePosixPath(p: string): string {
  const isAbsolute = p.startsWith('/');
  const segments = p.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (isAbsolute ? '/' : '') + out.join('/');
}
