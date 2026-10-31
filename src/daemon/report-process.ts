import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { LinuxReportCgroup, linuxReportUnitArgs } from './report-linux-unit.js';

/** Shared raw control-frame limit; Windows base64 envelope has separate native headroom. */
export const REPORT_PROCESS_MAX_CONTROL_BYTES = 8 * 1024 ** 2;
function controlBytes(message: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(message) + '\n');
  if (bytes.length > REPORT_PROCESS_MAX_CONTROL_BYTES) throw new RangeError('report control exceeds its byte limit');
  return bytes;
}

/** Parent-owned containment, independent of a blocked report Worker. An exit event means
 * the outer process and its owned job/group are gone, not merely that the thread exited. */
export class ReportProcess extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly nonce = randomBytes(16).toString('hex');
  private readonly windows = process.platform === 'win32';
  private readonly linux = process.platform === 'linux';
  private readonly linuxUnit = `tokenelo-report-${this.nonce}.service`;
  private linuxCgroup?: LinuxReportCgroup;
  private linuxStart?: Buffer;
  private linuxOwnership?: Buffer;
  private linuxPendingControls: Buffer[] = [];
  private readonly host: string;
  private pending: string[] = [];
  private pendingBytes = 0;
  private parsingFailed = false;
  private failureReported = false;
  private readonly decoder = new StringDecoder('utf8');
  private outerPending = '';
  private nativeParsingFailed = false;
  private workerExitCode?: number;
  private nativeRetired = false;
  private nativeStarted = false;
  private nativeNotStarted = false;
  private stopping = false;
  private closed = false;
  private quarantined = false;
  private proofTimer?: ReturnType<typeof setTimeout>;
  private observer?: ChildProcessWithoutNullStreams;
  private readonly finished: Promise<number>;
  private finish!: (code: number) => void;
  constructor(workerUrl: URL, workerData: unknown, private readonly maxBytes: number, opts: { entryUrl?: URL } = {}) {
    super();
    const compiled = new URL('./report-process-entry.js', import.meta.url);
    const development = !fs.existsSync(compiled);
    // Test seam for transport faults; ReportReads never supplies an alternate entry.
    const entry = opts.entryUrl ?? (development ? new URL('./report-process-entry.ts', import.meta.url) : compiled);
    const args = [...(development ? ['--import', 'tsx'] : []), fileURLToPath(entry)];
    const linuxArgs = [...(development ? ['--import', 'tsx'] : []),
      fileURLToPath(new URL(development ? './report-linux-entry.ts' : './report-linux-entry.js', import.meta.url)), entry.href];
    this.host = fileURLToPath(new URL(development ? '../../native/report-job-host.exe' : './native/report-job-host.exe', import.meta.url));
    // Reject oversized configuration before creating any report process on every OS.
    const start = controlBytes({ type: 'start', workerUrl: workerUrl.href, workerData, development });
    this.finished = new Promise(resolve => { this.finish = resolve; });
    const env = { ...process.env };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    if (this.linux) this.linuxOwnership = controlBytes({ type: 'owned', unit: this.linuxUnit, env });
    this.child = this.windows
      ? spawn(this.host, [process.execPath, Buffer.from(JSON.stringify(args)).toString('base64'), this.nonce], { windowsHide: true, env, stdio: 'pipe' })
      : this.linux ? spawn('/usr/bin/systemd-run', linuxReportUnitArgs(this.linuxUnit, process.execPath, linuxArgs, process.cwd(), env), { windowsHide: true, env, stdio: 'pipe' })
      : spawn(process.execPath, args, { detached: true, windowsHide: true, env, stdio: 'pipe' });
    this.child.stdout.on('data', bytes => this.windows ? this.nativeData(bytes) : this.workerData(bytes));
    this.child.stderr.resume();
    this.child.stdin.on('error', () => { /* Terminal close decides whether containment is proved. */ });
    this.child.once('error', error => this.reportFailure(error));
    this.child.once('close', (code, signal) => { void this.retire(code, signal); });
    // Linux must be bound to retained kernel handles before the Worker can start.
    if (this.linux) this.linuxStart = start;
    else this.writeControl(start);
  }
  postMessage(message: unknown): void {
    if (this.closed || this.quarantined) return;
    const bytes = controlBytes(message);
    if (this.linuxStart) {
      if (this.linuxPendingControls.reduce((sum, item) => sum + item.length, bytes.length) > REPORT_PROCESS_MAX_CONTROL_BYTES)
        throw new RangeError('pending report controls exceed their byte limit');
      this.linuxPendingControls.push(bytes);
    } else this.writeControl(bytes);
  }
  private writeControl(bytes: Buffer): void {
    this.child.stdin.write(this.windows ? JSON.stringify({ channel: 'stdin', base64: bytes.toString('base64') }) + '\n' : bytes);
  }
  terminate(): Promise<number> {
    this.guardProof();
    if (!this.stopping && !this.closed) {
      this.stopping = true;
      if (this.windows) this.child.stdin.write(JSON.stringify({ channel: 'stop', nonce: this.nonce }) + '\n');
      else if (this.linux) {
        if (this.linuxCgroup) { try { this.linuxCgroup.terminate(); } catch (error) { this.reportFailure(error); } }
        // Before the startup receipt, leave the Worker unstarted. A late verified
        // receipt performs cancellation; an unproved close quarantines capacity.
      }
      else if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
        // Only this live owned group leader is targeted. No kill occurs after leader exit.
        try { process.kill(-this.child.pid, 'SIGKILL'); } catch (error) { this.reportFailure(error); }
      }
    }
    return this.finished;
  }
  private workerData(bytes: Buffer): void {
    if (this.parsingFailed || this.quarantined) return;
    const text = this.decoder.write(bytes);
    let offset = 0;
    for (;;) {
      const newline = text.indexOf('\n', offset);
      const part = newline < 0 ? text.slice(offset) : text.slice(offset, newline);
      this.pendingBytes += Buffer.byteLength(part);
      // Count and scan each newly arrived fragment once, rather than rescanning a
      // multi-megabyte frame after every 16KiB native chunk. Join only at the newline.
      if (this.pendingBytes > this.maxBytes * 6 + 4096) { this.fail(); return; }
      this.pending.push(part);
      if (newline < 0) return;
      const line = this.pending.join(''); this.pending = []; this.pendingBytes = 0;
      try {
        const frame = JSON.parse(line);
        if (this.linux && frame.channel === 'process' && frame.event === 'linux_started'
          && frame.unit === this.linuxUnit && !this.linuxCgroup && this.linuxStart) {
          this.linuxCgroup = new LinuxReportCgroup(frame, this.linuxUnit);
          const start = this.linuxStart; this.linuxStart = undefined;
          if (this.stopping) this.linuxCgroup.terminate();
          else {
            this.writeControl(this.linuxOwnership!);
            this.writeControl(start);
            for (const bytes of this.linuxPendingControls) this.writeControl(bytes);
          }
          this.linuxPendingControls = [];
          this.linuxOwnership = undefined;
        }
        else if (this.linux && !this.linuxCgroup) this.fail();
        else if (frame.channel === 'worker') this.emit('message', frame.message);
        else if (frame.channel === 'process' && frame.event === 'worker_error') this.reportFailure(new Error('report worker unavailable'));
        else if (frame.channel === 'process' && frame.event === 'worker_exit' && Number.isSafeInteger(frame.code)) this.workerExitCode = frame.code;
        else this.fail();
      } catch { this.fail(); }
      if (this.parsingFailed) return;
      offset = newline + 1;
      if (offset === text.length) return;
    }
  }
  private nativeData(bytes: Buffer): void {
    if (this.nativeParsingFailed) return;
    this.outerPending += bytes.toString('utf8');
    let newline: number;
    while ((newline = this.outerPending.indexOf('\n')) >= 0) {
      const line = this.outerPending.slice(0, newline); this.outerPending = this.outerPending.slice(newline + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.channel === 'stdout' && typeof frame.base64 === 'string') this.workerData(Buffer.from(frame.base64, 'base64'));
        else if (frame.channel === 'stderr') { /* Original Worker stderr was drained privately. */ }
        else if (frame.channel === 'host' && frame.event === 'retired' && frame.nonce === this.nonce && frame.activeProcesses === 0
          && this.nativeStarted && !this.nativeNotStarted && !this.nativeRetired) this.nativeRetired = true;
        else if (frame.channel === 'host' && frame.event === 'started' && frame.nonce === this.nonce
          && Number.isSafeInteger(frame.pid) && frame.pid > 0 && !this.nativeStarted && !this.nativeNotStarted && !this.nativeRetired) this.nativeStarted = true;
        else if (frame.channel === 'host' && frame.event === 'not_started' && frame.nonce === this.nonce
          && frame.processCreated === false && !this.nativeStarted && !this.nativeRetired && !this.nativeNotStarted) {
          // This nonce-bound helper receipt proves no child was created. It is not
          // a zero-count Job observation and never excuses failure after startup.
          this.nativeNotStarted = true; this.reportFailure(new Error('report process could not start'));
        }
        else { this.nativeParsingFailed = true; this.fail(); return; }
      } catch { this.nativeParsingFailed = true; this.fail(); return; }
    }
    if (Buffer.byteLength(this.outerPending) > 64 * 1024) { this.nativeParsingFailed = true; this.fail(); }
  }
  private reportFailure(error: unknown): void {
    if (this.failureReported) return;
    this.failureReported = true; this.emit('error', error);
  }
  private fail(): void {
    this.parsingFailed = true; this.pending = []; this.pendingBytes = 0;
    // A bad worker payload does not invalidate native ownership receipts already
    // buffered behind it. Clear native bytes only when the native framing failed.
    if (this.nativeParsingFailed) {
      this.outerPending = ''; this.nativeNotStarted = false; this.nativeRetired = false;
    }
    this.reportFailure(new Error('report containment unavailable')); void this.terminate();
    // A failed ownership receipt cannot authorize importing the entry. Close our
    // pipe immediately; capacity still requires proof or remains quarantined.
    if (this.linux && this.linuxStart) this.child.stdin.end();
  }
  private async observeWindowsJob(): Promise<boolean> {
    return new Promise(resolve => {
      const observer = spawn(this.host, ['observe', this.nonce], { windowsHide: true, stdio: 'pipe' });
      this.observer = observer;
      let output = '', valid = false;
      observer.stdin.on('error', () => resolve(false));
      observer.stdin.end(); observer.stderr.resume();
      observer.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 4096) observer.stdout.pause(); });
      observer.on('error', () => resolve(false));
      observer.once('close', code => {
        try { const frame = JSON.parse(output.trim()); valid = code === 0 && frame.nonce === this.nonce && frame.channel === 'host'
          && frame.event === 'job_zero' && frame.activeProcesses === 0; } catch { /* Absence is not an actual zero-count receipt. */ }
        resolve(valid);
      });
    });
  }
  private async retire(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.closed = true;
    // A late outer close cannot start a new observer after quarantine retired its
    // existing observer and proof timer. Unproved capacity stays quarantined.
    if (this.quarantined) return;
    this.guardProof();
    if (this.windows && this.child.pid && !this.nativeRetired && !this.nativeNotStarted) {
      if (!await this.observeWindowsJob()) { this.quarantine(); return; }
    } else if (this.linux && this.child.pid) {
      if (!this.linuxCgroup) { this.quarantine(); return; }
      try {
        while (!this.linuxCgroup.empty()) {
          if (this.quarantined) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } catch { this.quarantine(); return; }
    } else if (!this.windows && this.child.pid) {
      // An inherited-group descendant can outlive its leader; do not release the slot
      // until the OS reports no group. This is observation only, never a late PID kill.
      for (;;) {
        if (this.quarantined) return;
        try { process.kill(-this.child.pid, 0); }
        catch (error) {
          const observed = (error as NodeJS.ErrnoException).code;
          if (observed === 'ESRCH') break;
          // Darwin can report EPERM for an existing group with no signal-eligible
          // member. It proves neither liveness nor absence: retain capacity and
          // observe only, under the existing proof guard. Never signal a late PID.
          if (process.platform !== 'darwin' || observed !== 'EPERM') { this.quarantine(); return; }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const logical = this.workerExitCode ?? (signal ? 1 : code ?? 1);
    if (this.quarantined) return;
    clearTimeout(this.proofTimer); this.linuxCgroup?.close(); this.finish(logical); this.emit('exit', logical);
  }
  private guardProof(): void {
    if (this.proofTimer || this.quarantined) return;
    // An error boundary for cleanup, not a response-time guarantee or wider read
    // deadline. Reports already reject at their original admission/cancel budget.
    this.proofTimer = setTimeout(() => this.quarantine(), 18_500);
  }
  private quarantine(): void {
    if (this.quarantined) return;
    this.quarantined = true;
    clearTimeout(this.proofTimer);
    if (this.linux) {
      // End our input even when ownership could not be proved. The bootstrap
      // closes without loading a Worker; never signal an unverified unit by name.
      this.child.stdin.end();
      if (this.linuxCgroup) { try { this.linuxCgroup.terminate(); } catch { /* Unproved retirement stays quarantined. */ } }
    }
    // Retire only our QUERY-only observer. Never signal an unproved tree by PID.
    if (this.observer && this.observer.exitCode === null && this.observer.signalCode === null) this.observer.kill('SIGKILL');
    this.linuxCgroup?.close();
    this.reportFailure(new Error('report process cleanup unproved'));
    this.emit('quarantined'); // Never emit exit or release capacity without proof.
  }
}
