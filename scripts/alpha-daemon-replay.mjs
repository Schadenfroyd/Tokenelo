#!/usr/bin/env node
/**
 * Whole-daemon copy kill / restart / control-equivalence harness.
 *
 * Each daemon runs the COMPILED `main()` from dist/daemon/main.js in its own worker process, with an isolated home,
 * an allocated loopback port, Fleet off, local capture off and no upstreams. It creates its own Runtime, SqliteLedger,
 * lock, schedule and HTTP listener exactly as the installed daemon does.
 *
 * Test seams (the only instrumentation; all installed before main() is imported in the worker):
 *   1. Write observation: `SqliteLedger.prototype.upsertEvents` and `recordActivity` are wrapped to count rows passed
 *      to each call that RETURNS (attempts that completed, by source). These are not new-insert counts: upserts merge
 *      duplicates and the seed may already hold the rows.
 *   2. Pause: on the first advancing offset commit (`setState` with offset > 0) for the chosen input root, the wrapper
 *      writes a marker containing the write observation so far and the worker pid, then blocks synchronously
 *      (Atomics.wait). The parent SIGKILLs it. Events and activity for that window were committed by their own
 *      transactions before the cursor; the cursor itself is not. The pause is inside the INITIAL ingest, which runs
 *      before `server.listen`, so the API is not bound at the pause point.
 *   3. Stop: control and unchanged runs end with `process.emit('SIGTERM')` inside the worker, invoked by an IPC message.
 *      That runs the daemon's own shutdown handler. It is a harness invocation, not a Windows OS signal.
 *
 * Inputs are frozen replay bytes (generated Claude transcripts and the repo's sanitized Codex rollout, or --input-root).
 * The crash case cuts each file mid-line, then appends the remaining bytes while the daemon is dead. This is not a
 * model of growing live input.
 *
 * Fingerprint (streamed, never materialized): every events column (SELECT *, ordered by id); every activity column
 * except the autoincrement id, in a total order over all of its columns; token sums; API-equivalent value sum; cursors
 * (relative names under the run's input root, external seed cursors counted and hashed without paths); quick_check.
 * Excluded tables and why: `meta` (volatile), `skipped` (last_seen is a timestamp; only its row count is kept),
 * `limits` and `desktop_sessions` (not written by the replayed inputs; their timestamps are volatile).
 * Input-root path normalization: applied per row only if the run's input root text occurs in a row; the number of
 * normalized rows is recorded (expected 0 for content-only inputs).
 *
 * Isolation: --out must be a NEW absolute path outside the user's home directory. Every daemon gets HOME, USERPROFILE,
 * APPDATA, LOCALAPPDATA, XDG_*, TOKENELO_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR inside its run directory. Config is
 * written with the daemon's own saveConfig and explicit roots, homes, port, Fleet off, capture off.
 *
 * Usage:
 *   node scripts/alpha-daemon-replay.mjs --out <absolute new dir> [--build <dir with dist/ and rates/>]
 *        [--seed-ledger <WAL-free consistent SQLite file>] [--input-root <dir with claude/ and codex/ jsonl>]
 *        [--pause-timeout-ms <n>] [--self-test-missing-marker]
 *
 * Exit status 0 only if every check passes. Probe budgets are a check: a 200 over budget fails the report, and the
 * remaining checks still run and are reported.
 *
 * NOT proven by this harness: live input growth; GPU or model compute; Fleet peers or the Tailscale listener; physical
 * power loss; a kill inside a SQLite transaction; a graceful Windows OS signal; the Coverage live process-table read
 * (read-only, never hashed or stored); the daemon's behaviour under a real Tailscale listener; A2000-scale performance.
 */
import { fork, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), '..');
/** Proposed budget (A2000 recovery doc). Recorded and checked, never relaxed. */
const PROBE_BUDGET_MS = 3000;
const LISTEN_TIMEOUT_MS = 300_000;
const DEFAULT_PAUSE_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 90_000;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const SOURCE_FILES = ['daemon/main.js', 'daemon/scheduler.js', 'daemon/lock.js', 'daemon/http.js', 'store/ledger.js'];

/** Every daemon worker this process started and has not seen exit. Cleaned up in one place (see main's finally). */
const owned = new Map(); // child -> Promise that resolves on exit

// ── worker role: the daemon process ────────────────────────────────────────────────────────────

async function daemonWorker() {
  const job = JSON.parse(process.env.ALPHA_DAEMON_JOB);
  const dist = (rel) => pathToFileURL(path.join(job.buildRoot, 'dist', rel)).href;
  const { SqliteLedger } = await import(dist('store/ledger.js'));

  // Write observation: counts rows handed to calls that returned. Installed for every worker.
  const writes = { eventCalls: 0, activityCalls: 0, eventsBySource: {}, activityBySource: {} };
  const upsertOriginal = SqliteLedger.prototype.upsertEvents;
  SqliteLedger.prototype.upsertEvents = function countedUpsertEvents(events) {
    const result = upsertOriginal.call(this, events);
    writes.eventCalls++;
    for (const e of events) writes.eventsBySource[e.source] = (writes.eventsBySource[e.source] ?? 0) + 1;
    return result;
  };
  const activityOriginal = SqliteLedger.prototype.recordActivity;
  SqliteLedger.prototype.recordActivity = function countedRecordActivity(marks) {
    const result = activityOriginal.call(this, marks);
    writes.activityCalls++;
    for (const m of marks) writes.activityBySource[m.source] = (writes.activityBySource[m.source] ?? 0) + 1;
    return result;
  };

  if (job.pause) {
    const original = SqliteLedger.prototype.setState;
    let armed = true;
    SqliteLedger.prototype.setState = function setStatePaused(state) {
      if (armed && state.offset > 0 && state.key.startsWith(job.pause.root)) {
        armed = false;
        const snapshot = JSON.parse(JSON.stringify(writes));
        fs.writeFileSync(job.pause.marker, JSON.stringify({ key: state.key, offset: state.offset, pid: process.pid, writesBeforePause: snapshot }));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, job.pause.timeoutMs);
        process.exit(3); // only reached if the parent did not kill us in time
      }
      return original.call(this, state);
    };
  }

  process.on('message', (msg) => {
    if (msg && msg.cmd === 'stop') process.emit('SIGTERM'); // harness invocation of the daemon's own shutdown handler
  });

  const { main } = await import(dist('daemon/main.js'));
  await main();
  process.send({ type: 'main-returned' });
}

// ── parent role ────────────────────────────────────────────────────────────────────────────────

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const args = { out: null, build: null, seedLedger: null, inputRoot: null, pauseTimeoutMs: DEFAULT_PAUSE_TIMEOUT_MS, selfTestMissingMarker: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--build') args.build = argv[++i];
    else if (a === '--seed-ledger') args.seedLedger = argv[++i];
    else if (a === '--input-root') args.inputRoot = argv[++i];
    else if (a === '--pause-timeout-ms') args.pauseTimeoutMs = Number(argv[++i]);
    else if (a === '--self-test-missing-marker') args.selfTestMissingMarker = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.out) throw new Error('--out <absolute new dir outside home> is required');
  if (!Number.isFinite(args.pauseTimeoutMs) || args.pauseTimeoutMs <= 0) throw new Error('--pause-timeout-ms must be a positive number');
  return args;
}

function assertOutDir(out) {
  if (!path.isAbsolute(out)) throw new Error('--out must be an absolute path');
  const resolved = path.resolve(out);
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved.startsWith(home + path.sep)) {
    throw new Error('refusing --out under the user home directory; use a dedicated scratch path');
  }
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) throw new Error('--out already exists and is not empty');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function buildRuntime(out, existing) {
  if (existing) {
    const root = path.resolve(existing);
    if (!fs.existsSync(path.join(root, 'dist', 'daemon', 'main.js'))) throw new Error('--build has no dist/daemon/main.js');
    return root;
  }
  const root = path.join(out, 'build');
  const tsc = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(REPO_ROOT, 'tsconfig.json'), '--outDir', path.join(root, 'dist')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`tsc failed (exit ${result.status})`);
  fs.cpSync(path.join(REPO_ROOT, 'rates'), path.join(root, 'rates'), { recursive: true });
  return root;
}

function sourceProvenance(buildRoot) {
  const distSha256 = Object.fromEntries(SOURCE_FILES.map((f) => [f, sha256(fs.readFileSync(path.join(buildRoot, 'dist', f)))]));
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' });
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    worktreeDirtyEntries: status.status === 0 ? status.stdout.split('\n').filter(Boolean).length : null,
    distSha256,
  };
}

// ── inputs (frozen replay bytes) ──────────────────────────────────────────────────────────────

function claudeFile(fileIdx, pairs) {
  const sessionId = `1111111${fileIdx}-1111-4111-8111-111111111111`;
  const lines = [];
  for (let n = 0; n < pairs; n++) {
    const ts = new Date(Date.UTC(2026, 8, 20, 10, 0, 0) + (fileIdx * 100 + n) * 60_000).toISOString();
    lines.push(JSON.stringify({ type: 'user', uuid: `uu-${fileIdx}-${n}`, timestamp: ts, sessionId, cwd: '/replay/project' }));
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: `ua-${fileIdx}-${n}`,
        timestamp: ts,
        sessionId,
        cwd: '/replay/project',
        message: {
          id: `msg-${fileIdx}-${n}`,
          model: 'claude-sonnet-5',
          usage: { input_tokens: 100 + n, output_tokens: 20 + n, cache_creation_input_tokens: 10 * n, cache_read_input_tokens: 500 + n },
        },
      })
    );
  }
  return { rel: `claude/projects/-replay-project/${sessionId}.jsonl`, bytes: Buffer.from(lines.join('\n') + '\n', 'utf8') };
}

function generatedInputs(repoRoot) {
  const codexSrc = fs.readFileSync(path.join(repoRoot, 'test', 'fixtures', 'codex', 'root-reset-01a08127.jsonl'));
  const terminated = codexSrc[codexSrc.length - 1] === 0x0a ? codexSrc : Buffer.concat([codexSrc, Buffer.from('\n')]);
  return [
    claudeFile(0, 12),
    claudeFile(1, 6),
    { rel: 'codex/sessions/2026/09/08/rollout-2026-09-08T07-14-11-01a08127-9a3d-7220-a867-0b45fa2e2dab.jsonl', bytes: terminated },
  ];
}

function readFrozenInputs(root) {
  const files = [];
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (!rel.startsWith('claude/') && !rel.startsWith('codex/')) continue;
        const bytes = fs.readFileSync(abs);
        total += bytes.length;
        files.push({ rel, bytes });
      }
    }
  };
  walk(root);
  if (total > MAX_INPUT_BYTES) throw new Error(`--input-root exceeds ${MAX_INPUT_BYTES} bytes`);
  if (!files.some((f) => f.rel.startsWith('claude/')) || !files.some((f) => f.rel.startsWith('codex/'))) {
    throw new Error('--input-root must contain at least one claude/ and one codex/ jsonl file');
  }
  return files;
}

/** Byte cut for the crash case: a partial line mid-way through line k (about 30% of the file). */
function phase1Cut(bytes) {
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) starts.push(i + 1);
  const lines = starts.length - 1;
  if (lines < 1) return bytes.length;
  const k = Math.floor(lines * 0.3);
  return starts[k] + Math.max(1, Math.floor((starts[k + 1] - 1 - starts[k]) / 2));
}

// ── seed ledger contract ──────────────────────────────────────────────────────────────────────

/** A seed must be a WAL-free file. A non-empty -wal or -shm beside it means a live database: refused. */
function assertSeedContract(seedPath) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = seedPath + suffix;
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) {
      throw new Error(`refusing --seed-ledger: ${path.basename(sidecar)} is present and non-empty; provide a consistent WAL-free file (SQLite online backup or VACUUM INTO)`);
    }
  }
}

// ── streamed semantic fingerprint ─────────────────────────────────────────────────────────────

/** Hashes are computed over raw values inside this function; only digests and counts leave it. */
export function fingerprint(dbFile, inputRoot = null) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const escapedRoot = inputRoot ? JSON.stringify(inputRoot).slice(1, -1) : null;
  let normalizedRows = 0;
  const serialize = (row) => {
    const text = JSON.stringify(row);
    if (escapedRoot && text.includes(escapedRoot)) {
      normalizedRows++;
      return text.split(escapedRoot).join('<INPUT_ROOT>');
    }
    return text;
  };
  try {
    const quickCheck = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);

    const eventColumns = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    const evHash = crypto.createHash('sha256');
    let events = 0;
    const tokens = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
    let apiEquivUsd = 0;
    // A numeric aggregate must not silently coerce a drifted (non-numeric) value. Such a value adds 0 to the
    // aggregate, is counted in typeDrift, and is still hashed through its row.
    const typeDrift = { tokens: 0, apiEquivUsd: 0 };
    const numeric = (v, key) => {
      if (v === null || v === undefined) return 0;
      if (typeof v === 'number') return v;
      typeDrift[key]++;
      return 0;
    };
    for (const row of db.prepare('SELECT * FROM events ORDER BY id').iterate()) {
      events++;
      evHash.update(serialize(row) + '\n');
      tokens.inputFresh += numeric(row.input_fresh, 'tokens');
      tokens.cacheWrite5m += numeric(row.cache_write_5m, 'tokens');
      tokens.cacheWrite1h += numeric(row.cache_write_1h, 'tokens');
      tokens.cacheRead += numeric(row.cache_read, 'tokens');
      tokens.output += numeric(row.output, 'tokens');
      tokens.reasoning += numeric(row.reasoning, 'tokens');
      apiEquivUsd += numeric(row.api_equiv_usd, 'apiEquivUsd');
    }

    // Total order over every activity column except the autoincrement id. Ties are identical rows, so the
    // hash does not depend on storage order. NULL is ordered distinctly from '' and 0.
    const activityColumns = db.prepare('PRAGMA table_info(activity)').all().map((c) => c.name).filter((n) => n !== 'id');
    const actHash = crypto.createHash('sha256');
    let activity = 0;
    const actSql = `SELECT source, session_id, ts, uuid, host, project, kind, duration_ms FROM activity
      ORDER BY source, session_id, ts, uuid IS NULL, uuid, kind IS NULL, kind, project IS NULL, project, host, duration_ms IS NULL, duration_ms`;
    for (const row of db.prepare(actSql).iterate()) {
      activity++;
      actHash.update(serialize(row) + '\n');
    }

    const cursorRows = db.prepare('SELECT key, size, offset FROM ingest_state ORDER BY key').all();
    const cursorHash = crypto.createHash('sha256');
    const externalHash = crypto.createHash('sha256');
    let inRoot = 0;
    let external = 0;
    let allComplete = true;
    for (const r of cursorRows) {
      const rel = inputRoot ? path.relative(inputRoot, r.key) : '';
      if (inputRoot && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        inRoot++;
        cursorHash.update(`${rel.split(path.sep).join('/')}|${Number(r.size)}|${Number(r.offset)}\n`);
        if (Number(r.offset) !== Number(r.size)) allComplete = false;
      } else {
        external++;
        externalHash.update(`${Number(r.size)}|${Number(r.offset)}\n`);
      }
    }

    const skippedCount = Number(db.prepare('SELECT COUNT(*) AS n FROM skipped').get().n);
    return {
      quickCheck,
      eventColumns: { count: eventColumns.length, sha256: sha256(Buffer.from(eventColumns.join(','))) },
      activityColumns: { count: activityColumns.length, sha256: sha256(Buffer.from(activityColumns.join(','))) },
      events: { count: events, sha256: evHash.digest('hex') },
      activity: { count: activity, sha256: actHash.digest('hex') },
      tokens,
      apiEquivUsd: apiEquivUsd.toFixed(9),
      typeDrift,
      cursors: {
        inputRootCount: inRoot,
        inputRootSha256: cursorHash.digest('hex'),
        inputRootAllComplete: allComplete,
        externalCount: external,
        externalSha256: externalHash.digest('hex'),
      },
      skippedCount,
      normalizedRows,
    };
  } finally {
    db.close();
  }
}

/** Semantic comparison. Returns the NAMES of differing fields, never their values. */
export function diffFingerprints(a, b) {
  const diffs = [];
  const fields = ['eventColumns', 'activityColumns', 'events', 'activity', 'tokens', 'apiEquivUsd', 'typeDrift', 'cursors', 'skippedCount'];
  for (const f of fields) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) diffs.push(f);
  return diffs;
}

// ── daemon run helpers ────────────────────────────────────────────────────────────────────────

function isolatedEnv(runDir) {
  return {
    ...process.env,
    HOME: path.join(runDir, 'userhome'),
    USERPROFILE: path.join(runDir, 'userhome'),
    APPDATA: path.join(runDir, 'appdata'),
    LOCALAPPDATA: path.join(runDir, 'localappdata'),
    XDG_CONFIG_HOME: path.join(runDir, 'xdg-config'),
    XDG_DATA_HOME: path.join(runDir, 'xdg-data'),
    XDG_STATE_HOME: path.join(runDir, 'xdg-state'),
    TOKENELO_HOME: path.join(runDir, 'home'),
    CODEX_HOME: path.join(runDir, 'no-codex-env'),
    CLAUDE_CONFIG_DIR: path.join(runDir, 'no-claude-env'),
  };
}

function startDaemon({ runDir, buildRoot, pause, logName }) {
  const env = { ...isolatedEnv(runDir), ALPHA_DAEMON_ROLE: 'worker', ALPHA_DAEMON_JOB: JSON.stringify({ buildRoot, pause }) };
  const child = fork(SCRIPT, [], { env, silent: true });
  const log = fs.createWriteStream(path.join(runDir, logName));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  owned.set(child, exited);
  exited.then(() => owned.delete(child));
  return { child, exited, logPath: path.join(runDir, logName) };
}

/** Kills every worker this harness still owns, and waits for each exit. Never touches processes it did not start. */
async function killOwnedWorkers() {
  const pending = [...owned.entries()];
  for (const [child] of pending) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(pending.map(([, exited]) => exited));
  return pending.length;
}

function portFree() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForListen(port, daemon, timeoutMs) {
  const started = performance.now();
  let exitedEarly = null;
  daemon.exited.then((r) => (exitedEarly = r));
  while (performance.now() - started < timeoutMs) {
    if (exitedEarly) throw new Error(`daemon exited before listening: ${JSON.stringify(exitedEarly)}`);
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (ok) return Math.round(performance.now() - started);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon did not start listening within the timeout');
}

/** Polls for the pause marker. Returns null if the worker exits first or the bound elapses. Never kills; the caller does. */
async function waitForMarker(markerPath, daemon, timeoutMs) {
  const started = performance.now();
  let exitedEarly = false;
  daemon.exited.then(() => (exitedEarly = true));
  while (performance.now() - started < timeoutMs) {
    if (fs.existsSync(markerPath)) return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (exitedEarly) return null;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

/** One unprimed authenticated Coverage probe with a 3000 ms abort target. No retry. */
async function probeCoverage(port, token) {
  const t0 = performance.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/coverage`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_BUDGET_MS),
    });
    const body = await res.json();
    const elapsed = performance.now() - t0;
    return {
      ok: res.status === 200,
      status: res.status,
      elapsedMs: Math.round(elapsed),
      withinBudget: elapsed <= PROBE_BUDGET_MS,
      processListing: body.processListing?.status ?? null,
      collectorScans: (body.collectorScans ?? []).map((s) => ({
        name: s.name,
        lastOutcome: s.lastOutcome,
        bytesRead: s.lastStats?.bytesRead ?? null,
        warningCount: s.lastStats?.warningCount ?? null,
      })),
    };
  } catch (err) {
    return { ok: false, status: null, elapsedMs: Math.round(performance.now() - t0), withinBudget: false, error: err?.name ?? 'Error' };
  }
}

async function stopDaemon(daemon) {
  if (!daemon.child.connected) return { handled: false, exit: await daemon.exited };
  daemon.child.send({ cmd: 'stop' });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS);
  });
  const result = await Promise.race([daemon.exited, timeout]);
  clearTimeout(timer); // the bound is only needed while the race is open
  if (result === 'timeout') {
    daemon.child.kill('SIGKILL');
    return { handled: false, timedOut: true, exit: await daemon.exited };
  }
  return { handled: true, exit: result };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function readToken(paths) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(paths.apiTokenFile)) return fs.readFileSync(paths.apiTokenFile, 'utf8').trim();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('api token file was not created');
}

// ── case setup ───────────────────────────────────────────────────────────────────────────────

function materializeInputs(inputDir, files, phase) {
  for (const f of files) {
    const abs = path.join(inputDir, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, phase === 'partial' ? f.bytes.subarray(0, phase1Cut(f.bytes)) : f.bytes);
  }
}

function appendRemainder(inputDir, files) {
  for (const f of files) fs.appendFileSync(path.join(inputDir, f.rel), f.bytes.subarray(phase1Cut(f.bytes)));
}

async function prepareRun({ runDir, port, distRoot, inputs, phase, seedPath }) {
  const inputDir = path.join(runDir, 'inputs');
  materializeInputs(inputDir, inputs, phase);
  const { getPaths, ensureDirs } = await import(pathToFileURL(path.join(distRoot, 'dist', 'daemon', 'paths.js')).href);
  const { defaultConfig, saveConfig } = await import(pathToFileURL(path.join(distRoot, 'dist', 'daemon', 'config.js')).href);
  const paths = getPaths({ env: { TOKENELO_HOME: path.join(runDir, 'home') } });
  ensureDirs(paths);
  const cfg = defaultConfig({ hostLabel: 'REPLAY' });
  cfg.api = { port };
  cfg.claude = { roots: [path.join(inputDir, 'claude', 'projects')] };
  cfg.codex = { homes: [path.join(inputDir, 'codex')] };
  cfg.local = { ...cfg.local, capture: 'off', upstreams: [] };
  cfg.fleet = { listenAddress: null, peers: [], sharePaths: false };
  saveConfig(paths, cfg);
  if (seedPath) fs.copyFileSync(seedPath, paths.dbFile);
  return { inputDir, paths };
}

// ── run sequences ────────────────────────────────────────────────────────────────────────────

async function runControl({ out, buildRoot, distRoot, inputs, port, seedPath }) {
  const runDir = path.join(out, 'control');
  const { inputDir, paths } = await prepareRun({ runDir, port, distRoot, inputs, phase: 'full', seedPath });

  const first = startDaemon({ runDir, buildRoot, pause: null, logName: 'daemon-initial.log' });
  const listenMs = await waitForListen(port, first, LISTEN_TIMEOUT_MS);
  const probe = await probeCoverage(port, await readToken(paths));
  const stop = await stopDaemon(first);
  const fp = fingerprint(paths.dbFile, inputDir);

  const second = startDaemon({ runDir, buildRoot, pause: null, logName: 'daemon-unchanged.log' });
  const unchangedListenMs = await waitForListen(port, second, LISTEN_TIMEOUT_MS);
  const probe2 = await probeCoverage(port, await readToken(paths));
  const stop2 = await stopDaemon(second);
  const fp2 = fingerprint(paths.dbFile, inputDir);
  return {
    initial: { listenMs, probe, stop },
    unchanged: { listenMs: unchangedListenMs, probe: probe2, stop: stop2 },
    fingerprint: fp,
    unchangedDiffs: diffFingerprints(fp, fp2),
    inputDir,
    paths,
  };
}

async function runCrash({ out, buildRoot, distRoot, inputs, port, seedPath, collector, control, args }) {
  const runDir = path.join(out, `crash-${collector}`);
  const realRoot = collector === 'claude' ? path.join(runDir, 'inputs', 'claude', 'projects') : path.join(runDir, 'inputs', 'codex');
  // Self-test only: point the pause at a root that matches nothing, so no marker is ever written.
  const pauseRoot = args.selfTestMissingMarker ? path.join(runDir, 'no-such-input-root') : realRoot;
  const marker = path.join(runDir, 'pause-marker.json');
  const { inputDir, paths } = await prepareRun({ runDir, port, distRoot, inputs, phase: 'partial', seedPath });
  const { readLockInfo } = await import(pathToFileURL(path.join(distRoot, 'dist', 'daemon', 'lock.js')).href);

  const doomed = startDaemon({
    runDir,
    buildRoot,
    pause: { root: pauseRoot, marker, timeoutMs: args.pauseTimeoutMs },
    logName: 'daemon-doomed.log',
  });
  const pausedAt = await waitForMarker(marker, doomed, args.pauseTimeoutMs);
  // Always kill the owned worker: at the pause (the marker was written and the worker is blocked), or at the bound
  // when no marker appeared. Waiting for it to exit on its own would hold the harness for the worker's full timeout.
  if (doomed.child.exitCode === null && doomed.child.signalCode === null) doomed.child.kill('SIGKILL');
  const killExit = await doomed.exited;
  const doomedPid = doomed.child.pid;

  const fpAfterKill = fingerprint(paths.dbFile, inputDir);
  const pausedCursor = pausedAt
    ? (() => {
        const db = new DatabaseSync(paths.dbFile, { readOnly: true });
        try {
          return db.prepare('SELECT offset FROM ingest_state WHERE key = ?').get(pausedAt.key) ?? null;
        } finally {
          db.close();
        }
      })()
    : null;

  const lockBefore = readLockInfo(paths);
  const stalePidDead = lockBefore ? !pidAlive(lockBefore.pid) : false;

  appendRemainder(inputDir, inputs);
  const restart = startDaemon({ runDir, buildRoot, pause: null, logName: 'daemon-restart.log' });
  let listenMs = null;
  let restartError = null;
  try {
    listenMs = await waitForListen(port, restart, LISTEN_TIMEOUT_MS);
  } catch (err) {
    restartError = String(err.message);
  }
  const probe = restartError ? null : await probeCoverage(port, await readToken(paths));
  const stop = await stopDaemon(restart);
  const lockAfter = readLockInfo(paths);
  const fp = fingerprint(paths.dbFile, inputDir);
  const diffsVsControl = diffFingerprints(control.fingerprint, fp);

  const unchanged = startDaemon({ runDir, buildRoot, pause: null, logName: 'daemon-unchanged.log' });
  let unchangedListenMs = null;
  let unchangedError = null;
  try {
    unchangedListenMs = await waitForListen(port, unchanged, LISTEN_TIMEOUT_MS);
  } catch (err) {
    unchangedError = String(err.message);
  }
  const probe2 = unchangedError ? null : await probeCoverage(port, await readToken(paths));
  const stop2 = await stopDaemon(unchanged);
  const fp2 = fingerprint(paths.dbFile, inputDir);
  const diffsUnchanged = diffFingerprints(fp, fp2);

  const bytesOf = (scans, name) => (Array.isArray(scans) ? scans.find((s) => s.name === name)?.bytesRead ?? null : null);
  const writes = pausedAt?.writesBeforePause ?? null;
  const checks = {
    pausedAtInitialIngestBeforeListen: pausedAt !== null,
    markerPidIsDoomedWorker: pausedAt !== null && pausedAt.pid === doomedPid,
    workerWroteTargetSourceBeforePause: (writes?.eventsBySource?.[collector] ?? 0) > 0 && (writes?.activityBySource?.[collector] ?? 0) > 0,
    killedWhilePaused: pausedAt !== null && killExit.signal === 'SIGKILL',
    pausedCursorNotAdvanced: pausedAt !== null && (pausedCursor === null || Number(pausedCursor.offset) === 0),
    quickCheckAfterKill: fpAfterKill.quickCheck.length === 1 && fpAfterKill.quickCheck[0] === 'ok',
    lockPresentAfterKill: lockBefore !== null && lockBefore.pid === doomedPid,
    stalePidDeadBeforeRestart: lockBefore !== null && lockBefore.pid === doomedPid && stalePidDead,
    restartListened: restartError === null,
    restartProbeOk: probe?.ok === true,
    restartProbeWithinBudget: probe?.withinBudget === true,
    restartStopHandled: stop.handled === true && stop.exit.code === 0,
    lockRecoveredOrReleased: lockBefore !== null && (lockAfter === null || lockAfter.pid !== lockBefore.pid),
    quickCheckRestart: fp.quickCheck.length === 1 && fp.quickCheck[0] === 'ok',
    cursorsReachLastCompleteLines: fp.cursors.inputRootAllComplete === true,
    equalsUninterruptedControl: diffsVsControl.length === 0,
    unchangedRestartListened: unchangedError === null,
    unchangedRestartProbeOk: probe2?.ok === true,
    unchangedRestartProbeWithinBudget: probe2?.withinBudget === true,
    unchangedRestartStopHandled: stop2.handled === true && stop2.exit.code === 0,
    unchangedRestartZeroBytes: bytesOf(probe2?.collectorScans, collector) === 0 && bytesOf(probe2?.collectorScans, 'claude') === 0 && bytesOf(probe2?.collectorScans, 'codex') === 0,
    unchangedRestartPreservesFingerprint: diffsUnchanged.length === 0,
  };
  return {
    pauseAt: pausedAt ? { keyBasename: path.basename(pausedAt.key), offset: pausedAt.offset } : null,
    workerWritesBeforePause: writes, // rows handed to CALLS THAT RETURNED; not new-insert counts
    killExit,
    doomedPid,
    eventsAtKill: fpAfterKill.events.count,
    activityAtKill: fpAfterKill.activity.count,
    lock: { pidBefore: lockBefore?.pid ?? null, pidAfter: lockAfter?.pid ?? null, pidAliveBeforeRestart: lockBefore ? pidAlive(lockBefore.pid) : null },
    restart: { listenMs, error: restartError, probe, stop },
    unchanged: { listenMs: unchangedListenMs, error: unchangedError, probe: probe2, stop: stop2, diffs: diffsUnchanged },
    counts: { events: fp.events.count, activity: fp.activity.count },
    normalizedRows: fp.normalizedRows,
    diffsVsControl,
    checks,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = assertOutDir(args.out);
  const steps = [];
  const step = (name, ok, detail) => {
    steps.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
    return ok === true;
  };
  const report = { startedAt: new Date().toISOString(), node: process.version, selfTest: args.selfTestMissingMarker ? 'missing-marker' : null, steps, cases: {} };
  let seedHashBefore = null;
  let seedPath = null;

  try {
    const buildRoot = buildRuntime(out, args.build);
    report.provenance = sourceProvenance(buildRoot);
    step('build: compiled daemon modules present', fs.existsSync(path.join(buildRoot, 'dist', 'daemon', 'main.js')), { distSha256: report.provenance.distSha256 });

    if (args.seedLedger) {
      seedPath = path.resolve(args.seedLedger);
      assertSeedContract(seedPath);
      seedHashBefore = sha256(fs.readFileSync(seedPath));
      const seedCheck = path.join(out, 'seed-check.sqlite');
      fs.copyFileSync(seedPath, seedCheck);
      const fp = fingerprint(seedCheck, null);
      fs.rmSync(seedCheck, { force: true });
      report.seed = { quickCheck: fp.quickCheck, events: fp.events.count, activity: fp.activity.count, columns: fp.eventColumns.count };
      step('seed: consistent WAL-free file, quick_check ok', fp.quickCheck.length === 1 && fp.quickCheck[0] === 'ok', { events: fp.events.count, activity: fp.activity.count });
    }

    const inputs = args.inputRoot ? readFrozenInputs(path.resolve(args.inputRoot)) : generatedInputs(REPO_ROOT);
    step('inputs: frozen replay bytes present for claude and codex', inputs.some((f) => f.rel.startsWith('claude/')) && inputs.some((f) => f.rel.startsWith('codex/')), {
      files: inputs.length,
      bytes: inputs.reduce((s, f) => s + f.bytes.length, 0),
    });

    const controlPort = await portFree();
    const control = await runControl({ out, buildRoot, distRoot: buildRoot, inputs, port: controlPort, seedPath });
    const ci = control.initial.probe;
    const cu = control.unchanged.probe;
    step('control: initial run listened', control.initial.listenMs > 0, { listenMs: control.initial.listenMs });
    step('control: initial probe 200 within budget', ci.ok === true && ci.withinBudget === true, { status: ci.status, elapsedMs: ci.elapsedMs, error: ci.error ?? null });
    step('control: initial stop handled with exit 0', control.initial.stop.handled === true && control.initial.stop.exit.code === 0, control.initial.stop.exit);
    step('control: quick_check ok', control.fingerprint.quickCheck.length === 1 && control.fingerprint.quickCheck[0] === 'ok');
    step('control: cursors reach the last complete line of every input', control.fingerprint.cursors.inputRootAllComplete === true, { inputCursors: control.fingerprint.cursors.inputRootCount });
    step('control: unchanged restart probe 200 within budget', cu.ok === true && cu.withinBudget === true, { status: cu.status, elapsedMs: cu.elapsedMs, error: cu.error ?? null });
    step('control: unchanged restart preserves fingerprint', control.unchangedDiffs.length === 0, { diffs: control.unchangedDiffs });
    const unchangedScans = Array.isArray(cu.collectorScans) ? cu.collectorScans : [];
    step('control: unchanged restart reads zero bytes (every collector reported)', unchangedScans.length > 0 && unchangedScans.every((s) => s.bytesRead === 0), unchangedScans.map((s) => ({ name: s.name, bytesRead: s.bytesRead })));
    report.cases.control = {
      initial: { listenMs: control.initial.listenMs, probe: ci, stop: control.initial.stop.exit },
      unchanged: { listenMs: control.unchanged.listenMs, probe: cu, stop: control.unchanged.stop.exit },
      counts: { events: control.fingerprint.events.count, activity: control.fingerprint.activity.count },
      fingerprint: { eventColumns: control.fingerprint.eventColumns, events: control.fingerprint.events.sha256, activity: control.fingerprint.activity.sha256, tokens: control.fingerprint.tokens, apiEquivUsd: control.fingerprint.apiEquivUsd, cursorsInput: control.fingerprint.cursors.inputRootSha256, normalizedRows: control.fingerprint.normalizedRows },
    };

    const crashPort = await portFree();
    const collectors = args.selfTestMissingMarker ? ['claude'] : ['claude', 'codex'];
    for (const collector of collectors) {
      const result = await runCrash({ out, buildRoot, distRoot: buildRoot, inputs, port: crashPort, seedPath, collector, control, args });
      report.cases[collector] = result;
      for (const [name, ok] of Object.entries(result.checks)) step(`${collector} crash: ${name}`, ok);
    }

    if (seedPath) step('seed: original file unchanged after all runs', sha256(fs.readFileSync(seedPath)) === seedHashBefore);
  } catch (err) {
    step('harness error: run aborted (owned workers are cleaned up below)', false, String(err && err.message ? err.message : err));
  } finally {
    const killed = await killOwnedWorkers();
    report.ownedWorkersKilledAtEnd = killed;
    report.ownedWorkersRemaining = owned.size;
    report.ok = steps.length > 0 && steps.every((s) => s.ok);
    report.finishedAt = new Date().toISOString();
    report.notProven = [
      'live input growth (inputs are frozen replay bytes)',
      'GPU or model compute',
      'Fleet peers or the Tailscale listener',
      'physical power loss or a kill inside a SQLite transaction',
      'a graceful Windows OS signal (shutdown is invoked via IPC, see header)',
      'Coverage live process-table read (read-only; not hashed or stored)',
      'A2000-scale seed performance unless the seed is actually used',
    ];
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`\n${report.ok ? 'ALL PASS' : 'FAILURES PRESENT'}  report: ${path.join(out, 'report.json')}`);
    process.exitCode = report.ok ? 0 : 1;
  }
}

if (process.env.ALPHA_DAEMON_ROLE === 'worker') {
  await daemonWorker();
} else if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
