/**
 * "Fixture schema conformance to types.ts (tsc on the fixtures via a typed import)": the fixtures
 * are authored as real TypeScript object literals in test/fixtures/api/fixtures.ts, each declared
 * `satisfies <ResponseType>` against src/core/types.ts (see that file's header comment for why a
 * plain JSON-module typed import can't do this check — resolveJsonModule widens every literal
 * string field to `string`, so a direct assignment always fails and an `as Type` cast never
 * catches a wrong value).
 *
 * This test (a) actually spawns `tsc --noEmit` on fixtures.ts with the same compiler options as
 * the project's own tsconfig.json and asserts it exits 0, and (b) round-trips those typed objects
 * against the committed *.json files api-client.ts's mock mode reads, so the two can never
 * silently drift apart.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allFixtures, coverage, sessions, sessionDetailClaude, sessionDetailLocal, summaryAll, summary30d } from '../fixtures/api/fixtures.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_TS = path.join(REPO_ROOT, 'test', 'fixtures', 'api', 'fixtures.ts');

describe('fixtures.ts typechecks against src/core/types.ts', () => {
  it('tsc --noEmit exits 0 for test/fixtures/api/fixtures.ts', () => {
    // Mirrors tsconfig.json's compilerOptions (see that file) for the Node/Electron-main-process
    // project that owns src/core/types.ts, applied directly to this one file so the check does
    // not depend on test/ being included/excluded by any tsconfig.
    const args = [
      '--noEmit',
      '--strict',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--resolveJsonModule',
      '--skipLibCheck',
      '--esModuleInterop',
      '--forceConsistentCasingInFileNames',
      FIXTURES_TS,
    ];
    let output = '';
    let failed = false;
    try {
      // Run typescript's own bin/tsc JS entry point via `node` rather than the
      // node_modules/.bin/tsc shim: that shim is a .cmd/.ps1 file on Windows, which doesn't exist
      // at the bare (no-extension) path this used to pass, and which Node refuses to spawn
      // directly without `shell: true` anyway. bin/tsc is a plain JS file (`require('../lib/tsc.js')`)
      // on every platform — no native binary involved — so `node <path>` works identically
      // everywhere.
      const tscBin = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
      execFileSync(process.execPath, [tscBin, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
    } catch (err) {
      failed = true;
      output = String((err as { stdout?: string }).stdout ?? err);
    }
    expect(failed, `tsc reported type errors in fixtures.ts:\n${output}`).toBe(false);
  }, 30_000);
});

describe('fixtures.ts ↔ committed JSON round-trip', () => {
  const FIXTURES_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'api');

  it('Fleet Today JSON mirror equals its allFixtures entry', () => {
    const onDisk = fs.readFileSync(path.join(FIXTURES_DIR, 'fleet-today.json'), 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk).toBe(JSON.stringify(allFixtures['fleet-today.json'], null, 2) + '\n');
  });

  for (const [name, data] of Object.entries(allFixtures)) {
    it(`${name} on disk matches JSON.stringify(fixtures.ts's ${name.replace('.json', '')})`, () => {
      const onDisk = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8').replace(/\r\n/g, '\n');
      const expected = JSON.stringify(data, null, 2) + '\n';
      expect(onDisk).toBe(expected);
    });
  }
});

describe('All-range FILED-EXAMPLE time-basis semantics', () => {
  it('keeps the lower cutoff unknown and never invents a subscription proration window', () => {
    expect(summaryAll.range).toBe('all');
    expect(summaryAll.timeBasis?.startMs).toBeNull();
    expect(summaryAll.timeBasis?.asOfMs).toBe(summaryAll.generatedAt);
    expect(summaryAll.totals.events).toBe(summary30d.totals.events);
    const claudePlan = summaryAll.subscriptions.find((row) => row.kind === 'claude');
    expect(claudePlan).toMatchObject({
      billedUsd: null,
      leverage: null,
      costBasis: { state: 'period-unavailable', monthlyUsd: 200, rangeStartMs: null, invoiceVerified: false },
    });
  });
});

describe('detail fixture accounting', () => {
  for (const detail of [sessionDetailClaude, sessionDetailLocal]) {
    it(`${detail.source} series and provenance reconcile with its model and session totals`, () => {
      const tokens = detail.tokens;
      const basis = tokens.inputFresh + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.output;
      const total = basis + tokens.cacheRead;
      expect(detail.timeseries.points.reduce((sum, point) => sum + point.tokens, 0)).toBe(basis);
      expect(detail.timeseries.points.reduce((sum, point) => sum + (point.totalTokens ?? 0), 0)).toBe(total);
      expect(detail.timeseries.points.reduce((sum, point) => sum + point.apiEquivUsd, 0)).toBeCloseTo(detail.apiEquivUsd!, 10);
      expect(detail.timeseries.points.reduce((sum, point) => sum + (point.bySource[detail.source] ?? 0), 0)).toBeCloseTo(detail.apiEquivUsd!, 10);
      expect(detail.byModel.reduce((sum, model) => sum + model.events, 0)).toBe(detail.events);
      expect(detail.telemetry.reduce((sum, feed) => sum + feed.events, 0)).toBe(detail.events);
      expect(detail.byModel.filter((row) => row.thinking === 'unknown').reduce((sum, row) => sum + row.events, 0)).toBe(detail.thinkingUnknownEvents);
      const listRow = sessions.find((row) => row.source === detail.source && row.sessionId === detail.sessionId)!;
      expect(detail.models).toEqual(listRow.models);
      expect(detail.burn).toEqual(listRow.burn);
      for (const point of detail.timeseries.points) expect(point.t % detail.timeseries.bucketMs).toBe(0);
    });
  }
});

it('scan fixtures preserve the single-run chronology and failure/metric relationship', () => {
  for (const scan of coverage.collectorScans) {
    if (scan.running) expect(scan.lastFinishedAt!).toBeLessThanOrEqual(scan.currentStartedAt!);
    if (scan.lastOutcome === 'failed') expect(scan.lastStats).toBeNull();
    if (scan.lastCompletedAt !== null) expect(scan.lastCompletedAt).toBeLessThanOrEqual(scan.lastFinishedAt!);
  }
});
