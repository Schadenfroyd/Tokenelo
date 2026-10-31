/**
 * Readiness gate for the session-detail window (R45). `--snapshot` (main.ts) captures on
 * `tokenelo:ready`, so ready must mean BOTH: the newest intent's detail painted, AND the initial
 * theme was applied. Boot starts the detail fetch before the OS-theme read settles, so a fast
 * success can arrive first; the gate waits for the theme, then rechecks that the same loader ticket
 * is still the newest intent (an external load, a subagent or Back may have superseded it during
 * that await). A rejected theme read never signals ready: no theme is invented. No DOM here.
 */
import type { DetailTicket } from './detail-load.js';

export function createReadyGate(
  themeApplied: Promise<void>,
  isCurrent: (ticket: DetailTicket) => boolean,
  signal: (ticket: DetailTicket) => void
): (ticket: DetailTicket) => Promise<boolean> {
  return async (ticket) => {
    try {
      await themeApplied;
    } catch {
      return false;
    }
    if (!isCurrent(ticket)) return false;
    signal(ticket);
    return true;
  };
}
