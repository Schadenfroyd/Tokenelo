/**
 * src/tray/renderer/charts.ts — pure SVG string generation, checked without any DOM/jsdom. Every
 * expected number below is hand-computed in a comment next to the assertion.
 */
import { describe, expect, it } from 'vitest';
import {
  sessionTimelineMetric,
  chartLegend,
  describePoint,
  formatDateTick,
  formatHourTick,
  formatMinuteTick,
  renderStackedBarChart,
  tickIndices,
} from '../../src/tray/renderer/charts.js';
import type { TimeseriesPoint } from '../../src/tray/renderer/api-types.js';

function point(t: number, claude: number, codex: number): TimeseriesPoint {
  return { t, apiEquivUsd: claude + codex, tokens: 0, bySource: { claude, codex } };
}

describe('session activity with unavailable dollar prices', () => {
  it('keeps recorded full token totals visible without drawing missing prices as zero dollars', () => {
    const metric = sessionTimelineMetric(false, true, false);
    const point: TimeseriesPoint = { t: Date.UTC(2026, 8, 21), apiEquivUsd: 0, tokens: 110, totalTokens: 150, bySource: { 'qwen-code': 0 } };
    const svg = renderStackedBarChart([point], { sources: ['qwen-code'], metric });
    expect(metric).toBe('totalTokens');
    expect(svg).not.toContain('$');
    expect(describePoint(point, ['qwen-code'], 'hour', metric).totalText).toContain('150');
  });
  it('uses the older recorded fresh/write/output basis when full totals were not supplied', () => {
    const metric = sessionTimelineMetric(false, false, false);
    const point: TimeseriesPoint = { t: Date.UTC(2026, 8, 21), apiEquivUsd: 0, tokens: 110, bySource: { 'qwen-code': 0 } };
    expect(metric).toBe('tokens');
    expect(describePoint(point, ['qwen-code'], 'hour', metric).totalText).toContain('110');
    expect(renderStackedBarChart([point], { sources: ['qwen-code'], metric })).not.toContain('$');
  });
  it('keeps priced hosted sessions on dollars and established local sessions on tokens', () => {
    expect(sessionTimelineMetric(false, true, true)).toBe('apiEquivUsd');
    expect(sessionTimelineMetric(true, true, true)).toBe('totalTokens');
  });
});

describe('formatHourTick', () => {
  it('UTC hour 15 -> "3p"', () => {
    expect(formatHourTick(Date.UTC(2026, 8, 26, 15, 0))).toBe('3p');
  });
  it('UTC hour 0 -> "12a" (midnight, not "0a")', () => {
    expect(formatHourTick(Date.UTC(2026, 8, 26, 0, 0))).toBe('12a');
  });
  it('UTC hour 12 -> "12p" (noon)', () => {
    expect(formatHourTick(Date.UTC(2026, 8, 26, 12, 0))).toBe('12p');
  });
  it('UTC hour 9 -> "9a"', () => {
    expect(formatHourTick(Date.UTC(2026, 8, 26, 9, 0))).toBe('9a');
  });
});

describe('formatDateTick', () => {
  it('UTC 2026-09-26 -> "9/26" (no leading zeros)', () => {
    expect(formatDateTick(Date.UTC(2026, 8, 26))).toBe('9/26');
  });
  it('UTC 2026-01-05 -> "1/5"', () => {
    expect(formatDateTick(Date.UTC(2026, 0, 5))).toBe('1/5');
  });
});

describe('formatMinuteTick', () => {
  it('UTC 23:35 -> "11:35p"', () => {
    expect(formatMinuteTick(Date.UTC(2026, 8, 26, 23, 35))).toBe('11:35p');
  });
  it('UTC 03:00 -> "3:00a" (2-digit minutes even at :00)', () => {
    expect(formatMinuteTick(Date.UTC(2026, 8, 26, 3, 0))).toBe('3:00a');
  });
  it('UTC 00:05 -> "12:05a" (midnight hour is 12, not 0)', () => {
    expect(formatMinuteTick(Date.UTC(2026, 8, 26, 0, 5))).toBe('12:05a');
  });
  it('UTC 12:09 -> "12:09p" (noon hour is 12)', () => {
    expect(formatMinuteTick(Date.UTC(2026, 8, 26, 12, 9))).toBe('12:09p');
  });
});

describe('tickIndices', () => {
  it('0 points -> []', () => {
    expect(tickIndices(0, 6)).toEqual([]);
  });
  it('1 point -> [0]', () => {
    expect(tickIndices(1, 6)).toEqual([0]);
  });
  it('2 points, maxTicks 6 -> [0, 1] (first and last, never more than count)', () => {
    expect(tickIndices(2, 6)).toEqual([0, 1]);
  });
  it('7 points, maxTicks 4 -> evenly spaced across 0..6: round(i*6/3) for i=0..3 -> [0,2,4,6]', () => {
    expect(tickIndices(7, 4)).toEqual([0, 2, 4, 6]);
  });
  it('24 points, maxTicks 6 -> round(i*23/5) for i=0..5 -> [0,5,9,14,18,23]', () => {
    expect(tickIndices(24, 6)).toEqual([0, 5, 9, 14, 18, 23]);
  });
});

describe('describePoint', () => {
  it('formats the time label, total, and only the non-zero sources', () => {
    const p = point(Date.UTC(2026, 8, 26, 15, 0), 12.5, 0);
    const desc = describePoint(p, ['claude', 'codex'], 'hour');
    expect(desc.timeLabel).toBe('3p');
    expect(desc.totalText).toBe('$12.50');
    expect(desc.bySource).toEqual([{ source: 'claude', label: 'Claude', valueText: '$12.50' }]);
  });

  it('day bucket uses the date tick format', () => {
    const p = point(Date.UTC(2026, 8, 26), 1, 1);
    expect(describePoint(p, ['claude', 'codex'], 'day').timeLabel).toBe('9/26');
  });
});

describe('renderStackedBarChart', () => {
  it('renders a "No data" placeholder for an empty points array', () => {
    const svg = renderStackedBarChart([]);
    expect(svg).toContain('<svg');
    expect(svg).toContain('No data');
    expect(svg).not.toContain('<rect');
  });

  it('draws 3 y-axis gridlines with $ labels and one x-axis label per tick', () => {
    // max total across the two buckets is 100 (60+40), so gridline labels are $0 / $50 / $100.
    const points = [point(1, 60, 40), point(2, 10, 0)];
    const svg = renderStackedBarChart(points);
    expect((svg.match(/<line /g) ?? []).length).toBe(3);
    expect(svg).toContain('>$0<');
    expect(svg).toContain('>$50<');
    expect(svg).toContain('>$100<');
    // 2 points -> 2 x-axis ticks (tickIndices(2, 6) = [0, 1]).
    const xAxisTexts = (svg.match(/<text[^>]*font-size="9">[^<]*<\/text>/g) ?? []).length;
    expect(xAxisTexts).toBe(3 /* y labels */ + 2 /* x labels */);
  });

  it('emits one <rect> segment per non-zero source plus one hit-rect per bucket, one <g> per bucket', () => {
    const points = [point(1, 10, 5), point(2, 0, 8)];
    const svg = renderStackedBarChart(points);
    expect((svg.match(/<g /g) ?? []).length).toBe(2);
    // bucket 1: hit-rect + 2 segments (claude, codex); bucket 2: hit-rect + 1 segment (codex only).
    expect((svg.match(/<rect/g) ?? []).length).toBe(2 + 3);
    expect((svg.match(/class="bar-hit"/g) ?? []).length).toBe(2);
  });

  it('uses CSS custom-property fills (no hardcoded hex colors) so light/dark theming works without JS branching', () => {
    const svg = renderStackedBarChart([point(1, 10, 5)]);
    expect(svg).toContain('var(--source-claude)');
    expect(svg).toContain('var(--source-codex)');
    expect(svg).not.toMatch(/fill="#/);
  });

  it('scales the tallest (single-segment) bar to fill the plot height and is a strict subset for a shorter bar', () => {
    // Single-segment bars (only 'claude' present) hit the firstSegment branch, so no 1px inset
    // is subtracted — the tallest bar's rect height equals the full plot height exactly.
    // plotHeight = height - 2*padding - bottomGutter(14) = 132 - 8 - 14 = 110 (defaults).
    const points = [point(1, 100, 0), point(2, 10, 0)];
    const svg = renderStackedBarChart(points, { sources: ['claude'] });
    const heights = Array.from(svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)" rx/g)).map((m) => Number(m[1]));
    expect(heights.length).toBe(2);
    const [tall, short] = heights;
    expect(tall).toBeCloseTo(110, 0);
    expect(short).toBeCloseTo(11, 0); // 10/100 of 110
  });

  it('embeds a <title> with the display-name-cased source and dollar value for accessibility/hover', () => {
    const svg = renderStackedBarChart([point(1, 12.5, 0)]);
    expect(svg).toContain('<title>Claude: $12.50</title>');
  });

  it('each bucket <g> is keyboard-focusable and carries an aria-label summarizing the bucket', () => {
    const svg = renderStackedBarChart([point(Date.UTC(2026, 8, 26, 15, 0), 12.5, 2.5)]);
    expect(svg).toContain('tabindex="0"');
    expect(svg).toContain('aria-label="3p: $15.00 total (Claude $12.50, Codex $2.50)"');
  });

  it('formats a sub-$10 max gridline to one decimal (e.g. max $8 -> mid "$4")', () => {
    const svg = renderStackedBarChart([point(1, 8, 0)]);
    expect(svg).toContain('>$0<');
    expect(svg).toContain('>$4<');
    expect(svg).toContain('>$8<');
  });
});

describe('chartLegend', () => {
  it('includes only sources with at least one positive value, in stack order, with a display label', () => {
    const points = [point(1, 10, 0), point(2, 0, 0)];
    const legend = chartLegend(points);
    expect(legend).toEqual([{ source: 'claude', label: 'Claude', colorVar: 'var(--source-claude)' }]);
  });

  it('returns an empty legend when every point is all-zero', () => {
    expect(chartLegend([point(1, 0, 0)])).toEqual([]);
  });

  it('preserves CHART_SOURCES stacking order even if points list codex before claude', () => {
    const points = [{ t: 1, apiEquivUsd: 3, tokens: 0, bySource: { codex: 2, claude: 1 } }];
    const legend = chartLegend(points);
    expect(legend.map((l) => l.source)).toEqual(['claude', 'codex']);
  });
});

describe('local session token timeline', () => {
  const points: TimeseriesPoint[] = [
    { t: Date.UTC(2026, 8, 26, 15), tokens: 5_000, totalTokens: 7_000, apiEquivUsd: 0, bySource: { 'ollama-proxy': 0 } },
    { t: Date.UTC(2026, 8, 26, 16), tokens: 6_000, totalTokens: 8_000, apiEquivUsd: 0, bySource: { 'ollama-proxy': 0 } },
  ];

  it('uses recorded tokens for bar heights, axes, legend, and accessible descriptions despite zero dollars', () => {
    const sources = ['ollama-proxy'] as const;
    const svg = renderStackedBarChart(points, { sources: [...sources], metric: 'totalTokens' });
    // Default plot height 110; 7,000/8,000 * 110 = 96.25, tallest = 110.
    const heights = Array.from(svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)" rx/g)).map((m) => Number(m[1]));
    expect(heights).toEqual([96.25, 110]);
    expect(svg).toContain('>4k<');
    expect(svg).toContain('>8k<');
    expect(svg).not.toContain('$');
    expect(svg).toContain('aria-label="Tokens over time"');
    expect(svg).toContain('aria-label="3p: 7,000 tokens · count evidence unrecorded total (Local proxy 7,000 tokens)"');
    expect(describePoint(points[1], [...sources], 'hour', 'totalTokens').totalText).toBe('8,000 tokens · count evidence unrecorded');
    expect(chartLegend(points, [...sources], 'totalTokens')).toEqual([
      { source: 'ollama-proxy', label: 'Local proxy', colorVar: 'var(--source-ollama)' },
    ]);
  });

  it('rejects token shares across multiple sources because the series has only aggregate token totals', () => {
    expect(() => renderStackedBarChart(points, { metric: 'tokens' })).toThrow('one source-filtered');
    expect(() => describePoint(points[0], ['claude', 'ollama-proxy'], 'hour', 'tokens')).toThrow('one source-filtered');
    expect(() => chartLegend(points, [], 'tokens')).toThrow('one source-filtered');
  });

  it('labels the old cache-read-excluding basis and refuses to invent total tokens', () => {
    const old = { ...points[0], totalTokens: undefined };
    expect(renderStackedBarChart([old], { sources: ['ollama-proxy'], metric: 'tokens' })).toContain('Fresh/write/output tokens over time');
    expect(describePoint(old, ['ollama-proxy'], 'hour', 'tokens').totalText).toBe('5,000 fresh/write/output tokens · cache reads excluded · count evidence unrecorded');
    expect(() => renderStackedBarChart([old], { sources: ['ollama-proxy'], metric: 'totalTokens' })).toThrow('recorded totalTokens');
  });
});
