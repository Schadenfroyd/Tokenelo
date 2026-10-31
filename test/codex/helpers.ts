/**
 * Test helpers for the Codex collector: a synthetic rollout line builder, an in-memory LedgerWriter, and
 * hand-computable pricing and valuation-seam stubs. Not a test file (vitest only collects *.test.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActivityMark,
  DesktopSessionMeta,
  ValuationEngine,
  IngestContext,
  IngestState,
  LedgerWriter,
  LimitSnapshot,
  PriceResult,
  PricingEngine,
  RateStatus,
  SkipReason,
  TokenCounts,
  TokeneloConfig,
  UsageComponent,
  UsageEvent,
} from '../../src/core/types.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/codex');

// ── synthetic rollout builder ─────────────────────────────────────────────

/** [input, cached, output, reasoning?, cacheWrite?, total?] — total defaults to input + output. */
export type U = [number, number, number, number?, number?, number?];

export function usage(u: U): Record<string, number> {
  const [input, cached, output, reasoning = 0, cw = 0, total] = u;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cw,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total ?? input + output,
  };
}

export class Rollout {
  readonly lines: string[] = [];
  private ord = 0;
  constructor(private tsMs = Date.UTC(2026, 8, 1, 12, 0, 0), private readonly stepMs = 1000, private readonly withOrdinal = true) {}

  private push(type: string, payload: unknown, ts?: number): this {
    const t = ts ?? this.tsMs;
    if (ts === undefined) this.tsMs += this.stepMs;
    const o: Record<string, unknown> = { timestamp: new Date(t).toISOString() };
    if (this.withOrdinal) o.ordinal = this.ord;
    this.ord++;
    o.type = type;
    o.payload = payload;
    this.lines.push(JSON.stringify(o));
    return this;
  }

  /** Current ordinal (the key the NEXT line will get). */
  get nextOrdinal(): number {
    return this.ord;
  }

  meta(p: Record<string, unknown>, ts?: number): this {
    return this.push('session_meta', { id: p.id, session_id: p.id, cwd: '/fixture/project', originator: 'Codex Desktop', cli_version: '0.155.1', ...p }, ts);
  }
  taskStarted(turnId: string, startedAtS?: number, ts?: number): this {
    return this.push('event_msg', { type: 'task_started', turn_id: turnId, ...(startedAtS !== undefined ? { started_at: startedAtS } : {}) }, ts);
  }
  taskComplete(turnId: string, startedAtS?: number, completedAtS?: number, durationMs?: number, ts?: number): this {
    return this.push('event_msg', {
      type: 'task_complete', turn_id: turnId, last_agent_message: '[redacted]',
      ...(startedAtS !== undefined ? { started_at: startedAtS } : {}),
      ...(completedAtS !== undefined ? { completed_at: completedAtS } : {}),
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    }, ts);
  }
  turnAborted(turnId: string, ts?: number): this {
    return this.push('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }, ts);
  }
  turnContextFlat(turnId: string, model: string, effort: string, ts?: number): this {
    return this.push('turn_context', { turn_id: turnId, cwd: '/fixture/project', model, effort }, ts);
  }
  turnContextNested(turnId: string, model: string, effort: string, ts?: number): this {
    return this.push('turn_context', { turn_id: turnId, cwd: '/fixture/project', collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort } } }, ts);
  }
  settings(model: string, effort?: string, ts?: number): this {
    return this.push('event_msg', { type: 'thread_settings_applied', thread_settings: { model, ...(effort ? { reasoning_effort: effort } : {}) } }, ts);
  }
  user(ts?: number): this {
    return this.push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[redacted]' }] }, ts);
  }
  assistant(ts?: number): this {
    return this.push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[redacted]' }] }, ts);
  }
  reasoning(ts?: number): this {
    return this.push('response_item', { type: 'reasoning', summary: [] }, ts);
  }
  toolOutput(ts?: number): this {
    return this.push('response_item', { type: 'function_call_output', output: '[redacted]' }, ts);
  }
  compacted(ts?: number): this {
    return this.push('compacted', { message: '[redacted]', replacement_history: [] }, ts);
  }
  worldState(model: string | null, ts?: number): this {
    return this.push('world_state', { full: true, state: { model } }, ts);
  }
  marker(ts?: number): this {
    return this.push('event_msg', { type: 'agent_message', message: '<EXTERNAL SESSION IMPORTED>' }, ts);
  }
  agentText(text: string, ts?: number): this {
    return this.push('event_msg', { type: 'agent_message', message: text }, ts);
  }
  tokenCount(total: U, last: U, extra: Record<string, unknown> = {}, ts?: number): this {
    return this.push('event_msg', {
      type: 'token_count',
      info: { total_token_usage: usage(total), last_token_usage: usage(last), model_context_window: 258400 },
      rate_limits: null,
      ...extra,
    }, ts);
  }
  tokenCountNoInfo(rateLimits: unknown, ts?: number): this {
    return this.push('event_msg', { type: 'token_count', info: null, rate_limits: rateLimits }, ts);
  }
  record(threadId: string, turnId: string, responseId: string, u: U, ts?: number): this {
    return this.push('token_usage_record', {
      thread_id: threadId, turn_id: turnId, session_id: threadId, response_id: responseId,
      usage: usage(u), turn_token_usage: usage(u), thread_token_usage: usage([999999999, 0, 0]),
    }, ts);
  }
  text(): string {
    return this.lines.map((l) => l + '\n').join('');
  }
}

// ── in-memory ledger ──────────────────────────────────────────────────────

const FIELDS: (keyof TokenCounts)[] = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'];

export class MemoryStore implements LedgerWriter {
  events = new Map<string, UsageEvent>();
  activity: ActivityMark[] = [];
  limits: LimitSnapshot[] = [];
  skipped: { path: string; reason: SkipReason }[] = [];
  states = new Map<string, IngestState>();
  upsertCalls = 0;

  upsertEvents(events: UsageEvent[]): { inserted: number; updated: number; unchanged: number } {
    this.upsertCalls++;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (const e of events) {
      const prev = this.events.get(e.id);
      if (!prev) {
        this.events.set(e.id, structuredClone(e));
        inserted++;
        continue;
      }
      // Same semantics as SqliteLedger: per-field MAX, never a sum.
      const merged = structuredClone(e.tokens.output >= prev.tokens.output ? e : prev);
      for (const f of FIELDS) merged.tokens[f] = Math.max(prev.tokens[f], e.tokens[f]);
      if (JSON.stringify(merged) === JSON.stringify(prev)) unchanged++;
      else updated++;
      this.events.set(e.id, merged);
    }
    return { inserted, updated, unchanged };
  }
  recordActivity(marks: ActivityMark[]): void {
    const seen = new Set(this.activity.map((m) => m.uuid));
    for (const m of marks) if (!m.uuid || !seen.has(m.uuid)) this.activity.push(m);
  }
  recordLimits(snapshot: LimitSnapshot): void {
    this.limits.push(snapshot);
  }
  recordSkipped(p: string, reason: SkipReason): void {
    this.skipped.push({ path: p, reason });
  }
  desktopSessionMeta: (DesktopSessionMeta & { sourceFile: string })[] = [];
  upsertDesktopSessionMeta(rows: (DesktopSessionMeta & { sourceFile: string })[]): void {
    for (const r of rows) {
      const i = this.desktopSessionMeta.findIndex((x) => x.cliSessionId === r.cliSessionId);
      if (i === -1) this.desktopSessionMeta.push(r);
      else this.desktopSessionMeta[i] = r;
    }
  }
  getState(key: string): IngestState | undefined {
    const s = this.states.get(key);
    return s ? (JSON.parse(JSON.stringify(s)) as IngestState) : undefined;
  }
  setState(state: IngestState): void {
    this.states.set(state.key, JSON.parse(JSON.stringify(state)) as IngestState);
  }
  recentEvents(source: UsageEvent['source'], sinceTs: number, untilTs: number): UsageEvent[] {
    return [...this.events.values()]
      .filter((e) => e.source === source && e.ts >= sinceTs && e.ts <= untilTs)
      .sort((a, b) => a.ts - b.ts)
      .map((e) => structuredClone(e));
  }
  transaction<T>(fn: () => T): T {
    return fn();
  }

  totals(): TokenCounts & { billable: number } {
    const t = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, billable: 0 };
    for (const e of this.events.values()) {
      for (const f of FIELDS) t[f] += e.tokens[f];
    }
    t.billable = t.inputFresh + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output;
    return t;
  }
}

// ── hand-computable engines ───────────────────────────────────────────────

/** $ per MILLION tokens: inputFresh 2, cacheWrite5m 2.5, cacheWrite1h 4, cacheRead 0.2, output 10. */
export const STUB_RATES = { in: 2, cw5: 2.5, cw1: 4, cr: 0.2, out: 10 };
export function stubUsd(t: TokenCounts): number {
  return (
    (t.inputFresh * STUB_RATES.in + t.cacheWrite5m * STUB_RATES.cw5 + t.cacheWrite1h * STUB_RATES.cw1 +
      t.cacheRead * STUB_RATES.cr + t.output * STUB_RATES.out) / 1e6
  );
}
export const STUB_TOKENS_PER_UNIT = 1000;

export class StubPricing implements PricingEngine {
  readonly version = 'stub-prices';
  resolve(): null {
    return null;
  }
  providerOf(model: string) {
    return model === 'unknown' ? ('unknown' as const) : ('openai' as const);
  }
  priceComponent(c: UsageComponent): PriceResult {
    return { usd: stubUsd(c.tokens), status: 'LIST', rowId: 'stub', flags: [] };
  }
  priceEvent(e: Pick<UsageEvent, 'components' | 'inferenceGeo'>): PriceResult {
    return { usd: e.components.reduce((a, c) => a + stubUsd(c.tokens), 0), status: 'LIST', rowId: 'stub', flags: [] };
  }
}

/**
 * Deterministic test double for the valuation seam (the slim ValuationEngine): a fixed linear value per event
 * (fresh input + cache writes + output, STUB_TOKENS_PER_UNIT tokens per unit) so a test can hand-check exactly what a
 * collector writes through the seam. It models no real valuation.
 */
export class StubValuation implements ValuationEngine {
  readonly defSha256 = 'stub-def';
  rateBasisOf(components: readonly UsageComponent[]): { rateKey: string; resolvedSha256: string } {
    const rateKey = `[${[...new Set(components.map((c) => JSON.stringify([c.model, null])))].sort().join(',')}]`;
    return { rateKey, resolvedSha256: `stub-identity:${STUB_TOKENS_PER_UNIT}:${rateKey}` };
  }
  valueForEvent(e: Pick<UsageEvent, 'components' | 'effort' | 'thinking'>): { reservedValue: number | null; status: RateStatus } {
    const stubTokens = (t: TokenCounts): number => t.inputFresh + t.cacheWrite5m + t.cacheWrite1h + t.output;
    return { reservedValue: e.components.reduce((a, c) => a + stubTokens(c.tokens), 0) / STUB_TOKENS_PER_UNIT, status: 'MEASURED' };
  }
}

export function makeCtx(store: LedgerWriter, homes: string[] = []): IngestContext & { logs: { level: string; msg: string }[] } {
  const logs: { level: string; msg: string }[] = [];
  const config = { hostLabel: 'test', codex: { homes } } as unknown as TokeneloConfig;
  return {
    host: 'test',
    config,
    store,
    pricing: new StubPricing(),
    valuationEngine: new StubValuation(),
    log: (level, msg) => {
      logs.push({ level, msg });
    },
    now: () => Date.UTC(2026, 8, 26),
    logs,
  };
}
