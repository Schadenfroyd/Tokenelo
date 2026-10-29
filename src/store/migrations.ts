/**
 * Versioned schema migrations for the Tokenelo ledger (DESIGN §2.1 `store/migrations.ts`).
 * Schema version is tracked in `meta` (key='schema_version'); `runMigrations` applies every
 * migration whose version is greater than the current one, each inside its own transaction, and
 * is idempotent — calling it again with nothing pending is a no-op.
 */
import { withTransaction, type TokeneloDb } from './db.js';
import { assertCurrentEventLayout, configureCurrentEventBasis, createEventProjection, registerCurrentWriterPolicy } from './event-basis.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: TokeneloDb) => void;
}

/**
 * v1: full initial schema.
 *
 * events — one row per UsageEvent (core/types.ts). Token fields, components_json (the
 * UsageComponent[] actually priced — see ledger.ts's per-field-MAX + kept-line merge) and
 * the derived pricing fields (and the reserved compatibility columns) are all flattened into columns per the scaffold spec.
 *
 * activity — ActivityMark rows for session timers. Deduped on (source, uuid) when a uuid is
 * present, else on (source, session_id, ts, kind) — enforced with two partial unique indexes
 * (SQLite supports `WHERE` on `CREATE UNIQUE INDEX`) rather than a single composite key, since
 * the dedup identity genuinely differs depending on whether uuid is known.
 *
 * skipped — one row per (path, reason), with `count`/`last_seen` bumped on every repeat sighting
 * (DESIGN §15.7.7 doctor report: "skipped paths").
 *
 * bench_runs / bench_items — mirror BenchRunSummary / BenchItemResult (core/types.ts §15.6);
 * owned by the bench module later, created here so the schema exists from v1.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE events (
          id                TEXT PRIMARY KEY,
          host              TEXT NOT NULL,
          source            TEXT NOT NULL,
          ts                INTEGER NOT NULL,
          ts_source         TEXT NOT NULL,
          session_id        TEXT NOT NULL,
          parent_session_id TEXT,
          is_subagent       INTEGER NOT NULL DEFAULT 0,
          project           TEXT,
          repo_root         TEXT,
          git_branch        TEXT,
          entrypoint        TEXT,
          model             TEXT NOT NULL,
          provider          TEXT NOT NULL,
          effort            TEXT,
          speed             TEXT,
          service_tier      TEXT,
          inference_geo     TEXT,
          components_json   TEXT NOT NULL,
          input_fresh       INTEGER NOT NULL DEFAULT 0,
          cache_write_5m    INTEGER NOT NULL DEFAULT 0,
          cache_write_1h    INTEGER NOT NULL DEFAULT 0,
          cache_read        INTEGER NOT NULL DEFAULT 0,
          output            INTEGER NOT NULL DEFAULT 0,
          reasoning         INTEGER NOT NULL DEFAULT 0,
          duration_ms       INTEGER,
          flags_json        TEXT NOT NULL DEFAULT '[]',
          api_equiv_usd     REAL,
          price_status      TEXT NOT NULL,
          price_version     TEXT NOT NULL,
          ucu               REAL,
          ucu_rate_status   TEXT NOT NULL,
          eacs_def_sha256   TEXT NOT NULL
        );
        CREATE INDEX idx_events_ts ON events(ts);
        CREATE INDEX idx_events_source_session ON events(source, session_id);
        CREATE INDEX idx_events_model ON events(model);
        CREATE INDEX idx_events_repo_root ON events(repo_root);

        CREATE TABLE activity (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          source      TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          ts          INTEGER NOT NULL,
          uuid        TEXT,
          host        TEXT NOT NULL,
          project     TEXT,
          kind        TEXT,
          duration_ms INTEGER
        );
        CREATE UNIQUE INDEX idx_activity_dedup_uuid
          ON activity(source, uuid) WHERE uuid IS NOT NULL;
        CREATE UNIQUE INDEX idx_activity_dedup_fallback
          ON activity(source, session_id, ts, kind) WHERE uuid IS NULL;

        CREATE TABLE limits (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          source       TEXT NOT NULL,
          host         TEXT NOT NULL,
          account      TEXT,
          captured_at  INTEGER NOT NULL,
          plan_type    TEXT,
          windows_json TEXT NOT NULL,
          credits_json TEXT,
          estimate     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_limits_host_source_captured
          ON limits(host, source, captured_at);

        CREATE TABLE skipped (
          path      TEXT NOT NULL,
          reason    TEXT NOT NULL,
          count     INTEGER NOT NULL DEFAULT 1,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (path, reason)
        );

        CREATE TABLE ingest_state (
          key        TEXT PRIMARY KEY,
          size       INTEGER NOT NULL,
          mtime_ms   REAL NOT NULL,
          offset     INTEGER NOT NULL,
          ino        INTEGER,
          extra_json TEXT
        );

        CREATE TABLE bench_runs (
          run_id             TEXT PRIMARY KEY,
          model              TEXT NOT NULL,
          config_json        TEXT NOT NULL,
          runner             TEXT NOT NULL,
          dataset            TEXT NOT NULL,
          n                  INTEGER NOT NULL,
          repeats            INTEGER NOT NULL,
          accuracy           REAL NOT NULL,
          mean_t             REAL NOT NULL,
          tokens_per_ucu     REAL,
          ci95_json          TEXT,
          half_width_pct     REAL,
          flagged_pct        REAL NOT NULL DEFAULT 0,
          clamped            INTEGER NOT NULL DEFAULT 0,
          status             TEXT NOT NULL,
          chars_per_token    REAL,
          decode_tok_per_sec REAL,
          def_sha256         TEXT NOT NULL,
          started_at         INTEGER NOT NULL,
          finished_at        INTEGER NOT NULL,
          notes_json         TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE bench_items (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id        TEXT NOT NULL REFERENCES bench_runs(run_id),
          dataset       TEXT NOT NULL,
          item_id       TEXT NOT NULL,
          stratum       TEXT NOT NULL,
          repeat        INTEGER NOT NULL,
          tokens_json   TEXT NOT NULL,
          prefix_tokens INTEGER,
          correct       INTEGER NOT NULL,
          flagged       TEXT,
          wall_ms       INTEGER NOT NULL,
          energy_wh     REAL,
          prompt_chars  INTEGER NOT NULL
        );
        CREATE INDEX idx_bench_items_run ON bench_items(run_id);
      `);
    },
  },
  {
    // v2 (DESIGN §15.9.5/§15.9.6, types.ts v0.2.1):
    //  - limits.limit_id: Codex emits several rate_limits ids per account ('codex',
    //    'codex_bengalfox', 'base_model_inference', 'premium' — all seen on A2000 2026-09-26);
    //    snapshots are keyed by (source, account, limitId) so one id never overwrites another.
    //  - events.perf_json: UsageEvent.perf (Ollama decode/prefill tok/s) — previously dropped.
    //  - idx_events_source_ts: LedgerWriter.recentEvents(source, since, until) range scans.
    version: 2,
    name: 'limits.limit_id, events.perf_json, events(source, ts) index',
    up(db) {
      db.exec(`
        ALTER TABLE limits ADD COLUMN limit_id TEXT;
        ALTER TABLE events ADD COLUMN perf_json TEXT;
        CREATE INDEX idx_events_source_ts ON events(source, ts);
      `);
    },
  },
  {
    // v3 (founder req. 2026-09-27, DESIGN §7/§15.5 thinking-mode amendment): UsageEvent.thinking
    // (true/false/NULL — NULL = not determinable, EventFlag `thinkingUnknown`). Nullable INTEGER
    // (1/0/NULL); existing rows default to NULL (unknown), never coerced to 0/false — a pre-v3 row
    // genuinely has no thinking-mode evidence recorded, which IS 'not determinable', not 'false'.
    version: 3,
    name: 'events.thinking',
    up(db) {
      db.exec(`
        ALTER TABLE events ADD COLUMN thinking INTEGER;
        CREATE INDEX idx_events_thinking ON events(thinking);
      `);
    },
  },
  {
    // v4 (build items 1-4, 2026-09-27): events.engine (which local engine served an
    // 'ollama-proxy' event when more than one is configured — UsageEvent.engine's own doc);
    // desktop_sessions (Claude Desktop's claude-code-sessions/local-agent-mode-sessions metadata,
    // build item 3 — written directly by collectors/claude-desktop.ts, not through LedgerWriter,
    // since it carries no UsageEvents/pricing at all). 'qwen-code' needs no schema change: it is
    // just another `source` value in the existing events table.
    version: 4,
    name: 'events.engine, desktop_sessions',
    up(db) {
      db.exec(`
        ALTER TABLE events ADD COLUMN engine TEXT;

        CREATE TABLE desktop_sessions (
          cli_session_id    TEXT PRIMARY KEY,
          cwd               TEXT,
          origin_cwd        TEXT,
          title             TEXT,
          model             TEXT,
          effort            TEXT,
          is_archived       INTEGER,
          created_at        INTEGER,
          last_activity_at  INTEGER,
          pr_number         INTEGER,
          pr_url            TEXT,
          pr_repository     TEXT,
          pr_state          TEXT,
          source_file       TEXT NOT NULL,
          updated_at        INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // v5 (2026-10-01): summary range reads order/filter activity by ts; Claude block estimation
    // filters and orders by source/host/ts. Without these indexes both paths scan and temp-sort
    // the full activity table on hosts whose ledgers have grown.
    version: 5,
    name: 'activity time and host range indexes',
    up(db) {
      db.exec(`
        CREATE INDEX idx_activity_ts ON activity(ts);
        CREATE INDEX idx_activity_source_host_ts ON activity(source, host, ts);
      `);
    },
  },
  {
    // v6 (2026-10-03): covering index for the Coverage telemetry group-by,
    // `SELECT source, provider, engine, MAX(ts) FROM events GROUP BY source, provider, engine`. With only
    // idx_events_source_ts the query reads each table row for provider and engine and sorts a temp B-tree. With this
    // index it reads only the index (measured on a private copy of a real ledger: 537 ms to 54 ms with the same groups;
    // one sample each, so the gain is indicative). Cost: one index over the events table, built once at upgrade time
    // under BEGIN IMMEDIATE (about 0.9 s measured on 388k events) and about 11.5 MB of index pages. Older builds ignore it.
    version: 6,
    name: 'events coverage covering index',
    up(db) {
      db.exec(`CREATE INDEX idx_events_coverage ON events(source, provider, engine, ts);`);
    },
  },
  {
    // Rate selection recorded per event (L-R8, 2026-10-04). Both columns are NULL for every row stored before this migration: such rows
    // are unverified until `tokenelo reprice` records their selection. No data is rewritten here; nothing is recomputed at upgrade time.
    version: 7,
    name: 'events rate selection',
    up(db) {
      // Idempotent: a ledger that already has a column (a test or tool that rewinds the version number) is not altered twice.
      const columns = new Set((db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>).map((c) => c.name));
      if (!columns.has('rate_key')) db.exec(`ALTER TABLE events ADD COLUMN rate_key TEXT;`);
      if (!columns.has('rate_resolved_sha256')) db.exec(`ALTER TABLE events ADD COLUMN rate_resolved_sha256 TEXT;`);
    },
  },
  {
    version: 8,
    name: 'count evidence materialization with legacy-writer invalidation',
    up(db) {
      const columns = new Set((db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>).map(c => c.name));
      for (const [name, type] of [['cache_write_unassigned', 'INTEGER'], ['cache_write_assumed_1h', 'INTEGER'],
        ['count_quality', 'TEXT'], ['count_policy', 'TEXT'], ['count_revision', 'INTEGER']])
        if (!columns.has(name!)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type};`);
      // A pre-v8 writer does not advance count_revision. Clear its stale materialization,
      // never pretend an old writer understands the seventh counter or new raw policies.
      db.exec(`CREATE TRIGGER IF NOT EXISTS events_invalidate_old_count_writer
        AFTER UPDATE OF components_json, input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning,
                        api_equiv_usd, ucu, flags_json ON events
        WHEN OLD.count_revision IS NOT NULL AND NEW.count_revision IS OLD.count_revision
          AND (NEW.components_json IS NOT OLD.components_json OR NEW.input_fresh IS NOT OLD.input_fresh
            OR NEW.cache_write_5m IS NOT OLD.cache_write_5m OR NEW.cache_write_1h IS NOT OLD.cache_write_1h
            OR NEW.cache_read IS NOT OLD.cache_read OR NEW.output IS NOT OLD.output OR NEW.reasoning IS NOT OLD.reasoning
            OR NEW.api_equiv_usd IS NOT OLD.api_equiv_usd OR NEW.ucu IS NOT OLD.ucu OR NEW.flags_json IS NOT OLD.flags_json)
        BEGIN
          UPDATE events SET cache_write_unassigned = NULL, cache_write_assumed_1h = NULL,
            count_quality = NULL, count_policy = NULL, count_revision = NULL,
            api_equiv_usd = NULL, price_status = 'UNPRICED', ucu = NULL, ucu_rate_status = 'NONE' WHERE id = NEW.id;
        END;`);
    },
  },
  {
    version: 9,
    name: 'v1-fresh count quality and supported materialization writer',
    up(db) {
      const columns = new Set((db.prepare('PRAGMA table_info(events)').all() as unknown as Array<{ name: string }>).map(c => c.name));
      if (!columns.has('ucu_count_quality')) db.exec('ALTER TABLE events ADD COLUMN ucu_count_quality TEXT;');
      // No old row is reprojected at migration. Replace the v8 guard only after the
      // nullable column exists; v8 writers advance revisions but do not know this basis.
      db.exec(`DROP TRIGGER IF EXISTS events_invalidate_old_count_writer;
        CREATE TRIGGER events_invalidate_old_count_writer
        AFTER UPDATE OF components_json, input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning,
                        api_equiv_usd, ucu, flags_json, count_policy, count_revision ON events
        WHEN (NEW.ucu_count_quality IS NOT NULL AND NEW.count_policy IS NOT 'tokenelo/claude-component-counts@v2')
          OR (OLD.count_revision IS NOT NULL AND NEW.count_revision IS OLD.count_revision
            AND (NEW.components_json IS NOT OLD.components_json OR NEW.input_fresh IS NOT OLD.input_fresh
              OR NEW.cache_write_5m IS NOT OLD.cache_write_5m OR NEW.cache_write_1h IS NOT OLD.cache_write_1h
              OR NEW.cache_read IS NOT OLD.cache_read OR NEW.output IS NOT OLD.output OR NEW.reasoning IS NOT OLD.reasoning
              OR NEW.api_equiv_usd IS NOT OLD.api_equiv_usd OR NEW.ucu IS NOT OLD.ucu OR NEW.flags_json IS NOT OLD.flags_json))
        BEGIN
          UPDATE events SET cache_write_unassigned = NULL, cache_write_assumed_1h = NULL,
            count_quality = NULL, ucu_count_quality = NULL, count_policy = NULL, count_revision = NULL,
            api_equiv_usd = NULL, price_status = 'UNPRICED', ucu = NULL, ucu_rate_status = 'NONE' WHERE id = NEW.id;
        END;`);
    },
  },
];

MIGRATIONS.push({ version: 10, name: 'immutable recorded events and versioned current event projection', up: createEventProjection });
/** Immutable registry for schema/provenance inspection and supported recovery verification. */
export const SCHEMA_MIGRATIONS: readonly Migration[] = Object.freeze([...MIGRATIONS]);
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

function ensureMetaTable(db: TokeneloDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

export function getSchemaVersion(db: TokeneloDb): number {
  const exists = db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='meta'").get();
  if (!exists) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  if (row && !/^(0|[1-9][0-9]*)$/.test(row.value)) throw new Error('Unsupported or malformed Tokenelo schema version');
  const version = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error('Unsupported or malformed Tokenelo schema version');
  return version;
}

/** A newer database must never be silently opened for writes by this binary. Read-only
 * current interpretation also refuses an unsupported schema; foreign raw reads are separate. */
export function assertSupportedSchema(db: TokeneloDb): void {
  const version = getSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) throw new Error(`Tokenelo schema ${version} is newer than supported ${CURRENT_SCHEMA_VERSION}; use its matching version or a verified package/database recovery pair`);
  if (version >= 10) assertCurrentEventLayout(db,true);
}

function setSchemaVersion(db: TokeneloDb, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(version));
}

/** Applies every migration with version > current schema version, in order, each in its own
 * transaction. Safe to call on every daemon/CLI start — a fully-migrated db is a no-op. */
export function runMigrations(db: TokeneloDb): void {
  assertSupportedSchema(db);
  registerCurrentWriterPolicy(db);
  ensureMetaTable(db);
  const current = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );
  for (const migration of pending) {
    try {
      // Standalone callers retain one transaction per migration. Maintenance
      // can reserve a larger backup/migrate/reprice boundary on this connection;
      // its migrations use savepoints and never commit the caller's boundary.
      withTransaction(db, () => {
        migration.up(db);
        setSchemaVersion(db, migration.version);
      });
    } catch (err) {
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(err)}`, {
        cause: err,
      });
    }
  }
  configureCurrentEventBasis(db);
}
