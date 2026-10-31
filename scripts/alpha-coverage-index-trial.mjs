#!/usr/bin/env node
/**
 * Private-copy covering-index trial for the Coverage telemetry query.
 *
 * It answers one question: does a covering index on events(source, provider, engine, ts) make
 * `SELECT source, provider, engine, MAX(ts) AS maxTs FROM events GROUP BY source, provider, engine`
 * return the same groups faster on a copy of a real ledger? It does not change any production schema.
 *
 * Contract:
 *   - --out must be an absolute path to a NEW (or empty) directory outside the user's home directory.
 *   - --seed must be a consistent, WAL-free SQLite file. A non-empty -wal or -shm beside it is refused.
 *   - The seed is never opened for writing. Its SHA-256 is streamed before and after, and must not change.
 *   - Only the main file is copied, into --out/trial.sqlite. Only one DDL statement runs, on that copy:
 *     CREATE INDEX idx_trial_events_coverage ON events(source, provider, engine, ts).
 *   - One baseline query, then one candidate query. Each is timed once with its EXPLAIN QUERY PLAN.
 *   - Equivalence is an order-independent digest of the group rows (count plus SHA-256 of canonical JSON).
 *     Raw rows are never printed or written. The report contains counts, digests, timings, plan detail and
 *     page-size deltas only.
 *   - Limits recorded in the report: the baseline runs first and the candidate second on the same file, so the
 *     OS and SQLite page cache order can favour the second run; one sample each; the copy was just written, so
 *     it may be partly in the OS cache; this is copy timing, not live HTTP latency.
 *
 * Usage:
 *   node scripts/alpha-coverage-index-trial.mjs --out <absolute new dir> --seed <WAL-free file>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const COVERAGE_QUERY = 'SELECT source, provider, engine, MAX(ts) AS maxTs FROM events GROUP BY source, provider, engine';
export const CANDIDATE_INDEX = 'idx_trial_events_coverage';
export const CANDIDATE_DDL = `CREATE INDEX ${CANDIDATE_INDEX} ON events(source, provider, engine, ts)`;

function parseArgs(argv) {
  const args = { out: null, seed: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--seed') args.seed = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!args.out || !args.seed) throw new Error('--out <absolute new dir> and --seed <WAL-free file> are required');
  return args;
}

function assertOutDir(out) {
  if (!path.isAbsolute(out)) throw new Error('--out must be an absolute path');
  const resolved = path.resolve(out);
  const home = path.resolve(os.homedir());
  if (resolved === home || resolved.startsWith(home + path.sep)) throw new Error('refusing --out under the user home directory');
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0) throw new Error('--out already exists and is not empty');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function assertSeedContract(seed) {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = seed + suffix;
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) {
      throw new Error(`refusing --seed: ${path.basename(sidecar)} is present and non-empty; provide a consistent WAL-free file`);
    }
  }
}

/** Streams a file through SHA-256. Never buffers the whole file. */
function streamSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Order-independent digest of the group rows: canonical JSON of sorted tuples. Raw values stay inside the hash. */
export function groupDigest(rows) {
  const tuples = rows.map((r) => JSON.stringify([r.source ?? null, r.provider ?? null, r.engine ?? null, r.maxTs ?? null])).sort();
  return { groups: tuples.length, sha256: crypto.createHash('sha256').update(tuples.join('\n')).digest('hex') };
}

function plan(db, sql) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail);
}

function timed(db, sql) {
  const t0 = performance.now();
  const rows = db.prepare(sql).all();
  return { ms: Math.round((performance.now() - t0) * 10) / 10, rows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = assertOutDir(args.out);
  const seed = path.resolve(args.seed);
  if (!fs.existsSync(seed)) throw new Error('--seed does not exist');
  assertSeedContract(seed);

  const report = { startedAt: new Date().toISOString(), node: process.version, steps: [], ok: false };
  const step = (name, ok, detail) => {
    report.steps.push({ name, ok: ok === true, ...(detail === undefined ? {} : { detail }) });
    console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
    return ok === true;
  };

  const seedHashBefore = await streamSha256(seed);
  report.seedSha256Before = seedHashBefore;

  const trial = path.join(out, 'trial.sqlite');
  fs.copyFileSync(seed, trial);
  const db = new DatabaseSync(trial);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const journal = db.prepare('PRAGMA journal_mode').get();
    const qcBefore = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
    const pageSize = db.prepare('PRAGMA page_size').get().page_size;
    report.copy = { journalMode: Object.values(journal)[0], quickCheck: qcBefore, eventRows: events, pageSize };
    step('copy: quick_check ok and journal is not WAL', qcBefore.length === 1 && qcBefore[0] === 'ok' && Object.values(journal)[0] !== 'wal', report.copy);

    const existing = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' ORDER BY name").all();
    report.existingEventIndexes = existing.map((r) => r.name);

    // Baseline first, once.
    const basePlan = plan(db, COVERAGE_QUERY);
    const base = timed(db, COVERAGE_QUERY);
    const baseDigest = groupDigest(base.rows);
    report.baseline = { ms: base.ms, plan: basePlan, ...baseDigest };
    step('baseline: one query executed', base.rows.length === baseDigest.groups, { groups: baseDigest.groups, ms: base.ms });

    // The single allowed DDL statement, on the copy only.
    const pagesBefore = db.prepare('PRAGMA page_count').get().page_count;
    const b0 = performance.now();
    db.exec(CANDIDATE_DDL);
    const buildMs = Math.round((performance.now() - b0) * 10) / 10;
    const pagesAfter = db.prepare('PRAGMA page_count').get().page_count;
    const qcAfter = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
    report.candidate = { index: CANDIDATE_INDEX, buildMs, indexPageBytes: (pagesAfter - pagesBefore) * pageSize, quickCheckAfterBuild: qcAfter };
    step('candidate: index built on the copy, quick_check ok', qcAfter.length === 1 && qcAfter[0] === 'ok', { buildMs, indexPageBytes: report.candidate.indexPageBytes });

    // Candidate, once.
    const candPlan = plan(db, COVERAGE_QUERY);
    const cand = timed(db, COVERAGE_QUERY);
    const candDigest = groupDigest(cand.rows);
    report.candidate.ms = cand.ms;
    report.candidate.plan = candPlan;
    report.candidate.groups = candDigest.groups;
    report.candidate.sha256 = candDigest.sha256;
    const equal = baseDigest.groups === candDigest.groups && baseDigest.sha256 === candDigest.sha256;
    report.equivalent = equal;
    step('equivalence: candidate groups equal baseline groups (count and digest)', equal, { groups: candDigest.groups });
    step('candidate: query plan uses the covering index', candPlan.some((d) => d.includes(CANDIDATE_INDEX)), candPlan);
    report.timing = { baselineMs: base.ms, candidateMs: cand.ms, buildMs, note: 'one sample each; baseline ran first on the same file' };
    report.limits = [
      'one sample each: no repeat timing, so no variance estimate',
      'baseline measured before the index existed, candidate after: page-cache order can favour the second run',
      'the copy was just written, so it may be partly in the OS cache',
      'this is isolated-copy query timing on the current host, not live HTTP latency; hardware identity is not inferred from seed contents',
      'the index is a candidate for a future schema decision only; nothing here changes production schema',
    ];
  } finally {
    db.close();
  }

  const seedHashAfter = await streamSha256(seed);
  report.seedSha256After = seedHashAfter;
  step('seed: unchanged by the trial (streamed SHA-256 before and after)', seedHashAfter === seedHashBefore);

  report.ok = report.steps.every((s) => s.ok);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\n${report.ok ? 'ALL PASS' : 'FAILURES PRESENT'}  report: ${path.join(out, 'report.json')}`);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
