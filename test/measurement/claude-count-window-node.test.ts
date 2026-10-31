import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { CountJournal } from '../../src/measurement/count-journal-node.js';
import { captureClaudeCountWindow,MAX_CLAUDE_COUNT_WINDOW_BYTES,MAX_CLAUDE_COUNT_WINDOW_JSON_LENGTH } from '../../src/measurement/claude-count-window-node.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const source='a'.repeat(64),epoch='b'.repeat(64);
const usage=(input=2)=>({input_tokens:input,output_tokens:3,cache_read_input_tokens:4,cache_creation_input_tokens:0});
const row=(id='private-identity',u:unknown=usage(),model:unknown='private-model')=>({type:'assistant',message:{id,model,usage:u,content:'private-content'}});
const encoded=(bytes:Uint8Array|string,patch:Record<string,unknown>={})=>JSON.stringify({sourceKey:source,epochSha:epoch,startOffset:0,resetEpoch:false,windowBase64:Buffer.from(bytes).toString('base64'),...patch});
function admitted(bytes:Uint8Array|string,patch:Record<string,unknown>={}){
 const result=captureClaudeCountWindow(encoded(bytes,patch));expect(result.kind).toBe('count-window');if(result.kind!=='count-window')throw Error('Expected admitted count window');return result;
}
const line=(r:unknown)=>JSON.stringify(r)+'\n';

describe('private caller-bound Claude JSONL byte window',()=>{
 it('advances CRLF/multibyte complete lines by bytes and leaves a partial JSON tail unread',()=>{
  const full=JSON.stringify({...row(),content:'snow☃'})+'\r\n',tail='{"type":"assistant"';
  const result=admitted(full+tail,{startOffset:11});
  expect(result.completeBytes).toBe(Buffer.byteLength(full));expect(result.nextOffset).toBe(11+Buffer.byteLength(full));expect(result.heldTailBytes).toBe(Buffer.byteLength(tail));
  expect(result.completeLines).toBe(1);expect(result.assistantUsageRows).toBe(1);expect(JSON.parse(result.journalBatch).offset).toBe(result.nextOffset);
 });
 it('holds a partial UTF8 tail without decoding it and refuses invalid UTF8 on a complete line',()=>{
  const full=Buffer.from(line(row())),tail=Buffer.from([0xe2,0x98]);const result=admitted(Buffer.concat([full,tail]));
  expect(result.completeBytes).toBe(full.length);expect(result.heldTailBytes).toBe(2);
  const waiting=admitted(tail);expect(waiting.completeBytes).toBe(0);expect(waiting.heldTailBytes).toBe(2);expect(JSON.parse(waiting.journalBatch).records).toHaveLength(0);
  expect(captureClaudeCountWindow(encoded(Buffer.from([0xff,10])))).toMatchObject({kind:'refused',reason:'invalid-utf8'});
 });
 it('extracts count-only packets and opaque keys while labeling identity/generation/boundary unverified',()=>{
  const result=admitted(line({...row(),cwd:'private-path'}));
  for(const marker of ['private-identity','private-model','private-content','private-path'])expect(JSON.stringify(result)).not.toContain(marker);
  expect(result).toMatchObject({sourceIdentity:'caller-unverified',generation:'caller-unverified',startBoundary:'caller-unverified'});
  const [record]=JSON.parse(result.journalBatch).records;expect(record.componentKey).toMatch(/^[a-f0-9]{64}$/);expect(record.contextSha).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(record.packet).totals.full.value).toBe(9);
 });
 it('selects iterations without adding a message final counter and never hashes equal counts into one event',()=>{
  const result=admitted(line(row('one',{...usage(100),iterations:[usage(2),usage(3)]}))+line(row('two',usage(2))));
  const records=JSON.parse(result.journalBatch).records;expect(result.components).toBe(3);expect(records.map((r:Record<string,string>)=>JSON.parse(r.packet).totals.full.value)).toEqual([9,10,9]);
  expect(new Set(records.map((r:Record<string,string>)=>r.componentKey)).size).toBe(3);
 });
 it('keeps repeated identity stable across generations but changed model/selection shape conflicts in the journal',()=>{
  const a=admitted(line(row())),b=admitted(line(row()),{epochSha:'c'.repeat(64)}),model=admitted(line(row('private-identity',usage(),'another-model'))),shape=admitted(line(row('private-identity',{...usage(),iterations:[usage()]})));
  const rec=(r:typeof a)=>JSON.parse(r.journalBatch).records[0];expect(rec(a).componentKey).toBe(rec(b).componentKey);expect(rec(a).contextSha).toBe(rec(b).contextSha);
  expect(rec(model).componentKey).toBe(rec(a).componentKey);expect(rec(model).contextSha).not.toBe(rec(a).contextSha);expect(rec(shape).componentKey).toBe(rec(a).componentKey);expect(rec(shape).contextSha).not.toBe(rec(a).contextSha);
  const db=new DatabaseSync(':memory:');try{const j=CountJournal.create(db);j.ingest(a.journalBatch);j.ingest(model.journalBatch);expect(j.project(rec(a).componentKey)).toEqual({kind:'unavailable',reason:'component-context-conflict'});}finally{db.close();}
 });
 it('refuses a bad later line as a whole window and returns only fixed reason/ordinal',()=>{
  const result=captureClaudeCountWindow(encoded(line(row())+'private-marker\n'));
  expect(result).toMatchObject({kind:'refused',reason:'line-invalid-json',lineOrdinal:1});expect(result).not.toHaveProperty('journalBatch');expect(JSON.stringify(result)).not.toContain('private-marker');
  expect(captureClaudeCountWindow(encoded('null\n'))).toMatchObject({reason:'line-object-required'});
 });
 it('skips non-usage/blank control lines but refuses malformed assistant identity/context/selection',()=>{
  const result=admitted('\n'+line({type:'user',message:'private-content'})+line({type:'assistant',message:{id:'no-usage'}}));expect(result.completeLines).toBe(3);expect(result.components).toBe(0);
  for(const [r,reason] of [[{type:'assistant'},'assistant-message-required'],[row(''), 'message-identity-required'],[row('id',usage(),{}),'model-context-invalid'],[row('id',null),'usage-selection-refused'],[row('id',{...usage(),iterations:'bad'}),'usage-selection-refused'],[row('id',{iterations:[null]}),'component-refused']] as const){
   expect(captureClaudeCountWindow(encoded(line(r)))).toMatchObject({kind:'refused',reason});
  }
 });
 it('bounds serialized input/bytes/offsets and never reads an in-process getter',()=>{
  let calls=0;expect(captureClaudeCountWindow({get bytes(){calls++;throw Error('private-marker');}})).toMatchObject({reason:'window-string-required'});expect(calls).toBe(0);
  expect(captureClaudeCountWindow(' '.repeat(MAX_CLAUDE_COUNT_WINDOW_JSON_LENGTH+1))).toMatchObject({reason:'window-json-too-large'});
  expect(captureClaudeCountWindow(encoded(Buffer.alloc(MAX_CLAUDE_COUNT_WINDOW_BYTES+1)))).toMatchObject({reason:'window-bytes-too-large'});
  for(const patch of [{startOffset:1.5},{startOffset:Number.MAX_SAFE_INTEGER},{windowBase64:'YQ=='+'\n'},{extra:true},{sourceKey:'private-marker'}])expect(captureClaudeCountWindow(encoded('\n',patch))).toMatchObject({reason:'window-invalid'});
 });
 it('accepts exactly512selected components and refuses513before returning a commit batch',()=>{
  const part={iterations:Array.from({length:256},()=>usage())};
  const result=admitted(line(row('one',part))+line(row('two',part)));expect(result.components).toBe(512);expect(JSON.parse(result.journalBatch).records).toHaveLength(512);
  expect(captureClaudeCountWindow(encoded(line(row('one',part))+line(row('two',part))+line(row('three'))))).toMatchObject({kind:'refused',reason:'journal-record-limit',lineOrdinal:2});
 });
});
