/** Regression fixtures from independently executed R1244/R1251 defects. No live ledgers. */
import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {openDb,openLedgerReadOnly,type TokeneloDb} from '../../src/store/db.js';
import {openReadSnapshot} from '../../src/store/read-snapshot.js';
import {SCHEMA_MIGRATIONS} from '../../src/store/migrations.js';
import {SqliteLedger} from '../../src/store/ledger.js';
import {defaultPricingEngine} from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type {UsageEvent} from '../../src/core/types.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const pricing=defaultPricingEngine(),computeUnits=createNullEngine(),model='qwen3-coder-plus';
const tokens={inputFresh:100,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:10,reasoning:0};
const event:UsageEvent={id:'qwen-code:integrity',host:'TEST',source:'qwen-code',ts:1790000000000,tsSource:'line',sessionId:'fixture',isSubagent:false,model,provider:'local',thinking:false,components:[{model,tokens}],tokens,flags:[],apiEquivUsd:0,priceStatus:'LIST',priceVersion:pricing.version,reservedValue:null,ucuRateStatus:'NONE',eacsDefSha256:computeUnits.defSha256};
function seed(db:TokeneloDb){const ledger=new SqliteLedger(db,pricing, computeUnits);ledger.upsertEvents([event]);ledger.upsertEvents([{...event,components:[{model,tokens,servingRoute:{kind:'hosted',evidence:'qwen-oauth'}}]}]);}
function replace(db:TokeneloDb,table:string,row:Record<string,unknown>){const names=Object.keys(row);return db.prepare(`INSERT OR REPLACE INTO ${table}(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(row) as never[]);}
describe('retained projection integrity',()=>{
 it('keeps current event identity and original row identity stable',()=>{
  const db=openDb({file:':memory:'});try{seed(db);const original=db.prepare('SELECT rowid,* FROM main.events').get();
   expect(()=>db.prepare('UPDATE events SET id=?').run('changed-id')).toThrow(/identity/);
   expect(()=>db.prepare('UPDATE events SET rowid=99').run()).toThrow(/identity/);
   expect(db.prepare('SELECT rowid,* FROM main.events').get()).toEqual(original);
  }finally{db.close();}
 });
 it('fails writes closed when recursive deletion audit is disabled',()=>{
  const db=openDb({file:':memory:'});try{seed(db);const current=db.prepare('SELECT rowid,* FROM events').get() as Record<string,unknown>;const history=db.prepare('SELECT * FROM event_interpretation_history').all();
   const report=db.prepare('SELECT rowid,* FROM event_route_reports').get() as Record<string,unknown>;db.exec('PRAGMA recursive_triggers=OFF');
   expect(()=>replace(db,'events',{...current,api_equiv_usd:99})).toThrow(/writer policy/);
   expect(()=>replace(db,'event_route_reports',{...report,event_id:'different-id'})).toThrow(/immutable|writer policy/);
   expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(current);expect(db.prepare('SELECT * FROM event_interpretation_history').all()).toEqual(history);
   expect(db.prepare('SELECT rowid,* FROM event_route_reports').get()).toEqual(report);
  }finally{db.close();}
 });
 it('refuses a history allocation that would block all later writes',()=>{
  const db=openDb({file:':memory:'});try{seed(db);const row=db.prepare('SELECT * FROM event_interpretation_history').get() as Record<string,unknown>;
   expect(()=>replace(db,'event_interpretation_history',{...row,history_id:9223372036854775807n})).toThrow(/retained interpretation/);
   db.prepare('UPDATE events SET api_equiv_usd=99').run();expect(db.prepare('SELECT api_equiv_usd FROM events').get()).toEqual({api_equiv_usd:99});
  }finally{db.close();}
 });
 it('refuses route-report rowid replacement independently of the observation key',()=>{
  const db=openDb({file:':memory:'});try{seed(db);const row=db.prepare('SELECT rowid,* FROM event_route_reports').get() as Record<string,unknown>;
   expect(()=>replace(db,'event_route_reports',{...row,event_id:'different-id'})).toThrow(/immutable/);
   expect(db.prepare('SELECT rowid,* FROM event_route_reports').get()).toEqual(row);
  }finally{db.close();}
 });
 it('refuses destructive table maintenance through configured owned connections',()=>{
  const db=openDb({file:':memory:'});try{seed(db);
   for(const sql of ['DROP TABLE events','DROP TABLE IF EXISTS "main"."event_projection"','ALTER TABLE events RENAME TO other','DROP TABLE event_interpretation_history','DROP TABLE event_route_reports','DROP TABLE event_projection_basis'])expect(()=>db.exec(sql)).toThrow(/retained event layout/);
   expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({n:1});
  }finally{db.close();}
 });
 for(const defect of ['unsupported-policy','missing-projection'])it(`rejects ${defect} before persistent open side effects`,()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-integrity-')),file=path.join(root,'fixture.sqlite');
  try{const db=openDb({file});db.close();const raw=new DatabaseSync(file);const policy=(raw.prepare('SELECT policy FROM event_projection_basis').get() as {policy:number}).policy;raw.function('tokenelo_event_writer_policy',{deterministic:true},()=>policy);raw.exec('PRAGMA recursive_triggers=ON');
   if(defect==='unsupported-policy')raw.exec('UPDATE event_projection_basis SET policy=1');else raw.exec('DROP TABLE event_projection');
   raw.exec('PRAGMA journal_mode=DELETE');raw.close();const before=fs.readFileSync(file);
   expect(()=>{const opened=openDb({file});opened.close();}).toThrow(/projection policy|retained event layout/);expect(()=>{const opened=openLedgerReadOnly(file);opened.close();}).toThrow(/projection policy|retained event layout/);
   expect(fs.readFileSync(file)).toEqual(before);expect(fs.existsSync(file+'-wal')).toBe(false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
 });
 it('validates the event basis inside the report snapshot when an upgrade commits at BEGIN',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-upgrade-snapshot-')),file=path.join(root,'fixture.sqlite');let armed=true;
  try{const legacy=openDb({file,migrate:false});legacy.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
   for(const migration of SCHEMA_MIGRATIONS.filter(m=>m.version<=9)){migration.up(legacy);legacy.prepare("INSERT OR REPLACE INTO meta(key,value)VALUES('schema_version',?)").run(String(migration.version));}
   new SqliteLedger(legacy,pricing, computeUnits).upsertEvents([event]);legacy.close();
   const nativeExec=DatabaseSync.prototype.exec;const spy=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:TokeneloDb,sql:string){
    if(armed&&sql.trim()==='BEGIN'){armed=false;const writer=openDb({file});writer.prepare('UPDATE events SET api_equiv_usd=99').run();writer.close();}
    return nativeExec.call(this,sql);
   });
   try{const snapshot=openReadSnapshot(file);try{expect(armed).toBe(false);expect(snapshot.db.prepare('SELECT api_equiv_usd FROM events').get()).toEqual({api_equiv_usd:99});}finally{snapshot.close();}}finally{spy.mockRestore();}
  }finally{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});}
 });
});
