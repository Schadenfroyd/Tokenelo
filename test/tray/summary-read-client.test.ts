import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiClient, SummaryReadRetiredError, LOCAL_REQUEST_TIMEOUT_MS, DaemonTimeoutError } from '../../src/tray/api-client.js';
import { recordReads } from '../../src/tray/snapshot-data.js';
import { failureMessage, isSummaryCancelled } from '../../src/tray/renderer/request-failure.js';
const token='owned-summary-token',id='a'.repeat(32);
let root:string,tokenFile:string;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-summary-client-'));tokenFile=path.join(root,'token');fs.writeFileSync(tokenFile,token);});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
const exact={host:'H',range:'all',generatedAt:34,timeBasis:{startMs:null,asOfMs:34,endInclusive:true,timestampBasis:'recorded-timestamps',excludedFutureEvents:0,excludedFutureActivity:0},totals:{events:1,tokens:{inputFresh:3,cacheRead:9,cacheWrite5m:0,cacheWrite1h:0,output:5,reasoning:2,countQuality:'unrecorded'},apiEquivUsd:0,unpricedEvents:1},bySource:{},byModel:[]};
const json=(v:unknown)=>new Response(JSON.stringify(v));
function transport(
  handler:(url:URL,init?:RequestInit)=>Response|Promise<Response>,
  onRequest?:(url:URL,init?:RequestInit)=>void,
):typeof fetch {
  return(async(input:string|URL|Request,init?:RequestInit)=>{
    const u=new URL(String(input));
    onRequest?.(u,init);
    if(u.pathname==='/v1/hello'){expect(new Headers(init?.headers).has('Authorization')).toBe(false);return json({proof:crypto.createHmac('sha256',token).update(u.searchParams.get('nonce')!).digest('hex')});}
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+token);
    return handler(u,init);
  })as typeof fetch;
}


describe('explicit historical Summary client',()=>{
  it('preserves every result field and server cutoff through progress and lease release',async()=>{
    let polls=0,lease='',released=false;const phases:unknown[]=[];
    const client=createApiClient({tokenFile,fetchImpl:transport((u,init)=>{
      if(u.pathname==='/v1/health')return json({capabilities:{summaryReadJobs:1}});
      if(init?.method==='POST'){expect(u.pathname).toBe('/v1/summary/read');expect(u.searchParams.get('range')).toBe('all');lease=new Headers(init.headers).get('X-Tokenelo-Read-Lease')!;return json({id});}
      if(init?.method==='DELETE'){expect(u.pathname.endsWith(lease)).toBe(true);released=true;return json({released:true});}
      expect(u.searchParams.get('lease')).toBe(lease);return json(++polls===1?{id,range:'all',status:'running',phase:'reading-activity'}:{id,range:'all',status:'completed',result:exact});
    })});
    expect(await client.getSummaryReport('all',{onProgress:p=>phases.push(p)})).toEqual(exact);expect(phases).toEqual([{status:'running',phase:'reading-activity'}]);expect(released).toBe(true);expect(LOCAL_REQUEST_TIMEOUT_MS).toBe(20_000);
  });
  it('waits for client cancellation lease release after a fresh identity proof before every bearer request',async()=>{
    let released=false,lease='';
    const calls:string[]=[],controller=new AbortController(),reason=new SummaryReadRetiredError();
    const {client,record}=recordReads(createApiClient({tokenFile,fetchImpl:transport((u,init)=>{
      if(u.pathname==='/v1/health')return json({capabilities:{summaryReadJobs:1}});
      if(init?.method==='POST'){lease=new Headers(init.headers).get('X-Tokenelo-Read-Lease')!;return json({id});}
      if(init?.method==='DELETE'){
        expect(u.pathname).toBe('/v1/summary/read/lease/'+lease);
        expect(init.signal?.aborted).toBe(false);
        released=true;
        return json({released:true});
      }
      return json({id,range:'all',status:'running'});
    },u=>calls.push(u.pathname))}),47821);
    await expect(client.getSummaryReport('all',{signal:controller.signal,onProgress:()=>controller.abort(reason)})).rejects.toBe(reason);
    expect(released).toBe(true);
    expect(calls).toEqual(['/v1/hello','/v1/health','/v1/hello','/v1/summary/read','/v1/hello','/v1/summary/read/'+id,'/v1/hello','/v1/summary/read/lease/'+lease]);
    // retired is client-side cancellation accounting, not a server worker-exit receipt.
    expect(record).toMatchObject({reads:0,started:1,pending:0,retired:1,failure:null});
    const ipc=new Error("Error invoking remote method 'tokenelo:getSummary': SummaryReadRetiredError: "+reason.message);
    expect(isSummaryCancelled(ipc)).toBe(true);
    expect(failureMessage(ipc)).toContain('cancelled');
  });


  it('keeps older daemon and short-period reads on the ordinary endpoint',async()=>{
    const paths:string[]=[];const client=createApiClient({tokenFile,fetchImpl:transport((u)=>{paths.push(u.pathname);return json(u.pathname==='/v1/health'?{status:'ok'}:exact);})});
    expect(await client.getSummaryReport('all')).toEqual(exact);expect(paths).toEqual(['/v1/health','/v1/summary']);paths.length=0;await client.getSummaryReport('7d');expect(paths).toEqual(['/v1/summary']);
  });
  for(const mismatch of [{id:'b'.repeat(32),range:'all',status:'completed',result:exact},{id,range:'7d',status:'completed',result:exact},{id,range:'all',status:'completed',result:{...exact,timeBasis:{...exact.timeBasis,asOfMs:35}}}]){
    it('rejects mismatched job, range or snapshot evidence and releases its lease',async()=>{
      let released=false;const client=createApiClient({tokenFile,fetchImpl:transport((u,init)=>u.pathname==='/v1/health'?json({capabilities:{summaryReadJobs:1}}):init?.method==='POST'?json({id}):init?.method==='DELETE'?(released=true,json({released:true})):json(mismatch))});
      await expect(client.getSummaryReport('all')).rejects.toThrow();expect(released).toBe(true);
    });
  }
  it('preserves an explicit job timeout as an error without zero-valued success',async()=>{
    const client=createApiClient({tokenFile,fetchImpl:transport((u,init)=>u.pathname==='/v1/health'?json({capabilities:{summaryReadJobs:1}}):init?.method==='POST'?json({id}):init?.method==='DELETE'?json({released:true}):json({id,range:'all',status:'failed',error:'read_timeout',budgetMs:45_000}))});
    await expect(client.getSummaryReport('all')).rejects.toBeInstanceOf(DaemonTimeoutError);
  });
  it('bounds a polling fetch that ignores abort and still releases the historical lease',async()=>{
    let released=false;const client=createApiClient({tokenFile,localTimeoutMs:25,fetchImpl:transport((u,init)=>{
      if(u.pathname==='/v1/health')return json({capabilities:{summaryReadJobs:1}});if(init?.method==='POST')return json({id});
      if(init?.method==='DELETE'){released=true;return json({released:true});}return new Promise<Response>(()=>{});
    })});
    await expect(client.getSummaryReport('all')).rejects.toBeInstanceOf(DaemonTimeoutError);expect(released).toBe(true);
  });
});

