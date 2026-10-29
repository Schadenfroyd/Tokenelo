import { describe, expect, it } from 'vitest';
import { formatMoney as mainFormatMoney, formatTrayLine } from '../../src/tray/format.js';
import { formatMoney, formatPreciseMoney } from '../../src/tray/renderer/format.js';
import { AXIS_CHAR_WIDTH_UNITS, describePoint, formatAxisDollars, renderStackedBarChart } from '../../src/tray/renderer/charts.js';
import type { TimeseriesPoint } from '../../src/tray/renderer/api-types.js';

// Currency precision (2026-10-04, Codex r14 visual finding). A positive API-equivalent amount of $0.00445 must never read as $0.00. Every expected
// value below is hand-computed from the stated rule, not copied from the implementation.

describe('summary and table money: cents and above keep their form; below a cent is "<$0.01", never $0.00', () => {
  it.each([
    [0, '$0.00'],
    [184.3, '$184.30'],
    [1234.5, '$1,234.50'],
    [0.01, '$0.01'],
    [-2.5, '-$2.50'],
    [0.00445, '<$0.01'], // nonzero, under a cent
    [0.005, '<$0.01'],
    [0.0099999, '<$0.01'],
    [-0.00445, '-<$0.01'], // sign kept
  ])('renderer formatMoney(%s) = %s', (usd, text) => {
    expect(formatMoney(usd)).toBe(text);
  });

  it.each([
    [0, '$0.00'],
    [0.00445, '<$0.01'],
    [-0.00445, '-<$0.01'],
    [42.1, '$42.10'],
  ])('main-process formatMoney(%s) = %s', (usd, text) => {
    expect(mainFormatMoney(usd)).toBe(text);
  });

  it('the title line shows the same honest amount for a tiny API-equivalent value (not "$0.00")', () => {
    const line = formatTrayLine({ apiEquivUsd: 0.00445 });
    expect(line).toBe('<$0.01');
    expect(line).not.toBe('$0.00');
  });
});

describe('tooltip and title precision: three significant digits, capped at six decimals, never $0.00 for a nonzero amount', () => {
  it.each([
    [0, '$0.00'],
    [0.00445, '$0.00445'], // 4,4,5 → five decimals
    [0.0022, '$0.0022'], // 0.00220 with the trailing zero dropped
    [0.0045, '$0.0045'],
    [0.005, '$0.005'], // exact at three digits
    [0.5, '$0.50'], // cents and above keep formatMoney's form
    [-0.00445, '-$0.00445'],
    [0.000012345, '≈$0.000012'], // six-decimal cap: more digits exist, so it is marked approximate
    [0.0000004, '<$0.000001'], // below one millionth
    [-0.0000004, '-<$0.000001'],
  ])('formatPreciseMoney(%s) = %s', (usd, text) => {
    expect(formatPreciseMoney(usd)).toBe(text);
  });

  it('never returns $0.00 for a nonzero amount', () => {
    for (const usd of [0.000000001, 0.0000004, 0.0099, 0.00445, 3.2e-7]) {
      expect(formatPreciseMoney(usd)).not.toBe('$0.00');
    }
  });
});

describe('dollar axis labels: readable at the scale the gridlines actually cover', () => {
  it('a scale below one dollar uses the decimals its top gridline needs, with distinct labels (0 / 0.002 / 0.004)', () => {
    expect(formatAxisDollars([0, 0.002, 0.004])).toEqual(['$0', '$0.0020', '$0.0040']);
  });

  it('the established two-decimal form is kept for an ordinary cents scale (0 / 0.25 / 0.50)', () => {
    expect(formatAxisDollars([0, 0.25, 0.5])).toEqual(['$0', '$0.25', '$0.50']);
  });

  it('a scale of one dollar or more keeps whole dollars (0 / 5 / 10)', () => {
    expect(formatAxisDollars([0, 5, 10])).toEqual(['$0', '$5', '$10']);
  });

  it('a microscale uses six decimals and never reads $0.00 (0 / 0.00004 / 0.00008)', () => {
    expect(formatAxisDollars([0, 0.00004, 0.00008])).toEqual(['$0', '$0.000040', '$0.000080']);
  });

  it('an all-zero scale is $0 on every gridline', () => {
    expect(formatAxisDollars([0, 0, 0])).toEqual(['$0', '$0', '$0']);
  });
});

describe('a tiny-scale chart keeps its labels inside the SVG and its tooltip honest', () => {
  const point = (t: number, claude: number): TimeseriesPoint => ({ t, apiEquivUsd: claude, tokens: 0, bySource: { claude } });

  it('the top gridline reads $0.0045, its label starts inside the SVG, and the bar tooltip shows $0.0045 (not $0.00)', () => {
    const svg = renderStackedBarChart([point(0, 0.0045), point(3_600_000, 0.0045)], { width: 400, height: 132 });
    // Right-aligned endpoint time ticks also use text-anchor="end"; select dollar labels explicitly.
    const labels = [...svg.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*font-size="9">(\$[^<]+)<\/text>/g)].map((m) => ({ x: Number(m[1]), text: m[2] }));
    expect(labels.map((l) => l.text)).toEqual(['$0', '$0.0022', '$0.0045']);
    const top = labels[2];
    // a label that is left-anchored at x must fit: its estimated width fits between the SVG's left edge and x
    expect(top.x - top.text.length * AXIS_CHAR_WIDTH_UNITS).toBeGreaterThanOrEqual(0);
    expect(svg).toContain('<title>Claude: $0.0045</title>');
    expect(svg).not.toMatch(/\$0\.00<\/text>/);
  });
});

describe('dollar axis labels below the fixed-decimal range: scientific notation keeps nonzero gridlines visible and distinct', () => {
  // The r15 boundary: fixed decimals up to six places collapse these two gridlines to $0.000000. Labels must stay nonzero and distinct.
  it('the r15 probe ($1.25e-8, $2.5e-8 on a zero-based scale) reads as nonzero, distinct scientific labels', () => {
    const [zero, mid, top] = formatAxisDollars([0, 1.25e-8, 2.5e-8]);
    expect(zero).toBe('$0');
    expect(mid).toMatch(/^\$1\.[0-9]e-8$/);
    expect(top).toMatch(/^\$2\.[0-9]e-8$/);
    expect(mid).not.toBe(top);
    expect([mid, top]).not.toContain('$0.000000');
  });

  it('an exact two-digit scientific scale: $0 / $2.5e-8 / $5.0e-8', () => {
    expect(formatAxisDollars([0, 2.5e-8, 5e-8])).toEqual(['$0', '$2.5e-8', '$5.0e-8']);
  });

  it('different positive exponents keep their own exponent: $0 / $3.0e-9 / $3.0e-6', () => {
    expect(formatAxisDollars([0, 3e-9, 3e-6])).toEqual(['$0', '$3.0e-9', '$3.0e-6']);
  });

  it('a negative scale keeps its sign and stays readable (fixed form): $0 / -$0.0022 / -$0.0045', () => {
    expect(formatAxisDollars([0, -0.0022, -0.0045])).toEqual(['$0', '-$0.0022', '-$0.0045']);
  });

  it('the fixed-to-scientific switch happens at the six-decimal limit: $0.00010 stays fixed, $9.0e-7 switches', () => {
    expect(formatAxisDollars([0, 0.00005, 0.0001])).toEqual(['$0', '$0.00005', '$0.00010']);
    expect(formatAxisDollars([0, 4.5e-7, 9e-7])).toEqual(['$0', '$4.5e-7', '$9.0e-7']);
  });

  it('an all-zero scale is $0 everywhere, with no scientific label', () => {
    expect(formatAxisDollars([0, 0, 0])).toEqual(['$0', '$0', '$0']);
  });

  it('a scientific label is laid out inside the left gutter (not clipped at the SVG edge)', () => {
    const svg = renderStackedBarChart(
      [{ t: 0, apiEquivUsd: 2.5e-8, tokens: 0, bySource: { claude: 2.5e-8 } }, { t: 3_600_000, apiEquivUsd: 2.5e-8, tokens: 0, bySource: { claude: 2.5e-8 } }],
      { width: 400, height: 132 },
    );
    const labels = [...svg.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="end"[^>]*font-size="9">(\$[^<]+)<\/text>/g)].map((m) => ({ x: Number(m[1]), text: m[2] }));
    expect(labels.map((l) => l.text)).toEqual(['$0', '$1.2e-8', '$2.5e-8']);
    for (const l of labels) expect(l.x - l.text.length * AXIS_CHAR_WIDTH_UNITS).toBeGreaterThanOrEqual(0);
  });
});

// r18 P3-F, r21 boundary: below $0.00001 the bar text uses the axis's two-significant-digit scientific form. That is where the six-decimal
// tooltip cap would drop below two significant digits, and where the axis itself switches to scientific labels.
// Summary and table money keep their floors (formatPreciseMoney, tested above); axis labels and scales are unchanged.
describe('chart bucket text below $0.00001 matches the axis notation', () => {
  const point = (claude: number): TimeseriesPoint => ({ t: 0, apiEquivUsd: claude, tokens: 0, bySource: { claude } });
  const total = (usd: number) => describePoint(point(usd), ['claude'], 'hour').totalText;

  it.each([
    [2.5e-8, '$2.5e-8'], // exact at two significant digits: no ≈
    [5e-8, '$5.0e-8'], // the axis keeps the trailing .0; so does the bucket text
    [9e-7, '$9.0e-7'],
    [1.25e-8, '≈$1.2e-8'], // toExponential(1) of 1.25e-8 is 1.2e-8 (as on the axis test above); the shown value differs → ≈
    [3.14159e-7, '≈$3.1e-7'],
  ])('bucket total %s → %s', (usd, text) => {
    expect(total(usd)).toBe(text);
  });

  it.each([
    [1.5e-6, '$1.5e-6'], // r21 review case: the axis reads $1.5e-6; the six-decimal tooltip read ≈$0.000002 (one significant digit)
    [1.2345e-6, '≈$1.2e-6'], // inexact at two significant digits
    [0.000001, '$1.0e-6'], // one millionth is now inside the scientific range, exact
    [9.5e-6, '$9.5e-6'], // just below the new threshold, exact
    [9.99e-6, '≈$1.0e-5'], // just below the threshold, rounds up at two significant digits and is marked approximate
  ])('between $0.000001 and $0.00001: bucket %s → %s', (usd, text) => {
    expect(total(usd)).toBe(text);
  });

  it('the threshold: $0.00001 and above keep the fixed tooltip form (already two or more significant digits); zero is $0.00', () => {
    expect(total(0.00001)).toBe('$0.00001');
    expect(total(0.000015)).toBe('$0.000015');
    expect(total(0.000012345)).toBe('≈$0.000012');
    expect(total(0)).toBe('$0.00');
  });

  it.each([-4e-7, -3.14159e-7, -1.5e-6, -1.2345e-6, -0.00001])('withholds an invalid negative stored dollar bucket %s', (usd) => {
    const description = describePoint(point(usd), ['claude'], 'hour');
    expect(description.totalText).toBe('Dollar value unavailable · review recorded price fields');
    expect(description.bySource).toEqual([]);
  });

  it('summary and table money keep their floor (unchanged)', () => {
    expect(formatPreciseMoney(2.5e-8)).toBe('<$0.000001');
    expect(formatPreciseMoney(1.2345e-6)).toBe('≈$0.000001');
    expect(formatMoney(1.5e-6)).toBe('<$0.01');
  });

  it('r21 case: a $1.5e-6 scale shows the same value on the axis, the SVG title, the aria-label and the hover/focus description', () => {
    const points = [point(1.5e-6), { ...point(1.2345e-6), t: 3_600_000 }];
    const svg = renderStackedBarChart(points, { width: 400, height: 132, sources: ['claude'] });
    const labels = [...svg.matchAll(/<text x="[\d.]+"[^>]*text-anchor="end"[^>]*font-size="9">(\$[^<]+)<\/text>/g)].map((m) => m[1]);
    expect(labels).toEqual(['$0', '$7.5e-7', '$1.5e-6']);
    const top = describePoint(points[0], ['claude'], 'hour');
    expect(top.totalText).toBe('$1.5e-6');
    expect(top.bySource.map((s) => s.valueText)).toEqual(['$1.5e-6']);
    expect(svg).toContain('<title>Claude: $1.5e-6</title>');
    expect(svg).toContain(`aria-label="${top.timeLabel}: $1.5e-6 total (Claude $1.5e-6)"`);
    const second = describePoint(points[1], ['claude'], 'hour');
    expect(second.totalText).toBe('≈$1.2e-6');
    expect(svg).toContain('<title>Claude: ≈$1.2e-6</title>');
    expect(svg).toContain(`aria-label="${second.timeLabel}: ≈$1.2e-6 total (Claude ≈$1.2e-6)"`);
    expect(svg).not.toContain('$0.000002');
    expect(svg).not.toContain('$0.000001');
  });

  it('scoped guarantee: on a fixed-decimal axis a smaller bucket keeps two significant digits, in scientific form', () => {
    const svg = renderStackedBarChart([point(0.00002), { ...point(3e-6), t: 3_600_000 }], { width: 400, height: 132, sources: ['claude'] });
    const labels = [...svg.matchAll(/<text x="[\d.]+"[^>]*text-anchor="end"[^>]*font-size="9">(\$[^<]+)<\/text>/g)].map((m) => m[1]);
    expect(labels).toEqual(['$0', '$0.000010', '$0.000020']);
    expect(svg).toContain('<title>Claude: $0.00002</title>');
    expect(svg).toContain('<title>Claude: $3.0e-6</title>');
  });

  it('the SVG title, the aria-label and the hover/focus description all show the same value as the axis notation', () => {
    const points = [point(2.5e-8), { ...point(1.25e-8), t: 3_600_000 }];
    const svg = renderStackedBarChart(points, { width: 400, height: 132, sources: ['claude'] });
    const desc = describePoint(points[0], ['claude'], 'hour');
    expect(desc.totalText).toBe('$2.5e-8');
    expect(desc.bySource.map((s) => s.valueText)).toEqual(['$2.5e-8']);
    expect(svg).toContain('<title>Claude: $2.5e-8</title>');
    expect(svg).toContain(`aria-label="${desc.timeLabel}: $2.5e-8 total (Claude $2.5e-8)"`);
    expect(svg).toContain('<title>Claude: ≈$1.2e-8</title>');
    expect(svg).not.toContain('&lt;$0.000001');
    expect(svg).not.toContain('<$0.000001');
    // axis unchanged: zero-based scale to the top bucket
    const labels = [...svg.matchAll(/<text x="[\d.]+"[^>]*text-anchor="end"[^>]*font-size="9">(\$[^<]+)<\/text>/g)].map((m) => m[1]);
    expect(labels).toEqual(['$0', '$1.2e-8', '$2.5e-8']);
  });
});
