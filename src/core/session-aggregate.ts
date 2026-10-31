/** Fixed-clock report reduction. Canonical array builders remain the legacy/differential path. */
import type { ActivityMark, HostLabel, SessionRow, SessionTelemetryFeed, Source, TokenCounts, UsageEvent } from './types.js';
import { ZERO_TOKENS } from './types.js';
import { addTokenCounts } from './token-counts.js';
import { addPriceEvidence, emptyPriceEvidence, qualifyAggregateAmount, type PriceEvidence } from './price-evidence.js';
import { hasEstimatedDollars, priceStatusOfCounts } from './price-quality.js';
import { SessionHierarchy } from './session-hierarchy.js';
import { activityProject, activityTimeEvidence, computeActiveMs, dedupeActivityMarkSteps, sessionGroupKey, SESSION_STEP_ITEMS } from './sessions.js';

type Identity = Pick<UsageEvent, 'host' | 'source' | 'sessionId' | 'parentSessionId' | 'isSubagent'>;
/** Keep final parent assignments in their first-insertion order, matching SessionHierarchy. */
export class SessionAncestryAccumulator {
  private readonly parents = new Map<string, Identity>();
  add(event: Identity): void {
    if (!event.isSubagent || !event.parentSessionId || event.parentSessionId === event.sessionId) return;
    this.parents.set(JSON.stringify([event.host, event.source, event.sessionId]), event);
  }
  finish(): SessionHierarchy {
    const hierarchy = new SessionHierarchy([...this.parents.values()]);
    this.parents.clear();
    return hierarchy;
  }
}
interface Totals {
  events: number; tokens: TokenCounts; usd: number; unpriced: number; estimated: number;
  evidence: PriceEvidence;
}
interface Feed {
  host: HostLabel; source: Source; provider: UsageEvent['provider']; engine?: string;
  totals: Totals; models: Map<string, number>; flags: SessionTelemetryFeed['flags'];
  firstEventAt: number; lastEventAt: number;
}
interface Group {
  host: HostLabel; source: Source; sessionId: string; marks: ActivityMark[]; subagents: Set<string>;
  totals: Totals; models: Map<string, { ts: number; index: number }>; feeds: Map<string, Feed>;
  start: number; end: number; recent: Totals; recentTokens: number;
  ownProject?: { value: string }; anyProject?: { value: string };
  ownRepo?: { value: string }; anyRepo?: { value: string };
}
function totals(): Totals {
  return { events: 0, tokens: { ...ZERO_TOKENS }, usd: 0, unpriced: 0, estimated: 0,
    evidence: emptyPriceEvidence() };
}
function add(target: Totals, event: UsageEvent): void {
  target.events++;
  addTokenCounts(target.tokens, event.tokens);
  target.usd += event.apiEquivUsd ?? 0;
  if (event.apiEquivUsd === null) target.unpriced++;
  if (hasEstimatedDollars(event.apiEquivUsd, event.priceStatus)) target.estimated++;
  addPriceEvidence(target.evidence, event.apiEquivUsd, event.priceStatus);
}
function price(target: Totals): Pick<SessionRow, 'unpricedEvents' | 'estimatedPriceEvents' | 'priceStatus' | 'priceEvidence'> {
  // Quality qualifies the known sum; even an all-unpriced sum is zero for this evidence check.
  qualifyAggregateAmount(target.evidence, target.usd);
  return { unpricedEvents: target.unpriced, estimatedPriceEvents: target.estimated,
    priceStatus: priceStatusOfCounts(target.events, target.unpriced, target.estimated, target.evidence), priceEvidence: target.evidence };
}
function dollars(target: Totals): number | null {
  return target.events > 0 && target.unpriced === target.events ? null : target.usd;
}

export interface SessionAggregateOptions { asOf: number; idleGapMs: number; liveThresholdMs?: number }
/** Events are folded in their original order, then released. Scope maps retain aggregate values, never raw components.
 * The caller must complete ancestry and feed events under the same pinned snapshot and fixed query clock. */
export class SessionEventAggregate {
  private readonly groups = new Map<string, Group>();
  private sequence = 0;
  constructor(private readonly hierarchy: SessionHierarchy, private readonly opts: SessionAggregateOptions) {}
  private groupFor(host: HostLabel, source: Source, rawSessionId: string): Group {
    const sessionId = this.hierarchy.root(host, source, rawSessionId), key = sessionGroupKey(host, source, sessionId);
    let group = this.groups.get(key);
    if (!group) {
      group = { host, source, sessionId, marks: [], subagents: new Set(), totals: totals(), models: new Map(), feeds: new Map(),
        start: Infinity, end: -Infinity, recent: totals(), recentTokens: 0 };
      this.groups.set(key, group);
    }
    if (rawSessionId !== sessionId) group.subagents.add(rawSessionId);
    return group;
  }
  addEvent(event: UsageEvent): void {
    const group = this.groupFor(event.host, event.source, event.sessionId);
    add(group.totals, event);
    group.start = Math.min(group.start, event.ts); group.end = Math.max(group.end, event.ts);
    const index = this.sequence++, previous = group.models.get(event.model);
    if (!previous || event.ts < previous.ts) group.models.set(event.model, { ts: event.ts, index });
    if (event.project !== undefined) {
      group.anyProject ??= { value: event.project };
      if (!event.isSubagent) group.ownProject ??= { value: event.project };
    }
    if (event.repoRoot !== undefined) {
      group.anyRepo ??= { value: event.repoRoot };
      if (!event.isSubagent) group.ownRepo ??= { value: event.repoRoot };
    }
    const key = JSON.stringify([event.host, event.source, event.provider, event.engine ?? null]);
    let feed = group.feeds.get(key);
    if (!feed) {
      feed = { host: event.host, source: event.source, provider: event.provider,
        ...(event.engine !== undefined ? { engine: event.engine } : {}), totals: totals(), models: new Map(), flags: {},
        firstEventAt: Infinity, lastEventAt: -Infinity };
      group.feeds.set(key, feed);
    }
    add(feed.totals, event);
    feed.firstEventAt = Math.min(feed.firstEventAt, event.ts); feed.lastEventAt = Math.max(feed.lastEventAt, event.ts);
    feed.models.set(event.model, Math.min(feed.models.get(event.model) ?? Infinity, event.ts));
    for (const flag of new Set(event.flags)) feed.flags[flag] = (feed.flags[flag] ?? 0) + 1;
    if (event.ts > this.opts.asOf - 900_000 && event.ts <= this.opts.asOf) {
      add(group.recent, event);
      // Same left-to-right arithmetic as computeBurn's sumTokens; do not combine per-event totals first.
      group.recentTokens = group.recentTokens + event.tokens.inputFresh + event.tokens.cacheWrite5m + event.tokens.cacheWrite1h
        + (event.tokens.cacheWriteUnassigned ?? 0) + event.tokens.cacheRead + event.tokens.output;
    }
  }
  /** One group or SESSION_STEP_ITEMS marks between steps; a row-count bound, not a time bound. */
  *buildSteps(marks: readonly ActivityMark[]): Generator<void, SessionRow[], void> {
    const deduped = yield* dedupeActivityMarkSteps(marks);
    let n = 0;
    for (const mark of deduped) {
      this.groupFor(mark.host, mark.source, mark.sessionId).marks.push(mark);
      if (++n % SESSION_STEP_ITEMS === 0) yield;
    }
    const rows: SessionRow[] = [];
    for (const group of this.groups.values()) {
      yield;
      const sortedMarks = [...group.marks].sort((a, b) => a.ts - b.ts);
      for (const mark of sortedMarks) { group.start = Math.min(group.start, mark.ts); group.end = Math.max(group.end, mark.ts); }
      const t = group.totals, recent = group.recent;
      const telemetry: SessionTelemetryFeed[] = [...group.feeds.values()].map(feed => ({ host: feed.host, source: feed.source, provider: feed.provider,
        ...(feed.engine !== undefined ? { engine: feed.engine } : {}),
        models: [...feed.models].sort((a, b) => a[1] - b[1]).map(([model]) => model), events: feed.totals.events,
        tokens: feed.totals.tokens, apiEquivUsd: dollars(feed.totals), ...price(feed.totals),
        firstEventAt: feed.firstEventAt, lastEventAt: feed.lastEventAt, flags: feed.flags,
      })).sort((a, b) => b.lastEventAt - a.lastEventAt);
      rows.push({ source: group.source, sessionId: group.sessionId, host: group.host,
        project: (group.ownProject ?? group.anyProject)?.value ?? activityProject(sortedMarks, group), repoRoot: (group.ownRepo ?? group.anyRepo)?.value,
        models: [...group.models].sort((a, b) => a[1].ts - b[1].ts || a[1].index - b[1].index).map(([model]) => model),
        start: group.start, end: group.end, activeMs: computeActiveMs(group.source, sortedMarks, this.opts.idleGapMs),
        activityEvidence: activityTimeEvidence(group.source, sortedMarks, this.opts.idleGapMs),
        live: this.opts.asOf - group.end < (this.opts.liveThresholdMs ?? 300_000), subagents: group.subagents.size,
        tokens: t.tokens, apiEquivUsd: dollars(t), ...price(t),
        burn: recent.events === 0 ? null : { tokensPerMin: group.recentTokens / 15, usdPerHour: recent.usd / 0.25,
          ...(recent.tokens.countQuality ? { countQuality: recent.tokens.countQuality } : {}), priceQuality: { events: recent.events, ...price(recent) } },
        telemetry });
    }
    return rows.sort((a, b) => a.start - b.start);
  }
}
