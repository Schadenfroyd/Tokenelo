import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { ClaudeCollector, readNewCompleteLines } from '../../src/collectors/claude.js';
import { readClaudeHold, summarizeClaudeHolds, CLAUDE_HOLD_KEY } from '../../src/core/capture-holds.js';
import { makeHarness, baseTestConfig } from './helpers.js';

const cap=4*1024*1024,sid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const longLine=(padKey='pad',padLength=cap+2048)=>JSON.stringify({type:'assistant',sessionId:sid,uuid:'held-line',timestamp:'2026-09-01T00:00:00Z',[padKey]:'x'.repeat(padLength),message:{id:'held-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:20}}})+'\n';
function setup(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-hold-identity-'));const project=path.join(root,'-held');fs.mkdirSync(project);const file=path.join(project,sid+'.jsonl');fs.writeFileSync(file,longLine());const h=makeHarness(baseTestConfig({roots:[root]}));return{root,file,h,close(){h.close();fs.rmSync(root,{recursive:true,force:true});}};}

it('keeps the held age through multiple appends and collector restarts, then clears it on recovery',async()=>{
 const t=setup();try{
  await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;expect(first).not.toBeNull();
  for(let n=0;n<3;n++){fs.appendFileSync(t.file,'{"type":"attachment"}\n');await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)?.heldSince).toBe(first.heldSince);expect(t.h.ledger.getState(t.file)?.offset).toBe(0);expect(t.h.ledger.getEvents({})).toHaveLength(0);}
  expect(summarizeClaudeHolds([JSON.stringify(t.h.ledger.getState(t.file)?.extra)])).toEqual({collector:'claude',heldFiles:1,oldestHeldAt:first.heldSince,maxLineBytes:cap});
  await new ClaudeCollector({maxLineBytes:cap*2}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)).toBeNull();expect(t.h.ledger.getEvents({})).toHaveLength(1);
 }finally{t.close();}
});

it('starts a new age for a changed capped prefix at the same inode and size',async()=>{
 const t=setup();try{await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;const ino=fs.statSync(t.file,{bigint:true}).ino,size=fs.statSync(t.file).size;fs.writeFileSync(t.file,longLine('paz'));const when=new Date(Date.now()+60_000);fs.utimesSync(t.file,when,when);expect(fs.statSync(t.file,{bigint:true}).ino).toBe(ino);expect(fs.statSync(t.file).size).toBe(size);await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBeGreaterThan(first.heldSince);}finally{t.close();}
});

it('starts a new age for a replaced inode even when size, mtime and capped prefix agree',async()=>{
 const t=setup();try{const when=new Date(1_700_000_000_000);fs.utimesSync(t.file,when,when);await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;const ino=fs.statSync(t.file,{bigint:true}).ino;fs.writeFileSync(t.file+'.new',longLine());fs.utimesSync(t.file+'.new',when,when);fs.renameSync(t.file+'.new',t.file);expect(fs.statSync(t.file,{bigint:true}).ino).not.toBe(ino);await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBeGreaterThan(first.heldSince);}finally{t.close();}
});

it('accumulates short reads without changing the capped-prefix identity',async()=>{
 const t=setup();const read=fs.readSync;try{await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;fs.appendFileSync(t.file,'{}\n');const spy=vi.spyOn(fs,'readSync').mockImplementation((...args:any[])=>{args[3]=Math.min(args[3],8192);return Reflect.apply(read,fs,args);});await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);spy.mockRestore();expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBe(first.heldSince);expect(t.h.ledger.getState(t.file)?.offset).toBe(0);}finally{vi.restoreAllMocks();t.close();}
});

it('does not invent a cap hold or advance unread state when EOF arrives before the statted length',async()=>{
 const t=setup();try{const spy=vi.spyOn(fs,'readSync').mockImplementation(()=>0);const scan=await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);spy.mockRestore();expect(scan.warnings.length).toBeGreaterThan(0);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)).toBeNull();expect(t.h.ledger.getState(t.file)?.offset??0).toBe(0);expect(t.h.db.prepare('SELECT count(*) n FROM skipped').get()!.n).toBe(0);await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)).not.toBeNull();}finally{vi.restoreAllMocks();t.close();}
});

it('an old marker without a digest remains recognised but does not prove an appended prefix',async()=>{
 const t=setup();try{await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const state=t.h.ledger.getState(t.file)!;const first=readClaudeHold(state.extra)!;t.h.ledger.setState({...state,extra:{[CLAUDE_HOLD_KEY]:{heldSince:first.heldSince,maxLineBytes:cap}}});await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)?.heldSince).toBe(first.heldSince);fs.appendFileSync(t.file,'{}\n');await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBeGreaterThan(first.heldSince);expect(t.h.ledger.getEvents({})).toHaveLength(0);}finally{t.close();}
});

it('keeps the public line-reader result shape and byte boundaries unchanged',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-line-read-shape-'));try{const file=path.join(root,'utf8.txt');fs.writeFileSync(file,'é\npartial');expect(readNewCompleteLines(file,0,fs.statSync(file).size)).toEqual({lines:['é'],newOffset:3});expect(readNewCompleteLines(file,3,fs.statSync(file).size)).toEqual({lines:[],newOffset:3});}finally{fs.rmSync(root,{recursive:true,force:true});}
});

it('starts a new age when truncation leaves the same capped prefix still blocked',async()=>{
 const t=setup();try{await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;fs.truncateSync(t.file,cap+1024);await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBeGreaterThan(first.heldSince);expect(t.h.ledger.getState(t.file)?.offset).toBe(0);}finally{t.close();}
});

it('a different cap starts a new hold if the line is still too long',async()=>{
 const t=setup();try{fs.writeFileSync(t.file,longLine('pad',cap*3));await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;await new ClaudeCollector({maxLineBytes:cap*2}).scan(t.h.ctx);const later=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;expect(later.maxLineBytes).toBe(cap*2);expect(later.heldSince).toBeGreaterThan(first.heldSince);expect(t.h.ledger.getState(t.file)?.offset).toBe(0);}finally{t.close();}
});

it('a malformed private digest cannot preserve age after append or leak into aggregate status',async()=>{
 const t=setup();try{await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const state=t.h.ledger.getState(t.file)!,first=readClaudeHold(state.extra)!;t.h.ledger.setState({...state,extra:{[CLAUDE_HOLD_KEY]:{...first,prefixSha256:'not-a-digest'}}});expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)).toEqual({heldSince:first.heldSince,maxLineBytes:cap});fs.appendFileSync(t.file,'{}\n');await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const later=readClaudeHold(t.h.ledger.getState(t.file)?.extra)!;expect(later.heldSince).toBeGreaterThan(first.heldSince);expect(JSON.stringify(summarizeClaudeHolds([JSON.stringify(t.h.ledger.getState(t.file)?.extra)]))).not.toContain('prefixSha256');}finally{t.close();}
});

it('public reader preserves complete lines when the supplied size exceeds current EOF',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-eof-compatible-'));try{const file=path.join(root,'text');fs.writeFileSync(file,'é\npartial');expect(readNewCompleteLines(file,0,fs.statSync(file).size+20)).toEqual({lines:['é'],newOffset:3});}finally{fs.rmSync(root,{recursive:true,force:true});}
});

it('replacement between stat and open defers without certifying the old identity, then resets age',async()=>{
 const t=setup();const open=fs.openSync;try{await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=t.h.ledger.getState(t.file)!;fs.appendFileSync(t.file,'{}\n');fs.writeFileSync(t.file+'.new',longLine()+'{}\n');let swapped=false;
 const spy=vi.spyOn(fs,'openSync').mockImplementation((...args:any[])=>{if(args[0]===t.file&&!swapped){swapped=true;fs.renameSync(t.file+'.new',t.file);}return Reflect.apply(open,fs,args);});
 const scan=await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);spy.mockRestore();expect(swapped).toBe(true);expect(scan.warnings.some(w=>w.includes('read deferred'))).toBe(true);expect(t.h.ledger.getState(t.file)).toEqual(first);expect(t.h.db.prepare('SELECT count(*) n FROM skipped').get()!.n).toBe(0);await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBeGreaterThan(readClaudeHold(first.extra)!.heldSince);
 }finally{vi.restoreAllMocks();t.close();}
});

it('preserves hold age at a nonzero byte offset after a touch and an append',async()=>{
 const t=setup();try{const before=JSON.stringify({type:'attachment',sessionId:sid,uuid:'before',timestamp:'2026-09-01T00:00:00Z',cwd:'/é'})+'\n';fs.writeFileSync(t.file,before+longLine());await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);const first=t.h.ledger.getState(t.file)!;expect(first.offset).toBe(Buffer.byteLength(before));fs.utimesSync(t.file,new Date(),new Date(Date.now()+60_000));await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBe(readClaudeHold(first.extra)!.heldSince);fs.appendFileSync(t.file,'{}\n');await new ClaudeCollector({maxLineBytes:cap}).scan(t.h.ctx);expect(t.h.ledger.getState(t.file)?.offset).toBe(first.offset);expect(readClaudeHold(t.h.ledger.getState(t.file)?.extra)!.heldSince).toBe(readClaudeHold(first.extra)!.heldSince);}finally{t.close();}
});
