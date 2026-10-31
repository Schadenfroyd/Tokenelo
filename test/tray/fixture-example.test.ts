import { describe, expect, it } from 'vitest';
import { snapshotFixtureMarker } from '../../src/tray/fixture-example.js';
import {
  FILED_EXAMPLE_SNAPSHOT_NOTICE,
  fixtureExampleNotice,
  showUsageFixtureInlineNotice,
} from '../../src/tray/renderer/fixture-example.js';
import { summary30d, summary7d, summaryToday } from '../fixtures/api/fixtures.js';

describe('trusted FILED-EXAMPLE snapshot marker', () => {
  it('marks only a snapshot whose resolved source is fixtures', () => {
    expect(snapshotFixtureMarker(true, 'fixtures')).toBe('FILED-EXAMPLE');
    expect(snapshotFixtureMarker(false, 'fixtures')).toBeNull();
    expect(snapshotFixtureMarker(true, 'live')).toBeNull();
    expect(snapshotFixtureMarker(false, 'live')).toBeNull();
    expect(snapshotFixtureMarker(true, null)).toBeNull();
  });

  it('returns one shared visible scope note and suppresses only the duplicate Usage banner', () => {
    expect(fixtureExampleNotice('FILED-EXAMPLE')).toBe(FILED_EXAMPLE_SNAPSHOT_NOTICE);
    expect(FILED_EXAMPLE_SNAPSHOT_NOTICE).toContain('not measured usage or invoice evidence');
    expect(FILED_EXAMPLE_SNAPSHOT_NOTICE).toContain('do not prove a shared live snapshot');
    expect(fixtureExampleNotice(null)).toBeNull();
    expect(showUsageFixtureInlineNotice('filed-fixture', 'FILED-EXAMPLE')).toBe(false);
    expect(showUsageFixtureInlineNotice('filed-fixture', null)).toBe(true);
    expect(showUsageFixtureInlineNotice('shared-read-transaction', null)).toBe(false);
  });
});

describe('the filed Today subscription example follows its frozen range', () => {
  it('prorates the configured plan price and preserves the separate API-equivalent value', () => {
    const claude = summaryToday.subscriptions.find((row) => row.kind === 'claude')!;
    const start = 1790402400000;
    const end = 1790466276688;
    const expectedProration = 200 * ((end - start) / (86_400_000 * 30));

    expect(summaryToday.timeBasis).toMatchObject({ startMs: start, asOfMs: end });
    expect(claude.costBasis).toEqual({
      state: 'configured-proration',
      monthlyUsd: 200,
      rangeStartMs: start,
      rangeEndMs: end,
      prorationDays: 30,
      origin: 'configured-plan-price',
      invoiceVerified: false,
    });
    expect(claude.billedUsd).toBeCloseTo(expectedProration, 12);
    expect(claude.apiEquivUsd).toBe(summaryToday.bySource.claude.apiEquivUsd);
    expect(claude.leverage).toBeCloseTo(claude.apiEquivUsd / expectedProration, 12);
  });

  it('uses independent range clocks and configured-plan prorations for the 7d and 30d fixture summaries', () => {
    for (const [summary, days] of [[summary7d, 7], [summary30d, 30]] as const) {
      const claude = summary.subscriptions.find((row) => row.kind === 'claude')!;
      const rangeStart = summary.generatedAt - days * 86_400_000;
      const expectedProration = 200 * days / 30;
      expect(summary.timeBasis).toMatchObject({ startMs: rangeStart, asOfMs: summary.generatedAt });
      expect(summary.timeBasis?.startMs).not.toBe(summaryToday.timeBasis?.startMs);
      expect(claude.costBasis).toMatchObject({
        state: 'configured-proration',
        monthlyUsd: 200,
        rangeStartMs: rangeStart,
        rangeEndMs: summary.generatedAt,
        prorationDays: 30,
        origin: 'configured-plan-price',
        invoiceVerified: false,
      });
      expect(claude.billedUsd).toBeCloseTo(expectedProration, 12);
      expect(claude.apiEquivUsd).toBe(summary.bySource.claude.apiEquivUsd);
      expect(claude.leverage).toBeCloseTo(claude.apiEquivUsd! / expectedProration, 12);
    }
  });
});
