import { formatQueryClock } from '../../src/tray/renderer/format.js';
import { describe, expect, it } from 'vitest';
import type { SummaryResponse, TimeseriesResponse } from '../../src/tray/renderer/api-types.js';
import { priceEvidenceOf } from '../../src/core/price-evidence.js';
import { dollarSourceEvidence } from '../../src/tray/renderer/dollar-source-evidence.js';
import { usageResponseEvidence } from '../../src/tray/renderer/response-evidence.js';
import { usageComparisonCopy, usageQueryClockCopy, usageQueryClockLine } from '../../src/tray/renderer/usage-comparison-copy.js';

function compared(priceEvidence = priceEvidenceOf(1, 'LIST')) {
  const totals = { events: 1, apiEquivUsd: 1, unpricedEvents: 0, estimatedPriceEvents: 0, priceEvidence };
  const points = [{ t: 1000, ...totals, bySource: { codex: 1 } }];
  const summary = { range: '7d', totals } as SummaryResponse;
  const timeseries = { range: '7d', points } as unknown as TimeseriesResponse;
  return { summary, timeseries, fields: [totals, ...points] };
}
function result(input: ReturnType<typeof compared>) {
  return usageComparisonCopy(usageResponseEvidence(input.summary, input.timeseries), dollarSourceEvidence(input.timeseries.points, ['codex']), input.fields);
}
describe('compact query clock line', () => {
  it('always names both independent query clocks exactly and marks unavailable ones', () => {
    const input = compared(); input.summary.generatedAt = 1000; input.timeseries.generatedAt = 1001;
    expect(usageQueryClockLine(usageResponseEvidence(input.summary, input.timeseries)))
      .toBe('Query times · Table 1970-01-01 00:00:01.000 UTC · Chart 1970-01-01 00:00:01.001 UTC');
    input.timeseries.generatedAt = 1000;
    expect(usageQueryClockLine(usageResponseEvidence(input.summary, input.timeseries))).toContain('Table 1970-01-01 00:00:01.000 UTC · Chart 1970-01-01 00:00:01.000 UTC');
    input.timeseries.generatedAt = undefined as unknown as number;
    expect(usageQueryClockLine(usageResponseEvidence(input.summary, input.timeseries))).toMatch(/Chart Time unavailable$/);
  });
});
describe('separate arithmetic and stored-price qualification', () => {
  it('shows the exact one-millisecond clock difference without changing matching or different-range verdicts', () => {
    const input = compared(); input.summary.generatedAt = 1000; input.timeseries.generatedAt = 1001;
    expect(formatQueryClock(input.summary.generatedAt)).toBe('1970-01-01 00:00:01.000 UTC');
    expect(formatQueryClock(input.timeseries.generatedAt)).toBe('1970-01-01 00:00:01.001 UTC');
    expect(usageQueryClockCopy(usageResponseEvidence(input.summary, input.timeseries))).not.toBeNull();
    expect(result(input)).toEqual({ label: 'Compared figures agree · stored price fields checked', warn: false });
    input.timeseries.range = '30d';
    expect(usageQueryClockCopy(usageResponseEvidence(input.summary, input.timeseries))).not.toBeNull();
    expect(result(input)).toEqual({ label: 'Chart and table cover different ranges', warn: true });
    for (const value of [undefined, null, '1000', -1, 1.5, NaN, Infinity, 8_640_000_000_000_001]) expect(formatQueryClock(value)).toBe('Time unavailable');
    expect(formatQueryClock(8_640_000_000_000_000)).toBe('+275760-09-13 00:00:00.000 UTC');
  });

  it('discloses valid differing query clocks without excusing mismatched figures or inventing legacy timing', () => {
    const input = compared(); input.summary.totals.apiEquivUsd = 2;
    const cases = [[0, 1, true], [1000, 1200, true], [1200, 1000, true], [1000, 1000, false],
      [undefined, 1000, false], [1000, undefined, false], [-1, 1000, false], [NaN, 1000, false],
      [Infinity, 1000, false], [8_640_000_000_000_001, 1000, false]] as const;
    for (const [tableAt, chartAt, disclosed] of cases) {
      input.summary.generatedAt = tableAt as number; input.timeseries.generatedAt = chartAt as number;
      const evidence = usageResponseEvidence(input.summary, input.timeseries);
      expect(usageQueryClockCopy(evidence) !== null).toBe(disclosed);
      expect(evidence.numeric).toBe('mismatch');
      expect(result(input)).toEqual({ label: 'Chart and table figures differ', warn: true });
      expect(input.summary.totals.apiEquivUsd).toBe(2);
    }
  });

  it('does not let matching arithmetic claim that conflicting price fields agree', () => {
    const input = compared(priceEvidenceOf(null, 'LIST'));
    expect(usageResponseEvidence(input.summary, input.timeseries).numeric).toBe('match');
    expect(result(input)).toEqual({ label: 'Compared figures agree · price fields need review', warn: true });
  });
  it('does not promote absent legacy checks to checked price fields', () => {
    const input = compared(); for (const figure of input.fields) delete (figure as { priceEvidence?: unknown }).priceEvidence;
    expect(result(input)).toEqual({ label: 'Compared figures agree · price field checks unavailable', warn: false });
  });
  it('separates checked stored fields from rate or invoice validation', () => {
    expect(result(compared())).toEqual({ label: 'Compared figures agree · stored price fields checked', warn: false });
  });
  it('preserves the range and arithmetic mismatch before a field-check caption', () => {
    const input = compared(); input.timeseries.range = '30d';
    expect(result(input)).toMatchObject({ label: 'Chart and table cover different ranges', warn: true });
    input.timeseries.range = '7d'; input.summary.totals.apiEquivUsd = 2;
    expect(result(input)).toMatchObject({ label: 'Chart and table figures differ', warn: true });
  });
});
