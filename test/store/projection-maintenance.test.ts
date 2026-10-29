import {describe,it,expect} from 'vitest';
import {openDb,type TokeneloDb} from '../../src/store/db.js';
import {SqliteLedger} from '../../src/store/ledger.js';
import {defaultPricingEngine} from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type {UsageEvent} from '../../src/core/types.js';
const pricing=defaultPricingEngine(),valuationEngine=createNullEngine(),model='qwen3-coder-plus',tokens={inputFresh:100,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:10,reasoning:0};
const event:UsageEvent={id:'qwen-code:maintenance',host:'TEST',source:'qwen-code',ts:1790000000000,tsSource:'line',sessionId:'fixture',isSubagent:false,model,provider:'local',thinking:false,components:[{model,tokens}],tokens,flags:[],apiEquivUsd:0,priceStatus:'LIST',priceVersion:pricing.version,reservedValue:null,ucuRateStatus:'NONE',eacsDefSha256:valuationEngine.defSha256};
function seed(db:TokeneloDb){const ledger=new SqliteLedger(db,pricing, valuationEngine);ledger.upsertEvents([event]);return ledger;}
describe('current retained maintenance and allocation',()=>{
 it('protects single-quoted retained tables and schema names',()=>{
  const db=openDb({file:':memory:'});try{seed(db);for(const sql of ["DROP TABLE 'event_route_reports'","DROP TABLE 'events'","DROP TABLE 'main'.'event_interpretation_history'","ALTER TABLE 'event_projection' RENAME TO other"])expect(()=>db.exec(sql)).toThrow(/retained event layout/);}finally{db.close();}
 });
 it('keeps retained and current count/audit triggers present through configured maintenance',()=>{
  const db=openDb({file:':memory:'});try{seed(db);for(const name of ['retain_prior_event_interpretation','recorded_events_reject_INSERT','supported_writer_ingest_state_UPDATE','require_history_allocation','events_invalidate_old_count_writer','projection_invalidate_old_count_writer'])expect(()=>db.exec(`DROP TRIGGER IF EXISTS '${name}'`)).toThrow(/retained event layout/);
   db.prepare('UPDATE events SET api_equiv_usd=99').run();expect(db.prepare('SELECT COUNT(*) AS n FROM event_interpretation_history').get()).toEqual({n:1});
  }finally{db.close();}
 });
 it('refuses implicit REPLACE that would move a retained event identity or ordering',()=>{
  const db=openDb({file:':memory:'});try{seed(db);const before=db.prepare('SELECT rowid AS retained_rowid,* FROM events').get() as Record<string,unknown>;const row=db.prepare('SELECT * FROM events').get() as Record<string,unknown>;delete row.rowid;const names=Object.keys(row);
   expect(()=>db.prepare(`INSERT OR REPLACE INTO events(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(n=>n==='api_equiv_usd'?99:row[n]) as never[])).toThrow(/identity/);
   expect(db.prepare('SELECT rowid AS retained_rowid,* FROM events').get()).toEqual(before);
  }finally{db.close();}
 });
 it('retains monotonic new row allocation and recovers a deleted original identity',()=>{
  const db=openDb({file:':memory:'});try{const ledger=seed(db);ledger.upsertEvents([{...event,id:'second'}]);const old=db.prepare('SELECT rowid AS r FROM events WHERE id=?').get('second') as {r:number};db.prepare('DELETE FROM events WHERE id=?').run('second');
   ledger.upsertEvents([{...event,id:'third'}]);const newer=db.prepare('SELECT rowid AS r FROM events WHERE id=?').get('third') as {r:number};expect(newer.r).toBeGreaterThan(old.r);
   ledger.upsertEvents([{...event,id:'second'}]);expect(db.prepare('SELECT rowid AS r FROM events WHERE id=?').get('second')).toEqual(old);
   expect(db.prepare('SELECT id,rowid AS r FROM events ORDER BY rowid').all()).toEqual(db.prepare('SELECT id,rowid AS r FROM main.events ORDER BY rowid').all());
   expect(ledger.getEvents().every(e=>!Object.hasOwn(e,'rowid'))).toBe(true);
  }finally{db.close();}
 });
 it('protects allocator metadata without requiring an AUTOINCREMENT history sequence',()=>{
  const db=openDb({file:':memory:'});try{seed(db);expect(()=>db.exec("UPDATE sqlite_sequence SET seq=9223372036854775807 WHERE name='event_interpretation_history'")).toThrow(/retained event layout/);
   db.prepare('UPDATE events SET api_equiv_usd=99').run();expect(db.prepare('SELECT COUNT(*) AS n FROM event_interpretation_history').get()).toEqual({n:1});
   expect(db.prepare("SELECT sql FROM main.sqlite_schema WHERE name='event_interpretation_history'").get()?.sql).not.toMatch(/AUTOINCREMENT/);
  }finally{db.close();}
 });
 it('restores upsert target qualifiers after a root SELECT and in RETURNING',()=>{
  const db=openDb({file:':memory:'});try{seed(db);for(const tail of ['',' RETURNING events.id']){
   const sql=(table:string)=>`INSERT INTO ${table}(id,api_equiv_usd) SELECT ?,? WHERE true ON CONFLICT(id) DO UPDATE SET api_equiv_usd=excluded.api_equiv_usd WHERE events.api_equiv_usd IS NOT excluded.api_equiv_usd${tail}`;
   expect(()=>db.prepare(sql('main.events'))).not.toThrow();expect(()=>db.prepare(sql('events'))).not.toThrow();
  }}finally{db.close();}
 });
 it('refuses all temporary shadow definitions for retained event tables',()=>{
  const db=openDb({file:':memory:'});try{seed(db);for(const sql of ['CREATE TEMP TABLE events(id TEXT)','CREATE TEMPORARY TABLE event_projection(id TEXT)',"CREATE TABLE 'temp'.'events'(id TEXT)","CREATE TEMP TABLE 'event_projection_basis'(singleton INTEGER,policy INTEGER)"])expect(()=>db.exec(sql)).toThrow(/retained event layout/);
   expect(db.prepare('SELECT id FROM events').get()).toEqual({id:event.id});
  }finally{db.close();}
 });
});

describe('focused adversarial routing findings',()=>{
 it('recovers the first recorded Claude fallback identity after current deletion',()=>{
  const db=openDb({file:':memory:'});try{const ledger=new SqliteLedger(db,pricing, valuationEngine);const fallback:UsageEvent={...event,id:'claude:+fallback-uuid',source:'claude',collectorFallbackUuidIdentity:true,collectorActivityUuid:'fallback-uuid'};
   ledger.upsertEvents([fallback]);const original=db.prepare('SELECT id,rowid AS r FROM main.events').get();db.prepare('DELETE FROM events WHERE id=?').run(fallback.id);
   db.prepare('INSERT INTO activity(source,session_id,ts,uuid,host)VALUES(?,?,?,?,?)').run('claude','resolved-session',event.ts,'fallback-uuid','TEST');
   ledger.upsertEvents([fallback]);expect(db.prepare('SELECT id,rowid AS r FROM events').all()).toEqual([original]);expect(db.prepare('SELECT COUNT(*) AS n FROM main.events').get()).toEqual({n:1});
  }finally{db.close();}
 });
 it('preserves CTE read bindings in UPDATE FROM',()=>{
  const db=openDb({file:':memory:'});try{seed(db);db.exec("CREATE TABLE routing_probe(key TEXT PRIMARY KEY,size INTEGER); INSERT INTO routing_probe VALUES('probe',0)");
   db.exec("WITH events AS(SELECT 'probe' AS key,123 AS size) UPDATE routing_probe SET size=events.size FROM events WHERE routing_probe.key=events.key");
   expect(db.prepare('SELECT size FROM routing_probe').get()).toEqual({size:123});
  }finally{db.close();}
 });
 it('refuses allocator updates through every UPDATE conflict prefix',()=>{
  const db=openDb({file:':memory:'});try{seed(db);for(const conflict of ['IGNORE','REPLACE','FAIL','ABORT','ROLLBACK'])expect(()=>db.exec(`UPDATE OR ${conflict} sqlite_sequence SET seq=0 WHERE name='event_projection'`)).toThrow(/retained event layout/);
  }finally{db.close();}
 });
 it('refuses explicit row allocation for an identity not already recorded',()=>{
  const db=openDb({file:':memory:'});try{seed(db);const row=db.prepare('SELECT * FROM events').get() as Record<string,unknown>;const names=Object.keys(row);
   expect(()=>db.prepare(`INSERT INTO events(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(n=>n==='id'?'new-explicit':n==='rowid'?3:row[n]) as never[])).toThrow(/identity/);
  }finally{db.close();}
 });
 it('restores bare REPLACE target qualifiers after SELECT in RETURNING',()=>{
  const db=openDb({file:':memory:'});try{seed(db);expect(()=>db.prepare('REPLACE INTO main.events(id) SELECT ? RETURNING events.id')).not.toThrow();expect(()=>db.prepare('REPLACE INTO events(id) SELECT ? RETURNING events.id')).not.toThrow();}finally{db.close();}
 });
 it('ends explicit trigger header state before its first body read',()=>{
  const db=openDb({file:':memory:'});try{seed(db);db.exec('CREATE TABLE routing_probe(n INTEGER);CREATE TABLE routing_log(n REAL)');db.prepare('UPDATE events SET api_equiv_usd=99').run();
   db.exec('CREATE TRIGGER main.routing_probe_trigger AFTER INSERT ON routing_probe BEGIN INSERT INTO routing_log SELECT api_equiv_usd FROM events; END');db.exec('INSERT INTO routing_probe VALUES(1)');expect(db.prepare('SELECT n FROM routing_log').get()).toEqual({n:99});
  }finally{db.close();}
 });
});
