/**
 * daemon/main.ts's `buildRuntime`/`runIngestOnce`/`ensureApiToken` against a fully isolated
 * TOKENELO_HOME (never the real `~/.claude`, `~/.codex`, or `~/Library/.../Tokenelo`) — this is a
 * real integration test (real pricing engine, real collector classes, a real temp SQLite
 * file) but with claude/codex roots pointed at empty temp directories, so it never reads the
 * machine's actual usage history and never writes outside its own tmpdir.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPaths, ensureDirs } from '../../src/daemon/paths.js';
import { saveConfig, defaultConfig } from '../../src/daemon/config.js';
import {
  buildRuntime,
  runIngestOnce,
  ensureApiToken,
  isValidApiTokenFormat,
  recordAclWarning,
  registerCollectors,
  bumpUnmeteredCounter,
  isEntryModule,
  attachMeteringBacklog,
} from '../../src/daemon/main.js';
import { createLogger } from '../../src/core/log.js';
import { META_UNMETERED_KEY } from '../../src/store/queries.js';
import { pathToFileURL } from 'node:url';

let tmpDir: string;

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function isolatedPaths(overrides?: Partial<ReturnType<typeof defaultConfig>>) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-main-'));
  const paths = getPaths({ env: { TOKENELO_HOME: tmpDir } });
  ensureDirs(paths);
  const claudeRoot = path.join(tmpDir, 'claude-projects');
  const codexHome = path.join(tmpDir, 'codex-home');
  const qwenRoot = path.join(tmpDir, 'qwen-home');
  const claudeDesktopRoot = path.join(tmpDir, 'claude-desktop-home');
  fs.mkdirSync(claudeRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(qwenRoot, { recursive: true });
  fs.mkdirSync(claudeDesktopRoot, { recursive: true });
  const config = {
    ...defaultConfig({ hostLabel: 'M4a' }),
    claude: { roots: [claudeRoot] },
    codex: { homes: [codexHome] },
    // Never the real ~/.qwen or ~/Library/.../Claude — this fixture must stay fully isolated from
    // this machine's actual usage history, same guarantee the claude/codex overrides above give.
    qwen: { roots: [qwenRoot] },
    claudeDesktop: { root: claudeDesktopRoot },
    local: { ...defaultConfig({ hostLabel: 'M4a' }).local, capture: 'off' as const },
    ...overrides,
  };
  saveConfig(paths, config);
  return paths;
}

function ensureApiTokenForTest(paths: ReturnType<typeof getPaths>): string {
  if (process.platform === 'win32') {
    return ensureApiToken(paths, undefined, {
      tightenPermissions: () => true,
      verifyDirectory: () => true,
    });
  }
  return ensureApiToken(paths);
}

describe('ensureApiToken', () => {
  it('generates a token on first call and returns the SAME token on a second call (does not rotate it)', () => {
    const paths = isolatedPaths();
    const first = ensureApiTokenForTest(paths);
    expect(first).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
    const second = ensureApiTokenForTest(paths);
    expect(second).toBe(first);
    expect(fs.existsSync(paths.apiTokenFile)).toBe(true);
  });

  it('the token file is not group/world readable on POSIX (0600)', () => {
    if (process.platform === 'win32') return; // POSIX modes are not meaningful there (see paths.ts)
    const paths = isolatedPaths();
    ensureApiTokenForTest(paths);
    const mode = fs.statSync(paths.apiTokenFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('isValidApiTokenFormat: exactly 64 hex chars, case-insensitive; rejects anything else', () => {
    expect(isValidApiTokenFormat('a'.repeat(64))).toBe(true);
    expect(isValidApiTokenFormat('A'.repeat(64))).toBe(true);
    expect(isValidApiTokenFormat('a'.repeat(63))).toBe(false);
    expect(isValidApiTokenFormat('a'.repeat(65))).toBe(false);
    expect(isValidApiTokenFormat('g'.repeat(64))).toBe(false); // not hex
    expect(isValidApiTokenFormat('')).toBe(false);
  });

  it('regenerates the token when the existing file is present but not a valid 64-hex-char token (corrupted/hand-edited)', () => {
    const paths = isolatedPaths();
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.apiTokenFile, 'not-a-real-token\n', { mode: 0o600 });
    const token = ensureApiTokenForTest(paths);
    expect(isValidApiTokenFormat(token)).toBe(true);
    expect(fs.readFileSync(paths.apiTokenFile, 'utf8').trim()).toBe(token);
  });

  it('re-tightens permissions on an existing, validly-formatted token file that was left group/world readable (POSIX)', () => {
    if (process.platform === 'win32') return;
    const paths = isolatedPaths();
    const first = ensureApiTokenForTest(paths);
    fs.chmodSync(paths.apiTokenFile, 0o644);
    const second = ensureApiTokenForTest(paths);
    expect(second).toBe(first); // still not rotated — just re-secured
    expect(fs.statSync(paths.apiTokenFile).mode & 0o777).toBe(0o600);
  });

  it('recordAclWarning + getDoctor: a Windows icacls failure is surfaced as a doctor warning', async () => {
    const paths = isolatedPaths();
    const runtime = await buildRuntime({ paths });
    try {
      recordAclWarning(runtime.db);
      const q = (await import('../../src/store/queries.js')).createQueries(runtime.db, runtime.config, {
        probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }),
      });
      const doctor = await q.getDoctor();
      expect(doctor.warnings.some((w) => w.includes('icacls'))).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});

describe('buildRuntime', () => {
  it('loads the real pricing engine and the neutral valuation seam, constructs a store, and registers the claude+codex collectors', async () => {
    const paths = isolatedPaths();
    const runtime = await buildRuntime({ paths, now: () => 1_700_000_000_000 });
    try {
      expect(runtime.pricing).not.toBeNull();
      expect(runtime.valuationEngine).not.toBeNull();
      expect(runtime.store).not.toBeNull();
      expect(runtime.collectors.map((c) => c.name).sort()).toEqual(['claude', 'claude-desktop-plan-usage', 'claude-desktop-sessions', 'codex', 'qwen-code']);
      expect(runtime.ollamaProxyHandle).toBeNull(); // local.capture: 'off' in this fixture's config
    } finally {
      await runtime.close();
    }
  });

  it('persists a config.json on first run so a second buildRuntime sees the same settings', async () => {
    const paths = isolatedPaths({ idleGapMs: 123_456 } as never);
    const runtime = await buildRuntime({ paths });
    expect(runtime.config.idleGapMs).toBe(123_456);
    await runtime.close();
  });
});

describe('runIngestOnce', () => {
  it('runs every registered collector once against empty claude/codex roots: zero files, zero events, no errors', async () => {
    const paths = isolatedPaths();
    const runtime = await buildRuntime({ paths });
    try {
      const results = await runIngestOnce(runtime);
      expect(results.map((r) => r.name).sort()).toEqual(['claude', 'claude-desktop-plan-usage', 'claude-desktop-sessions', 'codex', 'qwen-code']);
      for (const r of results) {
        expect(r.error).toBeUndefined();
        expect(r.stats?.eventsEmitted).toBe(0);
      }
    } finally {
      await runtime.close();
    }
  });

});

describe('core/log.ts default sink is stderr, never stdout (DESIGN §15.9.6)', () => {
  it('createLogger() with no sink writes the JSON line to process.stderr and nothing to process.stdout', () => {
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = (c: string) => (out.push(String(c)), true);
    (process.stderr.write as unknown) = (c: string) => (err.push(String(c)), true);
    try {
      createLogger({ now: () => 42 })('info', 'hello', { a: 1 });
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
    }
    expect(out.join('')).toBe('');
    expect(err.join('')).toBe('{"ts":42,"level":"info","msg":"hello","data":{"a":1}}\n');
  });

  it('buildRuntime without an explicit logger uses that default (no stdout writes during a full build)', async () => {
    const paths = isolatedPaths();
    const out: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (c: string) => (out.push(String(c)), true);
    let runtime: Awaited<ReturnType<typeof buildRuntime>> | undefined;
    try {
      runtime = await buildRuntime({ paths });
      runtime.log('warn', 'a warning');
    } finally {
      process.stdout.write = realOut;
    }
    expect(out.join('')).toBe('');
    await runtime!.close();
  });
});

describe('registerCollectors: one Collector per source via the real exports', () => {
  it('claude + codex always; ollama-serverlog runs for serverlog and both capture modes', () => {
    const base = defaultConfig({ hostLabel: 'ryzen' });
    const ALWAYS_ON = ['claude', 'codex', 'qwen-code', 'claude-desktop-plan-usage', 'claude-desktop-sessions'];
    expect(registerCollectors({ ...base, local: { ...base.local, capture: 'proxy' } }).map((c) => c.name)).toEqual(ALWAYS_ON);
    expect(registerCollectors({ ...base, local: { ...base.local, capture: 'off' } }).map((c) => c.name)).toEqual(ALWAYS_ON);
    const withLog = registerCollectors({ ...base, local: { ...base.local, capture: 'serverlog', serverLogPath: '/x/ollama.log' } });
    expect(withLog.map((c) => c.name)).toEqual([...ALWAYS_ON, 'ollama-serverlog']);
    expect(withLog.map((c) => c.collector.name)).toEqual([...ALWAYS_ON, 'ollama-serverlog']);
    expect(withLog[withLog.length - 1]!.watchPaths).toEqual(['/x/ollama.log']);
    expect(registerCollectors({ ...base, local: { ...base.local, capture: 'both' } }).map((c) => c.name)).toEqual([...ALWAYS_ON, 'ollama-serverlog']);
  });
});

describe('unmetered proxy requests are persisted for doctor', () => {
  it('bumpUnmeteredCounter accumulates in meta and getDoctor reports the total', async () => {
    const paths = isolatedPaths();
    const runtime = await buildRuntime({ paths });
    try {
      bumpUnmeteredCounter(runtime.db);
      bumpUnmeteredCounter(runtime.db, 2);
      const q = (await import('../../src/store/queries.js')).createQueries(runtime.db, runtime.config, {
        probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }),
      });
      expect((await q.getDoctor()).ollama.unmeteredRequests).toBe(3);
    } finally {
      await runtime.close();
    }
  });
});

describe('isEntryModule', () => {
  it('matches the entry script by file URL (incl. through a symlink) and rejects anything else', () => {
    const paths = isolatedPaths();
    const real = path.join(tmpDir, 'entry.js');
    fs.writeFileSync(real, '');
    const link = path.join(tmpDir, 'bin-link.js');
    let canCreateSymlink = true;
    try {
      fs.symlinkSync(real, link);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP')) {
        canCreateSymlink = false; // Windows Developer Mode/admin is not enabled in every test account.
      } else {
        throw err;
      }
    }
    const url = pathToFileURL(fs.realpathSync(real)).href;
    expect(isEntryModule(url, real)).toBe(true);
    if (canCreateSymlink) expect(isEntryModule(url, link)).toBe(true);
    expect(isEntryModule(url, path.join(tmpDir, 'other.js'))).toBe(false);
    expect(isEntryModule(url, undefined)).toBe(false);
    void paths;
  });
});

describe('ollama proxy wiring (main.ts side only — collectors/ollama-proxy.ts owns its own tests)', () => {
  it('the CLI path (no startProxy) never binds the proxy port even when local.capture is "proxy"', async () => {
    const paths = isolatedPaths();
    const cfg = { ...defaultConfig({ hostLabel: 'M4a' }), local: { ...defaultConfig({ hostLabel: 'M4a' }).local, capture: 'proxy' as const, proxyPort: 47914 } };
    saveConfig(paths, cfg);
    const runtime = await buildRuntime({ paths });
    try {
      expect(runtime.ollamaProxyHandle).toBeNull();
    } finally {
      await runtime.close();
    }
  });

  it('when local.capture is "proxy", buildRuntime({startProxy:true}) starts and binds a real listening proxy, and close() stops it cleanly', async () => {
    const paths = isolatedPaths();
    // Rewrite the config this fixture already saved to flip capture on with a dedicated test port.
    const cfg = { ...defaultConfig({ hostLabel: 'M4a' }), local: { ...defaultConfig({ hostLabel: 'M4a' }).local, capture: 'proxy' as const, proxyPort: 47912 } };
    saveConfig(paths, cfg);
    const runtime = await buildRuntime({ paths, startProxy: true });
    try {
      expect(runtime.ollamaProxyHandle).not.toBeNull();
    } finally {
      await runtime.close(); // must not throw even though it also closes the proxy's own listener
    }
  });

  it('when local.capture is "both", the daemon registers serverlog and starts the primary proxy with a durable backlog', async () => {
    const paths = isolatedPaths();
    const base = defaultConfig({ hostLabel: 'M4a' });
    const cfg = { ...base, local: { ...base.local, capture: 'both' as const, proxyPort: 0 } };
    saveConfig(paths, cfg);
    const runtime = await buildRuntime({ paths, startProxy: true });
    try {
      expect(runtime.collectors.map((collector) => collector.name)).toContain('ollama-serverlog');
      expect(runtime.ollamaProxyHandle).not.toBeNull();
      expect(runtime.meteringBacklog).not.toBeNull();
      expect(runtime.ollamaProxyHandle?.activeRequestCount()).toBe(0);
    } finally {
      await runtime.close();
    }
  });

  it('build item 4: config.local.upstreams[] starts one extra metering proxy per entry, independent of local.capture, and close() stops them all', async () => {
    const paths = isolatedPaths();
    const base = defaultConfig({ hostLabel: 'M4a' });
    const cfg = {
      ...base,
      // capture:'off' proves the extra upstreams are NOT gated by the primary capture switch.
      local: { ...base.local, capture: 'off' as const, upstreams: [{ name: 'docker-model-runner', upstream: 'http://127.0.0.1:47999', listenPort: 47913 }] },
    };
    saveConfig(paths, cfg);
    const runtime = await buildRuntime({ paths, startProxy: true });
    try {
      expect(runtime.ollamaProxyHandle).toBeNull();
      expect(runtime.extraMeteringProxyHandles).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it('extraMeteringProxyHandles is empty when startProxy is false (CLI path), even with upstreams configured', async () => {
    const paths = isolatedPaths();
    const base = defaultConfig({ hostLabel: 'M4a' });
    const cfg = {
      ...base,
      local: { ...base.local, upstreams: [{ name: 'vllm', upstream: 'http://127.0.0.1:48001', listenPort: 47915 }] },
    };
    saveConfig(paths, cfg);
    const runtime = await buildRuntime({ paths });
    try {
      expect(runtime.extraMeteringProxyHandles).toEqual([]);
    } finally {
      await runtime.close();
    }
  });
});


it('durably queued unmetered observations recover across restart without double-counting a committed receipt',async()=>{
  const paths=isolatedPaths();const cfg=defaultConfig({hostLabel:'M4a'});cfg.local.capture='proxy';cfg.local.proxyPort=0;saveConfig(paths,cfg);
  const first=await buildRuntime({paths,startProxy:true});
  try{
    first.meteringBacklog!.enqueue({kind:'unmetered',count:1});
    const failure=vi.spyOn(fs,'unlinkSync').mockImplementation(()=>{throw Object.assign(new Error('OWNED failure after counter commit'),{code:'EACCES'});});
    try{first.meteringBacklog!.flush();expect(first.meteringBacklog!.status().pending).toBe(1);expect(first.db.prepare("SELECT value FROM meta WHERE key=?").get(META_UNMETERED_KEY)?.value).toBe('1');}finally{try{await first.close();}finally{failure.mockRestore();}}
  }finally{await first.close();}
  const second=await buildRuntime({paths,startProxy:true});
  try{expect(second.meteringBacklog!.status().pending).toBe(1);second.meteringBacklog!.flush();expect(second.meteringBacklog!.status().pending).toBe(0);expect(second.db.prepare("SELECT value FROM meta WHERE key=?").get(META_UNMETERED_KEY)?.value).toBe('1');}finally{await second.close();}
});
it('Doctor attaches an explicitly later queue observation without overwriting the report clock or historical counts',()=>{
  const old={generatedAt:10,warnings:[],ollama:{servers:[],capture:'proxy',unmeteredRequests:3}} as unknown as import('../../src/core/types.js').DoctorReport;
  const status={observedAt:20,pending:2,quarantined:1,writeFailures:0,bytes:5,oldestQueuedAt:12,lastError:'invalid-entry' as const};
  const report=attachMeteringBacklog(old,status);expect(report.generatedAt).toBe(10);expect(report.ollama.unmeteredRequests).toBe(3);expect(report.ollama.backlog?.observedAt).toBe(20);expect(report.warnings.join(' ')).toContain('waiting to enter usage history');expect(report.warnings.join(' ')).toContain('may be incomplete');expect(old.warnings).toEqual([]);
});
