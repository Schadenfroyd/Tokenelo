import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { ReportProcess } from '../../src/daemon/report-process.js';
import { LinuxReportCgroup, linuxReportUnitArgs } from '../../src/daemon/report-linux-unit.js';

it('rejects unowned service names before launch', () => {
  expect(() => linuxReportUnitArgs('existing.service', '/usr/bin/node', [], '/tmp')).toThrow();
});

it('passes literal dollars through systemd ExecStart without evaluating arguments', () => {
  const args = linuxReportUnitArgs(`tokenelo-report-${'a'.repeat(32)}.service`, '/tmp/$node', ['$literal'], '/tmp');
  expect(args.slice(-2)).toEqual(['/tmp/$$node', '$$literal']);
});

it('clears inherited Electron mode and passes only the exact Node-run sentinel without leaking private values', () => {
  const unit = `tokenelo-report-${'b'.repeat(32)}.service`;
  const build = (env: NodeJS.ProcessEnv) => linuxReportUnitArgs(unit, '/usr/bin/node', [], '/tmp', env);
  const hasElectronModeUnset = (args: string[]) => {
    const environmentArgs = args.slice(args.indexOf('/usr/bin/env'));
    return environmentArgs.some((arg, index) => arg === '-u' && environmentArgs[index + 1] === 'ELECTRON_RUN_AS_NODE');
  };
  const modeAssignments = (args: string[]) => args.filter(arg => arg.startsWith('ELECTRON_RUN_AS_NODE='));

  const enabledEnv: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    TOKENELO_PRIVATE_MARKER: 'private-env-secret-marker',
  };
  const enabledBefore = { ...enabledEnv };
  const enabledArgs = build(enabledEnv);
  expect(hasElectronModeUnset(enabledArgs)).toBe(true);
  expect(modeAssignments(enabledArgs)).toEqual(['ELECTRON_RUN_AS_NODE=1']);
  expect(enabledArgs).toContain('TZ=UTC');
  expect(enabledArgs).toContain('LANG=C.UTF-8');
  expect(enabledArgs.join('\0')).not.toContain('private-env-secret-marker');
  expect(enabledEnv).toEqual(enabledBefore);

  for (const mode of [undefined, '0', 'private-run-mode-secret']) {
    const env: NodeJS.ProcessEnv = { TOKENELO_PRIVATE_MARKER: 'private-env-secret-marker' };
    if (mode !== undefined) env.ELECTRON_RUN_AS_NODE = mode;
    const before = { ...env };
    const args = build(env);
    expect(hasElectronModeUnset(args)).toBe(true);
    expect(modeAssignments(args)).toEqual([]);
    expect(args.join('\0')).not.toContain('private-env-secret-marker');
    if (mode === 'private-run-mode-secret') expect(args.join('\0')).not.toContain(mode);
    expect(env).toEqual(before);
  }
});

it('env assignment-looking executable names stay positional; nested cgroups are rejected before filesystem reads', () => {
  const unit = `tokenelo-report-${'a'.repeat(32)}.service`;
  const args = linuxReportUnitArgs(unit, '/tmp/a=b/node', ['arg'], '/tmp');
  expect(args.slice(-6)).toEqual(['/bin/sh','-c','exec "$$@"','--','/tmp/a=b/node','arg']);
  const uid = process.getuid?.();
  expect(() => new LinuxReportCgroup({pid:1,birth:'0',cgroup:`/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/nested/${unit}`}, unit)).toThrow('unowned report cgroup');
});

it('retained cgroup kill ENODEV is already gone; permission failure stays an error', () => {
  const group = Object.create(LinuxReportCgroup.prototype) as LinuxReportCgroup;
  const write = vi.spyOn(fs, 'writeSync').mockImplementation(() => { throw Object.assign(new Error('removed'), { code: 'ENODEV' }); });
  try {
    expect(() => group.terminate()).not.toThrow();
    write.mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(() => group.terminate()).toThrow('denied');
  } finally { write.mockRestore(); }
});

it.skipIf(process.platform !== 'linux')('Linux reports inherit daemon timezone and private environment before Worker import', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linux-environment-')), worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, `const{parentPort}=require('worker_threads');parentPort.postMessage({tz:process.env.TZ,marker:process.env.TOKENELO_BOUNDARY_ENV_PROOF,path:process.env.PATH,offset:new Date('2026-01-01T00:00:00Z').getTimezoneOffset()});parentPort.close();`);
  const names = ['TZ', 'TOKENELO_BOUNDARY_ENV_PROOF']; const saved = names.map(n => process.env[n]);
  let report: ReportProcess | undefined;
  try {
    process.env.TZ = 'Asia/Tokyo'; process.env.TOKENELO_BOUNDARY_ENV_PROOF = 'daemon-private-marker';
    report = new ReportProcess(pathToFileURL(worker), {}, 1024); report.on('error', () => {});
    const exit = new Promise(resolve => report!.once('exit', resolve));
    expect(await new Promise(resolve => report!.once('message', resolve))).toEqual({tz:'Asia/Tokyo',marker:'daemon-private-marker',path:process.env.PATH,offset:-540});
    await exit;
  } finally {
    for (let i = 0; i < names.length; i++) if (saved[i] === undefined) delete process.env[names[i]]; else process.env[names[i]] = saved[i];
    await report?.terminate(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

it.skipIf(process.platform !== 'linux')('Linux bootstrap EPIPE retires a native FIFO-blocked Worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linux-native-pipe-'));
  const fifo = path.join(root, 'owned.fifo'), worker = path.join(root, 'worker.cjs'), entry = path.join(root, 'entry.mjs');
  execFileSync('/usr/bin/mkfifo', [fifo], { windowsHide: true });
  fs.writeFileSync(worker, `const fs=require('fs'),{parentPort}=require('worker_threads');parentPort.postMessage({type:'ready'});fs.readFileSync(${JSON.stringify(fifo)});parentPort.close();`);
  const compiledEntry = new URL('../../src/daemon/report-process-entry.js', import.meta.url);
  const realEntry = fs.existsSync(compiledEntry) ? compiledEntry : new URL('../../src/daemon/report-process-entry.ts', import.meta.url);
  // A root-side progress write has no retirement callback. Keep the actual entry
  // and its native-blocked Worker, then break the root's output transport.
  fs.writeFileSync(entry, `await import(${JSON.stringify(realEntry.href)});setInterval(()=>process.stdout.write(JSON.stringify({channel:'worker',message:{type:'probe'}})+'\\n'),50).unref();`);
  const report = new ReportProcess(pathToFileURL(worker), {}, 1024, {entryUrl:pathToFileURL(entry)});
  const owned = report as unknown as { child: ChildProcessWithoutNullStreams; linuxUnit: string };
  report.on('error', () => {});
  const exit = new Promise<number>(resolve => report.once('exit', resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>(resolve => report.on('message', message => { if (message.type === 'ready') resolve(); }));
    const pid = execFileSync('/usr/bin/systemctl', ['--user', 'show', owned.linuxUnit, '--property=MainPID', '--value'], { encoding:'utf8', windowsHide:true }).trim();
    expect(/^\d+$/.test(pid)).toBe(true);
    let blocked = false; const deadline = Date.now() + 2000;
    while (!blocked && Date.now() < deadline) {
      blocked = fs.readdirSync(`/proc/${pid}/task`).some(tid => fs.readFileSync(`/proc/${pid}/task/${tid}/wchan`, 'utf8').trim() === 'wait_for_partner');
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(blocked).toBe(true);
    owned.child.stdout.destroy();
    // Finite fixture assertion only, not a report latency/lifetime guarantee.
    expect(await Promise.race([exit, new Promise(resolve => { timer = setTimeout(() => resolve('unretired'), 2000); })])).not.toBe('unretired');
  } finally { clearTimeout(timer); await report.terminate(); fs.rmSync(root, {recursive:true,force:true}); }
}, 10000);

it.skipIf(process.platform !== 'linux').each(['normal', 'cancel'] as const)(
  'Linux report %s retires a detached descendant before releasing ownership', async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linux-owned-'));
    const child = path.join(root, 'child.cjs'), worker = path.join(root, 'worker.cjs');
    fs.writeFileSync(child, `const fs=require('fs');let n=0;const pulse=setInterval(()=>fs.writeFileSync(${JSON.stringify(path.join(root, 'beat'))},String(++n)),20);setTimeout(()=>{clearInterval(pulse);fs.writeFileSync(${JSON.stringify(path.join(root, 'fallback'))},'expired');process.exit(88)},12000);`);
    fs.writeFileSync(worker, `const fs=require('fs'),{spawn}=require('child_process'),{parentPort}=require('worker_threads');spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();const pulse=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(path.join(root, 'beat'))}))return;clearInterval(pulse);parentPort.postMessage({type:'ready'});${mode === 'normal' ? 'parentPort.close();' : 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);'}},5);`);
    const report = new ReportProcess(pathToFileURL(worker), {}, 1024);
    const errors: unknown[] = []; report.on('error', error => errors.push(error));
    const exit = new Promise<number>(resolve => report.once('exit', resolve));
    try {
      await new Promise<void>(resolve => report.once('message', () => resolve()));
      if (mode === 'cancel') void report.terminate();
      await exit;
      expect(errors).toEqual([]);
      const beat = fs.readFileSync(path.join(root, 'beat'));
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(fs.readFileSync(path.join(root, 'beat'))).toEqual(beat);
      expect(fs.existsSync(path.join(root, 'fallback'))).toBe(false);
    } finally { await report.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 10000);
