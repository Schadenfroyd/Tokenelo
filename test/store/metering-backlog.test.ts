import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MeteringBacklog, type MeteringEnvelope } from '../../src/store/metering-backlog.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { makeEvent, StubPricingEngine, StubEacsEngine } from './stubs.js';

const roots: string[] = [], queues: MeteringBacklog[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const q of queues.splice(0)) q.close(); for (const r of roots.splice(0)) fs.rmSync(r,{recursive:true,force:true}); });
function root() { const r=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-owned-metering-'));roots.push(r);return r; }
function queue(dir: string, consume: (e: MeteringEnvelope) => void, maxBytes?: number) {
  const q=new MeteringBacklog(dir,consume,{autoDrain:false,now:()=>1000,maxBytes});queues.push(q);return q;
}
const event=()=>makeEvent({id:'OWNED-FILED-metered',model:'claude-sonnet-5-5',inputFresh:12,output:4});
it('commits the private queue file before any ledger call, then acknowledges only successful consumption',()=>{
  const dir=root();let calls=0;const q=queue(dir,()=>{calls++;});q.enqueue({kind:'event',event:event()});
  expect(calls).toBe(0);expect(q.status()).toMatchObject({pending:1,oldestQueuedAt:1000,writeFailures:0});
  const names=fs.readdirSync(dir);expect(names).toHaveLength(1);expect(names[0]).toMatch(/\.json$/);
  const contents=fs.readFileSync(path.join(dir,names[0]),'utf8');expect(contents).not.toContain('prompt');expect(contents).not.toContain('response');
  q.flush();expect(calls).toBe(1);expect(q.status().pending).toBe(0);expect(fs.readdirSync(dir)).toEqual([]);
});
it('exposes only a summary of a pending primary-proxy event for local dedupe',()=>{
  const dir=root(),q=queue(dir,()=>{}),queued={...event(),source:'ollama-proxy' as const,engine:'ollama',ts:2_000,durationMs:125};
  q.enqueue({kind:'event',event:queued});
  expect(q.pendingProxyEvents(0,3_000)).toEqual([{ts:2_000,durationMs:125,outputTokens:4,engine:'ollama'}]);
  expect(q.pendingProxyEvents(2_001,3_000)).toEqual([]);
  q.flush();
  expect(q.pendingProxyEvents(0,3_000)).toEqual([]);
});
it('rebuilds the content-free proxy guard summary from a durable queue after restart',()=>{
  const dir=root(),first=queue(dir,()=>{throw new Error('database is locked');});
  first.enqueue({kind:'event',event:{...event(),source:'ollama-proxy',engine:'ollama',ts:2_000,durationMs:125}});
  first.flush();first.close();
  const second=queue(dir,()=>{});
  expect(second.pendingProxyEvents(0,3_000)).toEqual([{ts:2_000,durationMs:125,outputTokens:4,engine:'ollama'}]);
});
it('does not expose a proxy guard match until a failed partial is recovered and synced',()=>{
  const dir=root(),first=queue(dir,()=>{}),failRename=vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw Object.assign(new Error('OWNED rename failure'),{code:'EIO'});});
  expect(()=>first.enqueue({kind:'event',event:{...event(),source:'ollama-proxy',engine:'ollama',ts:2_000,durationMs:125}})).toThrow(/Metering capture not durably queued/);
  expect(first.pendingProxyEvents(0,3_000)).toEqual([]);
  first.close();failRename.mockRestore();
  const recovered=queue(dir,()=>{});
  expect(recovered.pendingProxyEvents(0,3_000)).toEqual([{ts:2_000,durationMs:125,outputTokens:4,engine:'ollama'}]);
});
it('real native writer contention retains the queued event, then retry commits exactly once',()=>{
  const home=root(),dir=path.join(home,'backlog'),file=path.join(home,'owned.sqlite');const db=openDb({file,busyTimeoutMs:0}),other=openDb({file,migrate:false});
  const ledger=new SqliteLedger(db,new StubPricingEngine(),new StubEacsEngine()),q=queue(dir,e=>{if(e.observation.kind==='event')ledger.upsertEvents([e.observation.event]);});
  try{q.enqueue({kind:'event',event:event()});other.exec('BEGIN IMMEDIATE');q.flush();expect(q.status()).toMatchObject({pending:1,lastError:'ledger-busy'});expect(ledger.getEvents({})).toEqual([]);other.exec('ROLLBACK');q.flush();expect(q.status().pending).toBe(0);expect(ledger.getEvents({})).toHaveLength(1);expect(ledger.getEvents({})[0].tokens).toMatchObject({inputFresh:12,output:4});q.flush();expect(ledger.getEvents({})).toHaveLength(1);}finally{other.close();db.close();}
});
it('restart recovers and drains a valid synced observation without editing it',()=>{
  const dir=root(),first=queue(dir,()=>{throw new Error('database is locked');});first.enqueue({kind:'unmetered',count:1});first.flush();first.close();
  const before=fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]));const received:MeteringEnvelope[]=[];const second=queue(dir,e=>{received.push(e);});expect(second.status().pending).toBe(1);expect(fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]))).toEqual(before);second.flush();expect(received).toHaveLength(1);expect(received[0].observation).toEqual({kind:'unmetered',count:1});
});
it('recovers a fully written partial but quarantines torn content without consuming it',()=>{
  const dir=root(),first=queue(dir,()=>{});first.enqueue({kind:'event',event:event()});first.close();const name=fs.readdirSync(dir)[0],id=name.slice(0,-5);fs.renameSync(path.join(dir,name),path.join(dir,`.${id}.partial`));
  fs.writeFileSync(path.join(dir,'.00000000-0000-0000-0000-000000000000.partial'),'{torn');let received=0;const second=queue(dir,()=>{received++;});expect(second.status()).toMatchObject({pending:1,quarantined:1});second.flush();expect(received).toBe(1);expect(fs.readdirSync(dir)).toHaveLength(1);expect(fs.readdirSync(dir)[0]).toMatch(/\.invalid$/);
});
it('a failure after commit but before file acknowledgement replays without changing recorded economics',()=>{
  const dir=root(),db=openDb({file:':memory:'}),ledger=new SqliteLedger(db,new StubPricingEngine(),new StubEacsEngine());const q=queue(dir,e=>{if(e.observation.kind==='event')ledger.upsertEvents([e.observation.event]);});
  try{q.enqueue({kind:'event',event:event()});const original=fs.unlinkSync;const failure=vi.spyOn(fs,'unlinkSync').mockImplementationOnce(()=>{throw Object.assign(new Error('OWNED acknowledgement failure'),{code:'EACCES'});});q.flush();expect(q.status().pending).toBe(1);const row=db.prepare('SELECT rowid,* FROM events').get();failure.mockRestore();q.flush();expect(q.status().pending).toBe(0);expect(db.prepare('SELECT rowid,* FROM events').get()).toEqual(row);expect(original).toBeTypeOf('function');}finally{db.close();}
});
it('retains oversized invalid entries without reading or consuming them',()=>{
  const dir=root(),id='00000000-0000-0000-0000-000000000000';fs.writeFileSync(path.join(dir,`${id}.json`),Buffer.alloc(1024**2+1));let calls=0;const q=queue(dir,()=>{calls++;});expect(q.status().quarantined).toBe(1);q.flush();expect(calls).toBe(0);expect(fs.readdirSync(dir)[0]).toMatch(/\.invalid$/);
});
it('quota failure is explicit and never truncates an already durable observation',()=>{
  const dir=root(),q=queue(dir,()=>{},400);q.enqueue({kind:'unmetered',count:1});const file=fs.readdirSync(dir)[0],before=fs.readFileSync(path.join(dir,file));expect(()=>q.enqueue({kind:'event',event:event()})).toThrow(/backlog-full/);expect(q.status()).toMatchObject({pending:1,writeFailures:1,lastError:'backlog-full'});expect(fs.readFileSync(path.join(dir,file))).toEqual(before);
});
it('private directory and envelope permissions are tightened on POSIX',()=>{
  const dir=root();if(process.platform!=='win32')fs.chmodSync(dir,0o755);const q=queue(dir,()=>{});q.enqueue({kind:'unmetered',count:1});if(process.platform!=='win32'){expect(fs.statSync(dir).mode&0o777).toBe(0o700);expect(fs.statSync(path.join(dir,fs.readdirSync(dir)[0])).mode&0o777).toBe(0o600);}else expect(q.status().pending).toBe(1);
});
