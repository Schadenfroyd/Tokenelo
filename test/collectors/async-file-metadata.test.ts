import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createScheduler } from '../../src/daemon/scheduler.js';
import { createProfiler, setActiveProfiler } from '../../src/core/phase-profile.js';
import { expect, it, vi } from 'vitest';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { CodexCollector } from '../../src/collectors/codex.js';
import { createHttpServer, closeHttpReads } from '../../src/daemon/http.js';
import type { Queries } from '../../src/store/queries.js';
import { makeHarness, baseTestConfig } from '../claude/helpers.js';
import { MemoryStore, makeCtx } from '../codex/helpers.js';

function fixture(kind: 'claude' | 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-async-stat-'));
  const file = kind === 'claude'
    ? path.join(root, '-project', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl')
    : path.join(root, 'sessions', 'rollout-2026-09-01T00-00-00-01a08127-9a3d-7220-a867-0b45fa2e2dab.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
  const h = makeHarness(baseTestConfig({ roots: [root] })), store = new MemoryStore();
  return { root, file, h, store, scan: () => kind === 'claude' ? new ClaudeCollector().scan(h.ctx)
    : new CodexCollector({ homes: [root] }).scan(makeCtx(store, [root])) };
}

it.each(['claude', 'codex'] as const)('%s: a pending file metadata read leaves the real identity and health API responsive', async kind => {
  const f = fixture(kind), nativeStat = fs.promises.stat.bind(fs.promises), nativeSync = fs.statSync.bind(fs);
  let targetSyncCalls = 0;
  const syncSpy = vi.spyOn(fs, 'statSync').mockImplementation((...args) => { if (String(args[0]) === f.file) targetSyncCalls++; return Reflect.apply(nativeSync, fs, args); });
  let release!: () => void, entered!: () => void, completed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((...args) => {
    if (String(args[0]) === f.file) { entered(); return gate.then(() => Reflect.apply(nativeStat, fs.promises, args)); }
    return Reflect.apply(nativeStat, fs.promises, args);
  });
  const opts = { port: 0, token: 'fixture-only-api-token', host: 'TEST', queries: {} as Queries };
  const server = createHttpServer(opts), scheduler = createScheduler([{ name: kind, intervalMs: 30000, run: f.scan }]);
  let scan: ReturnType<typeof scheduler.runAllOnce> | undefined;
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); opts.port = (server.address() as { port: number }).port;
    scan = scheduler.runAllOnce().finally(() => { completed = true; });
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Collector never awaited async file stat')), 1000); })]); }
    finally { clearTimeout(timer!); }
    expect(targetSyncCalls).toBe(0); expect(completed).toBe(false);
    expect(scheduler.snapshot()[0]).toMatchObject({ running: true, lastCompletedAt: null });
    expect(scheduler.snapshot()[0]!.currentStartedAt).not.toBeNull();
    expect((kind === 'claude' ? f.h.ledger : f.store).getState(f.file)).toBeUndefined();
    expect(f.h.ledger.getEvents({})).toHaveLength(0); expect(f.store.events.size).toBe(0);
    const nonce = 'ab'.repeat(16), base = `http://127.0.0.1:${opts.port}`;
    const hello = await fetch(`${base}/v1/hello?nonce=${nonce}`, { signal: AbortSignal.timeout(1000) });
    expect(hello.status).toBe(200); expect(await hello.json()).toEqual({ proof: crypto.createHmac('sha256', opts.token).update(nonce).digest('hex') });
    const health = await fetch(`${base}/v1/health`, { headers: { Authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(1000) });
    expect(health.status).toBe(200); expect((await health.json()).status).toBe('ok'); expect(completed).toBe(false);
    release(); const result = await scan, stats = result[0]!.stats!;
    expect(scheduler.snapshot()[0]).toMatchObject({ running: false });
    expect(scheduler.snapshot()[0]!.lastCompletedAt).not.toBeNull();
    expect((kind === 'claude' ? f.h.ledger : f.store).getState(f.file)).toBeDefined(); expect(stats.filesScanned).toBe(1); expect(stats.eventsEmitted).toBe(0); expect(targetSyncCalls).toBe(0);
    expect(spy.mock.calls.some(args => String(args[0]) === f.file && args[1]?.bigint === true)).toBe(true);
  } finally {
    release(); await scan; spy.mockRestore(); syncSpy.mockRestore(); await closeHttpReads(server); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve())); f.h.close(); fs.rmSync(f.root, { recursive: true, force: true });
  }
}, 5000);

it.each(['claude', 'codex'] as const)('%s: rejected asynchronous metadata preserves the unreadable skip and does not advance its cursor', async kind => {
  const f = fixture(kind), nativeStat = fs.promises.stat.bind(fs.promises), nativeSync = fs.statSync.bind(fs);
  let targetSyncCalls = 0;
  const syncSpy = vi.spyOn(fs, 'statSync').mockImplementation((...args) => { if (String(args[0]) === f.file) targetSyncCalls++; return Reflect.apply(nativeSync, fs, args); });
  const spy = vi.spyOn(fs.promises, 'stat').mockImplementation((...args) => String(args[0]) === f.file
    ? Promise.reject(Object.assign(new Error('fixture unreadable'), { code: 'EACCES' })) : Reflect.apply(nativeStat, fs.promises, args));
  try {
    const lines: Record<string, unknown>[] = [];
    const profiler = createProfiler({ sink: { write: line => { lines.push(line); }, flush: () => {} }, windowStartMs: 0 });
    setActiveProfiler(profiler);
    const stats = await f.scan(); profiler.flushStats(1);
    expect(lines.some(line => line.type === 'interval' && line.name === `${kind}.stat_io`)).toBe(true);
    expect(stats.filesSkipped).toBe(1); expect(targetSyncCalls).toBe(0);
    expect((kind === 'claude' ? f.h.ledger : f.store).getState(f.file)).toBeUndefined();
    expect(f.h.ledger.getEvents({})).toHaveLength(0); expect(f.store.events.size).toBe(0);
  } finally { setActiveProfiler(null); spy.mockRestore(); syncSpy.mockRestore(); f.h.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
});
