/**
 * Inline-SVG stacked bar chart for the Usage tab ("stacked bars by source over time"). Pure
 * string-building — no DOM APIs — so it is unit-testable under plain vitest without jsdom; app.ts
 * inserts the returned markup via `container.innerHTML` and wires up the interactive hover/focus
 * tooltip itself (DOM event listeners have no place in a pure string-builder — see app.ts's
 * `wireChartTooltip`, which consumes this module's `describePoint`/`CHART_SOURCES` exports).
 *
 * Colors are CSS custom properties (`var(--source-claude)` etc., defined in styles.css per theme)
 * rather than hardcoded hex values, so the same markup renders correctly in light and dark
 * without any JS branching — SVG `fill`/`stroke` accept `var(...)` inside an HTML document. Both
 * the light and dark source palettes pass the dataviz skill's categorical-palette validator
 * (lightness band, chroma floor, CVD/normal-vision separation, ≥3:1 contrast vs the chart
 * surface) — see this agent's report for the exact `validate_palette.js` runs.
 *
 * Axes (DESIGN tray-polish task item 3): 3 horizontal gridlines with $ labels (0 / mid / max) and
 * x-axis time labels — hour-of-day for an 'hour' bucket (today/24h), M/D dates for a 'day' bucket
 * (7d/30d) — formatted in UTC so the chart (and its tests) render identically regardless of the
 * machine's local timezone, matching styles.css's `[data-theme]`-not-`prefers-color-scheme`
 * determinism rule at the top of that file.
 *
 * ASSUMPTION (see api-client.ts's contract note): `TimeseriesPoint.bySource` is read here as
 * API-equivalent USD per source for that bucket — the point's own top-level `apiEquivUsd` is the
 * sum of `bySource`. Bars and the scale use the selected source sums; tooltip totals use
 * the point's `apiEquivUsd`. Usage checks their coherence before plotting. It is not a separate
 * segment.
 */
import type { Source, TimeseriesPoint } from './api-types.js';
import { formatPreciseMoney } from './format.js';

export const CHART_SOURCES: Source[] = ['claude', 'codex', 'ollama-proxy', 'ollama-log', 'qwen-code', 'bench'];

const SOURCE_VAR: Record<Source, string> = {
  claude: 'var(--source-claude)',
  codex: 'var(--source-codex)',
  'ollama-proxy': 'var(--source-ollama)',
  'ollama-log': 'var(--source-ollama)',
  // This colour identifies the Qwen client source, not its serving location or provider.
  // Reuse the validated palette; the named legend distinguishes the feed.
  'qwen-code': 'var(--source-ollama)',
  bench: 'var(--source-bench)',
};

const SOURCE_LABEL: Record<Source, string> = {
  claude: 'Claude',
  codex: 'Codex',
  'ollama-proxy': 'Local proxy',
  'ollama-log': 'Local server log',
  'qwen-code': 'Qwen Code',
  bench: 'Bench',
};

export type ChartMetric = 'apiEquivUsd' | 'tokens' | 'totalTokens';

/** Session-only series have recorded token totals. Unknown or invalid prices must not
 * hide that activity or turn missing dollars into a flat zero-dollar chart. */
export function sessionTimelineMetric(localOnly: boolean, totalTokensAvailable: boolean, priceAvailable: boolean, unpricedEvents: unknown = 0): ChartMetric {
  const partialOrInvalid = typeof unpricedEvents !== 'number' || !Number.isSafeInteger(unpricedEvents) || unpricedEvents < 0 || unpricedEvents > 0;
  return localOnly || !priceAvailable || partialOrInvalid ? totalTokensAvailable ? 'totalTokens' : 'tokens' : 'apiEquivUsd';
}

/** Unavailable totals are gaps, never zero activity. Missing full totals remain a caller
 * contract error: older-daemon callers must choose the documented `tokens` basis. */
export function tokenTimelineIssue(point: TimeseriesPoint, metric: ChartMetric): string | null {
  if (metric === 'apiEquivUsd') return null;
  const quality = metric === 'tokens' ? point.ucuCountQuality ?? point.countQuality ?? 'unrecorded' : point.countQuality ?? 'unrecorded';
  if (['incomplete', 'invalid', 'conflict'].includes(quality)) return `${quality} count evidence`;
  if (quality !== 'complete' && quality !== 'unrecorded') return 'unsupported count evidence';
  if (metric === 'totalTokens' && point.totalTokens === undefined) throw new Error('Total-token charts require recorded totalTokens');
  const value = metric === 'totalTokens' ? point.totalTokens : point.tokens;
  return typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 ? 'invalid recorded token value' : null;
}

export interface StackedBarChartOptions {
  width?: number;
  height?: number;
  /** Outer padding in SVG units, around the whole chart (outside the axis gutters). */
  padding?: number;
  /** Sources to stack, bottom-to-top in this order. Defaults to CHART_SOURCES. */
  sources?: Source[];
  /** Tokens are available only as a bucket total, so this metric requires exactly one source
   * from a source-filtered session series. Never infer token shares from dollar shares. */
  metric?: ChartMetric;
  /** Governs x-axis label formatting: minute-of-hour (session-detail window's own short-session
   * 5-minute buckets, store/queries.ts#chooseSessionBucketMs), hour-of-day, or M/D date. Defaults
   * to 'hour'. */
  bucket?: 'minute' | 'hour' | 'day';
}

/** `$` axis label for a scale of one dollar or more: whole dollars from 10, one decimal below 10, two decimals below 1 (the established form). */
function formatAxisDollarWide(v: number): string {
  if (v <= 0) return '$0';
  if (v < 1) return `$${v.toFixed(2)}`;
  if (v < 10) return `$${(Math.round(v * 10) / 10).toString()}`;
  return `$${Math.round(v)}`;
}

/**
 * Dollar gridline labels for one chart. Zero is always "$0", and a negative value keeps its sign. A scale of one dollar or more keeps the
 * established form. Below one dollar, every label shares the decimals needed for two significant digits at the top gridline (at least two, at
 * most six), raised until distinct values get distinct labels and no nonzero value reads as zero (a $0.0045 scale gives $0 / $0.0022 / $0.0045).
 * When fixed decimals cannot do that within six places, the labels switch to two-significant-digit scientific notation ($2.5e-8), which stays
 * readable and nonzero at any scale. Values are the real gridline values; nothing is invented.
 */
export function formatAxisDollars(values: readonly number[]): string[] {
  const maxAbs = Math.max(0, ...values.map((v) => Math.abs(v)));
  const label = (v: number, format: (magnitude: number) => string): string => (v === 0 ? '$0' : `${v < 0 ? '-' : ''}${format(Math.abs(v))}`);
  if (maxAbs === 0) return values.map(() => '$0');
  if (maxAbs >= 1) return values.map((v) => label(v, formatAxisDollarWide));
  const first = Math.max(2, -Math.floor(Math.log10(maxAbs)) + 1);
  const distinctValues = [...new Set(values)];
  for (let decimals = first; decimals <= 6; decimals++) {
    const fixed = (magnitude: number) => `$${magnitude.toFixed(decimals)}`;
    const labels = values.map((v) => label(v, fixed));
    const nonzeroVisible = labels.every((text, i) => values[i] === 0 || Number(text.replace(/[^0-9.]/g, '')) !== 0);
    const distinctLabels = new Set(distinctValues.map((v) => label(v, fixed)));
    if (nonzeroVisible && distinctLabels.size === distinctValues.length) return labels;
  }
  return values.map((v) => label(v, formatAxisScientific));
}

/** Two significant digits in scientific notation for a positive magnitude below the fixed-decimal range: "$2.5e-8". Never zero for a positive input. */
function formatAxisScientific(magnitude: number): string {
  const [mantissa, exponent] = magnitude.toExponential(1).split('e');
  return `$${mantissa}e${exponent}`;
}

/**
 * Average advance of one axis-label character at the gridline font size (9 units): digits about 5.1, the period about 2.5. The left gutter is
 * widened to hold the longest dollar label, so a small-scale label is never clipped at the SVG edge.
 */
export const AXIS_CHAR_WIDTH_UNITS = 5.2;

function requireSingleTokenSource(sources: Source[], metric: ChartMetric): void {
  if (metric !== 'apiEquivUsd' && sources.length !== 1) {
    throw new Error('Token charts require one source-filtered session series');
  }
}

function sourceValue(point: TimeseriesPoint, source: Source, metric: ChartMetric): number {
  if (tokenTimelineIssue(point, metric)) return 0;
  if (metric === 'totalTokens') {
    if (point.totalTokens === undefined) throw new Error('Total-token charts require recorded totalTokens');
    return point.totalTokens;
  }
  return metric === 'tokens' ? point.tokens : point.bySource[source] ?? 0;
}

/**
 * One bucket value as text, shared by the SVG `<title>`, the aria-label and the hover/focus tooltip (describePoint).
 * A nonzero dollar amount below $0.00001 uses two-significant-digit scientific form ($1.5e-6, $2.5e-8). That is the range where
 * formatPreciseMoney's six-decimal cap leaves fewer than two significant digits, and the same range where formatAxisDollars switches a
 * scale's labels to scientific form (its first fixed decimal count exceeds six exactly when the top gridline is below $0.00001).
 * From $0.00001 up, formatPreciseMoney already shows at least two significant digits and is used unchanged.
 * Scoped guarantee: every nonzero bucket value is shown with at least two significant digits, the precision of the axis's top label. The
 * notation matches the axis when the whole scale is below $0.00001. On a scale that reaches $0.00001 or more, the axis is fixed-decimal
 * while a smaller bucket still reads in scientific form; the value is not truncated, but the notation differs.
 * The sign is kept, and "≈" marks a shown value that differs from the amount. Summary and table money (formatMoney / formatPreciseMoney)
 * keep their own floors.
 */
function valueText(value: number, metric: ChartMetric): string {
  if (metric !== 'apiEquivUsd') return `${Math.round(value).toLocaleString('en-US')} ${metric === 'tokens' ? 'fresh/write/output tokens · cache reads excluded' : 'tokens'}`;
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.00001) {
    const shown = formatAxisScientific(abs);
    const approx = Number(shown.slice(1)) !== abs ? '≈' : '';
    return `${value < 0 ? '-' : ''}${approx}${shown}`;
  }
  return formatPreciseMoney(value);
}

function formatAxisTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

/** `t` (epoch ms) -> "3p" / "11a" (UTC hour-of-day, 12-hour, no minutes — this is an axis tick,
 * not a clock). Hand-computed: UTC hour 15 -> "3p"; UTC hour 0 -> "12a"; UTC hour 12 -> "12p". */
export function formatHourTick(t: number): string {
  const h = new Date(t).getUTCHours();
  const period = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${period}`;
}

/** `t` (epoch ms) -> "9/26" (UTC month/day, no leading zeros). */
export function formatDateTick(t: number): string {
  const d = new Date(t);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** `t` (epoch ms) -> "11:35p" / "3:00a" (UTC hour:minute, 12-hour, always 2-digit minutes) — the
 * session-detail window's own chart, whose buckets can be as fine as 5 minutes
 * (store/queries.ts#chooseSessionBucketMs), needs a tick finer than `formatHourTick`'s
 * hour-only label or every tick in a sub-hour session would repeat the same hour. */
export function formatMinuteTick(t: number): string {
  const d = new Date(t);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const period = h < 12 ? 'a' : 'p';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${period}`;
}

function formatTick(t: number, bucket: 'minute' | 'hour' | 'day'): string {
  if (bucket === 'day') return formatDateTick(t);
  if (bucket === 'minute') return formatMinuteTick(t);
  return formatHourTick(t);
}

/** Evenly-spaced tick indices into `points` (at most `maxTicks`, always including the first and
 * last point when there are >= 2), de-duplicated. Pure index math so it's independently testable. */
export function tickIndices(count: number, maxTicks: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const n = Math.min(maxTicks, count);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round((i * (count - 1)) / (n - 1)));
  }
  return Array.from(new Set(out));
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface PointDescription {
  timeLabel: string;
  totalText: string;
  bySource: { source: Source; label: string; valueText: string }[];
}

/** Human-readable breakdown of one bucket, shared by the SVG's aria-label and app.ts's floating
 * hover/focus tooltip (kept here, not duplicated in app.ts, so the two never drift). */
export function describePoint(point: TimeseriesPoint, sources: Source[], bucket: 'minute' | 'hour' | 'day', metric: ChartMetric = 'apiEquivUsd'): PointDescription {
  requireSingleTokenSource(sources, metric);
  if (metric === 'apiEquivUsd' && (!priceFieldsUsable(point) || !Number.isFinite(point.apiEquivUsd) || point.apiEquivUsd < 0))
    return { timeLabel: formatTick(point.t, bucket), totalText: 'Dollar value unavailable · review recorded price fields', bySource: [] };
  const quality = metric === 'tokens' ? point.ucuCountQuality ?? point.countQuality : point.countQuality;
  const tokenIssue = tokenTimelineIssue(point, metric);
  if (tokenIssue)
    return { timeLabel: formatTick(point.t, bucket), totalText: `Token total unavailable · ${tokenIssue}`, bySource: [] };
  const bySource = sources
    .map((source) => ({ source, label: SOURCE_LABEL[source], value: sourceValue(point, source, metric) }))
    .filter((s) => s.value > 0)
    .map((s) => ({ source: s.source, label: s.label, valueText: valueText(s.value, metric) }));
  return {
    timeLabel: formatTick(point.t, bucket),
    totalText: valueText(metric === 'apiEquivUsd' ? point.apiEquivUsd : sourceValue(point, sources[0], metric), metric)
      + (metric !== 'apiEquivUsd' && quality !== 'complete' ? ' · count evidence unrecorded' : ''),
    bySource,
  };
}

/** Builds the stacked-bar SVG markup for a Usage-tab timeseries. Returns a `<svg>...</svg>`
 * string sized by `viewBox` (caller controls display size via CSS on the containing element).
 * An empty `points` array renders an accessible "no data" placeholder instead of an empty chart.
 * Each bucket is a focusable/hoverable `<g data-bucket-t>` (native `<title>` for mouse hover +
 * an `aria-label` summary for focus/screen readers); app.ts's `wireChartTooltip` adds the visible
 * floating tooltip on top of that. */
export function renderStackedBarChart(points: TimeseriesPoint[], opts: StackedBarChartOptions = {}): string {
  const width = opts.width ?? 340;
  const height = opts.height ?? 132;
  const outerPad = opts.padding ?? 4;
  const sources = opts.sources ?? CHART_SOURCES;
  const metric = opts.metric ?? 'apiEquivUsd';
  requireSingleTokenSource(sources, metric);
  const bucket = opts.bucket ?? 'hour';
  if (metric === 'apiEquivUsd' && points.some(point => !priceFieldsUsable(point) || !Number.isFinite(point.apiEquivUsd) || point.apiEquivUsd < 0))
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Dollar timeline unavailable: review recorded price fields"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--fg-muted)" font-size="12">Review price fields</text></svg>`;
  const bottomGutter = 14; // room for x-axis time labels

  if (points.length === 0) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="No usage data for this range"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--fg-muted)" font-size="12">No data</text></svg>`;
  }

  const unavailable = metric === 'apiEquivUsd' ? 0 : points.filter(point => tokenTimelineIssue(point, metric)).length;
  if (unavailable === points.length) {
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Token timeline unavailable: recorded totals need review"><text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="var(--fg-muted)" font-size="12">Token total unavailable</text></svg>`;
  }

  // Gridline values and labels come first: the dollar gutter depends on the longest label, so a tiny scale is never clipped at the SVG edge.
  const gridFractions = [0, 0.5, 1];
  const totals = points.map((p) => sources.reduce((sum, s) => sum + sourceValue(p, s, metric), 0));
  const maxTotal = Math.max(1e-9, ...totals);
  const realMax = Math.max(0, ...totals);
  const gridLabels =
    metric !== 'apiEquivUsd' ? gridFractions.map((f) => formatAxisTokens(maxTotal * f)) : formatAxisDollars(gridFractions.map((f) => realMax * f));
  const leftGutter = metric === 'apiEquivUsd' ? Math.max(30, Math.ceil(Math.max(...gridLabels.map((l) => l.length)) * AXIS_CHAR_WIDTH_UNITS) + 2) : 30;
  const plotLeft = outerPad + leftGutter;
  const plotRight = width - outerPad;
  const plotTop = outerPad;
  const plotBottom = height - outerPad - bottomGutter;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const gap = plotWidth * 0.015;
  const barWidth = (plotWidth - gap * (points.length - 1)) / points.length;

  // ── gridlines: 0 / mid / max, each with a $ label (task item 3: "2–3 gridlines + $ labels") ──
  const grid = gridFractions
    .map((f, gi) => {
      const y = plotBottom - f * plotHeight;
      return (
        `<line x1="${plotLeft.toFixed(2)}" y1="${y.toFixed(2)}" x2="${plotRight.toFixed(2)}" y2="${y.toFixed(2)}" stroke="var(--border)" stroke-width="1"/>` +
        `<text x="${(plotLeft - 4).toFixed(2)}" y="${(y + (f === 0 ? -1 : f === 1 ? 8 : 3)).toFixed(2)}" text-anchor="end" fill="var(--fg-muted)" font-size="9">${escapeXml(gridLabels[gi])}</text>`
      );
    })
    .join('');

  // ── x-axis: a handful of evenly-spaced time labels (hours for 'hour', dates for 'day') ──
  const ticks = tickIndices(points.length, 6);
  const xAxis = ticks
    .map((i) => {
      const x = plotLeft + i * (barWidth + gap) + barWidth / 2;
      // Narrow endpoint buckets leave less room than a centered date/time label needs.
      // Keep the real tick position while drawing its text toward the plot interior.
      const anchor = points.length === 1 ? 'middle' : i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      return `<text x="${x.toFixed(2)}" y="${(plotBottom + 11).toFixed(2)}" text-anchor="${anchor}" fill="var(--fg-muted)" font-size="9">${escapeXml(formatTick(points[i].t, bucket))}</text>`;
    })
    .join('');

  const bars: string[] = [];
  points.forEach((point, i) => {
    const x = plotLeft + i * (barWidth + gap);
    let yCursor = plotBottom; // bottom of the plot area; stack upward
    const segments: string[] = [];
    let firstSegment = true;
    for (const source of sources) {
      const value = sourceValue(point, source, metric);
      if (value <= 0) continue;
      const rawHeight = (value / maxTotal) * plotHeight;
      // A 1px gap between stacked segments (not below the bottom-most one, which sits flush on
      // the baseline) — dataviz mark spec: "a 2px surface gap between fills (stacked segments
      // and adjacent bars alike)"; 1px reads cleanly at this widget's compact 120px bar height.
      const segHeight = Math.max(0, rawHeight - (firstSegment ? 0 : 1));
      const y = yCursor - rawHeight + (firstSegment ? 0 : 1);
      segments.push(
        `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${segHeight.toFixed(2)}" rx="1" fill="${SOURCE_VAR[source]}"><title>${escapeXml(`${SOURCE_LABEL[source]}: ${valueText(value, metric)}`)}</title></rect>`
      );
      yCursor -= rawHeight;
      firstSegment = false;
    }
    const desc = describePoint(point, sources, bucket, metric);
    const ariaLabel = `${desc.timeLabel}: ${desc.totalText} total${desc.bySource.length ? ' (' + desc.bySource.map((s) => `${s.label} ${s.valueText}`).join(', ') + ')' : ''}`;
    // A full-height, transparent hit-rect gives every bucket (including all-zero ones) a
    // reliable, generously-sized hover/focus target — not just the thin colored segments.
    bars.push(
      `<g data-bucket-t="${point.t}" tabindex="0" role="img" aria-label="${escapeXml(ariaLabel)}">` +
        `<rect class="bar-hit" x="${x.toFixed(2)}" y="${plotTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${plotHeight.toFixed(2)}" fill="transparent"/>` +
        (tokenTimelineIssue(point, metric)
          ? `<rect class="bar-unavailable" x="${x.toFixed(2)}" y="${plotTop.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${plotHeight.toFixed(2)}" fill="none" stroke="var(--fg-muted)" stroke-dasharray="3 3"><title>Token total unavailable</title></rect>`
          : segments.join('')) +
        `</g>`
    );
  });

  const chartLabel = metric === 'totalTokens' ? 'Tokens over time' : metric === 'tokens' ? 'Fresh/write/output tokens over time' : 'API-equivalent spend by source over time';
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${chartLabel}">${grid}${bars.join('')}${xAxis}</svg>`;
}

/** Legend entries (label + CSS var) for the sources actually present in `points`, in stack order —
 * app.ts renders this alongside the chart so every fill color is named. */
export function chartLegend(
  points: TimeseriesPoint[],
  sources: Source[] = CHART_SOURCES,
  metric: ChartMetric = 'apiEquivUsd'
): { source: Source; label: string; colorVar: string }[] {
  requireSingleTokenSource(sources, metric);
  const present = new Set<Source>();
  for (const p of points) {
    for (const s of sources) {
      if (sourceValue(p, s, metric) > 0) present.add(s);
    }
  }
  return sources.filter((s) => present.has(s)).map((s) => ({ source: s, label: SOURCE_LABEL[s], colorVar: SOURCE_VAR[s] }));
}
import { priceFieldsUsable } from './price-evidence.js';
