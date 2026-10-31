/** Private Node SQLite sidecar. Caller-supplied opaque identity/context is not authenticated.
 * This receives an already opened NEW owned DB handle, never an app path or count ledger.
 * Neutral count SDK, production collectors/stores and original schemas remain separate.
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { importCountEnvelope } from './count-envelope-import.js';
import { captureCountHistory, MAX_COUNT_HISTORY_PACKETS, type CountHistoryResult } from './count-history.js';

export const COUNT_JOURNAL_VERSION = 'tokenelo/local-count-journal@v0';
export const MAX_COUNT_JOURNAL_BATCH_LENGTH = 1_048_576;
export const MAX_COUNT_JOURNAL_BATCH_RECORDS = 512;
type Refusal = 'batch-string-required' | 'batch-too-large' | 'batch-invalid' | 'packet-refused' | 'cursor-epoch-conflict' | 'cursor-backwards' | 'storage-refused';
export type CountJournalBatchResult = { kind: 'committed'; insertedSnapshots: number; cursorOffset: number } | { kind: 'refused'; reason: Refusal; packetIndex?: number };
export type CountJournalProjection = { kind: 'projected'; history: Extract<CountHistoryResult, { kind: 'count-history' }> }
  | { kind: 'unavailable'; reason: 'component-unknown' | 'component-context-conflict' | 'history-packet-limit' | 'stored-evidence-unavailable' };
export class CountJournalError extends Error {
  constructor(readonly reason: 'database-not-empty' | 'schema-unavailable' | 'schema-unsupported' | 'storage-refused') {
    super('Count journal unavailable'); this.name = 'CountJournalError'; this.stack = undefined;
  }
}
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const shape = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
const schemas = [
  ['count_journal_meta', 'CREATE TABLE count_journal_meta (id INTEGER PRIMARY KEY CHECK(id=1), version TEXT NOT NULL) STRICT'],
  ['count_journal_snapshots', 'CREATE TABLE count_journal_snapshots (component_key TEXT NOT NULL, context_sha TEXT NOT NULL, packet_sha TEXT NOT NULL, packet_json TEXT NOT NULL, PRIMARY KEY(component_key,context_sha,packet_sha)) STRICT'],
  ['count_journal_cursors', 'CREATE TABLE count_journal_cursors (source_key TEXT PRIMARY KEY, epoch_sha TEXT NOT NULL, byte_offset INTEGER NOT NULL CHECK(byte_offset>=0 AND byte_offset<=9007199254740991)) STRICT'],
] as const;
/** Memory is admitted for unit tests only; it proves no disk durability. No pragma mutation. */
function storageConfigured(db: DatabaseSync): boolean {
  if (typeof db.isTransaction !== 'boolean') return false;
  const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
  return (mode === 'delete' || mode === 'memory') && db.prepare('PRAGMA synchronous').get()?.synchronous === 2;
}

export class CountJournal {
  private constructor(private readonly db: DatabaseSync) {}
  static create(db: DatabaseSync): CountJournal {
    let began = false;
    try {
      if (db.isTransaction || !storageConfigured(db)) throw new CountJournalError('storage-refused');
      db.exec('BEGIN IMMEDIATE'); began = true;
      const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get();
      if (row?.n !== 0) throw new CountJournalError('database-not-empty');
      for (const [, sql] of schemas) db.exec(sql);
      db.prepare('INSERT INTO count_journal_meta VALUES (1,?)').run(COUNT_JOURNAL_VERSION);
      db.exec('COMMIT');began = false;return new CountJournal(db);
    } catch (e) {
      if (began) { try { db.exec('ROLLBACK'); } catch {} }
      if (e instanceof CountJournalError) throw e;
      throw new CountJournalError('storage-refused');
    }
  }
  static open(db: DatabaseSync): CountJournal {
    try {
      if (db.isTransaction || !storageConfigured(db)) throw new CountJournalError('storage-refused');
      const actual = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const expected = schemas.map(([name,sql])=>({type:'table',name,tbl_name:name,sql})).sort((a,b)=>a.name.localeCompare(b.name));
      if (JSON.stringify(actual)!==JSON.stringify(expected)) throw new CountJournalError('schema-unsupported');
      const metadata = db.prepare('SELECT id,version FROM count_journal_meta').all();
      if(metadata.length!==1 || metadata[0]?.id!==1 || metadata[0]?.version!==COUNT_JOURNAL_VERSION) throw new CountJournalError('schema-unsupported');
      return new CountJournal(db);
    } catch (e) { if (e instanceof CountJournalError) throw e;throw new CountJournalError('schema-unavailable'); }
  }
  ingest(serialized: unknown): CountJournalBatchResult {
    const refuse=(reason:Refusal,packetIndex?:number):CountJournalBatchResult=>({kind:'refused',reason,...(packetIndex===undefined?{}:{packetIndex})});
    if(typeof serialized!=='string')return refuse('batch-string-required');
    if(serialized.length>MAX_COUNT_JOURNAL_BATCH_LENGTH)return refuse('batch-too-large');
    let batch: unknown;try{batch=JSON.parse(serialized);}catch{return refuse('batch-invalid');}
    if(!record(batch)||!shape(batch,['sourceKey','epochSha','offset','resetEpoch','records'])||!key(batch.sourceKey)||!key(batch.epochSha)||!Number.isSafeInteger(batch.offset)||typeof batch.offset!=='number'||batch.offset<0||typeof batch.resetEpoch!=='boolean'||!Array.isArray(batch.records)||batch.records.length>MAX_COUNT_JOURNAL_BATCH_RECORDS)return refuse('batch-invalid');
    const validated:{componentKey:string;contextSha:string;packet:string;sha:string}[]=[];
    for(let i=0;i<batch.records.length;i++){
      const r:unknown=batch.records[i];if(!record(r)||!shape(r,['componentKey','contextSha','packet'])||!key(r.componentKey)||!key(r.contextSha))return refuse('batch-invalid');
      const imported=importCountEnvelope(r.packet);if(imported.kind==='rejected')return refuse('packet-refused',i);
      const packet=JSON.stringify(imported.envelope);validated.push({componentKey:r.componentKey,contextSha:r.contextSha,packet,sha:digest(packet)});
    }
    let began=false;
    try{
      if(this.db.isTransaction || !storageConfigured(this.db))return refuse('storage-refused');this.db.exec('BEGIN IMMEDIATE');began=true;
      const prior=this.db.prepare('SELECT epoch_sha,byte_offset FROM count_journal_cursors WHERE source_key=?').get(batch.sourceKey);
      if(prior&&prior.epoch_sha!==batch.epochSha&&!batch.resetEpoch){this.db.exec('ROLLBACK');began=false;return refuse('cursor-epoch-conflict');}
      if(prior&&prior.epoch_sha===batch.epochSha&&typeof prior.byte_offset==='number'&&batch.offset<prior.byte_offset){this.db.exec('ROLLBACK');began=false;return refuse('cursor-backwards');}
      const insert=this.db.prepare('INSERT INTO count_journal_snapshots VALUES (?,?,?,?) ON CONFLICT DO NOTHING');let inserted=0;
      for(const r of validated){
        const existing=this.db.prepare('SELECT packet_json FROM count_journal_snapshots WHERE component_key=? AND context_sha=? AND packet_sha=?').get(r.componentKey,r.contextSha,r.sha);
        if(existing&&existing.packet_json!==r.packet)throw new CountJournalError('storage-refused');
        inserted+=Number(insert.run(r.componentKey,r.contextSha,r.sha,r.packet).changes);
      }
      this.db.prepare('INSERT INTO count_journal_cursors VALUES (?,?,?) ON CONFLICT(source_key) DO UPDATE SET epoch_sha=excluded.epoch_sha,byte_offset=excluded.byte_offset').run(batch.sourceKey,batch.epochSha,batch.offset);
      this.db.exec('COMMIT');began=false;return {kind:'committed',insertedSnapshots:inserted,cursorOffset:batch.offset};
    }catch{if(began){try{this.db.exec('ROLLBACK');}catch{}}return refuse('storage-refused');}
  }
  cursor(sourceKey:string):{epochSha:string;offset:number}|null {
    try {
      if(this.db.isTransaction || !storageConfigured(this.db))throw new CountJournalError('storage-refused');
      if(!key(sourceKey))return null;const row=this.db.prepare('SELECT epoch_sha,byte_offset FROM count_journal_cursors WHERE source_key=?').get(sourceKey);
      if(!row)return null;
      if(!key(row.epoch_sha)||typeof row.byte_offset!=='number'||!Number.isSafeInteger(row.byte_offset)||row.byte_offset<0)throw new CountJournalError('storage-refused');
      return {epochSha:row.epoch_sha,offset:row.byte_offset};
    } catch {throw new CountJournalError('storage-refused');}
  }
  project(componentKey:string):CountJournalProjection {
    try {
    if(this.db.isTransaction || !storageConfigured(this.db))return {kind:'unavailable',reason:'stored-evidence-unavailable'};
    if(!key(componentKey))return {kind:'unavailable',reason:'component-unknown'};
    const contexts=this.db.prepare('SELECT DISTINCT context_sha FROM count_journal_snapshots WHERE component_key=?').all(componentKey);
    if(contexts.length===0)return {kind:'unavailable',reason:'component-unknown'};
    if(contexts.length>1)return {kind:'unavailable',reason:'component-context-conflict'};
    if(!key(contexts[0]?.context_sha))return {kind:'unavailable',reason:'stored-evidence-unavailable'};
    const size=this.db.prepare('SELECT COUNT(*) AS n FROM count_journal_snapshots WHERE component_key=?').get(componentKey)?.n;
    if(typeof size!=='number')return {kind:'unavailable',reason:'stored-evidence-unavailable'};
    if(size>MAX_COUNT_HISTORY_PACKETS)return {kind:'unavailable',reason:'history-packet-limit'};
    const rows=this.db.prepare('SELECT packet_json,packet_sha FROM count_journal_snapshots WHERE component_key=? ORDER BY packet_sha').all(componentKey);
    const packets:string[]=[];
    for(const row of rows){
      const imported=importCountEnvelope(row.packet_json);
      if(imported.kind==='rejected')return {kind:'unavailable',reason:'stored-evidence-unavailable'};
      const canonical=JSON.stringify(imported.envelope);
      if(canonical!==row.packet_json||digest(canonical)!==row.packet_sha)return {kind:'unavailable',reason:'stored-evidence-unavailable'};
      packets.push(canonical);
    }
    const history=captureCountHistory(JSON.stringify(packets));
    return history.kind==='count-history'?{kind:'projected',history}:{kind:'unavailable',reason:'stored-evidence-unavailable'};
    } catch {return {kind:'unavailable',reason:'stored-evidence-unavailable'};}
  }
}
