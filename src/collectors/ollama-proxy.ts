/**
 * ollama-proxy.ts — reverse-proxy metering for local Ollama traffic (DESIGN.md §4.3 + §15.3).
 *
 * `127.0.0.1:<proxyPort>` -> `config.local.ollamaUpstream`, transparent for every path, streaming
 * pass-through (the client's response bytes are forwarded chunk-by-chunk as they arrive from
 * upstream — this module never buffers a full response before writing to the client; it only
 * *observes* a copy of each chunk to parse usage after the fact).
 *
 * Metered paths: `/api/chat`, `/api/generate` (NDJSON; final `done:true` line carries
 * `prompt_eval_count`, `eval_count`, `*_duration` ns — verified real shape on this host, both
 * Ollama 0.32.13 [homebrew] and 0.34.2 [Ollama.app]: 0.32.13 has no `prompt_eval_cached_count`
 * field at all; 0.34.2 does, and it goes non-zero on a genuine cache hit — see
 * test/fixtures/ollama/*.json, captured live 2026-09-26 with `num_predict:8` on both models on
 * both servers). `/v1/chat/completions` + `/v1/completions` (OpenAI-compatible `usage` object;
 * non-streaming has it inline, streaming needs `stream_options.include_usage` to get a final
 * `choices:[]` chunk carrying it — verified live: 0.32.13 honours `include_usage` and *does* emit
 * that exact shape). `/api/embed` + `/v1/embeddings` (prompt-only; NOT reachable on the live
 * homebrew server tested here because it wasn't started with `--embeddings`, so the embeddings
 * parsers are unit-tested against hand-built fixtures matching Ollama's documented schema —
 * label that path "shape-only / unproven" until confirmed against a real embeddings-enabled
 * server). `/v1/messages` (Anthropic-compatible; ANNOTATE ONLY per DESIGN §15.3.3 — verified live
 * on Ollama.app 0.34.2: real shape is `{usage:{input_tokens, cache_read_input_tokens,
 * output_tokens}}`; when Claude Desktop is the caller this traffic is already owned and priced by
 * the Claude collector via its JSONL, so the proxy must never turn it into a UsageEvent, only log
 * it for `doctor` visibility).
 *
 * Usage-injection (`config.local.proxyInjectUsage`, DESIGN §15.3.3 "No include_usage injection by
 * default"): when enabled, a streaming `/v1/*` request that lacks `stream_options.include_usage`
 * has that field injected into the JSON body forwarded upstream, and the resulting usage-only
 * final chunk (`choices:[]` + `usage`) is stripped from what actually reaches the client — a
 * client that never asked for usage must never see an extra chunk appear. When disabled (the
 * default), such requests are counted as `unmetered` (DESIGN §15.3.3 "streaming /v1 without usage
 * is counted as unmetered requests in doctor") and forwarded completely untouched.
 */
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import { URL } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { HostLabel, Provider, Source, TokenCounts, UsageComponent, UsageEvent } from '../core/types.js';
import { isAllowedLoopbackHost, isAllowedLoopbackOrigin } from '../daemon/loopback.js';
import { captureNativeCounters, nativeCounterProjection, type NativeCounterEvidence } from '../measurement/native-counter-evidence.js';

/** Default cap on a metered request's body (config `local.proxyMaxBodyBytes`, security audit #2). */
export const DEFAULT_PROXY_MAX_BODY_BYTES = 33_554_432; // 32 MiB

/** Thrown by `readBody` when the client disconnects (aborts/closes) before the body completes —
 * never surfaced as a server error; the caller just stops quietly, there is no client left to
 * answer (security audit #1). */
class ClientAbortedError extends Error {
  constructor() {
    super('client disconnected before the request body completed');
  }
}

/** Thrown by `readBody` when the request body exceeds the configured cap (security audit #2). */
class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeded the ${limit}-byte cap`);
  }
}

// ── Hop-by-hop header handling (security audit #6) ──────────────────────────

/** RFC 7230 §6.1 hop-by-hop headers: meaningful only for one specific TCP hop, never forwarded
 * as-is by a compliant intermediary — each hop that needs them (or doesn't) recomputes its own. */
const HOP_BY_HOP_HEADER_NAMES = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Strips hop-by-hop headers (the fixed RFC 7230 list, every `proxy-*` header, and every header
 * named inside the request/response's own `Connection` header) from `headers` before forwarding
 * them to the other side. Applied in BOTH directions (client→upstream and upstream→client).
 * `transfer-encoding` is always in the fixed list, so it is never forwarded either way — Node's
 * own http client/server recomputes correct framing (chunked, if no `content-length` is set) for
 * the new hop, which also guarantees this proxy never forwards both `transfer-encoding` and
 * `content-length` for the same message (the audit's mutation-test concern).
 */
export function stripHopByHopHeaders<T extends http.IncomingHttpHeaders | http.OutgoingHttpHeaders>(headers: T): T {
  const connectionNamed = new Set<string>();
  const rawConnection = (headers as http.IncomingHttpHeaders).connection;
  if (rawConnection) {
    const raw = Array.isArray(rawConnection) ? rawConnection.join(',') : rawConnection;
    for (const part of raw.split(',')) {
      const name = part.trim().toLowerCase();
      if (name) connectionNamed.add(name);
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADER_NAMES.has(lower)) continue;
    if (lower.startsWith('proxy-')) continue;
    if (connectionNamed.has(lower)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out as T;
}

export type OllamaLogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void;

export type OllamaMeteredKind =
  | 'api-chat'
  | 'api-generate'
  | 'v1-chat-completions'
  | 'v1-completions'
  | 'api-embed'
  | 'v1-embeddings'
  | 'v1-messages-annotate'
  | 'unmetered';

export interface OllamaProxyDeps {
  /** e.g. 'http://127.0.0.1:11434'. */
  upstream: string;
  /** Port the proxy itself listens on, e.g. 11444. */
  port: number;
  host: HostLabel;
  /** Which local engine this proxy instance fronts (build item 4: generalized metering proxy —
   * `UsageEvent.engine`, see that field's own doc). Default `'ollama'` — every pre-existing
   * caller of this module (the primary Ollama proxy) gets exactly the same tag it always
   * implicitly meant, so existing tests/behavior are unaffected. */
  engine?: string;
  injectUsage: boolean;
  /** Cap on a metered request's body / retained response copy (security audit #2). Default
   * `DEFAULT_PROXY_MAX_BODY_BYTES` (32 MiB) — wired from `config.local.proxyMaxBodyBytes`. */
  maxBodyBytes?: number;
  /** Called once per successfully metered request/response. */
  onEvent: (event: UsageEvent) => void;
  /** Called for a metered request without a complete count basis, including
   * interrupted or cancelled native responses and streaming /v1 without usage.
   * Partial reported counts may also be retained; this is a request diagnostic,
   * never a token count, invoice amount, or attribution of fault. */
  onUnmetered?: (info: { path: string; model?: string }) => void;
  /** Called for /v1/messages traffic — annotate-only, never emits a UsageEvent (owned by the Claude collector). */
  onAnnotateOnly?: (info: { path: string; model?: string }) => void;
  log?: OllamaLogFn;
  now?: () => number;
  hrnow?: () => bigint;
}

const DEFAULT_LOG: OllamaLogFn = () => {};

// ── Path classification ─────────────────────────────────────────────────────

export function classifyPath(pathname: string): OllamaMeteredKind {
  if (pathname === '/api/chat') return 'api-chat';
  if (pathname === '/api/generate') return 'api-generate';
  if (pathname === '/v1/chat/completions') return 'v1-chat-completions';
  if (pathname === '/v1/completions') return 'v1-completions';
  if (pathname === '/api/embed' || pathname === '/api/embeddings') return 'api-embed';
  if (pathname === '/v1/embeddings') return 'v1-embeddings';
  if (pathname === '/v1/messages') return 'v1-messages-annotate';
  return 'unmetered';
}

// ── /api/chat, /api/generate (NDJSON) final-chunk parsing ───────────────────

export interface NativeFinalChunk {
  model: string;
  nativeCounterEvidence: NativeCounterEvidence;
  promptEvalCount: number;
  promptEvalCachedCount: number; // 0 when the field is absent (Ollama < 0.34, verified: 0.32.13 has no such field)
  evalCount: number;
  totalDurationNs: number | null;
  promptEvalDurationNs: number | null;
  evalDurationNs: number | null;
  loadDurationNs: number | null;
}

/** Parses one NDJSON line from /api/chat or /api/generate; returns the final chunk's fields, or null if not the final (`done:true`) line or unparseable. */
export function parseNativeLine(line: string): NativeFinalChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.done !== true) return null;
  if (typeof obj.model !== 'string') return null;
  const nativeCounterEvidence = captureNativeCounters(obj);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    model: obj.model,
    nativeCounterEvidence,
    promptEvalCount: num(obj.prompt_eval_count),
    promptEvalCachedCount: num(obj.prompt_eval_cached_count), // absent on 0.32.13 -> 0, per DESIGN §15.3.2
    evalCount: num(obj.eval_count),
    totalDurationNs: numOrNull(obj.total_duration),
    promptEvalDurationNs: numOrNull(obj.prompt_eval_duration),
    evalDurationNs: numOrNull(obj.eval_duration),
    loadDurationNs: numOrNull(obj.load_duration),
  };
}

// ── Thinking-mode detection (founder req. 2026-09-27) ───────────────────────
//
// Real evidence, this host, both gemma4:26b and Qwen3.8 UD-Q4_K_XL (docs/research/
// spikes-2026-09-26.md S7, `curl .../api/chat think:false` vs `think:true`, live 2026-09-26):
// "with think:false, `thinking` is absent and `content` holds the full answer... With think:true,
// `content` was empty, `thinking` held reasoning text" — the key is either fully ABSENT (think
// disabled) or genuinely PRESENT (think enabled); there is no "present but always empty" case to
// confuse with absence. Real fixtures (test/fixtures/ollama/api-chat-*.json, v1-chat-*-gemma.*,
// captured live 2026-09-26) confirm the same key names: native `/api/chat`+`/api/generate` use
// `message.thinking` (streamed on intermediate `done:false` lines too — the FINAL `done:true` line
// alone does not always carry it, e.g. a `done_reason:"length"` cutoff mid-thought); the
// OpenAI-compatible surface uses `message.reasoning` (non-stream) / `delta.reasoning` (stream
// chunks) under the exact same rule. This makes the response ALONE a fully determinable signal —
// present on any line of the response => true, never present => false — with no null/unknown case
// for this collector (contrast Claude JSONL / Codex, where the evidence is sometimes absent
// entirely). The request's own `think` field is not separately inspected: it would only ever repeat
// what the response already proves, per the verified behavior above. Content is inspected only for
// KEY PRESENCE, never read, stored, or logged (privacy — DESIGN §15.9.10's serverlog rule applies
// here in spirit even though this module isn't the serverlog collector).

/** True iff a native `/api/chat` (`message.thinking`) or `/api/generate` (TOP-LEVEL `thinking` — no
 * `message` object exists on this endpoint; verified live, this host, 2026-09-27:
 * `curl :11434/api/generate -d '{"model":"gemma4:26b","prompt":"...","think":true,"stream":false}'`
 * returns keys incl. a top-level `thinking` string, sibling to `response`) NDJSON line has its
 * thinking key present at all (regardless of value) — checked on EVERY line of the response, not
 * just the final `done:true` one, since a length-cutoff line can omit it while an earlier line had it. */
export function nativeLineHasThinking(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if ('thinking' in obj) return true; // /api/generate
  const message = obj.message;
  return message !== null && typeof message === 'object' && 'thinking' in (message as Record<string, unknown>); // /api/chat
}

/** True iff an OpenAI-compatible streaming SSE payload's `choices[0].delta.reasoning` key is present. */
export function openAiStreamPayloadHasReasoning(payload: string): boolean {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === '[DONE]') return false;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = (choices[0] as Record<string, unknown> | undefined)?.delta;
  return delta !== null && typeof delta === 'object' && 'reasoning' in (delta as Record<string, unknown>);
}

/** True iff an OpenAI-compatible non-streaming body's `choices[0].message.reasoning` key is present. */
export function openAiNonStreamHasReasoning(body: string): boolean {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return false;
  }
  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const message = (choices[0] as Record<string, unknown> | undefined)?.message;
  return message !== null && typeof message === 'object' && 'reasoning' in (message as Record<string, unknown>);
}

// ── /v1/* (OpenAI-compatible) usage parsing ─────────────────────────────────

export interface OpenAiUsage {
  model: string;
  promptTokens: number;
  cachedTokens: number; // prompt_tokens_details.cached_tokens; 0 when absent
  completionTokens: number;
}

/** Non-streaming /v1/chat/completions or /v1/completions response body. */
export function parseOpenAiNonStream(body: string): OpenAiUsage | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const model = typeof obj.model === 'string' ? obj.model : null;
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!model || !usage) return null;
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = typeof details?.cached_tokens === 'number' ? (details.cached_tokens as number) : 0;
  return { model, promptTokens, cachedTokens, completionTokens };
}

/**
 * Parses one SSE `data: {...}` payload (without the `data: ` prefix) from a streaming /v1/*
 * response. Returns the usage object only when this chunk is the usage-only final chunk
 * (`choices: []` + a `usage` object) — verified live shape on Ollama 0.32.13 with
 * `stream_options.include_usage: true`.
 */
export function parseOpenAiStreamUsageChunk(payload: string): OpenAiUsage | null {
  const trimmed = payload.trim();
  if (trimmed === '[DONE]') return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const choices = obj.choices;
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (!Array.isArray(choices) || choices.length !== 0 || !usage) return null;
  const model = typeof obj.model === 'string' ? obj.model : '';
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = typeof details?.cached_tokens === 'number' ? (details.cached_tokens as number) : 0;
  return { model, promptTokens, cachedTokens, completionTokens };
}

/** Splits an SSE byte stream into `data: ...` payloads (without the prefix), tolerant of chunk boundaries mid-line. Stateful — feed chunks via the returned `push`. */
export function createSseLineSplitter(onPayload: (payload: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = '';
  const process = () => {
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        onPayload(line.slice(5).trimStart());
      }
    }
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      process();
    },
    flush() {
      if (buffer.trim().startsWith('data:')) {
        onPayload(buffer.trim().slice(5).trimStart());
      }
      buffer = '';
    },
  };
}

// ── Embeddings (shape-only / unproven: not reachable on the live server tested) ─────────────

export interface EmbeddingUsage {
  model: string;
  promptTokens: number;
}

/** /api/embed response: `{model, embeddings, prompt_eval_count}` per Ollama's documented API. SHAPE-ONLY / UNPROVEN. */
export function parseApiEmbedResponse(body: string): EmbeddingUsage | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.model !== 'string') return null;
  const promptTokens = typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : 0;
  return { model: obj.model, promptTokens };
}

/** /v1/embeddings response: `{model, usage:{prompt_tokens}}` per OpenAI-compat convention. SHAPE-ONLY / UNPROVEN. */
export function parseV1EmbeddingsResponse(body: string): EmbeddingUsage | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (typeof obj.model !== 'string' || !usage) return null;
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  return { model: obj.model, promptTokens };
}

// ── /v1/messages (Anthropic-compatible, annotate-only) ──────────────────────

export interface AnthropicCompatUsage {
  model: string;
  inputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

/** Verified live shape (Ollama.app 0.34.2, 2026-09-26): {model, usage:{input_tokens, cache_read_input_tokens, output_tokens}}. */
export function parseAnthropicCompatResponse(body: string): AnthropicCompatUsage | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (typeof obj.model !== 'string' || !usage) return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    model: obj.model,
    inputTokens: num(usage.input_tokens),
    cacheReadInputTokens: num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

// ── UsageEvent construction ──────────────────────────────────────────────────

let idCounter = 0;

/** `ollama:<host>:<requestStartNs>:<counter>` (DESIGN §4.3 "Key `ollama:${host}:${requestStartNs}:${counter}`"). */
export function makeOllamaEventId(host: HostLabel, requestStartNs: bigint): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `ollama:${host}:${requestStartNs.toString()}:${idCounter}`;
}

/** `<ua>:<model>:<yyyy-mm-dd>` (DESIGN §4.3 sessionId; UTC date, deterministic for tests). */
export function ollamaSessionId(userAgent: string, model: string, tsMs: number): string {
  const d = new Date(tsMs);
  const day = d.toISOString().slice(0, 10);
  return `${userAgent}:${model}:${day}`;
}

export interface BuildEventParams {
  host: HostLabel;
  /** See `OllamaProxyDeps.engine`/`UsageEvent.engine`. */
  engine?: string;
  model: string;
  tokens: TokenCounts;
  nativeCounterEvidence?: NativeCounterEvidence;
  entrypoint: string; // User-Agent
  ts: number; // request start, epoch ms
  requestStartNs: bigint;
  durationMs?: number;
  /** eval_count / (eval_duration seconds), when both are known and eval_duration > 0. */
  decodeTokPerSec?: number;
  /** Known uncached input / prompt_eval_duration seconds. Missing cache uses the disclosed legacy policy. */
  prefillTokPerSec?: number;
  prefillCountBasis?: 'reported-uncached' | 'cache-zero-assumed';
  flags?: UsageEvent['flags'];
  /** Response proved/disproved thinking (see "Thinking-mode detection" above); default false —
   * every metered path here either checks it explicitly or genuinely cannot produce it (embeddings). */
  thinking?: boolean;
}

/**
 * Builds a normalized UsageEvent for a metered Ollama request. `provider` is always 'local'
 * (Ollama is local-only in this design). Engine-reported throughput goes to `UsageEvent.perf`
 * (decode/prefill tok/s), which the store persists and the Local panel averages.
 */
export function buildOllamaUsageEvent(p: BuildEventParams): UsageEvent {
  const component: UsageComponent = { model: p.model, tokens: p.tokens,
    ...(p.nativeCounterEvidence ? { nativeCounterEvidence: p.nativeCounterEvidence } : {}) };
  const provider: Provider = 'local';
  const source: Source = 'ollama-proxy';
  return {
    id: makeOllamaEventId(p.host, p.requestStartNs),
    host: p.host,
    source,
    ts: p.ts,
    tsSource: 'request',
    sessionId: ollamaSessionId(p.entrypoint, p.model, p.ts),
    isSubagent: false,
    entrypoint: p.entrypoint,
    model: p.model,
    provider,
    ...(p.engine !== undefined ? { engine: p.engine } : {}),
    thinking: p.thinking ?? false,
    components: [component],
    tokens: p.tokens,
    durationMs: p.durationMs,
    ...(p.decodeTokPerSec !== undefined || p.prefillTokPerSec !== undefined
      ? {
          perf: {
            ...(p.decodeTokPerSec !== undefined ? { decodeTokPerSec: p.decodeTokPerSec } : {}),
            ...(p.prefillTokPerSec !== undefined ? { prefillTokPerSec: p.prefillTokPerSec } : {}),
            ...(p.prefillTokPerSec !== undefined && p.prefillCountBasis ? { prefillCountBasis: p.prefillCountBasis } : {}),
          },
        }
      : {}),
    flags: p.flags ?? [],
    // Computed at ingest by the pricing and valuation engines, not here (this collector only normalizes
    // raw counts) — placeholders mirror test/store/stubs.ts's makeEvent() convention.
    apiEquivUsd: null,
    priceStatus: 'UNPRICED',
    priceVersion: '',
    reservedValue: null,
    ucuRateStatus: 'NONE',
    eacsDefSha256: '',
  };
}

function tokensFromNative(chunk: NativeFinalChunk): TokenCounts {
  return nativeCounterProjection(chunk.nativeCounterEvidence);
}

function tokensFromOpenAi(usage: OpenAiUsage): TokenCounts {
  return {
    inputFresh: Math.max(0, usage.promptTokens - usage.cachedTokens),
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: usage.cachedTokens,
    output: usage.completionTokens,
    reasoning: 0,
  };
}

function decodeTokPerSec(evalCount: number, evalDurationNs: number | null): number | undefined {
  if (!evalDurationNs || evalDurationNs <= 0) return undefined;
  return evalCount / (evalDurationNs / 1e9);
}

// ── The proxy server ─────────────────────────────────────────────────────────

export interface OllamaProxyHandle {
  server: http.Server;
  listen: () => Promise<void>;
  close: () => Promise<void>;
  /** Admitted request handlers still awaiting response observation/cleanup. */
  activeRequestCount: () => number;
  /** Requests with unusable usage, including interrupted native replies and buffer overflows. Exposed for tests/doctor. */
  unmeteredCount: () => number;
}

/**
 * Creates (but does not start) the metering reverse proxy. `deps.onEvent` is called once per
 * fully-metered request; the client's response is streamed through untouched except for the
 * usage-only chunk strip when `injectUsage` fires an injection this proxy itself added.
 */
/**
 * Build item 4 ("generalize the Ollama metering proxy so additional upstreams can be metered via
 * config"): decided and documented here rather than writing a second, near-duplicate proxy module.
 * Every mechanic below — Host/Origin loopback checks, hop-by-hop stripping, request-body caps,
 * abort-safety, streaming pass-through — is already engine-agnostic; the only genuinely
 * Ollama-specific paths are the native `/api/chat`/`/api/generate` NDJSON endpoints, which simply
 * never match against a different engine's upstream (that upstream just doesn't serve them, so
 * those branches are harmless no-ops). Docker Model Runner and vLLM are both OpenAI-compatible
 * servers exposing the exact `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings` shapes
 * this module already parses — so `createOllamaProxy` itself, given a different `upstream`/`port`
 * and an `engine` tag, is the generalized proxy. `daemon/main.ts` starts one instance per
 * configured upstream (the primary Ollama one, plus each of `config.local.upstreams[]`). Events
 * from every instance still land on `source: 'ollama-proxy'` (see `UsageEvent.engine`'s own doc for
 * why this is a field, not a new `Source`). `createMeteringProxy` is the name call sites outside
 * this module use, to read as engine-agnostic at the point of use.
 */
export function createOllamaProxy(deps: OllamaProxyDeps): OllamaProxyHandle {
  const log = deps.log ?? DEFAULT_LOG;
  const now = deps.now ?? (() => Date.now());
  const hrnow = deps.hrnow ?? (() => process.hrtime.bigint());
  const upstreamUrl = new URL(deps.upstream);
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_PROXY_MAX_BODY_BYTES;
  let unmetered = 0;
  let closing=false;
  let closePromise:Promise<void>|undefined;
  const responses=new Set<http.ServerResponse>();
  const activeRequests=new Set<Promise<void>>();
  // The real bound port — `deps.port` may be 0 (OS picks a free port, e.g. in tests); every
  // Host-header check below must compare against what the OS actually bound, not the requested
  // value. Set once `listen()` resolves.
  let effectivePort = deps.port;

  // CONNECT is never valid for this proxy (it fronts one fixed upstream, it is not a general
  // forward proxy) — reject explicitly rather than relying on Node's undocumented default.
  const server = http.createServer((clientReq, clientRes) => {
    // Existing keep-alive sockets can carry another request after server.close.
    // Refuse it before any upstream work; finish accepted work normally.
    if(closing) { clientRes.writeHead(503,{'content-type':'text/plain',connection:'close'});clientRes.end('metering proxy is stopping');return; }
    responses.add(clientRes);
    clientRes.once('close',()=>responses.delete(clientRes));
    clientRes.once('finish',()=>{if(closing)setImmediate(()=>server.closeIdleConnections());});
    const work=handleRequest(clientReq, clientRes).catch((err) => {
      failClientResponse(clientRes, log, 'unhandled error in request handler', err);
    });
    activeRequests.add(work);
    void work.then(()=>activeRequests.delete(work),()=>activeRequests.delete(work));
  });
  server.on('connect', (req, socket) => {
    log('warn', 'ollama-proxy: rejecting CONNECT method', { url: req.url });
    socket.destroy();
  });

  async function handleRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): Promise<void> {
    const requestStartNs = hrnow();
    const ts = now();
    const reqUrl = clientReq.url ?? '/';

    // ── Request validation (security audit #3) — before anything else. ──────────────────────
    // Reject an absolute-form / authority-form request target (e.g. a client using this as a
    // general forward proxy: `GET http://evil/ HTTP/1.1`) — the only legitimate target here is
    // origin-form (`/path?query`), since this proxy always talks to one fixed configured upstream.
    if (!reqUrl.startsWith('/')) {
      clientRes.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
      clientRes.end('absolute-form request targets are not accepted');
      return;
    }
    const hostHeader = clientReq.headers.host ?? '';
    if (!isAllowedLoopbackHost(hostHeader, effectivePort)) {
      log('warn', 'ollama-proxy: rejecting non-loopback Host header', { host: hostHeader });
      clientRes.writeHead(403, { 'content-type': 'text/plain' });
      clientRes.end('forbidden host');
      return;
    }
    // Origin, when present, must itself be a loopback origin — NOT rejected wholesale (unlike
    // daemon/http.ts's read API): a browser-based local tool (e.g. a web UI on some other local
    // port) is a legitimate caller of a metering proxy in front of Ollama.
    const originHeader = clientReq.headers.origin;
    if (originHeader !== undefined && !isAllowedLoopbackOrigin(originHeader)) {
      log('warn', 'ollama-proxy: rejecting non-loopback Origin header', { origin: originHeader });
      clientRes.writeHead(403, { 'content-type': 'text/plain' });
      clientRes.end('forbidden origin');
      return;
    }

    const pathname = reqUrl.split('?')[0];
    const kind = classifyPath(pathname);
    const userAgent = clientReq.headers['user-agent'] ?? 'unknown';

    // Read the request body only for metered JSON endpoints where we may need to inspect/rewrite
    // it (stream flag, include_usage injection). Every other path is piped through untouched with
    // zero buffering, exactly like a plain transparent reverse proxy.
    const isJsonBody = clientReq.method === 'POST' && kind !== 'unmetered';
    let requestBodyBuffer: Buffer | null = null;
    if (isJsonBody) {
      // Content-Length lets us reject an oversized body before reading a single byte of it.
      const declaredLength = Number(clientReq.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        clientRes.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
        // Destroy only AFTER the response is actually flushed — destroying the shared
        // request/response socket synchronously would truncate the 413 we just wrote.
        clientRes.end('request body too large', () => clientReq.destroy());
        return;
      }
      try {
        requestBodyBuffer = await readBody(clientReq, maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          if (!clientRes.headersSent) {
            clientRes.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
          }
          clientRes.end('request body too large', () => clientReq.destroy());
          return;
        }
        if (err instanceof ClientAbortedError) {
          // The client disconnected mid-body (security audit #1 — e.g. Content-Length promised
          // more bytes than the client ever sent, then closed the socket). There is no client
          // left to answer; just stop cleanly. This is the exact scenario that used to crash the
          // whole daemon before every handler had a `.catch`.
          log('debug', 'ollama-proxy: client aborted mid-request-body', { path: pathname });
          if (!clientRes.writableEnded) clientRes.destroy();
          return;
        }
        throw err; // genuinely unexpected — the outer .catch on handleRequest logs + 502s it
      }
    }

    let requestBodyText = requestBodyBuffer?.toString('utf8') ?? null;
    let requestedStream = false;
    let injectedUsage = false;
    if (requestBodyText && (kind === 'v1-chat-completions' || kind === 'v1-completions')) {
      try {
        const parsed = JSON.parse(requestBodyText) as Record<string, unknown>;
        requestedStream = parsed.stream === true;
        const hasIncludeUsage =
          typeof parsed.stream_options === 'object' &&
          parsed.stream_options !== null &&
          (parsed.stream_options as Record<string, unknown>).include_usage === true;
        if (requestedStream && !hasIncludeUsage && deps.injectUsage) {
          parsed.stream_options = { ...(parsed.stream_options as object | undefined), include_usage: true };
          requestBodyText = JSON.stringify(parsed);
          requestBodyBuffer = Buffer.from(requestBodyText, 'utf8');
          injectedUsage = true;
        }
      } catch {
        // malformed JSON: forward the original bytes untouched, don't attempt to meter
      }
    } else if (requestBodyText && kind === 'api-chat') {
      try {
        requestedStream = (JSON.parse(requestBodyText) as Record<string, unknown>).stream !== false; // /api default stream:true
      } catch {
        // ignore
      }
    } else if (requestBodyText && kind === 'api-generate') {
      try {
        requestedStream = (JSON.parse(requestBodyText) as Record<string, unknown>).stream !== false;
      } catch {
        // ignore
      }
    }

    const upstreamHeaders: http.OutgoingHttpHeaders = stripHopByHopHeaders({ ...clientReq.headers });
    delete upstreamHeaders.host;
    if (requestBodyBuffer) upstreamHeaders['content-length'] = String(requestBodyBuffer.byteLength);

    // Socket closure can precede the relay's final observation callback. Keep
    // the admitted request alive until that callback settles, including aborts.
    await new Promise<void>((resolve) => {
      let responseStarted=false;
      const upstreamReq = http.request(
        {
          protocol: upstreamUrl.protocol,
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
          path: reqUrl,
          method: clientReq.method,
          headers: upstreamHeaders,
          agent: false, // One-shot sockets avoid Node 24.22.0 keep-alive response reuse.
        },
        (upstreamRes) => {
          responseStarted=true;
          relayResponse(upstreamRes).catch((err) => {
            failClientResponse(clientRes, log, 'relayResponse failed', err);
          }).finally(resolve);
        }
      );

      // If the client's underlying TCP connection actually closes (abort/ECONNRESET) before we're
      // done with the upstream request, stop that upstream request too — otherwise it lingers, and
      // its eventual response is written to a client response that can no longer accept it
      // (security audit #1). Deliberately the SOCKET's 'close', not `clientReq`'s own 'close' —
      // the latter fires on ordinary request completion too (e.g. a bodyless GET), which would
      // destroy a perfectly healthy in-flight upstream request.
      clientReq.socket?.once('close', () => {
        if (!upstreamReq.destroyed) upstreamReq.destroy();
      });

      upstreamReq.on('error', (err) => {
        log('error', 'ollama-proxy upstream request failed', { path: pathname, error: String(err) });
        if (!clientRes.headersSent) {
          clientRes.statusCode = 502;
          clientRes.end();
        } else if (!clientRes.writableEnded) {
          // A connection reset after headers must not seal a truncated body.
          clientRes.destroy();
        }
        if(!responseStarted)resolve();
      });
      upstreamReq.once('close',()=>{if(!responseStarted)resolve();});

      if (requestBodyBuffer) {
        upstreamReq.end(requestBodyBuffer);
      } else {
        clientReq.pipe(upstreamReq);
        // A raw pipe() never forwards a source 'error' to the destination — an unhandled 'error'
        // on an EventEmitter crashes the process. Give clientReq an explicit listener here too (the
        // isJsonBody branch above already has one via readBody) so a mid-stream ECONNRESET on the
        // pass-through path is caught and logged instead of taking the daemon down.
        clientReq.on('error', (err) => {
          log('debug', 'ollama-proxy: client request error on pass-through path', { path: pathname, error: String(err) });
        });
      }
    });

    async function relayResponse(upstreamRes: http.IncomingMessage): Promise<void> {
      // A failed source pipe does not end or destroy its destination.
      // Propagate the transport failure while letting the usage parser settle.
      upstreamRes.on('error', (err) => {
        failClientResponse(clientRes, log, 'upstream response interrupted', err);
      });
      const resHeaders = stripHopByHopHeaders({ ...upstreamRes.headers });
      clientRes.writeHead(upstreamRes.statusCode ?? 200, resHeaders);

      if (kind === 'unmetered' || upstreamRes.statusCode == null || upstreamRes.statusCode >= 300) {
        upstreamRes.pipe(clientRes);
        return;
      }

      const model = tryExtractModelFromRequest(requestBodyText);

      if (kind === 'api-chat' || kind === 'api-generate') {
        await relayNativeNdjson(upstreamRes, clientRes, { pathname, userAgent, ts, requestStartNs, log });
        return;
      }

      if (kind === 'v1-chat-completions' || kind === 'v1-completions') {
        if (requestedStream) {
          await relayOpenAiStream(upstreamRes, clientRes, {
            pathname,
            userAgent,
            ts,
            requestStartNs,
            injectedUsage,
            fallbackModel: model,
          });
        } else {
          await relayOpenAiNonStream(upstreamRes, clientRes, { pathname, userAgent, ts, requestStartNs });
        }
        return;
      }

      const onBufferExceeded = (p: string) => {
        unmetered += 1;
        deps.onUnmetered?.({ path: p });
      };

      if (kind === 'api-embed') {
        await relayBuffered(
          upstreamRes,
          clientRes,
          maxBodyBytes,
          pathname,
          (body) => {
            const usage = parseApiEmbedResponse(body);
            if (usage) emitEmbeddingEvent(usage, userAgent, ts, requestStartNs, 'api-embed');
          },
          onBufferExceeded
        );
        return;
      }

      if (kind === 'v1-embeddings') {
        await relayBuffered(
          upstreamRes,
          clientRes,
          maxBodyBytes,
          pathname,
          (body) => {
            const usage = parseV1EmbeddingsResponse(body);
            if (usage) emitEmbeddingEvent(usage, userAgent, ts, requestStartNs, 'v1-embeddings');
          },
          onBufferExceeded
        );
        return;
      }

      if (kind === 'v1-messages-annotate') {
        await relayBuffered(
          upstreamRes,
          clientRes,
          maxBodyBytes,
          pathname,
          (body) => {
            const usage = parseAnthropicCompatResponse(body);
            deps.onAnnotateOnly?.({ path: pathname, model: usage?.model });
          },
          onBufferExceeded
        );
        return;
      }

      upstreamRes.pipe(clientRes);
    }

    function emitEmbeddingEvent(
      usage: EmbeddingUsage,
      userAgent: string,
      ts: number,
      requestStartNs: bigint,
      _kind: 'api-embed' | 'v1-embeddings'
    ) {
      const tokens: TokenCounts = {
        inputFresh: usage.promptTokens,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 0,
        reasoning: 0,
      };
      const event = buildOllamaUsageEvent({
        host: deps.host,
        engine: deps.engine ?? 'ollama',
        model: usage.model,
        tokens,
        entrypoint: userAgent,
        ts,
        requestStartNs,
      });
      deps.onEvent(event);
    }

    // ── NDJSON (/api/chat, /api/generate): stream every byte through untouched; meter the final line. ──
    async function relayNativeNdjson(
      upstreamRes: http.IncomingMessage,
      clientRes: http.ServerResponse,
      ctx: { pathname: string; userAgent: string; ts: number; requestStartNs: bigint; log: OllamaLogFn }
    ): Promise<void> {
      let buffer = '';
      let sawThinking = false;
      let observedCompleteCounters = false;
      const processLine = (line: string) => {
        if (!sawThinking && nativeLineHasThinking(line)) sawThinking = true;
        const final = parseNativeLine(line);
        if (!final) return;
        const tokens = tokensFromNative(final);
        observedCompleteCounters ||= tokens.countQuality === 'complete';
        const durationMs = final.totalDurationNs != null ? final.totalDurationNs / 1e6 : undefined;
        const report = final.nativeCounterEvidence.snapshots[0]!;
        const tokPerSec = report.eval_count.state === 'reported'
          ? decodeTokPerSec(report.eval_count.value, final.evalDurationNs) : undefined;
        const cache = report.prompt_eval_cached_count;
        const prefillKnown = report.prompt_eval_count.state === 'reported'
          && (cache.state === 'missing' || cache.state === 'reported' && cache.value <= report.prompt_eval_count.value);
        const prefillPerSec = prefillKnown ? decodeTokPerSec(tokens.inputFresh, final.promptEvalDurationNs) : undefined;
        const event = buildOllamaUsageEvent({
          host: deps.host,
        engine: deps.engine ?? 'ollama',
          model: final.model,
          tokens,
          nativeCounterEvidence: final.nativeCounterEvidence,
          entrypoint: ctx.userAgent,
          ts: ctx.ts,
          requestStartNs: ctx.requestStartNs,
          durationMs,
          decodeTokPerSec: tokPerSec,
          prefillTokPerSec: prefillPerSec,
          ...(prefillPerSec !== undefined ? { prefillCountBasis: cache.state === 'missing' ? 'cache-zero-assumed' as const : 'reported-uncached' as const } : {}),
          thinking: sawThinking,
        });
        deps.onEvent(event);
      };
      const tee = new PassThrough();
      tee.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          processLine(line);
        }
      });
      upstreamRes.pipe(tee);
      upstreamRes.pipe(clientRes); // untouched pass-through, no injection/stripping on native endpoints
      await onceEnd(upstreamRes);
      // A non-streaming /api/chat|/api/generate response is a single JSON object with NO
      // trailing newline — it never hits the '\n'-triggered branch above, so the leftover
      // buffer must be checked once more after the stream ends.
      if (buffer.trim().length > 0) processLine(buffer);
      if (!observedCompleteCounters) {
        // A successful or interrupted reply without a complete count basis is
        // unmetered usage. Partial reported counts remain an inspectable event.
        unmetered += 1;
        deps.onUnmetered?.({ path: ctx.pathname, model: tryExtractModelFromRequest(requestBodyText) ?? undefined });
      }
    }

    // ── /v1/* non-streaming: forward chunks as they arrive; parse once the body is complete. ──
    async function relayOpenAiNonStream(
      upstreamRes: http.IncomingMessage,
      clientRes: http.ServerResponse,
      ctx: { pathname: string; userAgent: string; ts: number; requestStartNs: bigint }
    ): Promise<void> {
      const collector = boundedCollector(maxBodyBytes);
      upstreamRes.on('data', (c: Buffer) => {
        collector.push(c); // stops retaining bytes past the cap; still written through below
        clientRes.write(c); // forwarded immediately — not held back for parsing
      });
      await onceEnd(upstreamRes);
      clientRes.end();
      if (collector.exceeded()) {
        // Security audit #2: a response over the cap keeps streaming to the client untouched
        // (already happened above), but is never metered from a possibly-truncated copy.
        unmetered += 1;
        deps.onUnmetered?.({ path: ctx.pathname });
        return;
      }
      const body = collector.body();
      const usage = parseOpenAiNonStream(body);
      if (usage) {
        const event = buildOllamaUsageEvent({
          host: deps.host,
        engine: deps.engine ?? 'ollama',
          model: usage.model,
          tokens: tokensFromOpenAi(usage),
          entrypoint: ctx.userAgent,
          ts: ctx.ts,
          requestStartNs: ctx.requestStartNs,
          thinking: openAiNonStreamHasReasoning(body),
        });
        deps.onEvent(event);
      }
    }

    // ── /v1/* streaming: forward every chunk immediately; on injectUsage, drop the injected usage-only chunk from what the client sees. ──
    async function relayOpenAiStream(
      upstreamRes: http.IncomingMessage,
      clientRes: http.ServerResponse,
      ctx: {
        pathname: string;
        userAgent: string;
        ts: number;
        requestStartNs: bigint;
        injectedUsage: boolean;
        fallbackModel: string | null;
      }
    ): Promise<void> {
      // A holder object (rather than a plain `let`) sidesteps a TS control-flow quirk where a
      // `let` only ever reassigned inside a nested closure gets narrowed to `never` at the
      // later `if` check, since the closure's effect on control flow isn't tracked across the
      // intervening `await`.
      const usageHolder: { value: OpenAiUsage | null } = { value: null };
      let sawAnyContent = false;
      let sawThinking = false;
      const splitter = createSseLineSplitter((payload) => {
        const usage = parseOpenAiStreamUsageChunk(payload);
        if (usage) usageHolder.value = usage;
        else if (payload.trim() !== '[DONE]') sawAnyContent = true;
        if (!sawThinking && openAiStreamPayloadHasReasoning(payload)) sawThinking = true;
      });

      upstreamRes.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        splitter.push(text);
        if (ctx.injectedUsage) {
          // Strip only the usage-only chunk (choices:[] + usage) we ourselves caused to exist;
          // everything else forwards byte-for-byte. Re-serialize per SSE "data: ...\n\n" line.
          const filtered = stripUsageOnlyChunks(text);
          clientRes.write(filtered);
        } else {
          clientRes.write(chunk);
        }
      });
      await onceEnd(upstreamRes);
      splitter.flush();
      clientRes.end();

      if (usageHolder.value) {
        const usageSeen = usageHolder.value;
        const event = buildOllamaUsageEvent({
          host: deps.host,
        engine: deps.engine ?? 'ollama',
          model: usageSeen.model || ctx.fallbackModel || 'unknown',
          tokens: tokensFromOpenAi(usageSeen),
          entrypoint: ctx.userAgent,
          ts: ctx.ts,
          requestStartNs: ctx.requestStartNs,
          thinking: sawThinking,
        });
        deps.onEvent(event);
      } else if (sawAnyContent) {
        unmetered += 1;
        deps.onUnmetered?.({ path: ctx.pathname, model: ctx.fallbackModel ?? undefined });
      }
    }
  }

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.port, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') effectivePort = (addr as AddressInfo).port;
          resolve();
        });
      }),
    close: () => {
      if(closePromise)return closePromise;
      closing=true;
      for(const response of responses)if(!response.headersSent)response.setHeader('Connection','close');
      closePromise=new Promise<void>(resolve=>server.close(()=>resolve())).then(async()=>{
        while(activeRequests.size)await Promise.allSettled([...activeRequests]);
      });
      server.closeIdleConnections();
      return closePromise;
    },
    activeRequestCount: () => activeRequests.size,
    unmeteredCount: () => unmetered,
  };
}

/**
 * Common failure path for both the server-level `.catch` (security audit #1's headline fix — a
 * rejected `handleRequest` promise used to be an unhandled rejection, and an aborting client used
 * to crash the whole daemon) and `relayResponse`'s own `.catch`: logs a warning, and cleans up the
 * client response — 502 if nothing has been written yet, otherwise just destroy the connection.
 * Never throws.
 */
function failClientResponse(clientRes: http.ServerResponse, log: OllamaLogFn, context: string, err: unknown): void {
  log('warn', `ollama-proxy: ${context}`, { error: String(err) });
  try {
    if (!clientRes.headersSent) clientRes.writeHead(502);
  } catch {
    // socket may already be gone — nothing more to do
  }
  try {
    clientRes.destroy();
  } catch {
    // already gone
  }
}

function tryExtractModelFromRequest(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return typeof parsed.model === 'string' ? parsed.model : null;
  } catch {
    return null;
  }
}

/**
 * Reads a full request body, enforcing `maxBytes` (security audit #2) and settling correctly when
 * the client disconnects mid-body instead of hanging forever (security audit #1 — 'aborted' fires
 * on an older-style abrupt disconnect, 'close' fires on every disconnect including a normal one,
 * but 'close' after a normal 'end' is a no-op here since the promise has already settled by then).
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (c: Buffer) => {
      if (settled) return;
      total += c.length;
      if (total > maxBytes) {
        fail(new BodyTooLargeError(maxBytes));
        // Pause (not destroy) — the caller still needs this socket alive to write a clean 413
        // response; it destroys the connection itself once that response has been flushed.
        req.pause();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(new ClientAbortedError()));
    req.on('close', () => fail(new ClientAbortedError()));
  });
}

export function onceEnd(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.removeListener('end', done);
      stream.removeListener('error', done);
      stream.removeListener('close', done);
      resolve();
    };
    stream.once('end', done);
    stream.once('error', done);
    stream.once('close', done);
    const state = stream as NodeJS.ReadableStream & { readableEnded?: boolean; closed?: boolean };
    if (state.readableEnded || state.closed) done();
  });
}

/** Collects bytes up to `maxBytes`; once exceeded, further chunks are neither retained nor
 * counted into `body()` (the caller keeps streaming the raw chunks through separately — this
 * collector only tracks whether a retained copy is still safe to hand to a parser). */
function boundedCollector(maxBytes: number): { push(chunk: Buffer): void; exceeded(): boolean; body(): string } {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  return {
    push(chunk: Buffer) {
      if (exceeded) return;
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        chunks.length = 0; // release — never read back once capped
        return;
      }
      chunks.push(chunk);
    },
    exceeded: () => exceeded,
    body: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/**
 * Streams an upstream response through to the client untouched while also retaining a copy (up to
 * `maxBytes`, security audit #2) to hand to `onBody` once complete. When the response exceeds the
 * cap, the client still gets every byte (already written through as it arrived) but `onBody` is
 * never called with a possibly-truncated copy — the caller counts that request as unmetered.
 */
async function relayBuffered(
  upstreamRes: http.IncomingMessage,
  clientRes: http.ServerResponse,
  maxBytes: number,
  pathname: string,
  onBody: (body: string) => void,
  onExceeded?: (pathname: string) => void
): Promise<void> {
  const collector = boundedCollector(maxBytes);
  upstreamRes.on('data', (c: Buffer) => {
    collector.push(c);
    clientRes.write(c);
  });
  await onceEnd(upstreamRes);
  clientRes.end();
  if (collector.exceeded()) {
    onExceeded?.(pathname);
    return;
  }
  onBody(collector.body());
}

/**
 * Removes any SSE `data: {...}\n\n` block whose payload is a usage-only chunk (`choices:[]` +
 * `usage`) from a raw text fragment, leaving every other byte untouched. Used only when this
 * proxy itself injected `stream_options.include_usage` — never applied to a client's own request
 * that asked for usage explicitly.
 *
 * Simplification: operates on whole `data: ...\n\n` blocks; assumes (as observed live) the
 * upstream flushes each SSE event as its own chunk or that the caller has already reassembled
 * line boundaries — for a chunk that splits a usage block across two `data()` events, the
 * fragment containing the usage JSON's closing brace performs the strip; the boundary case is
 * covered by the `stripUsageOnlyChunks` unit tests with deliberately split input.
 */
export function stripUsageOnlyChunks(text: string): string {
  // SSE permits CRLF separators. Preserve every byte of retained blocks and delimiters while
  // recognizing both LF and CRLF checkouts/upstreams.
  const blocks = text.split(/(\r?\n\r?\n)/);
  const kept: string[] = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const block = blocks[i];
    const separator = blocks[i + 1] ?? '';
    const dataLine = block.split(/\r?\n/).find((l) => l.startsWith('data:'));
    if (dataLine) {
      const payload = dataLine.slice(5).trimStart();
      if (parseOpenAiStreamUsageChunk(payload) !== null) {
        continue; // drop this block entirely
      }
    }
    kept.push(block + separator);
  }
  return kept.join('');
}

/** Engine-agnostic alias for `createOllamaProxy` — see that function's own doc (build item 4). */
export const createMeteringProxy = createOllamaProxy;
