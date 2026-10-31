import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

// One materially instrumented qualification. Never retries a failing command.
const root=process.cwd(),out=path.join(process.env.RUNNER_TEMP??os.tmpdir(),'tokenelo-bootstrap-profile');
fs.mkdirSync(out,{recursive:true});
const pinnedNode=fs.readFileSync(path.join(root,'.nvmrc'),'utf8').trim();
const result={version:1,scope:'INSTRUMENTED-PORTABLE-PROFILE-NOT-ORIGINAL-CI-ROOT-CAUSE',startedAt:new Date().toISOString(),originalOuterDeadlineMs:180000,originalChildTestDeadlineMs:2000,steps:[],passed:false};
const env={...process.env,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0'};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(fs.readFileSync('docs/cloud/CLOUD-BASELINE-SOURCE.json','utf8'));
function exact(){return Object.entries({...baseline.sourceBindings,...baseline.compiledBindings}).every(([n,h])=>sha(fs.readFileSync(n))===h);}
function run(name,args,timeout){
 const started=performance.now(),r=spawnSync(args[0],args.slice(1),{cwd:root,env,encoding:'utf8',timeout,maxBuffer:64*1024*1024,windowsHide:true});
 result.steps.push({name,exit:r.status,signal:r.signal,timedOut:r.error?.code==='ETIMEDOUT',elapsedMs:performance.now()-started,stdoutBytes:Buffer.byteLength(r.stdout??''),stderrBytes:Buffer.byteLength(r.stderr??'')});
 return r;
}
function success(r){if(r.status!==0||r.error)throw Error('owned-check-failed');}
function observation(raw){
 const prefix='[tokenelo-bootstrap-observer] ',lines=raw.split('\n').filter(x=>x.startsWith(prefix));
 if(lines.length!==1)throw Error('owned-observer-count');
 const x=JSON.parse(lines[0].slice(prefix.length));
 const allowed=new Set(['kind','version','observerDeadlineMs','observerDeadlineOrigin','originalTestDeadlineOrigin','originalTestTimerAndAssertionsUnchanged','observerDoesNotSignalChild','stderrDrained','inheritedTokeneloNames','inheritedProfileFileSuppressed','shutdownDiagnosticsEnabledForMatchedChild','childPid','firstNewlineAtMs','deadlineReachedBeforeReport','reported','report','phases','stdoutBytes','stderrBytes','exitCode','exitSignal','spawnErrorCode','parentObservedCloseMs']);
 if(Object.keys(x).some(k=>!allowed.has(k))||x.kind!=='owned-bootstrap-observation'||x.version!==1||x.observerDeadlineMs!==2000||x.originalTestTimerAndAssertionsUnchanged!==true)throw Error('owned-observer-schema');
 if(!Array.isArray(x.inheritedTokeneloNames)||x.inheritedTokeneloNames.some(n=>!/^TOKENELO_[A-Z0-9_]{1,80}$/i.test(n)))throw Error('owned-env-names');
 const phases=new Set(['entry-before-import','import-complete','main-begin','main-returned','error-caught-after-cleanup','proxy-close','runtime-close','ownership-release']);
 if(!Array.isArray(x.phases)||x.phases.length>32||x.phases.some(p=>!phases.has(p.phase)||Object.keys(p).some(k=>!['phase','elapsedMs','parentObservedElapsedMs','status'].includes(k))))throw Error('owned-phases');
 return x;
}
try{
 if(!/^\d+\.\d+\.\d+$/.test(pinnedNode)||process.version!==`v${pinnedNode}`||Object.keys(baseline.sourceBindings).length!==487||Object.keys(baseline.compiledBindings).length!==225||!exact())throw Error('source-preflight');
 success(run('locked-setup',['bash','scripts/claude-cloud-setup.sh'],180000));
 success(run('clone-local-safety',[process.execPath,'scripts/cloud-workspace-safety.mjs'],20000));
 success(run('typecheck',['npm','run','typecheck'],60000));
 success(run('build',['npm','run','build'],60000));
 const controls=run('five-observer-controls',[process.execPath,'--test','scripts/cloud-bootstrap-observer.test.mjs'],30000);success(controls);
 if(!/# tests 5\b/.test(controls.stdout)||!/# pass 5\b/.test(controls.stdout)||!/# fail 0\b/.test(controls.stdout))throw Error('control-population');
 result.observerControls={total:5,passed:5,failed:0};
 const file=path.join(out,'vitest-result.json');
 const suite=run('instrumented-existing-portable-population',[process.execPath,'node_modules/vitest/vitest.mjs','run','-c','vitest.bootstrap-observer.config.ts','--reporter=json','--outputFile='+file],180000);
 if(fs.existsSync(file)){
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  result.profile=Object.fromEntries(['numTotalTests','numPassedTests','numPendingTests','numFailedTests'].map(k=>[k,raw[k]]));
 }
 result.bootstrap=observation(suite.stderr??'');
 success(suite);
 if(result.profile?.numTotalTests!==3039||result.profile.numPassedTests!==3027||result.profile.numPendingTests!==12||result.profile.numFailedTests!==0)throw Error('portable-population');
 success(run('separate-fourteen-report-checks',[process.execPath,'scripts/check-cloud-portable-report.mjs'],180000));
 const status=run('git-clean',['git','status','--porcelain'],15000);success(status);
 result.source487Compiled225Exact=exact();result.gitClean=status.stdout==='';
 if(!result.source487Compiled225Exact||!result.gitClean)throw Error('final-source-or-status');
 result.passed=true;
}catch(error){result.failureCode=['owned-check-failed','owned-observer-count','owned-observer-schema','owned-env-names','owned-phases','source-preflight','control-population','portable-population','final-source-or-status'].includes(error.message)?error.message:'owned-observer-preparation-or-parse';process.exitCode=1;}
finally{
 result.completedAt=new Date().toISOString();result.originalFailedRunStillUnresolved=true;result.originalUninstrumentedCiAccepted=false;result.fullAlphaAccepted=false;
 fs.writeFileSync(path.join(out,'phase-and-count-receipt.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({passed:result.passed,steps:result.steps.length,profile:result.profile??null,failureCode:result.failureCode??null}));
}
