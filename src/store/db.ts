/**
 * SQLite connection helper (node:sqlite DatabaseSync). WAL mode + busy_timeout, the
 * ExperimentalWarning filter (spikes-2026-09-26.md S1 — node 22.x only), and a manual
 * transaction wrapper (node:sqlite's DatabaseSync has no built-in `.transaction()` helper the
 * way better-sqlite3 does).
 *
 * `DatabaseSync` is loaded via `createRequire(...)('node:sqlite')` rather than a static
 * `import { DatabaseSync } from 'node:sqlite'` — verified necessary (2026-09-26, this session):
 * vitest 2.1.9's bundled `vite-node@2.1.9` has its own hardcoded builtin-module list
 * (`node_modules/vite-node/dist/utils.mjs`'s `builtins`/`prefixedBuiltins`) which predates
 * `node:sqlite`'s stabilization and does not recognize it, so a static import makes every test
 * file that transitively imports this module fail with "Failed to load url sqlite" (confirmed:
 * `vite-node@6.0.0`'s `prefixedBuiltins` set does include `"node:sqlite"`, so this is fixed
 * upstream, just not in the version pinned here). `createRequire` is a plain runtime function
 * call, invisible to vite-node's static import-rewriting, so Node resolves the real built-in
 * directly. The type import below is `import type` only — fully erased at compile time — so it
 * carries no runtime import and does not trip the same bug.
 */
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { installSqliteWarningFilter } from '../core/log.js';
import { measure } from '../core/phase-profile.js';
import { assertSupportedSchema, runMigrations } from './migrations.js';
import { configureCurrentEventBasis, registerCurrentWriterPolicy } from './event-basis.js';

const nodeSqlite = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncType;
};
const DatabaseSync = nodeSqlite.DatabaseSync;
type DatabaseSync = DatabaseSyncType;

export interface OpenDbOptions {
  /** ':memory:' for tests, or an absolute file path. */
  file: string;
  /** ms; default 5000. SQLite retries a locked write for up to this long before erroring. */
  busyTimeoutMs?: number;
  /** Skip WAL (node:sqlite silently ignores this for ':memory:' anyway). Default true. */
  wal?: boolean;
  /** Run pending schema migrations on open. Default true. */
  migrate?: boolean;
  /** Open read-only (DESIGN §15.2.10: node:sqlite {readOnly:true}, never immutable=1, for live
   * WAL DBs owned by other processes — e.g. Codex's state_5.sqlite). Never migrates. */
  readOnly?: boolean;
}

export type TokeneloDb = DatabaseSync;

/** Opens (and by default migrates) the Tokenelo ledger database. */
export function openDb(opts: OpenDbOptions): TokeneloDb {
  installSqliteWarningFilter();

  if (opts.file !== ':memory:') {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  }

  const db = new DatabaseSync(opts.file, { readOnly: opts.readOnly ?? false });
  try {
    assertSupportedSchema(db);
    registerCurrentWriterPolicy(db); // Resolve shared triggers; SQLite readOnly still rejects writes.
    if (!opts.readOnly) {
    if (opts.wal ?? true) {
      db.exec('PRAGMA journal_mode = WAL');
    }
    db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    db.exec('PRAGMA foreign_keys = ON');

    if (opts.migrate ?? true) {
      runMigrations(db);
    }
    }
    configureCurrentEventBasis(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Opens another process's live SQLite database read-only for cross-checks (DESIGN §11 gate 3,
 * §15.2.10) — e.g. Codex's `state_5.sqlite` / `thread_history_1.sqlite`. Deliberately separate
 * from `openDb`: never runs Tokenelo's own migrations against a foreign schema, and defaults
 * `readOnly: true` unconditionally so a caller cannot accidentally write to another app's DB.
 */
export function openForeignDbReadOnly(file: string): TokeneloDb {
  installSqliteWarningFilter();
  return new DatabaseSync(file, { readOnly: true });
}

/**
 * Read-only connection to Tokenelo's own ledger, for a request snapshot (store/read-snapshot.ts). Separate from the
 * writable handle, so a read transaction here stays on its own WAL snapshot while the daemon's writer commits. Never
 * migrates. Opening a `:memory:` database this way is impossible, because a second connection cannot see it.
 */
export function openLedgerReadOnly(file: string, options: { snapshot?: boolean } = {}): TokeneloDb {
  installSqliteWarningFilter();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // Apply the existing lock-wait policy before the first read acquires its snapshot.
    db.exec('PRAGMA busy_timeout = 5000');
    // Pin the WAL snapshot before inspecting the schema or selecting the event basis.
    // Production reports use this option; simple native readers may own their transaction.
    if(options.snapshot){db.exec('BEGIN');db.prepare('SELECT name FROM main.sqlite_schema LIMIT 1').get();}
    assertSupportedSchema(db);
    registerCurrentWriterPolicy(db);
    configureCurrentEventBasis(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Open withTransaction depth per connection (0 / absent = no transaction of ours is open). */
const txDepth = new WeakMap<TokeneloDb, number>();

/**
 * Runs `fn` inside a transaction, rolling back on any thrown error. REENTRANT (DESIGN §15.9.6):
 * the outermost call issues `BEGIN IMMEDIATE … COMMIT`; every nested call on the same connection
 * (e.g. `LedgerWriter.upsertEvents` inside a collector's `store.transaction(...)`) runs inside its
 * own `SAVEPOINT tx_<depth>` instead of a second BEGIN (which SQLite rejects). A nested failure
 * rolls back only to its savepoint and rethrows; if the caller catches it, the outer transaction
 * continues and commits without the failed inner writes. An outer failure rolls back everything.
 *
 * node:sqlite's DatabaseSync has no built-in transaction helper (unlike better-sqlite3's
 * `.transaction()`), so this is the manual equivalent.
 *
 * Profiling (default-off, core/phase-profile.ts): the outermost BEGIN IMMEDIATE and COMMIT are timed
 * as `db.begin_immediate` and `db.commit`. Both are synchronous on the event loop. BEGIN IMMEDIATE
 * includes any busy_timeout wait for another connection's write lock, and COMMIT includes any WAL
 * auto-checkpoint, so a long block in either one is attributable instead of hidden in the caller's span.
 */
export function withTransaction<T>(db: TokeneloDb, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth === 0) {
    measure('db.begin_immediate', () => db.exec('BEGIN IMMEDIATE'));
  } else {
    db.exec(`SAVEPOINT tx_${depth}`);
  }
  txDepth.set(db, depth + 1);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    txDepth.set(db, depth);
    try {
      if (depth === 0) {
        db.exec('ROLLBACK');
      } else {
        db.exec(`ROLLBACK TO tx_${depth}`);
        db.exec(`RELEASE tx_${depth}`);
      }
    } catch {
      // Rollback can itself fail if SQLite already rolled back (e.g. SQLITE_FULL); the original
      // error is what matters and is rethrown below regardless.
    }
    throw err;
  }
  txDepth.set(db, depth);
  if (depth === 0) {
    try {
      measure('db.commit', () => db.exec('COMMIT'));
    } catch (err) {
      // e.g. SQLITE_BUSY on commit: never leave the connection stuck inside an open transaction.
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back by SQLite
      }
      throw err;
    }
  } else {
    db.exec(`RELEASE tx_${depth}`);
  }
  return result;
}

/** Current withTransaction nesting depth on `db` (0 = none). Exposed for tests/diagnostics. */
export function transactionDepth(db: TokeneloDb): number {
  return txDepth.get(db) ?? 0;
}
