import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {originalBootstrapCode,matchesOwnedBootstrapSpawn,installBootstrapObserver} from './cloud-bootstrap-observer.mjs';

function fixture(source){const root=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-observer-')),entry=path.join(root,'dist/daemon/main.js');fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');fs.writeFileSync(entry,source);return{root,args:['--input-type=module','-e',originalBootstrapCode,pathToFileURL(entry).href],options:{env:{...process.env,TOKENELO_HOME:root,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']}};}
async function finish(child,exit){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;}

test('the selector observes only the exact original bootstrap invocation',()=>{
  const f=fixture('export async function main(){}');
  try{assert.ok(matchesOwnedBootstrapSpawn(process.execPath,f.args,f.options));assert.equal(matchesOwnedBootstrapSpawn(process.execPath,[...f.args.slice(0,2),'console.log("OWNED-unrelated")',f.args[3]],f.options),false);assert.equal(matchesOwnedBootstrapSpawn(process.execPath,[...f.args.slice(0,3),'file:///OWNED/foreign.js'],f.options),false);assert.equal(matchesOwnedBootstrapSpawn(process.execPath,f.args,{...f.options,env:{...f.options.env,TOKENELO_LIVE:'1'}}),false);}finally{fs.rmSync(f.root,{recursive:true});}
});

test('draining stderr changes a proven synthetic pipe-pressure timeout without changing stdout or a 2s boundary',async()=>{
  const marker='OWNED-FAKE-CONTENT-DO-NOT-RECEIPT';
  const f=fixture("import fs from'node:fs';export async function main(){fs.writeSync(2,Buffer.alloc(262144,'x'));fs.writeSync(2,'"+marker+"\\n');throw Object.assign(new Error('OWNED-FAKE-ERROR'),{code:'EISDIR'});}");
  let control,controlExit,child,exit,observer;const receipts=[];
  try{
    control=childProcess.spawn(process.execPath,f.args,f.options);controlExit=once(control,'close');let controlOutput='';control.stdout.on('data',b=>controlOutput+=b);await new Promise(resolve=>setTimeout(resolve,2000));assert.equal(controlOutput,'');await finish(control,controlExit);
    observer=installBootstrapObserver({emit:r=>receipts.push(r)});child=childProcess.spawn(process.execPath,f.args,f.options);exit=once(child,'close');let output='';child.stdout.on('data',b=>output+=b);const reported=await new Promise(resolve=>{const timer=setTimeout(()=>resolve(false),2000);child.stdout.on('data',()=>{if(output.includes('\n')){clearTimeout(timer);resolve(true);}});});assert.equal(reported,true);await exit;assert.deepEqual(JSON.parse(output),{rejected:true,code:'EISDIR'});assert.equal(receipts.length,1);assert.equal(receipts[0].observerDeadlineMs,2000);assert.equal(receipts[0].observerDeadlineOrigin,'before-spawn-call');assert.equal(receipts[0].originalTestDeadlineOrigin,'after-spawn-return');assert.ok(receipts[0].firstNewlineAtMs<=2000);assert.ok(receipts[0].stderrBytes>262144);assert.equal(receipts[0].report.code,'EISDIR');assert.equal(JSON.stringify(receipts).includes(marker),false);assert.equal(observer.observedChildren,1);
    const allowed=new Set(['kind','version','observerDeadlineMs','observerDeadlineOrigin','originalTestDeadlineOrigin','originalTestTimerAndAssertionsUnchanged','observerDoesNotSignalChild','stderrDrained','inheritedTokeneloNames','inheritedProfileFileSuppressed','shutdownDiagnosticsEnabledForMatchedChild','childPid','firstNewlineAtMs','deadlineReachedBeforeReport','reported','report','phases','stdoutBytes','stderrBytes','exitCode','exitSignal','spawnErrorCode','parentObservedCloseMs']);assert.ok(Object.keys(receipts[0]).every(key=>allowed.has(key)));for(const phase of receipts[0].phases)assert.ok(Object.keys(phase).every(key=>['phase','status','elapsedMs','parentObservedElapsedMs'].includes(key)));
  }finally{if(control)await finish(control,controlExit);if(child)await finish(child,exit);observer?.restore();fs.rmSync(f.root,{recursive:true});}
});

test('a cold import exceeding 2s records a deadline and partial phases without extending or signaling the child',async()=>{
  const f=fixture("await new Promise(resolve=>setTimeout(resolve,2500));export async function main(){}");const receipts=[];const observer=installBootstrapObserver({emit:r=>receipts.push(r)});let child,exit;
  try{child=childProcess.spawn(process.execPath,f.args,f.options);exit=once(child,'close');await new Promise(resolve=>setTimeout(resolve,2000));assert.equal(receipts.length,0);assert.equal(child.exitCode,null);await finish(child,exit);assert.equal(receipts.length,1);const receipt=receipts[0];assert.equal(receipt.observerDeadlineMs,2000);assert.equal(receipt.deadlineReachedBeforeReport,true);assert.equal(receipt.reported,false);assert.equal(receipt.observerDoesNotSignalChild,true);assert.ok(receipt.phases.some(p=>p.phase==='entry-before-import'));assert.equal(receipt.phases.some(p=>p.phase==='import-complete'),false);}finally{if(child)await finish(child,exit);observer.restore();fs.rmSync(f.root,{recursive:true});}
});

test('unrelated children remain byte-identical and unobserved',async()=>{
  const receipts=[],observer=installBootstrapObserver({emit:r=>receipts.push(r)});let child,exit;
  try{child=childProcess.spawn(process.execPath,['-e','console.log("OWNED-unrelated")'],{windowsHide:true,stdio:['ignore','pipe','pipe']});exit=once(child,'close');let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();await exit;assert.equal(output,'OWNED-unrelated\n');assert.equal(observer.observedChildren,0);assert.deepEqual(receipts,[]);}finally{if(child)await finish(child,exit);observer.restore();}
});

test('only the matched child suppresses a foreign profile output while retaining other inherited settings',async()=>{
  const f=fixture("import fs from'node:fs';export async function main(){if(process.env.TOKENELO_PROFILE_FILE)fs.writeFileSync(process.env.TOKENELO_PROFILE_FILE,'OWNED-PROFILE');if(process.env.TOKENELO_MOCK!=='OWNED-PRESERVED')throw Object.assign(new Error('OWNED missing inherited setting'),{code:'EINVAL'});throw Object.assign(new Error('OWNED expected failure'),{code:'EISDIR'});}");const foreign=path.join(f.root,'owned-forbidden-profile');f.options.env.TOKENELO_PROFILE_FILE=foreign;f.options.env.Tokenelo_Profile_File='OWNED-mixed-case-profile';f.options.env.TOKENELO_MOCK='OWNED-PRESERVED';const before={...f.options.env},receipts=[],observer=installBootstrapObserver({emit:r=>receipts.push(r)});let child,exit;
  try{child=childProcess.spawn(process.execPath,f.args,f.options);exit=once(child,'close');child.stdout.resume();await exit;assert.equal(fs.existsSync(foreign),false);assert.deepEqual(f.options.env,before);assert.equal(receipts[0].report.code,'EISDIR');assert.equal(receipts[0].inheritedProfileFileSuppressed,true);assert.ok(receipts[0].inheritedTokeneloNames.includes('TOKENELO_PROFILE_FILE'));assert.equal(JSON.stringify(receipts).includes(foreign),false);assert.equal(JSON.stringify(receipts).includes('OWNED-PRESERVED'),false);}finally{if(child)await finish(child,exit);observer.restore();fs.rmSync(f.root,{recursive:true});}
});
