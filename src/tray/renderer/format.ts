import { MAX_DATE_EPOCH_MS } from './response-evidence.js';
/**
 * Pure, dependency-free formatters for the popover **renderer** (Chromium side, no Node/Electron
 * APIs — bundled by esbuild per scripts/build-tray.mjs and typechecked under tsconfig.tray.json,
 * whose `rootDir` is restricted to this directory). Deliberately duplicates the small numeric
 * formatters in ../format.ts (used by the main-process tray title/tooltip) rather than importing
 * across that rootDir boundary — see the comment at the top of ../format.ts.
 */
import { priceFieldsUsable } from './price-evidence.js';

/**
 * Currency with cents and above: two decimals and thousands separators, as before. A nonzero amount below one cent is never shown as $0.00
 * (two decimals would round it to zero): it reads "<$0.01", with the sign kept. Exact zero is $0.00.
 */
export function formatMoney(usd: number): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs === 0) return '$0.00';
  if (abs < 0.01) return `${sign}<$0.01`;
  const fixed = abs.toFixed(2);
  const [whole, cents] = fixed.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${withCommas}.${cents}`;
}

/** Summary dollars are a priced-event subtotal. An all-unpriced scope has no usable value. */
export function formatApiEquivSubtotal(figure: { apiEquivUsd: number | null; events: number; unpricedEvents?: number | null; priceEvidence?: unknown }): string {
  if (!priceFieldsUsable(figure)) return '—';
  if (figure.apiEquivUsd === null || (figure.events > 0 && figure.unpricedEvents === figure.events)) return '—';
  return formatMoney(figure.apiEquivUsd);
}

/**
 * Tooltip, title and table precision for a dollar amount. Cents and above use formatMoney. Below a cent, three significant digits are shown,
 * capped at six decimals ($0.00445, $0.0022). A value that needs more digits than are shown is marked "≈" so it never claims to be exact.
 * Below one millionth: "<$0.000001", sign kept. Exact zero: $0.00.
 */
export function formatPreciseMoney(usd: number): string {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs === 0) return '$0.00';
  if (abs >= 0.01) return formatMoney(usd);
  if (abs < 0.000001) return `${sign}<$0.000001`;
  const decimals = Math.min(6, -Math.floor(Math.log10(abs)) + 2);
  const shown = abs.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const approx = Number(shown) !== abs ? '≈' : '';
  return `${sign}${approx}$${shown}`;
}

/** Same magnitude rule as the main-process formatter; billion-token histories use B. */
export function formatCompactNumber(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${trimTrailingZero((abs / 1000).toFixed(1))}k`;
  if (abs < 1_000_000_000) return `${sign}${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  return `${sign}${trimTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
}

function trimTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** `ms` → `"1h 23m"` / `"4m"` / `"<1m"` (identical rule to ../format.ts#formatDuration). */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** `"HH:MM:SS"` elapsed/countdown clock, used for locally-ticking timers (Now tab elapsed, Limits
 * reset countdown). Negative or zero durations render as "00:00:00". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** tok/s: 0 tokens or 0 duration → 0 (never NaN/Infinity). Rounded to 1 decimal. */
export function formatTokPerSec(tokens: number, ms: number): string {
  if (ms <= 0 || tokens <= 0) return '0';
  const perSec = tokens / (ms / 1000);
  return trimTrailingZero(perSec.toFixed(1));
}

/** Basename of a cwd/project path, independent of OS separator style in the stored string. */
export function projectBasename(p: string | undefined): string {
  if (!p) return '(unknown)';
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  const base = idx >= 0 ? norm.slice(idx + 1) : norm;
  return base || p;
}

/** A recorded session has an identity even when no workspace metadata was captured.
 * Server-log rows aggregate by their recorded UTC end-day; other short labels are identity
 * previews. Callers retain the full ID in the detail and accessible route. */
export function sessionDisplayName(session: { source?: string; project?: string; repoRoot?: string; sessionId: string }): string {
  const workspace = session.project || session.repoRoot;
  if (workspace) return projectBasename(workspace);
  if (!session.sessionId) return 'Session identity unavailable';
  if (session.source === 'ollama-log') {
    const day = /^serverlog:.+:(\d{4}-\d{2}-\d{2})$/.exec(session.sessionId)?.[1];
    if (day) {
      const stamp = Date.parse(`${day}T00:00:00.000Z`);
      if (Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day) return `${day} UTC`;
    }
  }
  return `Session ${session.sessionId.slice(0, 8)}${session.sessionId.length > 8 ? '…' : ''}`;
}

export type StatusTone = 'good' | 'warn' | 'bad' | 'neutral';

/** Maps a RateStatus (or PriceStatus) string to a status-color tone used consistently across
 * badges (styles.css defines --status-good/warn/bad/neutral). */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'MEASURED':
    case 'LIST':
      return 'good';
    case 'PROVISIONAL-MEASURED':
    case 'ESTIMATE':
      return 'warn';
    case 'FILED-EXAMPLE':
    case 'PLACEHOLDER':
    case 'UNPRICED':
      return 'bad';
    case 'NONE':
    default:
      return 'neutral';
  }
}

/** Exact query timestamps must retain milliseconds; clock differences never prove a shared snapshot. */
export function formatQueryClock(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_EPOCH_MS
    ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : 'Time unavailable';
}
