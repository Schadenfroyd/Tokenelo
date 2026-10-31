/**
 * Read-only access to Codex's own SQLite state (DESIGN §4.2, §15.2.3, §15.2.5, §15.2.10).
 *
 *  - `thread_history_1.sqlite` → `thread_turns(thread_id, turn_id, rollout_ordinal, status, started_at,
 *    completed_at, duration_ms, …)`: real per-turn wall-clock times (epoch SECONDS). Guardian and forked
 *    subagent rollouts carry a frozen line timestamp on every line (spikes S9 verifier: 01a03586's turns ran
 *    on 08-27 while every line says 08-24), so usage from those files is bucketed by these turn times.
 *  - `state_5.sqlite` → `threads.tokens_used`: the RAW cumulative counter of a thread's rollout (includes
 *    inherited history and misses mid-file resets). It is exposed here ONLY as a verification cross-check
 *    (gate 3) and must never be displayed or summed as usage (§15.2.3).
 *
 * Both files are live WAL databases written by the Codex app. They are opened with node:sqlite
 * `{ readOnly: true }` only — never `immutable=1` (it ignores the WAL), never copied (thread_history is ~8 GB
 * on A2000). Every query is a single short statement (its own implicit read transaction).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded via createRequire (same workaround as store/db.ts): vitest 2's vite-node does not list `node:sqlite`
// among prefixed builtins, so a static import fails in tests with "Failed to load url sqlite".
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => DatabaseSyncType;
};
type DatabaseSync = DatabaseSyncType;

export interface TurnTiming {
  turnId: string;
  /** epoch seconds */
  startedAtS: number | null;
  /** epoch seconds */
  completedAtS: number | null;
  durationMs: number | null;
  status: string | null;
  rolloutOrdinal: number | null;
}

export interface ThreadRow {
  id: string;
  /** RAW cumulative — verification only, never usage (§15.2.3). */
  tokensUsed: number;
  threadSource: string | null;
  source: string | null;
  model: string | null;
  reasoningEffort: string | null;
  rolloutPath: string | null;
  archived: number | null;
}

type Log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  return null;
}

function openReadOnly(file: string, log?: Log): DatabaseSync | null {
  if (!fs.existsSync(file)) return null;
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    log?.('warn', 'codex-sqlite: cannot open read-only', { file, error: String(err) });
    return null;
  }
}

/** One Codex home's SQLite state, opened read-only. Missing files are tolerated (all lookups return empty). */
export class CodexSqlite {
  private historyDb: DatabaseSync | null;
  private stateDb: DatabaseSync | null;
  private turnsStmt: ReturnType<DatabaseSync['prepare']> | null = null;
  private readonly turnCache = new Map<string, Map<string, TurnTiming>>();

  private constructor(historyDb: DatabaseSync | null, stateDb: DatabaseSync | null, private readonly log?: Log) {
    this.historyDb = historyDb;
    this.stateDb = stateDb;
  }

  static open(codexHome: string, log?: Log): CodexSqlite {
    return new CodexSqlite(
      openReadOnly(path.join(codexHome, 'thread_history_1.sqlite'), log),
      openReadOnly(path.join(codexHome, 'state_5.sqlite'), log),
      log
    );
  }

  get hasTurns(): boolean {
    return this.historyDb !== null;
  }

  get hasThreads(): boolean {
    return this.stateDb !== null;
  }

  /** thread_turns rows for one thread, keyed by turn_id (cached per instance). */
  turnsFor(threadId: string): Map<string, TurnTiming> {
    const cached = this.turnCache.get(threadId);
    if (cached) return cached;
    const out = new Map<string, TurnTiming>();
    if (this.historyDb) {
      try {
        this.turnsStmt ??= this.historyDb.prepare(
          'SELECT turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms FROM thread_turns WHERE thread_id = ?'
        );
        for (const r of this.turnsStmt.all(threadId) as Record<string, unknown>[]) {
          const turnId = typeof r.turn_id === 'string' ? r.turn_id : null;
          if (!turnId) continue;
          out.set(turnId, {
            turnId,
            startedAtS: num(r.started_at),
            completedAtS: num(r.completed_at),
            durationMs: num(r.duration_ms),
            status: typeof r.status === 'string' ? r.status : null,
            rolloutOrdinal: num(r.rollout_ordinal),
          });
        }
      } catch (err) {
        this.log?.('warn', 'codex-sqlite: thread_turns query failed', { threadId, error: String(err) });
      }
    }
    this.turnCache.set(threadId, out);
    return out;
  }

  /** All threads rows (verification / doctor cross-check only — tokens_used is NOT usage). */
  threads(): Map<string, ThreadRow> {
    const out = new Map<string, ThreadRow>();
    if (!this.stateDb) return out;
    try {
      const rows = this.stateDb
        .prepare(
          'SELECT id, tokens_used, thread_source, source, model, reasoning_effort, rollout_path, archived FROM threads'
        )
        .all() as Record<string, unknown>[];
      for (const r of rows) {
        if (typeof r.id !== 'string') continue;
        out.set(r.id, {
          id: r.id,
          tokensUsed: num(r.tokens_used) ?? 0,
          threadSource: typeof r.thread_source === 'string' ? r.thread_source : null,
          source: typeof r.source === 'string' ? r.source : null,
          model: typeof r.model === 'string' ? r.model : null,
          reasoningEffort: typeof r.reasoning_effort === 'string' ? r.reasoning_effort : null,
          rolloutPath: typeof r.rollout_path === 'string' ? r.rollout_path : null,
          archived: num(r.archived),
        });
      }
    } catch (err) {
      this.log?.('warn', 'codex-sqlite: threads query failed', { error: String(err) });
    }
    return out;
  }

  close(): void {
    this.turnsStmt = null;
    this.turnCache.clear();
    try {
      this.historyDb?.close();
    } catch {
      /* ignore */
    }
    try {
      this.stateDb?.close();
    } catch {
      /* ignore */
    }
    this.historyDb = null;
    this.stateDb = null;
  }
}
