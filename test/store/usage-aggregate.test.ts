import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { readUsageAggregate } from '../../src/store/usage-aggregate.js';
import { buildShareReport } from '../../src/cli/share-report.js';
import type { Range } from '../../src/core/types.js';

let root: string | undefined;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); root = undefined; });
const NOW = Date.UTC(2026, 9, 7, 20);
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-usage-aggregate-'));
  const file = path.join(root, 'ledger.db'); const writer = openDb({ file });
  return { file, writer };
}
function seed(db: TokeneloDb, id: string, ts = NOW - 1000, source = 'codex', optional: number | null = 7) {
  db.prepare(`INSERT INTO events (id,host,source,ts,ts_source,session_id,model,provider,components_json,
    input_fresh,cache_read,output,reasoning,cache_write_5m,cache_write_1h,cache_write_unassigned,cache_write_assumed_1h,count_quality,
    flags_json,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256)
    VALUES (?,'H',?,?,'record','s','m','unknown','[]',10,20,5,2,1,3,?,NULL,'complete','[]',0.25,'ESTIMATE','fixture','NONE','')`)
    .run(id, source, ts, optional);
}
describe('narrow aggregate snapshot', () => {
  it('reads a legacy schema without optional count columns or any migration/config/rate registry', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-usage-legacy-'));
    const file = path.join(root, 'legacy.db'); const writer = openDb({ file, migrate: false });
    try {
      writer.exec(`CREATE TABLE events(source TEXT,ts INTEGER,input_fresh INTEGER,cache_read INTEGER,output INTEGER,reasoning INTEGER,
        cache_write_5m INTEGER,cache_write_1h INTEGER,api_equiv_usd REAL,price_status TEXT);
        CREATE TABLE activity(ts INTEGER);
        INSERT INTO events VALUES('codex',${NOW - 1},10,20,5,2,1,3,0.25,'LIST');`);
      const columns = writer.prepare('PRAGMA table_info(events)').all();
      const report = buildShareReport(await readUsageAggregate(file, 'all', { now: () => NOW }), 'all');
      expect(report.totals.events).toBe(1); expect(report.totals.tokens.countQuality).toBe('unrecorded');
      expect(report.totals.tokens.components.cacheWriteUnassigned).toBeNull(); expect(report.totals.tokens.completeTotal).toBeNull();
      expect(writer.prepare('PRAGMA table_info(events)').all()).toEqual(columns);
    } finally { writer.close(); }
  });
  it('matches the full Summary projection across all ranges and equal-timestamp page boundaries', async () => {
    const { file, writer } = fixture();
    try {
      for (let i = 0; i < 9; i++) seed(writer, 'current-' + i, NOW - 1000, i % 2 ? 'claude' : 'codex', i % 2 ? 0 : null);
      seed(writer, 'old', NOW - 35 * 86400000); seed(writer, 'future', NOW + 1);
      writer.prepare("INSERT INTO activity(source,session_id,ts,host)VALUES('claude','s',?,'H')").run(NOW + 1);
      const queries = createQueries(writer, defaultConfig({ hostLabel: 'H' }), { now: () => NOW, readSnapshotFile: file, pageRows: 2 });
      for (const range of ['today', '24h', '7d', '30d', 'all'] as Range[]) {
        const actual = await readUsageAggregate(file, range, { now: () => NOW, pageRows: 2 });
        const expected = await queries.getSummary(range);
        expect(buildShareReport(actual, range)).toEqual(buildShareReport(expected, range));
        expect(actual.timeBasis).toMatchObject({ excludedFutureEvents: 1, excludedFutureActivity: 1 });
      }
      const report = buildShareReport(await readUsageAggregate(file, '7d', { now: () => NOW }), '7d');
      expect(report.totals.events).toBe(9); expect(report.totals.tokens.normalizedCategorySubtotal).toBe(351);
      expect(report.sources.find(row => row.source === 'codex')!.tokens.components.cacheWriteUnassigned).toBeNull();
      expect(report.sourceReconciliation.status).toBe('unavailable');
    } finally { writer.close(); }
  });
  it('holds event/future-count evidence on one snapshot while a writer commits between pages', async () => {
    const { file, writer } = fixture(); let yields = 0;
    try {
      for (let i = 0; i < 5; i++) seed(writer, 'before-' + i);
      const result = await readUsageAggregate(file, '7d', { now: () => NOW, pageRows: 2, yieldNow: async () => {
        if (++yields === 1) { seed(writer, 'later-in-range'); seed(writer, 'later-future', NOW + 1); }
      } });
      expect(yields).toBe(2); expect(result.totals.events).toBe(5); expect(result.timeBasis!.excludedFutureEvents).toBe(0);
      expect((await readUsageAggregate(file, '7d', { now: () => NOW })).totals.events).toBe(6);
    } finally { writer.close(); }
  });
  it('closes the snapshot on cancellation and rejects invalid page sizes', async () => {
    const { file, writer } = fixture(); const control = new AbortController();
    try {
      for (let i = 0; i < 5; i++) seed(writer, 'before-' + i);
      await expect(readUsageAggregate(file, '7d', { now: () => NOW, pageRows: 2, signal: control.signal,
        yieldNow: async () => { control.abort(); } })).rejects.toThrow();
      for (const pageRows of [0, -1, 0.5, NaN]) await expect(readUsageAggregate(file, 'all', { pageRows })).rejects.toThrow('pageRows');
      seed(writer, 'after-abort'); expect((await readUsageAggregate(file, '7d', { now: () => NOW })).totals.events).toBe(6);
    } finally { writer.close(); }
  });
  it('uses the same missing-dollar basis for totals and sources on contradictory stored rows', async () => {
    const { file, writer } = fixture();
    try {
      seed(writer, 'contradictory'); writer.prepare("UPDATE events SET api_equiv_usd=NULL,price_status='LIST'").run();
      const expected = await createQueries(writer, defaultConfig(), { now: () => NOW }).getSummary('all');
      const actual = await readUsageAggregate(file, 'all', { now: () => NOW });
      expect(buildShareReport(actual, 'all')).toEqual(buildShareReport(expected, 'all'));
      expect(actual.totals.unpricedEvents).toBe(1); expect(actual.bySource.codex!.unpricedEvents).toBe(1);
    } finally { writer.close(); }
  });
  it('collapses unrecognized feed labels into one excluded accumulator without losing total events', async () => {
    const { file, writer } = fixture();
    try {
      for (let i = 0; i < 40; i++) seed(writer, 'unknown-' + i, NOW - 1000, 'PRIVATE-FEED-' + i);
      const actual = await readUsageAggregate(file, 'all', { now: () => NOW, pageRows: 3 });
      expect(Object.keys(actual.bySource)).toEqual(['unrecognized-source']); expect(actual.totals.events).toBe(40);
      const report = buildShareReport(actual, 'all'); expect(report.sources).toEqual([]);
      expect(report.sourceReconciliation.status).toBe('unavailable'); expect(JSON.stringify(report)).not.toContain('PRIVATE-FEED');
    } finally { writer.close(); }
  });
});
