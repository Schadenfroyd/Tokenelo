import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { assertSnapshotOutcome, SNAPSHOT_OUTCOME_WAIT_SCRIPT, SnapshotRendererError } from '../../src/tray/renderer/snapshot-outcome.js';
import { runBounded, sanitizeFixtureReads } from '../../src/tray/snapshot-data.js';
import type { ApiClient } from '../../src/tray/api-client.js';

function windowState(ready = false, failure: unknown = null) {
  const listeners = new Map<string, Set<() => void>>();
  const window = {
    __tokeneloReady: ready, __tokeneloFailure: failure,
    addEventListener: (name: string, fn: () => void) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener: (name: string, fn: () => void) => listeners.get(name)?.delete(fn),
  };
  return { window, emit: (name: string) => [...(listeners.get(name) ?? [])].forEach(fn => fn()), remaining: () => [...listeners.values()].reduce((n,s) => n+s.size, 0) };
}

describe('snapshot terminal renderer outcome', () => {
  it('accepts already ready state and removes listeners', async () => {
    const s = windowState(true);
    expect(await vm.runInNewContext(SNAPSHOT_OUTCOME_WAIT_SCRIPT, { window:s.window })).toEqual({ok:true});
    expect(s.remaining()).toBe(0);
  });
  it('failure takes precedence over stale readiness', async () => {
    const s = windowState(true, 'detail-identity');
    const outcome = await vm.runInNewContext(SNAPSHOT_OUTCOME_WAIT_SCRIPT, { window:s.window });
    expect(() => assertSnapshotOutcome(outcome)).toThrow('the detail response did not match the requested session');
    expect(s.remaining()).toBe(0);
  });
  it('a later terminal failure settles without a readiness event', async () => {
    const s=windowState();const pending=vm.runInNewContext(SNAPSHOT_OUTCOME_WAIT_SCRIPT,{window:s.window});
    expect(s.remaining()).toBe(2);
    s.window.__tokeneloFailure='detail-load';s.emit('tokenelo:failed');
    expect(await pending).toEqual({ok:false,category:'detail-load'});
    expect(s.remaining()).toBe(0);
  });
  it('a later readiness settles, and unrelated events do not settle', async () => {
    const s=windowState();const pending=vm.runInNewContext(SNAPSHOT_OUTCOME_WAIT_SCRIPT,{window:s.window});
    s.emit('tokenelo:ready');expect(s.remaining()).toBe(2);
    s.window.__tokeneloReady=true;s.emit('tokenelo:ready');
    assertSnapshotOutcome(await pending);expect(s.remaining()).toBe(0);
  });
  it('unknown or malformed outcomes never echo caller data or falsely succeed', () => {
    for (const value of [null,undefined,'private-path',{}, {ok:1}, {ok:true,category:'private-path'}, {ok:false,category:{secret:'private-path'}}]) {
      expect(()=>assertSnapshotOutcome(value)).toThrow(/^the renderer reported an invalid outcome$/);
    }
    expect(new SnapshotRendererError('__proto__').message).toBe('the renderer reported an invalid outcome');
  });
  it('the bounded main runner reports the fixed failure category with no image claim', async () => {
    const reports:unknown[]=[];
    const err = new SnapshotRendererError('detail-identity');
    err.message = 'private-path';
    await runBounded(async()=>{throw err;},100,(...args)=>reports.push(args));
    expect(reports).toEqual([[1,'tray snapshot failed: the detail response did not match the requested session. No image was written.']]);
  });
});

describe('fixture snapshot IPC read boundary', () => {
  it('preserves successful values and arguments, without mutating the original client', async () => {
    const values:unknown[]=[];const response={range:'30d'};
    const client={getSummary:async (...args:unknown[])=>{values.push(args);return response;}} as unknown as ApiClient;
    const wrapped=sanitizeFixtureReads(client);
    expect(wrapped).not.toBe(client);
    expect(await wrapped.getSummary('30d')).toBe(response);
    expect(values).toEqual([['30d']]);
  });
  it('strips raw fixture parse paths and the error stack before IPC rejection', async () => {
    const client={getSessionDetail:async()=>{throw new Error('private-path and secret fixture text');}} as unknown as ApiClient;
    const wrapped=sanitizeFixtureReads(client);
    const err=await wrapped.getSessionDetail('claude','session').catch(err=>err);
    expect(err.name).toBe('SnapshotReadError');
    expect(err.message).toBe('a fixture read failed (getSessionDetail)');
    expect(err.stack).toBeUndefined();
    expect(String(err)).not.toContain('private-path');
  });
  it('also contains synchronous throws and preserves the original method receiver', async () => {
    const client={getDoctor:function(){expect(this).toBe(client);throw 'private-path';}} as unknown as ApiClient;
    await expect(sanitizeFixtureReads(client).getDoctor()).rejects.toThrow(/^a fixture read failed \(getDoctor\)$/);
  });
});
