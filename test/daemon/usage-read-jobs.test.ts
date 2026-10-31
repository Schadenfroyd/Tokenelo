import { afterEach, describe, expect, it } from 'vitest';
import { RangeReadJobs, RangeJobCapacityError } from '../../src/daemon/range-read-jobs.js';
let jobs:RangeReadJobs<unknown>|undefined;
afterEach(async()=>{await jobs?.close();jobs=undefined;});
const turn=()=>new Promise<void>(ok=>setImmediate(ok));
describe('shared historical Summary and Usage admission',()=>{
  it('separates route leases and results while sharing one active computation',async()=>{
    const calls:string[]=[];let finish!:(value:unknown)=>void;
    jobs=new RangeReadJobs(async(range,control,variant)=>{
      calls.push(`${variant??'default'}:${range}`);
      return new Promise((ok,no)=>{finish=ok;control.signal!.addEventListener('abort',()=>no(control.signal!.reason),{once:true});});
    },45000);
    const a=jobs.admit('all','a');const b=jobs.admit('all','b','usage');
    expect(a.id).not.toBe(b.id);expect(a.budgetMs).toBe(45000);expect(b.budgetMs).toBe(45000);
    expect(()=>jobs!.admit('all','a','usage')).toThrow(RangeJobCapacityError);
    expect(jobs.poll(a.id,'a','usage')).toBeUndefined();expect(jobs.poll(b.id,'b')).toBeUndefined();
    jobs.release('a','usage');expect(jobs.poll(a.id,'a')).toBeDefined();
    await turn();expect(calls).toEqual(['default:all']);expect(jobs.poll(b.id,'b','usage')?.status).toBe('queued');
    finish({summary:'old'});await turn();expect(calls).toEqual(['default:all','usage:all']);
    expect(jobs.poll(a.id,'a')?.result).toEqual({summary:'old'});
    finish({pair:'cohort'});await turn();expect(jobs.poll(b.id,'b','usage')?.result).toEqual({pair:'cohort'});
    jobs.release('b');expect(jobs.poll(b.id,'b','usage')).toBeDefined();
    jobs.release('b','usage');expect(jobs.poll(b.id,'b','usage')).toBeUndefined();
  });
  it('does not add a second queue or subscriber pool for Usage',async()=>{
    jobs=new RangeReadJobs(async(_r,c)=>new Promise((_ok,no)=>c.signal!.addEventListener('abort',()=>no(c.signal!.reason),{once:true})),45000);
    const a=jobs.admit('all','a');await turn();
    const b=jobs.admit('all','b','usage');jobs.admit('7d','c');
    expect(()=>jobs!.admit('30d','d','usage')).toThrow(RangeJobCapacityError);
    for(let n=1;n<8;n++)jobs.admit('all','a'+n);
    expect(()=>jobs!.admit('all','a8')).toThrow(RangeJobCapacityError);
    for(let n=1;n<8;n++)jobs.admit('all','b'+n,'usage');
    expect(()=>jobs!.admit('all','b8','usage')).toThrow(RangeJobCapacityError);
    expect(jobs.poll(a.id,'a')?.status).toBe('running');expect(jobs.poll(b.id,'b','usage')?.status).toBe('queued');
  });
});
