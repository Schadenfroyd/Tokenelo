import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {safeErrno,phaseOnlyLine,remainingOriginalBudget,ownedChildEnvironment,ownedScratchTarget,bootstrapAssertions} from './bootstrap-observation-helpers.mjs';

function option(flag){const at=process.argv.indexOf(flag);return at<0?undefined:process.argv[at+1];}
const repo=path.resolve(option('--repo')??fileURLToPath(new URL('../',import.meta.url)));
const scratchBase=path.resolve(option('--scratch-base')??os.tmpdir());
const output=option('--output')?path.resolve(option('--output')):null;
const {getPaths,ensureDirs}=await import(pathToFileURL(path.join(repo,'dist/daemon/paths.js')).href);
const {defaultConfig,saveConfig}=await import(pathToFileURL(path.join(repo,'dist/daemon/config.js')).href);
const {acquireLock}=await import(pathToFileURL(path.join(repo,'dist/daemon/lock.js')).href);
const freePort=async()=>{const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
const root=fs.mkdtempSync(path.join(scratchBase,'tokenelo-bootstrap-observation-'));
const realBase=fs.realpathSync(scratchBase),realRoot=fs.realpathSync(root);
if(!ownedScratchTarget(realBase,realRoot))throw new Error('Owned scratch boundary could not be verified');
let result,scratchSafeToRemove=true;
try{
  const paths=getPaths({env:{TOKENELO_HOME:root}});ensureDirs(paths);
  const config=defaultConfig({hostLabel:'OWNED-FILED-bootstrap-diagnostic'});
  for(const[key,field]of[['claude','roots'],['codex','homes'],['qwen','roots']]){const directory=path.join(root,key);fs.mkdirSync(directory);config[key][field]=[directory];}
  config.claudeDesktop.root=path.join(root,'desktop');fs.mkdirSync(config.claudeDesktop.root);
  config.api.port=await freePort();config.local.capture='proxy';config.local.proxyPort=await freePort();config.local.ollamaUpstream='http://127.0.0.1:9';config.local.upstreams=[];saveConfig(paths,config);
  fs.mkdirSync(paths.apiTokenFile);
  const module=pathToFileURL(path.join(repo,'dist/daemon/main.js')).href,generation=crypto.randomUUID();
  const code=`import fs from'node:fs';const started=performance.now();const phase=p=>fs.writeSync(2,JSON.stringify({ownedProbePhase:p,elapsedMs:performance.now()-started})+'\\n');phase('entry-before-import');const{main}=await import(process.argv[1]);phase('import-complete');try{phase('main-begin');await main();phase('main-returned');console.log(JSON.stringify({unexpectedSuccess:true,generation:process.argv[2],pid:process.pid}));}catch(error){phase('error-caught-after-cleanup');const code=typeof error.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:null;console.log(JSON.stringify({rejected:true,code,generation:process.argv[2],pid:process.pid}));}`;
  const phases=[],started=performance.now(),spawnObservedAt=new Date().toISOString();
  const child=spawn(process.execPath,['--input-type=module','-e',code,module,generation],{env:ownedChildEnvironment(process.env,root),windowsHide:true,stdio:['ignore','pipe','pipe']});
  scratchSafeToRemove=false;
  const exited=once(child,'exit');let stdout='',stderrLines='',stdoutBytes=0,stderrBytes=0;
  const stdoutHash=crypto.createHash('sha256'),stderrHash=crypto.createHash('sha256');
  const processBirth=()=>{
    if(process.platform!=='linux')return null;
    try{const raw=fs.readFileSync(`/proc/${child.pid}/stat`,'utf8'),end=raw.lastIndexOf(') ');return raw.slice(end+2).split(' ')[19];}catch{return null;}
  };
  const linuxProcStartTick=processBirth();
  child.stderr.on('data',buffer=>{stderrBytes+=buffer.length;stderrHash.update(buffer);stderrLines+=buffer;let end;while((end=stderrLines.indexOf('\n'))>=0){const line=stderrLines.slice(0,end);stderrLines=stderrLines.slice(end+1);const phase=phaseOnlyLine(line,performance.now()-started);if(phase)phases.push(phase);}if(stderrLines.length>16384)stderrLines='';});
  let reported=false,report,reason,observedExit,childReportMatchesOwnedSpawn=false;
  let elapsedAtObservationEndMs,lockPresentBeforeKill,portFreeBeforeKill,leaseFreeBeforeKill,postReportCheckErrorCode;
  let killedOwnedChildAfterObservation=false,killRefusedDifferentBirth=false,exitCode,exitSignal;
  try{
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('original2s-expired')),remainingOriginalBudget(performance.now()-started));
      const finish=error=>{clearTimeout(timer);error?reject(error):resolve();};
      child.once('error',error=>finish(Object.assign(new Error('child-spawn-error'),{code:safeErrno(error.code)})));
      child.once('exit',(code,signal)=>{observedExit={code,signal,parentObservedElapsedMs:performance.now()-started};if(!reported)finish(new Error('child-exited-before-report'));});
      child.stdout.on('data',buffer=>{stdoutBytes+=buffer.length;stdoutHash.update(buffer);if(stdout.length<16384)stdout+=buffer;if(!reported&&stdout.includes('\n')){reported=true;try{const value=JSON.parse(stdout.slice(0,stdout.indexOf('\n')));childReportMatchesOwnedSpawn=value.generation===generation&&value.pid===child.pid;report={rejected:value.rejected===true,unexpectedSuccess:value.unexpectedSuccess===true,code:safeErrno(value.code)};finish();}catch{finish(new Error('child-report-invalid'));}}});
    });
  }catch(error){reason=['original2s-expired','child-spawn-error','child-exited-before-report','child-report-invalid'].includes(error.message)?error.message:'observation-error';}
  elapsedAtObservationEndMs=performance.now()-started;lockPresentBeforeKill=fs.existsSync(paths.lockFile);
  if(process.argv.includes('--owned-fail-post-report'))throw Object.assign(new Error('owned post-report check failure'),{code:'EOWNEDCHECK'});
  if(reported&&childReportMatchesOwnedSpawn){const probe=net.createServer();portFreeBeforeKill=await new Promise(resolve=>{probe.once('error',()=>resolve(false));probe.listen(config.local.proxyPort,'127.0.0.1',()=>probe.close(()=>resolve(true)));});leaseFreeBeforeKill=false;try{const lease=acquireLock(paths,config.api.port);leaseFreeBeforeKill=true;lease.release();}catch{}}
  }catch(error){postReportCheckErrorCode=safeErrno(error.code)??'EOWNEDOBSERVER';}
  finally{
  if(child.exitCode===null&&child.signalCode===null){
    const birth=processBirth();
    if(process.platform==='linux'&&linuxProcStartTick!==null&&birth!==linuxProcStartTick)killRefusedDifferentBirth=true;
    else killedOwnedChildAfterObservation=child.kill('SIGKILL');
  }
  try{[exitCode,exitSignal]=await exited;scratchSafeToRemove=true;}catch{scratchSafeToRemove=!Number.isInteger(child.pid);}
  }
  result={recordedAt:new Date().toISOString(),scope:'Owned FILED-EXAMPLE fixture diagnostic; finite observation does not establish a CI root cause, latency bound, installed acceptance or fresh capture.',node:process.version,platform:process.platform,originalDeadlineMs:2000,childIdentity:{pid:child.pid,spawnObservedAt,linuxProcStartTick,nativeBirthVerified:linuxProcStartTick!==null,otherPlatformsUseOwnedChildProcessHandleOnly:process.platform!=='linux'},childReportMatchesOwnedSpawn,reported,report,reason,postReportCheckErrorCode,elapsedAtObservationEndMs,phases,stdoutBytes,stderrBytes,stdoutSha256:stdoutHash.digest('hex'),stderrSha256:stderrHash.digest('hex'),observedExit,exitCode,exitSignal,killedOwnedChildAfterObservation,killRefusedDifferentBirth,ownedChildExitObservedBeforeScratchCleanup:scratchSafeToRemove,portFreeBeforeKill,leaseFreeBeforeKill,lockPresentBeforeKill,productionRuntimeOrSourceMutation:false};
  result.assertions=bootstrapAssertions(result);result.observationPassed=!postReportCheckErrorCode&&scratchSafeToRemove&&Object.values(result.assertions).every(Boolean);
}finally{
  if(scratchSafeToRemove&&ownedScratchTarget(realBase,fs.realpathSync(root))){fs.rmSync(realRoot,{recursive:true,force:true});if(result)result.ownedFixtureScratchRemoved=!fs.existsSync(realRoot);}
  else if(result)result.ownedFixtureScratchRemoved=false;
}
if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify(result));process.exitCode=result?.observationPassed?0:1;
