/**
 * `tokenelo` CLI dispatch (src/cli/index.ts). Every command bootstraps via
 * `daemon/main.js#buildRuntime`, which reads `TOKENELO_HOME` from the environment — these tests
 * point it at a fresh temp dir per test so nothing ever touches the real `~/.claude`, `~/.codex`,
 * or the real Tokenelo config/data directories, and restore the previous env afterwards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/cli/index.js';
import { createLogger } from '../../src/core/log.js';
import { getPaths, ensureDirs } from '../../src/daemon/paths.js';
import { saveConfig, defaultConfig } from '../../src/daemon/config.js';
import { buildRuntime } from '../../src/daemon/main.js';
import type { UsageEvent } from '../../src/core/types.js';
import { verifyShareReportDigest } from '../../src/cli/share-report.js';

let tmpDir: string;
let prevTokeneloHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cli-'));
  prevTokeneloHome = process.env.TOKENELO_HOME;
  process.env.TOKENELO_HOME = tmpDir;

  // Pin claude/codex roots at empty temp dirs and turn off local capture (no proxy port bind)
  // BEFORE any command runs — otherwise buildRuntime()'s default config would scan this
  // machine's REAL ~/.claude and ~/.codex directories (this Mac's own daemon has real usage
  // history) and try to bind the real proxy port. Every CLI command must stay fully isolated.
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
  const base = defaultConfig({ hostLabel: 'M4a' });
  saveConfig(paths, {
    ...base,
    claude: { roots: [claudeRoot] },
    codex: { homes: [codexHome] },
    // Never the real ~/.qwen or ~/Library/.../Claude — same isolation guarantee as claude/codex above.
    qwen: { roots: [qwenRoot] },
    claudeDesktop: { root: claudeDesktopRoot },
    local: { ...base.local, capture: 'off' },
  });
});

afterEach(() => {
  if (prevTokeneloHome === undefined) delete process.env.TOKENELO_HOME;
  else process.env.TOKENELO_HOME = prevTokeneloHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Captures everything written to stdout/stderr during `fn()` (console.log ultimately calls
 * process.stdout.write, so spying there catches both console.log and direct stdout.write calls
 * used by `export --format csv`). */
async function capture(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: string) => {
    outChunks.push(String(chunk));
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    errChunks.push(String(chunk));
    return true;
  };
  try {
    const code = await fn();
    return { code, stdout: outChunks.join(''), stderr: errChunks.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe('runCli: help/usage', () => {
  it('no command prints usage and exits 0', async () => {
    const { code, stdout } = await capture(() => runCli([]));
    expect(code).toBe(0);
    expect(stdout).toContain('tokenelo <command>');
  });

  it('an unknown command prints usage to stderr and exits 1', async () => {
    const { code, stderr } = await capture(() => runCli(['bogus-command']));
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown command "bogus-command"');
  });

  it('an unknown command prints the usage to stderr, nothing to stdout, and exits 1', async () => {
    const { code, stdout, stderr } = await capture(() => runCli(['bogus-command']));
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Unknown command "bogus-command"');
    expect(stderr).toContain('tokenelo <command> [options]');
    expect(stderr).toContain('Commands:');
  });
});

describe('default structured logger', () => {
  it('writes its default JSON line to stderr without polluting stdout', async () => {
    const { code, stdout, stderr } = await capture(async () => {
      createLogger({ now: () => 123 })('info', 'fixture log');
      return 0;
    });
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('{"ts":123,"level":"info","msg":"fixture log"}\n');
  });
});

describe('runCli: token', () => {
  it('prints only the token FILE PATH by default, never the token value', async () => {
    const { code, stdout } = await capture(() => runCli(['token']));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(path.join(tmpDir, 'data', 'api-token'));
    expect(stdout).not.toMatch(/[0-9a-f]{64}/); // the actual 32-byte-hex token never appears
  });

  it('--show additionally prints the real token value', async () => {
    const { stdout } = await capture(() => runCli(['token', '--show']));
    const lines = stdout.trim().split('\n');
    expect(lines[0]).toBe(path.join(tmpDir, 'data', 'api-token'));
    expect(lines[1]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('runCli: report/sessions/limits/doctor — range parsing and JSON shape', () => {
  it('report --share reads the actual ledger without bootstrap/config/token/schema mutation or identities', async () => {
    const runtime = await buildRuntime();
    try {
      // Seed stored facts directly, as the query tests do. This checks the report's read boundary,
      // without depending on ingest repricing or incomplete collector fixtures.
      const tokens = { inputFresh: 10, cacheRead: 20, output: 5, reasoning: 2, cacheWrite5m: 1, cacheWrite1h: 3,
        cacheWriteUnassigned: 7, cacheWriteAssumed1h: 1, countQuality: 'complete' };
      runtime.db.prepare(`INSERT INTO events (id,host,source,ts,ts_source,session_id,is_subagent,project,model,provider,components_json,
        input_fresh,cache_read,output,reasoning,cache_write_5m,cache_write_1h,cache_write_unassigned,cache_write_assumed_1h,count_quality,
        flags_json,api_equiv_usd,price_status,price_version,ucu_rate_status,eacs_def_sha256)
        VALUES ('PRIVATE-EVENT','PRIVATE-HOST','codex',?,'record','PRIVATE-SESSION',0,'PRIVATE-PATH','PRIVATE-MODEL','unknown',?,
          10,20,5,2,1,3,7,1,'complete','[]',0.25,'ESTIMATE','fixture','NONE','')`)
        .run(Date.now() - 1000, JSON.stringify([{ model: 'PRIVATE-MODEL', tokens }]));
    } finally { runtime.close(); }
    const paths = getPaths();
    fs.writeFileSync(paths.configFile, 'invalid JSON: aggregate reporting must not read configuration');
    const beforeDb = fs.readFileSync(paths.dbFile); const beforeConfig = fs.readFileSync(paths.configFile);
    const tokenExisted = fs.existsSync(paths.apiTokenFile);
    const { code, stdout } = await capture(() => runCli(['report', '--share', '--range=7d']));
    const report = JSON.parse(stdout);
    expect(code).toBe(0); expect(report.schema).toBe('tokenelo.aggregate-report.v3');
    expect(report.totals.events).toBe(1); expect(report.totals.tokens.completeTotal).toBe(46);
    expect(report.totals.pricing).toMatchObject({ storedApiEquivalentUsd: 0.25, estimatedPriceEvents: 1, partial: false, fieldState: 'checked', recordedFieldChecks: { events: 1, issuesEvents: 0 } });
    expect(report.sourceReconciliation.status).toBe('match'); expect(verifyShareReportDigest(report)).toBe(true);
    expect(stdout).not.toContain('PRIVATE-'); expect(fs.readFileSync(paths.dbFile)).toEqual(beforeDb);
    expect(fs.readFileSync(paths.configFile)).toEqual(beforeConfig); expect(fs.existsSync(paths.apiTokenFile)).toBe(tokenExisted);
  });

  it('report --share refuses a missing ledger without creating home directories and validates its flag', async () => {
    const { code, stderr } = await capture(() => runCli(['report', '--share=false']));
    expect(code).toBe(1); expect(stderr).toContain('--share takes no value');
    const absent = path.join(tmpDir, 'uncreated'); process.env.TOKENELO_HOME = absent;
    await expect(runCli(['report', '--share'])).rejects.toThrow('No recorded Tokenelo ledger');
    expect(fs.existsSync(absent)).toBe(false);
  });

  it('report defaults to range "7d" and emits valid JSON with that range', async () => {
    const { code, stdout } = await capture(() => runCli(['report']));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.range).toBe('7d');
    expect(parsed.totals.events).toBe(0); // empty ledger
  });

  it('accepts both --range=X and --range X forms identically', async () => {
    const a = await capture(() => runCli(['report', '--range=30d']));
    const b = await capture(() => runCli(['report', '--range', '30d']));
    expect(JSON.parse(a.stdout).range).toBe('30d');
    expect(JSON.parse(b.stdout).range).toBe('30d');
  });

  it('rejects an invalid --range value with exit code 1 and never falls back to a silent default', async () => {
    const { code, stderr, stdout } = await capture(() => runCli(['report', '--range', 'nonsense']));
    expect(code).toBe(1);
    expect(stderr).toContain('--range must be one of');
    expect(stdout).toBe('');
  });

  it('sessions defaults to range "today" and honors --active', async () => {
    const { stdout } = await capture(() => runCli(['sessions', '--active']));
    const parsed = JSON.parse(stdout);
    expect(parsed.range).toBe('today');
    expect(parsed.sessions).toEqual([]);
  });

  it('limits/doctor all run and print valid JSON on an empty ledger', async () => {
    for (const cmd of ['limits', 'doctor']) {
      const { code, stdout } = await capture(() => runCli([cmd]));
      expect(code, `command "${cmd}" exit code`).toBe(0);
      const parsed = JSON.parse(stdout);
      if (cmd === 'doctor') {
        expect(parsed.incompleteCapture).toEqual([{ collector: 'claude', heldFiles: 0, oldestHeldAt: null, maxLineBytes: null }]);
      }
    }
  });

  it('doctor emits persisted Claude hold counts without paths or private marker fields', async () => {
    const runtime = await buildRuntime();
    const privatePath = path.join(tmpDir, 'claude-projects', '-private', 'held-session.jsonl');
    const privateDigest = 'a'.repeat(64);
    try {
      runtime.store.setState({
        key: privatePath, size: 100, mtimeMs: 10, offset: 12, ino: 7,
        extra: { claudeHold: { heldSince: 1234, maxLineBytes: 4096, prefixSha256: privateDigest } },
      });
    } finally {
      await runtime.close();
    }
    const { code, stdout } = await capture(() => runCli(['doctor']));
    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.incompleteCapture).toEqual([{ collector: 'claude', heldFiles: 1, oldestHeldAt: 1234, maxLineBytes: 4096 }]);
    expect(stdout).not.toContain(privatePath);
    expect(stdout).not.toContain(privateDigest);
  });
});

describe('runCli: ingest', () => {
  it.each(['--dry-run', '--help', 'unexpected'])('rejects unsupported ingest argument %s before creating a ledger or API token', async (arg) => {
    const paths = getPaths();
    expect(fs.existsSync(paths.dbFile)).toBe(false);
    expect(fs.existsSync(paths.apiTokenFile)).toBe(false);

    const { code, stdout, stderr } = await capture(() => runCli(['ingest', arg]));
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('ingest accepts no options or positional arguments');
    expect(stderr).toContain('has no --dry-run mode');
    expect(fs.existsSync(paths.dbFile)).toBe(false);
    expect(fs.existsSync(paths.apiTokenFile)).toBe(false);
  });
  it('runs the registered collectors against this fixture\'s empty claude/codex roots and reports zero events, not an error', async () => {
    const { code, stdout } = await capture(() => runCli(['ingest']));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results.map((r: { name: string }) => r.name).sort()).toEqual([
      'claude',
      'claude-desktop-plan-usage',
      'claude-desktop-sessions',
      'codex',
      'qwen-code',
    ]);
    for (const r of parsed.results) expect(r.error).toBeUndefined();
  });
});

describe('runCli: serve', () => {
  it.each(['--dry-run', '--help', 'unexpected'])('rejects unsupported serve argument %s before starting the daemon', async (arg) => {
    const paths = getPaths();
    expect(fs.existsSync(paths.dbFile)).toBe(false);
    expect(fs.existsSync(paths.apiTokenFile)).toBe(false);

    const { code, stdout, stderr } = await capture(() => runCli(['serve', arg]));
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('serve accepts no options or positional arguments');
    expect(stderr).toContain('has no --dry-run mode');
    expect(fs.existsSync(paths.dbFile)).toBe(false);
    expect(fs.existsSync(paths.apiTokenFile)).toBe(false);
  });
});
describe('runCli: reprice', () => {
  it('on an empty ledger reports {inserted:0, updated:0, unchanged:0}', async () => {
    const { code, stdout } = await capture(() => runCli(['reprice']));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ inserted: 0, updated: 0, unchanged: 0 });
  });
});

describe('runCli: export', () => {
  it('exports stored token components through the actual CLI without inventing optional coverage', async () => {
    const runtime = await buildRuntime();
    try {
      const event: UsageEvent = {
        id: 'synthetic-export-event', host: 'example-host', source: 'codex', ts: Date.now(), tsSource: 'record',
        sessionId: 'synthetic-export-session', isSubagent: false, model: 'unpriced-example', provider: 'openai',
        components: [{ model: 'unpriced-example', tokens: {
          inputFresh: 12, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 40, output: 10, reasoning: 4,
        } }],
        tokens: { inputFresh: 12, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 40, output: 10, reasoning: 4 },
        flags: [], apiEquivUsd: null, priceStatus: 'UNPRICED', priceVersion: 'example',
        reservedValue: null, ucuRateStatus: 'NONE', eacsDefSha256: '',
      };
      runtime.store.upsertEvents([event]);
    } finally { runtime.close(); }
    const json = await capture(() => runCli(['export', '--format', 'json']));
    const stored = JSON.parse(json.stdout)[0];
    const csv = await capture(() => runCli(['export', '--format', 'csv']));
    expect(json.code).toBe(0); expect(csv.code).toBe(0);
    const [header, line] = csv.stdout.trimEnd().split('\n');
    const names = header!.split(','); const cells = line!.split(',');
    for (const name of ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning']) {
      expect(cells[names.indexOf(name)]).toBe(String(stored.tokens[name]));
    }
    expect(cells[names.indexOf('cacheWriteUnassigned')]).toBe('');
    expect(cells[names.indexOf('countQuality')]).toBe('unrecorded');
    expect(cells[names.indexOf('apiEquivUsd')]).toBe('');
    // The JSON component column contains commas; the three trailing contract fields
    // are checked as a suffix rather than by naively splitting that quoted cell.
    expect(csv.stdout.endsWith(',api-equivalent-not-billed,3,\n')).toBe(true);
    expect(JSON.parse((await capture(() => runCli(['export']))).stdout)).toEqual([stored]);
  });
  it('--format json prints an empty array for an empty ledger', async () => {
    const { code, stdout } = await capture(() => runCli(['export', '--format', 'json']));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('--format csv prints just the header row for an empty ledger', async () => {
    const { code, stdout } = await capture(() => runCli(['export', '--format', 'csv']));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('id,host,source,ts,sessionId,model,provider,apiEquivUsd,priceStatus,priceVersion,inputFresh,cacheWrite5m,cacheWrite1h,cacheWriteUnassigned,cacheWriteAssumed1h,cacheRead,output,reasoning,countQuality,ucuCountQuality,tsSource,engine,thinking,speed,effort,serviceTier,inferenceGeo,flags,components,costBasis,exportSchemaVersion,fieldEvidence');
  });

  it('an invalid --format is rejected (exit 1) rather than silently defaulting to json', async () => {
    const { code, stderr } = await capture(() => runCli(['export', '--format', 'xml']));
    expect(code).toBe(1);
    expect(stderr).toContain('--format must be "csv" or "json"');
  });

  it('mutation check: default format (no --format given) is json, matching the documented default, not csv', async () => {
    const { stdout } = await capture(() => runCli(['export']));
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

describe('runCli: EPIPE from a closed downstream pipe is not a crash', () => {
  // Exercise the real CLI entry without a tsx command wrapper, using an OS pipe. A header-only
  // export can fit in one write and never exercise the EPIPE guard; use a large stored row.
  it('the actual CLI binary exits 0 with no stack trace when stdout is closed early by the reader', async () => {
    const deadline = performance.now() + 13_000; // Cleanup remains inside the original 15s case.
    const { spawn } = await import('node:child_process');
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    expect(fs.existsSync(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'))).toBe(true);
    const runtime = await buildRuntime();
    try {
      const tokens: UsageEvent['tokens'] = { inputFresh: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, reasoning: 0 };
      runtime.store.upsertEvents([{
        id: 'synthetic-pipe-export-event', host: 'example-host', source: 'codex',
        ts: Date.now(), tsSource: 'record', sessionId: 'synthetic-pipe-' + 'x'.repeat(1024 * 1024),
        isSubagent: false, model: 'unpriced-example', provider: 'openai', tokens,
        components: [{ model: 'unpriced-example', tokens }], flags: [],
        apiEquivUsd: null, priceStatus: 'UNPRICED', priceVersion: 'example',
        reservedValue: null, ucuRateStatus: 'NONE', eacsDefSha256: '',
      }]);
    } finally { runtime.close(); }

    // Direct Node preload avoids the tsx command's wrapper process. It still runs the
    // actual CLI entry/main-module EPIPE handler, never runCli() inside the test process.
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'export', '--format', 'csv'], {
      cwd: repoRoot, windowsHide: true, env: { ...process.env, TOKENELO_HOME: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '', received = 0, closed = false;
    let primaryFailed = false, primaryError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Register error/close before waiting for output: early exit cannot lose its event.
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('error', reject); child.stderr.once('error', reject);
      child.stderr.on('data', c => { stderr += String(c); });
      child.once('close', (code, signal) => {
        closed = true;
        if (received === 0) reject(new Error(`CLI closed before producing output: ${stderr}`));
        else resolve({ code, signal });
      });
      child.stdout.once('data', chunk => { received = chunk.length; child.stdout.destroy(); });
      timer = setTimeout(() => reject(new Error(`CLI pipe did not close within the original case budget: ${stderr}`)), Math.max(1, deadline - performance.now()));
    });
    try {
      const exited = await completed;
      expect(stderr).not.toContain('EPIPE');
      expect(exited).toEqual({ code: 0, signal: null });
      expect(received).toBeGreaterThan(0);
      expect(received).toBeLessThan(1024 * 1024); // Reader closed before the large row was consumed.
      expect(stderr).not.toContain("Emitted 'error' event");
    } catch (error) { primaryFailed = true; primaryError = error; throw error; } finally {
      clearTimeout(timer);
      if (!closed) {
        // Only the Node root created by this case; no whole-descendant claim for tsx/esbuild.
        try {
          child.kill('SIGKILL');
          await new Promise<void>((resolve, reject) => {
            const cleanup = setTimeout(() => reject(new Error('Owned CLI child failed to close during cleanup')), 1000);
            child.once('close', () => { clearTimeout(cleanup); resolve(); });
          });
        } catch (cleanupError) {
          if (primaryFailed) throw new AggregateError([primaryError, cleanupError], 'CLI failure and owned-root cleanup failure');
          throw cleanupError;
        }
      }
    }
  }, 15_000);
});
