/**
 * `--snapshot`/`--tab`/`--theme` argv parsing, split out of main.ts so it can be unit-tested
 * without importing the `electron` module — that module's Node-side entry point exports a plain
 * string (the path to the Electron binary) rather than `{app, BrowserWindow, ...}` unless the
 * process is actually running inside Electron's runtime, so `import { app } from 'electron'`
 * throws `SyntaxError: Named export 'app' not found` under plain Node/vitest (verified: see the
 * commit history / this module's test file for the reproduction). Keeping argv parsing here lets
 * test/tray/argv.test.ts import it directly with zero Electron dependency.
 *
 * Value rule. A flag that takes a value consumes the next argument only when that argument is
 * present, non-empty and does not start with `-`. Otherwise the flag has no value and the next
 * argument is read as a flag of its own. So `--tab --snapshot x.png` still requests a snapshot.
 * `--snapshot` with no usable path sets `snapshotRequested` and `snapshotError`: the request is
 * refused, and it never falls through to the normal tray start.
 */
import type { Range } from '../core/types.js';
import { isRangeScopedTab } from './renderer/initial-scope.js';

export interface SnapshotSession {
  source: string;
  sessionId: string;
}

export interface TrayArgv {
  /** True when `--snapshot` appears at all, with or without a usable path. This is what selects snapshot mode. */
  snapshotRequested: boolean;
  snapshotPath: string | null;
  /** Set when `--snapshot` has no usable path (none, empty, or followed by a flag). A refused request, never a normal start. */
  snapshotError: string | null;
  tab: string;
  theme: 'light' | 'dark' | null;
  /** `--data live|fixtures` for `--snapshot` (default `fixtures`): which data source the snapshot renders. `live` reads the already-running
   * local API with the configured token; `fixtures` renders the canned fixture set. See src/tray/snapshot-data.ts. */
  data: 'fixtures' | 'live';
  /** Set when `--data` has no value or an unknown value. The snapshot refuses to run; it never falls back to a default source. */
  dataError: string | null;
  /** Explicit ranges apply only to Sessions/Usage/Local/Fleet snapshots; detail is all recorded history. */
  rangeRequested: boolean;
  range: Range;
  rangeError: string | null;
  /** `--session <source>:<id>` (e.g. `claude:abc-123`): render the session-detail window instead
   * of the popover in `--snapshot` mode. `null` when not passed (the default: snapshot the
   * popover). Split on the FIRST `:` only — a sessionId itself may contain `:` (Codex thread ids,
   * Ollama's `<client>:<model>:<date>` keys), so splitting on every `:` would truncate it. */
  session: SnapshotSession | null;
}

/** The value after argv[i], if a flag can take it: present, non-empty, and not another flag. */
function valueAfter(argv: string[], i: number): string | null {
  const v = argv[i + 1];
  if (v === undefined || v === '' || v.startsWith('-')) return null;
  return v;
}

export function parseArgv(argv: string[]): TrayArgv {
  let snapshotRequested = false;
  let snapshotPath: string | null = null;
  let snapshotError: string | null = null;
  let tab = 'now';
  let theme: 'light' | 'dark' | null = null;
  let session: SnapshotSession | null = null;
  let data: 'fixtures' | 'live' = 'fixtures';
  let dataError: string | null = null;
  let rangeRequested = false;
  let range: Range = 'today';
  let rangeError: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--snapshot') {
      snapshotRequested = true;
      const v = valueAfter(argv, i);
      if (v === null) {
        snapshotPath = null;
        snapshotError = '--snapshot needs an output image path (not empty, and not another flag)';
      } else {
        snapshotPath = v;
        snapshotError = null;
        i++;
      }
    } else if (flag === '--tab') {
      const v = valueAfter(argv, i);
      if (v !== null) {
        tab = v;
        i++;
      }
    } else if (flag === '--theme') {
      const v = valueAfter(argv, i);
      if (v !== null) {
        i++;
        if (v === 'light' || v === 'dark') theme = v;
      }
    } else if (flag === '--session') {
      const v = valueAfter(argv, i);
      if (v !== null) {
        i++;
        const sepIdx = v.indexOf(':');
        if (sepIdx > 0 && sepIdx < v.length - 1) {
          session = { source: v.slice(0, sepIdx), sessionId: v.slice(sepIdx + 1) };
        }
      }
    } else if (flag === '--range') {
      rangeRequested = true;
      const v = valueAfter(argv, i);
      if (v === 'today' || v === '24h' || v === '7d' || v === '30d' || v === 'all') {
        range = v;
        rangeError = null;
        i++;
      } else {
        rangeError = '--range needs the value today, 24h, 7d, 30d or all';
        if (v !== null) i++;
      }
    } else if (flag === '--data') {
      const v = valueAfter(argv, i);
      if (v === 'live' || v === 'fixtures') {
        i++;
        data = v;
        dataError = null;
      } else {
        dataError = '--data needs the value live or fixtures';
        if (v !== null) i++;
      }
    }
  }
  if (rangeRequested && rangeError === null && (session || !isRangeScopedTab(tab))) {
    rangeError = '--range applies only to Sessions, Usage, Local and Fleet; session details show recorded history';
  }
  return { snapshotRequested, snapshotPath, snapshotError, tab, theme, session, data, dataError, rangeRequested, range, rangeError };
}
