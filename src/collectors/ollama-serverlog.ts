/**
 * ollama-serverlog.ts — best-effort incremental parse of Ollama's own server log
 * (DESIGN.md §4.4 + §15.3.4). Source label `ollama-log`, flag `serverlogEstimate` on every event
 * this module emits (it is always an ESTIMATE, never MEASURED — see DESIGN §15.5's status
 * ladder).
 *
 * Verified real log shape (`/opt/homebrew/var/log/ollama.log`, this host, 2026-09-26; both the
 * Homebrew 0.32.13 and Ollama.app 0.34.2 logs share this exact format since both are Go+llama.cpp
 * wrappers of the same upstream):
 *
 *   time=2026-09-26T15:39:42.982-06:00 level=INFO source=llama_server.go:1046 msg="loading model
 *     via llama-server" model=/Users/example/.ollama/models/blobs/sha256-dfd98d27342...
 *   time=2026-09-26T15:40:14.898-06:00 level=INFO source=images.go:374 msg="template selection"
 *     model=registry.ollama.ai/library/gemma4:26b selected=... (model name given directly, no
 *     manifest lookup needed — this is the PREFERRED source of model attribution; the blob-sha
 *     line is only a fallback for when no template-selection line was captured, e.g. the daemon
 *     started mid-stream)
 *   slot print_timing: id  0 | task 6 | prompt eval time =     179.18 ms /    18 tokens (...)
 *   slot print_timing: id  0 | task 6 |        eval time =     341.26 ms /    16 tokens (...)
 *   slot print_timing: id  0 | task 6 |       total time =     520.44 ms /    34 tokens
 *   slot print_timing: id  0 | task 6 |    graphs reused =          7          (ignored)
 *   slot print_timing: id  0 | task 6 | draft acceptance = 0.66667 (...)        (ignored, speculative decoding)
 *   slot print_timing: id  0 | task 6 |      acc per pos = (...)                (ignored)
 *   [GIN] 2026/09/26 - 15:40:16 | 200 |  818.697583ms |       127.0.0.1 | POST     "/api/chat"
 *
 * `print_timing` lines carry NO timestamp (llama-server runs with --no-log-timestamps —
 * confirmed via `ps` argv in spikes-2026-09-26.md S7) and no request id — only the bracketing
 * `[GIN]` access-log line (which the llama.cpp block always precedes) gives a real timestamp and
 * the request path. One `[GIN]` line for a metered path consumes exactly one pending
 * print_timing block, in file order (verified: every real print_timing block observed on this
 * host is immediately followed, a few dozen lines later, by exactly one matching GIN line before
 * the next block starts — single in-flight request per model, `OLLAMA_MAX_LOADED_MODELS=1`).
 *
 * Double-count guard (DESIGN §15.3.4, binding — supersedes the older §4.4 "±3s / prompt+eval
 * equal" text): drop a log-derived event when a proxy (`ollama-proxy`) event exists with an EQUAL
 * eval_count and an end-timestamp within ±2s — prompt counts are deliberately NOT compared
 * (spikes-2026-09-26.md, the Opus review finding: llama.cpp's print_timing prompt count only
 * covers the *uncached* tokens it actually evaluated, so it disagrees with the proxy's
 * prompt_eval_count whenever the prompt cache is warm — matching on eval_count + time is the
 * reliable half of the pair).
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import type {
  Collector,
  HostLabel,
  IngestContext,
  IngestState,
  IngestStats,
  TokenCounts,
  UsageComponent,
  UsageEvent,
} from '../core/types.js';
import { buildManifestMap, probeOllama, type OllamaProbeResult } from './ollama-probe.js';
import { safeIno, safeStatNumber, statSafe, UnsafeStatMetadataError } from './fswalk.js';

// ── Line parsers ─────────────────────────────────────────────────────────────

export interface ModelLoadLine {
  kind: 'load';
  ts: number; // epoch ms
  blobSha: string; // no 'sha256:' prefix
}

export interface TemplateSelectionLine {
  kind: 'template';
  ts: number;
  model: string; // canonicalized the same way as ollama-probe's manifest names
}

export interface PrintTimingLine {
  kind: 'prompt-eval' | 'eval' | 'total' | 'other';
  taskId: number;
  ms: number;
  tokens: number;
}

export interface GinLine {
  kind: 'gin';
  ts: number; // epoch ms, from the log's own local-time-with-offset timestamp
  statusCode: number;
  durationMs: number;
  method: string;
  path: string;
}

export type ParsedLine = ModelLoadLine | TemplateSelectionLine | PrintTimingLine | GinLine | null;

// Anchored to the REAL, fixed field order (`time=... level=... source=... msg="..." model=...`,
// see the header comment's verified examples) with every wildcard bounded to \S — never `.*`.
// This is a deliberate hardening against log injection: a malicious prompt echoed into an
// unrelated line's `prompt="..."` value can contain the literal text `msg="template selection"
// model=EVIL"`, and an unbounded `.*` after `msg=` would happily skip PAST that line's own real
// `msg=` field to match the attacker-controlled one later in the line. Anchoring to the exact
// `level=... source=... msg="<literal>"` sequence immediately after `time=\S+` means `model=` can
// only ever be recognized as the genuine key that follows the line's own real msg field, never as
// a substring match buried inside another field's value.
const LOAD_MODEL_RE =
  /^time=(\S+)\s+level=\S+\s+source=\S+\s+msg="loading model via llama-server"\s+model=\S*blobs[\\/]sha256[-:]([0-9a-fA-F]+)/;
const TEMPLATE_SELECTION_RE = /^time=(\S+)\s+level=\S+\s+source=\S+\s+msg="template selection"\s+model=(\S+)/;
const PRINT_TIMING_RE =
  /^slot print_timing: id\s+\d+ \| task \d+ \|\s*(prompt eval time|eval time|total time)\s*=\s*([0-9.]+)\s*ms\s*\/\s*(\d+)\s*tokens/;
const PRINT_TIMING_TASK_RE = /task (\d+)/;
const GIN_RE = /^\[GIN\]\s+(\S+)\s+-\s+(\S+)\s+\|\s*(\d+)\s*\|\s*([0-9.]+)(µs|ms|s)\s*\|\s*\S+\s*\|\s*(\S+)\s+"([^"]+)"/;

/** Canonicalizes an Ollama log's `model=` value the same way ollama-probe's manifest names are canonicalized (default registry/namespace dropped). */
export function canonicalizeLogModelName(raw: string): string {
  const parts = raw.split('/');
  if (parts[0] !== 'registry.ollama.ai') return raw;
  let rest = parts.slice(1);
  if (rest[0] === 'library') rest = rest.slice(1);
  return rest.join('/');
}

function parseGinDurationToMs(value: string, unit: string): number {
  const n = Number(value);
  if (unit === 'µs') return n / 1000;
  if (unit === 'ms') return n;
  return n * 1000; // 's'
}

/**
 * Parses `[GIN] 2026/09/26 - 15:40:16 | 200 |  818.697583ms | 127.0.0.1 | POST "/api/chat"`.
 * The date/time has NO explicit UTC offset in the log — Go's default `log.Println` local-time
 * format. `tzOffsetMinutes` (default: this process's local offset) lets tests pin a deterministic
 * offset regardless of the machine running them.
 */
export function parseLine(line: string, opts?: { tzOffsetMinutes?: number }): ParsedLine {
  // Real Ollama log lines this parser cares about are always short (a `time=...`/`[GIN]`/
  // `slot print_timing` line is well under 200 bytes). Bail out before running ANY regex on
  // anything absurdly long: this both guarantees the parse stays well under 50ms on a
  // pathological multi-hundred-KB single line, and — combined with the anchored marker regexes
  // below — closes off any attempt to hide a fake marker deep inside an oversized line.
  if (line.length > 4096) return null;

  let m = line.match(GIN_RE);
  if (m) {
    const [, datePart, timePart, statusStr, durValue, durUnit, method, reqPath] = m;
    const ts = parseGinTimestamp(datePart, timePart, opts?.tzOffsetMinutes);
    return {
      kind: 'gin',
      ts,
      statusCode: Number(statusStr),
      durationMs: parseGinDurationToMs(durValue, durUnit),
      method,
      path: reqPath,
    };
  }

  // Cheap substring fast-path before the (already-anchored) regex — avoids running the regex at
  // all on the common case of a line that doesn't contain the marker anywhere.
  if (line.includes('msg="loading model via llama-server"')) {
    m = line.match(LOAD_MODEL_RE);
    if (m) {
      const [, isoTs, sha] = m;
      return { kind: 'load', ts: Date.parse(isoTs), blobSha: sha };
    }
  }

  if (line.includes('msg="template selection"')) {
    m = line.match(TEMPLATE_SELECTION_RE);
    if (m) {
      const [, isoTs, rawModel] = m;
      return { kind: 'template', ts: Date.parse(isoTs), model: canonicalizeLogModelName(rawModel) };
    }
  }

  m = line.match(PRINT_TIMING_RE);
  if (m) {
    const [, label, msStr, tokensStr] = m;
    const taskMatch = line.match(PRINT_TIMING_TASK_RE);
    const kind = label === 'prompt eval time' ? 'prompt-eval' : label === 'eval time' ? 'eval' : 'total';
    return {
      kind,
      taskId: taskMatch ? Number(taskMatch[1]) : -1,
      ms: Number(msStr),
      tokens: Number(tokensStr),
    };
  }

  return null;
}

/** `2026/09/26 - 15:40:16` (Go's default local-time log format, no offset) -> epoch ms. */
export function parseGinTimestamp(datePart: string, timePart: string, tzOffsetMinutes?: number): number {
  const [y, mo, d] = datePart.split('/').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  if (tzOffsetMinutes != null) {
    // Construct as UTC then shift by the given offset (minutes EAST of UTC, e.g. Denver DST = -360).
    const utcMs = Date.UTC(y, mo - 1, d, h, mi, s);
    return utcMs - tzOffsetMinutes * 60_000;
  }
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

// ── The metered request paths this collector attributes ────────────────────

const METERED_PATHS = new Set(['/api/chat', '/api/generate', '/v1/chat/completions', '/v1/completions']);

export interface ServerLogRequestBlock {
  model: string;
  promptEvalCount: number;
  evalCount: number;
  totalMs: number;
  endTs: number; // from the bracketing GIN line
  durationMs: number; // from the bracketing GIN line (more reliable than summing print_timing ms, which excludes queueing)
  path: string;
}

export interface ServerLogParseState {
  /** Carried across incremental parse calls: file offset already consumed. */
  offset: number;
  currentModel: string | null;
  pendingPromptTokens: number | null;
  pendingEvalTokens: number | null;
  pendingTotalMs: number | null;
  /** Parsed blocks held until dual-capture proxy and queue evidence settles. */
  pendingBlocks?: ServerLogRequestBlock[];
  /** Sticky signal if unread source bytes may have changed before they were parsed. */
  historyIncomplete?: boolean;
  /** The bounded dual-capture pending queue prevented this tail from advancing. */
  pendingLimitReached?: boolean;
  /** SHA-256 of a bounded consumed-prefix window used to detect same-inode rewrites. */
  cursorGuard?: string | null;
}

export function initialServerLogState(): ServerLogParseState {
  return { offset: 0, currentModel: null, pendingPromptTokens: null, pendingEvalTokens: null, pendingTotalMs: null, pendingBlocks: [], historyIncomplete: false, pendingLimitReached: false, cursorGuard: null };
}

const SERVERLOG_CURSOR_GUARD_BYTES = 16 * 1024;

async function readHandleRange(handle: Awaited<ReturnType<typeof fsp.open>>, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, start + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

async function hashCursorPrefix(handle: Awaited<ReturnType<typeof fsp.open>>, offset: number): Promise<string | null> {
  const length = Math.min(offset, SERVERLOG_CURSOR_GUARD_BYTES);
  if (length <= 0) return null;
  const bytes = await readHandleRange(handle, offset - length, length);
  return createHash('sha256').update(bytes).digest('hex');
}

function resetServerLogCursor(state: ServerLogParseState, markIncomplete: boolean, deferBlocks: boolean | undefined): void {
  if (markIncomplete) state.historyIncomplete = true;
  state.offset = 0;
  state.currentModel = null;
  state.pendingPromptTokens = null;
  state.pendingEvalTokens = null;
  state.pendingTotalMs = null;
  state.cursorGuard = null;
  if (deferBlocks) state.pendingLimitReached = false;
}

/**
 * Parses a batch of complete log lines against `state` (mutated in place) and a shared
 * `blobShaToModel` map (from ollama-probe's `buildManifestMap`). Returns every fully-attributed
 * request block found (bracketed by a metered-path GIN line). Lines for non-metered paths (e.g.
 * `/api/ps`, `/api/tags`, `HEAD /`) are consumed (advance state) but never pop the pending block —
 * they have no print_timing block of their own, so nothing is at risk of being mis-attributed.
 */
export function parseServerLogLines(
  lines: string[],
  state: ServerLogParseState,
  blobShaToModel: ReadonlyMap<string, string>,
  opts?: { tzOffsetMinutes?: number }
): ServerLogRequestBlock[] {
  const blocks: ServerLogRequestBlock[] = [];
  for (const rawLine of lines) {
    const parsed = parseLine(rawLine, opts);
    if (!parsed) continue;
    switch (parsed.kind) {
      case 'template':
        state.currentModel = parsed.model;
        break;
      case 'load': {
        const mapped = blobShaToModel.get(parsed.blobSha);
        if (mapped) state.currentModel = mapped;
        break;
      }
      case 'prompt-eval':
        state.pendingPromptTokens = parsed.tokens;
        break;
      case 'eval':
        state.pendingEvalTokens = parsed.tokens;
        break;
      case 'total':
        state.pendingTotalMs = parsed.ms;
        break;
      case 'gin': {
        if (!METERED_PATHS.has(parsed.path)) break;
        if (state.pendingPromptTokens == null || state.pendingEvalTokens == null) break; // nothing pending — skip, best-effort
        blocks.push({
          model: state.currentModel ?? 'unknown',
          promptEvalCount: state.pendingPromptTokens,
          evalCount: state.pendingEvalTokens,
          totalMs: state.pendingTotalMs ?? parsed.durationMs,
          endTs: parsed.ts,
          durationMs: parsed.durationMs,
          path: parsed.path,
        });
        state.pendingPromptTokens = null;
        state.pendingEvalTokens = null;
        state.pendingTotalMs = null;
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

// ── Double-count guard vs proxy events (DESIGN §15.3.4) ─────────────────────

export interface ProxyEventForGuard {
  evalCount: number; // = tokens.output of an 'ollama-proxy' UsageEvent
  endTs: number; // ts + durationMs of that event (its response-complete time)
  /** The primary Ollama engine or a legacy event whose single-engine identity was not recorded. */
  engine?: string | null;
}

/**
 * True when `block` should be DROPPED because an equal-eval_count proxy event ended within
 * ±windowMs of it (default 2000ms per DESIGN §15.3.4). Pure and independently testable — the
 * mutation test re-introduces "prompt-count must also match" (the old §4.4 text) and "±3000ms" to
 * prove this exact guard, not a coincidentally-passing one.
 */
export function isDoubleCounted(
  block: Pick<ServerLogRequestBlock, 'evalCount' | 'endTs'>,
  proxyEvents: readonly ProxyEventForGuard[],
  windowMs = 2000
): boolean {
  return proxyEvents.some(
    (p) => (p.engine === undefined || p.engine === null || p.engine === 'ollama')
      && p.evalCount === block.evalCount && Math.abs(p.endTs - block.endTs) <= windowMs
  );
}

// ── UsageEvent construction ──────────────────────────────────────────────────

/**
 * Deterministic event id: the same log block always maps to the same id, so a re-read (log
 * rotation/truncation reset, a fresh cursor, two probe entries resolving to the same file) is
 * absorbed by the store's id-keyed upsert instead of double counting. Components: the GIN
 * end timestamp (ms) plus the block's prompt/eval counts — two distinct requests would have to end
 * in the same millisecond with identical counts to collide (then they are merged, i.e. at worst an
 * undercount of an indistinguishable duplicate — never a double count).
 */
export function makeServerLogEventId(
  host: HostLabel,
  block: Pick<ServerLogRequestBlock, 'endTs' | 'promptEvalCount' | 'evalCount'>
): string {
  return `ollama-log:${host}:${block.endTs}:${block.promptEvalCount}:${block.evalCount}`;
}

export function buildServerLogUsageEvent(host: HostLabel, block: ServerLogRequestBlock): UsageEvent {
  const tokens: TokenCounts = {
    inputFresh: block.promptEvalCount, // no cache-hit signal in the log (DESIGN §15.3.4 note); all prompt tokens counted as fresh
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: block.evalCount,
    reasoning: 0,
  };
  const component: UsageComponent = { model: block.model, tokens };
  return {
    id: makeServerLogEventId(host, block),
    host,
    source: 'ollama-log',
    ts: block.endTs - block.durationMs,
    tsSource: 'frozen-line', // no true request-start time in the log; end minus GIN duration is our best estimate
    sessionId: `serverlog:${block.model}:${new Date(block.endTs).toISOString().slice(0, 10)}`,
    isSubagent: false,
    model: block.model,
    provider: 'local',
    // Thinking mode is NOT determinable per request from this log (founder req. 2026-09-27,
    // checked live on this host): the only "thinking" evidence the Homebrew/Ollama.app server log
    // exposes is per-MODEL-LOAD, not per-request — `srv init: init: chat template, thinking = 1`
    // and the template-selection line's `chat_template=[...thinking...]` both fire once when a
    // model is loaded, not once per call, and say only that the model's template SUPPORTS
    // thinking, not whether any given request used it. The log's own `<think>`/`</think>` markers
    // that appear elsewhere are raw prompt/response content this collector must never parse or
    // persist (DESIGN §15.9.10) and aren't attributable to a specific GIN-bracketed request either.
    // So: always null + `thinkingUnknown` here; `doctor` surfaces the count and this reason.
    thinking: null,
    components: [component],
    tokens,
    durationMs: block.durationMs,
    flags: ['serverlogEstimate', 'thinkingUnknown'],
    apiEquivUsd: null,
    priceStatus: 'UNPRICED',
    priceVersion: '',
    reservedValue: null,
    ucuRateStatus: 'NONE',
    eacsDefSha256: '',
  };
}

// ── Incremental file reader ──────────────────────────────────────────────────

/** Proxy events can start long before they end; the guard looks back this far for their START. */
export const PROXY_GUARD_LOOKBACK_MS = 60 * 60 * 1000;
/** ± window of the double-count guard (DESIGN §15.3.4). */
export const GUARD_WINDOW_MS = 2000;
/** Max bytes consumed per tail call (a large first ingest continues on the next scan). */
export const MAX_TAIL_BYTES = 32 * 1024 * 1024;
/** Bound persisted holdback state if the local ledger/backlog cannot settle recent blocks. */
export const MAX_PENDING_SERVERLOG_BLOCKS = 10_000;
/** Small dual-capture chunks keep a single parse call from overshooting the pending-block bound. */
const DUAL_CAPTURE_TAIL_BYTES = 256 * 1024;

/** IngestState.ino is the shared safe-integer projection used by every path stat and SQLite cursor. */
function serverLogFileInfo(stat: { size: bigint; mtimeMs: bigint; ino: bigint }): { size: number; mtimeMs: number; ino: number } | undefined {
  const size = safeStatNumber(stat.size);
  const mtimeMs = safeStatNumber(stat.mtimeMs);
  if (size === undefined || size < 0 || mtimeMs === undefined) return undefined;
  return { size, mtimeMs, ino: safeIno(stat.ino) };
}

/**
 * Reads new complete lines appended to `logPath` since `state.offset` (at most MAX_TAIL_BYTES per
 * call), parses them, applies the double-count guard, and returns the surviving events plus the
 * updated state to persist (IngestState.extra — this collector's own resume cursor).
 *
 * `getRecentProxyEvents(windowStart, windowEnd)` must return every `ollama-proxy` event whose END
 * time (ts + durationMs) lies in [windowStart, windowEnd]. It is called ONCE per tail call with
 * the window spanning every parsed block ± GUARD_WINDOW_MS; each block is then checked against
 * that list with `isDoubleCounted`. The Collector below implements it with
 * `LedgerWriter.recentEvents` (DESIGN §15.9.6).
 */
export async function tailServerLog(
  logPath: string,
  state: ServerLogParseState,
  blobShaToModel: ReadonlyMap<string, string>,
  getRecentProxyEvents: (windowStartTs: number, windowEndTs: number) => ProxyEventForGuard[],
  opts?: { tzOffsetMinutes?: number; host?: HostLabel; maxBytes?: number; deferBlocks?: boolean; maxPendingBlocks?: number; unreadBytesBeforeTailStat?: boolean; expectedInode?: number }
): Promise<{ events: UsageEvent[]; state: ServerLogParseState; bytesRead: number; fileInfo?: { size: number; mtimeMs: number; ino: number } }> {
  if (!Number.isSafeInteger(state.offset) || state.offset < 0) {
    throw new RangeError('unsupported server-log cursor offset; preserving the existing cursor');
  }
  const originalKeys = new Set(Object.keys(state));
  const originalState = { ...state, ...(state.pendingBlocks ? { pendingBlocks: [...state.pendingBlocks] } : {}) };
  const restoreUnsupportedState = (): void => {
    const mutable = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(mutable)) if (!originalKeys.has(key)) delete mutable[key];
    Object.assign(state, originalState);
  };
  let fh: Awaited<ReturnType<typeof fsp.open>>;
  try {
    fh = await fsp.open(logPath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { events: [], state, bytesRead: 0 };
  }
  try {
    // Stat the opened handle, not just the path: rotation can replace the path between the
    // collector's statSafe call and this open, leaving an old cursor pointed into a new inode.
    // Use the exact handle identity, then project it to the same safe ID as statSafe and IngestState.
    const opened = await fh.stat({ bigint: true });
    const fileInfo = serverLogFileInfo(opened);
    if (!fileInfo) {
      restoreUnsupportedState();
      throw new RangeError('unsupported server-log size or mtime; preserving the existing cursor');
    }
    if (opts?.expectedInode !== undefined && fileInfo.ino !== opts.expectedInode) {
      resetServerLogCursor(state, !!opts.deferBlocks && !!opts.unreadBytesBeforeTailStat, opts.deferBlocks);
    }
    const size = fileInfo.size;
    if (size < state.offset) {
      // File truncated/rotated — restart from the top. Deterministic event ids make a re-read of
      // blocks already ingested idempotent in the store.
      resetServerLogCursor(state, !!opts?.deferBlocks && !!opts.unreadBytesBeforeTailStat, opts?.deferBlocks);
    }
    const readOffset = state.offset;
    const cursorGuardAtOpen = await hashCursorPrefix(fh, readOffset);
    if (state.cursorGuard && state.cursorGuard !== cursorGuardAtOpen) {
      const changed = await fh.stat({ bigint: true });
      const changedFileInfo = serverLogFileInfo(changed);
      if (!changedFileInfo) {
        restoreUnsupportedState();
        throw new RangeError('unsupported server-log size or mtime; preserving the existing cursor');
      }
      resetServerLogCursor(state, !!opts?.deferBlocks && !!opts.unreadBytesBeforeTailStat, opts?.deferBlocks);
      return { events: [], state, bytesRead: 0, fileInfo: changedFileInfo };
    }
    if (!state.cursorGuard) state.cursorGuard = cursorGuardAtOpen;
    if (size === state.offset) {
      if (opts?.deferBlocks) state.pendingLimitReached = false;
      return { events: [], state, bytesRead: 0, fileInfo };
    }

    let length = Math.min(size - state.offset, opts?.maxBytes ?? MAX_TAIL_BYTES);
    let buf = Buffer.alloc(length);
    let { bytesRead } = await fh.read(buf, 0, length, state.offset);
    // Split on the raw 0x0A byte (never inside a multi-byte UTF-8 sequence).
    let lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline === -1 && opts?.deferBlocks && length < Math.min(size - state.offset, MAX_TAIL_BYTES)) {
      length = Math.min(size - state.offset, MAX_TAIL_BYTES);
      buf = Buffer.alloc(length);
      ({ bytesRead } = await fh.read(buf, 0, length, state.offset));
      lastNewline = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
    }
    // The path may be truncated after the handle stat but before its bounded read. In that
    // window the initial size still looks current, so the pre-read size/offset check above
    // cannot detect that unread dual-capture bytes disappeared. Recheck the same opened inode
    // and a bounded consumed-prefix fingerprint before parsing; discard this batch and restart
    // from byte zero on the next scan if the file changed under the saved cursor.
    const afterRead = await fh.stat({ bigint: true });
    const readFileInfo = serverLogFileInfo(afterRead);
    if (!readFileInfo) {
      restoreUnsupportedState();
      throw new RangeError('unsupported server-log size or mtime; preserving the existing cursor');
    }
    const cursorGuardAfterRead = await hashCursorPrefix(fh, readOffset);
    const cursorChangedDuringRead = cursorGuardAtOpen !== null && cursorGuardAfterRead !== cursorGuardAtOpen;
    const sameOpenedInode = afterRead.ino === opened.ino;
    const fileChangedDuringRead = sameOpenedInode && (
      afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
    );
    // A concurrent append is safe if the bytes already read are unchanged. Re-read only the
    // bounded dual-capture batch when metadata changed so a larger rewrite of the unread window
    // cannot hide behind a preserved consumed-prefix fingerprint.
    const readWindowChanged = !!opts?.deferBlocks && bytesRead > 0 && fileChangedDuringRead
      && !(await readHandleRange(fh, readOffset, bytesRead)).equals(buf.subarray(0, bytesRead));
    const sameInodeReadRace = sameOpenedInode && (
      afterRead.size < opened.size
      || (afterRead.size === opened.size
        && (afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs))
    );
    if (sameInodeReadRace || cursorChangedDuringRead || readWindowChanged) {
      resetServerLogCursor(state, !!opts?.deferBlocks && !!opts.unreadBytesBeforeTailStat, opts?.deferBlocks);
      return { events: [], state, bytesRead: 0, fileInfo: readFileInfo };
    }
    if (lastNewline === -1) {
      state.cursorGuard = cursorGuardAfterRead;
      return { events: [], state, bytesRead: 0, fileInfo: readFileInfo }; // no complete line yet
    }
    const bytesConsumed = lastNewline + 1;
    const lines = buf.subarray(0, lastNewline).toString('utf8').split('\n');
    const beforeParse = opts?.deferBlocks
      ? { ...state, pendingBlocks: [...(state.pendingBlocks ?? [])] }
      : undefined;
    state.offset += bytesConsumed;

    const blocks = parseServerLogLines(lines, state, blobShaToModel, opts);
    const events: UsageEvent[] = [];
    if (opts?.deferBlocks) {
      const pending = [...(state.pendingBlocks ?? [])];
      const pendingIds = new Set(pending.map((block) => makeServerLogEventId(opts.host ?? 'unknown', block)));
      for (const block of blocks) {
        const id = makeServerLogEventId(opts.host ?? 'unknown', block);
        if (!pendingIds.has(id)) {
          pending.push(block);
          pendingIds.add(id);
        }
      }
      const limit = opts.maxPendingBlocks ?? MAX_PENDING_SERVERLOG_BLOCKS;
      if (pending.length > limit) {
        Object.assign(state, beforeParse);
        state.pendingLimitReached = true;
        return { events, state, bytesRead: 0, fileInfo };
      }
      state.pendingBlocks = pending;
      state.pendingLimitReached = false;
      state.cursorGuard = await hashCursorPrefix(fh, state.offset);
      return { events, state, bytesRead: bytesConsumed, fileInfo: readFileInfo };
    }
    if (blocks.length > 0) {
      let minEnd = Infinity;
      let maxEnd = -Infinity;
      for (const b of blocks) {
        if (b.endTs < minEnd) minEnd = b.endTs;
        if (b.endTs > maxEnd) maxEnd = b.endTs;
      }
      const recent = getRecentProxyEvents(minEnd - GUARD_WINDOW_MS, maxEnd + GUARD_WINDOW_MS);
      for (const block of blocks) {
        if (isDoubleCounted(block, recent, GUARD_WINDOW_MS)) continue;
        events.push(buildServerLogUsageEvent(opts?.host ?? 'unknown', block));
      }
    }
    state.cursorGuard = await hashCursorPrefix(fh, state.offset);
    return { events, state, bytesRead: bytesConsumed, fileInfo: readFileInfo };
  } finally {
    await fh.close();
  }
}

// ── The Collector (DESIGN §4.4, §15.3.4) ─────────────────────────────────────

export interface OllamaServerlogCollectorOptions {
  /** Overrides buildManifestMap's default ~/.ollama/models (tests never read the real catalog). */
  modelsDir?: string;
  /** Injected probe (tests); default: the live `probeOllama` against config.local.ollamaUpstream. */
  probe?: (upstream: string) => Promise<OllamaProbeResult>;
}

/**
 * `Collector` over Ollama's own server log(s). Log path: `config.local.serverLogPath` when set
 * (then only the model manifests are read — no process discovery, no HTTP probe); otherwise every
 * log `probeOllama` resolves for the live servers behind the configured port, deduped (M4a's
 * Homebrew server answers on IPv4 and IPv6 from one process and one log). The parse cursor is
 * persisted per log path via IngestState.extra. The double-count guard reads recent
 * `ollama-proxy` events through `ctx.store.recentEvents` (no raw SQL outside the ledger).
 */
export class OllamaServerlogCollector implements Collector {
  readonly name = 'ollama-serverlog';

  constructor(private readonly opts: OllamaServerlogCollectorOptions = {}) {}

  async scan(ctx: IngestContext): Promise<IngestStats> {
    const t0 = ctx.now();
    const stats: IngestStats = {
      collector: this.name,
      filesScanned: 0,
      filesSkipped: 0,
      eventsEmitted: 0,
      bytesRead: 0,
      warnings: [],
      durationMs: 0,
    };

    const configuredPath = ctx.config.local.serverLogPath;
    let candidatePaths: string[];
    let manifests: ReadonlyMap<string, string>;
    if (configuredPath) {
      candidatePaths = [configuredPath];
      manifests = await buildManifestMap(this.opts.modelsDir);
    } else {
      const probe = this.opts.probe
        ? await this.opts.probe(ctx.config.local.ollamaUpstream)
        : await probeOllama({ ollamaUpstream: ctx.config.local.ollamaUpstream, modelsDir: this.opts.modelsDir });
      candidatePaths = probe.servers.filter((s) => s.log.available && s.log.path).map((s) => s.log.path as string);
      manifests = probe.manifests;
    }
    const paths = [...new Set(candidatePaths)];

    const proxyEventsEndingIn = (windowStart: number, windowEnd: number): ProxyEventForGuard[] => {
      const out: ProxyEventForGuard[] = [];
      const windowStartTs = windowStart - PROXY_GUARD_LOOKBACK_MS;
      for (const e of ctx.store.recentEvents('ollama-proxy', windowStartTs, windowEnd)) {
        const endTs = e.ts + (e.durationMs ?? 0);
        if (endTs >= windowStart && endTs <= windowEnd) out.push({ evalCount: e.tokens.output, endTs, engine: e.engine ?? null });
      }
      for (const e of ctx.pendingProxyEvents?.(windowStartTs, windowEnd) ?? []) {
        const endTs = e.ts + (e.durationMs ?? 0);
        if (endTs >= windowStart && endTs <= windowEnd) out.push({ evalCount: e.outputTokens, endTs, engine: e.engine ?? null });
      }
      return out;
    };

    for (const logPath of paths) {
      stats.filesScanned++;
      const stateKey = `ollama-serverlog:${logPath}`;
      let saved: IngestState | undefined;
      try {
        saved = ctx.store.getState(stateKey);
      } catch {
        stats.filesSkipped++;
        stats.warnings.push(`${logPath}: unsupported saved server-log cursor; preserving its cursor and history.`);
        continue;
      }
      if (saved !== undefined && !isValidServerLogOuterCursor(saved)) {
        stats.filesSkipped++;
        stats.warnings.push(`${logPath}: unsupported saved server-log cursor; preserving its cursor and history.`);
        continue;
      }
      const savedExtra = saved?.extra;
      if (savedExtra !== undefined && savedExtra !== null && !isParseState(savedExtra)) {
        stats.filesSkipped++;
        stats.warnings.push(`${logPath}: unsupported server-log cursor metadata; preserving the saved cursor and history.`);
        continue;
      }
      if (saved && isParseState(savedExtra) && saved.offset !== savedExtra.offset) {
        stats.filesSkipped++;
        stats.warnings.push(`${logPath}: inconsistent server-log cursor metadata; preserving the saved cursor and history.`);
        continue;
      }
      const parseState: ServerLogParseState = isParseState(savedExtra)
        ? { ...initialServerLogState(), ...savedExtra, pendingBlocks: savedExtra.pendingBlocks ?? [] }
        : initialServerLogState();
      // A replaced file (new inode, e.g. rotation that happens to grow past the old offset) restarts at 0.
      let st: { size: number; mtimeMs: number; ino: number } | undefined;
      try {
        st = statSafe(logPath);
      } catch (error) {
        if (error instanceof UnsafeStatMetadataError) {
          stats.filesSkipped++;
          stats.warnings.push(`${logPath}: unsupported file cursor metadata; preserving the saved cursor and history.`);
          continue;
        }
        st = undefined;
      }
      const bothCapture = ctx.config.local.capture === 'both';
      const priorUnread = bothCapture && typeof saved?.size === 'number' && saved.offset < saved.size;
      const unreadBytesBeforeTailStat = priorUnread || (bothCapture && !!st && saved?.ino === st.ino && st.size > saved.offset);
      const inodeReplaced = !!st && saved?.ino !== undefined && saved.ino !== st.ino;
      const fileTruncated = !!st && saved?.ino === st.ino && st.size < saved.offset;
      if (priorUnread && (inodeReplaced || fileTruncated)) parseState.historyIncomplete = true;
      if (inodeReplaced) {
        const pendingBlocks = parseState.pendingBlocks ?? [];
        const historyIncomplete = parseState.historyIncomplete === true;
        Object.assign(parseState, initialServerLogState());
        parseState.pendingBlocks = pendingBlocks;
        parseState.historyIncomplete = historyIncomplete;
      }

      let result: Awaited<ReturnType<typeof tailServerLog>>;
      try {
        result = await tailServerLog(logPath, parseState, manifests, proxyEventsEndingIn, {
          host: ctx.host,
          expectedInode: st?.ino ?? saved?.ino,
          ...(bothCapture ? { deferBlocks: true, maxBytes: DUAL_CAPTURE_TAIL_BYTES, maxPendingBlocks: MAX_PENDING_SERVERLOG_BLOCKS, unreadBytesBeforeTailStat } : {}),
        });
        if (bothCapture) {
          const blocks = result.state.pendingBlocks ?? [];
          const events: UsageEvent[] = [];
          const pending: ServerLogRequestBlock[] = [];
          let minEnd = Infinity;
          let maxEnd = -Infinity;
          for (const block of blocks) {
            if (block.endTs < minEnd) minEnd = block.endTs;
            if (block.endTs > maxEnd) maxEnd = block.endTs;
          }
          const recent = blocks.length ? proxyEventsEndingIn(minEnd - GUARD_WINDOW_MS, maxEnd + GUARD_WINDOW_MS) : [];
          const backlog = ctx.meteringBacklogStatus?.() ?? null;
          const backlogHealthy = !!backlog && backlog.pending === 0 && backlog.quarantined === 0
            && backlog.writeFailures === 0 && backlog.lastError === null && backlog.historyIncomplete !== true
            && backlog.failureEvidenceStored !== false;
          const activeRequests = ctx.primaryOllamaActiveRequests?.();
          const now = ctx.now();
          for (const block of blocks) {
            if (isDoubleCounted(block, recent, GUARD_WINDOW_MS)) continue;
            const settled = now >= block.endTs + GUARD_WINDOW_MS && activeRequests === 0 && backlogHealthy;
            if (settled) events.push(buildServerLogUsageEvent(ctx.host, block));
            else pending.push(block);
          }
          result.events = events;
          result.state.pendingBlocks = pending;
          if (pending.length > 0) stats.warnings.push(`Dual capture is holding ${pending.length} server-log estimates for proxy/backlog settlement.`);
          if (pending.length > 0 && !backlog) stats.warnings.push('Dual capture needs daemon proxy/backlog status; one-shot CLI retains these log estimates for a later daemon scan.');
          if (result.state.pendingLimitReached) stats.warnings.push('Dual-capture settle queue reached its bound; the server-log cursor was held for the next scan.');
          if (result.state.historyIncomplete) stats.warnings.push('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
        } else if ((result.state.pendingBlocks?.length ?? 0) > 0) {
          // A config change from both to serverlog drains already-parsed log blocks instead of
          // stranding them in the persisted settle queue.
          const blocks = result.state.pendingBlocks ?? [];
          let minEnd = Infinity;
          let maxEnd = -Infinity;
          for (const block of blocks) {
            if (block.endTs < minEnd) minEnd = block.endTs;
            if (block.endTs > maxEnd) maxEnd = block.endTs;
          }
          const recent = proxyEventsEndingIn(minEnd - GUARD_WINDOW_MS, maxEnd + GUARD_WINDOW_MS);
          for (const block of blocks) {
            if (!isDoubleCounted(block, recent, GUARD_WINDOW_MS)) result.events.push(buildServerLogUsageEvent(ctx.host, block));
          }
          result.state.pendingBlocks = [];
        }
      } catch (err) {
        stats.filesSkipped++;
        stats.warnings.push(`${logPath}: ${String(err)}`);
        ctx.log('warn', 'ollama-serverlog: tail failed', { logPath, error: String(err) });
        continue;
      }

      // If both path and handle stats were unavailable (for example, the file disappeared
      // between discovery and open), do not write a zero-size replacement cursor.
      if (!result.fileInfo && !st) {
        stats.filesSkipped++;
        stats.warnings.push(`${logPath}: file cursor metadata unavailable; preserving the saved cursor and history.`);
        continue;
      }

      ctx.store.transaction(() => {
        if (result.events.length > 0) ctx.store.upsertEvents(result.events);
        const persistedFileInfo = result.fileInfo ?? st;
        ctx.store.setState({
          key: stateKey,
          size: persistedFileInfo?.size ?? 0,
          mtimeMs: persistedFileInfo?.mtimeMs ?? 0,
          offset: result.state.offset,
          ...(persistedFileInfo ? { ino: persistedFileInfo.ino } : {}),
          extra: result.state,
        });
      });
      stats.eventsEmitted += result.events.length;
      stats.bytesRead += result.bytesRead;
    }

    stats.durationMs = ctx.now() - t0;
    return stats;
  }
}

/** Mirrors the ledger's validCheckpointCursor contract; fractional finite mtimeMs stays valid. */
function isValidServerLogOuterCursor(value: unknown): value is IngestState {
  if (!value || typeof value !== 'object') return false;
  const state = value as IngestState;
  return typeof state.key === 'string' && state.key.length > 0
    && Number.isSafeInteger(state.size) && state.size >= 0
    && typeof state.mtimeMs === 'number' && Number.isFinite(state.mtimeMs)
    && Number.isSafeInteger(state.offset) && state.offset >= 0 && state.offset <= state.size
    && (state.ino === undefined || state.ino === null || Number.isSafeInteger(state.ino));
}

function isParseState(x: unknown): x is ServerLogParseState {
  if (!x || typeof x !== 'object' || typeof (x as ServerLogParseState).offset !== 'number') return false;
  const state = x as ServerLogParseState;
  if (!Number.isSafeInteger(state.offset) || state.offset < 0) return false;
  if (state.pendingBlocks !== undefined && (!Array.isArray(state.pendingBlocks) || !state.pendingBlocks.every(isServerLogRequestBlock))) return false;
  if (state.historyIncomplete !== undefined && typeof state.historyIncomplete !== 'boolean') return false;
  if (state.pendingLimitReached !== undefined && typeof state.pendingLimitReached !== 'boolean') return false;
  if (state.cursorGuard !== undefined && state.cursorGuard !== null && !/^[a-f0-9]{64}$/i.test(state.cursorGuard)) return false;
  return true;
}

function isServerLogRequestBlock(value: unknown): value is ServerLogRequestBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as ServerLogRequestBlock;
  return typeof block.model === 'string' && Number.isSafeInteger(block.promptEvalCount) && block.promptEvalCount >= 0
    && Number.isSafeInteger(block.evalCount) && block.evalCount >= 0 && Number.isFinite(block.totalMs) && block.totalMs >= 0
    && Number.isSafeInteger(block.endTs) && block.endTs >= 0 && Number.isFinite(block.durationMs) && block.durationMs >= 0
    && typeof block.path === 'string';
}
