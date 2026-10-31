/** Construct genuine owned legacy table shapes from the unchanged versioned DDL.
 * Do not simulate a legacy database by merely lowering a current meta version. */
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SCHEMA_MIGRATIONS } from '../../src/store/migrations.js';

export function ownedLegacySchema(version: number, source?: TokeneloDb): TokeneloDb {
  if (!Number.isInteger(version) || version < 1 || version >= 10) throw new Error('Legacy fixture version');
  const db = openDb({ file: ':memory:', migrate: false });
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  for (const migration of SCHEMA_MIGRATIONS.filter(m => m.version <= version)) {
    migration.up(db);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(migration.version));
  }
  if (source) {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('meta','sqlite_sequence')").all() as { name: string }[];
    for (const { name } of tables) {
      if (!/^[a-z_]+$/.test(name)) throw new Error('Owned fixture table identifier');
      const available = new Set((source.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(x => x.name));
      const cols = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(x => x.name).filter(x => available.has(x));
      const quoted = cols.map(x => `"${x}"`).join(',');
      const rows = source.prepare(`SELECT rowid AS retained_fixture_rowid,${quoted} FROM ${name} ORDER BY rowid`).all() as Record<string, import('node:sqlite').SQLInputValue>[];
      const put = db.prepare(`INSERT INTO ${name}(rowid,${quoted}) VALUES(${['rowid',...cols].map(()=>'?').join(',')})`);
      for (const row of rows) put.run(row.retained_fixture_rowid!,...cols.map(c => row[c]!));
    }
  }
  return db;
}
