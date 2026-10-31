import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries, META_ACL_WARNING_KEY, META_UNMETERED_KEY } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { createPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { createHttpServer, closeHttpReads, type CreateHttpServerOpts } from '../../src/daemon/http.js';
import { createApiClient } from '../../src/tray/api-client.js';
import { ReportReads, isolatedReportQueries, type ReportReadObservation } from '../../src/daemon/report-reads.js';
import type { ReportReadConfiguration } from '../../src/daemon/report-read-protocol.js';

let tmp: string, db: TokeneloDb, reads: ReportReads | undefined, versionServer: http.Server | undefined;
let historicalReads: ReportReads | undefined;
let usageServer: http.Server | undefined;
afterEach(async () => {
  if (usageServer) { await closeHttpReads(usageServer); usageServer.closeAllConnections(); await new Promise<void>(ok=>usageServer!.close(()=>ok())); usageServer=undefined; }
  await reads?.close(); reads = undefined;
  await historicalReads?.close(); historicalReads = undefined;
  if (versionServer) { versionServer.closeAllConnections(); await new Promise<void>(ok => versionServer!.close(() => ok())); versionServer = undefined; }
  db?.close(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});
function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-report-worker-'));
  const file = path.join(tmp, 'ledger.sqlite'); db = openDb({ file });
  insert('own', 's', 1000, 3, 5);
  insert('child', 'child', 2000, 7, 11, 's');
  db.prepare("INSERT INTO activity(host,source,session_id,ts,uuid,kind,duration_ms) VALUES('H','codex','s',1000,'mark','turn',700)").run();
  const config = defaultConfig(); config.hostLabel = 'H';
  const priceRows = loadPriceRows(), pricing = createPricingEngine(priceRows);
  const configuration: ReportReadConfiguration = { dbFile: file, config, priceRows, pricesVersion: pricing.version };
  return { file, config, pricing, configuration };
}
function insert(id: string, session: string, ts: number, input: number, output: number, parent?: string) {
  db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,parent_session_id,is_subagent,model,provider,
    components_json,flags_json,price_status,price_version,ucu_rate_status,eacs_def_sha256,input_fresh,output,api_equiv_usd)
    VALUES(?, 'H','codex',?,'line',?,?,?,'gpt-6-sol','openai','[]','[]','LIST','v','FILED-EXAMPLE','h',?,?,0.01)`)
    .run(id, ts, session, parent ?? null, parent ? 1 : 0, input, output);
}
function fixture(body: string): URL {
  const file = path.join(tmp, 'worker-fixture.mjs');
  fs.writeFileSync(file, `import {parentPort,workerData,threadId} from 'node:worker_threads';\n${body}`);
  return pathToFileURL(file);
}
function checkpointIsFree() {
  const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  expect(result?.busy).toBe(0); expect(result?.log).toBe(0);
}

describe('independent daemon report reads', () => {
  it('accepts a report only when a revision-bound parent and worker identity match', async () => {
    const { configuration } = setup();
    const expected = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) };
    const bound = { ...configuration, buildIdentity: expected };
    reads = new ReportReads(bound, { workerUrl: fixture(`parentPort.postMessage({type:'result',json:'{"ok":true}',buildIdentity:workerData.configuration.buildIdentity});parentPort.close();`) });
    await expect(reads.read({ kind: 'summary', range: 'all' })).resolves.toEqual({ ok: true });
    await reads.close(); checkpointIsFree();
  });

  it('does not return data from the real report-worker entry when its package identity is unknown or different', async () => {
    const { configuration } = setup();
    const expected = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) };
    reads = new ReportReads({ ...configuration, buildIdentity: expected });
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'query_failed' });
    await reads.close(); checkpointIsFree();
  });

  it.each([
    ['missing', ''],
    ['unknown', `parentPort.postMessage({type:'result',json:'{"ok":true}',buildIdentity:null});parentPort.close();`],
    ['mismatched', `parentPort.postMessage({type:'result',json:'{"ok":true}',buildIdentity:{...workerData.configuration.buildIdentity,distManifestSha256:'c'.repeat(64)}});parentPort.close();`],
  ] as const)('rejects %s worker identity before returning its result', async (_label, body) => {
    const { configuration } = setup();
    const expected = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) };
    const workerBody = body || `parentPort.postMessage({type:'result',json:'{"ok":true}'});parentPort.close();`;
    reads = new ReportReads({ ...configuration, buildIdentity: expected }, { workerUrl: fixture(workerBody) });
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'query_failed' });
    await reads.close(); checkpointIsFree();
  });

  it('records the admitted requested period and rejects private worker or unsupported task labels from diagnostics', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    let firstWaveRetired!: () => void;
    const firstWave = new Promise<void>(resolve => { firstWaveRetired = resolve; });
    // Exercise the production default two workers/four waiting slots. Queued callers
    // mutate both top-level and nested periods after admission; receipts keep originals.
    reads = new ReportReads(configuration, {
      workerUrl: fixture(`parentPort.postMessage({type:'result',json:JSON.stringify(workerData.task),range:'private-model-and-session'});parentPort.close();`),
      onRetired: value => { observed.push(value); if (observed.length === 6) firstWaveRetired(); } });
    const ranges = ['today', '24h', '7d', '30d', 'all'] as const;
    const sessionTask = { kind: 'sessions' as const, opts: { range: '7d' as typeof ranges[number], activeOnly: false } };
    const admitted = [...ranges.map(range => ({ kind: 'summary' as const, range })), sessionTask];
    const originals = structuredClone(admitted);
    const pending = admitted.map(task => reads!.read(task));
    const replies = Promise.all(pending);
    // Attach rejection handling before an admission assertion can fail and cleanup cancels reads.
    void replies.catch(() => {}); // The original promise is still awaited and rejects below.
    const capacity = reads.read({ kind: 'summary', range: 'today' }).catch(error => error.code);
    for (const task of admitted) {
      if (task.kind === 'summary') task.range = 'all';
      else task.opts.range = 'all';
    }
    expect(await capacity).toBe('read_capacity');
    // Each actual worker must receive its original task, independently of retirement labels.
    expect(await replies).toEqual(originals);
    await firstWave; // Keep original default capacity: no second wave until actual retirement.
    await Promise.all([
      expect(reads.read({ kind: 'summary', range: 'private-filter-and-path' as 'all' })).resolves.toEqual({ kind: 'summary', range: 'private-filter-and-path' }),
      expect(reads.read({ kind: 'detail', source: 'codex', sessionId: 'private-session' })).resolves.toEqual({ kind: 'detail', source: 'codex', sessionId: 'private-session' }),
    ]);
    await reads.close();
    // Retirement order may differ. Compare every kind/period pair, not a weaker period set.
    expect(observed.map(value => `${value.kind}:${value.range}`).sort()).toEqual([
      ...ranges.map(range => `summary:${range}`), 'sessions:7d', 'summary:null', 'detail:null',
    ].sort());
    expect(JSON.stringify(observed)).not.toMatch(/private-model|private-filter|private-session/);
    checkpointIsFree();
  });

  it('retains the allowlisted period after cancellation and proved retirement', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = []; const controller = new AbortController();
    reads = new ReportReads(configuration, {
      workerUrl: fixture(`const timer=setInterval(()=>{},100);parentPort.postMessage({type:'progress',phase:'reading-usage'});
        parentPort.on('message',m=>{if(m.type==='cancel'){clearInterval(timer);parentPort.close();}});`),
      onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'summary', range: '30d' }, { signal: controller.signal,
      onProgress: () => controller.abort() })).rejects.toMatchObject({ code: 'read_cancelled' });
    await reads.close();expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ range: '30d', outcome: 'read_cancelled' });checkpointIsFree();
  });

  it('keeps the real session response and ledger intact while recording content-free loading and aggregation phases', async () => {
    const { configuration, config, pricing } = setup();
    const expected = await createQueries(db, config, { pricing }).getSessions({ range: 'all', activeOnly: false });
    const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { onRetired: value => observed.push(value) });
    const result = await reads.read({ kind: 'sessions', opts: { range: 'all', activeOnly: false } });
    expect(result).toEqual({ ...expected, generatedAt: result.generatedAt,
      timeBasis: { ...expected.timeBasis!, asOfMs: result.generatedAt } });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ outcome: 'completed', budgetMs: 18_500, lastDiagnosticPhase: 'sessions.response' });
    expect(observed[0]!.diagnosticPhases.map(value => value.phase)).toEqual([
      'sessions.events', 'sessions.ancestry', 'sessions.event-payload', 'sessions.activity', 'sessions.aggregation', 'sessions.response',
    ]);
    for (const value of observed[0]!.diagnosticPhases) {
      expect(Object.keys(value).sort()).toEqual(['phase', 'workerElapsedMs', 'parentElapsedMs'].sort());
      expect(value.workerElapsedMs).toBeGreaterThanOrEqual(0);
      expect(value.parentElapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(2);
    await reads.close(); checkpointIsFree();
  });

  it('bounds repeated session phase receipts and excludes unknown labels and report contents', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    const workerUrl = fixture(`const phases=['sessions.events','sessions.activity','sessions.aggregation','sessions.response'];
      for(let i=0;i<2000;i++)parentPort.postMessage({type:'diagnostic',phase:phases[i%4],workerElapsedMs:i,contents:'private-model-and-session'});
      parentPort.postMessage({type:'diagnostic',phase:'sessions.private-model-and-path',workerElapsedMs:2001});
      parentPort.postMessage({type:'result',json:'{"ok":true}'});parentPort.close();`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'sessions', opts: { range: 'all', activeOnly: false } })).resolves.toEqual({ ok: true });
    expect(observed[0]!.diagnosticPhases.map(value => [value.phase, value.workerElapsedMs])).toEqual([
      ['sessions.events', 1996], ['sessions.activity', 1997], ['sessions.aggregation', 1998], ['sessions.response', 1999],
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/private-model|contents|path/);
    await reads.close(); checkpointIsFree();
  });

  it('reserves historical capacity and preserves one exact snapshot while ordinary workers are occupied and capture commits', async () => {
    const { configuration, config, pricing } = setup();
    const parent = createQueries(db, config, { pricing });
    const expected = await parent.getSummary('all');
    reads = new ReportReads(configuration, { workers: 2, waiting: 0, workerUrl: fixture("parentPort.on('message',m=>{if(m.type==='cancel')parentPort.close();});") });
    const pending = [reads.read({ kind: 'summary', range: 'all' }).catch(e=>e.code), reads.read({ kind: 'summary', range: 'all' }).catch(e=>e.code)];
    historicalReads = new ReportReads(configuration, { workers: 1, budgetMs: 45_000, maxResultBytes: 8 * 1024 ** 2 });
    const queries = isolatedReportQueries(parent, reads, historicalReads);
    await expect(queries.getSummary('all')).rejects.toMatchObject({ code: 'read_capacity' });
    let committed = false;
    const result = await queries.getSummaryReport!('all', { onProgress: phase => {
      if (phase === 'reading-usage' && !committed) { insert('after-snapshot', 's', 3000, 19, 23); committed = true; }
    } });
    expect(result).toEqual({ ...expected, generatedAt: result.generatedAt, timeBasis: { ...expected.timeBasis!, asOfMs: result.generatedAt } });
    expect(committed).toBe(true); expect(result.totals.events).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
    await reads.close(); expect(await Promise.all(pending)).toEqual(['read_cancelled', 'read_cancelled']);
    await historicalReads.close(); checkpointIsFree();
  }, 15_000);


  it('bounds repeated chart diagnostics and excludes private or unsupported payloads', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    const workerUrl = fixture(`const phases=['timeseries.sql','timeseries.map','timeseries.bucket','timeseries.response'];
      for(let i=0;i<2000;i++)parentPort.postMessage({type:'diagnostic',phase:phases[i%4],workerElapsedMs:i,contents:'private-model-and-path'});
      parentPort.postMessage({type:'diagnostic',phase:'timeseries.private-model-and-path',workerElapsedMs:2001});
      parentPort.postMessage({type:'result',json:'{"ok":true}'});parentPort.close();`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'usage', range: 'all' })).resolves.toEqual({ ok: true });
    expect(observed[0]!.diagnosticPhases.map(value => [value.phase,value.workerElapsedMs])).toEqual([
      ['timeseries.sql',1996],['timeseries.map',1997],['timeseries.bucket',1998],['timeseries.response',1999],
    ]);
    for (const phase of observed[0]!.diagnosticPhases)
      expect(Object.keys(phase).sort()).toEqual(['phase','workerElapsedMs','parentElapsedMs'].sort());
    expect(JSON.stringify(observed)).not.toContain('private-model');
    await reads.close(); checkpointIsFree();
  });

  it('retains chart receipts on actual cancellation without converting the read to success', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = []; const controller = new AbortController();
    const workerUrl = fixture(`const timer=setInterval(()=>{},100);
      parentPort.postMessage({type:'diagnostic',phase:'timeseries.map',workerElapsedMs:1});
      parentPort.postMessage({type:'progress',phase:'reading-usage'});
      parentPort.on('message',message=>{if(message.type==='cancel'){
        parentPort.postMessage({type:'diagnostic',phase:'timeseries.bucket',workerElapsedMs:2});
        parentPort.postMessage({type:'result',json:'{"ok":true}'});
        clearInterval(timer);parentPort.close();}});`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    await expect(reads.read({ kind:'usage',range:'all' }, { signal:controller.signal,
      onProgress:()=>controller.abort() })).rejects.toMatchObject({ code:'read_cancelled' });
    await reads.close();
    expect(observed[0]).toMatchObject({ kind:'usage',outcome:'read_cancelled',lastDiagnosticPhase:'timeseries.bucket' });
    expect(observed[0]!.diagnosticPhases.map(value=>value.phase)).toEqual(['timeseries.map','timeseries.bucket']);
    checkpointIsFree();
  });


  it('late chart failure after cancellation cannot replace the admitted cancellation outcome', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = []; const controller = new AbortController();
    const workerUrl = fixture(`const timer=setInterval(()=>{},100);
      parentPort.postMessage({type:'diagnostic',phase:'timeseries.map',workerElapsedMs:1});
      parentPort.postMessage({type:'progress',phase:'reading-usage'});
      parentPort.on('message',message=>{if(message.type==='cancel'){
        parentPort.postMessage({type:'diagnostic',phase:'timeseries.bucket',workerElapsedMs:2});
        parentPort.postMessage({type:'failure',code:'query_failed'});
        clearInterval(timer);parentPort.close();}});`);
    reads = new ReportReads(configuration, { workerUrl, onRetired:value=>observed.push(value) });
    await expect(reads.read({kind:'usage',range:'all'}, {signal:controller.signal,
      onProgress:()=>controller.abort()})).rejects.toMatchObject({code:'read_cancelled'});
    await reads.close();
    expect(observed[0]).toMatchObject({kind:'usage',outcome:'read_cancelled',lastDiagnosticPhase:'timeseries.bucket'});
    checkpointIsFree();
  });

  it('native report transport delivers chart entry before a blocked worker is retired at its original test budget', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    const workerUrl = fixture(`parentPort.postMessage({type:'diagnostic',phase:'timeseries.sql',workerElapsedMs:1});
      const until=Date.now()+15000;while(Date.now()<until){};
      parentPort.postMessage({type:'result',json:'{"ok":true}'});parentPort.close();`);
    reads = new ReportReads(configuration, {workerUrl,budgetMs:2500,onRetired:value=>observed.push(value)});
    await expect(reads.read({kind:'usage',range:'all'})).rejects.toMatchObject({code:'read_timeout'});
    await reads.close();
    expect(observed[0]).toMatchObject({kind:'usage',range:'all',outcome:'read_timeout',budgetMs:2500,
      workerStarted:true,lastDiagnosticPhase:'timeseries.sql'});
    expect(observed[0]!.diagnosticPhases.map(value=>value.phase)).toEqual(['timeseries.sql']);
    checkpointIsFree();
  }, 10_000);

  it('real worker reports all chart phase entries with the unchanged complete atomic response', async () => {
    const { configuration,config,pricing } = setup(); const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { onRetired:value=>observed.push(value) });
    const value=await reads.read({kind:'usage',range:'all'});
    const q=createQueries(db,config,{now:()=>value.summary.generatedAt,pricing});
    expect(value.summary).toEqual(await q.getSummary('all'));
    expect(value.timeseries).toEqual(await q.getTimeseries('day','all'));
    expect(observed[0]!.diagnosticPhases.map(value=>value.phase).slice(-4)).toEqual([
      'timeseries.sql','timeseries.map','timeseries.bucket','timeseries.response',
    ]);
    expect(observed[0]!.lastDiagnosticPhase).toBe('timeseries.response');
    await reads.close(); checkpointIsFree();
  });

  it('bounds repeated Summary diagnostics and excludes unsupported labels and private contents', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    const workerUrl = fixture(`const phases=['summary.usage','summary.local','summary.subscriptions','summary.activity','summary.active-time','summary.wall-time','summary.response'];
      for(let i=0;i<2000;i++)parentPort.postMessage({type:'diagnostic',phase:phases[i%7],workerElapsedMs:i,contents:'private-model-and-session'});
      parentPort.postMessage({type:'diagnostic',phase:'summary.private-model-and-path',workerElapsedMs:2001});
      parentPort.postMessage({type:'result',json:'{"ok":true}'});parentPort.close();`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'summary', range: 'all' })).resolves.toEqual({ ok: true });
    expect(observed[0]!.diagnosticPhases.map(value => value.phase)).toEqual([
      'summary.usage','summary.local','summary.subscriptions','summary.activity','summary.active-time','summary.wall-time','summary.response',
    ]);
    for (const phase of observed[0]!.diagnosticPhases)
      expect(Object.keys(phase).sort()).toEqual(['phase', 'workerElapsedMs', 'parentElapsedMs'].sort());
    expect(JSON.stringify(observed)).not.toContain('private-model');
    await reads.close(); checkpointIsFree();
  });

  it('retains Summary diagnostic receipts through cancellation without reporting success', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = []; const controller = new AbortController();
    const workerUrl = fixture(`const timer=setInterval(()=>{},100);
      parentPort.postMessage({type:'diagnostic',phase:'summary.activity',workerElapsedMs:1,contents:'private-model-and-session'});
      parentPort.postMessage({type:'progress',phase:'reading-activity'});
      parentPort.on('message',message=>{if(message.type==='cancel'){
        parentPort.postMessage({type:'diagnostic',phase:'summary.response',workerElapsedMs:2,contents:'private-model-and-session'});
        clearInterval(timer);parentPort.close();}});`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'summary', range: 'all' }, { signal: controller.signal,
      onProgress: () => controller.abort() })).rejects.toMatchObject({ code: 'read_cancelled' });
    await reads.close();
    expect(observed[0]).toMatchObject({ kind: 'summary', outcome: 'read_cancelled', lastDiagnosticPhase: 'summary.response' });
    expect(observed[0]!.diagnosticPhases.map(value => value.phase)).toEqual(['summary.activity', 'summary.response']);
    expect(JSON.stringify(observed)).not.toContain('private-model');
    checkpointIsFree();
  });

  it('Doctor matches the canonical real version probe and retains one WAL snapshot through concurrent capture', async () => {
    const { configuration, config, pricing } = setup();
    const observed: ReportReadObservation[] = [];
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(META_UNMETERED_KEY, '3');
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(META_ACL_WARNING_KEY, '1');
    let mutate = false, committed = false;
    versionServer = http.createServer((req, res) => {
      expect(req.method).toBe('GET'); expect(req.url).toBe('/api/version');
      if (mutate && !committed) {
        insert('during-probe', 's', 3000, 13, 17);
        db.prepare('UPDATE meta SET value=? WHERE key=?').run('99', META_UNMETERED_KEY);
        db.prepare('UPDATE meta SET value=? WHERE key=?').run('0', META_ACL_WARNING_KEY);
        committed = true;
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: 'fixture-version' }));
    });
    await new Promise<void>(ok => versionServer!.listen(0, '127.0.0.1', ok));
    config.local.ollamaUpstream = `http://127.0.0.1:${(versionServer.address() as import('node:net').AddressInfo).port}`;
    configuration.config = config;
    const canonical = await createQueries(db, config, { pricing }).getDoctor();
    reads = new ReportReads(configuration, { onRetired: value => observed.push(value) }); mutate = true;
    const parent = createQueries(db, config, { pricing });
    parent.getDoctor = async () => { throw Error('Doctor must not run on the capture thread'); };
    const result = await isolatedReportQueries(parent, reads).getDoctor();
    expect(result).toEqual({ ...canonical, generatedAt: result.generatedAt });
    expect(result.priceEvidence?.events).toBe(2); expect(result.ollama.unmeteredRequests).toBe(3);
    expect(result.ollama.servers[0]?.version).toBe('fixture-version');
    expect(result.warnings.some(w => w.includes('token file ACL'))).toBe(true);
    expect(committed).toBe(true); expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
    expect(db.prepare('SELECT value FROM meta WHERE key=?').get(META_UNMETERED_KEY)?.value).toBe('99');
    await reads.close(); checkpointIsFree();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'doctor', outcome: 'completed', lastDiagnosticPhase: 'doctor.response' });
    expect(observed[0]!.sinceLastDiagnosticMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('cancelling a real Doctor version request closes its request and snapshot instead of returning a healthy report', async () => {
    const { configuration } = setup(); let received!: () => void, disconnected!: () => void;
    const probeStarted = new Promise<void>(ok => { received = ok; });
    const probeClosed = new Promise<void>(ok => { disconnected = ok; });
    versionServer = http.createServer((_req, res) => { res.once('close', disconnected); received(); });
    await new Promise<void>(ok => versionServer!.listen(0, '127.0.0.1', ok));
    configuration.config.local.ollamaUpstream = `http://127.0.0.1:${(versionServer.address() as import('node:net').AddressInfo).port}`;
    reads = new ReportReads(configuration); const controller = new AbortController();
    const response = reads.read({ kind: 'doctor' }, { signal: controller.signal }).catch(e => e.code);
    await probeStarted; controller.abort(); expect(await response).toBe('read_cancelled');
    await reads.close(); await probeClosed; checkpointIsFree();
  }, 10_000);

  it.runIf(process.platform === 'linux')('cancels and awaits the promisified Doctor child even when a preload Promise exposes no child property', async () => {
    const { configuration } = setup(); const childPidFile = path.join(tmp, 'probe-child.pid');
    const workerFaultFile = path.join(tmp, 'worker-startup-error.txt');
    const child = path.join(tmp, 'ss');
    fs.writeFileSync(child, `#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(childPidFile)},String(process.pid));setInterval(()=>{},100);`);
    fs.chmodSync(child, 0o700);
    const loader = import.meta.resolve('tsx/esm/api');
    const url = fixture(`try{const {register}=await import(${JSON.stringify(loader)});register();
      const cp=await import('node:child_process'),{promisify}=await import('node:util'),{syncBuiltinESMExports}=await import('node:module');
      const original=cp.default.execFile,wrapped=(...args)=>Reflect.apply(original,cp.default,args);
      wrapped[promisify.custom]=(...args)=>new Promise((ok,no)=>wrapped(...args,(err,stdout,stderr)=>err?no(err):ok({stdout,stderr})));
      cp.default.execFile=wrapped;syncBuiltinESMExports();
      process.env.PATH=${JSON.stringify(tmp)}+':'+process.env.PATH;await import(${JSON.stringify(new URL('../../src/daemon/report-worker.ts', import.meta.url).href)});
    }catch(error){const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(workerFaultFile)},String(error.stack));throw error;}`);
    reads = new ReportReads(configuration, { workerUrl: url }); const controller = new AbortController();
    const response = reads.read({ kind: 'doctor' }, { signal: controller.signal }).catch(e => e.code);
    const until = Date.now() + 5000;
    while (!fs.existsSync(childPidFile) && Date.now() < until) await new Promise(ok => setTimeout(ok, 10));
    expect(fs.existsSync(childPidFile), fs.existsSync(workerFaultFile) ? fs.readFileSync(workerFaultFile, 'utf8') : 'owned probe child did not start').toBe(true);
    const pid = Number(fs.readFileSync(childPidFile, 'utf8'));
    controller.abort(); expect(await response).toBe('read_cancelled'); await reads.close();
    expect(() => process.kill(pid, 0)).toThrow(); checkpointIsFree();
  }, 10_000);

  it('records one content-free retirement after a real worker exits, without changing its response', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { onRetired: value => observed.push(value) });
    const result = await reads.read({ kind: 'detail', source: 'codex', sessionId: 's' });
    expect(result?.events).toBe(2); expect(observed).toHaveLength(1);
    expect(Object.keys(observed[0]!).sort()).toEqual(['kind','range','outcome','budgetMs','admissionToRetirementMs','queuedMs','workerOperationMs','workerStarted','lastDiagnosticPhase','sinceLastDiagnosticMs','diagnosticPhases'].sort());
    expect(observed[0]).toMatchObject({ kind: 'detail', outcome: 'completed', budgetMs: 18_500, workerStarted: true });
    expect(observed[0]!.workerOperationMs).toBeGreaterThanOrEqual(0);
    expect(observed[0]!.lastDiagnosticPhase).toBe('detail-response');
    expect(observed[0]!.diagnosticPhases.map(value => value.phase)).toContain('detail-response');
    for (const value of observed[0]!.diagnosticPhases) {
      expect(Object.keys(value).sort()).toEqual(['phase', 'workerElapsedMs', 'parentElapsedMs'].sort());
      expect(value.workerElapsedMs).toBeGreaterThanOrEqual(0);
      expect(value.parentElapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(observed[0]!.sinceLastDiagnosticMs).toBeGreaterThanOrEqual(0);
    expect(observed[0]!.queuedMs).toBeGreaterThanOrEqual(0);
    expect(observed[0]!.admissionToRetirementMs).toBeGreaterThanOrEqual(observed[0]!.queuedMs);
    await reads.close(); expect(observed).toHaveLength(1); checkpointIsFree();
  });

  it('reports cancelled queued reads once with no invented worker duration, and isolates sink failures', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { workers: 1, waiting: 1, cancelGraceMs: 20,
      workerUrl: fixture('setInterval(()=>{},100);'), onRetired: value => { observed.push(value); throw Error('diagnostic sink failed'); } });
    const active = reads.read({ kind: 'summary', range: 'all' }).catch(e => e.code);
    const queued = reads.read({ kind: 'detail', source: 'codex', sessionId: 'private-id-must-not-be-logged' }).catch(e => e.code);
    await reads.close(); expect(await active).toBe('read_cancelled'); expect(await queued).toBe('read_cancelled');
    expect(observed).toHaveLength(2);
    expect(observed.find(value => value.kind === 'detail')).toMatchObject({ outcome: 'read_cancelled', workerStarted: false, workerOperationMs: null, lastDiagnosticPhase: null, sinceLastDiagnosticMs: null });
    expect(JSON.stringify(observed)).not.toContain('private-id'); checkpointIsFree();
  });

  it('records a malformed result as a failed read rather than a completed report', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { workerUrl: fixture("parentPort.postMessage({type:'result',json:'{',workerOperationMs:NaN});parentPort.close();"), onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'query_failed' });
    expect(observed).toHaveLength(1); expect(observed[0]).toMatchObject({ outcome: 'query_failed', workerOperationMs: null });
    await reads.close(); checkpointIsFree();
  });

  it('real worker outputs deeply match the canonical Summary, Sessions, Timeseries and included-child detail', async () => {
    const { configuration, file, config, pricing } = setup(); const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { onRetired: value => observed.push(value) });
    const summary = await reads.read({ kind: 'summary', range: 'all' });
    expect(observed[0]).toMatchObject({ outcome: 'completed', lastDiagnosticPhase: 'summary.response' });
    expect(observed[0]!.diagnosticPhases.map(value => value.phase)).toEqual([
      'summary.usage', 'summary.local', 'summary.subscriptions', 'summary.activity',
      'summary.active-time', 'summary.wall-time', 'summary.response',
    ]);
    for (const phase of observed[0]!.diagnosticPhases) {
      expect(Object.keys(phase).sort()).toEqual(['phase', 'workerElapsedMs', 'parentElapsedMs'].sort());
      expect(Number.isFinite(phase.workerElapsedMs) && phase.workerElapsedMs >= 0).toBe(true);
      expect(Number.isFinite(phase.parentElapsedMs) && phase.parentElapsedMs >= 0).toBe(true);
    }
    const queries = createQueries(db, config, { pricing, now: () => summary.generatedAt, readSnapshotFile: file });
    expect(summary).toEqual(await queries.getSummary('all'));
    expect(summary.totals.tokens.countQuality).toBe('unrecorded');
    const sessions = await reads.read({ kind: 'sessions', opts: { range: 'all' } });
    expect(sessions).toEqual(await createQueries(db, config, { pricing, now: () => sessions.generatedAt!, readSnapshotFile: file }).getSessions({ range: 'all' }));
    const series = await reads.read({ kind: 'timeseries', bucket: 'day', range: 'all' });
    expect(series).toEqual(await createQueries(db, config, { pricing, now: () => series.generatedAt! }).getTimeseries('day', 'all'));
    const detail = await reads.read({ kind: 'detail', source: 'codex', sessionId: 's' });
    expect(detail).toEqual(await queries.getSessionDetail('codex', 's'));
    expect(detail?.tokens.output).toBe(16);
    await reads.close(); checkpointIsFree();
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(2);
  }, 20_000);

  it('a worker holds one readonly WAL snapshot while the owner writes, then releases it', async () => {
    const { configuration } = setup();
    const workerUrl = fixture(`import {createRequire}from'node:module';const{DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
      const db=new DatabaseSync(workerData.configuration.dbFile,{readOnly:true});db.exec('PRAGMA query_only=ON;BEGIN');
      const before=db.prepare('SELECT COUNT(*) AS n FROM events').get().n;let refused=false;try{db.exec("DELETE FROM events");}catch{refused=true;}
      parentPort.postMessage({type:'progress',phase:'reading-usage'});
      setTimeout(()=>{const after=db.prepare('SELECT COUNT(*) AS n FROM events').get().n;db.exec('ROLLBACK');db.close();parentPort.postMessage({type:'result',json:JSON.stringify({before,after,refused,threadId})});parentPort.close();},80);`);
    reads = new ReportReads(configuration, { workerUrl });
    const result = await reads.read({ kind: 'summary', range: 'all' }, { onProgress: () => insert('new', 's', 3000, 1, 1) }) as unknown as {before: number; after: number; refused: boolean; threadId: number};
    expect(result).toMatchObject({ before: 2, after: 2, refused: true }); expect(result.threadId).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3); checkpointIsFree();
  });

  it('bounds admission and cancels queued work without starting it during close', async () => {
    const { configuration } = setup();
    reads = new ReportReads(configuration, { workers: 1, waiting: 1, workerUrl: fixture("setInterval(()=>{},100);parentPort.on('message',()=>parentPort.close());") });
    const a = reads.read({ kind: 'summary', range: 'all' }).catch(e => e.code);
    const b = reads.read({ kind: 'summary', range: '7d' }).catch(e => e.code);
    await expect(reads.read({ kind: 'summary', range: 'today' })).rejects.toMatchObject({ code: 'read_capacity' });
    await reads.close(); expect(await a).toBe('read_cancelled'); expect(await b).toBe('read_cancelled');
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'read_unavailable' });
  });

  it('terminates an owned non-yielding thread on cancellation and releases its actual SQLite snapshot', async () => {
    const { configuration } = setup(); let ready!: () => void; const observed: ReportReadObservation[] = [];
    const started = new Promise<void>(ok => { ready = ok; });
    const workerUrl = fixture(`import {createRequire}from'node:module';const{DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
      const db=new DatabaseSync(workerData.configuration.dbFile,{readOnly:true});db.exec('BEGIN');db.prepare('SELECT COUNT(*) FROM events').get();
      parentPort.postMessage({type:'diagnostic',phase:'detail-descendants'});
      parentPort.postMessage({type:'diagnostic',phase:'private-path-session-must-not-be-logged'});
      parentPort.postMessage({type:'progress',phase:'reading-usage'});while(true){}`);
    reads = new ReportReads(configuration, { workerUrl, cancelGraceMs: 20, onRetired: value => observed.push(value) });
    const controller = new AbortController();
    const response = reads.read({ kind: 'summary', range: 'all' }, { signal: controller.signal, onProgress: ready }).catch(e => e.code);
    await started; controller.abort(); expect(await response).toBe('read_cancelled');
    await reads.close(); checkpointIsFree();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ outcome: 'read_cancelled', lastDiagnosticPhase: 'detail-descendants', workerOperationMs: null });
    expect(observed[0]!.sinceLastDiagnosticMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(observed)).not.toContain('private-path-session');
  });

  it('preserves worker phase receipts during cancellation without turning cancellation into success', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    let started!: () => void; const ready = new Promise<void>(ok => { started = ok; });
    const workerUrl = fixture(`parentPort.postMessage({type:'diagnostic',phase:'doctor.event-census',workerElapsedMs:1});
      parentPort.postMessage({type:'progress',phase:'reading-usage'});
      parentPort.on('message',m=>{if(m.type==='cancel'){
        parentPort.postMessage({type:'diagnostic',phase:'doctor.response',workerElapsedMs:2,privateData:'secret'});
        parentPort.postMessage({type:'result',json:'{"unexpectedSuccess":true}',workerOperationMs:3});parentPort.close();}});`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    const controller = new AbortController();
    const response = reads.read({ kind: 'doctor' }, { signal: controller.signal, onProgress: started }).catch(e => e.code);
    await ready; controller.abort(); expect(await response).toBe('read_cancelled'); await reads.close();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ outcome: 'read_cancelled', lastDiagnosticPhase: 'doctor.response', budgetMs: 18_500 });
    expect(observed[0]!.diagnosticPhases.map(value => [value.phase, value.workerElapsedMs])).toEqual([
      ['doctor.event-census', 1], ['doctor.response', 2],
    ]);
    expect(JSON.stringify(observed)).not.toContain('secret'); checkpointIsFree();
  });

  it('rejects unknown labels and invalid or backwards worker times from bounded diagnostic timing records', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    const workerUrl = fixture(`for(const message of [
      {phase:'doctor.event-census',workerElapsedMs:2},
      {phase:'private-path-prompt',workerElapsedMs:3},
      {phase:'doctor.skipped-paths',workerElapsedMs:NaN},
      {phase:'doctor.skipped-paths',workerElapsedMs:Infinity},
      {phase:'doctor.skipped-paths',workerElapsedMs:-1},
      {phase:'doctor.skipped-paths',workerElapsedMs:'3'},
      {phase:'doctor.skipped-paths',workerElapsedMs:1},
      {phase:'doctor.response',workerElapsedMs:4,contents:'secret'},
    ])parentPort.postMessage({type:'diagnostic',...message});
      parentPort.postMessage({type:'result',json:'{"ok":true}',workerOperationMs:5});parentPort.close();`);
    reads = new ReportReads(configuration, { workerUrl, onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'doctor' })).resolves.toEqual({ ok: true });
    expect(observed[0]!.diagnosticPhases.map(value => [value.phase, value.workerElapsedMs])).toEqual([
      ['doctor.event-census', 2], ['doctor.response', 4],
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/private-path|secret|contents/);
  });

  it('bounds repeated diagnostic receipts by the fixed phase vocabulary', async () => {
    const { configuration } = setup(); const observed: ReportReadObservation[] = [];
    reads = new ReportReads(configuration, { workerUrl: fixture(`for(let i=0;i<2000;i++)
      parentPort.postMessage({type:'diagnostic',phase:i%2?'doctor.response':'doctor.event-census',workerElapsedMs:i});
      parentPort.postMessage({type:'result',json:'{"ok":true}'});parentPort.close();`), onRetired: value => observed.push(value) });
    await expect(reads.read({ kind: 'doctor' })).resolves.toEqual({ ok: true });
    expect(observed[0]!.diagnosticPhases).toHaveLength(2);
    expect(observed[0]!.diagnosticPhases.map(value => value.workerElapsedMs)).toEqual([1998, 1999]);
  });

  it('enforces admission-time deadlines and drains the actual worker rather than returning zero', async () => {
    const { configuration } = setup();
    reads = new ReportReads(configuration, { budgetMs: 50, cancelGraceMs: 20, workerUrl: fixture('setInterval(()=>{},100);') });
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'read_timeout' });
    await reads.close(); checkpointIsFree();
  });

  it('rejects oversized results and worker crashes with stable errors, leaving the owner ledger intact', async () => {
    const { configuration } = setup();
    reads = new ReportReads(configuration, { maxResultBytes: 32, workerUrl: fixture("parentPort.postMessage({type:'result',json:JSON.stringify({data:'x'.repeat(1000)})});parentPort.close();") });
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'result_too_large' });
    await reads.close();
    reads = new ReportReads(configuration, { workerUrl: fixture("throw new Error('private path or contents must never become the API error');") });
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'read_unavailable', message: 'Report reads are temporarily unavailable.' });
    await reads.close(); checkpointIsFree();
  });

  it('uses the startup pricing identity and rejects a mismatched worker configuration', async () => {
    const { configuration } = setup(); configuration.pricesVersion = 'mismatch'; reads = new ReportReads(configuration);
    await expect(reads.read({ kind: 'summary', range: 'all' })).rejects.toMatchObject({ code: 'query_failed' });
    await reads.close(); checkpointIsFree();
  });

  it('refuses an already-cancelled read before starting any worker', async () => {
    const { configuration } = setup(); reads = new ReportReads(configuration, { workerUrl: new URL('file:///does-not-exist.mjs') });
    const controller = new AbortController(); controller.abort();
    await expect(reads.read({ kind: 'summary', range: 'all' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'read_cancelled' });
    await reads.close();
  });
});


describe('atomic Usage production worker', () => {
  it('keeps Usage totals and chart on one real pinned snapshot across a committed intervening write', async () => {
    const { configuration, config, pricing } = setup();
    const gate = path.join(tmp, 'summary-return-gate');
    const production = pathToFileURL(path.resolve('src/daemon/report-worker.ts')).href;
    // Only schedule a write at the real Summary response boundary. All SQL, clocks,
    // snapshot acquisition and response serialization belong to the production worker.
    const workerUrl = fixture(`import fs from 'node:fs';
      const post=parentPort.postMessage.bind(parentPort);
      parentPort.postMessage=(message)=>{
        post(message);
        if(message.type==='diagnostic' && message.phase==='summary.response'){
          post({type:'progress',phase:'resolving-repositories'});
          const deadline=Date.now()+750;
          while(!fs.existsSync(${JSON.stringify(gate)})){
            if(Date.now()>deadline)throw new Error('owned write gate expired');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
          }
        }
      };
      const {register}=await import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))});register();
      await import(${JSON.stringify(production)});`);
    let committed=false;
    reads=new ReportReads(configuration);
    historicalReads=new ReportReads(configuration,{workerUrl,workers:1,waiting:2,budgetMs:45000,maxResultBytes:8*1024**2});
    const queries=isolatedReportQueries(createQueries(db,config,{pricing}),reads,historicalReads);
    const paired=await queries.getUsageReport!('all',{onProgress:phase=>{
      if(phase!=='resolving-repositories')return;
      expect(committed).toBe(false);
      insert('between-summary-and-chart','s',3000,19,23);
      committed=true;fs.writeFileSync(gate,'committed');
    }});
    expect(committed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(3);
    expect(paired.snapshotScope).toBe('shared-read-transaction');
    expect(paired.summary.totals.events).toBe(2);
    expect(paired.summary.totals.apiEquivUsd).toBeCloseTo(0.02,12);
    expect(paired.timeseries.points.reduce((n,p)=>n+p.apiEquivUsd,0)).toBeCloseTo(0.02,12);
    expect(paired.timeseries.points.reduce((n,p)=>n+(p.totalTokens??NaN),0)).toBe(26);
    expect(paired.summary.generatedAt).toBe(paired.timeseries.generatedAt);
    expect(paired.summary.timeBasis).toEqual(paired.timeseries.timeBasis);
    const next=await queries.getUsageReport!('all');
    expect(next.summary.totals.events).toBe(3);
    expect(next.timeseries.points.reduce((n,p)=>n+p.apiEquivUsd,0)).toBeCloseTo(0.03,12);
    expect(next.timeseries.points.reduce((n,p)=>n+(p.totalTokens??NaN),0)).toBe(68);
    await reads.close();await historicalReads.close();checkpointIsFree();
  });
});


describe('actual Usage worker HTTP client round trip',()=>{
  for(const range of ['today','24h','7d','30d','all']as const)it(`validates the real ${range} envelope through authentication and its production pool`,async()=>{
    const {configuration,config,pricing }=setup();reads=new ReportReads(configuration);
    historicalReads=new ReportReads(configuration,{workers:1,waiting:2,budgetMs:45000,maxResultBytes:8*1024**2});
    const queries=isolatedReportQueries(createQueries(db,config,{pricing}),reads,historicalReads);
    const token='owned-e2e-usage-token',tokenFile=path.join(tmp,'client-token');fs.writeFileSync(tokenFile,token);
    const opts:CreateHttpServerOpts={port:0,token,host:'H',queries};usageServer=createHttpServer(opts);
    await new Promise<void>(ok=>usageServer!.listen(0,'127.0.0.1',ok));opts.port=(usageServer.address()as import('node:net').AddressInfo).port;
    const client=createApiClient({baseUrl:'http://127.0.0.1:'+opts.port,tokenFile,env:{}});const value=await client.getUsage(range);
    expect(value.snapshotScope).toBe('shared-read-transaction');expect(value.summary.range).toBe(range);expect(value.timeseries.range).toBe(range);
    expect(value.summary.timeBasis?.asOfMs).toBe(value.summary.generatedAt);expect(value.timeseries.generatedAt).toBe(value.summary.generatedAt);
    expect(value.summary.timeBasis).toEqual(value.timeseries.timeBasis);expect(value.summary.totals.events).toBe(range==='all'?2:0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(2);
  });
});
