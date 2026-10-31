import type { TokeneloDb } from './db.js';
import { PRICE_EVIDENCE_SQL } from '../core/price-evidence.js';
import { FILES_PER_YIELD, yieldToEventLoop } from '../core/event-loop.js';
import { checkRead, type DoctorReadPhase } from '../core/read-control.js';
import { SyncSegment, awaitOutside } from '../core/phase-profile.js';

const predicates = {
  invalidAmountEvents: PRICE_EVIDENCE_SQL.invalid,
  unknownStatusEvents: PRICE_EVIDENCE_SQL.unknown,
  statusAmountConflictEvents: PRICE_EVIDENCE_SQL.conflict,
  issuesEvents: `${PRICE_EVIDENCE_SQL.invalid} OR ${PRICE_EVIDENCE_SQL.unknown} OR ${PRICE_EVIDENCE_SQL.conflict}`,
  thinkingUnknownEvents: 'thinking IS NULL',
  ollamaLogThinkingUnknown: "source = 'ollama-log' AND thinking IS NULL",
  speedAssumed: `source = 'claude' AND flags_json LIKE '%"speedAssumed"%'`,
  cacheSplitAssumed: `source = 'claude' AND flags_json LIKE '%"cacheSplitAssumed"%'`,
  // Preserve the source guard: malformed JSON from another collector stays excluded.
  iterationEvents: `CASE WHEN source = 'claude' THEN json_array_length(components_json) > 1 ELSE 0 END`,
  reasoningClamped: `source = 'claude' AND flags_json LIKE '%"reasoningClamped"%'`,
} as const;
const keys = Object.keys(predicates) as Array<keyof typeof predicates>;
export type DoctorCensus = { events: number; usd: number } & Record<keyof typeof predicates, number>;
const COLUMNS = 'rowid AS censusRowid,api_equiv_usd,price_status,thinking,source,flags_json,components_json';
const AGGREGATE = `SELECT COUNT(*) AS events, CAST(MAX(censusRowid) AS TEXT) AS cursor,
  ${keys.map(key => `COALESCE(SUM(CASE WHEN ${predicates[key]} THEN 1 ELSE 0 END),0) AS ${key}`).join(',')}
  FROM (`;
type Batch = Omit<DoctorCensus, 'usd'> & { cursor: string | null };

/**
 * Count at most FILES_PER_YIELD rows inside SQLite per batch, then yield. Only the
 * integer counters cross that boundary; historical dollars keep SQLite's single
 * compensated SUM in table/rowid order, on the same pinned caller transaction.
 * Rowid cursors remain decimal strings so negative, sparse and 64-bit keys are exact.
 *
 * This removes per-event JavaScript materialization, not any evidence qualification.
 * Cancellation is checked around native queries and after each batch's event-loop
 * opportunity. The amount SUM and an individual native batch cannot be interrupted
 * here; worker retirement/deadlines remain unchanged. A row cap is not an IO or
 * response-time bound. The caller owns the snapshot across both passes.
 */
export async function readDoctorCensus(
  db: TokeneloDb,
  signal?: AbortSignal,
  onDiagnosticPhase?: (phase: DoctorReadPhase) => void,
): Promise<DoctorCensus> {
  checkRead(signal);
  const census = { events: 0, usd: 0, ...Object.fromEntries(keys.map(key => [key, 0])) } as DoctorCensus;
  const segment = new SyncSegment('doctor.event-census');
  try {
    // NOT INDEXED preserves the original table/rowid monetary accumulation order.
    onDiagnosticPhase?.('doctor.event-census.money-sum');
    census.usd = (db.prepare('SELECT COALESCE(SUM(api_equiv_usd),0) AS usd FROM events NOT INDEXED').get() as { usd: number }).usd;
    checkRead(signal);
    onDiagnosticPhase?.('doctor.event-census.row-batches');
    const first = db.prepare(`${AGGREGATE}SELECT ${COLUMNS} FROM events ORDER BY rowid LIMIT ?)`);
    const next = db.prepare(`${AGGREGATE}SELECT ${COLUMNS} FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?)`);
    let cursor: string | null = null;
    while (true) {
      checkRead(signal);
      const row = (cursor === null ? first.get(FILES_PER_YIELD) : next.get(cursor, FILES_PER_YIELD)) as Batch;
      checkRead(signal);
      if (row.events === 0) break;
      census.events += row.events;
      for (const key of keys) census[key] += row[key];
      cursor = row.cursor;
      await awaitOutside(segment, yieldToEventLoop);
      checkRead(signal);
    }
  } finally { segment.close(); }
  checkRead(signal);
  return census;
}
