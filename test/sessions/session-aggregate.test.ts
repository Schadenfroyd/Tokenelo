import { describe, it, expect } from 'vitest';
import { ZERO_TOKENS, type UsageEvent, type ActivityMark } from '../../src/core/types.js';
import { SessionAncestryAccumulator, SessionEventAggregate } from '../../src/core/session-aggregate.js';
import { buildSessions } from '../../src/core/sessions.js';
import { drainSteps } from '../../src/core/event-loop.js';
const opts = { idleGapMs: 300, now: () => 1000000 };
const e = (v: Partial<UsageEvent> = {}): UsageEvent => ({ id:'event',host:'M4a',source:'claude',ts:100,tsSource:'line',sessionId:'s',isSubagent:false,
  model:'shared-model',provider:'anthropic',components:[],tokens:{...ZERO_TOKENS},flags:[],
  apiEquivUsd:0,priceStatus:'LIST',priceVersion:'v1',reservedValue:0,ucuRateStatus:'MEASURED',eacsDefSha256:'current',...v });
const m = (v: Partial<ActivityMark> = {}): ActivityMark => ({ host:'M4a',source:'claude',sessionId:'s',ts:100,...v });
function compare(name: string, events: UsageEvent[], marks: ActivityMark[] = []) {
  it(name, () => {
    const ancestry = new SessionAncestryAccumulator(); for (const event of events) ancestry.add(event);
    const aggregate = new SessionEventAggregate(ancestry.finish(), { asOf: opts.now(), idleGapMs: opts.idleGapMs });
    for (const event of events) aggregate.addEvent(event);
    expect(drainSteps(aggregate.buildSteps(marks))).toEqual(buildSessions(marks, events, opts));
  });
}
describe('fixed-clock Sessions aggregate preserves canonical fields and order', () => {
compare('empty',[]);
compare('all unpriced is unknown not zero',[e({apiEquivUsd:null,priceStatus:'UNPRICED',reservedValue:null,ucuRateStatus:'NONE'})]);
compare('mixed partial and conflicting stored prices',[e({apiEquivUsd:.1}),e({apiEquivUsd:null,priceStatus:'UNPRICED'}),e({apiEquivUsd:.2,priceStatus:'UNPRICED'}),e({apiEquivUsd:.3,priceStatus:'ESTIMATE'})]);
compare('recent boundary and exact float fold',[e({ts:100000,apiEquivUsd:.1}),e({ts:100001,apiEquivUsd:.2}),e({ts:1000000,apiEquivUsd:.3}),e({ts:1000001,apiEquivUsd:.4})]);
compare('ancestry last parent after earlier child',[e({sessionId:'child',isSubagent:true,parentSessionId:'first'}),e({sessionId:'grandchild',isSubagent:true,parentSessionId:'child'}),e({sessionId:'child',isSubagent:true,parentSessionId:'last',ts:500})]);
compare('cycle and incoming branch',[e({sessionId:'a',isSubagent:true,parentSessionId:'b'}),e({sessionId:'b',isSubagent:true,parentSessionId:'a'}),e({sessionId:'c',isSubagent:true,parentSessionId:'a'})]);
compare('same model cloud engines and absent engine',[e({provider:'local',engine:'ollama',flags:['thinkingUnknown','thinkingUnknown']}),e({provider:'local',engine:'vllm'}),e({provider:'local'}),e()]);
compare('models chronological tie and input stable order',[e({model:'a',ts:500}),e({model:'b',ts:100}),e({model:'a',ts:100})]);
compare('project parent precedence over children and activity',[e({sessionId:'c',isSubagent:true,parentSessionId:'s',project:'child',repoRoot:'childRepo'}),e({project:'parent',repoRoot:'parentRepo'})],[m({project:'mark'})]);
compare('activity only ambiguous attribution',[],[m({project:'a'}),m({ts:150,project:'b'}),m({sessionId:'other',ts:150,project:'c'})]);
compare('UUID earliest owner first ties UUID-free order',[],[m({sessionId:'copy',uuid:'dup',ts:200}),m({sessionId:'owner',uuid:'dup',ts:100}),m({sessionId:'tie',uuid:'dup',ts:100}),m({sessionId:'plain',ts:100})]);
compare('Codex durations exclude incidental gaps',[],[m({source:'codex',durationMs:200}),m({source:'codex',ts:150,durationMs:70}),m({source:'codex',ts:200})]);
compare('count-quality evidence weakest status',[e({tokens:{...ZERO_TOKENS,inputFresh:1,countQuality:'complete'},reservedValue:1}),e({tokens:{...ZERO_TOKENS,cacheWriteUnassigned:3,cacheWriteAssumed1h:4,countQuality:'conflict',ucuCountQuality:'complete'},reservedValue:null,ucuRateStatus:'NONE'})]);
for(let seed=0;seed<24;seed++) {
 const events=Array.from({length:60},(_,i)=>e({id:`${seed}-${i}`,host:i%2?'A2000':'M4a',source:i%3?'claude':'codex',sessionId:`s${i%9}`,ts:999000+(i%13)*10,
   isSubagent:i%4===0,parentSessionId:i%4===0?`s${(i+seed+1)%9}`:undefined,provider:i%3?'local':'anthropic',engine:i%4===0?'ollama':i%4===1?'vllm':undefined,
   model:`m${i%5}`,project:i%7===0?`p${i%2}`:undefined,repoRoot:i%9===0?'repo':undefined,flags:i%4?[]:['thinkingUnknown','thinkingUnknown'],
   tokens:{...ZERO_TOKENS,inputFresh:i,output:i%3,countQuality:i%11===0?'incomplete':'complete'},apiEquivUsd:i%7?.01*i:null,priceStatus:i%7?'ESTIMATE':'UNPRICED',
   reservedValue:i%7?i/13:null,ucuRateStatus:i%3?'PROVISIONAL-MEASURED':'NONE'}));
 const marks=Array.from({length:150},(_,i)=>m({host:i%2?'A2000':'M4a',source:i%3?'claude':'codex',sessionId:`s${i%11}`,ts:999000+Math.floor(i/3)*(seed+1),uuid:i%7?`u${i}`:`copy${i%14}`,durationMs:i%5?undefined:i/2,project:i%8?'scope':undefined}));
 compare('generated ancestry/evidence/ordering '+seed,events,marks);
}
});
