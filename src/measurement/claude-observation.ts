/**
 * Pure Claude usage observation seam. The production component-count-evidence adapter
 * consumes its numeric observations; the dated v0 design contract records the earlier
 * unwired proposal. Raw model/build observations are not a clean export boundary.
 *
 * It records what a raw Claude Code assistant `message` actually reported, BEFORE any default,
 * fallback, clamp, sum or merge is applied:
 *  - per numeric field: `reported` (own data property, finite, >= 0 — zero is a value), `missing`
 *    (no own property) or `invalid` (present but unusable; value dropped);
 *  - per container (usage, cache_creation, output_tokens_details, iterations): present / absent /
 *    null / malformed, kept distinct;
 *  - one top-level component plus one component per `usage.iterations[]` entry, each with its
 *    ordinal and role. Top-level fields describe the FINAL iteration when iterations is a
 *    non-empty array; they are never summed or compared here, so the normal difference between
 *    top-level and the iteration aggregate is not (and cannot be) reported as a conflict;
 *  - flat `cache_creation_input_tokens` and nested `cache_creation.ephemeral_5m/1h_input_tokens`
 *    side by side, with no clamp, fallback or residual computation;
 *  - a thinking content SIGNAL (block of type thinking/redacted_thinking seen or not); no content,
 *    text or signature is read beyond each block's own `type`.
 *
 * Deliberately NOT here: reconciliation, dedup (only a caller-supplied key CLASS, never a key),
 * thinking-mode resolution, TTL partition/residuals, rate resolution, economics.
 *
 * Scope, not a privacy guarantee: output is built only from fixed keys, validated numbers and
 * strings from the allowed source fields. Prompt/content text, paths and message/request/session ids
 * are not copied. String fields such as model/build are only syntax-validated, so a UUID- or
 * credential-shaped value placed in one of them IS retained. This is a private observation seam, not a
 * clean export, redaction or privacy boundary. Input is never mutated, and only own DATA properties are
 * read (inherited properties count as missing; accessor properties are never invoked and count as
 * invalid/malformed). These statements cover parsed-JSON input only: Proxy objects, caller-supplied
 * options and very large in-process sparse arrays are outside that scope.
 */

export const CLAUDE_OBSERVATION_CONTRACT_VERSION = 'tokenelo/claude-count-observation@v0';

/** Static identities of the policies this seam itself applies. Policies it does NOT apply are
 * `not-applied` (raw observations) — distinct from `unknown` (historical normalized rows). */
export const CLAUDE_OBSERVATION_POLICIES = Object.freeze({
  parser: 'tokenelo/claude-observation-parser@v0',
  thinkingSignal: 'tokenelo/claude-thinking-content-signal@v0',
});

export type FieldObservation =
  | { state: 'reported'; value: number }
  | { state: 'missing'; value: null }
  | { state: 'invalid'; value: null };

export type StringObservation<T extends string = string> =
  | { state: 'reported'; value: T }
  | { state: 'missing'; value: null }
  | { state: 'invalid'; value: null };

export type ContainerState = 'present' | 'absent' | 'null' | 'malformed';

export const DEDUP_KEY_CLASSES = ['message-id', 'message-and-request-id', 'none', 'unknown'] as const;
export type DedupKeyClass = (typeof DEDUP_KEY_CLASSES)[number];

export interface CacheCreationObservation {
  /** `cache_creation_input_tokens` on the same object. */
  flatTotal: FieldObservation;
  /** `cache_creation` nested container. */
  container: ContainerState;
  ephemeral5m: FieldObservation;
  ephemeral1h: FieldObservation;
}

export interface ComponentObservation {
  role: 'top-level' | 'iteration';
  /** 0-based index within `usage.iterations`; null for the top-level component. */
  ordinal: number | null;
  /** Iteration: true for the last entry. Top-level: true (it describes the final iteration or
   * the whole message, see `topLevelDescribes`). */
  final: boolean;
  /** For iterations, the entry itself; for top-level, the `usage` container. */
  container: ContainerState;
  model: StringObservation;
  speed: StringObservation<'standard' | 'fast'>;
  inputTokens: FieldObservation;
  outputTokens: FieldObservation;
  cacheReadInputTokens: FieldObservation;
  cacheCreation: CacheCreationObservation;
}

export interface ClaudeRawObservation {
  kind: 'raw-message';
  provenance: {
    contractVersion: typeof CLAUDE_OBSERVATION_CONTRACT_VERSION;
    normalization: 'none';
    parser: string;
    thinkingSignal: string;
    componentSelection: 'not-applied';
    dedup: 'not-applied';
    merge: 'not-applied';
    ttlFallback: 'not-applied';
    sourceBuild: StringObservation;
    dedupKeyClass: DedupKeyClass;
  };
  messageContainer: ContainerState;
  /** `message.model` — the collector's fallback model; recorded separately, never applied. */
  messageModel: StringObservation;
  topLevelDescribes: 'final-iteration' | 'whole-message' | 'undetermined';
  topLevel: ComponentObservation;
  iterations: { container: ContainerState; length: number | null; components: ComponentObservation[] };
  thinking: {
    /** `present`: a thinking/redacted_thinking block was seen; `absent`: content was an array
     * without one; `unobservable`: content missing or not an array. */
    contentSignal: 'present' | 'absent' | 'unobservable';
    /** Top-level `usage.output_tokens_details` (never per-iteration). */
    detailsContainer: ContainerState;
    thinkingTokens: FieldObservation;
  };
}

export interface ObserveClaudeOptions {
  dedupKeyClass?: DedupKeyClass;
  /** Claude Code build string (the JSONL line's `version`), validated; never a path. */
  sourceBuild?: unknown;
}

// ── own-data-property access (no getters, no prototype chain) ────────────────────────────────

type Own = { kind: 'absent' } | { kind: 'accessor' } | { kind: 'data'; value: unknown };

function own(obj: object, key: string): Own {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return { kind: 'absent' };
  if (!('value' in d)) return { kind: 'accessor' };
  // JSON cannot express `undefined`; an own undefined is treated as not reported.
  if (d.value === undefined) return { kind: 'absent' };
  return { kind: 'data', value: d.value };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const MISSING = { state: 'missing', value: null } as const;
const INVALID = { state: 'invalid', value: null } as const;

function numberField(obj: object | null, key: string): FieldObservation {
  if (obj === null) return { ...MISSING };
  const o = own(obj, key);
  if (o.kind === 'absent') return { ...MISSING };
  if (o.kind === 'data' && typeof o.value === 'number' && Number.isFinite(o.value) && o.value >= 0) {
    // Normalize -0 so a reported zero is always the value 0.
    return { state: 'reported', value: o.value === 0 ? 0 : o.value };
  }
  return { ...INVALID };
}

function stringField<T extends string>(obj: object | null, key: string, accept: (s: string) => s is T): StringObservation<T> {
  if (obj === null) return { ...MISSING };
  const o = own(obj, key);
  if (o.kind === 'absent') return { ...MISSING };
  if (o.kind === 'data' && typeof o.value === 'string' && accept(o.value)) return { state: 'reported', value: o.value };
  return { ...INVALID };
}

type ContainerRead<T> = { state: ContainerState; value: T | null };

function recordContainer(obj: object | null, key: string): ContainerRead<Record<string, unknown>> {
  if (obj === null) return { state: 'absent', value: null };
  const o = own(obj, key);
  if (o.kind === 'absent') return { state: 'absent', value: null };
  if (o.kind === 'accessor') return { state: 'malformed', value: null };
  if (o.value === null) return { state: 'null', value: null };
  return isRecord(o.value) ? { state: 'present', value: o.value } : { state: 'malformed', value: null };
}

function arrayContainer(obj: object | null, key: string): ContainerRead<readonly unknown[]> {
  if (obj === null) return { state: 'absent', value: null };
  const o = own(obj, key);
  if (o.kind === 'absent') return { state: 'absent', value: null };
  if (o.kind === 'accessor') return { state: 'malformed', value: null };
  if (o.value === null) return { state: 'null', value: null };
  return Array.isArray(o.value) ? { state: 'present', value: o.value } : { state: 'malformed', value: null };
}

// Model names are retained only if they look like model identifiers (e.g. `claude-opus-5-5`,
// `gemma4:26b`, `<synthetic>`); anything else — including path-like or free text — is invalid.
const MODEL_RE = /^(?:<synthetic>|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const isModel = (s: string): s is string => MODEL_RE.test(s);
const isSpeed = (s: string): s is 'standard' | 'fast' => s === 'standard' || s === 'fast';
const BUILD_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,32})?$/;
const isBuild = (s: string): s is string => BUILD_RE.test(s);

const THINKING_CONTENT_TYPES = new Set(['thinking', 'redacted_thinking']);

function observeComponent(
  read: ContainerRead<Record<string, unknown>>,
  role: ComponentObservation['role'],
  ordinal: number | null,
  final: boolean,
): ComponentObservation {
  const obj = read.value;
  const cc = recordContainer(obj, 'cache_creation');
  return {
    role,
    ordinal,
    final,
    container: read.state,
    model: stringField(obj, 'model', isModel),
    speed: stringField(obj, 'speed', isSpeed),
    inputTokens: numberField(obj, 'input_tokens'),
    outputTokens: numberField(obj, 'output_tokens'),
    cacheReadInputTokens: numberField(obj, 'cache_read_input_tokens'),
    cacheCreation: {
      flatTotal: numberField(obj, 'cache_creation_input_tokens'),
      container: cc.state,
      ephemeral5m: numberField(cc.value, 'ephemeral_5m_input_tokens'),
      ephemeral1h: numberField(cc.value, 'ephemeral_1h_input_tokens'),
    },
  };
}

function iterationEntry(entries: readonly unknown[], i: number): ContainerRead<Record<string, unknown>> {
  const o = own(entries, String(i));
  if (o.kind === 'absent') return { state: 'absent', value: null }; // sparse hole
  if (o.kind === 'accessor') return { state: 'malformed', value: null };
  if (o.value === null) return { state: 'null', value: null };
  return isRecord(o.value) ? { state: 'present', value: o.value } : { state: 'malformed', value: null };
}

function contentSignal(message: object | null): ClaudeRawObservation['thinking']['contentSignal'] {
  const content = arrayContainer(message, 'content');
  if (content.state !== 'present' || content.value === null) return 'unobservable';
  const blocks = content.value;
  for (let i = 0; i < blocks.length; i++) {
    const b = own(blocks, String(i));
    if (b.kind !== 'data' || !isRecord(b.value)) continue;
    const t = own(b.value, 'type');
    if (t.kind === 'data' && typeof t.value === 'string' && THINKING_CONTENT_TYPES.has(t.value)) return 'present';
  }
  return 'absent';
}

/** Observe one raw Claude Code assistant `message` object (the JSONL line's `message`). */
export function observeClaudeMessage(message: unknown, options: ObserveClaudeOptions = {}): ClaudeRawObservation {
  const dedupKeyClass = options.dedupKeyClass ?? 'unknown';
  if (!(DEDUP_KEY_CLASSES as readonly string[]).includes(dedupKeyClass)) {
    throw new TypeError('observeClaudeMessage: unrecognized dedupKeyClass');
  }
  let sourceBuild: StringObservation = { ...MISSING };
  if (options.sourceBuild !== undefined) {
    sourceBuild =
      typeof options.sourceBuild === 'string' && isBuild(options.sourceBuild)
        ? { state: 'reported', value: options.sourceBuild }
        : { ...INVALID };
  }

  const messageContainer: ContainerState = message === null ? 'null' : isRecord(message) ? 'present' : 'malformed';
  const msg = isRecord(message) ? message : null;
  const usage = recordContainer(msg, 'usage');
  const its = arrayContainer(usage.value, 'iterations');
  const entries = its.value ?? [];
  // Array.from (not map) so sparse holes still get an ordinal and an `absent` container.
  const components = Array.from({ length: entries.length }, (_, i) =>
    observeComponent(iterationEntry(entries, i), 'iteration', i, i === entries.length - 1),
  );
  const otd = recordContainer(usage.value, 'output_tokens_details');

  let topLevelDescribes: ClaudeRawObservation['topLevelDescribes'];
  if (its.state === 'present') topLevelDescribes = entries.length > 0 ? 'final-iteration' : 'whole-message';
  else if (its.state === 'absent') topLevelDescribes = usage.state === 'present' ? 'whole-message' : 'undetermined';
  else topLevelDescribes = 'undetermined';

  return {
    kind: 'raw-message',
    provenance: {
      contractVersion: CLAUDE_OBSERVATION_CONTRACT_VERSION,
      normalization: 'none',
      parser: CLAUDE_OBSERVATION_POLICIES.parser,
      thinkingSignal: CLAUDE_OBSERVATION_POLICIES.thinkingSignal,
      componentSelection: 'not-applied',
      dedup: 'not-applied',
      merge: 'not-applied',
      ttlFallback: 'not-applied',
      sourceBuild,
      dedupKeyClass,
    },
    messageContainer,
    messageModel: stringField(msg, 'model', isModel),
    topLevelDescribes,
    topLevel: observeComponent(usage, 'top-level', null, true),
    iterations: { container: its.state, length: its.state === 'present' ? entries.length : null, components },
    thinking: {
      contentSignal: contentSignal(msg),
      detailsContainer: otd.state,
      thinkingTokens: numberField(otd.value, 'thinking_tokens'),
    },
  };
}

// ── normalized legacy rows: values survive, presence does not ──────────────────────────────────

export type NormalizedFieldObservation =
  | { state: 'unknown-after-normalization'; normalizedValue: number }
  | { state: 'invalid'; normalizedValue: null };

export const LEGACY_ASSUMPTION_FLAGS = ['cacheSplitAssumed', 'thinkingUnknown', 'speedAssumed', 'reasoningClamped'] as const;
export type LegacyAssumptionFlag = (typeof LEGACY_ASSUMPTION_FLAGS)[number];

const LEGACY_TOKEN_KEYS = ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const;
type LegacyTokenKey = (typeof LEGACY_TOKEN_KEYS)[number];

export interface LegacyNormalizedObservation {
  kind: 'normalized-legacy';
  provenance: {
    contractVersion: typeof CLAUDE_OBSERVATION_CONTRACT_VERSION;
    normalization: 'tokenelo-normalized';
    parser: 'unknown';
    thinkingSignal: 'unknown';
    componentSelection: 'unknown';
    dedup: 'unknown';
    merge: 'unknown';
    ttlFallback: 'unknown';
  };
  normalized: Record<LegacyTokenKey, NormalizedFieldObservation>;
  /** The flat cache-creation total was discarded by normalization and is NOT reconstructed. */
  cacheCreationFlatTotal: { state: 'unknown-after-normalization'; value: null };
  containers: { cacheCreation: 'unknown'; outputTokensDetails: 'unknown'; iterations: 'unknown' };
  /** Flags recorded on the row. Absence of a flag is not evidence: older parsers may not have
   * emitted it. Unrecognized flags are dropped. */
  recordedFlags: LegacyAssumptionFlag[];
}

/** Wrap an already-normalized stored row (TokenCounts-shaped `tokens`, EventFlag-like `flags`).
 * Presence is never invented: every value is `unknown-after-normalization`, e.g. a normalized
 * reasoning 0 says nothing about whether output_tokens_details existed. */
export function observeNormalizedLegacy(tokens: unknown, flags?: unknown): LegacyNormalizedObservation {
  const src = isRecord(tokens) ? tokens : null;
  const normalized = {} as Record<LegacyTokenKey, NormalizedFieldObservation>;
  for (const k of LEGACY_TOKEN_KEYS) {
    const f = numberField(src, k);
    normalized[k] =
      f.state === 'reported'
        ? { state: 'unknown-after-normalization', normalizedValue: f.value }
        : { state: 'invalid', normalizedValue: null };
  }
  const recordedFlags: LegacyAssumptionFlag[] = [];
  if (Array.isArray(flags)) {
    const seen = new Set<unknown>();
    for (let i = 0; i < flags.length; i++) {
      const o = own(flags, String(i));
      if (o.kind === 'data') seen.add(o.value);
    }
    for (const flag of LEGACY_ASSUMPTION_FLAGS) if (seen.has(flag)) recordedFlags.push(flag);
  }
  return {
    kind: 'normalized-legacy',
    provenance: {
      contractVersion: CLAUDE_OBSERVATION_CONTRACT_VERSION,
      normalization: 'tokenelo-normalized',
      parser: 'unknown',
      thinkingSignal: 'unknown',
      componentSelection: 'unknown',
      dedup: 'unknown',
      merge: 'unknown',
      ttlFallback: 'unknown',
    },
    normalized,
    cacheCreationFlatTotal: { state: 'unknown-after-normalization', value: null },
    containers: { cacheCreation: 'unknown', outputTokensDetails: 'unknown', iterations: 'unknown' },
    recordedFlags,
  };
}
