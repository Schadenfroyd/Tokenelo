import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../src/tray/api-client.js';
import { allFixtures } from './api/fixtures.js';

const apiFixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'api');
const readJson = (name: string): any => JSON.parse(fs.readFileSync(path.join(apiFixtureDir, name), 'utf8'));
const tokenFields = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const;
const sourceKeys = ['bench', 'claude', 'codex', 'ollama-log', 'ollama-proxy', 'qwen-code'];
const ranges = ['today', '7d', '30d'] as const;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const approx = (actual: number, expected: number): void => expect(actual).toBeCloseTo(expected, 8);

describe('canonical synthetic range fixture coherence', () => {
  it('keeps summary totals, source/model splits, and generated JSON mirrors aligned', () => {
    const today = readJson('summary-today.json');
    expect(ranges.map((range) => readJson(`summary-${range}.json`).totals.events)).toEqual([842, 4210, 15156]);

    for (const range of ranges) {
      const file = `summary-${range}.json`;
      const summary = readJson(file);
      expect(summary).toEqual(allFixtures[file as keyof typeof allFixtures]);
      expect(summary.range).toBe(range);
      expect(Object.keys(summary.bySource).sort()).toEqual(sourceKeys);

      const sourceRows = Object.values(summary.bySource) as any[];
      const modelRows = summary.byModel as any[];
      expect(sum(sourceRows.map((row) => row.events))).toBe(summary.totals.events);
      expect(sum(modelRows.map((row) => row.events))).toBe(summary.totals.events);
      approx(sum(sourceRows.map((row) => row.apiEquivUsd)), summary.totals.apiEquivUsd);
      approx(sum(modelRows.map((row) => row.apiEquivUsd ?? 0)), summary.totals.apiEquivUsd);

      for (const field of tokenFields) {
        expect(sum(sourceRows.map((row) => row.tokens[field]))).toBe(summary.totals.tokens[field]);
        expect(sum(modelRows.map((row) => row.tokens[field]))).toBe(summary.totals.tokens[field]);
      }

      for (const source of Object.keys(summary.bySource)) {
        const sourceSummary = summary.bySource[source];
        const rows = modelRows.filter((row) => row.source === source);
        expect(sum(rows.map((row) => row.events))).toBe(sourceSummary.events);
        approx(sum(rows.map((row) => row.apiEquivUsd ?? 0)), sourceSummary.apiEquivUsd);
        for (const field of tokenFields) {
          expect(sum(rows.map((row) => row.tokens[field]))).toBe(sourceSummary.tokens[field]);
        }
      }

      const modelUnpriced = sum(modelRows.filter((row) => row.apiEquivUsd === null).map((row) => row.events));
      expect(summary.totals.unpricedEvents).toBe(modelUnpriced);
      expect(summary.totals.estimatedPriceEvents).toBe(0);

      const claudePlan = summary.subscriptions.find((row: any) => row.kind === 'claude');
      const codexPlan = summary.subscriptions.find((row: any) => row.kind === 'codex');
      approx(claudePlan.apiEquivUsd, summary.bySource.claude.apiEquivUsd);
      approx(codexPlan.apiEquivUsd, summary.bySource.codex.apiEquivUsd);

      // The value of local work against a comparator is an explicit unavailable value (unknown, never zero).
      for (const comparator of [summary.local.valueVsClaude, summary.local.valueVsGpt]) {
        expect(comparator).toMatchObject({ usd: null, status: 'NONE', unratedEvents: 0 });
      }
      expect(summary.local.netSavingsVsClaude).toBeNull();
      expect(summary.local.netSavingsVsGpt).toBeNull();

      // Range scaling changes numeric counts only; it must not turn absent count evidence into zero.
      for (const source of Object.keys(today.bySource)) {
        expect(summary.bySource[source].tokens.countQuality).toBe(today.bySource[source].tokens.countQuality);
        expect(summary.bySource[source].tokens.ucuCountQuality).toBe(today.bySource[source].tokens.ucuCountQuality);
        expect(summary.bySource[source].tokens.fieldEvidence).toEqual(today.bySource[source].tokens.fieldEvidence);
      }
    }
  });

  it('makes each timeseries sum to its matching range without crossing the frozen Today boundary', () => {
    for (const range of ranges) {
      const summary = readJson(`summary-${range}.json`);
      const seriesFile = `timeseries-${range}.json`;
      const series = readJson(seriesFile);
      expect(series).toEqual(allFixtures[seriesFile as keyof typeof allFixtures]);
      expect(series.range).toBe(range);
      expect(series.generatedAt).toBe(summary.generatedAt);
      expect(series.timeBasis).toEqual(summary.timeBasis);
      expect(series.points.length).toBe(range === 'today' ? 18 : range === '7d' ? 7 : 30);
      expect(series.points[0].t).toBe(summary.timeBasis.startMs);
      expect(series.points.every((point: any) => point.t >= summary.timeBasis.startMs && point.t <= summary.generatedAt)).toBe(true);

      approx(sum(series.points.map((point: any) => point.apiEquivUsd)), summary.totals.apiEquivUsd);
      approx(sum(series.points.map((point: any) => point.tokens)), summary.totals.tokens.inputFresh + summary.totals.tokens.cacheWrite5m + summary.totals.tokens.cacheWrite1h + summary.totals.tokens.output);
      approx(sum(series.points.map((point: any) => point.totalTokens)), summary.totals.tokens.inputFresh + summary.totals.tokens.cacheWrite5m + summary.totals.tokens.cacheWrite1h + summary.totals.tokens.cacheRead + summary.totals.tokens.output);

      for (const source of Object.keys(summary.bySource)) {
        approx(sum(series.points.map((point: any) => point.bySource[source] ?? 0)), summary.bySource[source].apiEquivUsd);
      }
      for (const point of series.points) {
        approx(sum(Object.values(point.bySource) as number[]), point.apiEquivUsd);
      }
    }
  });

  it('keeps Today local/session data aligned and reads exact session fixtures for all ranges', async () => {
    const summary = readJson('summary-today.json');
    const sessions = readJson('sessions-today.json');
    const localSource = summary.bySource['ollama-proxy'];
    const localSession = sessions.sessions.find((row: any) => row.source === 'ollama-proxy');
    const localDetail = readJson('session-detail-ollama-proxy-ollama_M4a_qwen3_8_27b_2026-09-26.json');

    expect(sessions.range).toBe('today');
    expect(sessions.timeBasis).toEqual(summary.timeBasis);
    expect(localSession.tokens).toEqual(localSource.tokens);
    expect(localSession.apiEquivUsd).toBe(0);
    expect(sum(localSession.telemetry.map((row: any) => row.events))).toBe(localSource.events);
    expect(localDetail.events).toBe(localSource.events);
    expect(localDetail.apiEquivUsd).toBe(0);
    expect(sum(localDetail.timeseries.points.map((point: any) => point.tokens))).toBe(localSource.tokens.inputFresh + localSource.tokens.output);

    const client = createApiClient({
      mockDir: apiFixtureDir,
      strictMockRanges: true,
      fetchImpl: async () => { throw new Error('range fixture checks must not use the network'); },
    });
    expect((await client.getSummary('7d')).range).toBe('7d');
    expect((await client.getTimeseries('30d')).range).toBe('30d');
    for (const range of ['today', '24h', '7d', '30d', 'all'] as const) {
      const expected = readJson(`sessions-${range}.json`);
      expect(expected.range).toBe(range);
      expect(expected.timeBasis).toEqual(readJson(`summary-${range}.json`).timeBasis);
      expect(await client.getSessionsResponse(range)).toEqual(expected);
    }
  });

  it('uses independent range bases and configured-plan proration, never an invoice or Today proration leak', () => {
    const today = readJson('summary-today.json');
    const seven = readJson('summary-7d.json');
    const thirty = readJson('summary-30d.json');
    const dayMs = 86_400_000;
    const now = today.generatedAt;
    expect(today.timeBasis.startMs).toBe(Date.parse('2026-09-26T06:00:00.000Z'));
    expect(seven.timeBasis.startMs).toBe(now - 7 * dayMs);
    expect(thirty.timeBasis.startMs).toBe(now - 30 * dayMs);

    const todayCost = today.subscriptions.find((row: any) => row.kind === 'claude');
    const sevenCost = seven.subscriptions.find((row: any) => row.kind === 'claude');
    const thirtyCost = thirty.subscriptions.find((row: any) => row.kind === 'claude');
    for (const [row, start] of [[todayCost, today.timeBasis.startMs], [sevenCost, seven.timeBasis.startMs], [thirtyCost, thirty.timeBasis.startMs]] as const) {
      expect(row.costBasis).toMatchObject({
        state: 'configured-proration',
        monthlyUsd: 200,
        rangeStartMs: start,
        rangeEndMs: now,
        prorationDays: 30,
        origin: 'configured-plan-price',
        invoiceVerified: false,
      });
      expect(row).not.toHaveProperty('invoice');
    }
    expect(sevenCost.costBasis.rangeStartMs).not.toBe(todayCost.costBasis.rangeStartMs);
    expect(thirtyCost.costBasis.rangeStartMs).not.toBe(todayCost.costBasis.rangeStartMs);
    approx(sevenCost.billedUsd, 200 * 7 / 30);
    expect(thirtyCost.billedUsd).toBe(200);
    expect(seven.subscriptions.find((row: any) => row.kind === 'codex')).toMatchObject({ billedUsd: null, leverage: null });
    expect(thirty.subscriptions.find((row: any) => row.kind === 'codex')).toMatchObject({ billedUsd: null, leverage: null });
    expect(today.byModel.find((row: any) => row.model === 'codex-auto-review')).toMatchObject({ apiEquivUsd: null });
    expect(today.byModel.find((row: any) => row.model === 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL')).toMatchObject({ apiEquivUsd: 0 });
  });
});
