import path from 'node:path';

const probePhases=new Set(['entry-before-import','import-complete','main-begin','main-returned','error-caught-after-cleanup']);
const shutdownPhases=new Set(['proxy-close','runtime-close','ownership-release']);
export function safeErrno(value){return typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:null;}
export function phaseOnlyLine(line,observedMs){
  let value;try{value=JSON.parse(line);}catch{return null;}
  if(!value||typeof value!=='object'||!Number.isFinite(observedMs)||observedMs<0)return null;
  const elapsed=value.elapsedMs;
  const duration=Number.isFinite(elapsed)&&elapsed>=0?{elapsedMs:elapsed}:{};
  if(probePhases.has(value.ownedProbePhase))return{phase:value.ownedProbePhase,...duration,parentObservedElapsedMs:observedMs};
  if(shutdownPhases.has(value.shutdownPhase)&&['begin','complete','failed'].includes(value.status))return{phase:value.shutdownPhase,status:value.status,...duration,parentObservedElapsedMs:observedMs};
  return null;
}
export function remainingOriginalBudget(elapsedMs){return Number.isFinite(elapsedMs)&&elapsedMs>=0?Math.max(0,2000-elapsedMs):0;}
export function ownedChildEnvironment(environment,home){
  const clean=Object.fromEntries(Object.entries(environment).filter(([key])=>!key.toUpperCase().startsWith('TOKENELO_')));
  return{...clean,TOKENELO_HOME:home,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0',TOKENELO_SHUTDOWN_DIAGNOSTICS:'1'};
}
export function ownedScratchTarget(realBase,realRoot){
  const base=path.resolve(realBase),root=path.resolve(realRoot);
  return path.dirname(root)===base&&path.basename(root).startsWith('tokenelo-bootstrap-observation-');
}
export function bootstrapAssertions(receipt){
  const phases=Array.isArray(receipt.phases)?receipt.phases:[];
  const wanted=[['import-complete',undefined],['main-begin',undefined],['proxy-close','begin'],['proxy-close','complete'],['runtime-close','begin'],['runtime-close','complete'],['ownership-release','begin'],['ownership-release','complete'],['error-caught-after-cleanup',undefined]];
  let at=-1;
  const ordered=wanted.every(([phase,status])=>{const next=phases.findIndex((item,index)=>index>at&&item.phase===phase&&item.status===status);at=next;return next>=0;});
  return{
    originalDeadlinePreserved:receipt.originalDeadlineMs===2000,
    expectedFailureReportedBeforeDeadline:receipt.reported===true&&receipt.report?.rejected===true&&receipt.report?.code==='EISDIR'&&receipt.elapsedAtObservationEndMs<=2000,
    proxyReleasedBeforeKill:receipt.portFreeBeforeKill===true,
    ownershipReleasedBeforeKill:receipt.leaseFreeBeforeKill===true&&receipt.lockPresentBeforeKill===false,
    reportFromOwnedSpawn:receipt.childReportMatchesOwnedSpawn===true,
    importBootstrapAndCleanupPhasesObservedInOrder:ordered,
  };
}
