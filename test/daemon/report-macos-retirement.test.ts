import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { ReportProcess } from '../../src/daemon/report-process.js';

const nativeSetTimeout = setTimeout;
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-mac-group-observation-'));
  const entry = path.join(root, 'entry.mjs');
  fs.writeFileSync(entry, String.raw`process.stdout.write(JSON.stringify({channel:'worker',message:{type:'progress',phase:'reading-usage'}})+'\n');process.stdin.resume();setTimeout(()=>process.exit(88),15000);`);
  const report = new ReportProcess(pathToFileURL(entry), {}, 1024, { entryUrl: pathToFileURL(entry) });
  const errors: unknown[] = []; report.on('error', error => errors.push(error));
  await new Promise<void>((resolve, reject) => {
    const timer = nativeSetTimeout(() => reject(new Error('Owned fixture readiness deadline')), 4000);
    report.once('message', () => { clearTimeout(timer); resolve(); });
  });
  const child = (report as unknown as { child: ChildProcess }).child;
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  return { root, report, child, closed, errors };
}

it.skipIf(process.platform !== 'darwin')('mac retirement: EPERM holds capacity until an actual ESRCH observation', async () => {
  const f = await fixture(), nativeKill = process.kill.bind(process); let permitProof = false, observations = 0, exited = false, quarantined = false;
  f.report.on('exit', () => { exited = true; }); f.report.on('quarantined', () => { quarantined = true; });
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -f.child.pid! && signal === 0 && !permitProof) { observations++; throw Object.assign(new Error('held group observation'), { code: 'EPERM' }); }
    return nativeKill(pid, signal);
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const finished = f.report.terminate(); await f.closed;
    expect(observations).toBeGreaterThan(0); expect(exited).toBe(false); expect(quarantined).toBe(false);
    await vi.advanceTimersByTimeAsync(50); expect(exited).toBe(false); expect(quarantined).toBe(false);
    // Only the real OS ESRCH is accepted, never the injected permission failure.
    permitProof = true; await vi.advanceTimersByTimeAsync(50); expect(await finished).toBe(1);
    expect(exited).toBe(true); expect(quarantined).toBe(false); expect(f.errors).toHaveLength(0);
    const afterCloseSignals = spy.mock.calls.filter(([pid, signal]) => pid === -f.child.pid! && signal !== 0);
    expect(afterCloseSignals).toHaveLength(1); expect(afterCloseSignals[0]![1]).toBe('SIGKILL');
  } finally { spy.mockRestore(); await vi.advanceTimersByTimeAsync(20); vi.useRealTimers(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 10000);

it.skipIf(process.platform !== 'darwin')('mac retirement: permanent EPERM quarantines at the unchanged proof boundary without an exit receipt', async () => {
  const f = await fixture(), nativeKill = process.kill.bind(process); let exited = false, quarantined = false;
  f.report.on('exit', () => { exited = true; }); f.report.on('quarantined', () => { quarantined = true; });
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -f.child.pid! && signal === 0) throw Object.assign(new Error('unproved group'), { code: 'EPERM' });
    return nativeKill(pid, signal);
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); void f.report.terminate(); await f.closed;
    await vi.advanceTimersByTimeAsync(18499); expect(quarantined).toBe(false); expect(exited).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(quarantined).toBe(true); expect(exited).toBe(false); expect(f.errors).toHaveLength(1);
    expect(spy.mock.calls.filter(([pid, signal]) => pid === -f.child.pid! && signal !== 0)).toHaveLength(1);
  } finally { spy.mockRestore(); await vi.advanceTimersByTimeAsync(20); vi.useRealTimers(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 10000);

it.skipIf(process.platform !== 'darwin')('mac retirement: other observation errors stay fail closed', async () => {
  const f = await fixture(), nativeKill = process.kill.bind(process); let exited = false, quarantined = false;
  f.report.on('exit', () => { exited = true; }); f.report.on('quarantined', () => { quarantined = true; });
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === -f.child.pid! && signal === 0) throw Object.assign(new Error('invalid observation'), { code: 'EINVAL' });
    return nativeKill(pid, signal);
  });
  try {
    void f.report.terminate(); await f.closed; expect(quarantined).toBe(true); expect(exited).toBe(false); expect(f.errors).toHaveLength(1);
    expect(spy.mock.calls.filter(([pid, signal]) => pid === -f.child.pid! && signal !== 0)).toHaveLength(1);
  } finally { spy.mockRestore(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 10000);
