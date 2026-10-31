import { describe, it, expect } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { runMigrations, getSchemaVersion, CURRENT_SCHEMA_VERSION } from '../../src/store/migrations.js';
import { ownedLegacySchema } from '../helpers/legacy-schema.js';

// A raw, unmigrated connection (openDb's own migrate step is what's under test here).
function rawDb(): TokeneloDb {
  return openDb({ file: ':memory:', migrate: false });
}

function tableNames(db: TokeneloDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();
}

describe('runMigrations', () => {
  it('creates every table the scaffold spec lists', () => {
    const db = rawDb();
    runMigrations(db);
    const names = tableNames(db);
    for (const expected of [
      'events',
      'activity',
      'limits',
      'skipped',
      'ingest_state',
      'bench_runs',
      'bench_items',
      'meta',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('bumps schema_version to CURRENT_SCHEMA_VERSION', () => {
    const db = rawDb();
    expect(getSchemaVersion(db)).toBe(0);
    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it('is idempotent: running twice does not error and leaves the version unchanged', () => {
    const db = rawDb();
    runMigrations(db);
    const namesAfterFirst = tableNames(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(db)).toEqual(namesAfterFirst);
  });

  it('events table has the indexes required for range/session/model/repo queries', () => {
    const db = rawDb();
    runMigrations(db);
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toContain('idx_events_ts');
    expect(indexes).toContain('idx_events_source_session');
    expect(indexes).toContain('idx_events_model');
    expect(indexes).toContain('idx_events_repo_root');
  });

  it('v3: events.thinking is a nullable column with its own index (founder req. 2026-09-27)', () => {
    const db = rawDb();
    runMigrations(db);
    const cols = db.prepare('PRAGMA table_info(events)').all() as { name: string; notnull: number }[];
    const thinking = cols.find((c) => c.name === 'thinking');
    expect(thinking).toBeDefined();
    expect(thinking!.notnull).toBe(0); // NULL = not determinable must remain a valid, unconstrained value
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toContain('idx_events_thinking');
  });

  it('activity table dedup uses two partial unique indexes (uuid present vs absent)', () => {
    const db = rawDb();
    runMigrations(db);
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='activity'")
      .all() as { name: string; sql: string }[];
    const byUuid = indexes.find((i) => i.name === 'idx_activity_dedup_uuid');
    const fallback = indexes.find((i) => i.name === 'idx_activity_dedup_fallback');
    expect(byUuid?.sql).toContain('WHERE uuid IS NOT NULL');
    expect(fallback?.sql).toContain('WHERE uuid IS NULL');
  });

  it('v5: activity range and per-host window scans use supporting indexes', () => {
    const db = rawDb();
    runMigrations(db);

    const rangePlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM activity WHERE ts >= ? ORDER BY ts ASC')
      .all(1234) as { detail: string }[];
    expect(rangePlan.map((row) => row.detail).join('\n')).toContain('idx_activity_ts');

    const hostWindowPlan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT ts, ts - LAG(ts) OVER (ORDER BY ts) AS gap
         FROM activity WHERE source = 'claude' AND host = ?`
      )
      .all('M4a') as { detail: string }[];
    expect(hostWindowPlan.map((row) => row.detail).join('\n')).toContain('idx_activity_source_host_ts');
  });

  it('v4: events.engine is a nullable column, and desktop_sessions exists keyed by cli_session_id (build items 3/4)', () => {
    const db = rawDb();
    runMigrations(db);
    const eventCols = db.prepare('PRAGMA table_info(events)').all() as { name: string; notnull: number }[];
    const engine = eventCols.find((c) => c.name === 'engine');
    expect(engine).toBeDefined();
    expect(engine!.notnull).toBe(0);

    const desktopCols = (db.prepare('PRAGMA table_info(desktop_sessions)').all() as { name: string; pk: number }[]).map((c) => c.name);
    for (const col of ['cli_session_id', 'cwd', 'title', 'model', 'pr_number', 'pr_url', 'pr_repository', 'pr_state', 'source_file', 'updated_at']) {
      expect(desktopCols).toContain(col);
    }
    const pk = (db.prepare('PRAGMA table_info(desktop_sessions)').all() as { name: string; pk: number }[]).find((c) => c.pk === 1);
    expect(pk?.name).toBe('cli_session_id');
  });
});

describe('v6: events coverage covering index', () => {
  const COVERAGE_QUERY = 'SELECT source, provider, engine, MAX(ts) AS maxTs FROM events GROUP BY source, provider, engine';

  function insertEvent(db: TokeneloDb, id: string, source: string, provider: string, engine: string | null, ts: number): void {
    db.prepare(
      `INSERT INTO events (id, host, source, ts, ts_source, session_id, model, provider, engine, components_json,
                           price_status, price_version, ucu_rate_status, eacs_def_sha256, input_fresh, output)
       VALUES (?, 'H', ?, ?, 'line', 's', 'm', ?, ?, '[]', 'ok', 'v', 'ok', 'h', 1, 1)`
    ).run(id, source, ts, provider, engine);
  }

  function rowHash(db: TokeneloDb, sql: string): string {
    return JSON.stringify(db.prepare(sql).all());
  }

  function indexNames(db: TokeneloDb): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name
    );
  }

  it('creates the index on (source, provider, engine, ts) in that column order', () => {
    const db = rawDb();
    runMigrations(db);
    const cols = (db.prepare("PRAGMA index_info('idx_events_coverage')").all() as { seqno: number; name: string }[])
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    expect(cols).toEqual(['source', 'provider', 'engine', 'ts']);
  });

  it('advances a populated v5 ledger to v6: events, activity and cursors are preserved, and only the new index is added', () => {
    const db = ownedLegacySchema(5);
    insertEvent(db, 'e1', 'claude', 'anthropic', null, 1_000); // a NULL engine is a real group, not an error
    insertEvent(db, 'e2', 'claude', 'anthropic', null, 2_000);
    insertEvent(db, 'e3', 'ollama-proxy', 'local', 'ollama', 3_000);
    db.prepare("INSERT INTO activity (source, session_id, ts, uuid, host, kind) VALUES ('claude', 's', 1000, 'u1', 'H', 'user')").run();
    db.prepare("INSERT INTO ingest_state (key, size, mtime_ms, offset, ino) VALUES ('/x/a.jsonl', 10, 1, 10, 7)").run();

    const originalColumns=(db.prepare('PRAGMA table_info(events)').all() as {name:string}[]).map(c=>`"${c.name}"`).join(',');
    const originalRowsSql=`SELECT rowid AS originalRowid,${originalColumns} FROM events ORDER BY id`;
    const before = {
      events: rowHash(db, originalRowsSql),
      activity: rowHash(db, 'SELECT * FROM activity ORDER BY id'),
      cursors: rowHash(db, 'SELECT * FROM ingest_state ORDER BY key'),
      indexes: indexNames(db),
    };

    // Genuine v5 DDL/rows, not a current projection with lowered metadata.
    expect(getSchemaVersion(db)).toBe(5);

    runMigrations(db);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(10);
    expect(rowHash(db, originalRowsSql)).toBe(before.events);
    expect(rowHash(db, originalRowsSql.replace('FROM events','FROM main.events'))).toBe(before.events);
    expect(rowHash(db, 'SELECT * FROM activity ORDER BY id')).toBe(before.activity);
    expect(rowHash(db, 'SELECT * FROM ingest_state ORDER BY key')).toBe(before.cursors);
    const afterIndexes=indexNames(db);
    expect(afterIndexes).toContain('idx_events_coverage');
    for(const name of before.indexes)expect(afterIndexes).toContain(name);
    for(const name of [...before.indexes,'idx_events_coverage'])expect(afterIndexes).toContain(name.replace('idx_events_','idx_projection_'));
  });

  it('the grouped result is identical with and without the index, including a NULL-engine group', () => {
    const db = rawDb();
    runMigrations(db);
    insertEvent(db, 'e1', 'claude', 'anthropic', null, 1_000);
    insertEvent(db, 'e2', 'claude', 'anthropic', null, 5_000);
    insertEvent(db, 'e3', 'ollama-proxy', 'local', 'ollama', 3_000);
    insertEvent(db, 'e4', 'ollama-proxy', 'local', null, 4_000);

    const withIndex = JSON.stringify(db.prepare(COVERAGE_QUERY).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    db.exec('DROP INDEX idx_events_coverage');
    const withoutIndex = JSON.stringify(db.prepare(COVERAGE_QUERY).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    expect(withIndex).toBe(withoutIndex);

    const groups = db.prepare(COVERAGE_QUERY).all() as Array<{ engine: string | null }>;
    expect(groups).toHaveLength(3);
    expect(groups.some((g) => g.engine === null)).toBe(true);
  });

  it('the Coverage query reads only the covering index after v6', () => {
    const db = rawDb();
    runMigrations(db);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${COVERAGE_QUERY}`).all() as { detail: string }[]).map((r) => r.detail).join('\n');
    expect(plan).toContain('idx_projection_coverage');
    expect(plan).toContain('COVERING INDEX');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
