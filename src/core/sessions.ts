/**
 * Sessions, timers and burn rate (DESIGN §6, §15.7.1). Builds `SessionRow[]` (core/types.ts) from
 * raw `ActivityMark[]` + `UsageEvent[]`.
 *
 * Grouping key: `(host, source, sessionId)` — EXCEPT subagent events/marks, which are rolled up
 * into their parent's row (Claude subagents carry their own `sessionId` but `isSubagent:true` +
 * `parentSessionId` pointing at the owning session; DESIGN §6 "subagent count" is a property of
 * the *parent* session's row, not a standalone row of its own). `buildParentMap` derives
 * sessionId → parentSessionId purely from `UsageEvent.isSubagent`/`parentSessionId`, and
 * SessionHierarchy folds every recorded generation into its root within a host/collector. A session that
 * has no recorded parent is simply its own group. Cyclic links remain unfolded.
 */
import type { ActivityMark, ActivityTimeEvidence, HostLabel, Source, SessionRow, SessionTelemetryFeed, TokenCounts, UsageEvent } from './types.js';
import { ZERO_TOKENS } from './types.js';
import { addTokenCounts } from './token-counts.js';
import { priceFieldsOf, priceQualityOf, type PriceQuality } from './price-quality.js';
import { drainSteps, drainStepsYielding, type StepPacing } from './event-loop.js';
import { SessionHierarchy } from './session-hierarchy.js';

// ── subagent → parent folding ──────────────────────────────────────────────

/** sessionId → parentSessionId, derived purely from events (never from activity marks, which
 * carry no parent link). Only subagent sessionIds that actually appear with `isSubagent:true`
 * and a `parentSessionId` are mapped; a session with no such event is its own root. */
export function buildParentMap(events: readonly Pick<UsageEvent, 'sessionId' | 'parentSessionId' | 'isSubagent'>[]): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const e of events) {
    if (e.isSubagent && e.parentSessionId && e.parentSessionId !== e.sessionId) {
      parentOf.set(e.sessionId, e.parentSessionId);
    }
  }
  return parentOf;
}

/** Legacy direct-parent lookup. Session and Summary grouping use SessionHierarchy to include
 * nested branches and keep host/collector namespaces separate. */
export function effectiveSessionId(sessionId: string, parentOf: ReadonlyMap<string, string>): string {
  return parentOf.get(sessionId) ?? sessionId;
}

/** Grouping key for a session row: host + source + effective (parent-folded) sessionId. Source is
 * part of the key because Claude/Codex sessionIds are both opaque strings with no shared
 * namespace guarantee. */
export function sessionGroupKey(host: HostLabel, source: Source, sessionId: string): string {
  return `${host}\u0000${source}\u0000${sessionId}`;
}

// ── activity-mark dedup ─────────────────────────────────────────────────────

/**
 * Drops duplicate activity marks that share the same line `uuid` (DESIGN §15.7.1: "Activity
 * timestamps deduped globally by line uuid (earliest session owns a copied message)"). A resumed
 * or forked Claude session can carry forward earlier lines verbatim (same uuid, same ts) into a
 * new file/session; without this, that session's active-time and start/end would double-count
 * time that already belongs to the session the line was first written into.
 *
 * Marks without a `uuid` (proxy/bench marks, or any collector that doesn't have a stable line id)
 * are never deduped against each other here — there is nothing to dedup them BY.
 *
 * Tie-break for two marks sharing a uuid at the identical `ts` (should not happen in practice,
 * but deterministic either way): the first one encountered in `marks` wins, so the result depends
 * only on input order, never on Map iteration order.
 */
export function dedupeActivityMarks(marks: readonly ActivityMark[]): ActivityMark[] {
  return drainSteps(dedupeActivityMarkSteps(marks));
}

/**
 * Row-count bound: at most this many events or marks between two yield points while grouping. It bounds the count of items
 * per step, not the time of a step. Item costs vary (a row with a large payload costs more), and a session group is always
 * one step whatever its size, so one very large session can still run longer than this count of items suggests.
 */
export const SESSION_STEP_ITEMS = 2000;

/** The dedup as steps (same Map semantics and output order as dedupeActivityMarks). */
export function* dedupeActivityMarkSteps(marks: readonly ActivityMark[]): Generator<void, ActivityMark[], void> {
  const earliestByUuid = new Map<string, ActivityMark>();
  const withoutUuid: ActivityMark[] = [];
  let n = 0;
  for (const mark of marks) {
    if (++n % SESSION_STEP_ITEMS === 0) yield;
    if (!mark.uuid) {
      withoutUuid.push(mark);
      continue;
    }
    const existing = earliestByUuid.get(mark.uuid);
    if (!existing || mark.ts < existing.ts) {
      earliestByUuid.set(mark.uuid, mark);
    }
  }
  return [...withoutUuid, ...earliestByUuid.values()];
}

// ── active time ──────────────────────────────────────────────────────────

/**
 * Active time for one session's (deduped, sorted-by-ts) marks: Σ gaps between consecutive
 * timestamps that are ≤ `idleGapMs` (DESIGN §6/§15.7.1 default). For Codex sessions where at least
 * one mark carries a `durationMs` (from `thread_turns.duration_ms`, DESIGN §4.2/§15.2.5 — exact
 * per-turn active time), that is authoritative and used INSTEAD of the gap-sum: Σ of every mark's
 * own `durationMs` (marks with no durationMs in that same session contribute 0, since they are
 * typically non-turn line marks alongside turn marks that DO carry it).
 */
export function activityTimeEvidence(source: Source, sortedMarks: readonly ActivityMark[], idleGapMs: number): ActivityTimeEvidence {
  let durationMarkCount = 0;
  if (source === 'codex') {
    for (const mark of sortedMarks) if (typeof mark.durationMs === 'number' && mark.durationMs > 0) durationMarkCount++;
  }
  return {
    version: 1,
    basis: sortedMarks.length === 0 ? 'no-marks' : durationMarkCount > 0 ? 'reported-turn-durations' : 'activity-gaps',
    markCount: sortedMarks.length,
    durationMarkCount,
    idleGapMs,
  };
}

export function computeActiveMs(
  source: Source,
  sortedMarks: readonly ActivityMark[],
  idleGapMs: number
): number {
  if (sortedMarks.length === 0) return 0;

  if (source === 'codex') {
    const withDuration = sortedMarks.filter((m) => typeof m.durationMs === 'number' && m.durationMs > 0);
    if (withDuration.length > 0) {
      return withDuration.reduce((sum, m) => sum + (m.durationMs ?? 0), 0);
    }
  }

  let active = 0;
  for (let i = 1; i < sortedMarks.length; i++) {
    const gap = sortedMarks[i].ts - sortedMarks[i - 1].ts;
    if (gap > 0 && gap <= idleGapMs) active += gap;
  }
  return active;
}

// ── burn rate ────────────────────────────────────────────────────────────

const BURN_WINDOW_MS = 15 * 60 * 1000;

function sumTokens(events: readonly UsageEvent[]): number {
  return events.reduce(
    (sum, e) =>
      sum +
      e.tokens.inputFresh +
      e.tokens.cacheWrite5m +
      e.tokens.cacheWrite1h +
      (e.tokens.cacheWriteUnassigned ?? 0) +
      e.tokens.cacheRead +
      e.tokens.output,
    0
  );
}

/**
 * Burn rate over the trailing `windowMs` (default 15 min, DESIGN §6 "burn over last 15 min"):
 * total tokens (all fields, not just fresh input + cache creation + output — this is a throughput display)
 * and total API-equivalent $ accrued by events with `ts` in `(now - windowMs, now]`, expressed as
 * a rate over the FIXED window (never the actual elapsed time within it) — so a session that only
 * just started 2 minutes ago still reports a correct tokens/min average for that window rather
 * than an inflated one from dividing by 2 minutes instead of 15. Returns `null` when no event in
 * the session fell inside the window at all (nothing to report — not "$0/h", which would imply a
 * measured zero rather than an absence of recent data).
 *
 * `priceQuality` (R44) qualifies `usdPerHour` from the same window events via the canonical
 * priceQualityOf: unpriced events contribute 0 to the sum, so any unpriced count makes the rate
 * partial, and an all-unpriced window's 0 is not a measured zero. Whole-session counts never
 * qualify this window.
 */
export function computeBurn(
  events: readonly UsageEvent[],
  now: number,
  windowMs: number = BURN_WINDOW_MS
): { tokensPerMin: number; usdPerHour: number; countQuality?: TokenCounts['countQuality']; priceQuality: PriceQuality } | null {
  const windowStart = now - windowMs;
  const recent = events.filter((e) => e.ts > windowStart && e.ts <= now);
  if (recent.length === 0) return null;

  const totalTokens = sumTokens(recent);
  const totalUsd = recent.reduce((sum, e) => sum + (e.apiEquivUsd ?? 0), 0);
  const minutes = windowMs / 60_000;
  const hours = windowMs / 3_600_000;
  const counts = sumTokenCounts(recent);
  return { tokensPerMin: totalTokens / minutes, usdPerHour: totalUsd / hours,
    ...(counts.countQuality ? { countQuality: counts.countQuality } : {}), priceQuality: priceQualityOf(recent, { includeEvidence: true }) };
}

// ── wall-time vs summed agent-time ──────────────────────────────────────────

/**
 * Fleet/host-level rollup (DESIGN §6 "fleet/host wall-time = union of intervals vs summed
 * agent-time", §15.7.1 "show both summed agent-time and wall-time"): given a set of session
 * intervals (typically every SessionRow's [start, end] for a host or the whole fleet),
 *   - `agentMs` = Σ (end − start) over every interval — what it would sum to if every agent's
 *     clock ran independently (double-counts time where two sessions overlap).
 *   - `wallMs` = duration of the UNION of the intervals — actual person-wall-clock time during
 *     which at least one agent was active.
 * `agentMs >= wallMs` always; the gap is exactly the overlap between concurrent sessions.
 */
export function computeWallTime(
  intervals: readonly { start: number; end: number }[]
): { agentMs: number; wallMs: number } {
  const valid = intervals.filter((iv) => iv.end >= iv.start);
  const agentMs = valid.reduce((sum, iv) => sum + (iv.end - iv.start), 0);

  if (valid.length === 0) return { agentMs: 0, wallMs: 0 };

  const sorted = [...valid].sort((a, b) => a.start - b.start);
  let wallMs = 0;
  let curStart = sorted[0].start;
  let curEnd = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    const iv = sorted[i];
    if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      wallMs += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  wallMs += curEnd - curStart;

  return { agentMs, wallMs };
}

// ── building SessionRow[] ────────────────────────────────────────────────

export interface BuildSessionsOptions {
  idleGapMs: number;
  /** Default 5 min (DESIGN §6 "Live = last activity < 5 min ago"). */
  liveThresholdMs?: number;
  now?: () => number;
}

interface SessionGroup {
  host: HostLabel;
  source: Source;
  sessionId: string; // effective (parent) id
  marks: ActivityMark[];
  events: UsageEvent[];
  subagentSessionIds: Set<string>;
}

function pickProject(events: readonly UsageEvent[]): string | undefined {
  const own = events.find((e) => !e.isSubagent && e.project !== undefined);
  if (own) return own.project;
  const any = events.find((e) => e.project !== undefined);
  return any?.project;
}

/** Activity can carry workspace context even without a token usage record.
 * Use only the exact owning identity, and leave multiple recorded workspaces unresolved. */
export function activityProject(
  marks: readonly ActivityMark[],
  scope: Pick<ActivityMark, 'host' | 'source' | 'sessionId'>
): string | undefined {
  let selected: string | undefined;
  for (const mark of marks) {
    if (mark.host !== scope.host || mark.source !== scope.source || mark.sessionId !== scope.sessionId
      || typeof mark.project !== 'string' || mark.project.length === 0) continue;
    if (selected !== undefined && selected !== mark.project) return undefined;
    selected = mark.project;
  }
  return selected;
}

function pickRepoRoot(events: readonly UsageEvent[]): string | undefined {
  const own = events.find((e) => !e.isSubagent && e.repoRoot !== undefined);
  if (own) return own.repoRoot;
  const any = events.find((e) => e.repoRoot !== undefined);
  return any?.repoRoot;
}

function uniqueModelsInOrder(events: readonly UsageEvent[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const e of [...events].sort((a, b) => a.ts - b.ts)) {
    if (!seen.has(e.model)) {
      seen.add(e.model);
      models.push(e.model);
    }
  }
  return models;
}

function sumTokenCounts(events: readonly UsageEvent[]): TokenCounts {
  const t = { ...ZERO_TOKENS };
  for (const e of events) addTokenCounts(t, e.tokens);
  return t;
}

/**
 * Sums `apiEquivUsd` over events: `null` only when EVERY event's own `apiEquivUsd` is null (all
 * unpriced) and there is at least one event; an empty event list is 0 (no usage accrued, not
 * "unknown"); a mix of priced/unpriced events sums the known ones (the unpriced remainder is
 * still visible via the session's price status, never silently dropped from the type but
 * also never allowed to poison a real dollar total to null).
 */
function sumApiEquivUsd(events: readonly UsageEvent[]): number | null {
  if (events.length === 0) return 0;
  if (events.every((e) => e.apiEquivUsd === null)) return null;
  return events.reduce((sum, e) => sum + (e.apiEquivUsd ?? 0), 0);
}

/** Exact capture-feed breakdown used by both session rows and their detail windows. Unknown
 * engines stay unknown, and cloud/local events with the same model name remain separate. */
export function summarizeSessionTelemetry(events: readonly UsageEvent[]): SessionTelemetryFeed[] {
  const groups = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.host, event.source, event.provider, event.engine ?? null]);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return Array.from(groups.values()).map((group) => {
    const first = group[0];
    let firstEventAt = Infinity;
    let lastEventAt = -Infinity;
    const modelTimes = new Map<string, number>();
    const flags: SessionTelemetryFeed['flags'] = {};
    for (const event of group) {
      firstEventAt = Math.min(firstEventAt, event.ts);
      lastEventAt = Math.max(lastEventAt, event.ts);
      modelTimes.set(event.model, Math.min(modelTimes.get(event.model) ?? Infinity, event.ts));
      for (const flag of new Set(event.flags)) flags[flag] = (flags[flag] ?? 0) + 1;
    }
    return {
      host: first.host,
      source: first.source,
      provider: first.provider,
      ...(first.engine !== undefined ? { engine: first.engine } : {}),
      // Sort the handful of distinct models, not every event in a long session.
      models: Array.from(modelTimes.entries()).sort((a, b) => a[1] - b[1]).map(([model]) => model),
      events: group.length,
      tokens: sumTokenCounts(group),
      apiEquivUsd: sumApiEquivUsd(group),
      ...priceFieldsOf(group),
      firstEventAt,
      lastEventAt,
      flags,
    };
  }).sort((a, b) => b.lastEventAt - a.lastEventAt);
}

/** Groups events+marks by effective (parent-folded) session id, folding subagent activity into
 * its parent's group and recording the set of distinct subagent sessionIds folded in. */
export function groupBySession(
  marks: readonly ActivityMark[],
  events: readonly UsageEvent[]
): Map<string, SessionGroup> {
  return drainSteps(groupBySessionSteps(marks, events));
}

/** groupBySession as steps: a yield point after every SESSION_STEP_ITEMS events and marks. */
export function* groupBySessionSteps(
  marks: readonly ActivityMark[],
  events: readonly UsageEvent[]
): Generator<void, Map<string, SessionGroup>, void> {
  const hierarchy = new SessionHierarchy(events);
  const groups = new Map<string, SessionGroup>();

  function groupFor(host: HostLabel, source: Source, rawSessionId: string): SessionGroup {
    const effId = hierarchy.root(host, source, rawSessionId);
    const key = sessionGroupKey(host, source, effId);
    let g = groups.get(key);
    if (!g) {
      g = { host, source, sessionId: effId, marks: [], events: [], subagentSessionIds: new Set() };
      groups.set(key, g);
    }
    if (rawSessionId !== effId) g.subagentSessionIds.add(rawSessionId);
    return g;
  }

  let n = 0;
  for (const e of events) {
    groupFor(e.host, e.source, e.sessionId).events.push(e);
    if (++n % SESSION_STEP_ITEMS === 0) yield;
  }
  const deduped = yield* dedupeActivityMarkSteps(marks);
  for (const m of deduped) {
    groupFor(m.host, m.source, m.sessionId).marks.push(m);
    if (++n % SESSION_STEP_ITEMS === 0) yield;
  }

  return groups;
}

/** Builds one `SessionRow` per effective session group (DESIGN §6, §15.7.1). */
export function buildSessions(
  marks: readonly ActivityMark[],
  events: readonly UsageEvent[],
  opts: BuildSessionsOptions
): SessionRow[] {
  return drainSteps(buildSessionSteps(marks, events, opts));
}

/**
 * buildSessions with pauses between steps (one session group at a time, and every SESSION_STEP_ITEMS items while grouping).
 * The result is the same as buildSessions for the same input. The caller decides when to pause, and must not hold a
 * profiling span across the pause (see SyncSegment in core/phase-profile.ts).
 */
export function buildSessionsYielding(
  marks: readonly ActivityMark[],
  events: readonly UsageEvent[],
  opts: BuildSessionsOptions,
  pacing: StepPacing
): Promise<SessionRow[]> {
  return drainStepsYielding(buildSessionSteps(marks, events, opts), pacing);
}

export function* buildSessionSteps(
  marks: readonly ActivityMark[],
  events: readonly UsageEvent[],
  opts: BuildSessionsOptions
): Generator<void, SessionRow[], void> {
  const now = (opts.now ?? (() => Date.now()))();
  const liveThresholdMs = opts.liveThresholdMs ?? 5 * 60 * 1000;
  const groups = yield* groupBySessionSteps(marks, events);

  const rows: SessionRow[] = [];
  for (const g of groups.values()) {
    yield; // one session group per step: a count bound (one group), not a time bound
    const sortedMarks = [...g.marks].sort((a, b) => a.ts - b.ts);
    if (sortedMarks.length === 0 && g.events.length === 0) continue; // nothing to build a row from
    // Plain loops, never Math.min(...arr)/Math.max(...arr): spreading an unbounded array into call
    // arguments overflows the stack (RangeError) on large sessions (~10^5+ marks).
    let start = Infinity;
    let end = -Infinity;
    for (const m of sortedMarks) {
      if (m.ts < start) start = m.ts;
      if (m.ts > end) end = m.ts;
    }
    for (const e of g.events) {
      if (e.ts < start) start = e.ts;
      if (e.ts > end) end = e.ts;
    }

    rows.push({
      source: g.source,
      sessionId: g.sessionId,
      host: g.host,
      project: pickProject(g.events) ?? activityProject(sortedMarks, g),
      repoRoot: pickRepoRoot(g.events),
      models: uniqueModelsInOrder(g.events),
      start,
      end,
      activeMs: computeActiveMs(g.source, sortedMarks, opts.idleGapMs),
      activityEvidence: activityTimeEvidence(g.source, sortedMarks, opts.idleGapMs),
      live: now - end < liveThresholdMs,
      subagents: g.subagentSessionIds.size,
      tokens: sumTokenCounts(g.events),
      apiEquivUsd: sumApiEquivUsd(g.events),
      ...priceFieldsOf(g.events),
      burn: computeBurn(g.events, now),
      telemetry: summarizeSessionTelemetry(g.events),
    });
  }

  return rows.sort((a, b) => a.start - b.start);
}
