import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { readUsageAggregate } from '../../src/store/usage-aggregate.js';
import { buildShareReport } from '../../src/cli/share-report.js';

describe('stored-dollar quality consistency across read surfaces', () => {
  it('detects persisted invalid amounts, unknown labels and overlapping conflicts consistently without changing the ledger', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-price-evidence-'));
    const file = path.join(root, 'ledger.db'); const db = openDb({ file }); const now = Date.UTC(2026, 9, 7, 20);
    try {
      const insert = db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,model,provider,components_json,input_fresh,output,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256)
        VALUES (?,'H','codex',?,'record','s','m','unknown','[]',10,5,?,?,'fixture','NONE','')`);
      [[-1,'LIST'],[2,'UNKNOWN'],[null,'LIST'],[null,'ESTIMATE'],[0,'ESTIMATE'],[1,'UNPRICED'],[Infinity,'LIST'],['bad','LIST']].forEach(([usd,status],i)=>insert.run('b'+i,now-1000+i,usd,status));
      const before = db.prepare('SELECT * FROM events ORDER BY rowid').all();
      const config = defaultConfig({ hostLabel:'H' }); config.accounts=[{id:'fixture',kind:'codex',hosts:['H'],monthlyUsd:300}];
      const query=createQueries(db,config,{now:()=>now,readSnapshotFile:file,pageRows:2});
      const evidence={version:1,events:8,invalidAmountEvents:3,unknownStatusEvents:1,statusAmountConflictEvents:3,issuesEvents:7,aggregateAmountInvalid:true};
      const summary=await query.getSummary('7d');
      for (const figure of [summary.totals,summary.bySource.codex,summary.byModel[0],summary.subscriptions[0]]) expect(figure).toMatchObject({priceStatus:null,priceEvidence:evidence});
      expect(summary.subscriptions[0].leverage).toBeNull();
      const detail=await query.getSessionDetail('codex','s');
      for (const figure of [detail,detail!.telemetry[0],detail!.byModel[0],detail!.timeseries.points[0],detail!.burn!.priceQuality]) expect(figure).toMatchObject({priceStatus:null,priceEvidence:evidence});
      expect((await query.getTimeseries('hour','7d')).points[0]).toMatchObject({priceStatus:null,priceEvidence:evidence});
      const doctor=await query.getDoctor(); expect(doctor.priceEvidence).toEqual(evidence); expect(doctor.warnings.some(w=>w.startsWith('Stored price fields need review:'))).toBe(true);
      const aggregate=await readUsageAggregate(file,'7d',{now:()=>now,pageRows:2}); expect(aggregate.totals.priceEvidence).toEqual(evidence);
      expect(buildShareReport(aggregate,'7d').totals.pricing).toMatchObject({storedApiEquivalentUsd:null,priceStatus:null,fieldState:'conflict',recordedFieldChecks:evidence});
      expect(db.prepare('SELECT * FROM events ORDER BY rowid').all()).toEqual(before);
    } finally { db.close(); fs.rmSync(root,{recursive:true,force:true}); }
  });
  it('keeps two missing-dollar events and one priced estimate disjoint in totals, models, sessions and charts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-price-quality-'));
    const file = path.join(root, 'ledger.db'); const db = openDb({ file }); const now = Date.UTC(2026, 9, 7, 20);
    try {
      const insert = db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,model,provider,components_json,
        input_fresh,output,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256)
        VALUES (?,'H','codex',?,'record','s','m','unknown','[]',10,5,?,?,'fixture','NONE','')`);
      [[null, 'LIST'], [null, 'ESTIMATE'], [0.5, 'ESTIMATE'], [1, 'LIST']].forEach(([usd, status], i) => insert.run('e' + i, now - 1000 + i, usd, status));
      const before = db.prepare('SELECT * FROM events ORDER BY rowid').all();
      const config = defaultConfig({ hostLabel: 'H' });
      config.accounts = [{ id: 'fixture-account', kind: 'codex', hosts: ['H'], monthlyUsd: 300 }];
      const query = createQueries(db, config, { now: () => now, readSnapshotFile: file, pageRows: 2 });
      const expected = { unpricedEvents: 2, estimatedPriceEvents: 1, priceStatus: null, priceEvidence: { events: 4, issuesEvents: 2, statusAmountConflictEvents: 2, invalidAmountEvents: 0, unknownStatusEvents: 0, aggregateAmountInvalid: false } };
      const summary = await query.getSummary('7d');
      expect(summary.totals).toMatchObject({ events: 4, apiEquivUsd: 1.5, ...expected });
      expect(summary.bySource.codex).toMatchObject({ events: 4, apiEquivUsd: 1.5, ...expected });
      expect(summary.byModel[0]).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      expect(summary.subscriptions[0]).toMatchObject({ apiEquivUsd: 1.5, partial: true, ...expected });
      const aggregate = await readUsageAggregate(file, '7d', { now: () => now, pageRows: 2 });
      expect(aggregate.totals).toMatchObject({ events: 4, apiEquivUsd: 1.5, ...expected });
      expect(buildShareReport(aggregate, '7d').totals.pricing).toMatchObject({ storedApiEquivalentUsd: 1.5, partial: true, countsConsistent: true, fieldState: 'conflict', priceStatus: null, recordedFieldChecks: expected.priceEvidence });
      expect((await query.getDoctor()).priceEvidence).toMatchObject(expected.priceEvidence);
      expect((await query.getDoctor()).unmatchedModels[0]).toMatchObject({ events: 2 });
      const sessions = await query.getSessions({ range: '7d', activeOnly: false });
      expect(sessions.sessions[0]).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      expect(sessions.sessions[0]!.burn!.priceQuality).toMatchObject({ events: 4, ...expected });
      const detail = await query.getSessionDetail('codex', 's');
      expect(detail).not.toBeNull(); expect(detail).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      expect(detail!.telemetry[0]).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      expect(detail!.byModel[0]).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      expect(detail!.timeseries.points[0]).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      const timeseries = await query.getTimeseries('hour', '7d');
      expect(timeseries.range).toBe('7d'); expect(timeseries.bucket).toBe('hour');
      expect(timeseries.points[0]).toMatchObject({ apiEquivUsd: 1.5, ...expected });
      expect(db.prepare('SELECT * FROM events ORDER BY rowid').all()).toEqual(before);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
