import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { StubValuationEngine, StubPricingEngine, makeEvent } from './stubs.js';

type StatementCounts = { eventRead: number; eventWrite: number; activityWrite: number };
type Fixture = { db: TokeneloDb; ledger: SqliteLedger; counts: StatementCounts };

const fixtures: Fixture[] = [];

function fixture(): Fixture {
  const db = openDb({ file: ':memory:' });
  const counts: StatementCounts = { eventRead: 0, eventWrite: 0, activityWrite: 0 };
  const observedDb = new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized === 'select * from events where id = ?') counts.eventRead++;
        else if (normalized.startsWith('insert into events (')) counts.eventWrite++;
        else if (normalized.startsWith('insert into activity (source, session_id, ts, uuid, host, project, kind, duration_ms)')) {
          counts.activityWrite++;
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as TokeneloDb;
  const result = { db, ledger: new SqliteLedger(observedDb, new StubPricingEngine(), new StubValuationEngine()), counts };
  fixtures.push(result);
  return result;
}

afterEach(() => {
  for (const item of fixtures.splice(0)) {
    if (item.db.isOpen) item.db.close();
  }
});

describe('SqliteLedger fixed statement cache', () => {
  it('prepares event lookup/upsert and activity insert once per ledger while retaining results', () => {
    const { db, ledger, counts } = fixture();
    const event = makeEvent({ id: 'cache-event', inputFresh: 120, output: 30 });
    expect(ledger.upsertEvents([event])).toEqual({ inserted: 1, updated: 0, unchanged: 0 });
    expect(ledger.upsertEvents([event])).toEqual({ inserted: 0, updated: 0, unchanged: 1 });

    const mark = { source: 'claude' as const, sessionId: 'cache-session', ts: 100, uuid: 'cache-activity', host: 'fixture' };
    ledger.recordActivity([mark]);
    ledger.recordActivity([mark]);

    expect(counts).toEqual({ eventRead: 1, eventWrite: 1, activityWrite: 1 });
    expect(ledger.getEvents({}).map(row => row.id)).toEqual(['cache-event']);
    expect(db.prepare('SELECT COUNT(*) AS count FROM activity').get()?.count).toBe(1);
  });

  it('keeps each ledger connection’s prepared statements isolated', () => {
    const first = fixture();
    const second = fixture();
    for (const item of [first, second]) {
      item.ledger.upsertEvents([makeEvent({ id: 'same-id', inputFresh: 10, output: 5 })]);
      item.ledger.recordActivity([{ source: 'claude', sessionId: 's', ts: 1, uuid: 'u', host: 'fixture' }]);
    }

    expect(first.counts).toEqual({ eventRead: 1, eventWrite: 1, activityWrite: 1 });
    expect(second.counts).toEqual({ eventRead: 1, eventWrite: 1, activityWrite: 1 });
  });

  it('drops the cache after connection close and preserves the native closed-database failure', () => {
    const { db, ledger, counts } = fixture();
    const mark = { source: 'claude' as const, sessionId: 's', ts: 1, uuid: 'u', host: 'fixture' };
    ledger.recordActivity([mark]);
    expect(counts.activityWrite).toBe(1);
    db.close();

    expect(() => ledger.recordActivity([mark])).toThrow();
    expect(() => ledger.recordActivity([mark])).toThrow();
    expect(counts.activityWrite).toBe(3);
  });
});
