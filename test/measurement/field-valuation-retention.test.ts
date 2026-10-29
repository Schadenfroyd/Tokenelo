import {expect,it}from'vitest';
import type {TokenCounts}from'../../src/core/types.js';
import {ZERO_TOKENS}from'../../src/core/types.js';
import {addTokenCounts}from'../../src/core/token-counts.js';
import {nativeTokenFieldCoverage}from'../../src/core/token-field-evidence.js';
import {captureNativeCounters,nativeCounterProjection}from'../../src/measurement/native-counter-evidence.js';
import {buildOllamaUsageEvent}from'../../src/collectors/ollama-proxy.js';
import {openDb}from'../../src/store/db.js';
import {SqliteLedger}from'../../src/store/ledger.js';
import {StubPricingEngine,StubEacsEngine}from'../store/stubs.js';
import {buildShareReport}from'../../src/cli/share-report.js';
import {tokenPeriodEvidence}from'../../src/tray/renderer/token-period.js';

class NewPrice extends StubPricingEngine {
 constructor(){super();Object.defineProperty(this,'version',{value:'OWNED-FILED-new-price'});}
 override priceEvent(e:Parameters<StubPricingEngine['priceEvent']>[0]){const p=super.priceEvent(e);return{...p,usd:p.usd!*2};}
}
class NewCalibration extends StubEacsEngine {
 constructor(){super();Object.defineProperty(this,'defSha256',{value:'OWNED-FILED-new-calibration'});}
 override ucuForEvent(e:Parameters<StubEacsEngine['ucuForEvent']>[0]){const p=super.ucuForEvent(e);return{...p,reservedValue:p.reservedValue!*7};}
 override rateBasisOf(c:Parameters<StubEacsEngine['rateBasisOf']>[0]){const b=super.rateBasisOf(c);return{...b,resolvedSha256:'OWNED-FILED-new-selection:'+b.rateKey};}
}
function event(){const evidence=captureNativeCounters({prompt_eval_count:3,eval_count:8});return{...buildOllamaUsageEvent({host:'OWNED',model:'OWNED-NONGENERATING-FIXTURE',ts:1,requestStartNs:1n,entrypoint:'owned',tokens:nativeCounterProjection(evidence),nativeCounterEvidence:evidence}),id:'OWNED-native-recorded-price'};}
it.each(['raw-source','exported-row']as const)('retains every recorded native valuation cell under changed tables on ordinary %s replay',mode=>{
 const db=openDb({file:':memory:'});try{
  const incoming=event(),old=new SqliteLedger(db,new StubPricingEngine(),new StubEacsEngine());old.upsertEvents([incoming]);const stored=old.getEvents({})[0]!;
  expect(stored.tokens.fieldEvidence).toBeDefined();const before=db.prepare('SELECT rowid,* FROM events').get();
  const current=new SqliteLedger(db,new NewPrice(),new NewCalibration());
  expect(current.upsertEvents([mode==='raw-source'?incoming:stored])).toEqual({inserted:0,updated:0,unchanged:1});
  expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(before);
 }finally{db.close();}
});
it('keeps explicit native repricing distinct from ordinary replay',()=>{
 const db=openDb({file:':memory:'});try{
  const old=new SqliteLedger(db,new StubPricingEngine(),new StubEacsEngine());old.upsertEvents([event()]);const before=old.getEvents({})[0]!,rowid=db.prepare('SELECT rowid FROM events').get();
  const current=new SqliteLedger(db,new NewPrice(),new NewCalibration());expect(current.upsertEvents([before],{reprice:true}).updated).toBe(1);const after=current.getEvents({})[0]!;
  expect(after.apiEquivUsd).toBe(before.apiEquivUsd!*2);expect(after.reservedValue).toBe(before.reservedValue);expect(after.eacsDefSha256).toBe(before.eacsDefSha256);expect(after.rateResolvedSha256).toBe(before.rateResolvedSha256);expect(after.priceVersion).toBe('OWNED-FILED-new-price');expect(after.tokens).toEqual(before.tokens);expect(db.prepare('SELECT rowid FROM events').get()).toEqual(rowid);
 }finally{db.close();}
});
function native(){const e=captureNativeCounters({prompt_eval_count:0,prompt_eval_cached_count:0,eval_count:0}),tokens=nativeCounterProjection(e);return{...tokens,fieldEvidence:nativeTokenFieldCoverage([{model:'OWNED',tokens,nativeCounterEvidence:e}],tokens)};}
it('reconciles the real native optional-column shape consistently in the export and renderer',()=>{
 const n=native(),legacy:TokenCounts={...ZERO_TOKENS,output:9,cacheWriteUnassigned:0,countQuality:'complete'},total={...ZERO_TOKENS};expect(n.cacheWriteUnassigned).toBeUndefined();addTokenCounts(total,n);addTokenCounts(total,legacy);
 const row=(tokens:TokenCounts,events:number)=>({tokens,events,apiEquivUsd:0,unpricedEvents:0,estimatedPriceEvents:0,priceStatus:'LIST'as const});
 const summary={range:'all'as const,generatedAt:1,totals:row(total,2),bySource:{'ollama-proxy':row(n,1),claude:row(legacy,1)}};
 expect(tokenPeriodEvidence(summary as Parameters<typeof tokenPeriodEvidence>[0],'all').sourceState).toBe('match');
 expect(buildShareReport(summary,'all').sourceReconciliation.status).toBe('match');
});
it('preserves known complete legacy categories across mixed quality fold orders',()=>{
 const a:TokenCounts={...ZERO_TOKENS,output:5,countQuality:'complete'},b:TokenCounts={...ZERO_TOKENS,output:9,countQuality:'unrecorded'},n=native();
 const fold=(rows:TokenCounts[])=>{const t={...ZERO_TOKENS};for(const row of rows)addTokenCounts(t,row);return t;};
 const first=fold([n,a,b]),last=fold([a,b,n]);expect(last.fieldEvidence).toEqual(first.fieldEvidence);expect(last.fieldEvidence!.output).toMatchObject({knownValue:5,knownParts:2});expect(last.output).toBe(14);expect(first.output).toBe(14);
});
