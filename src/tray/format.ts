/**
 * Pure, dependency-free formatters for the Electron **main process** side of the tray
 * (macOS `tray.setTitle`, Windows/Linux tooltip). No DOM — this file is compiled by the
 * Node-side `tsconfig.json` project (src/tray/main.ts imports it directly).
 *
 * DESIGN.md §10: the title/tooltip line is the API-equivalent dollar figure with a short scope
 * qualifier when its own events are partial or estimated.
 *
 * A sibling file, src/tray/renderer/format.ts, duplicates the small numeric formatters for the
 * Chromium-side popover (that file is typechecked under tsconfig.tray.json, which restricts its
 * `rootDir` to src/tray/renderer/** — importing across that boundary would break `tsc -p
 * tsconfig.tray.json`, so the two copies are kept deliberately separate and each has its own
 * hand-computed unit tests).
 */

/**
 * Currency with cents and above: two decimals and thousands separators, as before. A nonzero amount below one cent is never shown as $0.00
 * (two decimals would round it to zero): it reads "<$0.01", with the sign kept. Exact zero is $0.00.
 */
export function formatMoney(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs === 0) return '$0.00';
  if (abs < 0.01) return `${sign}<$0.01`;
  const fixed = abs.toFixed(2);
  const [whole, cents] = fixed.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${withCommas}.${cents}`;
}

/**
 * Tooltip, title and table precision for a dollar amount. Cents and above use formatMoney. Below a cent, three significant digits are shown,
 * capped at six decimals ($0.00445, $0.0022). A value that needs more digits than are shown is marked "≈" so it never claims to be exact.
 * Below one millionth: "<$0.000001", sign kept. Exact zero: $0.00.
 */
export function formatPreciseMoney(usd: number): string {
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

/**
 * Compact magnitude formatting for large counters (tokens): <1000 → integer string;
 * 1000–999,999 → one decimal + "k"; millions → "M"; billions → "B" (trailing ".0" dropped).
 * Examples (hand-computed): 842 → "842"; 2143 → "2.1k"; 1000 → "1k"; 1_950_000 → "1.9M".
 */
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

/** The dollar segment's qualifier: partial when some events have no dollar figure, estimated when a derived price column is billed. */
export function priceQualifier(priceStatus: 'LIST' | 'ESTIMATE' | 'UNPRICED' | null | undefined): string {
  if (priceStatus === 'UNPRICED') return ' (partial)';
  if (priceStatus === 'ESTIMATE') return ' (estimated)';
  return '';
}

/**
 * The full title/tooltip line: `"$184.20"`, `"$12.00 (partial)"`, `"$0.00"`.
 * The dollar part carries a short scope qualifier when its own events are partial or estimated; stored figures are never labelled as recomputed.
 */
export function formatTrayLine(totals: {
  apiEquivUsd: number;
  priceStatus?: 'LIST' | 'ESTIMATE' | 'UNPRICED' | null;
  events?: number;
  priceEvidence?: PriceEvidence;
}): string {
  const evidence = totals.priceEvidence;
  const usable = Number.isFinite(totals.apiEquivUsd) && totals.apiEquivUsd >= 0 && (!evidence || priceEvidenceProblem(evidence, totals.events) === null && evidence.issuesEvents === 0 && !evidence.aggregateAmountInvalid);
  return usable ? `${formatMoney(totals.apiEquivUsd)}${priceQualifier(totals.priceStatus)}` : 'API-equiv — (review price fields)';
}

/** `ms` → `"1h 23m"` / `"4m"` / `"<1m"`. Never negative; floors to the minute (seconds not shown). */
export function formatDuration(ms: number): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
import { priceEvidenceProblem, type PriceEvidence } from '../core/price-evidence.js';
