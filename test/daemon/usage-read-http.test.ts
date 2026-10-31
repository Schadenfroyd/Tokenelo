import http from 'node:http';import {afterEach,describe,it,expect}from 'vitest';
import {createHttpServer,closeHttpReads,type CreateHttpServerOpts}from '../../src/daemon/http.js';
import type {Queries}from '../../src/store/queries.js';import type{UsageResponse,SummaryResponse}from '../../src/core/types.js';
let server:http.Server|undefined;const lease='a'.repeat(32),headers={Authorization:'Bearer owned-token','X-Tokenelo-Read-Lease':lease};
afterEach(async()=>{if(server){await closeHttpReads(server);await new Promise<void>(ok=>server!.close(()=>ok()));server=undefined;}});
async function start(queries:Partial<Queries>){const opts:CreateHttpServerOpts={port:0,token:'owned-token',host:'H',queries:queries as Queries};server=createHttpServer(opts);await new Promise<void>(ok=>server!.listen(0,'127.0.0.1',ok));opts.port=(server.address()as import('node:net').AddressInfo).port;return 'http://127.0.0.1:'+opts.port;}
describe('Usage HTTP boundary',()=>{
  it('passes all five periods to the unified query and rejects invalid periods and methods',async()=>{
    const calls:string[]=[];const base=await start({getUsage:async range=>{calls.push(range);return {range}as unknown as UsageResponse;}});
    for(const r of ['today','24h','7d','30d','all'])expect(await(await fetch(base+'/v1/usage?range='+r,{headers})).json()).toEqual({range:r});
    expect((await fetch(base+'/v1/usage?range=bad',{headers})).status).toBe(400);expect((await fetch(base+'/v1/usage?range=all',{method:'POST',headers})).status).toBe(405);expect(calls).toEqual(['today','24h','7d','30d','all']);
  });
  it('guards authentication, origin, host, admission body and range before work',async()=>{
    let calls=0;const read=async()=>{calls++;return {}as UsageResponse;};const base=await start({getUsage:read,getUsageReport:read});
    for(const [method,p]of [['GET','/v1/usage?range=7d'],['POST','/v1/usage/read?range=all'],['DELETE','/v1/usage/read/lease/'+lease]]){
      expect((await fetch(base+p,{method})).status).toBe(401);expect((await fetch(base+p,{method,headers:{...headers,Origin:base}})).status).toBe(403);
      const status=await new Promise<number>((ok,no)=>{const req=http.request(base+p,{method,headers:{...headers,Host:'bad.example'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode!));});req.on('error',no);req.end();});expect(status).toBe(403);
    }expect((await fetch(base+'/v1/usage/read?range=7d',{method:'POST',headers})).status).toBe(400);expect((await fetch(base+'/v1/usage/read?range=all',{method:'POST',headers,body:'{}'})).status).toBe(400);expect(calls).toBe(0);
  });
  it('cannot poll, release or transfer a Summary lease through Usage',async()=>{
    let finish!:(v:SummaryResponse)=>void;const base=await start({getSummaryReport:async(_r,c)=>new Promise<SummaryResponse>((ok,no)=>{finish=ok;c!.signal!.addEventListener('abort',()=>no(c!.signal!.reason),{once:true});}),getUsageReport:async()=>({}as UsageResponse)});
    const a=await(await fetch(base+'/v1/summary/read?range=all',{method:'POST',headers})).json();
    expect((await fetch(base+'/v1/usage/read?range=all',{method:'POST',headers})).status).toBe(429);
    expect((await fetch(base+'/v1/usage/read/'+a.id+'?lease='+lease,{headers})).status).toBe(404);
    await fetch(base+'/v1/usage/read/lease/'+lease,{method:'DELETE',headers});
    finish({range:'all'}as SummaryResponse);await new Promise<void>(ok=>setImmediate(ok));
    expect((await(await fetch(base+'/v1/summary/read/'+a.id+'?lease='+lease,{headers})).json()).status).toBe('completed');
  });
});


it('keeps historical Summary unavailable when only the Usage service exists',async()=>{
  let ordinaryCalls=0;const base=await start({getUsageReport:async()=>({}as UsageResponse),getSummary:async()=>{ordinaryCalls++;return {}as SummaryResponse;}});
  expect((await(await fetch(base+'/v1/health',{headers})).json()).capabilities.summaryReadJobs).toBeUndefined();
  for(const [method,p]of [['POST','/v1/summary/read?range=all'],['GET','/v1/summary/read/'+'b'.repeat(32)+'?lease='+lease],['DELETE','/v1/summary/read/lease/'+lease]])expect((await fetch(base+p,{method,headers})).status).toBe(404);
  expect(ordinaryCalls).toBe(0);
});
