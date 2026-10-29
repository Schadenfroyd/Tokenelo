import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {makeHarness,baseTestConfig} from '../claude/helpers.js';
import {CodexCollector,statFile} from '../../src/collectors/codex.js';
import {Rollout} from './helpers.js';
  it.each(['rename','copy','replace'] as const)('archive %s: idle trailing requests, later counter keep the same total and original ledger rows', async mode => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-review-archive-'));
    const h=makeHarness({...baseTestConfig(),codex:{homes:[root]}});
    const th='01a0819d-cfe2-7ef0-8f65-12c21ee505e1', turn='01a0819d-d01b-75c1-993c-c0c752866014';
    const file=path.join(root,'sessions',`rollout-2026-09-08T15-23-05-${th}.jsonl`);
    fs.mkdirSync(path.dirname(file));
    const r=new Rollout().meta({id:th}).taskStarted(turn,1788264000).turnContextNested(turn,'gpt-6-sol','low').assistant()
      .record(th,turn,'r1',[100,0,10]).record(th,turn,'r2',[200,0,20]);
    fs.writeFileSync(file,r.text());
    try {
      await new CodexCollector({homes:[root],now:()=>statFile(file).mtimeMs+2*3600000}).scan(h.ctx);
      const total=()=>h.ledger.getEvents({}).reduce((n,e)=>n+e.tokens.inputFresh+e.tokens.cacheRead+e.tokens.output,0);
      expect(total()).toBe(330);
      const extra=new Rollout(Date.UTC(2026,8,1,12,0,r.nextOrdinal)).record(th,turn,'r3',[300,0,30]).tokenCount([600,0,60],[300,0,30]);
      for(let i=0;i<extra.lines.length;i++){const line=JSON.parse(extra.lines[i]!);line.ordinal+=r.nextOrdinal;extra.lines[i]=JSON.stringify(line);}
      const all=[...r.lines,...extra.lines].map(line=>JSON.parse(line));
      expect(all.map(line=>line.ordinal)).toEqual(all.map((_line,i)=>i));
      expect(all.map(line=>Date.parse(line.timestamp))).toEqual(all.map(line=>Date.parse(line.timestamp)).sort((a,b)=>a-b));
      fs.appendFileSync(file,extra.text());
      await new CodexCollector({homes:[root],now:()=>statFile(file).mtimeMs+60000}).scan(h.ctx);
      expect(total()).toBe(660);
      const rowsBefore=h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all();
      const statesBefore=h.db.prepare('SELECT rowid,key FROM ingest_state ORDER BY rowid').all();
      const dest=mode==='replace'?file:path.join(root,'archived_sessions',path.basename(file));fs.mkdirSync(path.dirname(dest),{recursive:true});
      if(mode==='replace'){const temp=file+'.copy';fs.copyFileSync(file,temp);fs.unlinkSync(file);fs.renameSync(temp,file);}else if(mode==='copy'){fs.copyFileSync(file,dest);fs.unlinkSync(file);}else fs.renameSync(file,dest);
      await new CodexCollector({homes:[root],now:()=>statFile(dest).mtimeMs+60000}).scan(h.ctx);
      expect(total()).toBe(660);
      expect(h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(rowsBefore);
      if(mode!=='replace')expect(h.ledger.getState(file)).toBeUndefined();
      expect(h.db.prepare('SELECT rowid,key FROM ingest_state ORDER BY rowid').all()).toEqual([{rowid:statesBefore[0]!.rowid,key:dest}]);
      if(mode!=='replace')expect((h.ledger.getState(dest)!.extra as {previousSourceKeys:string[]}).previousSourceKeys).toEqual([file]);
    } finally {h.close();fs.rmSync(root,{recursive:true,force:true});}
  });

it('archive mismatch is disclosed and does not replay historical usage',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-archive-mismatch-'));const h=makeHarness({...baseTestConfig(),codex:{homes:[root]}});
  const sid='01a0819d-cfe2-7ef0-8f65-12c21ee505e1',turn='01a0819d-d01b-75c1-993c-c0c752866014';
  const file=path.join(root,'sessions',`rollout-2026-09-08T15-23-05-${sid}.jsonl`);fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file,new Rollout().meta({id:sid}).taskStarted(turn,1788264000).turnContextNested(turn,'gpt-6-sol','low').assistant().record(sid,turn,'r1',[100,0,10]).text());
  try{
    await new CodexCollector({homes:[root],now:()=>statFile(file).mtimeMs+2*3600000}).scan(h.ctx);
    const before=h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all(),saved=h.ledger.getState(file);
    const dest=path.join(root,'archived_sessions',path.basename(file));fs.mkdirSync(path.dirname(dest));fs.renameSync(file,dest);
    const changed=fs.readFileSync(dest,'utf8').replace('"r1"','"rX"');fs.writeFileSync(dest,changed);
    const stats=await new CodexCollector({homes:[root],now:()=>statFile(dest).mtimeMs+2*3600000}).scan(h.ctx);
    expect(stats.filesSkipped).toBe(1);expect(stats.warnings.some(s=>s.includes('automatic replay held'))).toBe(true);
    expect(h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(before);expect(h.ledger.getState(file)).toEqual(saved);expect(h.ledger.getState(dest)).toBeUndefined();
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('batch write failure rolls back events, activity and their consumed cursor together',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-archive-atomic-'));const h=makeHarness({...baseTestConfig(),codex:{homes:[root]}});
  const sid='01a0819d-cfe2-7ef0-8f65-12c21ee505e1',turn='01a0819d-d01b-75c1-993c-c0c752866014';
  const file=path.join(root,'sessions',`rollout-2026-09-08T15-23-05-${sid}.jsonl`);fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,new Rollout().meta({id:sid}).taskStarted(turn,1788264000).turnContextNested(turn,'gpt-6-sol','low').assistant().record(sid,turn,'r1',[100,0,10]).text());
  const setState=h.ledger.setState.bind(h.ledger);
  try{
    h.ledger.setState=()=>{throw new Error('injected cursor commit failure')};
    const stats=await new CodexCollector({homes:[root],now:()=>statFile(file).mtimeMs+2*3600000}).scan(h.ctx);
    expect(stats.filesSkipped).toBe(1);expect(h.db.prepare('SELECT COUNT(*)n FROM events').get()).toEqual({n:0});expect(h.ledger.getState(file)).toBeUndefined();
    h.ledger.setState=setState;
    await new CodexCollector({homes:[root],now:()=>statFile(file).mtimeMs+2*3600000}).scan(h.ctx);
    expect(h.ledger.getEvents({}).reduce((sum,e)=>sum+e.tokens.inputFresh+e.tokens.output,0)).toBe(110);
  }finally{h.ledger.setState=setState;h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('a legacy cursor adopts its witness at the original path; a moved unwitnessed cursor is held',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-archive-legacy-'));const h=makeHarness({...baseTestConfig(),codex:{homes:[root]}});
  const sid='01a0819d-cfe2-7ef0-8f65-12c21ee505e1',turn='01a0819d-d01b-75c1-993c-c0c752866014';
  const file=path.join(root,'sessions',`rollout-2026-09-08T15-23-05-${sid}.jsonl`);fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,new Rollout().meta({id:sid}).taskStarted(turn,1788264000).turnContextNested(turn,'gpt-6-sol','low').assistant().record(sid,turn,'r1',[100,0,10]).text());
  try{
    const scan=()=>new CodexCollector({homes:[root],now:()=>Date.now()+2*3600000}).scan(h.ctx);
    await scan();const before=h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all();
    let state=h.ledger.getState(file)!;const legacy={...(state.extra as Record<string,unknown>)};delete legacy.consumedPrefix;h.ledger.setState({...state,extra:legacy});
    await scan();expect((h.ledger.getState(file)!.extra as {consumedPrefix:unknown}).consumedPrefix).toBeDefined();expect(h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(before);
    state=h.ledger.getState(file)!;const again={...(state.extra as Record<string,unknown>)};delete again.consumedPrefix;h.ledger.setState({...state,extra:again});
    const dest=path.join(root,'archived_sessions',path.basename(file));fs.mkdirSync(path.dirname(dest));fs.renameSync(file,dest);
    const result=await scan();expect(result.filesSkipped).toBe(1);expect(result.warnings.some(s=>s.includes('automatic replay held'))).toBe(true);expect(h.db.prepare('SELECT rowid,* FROM events ORDER BY rowid').all()).toEqual(before);expect(h.ledger.getState(file)).toBeDefined();expect(h.ledger.getState(dest)).toBeUndefined();
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});
