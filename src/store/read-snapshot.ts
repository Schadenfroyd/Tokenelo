/**
 * Request snapshots for the daemon's read API (see docs/RESPONSIVENESS-2026-10-03.md, "Snapshot per request").
 *
 * A request that reads in several steps, and yields between them, must see one database state. Otherwise Summary totals and
 * the Sessions rows in the same response could come from different commits. So the request's reads run on a separate
 * read-only connection inside one read transaction. Under WAL the transaction keeps its snapshot while the daemon's writable
 * connection commits, and it ends when the request ends. Never page the writable connection: a commit can land between two
 * pages there.
 *
 * Paging. Events and activity are read in keyset pages on (ts, rowid), ordered by ts, rowid. The read-contract test pins that
 * this order equals the single-statement range read's order, including equal timestamps. The keyset resumes strictly after
 * the last row of the previous page, so a run of equal timestamps that spans a page boundary is neither repeated nor skipped.
 *
 * Seeking. A later page must start its index search at the cursor timestamp, not at the range start. The statement puts the
 * cursor's lower bound first, because the planner seeks the first lower bound it is given (test/store/read-seek.test.ts checks
 * the seek key in the VM program). Every original clause is still in WHERE, so the result does not depend on which bound the
 * planner chooses. Only the amount of index work does.
 */
import { measure } from '../core/phase-profile.js';
import { openLedgerReadOnly, type TokeneloDb } from './db.js';
import { checkRead } from '../core/read-control.js';

export interface ReadSnapshot {
  db: TokeneloDb;
  close(): void;
}

/** Opens a read-only connection and holds one read transaction on it until close(). */
export function openReadSnapshot(file: string): ReadSnapshot {
  const db = openLedgerReadOnly(file,{snapshot:true});
  try {
    db.prepare('SELECT 1 FROM events LIMIT 1').get();
  } catch (err) {
    db.close();
    throw err;
  }
  return {
    db,
    close() {
      try {
        db.exec('COMMIT');
      } finally {
        db.close();
      }
    },
  };
}

export interface PageOptions {
  signal?: AbortSignal;
  /**
   * Rows per keyset page. This bounds the row count of one synchronous read (and of its mapping). It is not a time bound:
   * a page of rows with large payloads can take longer than a page of small ones.
   */
  pageRows: number;
  /** Awaited after each full page, so the event loop runs between pages. */
  yieldNow: () => Promise<void>;
  /** Profiling label of each page's statement (default `query.page`). Static, not row data. */
  pageSpan?: string;
}

export interface RowQuery {
  table: 'events' | 'activity';
  /** Column list, e.g. `*`. */
  columns: string;
  /** Conjunctive WHERE clauses, without the keyword. `params[i]` belongs to `clauses[i]`, in order. */
  clauses: string[];
  params: (string | number)[];
  /**
   * The order the rows must come back in. `tsRowid` (default): ts ascending, then rowid. `rowid`: rowid ascending, which is
   * the order of a full scan with no range, and the order the unfiltered aggregate read returns. The keyset follows the order.
   */
  order?: 'tsRowid' | 'rowid';
}

/** The keyset position of the last row of the previous page. */
export interface KeysetCursor {
  ts: number;
  rid: number;
}

/**
 * The statement for one read. With no cursor it is the first page (or the whole result when `limit` is undefined). With a
 * cursor, the cursor's timestamp is the first lower bound, and the strict tuple test on (ts, rowid) follows the original
 * clauses. Exported so tests can check the seek key and the order without running pages.
 */
export function rowStatement(
  q: RowQuery,
  cursor?: KeysetCursor,
  limit?: number
): { sql: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.order === 'rowid') {
    // rowid order: the cursor is the rowid alone, and there is no timestamp bound to seek.
    if (cursor) {
      where.push('rowid > ?');
      params.push(cursor.rid);
    }
    where.push(...q.clauses);
    params.push(...q.params);
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const limitSql = limit === undefined ? '' : ` LIMIT ${limit}`;
    return { sql: `SELECT rowid AS rid, ts, ${q.columns} FROM ${q.table}${whereSql} ORDER BY rowid ASC${limitSql}`, params };
  }
  if (cursor) {
    where.push('ts >= ?');
    params.push(cursor.ts);
  }
  where.push(...q.clauses);
  params.push(...q.params);
  if (cursor) {
    where.push('(ts > ? OR (ts = ? AND rowid > ?))');
    params.push(cursor.ts, cursor.ts, cursor.rid);
  }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const limitSql = limit === undefined ? '' : ` LIMIT ${limit}`;
  return {
    sql: `SELECT rowid AS rid, ts, ${q.columns} FROM ${q.table}${whereSql} ORDER BY ts ASC, rowid ASC${limitSql}`,
    params,
  };
}

/**
 * Reads rows in (ts, rowid) order. Without `page`, one statement on `db` (what a request did before this module). With
 * `page`, keyset pages on the same connection, awaiting `yieldNow` after each full page. Each page is one synchronous
 * statement (`query.page`) followed by its mapping (`query.map`). `map` runs per page, on the raw row, so the caller receives
 * the same array as a single mapping pass over the whole result. A block is bounded by one page of rows.
 */
export async function readRows<R extends { ts: number; rid: number }, T = R>(
  db: TokeneloDb,
  q: RowQuery,
  page?: PageOptions,
  map?: (row: R) => T
): Promise<T[]> {
  const out: T[] = [];
  await visitRows<R>(db, q, page, row => { out.push(map ? map(row) : (row as unknown as T)); });
  return out;
}

/** Same checked keyset order as readRows, without retaining all rows or mapped results. */
export async function visitRows<R extends { ts: number; rid: number }>(
  db: TokeneloDb,
  q: RowQuery,
  page: PageOptions | undefined,
  visit: (row: R) => void
): Promise<void> {
  checkRead(page?.signal);
  if (!page) {
    const stmt = rowStatement(q);
    const rows = measure('query.rows', () => db.prepare(stmt.sql).all(...stmt.params)) as unknown as R[];
    for (const row of rows) visit(row);
    return;
  }
  if (!Number.isSafeInteger(page.pageRows) || page.pageRows <= 0) throw new RangeError('pageRows must be a positive safe integer');
  let cursor: KeysetCursor | undefined;
  for (;;) {
    checkRead(page.signal);
    const stmt = rowStatement(q, cursor, page.pageRows);
    const batch = measure(page.pageSpan ?? 'query.page', () => db.prepare(stmt.sql).all(...stmt.params)) as unknown as R[];
    // The keyset state comes from the raw row, before mapping. The mapped rows are only what the caller receives.
    const last = batch[batch.length - 1];
    measure('query.map', () => {
      for (const row of batch) visit(row);
    });
    if (batch.length < page.pageRows) return;
    cursor = { ts: last!.ts, rid: last!.rid };
    await page.yieldNow();
    checkRead(page.signal);
  }
}
