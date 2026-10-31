import {beforeEach,afterEach,describe,it,expect} from 'vitest';
import crypto from 'node:crypto';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createApiClient,SummaryReadRetiredError,LOCAL_REQUEST_TIMEOUT_MS} from '../../src/tray/api-client.js';
import {recordReads} from '../../src/tray/snapshot-data.js';
const token='owned-usage-token',id='a'.repeat(32);let root:string,tokenFile:string;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-client-'));tokenFile=path.join(root,'token');fs.writeFileSync(tokenFile,token);});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
const basis={startMs:null,asOfMs:34,endInclusive:true,timestampBasis:'recorded-timestamps',excludedFutureEvents:0,excludedFutureActivity:0};
function pair(range='all') {return {snapshotScope:'shared-read-transaction',summary:{host:'H',range,generatedAt:34,timeBasis:basis,totals:{events:1,tokens:{inputFresh:3,cacheRead:9,output:5,countQuality:'unrecorded'},apiEquivUsd:0,unpricedEvents:1},byModel:[],bySource:{}},timeseries:{range,bucket:['today','24h'].includes(range)?'hour':'day',generatedAt:34,timeBasis:{...basis},points:[]}};}
const json=(v:unknown)=>new Response(JSON.stringify(v));
function transport(
  handler:(u:URL,i?:RequestInit)=>Response|Promise<Response>,
  onRequest?:(u:URL,i?:RequestInit)=>void,
):typeof fetch{
  return(async(input:string|URL|Request,i?:RequestInit)=>{
    const u=new URL(String(input));
    onRequest?.(u,i);
    if(u.pathname==='/v1/hello'){expect(new Headers(i?.headers).has('Authorization')).toBe(false);return json({proof:crypto.createHmac('sha256',token).update(u.searchParams.get('nonce')!).digest('hex')});}
    expect(new Headers(i?.headers).get('Authorization')).toBe('Bearer '+token);
    return handler(u,i);
  })as typeof fetch;
}


describe('unified Usage client evidence',()=>{
  for(const range of ['today','24h','7d','30d']as const)it(`reads ${range} once and preserves count and price qualifications`,async()=>{
    const paths:string[]=[];const exact=pair(range);const client=createApiClient({tokenFile,fetchImpl:transport(u=>{paths.push(u.pathname+u.search);return json(exact);})});
    expect(await client.getUsage(range)).toEqual(exact);expect(paths).toEqual(['/v1/usage?range='+range]);expect(LOCAL_REQUEST_TIMEOUT_MS).toBe(20000);
  });
  it('does not infer different snapshots from equivalent property ordering',async()=>{
    const exact=pair('7d');exact.timeseries.timeBasis=Object.fromEntries(Object.entries(basis).reverse())as typeof basis;
    expect(await createApiClient({tokenFile,fetchImpl:transport(()=>json(exact))}).getUsage('7d')).toEqual(exact);
  });
  for(const corrupt of ['scope','clock','range','bucket','basis']as const)it(`rejects mixed ${corrupt} evidence`,async()=>{
    const v=pair('7d');if(corrupt==='scope')v.snapshotScope='filed-fixture';if(corrupt==='clock')v.timeseries.generatedAt=35;if(corrupt==='range')v.timeseries.range='all';if(corrupt==='bucket')v.timeseries.bucket='hour';if(corrupt==='basis')v.timeseries.timeBasis.excludedFutureEvents=1;
    await expect(createApiClient({tokenFile,fetchImpl:transport(()=>json(v))}).getUsage('7d')).rejects.toThrow('invalid unified Usage report');
  });
  it('refuses an older daemon without reconstructing independent responses',async()=>{
    const paths:string[]=[];const client=createApiClient({tokenFile,fetchImpl:transport(u=>{paths.push(u.pathname);return json({status:'ok'});})});
    await expect(client.getUsage('all')).rejects.toThrow('Update the daemon and tray together');expect(paths).toEqual(['/v1/health']);
  });
  it('preserves the historical pair and releases its exact lease',async()=>{
    const exact=pair();let lease='',released=false;const client=createApiClient({tokenFile,fetchImpl:transport((u,i)=>{
      if(u.pathname==='/v1/health')return json({capabilities:{usageReadJobs:1}});
      if(i?.method==='POST'){expect(u.pathname).toBe('/v1/usage/read');lease=new Headers(i.headers).get('X-Tokenelo-Read-Lease')!;return json({id});}
      if(i?.method==='DELETE'){expect(u.pathname).toBe('/v1/usage/read/lease/'+lease);released=true;return json({released:true});}
      expect(u.searchParams.get('lease')).toBe(lease);return json({id,range:'all',status:'completed',result:exact});
    })});expect(await client.getUsage('all')).toEqual(exact);expect(released).toBe(true);
  });
  it('waits for client Usage cancellation lease release after a fresh identity proof before every bearer request',async()=>{
    let released=false,lease='';
    const calls:string[]=[],c=new AbortController(),reason=new SummaryReadRetiredError();
    const {client,record}=recordReads(createApiClient({tokenFile,fetchImpl:transport((u,i)=>{
      if(u.pathname==='/v1/health')return json({capabilities:{usageReadJobs:1}});
      if(i?.method==='POST'){lease=new Headers(i.headers).get('X-Tokenelo-Read-Lease')!;return json({id});}
      if(i?.method==='DELETE'){
        expect(u.pathname).toBe('/v1/usage/read/lease/'+lease);
        expect(i.signal?.aborted).toBe(false);
        released=true;
        return json({released:true});
      }
      return json({id,range:'all',status:'running'});
    },u=>calls.push(u.pathname))}),47821);
    await expect(client.getUsage('all',{signal:c.signal,onProgress:()=>c.abort(reason)})).rejects.toBe(reason);
    expect(released).toBe(true);
    expect(calls).toEqual(['/v1/hello','/v1/health','/v1/hello','/v1/usage/read','/v1/hello','/v1/usage/read/'+id,'/v1/hello','/v1/usage/read/lease/'+lease]);
    // retired is client-side cancellation accounting, not a server worker-exit receipt.
    expect(record).toMatchObject({reads:0,started:1,pending:0,retired:1,failure:null});
  });


});


describe('ordinary Usage cancellation and strict filed fixtures',()=>{
  for(const range of ['today','24h','7d','30d']as const)it(`retires ordinary ${range} without inventing a read failure`,async()=>{
    let started!:()=>void;const ready=new Promise<void>(ok=>{started=ok;}),c=new AbortController(),reason=new SummaryReadRetiredError();
    const {client,record}=recordReads(createApiClient({tokenFile,fetchImpl:transport((_u,i)=>new Promise<Response>((_ok,no)=>{started();i!.signal!.addEventListener('abort',()=>no(i!.signal!.reason),{once:true});}))}),47821);
    const pending=client.getUsage(range,{signal:c.signal});void pending.catch(()=>{});await ready;c.abort(reason);
    await expect(pending).rejects.toBe(reason);expect(record).toMatchObject({started:1,pending:0,retired:1,reads:0,failure:null});
  });
  for(const range of ['today','24h','7d','30d','all']as const)it(`reads strict ${range} fixtures without claiming a live transaction`,async()=>{
    const v=pair(range);fs.writeFileSync(path.join(root,`summary-${range}.json`),JSON.stringify(v.summary));fs.writeFileSync(path.join(root,`timeseries-${range}.json`),JSON.stringify(v.timeseries));
    const client=createApiClient({mockDir:root,strictMockRanges:true,tokenFile:path.join(root,'missing-token'),fetchImpl:(()=>{throw new Error('fixture must never use network');})as typeof fetch});
    expect(await client.getUsage(range)).toEqual({...v,snapshotScope:'filed-fixture'});
  });
  it('does not fabricate a requested-range fixture from Today in strict mode',async()=>{
    const v=pair('today');fs.writeFileSync(path.join(root,'summary-today.json'),JSON.stringify(v.summary));fs.writeFileSync(path.join(root,'timeseries-today.json'),JSON.stringify(v.timeseries));
    await expect(createApiClient({mockDir:root,strictMockRanges:true}).getUsage('7d')).rejects.toThrow();
  });
});

