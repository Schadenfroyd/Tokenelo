/**
 * Claude Code collector (DESIGN §4.1 + §15.1 — §15.1 amendments win over §4.1 where they
 * disagree). Walks the whitelisted transcript files (`fswalk.ts`), turns each qualifying
 * `assistant` line into a `UsageEvent`, and records an `ActivityMark` for every line that has a
 * timestamp (user/assistant/tool/system/etc. — whatever the line's own `type` is).
 *
 * Real-field evidence for every mapping below lives in docs/research/log-formats.md §1 and the
 * sanitized fixtures under test/fixtures/claude/ (built from real, redacted M4a lines).
 *
 * What this file deliberately does NOT do: merge duplicate `message.id` lines itself. The store
 * (`store/ledger.ts`, DESIGN §15.1.2, not owned by this module) already does the correct
 * per-field-MAX + "kept line" merge on every `upsertEvents` call, keyed by `id`, whether the
 * duplicates arrive in the same batch or across separate scans/files (resumed/forked sessions).
 * Re-implementing that merge here would be redundant and risks disagreeing with the store's own
 * (already mutation-tested — see test/store/ledger.test.ts) logic. This collector's job is to
 * emit one `UsageEvent` per qualifying line, with the correct dedup `id`, and let the store merge.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  ActivityMark,
  Collector,
  EventFlag,
  IngestContext,
  IngestStats,
  TokenCounts,
  TokeneloConfig,
  UsageComponent,
  UsageEvent,
} from '../core/types.js';
import { CLAUDE_HOLD_KEY, readClaudeHold, readClaudeStoredEvidenceHold, type ClaudeHoldMarker, type ClaudeStoredEvidenceHoldMarker } from '../core/capture-holds.js';
import { StoredComponentEvidenceError } from '../store/ledger.js';
import { FILES_PER_YIELD, YIELD_BUDGET_MS, YieldPacer, yieldToEventLoop } from '../core/event-loop.js';
import { awaitOutside, measure, spanEnd, spanStart, SyncSegment, intervalBegin, intervalEnd } from '../core/phase-profile.js';
import { statSafeAsync, walkClaudeRootsYielding, type ClaudeFileRef, type SafeStat } from './fswalk.js';
import { captureComponentCounts, componentCountProjection, countEvidenceFlags } from '../measurement/component-count-evidence.js';
import { addTokenCounts } from '../core/token-counts.js';

const SYNTHETIC_MODEL = '<synthetic>';
const BATCH_SIZE = 2000;
/** Initial read window. A line longer than the window widens it, doubling up to `maxLineBytes`. */
const READ_WINDOW_BYTES = 4 * 1024 * 1024;
/** Lines parsed between event-loop yields inside a window (see the window loop in scan). */
const LINES_PER_YIELD = 500;
/** Largest line the collector will buffer (default). A longer line holds its file at that offset
 * (never ingested, never skipped past); see heldWarning. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

// ── Roots (DESIGN §4.1: $CLAUDE_CONFIG_DIR/projects if set, else ~/.claude/projects; optionally
// ~/.config/claude/projects) ─────────────────────────────────────────────────────────────────

/**
 * Resolves the Claude Code project roots to walk. `config.claude.roots`, when set and non-empty,
 * is authoritative and used verbatim (operator override). Otherwise: `$CLAUDE_CONFIG_DIR/projects`
 * if that env var is set, else `~/.claude/projects`; `~/.config/claude/projects` is additionally
 * included, but only when it actually exists as a directory (an alternate install location some
 * builds use — DESIGN §4.1's "optionally"), so a host without it doesn't get a phantom root that
 * would just no-op in `walkClaudeRoots` anyway but would be noise in `doctor`/logs.
 */
export function resolveClaudeRoots(
  config: TokeneloConfig,
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir()
): string[] {
  if (config.claude.roots && config.claude.roots.length > 0) {
    return config.claude.roots;
  }
  const roots: string[] = [];
  roots.push(
    env.CLAUDE_CONFIG_DIR
      ? path.join(env.CLAUDE_CONFIG_DIR, 'projects')
      : path.join(home, '.claude', 'projects')
  );
  const altRoot = path.join(home, '.config', 'claude', 'projects');
  try {
    if (fs.statSync(altRoot).isDirectory()) roots.push(altRoot);
  } catch {
    // doesn't exist on this host — fine, not every install has it
  }
  return roots;
}

// ── Incremental byte-offset reading (DESIGN §4.1 "Incremental") ───────────────────────────────

/**
 * Reads every COMPLETE line (terminated by `\n`) from `offset` to the current end of the file,
 * returning the new offset to persist (which always lands exactly on a `\n` boundary or at EOF
 * with no trailing partial line included). A trailing partial line — the file is still being
 * written — is left unconsumed; it will be picked up whole on the next scan once its `\n` lands.
 * Locates the split point on the raw byte buffer (searching backward for the last 0x0A byte)
 * rather than decoding first, which sidesteps any multi-byte UTF-8 boundary landing mid-chunk: a
 * `\n` byte can never be a continuation byte of a multi-byte codepoint, so slicing the buffer
 * there and only then decoding to UTF-8 is always safe.
 */
class ClaudeReadChangedError extends Error {}

function readCompleteWindow(
  filePath: string,
  offset: number,
  size: number,
  maxBytes: number = Infinity,
  hashIncompletePrefix = false,
  expectedIno?: number,
  strictLength = true,
  maxLines = Infinity,
  captureBatchIdentity = false,
  previousBatch?: ClaudeStoredEvidenceHoldMarker,
): { lines: string[]; newOffset: number; prefixSha256?: string; batchSha256?: string; previousBatchPrefixMatches?: boolean } {
  if (size <= offset) return { lines: [], newOffset: offset };
  const fd = fs.openSync(filePath, 'r');
  try {
    if (expectedIno !== undefined && Number(fs.fstatSync(fd, { bigint: true }).ino % 9007199254740991n) !== expectedIno)
      throw new ClaudeReadChangedError('file identity changed before open');
    // A bounded window keeps one read/parse step small; `scan` widens it only when a single line is
    // longer than the window (see the windowed loop there).
    const length = Math.min(size - offset, maxBytes);
    const buf = Buffer.alloc(length);
    let read = 0;
    let newlineCount = 0;
    let boundedEnd = -1;
    let chunkBytes = Number.isFinite(maxLines) ? 4096 : length;
    while (read < length) {
      // A record cap bounds the atomic write, without rereading an entire byte
      // window for every batch of tiny records. Only the last small chunk can
      // overlap the next read. Locate cursor boundaries on bytes, before decoding.
      const count = fs.readSync(fd, buf, read, Math.min(length - read, chunkBytes), offset + read);
      if (count === 0) break;
      const part = buf.subarray(read, read + count);
      const previousCount = newlineCount;
      for (let at = part.indexOf(0x0a); at >= 0; at = part.indexOf(0x0a, at + 1)) {
        if (++newlineCount === maxLines) {
          boundedEnd = read + at;
          break;
        }
      }
      read += count;
      if (boundedEnd >= 0) break;
      // Long records need fewer syscalls; as soon as a newline appears, return
      // to small chunks so a following tiny-record backlog is not reread in large windows.
      if (Number.isFinite(maxLines)) chunkBytes = newlineCount === previousCount ? Math.min(chunkBytes * 2, 65536) : 4096;
    }
    // A short read can occur without EOF. Accumulate it; an early EOF cannot establish
    // an over-cap prefix or a trustworthy offset under the caller's earlier stat.
    if (strictLength && boundedEnd < 0 && read !== length) throw new ClaudeReadChangedError('file ended before the statted read length');
    const actual = buf.subarray(0, read);
    let lastNewline = boundedEnd;
    for (let i = actual.length - 1; lastNewline < 0 && i >= 0; i--) {
      if (actual[i] === 0x0a) {
        lastNewline = i;
        break;
      }
    }
    if (lastNewline === -1) return { lines: [], newOffset: offset,
      ...(hashIncompletePrefix ? { prefixSha256: createHash('sha256').update(actual).digest('hex') } : {}) };
    const complete = actual.subarray(0, lastNewline + 1);
    // Hash the exact bounded raw bytes before UTF-8 decoding. A stored-evidence hold must retain
    // its original age through appends only when its entire rejected prefix still matches.
    // The successful public line-reader keeps its original shape and does not request this work.
    const batchSha256 = captureBatchIdentity ? createHash('sha256').update(complete).digest('hex') : undefined;
    const previousBatchPrefixMatches = previousBatch?.batchBytes !== undefined && previousBatch.batchSha256 !== undefined
      && previousBatch.batchBytes <= complete.length
      && previousBatch.batchSha256 === (previousBatch.batchBytes === complete.length ? batchSha256
        : createHash('sha256').update(complete.subarray(0, previousBatch.batchBytes)).digest('hex'));
    const text = complete.toString('utf8');
    const rawLines = text.split('\n');
    rawLines.pop(); // the split after the final '\n' always yields a trailing '' — discard it
    return { lines: rawLines, newOffset: offset + lastNewline + 1,
      ...(captureBatchIdentity ? { batchSha256, previousBatchPrefixMatches } : {}) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Public byte-boundary reader retains its original result shape; held-prefix identity
 * stays collector-private and is computed only for a complete bounded cap window. */
export function readNewCompleteLines(filePath: string, offset: number, size: number, maxBytes = Infinity): { lines: string[]; newOffset: number } {
  const { lines, newOffset } = readCompleteWindow(filePath, offset, size, maxBytes, false, undefined, false);
  return { lines, newOffset };
}

/** A held file is recognised only while its stored identity still matches the file on disk. A
 * replacement (new inode) or an in-place rewrite (new mtime) can keep the same size and offset. */
function sameFileIdentity(stored: { ino?: number; size: number; mtimeMs: number }, stat: SafeStat): boolean {
  return stored.ino === stat.ino && stored.size === stat.size && stored.mtimeMs === stat.mtimeMs;
}

/** Content-free: path and byte offset only, never line text. Repeated on every scan while held. */
function heldWarning(filePath: string, maxLineBytes: number, offset: number): string {
  return `incomplete capture: line longer than ${maxLineBytes} bytes at offset ${offset}; file held, later records not ingested: ${filePath}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Line -> ActivityMark (DESIGN §4.1 "Activity timestamps" / §15.7.1) ────────────────────────

const ACTIVITY_KIND_BY_LINE_TYPE: Readonly<Record<string, ActivityMark['kind']>> = Object.freeze({
  user: 'user',
  assistant: 'assistant',
});

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function numOr0(v: unknown): number {
  return numOrUndef(v) ?? 0;
}
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Builds an ActivityMark for ANY line that carries a parseable `timestamp` + `sessionId` —
 * queue-operation/file-history-snapshot/last-prompt/attachment lines included, not just
 * user/assistant — per DESIGN's "Activity marks for ALL line types with timestamp", so idle-gap
 * active-time computation (§6) sees the full shape of what happened, not just usage-bearing
 * turns. `kind` is only set when the line's own `type` maps cleanly onto ActivityMark's kind enum
 * (user/assistant observed in real Claude JSONL; Codex is where 'tool'/'system' show up) — an
 * unmapped `type` still produces a mark, just with `kind` left undefined rather than guessed. */
function buildActivityMark(
  line: Record<string, unknown>,
  host: string
): ActivityMark | null {
  const ts = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const sessionId = strOrUndef(line.sessionId);
  if (!sessionId) return null;
  return {
    source: 'claude',
    sessionId,
    ts,
    uuid: strOrUndef(line.uuid),
    host,
    project: strOrUndef(line.cwd),
    kind: ACTIVITY_KIND_BY_LINE_TYPE[typeof line.type === 'string' ? line.type : ''],
  };
}

// ── usage-like object (top-level `message.usage`, or one `usage.iterations[]` entry) ->
// UsageComponent (DESIGN §4.1 fields + §15.1.3/.4) ─────────────────────────────────────────────

interface ComponentResult {
  component: UsageComponent;
  /** True iff this component's cache_creation had no 5m/1h split and its cache-write tokens were
   * assumed to be all-1h (§15.1.4) — only meaningful (and only flagged) when there was actually
   * some non-zero cache-write mass to attribute; a component with zero cache writes and no split
   * object is not "assuming" anything. */
  cacheSplitAssumed: boolean;
}

function usageLikeToComponent(raw: Record<string, unknown>, fallbackModel: string): ComponentResult {
  const countEvidence = captureComponentCounts(raw);
  const { tokens, cache } = componentCountProjection(countEvidence);
  const cacheSplitAssumed = cache.assumed1h > 0;

  const model = strOrUndef(raw.model) ?? fallbackModel;
  const speedRaw = raw.speed;
  const speed = speedRaw === 'standard' || speedRaw === 'fast' ? speedRaw : undefined;

  const component: UsageComponent = { model, tokens, countEvidence };
  if (speed) component.speed = speed;
  return { component, cacheSplitAssumed };
}

/**
 * Per-line thinking detection (founder req. 2026-09-27; real-sample evidence, M4a
 * ~/.claude/projects, 2026-09-27 — never stored, structural fields only):
 *  - true: any content block of type 'thinking'/'redacted_thinking' is present on this line, OR
 *    `usage.output_tokens_details.thinking_tokens > 0`. Grouping 142,192 real assistant lines by
 *    message.id (46,628 distinct messages): 31,965 had a thinking content block; every model seen
 *    (claude-opus-4-8/5/5-5, sonnet-5/4-6/4-5, fable-5/5-1, haiku-4-5, and gemma4:26b served
 *    through this collector per §15.1.6) produced at least one such message.
 *  - false: `output_tokens_details` is present (the model/build reports it) but neither signal
 *    ever fired for this line — "verified non-thinking", not merely absent. 8,404 of the 46,628
 *    grouped messages were this case across every non-synthetic model.
 *  - null: `output_tokens_details` was never present on this line at all (older builds, or this
 *    line's own streaming snapshot simply doesn't carry it yet) — not determinable from this line
 *    alone; 14,989 of the 46,628 messages never had the field on ANY of their lines either
 *    (`EventFlag 'thinkingUnknown'` set). Streaming duplicates are merged by the store with
 *    true > false > null (ledger.ts mergeThinking), so a message.id resolves to `true` the moment
 *    ANY of its lines proves it, even if others are `false`/`null`.
 * `output_tokens_details.thinking_tokens` is per-message top-level only (never per-iteration, same
 * scope as the reasoning attribution above), so this reads `usage` directly, not per-component.
 */
const THINKING_CONTENT_TYPES = new Set(['thinking', 'redacted_thinking']);

function detectLineThinking(message: Record<string, unknown>, usage: Record<string, unknown>): boolean | null {
  const content = Array.isArray(message.content) ? (message.content as unknown[]) : [];
  const hasThinkingBlock = content.some(
    (b) => b !== null && typeof b === 'object' && THINKING_CONTENT_TYPES.has(String((b as Record<string, unknown>).type))
  );
  const otd = usage.output_tokens_details;
  const hasOtd = otd !== null && otd !== undefined && typeof otd === 'object';
  const thinkingTokens = hasOtd ? numOrUndef((otd as Record<string, unknown>).thinking_tokens) : undefined;
  if (hasThinkingBlock || (thinkingTokens !== undefined && thinkingTokens > 0)) return true;
  if (hasOtd) return false;
  return null;
}

function sumTokens(components: readonly UsageComponent[]): TokenCounts {
  const total: TokenCounts = {
    inputFresh: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    reasoning: 0,
  };
  for (const c of components) {
    addTokenCounts(total, c.tokens);
  }
  return total;
}

interface BuiltComponents {
  components: UsageComponent[];
  cacheSplitAssumed: boolean;
  reasoningClamped: boolean;
}

/**
 * Builds the priced components for one assistant line's `usage` object.
 *
 * DESIGN §15.1.3 (Opus-adversarial-review fix, spikes-2026-09-26.md #critical finding): when
 * `usage.iterations` is a non-empty array, the top-level `usage` fields (model included) describe
 * ONLY the final iteration — real evidence (log-formats.md §2.4, and a real M4a
 * claude-fable-5-1 -> claude-opus-4-8 fallback pair found this session) shows top-level
 * input/output/cache_read exactly equal the LAST iteration's own fields. Pricing only the
 * top-level usage therefore silently drops every earlier (often more expensive) iteration's
 * tokens. Fix: emit one component per iteration (iteration.model, fallback message.model), sum
 * for the event total, and use top-level usage only when iterations is absent/empty.
 *
 * `output_tokens_details.thinking_tokens` (top-level only — verified absent from individual
 * iteration objects in the real sample) is attributed to the LAST component's `reasoning`,
 * clamped to that component's own output (never to a non-final iteration, since there is no
 * per-iteration thinking figure anywhere in the log to attribute it to).
 */
function buildComponents(usage: Record<string, unknown>, topModel: string): BuiltComponents {
  const iterationsRaw = Array.isArray(usage.iterations)
    ? (usage.iterations as Record<string, unknown>[])
    : [];

  let components: UsageComponent[];
  let cacheSplitAssumed: boolean;

  if (iterationsRaw.length > 0) {
    cacheSplitAssumed = false;
    components = iterationsRaw.map((it) => {
      const { component, cacheSplitAssumed: assumed } = usageLikeToComponent(it, topModel);
      if (assumed) cacheSplitAssumed = true;
      return component;
    });
  } else {
    const { component, cacheSplitAssumed: assumed } = usageLikeToComponent(usage, topModel);
    components = [component];
    cacheSplitAssumed = assumed;
  }

  let reasoningClamped = false;
  const thinking = numOrUndef(
    (usage.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens
  );
  if (thinking !== undefined && components.length > 0) {
    const last = components[components.length - 1]!;
    last.tokens.reasoning = Math.min(thinking, last.tokens.output);
    if (thinking > last.tokens.output) reasoningClamped = true;
  }

  return { components, cacheSplitAssumed, reasoningClamped };
}

// ── Line -> UsageEvent ──────────────────────────────────────────────────────────────────────

/** Returns null when the line should not become a UsageEvent at all: synthetic model or
 * all-zero usage across every token field of every component (DESIGN §4.1 "Skip
 * `message.model === '<synthetic>'` and all-zero usage"). */
function buildUsageEvent(
  line: Record<string, unknown>,
  message: Record<string, unknown>,
  usage: Record<string, unknown>,
  file: ClaudeFileRef,
  ctx: IngestContext
): UsageEvent | null {
  const topModel = typeof message.model === 'string' ? message.model : 'unknown';
  if (topModel === SYNTHETIC_MODEL) return null;

  const { components, cacheSplitAssumed, reasoningClamped } = buildComponents(usage, topModel);
  const tokens = sumTokens(components);
  const allZero =
    tokens.inputFresh === 0 &&
    tokens.cacheWrite5m === 0 &&
    tokens.cacheWrite1h === 0 &&
    (tokens.cacheWriteUnassigned ?? 0) === 0 &&
    tokens.cacheRead === 0 &&
    tokens.output === 0;
  if (allZero) return null;

  const ts = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;

  const messageId = strOrUndef(message.id);
  const requestId = strOrUndef(line.requestId);
  const sessionIdField = strOrUndef(line.sessionId) ?? '';
  const uuid = strOrUndef(line.uuid) ?? '';
  const id = messageId
    ? `claude:${messageId}`
    : requestId
      ? `claude:${requestId}`
      : `claude:${sessionIdField}+${uuid}`;

  // Primary model = the last component's model (types.ts UsageEvent doc comment) — for an
  // iterations event this is the model that actually produced the final response (e.g. the
  // opus-4-8 fallback), matching what top-level usage/message.model would already say anyway.
  const model = components[components.length - 1]!.model;
  const provider = ctx.pricing.providerOf(model);

  const speedRaw = usage.speed;
  const speedAssumed = speedRaw !== 'standard' && speedRaw !== 'fast';
  const speed: 'standard' | 'fast' = speedAssumed ? 'standard' : (speedRaw as 'standard' | 'fast');

  const thinking = detectLineThinking(message, usage);

  const flags: EventFlag[] = [];
  if (cacheSplitAssumed) flags.push('cacheSplitAssumed');
  if (speedAssumed) flags.push('speedAssumed');
  if (reasoningClamped) flags.push('reasoningClamped');
  if (provider === 'local') flags.push('localViaClaudeJsonl');
  if (thinking === null) flags.push('thinkingUnknown');

  const priceResult = measure('price.event', () => ctx.pricing.priceEvent({ components, inferenceGeo: strOrUndef(usage.inference_geo) }));
  for (const f of priceResult.flags) if (!flags.includes(f)) flags.push(f);
  flags.push(...countEvidenceFlags(components));
  const valueResult = measure('units.valuation', () => ctx.valuationEngine.valueForEvent({ components, effort: strOrUndef(line.effort), thinking }));

  const event: UsageEvent = {
    id,
    host: ctx.host,
    source: 'claude',
    ...(uuid ? { collectorActivityUuid: uuid } : {}),
    ...(!messageId && !requestId && uuid ? { collectorFallbackUuidIdentity: true } : {}),
    ts,
    tsSource: 'line',
    sessionId: sessionIdField,
    parentSessionId: file.kind === 'subagent' ? file.parentUuid : undefined,
    isSubagent: file.kind === 'subagent',
    project: strOrUndef(line.cwd),
    gitBranch: strOrUndef(line.gitBranch),
    entrypoint: strOrUndef(line.entrypoint),
    model,
    provider,
    effort: strOrUndef(line.effort),
    thinking,
    speed,
    serviceTier: strOrUndef(usage.service_tier),
    inferenceGeo: strOrUndef(usage.inference_geo),
    components,
    tokens,
    flags,
    apiEquivUsd: priceResult.usd,
    priceStatus: priceResult.status,
    priceVersion: ctx.pricing.version,
    reservedValue: valueResult.reservedValue,
    ucuRateStatus: valueResult.status,
    eacsDefSha256: ctx.valuationEngine.defSha256,
  };
  return event;
}

// ── Collector ───────────────────────────────────────────────────────────────────────────────

export interface ClaudeCollectorOptions {
  /** Largest line buffered in one read. A file whose next line exceeds this is held (not ingested). */
  maxLineBytes?: number;
  /** Elapsed-time budget between yields in the file loop (default YIELD_BUDGET_MS). */
  yieldBudgetMs?: number;
  /** Clock for the yield budget (default performance.now). Tests inject a deterministic clock. */
  monotonicNow?: () => number;
}

/** The stat identity a cursor row was last confirmed at. */
type FileIdentity = Pick<SafeStat, 'size' | 'mtimeMs' | 'ino'>;

export class ClaudeCollector implements Collector {
  readonly name = 'claude';
  private readonly maxLineBytes: number;
  private readonly yieldBudgetMs: number;
  private readonly monotonicNow: () => number;
  /**
   * Files the previous completed scan of `unchangedStore` found fully read (offset at EOF, no hold), keyed by path, with
   * the identity their cursor row holds. A file whose stat still matches is skipped without its cursor read: the read would
   * return that same row, and the loop would `continue` without a write. Claude rows are written only by the Claude
   * collector (capture-holds.ts), and a file it changes is dropped from here first. A row edited by another writer while
   * the stat is unchanged is not seen until this instance is replaced (for example a daemon restart).
   */
  private unchanged = new Map<string, FileIdentity>();
  private unchangedStore: IngestContext['store'] | null = null;

  constructor(opts: ClaudeCollectorOptions = {}) {
    const requested = opts.maxLineBytes;
    const valid = Number.isSafeInteger(requested) && requested! > 0 ? requested! : MAX_LINE_BYTES;
    this.maxLineBytes = Math.max(READ_WINDOW_BYTES, valid);
    this.yieldBudgetMs = opts.yieldBudgetMs ?? YIELD_BUDGET_MS;
    this.monotonicNow = opts.monotonicNow ?? (() => performance.now());
  }

  async scan(ctx: IngestContext): Promise<IngestStats> {
    const startedAt = ctx.now();
    const warnings: string[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let eventsEmitted = 0;
    let bytesRead = 0;

    const roots = resolveClaudeRoots(ctx.config);
    // The walk awaits each directory read off the main thread and may also yield between reads (see
    // walkClaudeRootsYielding). Its profiling segment covers only the synchronous runs between those awaits, so
    // `claude.walk` is never a span across an await.
    const walkPacer = new YieldPacer(this.yieldBudgetMs, FILES_PER_YIELD, this.monotonicNow);
    const walkSync = new SyncSegment('claude.walk');
    const { files, skipped } = await walkClaudeRootsYielding(roots, {
      due: () => walkPacer.due(),
      yieldNow: async () => {
        await awaitOutside(walkSync, yieldToEventLoop);
        walkPacer.yielded();
      },
      aroundIo: (wait) => awaitOutside(walkSync, wait),
    });
    walkSync.close();

    for (const s of skipped) {
      measure('claude.record_skipped', () => ctx.store.recordSkipped(s.path, s.reason));
      filesSkipped++;
    }

    if (this.unchangedStore !== ctx.store) {
      this.unchanged = new Map();
      this.unchangedStore = ctx.store;
    }
    // Replaced only when the scan completes, so it holds just the files this scan saw. A file that misses is deleted from
    // `previous` at once, so a scan that throws never leaves a stale entry behind.
    const previous = this.unchanged;
    const current = new Map<string, FileIdentity>();

    // Yield on elapsed time as well as on file count (see YieldPacer). The profiling segment covers only synchronous
    // work: it is paused at every await in this loop, so an awaited yield or I/O wait is never recorded as work.
    const pacer = new YieldPacer(this.yieldBudgetMs, FILES_PER_YIELD, this.monotonicNow);
    const fileSync = new SyncSegment('claude.file_sync');
    for (const file of files) {
      if (pacer.due()) {
        await awaitOutside(fileSync, yieldToEventLoop);
        pacer.yielded();
      }
      let stat: SafeStat;
      try {
        // bigint stat → safe-integer ino (NTFS file ids exceed 2^53; DESIGN §15.9.6).
        const metadataWait = intervalBegin('claude.stat_io');
        try { stat = await awaitOutside(fileSync, () => statSafeAsync(file.path)); }
        finally { intervalEnd(metadataWait); }
      } catch (err) {
        ctx.store.recordSkipped(file.path, 'unreadable');
        filesSkipped++;
        warnings.push(`stat failed: ${file.path}: ${String(err)}`);
        ctx.log('warn', 'claude: stat failed', { path: file.path, error: String(err) });
        continue;
      }

      const known = previous.get(file.path);
      if (known && sameFileIdentity(known, stat)) {
        filesScanned++;
        current.set(file.path, known);
        continue;
      }
      previous.delete(file.path);

      const prevState = measure('claude.get_state', () => ctx.store.getState(file.path));
      const inoChanged =
        prevState?.ino !== undefined && prevState.ino !== stat.ino;
      const shrunk = prevState !== undefined && stat.size < prevState.offset;
      const offset = !prevState || inoChanged || shrunk ? 0 : prevState.offset;

      filesScanned++;
      if (offset >= stat.size) {
        // Nothing new; still persist the current stat so a later shrink/inode-change is detected
        // against up-to-date size/mtime, not stale values from long ago.
        if (!prevState || prevState.size !== stat.size || prevState.mtimeMs !== stat.mtimeMs || prevState.ino !== stat.ino) {
          measure('claude.set_state', () => ctx.store.setState({ key: file.path, size: stat.size, mtimeMs: stat.mtimeMs, offset, ino: stat.ino }));
        }
        current.set(file.path, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
        continue;
      }

      // Still held at the same over-cap line under the same cap, file unchanged: report again without
      // re-reading it. The hold is persisted, so this also holds after a restart.
      const hold = readClaudeHold(prevState?.extra);
      const storedHold = readClaudeStoredEvidenceHold(prevState?.extra);
      if (
        prevState && hold && hold.maxLineBytes === this.maxLineBytes &&
        prevState.offset === offset && sameFileIdentity(prevState, stat)
      ) {
        warnings.push(heldWarning(file.path, this.maxLineBytes, offset));
        continue;
      }

      // Read and commit in bounded windows, yielding to the event loop after each one, so a large
      // transcript backlog cannot starve the daemon's HTTP API for the length of the whole scan.
      // Each window has at most BATCH_SIZE complete records. Activity, usage and
      // the exact byte cursor commit atomically, then yield before the next batch.
      // A failed transaction resumes at its original cursor with neither half visible.
      let windowBytes = READ_WINDOW_BYTES;
      let windowStart = offset;
      while (windowStart < stat.size) {
        let lines: string[];
        let newOffset: number;
        let prefixSha256: string | undefined;
        let batchSha256: string | undefined;
        let previousBatchPrefixMatches: boolean | undefined;
        try {
          ({ lines, newOffset, prefixSha256, batchSha256, previousBatchPrefixMatches } = measure('claude.window_read', () => readCompleteWindow(file.path, windowStart, stat.size, windowBytes,
            windowBytes >= this.maxLineBytes && windowStart + windowBytes < stat.size, stat.ino, true, BATCH_SIZE, true,
            windowStart === offset ? storedHold ?? undefined : undefined)));
        } catch (err) {
          if (err instanceof ClaudeReadChangedError) {
            // A stat/open/truncate race is retryable; leave the last verified state intact.
            // It is not a persistent unreadable-path diagnosis or a proved current cap hold.
            filesSkipped++;
            warnings.push(`read deferred after source changed: ${file.path}`);
            ctx.log('warn', 'claude: read deferred after source changed', { path: file.path });
            break;
          }
          ctx.store.recordSkipped(file.path, 'unreadable');
          filesSkipped++;
          warnings.push(`read failed: ${file.path}: ${String(err)}`);
          ctx.log('warn', 'claude: read failed', { path: file.path, error: String(err) });
          break;
        }
        if (newOffset === windowStart) {
          // No complete line in this window. Either only a partial tail is left (the writer is
          // mid-line; wait for the next scan) or a single line is longer than the window.
          if (windowStart + windowBytes >= stat.size) {
            if (windowStart === offset) {
              measure('claude.set_state', () => ctx.store.setState({ key: file.path, size: stat.size, mtimeMs: stat.mtimeMs, offset, ino: stat.ino }));
            }
            break;
          }
          if (windowBytes >= this.maxLineBytes) {
            // Over the cap: never buffer it, and never advance past it. The file is HELD at this
            // offset (incomplete capture: this line and every later record in the file wait). The
            // warning repeats on every scan until the file is resolved, e.g. by raising
            // `claude.maxLineBytes` and restarting, which resumes at this offset.
            // A growing file can retain the same blocked capped prefix. Compare every byte
            // we inspected at the cap, never just size/mtime or a sampled prefix. A legacy
            // marker without the digest cannot certify the changed file's prior prefix.
            const sameHold = prevState !== undefined && prevState.offset === windowStart
              && prevState.ino === stat.ino && stat.size >= prevState.size && hold?.maxLineBytes === this.maxLineBytes
              && hold.prefixSha256 !== undefined && hold.prefixSha256 === prefixSha256;
            const heldSince = sameHold && hold ? hold.heldSince : ctx.now();
            ctx.store.setState({
              key: file.path, size: stat.size, mtimeMs: stat.mtimeMs, offset: windowStart, ino: stat.ino,
              extra: { [CLAUDE_HOLD_KEY]: { heldSince, maxLineBytes: this.maxLineBytes, prefixSha256 } satisfies ClaudeHoldMarker },
            });
            warnings.push(heldWarning(file.path, this.maxLineBytes, windowStart));
            ctx.log('warn', 'claude: file held at over-long line', { path: file.path, offset: windowStart, maxLineBytes: this.maxLineBytes });
            break;
          }
          // Widen one doubling (capped), then yield before the next attempt.
          windowBytes = Math.min(windowBytes * 2, this.maxLineBytes);
          await awaitOutside(fileSync, yieldToEventLoop);
          continue;
        }
        windowBytes = READ_WINDOW_BYTES;
        bytesRead += newOffset - windowStart;

        const events: UsageEvent[] = [];
        const marks: ActivityMark[] = [];

        // Parsing and each write batch are synchronous. Yield every LINES_PER_YIELD lines so one large append
        // cannot hold the event loop for the whole window (a 16 MB synthetic append blocked it for about 2.9 s).
        let linesSinceYield = 0;
        let parseSpan = spanStart(); // synchronous segments between yields are timed, the yields themselves are not
        for (const raw of lines) {
          if (++linesSinceYield >= LINES_PER_YIELD) {
            linesSinceYield = 0;
            spanEnd('claude.parse_segment', parseSpan);
            await awaitOutside(fileSync, yieldToEventLoop);
            parseSpan = spanStart();
          }
          if (raw.trim().length === 0) continue;
          let obj: Record<string, unknown>;
          try {
            obj = measure('claude.json_parse', () => JSON.parse(raw) as Record<string, unknown>);
          } catch (err) {
            // Never log String(err)/err.message here: a JSON.parse SyntaxError's message can embed a
            // snippet of the offending line's text, and that line may hold prompt/response content.
            // Only the error's name (e.g. 'SyntaxError') plus the file path is safe to record.
            const errName = err instanceof Error ? err.name : 'UnknownError';
            warnings.push(`parse error in ${file.path}: ${errName}`);
            ctx.log('warn', 'claude: line parse error', { path: file.path, error: errName });
            continue;
          }

          const mark = buildActivityMark(obj, ctx.host);
          if (mark) marks.push(mark);

          if (obj.type !== 'assistant') continue;
          const message = obj.message as Record<string, unknown> | undefined;
          if (!message || typeof message !== 'object') continue;
          const usage = message.usage as Record<string, unknown> | undefined;
          if (!usage || typeof usage !== 'object') continue;

          const event = buildUsageEvent(obj, message, usage, file, ctx);
          if (!event) continue;
          events.push(event);
        }

        spanEnd('claude.parse_segment', parseSpan);
        // One bounded read window commits activity, usage and cursor together.
        // Activity establishes the recorded UUID owner before a usage join;
        // no other writer or failed batch may leave the two halves split.
        try { ctx.store.transaction(() => {
          for (const batch of chunk(marks, BATCH_SIZE)) measure('claude.record_activity', () => ctx.store.recordActivity(batch));
          for (const batch of chunk(events, BATCH_SIZE)) measure('claude.upsert_events', () => ctx.store.upsertEvents(batch));
          measure('claude.set_state', () => ctx.store.setState({
          key: file.path,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          offset: newOffset,
          ino: stat.ino,
          }));
        }); } catch (error) {
          if (!(error instanceof StoredComponentEvidenceError)) throw error;
          // The outer transaction has rolled back activity, usage and cursor together. Persist
          // only a typed hold at the last committed offset; do not overwrite the malformed row
          // or advance past the rejected batch. Other whitelisted files can still be scanned.
          const sameHold = storedHold && prevState && prevState.offset === windowStart && prevState.ino === stat.ino
            && stat.size >= prevState.size && (storedHold.batchSha256 !== undefined
              ? previousBatchPrefixMatches === true : sameFileIdentity(prevState, stat));
          const heldSince = sameHold ? storedHold.heldSince : ctx.now();
          const originalBytes = sameHold && storedHold.batchBytes !== undefined ? storedHold.batchBytes : newOffset - windowStart;
          const originalDigest = sameHold && storedHold.batchSha256 !== undefined ? storedHold.batchSha256 : batchSha256!;
          measure('claude.set_state', () => ctx.store.setState({
            key: file.path, size: stat.size, mtimeMs: stat.mtimeMs, offset: windowStart, ino: stat.ino,
            extra: { [CLAUDE_HOLD_KEY]: { heldSince, reason: 'stored-component-evidence', batchBytes: originalBytes,
              batchSha256: originalDigest } satisfies ClaudeStoredEvidenceHoldMarker },
          }));
          filesSkipped++;
          warnings.push(`incomplete capture: stored component evidence is malformed; batch held at offset ${windowStart}: ${file.path}`);
          ctx.log('warn', 'claude: batch held on malformed stored component evidence', { path: file.path, offset: windowStart });
          break;
        }
        eventsEmitted += events.length;
        windowStart = newOffset;
        await awaitOutside(fileSync, yieldToEventLoop);
      }
    }

    fileSync.close();
    this.unchanged = current;
    return {
      collector: this.name,
      filesScanned,
      filesSkipped,
      eventsEmitted,
      bytesRead,
      warnings,
      durationMs: ctx.now() - startedAt,
    };
  }
}
