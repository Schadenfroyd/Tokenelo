import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect,it} from 'vitest';
import {CodexCollector,CodexRolloutParser} from '../../src/collectors/codex.js';
import {isUnownedCodexContextState} from '../../src/core/codex-context-recovery.js';
import {makeHarness,baseTestConfig} from '../claude/helpers.js';
import {Rollout} from './helpers.js';

const SESSION_ID='01a0819d-cfe2-7ef0-8f65-12c21ee505e1';
const countFields={
  input_tokens:0,
  cached_input_tokens:0,
  cache_write_input_tokens:0,
  output_tokens:0,
  reasoning_output_tokens:0,
  total_tokens:0,
};

function native(patch:Record<string,unknown>={}):Record<string,unknown>{
  return {...countFields,...patch};
}

function sourceLine(type:string,payload:unknown,includePayload=true):string{
  return JSON.stringify({timestamp:'2026-09-01T12:00:00.000Z',ordinal:0,type,...(includePayload?{payload}:{})});
}

function countLine(total:unknown= native(),last:unknown= native()):string{
  return sourceLine('event_msg',{type:'token_count',info:{total_token_usage:total,last_token_usage:last},rate_limits:null});
}

function strictParser():CodexRolloutParser{
  return new CodexRolloutParser(undefined,{host:'test',fallbackSessionId:SESSION_ID,strictNativeCountFields:true});
}

function pushLine(parser:CodexRolloutParser,line:string):void{
  parser.pushLine(line);
}

it('strict recovery rejects missing or malformed native event envelopes and count objects',()=>{
  const malformedEventMessages=[
    sourceLine('event_msg',undefined,false),
    sourceLine('event_msg',null),
    sourceLine('event_msg',[]),
    sourceLine('event_msg','token_count'),
    sourceLine('event_msg',{type:'token_count'}),
    sourceLine('event_msg',{type:'token_count',info:null}),
    sourceLine('event_msg',{type:'token_count',info:[]}),
    sourceLine('event_msg',{type:'token_count',info:'counts'}),
    sourceLine('event_msg',{type:'token_count',info:{last_token_usage:native()}}),
    sourceLine('event_msg',{type:'token_count',info:{total_token_usage:native()}}),
    countLine(null,native()),
    countLine(native(),null),
    countLine([],native()),
    countLine(native(),[]),
    countLine('counts',native()),
    countLine(native(),'counts'),
    countLine({...countFields,input_tokens:'0'},native()),
    countLine(native(),{...countFields,output_tokens:null}),
  ];

  for(const malformed of malformedEventMessages){
    expect(()=>pushLine(strictParser(),malformed)).toThrow(/Codex context checkpoint/);
  }

  const malformedResponseRecords=[
    sourceLine('token_usage_record',undefined,false),
    sourceLine('token_usage_record',null),
    sourceLine('token_usage_record',[]),
    sourceLine('token_usage_record','record'),
    sourceLine('token_usage_record',{}),
    sourceLine('token_usage_record',{usage:null}),
    sourceLine('token_usage_record',{usage:[]}),
    sourceLine('token_usage_record',{usage:'counts'}),
    sourceLine('token_usage_record',{usage:native()}),
    sourceLine('token_usage_record',{response_id:' ',thread_id:SESSION_ID,usage:native()}),
    sourceLine('token_usage_record',{response_id:'response',thread_id:'unknown-owner',usage:native()}),
    sourceLine('token_usage_record',{usage:{...countFields,total_tokens:1}}),
  ];
  for(const malformed of malformedResponseRecords){
    expect(()=>pushLine(strictParser(),malformed)).toThrow(/Codex context checkpoint/);
  }
});

it('strict recovery can identify a well-formed foreign-thread response without claiming its tokens',()=>{
  const parser=strictParser();
  for(const line of new Rollout().meta({id:SESSION_ID}).lines) pushLine(parser,line);
  pushLine(parser,sourceLine('token_usage_record',{
    response_id:'parent-response',thread_id:'01a0819d-cfe2-7ef0-8f65-12c21ee505e2',
    usage:native({input_tokens:100,output_tokens:10,total_tokens:110}),
  }));
  expect(parser.takeUsage()).toEqual([]);expect(parser.takeMarks()).toEqual([]);
  expect(parser.snapshotState().summary.recordsForeignThread).toBe(1);
  expect(isUnownedCodexContextState(parser.snapshotState(),SESSION_ID)).toBe(true);
});

it('strict recovery treats a case-variant UUID as its own response and refuses an unowned-context claim',()=>{
  const parser=strictParser();
  for(const line of new Rollout().meta({id:SESSION_ID}).lines) pushLine(parser,line);
  pushLine(parser,sourceLine('token_usage_record',{
    response_id:'own-case-variant',thread_id:SESSION_ID.toUpperCase(),
    usage:native({input_tokens:10,output_tokens:1,total_tokens:11}),
  }));
  const state=parser.snapshotState();
  expect(state.hasRecords).toBe(true);expect(state.pending).toHaveLength(1);
  expect(state.summary.records).toBe(1);expect(state.summary.recordsForeignThread).toBe(0);
  expect(isUnownedCodexContextState(state,SESSION_ID)).toBe(false);
});

it('strict recovery parses ignored records fully and holds unsupported schemas instead of inventing a zero baseline',()=>{
  const malformedOrUnsupported = [
    sourceLine('compacted',{}) + ' invalid trailing bytes',
    sourceLine('token_count_v2',{usage:native({input_tokens:10,total_tokens:10})}),
    sourceLine('event_msg',{type:'token_count_v2',info:{total_token_usage:native({input_tokens:10,total_tokens:10})}}),
    sourceLine('response_item',null),
    JSON.stringify(['unrecognized native envelope']),
  ];
  for(const line of malformedOrUnsupported) expect(()=>pushLine(strictParser(),line)).toThrow();
  expect(()=>pushLine(strictParser(),sourceLine('compacted',{}))).not.toThrow();
  expect(()=>pushLine(new CodexRolloutParser(undefined,{host:'test'}),malformedOrUnsupported[0]!)).not.toThrow();
});

it('strict recovery rejects incoherent subsets, unsupported cache writes, totals, and unsafe arithmetic',()=>{
  const malformedCounts=[
    countLine(native({input_tokens:4,cached_input_tokens:5,output_tokens:2,total_tokens:6}),native()),
    countLine(native(),native({output_tokens:2,reasoning_output_tokens:3,total_tokens:2})),
    countLine(native({input_tokens:4,output_tokens:2,total_tokens:5}),native()),
    countLine(native({input_tokens:4,cache_write_input_tokens:1,total_tokens:4}),native()),
    countLine(native({input_tokens:Number.MAX_SAFE_INTEGER,output_tokens:1,total_tokens:Number.MAX_SAFE_INTEGER}),native()),
    countLine(native({input_tokens:-1,total_tokens:-1}),native()),
    countLine(native({input_tokens:Number.MAX_SAFE_INTEGER+1,total_tokens:Number.MAX_SAFE_INTEGER+1}),native()),
    sourceLine('token_usage_record',{response_id:'resp_bad',usage:native({input_tokens:4,output_tokens:2,total_tokens:5})}),
  ];

  for(const malformed of malformedCounts){
    expect(()=>pushLine(strictParser(),malformed)).toThrow(/Codex context checkpoint/);
  }
});

it('strict recovery accepts coherent real-zero and inherited context-only snapshots',()=>{
  const cases=[
    new Rollout().meta({id:SESSION_ID}).tokenCount([0,0,0,0,0,0],[0,0,0,0,0,0]),
    new Rollout().meta({id:SESSION_ID}).tokenCount([100,90,10,5,0,110],[12,10,2,1,0,14]),
  ];

  for(const rollout of cases){
    const parser=strictParser();
    for(const line of rollout.lines) pushLine(parser,line);
    expect(parser.takeUsage()).toEqual([]);
    expect(parser.takeMarks()).toEqual([]);
    expect(isUnownedCodexContextState(parser.snapshotState(),SESSION_ID)).toBe(true);
  }
});

it('strict recovery preserves the documented imported total-only token_count form',()=>{
  const rollout=new Rollout().meta({id:SESSION_ID}).marker()
    .tokenCount([0,0,0,0,0,21388],[0,0,0,0,0,21388]);
  const parser=strictParser();
  for(const line of rollout.lines) pushLine(parser,line);
  expect(parser.takeUsage()).toEqual([]);
  expect(parser.snapshotState().summary.ownTotalDerived).toBe(0);
  expect(isUnownedCodexContextState(parser.snapshotState(),SESSION_ID)).toBe(true);

  const unmarked=strictParser();
  expect(()=>pushLine(unmarked,countLine(
    native({total_tokens:21388}),native({total_tokens:21388}),
  ))).toThrow(/Codex context checkpoint/);
});

it('ordinary parsing still accepts a rate-limit-only token_count without a native baseline',()=>{
  const payload={type:'token_count',rate_limits:{limit_id:'codex',primary:{used_percent:1,window_minutes:60,resets_at:1790000000}}};
  const parser=new CodexRolloutParser(undefined,{host:'test',fallbackSessionId:SESSION_ID});
  expect(()=>pushLine(parser,sourceLine('token_usage_record',null))).not.toThrow();
  expect(()=>pushLine(parser,sourceLine('event_msg',payload))).not.toThrow();
  expect(()=>pushLine(new CodexRolloutParser(undefined,{host:'test',fallbackSessionId:SESSION_ID}),
    countLine(native({input_tokens:4,cache_write_input_tokens:1,total_tokens:4}),native()))).not.toThrow();
  const state=parser.snapshotState();
  expect(state.summary.tokenCountEvents).toBe(0);
  expect(state.limitsById?.codex).toBeDefined();
  expect(parser.takeUsage()).toEqual([]);

  expect(()=>pushLine(strictParser(),sourceLine('event_msg',payload))).toThrow(/Codex context checkpoint/);
});

it('valid unowned context replacement still recovers its checkpoint without accounting writes',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-coherent-recovery-'));
  const harness=makeHarness({...baseTestConfig(),codex:{homes:[home]}});
  const file=path.join(home,'sessions',`rollout-2026-09-08T15-23-05-${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const scan=()=>new CodexCollector({homes:[home],now:()=>Date.now()+2*60*60*1000}).scan(harness.ctx);
  try{
    fs.writeFileSync(file,new Rollout().meta({id:SESSION_ID})
      .tokenCount([100,90,10,5,0,110],[12,10,2,1,0,14]).text());
    const first=await scan();
    expect(first.filesSkipped).toBe(0);
    const prior=harness.ledger.getState(file)!;
    expect(isUnownedCodexContextState(prior.extra,SESSION_ID)).toBe(true);

    const replacement=file+'.replacement';
    fs.writeFileSync(replacement,new Rollout().meta({id:SESSION_ID})
      .tokenCount([200,180,20,8,0,220],[20,18,2,1,0,22]).text());
    fs.unlinkSync(file);
    fs.renameSync(replacement,file);

    const recovered=await scan();
    const next=harness.ledger.getState(file)!;
    expect(recovered.filesSkipped).toBe(0);
    expect(harness.logs.some(entry=>entry.msg.includes('context-only checkpoint recovered'))).toBe(true);
    expect((next.extra as {contextCheckpointReceiptId?:string}).contextCheckpointReceiptId).toEqual(expect.any(String));
    expect(next.offset).toBe(fs.statSync(file).size);
    expect(harness.ledger.getEvents({})).toEqual([]);
    expect(harness.db.prepare('SELECT COUNT(*) AS n FROM activity').get()).toEqual({n:0});
  }finally{
    harness.close();
    if(path.dirname(path.resolve(home))!==path.resolve(os.tmpdir())) throw new Error('fixture escaped owned temp directory');
    fs.rmSync(home,{recursive:true,force:true});
  }
});
