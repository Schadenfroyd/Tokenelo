#!/usr/bin/env node
/**
 * `tokenelo` CLI (DESIGN §2, §12, §15.7.3/.8). Every read/report command shares exactly one
 * bootstrap path with the daemon via `daemon/main.js#buildRuntime`, so `tokenelo report` and the
 * running daemon's `/v1/summary` can never disagree about how a range is computed or which
 * collectors are registered.
 *
 * Subcommands: ingest | report [--range] | sessions [--range] [--active] | limits |
 * doctor | serve | export --format csv|json [--range] | reprice | token [--show | --help].
 *
 * No mutating HTTP endpoints exist (DESIGN §15.7.3) — `ingest`/`reprice` are CLI-only by
 * design, writing straight to the SQLite ledger while the daemon (if running) reads it back over
 * WAL; `report`/`sessions`/`limits`/`doctor`/`export` are pure reads and never touch
 * the daemon's exclusive lock.
 */
import { buildRuntime, runIngestOnce, main as runDaemon, ensureApiToken, isEntryModule } from '../daemon/main.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EacsEngine, PricingEngine, Range, UsageEvent } from '../core/types.js';
import { getPaths, ensureDirs, tightenDataDirPermissions, type TokeneloPaths } from '../daemon/paths.js';
import { openDb, withTransaction } from '../store/db.js';
import { runMigrations } from '../store/migrations.js';
import { SqliteLedger, rowToEvent, mergeDuplicateEvent, providerForValuation, type EventRow } from '../store/ledger.js';
import { createNullEngine } from '../core/null-engine.js';
import { defaultPricingEngine } from '../core/pricing.js';
import { eventsToCsv } from './csv.js';
import { readShareReport } from './share-report.js';

const VALID_RANGES: readonly Range[] = ['today', '24h', '7d', '30d', 'all'];

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function parseRange(flags: ParsedArgs['flags'], fallback: Range): Range {
  const raw = flags.range;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !(VALID_RANGES as readonly string[]).includes(raw)) {
    throw new UsageError(`--range must be one of ${VALID_RANGES.join(', ')}, got "${String(raw)}"`);
  }
  return raw as Range;
}

class UsageError extends Error {}

function printJson(value: unknown): void {
  // process.stdout.write rather than console.log: the CSV export path (below) already has to use
  // stdout.write directly, and keeping every command on the same call means a test (or a real
  // pipe/redirect) sees output in one consistent stream instead of two.
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

async function cmdIngest(): Promise<void> {
  const runtime = await buildRuntime();
  try {
    const results = await runIngestOnce(runtime);
    printJson({ results: results.map((r) => ({ name: r.name, stats: r.stats, error: r.error ? String(r.error) : undefined })) });
  } finally {
    await runtime.close();
  }
}

async function cmdReport(flags: ParsedArgs['flags']): Promise<void> {
  const range = parseRange(flags, '7d');
  if (flags.share !== undefined) {
    if (flags.share !== true) throw new UsageError('--share takes no value; use report --share [--range R].');
    printJson(await readShareReport(range));
    return;
  }
  const runtime = await buildRuntime();
  try {
    printJson(await runtime.queries.getSummary(range));
  } finally {
    await runtime.close();
  }
}

async function cmdSessions(flags: ParsedArgs['flags']): Promise<void> {
  const range = parseRange(flags, 'today');
  const activeOnly = flags.active === true || flags.active === '1';
  const runtime = await buildRuntime();
  try {
    printJson(await runtime.queries.getSessions({ range, activeOnly }));
  } finally {
    await runtime.close();
  }
}

async function cmdLimits(): Promise<void> {
  const runtime = await buildRuntime();
  try {
    printJson(await runtime.queries.getLimits());
  } finally {
    await runtime.close();
  }
}

async function cmdDoctor(): Promise<void> {
  const runtime = await buildRuntime();
  try {
    printJson(await runtime.queries.getDoctor());
  } finally {
    await runtime.close();
  }
}

async function cmdExport(flags: ParsedArgs['flags']): Promise<void> {
  const format = flags.format === undefined ? 'json' : flags.format;
  if (format !== 'json' && format !== 'csv') {
    throw new UsageError(`--format must be "csv" or "json", got "${String(format)}"`);
  }
  const range = parseRange(flags, 'all');
  const runtime = await buildRuntime();
  try {
    const events = await runtime.queries.exportEvents(range);
    if (format === 'csv') {
      process.stdout.write(eventsToCsv(events));
    } else {
      printJson(events);
    }
  } finally {
    await runtime.close();
  }
}

/**
 * Receipt of what a reprice would change: counts per model and thinking mode. No identifiers.
 * The reserved compatibility columns are not recomputed by a reprice, so they are not part of the receipt.
 */
function repriceReceipt(events: readonly UsageEvent[], pricing: PricingEngine) {
  const sameNumber = (a: number | null, b: number | null): boolean =>
    a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  const totals = {
    events: events.length,
    priceStatusChanged: 0,
    priceVersionChanged: 0,
    providerChanged: 0,
    tokensChanged: 0,
    countQualityChanged: 0,
    usdChanged: 0,
  };
  const groups = new Map<string, { model: string; mode: string; events: number; usdChanged: number; priceStatusChanged: number; priceVersionChanged: number; providerChanged: number; tokensChanged: number; countQualityChanged: number }>();
  for (const e of events) {
    // Maintenance values the same qualified self-merge the ledger writes.
    // Older aggregate/component gaps are evidence to retain and disclose.
    const valuation = mergeDuplicateEvent(e, e);
    const numericKeys = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning', 'cacheWriteUnassigned', 'cacheWriteAssumed1h'] as const;
    const tokensChanged = numericKeys.some(key => (e.tokens[key] ?? 0) !== (valuation.tokens[key] ?? 0));
    const quality = (tokens: UsageEvent['tokens']) => [tokens.countQuality ?? 'unrecorded', tokens.ucuCountQuality ?? tokens.countQuality ?? 'unrecorded'];
    const countQualityChanged = quality(e.tokens).some((value, index) => value !== quality(valuation.tokens)[index]);
    totals.tokensChanged += tokensChanged ? 1 : 0;
    totals.countQualityChanged += countQualityChanged ? 1 : 0;
    const p = pricing.priceEvent(valuation);
    const usdChanged = !sameNumber(e.apiEquivUsd, p.usd);
    totals.priceStatusChanged += e.priceStatus === p.status ? 0 : 1;
    totals.priceVersionChanged += e.priceVersion === pricing.version ? 0 : 1;
    const providerChanged = e.provider !== providerForValuation(valuation, pricing);
    totals.providerChanged += providerChanged ? 1 : 0;
    totals.usdChanged += usdChanged ? 1 : 0;
    const mode = e.thinking === true ? 'thinking' : e.thinking === false ? 'non-thinking' : 'unknown';
    const key = `${e.model}\u0000${mode}`;
    let g = groups.get(key);
    if (!g) {
      g = { model: e.model, mode, events: 0, usdChanged: 0, priceStatusChanged: 0, priceVersionChanged: 0, providerChanged: 0, tokensChanged: 0, countQualityChanged: 0 };
      groups.set(key, g);
    }
    g.events++;
    g.usdChanged += usdChanged ? 1 : 0;
    g.priceStatusChanged += e.priceStatus === p.status ? 0 : 1;
    g.priceVersionChanged += e.priceVersion === pricing.version ? 0 : 1;
    g.providerChanged += providerChanged ? 1 : 0;
    g.tokensChanged += tokensChanged ? 1 : 0;
    g.countQualityChanged += countQualityChanged ? 1 : 0;
  }
  const rows = [...groups.values()]
    .filter((g) => g.usdChanged > 0 || g.priceStatusChanged > 0 || g.priceVersionChanged > 0 || g.providerChanged > 0
      || g.tokensChanged > 0 || g.countQualityChanged > 0)
    .sort((a, b) => b.usdChanged - a.usdChanged || a.model.localeCompare(b.model));
  return { dryRun: true, readOnly: true, totals, groups: rows };
}

/**
 * `reprice --dry-run`: a preview. It computes the receipt without changing the ledger's rows, its schema, its config, or any runtime state.
 *
 * Exactly what can still change on disk: the shared-memory index (`-shm`) of a WAL-mode ledger may be created or updated by any read-only
 * connection (https://sqlite.org/wal.html). That is SQLite housekeeping, reported as `sidecarHousekeeping`; it is not ledger, schema or config
 * mutation. No migration runs, no directory is created, and no config or token file is touched.
 *
 * Consistency: every figure is read inside ONE deferred read transaction, so the receipt describes one committed state even while a writer
 * commits. The ordinary read-only open is used on purpose: `immutable=1` skips locking and change detection and is only correct when the file
 * cannot change (https://sqlite.org/uri.html), which a live ledger does not promise.
 */
function cmdRepricePreview(): void {
  const paths = getPaths();
  if (!fs.existsSync(paths.dbFile)) {
    printJson({ dryRun: true, readOnly: true, ledgerFound: false, totals: { events: 0 }, groups: [], mutation: PREVIEW_MUTATION });
    return;
  }
  const db = openDb({ file: paths.dbFile, readOnly: true });
  try {
    db.exec('BEGIN'); // deferred: the read snapshot is taken at the first SELECT and held until COMMIT
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      const counts = db.prepare('SELECT COUNT(*) AS n, MAX(rowid) AS maxRowid FROM events').get() as { n: number; maxRowid: number | null };
      const events = (db.prepare('SELECT * FROM events ORDER BY rowid').all() as unknown as EventRow[]).map(rowToEvent);
      const receipt = repriceReceipt(events, defaultPricingEngine());
      printJson({
        ...receipt,
        ledgerFound: true,
        schemaVersion: meta ? Number(meta.value) : null,
        committedState: { events: counts.n, maxRowid: counts.maxRowid, sameSnapshotAsTotals: counts.n === events.length },
        mutation: PREVIEW_MUTATION,
      });
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
}

const PREVIEW_MUTATION = {
  ledgerRows: 'none',
  schema: 'none',
  config: 'none',
  runtime: 'none',
  sidecarHousekeeping: 'SQLite may create or update the -shm index of a WAL-mode ledger (not ledger, schema or config mutation)',
} as const;

/** Explicit maintenance uses one reserved writer transaction from the prior
 * logical backup through migrations, event selection and revaluation. The
 * backup reader sees the pre-migration committed state while competing writers
 * wait. All writes commit together, or all schema/economic changes roll back. */
export function repriceLedger(paths: TokeneloPaths = getPaths(), pricing: PricingEngine = defaultPricingEngine(), computeUnits: EacsEngine = createNullEngine()) {
  const existed = fs.existsSync(paths.dbFile);
  ensureDirs(paths);
  const db = openDb({ file: paths.dbFile, migrate: false });
  tightenDataDirPermissions(paths);
  try {
    return withTransaction(db, () => {
      let backupName: string | null = null;
      if (existed) {
        const backupDir = path.join(paths.dataDir, 'backups');
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        backupName = `tokenelo-pre-reprice-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
        const backupFile = path.join(backupDir, backupName);
        const src = openDb({ file: paths.dbFile, readOnly: true });
        try { src.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`); }
        finally { src.close(); }
        if (process.platform !== 'win32') fs.chmodSync(backupFile, 0o600);
      }
      runMigrations(db);
      const events = (db.prepare('SELECT * FROM events ORDER BY rowid').all() as unknown as EventRow[]).map(rowToEvent);
      if (events.length === 0) return { ...(backupName ? { backup: backupName } : {}), inserted: 0, updated: 0, unchanged: 0 };
      const receipt = repriceReceipt(events, pricing);
      const result = new SqliteLedger(db, pricing, computeUnits).upsertEvents(events, { reprice: true });
      return { ...(backupName ? { backup: backupName } : {}), ...result,
        priceStatusChanged: receipt.totals.priceStatusChanged,
        priceVersionChanged: receipt.totals.priceVersionChanged, providerChanged: receipt.totals.providerChanged,
        tokensChanged: receipt.totals.tokensChanged, countQualityChanged: receipt.totals.countQualityChanged,
        usdChanged: receipt.totals.usdChanged };
    });
  } finally { db.close(); }
}

/** Repricing is a write operation. Validate raw arguments before opening any ledger,
 * so a typo, positional argument or conflicting duplicate cannot become write intent. */
function repricePreviewRequested(args: readonly string[]): boolean {
  let preview = false;
  for (const arg of args) {
    if (arg === '--dry-run' || arg === '--dry-run=true' || arg === '--dry-run=1') {
      if (preview) throw new UsageError('reprice: duplicate --dry-run option');
      preview = true;
      continue;
    }
    throw new UsageError('reprice: only --dry-run, --dry-run=true or --dry-run=1 are accepted; omit arguments for a real reprice');
  }
  return preview;
}

async function cmdReprice(args: readonly string[]): Promise<void> {
  if (repricePreviewRequested(args)) { cmdRepricePreview(); return; }
  printJson(repriceLedger());
}

async function cmdServe(): Promise<number> {
  return runDaemon();
}

async function cmdToken(args: readonly string[]): Promise<void> {
  // Parsed flags lose duplicates and treat strings such as "false" as truthy.
  // Validate raw intent before opening the runtime or creating/showing a token.
  const show = args.length === 1 && args[0] === '--show';
  const help = args.length === 1 && args[0] === '--help';
  if (args.length > 0 && !show && !help) {
    throw new UsageError('token accepts only bare --show or --help, without values, combinations, duplicates or positional arguments.');
  }
  if (help) {
    process.stdout.write('Usage: tokenelo token [--show | --help]\n\nPrint the API token file path; bare --show also prints its value.\n--help prints this help without opening a runtime.\n');
    return;
  }
  const runtime = await buildRuntime();
  try {
    process.stdout.write(runtime.paths.apiTokenFile + '\n');
    if (show) {
      process.stdout.write(ensureApiToken(runtime.paths) + '\n');
    }
  } finally {
    await runtime.close();
  }
}

const USAGE = `tokenelo <command> [options]

Commands:
  ingest                       run all registered collectors once and write results to the local ledger (no --dry-run)
  report [--range R] [--share]   usage summary (default: 7d); --share emits a versioned aggregate with local identifiers/paths omitted
  sessions [--range R] [--active]   session list (default range: today)
  limits                       latest Codex/Claude limit snapshots
  doctor                       diagnostics report
  serve                        run the daemon in the foreground (no --dry-run)
  export --format csv|json [--range R]   dump the ledger (default range: all)
  reprice [--dry-run]          recompute prices for all stored events with current rates; --dry-run changes no ledger rows, schema or config (SQLite may update its -shm index)
  token [--show | --help]       print the API token file path (value only with bare --show)

R is one of: ${VALID_RANGES.join(', ')}
`;

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { flags } = parseArgs(rest);
  try {
    switch (command) {
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE);
        return 0;
      case 'ingest':
        if (rest.length > 0) {
          throw new UsageError('ingest accepts no options or positional arguments; it writes collected results to the local ledger and has no --dry-run mode.');
        }
        await cmdIngest();
        return 0;
      case 'report':
        await cmdReport(flags);
        return 0;
      case 'sessions':
        await cmdSessions(flags);
        return 0;
      case 'limits':
        await cmdLimits();
        return 0;
      case 'doctor':
        await cmdDoctor();
        return 0;
      case 'serve':
        if (rest.length > 0) {
          throw new UsageError('serve accepts no options or positional arguments; it starts the daemon and has no --dry-run mode.');
        }
        return cmdServe();
      case 'export':
        await cmdExport(flags);
        return 0;
      case 'reprice':
        await cmdReprice(rest);
        return 0;
      case 'token':
        await cmdToken(rest);
        return 0;
      default:
        process.stderr.write(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (isEntryModule(import.meta.url)) {
  // A downstream pipe closing early (`tokenelo export | head`, `| less`, a killed `curl`, …) makes
  // the next stdout/stderr write fail with EPIPE. Node's default behavior for an unhandled 'error'
  // on a Writable is to throw and crash the process with a raw stack trace — verified live (this
  // exact crash reproduced running `tokenelo export --format csv --range today | head -5` against
  // real M4a data during this module's real-data check). EPIPE here means "the reader is gone",
  // which is a normal, successful outcome for a CLI, not a bug — swallow it and exit quietly
  // rather than let it look like a crash.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }

  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
