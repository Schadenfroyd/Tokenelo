import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// This additive hosted lane never runs an original Vitest population. Raw child
// output stays in memory and is discarded; the artifact contains allowlisted
// counts, phases and booleans from the owned FILED-EXAMPLE diagnostic only.
const repo=fileURLToPath(new URL('../',import.meta.url));
const runnerTemp=process.env.RUNNER_TEMP;
const pinnedNode=fs.readFileSync(path.join(repo,'.nvmrc'),'utf8').trim();
if(!runnerTemp||!/^\d+\.\d+\.\d+$/.test(pinnedNode)||process.version!==`v${pinnedNode}`)process.exit(1);
const root=path.join(fs.realpathSync(runnerTemp),'tokenelo-hosted-bootstrap');
if(fs.existsSync(root))process.exit(1);
fs.mkdirSync(root);
const scratch=path.join(root,'owned-diagnostic-scratch');
fs.mkdirSync(scratch);
const rawReceipt=path.join(root,'temporary-owned-observation.json');
const artifact=path.join(root,'hosted-phase-count-receipt.json');
const result={version:1,scope:'OWNED-FILED-EXAMPLE-HOSTED-DIAGNOSTIC',originalDeadlineMs:2000,steps:[],fiveNodeCases:null,diagnostic:null,source487Compiled225Exact:false,gitClean:false,passed:false};
const environment={...process.env,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0',ELECTRON_SKIP_BINARY_DOWNLOAD:'1'};
for(const key of Object.keys(environment))if(key.toUpperCase().startsWith('TOKENELO_')&&!['TOKENELO_LIVE','TOKENELO_GOLDEN'].includes(key))delete environment[key];
function run(name,args,timeoutMs){
  const started=performance.now();
  const child=spawnSync(args[0],args.slice(1),{cwd:repo,env:environment,encoding:null,windowsHide:true,timeout:timeoutMs,maxBuffer:1024*1024});
  result.steps.push({name,exit:Number.isInteger(child.status)?child.status:null,timedOut:child.error?.code==='ETIMEDOUT',elapsedMs:performance.now()-started,stdoutBytes:child.stdout?.length??0,stderrBytes:child.stderr?.length??0});
  return child;
}
function requirePass(child){if(child.error||child.status!==0)throw new Error('owned-step-failed');}
function verifyOriginalBytes(){
  const certificate=JSON.parse(fs.readFileSync(path.join(repo,'docs/cloud/CLOUD-BASELINE-SOURCE.json'),'utf8'));
  if(Object.keys(certificate.sourceBindings).length!==487||Object.keys(certificate.compiledBindings).length!==225)throw new Error('owned-binding-count');
  for(const[relative,binding]of Object.entries({...certificate.sourceBindings,...certificate.compiledBindings})){
    const target=path.resolve(repo,relative);
    if(!target.startsWith(path.resolve(repo)+path.sep))throw new Error('owned-binding-boundary');
    const expected=typeof binding==='string'?binding:binding.sha256;
    if(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==expected)throw new Error('owned-binding-mismatch');
  }
}
let originalObservation;
try{
  verifyOriginalBytes();
  requirePass(run('locked-cloud-setup',['bash','scripts/claude-cloud-setup.sh'],180000));
  requirePass(run('clone-local-safety',['node','scripts/cloud-workspace-safety.mjs'],20000));
  requirePass(run('typecheck',['npm','run','typecheck'],60000));
  requirePass(run('product-build',['npm','run','build'],60000));
  verifyOriginalBytes();
  const unit=run('five-new-node-bootstrap-cases',['node','--test','test/cloud/bootstrap-observation.test.mjs'],10000);
  requirePass(unit);
  const tap=unit.stdout.toString('utf8');
  const count=label=>Number(tap.match(new RegExp(`^# ${label} (\\d+)$`,'m'))?.[1]);
  result.fiveNodeCases={total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')};
  if(result.fiveNodeCases.total!==5||result.fiveNodeCases.passed!==5||result.fiveNodeCases.failed!==0||result.fiveNodeCases.skipped!==0)throw new Error('owned-unit-count');
  // No --repo override: exercise the committed script's real default path.
  const diagnostic=run('new-default-path-bootstrap-diagnostic',['node','scripts/check-bootstrap-observation.mjs','--scratch-base',scratch,'--output',rawReceipt],10000);
  if(fs.existsSync(rawReceipt))originalObservation=JSON.parse(fs.readFileSync(rawReceipt,'utf8'));
  if(!originalObservation)throw new Error('owned-receipt-absent');
  const allowedPhases=new Set(['entry-before-import','import-complete','main-begin','main-returned','error-caught-after-cleanup','proxy-close','runtime-close','ownership-release']);
  const phases=(originalObservation.phases??[]).filter(row=>allowedPhases.has(row.phase)).map(row=>({phase:row.phase,...(['begin','complete'].includes(row.status)?{status:row.status}:{}),...(Number.isFinite(row.elapsedMs)?{elapsedMs:row.elapsedMs}:{}),...(Number.isFinite(row.parentObservedElapsedMs)?{parentObservedElapsedMs:row.parentObservedElapsedMs}:{})}));
  result.diagnostic={passed:originalObservation.observationPassed===true,originalDeadlineMs:originalObservation.originalDeadlineMs,reportedBeforeOriginalDeadline:originalObservation.assertions?.expectedFailureReportedBeforeDeadline===true,ownedSpawnVerified:originalObservation.childReportMatchesOwnedSpawn===true,nativeBirthVerified:originalObservation.childIdentity?.nativeBirthVerified===true,allAssertionsPassed:Object.values(originalObservation.assertions??{}).every(value=>value===true),ownedChildExitObserved:originalObservation.ownedChildExitObservedBeforeScratchCleanup===true,ownedFixtureRemoved:originalObservation.ownedFixtureScratchRemoved===true,observedPhaseCount:originalObservation.phases?.length??0,allowedPhaseCount:phases.length,phases};
  requirePass(diagnostic);
  if(!result.diagnostic.passed||result.diagnostic.originalDeadlineMs!==2000||!result.diagnostic.reportedBeforeOriginalDeadline||!result.diagnostic.ownedSpawnVerified||!result.diagnostic.nativeBirthVerified||!result.diagnostic.allAssertionsPassed||!result.diagnostic.ownedChildExitObserved||!result.diagnostic.ownedFixtureRemoved)throw new Error('owned-diagnostic-failed');
  verifyOriginalBytes();result.source487Compiled225Exact=true;
  const status=run('git-status',['git','status','--porcelain'],10000);requirePass(status);result.gitClean=status.stdout.length===0;if(!result.gitClean)throw new Error('owned-workspace-changed');
  result.passed=true;
}catch{
  // Do not emit an exception message, path, body or raw child output.
  result.passed=false;
}finally{
  fs.rmSync(rawReceipt,{force:true});
  if(fs.existsSync(scratch)&&fs.readdirSync(scratch).length===0)fs.rmdirSync(scratch);
  result.ownedDiagnosticScratchRemoved=!fs.existsSync(scratch);
  fs.writeFileSync(artifact,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  process.exitCode=result.passed?0:1;
}
