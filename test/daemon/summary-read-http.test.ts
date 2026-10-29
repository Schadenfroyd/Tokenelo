import http from 'node:http';
import { afterEach, describe, it, expect } from 'vitest';
import { createHttpServer, closeHttpReads, type CreateHttpServerOpts } from '../../src/daemon/http.js';
import type { Queries } from '../../src/store/queries.js';
import type { SummaryResponse } from '../../src/core/types.js';
import { ReportReadError } from '../../src/daemon/report-read-protocol.js';
const lease='a'.repeat(32),headers={Authorization:'Bearer owned-token','X-Tokenelo-Read-Lease':lease};let server:http.Server|undefined;
afterEach(async()=>{if(server){await closeHttpReads(server);await new Promise<void>(ok=>server!.close(()=>ok()));server=undefined;}});
async function start(report?:Queries['getSummaryReport']){
  const opts:CreateHttpServerOpts={port:0,token:'owned-token',host:'H',queries:{getSummary:async()=>{throw new ReportReadError('read_timeout');},...(report?{getSummaryReport:report}:{})}as Queries};
  server=createHttpServer(opts);await new Promise<void>(ok=>server!.listen(0,'127.0.0.1',ok));opts.port=(server.address()as import('node:net').AddressInfo).port;return 'http://127.0.0.1:'+opts.port;
}
describe('historical Summary HTTP job boundary',()=>{
  it('advertises only a configured service and does not quietly replace the ordinary route',async()=>{
    const base=await start();expect((await(await fetch(base+'/v1/health',{headers})).json()).capabilities.summaryReadJobs).toBeUndefined();
    expect((await fetch(base+'/v1/summary/read?range=all',{method:'POST',headers})).status).toBe(404);expect((await fetch(base+'/v1/summary?range=all',{headers})).status).toBe(504);
  });
  it('keeps Host, Origin, auth, body and range checks ahead of historical computation',async()=>{
    let calls=0;const base=await start(async()=>{calls++;return {}as SummaryResponse;});
    for(const [method,path]of[['POST','/v1/summary/read?range=all'],['DELETE','/v1/summary/read/lease/'+lease]]){
      const response=await new Promise<number>((ok,no)=>{const req=http.request(base+path,{method,headers:{...headers,Host:'wrong.example'}},res=>{res.resume();res.on('end',()=>ok(res.statusCode!));});req.on('error',no);req.end();});expect(response).toBe(403);
      expect((await fetch(base+path,{method,headers:{...headers,Origin:base}})).status).toBe(403);expect((await fetch(base+path,{method})).status).toBe(401);
    }
    expect((await fetch(base+'/v1/summary/read?range=7d',{method:'POST',headers})).status).toBe(400);expect((await fetch(base+'/v1/summary/read?range=all',{method:'POST',headers,body:'{}'})).status).toBe(400);expect(calls).toBe(0);
  });
  it('shares only admitted leases, keeps ordinary requests bounded, and releases the final subscriber',async()=>{
    let calls=0,finish!:(v:SummaryResponse)=>void;const value={range:'all',generatedAt:42,timeBasis:{asOfMs:42},totals:{events:123}}as SummaryResponse;
    const base=await start(async(_range,control)=>{calls++;control?.onProgress?.('reading-usage');return new Promise<SummaryResponse>(ok=>{finish=ok;});});
    const a=await(await fetch(base+'/v1/summary/read?range=all',{method:'POST',headers})).json();
    const b=await(await fetch(base+'/v1/summary/read?range=all',{method:'POST',headers:{...headers,'X-Tokenelo-Read-Lease':'b'.repeat(32)}})).json();expect(a.id).toBe(b.id);expect(calls).toBe(1);
    expect((await fetch(base+'/v1/summary?range=all',{headers})).status).toBe(504);expect((await fetch(base+'/v1/summary/read/'+a.id+'?lease='+'c'.repeat(32),{headers})).status).toBe(404);
    await fetch(base+'/v1/summary/read/lease/'+lease,{method:'DELETE',headers});finish(value);await new Promise<void>(ok=>setImmediate(ok));
    const result=await(await fetch(base+'/v1/summary/read/'+b.id+'?lease='+'b'.repeat(32),{headers})).json();expect(result).toMatchObject({status:'completed',budgetMs:45000,result:value});
    await fetch(base+'/v1/summary/read/lease/'+'b'.repeat(32),{method:'DELETE',headers});expect((await fetch(base+'/v1/summary/read/'+b.id+'?lease='+'b'.repeat(32),{headers})).status).toBe(404);
  });
  it('aborts abandoned historical work and drains it during shutdown',async()=>{
    let started!:()=>void,closed=false;const ready=new Promise<void>(ok=>{started=ok;});const base=await start(async(_r,c)=>new Promise<SummaryResponse>((_ok,no)=>{c!.signal!.addEventListener('abort',()=>{closed=true;no(c!.signal!.reason);},{once:true});started();}));
    await fetch(base+'/v1/summary/read?range=all',{method:'POST',headers});await ready;await closeHttpReads(server!);expect(closed).toBe(true);
  });
});
