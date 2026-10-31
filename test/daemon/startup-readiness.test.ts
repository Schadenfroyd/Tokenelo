import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { main } from '../../src/daemon/main.js';
import { CodexCollector } from '../../src/collectors/codex.js';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import { defaultConfig, saveConfig } from '../../src/daemon/config.js';
import { ensureDirs, getPaths } from '../../src/daemon/paths.js';
import * as fleetModule from '../../src/daemon/fleet.js';
import { ReportReads } from '../../src/daemon/report-reads.js';
import { ReportReadError } from '../../src/daemon/report-read-protocol.js';

vi.mock('../../src/daemon/fleet.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/fleet.js')>();
  return { ...actual, ensureFleetToken: vi.fn(() => 'a'.repeat(64)) };
});

// These startup tests exercise the real main/API-token path with synthetic TOKENELO_HOME data.
// Keep token generation, persistence, HTTP bearer validation, listeners, and shutdown real, while
// replacing only the ACL adapter for each registered test-owned data directory. Windows ACL
// mechanics are covered separately by the native ACL tests.
const syntheticAclDataDirs = vi.hoisted(() => new Map<string, {
  apiTokenFile: string; fileChecks: number; directoryChecks: number;
}>());
vi.mock('../../src/daemon/paths.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/daemon/paths.js')>();
  return {
    ...actual,
    tightenSecretFilePermissions: (filePath: string) => {
      if (process.platform !== 'win32') return actual.tightenSecretFilePermissions(filePath);
      const owned = syntheticAclDataDirs.get(path.dirname(filePath));
      if (!owned) throw new Error('synthetic ACL adapter received an unregistered directory');
      const basename = path.basename(filePath);
      const stagingPrefix = '.' + path.basename(owned.apiTokenFile) + '.' + process.pid + '.';
      if (filePath !== owned.apiTokenFile && !(basename.startsWith(stagingPrefix) &&
          /^[0-9a-f]{24}\.tmp$/.test(basename.slice(stagingPrefix.length)))) {
        throw new Error('synthetic ACL adapter received an unowned token path');
      }
      owned.fileChecks++;
      return true;
    },
    verifySecretDirectoryPermissions: (directoryPath: string) => {
      if (process.platform !== 'win32') return actual.verifySecretDirectoryPermissions(directoryPath);
      const owned = syntheticAclDataDirs.get(directoryPath);
      if (!owned) throw new Error('synthetic ACL adapter received an unregistered directory');
      owned.directoryChecks++;
      return true;
    },
  };
});

function assertSyntheticTokenAdapterUsed(dataDir: string): void {
  if (process.platform !== 'win32') return;
  const owned = syntheticAclDataDirs.get(dataDir);
  expect(owned?.fileChecks).toBeGreaterThan(0);
  expect(owned?.directoryChecks).toBeGreaterThan(0);
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); });

async function waitFor<T>(probe: () => Promise<T>): Promise<T> {
  const end = Date.now() + 2000;
  let last: unknown;
  while (Date.now() < end) {
    try { return await probe(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw last ?? new Error('fixture observation did not complete');
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}



describe('authenticated API readiness during the first local-history scan', () => {
  it.each([{ fails: false, stopEarly: false }, { fails: true, stopEarly: false }, { fails: false, stopEarly: true }])('serves honest first-scan state and retires safely (%j)', async ({ fails, stopEarly }) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-startup-readiness-'));
    const previousHome = process.env.TOKENELO_HOME;
    process.env.TOKENELO_HOME = temp;
    const paths = getPaths(); ensureDirs(paths); syntheticAclDataDirs.set(paths.dataDir, { apiTokenFile: paths.apiTokenFile, fileChecks: 0, directoryChecks: 0 });
    const roots = ['claude', 'codex', 'qwen', 'desktop'].map(name => path.join(temp, name));
    roots.forEach(root => fs.mkdirSync(root));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const config = defaultConfig({ hostLabel: 'StartupFixture' });
    saveConfig(paths, { ...config, claude: { ...config.claude, roots: [roots[0]!] }, codex: { homes: [roots[1]!] },
      qwen: { roots: [roots[2]!] }, claudeDesktop: { root: roots[3]! }, local: { ...config.local, capture: 'off' },
      api: { port }, fleet: { ...config.fleet, listenAddress: null, peers: [] } });
    let release!: () => void;
    let entered!: () => void;
    const scanEntered = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(ClaudeCollector.prototype, 'scan').mockImplementation(async () => {
      entered();
      await held;
      if (fails) throw new Error('synthetic fixture scan failure');
      return { collector: 'claude', filesScanned: 0, filesSkipped: 0, eventsEmitted: 0, bytesRead: 0, warnings: [], durationMs: 0 };
    });
    const codexScan = stopEarly ? vi.spyOn(CodexCollector.prototype, 'scan') : undefined;
    const oldHandlers = new Set(process.listeners('SIGTERM'));
    const oldInterruptHandlers = new Set(process.listeners('SIGINT'));
    const exited = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const running = main();
    let released = false;
    cleanup = async () => {
      if (!released) { release(); released = true; }
      await running;
      process.emit('SIGTERM');
      await waitFor(async () => { expect(exited).toHaveBeenCalled(); });
      for (const handler of process.listeners('SIGTERM')) if (!oldHandlers.has(handler)) process.off('SIGTERM', handler);
      for (const handler of process.listeners('SIGINT')) if (!oldInterruptHandlers.has(handler)) process.off('SIGINT', handler);
      syntheticAclDataDirs.delete(paths.dataDir);
      if (previousHome === undefined) delete process.env.TOKENELO_HOME; else process.env.TOKENELO_HOME = previousHome;
      fs.rmSync(temp, { recursive: true, force: true });
    };
    const readHealth = async () => {
      const token = fs.readFileSync(paths.apiTokenFile, 'utf8').trim();
      const response = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
      expect(response.status).toBe(200); return response.json() as Promise<{ status: string; initialCaptureState: string }>;
    };
    // Observe availability during the actual held scan, after unrelated key/bootstrap setup.
    // The existing two-second observation and overall test timeout remain unchanged.
    await scanEntered;
    const before = await waitFor(readHealth);
    assertSyntheticTokenAdapterUsed(paths.dataDir);
    expect(before).toMatchObject({ status: 'ok', initialCaptureState: 'running' });
    // Actual daemon HTTP is available while its real collector scan promise remains unresolved.
    if (stopEarly) {
      process.emit('SIGTERM');
      await Promise.resolve();
      expect(exited).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(paths.lockFile,'utf8')).pid).toBe(process.pid);
      // An accepted scan must finish before its ledger and ownership can close.
      release(); released = true; await running;
      await waitFor(async () => { expect(exited).toHaveBeenCalled(); });
      expect(codexScan).not.toHaveBeenCalled();
      return;
    }
    release(); released = true; await running;
    expect(await readHealth()).toMatchObject({ status: 'ok', initialCaptureState: fails ? 'failed' : 'complete' });
  });
});


describe('main signal ownership during real listener startup', () => {
  it.each(['loopback', 'fleet'] as const)('gates admitted report work during %s listen and waits for retirement before closing ownership', async phase => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-main-listener-signal-'));
    const previousHome = process.env.TOKENELO_HOME;
    process.env.TOKENELO_HOME = temp;
    const paths = getPaths(); ensureDirs(paths); syntheticAclDataDirs.set(paths.dataDir, { apiTokenFile: paths.apiTokenFile, fileChecks: 0, directoryChecks: 0 });
    const roots = ['claude', 'codex', 'qwen', 'desktop'].map(name => path.join(temp, name));
    roots.forEach(root => fs.mkdirSync(root));
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const config = defaultConfig({ hostLabel: 'StartupFixture' });
    saveConfig(paths, {
      ...config,
      claude: { ...config.claude, roots: [roots[0]!] },
      codex: { homes: [roots[1]!] },
      qwen: { roots: [roots[2]!] },
      claudeDesktop: { root: roots[3]! },
      local: { ...config.local, capture: 'off', upstreams: [] },
      api: { port },
      fleet: { ...config.fleet, listenAddress: phase === 'fleet' ? '100.64.0.7' : null, peers: [] },
    });

    const oldTermHandlers = new Set(process.listeners('SIGTERM'));
    const oldInterruptHandlers = new Set(process.listeners('SIGINT'));
    const exited = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let dbCloseCalls = 0;
    const realDbClose = DatabaseSync.prototype.close;
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
      dbCloseCalls++;
      return realDbClose.call(this);
    });

    const fleetToken = 'a'.repeat(64);
    vi.mocked(fleetModule.ensureFleetToken).mockReturnValue(fleetToken);

    let readEnteredSeen = false;
    const readReply = deferred<unknown>();
    void readReply.promise.catch(() => {});
    let readReplyReleased = false;
    const releaseReadReply = () => {
      if (readReplyReleased) return;
      readReplyReleased = true;
      readReply.reject(new ReportReadError('read_cancelled'));
    };
    vi.spyOn(ReportReads.prototype, 'readAfterRetirement').mockImplementation((async () => {
      readEnteredSeen = true;
      return readReply.promise;
    }) as unknown as typeof ReportReads.prototype.readAfterRetirement);

    const retirement = deferred<void>();
    let retirementReleased = false;
    const releaseRetirement = () => {
      if (retirementReleased) return;
      retirementReleased = true;
      retirement.resolve();
    };
    let closeCalls = 0;
    const realReportClose = ReportReads.prototype.close;
    vi.spyOn(ReportReads.prototype, 'close').mockImplementation(async function (this: ReportReads) {
      closeCalls++;
      await retirement.promise;
      await realReportClose.call(this);
    });

    const realListen = net.Server.prototype.listen;
    let listenerReadySeen = false;
    let listenCalls = 0;
    let fleetListenPort: number | undefined;
    let holdMainListenCallback = true;
    let releaseMainListenCallback: (() => void) | undefined;
    const targetListenCall = phase === 'loopback' ? 1 : 2;
    const listenerListenStarted = deferred<void>();
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, ...args: any[]) {
      let callbackIndex = -1;
      for (let index = args.length - 1; index >= 0; index--) {
        if (typeof args[index] === 'function') { callbackIndex = index; break; }
      }
      if (callbackIndex < 0) return (realListen as any).apply(this, args);
      listenCalls++;
      if (listenCalls !== targetListenCall) return (realListen as any).apply(this, args);

      // Do not spend the callback-readiness window on buildRuntime or secure-token setup.
      // The bound remains measured from the actual intercepted listener invocation.
      listenerListenStarted.resolve();
      const callback = args[callbackIndex] as (...callbackArgs: unknown[]) => void;
      if (phase === 'fleet') {
        // Keep the real main/Fleet server, but bind this test-only socket to loopback and an ephemeral port.
        args[0] = 0;
        args[1] = '127.0.0.1';
      }
      args[callbackIndex] = (...callbackArgs: unknown[]) => {
        if (phase === 'fleet') fleetListenPort = (this.address() as net.AddressInfo).port;
        listenerReadySeen = true;
        const release = () => callback(...callbackArgs);
        releaseMainListenCallback = release;
        if (!holdMainListenCallback) release();
      };
      return (realListen as any).apply(this, args);
    });

    let running: Promise<number> | undefined;
    let mainFinished = false;
    let cleaned = false;
    const cleanupTest = async () => {
      if (cleaned) return;
      cleaned = true;
      holdMainListenCallback = false;
      releaseMainListenCallback?.();
      releaseRetirement();
      releaseReadReply();
      await running?.catch(() => {});
      if (!exited.mock.calls.length) {
        const hasShutdownHandler = process.listeners('SIGTERM').some(handler => !oldTermHandlers.has(handler));
        if (hasShutdownHandler) {
          process.emit('SIGTERM');
          await waitFor(async () => { expect(exited).toHaveBeenCalled(); });
        }
      }
      for (const handler of process.listeners('SIGTERM')) if (!oldTermHandlers.has(handler)) process.off('SIGTERM', handler);
      for (const handler of process.listeners('SIGINT')) if (!oldInterruptHandlers.has(handler)) process.off('SIGINT', handler);
      syntheticAclDataDirs.delete(paths.dataDir);
      if (previousHome === undefined) delete process.env.TOKENELO_HOME; else process.env.TOKENELO_HOME = previousHome;
      fs.rmSync(temp, { recursive: true, force: true });
    };
    cleanup = cleanupTest;

    try {
      running = main();
      running = running.finally(() => { mainFinished = true; });
      await listenerListenStarted.promise;
      await waitFor(async () => { expect(listenerReadySeen).toBe(true); });

      // This assertion intentionally fails the old ordering: main must have installed handlers
      // before its real local or Fleet Server.listen callback is allowed to return.
      const earlyHandlers = process.listeners('SIGTERM').filter(handler => !oldTermHandlers.has(handler));
      expect(earlyHandlers.length).toBeGreaterThan(0);
      assertSyntheticTokenAdapterUsed(paths.dataDir);

      const token = fs.readFileSync(paths.apiTokenFile, 'utf8').trim();
      const lease = 'b'.repeat(32);
      const admitted = await fetch('http://127.0.0.1:' + port + '/v1/summary/read?range=all', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'x-tokenelo-read-lease': lease },
        signal: AbortSignal.timeout(500),
      });
      expect(admitted.status).toBe(202);
      await waitFor(async () => { expect(readEnteredSeen).toBe(true); });

      process.emit('SIGTERM');
      const rejectedAdmission = await fetch('http://127.0.0.1:' + port + '/v1/summary/read?range=all', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'x-tokenelo-read-lease': 'c'.repeat(32) },
        signal: AbortSignal.timeout(500),
      });
      expect(rejectedAdmission.status).toBe(503);
      expect(closeCalls).toBe(0);
      expect(dbCloseCalls).toBe(0);
      expect(fs.existsSync(paths.lockFile)).toBe(true);
      expect(exited).not.toHaveBeenCalled();

      if (phase === 'fleet') {
        if (fleetListenPort === undefined) throw new Error('Fleet startup listener did not expose its test loopback port');
        const fleetResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const request = http.request({
            host: '127.0.0.1',
            port: fleetListenPort,
            path: '/v1/fleet/summary?range=7d',
            method: 'GET',
            headers: { host: '100.64.0.7:' + fleetModule.FLEET_PORT, authorization: 'Bearer ' + fleetToken },
          }, response => {
            let body = '';
            response.on('data', chunk => body += chunk);
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
          });
          request.on('error', reject);
          request.setTimeout(500, () => request.destroy(new Error('Fleet admission response timed out')));
          request.end();
        });
        expect(fleetResponse.status).toBe(503);
      }

      holdMainListenCallback = false;
      releaseMainListenCallback?.();
      await waitFor(async () => { expect(mainFinished).toBe(true); });
      await running;
      await waitFor(async () => { expect(closeCalls).toBeGreaterThan(0); });
      expect(closeCalls).toBeGreaterThan(0);
      expect(dbCloseCalls).toBe(0);
      expect(fs.existsSync(paths.lockFile)).toBe(true);
      expect(exited).not.toHaveBeenCalled();

      const healthWhileRetiring = await fetch('http://127.0.0.1:' + port + '/v1/health', {
        headers: { authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(500),
      });
      expect(healthWhileRetiring.status).toBe(200);

      releaseRetirement();
      releaseReadReply();
      await waitFor(async () => { expect(exited).toHaveBeenCalledWith(0); });
      expect(dbCloseCalls).toBeGreaterThan(0);
      expect(fs.existsSync(paths.lockFile)).toBe(false);
    } finally {
      await cleanupTest();
      cleanup = undefined;
    }
  });
});
