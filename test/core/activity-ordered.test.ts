import {describe,it,expect} from 'vitest';
import {ActivityGroupingIdentities,OrderedActivityGroupingIdentities,summedSessionActiveMsSteps,type ActivityGroupingEvent} from '../../src/core/activity-summary.js';
import {drainSteps} from '../../src/core/event-loop.js';
import type {ActivityMark} from '../../src/core/types.js';
interface Row {ts:number;rid:number;event:ActivityGroupingEvent}
const compare=(a:Row,b:Row)=>a.ts-b.ts||a.rid-b.rid;
function reference(rows:Row[]){const identities=new ActivityGroupingIdentities();for(const r of [...rows].sort(compare))identities.add(r.event);return identities.events();}
function ordered(rows:Row[]){const identities=new OrderedActivityGroupingIdentities();for(const r of rows)identities.add(r.event,r.ts,r.rid);return identities.events();}
describe('single-scan activity identities retain canonical time-order semantics',()=>{
 it('preserves final valid parent changes including a return to an earlier parent',()=>{
  const e=(parentSessionId?:string):ActivityGroupingEvent=>({host:'one',source:'claude',sessionId:'child',parentSessionId,isSubagent:!!parentSessionId});
  const rows:Row[]=[{rid:1,ts:20,event:e('B')},{rid:2,ts:10,event:e('A')},{rid:3,ts:30,event:e('A')},{rid:4,ts:40,event:e()}];
  expect(ordered(rows)).toEqual(reference(rows));expect(ordered(rows).at(-1)?.parentSessionId).toBe('A');
 });
 it('retains tied timestamps by rowid and scopes identical session IDs by host and collector',()=>{
  const rows:Row[]=[{ts:1,rid:4,event:{host:'one',source:'codex',sessionId:'child',isSubagent:true,parentSessionId:'C'}},{ts:1,rid:3,event:{host:'two',source:'claude',sessionId:'child',isSubagent:true,parentSessionId:'B'}},{ts:1,rid:2,event:{host:'one',source:'claude',sessionId:'child',isSubagent:true,parentSessionId:'A'}},{ts:1,rid:1,event:{host:'one',source:'claude',sessionId:'child',isSubagent:true,parentSessionId:'Z'}}];
  expect(ordered(rows)).toEqual(reference(rows));expect(ordered(rows).map(e=>e.parentSessionId)).toEqual(['Z','A','B','C']);
 });
 it('keeps an empty population empty',()=>expect(ordered([])).toEqual([]));
 it.each(Array.from({length:80},(_,i)=>i+1))('matches the independent old ordered stream and full timer for deterministic permutation %s',seed=>{
  let state=seed;const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
  const rows:Row[]=Array.from({length:600},(_,i)=>({rid:i+1,ts:rand()%30,event:{host:'host'+rand()%3,source:rand()%2?'claude':'codex',sessionId:'s'+rand()%23,isSubagent:rand()%2===1,parentSessionId:'s'+rand()%23}}));
  const marks:ActivityMark[]=rows.slice(0,160).map(r=>({host:r.event.host,source:r.event.source,sessionId:r.event.sessionId,ts:r.ts,uuid:'u'+r.rid%40,durationMs:r.rid%5}));
  const wanted=reference(rows),permutation=[...rows].sort((a,b)=>(a.rid*17%601)-(b.rid*17%601)),actual=ordered(permutation);
  expect(actual).toEqual(wanted);expect(drainSteps(summedSessionActiveMsSteps(marks,actual,150))).toBe(drainSteps(summedSessionActiveMsSteps(marks,wanted,150)));
 });
});
