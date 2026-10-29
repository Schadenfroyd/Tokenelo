import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {createApiClient} from '../../src/tray/api-client.js';
import {getFleetPeerTokenPath} from '../../src/daemon/fleet.js';
import type {SummaryResponse} from '../../src/core/types.js';

const syntheticPeerTokenFiles = vi.hoisted(() => new Map<string, { permissionChecks: number }>());
vi.mock('../../src/daemon/fleet.js', async importOriginal => {
 const actual = await importOriginal<typeof import('../../src/daemon/fleet.js')>();
 return {
  ...actual,
  readFleetPeerToken: (
   paths: Parameters<typeof actual.readFleetPeerToken>[0],
   label: Parameters<typeof actual.readFleetPeerToken>[1],
  ) => {
   if (process.platform !== 'win32') return actual.readFleetPeerToken(paths,label);
   const tokenPath = actual.getFleetPeerTokenPath(paths,label);
   const owned = syntheticPeerTokenFiles.get(tokenPath);
   if (!owned) throw new Error('peer token path is not a registered test fixture');
   return actual.readFleetPeerToken(paths,label,filePath => {
    if (filePath !== tokenPath) throw new Error('peer token permission check escaped the registered fixture');
    owned.permissionChecks++;
    return true;
   });
  },
 };
});

function registerPeerTokenFile(filePath:string):void {
 if (process.platform === 'win32') syntheticPeerTokenFiles.set(filePath,{permissionChecks:0});
}
function assertPeerTokenPermissionCheck(filePath:string):void {
 if (process.platform === 'win32') expect(syntheticPeerTokenFiles.get(filePath)?.permissionChecks).toBeGreaterThan(0);
}
function unregisterPeerTokenFile(filePath:string|undefined):void {
 if (filePath) syntheticPeerTokenFiles.delete(filePath);
}

const fixture=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../fixtures/api/summary-7d.json'),'utf8')) as SummaryResponse;
async function readPeer(change:(s:SummaryResponse)=>void){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'tokenelo-peer-numeric-'));
 const peer={label:'ryzen',url:'http://100.64.0.8:47822'},localToken='a'.repeat(64),peerToken='b'.repeat(64);
 let peerTokenFile:string|undefined;
 try{
  fs.mkdirSync(home+'/config');fs.mkdirSync(home+'/data');fs.writeFileSync(home+'/config/config.json',JSON.stringify({hostLabel:'A2000',fleet:{peers:[peer]}}));fs.writeFileSync(home+'/data/api-token',localToken);
  const peerFile=getFleetPeerTokenPath({dataDir:home+'/data'} as never,peer.label);peerTokenFile=peerFile;registerPeerTokenFile(peerFile);fs.mkdirSync(path.dirname(peerFile),{recursive:true});fs.writeFileSync(peerFile,peerToken);
  const summary={...structuredClone(fixture),host:'ryzen'};change(summary);
  const fetchImpl=(async(input:string,init?:RequestInit)=>{const u=new URL(input),isPeer=u.hostname!=='127.0.0.1';if(u.pathname.endsWith('/hello')){expect(new Headers(init?.headers).has('Authorization')).toBe(false);return new Response(JSON.stringify({proof:crypto.createHmac('sha256',isPeer?peerToken:localToken).update(u.searchParams.get('nonce')!).digest('hex')}));}expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+(isPeer?peerToken:localToken));return new Response(JSON.stringify(isPeer?summary:fixture));})as typeof fetch;
  const overview=await createApiClient({tokenFile:home+'/data/api-token',fetchImpl,env:{TOKENELO_HOME:home}}).getFleetOverview('7d');
  assertPeerTokenPermissionCheck(peerFile);
  return overview;
 }finally{unregisterPeerTokenFile(peerTokenFile);fs.rmSync(home,{recursive:true,force:true});}
}
describe('authenticated peer aggregate numeric boundaries',()=>{
 const bad:Array<[string,(s:SummaryResponse)=>void]>=[
  ['negative token',s=>s.totals.tokens.inputFresh=-1],['fractional token',s=>s.totals.tokens.inputFresh=.5],['unsafe token',s=>s.totals.tokens.inputFresh=Number.MAX_SAFE_INTEGER+1],
  ['negative event',s=>s.totals.events=-1],['negative money',s=>s.totals.apiEquivUsd=-1],['negative agent time',s=>s.activeTime.agentMs=-1],['negative wall time',s=>s.activeTime.wallMs=-1],
  ['negative source token',s=>Object.values(s.bySource)[0].tokens.output=-1],
 ];
 it.each(bad)('rejects %s while retaining the valid local report',async(_name,change)=>{const r=await readPeer(change);expect(r.hosts[1]).toEqual({label:'ryzen',kind:'peer',status:'untrusted'});expect(r.hosts[0].status).toBe('online');expect(r.hosts[0].summary?.totals.tokens).toEqual(fixture.totals.tokens);});
});
