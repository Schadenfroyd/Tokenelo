import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

export const originalBootstrapCode="const{main}=await import(process.argv[1]);try{await main();console.log(JSON.stringify({unexpectedSuccess:true}));}catch(error){console.log(JSON.stringify({rejected:true,code:error.code}));}";
const codes=new Set(['EISDIR','EACCES','ENOENT','EIO','EADDRINUSE','EINVAL','ERR_SQLITE_ERROR','ERR_MODULE_NOT_FOUND','ERR_INVALID_ARG_TYPE']);
const probePhases=new Set(['entry-before-import','import-complete','main-begin','main-returned','error-caught-after-cleanup']);
const shutdownPhases=new Set(['proxy-close','runtime-close','ownership-release']);
const signals=new Set(['SIGKILL','SIGTERM','SIGINT','SIGABRT']);
const instrumentedCode="import fs from'node:fs';const started=performance.now();const phase=p=>fs.writeSync(2,JSON.stringify({ownedProbePhase:p,elapsedMs:performance.now()-started})+'\\n');phase('entry-before-import');const{main}=await import(process.argv[1]);phase('import-complete');try{phase('main-begin');await main();phase('main-returned');console.log(JSON.stringify({unexpectedSuccess:true}));}catch(error){phase('error-caught-after-cleanup');console.log(JSON.stringify({rejected:true,code:error.code}));}";

export function matchesOwnedBootstrapSpawn(command,args,options){
  if(command!==process.execPath||!Array.isArray(args)||args.length!==4||args[0]!=='--input-type=module'||args[1]!=='-e'||args[2]!==originalBootstrapCode)return false;
  let module;try{module=new URL(args[3]);}catch{return false;}
  return module.protocol==='file:'&&module.pathname.endsWith('/dist/daemon/main.js')&&options?.env?.TOKENELO_HOME&&options.env.TOKENELO_LIVE==='0'&&options.env.TOKENELO_GOLDEN==='0'&&JSON.stringify(options.stdio)===JSON.stringify(['ignore','pipe','pipe']);
}

function phaseOnly(line,observedMs){
  let value;try{value=JSON.parse(line);}catch{return null;}
  if(!value||typeof value!=='object')return null;
  const elapsedMs=Number.isFinite(value.elapsedMs)&&value.elapsedMs>=0?value.elapsedMs:undefined;
  if(probePhases.has(value.ownedProbePhase))return{phase:value.ownedProbePhase,elapsedMs,parentObservedElapsedMs:observedMs};
  if(shutdownPhases.has(value.shutdownPhase)&&['begin','complete','failed'].includes(value.status))return{phase:value.shutdownPhase,status:value.status,elapsedMs,parentObservedElapsedMs:observedMs};
  return null;
}

/** Observes one exact existing test spawn. It never accepts a report for the test,
 * changes its timeout, signals its child, retries work, or serializes raw output. */
export function installBootstrapObserver({emit=receipt=>process.stderr.write('[tokenelo-bootstrap-observer] '+JSON.stringify(receipt)+'\n')}={}){
  const originalSpawn=childProcess.spawn;
  let observedChildren=0;
  function observedSpawn(command,args,options){
    if(!matchesOwnedBootstrapSpawn(command,args,options))return originalSpawn.apply(this,arguments);
    observedChildren++;
    const started=performance.now(),phases=[];
    const inheritedTokeneloNames=Object.keys(options.env).filter(key=>/^TOKENELO_[A-Z0-9_]{1,80}$/i.test(key)).sort();
    const inheritedProfileFileSuppressed=inheritedTokeneloNames.some(key=>key.toUpperCase()==='TOKENELO_PROFILE_FILE');
    const ownedEnvironment=Object.fromEntries(Object.entries(options.env).filter(([key])=>key.toUpperCase()!=='TOKENELO_PROFILE_FILE'));
    const child=originalSpawn.call(this,command,[...args.slice(0,2),instrumentedCode,args[3]],{...options,env:{...ownedEnvironment,TOKENELO_SHUTDOWN_DIAGNOSTICS:'1'}});
    let stderrPartial='',stdoutPartial='',stdoutBytes=0,stderrBytes=0,firstNewlineAtMs,report,spawnErrorCode,deadlineReachedBeforeReport=false;
    const timer=setTimeout(()=>{deadlineReachedBeforeReport=firstNewlineAtMs===undefined;},Math.max(0,2000-(performance.now()-started)));
    child.stdout.on('data',buffer=>{
      stdoutBytes+=buffer.length;
      if(firstNewlineAtMs!==undefined)return;
      if(stdoutPartial.length<16384)stdoutPartial+=buffer;
      const end=stdoutPartial.indexOf('\n');if(end<0)return;
      firstNewlineAtMs=performance.now()-started;
      try{const value=JSON.parse(stdoutPartial.slice(0,end));report={rejected:value.rejected===true,unexpectedSuccess:value.unexpectedSuccess===true,code:codes.has(value.code)?value.code:null};}catch{report={invalidJson:true};}
      stdoutPartial='';
    });
    child.stderr.on('data',buffer=>{
      stderrBytes+=buffer.length;stderrPartial+=buffer;
      let end;while((end=stderrPartial.indexOf('\n'))>=0){const phase=phaseOnly(stderrPartial.slice(0,end),performance.now()-started);stderrPartial=stderrPartial.slice(end+1);if(phase&&phases.length<32)phases.push(phase);}
      if(stderrPartial.length>16384)stderrPartial='';
    });
    child.once('error',error=>{spawnErrorCode=codes.has(error.code)?error.code:null;});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);
      emit({kind:'owned-bootstrap-observation',version:1,observerDeadlineMs:2000,observerDeadlineOrigin:'before-spawn-call',originalTestDeadlineOrigin:'after-spawn-return',originalTestTimerAndAssertionsUnchanged:true,observerDoesNotSignalChild:true,stderrDrained:true,inheritedTokeneloNames,inheritedProfileFileSuppressed,shutdownDiagnosticsEnabledForMatchedChild:true,childPid:Number.isInteger(child.pid)?child.pid:null,firstNewlineAtMs,deadlineReachedBeforeReport,reported:firstNewlineAtMs!==undefined,report,phases,stdoutBytes,stderrBytes,exitCode:Number.isInteger(code)?code:null,exitSignal:signals.has(signal)?signal:null,spawnErrorCode,parentObservedCloseMs:performance.now()-started});
    });
    return child;
  }
  childProcess.spawn=observedSpawn;syncBuiltinESMExports();
  return{get observedChildren(){return observedChildren;},restore(){if(childProcess.spawn===observedSpawn){childProcess.spawn=originalSpawn;syncBuiltinESMExports();}}};
}
