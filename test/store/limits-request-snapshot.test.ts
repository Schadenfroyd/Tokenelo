import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AccountConfig, TokeneloDb, UsageEvent } from '../../src/core/types.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { openDb, openLedgerReadOnly } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';

const NOW = Date.UTC(2026, 9, 20, 12);
const EVENT_TS = NOW - 30 * 60_000;
const price = defaultPricingEngine();
const computeUnits = createNullEngine();

function event(host: 'A' | 'B'): UsageEvent {
  const tokens = { inputFresh: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
  return {
    id: `limits-snapshot-${host}`,
    host,
    source: 'claude',
    ts: EVENT_TS,
    tsSource: 'line',
    sessionId: `fixture-${host}`,
    isSubagent: false,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    components: [{ model: 'claude-sonnet-5', tokens }],
    tokens,
    flags: [],
    apiEquivUsd: 0.01,
    priceStatus: 'LIST',
    priceVersion: 'fixture-prices-v1',
    reservedValue: null,
    ucuRateStatus: 'NONE',
    eacsDefSha256: '',
  };
}

function queryConnectionWithBetweenStatementWrite(db: TokeneloDb, write: () => void, state: { written: boolean }): TokeneloDb {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM events WHERE source = 'claude'") || !sql.includes('ORDER BY ts ASC')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'all') {
                return (...params: Parameters<typeof statementTarget.all>) => {
                  const rows = statementTarget.all(...params);
                  if (!state.written) {
                    state.written = true;
                    write();
                  }
                  return rows;
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TokeneloDb;
}

describe('Limits derived block and contributor rows use one request snapshot', () => {
  it.each(['direct', 'shared-snapshot', 'separate-snapshot'] as const)(
    'does not mix host rows when a writer commits between per-host reads (%s)', async (mode) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-limits-request-snapshot-'));
    const dbPath = path.join(tempRoot, 'ledger.sqlite');
    const writerDb = openDb({ file: dbPath });
    const liveReaderDb = openDb({ file: dbPath });
    let snapshotDb: TokeneloDb | undefined;
    try {
      const ledger = new SqliteLedger(writerDb, price, computeUnits);
      const marks = (['A', 'B'] as const).map((host) => ({
        source: 'claude' as const,
        sessionId: `fixture-${host}`,
        ts: EVENT_TS,
        uuid: `limits-snapshot-activity-${host}`,
        host,
      }));
      ledger.recordActivity(marks);
      ledger.upsertEvents([event('A'), event('B')]);
      writerDb.prepare("UPDATE events SET api_equiv_usd = 0.01, price_status = 'LIST', price_version = 'fixture-prices-v1'").run();
      snapshotDb = mode === 'direct' ? undefined : openLedgerReadOnly(dbPath, { snapshot: true });

      const config = defaultConfig({ hostLabel: 'A' });
      config.accounts = [{ id: 'fixture-account', kind: 'claude', hosts: ['A', 'B'], monthlyUsd: 100 } satisfies AccountConfig];
      const writeMidRead = () => {
        writerDb.exec('BEGIN IMMEDIATE');
        try {
          writerDb.prepare("UPDATE events SET api_equiv_usd = 0.02, price_status = 'LIST', price_version = 'fixture-prices-v2' WHERE source = 'claude'").run();
          writerDb.exec('COMMIT');
        } catch (error) {
          writerDb.exec('ROLLBACK');
          throw error;
        }
      };
      const writeState = { written: false };
      const liveReader = queryConnectionWithBetweenStatementWrite(liveReaderDb, writeMidRead, writeState);
      const snapshotReader = snapshotDb ? queryConnectionWithBetweenStatementWrite(snapshotDb, writeMidRead, writeState) : undefined;
      const queryDb = mode === 'shared-snapshot' ? snapshotReader! : liveReader;
      const queries = createQueries(queryDb, config, {
        now: () => NOW,
        pricing: price,
        ...(snapshotReader && mode !== 'direct' ? { readSnapshotDb: snapshotReader } : {}),
        probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }),
      });

      const response = await queries.getLimits();
      const block = response.snapshots.find((snapshot) => snapshot.source === 'claude-block-estimate');
      expect(block).toBeDefined();
      expect(block!.windows[0]!.apiEquivUsd).toBe(0.02);
      expect(block!.contributors?.reduce((sum, row) => sum + (row.knownApiEquivUsd ?? 0), 0)).toBe(0.02);
      expect(writeState.written).toBe(true);
      expect(writerDb.prepare("SELECT SUM(api_equiv_usd) AS usd FROM events WHERE source = 'claude'").get()).toEqual({ usd: 0.04 });
      if (mode === 'direct') {
        // A successful direct-handle read must release its savepoint before the caller starts another transaction.
        liveReaderDb.exec('BEGIN DEFERRED');
        liveReaderDb.exec('ROLLBACK');
      }
      if (snapshotDb) {
        // Both a same-handle nested savepoint and a separate request snapshot must leave the caller's pinned state intact.
        expect(snapshotDb.prepare("SELECT SUM(api_equiv_usd) AS usd FROM events WHERE source = 'claude'").get()).toEqual({ usd: 0.02 });
      }
    } finally {
      snapshotDb?.close();
      liveReaderDb.close();
      writerDb.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('releases the direct-handle read savepoint after malformed rows abort the response', async () => {
    const db = openDb({ file: ':memory:' });
    try {
      const ledger = new SqliteLedger(db, price, computeUnits);
      ledger.recordActivity([{ source: 'claude', sessionId: 'fixture-A', ts: EVENT_TS, uuid: 'limits-snapshot-error', host: 'A' }]);
      ledger.upsertEvents([event('A')]);
      const stored = db.prepare('SELECT components_json FROM events WHERE id=?').get('limits-snapshot-A');
      const originalComponents = (stored as { components_json: string }).components_json;
      db.prepare('UPDATE events SET components_json=? WHERE id=?').run('{malformed', 'limits-snapshot-A');
      const config = defaultConfig({ hostLabel: 'A' });
      const queries = createQueries(db, config, {
        now: () => NOW, pricing: price,
        probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }),
      });

      db.exec('SAVEPOINT caller_owned_error');
      await expect(queries.getLimits()).rejects.toThrow();
      // The request cleanup must leave the caller's surrounding transaction intact.
      db.exec('ROLLBACK TO caller_owned_error');
      db.exec('RELEASE caller_owned_error');
      // A second BEGIN succeeds only if the request savepoint was rolled back/released.
      db.exec('BEGIN DEFERRED');
      db.exec('ROLLBACK');
      db.prepare('UPDATE events SET components_json=? WHERE id=?').run(originalComponents, 'limits-snapshot-A');
      db.exec('SAVEPOINT caller_owned_success');
      expect((await queries.getLimits()).snapshots.some((snapshot) => snapshot.source === 'claude-block-estimate')).toBe(true);
      db.exec('RELEASE caller_owned_success');
    } finally {
      db.close();
    }
  });

  it('opens and closes a fresh file-backed request snapshot for Limits', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-limits-file-snapshot-'));
    const dbPath = path.join(tempRoot, 'ledger.sqlite');
    const writerDb = openDb({ file: dbPath });
    try {
      const ledger = new SqliteLedger(writerDb, price, computeUnits);
      ledger.recordActivity([{ source: 'claude', sessionId: 'fixture-A', ts: EVENT_TS, uuid: 'limits-file-snapshot-activity', host: 'A' }]);
      ledger.upsertEvents([event('A')]);
      writerDb.prepare("UPDATE events SET api_equiv_usd = 0.01, price_status = 'LIST', price_version = 'fixture-prices-v1'").run();
      const config = defaultConfig({ hostLabel: 'A' });
      const queries = createQueries(writerDb, config, {
        now: () => NOW,
        pricing: price,
        readSnapshotFile: dbPath,
        probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }),
      });

      const first = await queries.getLimits();
      expect(first.snapshots.find((snapshot) => snapshot.source === 'claude-block-estimate')?.windows[0]?.apiEquivUsd).toBe(0.01);
      writerDb.prepare("UPDATE events SET api_equiv_usd = 0.02, price_status = 'LIST', price_version = 'fixture-prices-v2'").run();
      const second = await queries.getLimits();
      expect(second.snapshots.find((snapshot) => snapshot.source === 'claude-block-estimate')?.windows[0]?.apiEquivUsd).toBe(0.02);
    } finally {
      writerDb.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports both the query failure and a failed savepoint cleanup', async () => {
    const db = openDb({ file: ':memory:' });
    const releaseError = new Error('injected Limits savepoint release failure');
    try {
      const ledger = new SqliteLedger(db, price, computeUnits);
      ledger.recordActivity([{ source: 'claude', sessionId: 'fixture-A', ts: EVENT_TS, uuid: 'limits-cleanup-error', host: 'A' }]);
      ledger.upsertEvents([event('A')]);
      db.prepare('UPDATE events SET components_json=? WHERE id=?').run('{malformed', 'limits-snapshot-A');
      const config = defaultConfig({ hostLabel: 'A' });
      const failingDb = new Proxy(db, {
        get(target, property) {
          if (property === 'exec') {
            return (sql: string) => {
              if (sql === 'RELEASE tokenelo_limits_read') throw releaseError;
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as TokeneloDb;
      const queries = createQueries(failingDb, config, {
        now: () => NOW,
        pricing: price,
        probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }),
      });

      let thrown: unknown;
      try { await queries.getLimits(); }
      catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[1]).toBe(releaseError);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      // This injected release failure leaves the fixture transaction open; clean only this owned in-memory DB.
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  });
});
