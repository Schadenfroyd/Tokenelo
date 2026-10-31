import fs from'node:fs';import os from'node:os';import path from'node:path';import http from'node:http';import net from'node:net';import{spawn}from'node:child_process';import{once}from'node:events';import{expect,it}from'vitest';
import{buildRuntime}from'../../src/daemon/main.js';import{getPaths,ensureDirs}from'../../src/daemon/paths.js';import{defaultConfig,saveConfig}from'../../src/daemon/config.js';import{acquireLock}from'../../src/daemon/lock.js';import{openDb}from'../../src/store/db.js';import{META_UNMETERED_KEY}from'../../src/store/queries.js';
async function listen(server:net.Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return(server.address()as net.AddressInfo).port;}
async function freePort(){const server=net.createServer(),port=await listen(server);await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function fixture(upstream:string){const home=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-runtime-shutdown-')),paths=getPaths({env:{TOKENELO_HOME:home}});ensureDirs(paths);const config=defaultConfig({hostLabel:'OWNED-FILED-shutdown'});for(const[key,field]of[['claude','roots'],['codex','homes'],['qwen','roots']]as const){const dir=path.join(home,key);fs.mkdirSync(dir);config[key][field]=[dir];}config.claudeDesktop.root=path.join(home,'desktop');fs.mkdirSync(config.claudeDesktop.root);config.api.port=await freePort();config.local.capture='proxy';config.local.proxyPort=await freePort();config.local.ollamaUpstream=upstream;config.local.upstreams=[];saveConfig(paths,config);return{home,paths,config};}
it('runtime shutdown waits for an accepted proxy response, persists its observation and closes only after drain',async()=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>entered=r);
 const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{entered();void gate.then(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',done:true,prompt_eval_count:3,eval_count:2}));});});});
 const upstreamPort=await listen(upstream),f=await fixture('http://127.0.0.1:'+upstreamPort),runtime=await buildRuntime({paths:f.paths,startProxy:true,log:()=>{}});let closing:Promise<void>|undefined;
 const request=new Promise<void>((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.config.local.proxyPort,path:'/api/generate',method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>{expect(res.statusCode).toBe(200);resolve();});});req.once('error',reject);req.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',stream:false}));});
 try{await received;expect(runtime.ollamaProxyHandle?.activeRequestCount()).toBe(1);let done=false;closing=Promise.resolve(runtime.close()).then(()=>{done=true;});await Promise.resolve();expect(done).toBe(false);expect(()=>runtime.db.prepare('SELECT 1').get()).not.toThrow();release();await request;expect(runtime.ollamaProxyHandle?.activeRequestCount()).toBe(0);await closing;const db=openDb({file:f.paths.dbFile,migrate:false});try{expect(db.prepare('SELECT count(*) AS n,sum(input_fresh) AS input,sum(output) AS output FROM events').get()).toEqual({n:1,input:3,output:2});}finally{db.close();}const probe=net.createServer();await new Promise<void>((resolve,reject)=>{probe.once('error',reject);probe.listen(f.config.local.proxyPort,'127.0.0.1',resolve);});await new Promise<void>(resolve=>probe.close(()=>resolve()));}
 finally{release();await request.catch(()=>{});await closing?.catch(()=>{});try{await runtime.close();}catch{}await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});
it('post-runtime token bootstrap failure closes its proxy and releases ownership before returning the error',async()=>{
 const f=await fixture('http://127.0.0.1:9');fs.mkdirSync(f.paths.apiTokenFile);const module=new URL('../../dist/daemon/main.js',import.meta.url).href;
 const code=`const{main}=await import(process.argv[1]);try{await main();console.log(JSON.stringify({unexpectedSuccess:true}));}catch(error){console.log(JSON.stringify({rejected:true,code:error.code}));}`;
 const child=spawn(process.execPath,['--input-type=module','-e',code,module],{env:{...process.env,TOKENELO_HOME:f.home,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');let output='';
 try{await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Owned bootstrap child did not report within original2s')),2000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.stdout.on('data',b=>{output+=b;if(output.includes('\n')){clearTimeout(timeout);resolve();}});});expect(JSON.parse(output).rejected).toBe(true);const probe=net.createServer();const portFree=await new Promise<boolean>(resolve=>{probe.once('error',()=>resolve(false));probe.listen(f.config.local.proxyPort,'127.0.0.1',()=>probe.close(()=>resolve(true)));});let leaseFree=false;try{const handle=acquireLock(f.paths,f.config.api.port);leaseFree=true;handle.release();}catch{}expect({portFree,leaseFree,lockPresent:fs.existsSync(f.paths.lockFile)}).toEqual({portFree:true,leaseFree:true,lockPresent:false});}
 finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
});

it('the compiled CLI reports held startup ownership as failure without changing its diagnostic generation',async()=>{
 const f=await fixture('http://127.0.0.1:9'),held=acquireLock(f.paths,f.config.api.port),before=fs.readFileSync(f.paths.lockFile);
 try{const entry=new URL('../../dist/cli/index.js',import.meta.url);const child=spawn(process.execPath,[entry.pathname.replace(/^\/(\w:)/,'$1'),'serve'],{env:{...process.env,TOKENELO_HOME:f.home,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const[code,signal]=await once(child,'exit');fs.writeFileSync(path.join(f.home,'owned-refused-cli.stderr.log'),stderr);expect({code,signal}).toEqual({code:1,signal:null});expect(fs.readFileSync(f.paths.lockFile)).toEqual(before);expect(fs.existsSync(f.paths.dbFile)).toBe(false);}finally{held.release();}
});

it('shutdown refuses a subsequent keep-alive request before it reaches the upstream and settles without destroying the agent',async()=>{
 let release!:()=>void,enter!:()=>void,forwards=0;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>enter=r);
 const upstream=http.createServer((req,res)=>{req.resume();req.on('end',()=>{forwards++;if(forwards===1){enter();void gate.then(reply);}else reply();function reply(){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',done:true,prompt_eval_count:3,eval_count:2}));}});});
 const port=await listen(upstream),f=await fixture('http://127.0.0.1:'+port),runtime=await buildRuntime({paths:f.paths,startProxy:true,log:()=>{}}),agent=new http.Agent({keepAlive:true,maxSockets:1});
 const request=()=>new Promise<{status?:number;error?:string}>(resolve=>{const req=http.request({host:'127.0.0.1',port:f.config.local.proxyPort,path:'/api/generate',method:'POST',headers:{'Content-Type':'application/json'},agent},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});req.once('error',(error:NodeJS.ErrnoException)=>resolve({error:error.code}));req.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',stream:false}));});
 try{const first=request();await entered;const closing=runtime.close();release();expect((await first).status).toBe(200);const second=await request();expect(second.status===503||['ECONNREFUSED','ECONNRESET','EPIPE'].includes(second.error??'')).toBe(true);await closing;expect(forwards).toBe(1);const db=openDb({file:f.paths.dbFile,migrate:false});try{expect(db.prepare('SELECT count(*) AS n,sum(input_fresh) AS input,sum(output) AS output FROM events').get()).toEqual({n:1,input:3,output:2});}finally{db.close();}}finally{release();agent.destroy();await runtime.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
});

it('a compiled bootstrap failure and post-release close error both survive without stranding its ownership',async()=>{
 const f=await fixture('http://127.0.0.1:9');fs.mkdirSync(f.paths.dbFile);
 const main=new URL('../../dist/daemon/main.js',import.meta.url).href,lock=new URL('../../dist/daemon/lock.js',import.meta.url).href;
 const code=`import fs from'node:fs';import{DatabaseSync}from'node:sqlite';import{main}from${JSON.stringify(main)};import{acquireLock}from${JSON.stringify(lock)};const real=DatabaseSync.prototype.close,cleanupError=Object.assign(new Error('OWNED release EIO after real close'),{code:'EIO'});let calls=0,error;DatabaseSync.prototype.close=function(){calls++;real.call(this);throw cleanupError;};try{await main();}catch(e){error=e;}finally{DatabaseSync.prototype.close=real;}const paths=${JSON.stringify(f.paths)};const result={aggregate:error instanceof AggregateError,primaryCode:error?.cause?.code,primarySqliteFamily:(error?.cause?.errcode??0)&255,exactErrors:error?.errors?.length===2&&error.errors[0]===error.cause&&error.errors[1]===cleanupError,closeCalls:calls,diagnosticPresent:fs.existsSync(paths.lockFile),dbStillDirectory:fs.statSync(paths.dbFile).isDirectory()};const next=acquireLock(paths,47821);next.release();result.leaseReusable=true;console.log(JSON.stringify(result));`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TOKENELO_HOME:f.home,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});const exited=once(child,'exit');let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const[status,signal]=await exited;fs.writeFileSync(path.join(f.home,'owned-bootstrap-release.stderr.log'),stderr);
 expect({status,signal}).toEqual({status:0,signal:null});expect(JSON.parse(stdout)).toEqual({aggregate:true,primaryCode:'ERR_SQLITE_ERROR',primarySqliteFamily:14,exactErrors:true,closeCalls:1,diagnosticPresent:false,dbStillDirectory:true,leaseReusable:true});
});

it('compiled shutdown persists already-received terminal counts when the client disconnects before upstream EOF',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r),payload=JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',done:true,prompt_eval_count:3,eval_count:2});
 const upstream=http.createServer((req,res)=>{req.resume();req.once('end',()=>{res.setHeader('Content-Type','application/json');res.write(payload);void gate.then(()=>res.end());});});
 const port=await listen(upstream),f=await fixture('http://127.0.0.1:'+port),module=new URL('../../dist/daemon/main.js',import.meta.url).href;
 const code=`import net from'node:net';import{main}from${JSON.stringify(module)};const realListen=net.Server.prototype.listen;let markerSent=false;net.Server.prototype.listen=function(...args){if(!markerSent&&args[0]===${JSON.stringify(f.config.api.port)}){markerSent=true;process.stdout.write('OWNED_API_LISTEN\\n');}return Reflect.apply(realListen,this,args);};process.stdin.on('data',b=>{if(b.toString().trim()==='TERM')process.emit('SIGTERM');});try{await main();console.log('OWNED_READY');}finally{net.Server.prototype.listen=realListen;}`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,TOKENELO_HOME:f.home,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0'},windowsHide:true,stdio:['pipe','pipe','pipe']});const exited=once(child,'exit');let stdout='',stderr='',req:http.ClientRequest|undefined;
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const waitText=async(text:string,stream:'stdout'|'stderr'='stdout')=>{const observed=()=>stream==='stdout'?stdout:stderr;const end=Date.now()+2000;while(!observed().includes(text)&&Date.now()<end){if(child.exitCode!==null)throw new Error('Owned child exited early');await new Promise(r=>setTimeout(r,5));}if(!observed().includes(text))throw new Error('Owned original2s observation ended before '+text);};
 const waitApiListener=async()=>{const end=Date.now()+4500;while(!stdout.includes('OWNED_API_LISTEN')&&Date.now()<end){if(child.exitCode!==null||child.signalCode!==null)throw new Error('Owned child exited before the configured API listen call');await new Promise(r=>setTimeout(r,5));}if(!stdout.includes('OWNED_API_LISTEN'))throw new Error('Owned bounded startup observation ended before the configured API listen call');};
 try{await waitApiListener();await waitText('OWNED_READY');const received=new Promise<void>(resolve=>{let body='';req=http.request({host:'127.0.0.1',port:f.config.local.proxyPort,path:'/api/generate',method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.on('data',b=>{body+=b;if(body.includes(payload))resolve();});res.on('error',()=>{});});req.on('error',()=>{});req.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',stream:false}));});await received;child.stdin.write('TERM\n');await waitText('"msg":"shutting down"','stderr');req!.destroy();const[status,signal]=await exited;expect({status,signal}).toEqual({status:0,signal:null});const db=openDb({file:f.paths.dbFile,migrate:false});try{expect(db.prepare('SELECT count(*) AS n,sum(input_fresh) AS input,sum(output) AS output FROM events').get()).toEqual({n:1,input:3,output:2});}finally{db.close();}}
 finally{release();req?.destroy();if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));fs.writeFileSync(path.join(f.home,'owned-disconnect-child.stdout.log'),stdout);fs.writeFileSync(path.join(f.home,'owned-disconnect-child.stderr.log'),stderr);}
});


for (const sample of [
 { name:'missing counters', body:'{"model":"OWNED-NONGENERATING-FIXTURE","done":true,"prompt_eval_count":3', expected:{n:0,input:0,output:0}, unmetered:1 },
 { name:'known counters', body:JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',done:true,prompt_eval_count:3,eval_count:2}), expected:{n:1,input:3,output:2}, unmetered:0 },
 { name:'known zero counters', body:JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',done:true,prompt_eval_count:0,eval_count:0}), expected:{n:1,input:0,output:0}, unmetered:0 },
]) {
 it('upstream native interruption reaches the client and preserves '+sample.name, async()=>{
  let response:http.ServerResponse|undefined;
  const upstream=http.createServer((req,res)=>{req.resume();req.once('end',()=>{response=res;res.setHeader('Content-Type','application/json');res.write(sample.body);});});
  const port=await listen(upstream),f=await fixture('http://127.0.0.1:'+port),runtime=await buildRuntime({paths:f.paths,startProxy:true,log:()=>{}});
  let req:http.ClientRequest|undefined,received='';let receivedBody!:()=>void,finished!:(kind:string)=>void;
  const bodyArrived=new Promise<void>(resolve=>receivedBody=resolve),clientFinished=new Promise<string>(resolve=>finished=resolve);
  try {
   req=http.request({host:'127.0.0.1',port:f.config.local.proxyPort,path:'/api/generate',method:'POST',headers:{'Content-Type':'application/json'}},res=>{
    res.on('data',b=>{received+=b;if(received===sample.body)receivedBody();});
    res.once('end',()=>finished('clean-end'));res.once('error',()=>finished('response-error'));
   });
   req.once('error',()=>finished('request-error'));req.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',stream:false}));
   await Promise.race([bodyArrived,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Owned original2s body observation expired')),2000))]);
   expect(received).toBe(sample.body);response!.socket!.destroy();
   const completion=await Promise.race([clientFinished,new Promise<string>(resolve=>setTimeout(()=>resolve('original2s-observation-expired'),2000))]);
   expect(['response-error','request-error']).toContain(completion);
   await runtime.close();
   const db=openDb({file:f.paths.dbFile,migrate:false});
   try {
    expect(db.prepare('SELECT count(*) AS n,coalesce(sum(input_fresh),0) AS input,coalesce(sum(output),0) AS output FROM events').get()).toEqual(sample.expected);
    const row=db.prepare('SELECT value FROM meta WHERE key=?').get(META_UNMETERED_KEY) as {value:string}|undefined;
    expect(Number(row?.value??0)).toBe(sample.unmetered);
   } finally {db.close();}
  } finally {
   req?.destroy();upstream.closeAllConnections();await runtime.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));
  }
 });
}


it('upstream TCP reset after headers remains an error and preserves unknown usage before shutdown',async()=>{
 let response:http.ServerResponse|undefined;
 const upstream=http.createServer((req,res)=>{req.resume();req.once('end',()=>{response=res;res.setHeader('Content-Type','application/json');res.write('{"model":"OWNED-NONGENERATING-FIXTURE","done":true,"prompt_eval_count":3');});});
 const port=await listen(upstream),f=await fixture('http://127.0.0.1:'+port),runtime=await buildRuntime({paths:f.paths,startProxy:true,log:()=>{}});let request:http.ClientRequest|undefined,received='';let saw!:()=>void,finished!:(kind:string)=>void;
 const data=new Promise<void>(r=>saw=r),completion=new Promise<string>(r=>finished=r);
 try{
  request=http.request({host:'127.0.0.1',port:f.config.local.proxyPort,path:'/api/generate',method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.on('data',b=>{received+=b;if(received.includes('prompt_eval_count'))saw();});res.once('end',()=>finished('clean-end'));res.once('error',()=>finished('response-error'));});request.once('error',()=>finished('request-error'));request.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',stream:false}));
  await Promise.race([data,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Owned original2s body observation expired')),2000))]);response!.socket!.resetAndDestroy();
  const result=await Promise.race([completion,new Promise<string>(r=>setTimeout(()=>r('original2s-observation-expired'),2000))]);expect(['response-error','request-error']).toContain(result);await runtime.close();const db=openDb({file:f.paths.dbFile,migrate:false});try{expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({n:0});expect(Number((db.prepare('SELECT value FROM meta WHERE key=?').get(META_UNMETERED_KEY) as {value:string})?.value)).toBe(1);}finally{db.close();}
 }finally{request?.destroy();upstream.closeAllConnections();await runtime.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});

for (const sample of [
 {name:'missing output',fields:{prompt_eval_count:3},quality:'incomplete',outputState:'missing',unmetered:1,decode:false},
 {name:'reported zero output',fields:{prompt_eval_count:3,eval_count:0},quality:'complete',outputState:'reported',unmetered:0,decode:true},
] as const) {
 it('native '+sample.name+' survives real HTTP and shutdown with field evidence rather than a synthetic zero rate',async()=>{
  const upstream=http.createServer((req,res)=>{req.resume();req.once('end',()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',done:true,...sample.fields,prompt_eval_duration:100000000,eval_duration:100000000}));});});
  const port=await listen(upstream),f=await fixture('http://127.0.0.1:'+port),runtime=await buildRuntime({paths:f.paths,startProxy:true,log:()=>{}});
  try {
   await new Promise<void>((resolve,reject)=>{const request=http.request({host:'127.0.0.1',port:f.config.local.proxyPort,path:'/api/generate',method:'POST',headers:{'Content-Type':'application/json'}},res=>{res.resume();res.once('error',reject);res.once('end',resolve);});request.once('error',reject);request.end(JSON.stringify({model:'OWNED-NONGENERATING-FIXTURE',stream:false}));});
   await runtime.close();const db=openDb({file:f.paths.dbFile,migrate:false});
   try {
    const row=db.prepare('SELECT input_fresh,output,count_quality,components_json,perf_json FROM events').get() as {input_fresh:number;output:number;count_quality:string;components_json:string;perf_json:string};
    expect({input:row.input_fresh,output:row.output,quality:row.count_quality}).toEqual({input:3,output:0,quality:sample.quality});
    expect(JSON.parse(row.components_json)[0].nativeCounterEvidence.snapshots[0].eval_count.state).toBe(sample.outputState);
    const perf=JSON.parse(row.perf_json);expect(perf.prefillTokPerSec).toBe(30);expect('decodeTokPerSec' in perf).toBe(sample.decode);
    expect(Number((db.prepare('SELECT value FROM meta WHERE key=?').get(META_UNMETERED_KEY) as {value:string}|undefined)?.value??0)).toBe(sample.unmetered);
   } finally {db.close();}
  } finally {upstream.closeAllConnections();await runtime.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
 });
}
