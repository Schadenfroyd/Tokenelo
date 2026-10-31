import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ReportReads, REPORT_READ_BUDGET_MS } from '../../src/daemon/report-reads.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { defaultPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-owned-tree-'));
  const worker = path.join(root, 'worker.mjs'), child = path.join(root, 'child.mjs'), grand = path.join(root, 'grand.mjs');
  fs.writeFileSync(grand, `import fs from 'node:fs';const [root]=process.argv.slice(2);let sequence=0;
    fs.writeFileSync(root+'/grand.json',JSON.stringify({pid:process.pid,ppid:process.ppid}));
    const pulse=setInterval(()=>{fs.writeFileSync(root+'/beat.tmp',JSON.stringify({pid:process.pid,sequence:++sequence}));fs.renameSync(root+'/beat.tmp',root+'/beat.json');},20);
    setTimeout(()=>{clearInterval(pulse);process.exit(88)},15000);`);
  fs.writeFileSync(child, `import fs from 'node:fs';import{execFile}from'node:child_process';const[root,grand]=process.argv.slice(2);
    fs.writeFileSync(root+'/child.json',JSON.stringify({pid:process.pid,ppid:process.ppid}));
    execFile(process.execPath,[grand,root],{windowsHide:true},()=>{});setTimeout(()=>process.exit(88),15000);`);
  fs.writeFileSync(worker, `import fs from 'node:fs';import{execFile}from'node:child_process';import{parentPort,workerData}from'node:worker_threads';
    const root=workerData.configuration.dbFile,range=workerData.task.range;
    fs.appendFileSync(root+'/trace.txt','start:'+range+'\\n');
    if(range==='7d'){parentPort.postMessage({type:'result',json:JSON.stringify({range,unicode:'λ雪',values:[1,2,3]})});parentPort.close();}
    else{execFile(process.execPath,[${JSON.stringify(child)},root,${JSON.stringify(grand)}],{windowsHide:true},()=>{});
      const poll=setInterval(()=>{if(fs.existsSync(root+'/beat.json')){clearInterval(poll);parentPort.postMessage({type:'progress',phase:'reading-usage'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}},5);
      parentPort.on('message',()=>{});}`);
  fs.writeFileSync(path.join(root, 'trace.txt'), '');
  const pricing = defaultPricingEngine(), valuationEngine = createNullEngine(), retired: string[] = [];
  const reads = new ReportReads({ dbFile: root, config: defaultConfig(), priceRows: loadPriceRows(),
    pricesVersion: pricing.version },
  { workerUrl: pathToFileURL(worker), workers: 1, waiting: 2, budgetMs: 2000, cancelGraceMs: 100,
    onRetired: item => retired.push(item.outcome) });
  return { root, reads, retired, trace: () => fs.readFileSync(path.join(root, 'trace.txt'), 'utf8') };
}

it.each(['cancel', 'timeout', 'close'] as const)('owned report tree: %s stops child and grandchild before retirement/successor', async mode => {
  const f = fixture(), controller = new AbortController(); let ready = false;
  const first = f.reads.readAfterRetirement({ kind: 'summary', range: '30d' }, {
    signal: controller.signal, onProgress: () => { ready = true; },
  }).catch(error => error.code);
  try {
    await until(() => ready);
    const ids = ['child.json', 'grand.json'].map(n => JSON.parse(fs.readFileSync(path.join(f.root, n), 'utf8')));
    expect(ids[1].ppid).toBe(ids[0].pid);
    let successor: ReturnType<ReportReads['read']> | undefined;
    // The first uses a shortened synthetic timeout. The successor retains the original
    // ordinary admission budget, which includes time queued behind that two-second read.
    if (mode !== 'close') successor = f.reads.read({ kind: 'summary', range: '7d' }, undefined, REPORT_READ_BUDGET_MS);
    if (mode === 'cancel') controller.abort();
    if (mode === 'close') await f.reads.close();
    expect(await first).toBe(mode === 'timeout' ? 'read_timeout' : 'read_cancelled');
    expect(f.retired[0]).toBe(mode === 'timeout' ? 'read_timeout' : 'read_cancelled');
    const beat = fs.readFileSync(path.join(f.root, 'beat.json'));
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(fs.readFileSync(path.join(f.root, 'beat.json'))).toEqual(beat);
    if (successor) expect(await successor).toEqual({ range: '7d', unicode: 'λ雪', values: [1, 2, 3] });
    else await expect(f.reads.read({ kind: 'summary', range: '7d' })).rejects.toMatchObject({ code: 'read_unavailable' });
  } finally { await f.reads.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 10000);

it('owned report tree: cancelling queued work never starts its process', async () => {
  const f = fixture(), active = new AbortController(), queued = new AbortController(); let ready = false;
  const first = f.reads.readAfterRetirement({ kind: 'summary', range: '30d' }, { signal: active.signal, onProgress: () => { ready = true; } }).catch(error => error.code);
  try {
    await until(() => ready);
    const second = f.reads.read({ kind: 'summary', range: '7d' }, { signal: queued.signal }).catch(error => error.code);
    queued.abort(); expect(await second).toBe('read_cancelled'); expect(f.trace()).not.toContain('start:7d');
    active.abort(); expect(await first).toBe('read_cancelled'); expect(f.trace()).not.toContain('start:7d');
  } finally { await f.reads.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 10000);

it('owned report tree: a queued read consumes its own admission deadline and never starts after expiry', async () => {
  const f = fixture(), active = new AbortController(); let ready = false;
  const first = f.reads.readAfterRetirement({ kind: 'summary', range: '30d' }, { signal: active.signal, onProgress: () => { ready = true; } }).catch(error => error.code);
  try {
    await until(() => ready);
    const queued = f.reads.read({ kind: 'summary', range: '7d' }, undefined, 50).catch(error => error.code);
    expect(await queued).toBe('read_timeout'); expect(f.trace()).not.toContain('start:7d');
    active.abort(); expect(await first).toBe('read_cancelled'); expect(f.trace()).not.toContain('start:7d');
  } finally { await f.reads.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 10000);
