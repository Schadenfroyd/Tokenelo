import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {phaseOnlyLine,remainingOriginalBudget,ownedChildEnvironment,ownedScratchTarget,bootstrapAssertions,safeErrno} from '../../scripts/bootstrap-observation-helpers.mjs';

test('phase receipts drop injected keys and reject dynamic content labels',()=>{
  assert.deepEqual(phaseOnlyLine(JSON.stringify({shutdownPhase:'runtime-close',status:'complete',elapsedMs:2,apiKey:'OWNED-FAKE-SECRET',prompt:'OWNED-FAKE-PROMPT'}),10),{phase:'runtime-close',status:'complete',elapsedMs:2,parentObservedElapsedMs:10});
  assert.equal(phaseOnlyLine(JSON.stringify({shutdownPhase:'OWNED-FAKE-SECRET',status:'complete'}),10),null);
  assert.equal(phaseOnlyLine('{bad-json',10),null);
  assert.equal(safeErrno('OWNED text with a path'),null);
});
test('the original absolute deadline cannot be reanchored by a late phase',()=>{
  assert.equal(remainingOriginalBudget(50),1950);assert.equal(remainingOriginalBudget(1999),1);assert.equal(remainingOriginalBudget(2001),0);
  assert.equal(remainingOriginalBudget(-1),0);assert.equal(remainingOriginalBudget(NaN),0);
});
test('inherited Tokenelo profile and mutation settings cannot reach the owned child',()=>{
  const home=path.join(os.tmpdir(),'OWNED-home');
  const environment=ownedChildEnvironment({PATH:'OWNED-path',TOKENELO_PROFILE_FILE:'OWNED-foreign-profile',Tokenelo_Profile_File:'OWNED-mixed-case-foreign-profile',TOKENELO_MOCK:'1',TOKENELO_HOME:'OWNED-foreign-home',TOKENELO_LIVE:'1'},home);
  assert.deepEqual(environment,{PATH:'OWNED-path',TOKENELO_HOME:home,TOKENELO_LIVE:'0',TOKENELO_GOLDEN:'0',TOKENELO_SHUTDOWN_DIAGNOSTICS:'1'});
});
test('a report requires owned generation, original timing and pre-kill resource release',()=>{
  const phases=[['import-complete',undefined],['main-begin',undefined],['proxy-close','begin'],['proxy-close','complete'],['runtime-close','begin'],['runtime-close','complete'],['ownership-release','begin'],['ownership-release','complete'],['error-caught-after-cleanup',undefined]].map(([phase,status])=>({phase,status}));
  const receipt={originalDeadlineMs:2000,reported:true,report:{rejected:true,code:'EISDIR'},elapsedAtObservationEndMs:100,portFreeBeforeKill:true,leaseFreeBeforeKill:true,lockPresentBeforeKill:false,childReportMatchesOwnedSpawn:true,phases};
  assert.ok(Object.values(bootstrapAssertions(receipt)).every(Boolean));
  assert.equal(bootstrapAssertions({...receipt,elapsedAtObservationEndMs:2001}).expectedFailureReportedBeforeDeadline,false);
  assert.equal(bootstrapAssertions({...receipt,childReportMatchesOwnedSpawn:false}).reportFromOwnedSpawn,false);
  assert.equal(bootstrapAssertions({...receipt,lockPresentBeforeKill:true}).ownershipReleasedBeforeKill,false);
  assert.equal(bootstrapAssertions({...receipt,phases:phases.filter(item=>item.phase!=='runtime-close')}).importBootstrapAndCleanupPhasesObservedInOrder,false);
});
test('cleanup accepts only the direct owned scratch directory beneath its real base',()=>{
  const base=os.tmpdir(),good=path.join(base,'tokenelo-bootstrap-observation-OWNED');
  assert.equal(ownedScratchTarget(base,good),true);assert.equal(ownedScratchTarget(base,base),false);
  assert.equal(ownedScratchTarget(base,path.join(base,'foreign-work')),false);
  assert.equal(ownedScratchTarget(base,path.join(base,'nested','tokenelo-bootstrap-observation-OWNED')),false);
});
