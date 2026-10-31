import { describe,expect,it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { Source } from '../../src/core/types.js';

const NOW=Date.UTC(2026,9,6,12);
describe('capture-off retained local telemetry',()=>{
  it.each<Source>(['claude','ollama-proxy','ollama-log'])('retains %s data without assuming a Claude JSONL origin',async source=>{
    const db=openDb({file:':memory:'});
    try{
      const config=defaultConfig({hostLabel:'M4a'});config.local.capture='off';
      db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,is_subagent,model,provider,components_json,input_fresh,cache_write_5m,cache_write_1h,cache_read,output,reasoning,flags_json,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256,thinking)
        VALUES ('local','M4a',?,?,'line','local',0,'gemma4:12b','local',?,10,0,0,0,5,0,'[]',0,'LIST','synthetic-only','NONE','synthetic-only',NULL)`)
        .run(source,NOW-1000,JSON.stringify([{model:'gemma4:12b',tokens:{inputFresh:10,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:5,reasoning:0}}]));
      const summary=await createQueries(db,config,{now:()=>NOW}).getSummary('today');
      expect(summary.local.captured).toBe(true);
      expect(summary.local.reason).not.toContain('Claude JSONL');
      expect(summary.byModel.filter(row=>row.provider==='local')).toMatchObject([{source,events:1}]);
      expect(summary.totals.events).toBe(1);expect(summary.totals.apiEquivUsd).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(1);
    }finally{db.close();}
  });
  it('keeps disabled capture with no retained events unavailable',async()=>{
    const db=openDb({file:':memory:'});
    try{
      const config=defaultConfig({hostLabel:'M4a'});config.local.capture='off';
      const summary=await createQueries(db,config,{now:()=>NOW}).getSummary('today');
      expect(summary.local).toMatchObject({captured:false,reason:'local capture not configured',valueVsClaude:{usd:null},valueVsGpt:{usd:null},netSavingsVsClaude:null,netSavingsVsGpt:null});
    }finally{db.close();}
  });
});
