import type { QueryTimeBasis } from '../core/types.js';
import type { TokeneloDb } from './db.js';

/** Must use the same snapshot as the response; source clocks and capture completeness are not attested. */
export function recordedQueryTimeBasis(db: TokeneloDb, since: number | undefined, asOf: number): QueryTimeBasis {
  const row = db.prepare(`SELECT
    (SELECT COUNT(*) FROM events WHERE ts > ?) AS events,
    (SELECT COUNT(*) FROM activity WHERE ts > ?) AS activity`).get(asOf, asOf) as { events: number; activity: number };
  return { startMs: since ?? null, asOfMs: asOf, endInclusive: true, timestampBasis: 'recorded-timestamps',
    excludedFutureEvents: row.events, excludedFutureActivity: row.activity };
}
