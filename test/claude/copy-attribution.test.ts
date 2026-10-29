import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { makeHarness, baseTestConfig } from '../claude/helpers.js';

it('a blank-session join retains parent and main/subagent role as one recorded pair',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-parent-role-pair-')),project=path.join(root,'-fixture');fs.mkdirSync(project);const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',parent='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(uuid:string)=>JSON.stringify({type:'assistant',uuid,timestamp:'2026-09-01T00:00:00Z',message:{id:'paired-role-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0,speed:'standard'}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    fs.writeFileSync(path.join(project,owner+'.jsonl'),line('stored-main'));await new ClaudeCollector().scan(h.ctx);
    h.ledger.recordActivity([{source:'claude',sessionId:owner,ts:Date.parse('2026-09-01'),uuid:'incoming-agent',host:'TEST'}]);
    const dir=path.join(project,parent,'subagents');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'agent-pair.jsonl'),line('incoming-agent'));await new ClaudeCollector().scan(h.ctx);
    const e=h.ledger.getEvents({})[0]!;expect(e).toMatchObject({sessionId:owner,isSubagent:false,parentSessionId:undefined});expect(e.tokens.output).toBe(20);
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('repeated equal-count copied usage after activity enrichment leaves every stored field unchanged',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-joined-noop-')),project=path.join(root,'-fixture');fs.mkdirSync(project);const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',copy='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string|undefined,uuid:string)=>JSON.stringify({type:'assistant',uuid,sessionId:sid,timestamp:'2026-09-01T00:00:00Z',message:{id:'joined-noop',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    fs.writeFileSync(path.join(project,owner+'.jsonl'),line(undefined,'stored'));await new ClaudeCollector().scan(h.ctx);
    h.ledger.recordActivity([{source:'claude',sessionId:owner,ts:Date.parse('2026-09-01'),uuid:'joined-noop',host:'TEST'}]);
    const file=path.join(project,copy+'.jsonl');fs.writeFileSync(file,line(copy,'joined-noop'));await new ClaudeCollector().scan(h.ctx);const before=h.db.prepare('SELECT rowid,* FROM events').get();
    fs.appendFileSync(file,line(copy,'joined-noop'));await new ClaudeCollector().scan(h.ctx);const after=h.db.prepare('SELECT rowid,* FROM events').get()!;
    expect(after).toEqual(before);
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('a fresh blank-session subagent usage preserves its file-derived role and reported context on activity join',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-blank-subagent-')),project=path.join(root,'-fixture');fs.mkdirSync(project);const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',parent='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const dir=path.join(project,parent,'subagents');fs.mkdirSync(dir,{recursive:true});
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    h.ledger.recordActivity([{source:'claude',sessionId:owner,ts:Date.parse('2026-09-01'),uuid:'blank-subagent',host:'TEST'}]);
    fs.writeFileSync(path.join(dir,'agent-context.jsonl'),JSON.stringify({type:'assistant',uuid:'blank-subagent',cwd:'/fixture/subagent',gitBranch:'main',entrypoint:'agent',timestamp:'2026-09-01T00:00:00Z',message:{id:'blank-subagent-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0,speed:'standard'}}})+'\n');
    await new ClaudeCollector().scan(h.ctx);const e=h.ledger.getEvents({})[0]!;expect(e).toMatchObject({sessionId:owner,isSubagent:true,parentSessionId:parent,project:'/fixture/subagent',gitBranch:'main',entrypoint:'agent'});expect(e.flags).toContain('sessionAttributionEnriched');expect(e.flags).not.toContain('sessionAttributionConflict');
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('a blank incoming usage fills missing recorded context without erasing a stored project',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-blank-context-')),project=path.join(root,'-fixture');fs.mkdirSync(project);const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const line=(uuid:string,cwd:string,extra:Record<string,string>={})=>JSON.stringify({type:'assistant',uuid,cwd,...extra,timestamp:'2026-09-01T00:00:00Z',message:{id:'blank-context-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0,speed:'standard'}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    const file=path.join(project,owner+'.jsonl');fs.writeFileSync(file,line('stored-blank','/fixture/stored'));await new ClaudeCollector().scan(h.ctx);
    h.ledger.recordActivity([{source:'claude',sessionId:owner,ts:Date.parse('2026-09-01'),uuid:'fill-context',host:'TEST'}]);
    fs.appendFileSync(file,line('fill-context','/fixture/incoming',{gitBranch:'main',entrypoint:'agent'}));await new ClaudeCollector().scan(h.ctx);
    expect(h.ledger.getEvents({})[0]).toMatchObject({sessionId:owner,project:'/fixture/stored',gitBranch:'main',entrypoint:'agent'});
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it.each([true,false])('initial and duplicate iteration snapshots qualify actual component speed when top-level explicit is %s',async explicit=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-iteration-speed-')),project=path.join(root,'-fixture');fs.mkdirSync(project);const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const counts={input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0};const line=JSON.stringify({type:'assistant',uuid:'iteration-speed',sessionId:owner,timestamp:'2026-09-01T00:00:00Z',message:{id:'iteration-speed-message',model:'claude-sonnet-5',usage:{...counts,...(explicit?{speed:'standard'}:{}),iterations:[{...counts,model:'claude-sonnet-5',...(!explicit?{speed:'standard'}:{})}]}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{const file=path.join(project,owner+'.jsonl');fs.writeFileSync(file,line);await new ClaudeCollector().scan(h.ctx);expect(h.ledger.getEvents({})[0]!.flags.includes('speedAssumed')).toBe(explicit);const before=h.db.prepare('SELECT rowid,* FROM events').get();fs.appendFileSync(file,line);await new ClaudeCollector().scan(h.ctx);expect(h.db.prepare('SELECT rowid,* FROM events').get()).toEqual(before);}
  finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('activity enrichment preserves recorded subagent context and rejects conflicting copy economics', async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-joined-context-')),project=path.join(root,'-fixture');fs.mkdirSync(project);
  const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',copy='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string|undefined,uuid:string,output:number,geo:string,effort:string)=>JSON.stringify({type:'assistant',uuid,sessionId:sid,effort,timestamp:'2026-09-01T00:00:00Z',message:{id:'joined-context-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:output,cache_creation_input_tokens:0,cache_read_input_tokens:0,inference_geo:geo,speed:'standard'}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try {
    fs.writeFileSync(path.join(project,owner+'.jsonl'),line(undefined,'stored-blank',30,'global','low'));await new ClaudeCollector().scan(h.ctx);
    h.db.prepare("UPDATE events SET is_subagent=1,parent_session_id='parent',git_branch='main',repo_root='/fixture/repo',entrypoint='agent'").run();
    const before=h.ledger.getEvents({})[0]!;const rowid=h.db.prepare('SELECT rowid FROM events').get()!.rowid;
    h.ledger.recordActivity([{source:'claude',sessionId:owner,ts:before.ts,uuid:'join-context',host:'TEST'}]);
    fs.writeFileSync(path.join(project,copy+'.jsonl'),line(copy,'join-context',20,'us','high'));await new ClaudeCollector().scan(h.ctx);
    const after=h.ledger.getEvents({})[0]!;
    expect(after).toMatchObject({sessionId:owner,isSubagent:true,parentSessionId:'parent',gitBranch:'main',repoRoot:'/fixture/repo',entrypoint:'agent',inferenceGeo:'global',effort:'low'});
    expect(after.flags).toContain('sessionAttributionConflict');expect(after.flags).toContain('sessionAttributionEnriched');expect(after.tokens.output).toBe(30);expect(after.apiEquivUsd).toBe(before.apiEquivUsd);expect(after.reservedValue).toBe(before.reservedValue);expect(h.db.prepare('SELECT rowid FROM events').get()!.rowid).toBe(rowid);
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it.each([20,40])('priced speed assumption follows kept collector components when incoming output is %i',async output=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-priced-speed-')),project=path.join(root,'-fixture');fs.mkdirSync(project);const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const line=(uuid:string,n:number,speed?:string)=>JSON.stringify({type:'assistant',uuid,sessionId:owner,timestamp:'2026-09-01T00:00:00Z',message:{id:'priced-speed-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:n,cache_creation_input_tokens:0,cache_read_input_tokens:0,speed}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    const file=path.join(project,owner+'.jsonl');fs.writeFileSync(file,line('explicit',30,'standard'));await new ClaudeCollector().scan(h.ctx);
    h.db.prepare('UPDATE events SET flags_json=?,count_revision=count_revision+1').run(JSON.stringify(['sessionContextUnrecorded']));
    expect(h.ledger.getEvents({})[0]!.apiEquivUsd).not.toBeNull();
    fs.appendFileSync(file,line('assumed',output));await new ClaudeCollector().scan(h.ctx);const e=h.ledger.getEvents({})[0]!;
    expect(e.tokens.output).toBe(Math.max(30,output));expect(e.components[0]!.speed).toBe(output===40?undefined:'standard');expect(e.flags.includes('speedAssumed')).toBe(output===40);
    expect(e.apiEquivUsd).not.toBeNull();expect(e.flags).not.toContain('legacyCountEvidenceMixed');
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('a blank stored usage owner joins the existing activity owner rather than a copied session', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-blank-stored-owner-')),project=path.join(root,'-fixture');fs.mkdirSync(project);
  const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',copy='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string|undefined,uuid:string,output:number)=>JSON.stringify({type:'assistant',uuid,sessionId:sid,timestamp:'2026-09-01T00:00:00Z',message:{id:'blank-stored-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:output,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try {
    const original=path.join(project,owner+'.jsonl');fs.writeFileSync(original,line(undefined,'original-blank',30));await new ClaudeCollector().scan(h.ctx);
    const rowid=h.db.prepare('SELECT rowid FROM events').get()!.rowid;
    h.ledger.recordActivity([{source:'claude',sessionId:owner,ts:Date.parse('2026-09-01T00:00:00Z'),uuid:'activity-owner',host:'TEST'}]);
    fs.writeFileSync(path.join(project,copy+'.jsonl'),line(copy,'activity-owner',20));await new ClaudeCollector().scan(h.ctx);
    const event=h.ledger.getEvents({})[0]!;expect(event).toMatchObject({sessionId:owner,tsSource:'activity'});expect(event.tokens.output).toBe(30);
    expect(event.flags).toContain('sessionAttributionEnriched');expect(event.flags).toContain('sessionContextUnrecorded');expect(event.flags).toContain('sessionAttributionConflict');
    expect(h.db.prepare('SELECT rowid FROM events').get()!.rowid).toBe(rowid);
  } finally {h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it.each([10,50])('a blank incoming snapshot with output %i discloses existing event/activity ownership disagreement',async output=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-existing-owner-mismatch-')),project=path.join(root,'-fixture');fs.mkdirSync(project);
  const stored='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',activityOwner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string|undefined,uuid:string,n:number)=>JSON.stringify({type:'assistant',uuid,sessionId:sid,timestamp:'2026-09-01T00:00:00Z',message:{id:'existing-owner-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:n,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try {
    const file=path.join(project,stored+'.jsonl');fs.writeFileSync(file,line(stored,'stored-owner',30));await new ClaudeCollector().scan(h.ctx);
    h.ledger.recordActivity([{source:'claude',sessionId:activityOwner,ts:Date.parse('2026-09-01T00:00:00Z'),uuid:'other-owner',host:'TEST'}]);
    fs.appendFileSync(file,line(undefined,'other-owner',output));await new ClaudeCollector().scan(h.ctx);
    const event=h.ledger.getEvents({})[0]!;expect(event.sessionId).toBe(stored);expect(event.tokens.output).toBe(Math.max(30,output));
    expect(event.flags).toContain('sessionAttributionConflict');expect(event.flags).not.toContain('sessionAttributionEnriched');
  } finally {h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('an owner snapshot with absent economic fields preserves reported context and the frozen LIST price basis and reserved valuation fields',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-absent-owner-context-')),project=path.join(root,'-fixture');fs.mkdirSync(project);
  const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',copy='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string,uuid:string,output:number|null,effort?:string,geo?:string)=>JSON.stringify({type:'assistant',uuid,sessionId:sid,effort,timestamp:'2026-09-01T00:00:00Z',message:{id:'absent-context-message',model:'claude-sonnet-5',...(output===null?{}:{usage:{input_tokens:10,output_tokens:output,cache_creation_input_tokens:0,cache_read_input_tokens:0,inference_geo:geo}})}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try {
    const file=path.join(project,owner+'.jsonl');fs.writeFileSync(file,line(owner,'context-origin',null));await new ClaudeCollector().scan(h.ctx);
    fs.writeFileSync(path.join(project,copy+'.jsonl'),line(copy,'context-origin',30,'high','us'));await new ClaudeCollector().scan(h.ctx);const before=h.ledger.getEvents({})[0]!;
    fs.appendFileSync(file,line(owner,'owner-absent-fields',20));await new ClaudeCollector().scan(h.ctx);const after=h.ledger.getEvents({})[0]!;
    expect(after).toMatchObject({sessionId:owner,effort:'high',inferenceGeo:'us'});expect(after.tokens.output).toBe(30);expect(after.apiEquivUsd).toBe(before.apiEquivUsd);expect(after.reservedValue).toBe(before.reservedValue);expect(after.rateKey).toBe(before.rateKey);expect(after.ucuRateStatus).toBe(before.ucuRateStatus);
  } finally {h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('a usage snapshot without a session can join existing activity without claiming a conflicting session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-blank-owner-'));
  const project = path.join(root, '-fixture'); fs.mkdirSync(project);
  const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const line = (withSession: boolean, withUsage: boolean) => JSON.stringify({type:'assistant',uuid:'blank-owner',...(withSession?{sessionId:sid}:{}),timestamp:'2026-09-01T00:00:00Z',message:{id:'blank-message',model:'claude-sonnet-5',...(withUsage?{usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}}:{})}})+'\n';
  const h = makeHarness(baseTestConfig({roots:[root]}));
  try {
    const file=path.join(project,sid+'.jsonl');fs.writeFileSync(file,line(true,false));await new ClaudeCollector().scan(h.ctx);
    fs.appendFileSync(file,line(false,true));await new ClaudeCollector().scan(h.ctx);
    const event=h.ledger.getEvents({})[0]!;
    expect(event).toMatchObject({sessionId:sid,tsSource:'activity'});
    expect(event.flags).toContain('sessionAttributionEnriched');
    expect(event.flags).not.toContain('sessionAttributionConflict');
    expect(event.tokens.output).toBe(20);
    expect(h.db.prepare('SELECT session_id FROM activity').all()).toEqual([{session_id:sid}]);
  } finally {h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('an owner snapshot corrects copied economic context after activity-only attribution while MAX counts survive', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-owner-economics-'));
  const project = path.join(root, '-fixture'); fs.mkdirSync(project);
  const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line = (sid: string, uuid: string, output: number | null, geo: string, effort: string) => JSON.stringify({ type: 'assistant', uuid, sessionId: sid, effort, timestamp: '2026-09-01T00:00:00Z', message: { id: 'owner-economics', model: 'claude-sonnet-5', ...(output === null ? {} : {usage: { input_tokens: 10, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, inference_geo: geo }}) } }) + '\n';
  const h = makeHarness(baseTestConfig({ roots: [root] }));
  try {
    const file = path.join(project, first + '.jsonl');
    fs.writeFileSync(file, line(first, 'original-uuid', null, 'global', 'low'));
    await new ClaudeCollector().scan(h.ctx);
    fs.writeFileSync(path.join(project, second + '.jsonl'), line(second, 'original-uuid', 30, 'us', 'high'));
    await new ClaudeCollector().scan(h.ctx);
    const copied = h.ledger.getEvents({})[0]!;
    expect(copied).toMatchObject({ sessionId: first, inferenceGeo: 'us', effort: 'high', tsSource: 'activity' });
    const rowid = h.db.prepare('SELECT rowid FROM events').get()!.rowid;
    fs.appendFileSync(file, line(first, 'owner-new-uuid', 20, 'global', 'low'));
    await new ClaudeCollector().scan(h.ctx);
    const corrected = h.ledger.getEvents({})[0]!;
    expect(corrected).toMatchObject({ sessionId: first, inferenceGeo: 'global', effort: 'low' });
    expect(corrected.tokens.output).toBe(30);
    expect(corrected.apiEquivUsd).toBeCloseTo((10 * 2 + 30 * 10) / 1_000_000, 12);
    expect(corrected.flags).toContain('sessionAttributionConflict');
    expect(h.db.prepare('SELECT rowid FROM events').get()!.rowid).toBe(rowid);
  } finally { h.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('a copied UUID without a message ID retains one fallback event and the first rowid', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-copy-fallback-'));
  const project = path.join(root, '-fixture'); fs.mkdirSync(project);
  const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line = (sid: string) => JSON.stringify({ type: 'assistant', uuid: 'fallback-copy', sessionId: sid, timestamp: '2026-09-01T00:00:00Z', message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n';
  const h = makeHarness(baseTestConfig({ roots: [root] }));
  try {
    fs.writeFileSync(path.join(project, first + '.jsonl'), line(first));
    await new ClaudeCollector().scan(h.ctx);
    const original = h.db.prepare('SELECT rowid,id FROM events').get();
    fs.writeFileSync(path.join(project, second + '.jsonl'), line(second));
    await new ClaudeCollector().scan(h.ctx);
    expect(h.db.prepare('SELECT rowid,id FROM events').all()).toEqual([original]);
    expect(h.ledger.getEvents({})[0]!.sessionId).toBe(first);
    expect(h.ledger.getEvents({})[0]!.flags).toContain('sessionAttributionConflict');
    expect(h.ledger.getEvents({})[0]!.tokens.output).toBe(20);
    expect(h.db.prepare('SELECT session_id FROM activity').all()).toEqual([{session_id:first}]);
  } finally { h.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(['same','later'] as const)('F1 actual Claude collector: %s copied timestamp keeps event and activity session ownership consistent',async timestamp=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-review-claude-copy-'));
  const proj=path.join(root,'-review');fs.mkdirSync(proj);
  const first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string,ts:string)=>JSON.stringify({type:'assistant',uuid:'copied-line',sessionId:sid,cwd:'/fixture/review',timestamp:ts,message:{id:'copied-message',model:'claude-sonnet-5',usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try {
    fs.writeFileSync(path.join(proj,first+'.jsonl'),line(first,'2026-09-01T00:00:00Z'));
    await new ClaudeCollector().scan(h.ctx);
    expect(h.ledger.getEvents({})).toHaveLength(1);
    expect(h.ledger.getEvents({})[0]!.source).toBe('claude');
    expect(h.ledger.getEvents({})[0]!.sessionId).toBe(first);
    fs.writeFileSync(path.join(proj,second+'.jsonl'),line(second,timestamp==='same'?'2026-09-01T00:00:00Z':'2026-09-01T00:10:00Z'));
    await new ClaudeCollector().scan(h.ctx);
    const activity=h.db.prepare("SELECT session_id FROM activity WHERE source='claude' AND uuid='copied-line'").all();
    expect(activity).toHaveLength(1);
    expect(activity[0]!.session_id).toBe(first);
    const event=h.ledger.getEvents({})[0]!;
    expect(event.tokens.output).toBe(20);
    expect(event.sessionId).toBe(activity[0]!.session_id);
    expect(event.flags).toContain('sessionAttributionConflict');
    fs.appendFileSync(path.join(proj,first+'.jsonl'),line(first,'2026-09-01T00:00:00Z'));
    await new ClaudeCollector().scan(h.ctx);
    expect(h.ledger.getEvents({})[0]!.flags).toContain('sessionAttributionConflict');
    expect(h.ledger.getEvents({})[0]!.sessionId).toBe(first);
  } finally {h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it('a larger copied snapshot retains recorded ownership while MAX counts and list-basis dollars grow',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-copy-growth-')),proj=path.join(root,'-review');fs.mkdirSync(proj);
  const first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const line=(sid:string,large:boolean)=>JSON.stringify({type:'assistant',uuid:'copied-line',sessionId:sid,cwd:large?'/fixture/copy':'/fixture/original',timestamp:large?'2026-09-01T00:10:00Z':'2026-09-01T00:00:00Z',message:{id:'copied-message',model:'claude-sonnet-5',usage:{input_tokens:large?100:10,output_tokens:large?60:20,cache_creation_input_tokens:large?40:10,cache_creation:{ephemeral_5m_input_tokens:large?15:3,ephemeral_1h_input_tokens:large?25:7},cache_read_input_tokens:large?30:20,output_tokens_details:{thinking_tokens:large?25:10}}}})+'\n';
  const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    fs.writeFileSync(path.join(proj,first+'.jsonl'),line(first,false));await new ClaudeCollector().scan(h.ctx);const original=h.ledger.getEvents({})[0]!;const rowid=h.db.prepare('SELECT rowid FROM events').get()!.rowid;
    fs.writeFileSync(path.join(proj,second+'.jsonl'),line(second,true));await new ClaudeCollector().scan(h.ctx);const events=h.ledger.getEvents({});expect(events).toHaveLength(1);const event=events[0]!;
    expect(event).toMatchObject({host:original.host,sessionId:first,ts:original.ts,tsSource:original.tsSource,project:original.project,repoRoot:original.repoRoot,parentSessionId:original.parentSessionId,isSubagent:original.isSubagent});
    expect(event.tokens).toMatchObject({inputFresh:100,cacheWrite5m:15,cacheWrite1h:25,cacheRead:30,output:60,reasoning:25});expect(event.components).toHaveLength(1);expect(event.components[0]!.tokens).toEqual(event.tokens);
    // Frozen repository LIST basis:100*2 +15*2.5 +25*4 +30*.2 +60*10, per million.
    // This is not current vendor served-tier or invoice acceptance.
    expect(event.apiEquivUsd).toBeCloseTo(.0009435,12);expect(event.flags).toContain('sessionAttributionConflict');expect(h.db.prepare('SELECT rowid FROM events').get()!.rowid).toBe(rowid);
    expect(h.db.prepare("SELECT session_id,COUNT(*)n FROM activity WHERE source='claude' AND uuid='copied-line' GROUP BY session_id").all()).toEqual([{session_id:first,n:1}]);expect(h.db.prepare('SELECT session_id,SUM(output)n FROM events GROUP BY session_id').all()).toEqual([{session_id:first,n:60}]);
    const before=h.db.prepare('SELECT rowid,* FROM events').get();fs.appendFileSync(path.join(proj,first+'.jsonl'),line(first,false));await new ClaudeCollector().scan(h.ctx);expect(h.db.prepare('SELECT rowid,* FROM events').get()).toEqual(before);
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});

it.each(['same-window','separate-scans'] as const)('an activity-only original before a copied usage snapshot keeps attribution coherent (%s)',async mode=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-copy-mark-first-')),proj=path.join(root,'-review');fs.mkdirSync(proj);const first='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const firstFile=path.join(proj,first+'.jsonl');const line=(sid:string,withUsage:boolean)=>JSON.stringify({type:'assistant',uuid:'copied-line',sessionId:sid,cwd:sid===first?'/fixture/original':'/fixture/copy',timestamp:sid===first?'2026-09-01T00:00:00Z':'2026-09-01T00:10:00Z',message:{id:'copied-message',model:'claude-sonnet-5',...(withUsage?{usage:{input_tokens:10,output_tokens:20,cache_creation_input_tokens:0,cache_read_input_tokens:0}}:{})}})+'\n';const h=makeHarness(baseTestConfig({roots:[root]}));
  try{
    fs.writeFileSync(firstFile,line(first,false));
    if(mode==='separate-scans'){await new ClaudeCollector().scan(h.ctx);fs.writeFileSync(path.join(proj,second+'.jsonl'),line(second,true));}else fs.appendFileSync(firstFile,line(second,true));
    await new ClaudeCollector().scan(h.ctx);const events=h.ledger.getEvents({});expect(events).toHaveLength(1);const mark=h.db.prepare("SELECT session_id,project,ts FROM activity WHERE source='claude' AND uuid='copied-line'").get()!;expect(mark.session_id).toBe(first);expect(events[0]!).toMatchObject({sessionId:mark.session_id,project:mark.project,ts:mark.ts});expect(events[0]!.tokens.output).toBe(20);expect(events[0]!.flags).toContain('sessionAttributionConflict');
  }finally{h.close();fs.rmSync(root,{recursive:true,force:true});}
});
