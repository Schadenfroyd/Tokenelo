/**
 * Tokenelo core contract — every collector, the store, the daemon API and the tray
 * build against these types. Owned by the orchestrator: module agents must not edit this file; request
 * changes instead. See docs/DESIGN.md (§3, §15 amendments win over earlier text).
 *
 * No prompt/response content ever appears in these types — metadata and counts only.
 */

// ── Identity ────────────────────────────────────────────────────────────────

/** Configured per host: 'M4a' | 'A2000' | 'ryzen' | … */
export type HostLabel = string;

/** Collector source identifiers accepted by both the local API and tray IPC. `bench` is retained only because
 * a ledger written by another edition may hold rows with that source; no collector in this edition emits it. */
export const USAGE_SOURCES = ['claude', 'codex', 'ollama-proxy', 'ollama-log', 'qwen-code', 'bench'] as const;
export type Source = (typeof USAGE_SOURCES)[number];

/** Model-table provider (DESIGN §15.1.6), qualified to unknown when explicit request
 * route evidence cannot support that table's local-serving assumption. */
export type Provider = 'anthropic' | 'openai' | 'local' | 'unknown';

// ── Tokens ──────────────────────────────────────────────────────────────────

/**
 * Normalized token fields. `output` INCLUDES reasoning/thinking; `reasoning` is the subset (0 if unknown).
 * Codex: inputFresh = max(0, Δinput − Δcached − Δcache_write) (§15.2.8). Ollama: all prompt tokens are inputFresh.
 */
export interface TokenCounts {
  /** Read-side field presence and assumptions; absent on legacy reports. */
  fieldEvidence?: import('./token-field-evidence.js').TokenFieldCoverage;
  inputFresh: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Known cache creation whose TTL was not reported. Absence in older rows is unrecorded. */
  cacheWriteUnassigned?: number;
  /** Subset of cacheWrite1h assigned by source policy, never reported 1h work. */
  cacheWriteAssumed1h?: number;
  /** Count basis, separate from price/calibration status. Absent on legacy APIs/rows. */
  countQuality?: 'complete' | 'incomplete' | 'invalid' | 'conflict' | 'unrecorded';
  /** Qualification of the fresh-input + cache-creation + output subset when different from full counts
   * (stored in the reserved `ucu_count_quality` column). Absent inherits countQuality; it never implies
   * omitted reads were reported zero. */
  ucuCountQuality?: TokenCounts['countQuality'];
  cacheRead: number;
  output: number;
  reasoning: number;
}

export const ZERO_TOKENS: Readonly<TokenCounts> = Object.freeze({
  inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0,
});

/** Content-free request provenance. Model/weights names alone do not establish a serving route.
 * Absent on legacy components; an explicit unknown must not use a local zero-dollar rate.
 * metered-engine is a policy slot, not an attestation or proof of an installed engine. */
export type ServingRouteEvidence =
  | { kind: 'local'; evidence: 'metered-engine' }
  | { kind: 'hosted'; evidence: 'qwen-oauth' }
  | { kind: 'unknown'; evidence: 'qwen-openai-compatible' | 'unrecorded' | 'invalid' | 'conflicting-reports' };

/** Passive source-field presence for Codex counters. This is not a completeness or count-quality claim. */
export type CodexUsageFieldName =
  | 'input_tokens'
  | 'cached_input_tokens'
  | 'cache_write_input_tokens'
  | 'output_tokens'
  | 'reasoning_output_tokens'
  | 'total_tokens';

export type CodexUsageFieldState = 'reported-zero' | 'reported-nonzero' | 'missing' | 'invalid' | 'unassessed';

export interface CodexFieldStateEvidence {
  schemaVersion: 1;
  source: 'token_usage_record.usage' | 'token_count.info.total_token_usage' | 'token_count.info.last_token_usage';
  basis: 'record-reconciled' | 'trailing-record' | 'first-own-last' | 'first-own-total-fallback' | 'counter-delta'
    | 'counter-reset-last' | 'counter-reset-total-fallback';
  /** Status only; raw values and session content are never copied into this metadata. */
  fields: Record<CodexUsageFieldName, CodexUsageFieldState>;
  /** Existing persisted cursors do not retain field-presence history for the prior cumulative sample. */
  priorPresence?: 'unassessed';
}

/** One priced unit. A Claude message with `usage.iterations` has one component per iteration. */
export interface UsageComponent {
  model: string;
  tokens: TokenCounts;
  /** Total prompt size of this request incl. cached (GPT-6 >272K whole-request bracket). */
  requestInput?: number;
  speed?: 'standard' | 'fast' | 'ultrafast';
  servingRoute?: ServingRouteEvidence;
  /** Content-free raw counters and versioned reconciliation, only on the new Claude adapter. */
  countEvidence?: import('../measurement/component-count-evidence.js').ComponentCountEvidence;
  /** Actual native engine fields, separate from Claude's counter schema and policy. */
  nativeCounterEvidence?: import('../measurement/native-counter-evidence.js').NativeCounterEvidence;
  /** Passive Codex raw-field state; it never changes token normalization, pricing, or count quality. */
  codexFieldStateEvidence?: CodexFieldStateEvidence;
}

/** Where `UsageEvent.ts` came from (Codex subagent/guardian files carry frozen line timestamps, §15.2.5). */
export type TsSource = 'line' | 'turn' | 'record' | 'frozen-line' | 'request' | 'activity';

export type EventFlag =
  | 'cacheSplitAssumed'        // Claude cache_creation split missing → 1h assumed
  | 'speedAssumed'             // priced Claude components include an absent speed, defaulting to standard
  | 'importedContext'          // Codex usage after an <EXTERNAL SESSION IMPORTED> marker
  | 'inheritedBaselineSuspect' // Codex first event after a turn with an unexplained baseline
  | 'counterReset'             // Codex cumulative counter decreased at this event
  | 'recordReconciled'         // Codex usage taken from token_usage_record ground truth
  | 'serverlogEstimate'        // Ollama usage parsed from the server log (ESTIMATE)
  | 'localViaClaudeJsonl'      // local model served through Claude Code's Anthropic-compatible endpoint
  | 'reasoningClamped'         // thinking_tokens > output_tokens, clamped
  | 'unpricedModel'            // no price row matched
  | 'longContextBracket'       // GPT-6 >272K bracket applied
  | 'thinkingUnknown'         // UsageEvent.thinking could not be determined for this source/line
  | 'mergedComponentsMisaligned' // duplicate lines carried different component structures
  | 'servingRouteMisaligned' // reported route cannot be attributed across mismatched components
  | 'sessionAttributionConflict' // duplicate Claude usage claimed another session; recorded owner retained
  | 'sessionContextUnrecorded' // activity supplied ownership; complete owner context remains unverified
  | 'sessionAttributionEnriched' // recorded evidence supplied a previously missing session id
  | 'countSnapshotsIncomparable'
  | 'countSnapshotsCapped'
  | 'cacheTtlConflict'
  | 'cacheTtlInvalid'
  | 'cacheTtlUnassigned'
  | 'countBasisIncomplete'
  | 'countBasisInvalid'
  | 'legacyCountEvidenceMixed'
  | 'countPolicyUnsupported'
  | 'priceTierUnsupported'
  | 'priceContextInvalid'
  | 'servingRouteUnpriced'
  | 'servingRouteConflict'
  | 'servingRouteInvalid';

// ── The normalized event (DESIGN §3) ───────────────────────────────────────

export interface UsageEvent {
  /** Ingestion-only activity join hint. Not persisted or returned by ledger read APIs. */
  collectorActivityUuid?: string;
  /** Ingestion-only: uuid was used because neither message.id nor requestId was supplied. */
  collectorFallbackUuidIdentity?: boolean;
  /** Globally unique dedup key: `claude:<message.id>` | `codex:<sessionId>:<ordinal|line>` | `ollama:<host>:<n>` | `bench:<run>:<item>:<repeat>` */
  id: string;
  host: HostLabel;
  source: Source;
  /** Epoch ms UTC. */
  ts: number;
  tsSource: TsSource;
  /** Claude sessionId FIELD (not file name) | Codex session id | proxy `<client>:<model>:<yyyy-mm-dd>` | bench run id */
  sessionId: string;
  parentSessionId?: string;
  isSubagent: boolean;
  /** cwd as recorded (never sent off-host unless fleet.sharePaths). */
  project?: string;
  repoRoot?: string;
  gitBranch?: string;
  /** Claude entrypoint | Codex originator | proxy User-Agent. */
  entrypoint?: string;
  /** Primary model = the last component's model. */
  model: string;
  provider: Provider;
  /**
   * Which local engine served this event, when a host meters more than one OpenAI-compatible
   * local server behind the generic metering proxy (DESIGN §15 build item 4: "generalize the
   * Ollama proxy so additional upstreams can be metered via config"). `undefined` on every
   * pre-existing single-Ollama-upstream event (backward compatible — never defaulted to
   * `'ollama'` after the fact, since older rows genuinely never recorded this). A configured
   * upstream's `name` (e.g. `'docker-model-runner'`, `'vllm'`) becomes this value; the default
   * Ollama proxy instance sets it to `'ollama'`. Deliberately NOT a new `Source` — the capture
   * *method* (source: 'ollama-proxy') is engine-agnostic reverse-proxy metering; the engine is
   * just which local server answered, same as `model` already varies per request.
   */
  engine?: string;
  effort?: string;
  /**
   * true = model reasoned/thought on this event; false = verified non-thinking (the source proved
   * absence, not merely didn't mention it); null/undefined = not determinable from this source's
   * data (flag `thinkingUnknown` set alongside). Per-source detection is evidence-based — see
   * collectors/claude.ts, collectors/codex.ts#detectCodexThinking, collectors/ollama-proxy.ts, and
   * collectors/ollama-serverlog.ts (always null: no per-request signal in the server log).
   */
  thinking?: boolean | null;
  speed?: 'standard' | 'fast';
  serviceTier?: string;
  inferenceGeo?: string;
  /** ≥ 1. Σ components = tokens. */
  components: UsageComponent[];
  tokens: TokenCounts;
  /** Model wall time when known (Ollama total_duration, Codex turn duration). */
  durationMs?: number;
  /** Local inference throughput when the engine reports it (Ollama eval/prompt durations). */
  perf?: { decodeTokPerSec?: number; prefillTokPerSec?: number; prefillCountBasis?: 'reported-uncached' | 'cache-zero-assumed' };
  flags: EventFlag[];

  // ── computed at ingest; recomputable via `tokenelo reprice` ──
  /** API-equivalent list-price $ ("not billed"). null = unpriced model. Local models: 0. */
  apiEquivUsd: number | null;
  priceStatus: PriceStatus;
  priceVersion: string;
  /**
   * Reserved compatibility fields: these three (plus the optional rate selection below) map to stored columns that exist
   * so one ledger can be opened by more than one edition (see src/store/migrations.ts). This edition writes a `null`
   * value, status `'NONE'` and an empty hash for new rows (unknown, never zero) and never computes or interprets them;
   * rows already stored are read back unchanged.
   */
  reservedValue: number | null;
  ucuRateStatus: RateStatus;
  eacsDefSha256: string;
  /** Reserved: the rate selection recorded with the row. null / absent = none recorded. */
  rateKey?: string | null;
  rateResolvedSha256?: string | null;
}

// ── Pricing (DESIGN §5, §15.4) ─────────────────────────────────────────────

export type PriceStatus = 'LIST' | 'ESTIMATE' | 'UNPRICED';

/** Class label carried by every row of rates/prices.json; validated at load, otherwise unused by this edition. */
export type EacsClass = 'ELO_GPT' | 'ELO_CLD' | 'ELO_GEM' | 'ELO_LMA';

/** Per-million-token USD rates. */
export interface RateColumns {
  in: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  out: number;
}

/** Explicit processing-tier prices. Long context stacks with the selected tier. */
export interface ProcessingPriceTier extends RateColumns {
  status: 'LIST' | 'ESTIMATE';
  derivedColumns?: ('cacheWrite5m' | 'cacheWrite1h')[];
  longContext?: RateColumns & { derivedColumns?: ('cacheWrite5m' | 'cacheWrite1h')[] };
}

export interface PriceRow {
  id: string;                 // canonical id, e.g. 'claude-opus-5-5'
  /** Regex source matched case-insensitively against the raw model id; rows are first-match in file order. */
  match: string;
  displayName: string;
  provider: Provider;
  eacsClass: EacsClass;
  local: boolean;
  rates: RateColumns;
  status: 'LIST' | 'ESTIMATE';
  fast?: ProcessingPriceTier;
  ultrafast?: ProcessingPriceTier;
  /** GPT-6: whole request priced at these rates when requestInput > thresholdInput. */
  longContext?: RateColumns & { thresholdInput: number };
  /** Data residency ×1.1 applies when inference_geo === 'us' (Claude 4.6+). */
  geoMultiplierUs?: number;
  /** Columns with no vendor-quoted figure (derived by convention). A component that bills one of them is priced ESTIMATE, never LIST. */
  derivedColumns?: ('cacheWrite5m' | 'cacheWrite1h')[];
  source: string;
  verifiedAt: string;         // ISO date
}

export interface PriceResult {
  usd: number | null;
  status: PriceStatus;
  rowId: string | null;
  flags: EventFlag[];
}

// ── Rate status (reserved compatibility vocabulary) ────────────────────────

/** Status vocabulary of the reserved `ucu_rate_status` column. This edition only ever writes `'NONE'` (no rate configured). */
export type RateStatus = 'MEASURED' | 'PROVISIONAL-MEASURED' | 'ESTIMATE' | 'FILED-EXAMPLE' | 'PLACEHOLDER' | 'NONE';

// ── Collectors & store ─────────────────────────────────────────────────────

export interface IngestState {
  /** e.g. absolute file path, or 'codex-sqlite:<path>' */
  key: string;
  size: number;
  mtimeMs: number;
  offset: number;
  ino?: number;
  /** Collector-private resume data (JSON-serializable), e.g. Codex previous totals / baseline for the file. */
  extra?: unknown;
}
// NOTE ino: must be a JS safe integer. NTFS file ids exceed 2^53 (A2000: 9,851,624,185,066,820);
// collectors store `Number(BigInt(stat.ino) % (2n**53n - 1n))` (fs.statSync(p, {bigint:true})).

/** Session activity marks (all line types, not just usage lines) for timers. Deduped globally by uuid (§15.7.1). */
export interface ActivityMark {
  source: Source;
  sessionId: string;
  ts: number;
  uuid?: string;
  host: HostLabel;
  project?: string;
  kind?: 'user' | 'assistant' | 'tool' | 'turn' | 'system' | 'request';
  /** Codex thread_turns duration when known. */
  durationMs?: number;
}

export interface LimitWindow {
  priceEvidence?: PriceEvidence;
  countQuality?: TokenCounts['countQuality'];
  id: 'primary' | 'secondary' | 'five_hour' | 'seven_day' | 'spend_limit' | 'block_estimate';
  usedPercent: number | null;
  windowMinutes?: number;
  resetsAt?: number;        // epoch ms
  /** block_estimate only: usage inside the current block and the projection to its end. */
  tokens?: number;
  apiEquivUsd?: number | null;
  burnTokensPerMin?: number;
  projectedTokens?: number;
  projectedUsd?: number | null;
  startedAt?: number;       // epoch ms
}

/** Privacy-safe grouped contributors for a locally-derived Claude block estimate.
 * These rows contain aggregate counts and source event-time bounds, never session ids or paths. */
export interface LimitContributor {
  host: HostLabel;
  model: string;
  provider: Provider;
  /** Distinct component route evidence for events in this group. Absence is kept explicit. */
  servingRoutes: LimitContributorRouteEvidence[];
  priceVersion: string;
  tsSource: TsSource;
  firstEventAt: number;
  lastEventAt: number;
  events: number;
  tokens: TokenCounts;
  /** Sum of numerically valid stored API-equivalent amounts; may be partial when some events are unpriced. */
  knownApiEquivUsd: number | null;
  priceStatusCounts: { LIST: number; ESTIMATE: number; UNPRICED: number; unknown: number };
  priceEvidence: PriceEvidence;
}

/** Missing legacy component route data is distinct from an explicit unknown route report. */
export type LimitContributorRouteEvidence = ServingRouteEvidence | { kind: 'unrecorded' };

export interface LimitSnapshot {
  /** 'claude-desktop': parsed from the Desktop app's own `plan-usage-history.json` (build item 2)
   * — genuine local plan-window telemetry, `estimate: false` (contrast `claude-block-estimate`,
   * which IS an estimate because the bare CLI persists nothing). */
  source: 'codex' | 'claude-statusline' | 'claude-block-estimate' | 'claude-desktop';
  /** Codex emits several rate_limits ids ('codex', 'premium', …); snapshots are keyed by (source, account, limitId). */
  limitId?: string;
  host: HostLabel;
  account?: string;
  capturedAt: number;       // epoch ms
  planType?: string;
  windows: LimitWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string };
  estimate: boolean;
  /** Present only for computed Claude block estimates; persisted vendor snapshots have no derived rows. */
  contributors?: LimitContributor[];
}

export type SkipReason =
  | 'not-whitelisted' | 'memory-vault' | 'syncthing-versions' | 'nested-.claude' | 'sync-conflict'
  | 'unreadable' | 'timestamp-unavailable' | 'checkpoint-unverified' | 'import-only' | 'other';

export interface EventUpsertOptions {
  /** Explicit CLI maintenance only: recompute recorded prices even when measurement inputs are unchanged. */
  reprice?: boolean;
}

export interface CodexContextCheckpointRecoveryCandidate {
  prior: IngestState;
  next: IngestState;
  claim: { host: HostLabel; sessionId: string };
}

export interface LedgerWriter {
  /** Per-field MAX upsert. Recompute changed measurement inputs; ordinary replay retains recorded valuation. */
  upsertEvents(events: UsageEvent[], options?: EventUpsertOptions): { inserted: number; updated: number; unchanged: number };
  recordActivity(marks: ActivityMark[]): void;
  recordLimits(snapshot: LimitSnapshot): void;
  recordSkipped(path: string, reason: SkipReason): void;
  /** Upserts Claude Desktop session metadata rows (build item 3), keyed by `cliSessionId` —
   * re-reading the same `local_<uuid>.json` file always replaces its row wholesale (the source
   * file is the sole owner of this row's truth), never merged field-by-field. */
  upsertDesktopSessionMeta(rows: (DesktopSessionMeta & { sourceFile: string })[]): void;
  getState(key: string): IngestState | undefined;
  /** Codex archive candidates only; complete prefix verification is owned by its collector. */
  codexStateCandidates?(sessionId: string, exceptKey: string): IngestState[];
  /** Key-only inventory for one scan's local archive lookup; no transcript JSON materialization. */
  codexStateKeys?(): string[];
  /** Compare-and-move one cursor row atomically; usage/prices/rowids remain untouched. */
  relocateState?(prior: IngestState, next: IngestState): boolean;
  /**
   * Same-key, compare-and-swap recovery for an independently verified unowned Codex context.
   * Writes only the cursor and an append-only receipt in `meta`; every accounting basis is checked
   * inside the same transaction. A false result means the evidence no longer qualifies.
   */
  recoverCodexContextCheckpoint?(prior: IngestState, next: IngestState, claim: { host: HostLabel; sessionId: string }): boolean;
  /** At most 256 candidates; one ownership scan per basis in one transaction, outcomes in input order. */
  recoverCodexContextCheckpoints?(candidates: readonly CodexContextCheckpointRecoveryCandidate[]): boolean[];
  setState(state: IngestState): void;
  /** Events of one source whose ts falls in [sinceTs, untilTs] (e.g. the serverlog-vs-proxy double-count guard). */
  recentEvents(source: Source, sinceTs: number, untilTs: number): UsageEvent[];
  /** Wrap a batch of writes in one transaction. REENTRANT: nested calls (and upsertEvents/recordActivity inside it) use SAVEPOINTs. */
  transaction<T>(fn: () => T): T;
}

export interface IngestContext {
  host: HostLabel;
  config: TokeneloConfig;
  store: LedgerWriter;
  /** Summary-only proxy observations durably queued but not yet applied to the ledger. */
  pendingProxyEvents?: (sinceTs: number, untilTs: number) => PendingProxyGuardEvent[];
  /** Number of currently admitted primary Ollama proxy requests, for bounded log-settle decisions. */
  primaryOllamaActiveRequests?: () => number;
  /** Current durable queue health used to finalize dual-capture log estimates. */
  meteringBacklogStatus?: () => MeteringBacklogStatus | null;
  pricing: PricingEngine;
  /** The valuation seam (src/core/null-engine.ts): fills the reserved compatibility columns of new rows. */
  computeUnits: EacsEngine;
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void;
  now: () => number;
}

/** Minimal queue projection used only by the local server-log duplicate guard. */
export interface PendingProxyGuardEvent {
  ts: number;
  durationMs?: number;
  outputTokens: number;
  engine?: string;
}

export interface IngestStats {
  collector: string;
  filesScanned: number;
  filesSkipped: number;
  eventsEmitted: number;
  bytesRead: number;
  warnings: string[];
  durationMs: number;
  /** Local Codex rollout byte cursors sampled at each file's stat time. Absent on other collectors. */
  codexCursorCoverageAtStat?: {
    filesDiscovered: number;
    filesObservedAtStat: number;
    filesBehindCursorAtStat: number;
    bytesUnreadAtStat: number;
    filesWithoutUsableCursorAtStat: number;
    filesWithStatError: number;
    filesWithCursorStateError: number;
  };
}

export interface Collector {
  readonly name: string;
  scan(ctx: IngestContext): Promise<IngestStats>;
}

// ── Engines (pricing: core/pricing.ts; valuation seam: core/null-engine.ts) ───

export interface PricingEngine {
  readonly version: string;                       // sha256 of canonical prices.json
  resolve(model: string): PriceRow | null;
  providerOf(model: string, route?: ServingRouteEvidence): Provider;
  priceComponent(c: UsageComponent, ctx?: { inferenceGeo?: string; batch?: boolean }): PriceResult;
  /** Σ components; null if any component is unpriced. */
  priceEvent(e: Pick<UsageEvent, 'components' | 'inferenceGeo'> & { tokens?: TokenCounts; flags?: EventFlag[] }): PriceResult;
}

/**
 * The valuation seam. This edition configures no valuation rates, so its only implementation
 * (core/null-engine.ts) reports an unknown value and records no definition or rate selection.
 */
export interface EacsEngine {
  /** Identity of the definition a new row was valued under. Empty = none. */
  readonly defSha256: string;
  /** The reserved compatibility value of one event: `null` + `'NONE'` = unknown (never zero). */
  ucuForEvent(e: Pick<UsageEvent, 'components' | 'effort' | 'thinking'> & { tokens?: TokenCounts; flags?: EventFlag[] }): { reservedValue: number | null; status: RateStatus };
  /** The rate selection recorded with a new row. `null` = none. */
  rateBasisOf(components: readonly UsageComponent[], effort?: string, think?: boolean | null): { rateKey: string | null; resolvedSha256: string | null };
}

// ── Config (DESIGN §2.2, §15.7) ────────────────────────────────────────────

export interface AccountConfig {
  id: string;
  kind: 'claude' | 'codex';
  hosts: HostLabel[];
  planName?: string;
  /** Actual billed per month (founder-entered; never guessed). */
  monthlyUsd?: number;
}

export interface TokeneloConfig {
  hostLabel: HostLabel;
  accounts: AccountConfig[];
  idleGapMs: number;                       // default 5 min
  claude: { roots?: string[]; maxLineBytes?: number }; // roots default: $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects; maxLineBytes default 32 MiB (a file over it is held)
  codex: { homes?: string[] };             // default: $CODEX_HOME or ~/.codex
  /** Qwen Code CLI (build item 1). Default root: `~/.qwen`. */
  qwen: { roots?: string[] };
  /** Claude Desktop app's own data (build items 2/3): plan-usage-history.json (real plan-window
   * %) and claude-code-sessions/local-agent-mode-sessions metadata (session/PR/repo attribution).
   * Default root: the platform's Claude Desktop `Application Support`-equivalent dir. */
  claudeDesktop: { root?: string };
  local: {
    capture: 'proxy' | 'serverlog' | 'both' | 'off';
    ollamaUpstream: string;                // 'http://127.0.0.1:11434'
    proxyPort: number;                     // 11444
    proxyInjectUsage: boolean;             // default false
    proxyMaxBodyBytes?: number;            // default 33554432 (32 MiB) — collectors/ollama-proxy.ts
    serverLogPath?: string;                // auto-detected when absent
    wattsEstimate?: number;
    tariffUsdPerKwh?: number;
    /** Additional OpenAI-compatible local engines to meter via the same generic reverse-proxy
     * mechanics as the primary Ollama proxy (build item 4), e.g. Docker Model Runner on M4a
     * (`{name:'docker-model-runner', upstream:'http://127.0.0.1:12434', listenPort:12444}`) or
     * vLLM on ryzen. Each entry gets its own listener; events are tagged `UsageEvent.engine =
     * name` and still land on `source: 'ollama-proxy'` (see that field's own doc). Independent of
     * `capture` — these are opt-in extra engines, not the primary Ollama capture-mode switch. */
    upstreams?: { name: string; upstream: string; listenPort: number }[];
  };
  api: { port: number };                   // 47821
  fleet: {
    /** Exact Tailscale interface IP. Empty/null disables the listener; never binds 0.0.0.0. */
    listenAddress: string | null;
    peers: { label: HostLabel; url: string }[];
    sharePaths: boolean;
  };
}

// ── Daemon HTTP API (read-only; bearer auth; DESIGN §15.7.3) ───────────────

export type Range = 'today' | '24h' | '7d' | '30d' | 'all';

export interface ModelRow {
  model: string;
  displayName: string;
  provider: Provider;
  source: Source;
  /** Thinking-mode bucket every row in this group shares (byModel is split by it — DESIGN founder req. 2026-09-27). */
  thinking: 'thinking' | 'non-thinking' | 'unknown';
  events: number;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  unpricedEvents?: number;
  estimatedPriceEvents?: number;
}

/** An explicit "unavailable" comparator value: no comparator rate is configured in this edition, so the value is unknown (`usd: null`), never zero. */
export interface ComparatorValue { usd: number | null; comparator: string; status: RateStatus; unratedEvents: number }

export interface LocalValue {
  captured: boolean;
  reason?: string;                         // 'local capture not configured' etc.
  /** Local estimate read scope, separate from token-count/rate quality and fresh capture. */
  readEvidence?: { version: 1; state: 'malformed-components'; captureMode: 'off' | 'proxy' | 'serverlog' | 'both'; events: number; readableEvents: number; malformedComponentEvents: number };
  valueVsClaude: ComparatorValue;
  valueVsGpt: ComparatorValue;
  energy: { kwh: number | null; usd: number | null; status: 'MEASURED' | 'ESTIMATE' | 'NONE' };
  /** Net = comparator value − energy $; unknown whenever either is unknown. */
  netSavingsVsClaude: number | null;
  netSavingsVsClaudeStatus: RateStatus;
  netSavingsVsGpt: number | null;
  netSavingsVsGptStatus: RateStatus;
  decodeTokPerSec?: number;
}

import type { PriceStatusLabel, PriceQuality } from './price-quality.js';
import type { PriceEvidence } from './price-evidence.js';

export interface SubscriptionCostBasis {
  state: 'configured-proration' | 'price-unconfigured' | 'price-invalid' | 'period-unavailable' | 'period-invalid';
  monthlyUsd: number | null;
  rangeStartMs: number | null;
  rangeEndMs: number;
  prorationDays: 30;
  origin: 'configured-plan-price';
  invoiceVerified: false;
}

/** A query-clock fence on recorded timestamps; it does not attest source clocks or completeness. */
export interface QueryTimeBasis {
  startMs: number | null;
  asOfMs: number;
  endInclusive: true;
  timestampBasis: 'recorded-timestamps';
  excludedFutureEvents: number;
  excludedFutureActivity: number;
}

export interface SubscriptionRow {
  account: string;
  kind: 'claude' | 'codex';
  planName?: string;
  billedUsd: number | null;                // legacy name: configured plan-cost proration, not an invoice
  /** Absent on older daemons: the denominator basis is unavailable. */
  costBasis?: SubscriptionCostBasis;
  apiEquivUsd: number;
  leverage: number | null;                 // apiEquiv / billed
  /** Events in range with no price (missing from apiEquivUsd). null = unknown; never read as zero. */
  unpricedEvents: number | null;
  /** Priced events whose price used a derived rate column (ESTIMATE). null = unknown. */
  estimatedPriceEvents: number | null;
  /** Weakest price status of this account's dollars (events on its hosts and kind only). null = unknown or no events. */
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  /** true: leverage is partial (some events unpriced). false: none unpriced. null: unknown. */
  partial: boolean | null;
}

export interface SummaryResponse {
  host: HostLabel;
  range: Range;
  generatedAt: number;
  timeBasis?: QueryTimeBasis;
  /** priceStatus is the weakest price status of the dollars; estimatedPriceEvents counts ESTIMATE-priced events (their dollars are not LIST). */
  totals: { events: number; tokens: TokenCounts; apiEquivUsd: number; unpricedEvents: number; estimatedPriceEvents: number; priceStatus: 'LIST' | 'ESTIMATE' | 'UNPRICED' | null; priceEvidence?: PriceEvidence };
  bySource: Record<Source, { events: number; tokens: TokenCounts; apiEquivUsd: number; unpricedEvents?: number; estimatedPriceEvents?: number; priceStatus?: PriceStatusLabel | null; priceEvidence?: PriceEvidence }>;
  byModel: ModelRow[];
  local: LocalValue;
  subscriptions: SubscriptionRow[];
  activeTime: { agentMs: number; wallMs: number };
}

/** The only data exposed by the optional Tailscale fleet listener. It deliberately omits session,
 * project, repository, branch, process, and account identifiers. */
export interface FleetSummaryResponse {
  host: HostLabel;
  range: Range;
  generatedAt: number;
  /** unpricedEvents is null when the peer did not send the field (an older daemon): unknown, never zero. */
  /** Older peers may omit the price-quality fields: they are null (unknown), never zero or LIST. */
  totals: Omit<SummaryResponse['totals'], 'unpricedEvents' | 'estimatedPriceEvents' | 'priceStatus'> & {
  unpricedEvents: number | null;
  estimatedPriceEvents: number | null;
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  };
  bySource: SummaryResponse['bySource'];
  activeTime: SummaryResponse['activeTime'];
}

export interface FleetHostResult {
  label: HostLabel;
  kind: 'local' | 'peer';
  status: 'online' | 'offline' | 'unauthorized' | 'untrusted' | 'not-configured' | 'report-timeout' | 'report-unavailable';
  summary?: FleetSummaryResponse;
}

export interface FleetOverviewResponse {
  range: Range;
  generatedAt: number;
  hosts: FleetHostResult[];
}

/** A session's usage grouped by the recorded capture feed, without inferring a local engine
 * from a model name or process. Event timestamps describe recorded usage, not collector scans. */
export interface SessionTelemetryFeed {
  host: HostLabel;
  source: Source;
  provider: Provider;
  engine?: string;
  models: string[];
  events: number;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  unpricedEvents: number;
  /** Priced events whose price used a derived rate column (ESTIMATE). Same events as apiEquivUsd. */
  estimatedPriceEvents: number;
  /** Weakest price status of this feed's own events; null when it has none. */
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  firstEventAt: number;
  lastEventAt: number;
  flags: Partial<Record<EventFlag, number>>;
}

/** Evidence for the marks used by activeMs, not process runtime or capture completeness. */
export interface ActivityTimeEvidence {
  version: 1;
  basis: 'no-marks' | 'activity-gaps' | 'reported-turn-durations';
  markCount: number;
  durationMarkCount: number;
  idleGapMs: number;
}

export interface SessionRow {
  source: Source;
  sessionId: string;
  host: HostLabel;
  /** Events in this session with no price. apiEquivUsd sums only the priced events, so any count above 0 makes it partial. */
  unpricedEvents: number;
  /** Priced events in this session whose price used a derived rate column (ESTIMATE). */
  estimatedPriceEvents: number;
  /** Weakest price status of this session's dollars; null when the session has no events. */
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  project?: string;
  repoRoot?: string;
  models: string[];
  start: number;
  end: number;
  activeMs: number;
  /** Absent on older daemons: active-time basis is unrecorded, never inferred from activeMs. */
  activityEvidence?: ActivityTimeEvidence;
  live: boolean;
  subagents: number;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  /** Quality covers the same recent events as the rates; absent on older responses, never known zero. */
  burn: { tokensPerMin: number; usdPerHour: number; countQuality?: TokenCounts['countQuality']; priceQuality?: PriceQuality } | null;   // last 15 min
  /** Absent only on older daemons; an empty array means activity with no usage events. */
  telemetry?: SessionTelemetryFeed[];
}

export interface LimitsResponse { snapshots: LimitSnapshot[] }

/** `GET /v1/limits/history` (build item 2's "time series of plan usage available via API") —
 * every `claude-desktop` plan-usage sample ever ingested (not just the newest, unlike
 * `LimitsResponse`), grouped by hashed account. */
export interface PlanUsagePoint {
  t: number;
  fiveHourUsedPercent: number | null;
  sevenDayUsedPercent: number | null;
}
export interface PlanUsageHistoryResponse {
  host: HostLabel;
  series: { account: string; points: PlanUsagePoint[] }[];
}

export interface SessionsResponse {
  timeBasis?: QueryTimeBasis;

  range: Range;
  /**
   * Epoch ms of the query clock read once at the start of this request, for its range boundary (`since` is derived from it; it is
   * not itself a lower cutoff). It is NOT a database revision, a shared snapshot identity, or a statement of source completeness:
   * equal or different values from two responses (this one and a Summary, say) neither prove nor disprove that they read the same
   * data. Absent on older daemons: unknown, never inferred from when the client received the response.
   */
  generatedAt?: number;
  sessions: SessionRow[];
}

export interface TimeseriesPoint {
  t: number;
  apiEquivUsd: number;
  /** Fresh input + cache writes + output, retained for compatibility with the v1 token basis. */
  tokens: number;
  /** All input/write/read/output tokens, excluding the reasoning subset. Older daemons omit it. */
  totalTokens?: number;
  /** Numeric token columns are category subtotals if this basis is unresolved. */
  countQuality?: TokenCounts['countQuality'];
  /** Qualification of the fresh-input + cache-creation + output subset; absence inherits full count quality. */
  ucuCountQuality?: TokenCounts['countQuality'];
  /** Price quality of THIS bucket's dollars (its own events). Absent on older daemons: unknown, never LIST. */
  unpricedEvents?: number;
  estimatedPriceEvents?: number;
  priceStatus?: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  /** API-equivalent USD per source, never token counts. */
  bySource: Partial<Record<Source, number>>;
}
export interface TimeseriesResponse {
  bucket: 'hour' | 'day';
  range: Range;
  timeBasis?: QueryTimeBasis;
  /**
   * Epoch ms of the query clock read once for this response's range boundary. It is NOT a database revision or snapshot identity:
   * equal or different values from two responses neither prove nor disprove that they read the same data. It says nothing about which
   * point fields the responder sends. Absent on older daemons: unknown.
   */
  generatedAt?: number;
  /**
   * Capability: this responder sends unpricedEvents/estimatedPriceEvents on every point, so an empty `points` is a known zero count.
   * Absent (older daemons, or any responder that does not declare it): an empty series' counts are unknown. Independent of generatedAt.
   */
  priceQualityCounts?: true;
  points: TimeseriesPoint[];
}

// ── Session detail (tray click-through; founder req. 2026-09-27 "session listing should open to
// more data when clicked, in a larger window") ─────────────────────────────────────────────────

/** One direct child branch, including its recorded descendants. The detail list contains direct
 * children; SessionDetail.subagents counts all descendants included in the session totals. */
export interface SessionDetailSubagent {
  sessionId: string;
  /** Recorded descendants included in this branch's totals. */
  subagents?: number;
  models: string[];
  start: number;
  end: number;
  activeMs: number;
  live: boolean;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  unpricedEvents: number;
  estimatedPriceEvents: number;
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
}

/**
 * `GET /v1/sessions/detail?source=&sessionId=`. Extends `SessionRow` with everything the tray's
 * detail window needs in one round trip. Never includes prompt/response content — metadata and
 * counts only, same as every other type in this file (DESIGN §2 "No prompt or response content is
 * ever stored").
 */
/**
 * Claude Desktop's own session/PR bookkeeping (build item 3), parsed read-only from
 * `claude-code-sessions/**\/local_<uuid>.json` (metadata only — no token/usage fields exist in
 * that store; verified empirically, docs/research/agent-inventory-2026-09-27.md). Joined onto a
 * `SessionDetail` by `cliSessionId === sessionId` (the field in that file that IS the real Claude
 * Code CLI session id already ingested from `~/.claude/projects/**\/*.jsonl`) — never a separate
 * token source, purely repo/PR/title attribution for the detail window.
 */
export interface DesktopSessionMeta {
  cliSessionId: string;
  cwd?: string;
  originCwd?: string;
  title?: string;
  model?: string;
  effort?: string;
  isArchived?: boolean;
  createdAt?: number;
  lastActivityAt?: number;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
  prState?: string;
}

export interface SessionDetail extends SessionRow {
  /** Per-model breakdown, already split by thinking mode (same shape as the Usage tab's byModel). */
  byModel: ModelRow[];
  /** Activity-bucketed tokens/$ time series; bucket size is chosen from this session's own
   * span (store/queries.ts#chooseSessionBucketMs), not the tray's global hour/day buckets. */
  timeseries: { bucketMs: number; points: TimeseriesPoint[] };
  /** Child sessions folded into this row for `SessionRow` purposes, broken back out here with
   * their own totals. */
  subagentSessions: SessionDetailSubagent[];
  /** Share (0-1) of gross prompt tokens (inputFresh+cacheWrite5m+cacheWrite1h+cacheRead) served
   * from cache; null when the session has no gross prompt tokens at all (nothing to take a share
   * of — never displayed as 0%, which would imply zero cache reuse rather than no data). */
  cacheReadShare: number | null;
  /** Share (0-1) of events with thinking=true, of the events where thinking is determinable
   * (true or false); null when every event's thinking mode is unknown. */
  thinkingShare: number | null;
  /** Events whose thinking mode could not be determined (`thinkingUnknown`), excluded from
   * `thinkingShare`'s denominator. */
  thinkingUnknownEvents: number;
  /** Total usage events folded into this session (its own + every subagent's). */
  events: number;
  firstEventTs: number | null;
  lastEventTs: number | null;
  /** end − start (this session's own wall span). `activeMs` (inherited from SessionRow) is the
   * gap-summed active time over that same span — the "active vs wall time" pair. */
  wallMs: number;
  /** Count of events carrying each flag (own + subagents'); a flag absent from every event is
   * omitted from this object entirely, never shown as an explicit 0. */
  flags: Partial<Record<EventFlag, number>>;
  gitBranch?: string;
  entrypoint?: string;
  /** Claude Desktop session/PR metadata for this session, when `source === 'claude'` and a
   * `claude-code-sessions` file's `cliSessionId` matches — `undefined` otherwise (never guessed;
   * most sessions were never opened through the Desktop app's Code feature at all). */
  desktopMeta?: DesktopSessionMeta;
}

/** Current private metering backlog observation, separate from any pinned report snapshot. */
export interface MeteringBacklogStatus {
  observedAt: number;
  pending: number;
  quarantined: number;
  writeFailures: number;
  /** null: no stored snapshot; false: the current failure evidence could not be stored. */
  failureEvidenceStored?: boolean | null;
  /** Known failure counts are a lower bound when prior diagnostic bytes cannot be read. */
  historyIncomplete?: boolean;
  bytes: number;
  oldestQueuedAt: number | null;
  lastError: 'ledger-busy' | 'ledger-unavailable' | 'invalid-entry' | 'queue-unwritable' | 'backlog-full' | 'entry-too-large' | null;
}

/** Tray-side comparison of its package identity with the daemon's authenticated health response.
 * This is not daemon-generated, persisted, or a claim about loaded code or capture completeness. */
export type RuntimeBuildIdentityState = 'matching' | 'matching-dirty' | 'mismatch' | 'unknown';
export interface RuntimeBuildIdentityStatus {
  state: RuntimeBuildIdentityState;
  observedAt: number | null;
}

export interface DoctorReport {
  /** Added by the tray client; absent from older daemon responses and stored reports. */
  runtimeBuildIdentity?: RuntimeBuildIdentityStatus;
  priceEvidence?: PriceEvidence;
  host: HostLabel;
  generatedAt: number;
  skippedPaths: { reason: SkipReason; count: number; examples: string[] }[];
  unmatchedModels: { model: string; events: number }[];
  /** Events whose `thinking` mode is null (not determinable from the source) — flag `thinkingUnknown`. */
  thinkingUnknownEvents: number;
  codex: {
    resetFiles: number;
    inheritedBaselineFiles: number;
    suspectFiles: number;
    recordReconciledFiles: number;
    nonZeroCacheWrite: number;
    /** §15.10.1: files with own token_counts counted while a replayed `rollout-N` wrapper was open. */
    ownInWrapperFiles: number;
    /** Σ such events (summary.ownInWrapperEvents). */
    ownInWrapperEvents: number;
    /** Files whose trailing own token_usage_records (no later token_count) were emitted once idle. */
    trailingRecordFiles: number;
  };
  claude: { speedAssumed: number; cacheSplitAssumed: number; iterationEvents: number; reasoningClamped: number };
  /** Persisted Claude hold counts only; an absent field on older responders means unknown, not zero. */
  incompleteCapture?: IncompleteCaptureStatus[];
  ollama: {
    /** Every live server found behind the configured port (M4a runs Homebrew on IPv4 AND Ollama.app on IPv6). */
    servers: { address: string; family: 'IPv4' | 'IPv6'; version: string; binary?: string; logPath?: string; logAvailable: boolean }[];
    unmeteredRequests: number;
    /** Current queue status, absent on older/no-proxy runtimes. Zero is not a capture audit. */
    backlog?: MeteringBacklogStatus;
    capture: string;
  };
  warnings: string[];
}

// ── Live process sniffer (build item 5) ─────────────────────────────────────

/**
 * One running process recognized as a known AI agent / LLM server (`data/agent-catalog.ts`'s
 * `id`). Never carries raw argv — only the executable path/name plus a small allow-listed
 * `subcommand`/`model` extracted from argv (e.g. `exec`, `-p`, `--model <value>`); every other
 * argument is redacted (DESIGN §2 "no prompt/response content ever stored" extends here: argv can
 * carry prompts via `-p "..."` or similar, so only known-safe flags are ever read out of it).
 */
export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  /** epoch ms; null when the platform/tool this host uses could not report a start time. */
  startedAt: number | null;
  /** Executable path (or bare name when a path could not be resolved) — never full argv. */
  exe: string;
  /** One allow-listed subcommand/flag actually observed on this process's argv (e.g. `'exec'`,
   * `'-p'`, `'app-server'`, `'serve'`) — never a raw argument value. */
  subcommand?: string;
  /** The value of an allow-listed `--model`/`-m` flag, when present. */
  model?: string;
  /** Working directory, where obtainable (`lsof -p` on macOS, `/proc/<pid>/cwd` on Linux, WMI on
   * Windows) — best-effort, `undefined` when the platform/permissions didn't allow it. */
  cwd?: string;
  host: HostLabel;
  /** The `data/agent-catalog.ts` entry id this process matched. */
  tool: string;
}

export interface ProcessesResponse {
  host: HostLabel;
  generatedAt: number;
  processes: ProcessInfo[];
  /** Whether `processes` is a measured listing. `unavailable` means the list is unknown, not empty. */
  listing?: ProcessListingStatus;
}

/** Status of the process listing behind a response. `observedAt` is when the listing completed (epoch ms),
 * which can be up to the cache TTL before the response was built; null when unavailable. */
export interface ProcessListingStatus {
  status: 'ok' | 'unavailable';
  observedAt: number | null;
  /** Present only when the response's bounded wait ended before its shared probe settled.
   * The observation is still unknown. Absence on older daemons does not imply a failed probe. */
  probePending?: true;
}

// ── Coverage (build item 6) ─────────────────────────────────────────────────

export type CoverageCategory = 'cloud-agent-cli' | 'cloud-agent-desktop' | 'local-llm-server' | 'other';

/**
 * One row of the known-agent catalog (`data/agent-catalog.ts`), joined with live detection for
 * this host: `installed`/`running` come from `ProcessInfo`/path checks; `captured` is true when a
 * collector for this tool has ever recorded an event (`lastEventAt` its newest one); a tool this
 * host has never seen at all is `installed: false, captured: false` with no `reason` (nothing to
 * explain yet — never confused with "not capturable", which is a tool this codebase has decided
 * NOT to build a collector for, e.g. Cursor's spend, per docs/research/agent-inventory-2026-09-27.md).
 */
export interface CoverageEntry {
  id: string;
  name: string;
  category: CoverageCategory;
  installed: boolean;
  running: boolean;
  captured: boolean;
  /** Legacy field name: newest matching event time, or plan capture time for plan-only tools. */
  lastEventAt: number | null;
  /** Omitted by older responders; null when no matching telemetry time is recorded. */
  lastTelemetryTimeBasis?: 'event-recorded' | 'plan-captured' | null;
  /** Omitted by older responders: current adapter support is unknown. This is not a claim about vendor telemetry availability. */
  captureSupport?: 'unsupported' | 'not-capturable';
  /** Why this tool is not capturable at all (e.g. 'usage only server-side'), or why detection is
   * partial on this host — omitted when there is nothing to explain. */
  reason?: string;
}

export interface CoverageResponse {
  host: HostLabel;
  generatedAt: number;
  tools: CoverageEntry[];
  /** Configured local-capture mode and aggregate dual-capture settle state, when exposed by this daemon. */
  localCapture?: LocalCaptureCoverageStatus;
  /** Scheduled scan observations from this daemon process. Omitted by older/static responders. */
  collectorScans?: CollectorScanStatus[];
  /** Persisted incomplete-capture counts, one entry per collector that can hold a file. Omitted by
   * older responders: treat an absent field as unknown, not as zero. Aggregate only. */
  incompleteCapture?: IncompleteCaptureStatus[];
  /** Status of the process listing that produced each entry's `running` flag. When `unavailable`, every
   * `running` value is unknown and must not be shown as "not running". Omitted by older responders. */
  processListing?: ProcessListingStatus;
}

export interface LocalCaptureCoverageStatus {
  mode: TokeneloConfig['local']['capture'];
  observedAt: number;
  dualSettle: DualCaptureCoverageStatus | null;
}

export interface DualCaptureCoverageStatus {
  state: 'unobserved' | 'settling' | 'limit-reached' | 'history-incomplete' | 'backlog-review' | 'no-held-estimates' | 'unknown';
  /** Aggregate count only; null means settle state could not be read or validated. */
  pendingLogEstimates: number | null;
  pendingLimitReached: boolean | null;
  historyIncomplete: boolean | null;
  activePrimaryProxyRequests: number | null;
  backlogPending: number | null;
  backlogLastError: MeteringBacklogStatus['lastError'] | null;
  backlogReviewRequired: boolean | null;
}

/** Aggregate incomplete-capture state for one collector. No paths, line text, or session content. */
export interface IncompleteCaptureStatus {
  collector: 'claude';
  /** Files currently held at a line the collector will not ingest. Persisted, so it survives restarts
   * and quiet scans, and includes held files that are no longer present on disk. */
  heldFiles: number;
  /** Earliest time a currently held file was first held (epoch ms), or null when none are held. */
  oldestHeldAt: number | null;
  /** Line cap of the oldest hold, or null when no hold or its cause is stored evidence. */
  maxLineBytes: number | null;
  /** Optional on older responders. Subset of heldFiles rejected on malformed stored components,
   * not a line-size diagnosis. Other files continue; these batches remain uncommitted. */
  storedComponentEvidenceHeldFiles?: number;
}

/** Bounded runtime observations, independent of the event ledger's last usage timestamp. */
export interface CollectorScanStatus {
  name: string;
  intervalMs: number;
  running: boolean;
  rerunQueued: boolean;
  currentStartedAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  /** Last resolved scan, including scans that returned warnings. */
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
  lastOutcome: 'completed' | 'warnings' | 'failed' | null;
  /** Scheduler-measured monotonic duration, not a difference between wall-clock timestamps. */
  lastDurationMs: number | null;
  /** The most recent attempt's metrics; null on failure or when no stats were returned.
   * Emitted records can be deduplicated/upserted, and are not a count of new ledger inserts. */
  lastStats: {
    filesScanned: number;
    filesSkipped: number;
    recordsEmitted: number;
    bytesRead: number;
    warningCount: number;
    /** Per-file scan-time Codex cursor snapshot; absent on older daemons/other collectors. */
    codexCursorCoverageAtStat?: {
      filesDiscovered: number;
      filesObservedAtStat: number;
      filesBehindCursorAtStat: number;
      bytesUnreadAtStat: number;
      filesWithoutUsableCursorAtStat: number;
      filesWithStatError: number;
      filesWithCursorStateError: number;
    };
  } | null;
}

/** The daemon's Usage pair comes from one worker-owned pinned read transaction and cutoff.
 * Filed fixtures are explicitly separate; matching query clocks alone never prove a snapshot. */
export interface UsageResponse {
  snapshotScope: 'shared-read-transaction' | 'filed-fixture';
  summary: SummaryResponse;
  timeseries: TimeseriesResponse;
}
