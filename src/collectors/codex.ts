/**
 * Codex rollout collector (DESIGN §4.2 as amended by §15.2 — the S9 + Opus-verified rule is binding).
 *
 * Per rollout file, walk `event_msg/token_count` events that carry `info`, in file order:
 *   - FIRST event: if it appears before any OWN turn (no preceding `task_started` with a real, non-`rollout-N`
 *     turn id followed by model output) it is an inherited snapshot → contributes 0 (its whole total is the
 *     baseline). Otherwise it contributes its own `last_token_usage`.
 *   - Later events: per-field delta vs the previous totals when total_tokens ≥ previous total_tokens.
 *   - Counter reset (total_tokens < previous): contribute the event's own `last_token_usage`, re-anchor.
 *   - EXTENSION (not in the §15.2 text; evidence-driven, requested as a contract change): events while the active
 *     turn is inherited — a replayed `rollout-N` turn, or a turn whose UUIDv7 predates the thread — contribute 0
 *     and re-anchor. A2000 corpus 2026-09-26: 26,033 replay-region + 34,204 older-turn events are verbatim
 *     (total,last) copies of the parent's own token_count events (9.05 B total_tokens that §15.2 would re-count).
 *   - §15.10.1: the active turn is the INNERMOST OPEN turn. A `rollout-N` wrapper may contain a nested turn (own
 *     turn_context / task_started … task_complete) whose UUIDv7 is newer than the thread — that nested turn is
 *     own usage (M4a guardian auto-review files 01a00057 / 01a000e9) — and so is an own turn opened just before a
 *     wrapper or still open across later wrappers (A2000 019ff278 / 019ff2f3); see openTurn/closeTurn/syncActive.
 *     Counted-inside-wrapper events are surfaced per file as `summary.ownInWrapperEvents` for `doctor`.
 * Top-level `token_usage_record` lines (one per API response, unique `response_id`) are ground truth when
 * present: the records pending since the previous token_count become that event's components (flag
 * `recordReconciled`); the derivation above is still computed and any disagreement is counted. Their
 * `thread_token_usage` is never used as a cumulative.
 *
 * Fork markers are recorded as metadata only; they never gate the baseline logic (§15.2.4).
 * Imports are detected only by the exact `<EXTERNAL SESSION IMPORTED>` agent_message marker or an
 * `external-import-turn-N` turn id; later usage is tagged `importedContext` (§15.2.6 detection). §15.9.2 replaces
 * §15.2.6's counting rule: import token_counts carry total_tokens only (context-size estimates, every token field 0),
 * so they emit no usage — though their total growth still enters the raw counter diagnostic `ownTotalDerived`.
 * `state_5.threads.tokens_used` is never used as usage (§15.2.3).
 *
 * Files are streamed line by line (the largest A2000 rollout is 3.57 GB) and resumed from a byte offset with
 * the running parser state persisted in `ingest_state.extra` (see CodexFileState).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ActivityMark,
  Collector,
  CodexContextCheckpointRecoveryCandidate,
  CodexFieldStateEvidence,
  CodexUsageFieldName,
  CodexUsageFieldState,
  EventFlag,
  HostLabel,
  IngestContext,
  IngestState,
  IngestStats,
  LimitSnapshot,
  LimitWindow,
  TokenCounts,
  TsSource,
  UsageComponent,
  UsageEvent,
} from '../core/types.js';
import { CodexSqlite, type TurnTiming } from './codex-sqlite.js';
import { safeIno as fsSafeIno } from './fswalk.js';
import { CodexPrefixStreamDigest, sameCodexPrefixContent, type CodexParsedPrefixDigest } from './codex-prefix-stream.js';
import { FILES_PER_YIELD, YIELD_BUDGET_MS, YieldPacer, yieldToEventLoop } from '../core/event-loop.js';
import { awaitOutside, measure, SyncSegment, intervalBegin, intervalEnd } from '../core/phase-profile.js';
import { performance } from 'node:perf_hooks';
import { codexPrefixWitness, isCodexPrefixWitness, codexObjectId, sameCodexObject, type CodexPrefixWitness } from './codex-prefix.js';
import { isCanonicalCodexSessionId, isUnownedCodexContextState } from '../core/codex-context-recovery.js';
import { emptyCodexCursorCoverageAtStat, recordCodexCursorAtStat } from './codex-cursor-coverage.js';

// ── raw usage ────────────────────────────────────────────────────────────────

/** One Codex usage object (`total_token_usage` / `last_token_usage` / record `usage`), verbatim fields. */
export interface RawUsage {
  input: number; // input_tokens — INCLUDES cached_input_tokens
  cached: number; // cached_input_tokens
  cacheWrite: number; // cache_write_input_tokens (subset assumption, §15.2.8)
  output: number; // output_tokens — INCLUDES reasoning_output_tokens
  reasoning: number; // reasoning_output_tokens
  total: number; // total_tokens as logged (NOT always input+output: synthetic snapshots carry total only)
}

export const ZERO_RAW: Readonly<RawUsage> = Object.freeze({
  input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0,
});

function n0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function readRawUsage(u: unknown): RawUsage | null {
  if (!u || typeof u !== 'object') return null;
  const o = u as Record<string, unknown>;
  const input = n0(o.input_tokens);
  const output = n0(o.output_tokens);
  return {
    input,
    cached: n0(o.cached_input_tokens),
    cacheWrite: n0(o.cache_write_input_tokens),
    output,
    reasoning: n0(o.reasoning_output_tokens),
    total: typeof o.total_tokens === 'number' && Number.isFinite(o.total_tokens) ? o.total_tokens : input + output,
  };
}

const CODEX_USAGE_FIELDS: readonly CodexUsageFieldName[] = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens',
];

function codexFieldStateEvidence(
  value: unknown,
  source: CodexFieldStateEvidence['source'],
  basis: CodexFieldStateEvidence['basis'],
  priorPresence?: CodexFieldStateEvidence['priorPresence'],
  unassessed = false,
): CodexFieldStateEvidence {
  const raw = isRecordObject(value) ? value : undefined;
  const fields = Object.fromEntries(CODEX_USAGE_FIELDS.map((key): [CodexUsageFieldName, CodexUsageFieldState] => {
    if (unassessed) return [key, 'unassessed'];
    if (!raw || !Object.hasOwn(raw, key)) return [key, raw ? 'missing' : 'invalid'];
    const field = raw[key];
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) return [key, 'invalid'];
    return [key, field === 0 ? 'reported-zero' : 'reported-nonzero'];
  })) as Record<CodexUsageFieldName, CodexUsageFieldState>;
  return { schemaVersion: 1, source, basis, fields, ...(priorPresence ? { priorPresence } : {}) };
}

/** Billable size of a raw usage: input (incl. cached) + output. */
export function rawBillable(u: RawUsage): number {
  return u.input + u.output;
}

/** Recovery must not turn absent parent counters into a measured zero baseline. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate only relationships established by the native rollout contract: input includes cached input, output includes
 * reasoning output, and ordinary totals equal input + output. §15.9.2 has one explicit synthetic exception: imported
 * token_count snapshots can carry a total-only context estimate, but only after an import marker/turn was recognized.
 */
function completeNativeCountFields(value: unknown, allowImportedTotalOnly = false): boolean {
  if (!isRecordObject(value)) return false;
  const raw = value;
  const fields = ['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'] as const;
  if (!fields.every(key => Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0)) return false;

  const input = raw.input_tokens as number;
  const cached = raw.cached_input_tokens as number;
  const cacheWrite = raw.cache_write_input_tokens as number;
  const output = raw.output_tokens as number;
  const reasoning = raw.reasoning_output_tokens as number;
  const total = raw.total_tokens as number;
  // Nonzero native cache-write semantics still require the §15.2.8 subset review.
  // A metadata-only recovery must hold that uncertainty; ordinary parsing is unchanged.
  if (cacheWrite !== 0) return false;
  if (cached > input || reasoning > output) return false;
  const expectedTotal = input + output;
  if (Number.isSafeInteger(expectedTotal) && total === expectedTotal) return true;
  return allowImportedTotalOnly && input === 0 && cached === 0 && cacheWrite === 0
    && output === 0 && reasoning === 0;
}

function addRaw(a: RawUsage, b: RawUsage): RawUsage {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    total: a.total + b.total,
  };
}

function sameFields(a: RawUsage, b: RawUsage): boolean {
  return (
    a.input === b.input &&
    a.cached === b.cached &&
    a.cacheWrite === b.cacheWrite &&
    a.output === b.output &&
    a.reasoning === b.reasoning
  );
}

/**
 * Codex raw usage → normalized TokenCounts (§15.2.8 subset assumption):
 * inputFresh = max(0, input − cached − cache_write); cacheRead = cached; cacheWrite5m = cache_write;
 * output includes reasoning; reasoning = min(reasoning, output).
 */
export function toTokenCounts(u: RawUsage): { tokens: TokenCounts; reasoningClamped: boolean } {
  const reasoning = Math.min(u.reasoning, u.output);
  return {
    tokens: {
      inputFresh: Math.max(0, u.input - u.cached - u.cacheWrite),
      cacheWrite5m: u.cacheWrite,
      cacheWrite1h: 0,
      cacheRead: u.cached,
      output: u.output,
      reasoning,
    },
    reasoningClamped: u.reasoning > u.output,
  };
}

// ── parser state (persisted in ingest_state.extra) ─────────────────────────

export const CODEX_STATE_VERSION = 1;
const RECENT_TOTALS_MAX = 64;
export const IMPORT_MARKER = '<EXTERNAL SESSION IMPORTED>';
export const IMPORT_TURN_ID = 'external-import-turn-1';
/** A2000 import rollouts number their replay turns external-import-turn-1..N (verified: 01a09fbf-22e5 has 1..12). */
const IMPORT_TURN_RE = /^external-import-turn-\d+$/;

export interface CodexSessionMeta {
  id: string;
  parentThreadId?: string;
  forkedFromId?: string;
  threadSource?: string;
  sourceKind?: string; // 'vscode' | 'subagent:guardian' | 'subagent:thread_spawn' | …
  agentNickname?: string;
  agentPath?: string;
  subagentHistoryStartOrdinal?: number;
  multiAgentVersion?: string | number;
  historyMode?: string;
  originator?: string;
  cliVersion?: string;
  cwd?: string;
  gitBranch?: string;
  isSubagent: boolean;
}

export interface PendingRecord {
  key: number; // ordinal (or line index)
  responseId: string;
  turnId?: string;
  usage: RawUsage;
  lineTs: number | null;
}

/** Per-file diagnostics (also persisted; `doctor` reads these from ingest_state.extra.summary). */
export interface CodexFileSummary {
  tokenCountEvents: number;
  firstEventKey: number | null;
  /** true = first event came before any own turn (inherited snapshot, contributed 0). */
  firstEventBeforeOwnTurn: boolean | null;
  /** Billable (input+output) tokens of the first event excluded as inherited history. */
  baselineBillable: number;
  /** Billable size of the first event's own last_token_usage (what rule (d) would have added). */
  firstLastBillable: number;
  /** At the first event, the active turn id is a UUIDv7 not older than the thread (diagnostic only). */
  firstEventInNewerUuidTurn: boolean | null;
  /** total_tokens excluded as inherited history (first_total, or first_total − first_last post-turn). */
  baselineTotal: number;
  resets: number;
  resetLastMismatch: number; // reset events whose last.total ≠ total.total
  fieldDecreases: number; // non-reset events where some per-field delta was negative (clamped to 0)
  inheritedBaselineSuspect: boolean;
  records: number;
  recordDuplicates: number;
  recordEvents: number; // token_count events whose tokens came from records
  recordMismatches: number; // events where Σ records ≠ derivation (records won)
  recordFreeDeltas: number; // events with a non-zero derived delta but no pending record, in a file with records
  importDetected: boolean;
  nonZeroCacheWrite: number;
  eventsWithoutModel: number;
  /**
   * Σ contributed total_tokens of the RAW counter derivation (§15.2.1 / §15.9.1; the counter-only number gate 3 compares
   * with `threads.tokens_used`, §15.9.3). It includes non-billable total-only growth (e.g. §15.9.2 synthetic import
   * estimates, which emit no usage) and excludes responses the counter never sees (compaction), so it can differ from
   * Σ records and from `ownBillableEmitted` in either direction. A diagnostic, never usage.
   */
  ownTotalDerived: number;
  /** Σ billable tokens actually emitted (records where present, else derivation). */
  ownBillableEmitted: number;
  /** Σ records usage.total_tokens over unique response ids. */
  recordTotal: number;
  /** Last raw cumulative total_tokens (what state_5.threads.tokens_used mirrors). */
  lastTotal: number | null;
  missingOrdinals: number;
  /** token_count events inside a replayed `rollout-N` turn (copied history; contributed 0, re-anchored). */
  replayEvents: number;
  /** token_count events inside a turn whose UUIDv7 predates the thread (copied parent turn; contributed 0). */
  olderTurnEvents: number;
  /** total_tokens growth skipped inside replayed / older (inherited) turns. */
  replayExcludedTotal: number;
  /** token_usage_record lines whose thread_id is another thread (copied history; ignored). */
  recordsForeignThread: number;
  /** token_usage_record lines met while a replayed `rollout-N` turn was active. */
  recordsInReplay: number;
  /**
   * §15.10.1: token_count events counted as OWN usage while a replayed `rollout-N` wrapper was still open beneath
   * the innermost (own, newer-than-thread) turn — e.g. M4a guardian auto-review files 01a00057 / 01a000e9.
   * Doctor-visible so a regression to "anything inside rollout-N ⇒ 0" (or the reverse) shows up per file.
   */
  ownInWrapperEvents: number;
  /** Σ contributed total_tokens of those events. */
  ownInWrapperTotal: number;
  /**
   * Own token_usage_record lines with no later token_count (the file ended after the response was logged —
   * A2000 guardian files 01a0819d-cfe2 / -a6f1): emitted by `finalizeTrailingRecords` once the file is idle.
   */
  trailingRecords: number;
  trailingRecordTotal: number;
}

export interface OpenTurn {
  id: string;
  /** task_started.started_at (epoch s), when this turn was opened by a task_started line. */
  startedAtS?: number;
}

export interface CodexFileState {
  v: number;
  /** Index of the next line (0-based). */
  lineIndex: number;
  sessionId?: string;
  meta?: CodexSessionMeta;
  /** session_meta line timestamp (ms) — every line of a frozen subagent file carries exactly this. */
  creationTs: number | null;
  model?: string;
  effort?: string;
  /**
   * The ACTIVE turn (§15.10.1: the innermost open turn; when none is open, the most recently closed one so
   * copied token_counts between a replay's task_complete and the next task_started stay attributed to it).
   */
  turnId?: string;
  /** in-file task_started.started_at (epoch s) for `turnId`. */
  turnStartedAtS?: number;
  /** Verified in-file real turn times, retained for pending records across checkpoints. */
  inFileTurnTimesS?: Record<string, number>;
  /**
   * Open turns, outermost first. A replayed `rollout-N` wrapper can contain a nested turn (its own turn_context /
   * task_started … task_complete); closing the nested turn makes the wrapper active again. Absent in states
   * persisted before §15.10.1 — seeded from `turnId` on resume.
   */
  openTurns?: OpenTurn[];
  /**
   * Σ record usage already emitted by `finalizeTrailingRecords` that the NEXT token_count's counter delta will
   * include again if the thread resumes: subtracted from that delta (records win when new ones are pending).
   */
  emittedAhead?: RawUsage;
  ownTurnStarted: boolean;
  ownTurnSeen: boolean;
  prev: RawUsage | null;
  imported: boolean;
  pending: PendingRecord[];
  hasRecords: boolean;
  /** Exact IDs of every accepted response in the consumed prefix; never an LRU window. */
  responseIds: string[];
  /** Absent on legacy states whose old 4096-entry window may have discarded IDs. */
  responseIdsComplete?: boolean;
  /** Read-only prefix recovery completed at this offset; historical event rows were not replayed. */
  responseIdHistoryRecoveredAtOffset?: number;
  recentTotals: number[];
  /** Newest snapshot of the main 'codex' limit (kept for pre-limitId states and callers). */
  lastLimits?: LimitSnapshot;
  /** Newest snapshot per rate_limits.limit_id ('codex', 'codex_bengalfox', 'base_model_inference', …). */
  limitsById?: Record<string, LimitSnapshot>;
  summary: CodexFileSummary;
  /** Current-epoch consumed-content witness, never a claim of historical ledger correctness. */
  consumedPrefix?: CodexPrefixWitness;
  previousSourceKeys?: string[];
  /** Append-only meta receipt retaining the prior replaced context checkpoint. */
  contextCheckpointReceiptId?: string;
}

export function newSummary(): CodexFileSummary {
  return {
    tokenCountEvents: 0,
    firstEventKey: null,
    firstEventBeforeOwnTurn: null,
    baselineBillable: 0,
    firstLastBillable: 0,
    firstEventInNewerUuidTurn: null,
    baselineTotal: 0,
    resets: 0,
    resetLastMismatch: 0,
    fieldDecreases: 0,
    inheritedBaselineSuspect: false,
    records: 0,
    recordDuplicates: 0,
    recordEvents: 0,
    recordMismatches: 0,
    recordFreeDeltas: 0,
    importDetected: false,
    nonZeroCacheWrite: 0,
    eventsWithoutModel: 0,
    ownTotalDerived: 0,
    ownBillableEmitted: 0,
    recordTotal: 0,
    lastTotal: null,
    missingOrdinals: 0,
    replayEvents: 0,
    olderTurnEvents: 0,
    replayExcludedTotal: 0,
    recordsForeignThread: 0,
    recordsInReplay: 0,
    ownInWrapperEvents: 0,
    ownInWrapperTotal: 0,
    trailingRecords: 0,
    trailingRecordTotal: 0,
  };
}

export function newFileState(): CodexFileState {
  return {
    v: CODEX_STATE_VERSION,
    lineIndex: 0,
    creationTs: null,
    ownTurnStarted: false,
    ownTurnSeen: false,
    prev: null,
    imported: false,
    pending: [],
    hasRecords: false,
    responseIds: [],
    responseIdsComplete: true,
    recentTotals: [],
    summary: newSummary(),
  };
}

function isFileState(x: unknown): x is CodexFileState {
  return !!x && typeof x === 'object' && (x as CodexFileState).v === CODEX_STATE_VERSION &&
    typeof (x as CodexFileState).lineIndex === 'number';
}

/** Legacy states are complete only when their unique-record diagnostic fits the retained set. */
function hasExactResponseIdHistory(state: CodexFileState): boolean {
  return state.responseIdsComplete === true || state.summary.records <= new Set(state.responseIds).size;
}

/** Exact cached totals cover the parsed prefix only; current file tails are checked separately. */
function hasExactRecentTotals(state: CodexFileState): boolean {
  const count = state.summary?.tokenCountEvents;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    && Array.isArray(state.recentTotals) && state.recentTotals.length === count
    && state.recentTotals.every(total => Number.isSafeInteger(total) && total >= 0);
}

// ── parser output ────────────────────────────────────────────────────────────

export interface ParsedComponent {
  model: string;
  raw: RawUsage;
  requestInput?: number;
  codexFieldStateEvidence?: CodexFieldStateEvidence;
}

export interface ParsedUsage {
  /** `codex:<sessionId>:<ordinal|lineIndex>` */
  id: string;
  key: number;
  sessionId: string;
  ts: number;
  tsSource: TsSource;
  turnId?: string;
  model: string;
  effort?: string;
  components: ParsedComponent[];
  flags: EventFlag[];
}

export interface ParserOptions {
  host: HostLabel;
  /** thread_turns lookup (thread_history_1.sqlite) for frozen-timestamp files. */
  turns?: (threadId: string) => Map<string, TurnTiming> | undefined;
  /** Complete raw token_count totals for a parent; undefined means membership is unknown or incomplete. */
  parentTotals?: (parentId: string) => ReadonlySet<number> | undefined;
  /** Fallback session id (UUID in the file name) when session_meta is missing. */
  fallbackSessionId?: string;
  onWarning?: (msg: string) => void;
  /** Internal replacement-context inspection only; ordinary legacy parsing stays unchanged. */
  strictNativeCountFields?: boolean;
}

// Fast structural peek. Codex writes `{"timestamp":…,"ordinal":N,"type":"X","payload":{"type":"Y",…`.
// Anything not matching falls back to a full JSON.parse, so the peek is an optimisation, never a filter.
const PEEK_RE =
  /^\{"timestamp":"([^"]*)",(?:"ordinal":(\d+),)?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)"(?:,"role":"([a-z_]+)")?)?/;
const ROLLOUT_TURN_RE = /^rollout-\d+$/;

/** Millisecond timestamp embedded in a UUIDv7 (thread and turn ids are UUIDv7), else null. */
export function uuidV7Ms(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(id);
  return m ? parseInt(m[1]! + m[2]!, 16) : null;
}

/**
 * A turn that cannot be this thread's own work: a replayed `rollout-N` turn, or a turn whose UUIDv7 time is
 * earlier than the thread's own UUIDv7 creation time (a parent/source turn copied into a fork or subagent).
 * A2000 corpus check (2026-09-26): 26,033 replay-region events and 34,204 older-turn events are verbatim
 * (total,last) copies of the parent's own token_count events.
 */
export function isInheritedTurn(turnId: unknown, threadId: unknown): boolean {
  if (isReplayTurnId(turnId)) return true;
  const t = uuidV7Ms(turnId);
  const th = uuidV7Ms(threadId);
  return t !== null && th !== null && t < th;
}

/** A replayed history turn (`rollout-N`): written at thread creation, started_at == completed_at == creation. */
export function isReplayTurnId(id: unknown): boolean {
  return typeof id === 'string' && ROLLOUT_TURN_RE.test(id);
}

/** A real turn id: a string that is neither a replayed `rollout-N` turn nor a synthetic import turn. */
export function isRealTurnId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && !ROLLOUT_TURN_RE.test(id) && !IMPORT_TURN_RE.test(id);
}

/** response_item that is model output (not a replayed user/developer/system message, not a tool result). */
function isModelOutput(payloadType: string | undefined, role: string | undefined): boolean {
  if (!payloadType) return false;
  if (payloadType === 'message') return role === 'assistant';
  return !payloadType.endsWith('_output');
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function metaFrom(p: Record<string, unknown>, fallbackId: string | undefined): CodexSessionMeta | null {
  const id = str(p.id) ?? fallbackId;
  if (!id) return null;
  const src = p.source;
  let sourceKind: string | undefined;
  let spawnParent: string | undefined;
  if (typeof src === 'string') sourceKind = src;
  else if (src && typeof src === 'object') {
    const sub = (src as Record<string, unknown>).subagent;
    if (sub && typeof sub === 'object') {
      const s = sub as Record<string, unknown>;
      if (s.thread_spawn && typeof s.thread_spawn === 'object') {
        sourceKind = 'subagent:thread_spawn';
        spawnParent = str((s.thread_spawn as Record<string, unknown>).parent_thread_id);
      } else if (typeof s.other === 'string') sourceKind = `subagent:${s.other}`;
      else sourceKind = 'subagent';
    } else sourceKind = Object.keys(src as object)[0];
  }
  const threadSource = str(p.thread_source);
  const parentThreadId = str(p.parent_thread_id) ?? spawnParent;
  const forkedFromId = str(p.forked_from_id);
  const git = p.git && typeof p.git === 'object' ? (p.git as Record<string, unknown>) : undefined;
  const hso = p.subagent_history_start_ordinal;
  const mav = p.multi_agent_version;
  return {
    id,
    parentThreadId,
    forkedFromId,
    threadSource,
    sourceKind,
    agentNickname: str(p.agent_nickname),
    agentPath: str(p.agent_path),
    subagentHistoryStartOrdinal: typeof hso === 'number' ? hso : undefined,
    multiAgentVersion: typeof mav === 'string' || typeof mav === 'number' ? mav : undefined,
    historyMode: str(p.history_mode),
    originator: str(p.originator),
    cliVersion: str(p.cli_version),
    cwd: str(p.cwd),
    gitBranch: git ? str(git.branch) : undefined,
    isSubagent:
      threadSource === 'subagent' ||
      threadSource === 'guardian_review' ||
      (sourceKind?.startsWith('subagent') ?? false) ||
      parentThreadId !== undefined,
  };
}

/** limit_id of a snapshot with none recorded (older Codex builds): the main plan limit. */
export const DEFAULT_CODEX_LIMIT_ID = 'codex';

function limitsFrom(rl: unknown, host: HostLabel, capturedAt: number): LimitSnapshot | null {
  if (!rl || typeof rl !== 'object') return null;
  const r = rl as Record<string, unknown>;
  // Every limit id is kept separately (DESIGN §15.9.5): A2000 rollouts carry 'codex',
  // 'codex_bengalfox' (limit_name "GPT-5.3-Codex-Spark"), 'base_model_inference' and 'premium'.
  const limitId = typeof r.limit_id === 'string' && r.limit_id.length > 0 ? r.limit_id : DEFAULT_CODEX_LIMIT_ID;
  const windows: LimitWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const w = r[id];
    if (!w || typeof w !== 'object') continue;
    const o = w as Record<string, unknown>;
    windows.push({
      id,
      usedPercent: typeof o.used_percent === 'number' ? o.used_percent : null,
      windowMinutes: typeof o.window_minutes === 'number' ? o.window_minutes : undefined,
      resetsAt: typeof o.resets_at === 'number' ? o.resets_at * 1000 : undefined,
    });
  }
  // An id with no windows (A2000 'premium': primary/secondary null) carries no limit to show.
  if (windows.length === 0) return null;
  const snap: LimitSnapshot = { source: 'codex', limitId, host, capturedAt, windows, estimate: false };
  const plan = str(r.plan_type);
  if (plan) snap.planType = plan;
  const c = r.credits;
  if (c && typeof c === 'object') {
    const co = c as Record<string, unknown>;
    snap.credits = {
      hasCredits: co.has_credits === true,
      unlimited: co.unlimited === true,
      balance: co.balance === undefined || co.balance === null ? '' : String(co.balance),
    };
  }
  return snap;
}

/**
 * Streaming, resumable parser for ONE rollout file. Feed complete lines in file order with `pushLine`;
 * drain outputs with `takeUsage` / `takeMarks`; persist `state` to resume after the last pushed line.
 */
export class CodexTimestampUnavailableError extends Error {
  constructor() { super('Codex usage is waiting for a verifiable turn timestamp; unread offset held'); }
}

const CONTEXT_RECORD_TYPES = new Set(['session_meta','turn_context','world_state','response_item','token_usage_record','event_msg','compacted','inter_agent_communication_metadata']);
const CONTEXT_EVENT_TYPES = new Set(['token_count','task_started','task_complete','turn_aborted','thread_settings_applied','agent_message','user_message','item_completed']);

function onlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key));
}

function importCompletionTurnId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^external-import-turn-[1-9]\d*$/.test(value)) return false;
  return Number.isSafeInteger(Number(value.slice('external-import-turn-'.length)));
}

export class CodexRolloutParser {
  readonly state: CodexFileState;
  private usage: ParsedUsage[] = [];
  /** Frozen-timestamp events held until their turn's task_complete (which carries started_at) arrives. */
  private deferred: ParsedUsage[] = [];
  private marks: ActivityMark[] = [];
  private respIdSet: Set<string>;
  /** Field-state metadata observed in this parser call; deliberately absent from persisted cursor state. */
  private readonly recordFieldStates = new Map<string, CodexFieldStateEvidence>();
  /** Transient strict-inspection proof: a turn_context or restored state alone cannot establish an import task. */
  private importCompletionTask?: string;
  /** Every token_count total_tokens seen by THIS parser instance (not persisted; feeds the suspect check). */
  readonly runTotals: number[] = [];

  constructor(state: CodexFileState | undefined, private readonly opts: ParserOptions) {
    this.state = state && isFileState(state) ? state : newFileState();
    if (!hasExactResponseIdHistory(this.state)) {
      throw new Error('Codex response history is incomplete; restore the consumed rollout prefix before resuming');
    }
    this.respIdSet = new Set(this.state.responseIds);
    // States persisted before §15.10.1 carry only the active turn: treat it as the single open turn.
    if (!Array.isArray(this.state.openTurns)) {
      this.state.openTurns = this.state.turnId
        ? [{ id: this.state.turnId, ...(this.state.turnStartedAtS !== undefined ? { startedAtS: this.state.turnStartedAtS } : {}) }]
        : [];
    }
    this.state.summary.ownInWrapperEvents ??= 0;
    this.state.summary.ownInWrapperTotal ??= 0;
    this.state.summary.trailingRecords ??= 0;
    this.state.summary.trailingRecordTotal ??= 0;
  }

  // ── turn stack (§15.10.1: active turn = innermost open turn) ──
  //
  // A `rollout-N` turn is a replay/pagination WRAPPER, not a turn of its own: the turn that owns the events inside
  // it is the innermost open REAL turn, whether that turn was opened inside the wrapper (M4a guardian auto-review
  // 01a00057: task_started rollout-2 → turn_context <own turn> → token_count → task_complete <own turn>) or just
  // before it (A2000 spawned subagent 019ff278: turn_context <own turn> → task_started rollout-4 → 99 token_counts
  // → task_complete <own turn> → task_complete rollout-4). Only when no real turn is open inside/around the
  // wrapper is the wrapper itself active — a replayed region (01a02222: turn_context <parent's older turn> →
  // rollout-4 → 125 verbatim parent copies).

  private get open(): OpenTurn[] {
    return (this.state.openTurns ??= []);
  }

  /**
   * Re-derive the active turn (unchanged when none is open): the innermost open real turn — except that a wrapper
   * opened AFTER a real turn stays active unless that turn is provably this thread's own (UUIDv7 not older than
   * the thread); a turn of unknown age around a wrapper does not make replayed events own. No real turn open →
   * the innermost wrapper.
   */
  private syncActive(): void {
    const open = this.open;
    if (open.length === 0) return;
    let active = open[open.length - 1]!;
    let wrapperAbove: OpenTurn | undefined;
    for (let i = open.length - 1; i >= 0; i--) {
      const t = open[i]!;
      if (isReplayTurnId(t.id)) {
        wrapperAbove ??= t;
        continue;
      }
      active = !wrapperAbove || this.provablyOwnTurn(t.id) ? t : wrapperAbove;
      break;
    }
    this.state.turnId = active.id;
    this.state.turnStartedAtS = active.startedAtS;
  }

  /** A UUIDv7 turn id not older than this thread's UUIDv7 id. */
  private provablyOwnTurn(id: string): boolean {
    return uuidV7Ms(id) !== null && uuidV7Ms(this.sessionId) !== null && !isInheritedTurn(id, this.sessionId);
  }

  /**
   * A turn opens (task_started, or a turn_context naming a turn that is not already open). A `rollout-N` wrapper is
   * pushed. A real turn is pushed innermost and supersedes every other open real turn (a thread runs one real turn
   * at a time; one that never logged task_complete was interrupted or belongs to replayed history).
   */
  private openTurn(id: string, startedAtS: number | undefined): void {
    const s = this.state;
    let open = this.open;
    const existing = open.find((t) => t.id === id);
    if (existing) {
      if (startedAtS !== undefined) existing.startedAtS = startedAtS;
    } else {
      const entry: OpenTurn = startedAtS !== undefined ? { id, startedAtS } : { id };
      if (!isReplayTurnId(id)) open = s.openTurns = open.filter((t) => isReplayTurnId(t.id));
      open.push(entry);
    }
    this.syncActive();
    if (isRealTurnId(id) && !isInheritedTurn(id, this.sessionId)) s.ownTurnStarted = true;
  }

  /**
   * task_complete / turn_aborted closes exactly that turn: wrappers are pagination segments of the replayed
   * history, so closing one does not close a real turn opened inside it (A2000 019ff2f3: own turn opened inside
   * `rollout-2` runs on through `rollout-264` until its turn_aborted). Closing the last open turn leaves it as the
   * active turn. An id that is not open is ignored; a missing id closes the innermost turn.
   */
  private closeTurn(id: string | undefined): void {
    const open = this.open;
    const i = id === undefined ? open.length - 1 : open.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [closed] = open.splice(i, 1);
    if (open.length > 0) this.syncActive();
    else {
      this.state.turnId = closed!.id;
      this.state.turnStartedAtS = closed!.startedAtS;
    }
  }

  /** A `rollout-N` wrapper is open while the active turn is a real turn. */
  private insideReplayWrapper(): boolean {
    const s = this.state;
    if (isReplayTurnId(s.turnId)) return false;
    return this.open.some((t) => isReplayTurnId(t.id));
  }

  /** Number of usage events buffered since the last takeUsage(). */
  get bufferedUsage(): number {
    return this.usage.length;
  }

  get unresolvedTimestampUsage(): number {
    return this.deferred.length;
  }

  private rememberTurnTime(turnId: string | undefined, timeS: number | undefined): void {
    if (!isRealTurnId(turnId) || timeS === undefined || !Number.isFinite(timeS)) return;
    const times = this.state.inFileTurnTimesS ??= {};
    // Turn IDs come from source data; preserve literal keys including __proto__ without prototype mutation.
    Object.defineProperty(times, turnId!, { value: timeS, enumerable: true, writable: true, configurable: true });
    const keep: ParsedUsage[] = [];
    for (const ev of this.deferred) {
      if (ev.turnId === turnId) {
        ev.ts = timeS * 1000; ev.tsSource = 'turn';
        this.usage.push(ev); this.mark(ev.key, ev.ts, 'assistant');
      } else keep.push(ev);
    }
    this.deferred = keep;
  }

  /**
   * Refuse a checkpoint while own usage still lacks a verifiable subagent turn time.
   * Identity-only prefix recovery may discard historical placeholder events without publishing them.
   */
  releaseDeferred(options: { identityOnly?: boolean } = {}): void {
    if (!options.identityOnly && this.unresolvedTimestampUsage > 0) throw new CodexTimestampUnavailableError();
    for (const ev of this.deferred) {
      this.usage.push(ev);
      this.mark(ev.key, ev.ts, 'assistant');
    }
    this.deferred = [];
  }

  takeUsage(): ParsedUsage[] {
    const u = this.usage;
    this.usage = [];
    return u;
  }

  takeMarks(): ActivityMark[] {
    const m = this.marks;
    this.marks = [];
    return m;
  }

  /** Snapshot with exact response identity across every batch and process restart. */
  snapshotState(): CodexFileState {
    const s = this.state;
    s.responseIds = [...this.respIdSet];
    s.responseIdsComplete = true;
    return JSON.parse(JSON.stringify(s)) as CodexFileState;
  }

  get sessionId(): string | undefined {
    return this.state.sessionId ?? this.opts.fallbackSessionId;
  }

  private warn(msg: string): void {
    this.opts.onWarning?.(msg);
  }

  private pendingRecordEvidence(record: PendingRecord, basis: 'record-reconciled' | 'trailing-record'): CodexFieldStateEvidence {
    const seen = this.recordFieldStates.get(record.responseId);
    if (seen) return { ...seen, basis };
    // Legacy cursors retain normalized RawUsage but not the original field-presence states.
    return codexFieldStateEvidence(undefined, 'token_usage_record.usage', basis, undefined, true);
  }

  /**
   * Emit own records still pending with no token_count after them. Call only when the file is idle (its writer
   * is done): a live file logs the record a moment before its token_count. The emitted usage is remembered in
   * `emittedAhead` so a later token_count (thread resumed) does not count those responses a second time.
   */
  finalizeTrailingRecords(): void {
    const s = this.state;
    if (s.pending.length === 0) return;
    const pending = s.pending;
    const recSum = pending.reduce<RawUsage>((a, r) => addRaw(a, r.usage), { ...ZERO_RAW });
    const model = s.model ?? 'unknown';
    const first = pending[0]!;
    const turnId = first.turnId ?? s.turnId;
    const { ts, src } = this.eventTime(first.lineTs, turnId, first.lineTs);
    const sid = this.sessionId ?? 'unknown';
    const ev: ParsedUsage = {
      id: `codex:${sid}:${first.key}`,
      key: first.key,
      sessionId: sid,
      ts,
      tsSource: src,
      model,
      components: pending.map((r) => ({ model, raw: r.usage,
        ...(r.usage.input > 0 ? { requestInput: r.usage.input } : {}),
        codexFieldStateEvidence: this.pendingRecordEvidence(r, 'trailing-record'),
      })),
      flags: s.imported ? ['recordReconciled', 'importedContext'] : ['recordReconciled'],
    };
    if (turnId) ev.turnId = turnId;
    if (s.effort) ev.effort = s.effort;
    s.summary.trailingRecords += pending.length;
    s.summary.trailingRecordTotal += recSum.total;
    s.summary.ownBillableEmitted += rawBillable(recSum);
    s.emittedAhead = s.emittedAhead ? addRaw(s.emittedAhead, recSum) : recSum;
    s.pending = [];
    for (const record of pending) this.recordFieldStates.delete(record.responseId);
    if (src === 'frozen-line') this.deferred.push(ev);
    else {
      this.usage.push(ev);
      this.mark(ev.key, ev.ts, 'assistant');
    }
  }

  pushLine(line: Buffer | string): void {
    const s = this.state;
    const lineIndex = s.lineIndex++;
    const buf = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
    if (buf.length === 0) return;
    const head = buf.toString('latin1', 0, Math.min(buf.length, 400));
    const m = PEEK_RE.exec(head);
    let obj: Record<string, unknown> | undefined;
    let type: string | undefined;
    let ptype: string | undefined;
    let role: string | undefined;
    let ordinal: number | undefined;
    let lineTs: number | null = null;
    if (this.opts.strictNativeCountFields) {
      // Recovery must not let the fast header peek turn malformed or unknown native records into a zero baseline.
      obj = this.parse(buf, lineIndex);
      if (!isRecordObject(obj) || typeof obj.type !== 'string' || !CONTEXT_RECORD_TYPES.has(obj.type)
        || !isRecordObject(obj.payload)) throw new Error('Codex context checkpoint requires a supported native record object');
      type = obj.type;lineTs = parseTs(obj.timestamp);
      ordinal = typeof obj.ordinal === 'number' ? obj.ordinal : undefined;
      ptype = str(obj.payload.type);role = str(obj.payload.role);
      if (type === 'event_msg' && (!ptype || !CONTEXT_EVENT_TYPES.has(ptype)))
        throw new Error('Codex context checkpoint requires a supported native event type');
    } else if (m) {
      lineTs = parseTs(m[1]);
      ordinal = m[2] !== undefined ? Number(m[2]) : undefined;
      type = m[3];
      ptype = m[4];
      role = m[5];
    } else {
      obj = this.parse(buf, lineIndex);
      if (!obj) return;
      type = str(obj.type);
      lineTs = parseTs(obj.timestamp);
      ordinal = typeof obj.ordinal === 'number' ? obj.ordinal : undefined;
      const p = obj.payload as Record<string, unknown> | undefined;
      ptype = p && typeof p === 'object' ? str(p.type) : undefined;
      role = p && typeof p === 'object' ? str(p.role) : undefined;
    }
    const key = ordinal ?? lineIndex;

    switch (type) {
      case 'session_meta': {
        if (s.meta) return; // only the first session_meta describes this file
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (!p) return;
        const meta = metaFrom(p, this.opts.fallbackSessionId);
        if (meta) {
          s.meta = meta;
          s.sessionId = meta.id;
          s.creationTs = lineTs;
        }
        return;
      }
      case 'turn_context': {
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (!p) return;
        const cm = p.collaboration_mode as Record<string, unknown> | undefined;
        const settings = cm && typeof cm === 'object' ? (cm.settings as Record<string, unknown> | undefined) : undefined;
        const model = str(p.model) ?? str(settings?.model) ?? str(cm?.model);
        const effort = str(p.effort) ?? str(p.reasoning_effort) ?? str(settings?.reasoning_effort);
        if (model) s.model = model;
        if (effort) s.effort = effort;
        const tid = str(p.turn_id);
        if (this.opts.strictNativeCountFields && tid && tid !== this.importCompletionTask) this.importCompletionTask = undefined;
        if (tid && tid !== s.turnId) this.openTurn(tid, undefined);
        if (s.meta && str(p.cwd)) s.meta.cwd = str(p.cwd);
        return;
      }
      case 'world_state': {
        if (s.model) return;
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        const st = p?.state as Record<string, unknown> | undefined;
        const model = st ? str(st.model) : undefined;
        if (model) s.model = model;
        return;
      }
      case 'response_item': {
        if (s.ownTurnStarted && !s.ownTurnSeen && s.prev === null) {
          if (ptype === 'message' && role === undefined) {
            obj ??= this.parse(buf, lineIndex);
            const p = obj?.payload as Record<string, unknown> | undefined;
            role = p ? str(p.role) : undefined;
          }
          if (isModelOutput(ptype, role)) s.ownTurnSeen = true;
        }
        return;
      }
      case 'token_usage_record': {
        obj ??= this.parse(buf, lineIndex);
        if (this.opts.strictNativeCountFields && !isRecordObject(obj?.payload))
          throw new Error('Codex context checkpoint requires a native response payload object');
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (p) this.onRecord(p, key, lineTs);
        return;
      }
      case 'event_msg':
        if (this.opts.strictNativeCountFields) {
          obj ??= this.parse(buf, lineIndex);
          const payload = obj?.payload;
          if (!isRecordObject(payload) || typeof payload.type !== 'string')
            throw new Error('Codex context checkpoint requires a typed event payload object');
        }
        break;
      default:
        return; // compacted, inter_agent_communication_metadata, … carry no usage
    }

    // event_msg
    switch (ptype) {
      case 'token_count': {
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (p) {
          if (ordinal === undefined) s.summary.missingOrdinals++;
          this.onTokenCount(p, key, lineTs);
        }
        return;
      }
      case 'task_started': {
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (!p) return;
        const tid = str(p.turn_id);
        if (this.opts.strictNativeCountFields) {
          this.importCompletionTask = s.meta && importCompletionTurnId(tid) ? tid : undefined;
        }
        const startedAt = typeof p.started_at === 'number' ? p.started_at : undefined;
        if (tid) this.openTurn(tid, startedAt);
        this.rememberTurnTime(tid, startedAt);
        if (tid !== undefined && IMPORT_TURN_RE.test(tid)) this.markImport();
        if (isRealTurnId(tid) && !isInheritedTurn(tid, this.sessionId)) {
          this.mark(key, startedAt !== undefined ? startedAt * 1000 : lineTs, 'turn');
        }
        return;
      }
      case 'task_complete':
      case 'turn_aborted': {
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (!p) return;
        const tid = str(p.turn_id);
        this.closeTurn(tid);
        if (this.opts.strictNativeCountFields && !this.open.some(t => t.id === this.importCompletionTask)) {
          this.importCompletionTask = undefined;
        }
        // copied parent turns (replayed / older than this thread) are not this session's activity
        if (!isRealTurnId(tid) || isInheritedTurn(tid, this.sessionId)) return;
        const row = this.turnRow(tid);
        const completedAt = typeof p.completed_at === 'number' ? p.completed_at : row?.completedAtS ?? undefined;
        const dur = typeof p.duration_ms === 'number' ? p.duration_ms : row?.durationMs ?? undefined;
        this.mark(key, completedAt !== undefined ? completedAt * 1000 : lineTs, 'turn', dur);
        const startedAt = typeof p.started_at === 'number' ? p.started_at : row?.startedAtS ?? completedAt;
        this.rememberTurnTime(tid, startedAt);
        return;
      }
      case 'thread_settings_applied': {
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        const ts = p?.thread_settings as Record<string, unknown> | undefined;
        if (ts && typeof ts === 'object') {
          const model = str(ts.model);
          const effort = str(ts.reasoning_effort);
          if (model) s.model = model;
          if (effort) s.effort = effort;
        }
        return;
      }
      case 'agent_message': {
        // Only the exact marker counts (§15.2.6); cheap substring gate before parsing.
        if (buf.indexOf(IMPORT_MARKER) === -1) return;
        obj ??= this.parse(buf, lineIndex);
        const p = obj?.payload as Record<string, unknown> | undefined;
        if (p && p.message === IMPORT_MARKER) this.markImport();
        return;
      }
      case 'item_completed': {
        // Ordinary parsing historically ignores these protocol items. Only strict context inspection may
        // recognize the separately validated external-import message form; it never marks model output.
        if (this.opts.strictNativeCountFields) this.validateImportCompletion(obj!);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The observed native import writer repeats message context as ItemCompletedEvent, separately from response
   * usage records. Recognize only that message schema and a task opened here, never arbitrary protocol items
   * or a message completed by an own turn. Unknown fields remain a recovery hold, including nested usage.
   */
  private validateImportCompletion(obj: Record<string, unknown>): void {
    const s = this.state;
    const p = obj.payload;
    const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
    const sid = s.sessionId;
    if (!onlyFields(obj,['timestamp','ordinal','type','payload'])
      || typeof obj.timestamp !== 'string' || parseTs(obj.timestamp) === null
      || !timestamp(obj.ordinal) || !isRecordObject(p)
      || !onlyFields(p,['type','thread_id','turn_id','item','started_at_ms','completed_at_ms'])
      || !timestamp(p.completed_at_ms)
      || (Object.hasOwn(p,'started_at_ms') && (!timestamp(p.started_at_ms) || p.started_at_ms > p.completed_at_ms))
      || !isCanonicalCodexSessionId(p.thread_id) || !isCanonicalCodexSessionId(sid)
      || !isCanonicalCodexSessionId(s.meta?.id) || p.thread_id.toLowerCase() !== sid.toLowerCase()
      || p.thread_id.toLowerCase() !== s.meta.id.toLowerCase()
      || (this.opts.fallbackSessionId !== undefined && (!isCanonicalCodexSessionId(this.opts.fallbackSessionId)
        || p.thread_id.toLowerCase() !== this.opts.fallbackSessionId.toLowerCase()))
      || !importCompletionTurnId(p.turn_id) || p.turn_id !== this.importCompletionTask || p.turn_id !== s.turnId
      || !this.open.some(t => t.id === p.turn_id) || s.imported !== true || !isUnownedCodexContextState(s,sid)) {
      throw new Error('Codex context checkpoint requires a bound external-import completion');
    }
    const item = p.item;
    if (!isRecordObject(item) || !onlyFields(item,['type','id','content'])
      || typeof item.id !== 'string' || item.id.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(item.id)
      || !Array.isArray(item.content) || (item.type !== 'AgentMessage' && item.type !== 'UserMessage')
      || !item.content.every(part => isRecordObject(part) && typeof part.text === 'string'
        && (item.type === 'AgentMessage'
          ? part.type === 'Text' && onlyFields(part,['type','text'])
          : part.type === 'text' && onlyFields(part,['type','text','text_elements'])
            && Array.isArray(part.text_elements) && part.text_elements.length === 0))) {
      throw new Error('Codex context checkpoint requires a supported external-import message item');
    }
  }

  private parse(buf: Buffer, lineIndex: number): Record<string, unknown> | undefined {
    try {
      const o = JSON.parse(buf.toString('utf8')) as unknown;
      return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
    } catch {
      this.warn(`codex: unparseable line ${lineIndex}`);
      return undefined;
    }
  }

  private markImport(): void {
    this.state.imported = true;
    this.state.summary.importDetected = true;
  }

  private turnRow(turnId: string | undefined): TurnTiming | undefined {
    if (!turnId || !this.sessionId) return undefined;
    return this.opts.turns?.(this.sessionId)?.get(turnId);
  }

  private mark(key: number, ts: number | null, kind: ActivityMark['kind'], durationMs?: number): void {
    const sid = this.sessionId;
    if (!sid || ts === null) return;
    const mk: ActivityMark = {
      source: 'codex',
      sessionId: sid,
      ts,
      uuid: `codex:${sid}:${key}`,
      host: this.opts.host,
      kind,
    };
    if (this.state.meta?.cwd) mk.project = this.state.meta.cwd;
    if (durationMs !== undefined) mk.durationMs = durationMs;
    this.marks.push(mk);
  }

  /** Line timestamps of subagent files are frozen at creation (§15.2.5): use real turn times instead. */
  private eventTime(lineTs: number | null, turnId: string | undefined, fromRecordTs?: number | null): { ts: number; src: TsSource } {
    const s = this.state;
    const subagent = s.meta?.isSubagent === true;
    const frozen = subagent && (lineTs === null || lineTs === s.creationTs);
    if (!frozen && fromRecordTs !== undefined && fromRecordTs !== null) return { ts: fromRecordTs, src: 'record' };
    const row = this.turnRow(turnId);
    if (row?.startedAtS != null) return { ts: row.startedAtS * 1000, src: 'turn' };
    if (row?.completedAtS != null) return { ts: row.completedAtS * 1000, src: 'turn' };
    const times = s.inFileTurnTimesS;
    if (turnId && times && Object.hasOwn(times, turnId) && Number.isFinite(times[turnId])) {
      return { ts: times[turnId]! * 1000, src: 'turn' };
    }
    if (turnId && turnId === s.turnId && s.turnStartedAtS !== undefined && isRealTurnId(turnId)) {
      return { ts: s.turnStartedAtS * 1000, src: 'turn' };
    }
    if (!subagent && lineTs !== null) return { ts: lineTs, src: 'line' };
    // This placeholder is never published: releaseDeferred holds before any checkpoint.
    return { ts: lineTs ?? s.creationTs ?? 0, src: 'frozen-line' };
  }

  private onRecord(p: Record<string, unknown>, key: number, lineTs: number | null): void {
    const s = this.state;
    if (this.opts.strictNativeCountFields && (!completeNativeCountFields(p.usage)
      || typeof p.response_id !== 'string' || p.response_id.trim().length === 0
      || typeof p.thread_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(p.thread_id)))
      throw new Error('Codex context checkpoint requires recorded native response fields');
    const rid = str(p.response_id);
    const usage = readRawUsage(p.usage);
    if (!rid || !usage) {
      this.warn(`codex: token_usage_record without response_id/usage at ${key}`);
      return;
    }
    const threadId = str(p.thread_id);
    const foreignThread = threadId && this.sessionId && (this.opts.strictNativeCountFields
      ? threadId.toLowerCase() !== this.sessionId.toLowerCase()
      : threadId !== this.sessionId);
    if (foreignThread) {
      // A record of another thread (copied parent history) is that thread's usage, never ours.
      s.summary.recordsForeignThread++;
      return;
    }
    if (isInheritedTurn(s.turnId, this.sessionId)) s.summary.recordsInReplay++;
    s.hasRecords = true;
    if (this.respIdSet.has(rid)) {
      s.summary.recordDuplicates++;
      return;
    }
    this.respIdSet.add(rid);
    s.summary.records++;
    s.summary.recordTotal += usage.total;
    this.recordFieldStates.set(rid, codexFieldStateEvidence(p.usage,
      'token_usage_record.usage', 'record-reconciled'));
    s.pending.push({ key, responseId: rid, turnId: str(p.turn_id), usage, lineTs });
  }

  private onTokenCount(p: Record<string, unknown>, key: number, lineTs: number | null): void {
    const s = this.state;
    const sum = s.summary;
    const infoValue = p.info;
    if (this.opts.strictNativeCountFields && !isRecordObject(infoValue))
      throw new Error('Codex context checkpoint requires native token_count info');
    const info = infoValue as Record<string, unknown> | null | undefined;
    if (this.opts.strictNativeCountFields && (!completeNativeCountFields(info?.total_token_usage, s.imported === true)
      || !completeNativeCountFields(info?.last_token_usage, s.imported === true)))
      throw new Error('Codex context checkpoint requires coherent native counter fields');
    const turnId = s.turnId;
    const { ts, src } = this.eventTime(lineTs, turnId);

    const lim = limitsFrom(p.rate_limits, this.opts.host, ts);
    if (lim) {
      const id = lim.limitId ?? DEFAULT_CODEX_LIMIT_ID;
      const byId = (s.limitsById ??= {});
      const prevLim = byId[id];
      if (!prevLim || lim.capturedAt >= prevLim.capturedAt) byId[id] = lim;
      if (id === DEFAULT_CODEX_LIMIT_ID && (!s.lastLimits || lim.capturedAt >= s.lastLimits.capturedAt)) s.lastLimits = lim;
    }

    if (!info || typeof info !== 'object') return;
    const tot = readRawUsage(info.total_token_usage);
    const last = readRawUsage(info.last_token_usage);
    if (!tot) return;
    sum.tokenCountEvents++;

    const flags: EventFlag[] = [];
    let contrib: RawUsage;
    let contribTotal: number;
    let derivedFieldState: CodexFieldStateEvidence | undefined;
    let inherited = false;
    if (s.prev === null) {
      // An inherited active turn stays a snapshot even if an earlier own turn produced output.
      sum.firstEventKey = key;
      sum.firstLastBillable = last ? rawBillable(last) : 0;
      sum.firstEventInNewerUuidTurn = uuidV7Ms(turnId) !== null && uuidV7Ms(this.sessionId) !== null && !isInheritedTurn(turnId, this.sessionId);
      const inheritedFirstEvent = isInheritedTurn(turnId, this.sessionId);
      if (!s.ownTurnSeen || inheritedFirstEvent) {
        sum.firstEventBeforeOwnTurn = !s.ownTurnSeen;
        inherited = inheritedFirstEvent;
        contrib = { ...ZERO_RAW };
        contribTotal = 0;
        sum.baselineTotal = tot.total;
        sum.baselineBillable = rawBillable(tot);
      } else {
        sum.firstEventBeforeOwnTurn = false;
        contrib = last ?? { ...tot };
        contribTotal = contrib.total;
        derivedFieldState = codexFieldStateEvidence(
          last ? info.last_token_usage : info.total_token_usage,
          last ? 'token_count.info.last_token_usage' : 'token_count.info.total_token_usage',
          last ? 'first-own-last' : 'first-own-total-fallback',
        );
        sum.baselineTotal = Math.max(0, tot.total - contribTotal);
        sum.baselineBillable = Math.max(0, rawBillable(tot) - rawBillable(contrib));
        if (sum.baselineTotal > 0) {
          const parentId = s.meta?.parentThreadId ?? s.meta?.forkedFromId;
          const known = parentId ? this.opts.parentTotals?.(parentId) : undefined;
          if (known && !known.has(sum.baselineTotal)) {
            sum.inheritedBaselineSuspect = true;
            flags.push('inheritedBaselineSuspect');
          }
        }
      }
    } else if (isInheritedTurn(turnId, this.sessionId)) {
      // Inside a replayed `rollout-N` turn, or a turn older than this thread: these token_counts are verbatim
      // copies of the parent's events (A2000 01a02222: 125/125 replay-region (total,last) pairs occur in parent
      // 01a02131). Inherited history: contribute 0 and re-anchor on the copied totals.
      if (isReplayTurnId(turnId)) sum.replayEvents++;
      else sum.olderTurnEvents++;
      sum.replayExcludedTotal += Math.max(0, tot.total - s.prev.total);
      contrib = { ...ZERO_RAW };
      contribTotal = 0;
      inherited = true;
    } else if (tot.total < s.prev.total) {
      // Counter reset (§15.2.1): count this event's own last_token_usage and re-anchor.
      flags.push('counterReset');
      sum.resets++;
      contrib = last ?? { ...tot };
      contribTotal = contrib.total;
      derivedFieldState = codexFieldStateEvidence(
        last ? info.last_token_usage : info.total_token_usage,
        last ? 'token_count.info.last_token_usage' : 'token_count.info.total_token_usage',
        last ? 'counter-reset-last' : 'counter-reset-total-fallback',
      );
      if (!last || last.total !== tot.total) sum.resetLastMismatch++;
    } else {
      const prev = s.prev;
      const d = (a: number, b: number): number => {
        const x = a - b;
        return x < 0 ? 0 : x;
      };
      if (
        tot.input < prev.input || tot.cached < prev.cached || tot.cacheWrite < prev.cacheWrite ||
        tot.output < prev.output || tot.reasoning < prev.reasoning
      ) {
        sum.fieldDecreases++;
      }
      contrib = {
        input: d(tot.input, prev.input),
        cached: d(tot.cached, prev.cached),
        cacheWrite: d(tot.cacheWrite, prev.cacheWrite),
        output: d(tot.output, prev.output),
        reasoning: d(tot.reasoning, prev.reasoning),
        total: tot.total - prev.total,
      };
      contribTotal = contrib.total;
      derivedFieldState = codexFieldStateEvidence(
        info.total_token_usage,
        'token_count.info.total_token_usage',
        'counter-delta',
        'unassessed',
      );
    }
    // Responses already emitted as trailing records (finalizeTrailingRecords): this counter delta includes them
    // again, so they are taken off what this event emits. `ownTotalDerived` stays the pure counter derivation.
    let emitContrib = contrib;
    if (s.emittedAhead) {
      const a = s.emittedAhead;
      const sub = (x: number, y: number): number => (x - y < 0 ? 0 : x - y);
      if (!inherited) {
        emitContrib = {
          input: sub(contrib.input, a.input),
          cached: sub(contrib.cached, a.cached),
          cacheWrite: sub(contrib.cacheWrite, a.cacheWrite),
          output: sub(contrib.output, a.output),
          reasoning: sub(contrib.reasoning, a.reasoning),
          total: sub(contrib.total, a.total),
        };
      }
      delete s.emittedAhead;
    }
    if (!inherited && contribTotal > 0 && this.insideReplayWrapper()) {
      // §15.10.1: a nested own turn inside a `rollout-N` wrapper is own usage (the wrapper is not the active turn).
      sum.ownInWrapperEvents++;
      sum.ownInWrapperTotal += contribTotal;
    }
    s.prev = tot;
    sum.lastTotal = tot.total;
    sum.ownTotalDerived += contribTotal;
    s.recentTotals.push(tot.total);
    this.runTotals.push(tot.total);
    if (s.recentTotals.length > RECENT_TOTALS_MAX) s.recentTotals.splice(0, s.recentTotals.length - RECENT_TOTALS_MAX);

    const model = str(p.model) ?? str((info as Record<string, unknown>).model) ?? s.model;
    let components: ParsedComponent[];
    let evTs = ts;
    let evSrc = src;
    if (s.pending.length > 0) {
      // Ground truth (§15.2.2): the responses recorded since the previous token_count.
      const pending = s.pending;
      const recSum = pending.reduce<RawUsage>((a, r) => addRaw(a, r.usage), { ...ZERO_RAW });
      if (!sameFields(recSum, emitContrib)) sum.recordMismatches++;
      sum.recordEvents++;
      flags.push('recordReconciled');
      components = pending.map((r) => ({
        model: model ?? 'unknown',
        raw: r.usage,
        ...(r.usage.input > 0 ? { requestInput: r.usage.input } : {}),
        codexFieldStateEvidence: this.pendingRecordEvidence(r, 'record-reconciled'),
      }));
      const t = this.eventTime(lineTs, turnId, pending[0]!.lineTs);
      evTs = t.ts;
      evSrc = t.src;
      s.pending = [];
      for (const record of pending) this.recordFieldStates.delete(record.responseId);
    } else {
      if (s.hasRecords && rawBillable(emitContrib) > 0) sum.recordFreeDeltas++;
      const requestInput = last && last.input > 0 ? last.input : emitContrib.input > 0 ? emitContrib.input : undefined;
      components = [{ model: model ?? 'unknown', raw: emitContrib, ...(requestInput ? { requestInput } : {}),
        ...(derivedFieldState ? { codexFieldStateEvidence: derivedFieldState } : {}) }];
    }

    const billable = components.reduce((a, c) => a + rawBillable(c.raw), 0);
    if (billable === 0) return; // nothing to price (inherited snapshot, repeated totals, synthetic import count)
    if (!model) sum.eventsWithoutModel++;
    for (const c of components) if (c.raw.cacheWrite > 0) sum.nonZeroCacheWrite++;
    if (s.imported) flags.push('importedContext');
    sum.ownBillableEmitted += billable;

    const sid = this.sessionId ?? 'unknown';
    const ev: ParsedUsage = {
      id: `codex:${sid}:${key}`,
      key,
      sessionId: sid,
      ts: evTs,
      tsSource: evSrc,
      model: model ?? 'unknown',
      components,
      flags,
    };
    if (turnId) ev.turnId = turnId;
    if (s.effort) ev.effort = s.effort;
    if (evSrc === 'frozen-line') {
      this.deferred.push(ev); // resolved to the turn's started_at at its task_complete (same parse call)
      return;
    }
    this.usage.push(ev);
    this.mark(key, evTs, 'assistant');
  }
}

// ── streaming line reader ──────────────────────────────────────────────────

export interface LineChunk {
  line: Buffer;
  /** Byte offset just past this line's '\n'. */
  endOffset: number;
}

/**
 * Yields complete ('\n'-terminated) lines from `start` up to `end` (exclusive byte bound, default EOF).
 * A trailing partial line is NOT yielded — it is picked up once the writer finishes it.
 */
export async function* readLines(file: string, start = 0, end?: number, expected?: CodexPrefixWitness['object'], observeBytes?: (chunk: Buffer) => void): AsyncGenerator<LineChunk> {
  if (end !== undefined && end <= start) return;
  const handle = await fs.promises.open(file, 'r');
  try {
  if (expected && !sameCodexObject(expected, codexObjectId(await handle.stat({bigint:true}))))
    throw new Error('Codex opened rollout object differs from discovered file');
  const stream = handle.createReadStream({
    autoClose: false,
    start,
    ...(end !== undefined ? { end: end - 1 } : {}),
    highWaterMark: 1 << 20,
  });
  let parts: Buffer[] = [];
  let partsLen = 0;
  let pos = start; // offset of the first byte in `parts`
  for await (const chunkAny of stream) {
    const chunk = chunkAny as Buffer;
    observeBytes?.(chunk);
    let s = 0;
    let idx: number;
    while ((idx = chunk.indexOf(10, s)) !== -1) {
      let line = parts.length ? Buffer.concat([...parts, chunk.subarray(s, idx)]) : chunk.subarray(s, idx);
      const endOffset = pos + partsLen + (idx - s) + 1;
      if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      yield { line, endOffset };
      pos = endOffset;
      parts = [];
      partsLen = 0;
      s = idx + 1;
    }
    if (s < chunk.length) {
      const rest = chunk.subarray(s);
      parts.push(rest);
      partsLen += rest.length;
    }
  }
  } finally { await handle.close(); }
}

// ── discovery ────────────────────────────────────────────────────────────────

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const NAME_TS_RE = /rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/;

export interface RolloutFile {
  path: string;
  home: string;
  tree: 'sessions' | 'archived';
  /** UUID from the file name (session_meta.payload.id is canonical; mismatch is warned). */
  nameId: string | null;
  sortKey: string;
}

/** $CODEX_HOME (comma list) or ~/.codex, unless config.codex.homes is set. */
export function resolveCodexHomes(configured: string[] | undefined, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
  if (configured && configured.length) return configured;
  const envHome = env.CODEX_HOME;
  if (envHome && envHome.trim()) {
    return envHome.split(',').map((h) => h.trim()).filter(Boolean);
  }
  return [path.join(home, '.codex')];
}

function walk(dir: string, out: string[], depth: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 6) walk(p, out, depth + 1);
    } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
}

/**
 * sessions/**\/rollout-*.jsonl + archived_sessions/*.jsonl across homes, deduped by session id
 * (sessions/ wins over archived_sessions/; earlier homes win over later ones). Sorted oldest-first by the
 * timestamp in the file name so parents are parsed before the subagents they spawn.
 */
export function discoverRollouts(homes: string[]): { files: RolloutFile[]; duplicates: RolloutFile[] } {
  const all: RolloutFile[] = [];
  for (const home of homes) {
    const sess: string[] = [];
    walk(path.join(home, 'sessions'), sess, 0);
    for (const p of sess) all.push(mk(p, home, 'sessions'));
    let arch: fs.Dirent[] = [];
    try {
      arch = fs.readdirSync(path.join(home, 'archived_sessions'), { withFileTypes: true });
    } catch {
      /* none */
    }
    for (const e of arch) {
      if (e.isFile() && e.name.endsWith('.jsonl')) all.push(mk(path.join(home, 'archived_sessions', e.name), home, 'archived'));
    }
  }
  const byId = new Map<string, RolloutFile>();
  const files: RolloutFile[] = [];
  const duplicates: RolloutFile[] = [];
  // Stable priority: home order, then sessions before archived.
  const rank = (f: RolloutFile): number => homes.indexOf(f.home) * 2 + (f.tree === 'sessions' ? 0 : 1);
  const ordered = [...all].sort((a, b) => rank(a) - rank(b));
  for (const f of ordered) {
    if (f.nameId) {
      const seen = byId.get(f.nameId.toLowerCase());
      if (seen) {
        duplicates.push(f);
        continue;
      }
      byId.set(f.nameId.toLowerCase(), f);
    }
    files.push(f);
  }
  files.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return { files, duplicates };

  function mk(p: string, home: string, tree: 'sessions' | 'archived'): RolloutFile {
    const base = path.basename(p);
    const id = UUID_RE.exec(base)?.[1] ?? null;
    const t = NAME_TS_RE.exec(base)?.[1] ?? '9999';
    return { path: p, home, tree, nameId: id, sortKey: `${t}|${base}` };
  }
}

// ── file-level driver (used by the collector and the probe) ─────────────────

export interface ParseFileOptions extends ParserOptions {
  startOffset?: number;
  endOffset?: number;
  expectedObject?: CodexPrefixWitness['object'];
  /** Recovery-only: bind a fresh from-zero parse to its original raw bytes. */
  capturePrefixDigest?: boolean;
  state?: CodexFileState;
  /** Called every `batchSize` usage events (and at the end) with the offset safe to persist. */
  onBatch?: (b: { usage: ParsedUsage[]; marks: ActivityMark[]; offset: number; state: CodexFileState }) => void | Promise<void>;
  batchSize?: number;
  /** The file is idle (writer done): emit own records left without a token_count (see finalizeTrailingRecords). */
  finalizeTrailingRecords?: boolean;
}

export interface ParseFileResult {
  offset: number;
  bytesRead: number;
  state: CodexFileState;
  usage: ParsedUsage[]; // only when onBatch is not given
  marks: ActivityMark[]; // only when onBatch is not given
  /** All token_count total_tokens values parsed in this call (for parent matching). */
  runTotals: number[];
  parsedPrefixDigest?: CodexParsedPrefixDigest;
}

export async function parseRolloutFile(file: string, opts: ParseFileOptions): Promise<ParseFileResult> {
  const start = opts.startOffset ?? 0;
  if (opts.capturePrefixDigest && (start !== 0 || opts.state !== undefined)) throw new Error('Codex prefix digest requires a fresh from-zero parse');
  const prefixDigest = opts.capturePrefixDigest ? new CodexPrefixStreamDigest() : undefined;
  // A held or failed parse must not mutate the caller's last saved checkpoint.
  let state = opts.state ? JSON.parse(JSON.stringify(opts.state)) as CodexFileState : undefined;
  let historyBytesRead = 0;
  const recoverIdentity = state && isFileState(state) && !hasExactResponseIdHistory(state);
  const recoverTurnTimes = state && isFileState(state) && state.meta?.isSubagent === true
    && state.inFileTurnTimesS === undefined && start > 0;
  if (state && (recoverIdentity || recoverTurnTimes)) {
    // Restore only identity and verified in-file turn clocks from the consumed prefix.
    // Never replay events, pricing, activity, offsets or legacy diagnostics into the store.
    const history = new CodexRolloutParser(undefined, {
      host: opts.host,
      ...(opts.fallbackSessionId ? { fallbackSessionId: opts.fallbackSessionId } : {}),
    });
    let consumed = 0;
    let lines = 0;
    for await (const { line, endOffset } of readLines(file, 0, start, opts.expectedObject)) {
      history.pushLine(line);
      history.releaseDeferred({ identityOnly: true });
      history.takeUsage();
      history.takeMarks();
      consumed = endOffset;
      if (++lines % 500 === 0) await yieldToEventLoop();
    }
    if (start <= 0 || consumed !== start) {
      throw new Error('Codex response history recovery requires a complete readable consumed prefix');
    }
    const prefix = history.snapshotState();
    if (state.sessionId && prefix.sessionId?.toLowerCase() !== state.sessionId.toLowerCase()) {
      throw new Error('Codex consumed prefix does not match the saved session identity');
    }
    const recovered = prefix.responseIds;
    const known = new Set(recovered);
    if (!state.responseIds.every(id => known.has(id))) {
      throw new Error('Codex response history recovery does not match the retained response IDs');
    }
    state = { ...JSON.parse(JSON.stringify(state)) as CodexFileState,
      ...(recoverIdentity ? { responseIds: recovered, responseIdsComplete: true, responseIdHistoryRecoveredAtOffset: start } : {}),
      ...(recoverTurnTimes ? { inFileTurnTimesS: prefix.inFileTurnTimesS ?? {} } : {}) };
    historyBytesRead = consumed;
  }
  const parser = new CodexRolloutParser(state, opts);
  const batchSize = opts.batchSize ?? 2000;
  let offset = start;
  const allUsage: ParsedUsage[] = [];
  const allMarks: ActivityMark[] = [];
  const flush = async (): Promise<void> => {
    parser.releaseDeferred();
    const usage = parser.takeUsage();
    const marks = parser.takeMarks();
    if (opts.onBatch) await opts.onBatch({ usage, marks, offset, state: parser.snapshotState() });
    else {
      for (const u of usage) allUsage.push(u);
      for (const m of marks) allMarks.push(m);
    }
  };
  for await (const { line, endOffset } of readLines(file, start, opts.endOffset, opts.expectedObject, prefixDigest ? chunk => prefixDigest.push(chunk) : undefined)) {
    measure('codex.push_line', () => parser.pushLine(line));
    offset = endOffset;
    // Read ahead to task timing before committing; never discard deferred usage at a batch boundary.
    if (opts.onBatch && parser.bufferedUsage >= batchSize && parser.unresolvedTimestampUsage === 0) await flush();
  }
  if (opts.finalizeTrailingRecords) parser.finalizeTrailingRecords();
  await flush();
  return {
    offset,
    bytesRead: offset - start + historyBytesRead,
    state: parser.snapshotState(),
    usage: allUsage,
    marks: allMarks,
    runTotals: parser.runTotals,
    ...(prefixDigest ? {parsedPrefixDigest:prefixDigest.snapshot()} : {}),
  };
}

// ── UsageEvent construction ────────────────────────────────────────────────

function sumTokens(cs: UsageComponent[]): TokenCounts {
  const t: TokenCounts = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
  for (const c of cs) {
    t.inputFresh += c.tokens.inputFresh;
    t.cacheWrite5m += c.tokens.cacheWrite5m;
    t.cacheWrite1h += c.tokens.cacheWrite1h;
    t.cacheRead += c.tokens.cacheRead;
    t.output += c.tokens.output;
    t.reasoning += c.tokens.reasoning;
  }
  return t;
}

/**
 * Codex thinking detection (founder req. 2026-09-27). Evidence: no real Codex rollouts exist on
 * this Mac (M4a has no codex CLI on PATH — DESIGN §15.3.1/spikes-2026-09-26.md; confirmed empty
 * ~/.codex/sessions this session) and no fixture or real sample anywhere in this repo carries
 * effort 'none' or 'minimal' — every real/fixture effort value observed is 'low'/'medium'/'ultra'/
 * 'xhigh' (test/fixtures/codex/*.jsonl), all of which produce `thinking:true` below regardless of
 * reasoning_output_tokens. The 'none'/'minimal' → false branch therefore implements the founder's
 * literal spec ("reasoning models always reason... false only if effort is 'none'/'minimal' AND
 * reasoning tokens are 0") but is UNVERIFIED against a real 'minimal'/'none' rollout — flagged here
 * and in the delivery report, not silently assumed correct.
 *   true  — reasoningTokens > 0, OR effort is set to anything other than 'none'/'minimal'.
 *   false — effort is exactly 'none' or 'minimal' AND reasoningTokens === 0.
 *   null  — effort was never recorded (no turn_context/thread_settings_applied ever set it) AND
 *           reasoningTokens === 0: Codex has no separate "reasoning disabled" signal absent effort.
 */
export function detectCodexThinking(effort: string | undefined, reasoningTokens: number): boolean | null {
  if (reasoningTokens > 0) return true;
  if (effort === 'none' || effort === 'minimal') return false;
  if (effort !== undefined) return true;
  return null;
}

export function toUsageEvent(
  u: ParsedUsage,
  meta: CodexSessionMeta | undefined,
  ctx: Pick<IngestContext, 'host' | 'pricing' | 'computeUnits'>
): UsageEvent {
  const flags = new Set<EventFlag>(u.flags);
  const components: UsageComponent[] = u.components.map((c) => {
    const { tokens, reasoningClamped } = toTokenCounts(c.raw);
    if (reasoningClamped) flags.add('reasoningClamped');
    const comp: UsageComponent = { model: c.model, tokens };
    if (c.requestInput !== undefined) comp.requestInput = c.requestInput;
    if (c.codexFieldStateEvidence) comp.codexFieldStateEvidence = c.codexFieldStateEvidence;
    return comp;
  });
  const tokens = sumTokens(components);
  const thinking = detectCodexThinking(u.effort, tokens.reasoning);
  if (thinking === null) flags.add('thinkingUnknown');
  const price = ctx.pricing.priceEvent({ components });
  for (const f of price.flags) flags.add(f);
  const valuation = ctx.computeUnits.ucuForEvent({ components, thinking, ...(u.effort ? { effort: u.effort } : {}) });
  const ev: UsageEvent = {
    id: u.id,
    host: ctx.host,
    source: 'codex',
    ts: u.ts,
    tsSource: u.tsSource,
    sessionId: u.sessionId,
    isSubagent: meta?.isSubagent ?? false,
    model: u.model,
    provider: ctx.pricing.providerOf(u.model),
    components,
    tokens,
    thinking,
    flags: [...flags],
    apiEquivUsd: price.usd,
    priceStatus: price.status,
    priceVersion: ctx.pricing.version,
    reservedValue: valuation.reservedValue,
    ucuRateStatus: valuation.status,
    eacsDefSha256: ctx.computeUnits.defSha256,
  };
  const parent = meta?.parentThreadId ?? meta?.forkedFromId;
  if (parent) ev.parentSessionId = parent;
  if (meta?.cwd) ev.project = meta.cwd;
  if (meta?.gitBranch) ev.gitBranch = meta.gitBranch;
  if (meta?.originator) ev.entrypoint = meta.originator;
  if (u.effort) ev.effort = u.effort;
  return ev;
}

// ── the collector ────────────────────────────────────────────────────────────

/**
 * stat with an ino that is always a safe integer: node's number ino is lossy above 2^53 and node:sqlite refuses
 * to read such an INTEGER back (RangeError, seen on A2000). Reduce the exact bigint id modulo 2^53 − 1 — still a
 * stable identity for "was this file replaced", which is all the ino is used for.
 */
function codexStatFields(b: fs.BigIntStats): { size: number; mtimeMs: number; ino: number; object: CodexPrefixWitness['object'] } {
  return { size: Number(b.size), mtimeMs: Number(b.mtimeMs), ino: safeIno(b.ino), object: codexObjectId(b) };
}

export function statFile(p: string): ReturnType<typeof codexStatFields> {
  return codexStatFields(fs.statSync(p, { bigint: true }));
}

/** Await filesystem metadata without occupying the daemon event loop; file identity and cursor checks remain unchanged. */
export async function statFileAsync(p: string): Promise<ReturnType<typeof codexStatFields>> {
  const b = await fs.promises.stat(p, { bigint: true });
  return measure('codex.stat_fields', () => codexStatFields(b));
}

/** Shared with every collector (collectors/fswalk.ts#safeIno): `Number(ino % (2^53 − 1))`. */
export function safeIno(ino: bigint): number {
  return fsSafeIno(ino);
}

export interface CodexCollectorOptions {
  /** Override homes (tests); otherwise config.codex.homes → $CODEX_HOME → ~/.codex. */
  homes?: string[];
  env?: NodeJS.ProcessEnv;
  batchSize?: number;
  /** A file untouched for this long is finished: its trailing own records are emitted (default 1 h). */
  trailingRecordIdleMs?: number;
  /** Clock (tests). */
  now?: () => number;
  /** Elapsed-time budget between yields in the file loop (default YIELD_BUDGET_MS). */
  yieldBudgetMs?: number;
  /** Monotonic clock for the yield budget (default performance.now). Tests inject a deterministic clock. */
  monotonicNow?: () => number;
}

export const TRAILING_RECORD_IDLE_MS = 60 * 60 * 1000;

/** A changed object with no owned work can retain a new context checkpoint only
 * through the store's accounting guard, CAS and append-only prior-row receipt.
 * This inspection never publishes events, activity, limits or parent totals. */
type PreparedContextCheckpoint = CodexContextCheckpointRecoveryCandidate & { bytesRead: number };

async function recoverReplacedContext(
  ctx: IngestContext, file: RolloutFile, prior: IngestState,
  found: ReturnType<typeof statFile>, turns: ParserOptions['turns'],
): Promise<PreparedContextCheckpoint | undefined> {
  if (typeof ctx.store.recoverCodexContextCheckpoints !== 'function' || !file.nameId || prior.key !== file.path
    || !isUnownedCodexContextState(prior.extra,file.nameId)) return undefined;
  const old = prior.extra as CodexFileState;
  if (old.meta?.id !== file.nameId || !isCodexPrefixWitness(old.consumedPrefix)
    || old.consumedPrefix.bytes !== prior.offset || prior.offset <= 0) return undefined;
  const before = await fs.promises.stat(file.path,{bigint:true});
  const object = codexObjectId(before);
  if (!sameCodexObject(found.object,object) || Number(before.size) !== found.size) return undefined;
  const unchanged = (stat: fs.BigIntStats): boolean => sameCodexObject(object,codexObjectId(stat))
    && stat.size === before.size && stat.mtimeNs === before.mtimeNs;
  const parsed = await parseRolloutFile(file.path,{
    host:ctx.host, fallbackSessionId:file.nameId, endOffset:Number(before.size), expectedObject:object,
    ...(turns ? {turns} : {}), strictNativeCountFields:true, capturePrefixDigest:true, finalizeTrailingRecords:false,
    onWarning:()=>{throw new Error('Codex context checkpoint source warning');},
    onBatch:batch=>{
      if (batch.usage.length || batch.marks.length) throw new Error('Codex replacement contains owned work or activity');
    },
  });
  if (parsed.offset !== Number(before.size) || parsed.state.meta?.id !== file.nameId
    || !isUnownedCodexContextState(parsed.state,file.nameId)
    || !unchanged(await fs.promises.stat(file.path,{bigint:true}))) return undefined;
  const witness = await codexPrefixWitness(file.path,parsed.offset,undefined,false,object);
  if (!parsed.parsedPrefixDigest || !sameCodexPrefixContent(parsed.parsedPrefixDigest,witness)
    || !unchanged(await fs.promises.stat(file.path,{bigint:true}))) return undefined;
  const next: IngestState = {key:prior.key,size:Number(before.size),mtimeMs:Number(before.mtimeMs),
    offset:parsed.offset,ino:safeIno(before.ino),extra:{...parsed.state,consumedPrefix:witness}};
  return {prior,next,claim:{host:ctx.host,sessionId:file.nameId},bytesRead:parsed.bytesRead+witness.readBytes};
}

export class CodexCollector implements Collector {
  readonly name = 'codex';

  constructor(private readonly options: CodexCollectorOptions = {}) {}

  async scan(ctx: IngestContext): Promise<IngestStats> {
    const t0 = Date.now();
    const stats: IngestStats = {
      collector: this.name,
      filesScanned: 0,
      filesSkipped: 0,
      eventsEmitted: 0,
      bytesRead: 0,
      warnings: [],
      durationMs: 0,
      codexCursorCoverageAtStat: emptyCodexCursorCoverageAtStat(),
    };
    const warn = (msg: string): void => {
      if (stats.warnings.length < 100) stats.warnings.push(msg);
      ctx.log('warn', msg);
    };
    const contextCheckpoints: PreparedContextCheckpoint[] = [];
    const homes = this.options.homes ?? resolveCodexHomes(ctx.config.codex?.homes, this.options.env ?? process.env);
    const { files, duplicates } = measure('codex.discover', () => discoverRollouts(homes));
    const duplicateParentIds = new Set(duplicates.flatMap(file => file.nameId ? [file.nameId.toLowerCase()] : []));
    for (const d of duplicates) {
      ctx.store.recordSkipped(d.path, 'other');
      stats.filesSkipped++;
    }

    const dbs = new Map<string, CodexSqlite>();
    const dbFor = (home: string): CodexSqlite => {
      let db = dbs.get(home);
      if (!db) {
        db = CodexSqlite.open(home, ctx.log);
        dbs.set(home, db);
      }
      return db;
    };
    // token_count totals per session seen this run (+ persisted recent totals) for the suspect check.
    const totalsBySession = new Map<string, Set<number>>();
    const completeTotalsBySession = new Set<string>();
    const addTotals = (sid: string | undefined, totals: Iterable<number>, complete = false): void => {
      if (!sid) return;
      let set = totalsBySession.get(sid);
      if (!set) totalsBySession.set(sid, (set = new Set()));
      for (const t of totals) set.add(t);
      if (complete) completeTotalsBySession.add(sid);
      else completeTotalsBySession.delete(sid);
    };
    // Newest snapshot per limit id across all files (each id recorded separately, §15.9.5).
    const newestLimits = new Map<string, LimitSnapshot>();
    let archiveKeys: Map<string,string[]> | undefined;
    const archiveCandidates = (sessionId: string, exceptKey: string): IngestState[] => {
      if (!ctx.store.codexStateKeys) return ctx.store.codexStateCandidates?.(sessionId,exceptKey) ?? [];
      if (!archiveKeys) {
        archiveKeys = new Map();
        for (const key of ctx.store.codexStateKeys()) {
          const id = UUID_RE.exec(key)?.[1]?.toLowerCase();
          if (!id) continue;
          const group = archiveKeys.get(id) ?? []; group.push(key); archiveKeys.set(id,group);
        }
      }
      return (archiveKeys.get(sessionId.toLowerCase()) ?? []).filter(key=>key!==exceptKey)
        .flatMap(key=>{const state=ctx.store.getState(key);return state?[state]:[];}).sort((a,b)=>b.offset-a.offset);
    };

    try {
      // File metadata is awaited off the main thread; state reads and JSON conversion remain synchronous. Yield on
      // elapsed time and file count (see YieldPacer). Pause the synchronous profiler segment around every awaited
      // metadata read, prefix witness, parser and yield; stat_io intervals describe wait time, never CPU ownership.
      const pacer = new YieldPacer(this.options.yieldBudgetMs ?? YIELD_BUDGET_MS, FILES_PER_YIELD, this.options.monotonicNow ?? (() => performance.now()));
      const fileSync = new SyncSegment('codex.file_sync');
      for (const f of files) {
        stats.codexCursorCoverageAtStat!.filesDiscovered++;
        if (pacer.due()) {
          await awaitOutside(fileSync, yieldToEventLoop);
          pacer.yielded();
        }
        let st: ReturnType<typeof statFile>;
        try {
          const metadataWait = intervalBegin('codex.stat_io');
        try { st = await awaitOutside(fileSync, () => statFileAsync(f.path)); }
        finally { intervalEnd(metadataWait); }
        } catch {
          recordCodexCursorAtStat(stats.codexCursorCoverageAtStat!, null, null);
          ctx.store.recordSkipped(f.path, 'unreadable');
          stats.filesSkipped++;
          continue;
        }
        let prior: IngestState | undefined;
        let stateReadFailed = false;
        try {
          prior = measure('codex.get_state', () => ctx.store.getState(f.path));
        } catch (err) {
          // unreadable state row → re-read the file from 0 (event ids are stable, upserts idempotent)
          stateReadFailed = true;
          warn(`codex: ingest state unreadable for ${f.path}: ${String(err)}`);
        }
        let priorExtra = prior && isFileState(prior.extra) ? prior.extra : undefined;
        if (!prior && f.nameId && (ctx.store.codexStateKeys || ctx.store.codexStateCandidates) && ctx.store.relocateState) {
          try {
            let unverifiedCheckpoint = false;
            for (const donor of archiveCandidates(f.nameId, f.path)) {
              if (!isFileState(donor.extra) || donor.extra.sessionId?.toLowerCase() !== f.nameId.toLowerCase() || donor.offset <= 0) continue;
              if (donor.offset > st.size || !isCodexPrefixWitness(donor.extra.consumedPrefix)
                || donor.extra.consumedPrefix.bytes !== donor.offset) {unverifiedCheckpoint = true; continue;}
              let verified: CodexPrefixWitness;
              const savedWitness = donor.extra.consumedPrefix;
              try { verified = await awaitOutside(fileSync, () => codexPrefixWitness(f.path, donor.offset, savedWitness, true, st.object)); }
              catch { unverifiedCheckpoint = true; continue; }
              stats.bytesRead += verified.readBytes;
              const extra = {...donor.extra, consumedPrefix:verified,
                previousSourceKeys:[...new Set([...(donor.extra.previousSourceKeys ?? []), donor.key])]};
              const moved = {...donor,key:f.path,mtimeMs:0,ino:st.ino,extra};
              if (!ctx.store.relocateState(donor,moved)) throw new Error('Codex archive cursor changed during relocation');
              prior = moved; priorExtra = extra; break;
            }
            if (!prior && unverifiedCheckpoint) throw new Error('Codex archive consumed prefix is unverified; automatic replay held');
          } catch (error) {
            warn(`codex: archive checkpoint unavailable for ${f.path}: ${String(error)}`);
            stats.codexCursorCoverageAtStat!.filesWithCursorStateError++;
            ctx.store.recordSkipped(f.path,'checkpoint-unverified'); stats.filesSkipped++; continue;
          }
        }
        const savedPrefix = priorExtra?.consumedPrefix;
        const replaced = prior && priorExtra && (isCodexPrefixWitness(savedPrefix)
          ? !sameCodexObject(savedPrefix.object, st.object)
          : prior.ino !== 0 && st.ino !== 0 && prior.ino !== st.ino);
        if (replaced && prior && priorExtra) {
          try {
            if (!isCodexPrefixWitness(savedPrefix) || savedPrefix.bytes !== prior.offset || st.size < prior.offset)
              throw new Error('replacement has no verifiable consumed prefix');
            const verified = await awaitOutside(fileSync, () => codexPrefixWitness(f.path, prior!.offset, savedPrefix, true, st.object));
            stats.bytesRead += verified.readBytes;
            priorExtra = {...priorExtra,consumedPrefix:verified};
            prior = {...prior,ino:st.ino,mtimeMs:0,extra:priorExtra};
          } catch (error) {
            // Prefix-match resume remains the default. Only a strictly unowned
            // same-key replacement can use this separately receipted recovery.
            try {
              // Inspect outside the writer lock, then guard the whole bounded group once per basis.
              const prepared = contextCheckpoints.length < 256
                ? await awaitOutside(fileSync, () => recoverReplacedContext(ctx,f,prior!,st,
                  id=>dbFor(f.home).turnsFor(id))) : undefined;
              if (prepared) {
                contextCheckpoints.push(prepared);
                stats.bytesRead += prepared.bytesRead;
                stats.codexCursorCoverageAtStat!.filesWithCursorStateError++;
                continue;
              }
            } catch { /* Preserve the original checkpoint and ordinary held disclosure. */ }
            warn(`codex: replacement checkpoint unavailable for ${f.path}: ${String(error)}; automatic replay held`);
            stats.codexCursorCoverageAtStat!.filesWithCursorStateError++;
            ctx.store.recordSkipped(f.path,'checkpoint-unverified');stats.filesSkipped++;continue;
          }
        }
        const inoChanged = prior?.ino !== undefined && prior.ino !== 0 && st.ino !== 0 && prior.ino !== st.ino;
        const resume = prior && priorExtra && !inoChanged && st.size >= prior.offset;
        const startOffset = resume ? prior!.offset : 0;
        const priorTotalsPrefixComplete = !!(resume && priorExtra && hasExactRecentTotals(priorExtra));
        const priorTotalsCoverCurrentFile = priorTotalsPrefixComplete && prior!.offset === st.size;
        if (resume && priorExtra) {
          addTotals(priorExtra.sessionId, Array.isArray(priorExtra.recentTotals) ? priorExtra.recentTotals : [], priorTotalsCoverCurrentFile);
        }
        recordCodexCursorAtStat(stats.codexCursorCoverageAtStat!, st.size, resume ? startOffset : null, stateReadFailed ? 'failed' : 'ok');
        const idle = (this.options.now ?? Date.now)() - st.mtimeMs >= (this.options.trailingRecordIdleMs ?? TRAILING_RECORD_IDLE_MS);
        if (prior && priorExtra && prior.size === st.size && prior.mtimeMs === st.mtimeMs && prior.offset <= st.size) {
          // unchanged since last ingest — unless it has since gone idle with own records still pending
          if (!(idle && priorExtra.pending.length > 0)) {
            // Adopt a content witness at the current clock for an unchanged legacy
            // cursor. This does not prove or rewrite historical event accounting.
            if (!isCodexPrefixWitness(priorExtra.consumedPrefix) || priorExtra.consumedPrefix.bytes !== prior.offset) {
              try {
                const witness = await awaitOutside(fileSync, () => codexPrefixWitness(f.path,prior!.offset,undefined,false,st.object));
                stats.bytesRead += witness.readBytes;
                ctx.store.setState({...prior,extra:{...priorExtra,consumedPrefix:witness}});
              } catch (error) { warn(`codex: prefix checkpoint unavailable for ${f.path}: ${String(error)}`); }
            }
            continue;
          }
        }
        if (prior && !resume) warn(`codex: re-reading ${f.path} from 0 (truncated, replaced or state version changed)`);
        const db = dbFor(f.home);
        let meta: CodexSessionMeta | undefined = resume ? priorExtra!.meta : undefined;
        const perFileWarn = (m: string): void => warn(`${m} (${f.path})`);

        stats.filesScanned++;
        let lastState: CodexFileState | undefined;
        let parentTotalsComplete = false;
        let witness = resume && isCodexPrefixWitness(priorExtra?.consumedPrefix) ? priorExtra!.consumedPrefix : undefined;
        try {
          const res = await awaitOutside(fileSync, () => parseRolloutFile(f.path, {
            host: ctx.host,
            startOffset,
            endOffset: st.size,
            expectedObject: st.object,
            ...(resume ? { state: priorExtra! } : {}),
            ...(f.nameId ? { fallbackSessionId: f.nameId } : {}),
            turns: (tid) => (db.hasTurns ? db.turnsFor(tid) : undefined),
            parentTotals: (pid) => !duplicateParentIds.has(pid.toLowerCase()) && completeTotalsBySession.has(pid)
              ? totalsBySession.get(pid) : undefined,
            onWarning: perFileWarn,
            finalizeTrailingRecords: idle,
            batchSize: this.options.batchSize ?? 2000,
            onBatch: async ({ usage, marks, offset, state }) => {
              witness = await codexPrefixWitness(f.path, offset, witness, false, st.object);
              stats.bytesRead += witness.readBytes;
              state.consumedPrefix = witness;
              meta = state.meta ?? meta;
              const events = measure('codex.to_usage_event', () => usage.map((u) => toUsageEvent(u, meta, ctx)));
              const done = offset >= st.size;
              // Reentrant ledger transactions use SAVEPOINTs. Commit the exact
              // grouping, activity, prefix witness and cursor atomically.
              ctx.store.transaction(() => {
                if (events.length) measure('codex.upsert_events', () => ctx.store.upsertEvents(events));
                if (marks.length) measure('codex.record_activity', () => ctx.store.recordActivity(marks));
                ctx.store.setState({
                key: f.path,
                // Only a fully-read file records the stat'd size/mtime (else the next scan would skip it).
                size: done ? st.size : offset,
                mtimeMs: done ? st.mtimeMs : 0,
                offset,
                ino: st.ino,
                extra: state,
                } satisfies IngestState);
              });
              stats.eventsEmitted += events.length;
              lastState = state;
            },
          }));
          stats.bytesRead += res.bytesRead;
          lastState = res.state;
          parentTotalsComplete = res.offset === st.size
            && (startOffset === 0 || priorTotalsPrefixComplete)
            && (!f.nameId || res.state.sessionId?.toLowerCase() === f.nameId.toLowerCase());
          addTotals(res.state.sessionId, res.runTotals, parentTotalsComplete);
          // Final state (covers a trailing partial line: offset < size but the stat'd size/mtime are kept
          // so an unchanged file is not re-read; any append changes size/mtime and resumes at `offset`).
          if (witness) res.state.consumedPrefix = witness;
          ctx.store.setState({ key: f.path, size: st.size, mtimeMs: st.mtimeMs, offset: res.offset, ino: st.ino, extra: res.state });
        } catch (err) {
          warn(`codex: failed reading ${f.path}: ${String(err)}`);
          ctx.store.recordSkipped(f.path, err instanceof CodexTimestampUnavailableError ? 'timestamp-unavailable' : 'unreadable');
          stats.filesSkipped++;
          continue;
        }
        if (lastState) {
          if (f.nameId && lastState.sessionId && lastState.sessionId.toLowerCase() !== f.nameId.toLowerCase()) {
            warn(`codex: session_meta id ${lastState.sessionId} ≠ file-name id ${f.nameId} (${f.path})`);
          }
          addTotals(lastState.sessionId, lastState.recentTotals, parentTotalsComplete);
          const fileLimits = lastState.limitsById
            ? Object.values(lastState.limitsById)
            : lastState.lastLimits
              ? [lastState.lastLimits]
              : [];
          for (const lim of fileLimits) {
            const id = lim.limitId ?? DEFAULT_CODEX_LIMIT_ID;
            const cur = newestLimits.get(id);
            if (!cur || lim.capturedAt > cur.capturedAt) newestLimits.set(id, { ...lim, limitId: id });
          }
          const sm = lastState.summary;
          if (sm.resets || sm.inheritedBaselineSuspect || sm.recordMismatches || sm.nonZeroCacheWrite) {
            ctx.log('info', 'codex: file anomalies', {
              path: f.path,
              resets: sm.resets,
              suspect: sm.inheritedBaselineSuspect,
              recordMismatches: sm.recordMismatches,
              nonZeroCacheWrite: sm.nonZeroCacheWrite,
            });
          }
          if (sm.nonZeroCacheWrite) warn(`codex: non-zero cache_write_input_tokens seen (${f.path}) — subset assumption (§15.2.8) needs review`);
        }
      }
      if (contextCheckpoints.length) {
        let outcomes = contextCheckpoints.map(() => false);
        try {
          outcomes = measure('codex.context_checkpoint_batch', () => ctx.store.transaction(() => {
            const result = ctx.store.recoverCodexContextCheckpoints!(contextCheckpoints);
            if (!Array.isArray(result) || result.length !== contextCheckpoints.length)
              throw new Error('invalid Codex checkpoint batch outcomes');
            for (let index = 0; index < contextCheckpoints.length; index++) {
              if (!Object.hasOwn(result,index) || typeof result[index] !== 'boolean')
                throw new Error('invalid Codex checkpoint batch outcomes');
            }
            return result;
          }));
        } catch (error) {
          warn(`codex: context checkpoint batch unavailable; recovery held: ${String(error)}`);
        }
        for (let index = 0; index < contextCheckpoints.length; index++) {
          if (outcomes[index]) {
            ctx.log('info','codex: context-only checkpoint recovered without accounting writes');
          } else {
            const key = contextCheckpoints[index]!.prior.key;
            warn(`codex: replacement checkpoint unavailable for ${key}; automatic replay held`);
            ctx.store.recordSkipped(key,'checkpoint-unverified');stats.filesSkipped++;
          }
        }
      }
      fileSync.close();
      for (const lim of newestLimits.values()) ctx.store.recordLimits(lim);
    } finally {
      for (const db of dbs.values()) db.close();
    }
    stats.durationMs = Date.now() - t0;
    return stats;
  }
}
