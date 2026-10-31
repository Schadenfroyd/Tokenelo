/** Private durable metering observations, retained until an idempotent ledger
 * commit succeeds. No prompts, response text, credentials or central upload.
 * A bounded queue makes storage failure explicit; zero backlog is not evidence
 * of complete capture. Its current observation is separate from report snapshots. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MeteringBacklogStatus, PendingProxyGuardEvent, UsageEvent } from '../core/types.js';

export type MeteringObservation = { kind: 'event'; event: UsageEvent } | { kind: 'unmetered'; count: 1 };
export interface MeteringEnvelope { version: 1; id: string; queuedAt: number; observation: MeteringObservation; sha256: string }
const ENTRY_LIMIT = 1024 ** 2;
const BACKLOG_LIMIT = 256 * 1024 ** 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function digest(observation: MeteringObservation): string { return createHash('sha256').update(JSON.stringify(observation)).digest('hex'); }
function parse(bytes: Buffer, id: string): MeteringEnvelope {
  if (bytes.length > ENTRY_LIMIT) throw new Error('entry-too-large');
  const e = JSON.parse(bytes.toString('utf8')) as MeteringEnvelope;
  if (e.version !== 1 || !UUID.test(e.id) || e.id !== id || !Number.isSafeInteger(e.queuedAt) || e.queuedAt < 0
    || !e.observation || e.sha256 !== digest(e.observation)) throw new Error('invalid-entry');
  const o = e.observation;
  if (o.kind === 'unmetered') { if (o.count !== 1) throw new Error('invalid-entry'); }
  else if (o.kind !== 'event' || !o.event || typeof o.event.id !== 'string' || !o.event.id
    || typeof o.event.host !== 'string' || typeof o.event.model !== 'string' || !Number.isSafeInteger(o.event.ts)
    || !o.event.tokens || !Array.isArray(o.event.components) || !Array.isArray(o.event.flags)) throw new Error('invalid-entry');
  return e;
}
function syncDirectory(dir: string): void {
  // Windows does not expose directory fsync through this API. The entry itself
  // is synced before rename on every OS; POSIX also syncs the renamed directory.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

type PendingEntry = { file: string; bytes: number; queuedAt: number | null; proxyGuard?: PendingProxyGuardEvent };
const DIAGNOSTICS = 'capture-diagnostics.json';
const RECOVERY_DIAGNOSTICS = 'capture-diagnostics-recovery.json';
const DIAGNOSTIC_FILE = /^capture-diagnostics\.[0-9a-f-]+\.json$/;
function diagnosticSnapshot(file: string): {writeFailures: number; historyIncomplete: boolean} {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('invalid-diagnostics');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as {version?: number; writeFailures?: number; historyIncomplete?: unknown};
  if (value.version !== 1 || !Number.isSafeInteger(value.writeFailures) || value.writeFailures! < 0
    || (value.historyIncomplete !== undefined && typeof value.historyIncomplete !== 'boolean')) throw new Error('invalid-diagnostics');
  return {writeFailures: value.writeFailures!, historyIncomplete: value.historyIncomplete === true};
}
export class MeteringBacklog {
  private pending = new Map<string, PendingEntry>();
  private acknowledged = new Set<string>();
  private retainedBytes = 0;
  private quarantined = 0;
  private writeFailures = 0;
  private failureEvidenceStored: boolean | null = null;
  private historyIncomplete = false;
  private recoverySnapshot: string | undefined;
  private lastError: MeteringBacklogStatus['lastError'] = null;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  constructor(readonly directory: string, private consume: (envelope: MeteringEnvelope) => void,
    private options: { autoDrain?: boolean; maxBytes?: number; now?: () => number } = {}) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw new Error('Backlog directory must be a private directory');
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    const names = fs.readdirSync(directory).sort();
    this.loadDiagnostics(names);
    for (const name of names) {
      if (name.endsWith('.invalid')) {
        try { this.quarantined++; this.retainedBytes += fs.lstatSync(path.join(directory,name)).size; this.lastError = 'invalid-entry'; }
        catch { this.lastError = 'queue-unwritable'; }
        continue;
      }
      const id = /^([0-9a-f-]+)\.json$/.exec(name)?.[1] ?? /^\.([0-9a-f-]+)\.partial$/.exec(name)?.[1];
      if (!id || !UUID.test(id)) continue;
      const entry: PendingEntry = { file: path.join(directory,name), bytes: 0, queuedAt: null };
      try { entry.bytes = fs.lstatSync(entry.file).size; this.pending.set(id,entry); this.retainedBytes += entry.bytes; entry.proxyGuard = proxyGuardSummary(this.readEntry(id,entry,true).observation); }
      catch (error) { this.handleReadFailure(id,entry,error); }
    }
    if (options.autoDrain !== false) { this.timer = setInterval(() => this.flush(),1000); this.timer.unref(); }
  }
  private loadDiagnostics(names: string[]): void {
    let invalid = false;
    for (const name of names.filter(n => n === DIAGNOSTICS || n === RECOVERY_DIAGNOSTICS || DIAGNOSTIC_FILE.test(n) || /^\.capture-diagnostics\.[0-9a-f-]+\.tmp$/.test(n))) {
      try {
        const file=path.join(this.directory,name),v=diagnosticSnapshot(file);
        this.writeFailures=Math.max(this.writeFailures,v.writeFailures);
        this.historyIncomplete ||= v.historyIncomplete;
        if (DIAGNOSTIC_FILE.test(name)) this.recoverySnapshot=file;
        if (name.startsWith('.')) {
          const fd=fs.openSync(file,'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          syncDirectory(this.directory);
        }
        this.failureEvidenceStored=true;
      } catch { invalid=true; }
    }
    if (invalid) { this.historyIncomplete=true; if (this.failureEvidenceStored !== true) this.failureEvidenceStored=false; }
    if (this.historyIncomplete) this.lastError='queue-unwritable';
  }
  private persistFailureEvidence(): void {
    // Only a successfully synced local snapshot establishes persistence. Failed
    // nonempty diagnostic temporaries remain recoverable; no payload is deleted.
    const temporary=path.join(this.directory,`.capture-diagnostics.${randomUUID()}.tmp`);
    try {
      let target=path.join(this.directory,DIAGNOSTICS);
      // Preserve unreadable/corrupt evidence. A separate valid snapshot can keep
      // new known counts durable, without claiming the older history is complete.
      for (const name of [DIAGNOSTICS, RECOVERY_DIAGNOSTICS]) {
        target=path.join(this.directory,name);
        try {
          const old=diagnosticSnapshot(target);
          this.writeFailures=Math.max(this.writeFailures,old.writeFailures);
          this.historyIncomplete ||= old.historyIncomplete;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
          this.historyIncomplete=true;
          target=path.join(this.directory,`capture-diagnostics.${randomUUID()}.json`);
        }
      }
      if (DIAGNOSTIC_FILE.test(path.basename(target))) {
        // Reuse a verified valid alternate after damaged fixed names. Retain
        // every invalid/non-target snapshot; one failure need not add one file.
        if (this.recoverySnapshot) {
          try {
            const old=diagnosticSnapshot(this.recoverySnapshot);
            this.writeFailures=Math.max(this.writeFailures,old.writeFailures);
            this.historyIncomplete ||= old.historyIncomplete;
            target=this.recoverySnapshot;
          } catch { this.historyIncomplete=true; }
        }
        this.recoverySnapshot=target;
      }
      const fd=fs.openSync(temporary,'wx',0o600);
      try { fs.writeFileSync(fd,JSON.stringify({version:1,writeFailures:this.writeFailures,historyIncomplete:this.historyIncomplete})); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary,target); syncDirectory(this.directory); this.failureEvidenceStored=true;
    } catch {
      this.failureEvidenceStored=false;
      // An owned empty metadata temporary contains no unique recovery data.
      try { const stat=fs.lstatSync(temporary); if (stat.isFile()&&!stat.isSymbolicLink()&&stat.size===0) fs.unlinkSync(temporary); } catch { /* retain everything else */ }
    }
  }
  private recordFailure(): void { this.writeFailures=Math.min(Number.MAX_SAFE_INTEGER,this.writeFailures+1); this.persistFailureEvidence(); }
  private readEntry(id:string,entry:PendingEntry,tighten=false): MeteringEnvelope {
    const stat=fs.lstatSync(entry.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size>ENTRY_LIMIT) throw new Error('invalid-entry');
    this.retainedBytes+=stat.size-entry.bytes; entry.bytes=stat.size;
    const e=parse(fs.readFileSync(entry.file),id); entry.queuedAt=e.queuedAt;
    if (tighten && process.platform!=='win32') fs.chmodSync(entry.file,0o600);
    if (entry.file.endsWith('.partial')) {
      // Recovered or failed-write bytes are not acknowledged until synced.
      const fd=fs.openSync(entry.file,'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const target=path.join(this.directory,`${id}.json`);
      if (fs.existsSync(target)) throw new Error('invalid-entry');
      fs.renameSync(entry.file,target); entry.file=target;
      // Tracking precedes directory sync, so a failure cannot orphan the rename.
      syncDirectory(this.directory);
    }
    return e;
  }
  private handleReadFailure(id:string,entry:PendingEntry,error:unknown): void {
    const code=(error as NodeJS.ErrnoException).code;
    if (code==='ENOENT') {
      if (this.pending.delete(id)) { this.retainedBytes-=entry.bytes; this.lastError='invalid-entry'; this.recordFailure(); }
      return;
    }
    if (typeof code==='string') { this.lastError='queue-unwritable'; return; }
    try {
      const stat=fs.lstatSync(entry.file),target=entry.file+'.'+randomUUID()+'.invalid';
      fs.renameSync(entry.file,target); this.retainedBytes+=stat.size-entry.bytes;
      this.pending.delete(id); this.quarantined++; this.lastError='invalid-entry';
    } catch { this.lastError='queue-unwritable'; }
  }
  enqueue(observation:MeteringObservation): void {
    const id=randomUUID(),queuedAt=(this.options.now??Date.now)(),e:MeteringEnvelope={version:1,id,queuedAt,observation,sha256:digest(observation)},bytes=Buffer.from(JSON.stringify(e));
    const entry:PendingEntry={file:path.join(this.directory,`.${id}.partial`),bytes:bytes.length,queuedAt};
    try {
      const validated=parse(bytes,id);
      if (this.retainedBytes+bytes.length>(this.options.maxBytes??BACKLOG_LIMIT)) throw new Error('backlog-full');
      const fd=fs.openSync(entry.file,'wx',0o600);
      // Reserve and retain the entry as soon as its private file exists. A failed
      // write cannot leave disk bytes outside quota accounting or restart recovery.
      this.pending.set(id,entry); this.retainedBytes+=entry.bytes;
      try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const target=path.join(this.directory,`${id}.json`); fs.renameSync(entry.file,target); entry.file=target;
      syncDirectory(this.directory);
      entry.proxyGuard=proxyGuardSummary(validated.observation);
      if (!this.quarantined && !this.writeFailures && !this.historyIncomplete && this.pending.size===1) this.lastError=null;
    } catch (error) {
      if (this.pending.has(id)) {
        try { const actual=fs.lstatSync(entry.file).size; this.retainedBytes+=actual-entry.bytes; entry.bytes=actual; }
        catch { /* keep the bounded reservation when actual size is unavailable */ }
      }
      const code=error instanceof Error?error.message:'';
      this.lastError=code==='backlog-full'||code==='entry-too-large'||code==='invalid-entry'?code:'queue-unwritable';
      this.recordFailure();
      throw new Error(`Metering capture not durably queued: ${this.lastError}`,{cause:error});
    }
  }
  flush(max=64): void {
    if (this.closed) return;
    let attempted=0;
    for (const[id,entry]of this.pending) {
      if (attempted++>=max) break;
      if (this.acknowledged.has(id)) {
        try { syncDirectory(this.directory);this.acknowledged.delete(id);this.pending.delete(id);this.retainedBytes-=entry.bytes; }
        catch { this.lastError='queue-unwritable'; }
        continue;
      }
      let e:MeteringEnvelope;
      try { e=this.readEntry(id,entry); }
      catch(error) { this.handleReadFailure(id,entry,error);continue; }
      entry.proxyGuard=proxyGuardSummary(e.observation);
      try { this.consume(e); }
      catch(error) { this.lastError=/locked|busy/i.test(String(error))?'ledger-busy':'ledger-unavailable';if(this.lastError==='ledger-busy')break;continue; }
      try {
        try { fs.unlinkSync(entry.file); } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
        this.acknowledged.add(id);syncDirectory(this.directory);this.acknowledged.delete(id);this.pending.delete(id);this.retainedBytes-=entry.bytes;
      } catch { this.lastError='queue-unwritable'; }
    }
    if (!this.pending.size) this.lastError=(this.quarantined || (this.writeFailures>0 && this.lastError==='invalid-entry'))?'invalid-entry':(this.writeFailures || this.historyIncomplete)?'queue-unwritable':null;
  }
  status():MeteringBacklogStatus {
    let oldest:number|null=null;
    for(const entry of this.pending.values())if(entry.queuedAt!==null)oldest=oldest===null?entry.queuedAt:Math.min(oldest,entry.queuedAt);
    return{observedAt:(this.options.now??Date.now)(),pending:this.pending.size,quarantined:this.quarantined,writeFailures:this.writeFailures,bytes:this.retainedBytes,oldestQueuedAt:oldest,lastError:this.lastError,failureEvidenceStored:this.failureEvidenceStored,historyIncomplete:this.historyIncomplete};
  }
  /** Read-only, content-free view of queued Ollama proxy completions not yet applied to SQLite. */
  pendingProxyEvents(sinceTs:number,untilTs:number):PendingProxyGuardEvent[] {
    if(!Number.isSafeInteger(sinceTs)||!Number.isSafeInteger(untilTs)||untilTs<sinceTs)return[];
    const out:PendingProxyGuardEvent[]=[];
    for(const entry of this.pending.values()) {
      const event=entry.proxyGuard;
      if(event&&event.ts>=sinceTs&&event.ts<=untilTs)out.push({...event});
    }
    return out;
  }
  close():void { this.closed=true;if(this.timer)clearInterval(this.timer); }
}

function proxyGuardSummary(observation:MeteringObservation):PendingProxyGuardEvent|undefined {
  if(observation.kind!=='event')return undefined;
  const event=observation.event;
  if(event.source!=='ollama-proxy'||!Number.isSafeInteger(event.ts)||event.ts<0
    ||(event.durationMs!==undefined&&(!Number.isSafeInteger(event.durationMs)||event.durationMs<0))
    ||!Number.isSafeInteger(event.tokens?.output)||event.tokens.output<0
    ||(event.engine!==undefined&&typeof event.engine!=='string'))return undefined;
  return{ts:event.ts,...(event.durationMs!==undefined?{durationMs:event.durationMs}:{}),outputTokens:event.tokens.output,...(event.engine!==undefined?{engine:event.engine}:{})};
}
