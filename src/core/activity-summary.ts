import type { ActivityMark, Source, UsageEvent } from './types.js';
import { computeActiveMs, dedupeActivityMarkSteps, sessionGroupKey, SESSION_STEP_ITEMS } from './sessions.js';
import { SessionHierarchy } from './session-hierarchy.js';

/** Summary needs session identity and ancestry for its timer, not token/model session rows. */
export type ActivityGroupingEvent = Pick<UsageEvent, 'host' | 'source' | 'sessionId' | 'parentSessionId' | 'isSubagent'>;

/** Keeps the first raw group occurrence and last valid parent assignment in input order.
 * Repeated identities carry no timing payload. Keeping only their first occurrence would
 * be wrong when a child's parent changes and later returns to an earlier parent. */
export class ActivityGroupingIdentities {
  private readonly seen = new Map<string, Map<Source, Set<string>>>();
  private readonly first: Array<{ ordinal: number; event: ActivityGroupingEvent }> = [];
  private readonly lastParent = new Map<string, { ordinal: number; event: ActivityGroupingEvent }>();
  private ordinal = 0;

  add(event: ActivityGroupingEvent): void {
    const ordinal = this.ordinal++;
    let sources = this.seen.get(event.host);
    if (!sources) { sources = new Map(); this.seen.set(event.host, sources); }
    let sessions = sources.get(event.source);
    if (!sessions) { sessions = new Set(); sources.set(event.source, sessions); }
    if (!sessions.has(event.sessionId)) {
      sessions.add(event.sessionId); this.first.push({ ordinal, event });
    }
    // Retain final ancestry within the same host and collector namespace.
    if (event.isSubagent && event.parentSessionId && event.parentSessionId !== event.sessionId) {
      this.lastParent.set(JSON.stringify([event.host, event.source, event.sessionId]), { ordinal, event });
    }
  }

  events(): ActivityGroupingEvent[] {
    const retained = new Map(this.first.map(entry => [entry.ordinal, entry]));
    for (const entry of this.lastParent.values()) retained.set(entry.ordinal, entry);
    return [...retained.values()].sort((a, b) => a.ordinal - b.ordinal).map(entry => entry.event);
  }
}

/** Compact the same first identity and final valid parent in canonical (ts,rowid) order,
 * even when Summary's monetary fold must visit rows in rowid order. Every contributing
 * row is visited; no population, timestamp, UUID ownership or ancestry is sampled. */
export class OrderedActivityGroupingIdentities {
  private readonly groups = new Map<string, Map<Source, Map<string, { first: Entry; lastParent?: Entry }>>>();
  add(event: ActivityGroupingEvent, ts: number, rid: number): void {
    let sources = this.groups.get(event.host);
    if (!sources) { sources = new Map(); this.groups.set(event.host, sources); }
    let sessions = sources.get(event.source);
    if (!sessions) { sessions = new Map(); sources.set(event.source, sessions); }
    let group = sessions.get(event.sessionId);
    const position = { ts, rid };
    if (!group) { group = { first:{ ...position,event } }; sessions.set(event.sessionId,group); }
    else if (comparePosition(position,group.first) < 0) group.first = { ...position,event };
    if (event.isSubagent && event.parentSessionId && event.parentSessionId !== event.sessionId
      && (!group.lastParent || comparePosition(position,group.lastParent) > 0)) group.lastParent = { ...position,event };
  }
  events(): ActivityGroupingEvent[] {
    const entries = new Map<number,Entry>();
    for (const sources of this.groups.values()) for (const sessions of sources.values()) for (const group of sessions.values()) {
      entries.set(group.first.rid,group.first);
      if (group.lastParent) entries.set(group.lastParent.rid,group.lastParent);
    }
    return [...entries.values()].sort(comparePosition).map(entry=>entry.event);
  }
}
interface Position { ts:number; rid:number }
interface Entry extends Position { event:ActivityGroupingEvent }
function comparePosition(a:Position,b:Position):number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0;
}

/** Preserve session order, global UUID ownership, parent folding and the canonical active-time calculation. */
export function* summedSessionActiveMsSteps(
  marks: readonly ActivityMark[], events: readonly ActivityGroupingEvent[], idleGapMs: number
): Generator<void, number, void> {
  const hierarchy = new SessionHierarchy(events);
  const groups = new Map<string, { source: Source; marks: ActivityMark[] }>();
  function group(host: string, source: Source, sessionId: string) {
    const key = sessionGroupKey(host, source, hierarchy.root(host, source, sessionId));
    let found = groups.get(key);
    if (!found) { found = { source, marks: [] }; groups.set(key, found); }
    return found;
  }
  let n = 0;
  // Event-first order matches buildSessions, including groups with zero activity.
  for (const event of events) {
    group(event.host, event.source, event.sessionId);
    if (++n % SESSION_STEP_ITEMS === 0) yield;
  }
  const deduped = yield* dedupeActivityMarkSteps(marks);
  for (const mark of deduped) {
    group(mark.host, mark.source, mark.sessionId).marks.push(mark);
    if (++n % SESSION_STEP_ITEMS === 0) yield;
  }
  let total = 0;
  for (const value of groups.values()) {
    yield;
    total += computeActiveMs(value.source, value.marks.sort((a, b) => a.ts - b.ts), idleGapMs);
  }
  return total;
}

interface SummaryActivityGroup {
  source: Source;
  lastTs?: number;
  gapMs: number;
  durationMarks: Array<{ ts: number; hasUuid: boolean; rowid: number; durationMs: number }>;
}

export interface SummaryActivityTime {
  agentMs: number;
  wallMs: number;
}

/**
 * Streaming counterpart to `summedSessionActiveMsSteps` for rows already ordered by (ts,rowid).
 * It keeps UUID ownership and session-group totals, rather than retaining every ActivityMark.
 * `add` must receive the canonical database order used by readRows.
 */
export class SummaryActivityAccumulator {
  private readonly hierarchy: SessionHierarchy;
  private readonly groups = new Map<string, SummaryActivityGroup>();
  private readonly eventOrder: string[] = [];
  private readonly noUuidOrder: string[] = [];
  private readonly uuidOrder: string[] = [];
  private readonly noUuidKeys = new Set<string>();
  private readonly uuidKeys = new Set<string>();
  private readonly seenUuids = new Set<string>();
  private lastInput: { ts: number; rowid: number } | undefined;
  private wallStart: number | undefined;
  private wallPrevious: number | undefined;
  private wallTotal = 0;

  constructor(events: readonly ActivityGroupingEvent[], private readonly idleGapMs: number) {
    this.hierarchy = new SessionHierarchy(events);
    // Preserve the reference reducer's Map insertion order: event groups first.
    for (const event of events) {
      const key = this.key(event.host, event.source, event.sessionId);
      if (!this.groups.has(key)) {
        this.groups.set(key, { source: event.source, gapMs: 0, durationMarks: [] });
        this.eventOrder.push(key);
      }
    }
  }

  add(mark: ActivityMark, rowid: number): void {
    if (!Number.isSafeInteger(rowid)) throw new RangeError('summary activity rowid must be a safe integer');
    if (this.lastInput && (mark.ts < this.lastInput.ts || (mark.ts === this.lastInput.ts && rowid < this.lastInput.rowid))) {
      throw new RangeError('summary activity rows must be ordered by (ts,rowid)');
    }
    this.lastInput = { ts: mark.ts, rowid };

    const hasUuid = Boolean(mark.uuid);
    if (hasUuid) {
      if (this.seenUuids.has(mark.uuid!)) return;
      this.seenUuids.add(mark.uuid!);
    }
    this.addWallTimestamp(mark.ts);

    const key = this.key(mark.host, mark.source, mark.sessionId);
    let group = this.groups.get(key);
    if (!group) {
      group = { source: mark.source, gapMs: 0, durationMarks: [] };
      this.groups.set(key, group);
    }
    if (hasUuid) {
      if (!this.uuidKeys.has(key)) { this.uuidKeys.add(key); this.uuidOrder.push(key); }
    } else if (!this.noUuidKeys.has(key)) {
      this.noUuidKeys.add(key); this.noUuidOrder.push(key);
    }

    if (group.lastTs !== undefined) {
      const gap = mark.ts - group.lastTs;
      if (gap > 0 && gap <= this.idleGapMs) group.gapMs += gap;
    }
    group.lastTs = mark.ts;
    if (group.source === 'codex' && typeof mark.durationMs === 'number' && mark.durationMs > 0) {
      group.durationMarks.push({ ts: mark.ts, hasUuid, rowid, durationMs: mark.durationMs });
    }
  }

  *finishSteps(): Generator<void, SummaryActivityTime, void> {
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const key of [...this.eventOrder, ...this.noUuidOrder, ...this.uuidOrder]) {
      if (!seen.has(key)) { seen.add(key); orderedKeys.push(key); }
    }

    let agentMs = 0;
    let work = 0;
    for (const key of orderedKeys) {
      const group = this.groups.get(key)!;
      let groupMs = group.gapMs;
      if (group.source === 'codex' && group.durationMarks.length > 0) {
        // The reference path concatenates no-UUID marks before UUID-owned marks, then uses a
        // stable timestamp sort. rowid preserves that order within equal-timestamp categories.
        group.durationMarks.sort((a, b) => a.ts - b.ts || Number(a.hasUuid) - Number(b.hasUuid) || a.rowid - b.rowid);
        groupMs = 0;
        for (const mark of group.durationMarks) {
          groupMs += mark.durationMs;
          if (++work % SESSION_STEP_ITEMS === 0) yield;
        }
      }
      agentMs += groupMs;
      if (++work % SESSION_STEP_ITEMS === 0) yield;
    }

    let wallMs = this.wallTotal;
    if (this.wallStart !== undefined && this.wallPrevious !== undefined) wallMs += this.wallPrevious - this.wallStart;
    return { agentMs, wallMs };
  }

  private key(host: string, source: Source, sessionId: string): string {
    return sessionGroupKey(host, source, this.hierarchy.root(host, source, sessionId));
  }

  private addWallTimestamp(ts: number): void {
    if (this.wallStart === undefined || this.wallPrevious === undefined) {
      this.wallStart = ts;
      this.wallPrevious = ts;
      return;
    }
    if (ts - this.wallPrevious > this.idleGapMs) {
      this.wallTotal += this.wallPrevious - this.wallStart;
      this.wallStart = ts;
    }
    this.wallPrevious = ts;
  }
}
