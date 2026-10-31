/**
 * Structural duplicate of the subset of src/core/types.ts that the renderer needs.
 *
 * WHY THIS DUPLICATES core/types.ts INSTEAD OF IMPORTING IT: tsconfig.tray.json (owned by the
 * orchestrator; not to be edited here) sets `rootDir: "src/tray/renderer"` with a matching
 * `include`, specifically so DOM-lib types never leak into the Node-side project. Verified by
 * running `npx tsc -p tsconfig.tray.json` after importing core/types.ts directly from
 * renderer/charts.ts: TS6059 "File '.../src/core/types.ts' is not under 'rootDir'
 * '.../src/tray/renderer'" — TypeScript pulls in every file transitively referenced by an
 * `import type`, so even a type-only import trips this. Bundling (esbuild) doesn't care about
 * rootDir, so this split only matters for `tsc -p tsconfig.tray.json`, but that command is part
 * of the project's own typecheck story, so it must pass.
 *
 * CONTRACT NOTE (for the orchestrator): these types must be kept in sync with core/types.ts by
 * hand. A cleaner long-term fix would be a `paths`/project-reference remap in tsconfig.tray.json
 * itself, which is out of scope for this module (it owns src/tray/** only) — reported here
 * rather than edited.
 */

/** Fixed main-process marker; paths, credentials and live-source details stay behind IPC. */
export type SnapshotFixtureMarker = 'FILED-EXAMPLE' | null;

export type Source = 'claude' | 'codex' | 'ollama-proxy' | 'ollama-log' | 'qwen-code' | 'bench';
export type TsSource = 'line' | 'turn' | 'record' | 'frozen-line' | 'request' | 'activity';
export type Provider = 'anthropic' | 'openai' | 'local' | 'unknown';
export type Range = 'today' | '24h' | '7d' | '30d' | 'all';
export type RateStatus = 'MEASURED' | 'PROVISIONAL-MEASURED' | 'ESTIMATE' | 'FILED-EXAMPLE' | 'PLACEHOLDER' | 'NONE';
export type PriceStatus = 'LIST' | 'ESTIMATE' | 'UNPRICED';

/** Numeric read disclosure contract; mirrors core/token-field-evidence without
 * importing Node/domain code into the independent renderer compilation. */
export type TokenFieldKey = 'inputFresh' | 'cacheRead' | 'output' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheWriteUnassigned' | 'reasoning';
export interface TokenFieldEvidence {
  knownValue: number; knownParts: number; reportedParts: number; derivedParts: number; normalizedParts: number;
  assumedParts: number; notApplicableParts: number; missingParts: number; invalidParts: number; unrecordedParts: number;
}
export type TokenFieldCoverage = Record<TokenFieldKey, TokenFieldEvidence>;
export interface TokenCounts {
  fieldEvidence?: TokenFieldCoverage;
  inputFresh: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteUnassigned?: number;
  cacheWriteAssumed1h?: number;
  countQuality?: 'complete' | 'incomplete' | 'invalid' | 'conflict' | 'unrecorded';
  /** v1-fresh qualification override; absence inherits full count quality. */
  ucuCountQuality?: TokenCounts['countQuality'];
  cacheRead: number;
  output: number;
  reasoning: number;
}

export interface ModelRow {
  model: string;
  displayName: string;
  provider: Provider;
  source: Source;
  thinking: 'thinking' | 'non-thinking' | 'unknown';
  events: number;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  priceStatus: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  unpricedEvents?: number;
  estimatedPriceEvents?: number;
}

export interface LocalValue {
  captured: boolean;
  reason?: string;
  readEvidence?: { version: 1; state: 'malformed-components'; captureMode: 'off' | 'proxy' | 'serverlog' | 'both'; events: number; readableEvents: number; malformedComponentEvents: number };
  valueVsClaude: { usd: number | null; comparator: string; status: RateStatus; unratedEvents: number };
  valueVsGpt: { usd: number | null; comparator: string; status: RateStatus; unratedEvents: number };
  energy: { kwh: number | null; usd: number | null; status: 'MEASURED' | 'ESTIMATE' | 'NONE' };
  netSavingsVsClaude: number | null;
  netSavingsVsClaudeStatus: RateStatus;
  netSavingsVsGpt: number | null;
  netSavingsVsGptStatus: RateStatus;
  decodeTokPerSec?: number;
}

/** Price status of the dollars this row shows; absent or null from an older peer means unknown. */
export type PriceStatusLabel = 'LIST' | 'ESTIMATE' | 'UNPRICED';
export interface PriceEvidence { version: 1; events: number; invalidAmountEvents: number; unknownStatusEvents: number; statusAmountConflictEvents: number; issuesEvents: number; aggregateAmountInvalid: boolean }

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
  costBasis?: SubscriptionCostBasis;

  account: string;
  kind: 'claude' | 'codex';
  planName?: string;
  billedUsd: number | null;
  apiEquivUsd: number;
  leverage: number | null;
  unpricedEvents: number | null;
  /** Older peers may omit these: absent or null is unknown, never zero or LIST. */
  estimatedPriceEvents?: number | null;
  priceStatus?: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  partial: boolean | null;
}

export interface SummaryResponse {
  timeBasis?: QueryTimeBasis;

  host: string;
  range: Range;
  generatedAt: number;
  totals: { events: number; tokens: TokenCounts; apiEquivUsd: number; unpricedEvents: number; estimatedPriceEvents?: number; priceStatus?: 'LIST' | 'ESTIMATE' | 'UNPRICED' | null; priceEvidence?: PriceEvidence };
  bySource: Record<Source, { events: number; tokens: TokenCounts; apiEquivUsd: number; unpricedEvents?: number; estimatedPriceEvents?: number; priceStatus?: PriceStatusLabel | null; priceEvidence?: PriceEvidence }>;
  byModel: ModelRow[];
  local: LocalValue;
  subscriptions: SubscriptionRow[];
  activeTime: { agentMs: number; wallMs: number };
}

export interface FleetSummaryResponse {
  host: string;
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
  label: string;
  kind: 'local' | 'peer';
  status: 'online' | 'offline' | 'unauthorized' | 'untrusted' | 'not-configured' | 'report-timeout' | 'report-unavailable';
  summary?: FleetSummaryResponse;
}

export interface FleetOverviewResponse {
  range: Range;
  generatedAt: number;
  hosts: FleetHostResult[];
}

export interface SessionsResponse {
  timeBasis?: QueryTimeBasis;

  range: Range;
  /** Query clock (epoch ms) read once for the range boundary; not a snapshot identity or source completeness. Absent: unknown. Mirrors core/types.ts. */
  generatedAt?: number;
  sessions: SessionRow[];
}

export interface SessionTelemetryFeed {
  host: string;
  source: Source;
  provider: Provider;
  engine?: string;
  models: string[];
  events: number;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  unpricedEvents: number;
  /** Older peers may omit these: absent is unknown, never zero or LIST. */
  estimatedPriceEvents?: number;
  priceStatus?: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  firstEventAt: number;
  lastEventAt: number;
  flags: Partial<Record<EventFlag, number>>;
}

export interface ActivityTimeEvidence {
  version: 1;
  basis: 'no-marks' | 'activity-gaps' | 'reported-turn-durations';
  markCount: number;
  durationMarkCount: number;
  idleGapMs: number;
}

export interface SessionRow {
  priceEvidence?: PriceEvidence;
  estimatedPriceEvents?: number;
  priceStatus?: PriceStatusLabel | null;
  source: Source;
  sessionId: string;
  host: string;
  project?: string;
  repoRoot?: string;
  models: string[];
  start: number;
  end: number;
  activeMs: number;
  /** Missing on older peers: evidence unrecorded, not zero activity or process runtime. */
  activityEvidence?: ActivityTimeEvidence;
  live: boolean;
  subagents: number;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  /** Older peers may omit the count; omission is unknown, never zero. */
  unpricedEvents?: number;
  /** Optional for older daemon responses; counts describe the burn window, not the whole session. */
  burn: { tokensPerMin: number; usdPerHour: number; countQuality?: TokenCounts['countQuality']; priceQuality?: { events: number; unpricedEvents: number; estimatedPriceEvents: number; priceStatus: PriceStatus | null; priceEvidence?: PriceEvidence } } | null;
  telemetry?: SessionTelemetryFeed[];
}

export interface LimitWindow {
  priceEvidence?: PriceEvidence;
  countQuality?: TokenCounts['countQuality'];
  id: 'primary' | 'secondary' | 'five_hour' | 'seven_day' | 'spend_limit' | 'block_estimate';
  usedPercent: number | null;
  windowMinutes?: number;
  resetsAt?: number;
  /** block_estimate only: usage inside the current block and the projection to its end. */
  tokens?: number;
  apiEquivUsd?: number | null;
  burnTokensPerMin?: number;
  projectedTokens?: number;
  projectedUsd?: number | null;
  startedAt?: number;
}

/** Privacy-safe grouped contributors returned only for a derived Claude block estimate. */
export interface LimitContributor {
  host: string;
  model: string;
  provider: 'anthropic' | 'openai' | 'local' | 'unknown';
  /** Distinct component route evidence; missing legacy data is explicit. */
  servingRoutes: (
    | { kind: 'unrecorded' }
    | { kind: 'local'; evidence: 'metered-engine' }
    | { kind: 'hosted'; evidence: 'qwen-oauth' }
    | { kind: 'unknown'; evidence: 'qwen-openai-compatible' | 'unrecorded' | 'invalid' | 'conflicting-reports' }
  )[];
  priceVersion: string;
  tsSource: TsSource;
  firstEventAt: number;
  lastEventAt: number;
  events: number;
  tokens: TokenCounts;
  knownApiEquivUsd: number | null;
  priceStatusCounts: { LIST: number; ESTIMATE: number; UNPRICED: number; unknown: number };
  priceEvidence: PriceEvidence;
}

export interface LimitSnapshot {
  source: 'codex' | 'claude-statusline' | 'claude-block-estimate' | 'claude-desktop';
  /** Codex emits several rate_limits ids ('codex', 'premium', …); snapshots are keyed by (source, account, limitId). */
  limitId?: string;
  host: string;
  account?: string;
  capturedAt: number;
  planType?: string;
  windows: LimitWindow[];
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string };
  estimate: boolean;
  contributors?: LimitContributor[];
}

export interface LimitsResponse {
  snapshots: LimitSnapshot[];
}

export interface TimeseriesPoint {
  countQuality?: TokenCounts['countQuality'];
  ucuCountQuality?: TokenCounts['countQuality'];
  t: number;
  apiEquivUsd: number;
  tokens: number;
  /** Includes cache reads; absent on older daemons. */
  totalTokens?: number;
  /** This bucket's own price quality (absent on older daemons: unknown). */
  unpricedEvents?: number;
  estimatedPriceEvents?: number;
  priceStatus?: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
  bySource: Partial<Record<Source, number>>;
}

export interface TimeseriesResponse {
  timeBasis?: QueryTimeBasis;

  bucket: 'hour' | 'day';
  range: Range;
  /** Query clock (epoch ms) of the range boundary; not a snapshot identity and not a schema marker. Absent on older daemons: unknown. Mirrors core/types.ts. */
  generatedAt?: number;
  /** Capability: every point carries its price-quality counts, so an empty series is a known zero. Absent: unknown. Independent of generatedAt. Mirrors core/types.ts. */
  priceQualityCounts?: true;
  points: TimeseriesPoint[];
}

// ── Session detail (tray click-through) ─────────────────────────────────────────────────────────

export interface SessionDetailSubagent {
  sessionId: string;
  /** Older daemons omit the nested branch count. */
  subagents?: number;
  models: string[];
  start: number;
  end: number;
  activeMs: number;
  live: boolean;
  tokens: TokenCounts;
  apiEquivUsd: number | null;
  /** Older peers may omit the count; omission is unknown, never zero. */
  unpricedEvents?: number;
  estimatedPriceEvents?: number;
  priceStatus?: PriceStatusLabel | null;
  priceEvidence?: PriceEvidence;
}

export type EventFlag =
  | 'sessionAttributionConflict'
  | 'mergedComponentsMisaligned'
  | 'sessionContextUnrecorded' | 'sessionAttributionEnriched'
  | 'countSnapshotsIncomparable' | 'countSnapshotsCapped' | 'cacheTtlConflict' | 'cacheTtlInvalid'
  | 'cacheTtlUnassigned' | 'countBasisIncomplete' | 'countBasisInvalid' | 'legacyCountEvidenceMixed' | 'countPolicyUnsupported'
  | 'priceTierUnsupported' | 'priceContextInvalid' | 'servingRouteUnpriced' | 'servingRouteInvalid' | 'servingRouteConflict' | 'servingRouteMisaligned'
  | 'cacheSplitAssumed'
  | 'speedAssumed'
  | 'importedContext'
  | 'inheritedBaselineSuspect'
  | 'counterReset'
  | 'recordReconciled'
  | 'serverlogEstimate'
  | 'localViaClaudeJsonl'
  | 'reasoningClamped'
  | 'unpricedModel'
  | 'longContextBracket'
  | 'thinkingUnknown';

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
  byModel: ModelRow[];
  timeseries: { bucketMs: number; points: TimeseriesPoint[] };
  subagentSessions: SessionDetailSubagent[];
  cacheReadShare: number | null;
  thinkingShare: number | null;
  thinkingUnknownEvents: number;
  events: number;
  firstEventTs: number | null;
  lastEventTs: number | null;
  wallMs: number;
  flags: Partial<Record<EventFlag, number>>;
  gitBranch?: string;
  entrypoint?: string;
  desktopMeta?: DesktopSessionMeta;
}

export type SkipReason =
  | 'not-whitelisted'
  | 'memory-vault'
  | 'syncthing-versions'
  | 'nested-.claude'
  | 'sync-conflict'
  | 'unreadable'
  | 'timestamp-unavailable'
  | 'checkpoint-unverified'
  | 'import-only'
  | 'other';

// ── Live processes (build item 5) ───────────────────────────────────────────────────────────────

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  startedAt: number | null;
  exe: string;
  subcommand?: string;
  model?: string;
  cwd?: string;
  host: string;
  tool: string;
}

export interface ProcessesResponse {
  host: string;
  generatedAt: number;
  processes: ProcessInfo[];
  /** Whether `processes` is a measured listing. `unavailable` means the list is unknown, not empty. */
  listing?: ProcessListingStatus;
}

/** Status of the process listing behind a response. `observedAt` is when the listing completed (epoch ms),
 * which can be up to the cache TTL before the response was built; null when unavailable. Mirrors core/types.ts. */
export interface ProcessListingStatus {
  status: 'ok' | 'unavailable';
  observedAt: number | null;
  /** Optional current-daemon evidence: the bounded wait ended while the shared probe continued.
   * Missing on older daemons is unknown, not proof of failure. Mirrors core/types.ts. */
  probePending?: true;
}

// ── Coverage (build item 6) ──────────────────────────────────────────────────────────────────────

export type CoverageCategory = 'cloud-agent-cli' | 'cloud-agent-desktop' | 'local-llm-server' | 'other';

export interface CoverageEntry {
  id: string;
  name: string;
  category: CoverageCategory;
  installed: boolean;
  running: boolean;
  captured: boolean;
  /** Legacy field name: event source time or the selected plan snapshot capture time. */
  lastEventAt: number | null;
  /** Older responses do not identify this basis. */
  lastTelemetryTimeBasis?: 'event-recorded' | 'plan-captured' | null;
  captureSupport?: 'unsupported' | 'not-capturable';
  reason?: string;
}

export interface CoverageResponse {
  host: string;
  generatedAt: number;
  tools: CoverageEntry[];
  localCapture?: LocalCaptureCoverageStatus;
  collectorScans?: CollectorScanStatus[];
  incompleteCapture?: IncompleteCaptureStatus[];
  /** Status of the process listing behind `tools[].installed/running`. Mirrors core/types.ts. */
  processListing?: ProcessListingStatus;
}

export interface LocalCaptureCoverageStatus {
  mode: 'proxy' | 'serverlog' | 'both' | 'off';
  observedAt: number;
  dualSettle: {
    state: 'unobserved' | 'settling' | 'limit-reached' | 'history-incomplete' | 'backlog-review' | 'no-held-estimates' | 'unknown';
    pendingLogEstimates: number | null;
    pendingLimitReached: boolean | null;
    historyIncomplete: boolean | null;
    activePrimaryProxyRequests: number | null;
    backlogPending: number | null;
    backlogLastError: 'ledger-busy' | 'ledger-unavailable' | 'invalid-entry' | 'queue-unwritable' | 'backlog-full' | 'entry-too-large' | null;
    backlogReviewRequired: boolean | null;
  } | null;
}

/** Persisted Claude holds only; an absent field does not establish zero holds. */
export interface IncompleteCaptureStatus {
  collector: 'claude';
  heldFiles: number;
  oldestHeldAt: number | null;
  maxLineBytes: number | null;
  storedComponentEvidenceHeldFiles?: number;
}

export interface CollectorScanStatus {
  name: string;
  intervalMs: number;
  running: boolean;
  rerunQueued: boolean;
  currentStartedAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastCompletedAt: number | null;
  lastFailedAt: number | null;
  lastOutcome: 'completed' | 'warnings' | 'failed' | null;
  lastDurationMs: number | null;
  lastStats: {
    filesScanned: number; filesSkipped: number; recordsEmitted: number; bytesRead: number; warningCount: number;
    codexCursorCoverageAtStat?: {
      filesDiscovered: number; filesObservedAtStat: number; filesBehindCursorAtStat: number; bytesUnreadAtStat: number;
      filesWithoutUsableCursorAtStat: number; filesWithStatError: number; filesWithCursorStateError: number;
    };
  } | null;
}

// ── Plan usage history (build item 2) ───────────────────────────────────────────────────────────

export interface PlanUsagePoint {
  t: number;
  fiveHourUsedPercent: number | null;
  sevenDayUsedPercent: number | null;
}

export interface PlanUsageHistoryResponse {
  host: string;
  series: { account: string; points: PlanUsagePoint[] }[];
}

// ── Shared `window.tokenelo` bridge type ────────────────────────────────────────────────────────
//
// Mirrors preload.ts's TokeneloBridge (main-process side) exactly. Declared ONCE here — imported
// by BOTH app.ts (popover) and detail.ts (session-detail window) for their own `declare global`
// augmentation of `Window.tokenelo` — rather than each file declaring its own local subset/superset
// type, because TypeScript merges every `declare global` augmentation of the same ambient
// interface across a whole compilation unit (tsconfig.tray.json includes every renderer file), so
// two files augmenting `Window.tokenelo` with two DIFFERENT types is a compile error (verified:
// TS2717 "Subsequent property declarations must have the same type"). Both windows load the same
// preload.js, so both genuinely have every one of these methods available at runtime regardless
// of which ones a given window's own code calls.
export interface TokeneloBridge {
  getSnapshotFixtureMarker(): Promise<SnapshotFixtureMarker>;
  getSummary(range: Range, requestId?: string): Promise<SummaryResponse>;
  getUsage(range: Range, requestId?: string): Promise<UsageResponse>;
  cancelUsage(requestId: string): Promise<void>;
  onUsageProgress(cb: (progress: { requestId: string; range: Range; status: 'queued' | 'running'; phase?: string }) => void): void;
  cancelSummary?(requestId: string): Promise<void>;
  onSummaryProgress?(cb: (progress: { requestId: string; range: Range; status: 'queued' | 'running'; phase?: string }) => void): void;
  getSessions(range?: Range): Promise<SessionRow[]>;
  /** The full sessions envelope with its optional query clock. Optional: an older preload does not expose it (fall back to getSessions). */
  getSessionsResponse?(range?: Range): Promise<SessionsResponse>;
  getLimits(): Promise<LimitsResponse>;
  getTimeseries(range: Range): Promise<TimeseriesResponse>;
  getDoctor(): Promise<DoctorReport>;
  getCoverage(): Promise<CoverageResponse>;
  getProcesses(): Promise<ProcessesResponse>;
  getSessionDetail(source: Source, sessionId: string): Promise<SessionDetail>;
  getFleetOverview(range: Range): Promise<FleetOverviewResponse>;
  openSessionDetail(source: Source, sessionId: string): Promise<void>;
  onLoadSession(cb: (session: { source: Source; sessionId: string }) => void): void;
  closeSessionDetail(): Promise<void>;
  getTheme(): Promise<'light' | 'dark'>;
  onThemeChanged(cb: (theme: 'light' | 'dark') => void): void;
}

/** Current private metering backlog observation, separate from any pinned report snapshot. */
export interface MeteringBacklogStatus {
  observedAt: number;
  pending: number;
  quarantined: number;
  writeFailures: number;
  /** null: no stored snapshot; false: the current failure evidence could not be stored. */
  failureEvidenceStored?: boolean | null;
  historyIncomplete?: boolean;
  bytes: number;
  oldestQueuedAt: number | null;
  lastError: 'ledger-busy' | 'ledger-unavailable' | 'invalid-entry' | 'queue-unwritable' | 'backlog-full' | 'entry-too-large' | null;
}

/** Client-side package comparison from one authenticated health read; not persisted evidence. */
export type RuntimeBuildIdentityState = 'matching' | 'matching-dirty' | 'mismatch' | 'unknown';
export interface RuntimeBuildIdentityStatus {
  state: RuntimeBuildIdentityState;
  observedAt: number | null;
}

export interface DoctorReport {
  runtimeBuildIdentity?: RuntimeBuildIdentityStatus;
  priceEvidence?: PriceEvidence;
  host: string;
  generatedAt: number;
  skippedPaths: { reason: SkipReason; count: number; examples: string[] }[];
  unmatchedModels: { model: string; events: number }[];
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

/** The daemon's Usage pair comes from one worker-owned pinned read transaction and cutoff.
 * Filed fixtures are explicitly separate; matching query clocks alone never prove a snapshot. */
export interface UsageResponse {
  snapshotScope: 'shared-read-transaction' | 'filed-fixture';
  summary: SummaryResponse;
  timeseries: TimeseriesResponse;
}
