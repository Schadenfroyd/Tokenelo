import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect,it} from 'vitest';
import {CodexCollector,CodexRolloutParser} from '../../src/collectors/codex.js';
import {isUnownedCodexContextState} from '../../src/core/codex-context-recovery.js';
import {makeHarness,baseTestConfig} from '../claude/helpers.js';
import {Rollout} from './helpers.js';

const SID='01a0819d-cfe2-7ef0-8f65-12c21ee505e1';
const FOREIGN='01a0819d-cfe2-7ef0-8f65-12c21ee505e2';
const OWN='01a0819d-d01b-75c1-993c-c0c752866014';
const IMPORT='external-import-turn-1';

function completion(itemType='AgentMessage'):Record<string,unknown>{
  return {
    timestamp:'2026-09-01T12:00:00.000Z',ordinal:3,type:'event_msg',
    payload:{type:'item_completed',thread_id:SID,turn_id:IMPORT,completed_at_ms:1788263990000,
      item:{type:itemType,id:'imported-message-1',content:itemType==='AgentMessage'
        ? [{type:'Text',text:'[synthetic context]'}]
        : [{type:'text',text:'[synthetic context]',text_elements:[]}]}},
  };
}

function parser(rollout=new Rollout().meta({id:SID,cli_version:'0.162.0-alpha.17.2'}).taskStarted(IMPORT)){
  const p=new CodexRolloutParser(undefined,{host:'test',fallbackSessionId:SID,strictNativeCountFields:true});
  for(const line of rollout.lines) p.pushLine(line);
  return p;
}

function payload(line:Record<string,unknown>):Record<string,unknown>{return line.payload as Record<string,unknown>;}
function item(line:Record<string,unknown>):Record<string,unknown>{return payload(line).item as Record<string,unknown>;}
function part(line:Record<string,unknown>):Record<string,unknown>{return (item(line).content as Array<Record<string,unknown>>)[0]!;}

it.each(['AgentMessage','UserMessage'])('strict recovery recognizes bound imported %s context without ownership or accounting changes',type=>{
  const p=parser();const before=p.snapshotState();const line=completion(type);
  // Completion history may predate the replay's task timestamp; it is not a new activity time.
  payload(line).thread_id=SID.toUpperCase();
  p.pushLine(JSON.stringify(line));
  expect(p.takeUsage()).toEqual([]);expect(p.takeMarks()).toEqual([]);
  const after=p.snapshotState();
  expect(after).toEqual({...before,lineIndex:before.lineIndex+1});
  expect(isUnownedCodexContextState(after,SID)).toBe(true);
});

const invalid:Array<[string,(line:Record<string,unknown>)=>void]>=[
  ['foreign thread',line=>{payload(line).thread_id=FOREIGN;}],
  ['malformed thread',line=>{payload(line).thread_id='not-a-thread';}],
  ['missing thread',line=>{delete payload(line).thread_id;}],
  ['different import turn',line=>{payload(line).turn_id='external-import-turn-2';}],
  ['own turn',line=>{payload(line).turn_id=OWN;}],
  ['missing turn',line=>{delete payload(line).turn_id;}],
  ['unsafe import ordinal',line=>{payload(line).turn_id='external-import-turn-9007199254740992';}],
  ['unknown payload field',line=>{payload(line).future_field={};}],
  ['hidden native usage',line=>{payload(line).token_usage={input_tokens:10};}],
  ['unknown top-level field',line=>{line.usage={total_tokens:1};}],
  ['unknown item',line=>{item(line).type='Reasoning';}],
  ['unknown item field',line=>{item(line).model='future-model';}],
  ['nested item usage',line=>{item(line).usage={input_tokens:1};}],
  ['missing item id',line=>{delete item(line).id;}],
  ['blank item id',line=>{item(line).id=' ';}],
  ['control item id',line=>{item(line).id='bad\u0000id';}],
  ['nonarray content',line=>{item(line).content={type:'Text',text:'[synthetic]'};}],
  ['malformed content part',line=>{item(line).content=[null];}],
  ['nontext content',line=>{part(line).text={usage:{total_tokens:1}};}],
  ['unknown text field',line=>{part(line).usage={total_tokens:1};}],
  ['wrong content discriminator',line=>{part(line).type='text';}],
  ['missing completion time',line=>{delete payload(line).completed_at_ms;}],
  ['fractional completion time',line=>{payload(line).completed_at_ms=0.5;}],
  ['negative completion time',line=>{payload(line).completed_at_ms=-1;}],
  ['unsafe completion time',line=>{payload(line).completed_at_ms=Number.MAX_SAFE_INTEGER+1;}],
  ['invalid start time',line=>{payload(line).started_at_ms='0';}],
  ['reversed item times',line=>{payload(line).started_at_ms=(payload(line).completed_at_ms as number)+1;}],
  ['invalid line timestamp',line=>{line.timestamp='invalid';}],
  ['numeric line timestamp',line=>{line.timestamp=1788264000000;}],
  ['missing record ordinal',line=>{delete line.ordinal;}],
  ['unsafe record ordinal',line=>{line.ordinal=Number.MAX_SAFE_INTEGER+1;}],
];

it.each(invalid)('strict recovery holds %s on an item completion',(_name,change)=>{
  const p=parser();const line=completion();change(line);
  expect(()=>p.pushLine(JSON.stringify(line))).toThrow(/Codex context checkpoint/);
  expect(p.takeUsage()).toEqual([]);expect(p.takeMarks()).toEqual([]);
});

it('strict recovery holds unknown user text annotations and mixed message schemas',()=>{
  for(const change of [
    (line:Record<string,unknown>)=>{part(line).text_elements=[{usage:{total_tokens:1}}];},
    (line:Record<string,unknown>)=>{delete part(line).text_elements;},
    (line:Record<string,unknown>)=>{part(line).type='Text';},
  ]){
    const line=completion('UserMessage');change(line);
    expect(()=>parser().pushLine(JSON.stringify(line))).toThrow(/Codex context checkpoint/);
  }
});

it('strict recovery requires an active import task opened after metadata, not a marker, turn_context or closed task',()=>{
  for(const rollout of [
    new Rollout().meta({id:SID}).marker(),
    new Rollout().meta({id:SID}).turnContextFlat(IMPORT,'gpt-6','low').marker(),
    new Rollout().taskStarted(IMPORT).meta({id:SID}),
    new Rollout().meta({id:SID}).taskStarted(IMPORT).taskComplete(IMPORT),
    new Rollout().meta({id:SID}).taskStarted(IMPORT).turnAborted(IMPORT),
    new Rollout().meta({id:SID}).taskStarted(IMPORT).taskStarted('rollout-1'),
  ]) expect(()=>parser(rollout).pushLine(JSON.stringify(completion()))).toThrow(/Codex context checkpoint/);
});

it('strict recovery holds own work even when an import task is later active',()=>{
  const p=parser(new Rollout().meta({id:SID}).taskStarted(OWN).assistant().taskComplete(OWN).taskStarted(IMPORT));
  p.takeMarks();
  expect(()=>p.pushLine(JSON.stringify(completion()))).toThrow(/Codex context checkpoint/);
  expect(p.state.ownTurnStarted).toBe(true);expect(p.state.ownTurnSeen).toBe(true);
});

it('strict recovery binds the first metadata and filename session rather than a later copied header',()=>{
  for(const rollout of [
    new Rollout().meta({id:FOREIGN}).taskStarted(IMPORT),
    new Rollout().meta({id:FOREIGN}).meta({id:SID}).taskStarted(IMPORT),
    new Rollout().taskStarted(IMPORT),
  ]) expect(()=>parser(rollout).pushLine(JSON.stringify(completion()))).toThrow(/Codex context checkpoint/);
});

it('ordinary parsing keeps ignoring unsupported completions without claiming model output',()=>{
  const p=new CodexRolloutParser(undefined,{host:'test',fallbackSessionId:SID});
  for(const line of new Rollout().meta({id:SID}).taskStarted(OWN).lines) p.pushLine(line);
  p.takeMarks();const before=p.snapshotState();const line=completion();payload(line).usage={total_tokens:123};
  p.pushLine(JSON.stringify(line));
  expect(p.snapshotState()).toEqual({...before,lineIndex:before.lineIndex+1});
  expect(p.state.ownTurnSeen).toBe(false);expect(p.takeUsage()).toEqual([]);expect(p.takeMarks()).toEqual([]);
});

it('recovers a replaced import context through the collector without writing events or activity',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-import-completion-'));
  const h=makeHarness({...baseTestConfig(),codex:{homes:[home]}});
  const file=path.join(home,'sessions',`rollout-2026-09-08T15-23-05-${SID}.jsonl`);
  const scan=()=>new CodexCollector({homes:[home],now:()=>Date.now()+2*3600000}).scan(h.ctx);
  try{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,new Rollout().meta({id:SID}).text());await scan();
    const rollout=new Rollout().meta({id:SID,cli_version:'0.162.0-alpha.17.2'}).taskStarted(IMPORT).assistant();
    const completed=JSON.stringify(completion());
    rollout.taskComplete(IMPORT).tokenCount([0,0,0,0,0,100],[0,0,0,0,0,100]);
    const lines=[...rollout.lines.slice(0,3),completed,...rollout.lines.slice(3)];
    const replacement=file+'.replacement';fs.writeFileSync(replacement,lines.join('\n')+'\n');
    fs.unlinkSync(file);fs.renameSync(replacement,file);
    const result=await scan();
    expect(result.filesSkipped).toBe(0);expect(result.eventsEmitted).toBe(0);
    expect(h.ledger.getEvents({})).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM activity').get()).toEqual({n:0});
    expect((h.ledger.getState(file)!.extra as {contextCheckpointReceiptId?:string}).contextCheckpointReceiptId).toEqual(expect.any(String));
  }finally{
    h.close();
    if(path.dirname(path.resolve(home))!==path.resolve(os.tmpdir())) throw new Error('fixture escaped owned temp directory');
    fs.rmSync(home,{recursive:true,force:true});
  }
});
