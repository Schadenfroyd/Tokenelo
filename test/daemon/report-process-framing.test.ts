import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ReportProcess, REPORT_PROCESS_MAX_CONTROL_BYTES } from '../../src/daemon/report-process.js';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

it.each(['bad-frames', 'overflow', 'worker-error-then-bad'] as const)('report transport: %s fails once and retires its real owned process', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-transport-fault-')), entry = path.join(root, 'entry.mjs');
  const body = mode === 'worker-error-then-bad' ? `process.stdout.write(JSON.stringify({channel:'process',event:'worker_error'})+'\\n');setTimeout(()=>process.stdout.write('bad\\n'),5);` : mode === 'bad-frames' ? `process.stdout.write('bad\\n');setTimeout(()=>process.stdout.write('bad\\n'),5);`
    : `process.stdout.write(Buffer.alloc(32768,120));setTimeout(()=>process.stdout.write(Buffer.alloc(32768,120)),5);`;
  fs.writeFileSync(entry, `${body}process.stdin.resume();setTimeout(()=>process.exit(88),15000);`);
  const report = new ReportProcess(pathToFileURL(entry), {}, 64, { entryUrl: pathToFileURL(entry) });
  const errors: unknown[] = [];
  // The single-listener case used to throw on a second error. The adapter now latches
  // failures, and ReportReads independently keeps a persistent listener for cleanup.
  report.once('error', error => errors.push(error));
  try {
    const code = await new Promise<number>(resolve => report.once('exit', resolve));
    expect(code).not.toBe(0); expect(errors).toHaveLength(1);
  } finally { await report.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

it.skipIf(process.platform !== 'win32')('report transport quarantines helper-crash job absence without pretending retirement', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-helper-quarantine-')), entry = path.join(root, 'entry.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root, 'ready.json'))},JSON.stringify({pid:process.pid}));process.stdin.resume();setInterval(()=>{},1000);`);
  const report = new ReportProcess(pathToFileURL(entry), {}, 1024, { entryUrl: pathToFileURL(entry) });
  let exited = false; report.on('error', () => {}); report.on('exit', () => { exited = true; });
  const terminal = new Promise<'quarantined' | 'proved'>(resolve => { report.once('quarantined', () => resolve('quarantined')); report.once('exit', () => resolve('proved')); });
  try {
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(path.join(root, 'ready.json')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(fs.existsSync(path.join(root, 'ready.json'))).toBe(true);
    // Fault injection targets the exact spawned GUI host's retained ChildProcess handle.
    // Production never exposes this test access or kills a tree from a sampled PID.
    (report as unknown as { child: ChildProcess }).child.kill('SIGKILL');
    const result = await terminal;
    // QUERY may open before the Job is destroyed and obtain actual zero; absence
    // after destruction remains unproved and must quarantine. Either is valid.
    expect(exited).toBe(result === 'proved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

it('report transport preserves split UTF8 across many native frames and emits the complete result once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-transport-utf8-')), entry = path.join(root, 'entry.mjs');
  const value = { text: 'ÃŽÂ»Ã©â€ºÂª'.repeat(20000), nested: { quote: 'a"b\\c' } };
  fs.writeFileSync(entry, `const frame=Buffer.from(JSON.stringify({channel:'worker',message:{type:'result',json:JSON.stringify(${JSON.stringify(value)})}})+'\\n');
    for(let i=0;i<frame.length;i+=1023)process.stdout.write(frame.subarray(i,i+1023));
    process.stdout.write(JSON.stringify({channel:'process',event:'worker_exit',code:0})+'\\n',()=>process.exit(0));`);
  const report = new ReportProcess(pathToFileURL(entry), {}, 1024 * 1024, { entryUrl: pathToFileURL(entry) });
  const errors: unknown[] = [], messages: Array<{ type: string; json: string }> = [];
  report.on('error', error => errors.push(error)); report.on('message', message => messages.push(message));
  try {
    expect(await new Promise<number>(resolve => report.once('exit', resolve))).toBe(0);
    expect(errors).toEqual([]); expect(messages).toHaveLength(1); expect(JSON.parse(messages[0]!.json)).toEqual(value);
  } finally { await report.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

it('late outer close after quarantine does not launch a new unowned observer', async () => {
  const report = Object.create(ReportProcess.prototype) as ReportProcess;
  const state = report as unknown as { quarantined: boolean; closed: boolean; retire: (code: number, signal: null) => Promise<void>; observeWindowsJob: () => Promise<boolean>; guardProof: () => void };
  state.quarantined = true; let observers = 0, timers = 0;
  state.observeWindowsJob = async () => { observers++; return false; };
  state.guardProof = () => { timers++; };
  await state.retire(1, null);
  expect(state.closed).toBe(true); expect(observers).toBe(0); expect(timers).toBe(0);
});

it('oversized native frame clears its buffer and ignores later chunks after failure', () => {
  const report = Object.create(ReportProcess.prototype) as ReportProcess;
  const state = report as unknown as { outerPending: string; parsingFailed: boolean; nativeData: (bytes: Buffer) => void; reportFailure: () => void; terminate: () => Promise<number> };
  state.outerPending = ''; state.parsingFailed = false; let failures = 0, stops = 0;
  state.reportFailure = () => { failures++; }; state.terminate = async () => { stops++; return 1; };
  state.nativeData(Buffer.alloc(65537, 120)); state.nativeData(Buffer.alloc(65537, 120));
  expect(state.outerPending).toBe(''); expect(state.parsingFailed).toBe(true);
  expect(failures).toBe(1); expect(stops).toBe(1);
});

it('keeps a valid retirement receipt coalesced after a malformed worker frame', () => {
  const report = Object.create(ReportProcess.prototype) as ReportProcess;
  const state = report as unknown as { nativeData: (bytes: Buffer) => void; nativeRetired: boolean };
  Object.assign(report, { nonce: 'test-owner', nativeStarted: true, decoder: new StringDecoder('utf8'), pending: [], pendingBytes: 0,
    outerPending: '', nativeParsingFailed: false, parsingFailed: false, maxBytes: 64,
    reportFailure: () => {}, terminate: async () => 1 });
  state.nativeData(Buffer.from(JSON.stringify({ channel: 'stdout', base64: Buffer.from('bad\n').toString('base64') }) + '\n'
    + JSON.stringify({ channel: 'host', event: 'retired', activeProcesses: 0, nonce: 'test-owner' }) + '\n'));
  expect(state.nativeRetired).toBe(true);
});

it.skipIf(process.platform !== 'win32')('native no-child receipt retires a failed launch without quarantining', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  const entry = pathToFileURL(path.join(os.tmpdir(), 'tokenelo-never-created.mjs'));
  let report: ReportProcess;
  Object.defineProperty(process, 'execPath', { ...descriptor, value: path.join(os.tmpdir(), 'tokenelo-no-such-node.exe') });
  try { report = new ReportProcess(entry, {}, 1024, { entryUrl: entry }); }
  finally { Object.defineProperty(process, 'execPath', descriptor); }
  let quarantined = false; const errors: unknown[] = [];
  report!.on('quarantined', () => { quarantined = true; }); report!.on('error', error => errors.push(error));
  expect(await new Promise<number>(resolve => report!.once('exit', resolve))).toBe(1);
  expect(quarantined).toBe(false); expect(errors).toHaveLength(1);
}, 10000);

it('accepts a two-MiB raw start payload through the real control transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-large-control-')), entry = path.join(root, 'entry.mjs');
  fs.writeFileSync(entry, `import readline from 'node:readline';const input=readline.createInterface({input:process.stdin});input.once('line',line=>{
    const packet=JSON.parse(line);process.stdout.write(JSON.stringify({channel:'worker',message:{received:packet.workerData.text.length}})+'\\n');
    process.stdout.write(JSON.stringify({channel:'process',event:'worker_exit',code:0})+'\\n',()=>process.exit(0));});`);
  const report = new ReportProcess(pathToFileURL(entry), { text: 'x'.repeat(2 * 1024 ** 2) }, 1024, { entryUrl: pathToFileURL(entry) });
  const messages: unknown[] = []; report.on('error', () => {}); report.on('message', message => messages.push(message));
  try {
    expect(await new Promise<number>(resolve => report.once('exit', resolve))).toBe(0);
    expect(messages).toEqual([{ received: 2 * 1024 ** 2 }]);
  } finally { await report.terminate(); fs.rmSync(root, { recursive: true, force: true }); }
}, 10000);

it('refuses oversized start data before starting a report process on any platform', () => {
  const entry = pathToFileURL(path.join(os.tmpdir(), 'tokenelo-oversized-start.mjs'));
  expect(() => new ReportProcess(entry, { text: 'x'.repeat(REPORT_PROCESS_MAX_CONTROL_BYTES) }, 1024, { entryUrl: entry }))
    .toThrow('report control exceeds its byte limit');
});

it('a contradictory native startup frame invalidates the no-child receipt', () => {
  const report = Object.create(ReportProcess.prototype) as ReportProcess;
  const state = report as unknown as { nativeData: (bytes: Buffer) => void; nativeNotStarted: boolean; nativeParsingFailed: boolean };
  Object.assign(report, { nonce: 'test-owner', outerPending: '', nativeParsingFailed: false, nativeStarted: false,
    nativeNotStarted: false, reportFailure: () => {}, terminate: async () => 1 });
  state.nativeData(Buffer.from(JSON.stringify({ channel: 'host', event: 'not_started', processCreated: false, nonce: 'test-owner' }) + '\n'
    + JSON.stringify({ channel: 'host', event: 'started', nonce: 'test-owner' }) + '\n'));
  expect(state.nativeNotStarted).toBe(false); expect(state.nativeParsingFailed).toBe(true);
});

it.each([
  { sequence: ['retired'] }, { sequence: ['not_started', 'retired'] }, { sequence: ['started', 'retired', 'not_started'] },
  { sequence: ['started', 'started'] }, { sequence: ['started', 'retired', 'retired'] },
])('invalid native receipt order %j discards startup and retirement proof', ({ sequence }) => {
  const report = Object.create(ReportProcess.prototype) as ReportProcess;
  const state = report as unknown as { nativeData: (bytes: Buffer) => void; nativeNotStarted: boolean; nativeRetired: boolean; nativeParsingFailed: boolean };
  Object.assign(report, { nonce: 'test-owner', outerPending: '', nativeParsingFailed: false, nativeStarted: false,
    nativeRetired: false, nativeNotStarted: false, reportFailure: () => {}, terminate: async () => 1 });
  const lines = sequence.map(event => JSON.stringify({ channel: 'host', event, nonce: 'test-owner', pid: 123,
    ...(event === 'retired' ? { activeProcesses: 0 } : event === 'not_started' ? { processCreated: false } : {}) }));
  state.nativeData(Buffer.from(lines.join('\n') + '\n'));
  expect(state.nativeParsingFailed).toBe(true); expect(state.nativeRetired).toBe(false); expect(state.nativeNotStarted).toBe(false);
});
