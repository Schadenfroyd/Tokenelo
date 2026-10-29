import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { computeSubscriptionLeverage } from '../../src/core/subscriptions.js';
import type { Range } from '../../src/core/types.js';

const NOW = Date.UTC(2026, 9, 6, 12), HOUR = 3_600_000;

describe('recorded timestamp fence and configured plan-cost evidence', () => {
  it.each(['sessions.activity', 'sessions.aggregation'])('cancels a paged session read at %s without returning success or retaining its snapshot', async cancelAt => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-session-phase-cancel-'));
    const file = path.join(dir, 'ledger.db'), db = openDb({ file });
    try {
      db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,model,provider,components_json,
        flags_json,price_status,price_version,ucu_rate_status,eacs_def_sha256,input_fresh,output,api_equiv_usd)
        VALUES('private-event','M4a','claude',?,'line','private-session','claude-sonnet-5','anthropic',
        '[]','[]','LIST','v','FILED-EXAMPLE','h',3,5,0.01)`).run(NOW - HOUR);
      db.prepare("INSERT INTO activity(source,session_id,ts,uuid,host,kind) VALUES('claude','private-session',?,'private-mark','M4a','user')").run(NOW - HOUR);
      const reason = new Error('owned session read cancelled'), controller = new AbortController(), phases: string[] = [];
      const queries = createQueries(db, defaultConfig({ hostLabel: 'M4a' }), { now: () => NOW, readSnapshotFile: file });
      await expect(queries.getSessions({ range: 'all', activeOnly: false }, {
        signal: controller.signal, onDiagnosticPhase: phase => {
          phases.push(phase); if (String(phase) === cancelAt) controller.abort(reason);
        },
      })).rejects.toBe(reason);
      expect(phases).toEqual(cancelAt === 'sessions.activity'
        ? ['sessions.events', 'sessions.activity'] : ['sessions.events', 'sessions.activity', 'sessions.aggregation']);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM activity').get()?.n).toBe(1);
      expect(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0);
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each<Range>(['today', '24h', '7d', '30d', 'all'])('keeps exact-now, excludes future, and preserves account scope for %s', async range => {
    const db = openDb({ file: ':memory:' });
    try {
      const config = defaultConfig({ hostLabel: 'M4a' });
      config.accounts = [{ id: 'account', kind: 'claude', hosts: ['M4a'], monthlyUsd: 30 }];
      const insert = db.prepare(`INSERT INTO events (id,host,source,ts,ts_source,session_id,is_subagent,model,provider,components_json,
        input_fresh,cache_write_5m,cache_write_1h,cache_read,output,reasoning,flags_json,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256,thinking)
        VALUES (?,?,?,?,'line',?,0,'claude-sonnet-5','anthropic',?,100,0,0,0,0,0,'[]',?,'LIST','synthetic-price','NONE','synthetic-def',NULL)`);
      const rows = [
        ['past','M4a','claude',NOW-HOUR,10], ['exact','M4a','claude',NOW,5], ['future','M4a','claude',NOW+HOUR,100],
        ['older','M4a','claude',NOW-25*HOUR,20], ['foreign-host','A2000','claude',NOW-HOUR,7], ['foreign-source','M4a','codex',NOW-HOUR,11],
      ] as const;
      for (const [id,host,source,ts,usd] of rows) insert.run(id,host,source,ts,id,JSON.stringify([{model:'claude-sonnet-5',tokens:{inputFresh:100,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:0,reasoning:0}}]),usd);
      const queries = createQueries(db, config, { now: () => NOW, listProcesses: async () => [], probeOllama: async () => ({servers:[],manifests:new Map(),generatedAt:NOW}) });
      const summary = await queries.getSummary(range), short = range === 'today' || range === '24h';
      expect(summary.totals.apiEquivUsd).toBe(short ? 33 : 53);
      expect(summary.subscriptions[0].apiEquivUsd).toBe(short ? 15 : 35);
      expect(summary.timeBasis).toMatchObject({asOfMs:NOW,endInclusive:true,timestampBasis:'recorded-timestamps',excludedFutureEvents:1,excludedFutureActivity:0});
      expect(summary.subscriptions[0]).toMatchObject({unpricedEvents:0,estimatedPriceEvents:0,priceStatus:'LIST',partial:false});
      if (range === 'all') {
        expect(summary.subscriptions[0]).toMatchObject({billedUsd:null,leverage:null,costBasis:{state:'period-unavailable',monthlyUsd:30,rangeStartMs:null,invoiceVerified:false}});
      } else expect(summary.subscriptions[0].costBasis).toMatchObject({state:'configured-proration',monthlyUsd:30,prorationDays:30,invoiceVerified:false});
      const sessions = await queries.getSessions({range,activeOnly:false});
      expect(sessions.sessions.some(s => s.sessionId === 'exact')).toBe(true);
      expect(sessions.sessions.some(s => s.sessionId === 'future')).toBe(false);
      expect(sessions.timeBasis?.asOfMs).toBe(NOW);
      const series = await queries.getTimeseries('hour', range);
      expect(series.points.reduce((n,p) => n+p.apiEquivUsd,0)).toBe(summary.totals.apiEquivUsd);
      expect(series.timeBasis?.excludedFutureEvents).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(6);
    } finally { db.close(); }
  });

  it('does not turn an unknown period into epoch zero; explicit epoch zero remains a declared numeric period', () => {
    const account = {id:'account',kind:'claude' as const,hosts:['M4a' as const],monthlyUsd:30};
    expect(computeSubscriptionLeverage(account,130,null,NOW)).toMatchObject({billedUsd:null,leverage:null,costBasis:{state:'period-unavailable',rangeStartMs:null}});
    expect(computeSubscriptionLeverage(account,130,0,NOW).billedUsd).toBe(20732.5);
  });

  it('distinguishes a reported zero, missing price, invalid price and empty period', () => {
    const account = {id:'account',kind:'claude' as const,hosts:['M4a' as const]};
    expect(computeSubscriptionLeverage({...account,monthlyUsd:0},10,NOW-HOUR,NOW)).toMatchObject({billedUsd:0,leverage:null,costBasis:{state:'configured-proration',monthlyUsd:0}});
    expect(computeSubscriptionLeverage(account,10,NOW-HOUR,NOW).costBasis?.state).toBe('price-unconfigured');
    for (const monthlyUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(computeSubscriptionLeverage({...account,monthlyUsd},10,NOW-HOUR,NOW)).toMatchObject({billedUsd:null,leverage:null,costBasis:{state:'price-invalid',monthlyUsd:null}});
    expect(computeSubscriptionLeverage({...account,monthlyUsd:30},10,NOW,NOW)).toMatchObject({billedUsd:0,leverage:null,costBasis:{state:'configured-proration'}});
  });

  it.each<Range>(['today','all'])('fences event and activity pages on the same request snapshot for %s', async range => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-time-cost-'));
    const file = path.join(dir,'ledger.db'), db = openDb({file});
    try {
      const config = defaultConfig({hostLabel:'M4a'});
      config.accounts = [{id:'account',kind:'claude',hosts:['M4a'],monthlyUsd:30}];
      const event = db.prepare(`INSERT INTO events (id,host,source,ts,ts_source,session_id,is_subagent,model,provider,components_json,
        input_fresh,cache_write_5m,cache_write_1h,cache_read,output,reasoning,flags_json,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256,thinking)
        VALUES (?,'M4a','claude',?,'line',?,0,'claude-sonnet-5','anthropic','[]',100,0,0,0,0,0,'[]',?,'LIST','synthetic-price','NONE','synthetic-def',NULL)`);
      const mark = db.prepare("INSERT INTO activity (source,session_id,ts,uuid,host,kind) VALUES ('claude',?,?,?,'M4a','user')");
      for (const [id,ts,usd] of [['past',NOW-HOUR,10],['exact',NOW,5],['future',NOW+HOUR,100]] as const) {
        event.run(id,ts,id,usd);mark.run(id,ts,id+'-mark');
      }
      const opts = {now:()=>NOW,listProcesses:async()=>[],probeOllama:async()=>({servers:[],manifests:new Map(),generatedAt:NOW})};
      const direct = createQueries(db,config,opts), baseline = await direct.getSummary(range);
      expect(baseline.totals.apiEquivUsd).toBe(15);
      expect(baseline.timeBasis).toMatchObject({excludedFutureEvents:1,excludedFutureActivity:1});
      let wrote = false;
      const paged = createQueries(db,config,{...opts,readSnapshotFile:file,pageRows:1,yieldNow:async()=>{
        if (wrote) return;
        wrote=true;event.run('late',NOW-HOUR,'late',7);mark.run('late',NOW-HOUR,'late-mark');
        event.run('late-future',NOW+2*HOUR,'late-future',200);mark.run('late-future',NOW+2*HOUR,'late-future-mark');
      }});
      expect(await paged.getSummary(range)).toEqual(baseline);
      expect(wrote).toBe(true);
      const after = await direct.getSummary(range);
      expect(after.totals.apiEquivUsd).toBe(22);
      expect(after.timeBasis).toMatchObject({excludedFutureEvents:2,excludedFutureActivity:2});
      const sessions = await paged.getSessions({range,activeOnly:false});
      expect(sessions).toEqual(await direct.getSessions({range,activeOnly:false}));
      expect(sessions.sessions.map(s=>s.sessionId).sort()).toEqual(['exact','late','past']);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(5);
      expect(db.prepare('SELECT COUNT(*) AS n FROM activity').get()?.n).toBe(5);
    } finally { db.close();fs.rmSync(dir,{recursive:true,force:true}); }
  });
});
