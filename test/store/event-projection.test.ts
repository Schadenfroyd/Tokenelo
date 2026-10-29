/** Owned synthetic ledgers only; original installed binaries/native lifecycle remain separate gates. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openDb, openLedgerReadOnly, openForeignDbReadOnly } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { currentEventSql } from '../../src/store/event-basis.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type { UsageEvent } from '../../src/core/types.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const pricing=defaultPricingEngine(),computeUnits=createNullEngine();
const model='qwen3-coder-plus',tokens={inputFresh:100,cacheWrite5m:0,cacheWrite1h:0,cacheRead:0,output:10,reasoning:0};
const event:UsageEvent={id:'qwen-code:fixture',host:'TEST',source:'qwen-code',ts:1790000000000,tsSource:'line',sessionId:'fixture',isSubagent:false,
 model,provider:'local',thinking:false,components:[{model,tokens}],tokens,flags:[],apiEquivUsd:0,priceStatus:'LIST',priceVersion:pricing.version,
 reservedValue:null,ucuRateStatus:'NONE',eacsDefSha256:computeUnits.defSha256};
// A real count increase keeps these SQL-basis tests about changed measurements, not D4 route-only enrichment.
function hostedObservation(base:UsageEvent=event):UsageEvent{
 const nextTokens={...base.tokens,output:base.tokens.output+1};
 return{...base,provider:'unknown',tokens:nextTokens,components:base.components.map(c=>({...c,tokens:{...c.tokens,output:c.tokens.output+1},
   servingRoute:{kind:'hosted',evidence:'qwen-oauth'}}))};
}
function ownedFixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-projection-')),file=path.join(root,'fixture.sqlite');
 const fresh=openDb({file});fresh.close();
 // Reconstitute the unchanged original v9 tables with no projection/guards. This is
 // a synthetic schema fixture, not a substitute for a retained installed database.
 const raw=new DatabaseSync(file);
 for(const row of raw.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND (name LIKE 'recorded_events_%' OR name LIKE 'supported_writer_%' OR name LIKE 'projection_%' OR name LIKE 'retained_history_%')").all()as{name:string}[])
  raw.exec(`DROP TRIGGER "${row.name}"`);
 raw.exec("DROP TABLE event_projection;DROP TABLE event_projection_basis;DROP TABLE event_interpretation_history;DROP TABLE event_route_reports;UPDATE meta SET value='9' WHERE key='schema_version'");
 const ledger=new SqliteLedger(raw,pricing, computeUnits);ledger.upsertEvents([event]);ledger.setState({key:'fixture',size:100,mtimeMs:1,offset:50});raw.close();
 return{file,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
describe('current event SQL basis',()=>{
 it('protects original rows and immutable observations from REPLACE even without recursive triggers',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  const replace=(table:string,row:Record<string,unknown>)=>{const names=Object.keys(row);return db.prepare(`INSERT OR REPLACE INTO ${table}(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...Object.values(row)as never[]);};
  try{
   ledger.upsertEvents([event]);ledger.upsertEvents([hostedObservation()]);
   db.exec('PRAGMA recursive_triggers=OFF');
   const original=db.prepare('SELECT rowid,* FROM main.events').get()as Record<string,unknown>;
   expect(()=>replace('main.events',{...original,api_equiv_usd:99})).toThrow(/immutable/);
   expect(()=>replace('main.events',{...original,id:'orphan'})).toThrow(/immutable/);
   expect(db.prepare('SELECT rowid,* FROM main.events').get()).toEqual(original);
   const history=db.prepare('SELECT * FROM event_interpretation_history').get()as Record<string,unknown>;
   replace('event_interpretation_history',{...history,api_equiv_usd:99});
   expect(db.prepare('SELECT * FROM event_interpretation_history').get()).toEqual(history);
   const report=db.prepare('SELECT rowid,* FROM event_route_reports').get()as Record<string,unknown>;
   replace('event_route_reports',{...report,observed_at_ms:999});
   expect(db.prepare('SELECT rowid,* FROM event_route_reports').get()).toEqual(report);
  }finally{db.close();}
 });
 it('retains every current deletion and REPLACE prior row as a typed deletion interpretation',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([event]);const original=db.prepare('SELECT rowid,* FROM main.events').get();
   const row=db.prepare('SELECT rowid,* FROM events').get()as Record<string,unknown>,names=Object.keys(row);
   db.prepare(`INSERT OR REPLACE INTO events(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(n=>n==='api_equiv_usd'?7:row[n])as never[]);
   expect(db.prepare('SELECT change_kind,api_equiv_usd FROM event_interpretation_history ORDER BY history_id').all()).toEqual([{change_kind:'delete',api_equiv_usd:0}]);
   db.prepare('DELETE FROM events WHERE id=?').run(event.id);
   expect(db.prepare('SELECT change_kind,api_equiv_usd FROM event_interpretation_history ORDER BY history_id').all()).toEqual([{change_kind:'delete',api_equiv_usd:0},{change_kind:'delete',api_equiv_usd:7}]);
   expect(db.prepare('SELECT rowid,* FROM main.events').get()).toEqual(original);
  }finally{db.close();}
 });
 it('keeps parenthesized joins, WINDOW and pragma functions on the current basis',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([event]);ledger.upsertEvents([hostedObservation()]);
   for(const sql of ['SELECT api_equiv_usd FROM (events)','SELECT events.api_equiv_usd FROM ((events))','SELECT events.api_equiv_usd FROM (events JOIN (SELECT 1) AS unit ON 1)','SELECT events.api_equiv_usd FROM ((SELECT 1) AS unit JOIN events ON 1)','SELECT events.api_equiv_usd FROM events WINDOW w AS (PARTITION BY session_id)'])expect(db.prepare(sql).get()).toEqual({api_equiv_usd:null});
   expect((db.prepare("SELECT name FROM pragma_index_list('events')").all()as{name:string}[]).some(r=>r.name==='idx_projection_coverage')).toBe(true);
   expect((db.prepare("SELECT name FROM pragma_index_list('events','main')").all()as{name:string}[]).some(r=>r.name==='idx_events_coverage')).toBe(true);
  }finally{db.close();}
 });
 it('refuses conditional retained-trigger removal and preserves both count guards',()=>{
  const db=openDb({file:':memory:'});
  try{
   expect(()=>db.exec('DROP TRIGGER IF EXISTS events_invalidate_old_count_writer')).toThrow(/retained event layout/);
   expect(db.prepare("SELECT name FROM main.sqlite_schema WHERE name IN ('events_invalidate_old_count_writer','projection_invalidate_old_count_writer') ORDER BY name").all()).toEqual([{name:'events_invalidate_old_count_writer'},{name:'projection_invalidate_old_count_writer'}]);
   db.exec('CREATE TRIGGER IF NOT EXISTS events_invalidate_old_count_writer AFTER UPDATE ON events BEGIN SELECT 1; END');
   expect(db.prepare("SELECT tbl_name FROM main.sqlite_schema WHERE name='projection_invalidate_old_count_writer'").get()).toEqual({tbl_name:'event_projection'});
  }finally{db.close();}
 });
 it('preserves CTE bindings instead of substituting an unrelated current table',()=>{
  const db=openDb({file:':memory:'});
  try{
   expect(db.prepare('WITH events AS (SELECT 42 AS id) SELECT id FROM events').all()).toEqual([{id:42}]);
   expect(db.prepare('WITH other AS (SELECT 1), events(id) AS MATERIALIZED (SELECT 43) SELECT events.id FROM events').all()).toEqual([{id:43}]);
   expect(db.prepare('WITH RECURSIVE events(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM events WHERE id<3) SELECT id FROM events').all()).toEqual([{id:1},{id:2},{id:3}]);
  }finally{db.close();}
 });
 it('keeps aggregate aliases independent of physical table qualifiers',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([event]);
   expect(db.prepare('SELECT COUNT(*) AS events, events.id FROM events').get()).toEqual({events:1,id:event.id});
   expect(db.prepare('SELECT events.id,(SELECT COUNT(*) AS events FROM activity) AS activity_count FROM events').get()).toEqual({id:event.id,activity_count:0});
  }finally{db.close();}
 });
 it('uses the current economic row for comma joins and retains original indexed reads explicitly',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([event]);
   ledger.upsertEvents([hostedObservation()]);
   expect(db.prepare('SELECT events.api_equiv_usd FROM (SELECT 1) AS unit, events').get()).toEqual({api_equiv_usd:null});
   expect(db.prepare('SELECT api_equiv_usd FROM main.events INDEXED BY idx_events_coverage').get()).toEqual({api_equiv_usd:0});
  }finally{db.close();}
 });
 it('resolves nested table aliases and CTE scope without changing an outer current interpretation',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([event]);
   ledger.upsertEvents([hostedObservation()]);
   expect(db.prepare('SELECT events.api_equiv_usd,(WITH events AS (SELECT 44 AS id) SELECT events.id FROM events) AS nested_id FROM events').get()).toEqual({api_equiv_usd:null,nested_id:44});
   expect(db.prepare('SELECT events.id FROM (SELECT 45 AS id) AS events, events AS original WHERE original.id=?').get(event.id)).toEqual({id:45});
   expect(db.prepare('SELECT (SELECT events.api_equiv_usd) AS current_usd FROM events').get()).toEqual({current_usd:null});
  }finally{db.close();}
 });
 it('treats explicit schema pragma and index names as retained evidence, including multiple SQL statements',()=>{
  const db=openDb({file:':memory:'});
  try{
   expect((db.prepare("PRAGMA main.index_list('events')").all()as{name:string}[]).some(r=>r.name==='idx_events_coverage')).toBe(true);
   db.exec('CREATE INDEX idx_events_fixture_id ON events(id); CREATE INDEX main.idx_events_fixture_recorded ON events(id)');
   expect(db.prepare("SELECT name FROM main.sqlite_schema WHERE name IN ('idx_projection_fixture_id','idx_events_fixture_recorded') ORDER BY name").all()).toEqual([{name:'idx_events_fixture_recorded'},{name:'idx_projection_fixture_id'}]);
  }finally{db.close();}
 });
 it('routes tables and index hints without changing aliases, literals, comments or explicit recorded reads',()=>{
  const sql="SELECT 'FROM events',e.*,COUNT(*) AS events FROM events e INDEXED BY idx_events_ts -- JOIN events\nWHERE e.id=?";
  expect(currentEventSql(sql)).toBe("SELECT 'FROM events',e.*,COUNT(*) AS events FROM event_projection e INDEXED BY idx_projection_ts -- JOIN events\nWHERE e.id=?");
  expect(currentEventSql('SELECT * FROM main.events')).toBe('SELECT * FROM main.events');
  expect(currentEventSql('SELECT events.* FROM main.events')).toBe('SELECT events.* FROM main.events');
  expect(currentEventSql('SELECT events.* FROM events AS events')).toBe('SELECT events.* FROM event_projection AS events');
  expect(currentEventSql('DROP INDEX idx_events_coverage')).toBe('DROP INDEX idx_projection_coverage');
  expect(currentEventSql('SELECT events.* FROM "events"')).toBe('SELECT events.* FROM event_projection AS events');
  expect(currentEventSql("PRAGMA table_info('events')")).toBe("PRAGMA table_info('event_projection')");
 });
 it('preserves every original column/rowid while actual replay and all ordinary reads use current rows',()=>{
  const fixture=ownedFixture(),old=new DatabaseSync(fixture.file);
  const before=JSON.stringify(old.prepare('SELECT rowid,* FROM events').all());
  const rootpage=(old.prepare("SELECT rootpage FROM sqlite_schema WHERE type='table' AND name='events'").get()as{rootpage:number}).rootpage;
  const writer=openDb({file:fixture.file}),ledger=new SqliteLedger(writer,pricing, computeUnits);
  try{
   ledger.upsertEvents([hostedObservation()]);
   expect(ledger.getEvents()[0]!.apiEquivUsd).toBeNull();
   expect((writer.prepare('SELECT provider,api_equiv_usd FROM events').get()as{provider:string;api_equiv_usd:null})).toEqual({provider:'unknown',api_equiv_usd:null});
   expect(JSON.stringify(old.prepare('SELECT rowid,* FROM events').all())).toBe(before);
   expect((old.prepare("SELECT rootpage FROM sqlite_schema WHERE type='table' AND name='events'").get()as{rootpage:number}).rootpage).toBe(rootpage);
   const read=openLedgerReadOnly(fixture.file);try{expect((read.prepare('SELECT api_equiv_usd FROM events').get()as{api_equiv_usd:null}).api_equiv_usd).toBeNull();}finally{read.close();}
   const recorded=openForeignDbReadOnly(fixture.file);try{expect((recorded.prepare('SELECT api_equiv_usd FROM events').get()as{api_equiv_usd:number}).api_equiv_usd).toBe(0);}finally{recorded.close();}
  }finally{old.close();writer.close();fixture.close();}
 });
 it('rejects an already-prepared unsupported writer and rolls back its actual cursor/event transaction',()=>{
  const fixture=ownedFixture(),old=new DatabaseSync(fixture.file),oldLedger=new SqliteLedger(old,pricing, computeUnits);
  const prepared=old.prepare("UPDATE events SET api_equiv_usd=0 WHERE id='qwen-code:fixture'");
  const writer=openDb({file:fixture.file});
  try{
   expect(()=>prepared.run()).toThrow(/immutable/);
   expect(()=>oldLedger.transaction(()=>{oldLedger.setState({key:'fixture',size:200,mtimeMs:2,offset:150});oldLedger.upsertEvents([event]);})).toThrow(/tokenelo_event_writer_policy/);
   expect((old.prepare('SELECT offset FROM ingest_state').get()as{offset:number}).offset).toBe(50);
   expect(()=>writer.prepare('UPDATE main.events SET api_equiv_usd=1').run()).toThrow(/immutable/);
  }finally{old.close();writer.close();fixture.close();}
 });
 it('retains first recorded values for new captures and each changed interpretation without rewriting originals',()=>{
  const db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([event]);
   const original=JSON.stringify(db.prepare('SELECT rowid,* FROM main.events').all());
   ledger.upsertEvents([hostedObservation()]);
   expect(JSON.stringify(db.prepare('SELECT rowid,* FROM main.events').all())).toBe(original);
   expect(ledger.getEvents()[0]!.apiEquivUsd).toBeNull();
   const history=db.prepare('SELECT id,api_equiv_usd,prior_rowid,captured_at_ms FROM event_interpretation_history').all()as{id:string;api_equiv_usd:number;prior_rowid:number;captured_at_ms:number}[];
   expect(history).toHaveLength(1);expect(history[0]).toMatchObject({id:event.id,api_equiv_usd:0,prior_rowid:1});
   expect(history[0]!.captured_at_ms%1000).toBe(0); // Explicit second-resolution observation clock.
   const rowsBefore=db.prepare('SELECT COUNT(*) AS n FROM event_interpretation_history').get();
   ledger.upsertEvents([ledger.getEvents()[0]!]);
   expect(db.prepare('SELECT COUNT(*) AS n FROM event_interpretation_history').get()).toEqual(rowsBefore);
   expect(()=>db.exec('DELETE FROM event_interpretation_history')).toThrow(/immutable/);
  }finally{db.close();}
 });
 it('refuses an unsupported projection policy for both writable and current read-only openers',()=>{
  const fixture=ownedFixture(),db=openDb({file:fixture.file});db.exec('UPDATE event_projection_basis SET policy=999');
  expect(()=>new SqliteLedger(db,pricing, computeUnits).setState({key:'fixture',size:200,mtimeMs:2,offset:150})).toThrow(/writer policy/);
  expect((db.prepare('SELECT offset FROM ingest_state').get()as{offset:number}).offset).toBe(50);db.close();
  try{
   expect(()=>openDb({file:fixture.file})).toThrow(/projection policy/);
   expect(()=>openLedgerReadOnly(fixture.file)).toThrow(/projection policy/);
  }finally{fixture.close();}
 });
 it('refuses earlier internal projection policy copies and prevents negative history identity poisoning',()=>{
  const fixture=ownedFixture(),db=openDb({file:fixture.file}),ledger=new SqliteLedger(db,pricing, computeUnits);
  try{
   ledger.upsertEvents([{...event,components:[{model,tokens,servingRoute:{kind:'hosted',evidence:'qwen-oauth'}}]}]);
   const history=db.prepare('SELECT * FROM event_interpretation_history').get()as Record<string,unknown>,names=Object.keys(history);
   expect(()=>db.prepare(`INSERT INTO event_interpretation_history(${names.join(',')})VALUES(${names.map(()=>'?').join(',')})`).run(...names.map(n=>n==='history_id'?-1:history[n])as never[])).toThrow(/identity/);
   db.prepare("UPDATE events SET api_equiv_usd=7 WHERE id=?").run(event.id);
   expect(db.prepare('SELECT COUNT(*) AS n FROM event_interpretation_history').get()?.n).toBe(2);
   db.exec('UPDATE event_projection_basis SET policy=1');
  }finally{db.close();}
  try{expect(()=>openDb({file:fixture.file})).toThrow(/projection policy/);expect(()=>openLedgerReadOnly(fixture.file)).toThrow(/projection policy/);}finally{fixture.close();}
 });
 it('refuses newer/malformed owned schemas before changing journal mode or attempting migration',()=>{
  const fixture=ownedFixture(),raw=new DatabaseSync(fixture.file);
  raw.exec("PRAGMA journal_mode=DELETE;UPDATE meta SET value='999' WHERE key='schema_version'");raw.close();
  try{
   expect(()=>openDb({file:fixture.file})).toThrow(/newer than supported/);
   expect(()=>openLedgerReadOnly(fixture.file)).toThrow(/newer than supported/);
   const check=new DatabaseSync(fixture.file);try{
    expect((check.prepare('PRAGMA journal_mode').get()as{journal_mode:string}).journal_mode).toBe('delete');
    expect((check.prepare('SELECT COUNT(*) AS n FROM events').get()as{n:number}).n).toBe(1);
    check.exec("UPDATE meta SET value='NaN' WHERE key='schema_version'");
   }finally{check.close();}
   expect(()=>openDb({file:fixture.file})).toThrow(/malformed/);
  }finally{fixture.close();}
 });
});
