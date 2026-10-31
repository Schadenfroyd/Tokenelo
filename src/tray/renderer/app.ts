import { aggregatePriceFields, priceFieldReview, priceFieldsUsable } from './price-evidence.js';
import { localSessionPriceCopy } from './local-session-price-copy.js';
import { usageComparisonCopy, usageQueryClockCopy, usageQueryClockLine } from './usage-comparison-copy.js';
import {
  API_EQUIVALENT_BASIS_NOTE, LOCAL_COMPARATOR_BASIS_NOTE, LOCAL_SAVINGS_BASIS_NOTE, priceEvidenceLabel,
} from './quality.js';
import { evidenceNumber } from './evidence-number.js';
import { dollarSourceEvidence, type DollarSourceEvidence, type DollarSourceIssueReason } from './dollar-source-evidence.js';
import { positionChartTooltip } from './chart-tooltip.js';
import { aggregateTokenText, countBasisLabel, exactTokenLabel, hasKnownEmptyUsage, tokenTotalText, unresolvedCounts } from './token-counts.js';
import { tokenPeriodEvidence } from './token-period.js';
import { activityTimeLabel } from './activity-time.js';
import { ProcessRefresh, ProcessObservations, processProbePending, coverageWithProcessObservation } from './process-refresh.js';
import { burnMoneyText } from './detail-burn.js';
import { readNowData } from './now-read.js';
import { limitSubjectLabel } from './limit-subject.js';
import { codexAccountMetadataCopy } from './codex-account-metadata.js';
import { limitWindowTimingLabels } from './limit-window-timing.js';
import { limitContributorView } from './limit-contributor-view.js';
import { usageModelRowCopy, usageModelToggleLabel } from './usage-model-copy.js';
import { localModelSessionDrilldownAllowed, localModelSessionMatches } from './local-model-sessions.js';
/**
 * Popover renderer entry point (vanilla TS, no frameworks). Bundled by esbuild
 * (scripts/build-tray.mjs) into dist/tray/renderer/app.js and loaded by index.html as a
 * `<script type="module">` under a strict CSP (no inline scripts/styles, no remote origins).
 * Talks to the daemon only through `window.tokenelo` (preload.ts's contextBridge surface) — never
 * fetch/XHR directly, per the CSP's `connect-src 'none'`.
 *
 * Seven tabs: Now, Sessions, Usage, Local, Limits, Coverage and Fleet. Every dollar figure is labelled
 * "API-equivalent".
 */
import type {
  CoverageEntry,
  CoverageResponse,
  CollectorScanStatus,
  DoctorReport,
  FleetHostResult,
  FleetOverviewResponse,
  LimitContributor,
  LimitsResponse,
  LimitSnapshot,
  LimitWindow,
  ModelRow,
  ProcessesResponse,
  Range,
  SessionsResponse,
  SnapshotFixtureMarker,
  SessionRow,
  Source,
  SubscriptionRow,
  SummaryResponse,
  UsageResponse,
  TimeseriesResponse,
  TokeneloBridge,
} from './api-types.js';
import { CHART_SOURCES, chartLegend, describePoint, renderStackedBarChart } from './charts.js';
import { collectorScanStatus } from './collector-status.js';
import { claudeCaptureHoldView } from './capture-completeness.js';
import {
  formatApiEquivSubtotal,
  formatClock,
  formatQueryClock,
  formatCompactNumber,
  formatDuration,
  formatMoney,
  formatPercent,
  projectBasename,
  sessionDisplayName,
  statusTone,
} from './format.js';
import { ViewGate, type View } from './view-gate.js';
import { RequestCache } from './request-cache.js';
import { DoctorView, type DoctorContent, type ReadOrigin } from './doctor-view.js';
import { doctorBuildIdentityBadge, doctorSummary } from './doctor-summary.js';
import { failureMessage, isSummaryCancelled } from './request-failure.js';
import { initialRange, isRangeScopedTab } from './initial-scope.js';
import { usageTimelineEmptyCaption } from './usage-empty.js';
import { usageResponseEvidence, type FieldEvidence } from './response-evidence.js';
import { recordedWindowDisclosure, RECORDED_WINDOW_QUALIFICATION, responseTimingWarning } from './recorded-window.js';
import { fixtureExampleNotice, showUsageFixtureInlineNotice } from './fixture-example.js';

// `TokeneloBridge` (the FULL bridge, shared with detail.ts) is imported rather than declared
// locally here — see api-types.ts's header comment on that type for why two renderer files can't
// each augment `Window.tokenelo` with their own different subset/superset type.
declare global {
  interface Window {
    tokenelo: TokeneloBridge;
    __tokeneloReady?: boolean;
  }
}

type TabName = 'now' | 'sessions' | 'usage' | 'local' | 'limits' | 'coverage' | 'fleet';
const TABS: TabName[] = ['now', 'sessions', 'usage', 'local', 'limits', 'coverage', 'fleet'];

/**
 * VERIFIED (2026-09-26, via the founder's real Chrome — Claude-in-Chrome MCP against a page
 * serving this exact CSP): index.html's `style-src 'self'` (no `'unsafe-inline'`) silently drops
 * a `style` attribute set through `setAttribute('style', …)` — `el()`'s original one-size-fits-all
 * `node.setAttribute(k, v)` loop — even though `.style.cssText = …` (CSSOM) is NOT restricted by
 * the same policy. Confirmed with a minimal same-CSP test page: `el.setAttribute('style', …)`
 * left the element's computed background/width untouched, while `el.style.cssText = …` on an
 * identical element applied normally. This is why every inline-`style`-via-`el()` caller in this
 * file (the chart legend swatches, the Limits-tab meter-fill bars) rendered as if no `style` had
 * been set at all — a real, verified bug, not a guess. Fixed at the root here: `style` goes
 * through `.style.cssText`, every other attribute keeps using `setAttribute`.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style') node.style.cssText = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) for (const c of children) node.append(c);
  return node;
}

function badge(status: string, tone = statusTone(status)): HTMLElement {
  return el('span', { class: `badge tone-${tone} badge-sm` }, [status]);
}

function apiEquivalentBasisNote(extraClass = ''): HTMLElement {
  const classes = ['label-note', 'api-equiv-basis-note', extraClass].filter(Boolean).join(' ');
  return el('div', { class: classes }, [API_EQUIVALENT_BASIS_NOTE]);
}

// ── App state ──────────────────────────────────────────────────────────────────────────────────

interface State {
  tab: TabName;
  range: Range;
  /** Written only by the current Coverage render, for the row helpers that read it while building the body. */
  coverage: CoverageResponse | null;
  /** Re-requested on each Now render. The daemon may reuse a successful process observation;
   * use listing.observedAt, not the response timestamp, for its time. */
  processes: ProcessesResponse | null;
  /** Renderer-session preference; retained across Refresh and tab navigation. */
  processesExpanded: boolean;
  processRefresh: ProcessRefresh | null;
  fleetHost: string;
  nowTicker: number | null;
  fixtureExample: boolean;
}

const processObservations = new ProcessObservations();
const state: State = {
  tab: 'now',
  range: 'today',
  coverage: null,
  processes: null,
  processesExpanded: false,
  processRefresh: null,
  fleetHost: 'fleet',
  nowTicker: null,
  fixtureExample: false,
};

function panel(): HTMLElement {
  return document.getElementById('panel') as HTMLElement;
}

// ── Data loading (cached per range; re-fetched on range switch or Refresh) ───────────────────────

/** Runs a handler's async work so a failure reaches the UI instead of an unhandled rejection. */
function contain(task: Promise<void>, onFailure: (message: string) => void): void {
  task.catch((err: unknown) => onFailure(err instanceof Error ? err.message : String(err)));
}

/** A failure that is not attributable to one tab: shown in the panel body. It does not touch aria-busy, which belongs to the current render. */
function showFatal(message: string): void {
  panel().replaceChildren(el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Something went wrong']),
    el('div', { class: 'label-note' }, [message]),
  ]));
  signalSnapshotFailure();
}

function signalSnapshotFailure(): void {
  window.__tokeneloReady = false;
  window.__tokeneloFailure = 'renderer-load';
  window.dispatchEvent(new Event('tokenelo:failed'));
}

/** The view a render belongs to (view-gate.ts). Renders build into their own stage; only the current one commits. */
type TabView = View<HTMLElement, { tab: TabName; range: Range }>;

/** The body shown while a changed selection loads: the empty-state styling, announced politely. */
function loadingPlaceholder(): HTMLElement {
  return el('div', { class: 'empty-state', role: 'status' }, ['Loading…']);
}

const gate = new ViewGate<HTMLElement, { tab: TabName; range: Range }>({
  createStage: () => document.createElement('div'),
  commit: (stage) => {
    // Preserve the host selector only while it still owns focus. A newer navigation or
    // another focused control must never have its focus taken by a completed render.
    const fleetSelectorFocused = document.activeElement?.matches('.fleet-host-select');
    panel().replaceChildren(...Array.from(stage.childNodes));
    if (fleetSelectorFocused) {
      panel().querySelector<HTMLSelectElement>('.fleet-host-select')?.focus({ preventScroll: true });
    }
  },
  clear: () => panel().replaceChildren(loadingPlaceholder()),
  setBusy: (busy) => {
    if (busy) panel().setAttribute('aria-busy', 'true');
    else panel().removeAttribute('aria-busy');
  },
  setReady: (ready) => {
    window.__tokeneloReady = ready;
    if (ready) window.dispatchEvent(new Event('tokenelo:ready'));
  },
});

// ── Data loading (per-key caches, re-fetched after Refresh; see request-cache.ts) ──────────────────

const summaryCache = new RequestCache<Range, SummaryResponse>();
const usageCache = new RequestCache<Range, UsageResponse>();
const sessionsCache = new RequestCache<Range, SessionsResponse>();
const fleetCache = new RequestCache<Range, FleetOverviewResponse>();
const limitsCache = new RequestCache<'limits', LimitsResponse>();
const coverageCache = new RequestCache<'coverage', CoverageResponse>();
const doctorCache = new RequestCache<'doctor', DoctorReport>();

let activeSummaryRead: { id: string; view: TabView } | null = null;
window.tokenelo.onSummaryProgress?.((progress) => {
  const read = activeSummaryRead;
  if (!read || !read.view.current() || progress.requestId !== read.id || progress.range !== read.view.key.range) return;
  let status = panel().querySelector<HTMLElement>('.summary-report-status');
  if (status?.dataset.readId !== read.id) status = null;
  if (!status) {
    const copy = el('div', { class: 'label-note', role: 'status' });
    const cancel = el('button', { type: 'button', class: 'refresh-btn', 'aria-label': 'Cancel historical usage report' }, ['Cancel report']);
    cancel.addEventListener('click', () => {
      if (activeSummaryRead !== read || !read.view.current()) return;
      cancel.disabled = true; copy.textContent = 'Cancelling historical report…';
      void window.tokenelo.cancelSummary?.(read.id).catch(() => {});
    });
    status = el('div', { class: 'empty-state summary-report-status' }, [copy,
      el('div', { class: 'label-note' }, ['You can choose a shorter period while this runs.']), cancel]);
    status.dataset.readId = read.id;
    panel().replaceChildren(status);
  }
  const copy = status.querySelector<HTMLElement>('[role="status"]')!;
  copy.textContent = progress.status === 'queued' ? 'Waiting to read all history…'
    : progress.phase === 'reading-activity' ? 'Reading recorded activity…' : 'Preparing the all-history usage report…';
});
async function ensureSummary(range: Range, view?: TabView): Promise<SummaryResponse> {
  return summaryCache.load(range, async () => {
    if (range !== 'all' || !view) return window.tokenelo.getSummary(range);
    const read = { id: crypto.randomUUID().replaceAll('-', ''), view }; activeSummaryRead = read;
    try { return await window.tokenelo.getSummary(range, read.id); }
    finally { if (activeSummaryRead === read) activeSummaryRead = null; }
  });
}

let activeUsageRead: { id: string; view: TabView } | null = null;
window.tokenelo.onUsageProgress?.((progress) => {
  const read = activeUsageRead;
  if (!read || !read.view.current() || progress.requestId !== read.id || progress.range !== read.view.key.range) return;
  let status = panel().querySelector<HTMLElement>('.usage-report-status');
  if (status?.dataset.readId !== read.id) status = null;
  if (!status) {
    const copy = el('div', { class: 'label-note', role: 'status' });
    const cancel = el('button', { type: 'button', class: 'refresh-btn', 'aria-label': 'Cancel historical usage report' }, ['Cancel report']);
    cancel.addEventListener('click', () => {
      if (activeUsageRead !== read || !read.view.current()) return;
      cancel.disabled = true; copy.textContent = 'Cancelling historical report…';
      void window.tokenelo.cancelUsage?.(read.id).catch(() => {});
    });
    status = el('div', { class: 'empty-state usage-report-status' }, [copy,
      el('div', { class: 'label-note' }, ['You can choose a shorter period while this runs.']), cancel]);
    status.dataset.readId = read.id;
    panel().replaceChildren(status);
  }
  const copy = status.querySelector<HTMLElement>('[role="status"]')!;
  copy.textContent = progress.status === 'queued' ? 'Waiting to read all history…'
    : progress.phase === 'reading-activity' ? 'Reading recorded activity…' : 'Preparing the all-history usage report…';
});
async function ensureUsage(range: Range, view: TabView): Promise<UsageResponse> {
  return usageCache.load(range, async () => {
    const read = { id: crypto.randomUUID().replaceAll('-', ''), view }; activeUsageRead = read;
    try { return await window.tokenelo.getUsage(range, read.id); }
    finally { if (activeUsageRead === read) activeUsageRead = null; }
  });
}


async function ensureSessionsResponse(range: Range): Promise<SessionsResponse> {
  return sessionsCache.load(range, async () => window.tokenelo.getSessionsResponse
    ? window.tokenelo.getSessionsResponse(range)
    : { range, sessions: await window.tokenelo.getSessions(range) });
}

/** Refresh: every cache drops its values, and any load still in flight is retired (it cannot repopulate what was cleared). */
function invalidateCaches(): void {
  processObservations.clear();
  for (const cache of [summaryCache, usageCache, sessionsCache, fleetCache, limitsCache, coverageCache, doctorCache]) {
    cache.clear();
  }
}

// ── Now tab ────────────────────────────────────────────────────────────────────────────────────

function sourceLabel(source: SessionRow['source']): string {
  switch (source) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'ollama-proxy':
      return 'Local proxy';
    case 'ollama-log':
      return 'Local server log';
    case 'bench':
      return 'Bench';
    case 'qwen-code':
      return 'Qwen Code';
  }
}

/**
 * A session row is clickable everywhere it appears (Now tab, Sessions tab — task item "clicking a
 * session row opens a separate, larger BrowserWindow"): `data-open-source`/`data-open-session-id`
 * carry what to open, and one delegated click/keydown listener per container (wired by
 * `wireSessionRowClicks`) opens it via the bridge. Rows are focusable (`tabindex`, `role=button`)
 * so Enter/Space work exactly like a click, not just a mouse click.
 */
function openableRowAttrs(session: Pick<SessionRow, 'source' | 'sessionId' | 'project' | 'repoRoot'>): Record<string, string> {
  return { tabindex: '0', role: 'button', 'data-open-source': session.source, 'data-open-session-id': session.sessionId,
    'aria-label': `${sessionDisplayName(session)} · ${sourceLabel(session.source)} · session ${session.sessionId}` };
}

/** Delegated click/keydown handler for a container of openable rows — call once per rendered
 * list (re-rendering replaces the DOM, so this is re-wired each render, same pattern as this
 * file's other event wiring, e.g. wireChartTooltip). */
function wireSessionRowClicks(container: HTMLElement): void {
  function openFrom(target: Element | null): void {
    const row = target?.closest<HTMLElement>('[data-open-session-id]');
    if (!row) return;
    const source = row.dataset.openSource as SessionRow['source'];
    const sessionId = row.dataset.openSessionId as string;
    void window.tokenelo.openSessionDetail(source, sessionId);
  }
  container.addEventListener('click', (e) => openFrom(e.target as Element));
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as Element).closest<HTMLElement>('[data-open-session-id]');
    if (!row) return;
    e.preventDefault();
    openFrom(e.target as Element);
  });
}

/** The legacy API's live flag means recent recorded activity, not an observed process. */
function sessionIsRecent(session: SessionRow, now: number): boolean {
  return session.live && now - session.end < 5 * 60_000;
}

function recentActivityMarker(): HTMLElement {
  return el('span', { class: 'live-dot', role: 'img', 'aria-label': 'Recent recorded activity',
    title: 'Recorded activity within the last 5 minutes; running process state is observed separately.' });
}

/** The daemon's explicit empty feed means no selected usage events. Missing feeds are unknown. */
function sessionHasNoRecordedUsage(session: SessionRow): boolean {
  return Array.isArray(session.telemetry) && session.telemetry.length === 0;
}

/** Activity-only records explain a selected population; unknown telemetry is not empty. */
function activityOnlyCoverage(sessions: readonly SessionRow[], period: string, compact = false): HTMLElement | null {
  const activity = sessions.filter(sessionHasNoRecordedUsage);
  if (!activity.length) return null;
  const sources = new Map<SessionRow['source'], number>();
  for (const session of activity) sources.set(session.source, (sources.get(session.source) ?? 0) + 1);
  const button = el('button', { type: 'button', class: 'refresh-btn session-activity-coverage-link',
    'aria-label': 'Review capture coverage for sessions with activity only' }, ['Review capture coverage']);
  button.addEventListener('click', () => contain(selectTab('coverage').then(() => {
    if (state.tab === 'coverage') {
      panel().scrollTop = 0;
      document.getElementById('tab-coverage')?.focus();
    }
  }), showFatal));
  const explanation = el('div', { class: 'activity-only-explanation', 'data-activity-only-count': String(activity.length) }, [
    el('p', { class: 'label-note' }, [`${activity.length.toLocaleString()} ${activity.length === 1 ? 'session has' : 'sessions have'} activity without recorded usage events ${period}.`]),
    el('p', { class: 'label-note' }, [[...sources].map(([source, count]) => `${sourceLabel(source)} · ${count.toLocaleString()}`).join(' · ')]),
    el('p', { class: 'label-note' }, ['Activity records do not establish token usage or capture completeness. Review the source scans and capture configuration.']),
    button,
  ]);
  if (!compact) return explanation;
  return el('div', { class: 'activity-only-compact', 'data-activity-only-count': String(activity.length) }, [
    el('details', { class: 'session-activity-disclosure' }, [
      el('summary', { class: 'response-evidence-toggle tone-neutral' }, [
        el('span', {}, ['Activity without token records']),
        el('span', { class: 'label-note' }, [`${activity.length.toLocaleString()} ${activity.length === 1 ? 'session' : 'sessions'} ${period}`]),
      ]),
      explanation,
    ]),
    el('p', { class: 'label-note activity-only-qualification' }, ['Activity does not establish token usage or capture completeness.']),
  ]);
}

function renderNowRow(session: SessionRow, now: number, localModels: ReadonlySet<string> | null): HTMLElement {
  const isLive = sessionIsRecent(session, now);
  const noUsage = sessionHasNoRecordedUsage(session);
  const elapsed = Math.max(0, (isLive ? now : session.end) - session.start);
  const model = session.models[session.models.length - 1] ?? '(unknown model)';
  const apiEquivBurn = session.burn === null ? 'API-equiv —/h' : `API-equiv ${burnMoneyText(session.burn)}`;
  const entirelyLocal = session.telemetry !== undefined
    ? session.telemetry.length > 0 && session.telemetry.every((feed) => feed.provider === 'local')
    : localModels === null ? null
      : session.models.length > 0 && session.models.every((id) => localModels.has(`${session.source}\u0000${id}`));
  const activityText = noUsage ? 'No usage events in this range' : entirelyLocal
    ? `Local · ${tokenTotalText(session.tokens)} tok`
    : entirelyLocal === null ? `Usage · ${tokenTotalText(session.tokens)} tok`
      : `${apiEquivBurn} · ${tokenTotalText(session.tokens)} tok`;
  return el(
    'div',
    { class: 'row-item now-session-row', 'data-start': String(session.start), 'data-end': String(session.end), 'data-live': String(session.live), ...openableRowAttrs(session) },
    [
      el('span', { class: `source-dot ${session.source}` }),
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, [
          isLive ? recentActivityMarker() : '',
          sessionDisplayName(session),
        ]),
        el('div', { class: 'row-sub' }, [`${sourceLabel(session.source)} · ${noUsage ? 'Session activity' : model}`]),
      ]),
      el('div', { class: 'row-metrics' }, [
        el('span', { class: 'num elapsed-cell' }, [formatDuration(elapsed)]),
      ]),
      el('span', { class: 'row-sub session-activity-line', title: activityTimeLabel(session).title }, [activityTimeLabel(session).text]),
      el('span', {
        class: 'num label-note now-session-usage',
        title: noUsage ? 'Activity was recorded without usage events in this range; capture completeness is not established.' : entirelyLocal ? 'Local-model activity; API-equivalent value is shown in the Local tab' : entirelyLocal === null ? 'Provider classification is unavailable because today’s summary could not be read. Recorded session counters remain available.' : 'API-equivalent hourly burn over the trailing 15 minutes',
      }, [activityText]),
    ]
  );
}

function tickNowTimers(): void {
  const now = Date.now();
  for (const rowEl of Array.from(document.querySelectorAll<HTMLElement>('.row-item[data-start]'))) {
    const start = Number(rowEl.dataset.start);
    const end = Number(rowEl.dataset.end);
    const isLive = rowEl.dataset.live === 'true' && Number.isFinite(end) && now - end < 5 * 60_000;
    const cell = rowEl.querySelector<HTMLElement>('.elapsed-cell');
    if (cell) cell.textContent = formatDuration(Math.max(0, (isLive ? now : end) - start));
    const title = rowEl.querySelector<HTMLElement>('.row-title');
    const liveDot = title?.querySelector<HTMLElement>('.live-dot');
    if (isLive && title && !liveDot) title.prepend(recentActivityMarker());
    else if (!isLive) liveDot?.remove();
  }
}

/** Build item 5: a live process row, correlated to the session list by cwd (best-effort — a
 * process with no readable cwd, or one that just started and has no ledger event yet, still gets
 * its own row, just without a project name). */
function processRow(p: ProcessesResponse['processes'][number]): HTMLElement {
  const started = p.startedAt !== null ? new Date(p.startedAt).toLocaleString() : '—';
  const subParts = [p.exe.split(/[\\/]/).pop() ?? p.exe];
  if (p.subcommand) subParts.push(p.subcommand);
  if (p.model) subParts.push(p.model);
  subParts.push(`started ${started}`);
  return el('div', { class: 'row-item' }, [
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title' }, [p.cwd ? projectBasename(p.cwd) : `pid ${p.pid}`]),
      el('div', { class: 'row-sub' }, [subParts.join(' · ')]),
    ]),
  ]);
}

function processObservation(processes: ProcessesResponse): HTMLElement {
  const unavailable = processes.listing?.status === 'unavailable';
  const card = el('div', { class: 'process-observation-content' }, [
    el('div', { class: 'section-title' }, [`Process observation · ${processes.host}`]),
    el('div', { class: 'label-note' }, [processObservationText(processes.listing)]),
  ]);
  if (unavailable || processes.processes.length === 0) {
    card.append(el('div', { class: 'empty-state' }, [unavailable
      ? 'Current running state is unknown.'
      : processes.listing?.status === 'ok'
        ? 'No recognized agent processes in this observation.'
        : 'No processes reported; detection status is unavailable.']));
    return card;
  }
  const list = el('div', { class: 'row-list', id: 'now-observed-processes' });
  const toggle = el('button', { type: 'button', class: 'refresh-btn process-toggle', 'aria-controls': list.id });
  const update = (): void => {
    const visible = state.processesExpanded ? processes.processes : processes.processes.slice(0, 3);
    list.replaceChildren(...visible.map(processRow));
    toggle.textContent = state.processesExpanded ? 'Show fewer' : `Show all ${processes.processes.length} observed processes`;
    toggle.setAttribute('aria-expanded', String(state.processesExpanded));
  };
  update();
  card.append(list);
  if (processes.processes.length > 3) {
    toggle.addEventListener('click', () => { state.processesExpanded = !state.processesExpanded; update(); });
    card.append(toggle);
  }
  return card;
}

/** Today's freshly requested summary, shown separately from observed process state. */
function nowUsageOverview(summary: SummaryResponse): HTMLElement {
  const evidence = tokenPeriodEvidence(summary, 'today');
  const review = el('button', { type: 'button', class: 'refresh-btn now-usage-open' }, ['Review Today’s usage']);
  review.addEventListener('click', () => {
    state.range = 'today';
    setActiveButton(document.getElementById('range-switch') as HTMLElement, '.range-btn', 'data-range', 'today');
    contain(selectTab('usage').then(() => document.getElementById('tab-usage')?.focus()), showFatal);
  });
  const generated = new Date(summary.generatedAt);
  return el('section', { class: 'card token-period now-usage-overview', 'aria-label': 'Recorded usage overview · today',
    'data-range': 'today', 'data-generated-at': String(summary.generatedAt),
    'data-count-state': evidence.empty ? 'empty' : evidence.totalAvailable ? 'available' : 'unavailable' }, [
    el('div', { class: 'section-title' }, ['Recorded usage · today']),
    el('dl', { class: 'token-period-components' }, [
      el('div', {}, [el('dt', {}, [evidence.headline]), el('dd', {}, [
        el('strong', { class: 'num token-period-headline', title: exactTokenLabel(summary.totals.tokens),
          'aria-label': exactTokenLabel(summary.totals.tokens) }, [tokenTotalText(summary.totals.tokens)]),
      ])]),
      el('div', {}, [el('dt', {}, ['API-equivalent']), el('dd', {}, [
        el('strong', { class: 'num token-period-headline' }, [formatApiEquivSubtotal(summary.totals)]),
      ])]),
    ]),
    el('div', { class: 'label-note count-quality' }, [evidence.basis]),
    ...(priceEvidenceLabel(summary.totals) ? [el('div', { class: 'label-note price-quality' }, [priceEvidenceLabel(summary.totals)!])] : []),
    el('div', { class: 'label-note' }, [`${summary.totals.events.toLocaleString()} recorded events`]),
    el('div', { class: 'label-note' }, ['Summary generated ', el('time', { datetime: generated.toISOString() }, [generated.toLocaleString()])]),
    el('div', { class: 'label-note' }, ['API-equivalent is not an invoice. Capture completeness is unverified.']),
    review,
  ]);
}

function nowReadUnavailable(title: string, message: string, section: string): HTMLElement {
  const retry = el('button', { type: 'button', class: 'refresh-btn now-read-retry' }, ['Refresh recorded data']);
  retry.addEventListener('click', () => contain(refreshCurrentView(), showFatal));
  return el('section', { class: 'card now-read-unavailable', 'data-now-read': section, role: 'status' }, [
    el('div', { class: 'section-title' }, [title]),
    el('div', { class: 'label-note' }, [message]), retry,
  ]);
}

async function renderNow(view: TabView): Promise<void> {
  const reads = await readNowData({
    sessions: () => window.tokenelo.getSessions('today'),
    processes: () => window.tokenelo.getProcesses().then(response => {
      if (response.processes.some(process => process.host !== response.host))
        throw new Error('Process observation host mismatch');
      return response;
    }),
    summary: () => window.tokenelo.getSummary('today'),
  });
  if (!view.current()) return;
  const processes = reads.processes.state === 'available' ? reads.processes.value : null;
  state.processes = processes;
  if (processes) processObservations.remember(processes);
  const summary = reads.summary.state === 'available' ? reads.summary.value : null;
  const localModels = summary === null ? null
    : new Set(summary.byModel.filter((row) => row.provider === 'local').map((row) => `${row.source}\u0000${row.model}`));
  const container = view.stage;
  container.replaceChildren(summary ? nowUsageOverview(summary) : nowReadUnavailable(
    'Recorded usage unavailable · today',
    'Today’s summary could not be read. Token totals and API-equivalent value are unavailable.', 'usage'));

  const content = processes ? processObservation(processes) : el('div', { class: 'process-observation-content' }, [
    el('div', { class: 'section-title' }, ['Process observation unavailable']),
    el('div', { class: 'label-note' }, ['The process response could not be read. Current running state is unknown.']),
  ]);
  const refresh = el('button', { type: 'button', class: 'refresh-btn process-refresh-btn' }, ['Refresh processes']);
  const feedback = el('div', { class: 'label-note process-refresh-feedback', role: 'status', 'aria-live': 'polite' });
  const attempt = el('div', { class: 'label-note process-check-attempt' });
  const recordAttempt = (outcome: 'received' | 'failed', completedAt: number): void => {
    const time = new Date(completedAt);
    attempt.replaceChildren(outcome === 'received' ? 'Last response received ' : 'Last check failed ',
      el('time', {
        datetime: time.toISOString(),
        title: 'This window’s local read-completion clock. A successful process snapshot has its own observation time above.',
      }, [time.toLocaleString()]), ' · window clock');
  };
  recordAttempt(processes ? 'received' : 'failed', reads.processes.completedAt);
  const card = el('div', { class: 'card process-observation' }, [content,
    el('div', { class: 'process-observation-controls' }, [refresh, feedback]), attempt,
  ]);
  const controller = new ProcessRefresh({
    current: () => view.current(),
    read: () => window.tokenelo.getProcesses(),
    show: (next) => {
      processObservations.remember(next);
      state.processes = next;
      // Keep the controls (and manual-action focus) intact while replacing only observation content.
      content.replaceChildren(...Array.from(processObservation(next).childNodes));
    },
    status: (status) => {
      // Match Coverage: keep keyboard focus while the owner refuses overlapping reads.
      refresh.setAttribute('aria-disabled', String(status === 'checking' || status === 'retired'));
      refresh.textContent = status === 'retired' ? 'View refreshing…' : status === 'checking' ? 'Checking processes…' : 'Refresh processes';
      card.setAttribute('aria-busy', String(status === 'checking'));
      if (status === 'idle' || status === 'failed') recordAttempt(status === 'idle' ? 'received' : 'failed', Date.now());
      feedback.textContent = status === 'retired' ? 'This process control was retired. The view is refreshing.' : status === 'scheduled'
        ? 'Will check again shortly.'
        : status === 'checking' ? 'Checking process observation…'
          : status === 'failed' ? state.processes ? 'Could not refresh. The previous observation remains.' : 'Could not refresh. Current running state is unknown.'
            : processProbePending(state.processes?.listing) ? 'Process check is still running. Refresh to check again.' : 'Process response received.';
    },
  });
  state.processRefresh = controller;
  refresh.addEventListener('click', () => { void controller.refresh(); });
  container.append(card);
  if (processes) controller.start(processes);

  if (reads.sessions.state === 'unavailable') {
    container.append(nowReadUnavailable('Recorded sessions unavailable · today',
      'Today’s sessions could not be read. This does not establish that no sessions were recorded.', 'sessions'));
    return;
  }
  const sessions = reads.sessions.value;
  if (sessions.length === 0) {
    container.append(el('div', { class: 'empty-state' }, ['No recorded sessions today.']));
    return;
  }
  const list = el('div', { class: 'row-list' });
  const activityList = el('div', { class: 'row-list' });
  const now = Date.now();
  let activityOnlyCount = 0;
  for (const session of sessions) {
    if (sessionHasNoRecordedUsage(session)) {
      activityOnlyCount++;
      activityList.append(renderNowRow(session, now, localModels));
    } else {
      list.append(renderNowRow(session, now, localModels));
    }
  }
  wireSessionRowClicks(list);
  wireSessionRowClicks(activityList);
  container.append(el('div', { class: 'section-title' }, ['Recorded sessions · today']));
  if (list.childElementCount) container.append(list);
  if (activityOnlyCount) {
    container.append(el('details', { class: 'card now-activity-only' }, [
      el('summary', {}, [`Show ${activityOnlyCount} ${activityOnlyCount === 1 ? 'session' : 'sessions'} with activity only`]),
      activityOnlyCoverage(sessions, 'today')!,
      activityList,
    ]));
  }
}

// ── Sessions tab (task item 3: a sessions list beyond "Now", with a range selector) ─────────────

function renderSessionsRow(session: SessionRow, context: 'sessions' | 'local' = 'sessions'): HTMLElement {
  const noUsage = sessionHasNoRecordedUsage(session);
  const model = session.models[session.models.length - 1] ?? '(unknown model)';
  const isLive = sessionIsRecent(session, Date.now());
  const localAndApi = context === 'local'
    && session.telemetry?.some((feed) => feed.provider === 'local' && Number.isSafeInteger(feed.events) && feed.events > 0)
    && session.telemetry?.some((feed) => (feed.provider === 'anthropic' || feed.provider === 'openai') && Number.isSafeInteger(feed.events) && feed.events > 0);
  return el('div', { class: 'row-item session-evidence-row', ...openableRowAttrs(session) }, [
    el('span', { class: `source-dot ${session.source}` }),
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title' }, [
        isLive ? recentActivityMarker() : '',
        sessionDisplayName(session),
      ]),
      el('div', { class: 'row-sub' }, [`${sourceLabel(session.source)} · ${noUsage ? 'Session activity' : model}`]),
      el('div', { class: 'row-sub session-last-activity', title: new Date(session.end).toLocaleString() }, [
        `Last activity ${new Date(session.end).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      ]),
      ...(localAndApi ? [el('div', { class: 'label-note local-session-scope' }, ['Includes local and API usage · full session totals'])] : []),
    ]),
    el('div', { class: 'row-metrics' }, noUsage ? [
      el('span', { class: 'label-note' }, ['Activity recorded']),
      el('span', { class: 'label-note', title: 'This does not establish capture completeness.' }, ['No usage events in this range']),
    ] : [
      el('div', { class: 'session-token-value' }, [
        el('span', { class: 'num', tabindex: '0', title: `Selected date range · ${exactTokenLabel(session.tokens)}`, 'aria-label': `Selected date range · ${exactTokenLabel(session.tokens)}` }, [tokenTotalText(session.tokens)]),
        el('span', { class: 'label-note', title: countBasisLabel(session.tokens) }, ['Tokens · includes cache reads']),
        el('span', { class: 'label-note' }, [countBasisLabel(session.tokens)]),
      ]),
      el('span', { class: 'num' }, [!priceFieldsUsable(session) || session.apiEquivUsd === null ? '—' : formatMoney(session.apiEquivUsd)]),
      el('span', { class: 'label-note api-equivalent-price-label', title: API_EQUIVALENT_BASIS_NOTE, 'aria-label': `API-equivalent. ${API_EQUIVALENT_BASIS_NOTE}` }, ['API-equiv']),
      ...(priceEvidenceLabel(session) ? [el('span', { class: 'label-note price-quality' }, [priceEvidenceLabel(session)!])] : []),
    ]),
    el('span', { class: 'row-sub session-activity-line', title: activityTimeLabel(session).title }, [activityTimeLabel(session).text]),
  ]);
}

function renderLocalSessionSummaryRow(session: SessionRow): HTMLElement {
  const noUsage = sessionHasNoRecordedUsage(session);
  const model = session.models[session.models.length - 1] ?? '(unknown model)';
  const localPrice = localSessionPriceCopy(session);
  const apiEquivalent = localPrice.value;
  const metrics = noUsage ? [
    el('span', { class: 'label-note' }, ['Activity recorded']),
    el('span', { class: 'label-note', title: 'This does not establish capture completeness.' }, ['No usage events in this range']),
  ] : [
    el('div', { class: 'session-token-value local-session-summary-metric' }, [
      el('span', { class: 'num', tabindex: '0', title: `Selected date range · ${exactTokenLabel(session.tokens)}`, 'aria-label': `Selected date range · ${exactTokenLabel(session.tokens)}` }, [tokenTotalText(session.tokens)]),
      el('span', { class: 'label-note' }, [countBasisLabel(session.tokens)]),
    ]),
    el('div', { class: 'local-session-summary-metric' }, [
      el('span', { class: 'num' }, [apiEquivalent]),
      el('span', { class: 'label-note api-equivalent-price-label', title: localPrice.title, 'aria-label': `${localPrice.label}. ${localPrice.title}` }, [localPrice.label]),
    ]),
  ];
  return el('div', { class: 'row-item session-evidence-row local-session-summary-row', ...openableRowAttrs(session) }, [
    el('span', { class: `source-dot ${session.source}` }),
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title' }, [sessionDisplayName(session)]),
      el('div', { class: 'row-sub local-session-summary-context', title: `${sourceLabel(session.source)} · ${model} · Last activity ${new Date(session.end).toLocaleString()}` }, [
        `${sourceLabel(session.source)} · ${model} · Last active ${new Date(session.end).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
      ]),
    ]),
    el('div', { class: 'row-metrics local-session-summary-metrics' }, metrics),
  ]);
}

async function renderSessions(view: TabView): Promise<void> {
  const response = await ensureSessionsResponse(view.key.range);
  const sessions = response.sessions;
  if (!view.current()) return;
  const container = view.stage;
  container.replaceChildren();
  container.append(
    el('div', { class: 'section-title' }, ['Sessions — ' + view.key.range]),
    ...responseTimingWarningNodes(response.generatedAt, response.timeBasis),
    recordedResponseCard('Sessions', response.timeBasis),
  );
  if (sessions.length === 0) {
    container.append(el('div', { class: 'empty-state' }, [`No sessions in this range.`]));
    return;
  }
  // Sorted by last activity (task spec: "sorted by last activity") — most recently active first.
  const activityOnly = activityOnlyCoverage(sessions, 'in this range', true);
  if (activityOnly) container.append(el('section', { class: 'card session-activity-coverage', 'aria-label': 'Sessions with activity only' }, [
    activityOnly,
  ]));
  const sorted = [...sessions].sort((a, b) => b.end - a.end);
  const list = el('div', { class: 'row-list' });
  wireSessionRowClicks(list);
  const pageSize = 25;
  const lastPage = Math.ceil(sorted.length / pageSize) - 1;
  let page = 0;
  const status = el('div', { class: 'label-note session-page-status', role: 'status', 'aria-live': 'polite' });
  const navigation = el('nav', { class: 'session-pagination', 'aria-label': 'Recorded session pages' }, [status]);
  const controls = (['first', 'previous', 'next', 'last'] as const).map((action) => {
    const button = el('button', { type: 'button', class: 'refresh-btn', 'data-page-action': action }, [
      action[0].toUpperCase() + action.slice(1),
    ]);
    button.addEventListener('click', () => {
      if (!view.current()) return;
      page = action === 'first' ? 0 : action === 'last' ? lastPage : page + (action === 'next' ? 1 : -1);
      renderPage();
      panel().scrollTop = 0;
    });
    return button;
  });
  if (lastPage > 0) navigation.append(...controls);
  function renderPage(): void {
    page = Math.min(lastPage, Math.max(0, page));
    const start = page * pageSize, stop = Math.min(start + pageSize, sorted.length);
    status.textContent = `Showing ${(start + 1).toLocaleString()}–${stop.toLocaleString()} of ${sorted.length.toLocaleString()} recorded sessions`;
    list.replaceChildren(...sorted.slice(start, stop).map((session) => renderSessionsRow(session)));
    controls[0].disabled = controls[1].disabled = page === 0;
    controls[2].disabled = controls[3].disabled = page === lastPage;
  }
  renderPage();
  container.append(navigation,
    ...(lastPage > 0 ? [el('div', { class: 'label-note' }, ['Newest activity first. Refresh and range changes return to the first page.'])] : []), list);
}

// ── Usage tab ──────────────────────────────────────────────────────────────────────────────────

function localModelSessionDisclosure(
  row: ModelRow,
  copy: ReturnType<typeof usageModelRowCopy>,
  index: number,
  sessionResponsePromise: Promise<SessionsResponse>,
): HTMLElement {
  const summaryId = `local-model-session-summary-${index}`;
  const bodyId = `local-model-session-body-${index}`;
  const body = el('div', {
    id: bodyId,
    class: 'response-evidence-body local-model-session-body',
    role: 'region',
    'aria-labelledby': summaryId,
  }, [el('p', { class: 'label-note', role: 'status' }, ['Session summaries load with this Local view; open to review the matches.'])]);
  const disclosure = el('details', { class: 'local-model-session-disclosure' }, [
    el('summary', { id: summaryId, class: 'response-evidence-toggle tone-neutral' }, [
      el('span', {}, ['Session summaries containing this model']),
      el('span', { class: 'label-note' }, ['Exact source/model presence · not an event total']),
    ]),
    body,
  ]);
  let loaded = false;
  let loading = false;
  disclosure.addEventListener('toggle', async () => {
    if (!disclosure.open || loaded || loading) return;
    loading = true;
    body.replaceChildren(el('p', { class: 'label-note', role: 'status' }, ['Loading session summaries…']));
    try {
      const response = await sessionResponsePromise;
      const matches = localModelSessionMatches(row, response.sessions);
      const telemetryCount = matches.filter((match) => match.evidence === 'telemetry').length;
      const legacyCount = matches.length - telemetryCount;
      const list = el('div', { class: 'row-list local-model-session-list' });
      for (const match of matches) list.append(renderSessionsRow(match.session, 'local'));
      if (matches.length > 0) wireSessionRowClicks(list);
      body.replaceChildren(
        el('p', { class: 'label-note' }, [`${matches.length.toLocaleString()} session summaries match ${copy.source} · ${row.model} in this response.`]),
        el('div', { class: 'label-note response-evidence-clock' }, [`Sessions · ${response.range} · ${response.generatedAt === undefined ? 'query clock unavailable' : responseClock(response.generatedAt)}`]),
        el('p', { class: 'label-note' }, [`Matched session summaries: ${telemetryCount.toLocaleString()} with per-feed telemetry · ${legacyCount.toLocaleString()} using legacy model-list metadata.`]),
        el('p', { class: 'label-note' }, ['This is a count of session summaries, not events. Full session totals may include other models; do not add these totals to the model row. Session and model reads have separate query clocks and are not one snapshot.']),
        ...(matches.length > 0
          ? [list]
          : [el('p', { class: 'empty-state' }, ['No matching session summary is present in this response. This is not proof of zero recorded usage or complete attribution.'])]),
      );
    } catch {
      body.replaceChildren(el('p', { class: 'label-note', role: 'status' }, ['Session summaries are unavailable for this range; no zero is inferred.']));
    } finally {
      loading = false;
      loaded = true;
    }
  });
  return disclosure;
}
function modelTableRows(row: ModelRow, index: number, view: 'usage' | 'local' = 'usage', localSessionResponse?: Promise<SessionsResponse>): HTMLElement[] {
  const copy = usageModelRowCopy(row, view);
  const detailsId = `${view}-model-details-${index}`;
  const toggle = el('button', { type: 'button', class: 'model-toggle', title: copy.identity,
    'aria-label': usageModelToggleLabel(copy),
    'aria-expanded': 'false', 'aria-controls': detailsId }, [
      el('span', { class: 'model-display-name' }, [row.displayName]),
      el('span', { class: 'model-mode' }, [copy.mode]),
    ]);
  const summary = el('tr', {}, [
    el('td', { class: 'model-name' }, [toggle]),
    el('td', { class: 'num', title: copy.summaryCountTitle }, [copy.summaryCount]),
    el('td', { class: 'num', title: copy.summaryValueTitle }, [copy.summaryValue, ...(view !== 'local' && row.priceStatus !== 'LIST' ? [badge(copy.priceStatus)] : [])]),
  ]);
  // The Local view shows each model's recorded identity (id, capture source, count qualification) under its summary row.
  const identity = view === 'local' ? el('tr', { class: 'model-identity-row' }, [
    el('td', { colspan: '3' }, [
      el('div', { class: 'local-model-identity' }, [
        el('code', { class: 'local-model-id' }, [row.model]),
        el('span', { class: 'local-model-source', 'aria-hidden': 'true' }, [copy.source, ...(row.source === 'ollama-log' ? [' · estimated counts'] : [])]),
        ...(copy.summaryCountQualification ? [el('span', {
          class: `label-note local-model-count-quality${copy.summaryCountQualificationTone === 'warn' ? ' tone-warn' : ''}`,
          'aria-hidden': 'true',
        }, [copy.summaryCountQualification])] : []),
      ]),
    ]),
  ]) : null;
  const detailsContent = el('div', { class: 'model-details-content' }, [
    el('div', { class: 'row-title' }, [copy.name]),
    el('div', { class: 'label-note' }, [copy.detailsIdentity]),
    ...(row.source === 'ollama-log' ? [el('div', { class: 'label-note' }, ['Server-log token counts are estimates. Open a session for capture flags and recorded engine details.'])] : []),
    el('div', { class: 'label-note' }, [copy.countBasis]),
    el('div', { class: 'label-note' }, [copy.categoryLine]),
    el('div', { class: 'label-note' }, [copy.reasoningLine]),
    el('div', { class: 'label-note' }, [copy.apiValuePrefix, badge(copy.priceStatus)]),
    el('div', { class: 'label-note' }, ['Usage tokens include cache reads.']),
  ]);
  if (view === 'local' && localSessionResponse) {
    detailsContent.append(localModelSessionDisclosure(row, copy, index, localSessionResponse));
  }
  const details = el('tr', { id: detailsId, class: 'model-details-row' }, [
    el('td', { colspan: '3' }, [detailsContent]),
  ]);
  details.hidden = true;
  toggle.addEventListener('click', () => {
    details.hidden = !details.hidden;
    toggle.setAttribute('aria-expanded', String(!details.hidden));
    if (!details.hidden) details.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
  return [summary, ...(identity ? [identity] : []), details];
}

/**
 * Wires the chart's hover/focus tooltip (task item 3: "hover/focus tooltips with exact values").
 * `host` is the plain `<div>` whose innerHTML is the chart SVG (renderUsage, below); each bucket
 * is a `<g data-bucket-t="…">` (see charts.ts) carrying its own native `<title>`/`aria-label`
 * already — this adds a visible floating tooltip on top of that, driven by the same
 * `describePoint` data so the two can never show different numbers.
 */
function wireChartTooltip(host: HTMLElement, points: TimeseriesResponse['points'], sources: Source[], bucket: 'hour' | 'day'): void {
  let tooltip: HTMLElement | null = null;

  function showFor(g: Element): void {
    const t = Number(g.getAttribute('data-bucket-t'));
    const point = points.find((p) => p.t === t);
    if (!point) return;
    const desc = describePoint(point, sources, bucket);
    if (!tooltip) {
      tooltip = el('div', { class: 'chart-tooltip', role: 'status' });
      host.append(tooltip);
    }
    tooltip.replaceChildren(
      el('div', { class: 'chart-tooltip-time' }, [desc.timeLabel]),
      el('div', { class: 'chart-tooltip-total' }, [desc.totalText]),
      ...desc.bySource.map((s) => el('div', { class: 'chart-tooltip-row' }, [`${s.label}: ${s.valueText}`])),
      ...(priceEvidenceLabel(point) ? [el('div', { class: 'chart-tooltip-row' }, [priceEvidenceLabel(point)!])] : [])
    );
    positionChartTooltip(host, g, tooltip);
  }

  function hide(): void {
    tooltip?.classList.remove('visible');
  }

  host.addEventListener('mouseover', (e) => {
    const g = (e.target as Element).closest?.('g[data-bucket-t]');
    if (g) showFor(g);
  });
  host.addEventListener('mouseout', (e) => {
    const related = (e as MouseEvent).relatedTarget as Node | null;
    if (!related || !host.contains(related)) hide();
  });
  host.addEventListener('focusin', (e) => {
    const g = (e.target as Element).closest?.('g[data-bucket-t]');
    if (g) showFor(g);
  });
  host.addEventListener('focusout', (e) => {
    const related = (e as FocusEvent).relatedTarget as Node | null;
    if (!related || !host.contains(related)) hide();
  });
}

/** Query clocks describe these independent reads; matching fields are not a capture-completeness check. */
function responseClock(value: unknown): string {
  return formatQueryClock(value);
}

function recordedWindowRows(label: string, basis: SummaryResponse['timeBasis']): HTMLElement[] {
  const disclosure = recordedWindowDisclosure(basis);
  return [
    el('div', { class: 'label-note response-recorded-window', 'data-window-state': disclosure.state }, [`${label} · ${disclosure.window}`]),
    ...(disclosure.exclusions ? [el('div', { class: 'label-note response-recorded-exclusions' }, [`${label} · ${disclosure.exclusions}`])] : []),
  ];
}

function recordedResponseCard(label: string, basis: SummaryResponse['timeBasis']): HTMLElement {
  return el('div', { class: 'card response-evidence' }, [el('details', {}, [
    el('summary', { class: 'response-evidence-toggle tone-neutral' }, [el('span', {}, ['Data evidence']), el('span', { class: 'label-note' }, ['Recorded timestamp window'])]),
    el('div', { class: 'response-evidence-body' }, [...recordedWindowRows(label,basis), el('p', { class: 'label-note' }, [RECORDED_WINDOW_QUALIFICATION])]),
  ])]);
}

function responseTimingWarningNodes(queryClock: unknown, basis: SummaryResponse['timeBasis']): HTMLElement[] {
  const warning = responseTimingWarning(queryClock, basis);
  return warning ? [el('div', { class: 'label-note response-timing-warning', role: 'status' }, [warning])] : [];
}

function chartSourceEvidenceBody(evidence: DollarSourceEvidence): HTMLElement {
  const labels: Record<DollarSourceIssueReason, string> = {
    points: 'Bucket list unavailable', point: 'Bucket data unavailable', timestamp: 'Bucket timestamp unavailable',
    total: 'Bucket amount unavailable', sources: 'Source breakdown unavailable', 'source-value': 'Source amount unavailable',
    negative: 'Negative amounts cannot be plotted by this chart', unsupported: 'Source data cannot be represented by this chart',
    overflow: 'Source sum exceeds the numeric range', mismatch: 'Source amounts differ from the bucket total',
  };
  const message = evidence.state === 'empty' ? 'No chart buckets provided; source comparison is unavailable.'
    : evidence.state === 'consistent' ? `Chart buckets: ${evidence.buckets}. Source amounts agree with bucket totals within the dollar tolerance.`
    : evidence.buckets === null ? 'Chart source comparison unavailable; bucket count unknown.'
    : `Chart buckets: ${evidence.buckets}. ${evidence.consistentBuckets} agree, ${evidence.mismatchedBuckets} differ, ${evidence.unavailableBuckets} unavailable.`;
  return el('div', { class: 'response-source-breakdown', 'data-source-state': evidence.state }, [
    el('p', { class: `label-note ${['mismatch', 'unavailable'].includes(evidence.state) ? 'tone-warn' : ''}` }, [message]),
    ...(evidence.unrepresentedZeroEntries ? [el('p', { class: 'label-note' }, [
      `Zero-dollar entries from unfamiliar sources: ${evidence.unrepresentedZeroEntries}. These identities remain unverified.`,
    ])] : []),
    ...(evidence.issues.length ? [el('ul', { class: 'label-note' }, evidence.issues.slice(0, 5).map(issue => el('li', {}, [
      `${issue.index === null ? 'Buckets' : `Bucket ${issue.index + 1}`} · ${labels[issue.reason]}. `,
      ...(issue.index !== null ? [
        `${issue.timestamp === null ? 'Timestamp unavailable' : `${new Date(issue.timestamp).toISOString()} UTC`} · aggregate USD `,
        el('code', {}, [issue.total === null ? 'Unknown' : String(issue.total)]), ' · source sum USD ',
        el('code', {}, [issue.sourceSum === null ? 'Unknown' : String(issue.sourceSum)]),
      ] : []),
    ])))] : []),
    ...(evidence.issues.length > 5 ? [el('p', { class: 'label-note' }, [`First 5 of ${evidence.issues.length} affected buckets shown.`])] : []),
  ]);
}

function usageEvidenceCard(summary: SummaryResponse, timeseries: TimeseriesResponse, sourceEvidence: DollarSourceEvidence, snapshotScope: UsageResponse['snapshotScope']): HTMLElement {
  const readScopeText = snapshotScope === 'shared-read-transaction'
    ? 'The chart and table use one recorded ledger snapshot. The time below is their shared query cutoff.'
    : snapshotScope === 'filed-fixture'
      ? 'Saved example data. A shared live ledger snapshot is not verified. Times below describe saved query cutoffs.'
      : 'A shared live ledger snapshot is not verified. Times below describe the supplied query cutoffs.';
  const evidence = usageResponseEvidence(summary, timeseries);
  const comparison = usageComparisonCopy(evidence, sourceEvidence, [summary.totals, ...timeseries.points]);
  const label = comparison.label;
  const clockCue = usageQueryClockCopy(evidence);
  const tone = comparison.warn ? 'tone-warn' : 'tone-neutral';
  const valueText = (value: number | null, dollars = false): string => evidenceNumber(value, dollars ? 'usd' : 'count').text;
  const exactText = (value: number | null, dollars = false): string => evidenceNumber(value, dollars ? 'usd' : 'count').exact ?? 'Unknown';
  const comparisonRow = (name: string, field: FieldEvidence, dollars = false): HTMLElement => el('tr', {}, [
    el('th', { scope: 'row' }, [name, el('span', { class: 'label-note' }, [field.state === 'match' ? 'Agree'
      : field.state === 'mismatch' ? 'Differ' : field.state === 'not-compared' ? 'Different ranges' : 'Evidence unavailable'])]),
    el('td', { class: 'num', title: `Exact comparison value: ${exactText(field.summary, dollars)}${dollars ? ' USD' : ' events'}` }, [valueText(field.summary, dollars)]),
    el('td', { class: 'num', title: `Exact comparison value: ${exactText(field.timeseries, dollars)}${dollars ? ' USD' : ' events'}` }, [valueText(field.timeseries, dollars)]),
  ]);
  return el('div', { class: 'card response-evidence', 'data-comparison': evidence.numeric }, [
    el('details', {}, [
      el('summary', { class: `response-evidence-toggle ${tone}` }, [el('span', {}, ['Data evidence']), el('span', { class: 'label-note' }, [label])]),
      el('div', { class: 'response-evidence-body' }, [
        el('p', { class: 'label-note' }, [readScopeText, ' Matching figures do not establish capture completeness, valid stored price fields, vendor rate accuracy or invoice agreement. Refresh requests a new view.']),
        el('div', { class: 'label-note response-evidence-clock' }, [`Table · ${evidence.range.summary} · ${responseClock(evidence.timestamps.summaryGeneratedAt)}`]),
        el('div', { class: 'label-note response-evidence-clock' }, [`Chart · ${evidence.range.timeseries} · ${responseClock(evidence.timestamps.timeseriesGeneratedAt)}`]),
        ...recordedWindowRows('Table', summary.timeBasis),
        ...recordedWindowRows('Chart', timeseries.timeBasis),
        el('p', { class: 'label-note' }, [RECORDED_WINDOW_QUALIFICATION]),
        chartSourceEvidenceBody(sourceEvidence),
        el('table', { class: 'data-table response-evidence-table' }, [
          el('thead', {}, [el('tr', {}, [el('th', { scope: 'col' }, ['Measure']), el('th', { scope: 'col', class: 'num' }, ['Table']), el('th', { scope: 'col', class: 'num' }, ['Chart'])])]),
          el('tbody', {}, [comparisonRow('API-equivalent $', evidence.apiEquivUsd, true), comparisonRow('Unpriced events', evidence.unpricedEvents), comparisonRow('Estimated-price events', evidence.estimatedPriceEvents)]),
        ]),
        el('p', { class: 'label-note' }, ['Compact values marked ≈ are rounded. Comparisons use the exact values below.']),
        el('details', { class: 'response-exact-values' }, [
          el('summary', { class: 'label-note' }, ['Exact comparison values']),
          ...([
            ['API-equivalent USD', evidence.apiEquivUsd, true],
            ['Unpriced events', evidence.unpricedEvents, false],
            ['Estimated-price events', evidence.estimatedPriceEvents, false],
          ] as const).map(([name, field, dollars]) => el('p', { class: 'label-note' }, [
            `${name} · Table: `, el('code', {}, [exactText(field.summary, dollars)]),
            ' · Chart: ', el('code', {}, [exactText(field.timeseries, dollars)]),
          ])),
        ]),
        el('p', { class: 'label-note' }, ['Dollar totals allow a small rounding tolerance. This comparison covers these three fields; tokens and session details are separate checks.']),
      ]),
    ]),
    el('p', { class: 'label-note response-evidence-clock-cue', 'data-clock-state': clockCue ? 'differs' : 'same-or-unknown' }, [usageQueryClockLine(evidence), ...(clockCue ? [` · ${clockCue}`] : [])]),
  ]);
}

function tokenPeriodCard(summary: SummaryResponse, range: Range): HTMLElement {
  const evidence = tokenPeriodEvidence(summary, range);
  const exact = (value: number | null): string => value === null ? 'Unavailable' : value.toLocaleString();
  const headline = evidence.totalAvailable ? `${evidence.subtotal! >= 1000 ? '≈' : ''}${formatCompactNumber(evidence.subtotal!)}` : 'Unavailable';
  const components = el('dl', { class: 'token-period-components' }, evidence.components.map(row => el('div', { 'data-component': row.key }, [
    el('dt', {}, [row.label]), el('dd', { class: 'num', 'data-exact-count': row.value === null ? 'unavailable' : String(row.value), title: exact(row.value) + (row.note ? ' · ' + row.note : '') }, [
      row.value === null ? 'Unavailable' : `${row.value >= 1000 ? '≈' : ''}${formatCompactNumber(row.value)}`,
      ...(row.note ? [el('div', { class: 'label-note' }, [row.note])] : []),
    ]),
  ])));
  const coverage = el('button', { type: 'button', class: 'refresh-btn token-period-coverage' }, ['View capture coverage']);
  coverage.addEventListener('click', () => contain(selectTab('coverage'), showFatal));
  const sourceCopy = evidence.sourceState === 'match' ? 'Source event counts and normalized token categories agree with this summary. Field presence may still be incomplete.'
    : evidence.sourceState === 'mismatch' ? 'Source breakdown differs from this summary. Do not use it as a reconciled report.'
    : 'Source breakdown evidence is unavailable.';
  const sourceDetails = el('details', { class: 'token-period-source-details' }, [
    el('summary', {}, [`Recorded sources · ${evidence.sources.length}`]),
    el('p', { class: 'label-note' }, [sourceCopy]),
    ...evidence.sources.map(row => el('div', { class: 'token-period-source-row', 'data-source': row.source }, [
      el('strong', {}, [sourceLabel(row.source)]),
      el('div', { class: 'label-note' }, [`${row.events.toLocaleString()} recorded ${row.events === 1 ? 'event' : 'events'} · ${tokenTotalText(row.tokens)} token categories`]),
      el('div', { class: 'label-note' }, [countBasisLabel(row.tokens, row.events)]),
    ])),
    el('p', { class: 'label-note' }, ['Only sources with records in this period are listed. This does not establish complete capture or whether a tool is installed.']),
  ]);
  return el('section', { class: 'card token-period', 'aria-label': `Recorded token summary · ${range}`, 'data-range': range,
    'data-count-state': evidence.empty ? 'empty' : evidence.totalAvailable ? 'available' : 'unavailable', 'data-source-state': evidence.sourceState }, [
    el('div', { class: 'section-title' }, [`Recorded usage · ${range}`]),
    el('div', { class: 'token-period-headline num', title: evidence.totalAvailable ? exact(evidence.subtotal) : evidence.basis,
      'aria-label': evidence.totalAvailable ? `${exact(evidence.subtotal)} ${evidence.headline.toLowerCase()}` : evidence.basis }, [headline]),
    el('div', { class: 'label-note' }, [evidence.headline]),
    apiEquivalentBasisNote('usage-api-equiv-basis-note'),
    el('div', { class: 'label-note count-quality' }, [evidence.basis]),
    el('div', { class: 'label-note' }, [`${summary.totals.events.toLocaleString()} recorded ${summary.totals.events === 1 ? 'event' : 'events'}`]),
    components,
    ...(!evidence.totalAvailable && evidence.subtotal !== null ? [el('div', { class: 'label-note' }, [`${summary.totals.tokens.fieldEvidence ? 'Known category subtotal' : 'Normalized category subtotal'}: ${exact(evidence.subtotal)}. A complete token total is unavailable.`])] : []),
    el('details', { class: 'token-period-exact-details' }, [
      el('summary', {}, ['Exact counts and subsets']),
      ...evidence.components.map(row => el('div', { class: 'label-note' }, [`${row.label}: ${exact(row.value)}${row.note ? ' · ' + row.note : ''}`])),
      el('div', { class: 'label-note' }, [`Reasoning: ${exact(evidence.reasoning)} · included in output, not added again.`]),
      el('div', { class: 'label-note' }, [`Assumed 1-hour cache writes: ${exact(evidence.assumed1h)} · included in 1-hour writes, not added again.`]),
      el('div', { class: 'label-note' }, ['Token categories include cache reads. Compact counts marked ≈ are rounded.']),
    ]),
    sourceDetails,
    ...(evidence.sourceState !== 'match' ? [el('div', { class: 'label-note tone-warn' }, [sourceCopy])] : []),
    ...recordedWindowRows('Summary', summary.timeBasis),
    el('div', { class: 'label-note' }, ['Source clocks and capture completeness are unverified.']),
    coverage,
  ]);
}

async function renderUsage(view: TabView): Promise<void> {
  const { summary, timeseries, snapshotScope } = await ensureUsage(view.key.range, view);
  if (!view.current()) return;
  const container = view.stage;
  container.replaceChildren();
  if (showUsageFixtureInlineNotice(snapshotScope, state.fixtureExample ? 'FILED-EXAMPLE' : null)) container.append(el('div', { class: 'label-note' },
    ['FILED-EXAMPLE: saved fixture data; a shared live ledger snapshot is not established.']));
  container.append(tokenPeriodCard(summary, view.key.range));
  container.append(priceFieldReview({ ...summary.totals }));
  const sourceEvidence = dollarSourceEvidence(timeseries.points, CHART_SOURCES);
  container.append(usageEvidenceCard(summary, timeseries, sourceEvidence, snapshotScope));
  const priceEvidence = priceEvidenceLabel(summary.totals);
  if (priceEvidence) {
    container.append(el('div', { class: 'label-note price-quality' }, [`API-equivalent totals: ${priceEvidence}`]));
  }

  const chartCard = el('div', { class: 'card chart-wrap' }, [
    el('div', { class: 'section-title' }, [`API-equivalent $ by source — ${timeseries.range} · UTC`]),
  ]);
  const chartHost = el('div', { class: 'chart-host' });
  const sourceUsable = sourceEvidence.state === 'consistent' || sourceEvidence.state === 'empty';
  const emptyCaption = sourceUsable ? usageTimelineEmptyCaption(summary, timeseries) : null;
  let chartRendered = false;
  if (!priceFieldsUsable(summary.totals) || timeseries.points.some(point => !priceFieldsUsable(point)))
    chartHost.append(el('div', { class: 'empty-state' }, ['API-equivalent timeline unavailable: recorded price fields need review.']));
  else if (summary.totals.events > 0 && summary.totals.unpricedEvents === summary.totals.events)
    chartHost.append(el('div', { class: 'empty-state' }, ['API-equivalent timeline unavailable: no priced events in this range.']));
  else if (!sourceUsable) chartHost.append(el('div', { class: 'empty-state' }, [
    `API-equivalent timeline unavailable: ${sourceEvidence.state === 'mismatch' ? 'source amounts differ from bucket totals' : 'the source breakdown cannot be plotted faithfully'}. Open Data evidence for the returned figures.`,
  ]));
  else if (emptyCaption) chartHost.append(el('div', { class: 'empty-state' }, [emptyCaption]));
  else {
    chartHost.innerHTML = renderStackedBarChart(timeseries.points, { bucket: timeseries.bucket, sources: CHART_SOURCES });
    chartRendered = true;
  }
  chartCard.append(chartHost);
  if (chartRendered) wireChartTooltip(chartHost, timeseries.points, CHART_SOURCES, timeseries.bucket);
  const legend = el('div', { class: 'legend' });
  for (const entry of chartRendered ? chartLegend(timeseries.points) : []) {
    legend.append(
      el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-swatch', style: `background:${entry.colorVar}` }),
        entry.label,
      ])
    );
  }
  chartCard.append(legend);
  if (summary.totals.unpricedEvents > 0) {
    chartCard.append(el('div', { class: 'label-note usage-price-note' }, [
      `${summary.totals.unpricedEvents.toLocaleString()} unpriced events in this range. Dollar values include priced events only.`,
    ]));
  }

  const table = el('table', { class: 'data-table model-table' }, [
    el('colgroup', {}, [
      el('col', { class: 'col-model' }),
      el('col', { class: 'col-num' }),
      el('col', { class: 'col-num' }),
    ]),
    el('thead', {}, [
      el('tr', {}, [
        el('th', {}, ['Model']),
        el('th', { class: 'num' }, ['Tokens']),
        el('th', { class: 'num' }, ['API-equiv $']),
      ]),
    ]),
    el(
      'tbody',
      {},
      summary.byModel.flatMap((row, index) => modelTableRows(row, index))
    ),
  ]);

  container.append(
    chartCard,
    el('div', { class: 'card' }, [
      el('div', { class: 'section-title' }, ['By model']),
      el('div', { class: 'label-note' }, [`Report generated ${new Date(summary.generatedAt).toLocaleString()} · range ${summary.range}`]),
      el('div', { class: 'label-note' }, ['Tokens include cache reads. Select a model for its recorded categories and count basis.']),
      summary.byModel.length ? table : el('div', { class: 'empty-state' }, [hasKnownEmptyUsage(summary.totals.tokens, summary.totals.events)
        ? 'No usage events recorded in this range.' : 'Model breakdown unavailable for the recorded usage.']),
    ]),
    planComparisonCard(summary)
  );
}

// ── Local tab ──────────────────────────────────────────────────────────────────────────────────

/**
 * Not-configured explanation (task item 5: "explain how to enable it … rather than showing
 * zeros"). DESIGN §15.3.4: default `local.capture` is `both` on M4a (proxy plus best-effort/ESTIMATE
 * server-log coverage for direct clients) and `proxy` elsewhere (routing Ollama traffic through
 * the metering proxy, default port 11444, DESIGN §2.2/§15.3.3) — spelled out here so the fix is a
 * one-line config edit, not a guess.
 */
function localCaptureHelp(): HTMLElement {
  return el('div', { class: 'capture-help' }, [
    el('div', {}, ['To meter local LLM server requests, set ', el('code', {}, ['local.capture']), ' in config:']),
    el('ul', {}, [
      el('li', {}, [
        el('code', {}, ['"serverlog"']),
        ' — reads the Ollama server log when available (best-effort; figures carry ESTIMATE status).',
      ]),
      el('li', {}, [
        el('code', {}, ['"both"']),
        ' — meters requests through the proxy and uses the server log to cover direct clients; matching log estimates are suppressed, and recent logs are held while proxy/backlog state settles.',
      ]),
      el('li', {}, [
        el('code', {}, ['"proxy"']),
        ' — route compatible local-model requests through the metering proxy on port ',
        el('code', {}, ['11444']),
        ' instead of ',
        el('code', {}, ['11434']),
        '; token counts come from each response.',
      ]),
      el('li', {}, [
        el('code', {}, ['"off"']),
        ' — do not collect local Ollama usage; recorded history remains available.',
      ]),
    ]),
  ]);
}

async function renderLocal(view: TabView): Promise<void> {
  const summary = await ensureSummary(view.key.range, view);
  if (!view.current()) return;
  const { local } = summary;
  const localModels = summary.byModel.filter((row) => row.provider === 'local');
  const container = view.stage;
  container.replaceChildren();

  if (!local.captured) {
    container.append(
      recordedResponseCard('Models', summary.timeBasis),
      ...responseTimingWarningNodes(summary.generatedAt, summary.timeBasis),
      el('div', { class: 'card' }, [
        el('div', { class: 'section-title' }, ['Local capture']),
        el('div', { class: 'empty-state' }, [local.reason ?? 'Local capture not configured.']),
        localCaptureHelp(),
      ])
    );
    return;
  }

  if (local.reason?.includes('local capture not configured') || local.readEvidence?.captureMode === 'off') {
    container.append(el('div', { class: 'label-note local-coverage-note' }, [
      'Local server capture is off; recorded local-model events remain available in this range.',
    ]));
  }
  if (localModels.length === 0) {
    container.append(recordedResponseCard('Models', summary.timeBasis));
    container.append(el('div', { class: 'card' }, [
      el('div', { class: 'section-title' }, [`Local activity · ${view.key.range}`]),
      ...responseTimingWarningNodes(summary.generatedAt, summary.timeBasis),
      el('div', { class: 'empty-state' }, ['No local-model events were recorded in this range. Capture is configured. Check Coverage to review capture and scan evidence.']),
    ]));
    return;
  }

  const sessionResponsePromise = localModelSessionDrilldownAllowed(local) ? ensureSessionsResponse(view.key.range) : undefined;
  const modelTable = el('table', { class: 'data-table model-table local-model-table' }, [
    el('colgroup', {}, [
      el('col', { class: 'col-model' }),
      el('col', { class: 'col-num' }),
      el('col', { class: 'col-num' }),
    ]),
    el('thead', {}, [el('tr', {}, [el('th', {}, ['Local model']), el('th', { class: 'num' }, ['Events']), el('th', { class: 'num' }, ['Tokens'])])]),
    el('tbody', {}, localModels.flatMap((row, index) => modelTableRows(row, index, 'local', sessionResponsePromise))),
  ]);
  const modelCard = el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, [`Local models · ${view.key.range}`]),
    ...responseTimingWarningNodes(summary.generatedAt, summary.timeBasis),
    el('div', { class: 'label-note' }, ['Model IDs and capture sources appear below each row. Select a model for its exact usage breakdown.']),
    ...(localModels.some((row) => row.source === 'ollama-log') ? [el('div', { class: 'label-note' }, ['Server-log token counts are estimates; session capture provenance shows input flags and recorded engine details.'])] : []),
    modelTable,
  ]);

  if (local.readEvidence?.version === 1 && local.readEvidence.state === 'malformed-components') {
    container.append(modelCard, el('div', { class: 'card local-read-hold', role: 'status' }, [
      el('div', { class: 'section-title' }, ['Local estimates unavailable']),
      el('p', { class: 'label-note' }, [local.reason ?? 'Some recorded events have unreadable component evidence. Stored usage totals remain available.']),
      el('p', { class: 'label-note' }, ['Combined local comparator value, energy, net savings and decode estimates are withheld. The model breakdown shows stored figures and their recorded qualifications.']),
      el('p', { class: 'label-note' }, ['No stored usage or prices have been changed.']),
      el('p', { class: 'label-note' }, ['Session and component drill-downs require readable attribution. Review Coverage before relying on local estimates.']),
    ]));
    return;
  }

  if (!sessionResponsePromise) {
    container.append(modelCard);
    return;
  }

  const localSessionsCard = el('div', { class: 'card local-session-activity-card' }, [
    el('div', { class: 'section-title' }, [`Sessions with local-model activity · ${view.key.range}`]),
    el('div', { class: 'empty-state', role: 'status' }, ['Loading matching session summaries…']),
  ]);
  // Put the drill-down first so a narrow Local view exposes what the model totals join to.
  // Keep the model table visible while the independent session response is loading.
  container.append(localSessionsCard, modelCard);

  const localModelKeys = new Set(localModels.map((row) => `${row.source}\u0000${row.model}`));
  const sessionResponse = await sessionResponsePromise;
  if (!view.current()) return;
  const localSessions = sessionResponse.sessions
    .filter((session) => session.telemetry !== undefined
      ? session.telemetry.some((feed) => feed.provider === 'local' && feed.events > 0)
      : session.models.some((model) => localModelKeys.has(`${session.source}\u0000${model}`)))
    .sort((a, b) => b.end - a.end);
  const sessionList = el('div', { class: 'row-list' });
  for (const session of localSessions) sessionList.append(renderLocalSessionSummaryRow(session));
  wireSessionRowClicks(sessionList);
  localSessionsCard.replaceChildren(
    el('div', { class: 'section-title' }, [`Sessions with local-model activity · ${view.key.range}`]),
    ...responseTimingWarningNodes(sessionResponse.generatedAt, sessionResponse.timeBasis),
    el('div', { class: 'label-note' }, ['Session totals may include other models; open a row for its full per-model breakdown.']),
    localSessions.length ? sessionList : el('div', { class: 'empty-state' }, [
      'No matching session summaries are available for these events. Model totals come from usage telemetry; session drill-down appears when those events can be joined to a source and model session.',
    ]),
  );

  const sameRange = summary.range === sessionResponse.range;
  const responseEvidenceCard = el('div', { class: 'card response-evidence local-response-evidence' }, [
    el('div', { class: 'local-response-clocks' }, [
      el('div', { class: 'label-note response-evidence-clock' }, [`Models · ${summary.range} · ${responseClock(summary.generatedAt)}`]),
      el('div', { class: 'label-note response-evidence-clock' }, [`Sessions · ${sessionResponse.range} · ${responseClock(sessionResponse.generatedAt)}`]),
    ]),
    el('details', {}, [
      el('summary', { class: `response-evidence-toggle ${sameRange ? 'tone-neutral' : 'tone-warn'}` }, [
        el('span', {}, ['Data evidence']),
        el('span', { class: 'label-note' }, [sameRange ? ' · Separate reads · completeness unverified' : ' · Different ranges · separate reads']),
      ]),
      el('div', { class: 'response-evidence-body' }, [
        el('p', { class: 'label-note' }, ['Each view has its own query time. Model totals count local-model events; session totals may include other models. They are not compared.']),
        el('details', { class: 'response-recorded-detail' }, [
          el('summary', { class: 'response-evidence-toggle' }, ['Recorded-time coverage and limits']),
          el('div', { class: 'response-evidence-body' }, [
            ...recordedWindowRows('Models', summary.timeBasis),
            ...recordedWindowRows('Sessions', sessionResponse.timeBasis),
            el('p', { class: 'label-note' }, [RECORDED_WINDOW_QUALIFICATION]),
            el('p', { class: 'label-note' }, ['Refresh requests the views again. Query times do not establish capture completeness.']),
          ]),
        ]),
      ]),
    ]),
  ]);
  container.insertBefore(responseEvidenceCard, localSessionsCard);

  const comparators = el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['API-equivalent value of local work']),
    apiEquivalentBasisNote('local-api-equiv-basis-note'),
    el('div', { class: 'label-note local-comparator-basis-note' }, [LOCAL_COMPARATOR_BASIS_NOTE]),
    el('div', { class: 'row-list' }, [
      el('div', { class: 'row-item' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, [`vs ${local.valueVsClaude.comparator}`]),
          local.valueVsClaude.unratedEvents > 0
            ? el('div', { class: 'row-sub' }, [`${local.valueVsClaude.unratedEvents} event(s) unrated; total unavailable`])
            : '',
        ]),
        el('div', { class: 'row-metrics' }, [
          el('span', { class: 'num' }, [local.valueVsClaude.usd === null ? '—' : formatMoney(local.valueVsClaude.usd)]),
          badge(local.valueVsClaude.status),
        ]),
      ]),
      el('div', { class: 'row-item' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, [`vs ${local.valueVsGpt.comparator}`]),
          local.valueVsGpt.unratedEvents > 0
            ? el('div', { class: 'row-sub' }, [`${local.valueVsGpt.unratedEvents} event(s) unrated; total unavailable`])
            : '',
        ]),
        el('div', { class: 'row-metrics' }, [
          el('span', { class: 'num' }, [local.valueVsGpt.usd === null ? '—' : formatMoney(local.valueVsGpt.usd)]),
          badge(local.valueVsGpt.status),
        ]),
      ]),
    ]),
  ]);

  const energyRow = el('div', { class: 'row-item' }, [
    el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, ['Energy'])]),
    el('div', { class: 'row-metrics' }, [
      el('span', { class: 'num', title: 'Energy quantity and its configured marginal electricity cost' }, [
        `${local.energy.kwh === null ? '—' : `${local.energy.kwh.toFixed(2)} kWh`} · ${local.energy.usd === null ? '—' : `${formatMoney(local.energy.usd)} cost`}`,
      ]),
      badge(local.energy.status),
    ]),
  ]);

  const savings = el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Net savings (API-equivalent value − local marginal cost)']),
    el('div', { class: 'label-note local-savings-basis-note' }, [LOCAL_SAVINGS_BASIS_NOTE]),
    el('div', { class: 'row-list' }, [
      energyRow,
      el('div', { class: 'row-item' }, [
        el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, ['Net vs Claude'])]),
        el('span', { class: 'num' }, [local.netSavingsVsClaude === null ? '—' : formatMoney(local.netSavingsVsClaude)]),
        badge(local.netSavingsVsClaudeStatus),
      ]),
      el('div', { class: 'row-item' }, [
        el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, ['Net vs GPT'])]),
        el('span', { class: 'num' }, [local.netSavingsVsGpt === null ? '—' : formatMoney(local.netSavingsVsGpt)]),
        badge(local.netSavingsVsGptStatus),
      ]),
      el('div', { class: 'row-item' }, [
        el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, ['Decode speed'])]),
        el('span', { class: 'num' }, [
          // decodeTokPerSec is already a tok/s rate (not a token count), so it is formatted
          // directly rather than through formatTokPerSec(tokens, ms) — which exists for the
          // opposite case: computing a rate from raw token/duration pairs.
          local.decodeTokPerSec === undefined ? '—' : `${local.decodeTokPerSec.toFixed(1)} tok/s`,
        ]),
      ]),
    ]),
  ]);

  container.append(comparators, savings);
}

// ── Limits tab ─────────────────────────────────────────────────────────────────────────────────

function meterTone(pct: number): 'good' | 'warn' | 'bad' {
  if (pct >= 90) return 'bad';
  if (pct >= 70) return 'warn';
  return 'good';
}

/**
 * The block-estimate detail line (task item 6): "Claude block estimate shows tokens/$ in block,
 * burn and projection" (new LimitWindow fields, DESIGN §15.9.5). Rendered under the window's
 * meter whenever at least one of these fields is present — a plain percent-only window (Codex's
 * primary/secondary) never gets this block.
 */
function blockEstimateDetail(w: LimitWindow): HTMLElement | string {
  if (unresolvedCounts(w)) return el('div', { class: 'label-note block-estimate' }, [`Block token total, burn and projection unavailable · ${w.countQuality} count evidence`]);
  const parts: string[] = [];
  if (w.tokens !== undefined) {
    parts.push(`${formatCompactNumber(w.tokens)} tok${!priceFieldsUsable(w) ? ' (dollar value unavailable · review price fields)' : w.apiEquivUsd != null ? ` (API-equiv ${formatMoney(w.apiEquivUsd)})` : ''} in block`);
  }
  if (w.burnTokensPerMin !== undefined) parts.push(`burn ${formatCompactNumber(w.burnTokensPerMin)} tok/min`);
  if (w.projectedTokens !== undefined) {
    parts.push(`projected ${formatCompactNumber(w.projectedTokens)} tok${w.projectedUsd != null ? ` (API-equiv ${formatMoney(w.projectedUsd)})` : ''} by reset`);
  }
  if (parts.length === 0) return '';
  return el('div', { class: 'label-note block-estimate' }, [parts.join(' · ')]);
}

function renderLimitWindow(w: LimitWindow, estimate: boolean): HTMLElement {
  const windowName = ({ five_hour: '5-hour window', seven_day: '7-day window', primary: 'Primary window', secondary: 'Secondary window' } as Record<string, string>)[w.id] ?? w.id.replace(/_/g, ' ');
  const detail = blockEstimateDetail(w);
  const timing = limitWindowTimingLabels(w, estimate, Date.now());
  const timingNotes = [
    ...(timing.started === null ? [] : [el('div', { class: 'label-note' }, [timing.started])]),
    el('div', { class: 'label-note' }, [timing.reset]),
  ];
  // A block_estimate window with no usedPercent (this fixture; the daemon may or may not compute
  // a % for it) has nothing meaningful to put in a 0-100 meter — showing an always-empty bar next
  // to "— —" is worse than showing just the token/burn/projection detail line by itself.
  if (w.usedPercent === null && detail !== '') {
    return el('div', { class: 'limit-window' }, [el('div', { class: 'row-sub' }, [`${windowName}${estimate ? ' (estimate)' : ''}`]), ...timingNotes, detail]);
  }
  const pct = w.usedPercent ?? 0;
  const tone = meterTone(pct);
  return el('div', { class: 'limit-window' }, [
    el('div', { class: 'row-sub' }, [
      `${windowName}${estimate ? ' (estimate)' : ''} — ${w.usedPercent === null ? '—' : formatPercent(w.usedPercent / 100)} used`,
    ]),
    el('div', { class: 'meter' }, [el('div', { class: `meter-fill tone-${tone}`, style: `width:${Math.min(100, pct)}%` })]),
    ...timingNotes,
    detail,
  ]);
}


function renderLimitContributor(row: LimitContributor): HTMLElement {
  const view = limitContributorView(row);
  const fields: (Node | string)[] = [
    el('dt', {}, ['Source event times']),
    el('dd', {}, [view.eventTimeRange]),
    el('dt', {}, ['Observed host']),
    el('dd', {}, [view.scope]),
    el('dt', {}, ['Price-table provider']),
    el('dd', {}, [view.provider]),
    el('dt', {}, ['Serving-route evidence']),
    el('dd', {}, [view.servingRouteEvidence]),
    el('dt', {}, ['Event count']),
    el('dd', {}, [view.eventCount]),
    el('dt', {}, ['Timestamp source']),
    el('dd', {}, [view.timestampSource]),
    el('dt', {}, ['Token subtotal']),
    el('dd', {}, [view.countTotal]),
    el('dt', {}, ['Count basis']),
    el('dd', {}, [view.countBasis]),
    el('dt', {}, ['Recorded token categories']),
    el('dd', {}, [
      el('ul', { class: 'limit-contributor-token-list' }, view.tokenCategories.map((part) =>
        el('li', {}, [el('span', {}, [part.label]), el('span', { class: 'num' }, [part.value])])
      )),
      el('div', { class: 'label-note' }, [view.reasoning]),
    ]),
    el('dt', {}, ['API-equivalent value']),
    el('dd', {}, [view.apiEquivSubtotal]),
    el('dt', {}, ['Recorded price basis']),
    el('dd', {}, [view.priceBasis]),
  ];
  if (view.priceReview) fields.push(el('dt', {}, ['Price evidence']), el('dd', { class: 'limit-contributor-warning' }, [view.priceReview]));
  return el('li', { class: 'limit-contributor-row' }, [
    el('div', { class: 'row-title' }, [view.heading]),
    el('dl', { class: 'limit-contributor-fields' }, fields),
  ]);
}

function renderLimitContributorDisclosure(snapshot: LimitSnapshot): HTMLElement | null {
  if (snapshot.contributors === undefined) return null;
  const contributors = snapshot.contributors;
  const summary = contributors.length === 1 ? 'View 1 contributing group' : 'View ' + formatCompactNumber(contributors.length) + ' contributing groups';
  return el('details', { class: 'limit-contributors' }, [
    el('summary', {}, [summary]),
    el('div', { class: 'limit-contributors-body' }, [
      el('p', { class: 'label-note' }, [
        'Rows group local event metadata by host, model, price-table provider, serving-route evidence, price version and timestamp source. They contain no session IDs or local paths. These rows are included in the block estimate; they are not additional usage. API-equivalent values are not invoices; unpriced events are excluded from a known subtotal, and conflicting price fields withhold the subtotal.',
      ]),
      contributors.length > 0
        ? el('ul', { class: 'limit-contributor-list' }, contributors.map(renderLimitContributor))
        : el('div', { class: 'empty-state' }, ['No usage-event rows matched this activity-based block; activity marks are not token counts.']),
    ]),
  ]);
}
/** 'claude-desktop' is real, locally-observed plan-window telemetry (build item 2) — labelled
 * distinctly from the CLI-only 'claude-block-estimate' fallback so the tray never implies both
 * are the same kind of number (one is measured, the other is an activity-derived estimate). */
function limitSourceLabel(source: LimitSnapshot['source']): string {
  switch (source) {
    case 'codex':
      return 'Codex';
    case 'claude-desktop':
      return 'Claude Desktop';
    case 'claude-block-estimate':
      return 'Claude (estimate)';
    default:
      return 'Claude';
  }
}

function renderCodexAccountMetadata(snapshot: LimitSnapshot): HTMLElement | null {
  const copy = codexAccountMetadataCopy(snapshot);
  if (!copy) return null;
  return el('div', { class: 'codex-account-metadata' }, [
    el('div', { class: 'label-note codex-account-metadata-line', 'data-field': 'plan' }, [copy.plan]),
    el('div', { class: 'label-note codex-account-metadata-line', 'data-field': 'balance' }, [copy.balance]),
    el('div', { class: 'label-note codex-account-metadata-line', 'data-field': 'credits-available' }, [copy.creditsAvailable]),
    el('div', { class: 'label-note codex-account-metadata-line', 'data-field': 'unlimited-credits' }, [copy.unlimitedCredits]),
    el('div', { class: 'label-note codex-account-metadata-note' }, [copy.footer]),
  ]);
}

function renderLimitCard(snapshot: LimitSnapshot): HTMLElement {
  const who = limitSourceLabel(snapshot.source);
  const subject = limitSubjectLabel(snapshot);
  const title = snapshot.limitId ? `${who} — ${subject} [${snapshot.limitId}]` : `${who} — ${subject}`;
  const rows = snapshot.windows.map((w) => renderLimitWindow(w, snapshot.estimate));
  const ageDays = Math.floor(Math.max(0, Date.now() - snapshot.capturedAt) / 86_400_000);
  const contributors = renderLimitContributorDisclosure(snapshot);
  const accountMetadata = renderCodexAccountMetadata(snapshot);
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, [title]),
    el('div', { class: 'label-note' }, [`Snapshot ${new Date(snapshot.capturedAt).toLocaleString()}`]),
    ...(ageDays >= 1 ? [el('div', { class: 'snapshot-age label-note' }, [`Recorded ${ageDays} day${ageDays === 1 ? '' : 's'} ago. Percentages may have changed.`])] : []),
    ...(accountMetadata ? [accountMetadata] : []),
    ...rows,
    ...(contributors ? [contributors] : []),
  ]);
}

async function renderLimits(view: TabView): Promise<void> {
  const limits = await limitsCache.load('limits', () => window.tokenelo.getLimits());
  if (!view.current()) return;
  const container = view.stage;
  container.replaceChildren();
  container.append(el('div', { class: 'label-note' }, ['Plan percentages are local snapshots; block dollar figures are API-equivalent estimates, not billed amounts.']));
  if (limits.snapshots.length === 0) {
    container.append(el('div', { class: 'empty-state' }, ['No limit snapshots yet.']));
    return;
  }
  for (const snapshot of limits.snapshots) container.append(renderLimitCard(snapshot));
}

// ── Plan comparison (shown below the Usage tab's model table) ─────────────────────────────────

function subscriptionRow(row: SubscriptionRow): HTMLElement {
  const basis = row.costBasis;
  const unavailable = !basis ? 'Plan cost basis unavailable from this daemon.'
    : basis.state === 'price-unconfigured' ? 'Plan price not configured.'
    : basis.state === 'price-invalid' ? 'Configured plan price is invalid.'
    : basis.state === 'period-unavailable' ? 'Historical billing period unavailable; plan cost is not estimated.'
    : basis.state === 'period-invalid' ? 'Plan cost period is invalid.' : null;
  const leverageText = unavailable || row.partial === null ? '— ratio'
    : row.leverage === null ? '— ratio'
    : `${row.leverage.toFixed(2)}×`;
  const costText = unavailable ?? (row.billedUsd !== null && Number.isFinite(row.billedUsd) && basis?.monthlyUsd !== null && basis?.monthlyUsd !== undefined
    ? `Configured plan cost ${formatMoney(row.billedUsd)} · ${formatMoney(basis.monthlyUsd)}/month · 30-day proration`
    : 'Plan cost evidence unavailable.');
  const periodText = basis?.state === 'configured-proration' && basis.rangeStartMs !== null
    ? `${new Date(basis.rangeStartMs).toLocaleString()} to ${new Date(basis.rangeEndMs).toLocaleString()} · invoice verification unavailable`
    : 'Configured plan price and API-equivalent value have separate evidence bases.';
  return el('div', { class: 'row-item' }, [
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title' }, [row.account]),
      el('div', { class: 'row-sub' }, [row.planName ?? row.kind]),
      el('div', { class: 'label-note subscription-cost-basis' }, [costText]),
      el('div', { class: 'label-note subscription-cost-period' }, [periodText]),
      ...(priceEvidenceLabel(row) ? [el('div', { class: 'label-note' }, [priceEvidenceLabel(row) as string])] : []),
    ]),
    el('div', { class: 'row-metrics' }, [
      el('span', { class: 'num' }, [priceFieldsUsable(row) ? formatMoney(row.apiEquivUsd) : '—']),
      el('span', { class: 'label-note' }, ['API-equiv']),
      el('span', { class: 'num label-note' }, [leverageText]),
    ]),
  ]);
}

/** API-equivalent value grouped by configured source and hosts, beside each configured plan's cost. */
function planComparisonCard(summary: SummaryResponse): HTMLElement {
  const subscriptionWindow = recordedWindowDisclosure(summary.timeBasis);
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Plan comparison']),
    el('div', { class: 'label-note' }, ['API-equivalent value grouped by configured source and hosts, compared with the configured plan cost. Proration uses a 30-day month; vendor account identity and invoice history are unverified.']),
    el('div', { class: 'label-note subscription-time-basis', 'data-window-state': subscriptionWindow.state }, [
      `${subscriptionWindow.window}${subscriptionWindow.exclusions ? ` ${subscriptionWindow.exclusions}` : ''}`,
    ]),
    el(
      'div',
      { class: 'row-list' },
      summary.subscriptions.length ? summary.subscriptions.map(subscriptionRow) : [el('div', { class: 'empty-state' }, ['No accounts configured.'])]
    ),
  ]);
}

// ── Coverage tab (build item 6) ───────────────────────────────────────────────────────────────

/** Coverage status for one catalog row — mirrors `CoverageEntry`'s own doc: 'not-capturable' (a
 * deliberate decision, `reason` set) always wins over the detection booleans, since it's true
 * regardless of what this host happens to detect right now. */
function processObservationText(listing: ProcessesResponse['listing']): string {
  if (processProbePending(listing)) return 'Process check in progress.';
  if (listing?.status === 'unavailable') return 'Process listing unavailable.';
  if (!listing || listing.observedAt === null) return 'Process observation time unavailable from this daemon.';
  return `Processes observed ${new Date(listing.observedAt).toLocaleString()} · snapshot`;
}

function coverageStatus(entry: CoverageEntry): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  if (entry.captured) return { label: 'Recorded', tone: 'good' };
  if (entry.captureSupport === 'unsupported') return { label: 'Unsupported', tone: 'neutral' };
  if (entry.captureSupport === 'not-capturable') return { label: 'Not capturable', tone: 'neutral' };
  if (entry.reason) return { label: 'Capture unavailable', tone: 'neutral' };
  if (entry.installed || (state.coverage?.processListing?.status !== 'unavailable' && entry.running)) return { label: 'Detected', tone: 'warn' };
  if (state.coverage?.processListing?.status !== 'ok') return { label: 'Detection unknown', tone: 'neutral' };
  return { label: 'Not detected', tone: 'neutral' };
}

const COVERAGE_CATEGORY_LABEL: Record<CoverageEntry['category'], string> = {
  'cloud-agent-cli': 'Cloud agent — CLI',
  'cloud-agent-desktop': 'Cloud agent — desktop',
  'local-llm-server': 'Local LLM server',
  other: 'Other',
};

function coverageRow(entry: CoverageEntry): HTMLElement {
  const hold = entry.id === 'claude-code-cli'
    ? claudeCaptureHoldView(state.coverage?.incompleteCapture)
    : null;
  const status = coverageStatus(entry);
  const detailsId = 'coverage-evidence-' + entry.id;
  const toggle = el('button', {
    type: 'button', class: 'model-toggle coverage-toggle',
    'aria-label': 'Coverage evidence for ' + entry.name,
    'aria-expanded': 'false', 'aria-controls': detailsId,
  }, [entry.name, el('span', { class: 'label-note coverage-toggle-note' }, ['View evidence'])]);
  const sub: string[] = [];
  const listing = state.coverage?.processListing;
  if (processProbePending(listing)) sub.push('process check in progress');
  else if (listing?.status === 'unavailable') sub.push('process state unknown');
  else if (entry.running) sub.push(listing?.status === 'ok' ? 'running in snapshot' : 'process reported · time unavailable');
  else if (!listing) sub.push('process state unavailable');
  if (entry.installed && !entry.running) sub.push('installed');
  if (entry.lastEventAt !== null) sub.push(`latest stored telemetry ${new Date(entry.lastEventAt).toLocaleString()}`);
  if (entry.reason) sub.push(entry.reason);
  const processState = processProbePending(listing)
    ? 'Process check in progress; current running state is unknown.'
    : listing?.status === 'ok'
      ? entry.running ? 'Matching process in snapshot.' : 'No matching process in snapshot.'
      : 'Observation unavailable; current running state is unknown.';
  const telemetryTimeLabel = entry.lastTelemetryTimeBasis === 'event-recorded'
    ? 'Latest recorded event time'
    : entry.lastTelemetryTimeBasis === 'plan-captured' ? 'Latest plan snapshot time' : 'Latest stored telemetry time';
  const telemetryTimeNote = entry.lastTelemetryTimeBasis === 'event-recorded'
    ? 'Reported event time; arrival time and clock accuracy are unverified.'
    : entry.lastTelemetryTimeBasis === 'plan-captured'
      ? 'Capture time stored with the plan snapshot; clock accuracy is unverified.'
      : 'This response does not identify the timestamp source.';
  const detail = el('div', { class: 'coverage-evidence', id: detailsId, hidden: '' }, [
    el('div', { class: 'row-title' }, [entry.name]),
    el('div', { class: 'label-note' }, [
      'Telemetry · ' + (entry.captured ? 'Recorded usage or plan telemetry is present.' : 'No matching telemetry recorded.'),
    ]),
    el('div', { class: 'label-note' }, [
      telemetryTimeLabel + ' · ' + (entry.lastEventAt === null ? 'Time unavailable.' : new Date(entry.lastEventAt).toLocaleString()),
    ]),
    ...(entry.lastEventAt !== null ? [el('div', { class: 'label-note' }, [telemetryTimeNote])] : []),
    el('div', { class: 'label-note' }, [
      'Installation evidence · ' + (entry.installed ? 'Detected in this snapshot.' : 'No local installation evidence in this snapshot.'),
    ]),
    el('div', { class: 'label-note' }, ['Process observation · ' + processState]),
    ...(listing?.status === 'ok' && listing.observedAt !== null ? [
      el('div', { class: 'label-note' }, ['Processes checked ' + new Date(listing.observedAt).toLocaleString()]),
    ] : []),
    ...(entry.reason ? [el('div', { class: 'coverage-reason' }, [entry.reason])] : []),
    ...(hold ? [el('div', { class: 'label-note' }, [hold.detail])] : []),
    el('div', { class: 'label-note' }, [
      'Recorded telemetry does not establish complete usage coverage or current capture. These observations describe this host.',
    ]),
  ]);
  toggle.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    toggle.setAttribute('aria-expanded', String(!detail.hidden));
    if (!detail.hidden) detail.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
  if (hold) sub.push(hold.detail);
  const row = el('div', { class: 'row-item' }, [
    el('div', { class: 'row-main' }, [
      toggle,
      el('div', { class: 'row-sub' }, [sub.join(' · ') || COVERAGE_CATEGORY_LABEL[entry.category]]),
    ]),
    el('span', { class: `badge tone-${status.tone} badge-sm` }, [status.label]),
    ...(hold ? [el('span', { class: `badge tone-${hold.tone} badge-sm`, 'data-hold-state': hold.state }, [hold.label])] : []),
  ]);
  return el('div', { class: 'coverage-entry', 'data-coverage-id': entry.id }, [row, detail]);
}

const COLLECTOR_LABELS: Record<string, string> = {
  claude: 'Claude Code JSONL', codex: 'Codex rollouts', 'qwen-code': 'Qwen Code JSONL',
  'claude-desktop-plan-usage': 'Claude Desktop plan usage',
  'claude-desktop-sessions': 'Claude Desktop session context',
  'ollama-serverlog': 'Ollama server logs',
};

function collectorScanRow(scan: CollectorScanStatus, observedAt: number): HTMLElement {
  const status = collectorScanStatus(scan, observedAt);
  const details: (Node | string)[] = [el('div', { class: 'row-title' }, [COLLECTOR_LABELS[scan.name] ?? scan.name])];
  if (scan.running && scan.currentStartedAt !== null) details.push(el('div', { class: 'label-note' }, [
    `Started ${new Date(scan.currentStartedAt).toLocaleString()} · running ${formatDuration(Math.max(0, observedAt - scan.currentStartedAt))}${scan.rerunQueued ? ' · another scan queued' : ''}`,
  ]));
  if (scan.lastFinishedAt !== null) details.push(el('div', { class: 'label-note' }, [
    `Last attempt ${new Date(scan.lastFinishedAt).toLocaleString()}${scan.lastDurationMs === null ? '' : ` · ${scan.lastDurationMs < 1000 ? `${scan.lastDurationMs < 1 ? '<1' : Math.round(scan.lastDurationMs)} ms` : `${(scan.lastDurationMs / 1000).toFixed(2)} s`}`}${scan.lastOutcome ? ` · ${scan.lastOutcome}` : ''}`,
  ]));
  if (scan.lastFailedAt !== null && scan.lastFailedAt !== scan.lastFinishedAt) details.push(el('div', { class: 'label-note' }, [`Last failure ${new Date(scan.lastFailedAt).toLocaleString()}`]));
  if (scan.lastCompletedAt !== null && scan.lastCompletedAt !== scan.lastFinishedAt) details.push(el('div', { class: 'label-note' }, [`Last completed ${new Date(scan.lastCompletedAt).toLocaleString()}`]));
  if (scan.lastStats) details.push(el('div', { class: 'label-note' }, [
    `${formatCompactNumber(scan.lastStats.recordsEmitted)} records emitted · ${formatCompactNumber(scan.lastStats.filesScanned)} files scanned · ${formatCompactNumber(scan.lastStats.filesSkipped)} skipped · ${formatCompactNumber(scan.lastStats.bytesRead)} bytes read · ${scan.lastStats.warningCount} warnings`,
  ]));
  if (scan.name === 'codex') {
    const cursor = scan.lastStats?.codexCursorCoverageAtStat;
    details.push(el('div', { class: 'label-note' }, [!cursor
      ? 'Per-file cursor detail is unavailable from this daemon. Scan completion does not establish complete capture.'
      : `Last scan: ${formatCompactNumber(cursor.filesBehindCursorAtStat)}/${formatCompactNumber(cursor.filesObservedAtStat)} files beyond their cursors (${formatCompactNumber(cursor.bytesUnreadAtStat)} bytes); ${formatCompactNumber(cursor.filesWithoutUsableCursorAtStat)} had no usable cursor; ${formatCompactNumber(cursor.filesWithStatError + cursor.filesWithCursorStateError)} could not be assessed. Scan snapshot only, not token or billing totals.`]));
  }
  return el('div', { class: 'row-item collector-scan' }, [
    el('div', { class: 'row-main' }, details),
    el('span', { class: `badge tone-${status.tone} badge-sm` }, [status.label]),
  ]);
}

function captureCompletenessCard(coverage: CoverageResponse): HTMLElement {
  const hold = claudeCaptureHoldView(coverage.incompleteCapture);
  const body: (Node | string)[] = [
    el('div', { class: 'section-title' }, ['Capture completeness']),
    el('div', { class: 'label-note' }, ['Persisted Claude JSONL holds. Scan results and other capture sources are listed below.']),
  ];
  if (hold.state === 'unavailable') {
    body.push(el('div', { class: 'empty-state' }, [hold.detail]));
  } else if (hold.state === 'clear') {
    body.push(el('div', { class: 'row-item' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, ['Claude Code JSONL']),
        el('div', { class: 'row-sub' }, [hold.detail]),
      ]),
      el('span', { class: `badge tone-${hold.tone} badge-sm` }, [hold.label]),
    ]));
  } else {
    const heldFiles = hold.heldFiles;
    const storedEvidenceHolds = hold.storedComponentEvidenceHeldFiles;
    body.push(el('div', { class: 'row-item' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, [`${heldFiles} held Claude ${heldFiles === 1 ? 'file' : 'files'}`]),
        el('div', { class: 'row-sub' }, [hold.detail]),
      ]),
      el('span', { class: `badge tone-${hold.tone} badge-sm` }, [hold.label]),
    ]));
    if (hold.oldestHeldAt !== null) body.push(el('div', { class: 'label-note' }, [`Oldest hold ${new Date(hold.oldestHeldAt).toLocaleString()}`]));
    if (hold.maxLineBytes !== null) body.push(el('div', { class: 'label-note' }, [`Oldest hold's recorded line limit: ${formatCompactNumber(hold.maxLineBytes / 1_048_576)} MiB.`]));
    if (storedEvidenceHolds !== null && storedEvidenceHolds > 0) body.push(el('div', { class: 'label-note' }, [
      `${storedEvidenceHolds} ${storedEvidenceHolds === 1 ? 'file is' : 'files are'} blocked by malformed stored component evidence. `,
      'Earlier committed records are retained. Use verified ledger recovery; available files are retried on each scan, and independent files can continue. ',
      'Removed or excluded files remain counted; their pending records have not been recovered.',
    ]));
    if (storedEvidenceHolds !== null && heldFiles > storedEvidenceHolds) body.push(el('div', { class: 'label-note' }, [
      'Resolve the source file or raise ', el('code', {}, ['claude.maxLineBytes']),
      ' in configuration, then restart the collector to recheck. Removed files remain counted; their unread records have not been recovered.',
    ]));
  }
  return el('div', { class: 'card capture-completeness' }, body);
}

function dualCaptureSettleCard(coverage: CoverageResponse): HTMLElement | null {
  const local = coverage.localCapture;
  if (!local || local.mode !== 'both') return null;
  const settle = local.dualSettle;
  let presentation: { label: string; tone: 'warn' | 'bad' | 'neutral'; detail: string };
  switch (settle?.state) {
    case 'settling': presentation = { label: 'Settling', tone: 'warn', detail: 'Recent estimates wait for the duplicate window, active proxy work, and durable backlog to settle.' }; break;
    case 'limit-reached': presentation = { label: 'Log cursor paused', tone: 'bad', detail: 'The settle queue reached its bound; the log cursor is held.' }; break;
    case 'history-incomplete': presentation = { label: 'History review needed', tone: 'bad', detail: 'Unread log bytes may have been lost during rotation; this interval may be incomplete.' }; break;
    case 'backlog-review': presentation = { label: 'Backlog review needed', tone: 'bad', detail: 'The durable queue reports an error or incomplete history; unmatched estimates remain held.' }; break;
    case 'no-held-estimates': presentation = { label: 'No held estimates', tone: 'neutral', detail: 'No server-log estimates are currently held. This does not prove complete capture.' }; break;
    case 'unobserved': presentation = { label: 'Not observed yet', tone: 'neutral', detail: 'No settle snapshot has been recorded yet; capture completeness is unknown.' }; break;
    default: presentation = { label: 'Unknown', tone: 'neutral', detail: 'Settle evidence is unavailable; capture completeness is unknown.' }; break;
  }
  const queueError = settle?.backlogLastError === 'ledger-busy' ? 'ledger is busy'
    : settle?.backlogLastError === 'ledger-unavailable' ? 'ledger unavailable'
      : settle?.backlogLastError === 'invalid-entry' ? 'invalid queued observation'
        : settle?.backlogLastError === 'queue-unwritable' ? 'queue read/write failed'
          : settle?.backlogLastError === 'backlog-full' ? 'queue capacity reached'
            : settle?.backlogLastError === 'entry-too-large' ? 'queued observation exceeded its size limit' : null;
  const pending = settle?.pendingLogEstimates === null || settle?.pendingLogEstimates === undefined
    ? 'Held server-log estimate count unavailable.'
    : `${formatCompactNumber(settle.pendingLogEstimates)} server-log estimates held; this is a row count, not token usage.`;
  const active = settle?.activePrimaryProxyRequests === null || settle?.activePrimaryProxyRequests === undefined
    ? 'Active primary-proxy count unavailable.'
    : `${formatCompactNumber(settle.activePrimaryProxyRequests)} active primary-proxy ${settle.activePrimaryProxyRequests === 1 ? 'handler' : 'handlers'} in this snapshot.`;
  const backlog = settle?.backlogPending === null || settle?.backlogPending === undefined
    ? 'Durable backlog status unavailable.'
    : `${formatCompactNumber(settle.backlogPending)} local observations queued${queueError ? ` · ${queueError}` : ''}.`;
  return el('div', { class: 'card dual-capture-settle', 'aria-label': 'Dual-capture settle status' }, [
    el('div', { class: 'section-title' }, ['Local capture settle']),
    el('div', { class: 'label-note' }, [`Configured mode both · checked ${new Date(local.observedAt).toLocaleString()}`]),
    el('div', { class: 'row-item' }, [
      el('div', { class: 'row-main' }, [el('div', { class: 'row-title' }, ['Server-log duplicate guard'])]),
      el('span', { class: `badge tone-${presentation.tone} badge-sm` }, [presentation.label]),
    ]),
    el('div', { class: 'label-note dual-capture-settle-detail' }, [presentation.detail]),
    el('div', { class: 'label-note' }, [pending]),
    el('div', { class: 'label-note' }, [active]),
    el('div', { class: 'label-note' }, [backlog]),
    el('div', { class: 'label-note' }, ['No held estimates does not prove complete capture. These aggregate signals include no file paths, model names, prompts, or response text.']),
  ]);
}

function dualCaptureSummaryText(local: CoverageResponse['localCapture']): string {
  if (!local) return 'Local capture status unavailable from this daemon.';
  if (local.mode !== 'both') return `Configured local capture mode: ${local.mode}.`;
  const settle = local.dualSettle;
  if (!settle) return 'Dual-capture settle status unavailable.';
  if (settle.state === 'settling') {
    const count = (value: number | null, singular: string, plural: string): string => value === null
      ? `unknown ${plural}` : `${formatCompactNumber(value)} ${value === 1 ? singular : plural}`;
    const backlogIssue = settle.backlogLastError === 'ledger-busy' ? ' (backlog ledger busy)'
      : settle.backlogLastError === 'ledger-unavailable' ? ' (backlog ledger unavailable)'
        : settle.backlogLastError === 'invalid-entry' ? ' (invalid queued observation)'
          : settle.backlogLastError === 'queue-unwritable' ? ' (queue read/write failed)'
            : settle.backlogLastError === 'backlog-full' ? ' (queue capacity reached)'
              : settle.backlogLastError === 'entry-too-large' ? ' (queued item exceeded size limit)' : '';
    return `Dual capture settling · ${count(settle.pendingLogEstimates, 'server-log estimate held', 'server-log estimates held')} · ${count(settle.activePrimaryProxyRequests, 'active primary-proxy handler', 'active primary-proxy handlers')} · ${count(settle.backlogPending, 'local observation queued', 'local observations queued')}${backlogIssue}.`;
  }
  if (settle.state === 'limit-reached') return 'Dual capture paused · settle queue limit reached.';
  if (settle.state === 'history-incomplete') return 'Dual capture history needs review.';
  if (settle.state === 'backlog-review') return 'Dual capture backlog needs review.';
  if (settle.state === 'no-held-estimates') return 'No server-log estimates currently held; this is not a coverage guarantee.';
  if (settle.state === 'unobserved') return 'Dual-capture settle state has not been observed yet.';
  return 'Dual-capture settle status is unknown.';
}

async function renderCoverage(view: TabView): Promise<void> {
  const original = await coverageCache.load('coverage', () => window.tokenelo.getCoverage());
  if (!view.current()) return;
  const coverage = processObservations.apply(original);
  state.coverage = coverage; // read by the row helpers below, for this render only
  const container = view.stage;
  container.replaceChildren();
  const processNote = el('div', { class: 'label-note process-observation-note' }, [processObservationText(coverage.processListing)]);
  const refresh = el('button', { type: 'button', class: 'refresh-btn process-refresh-btn' }, ['Refresh processes']);
  const feedback = el('div', { class: 'label-note process-refresh-feedback', role: 'status', 'aria-live': 'polite' });
  const context = el('div', { class: 'card coverage-context' }, [
    el('div', { class: 'section-title' }, [`Telemetry coverage · ${coverage.host}`]),
    el('div', { class: 'label-note' }, [`Checked ${new Date(coverage.generatedAt).toLocaleString()}`]),
    el('div', { class: 'label-note dual-capture-summary' }, [dualCaptureSummaryText(coverage.localCapture)]),
    processNote,
    el('div', { class: 'process-observation-controls' }, [refresh, feedback]),
    el('div', { class: 'coverage-explainer' }, [
      'Installed/running checks describe this host. Recorded means matching usage or plan telemetry exists; the last-telemetry time may be older than this check. Tokenelo stores usage metadata, not prompt or response text.',
    ]),
    el('div', { class: 'label-note' }, ['Refresh processes rechecks running tools only. Installation, telemetry and scan results retain the checked time above. Use the main Refresh to recheck the whole snapshot.']),
  ]);
  container.append(context);
  const entriesById = new Map<string, HTMLElement>();
  const controller = new ProcessRefresh({
    current: () => view.current(),
    read: () => window.tokenelo.getProcesses(),
    show: (next) => {
      const updated = coverageWithProcessObservation(state.coverage!, next);
      processObservations.remember(next);
      state.coverage = updated;
      processNote.textContent = processObservationText(updated.processListing);
      // Preserve toggle identity, focus, disclosure state and the original snapshot clocks.
      for (const tool of updated.tools) {
        const existing = entriesById.get(tool.id);
        if (!existing) continue;
        const replacement = coverageRow(tool);
        for (const selector of ['.row-sub', '.badge']) {
          existing.querySelector(selector)!.replaceWith(replacement.querySelector(selector)!);
        }
        const detail = existing.querySelector('.coverage-evidence')!;
        detail.replaceChildren(...Array.from(replacement.querySelector('.coverage-evidence')!.childNodes));
      }
    },
    status: (status) => {
      // aria-disabled keeps keyboard focus on the control while the owner refuses overlap.
      refresh.setAttribute('aria-disabled', String(status === 'checking' || status === 'retired'));
      refresh.textContent = status === 'retired' ? 'View refreshing…' : status === 'checking' ? 'Checking processes…' : 'Refresh processes';
      context.setAttribute('aria-busy', String(status === 'checking'));
      feedback.textContent = status === 'retired' ? 'This process control was retired. The view is refreshing.' : status === 'scheduled' ? 'Will check again shortly.'
        : status === 'checking' ? 'Checking process observation…'
          : status === 'failed' ? 'Could not refresh. The previous observation remains.'
            : processProbePending(state.coverage?.processListing) ? 'Process check is still running. Refresh to check again.' : 'Process response received.';
    },
  });
  state.processRefresh = controller;
  refresh.addEventListener('click', () => { void controller.refresh(); });
  container.append(captureCompletenessCard(coverage));
  const dualCaptureCard = dualCaptureSettleCard(coverage);
  if (dualCaptureCard) container.append(dualCaptureCard);
  const scans = coverage.collectorScans;
  container.append(el('div', { class: 'card collector-scans' }, [
    el('div', { class: 'section-title' }, ['Collector scans']),
    el('div', { class: 'label-note' }, [`Scan snapshot ${new Date(coverage.generatedAt).toLocaleString()}. Refresh to recheck.`]),
    el('div', { class: 'label-note' }, [
      'Scan completion and last usage are separate. A quiet scan may emit no records; warnings can mean incomplete capture. Counts are emitted records, not new ledger inserts. Metering proxies report requests rather than scheduled scans.',
    ]),
    scans === undefined
      ? el('div', { class: 'empty-state' }, ['Scan status is unavailable from this daemon.'])
      : scans.length === 0
        ? el('div', { class: 'empty-state' }, ['No scheduled collectors are registered.'])
        : el('div', { class: 'row-list' }, scans.map((scan) => collectorScanRow(scan, coverage!.generatedAt))),
  ]));
  const byCategory = new Map<CoverageEntry['category'], CoverageEntry[]>();
  for (const t of coverage.tools) {
    const list = byCategory.get(t.category) ?? [];
    list.push(t);
    byCategory.set(t.category, list);
  }
  const order: CoverageEntry['category'][] = ['cloud-agent-cli', 'cloud-agent-desktop', 'local-llm-server', 'other'];
  for (const category of order) {
    const entries = byCategory.get(category);
    if (!entries || entries.length === 0) continue;
    container.append(
      el('div', { class: 'card' }, [
        el('div', { class: 'section-title' }, [COVERAGE_CATEGORY_LABEL[category]]),
        el('div', { class: 'row-list' }, entries.map(entry => { const row = coverageRow(entry); entriesById.set(entry.id, row); return row; })),
      ])
    );
  }
  if (coverage.tools.length === 0) {
    container.append(el('div', { class: 'empty-state' }, ['No coverage data yet.']));
  }
  controller.start({ listing: coverage.processListing });
}

// ── Fleet view (read-only aggregate summaries over the configured Tailscale peers) ─────────────

function fleetHostStatus(status: FleetHostResult['status']): string {
  switch (status) {
    case 'online': return 'Online';
    case 'offline': return 'Offline';
    case 'unauthorized': return 'Token rejected';
    case 'untrusted': return 'Identity check failed';
    case 'not-configured': return 'Not configured';
    case 'report-timeout': return 'Report timed out';
    case 'report-unavailable': return 'Report unavailable';
  }
}

function fleetStatusBadge(status: FleetHostResult['status']): HTMLElement {
  const tone = status === 'online' ? 'good' : status === 'offline' || status === 'unauthorized' ? 'bad' : 'warn';
  return el('span', { class: `badge tone-${tone} badge-sm` }, [fleetHostStatus(status)]);
}

function fleetHostCard(host: FleetHostResult, includeApiBasisNote = false): HTMLElement {
  if (!host.summary) {
    const note = host.status === 'not-configured'
      ? 'Set this peer’s Tailscale URL and copy its fleet token to connect.'
      : host.status === 'unauthorized'
        ? 'The local peer token does not match this host’s fleet listener.'
        : host.status === 'untrusted'
          ? 'The peer identity or response did not match this host. Check its address and host label.'
          : host.status === 'report-timeout'
            ? 'This host proved its identity, but the selected report did not finish in time. Choose a shorter period. Its report is excluded from this total.'
            : host.status === 'report-unavailable'
              ? 'This host proved its identity, but its report service is busy or unavailable. Refresh or choose a shorter period. Its report is excluded from this total.'
          : 'The peer did not respond. Its current collector state is unknown here.';
    return el('div', { class: 'card fleet-host-card' }, [
      el('div', { class: 'fleet-host-heading' }, [
        el('div', { class: 'section-title' }, [host.label]),
        fleetStatusBadge(host.status),
      ]),
      el('div', { class: 'label-note' }, [note]),
    ]);
  }

  const summary = host.summary;
  return el('div', { class: 'card fleet-host-card' }, [
    el('div', { class: 'fleet-host-heading' }, [
      el('div', { class: 'section-title' }, [summary.host]),
      fleetStatusBadge('online'),
    ]),
    el('div', { class: 'fleet-metrics' }, [
      el('div', { class: 'fleet-metric' }, [
        el('span', { class: 'label-note' }, ['Events']),
        el('strong', { class: 'num' }, [formatCompactNumber(summary.totals.events)]),
      ]),
      el('div', { class: 'fleet-metric' }, [
        el('span', { class: 'label-note' }, ['Tokens']),
        el('strong', { class: 'num', title: host.summary ? countBasisLabel(host.summary.totals.tokens, host.summary.totals.events) : '' }, [host.summary ? tokenTotalText(host.summary.totals.tokens) : '—']),
      ]),
      el('div', { class: 'fleet-metric' }, [
      el('span', { class: 'label-note api-equivalent-price-label', title: API_EQUIVALENT_BASIS_NOTE, 'aria-label': `API-equivalent. ${API_EQUIVALENT_BASIS_NOTE}` }, ['API-equivalent']),
        el('strong', { class: 'num' }, [formatApiEquivSubtotal(summary.totals)]),
        ...(priceEvidenceLabel(summary.totals) ? [el('span', { class: 'label-note' }, [priceEvidenceLabel(summary.totals) as string])] : []),
      ]),
    ]),
    ...(includeApiBasisNote ? [apiEquivalentBasisNote('fleet-api-equiv-basis-note')] : []),
    el('div', { class: 'label-note' }, [countBasisLabel(summary.totals.tokens, summary.totals.events)]),
    el('div', { class: 'label-note fleet-reasoning-note' }, ['Reasoning is a subset of output where applicable; do not add it again to the total.']),
    el('div', { class: 'label-note fleet-time' }, [`Report generated ${new Date(summary.generatedAt).toLocaleString()} · range ${summary.range}`]),
    el('div', { class: 'label-note fleet-time' }, [`Agent time ${formatDuration(summary.activeTime.agentMs)}`]),
  ]);
}

async function renderFleet(view: TabView): Promise<void> {
  const overview = await fleetCache.load(view.key.range, () => window.tokenelo.getFleetOverview(view.key.range));
  if (!view.current()) return;

  const availableSelection = state.fleetHost === 'fleet' || overview.hosts.some((host) => `${host.kind}:${host.label}` === state.fleetHost);
  if (!availableSelection) state.fleetHost = 'fleet';

  const select = el('select', { class: 'fleet-host-select', 'aria-label': 'Fleet host view' });
  select.append(el('option', { value: 'fleet' }, ['Fleet']));
  for (const host of overview.hosts) {
    const label = host.kind === 'local' ? `${host.label} · this host` : host.label;
    select.append(el('option', { value: `${host.kind}:${host.label}` }, [label]));
  }
  select.value = state.fleetHost;
  select.addEventListener('change', () => {
    state.fleetHost = select.value;
    contain(renderCurrentTab(), showFatal);
  });

  const container = view.stage;
  container.replaceChildren(
    el('div', { class: 'fleet-toolbar' }, [
      el('div', { class: 'section-title' }, ['Host view']),
      select,
    ])
  );

  if (state.fleetHost === 'fleet') {
    const online = overview.hosts.filter((host) => host.summary);
    const hasReports = online.length > 0;
    const allEvents = online.reduce((sum, host) => sum + (host.summary?.totals.events ?? 0), 0);
    const allTokens = aggregateTokenText(online.map(host => host.summary!.totals.tokens));
    const allApiEquiv = online.reduce((sum, host) => sum + (host.summary?.totals.apiEquivUsd ?? 0), 0);
    const fleetPriceFields = aggregatePriceFields(online.map(host => host.summary!.totals));
    const allEstimatedPrices = online.some(host => host.summary?.totals.estimatedPriceEvents == null) ? null : online.reduce((sum, host) => sum + (host.summary?.totals.estimatedPriceEvents ?? 0), 0);
    const populated = online.filter(host => (host.summary?.totals.events ?? 0) > 0);
    const allPriceStatus = populated.length === 0 || populated.some(host => host.summary?.totals.priceStatus == null) ? null : populated.some(host => host.summary?.totals.priceStatus === 'UNPRICED') ? 'UNPRICED' : populated.some(host => host.summary?.totals.priceStatus === 'ESTIMATE') ? 'ESTIMATE' : 'LIST';
    // Unknown propagates: any online host without a count makes the fleet count unknown, never a sum of the known ones.
    const allUnpriced: number | null = online.some((host) => host.summary?.totals.unpricedEvents === null || host.summary?.totals.unpricedEvents === undefined)
      ? null
      : online.reduce((sum, host) => sum + (host.summary?.totals.unpricedEvents ?? 0), 0);
    container.append(el('div', { class: 'card' }, [
      el('div', { class: 'section-title' }, [`Reported host total · ${online.length}/${overview.hosts.length}`]),
      el('div', { class: 'fleet-metrics fleet-total' }, [
        el('div', { class: 'fleet-metric' }, [el('span', { class: 'label-note' }, ['Events']), el('strong', { class: 'num' }, [hasReports ? formatCompactNumber(allEvents) : 'Unavailable'])]),
        el('div', { class: 'fleet-metric' }, [el('span', { class: 'label-note' }, ['Tokens']), el('strong', { class: 'num', title: allTokens.title }, [allTokens.text])]),
        el('div', { class: 'fleet-metric' }, [el('span', { class: 'label-note' }, ['API-equivalent']), el('strong', { class: 'num' }, [!hasReports ? 'Unavailable' : fleetPriceFields.usable ? formatApiEquivSubtotal({ apiEquivUsd: allApiEquiv, events: allEvents, unpricedEvents: allUnpriced, priceEvidence: fleetPriceFields.priceEvidence }) : '—']), el('span', { class: 'label-note' }, [!hasReports ? 'No host reports available for this period.' : !fleetPriceFields.usable && !fleetPriceFields.priceEvidence ? 'Price fields need review on an online host' : priceEvidenceLabel({ events: allEvents, priceEvidence: fleetPriceFields.priceEvidence, unpricedEvents: allUnpriced, estimatedPriceEvents: allEstimatedPrices, priceStatus: allPriceStatus }) ?? 'No unpriced events or estimated prices'])]),
      ]),
      apiEquivalentBasisNote('fleet-api-equiv-basis-note'),
      el('div', { class: 'label-note' }, [allTokens.title]),
      el('div', { class: 'label-note fleet-reasoning-note' }, ['Reasoning is a subset of output where applicable; do not add it again to the total.']),
    ]));
    for (const host of overview.hosts) container.append(fleetHostCard(host));
    if (overview.hosts.length === 1) {
      container.append(el('div', { class: 'label-note' }, ['Add Tailscale peers in config to see the full fleet.']));
    }
  } else {
    const selected = overview.hosts.find((host) => `${host.kind}:${host.label}` === state.fleetHost);
    if (selected) container.append(fleetHostCard(selected, true));
  }
  container.append(el('div', { class: 'label-note' }, [
    'Totals include only hosts with a returned report. Each report shows its own generated time and selected range only; peer summaries do not share a recorded-window cutoff, and matching times do not establish a shared snapshot or complete capture.',
  ]));
  container.append(el('div', { class: 'label-note' }, ['Fleet shares aggregate usage only. Session and project paths stay on each host.']));
}

// ── Doctor overlay ────────────────────────────────────────────────────────────────────────────

async function loadDoctor(): Promise<DoctorReport> {
  return doctorCache.load('doctor', () => window.tokenelo.getDoctor());
}

/** The overlay and its trigger, as the coordinator needs them (see doctor-view.ts for the sequencing rules). */
const doctor = new DoctorView(
  {
    renderContent: (content: DoctorContent) => {
      const overlay = document.getElementById('doctor-panel') as HTMLElement;
      const body = content.kind === 'error'
        ? [el('div', { class: 'empty-state', role: 'alert' }, ['Doctor report unavailable. Close and reopen Doctor to try again.'])]
        : [
          el('div', { class: 'label-note' }, [`All stored history · report ${responseClock(content.report.generatedAt)}`]),
          el('div', { class: 'row-item doctor-warnings-overview' }, [
            el('div', { class: 'row-main' }, [
              el('div', { class: 'row-title' }, [`${content.report.warnings.length} ${content.report.warnings.length === 1 ? 'warning' : 'warnings'} reported`]),
              el('div', { class: 'label-note' }, [content.report.warnings.length ? 'Review these diagnostics. Counts do not establish complete capture.' : 'No warnings were reported. Complete capture is not established.']),
            ]),
            ...(content.report.warnings.length ? [el('button', { type: 'button', class: 'doctor-view-warnings', 'aria-controls': 'doctor-warnings-title' }, ['View warnings'])] : []),
          ]),
          el('div', { class: 'section-title' }, ['Capture and token evidence']),
          ...doctorSummary(content.report).map((row) => el('div', { class: 'row-item' }, [
            el('div', { class: 'row-main' }, [
              el('div', { class: 'row-title' }, [row.label]),
              el('div', { class: 'mono' }, [row.value]),
              el('div', { class: 'label-note' }, [row.note]),
            ]),
          ])),
          el('div', { class: 'label-note' }, ['These diagnostics do not establish complete capture, vendor billing or an independent token audit.']),
          el('div', { class: 'section-title', id: 'doctor-warnings-title', tabindex: '-1' }, ['Reported warnings']),
          ...(content.report.warnings.length
            ? content.report.warnings.map((warning) => el('div', { class: 'row-item' }, [warning]))
            : [el('div', { class: 'empty-state' }, ['No warnings were reported. Capture completeness is not established.'])]),
        ];
      const fixtureBanner = document.getElementById('fixture-example-banner') as HTMLElement | null;
      const fixtureNoticeText = state.fixtureExample ? fixtureBanner?.textContent.trim() ?? '' : '';
      const identityBadge = content.kind === 'report' ? doctorBuildIdentityBadge(content.report) : null;
      overlay.replaceChildren(
        el('div', { class: 'doctor-header' }, [
          el('div', { class: 'doctor-header-row' }, [
            el('h2', { id: 'doctor-title' }, ['Doctor']),
            ...(identityBadge ? [el('span', { class: 'doctor-build-identity', 'data-state': identityBadge.state, role: 'status', title: identityBadge.note, 'aria-label': identityBadge.note }, [identityBadge.text])] : []),
            el('button', { type: 'button', class: 'doctor-close' }, ['Close']),
          ]),
          ...(fixtureNoticeText ? [el('div', { class: 'label-note doctor-fixture-notice', role: 'note' }, [fixtureNoticeText])] : []),
        ]),
        el('div', { class: 'row-list' }, body)
      );
      overlay.querySelector('.doctor-close')?.addEventListener('click', closeDoctor);
      overlay.querySelector('.doctor-view-warnings')?.addEventListener('click', () => {
        const target = overlay.querySelector<HTMLElement>('#doctor-warnings-title');
        const header = overlay.querySelector<HTMLElement>('.doctor-header');
        if (target) {
          const panelTop = overlay.getBoundingClientRect().top;
          const targetContentTop = target.getBoundingClientRect().top - panelTop + overlay.scrollTop;
          const stickyHeaderHeight = header?.getBoundingClientRect().height ?? 0;
          overlay.scrollTop = Math.max(0, targetContentTop - stickyHeaderHeight);
        }
        target?.focus({ preventScroll: true });
      });
    },
    setOpen: (open: boolean) => {
      const overlay = document.getElementById('doctor-panel') as HTMLElement;
      const trigger = document.getElementById('doctor-btn') as HTMLButtonElement;
      trigger.setAttribute('aria-expanded', String(open));
      if (open) {
        overlay.classList.remove('hidden');
        overlay.querySelector<HTMLElement>('.doctor-close')?.focus();
      } else {
        overlay.classList.add('hidden');
        trigger.focus();
      }
    },
    setBadge: (hasWarnings: boolean) => {
      (document.getElementById('doctor-btn') as HTMLElement).classList.toggle('has-warnings', hasWarnings);
    },
    // The trigger stays enabled while pending: activating it again, Escape, or Refresh cancels the opening.
    setPending: (pending: boolean) => {
      const trigger = document.getElementById('doctor-btn') as HTMLButtonElement;
      trigger.textContent = pending ? 'Checking…' : 'Doctor';
      trigger.setAttribute('aria-busy', String(pending));
      if (pending) {
        trigger.setAttribute('aria-label', 'Doctor: checking diagnostics. Activate again to cancel.');
        trigger.setAttribute('title', 'Checking diagnostics. Activate again or press Escape to cancel.');
      } else {
        trigger.removeAttribute('aria-label');
        trigger.removeAttribute('title');
      }
    },
  },
  loadDoctor
);

async function toggleDoctor(): Promise<void> {
  await doctor.toggle();
}

/** Every dismissal (Close, Escape, the trigger) goes here, so it also cancels a pending opening. */
function closeDoctor(): void {
  doctor.close();
}

function wireDoctorKeyboard(): void {
  // Escape is listened for on the document, because the trigger keeps focus while an opening is pending. It cancels that
  // opening, and it closes an open overlay when focus is inside the overlay (as before).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('doctor-panel') as HTMLElement;
    if (!doctor.isPending() && !(doctor.isOpen() && overlay.contains(document.activeElement))) return;
    e.preventDefault();
    closeDoctor();
  });
  document.getElementById('doctor-panel')?.addEventListener('keydown', (e) => {
    const overlay = e.currentTarget as HTMLElement;
    if (e.key !== 'Tab') return;
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
      'button:not([disabled]), details > summary:not([tabindex="-1"]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !focusable.includes(active as HTMLElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !focusable.includes(active as HTMLElement))) {
      e.preventDefault();
      first.focus();
    }
  });
}

async function refreshDoctorBadge(origin: ReadOrigin): Promise<void> {
  await doctor.refreshBadge(origin);
}

// ── Tab / range switching ─────────────────────────────────────────────────────────────────────

const renderers: Record<TabName, (view: TabView) => Promise<void>> = {
  now: renderNow,
  sessions: renderSessions,
  usage: renderUsage,
  local: renderLocal,
  limits: renderLimits,
  coverage: renderCoverage,
  fleet: renderFleet,
};

const FIXED_SCOPE_LABEL: Partial<Record<TabName, string>> = {
  now: 'Today · observations',
  limits: 'Latest',
  coverage: 'This host',
};

function setActiveButton(container: Element, selector: string, matchAttr: string, value: string): void {
  for (const btn of Array.from(container.querySelectorAll<HTMLElement>(selector))) {
    const active = btn.getAttribute(matchAttr) === value;
    btn.classList.toggle('is-active', active);
    if (btn.getAttribute('role') === 'tab') {
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
    } else {
      btn.setAttribute('aria-pressed', String(active));
    }
    // Keep the active tab visible when opening directly onto it (boot()'s ?tab= /
    // --snapshot --tab), including when the window is narrower than the tab grid.
    if (active) btn.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }
}

async function selectTab(tab: TabName): Promise<void> {
  state.tab = tab;
  setActiveButton(document.getElementById('tabs') as HTMLElement, '.tab', 'data-tab', tab);
  document.getElementById('panel')?.setAttribute('aria-labelledby', `tab-${tab}`);
  const rangeSwitch = document.getElementById('range-switch') as HTMLElement;
  const scopeIndicator = document.getElementById('scope-indicator') as HTMLElement;
  const rangeScoped = isRangeScopedTab(tab);
  rangeSwitch.hidden = !rangeScoped;
  scopeIndicator.hidden = rangeScoped;
  scopeIndicator.textContent = FIXED_SCOPE_LABEL[tab] ?? '';
  if (state.nowTicker !== null) {
    clearInterval(state.nowTicker);
    state.nowTicker = null;
  }
  if (tab === 'now') state.nowTicker = window.setInterval(tickNowTimers, 1000);
  await renderCurrentTab();
}

async function selectRange(range: Range): Promise<void> {
  state.range = range;
  setActiveButton(document.getElementById('range-switch') as HTMLElement, '.range-btn', 'data-range', range);
  await renderCurrentTab();
}

async function renderCurrentTab(): Promise<void> {
  if (activeUsageRead) {
    const retired = activeUsageRead; activeUsageRead = null; usageCache.clear();
    void window.tokenelo.cancelUsage?.(retired.id).catch(() => {});
  }
  if (activeSummaryRead) {
    const retired = activeSummaryRead; activeSummaryRead = null; summaryCache.clear();
    void window.tokenelo.cancelSummary?.(retired.id).catch(() => {});
  }
  state.processRefresh?.dispose();
  state.processRefresh = null;
  const view = gate.begin({ tab: state.tab, range: state.range });
  window.__tokeneloFailure = null;
  try {
    await renderers[view.key.tab](view);
    gate.finish(view);
  } catch (err) {
    gate.fail(view, (stage) => {
      // A timed-out read shows the timeout copy; the failed load left its cache key empty (request-cache.ts). Try again is a user action, never automatic.
      const message = failureMessage(err);
      const retry = el('button', { type: 'button', class: 'refresh-btn' }, ['Try again']);
      retry.addEventListener('click', () => contain(refreshCurrentView(), showFatal));
      stage.replaceChildren(el('div', { class: 'card' }, [
        el('div', { class: 'section-title' }, [isSummaryCancelled(err) ? 'Historical report cancelled' : `Could not load ${view.key.tab} data`]),
        el('div', { class: 'label-note' }, [message]),
        ...(view.key.range === 'all' && !isSummaryCancelled(err) ? [el('div', { class: 'label-note' }, ['Choose a shorter period to read less history.'])] : []),
        retry,
      ]));
      // Only the current view's failure callback runs; superseded reads cannot refuse a newer snapshot.
      signalSnapshotFailure();
    });
  }
}

async function refreshCurrentView(): Promise<void> {
  const button = document.getElementById('refresh-btn') as HTMLButtonElement | null;
  if (button) button.disabled = true;
  invalidateCaches();
  state.processes = null;
  // Retired at the click, not after the tab body loads: a pending opening is cancelled and older diagnostic results are discarded.
  doctor.retire();
  try {
    // A failed diagnostic read keeps the last good badge, and a tab refresh is still useful without it.
    await Promise.all([renderCurrentTab(), refreshDoctorBadge('click').catch(() => undefined)]);
  } finally {
    if (button) button.disabled = false;
  }
}

function wireControls(): void {
  const tabs = document.getElementById('tabs');
  tabs?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (target) contain(selectTab(target.dataset.tab as TabName), showFatal);
  });
  tabs?.addEventListener('keydown', (e) => {
    const current = (e.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (!current) return;
    const buttons = Array.from(tabs.querySelectorAll<HTMLElement>('[role="tab"]'));
    const index = buttons.indexOf(current);
    if (index < 0) return;
    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (index + 1) % buttons.length;
    else if (e.key === 'ArrowLeft') nextIndex = (index - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = buttons.length - 1;
    if (nextIndex === null) return;
    e.preventDefault();
    const next = buttons[nextIndex];
    next.focus();
    contain(selectTab(next.dataset.tab as TabName), showFatal);
  });
  document.getElementById('range-switch')?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-range]');
    if (target) contain(selectRange(target.dataset.range as Range), showFatal);
  });
  document.getElementById('refresh-btn')?.addEventListener('click', () => contain(refreshCurrentView(), showFatal));
  document.getElementById('doctor-btn')?.addEventListener('click', () => contain(toggleDoctor(), showFatal));
  wireDoctorKeyboard();
}

// ── Theme ──────────────────────────────────────────────────────────────────────────────────────

function applyTheme(theme: 'light' | 'dark'): void {
  // styles.css keys its dark-mode variable overrides off `:root[data-theme='dark']` (:root ==
  // <html>), not off #app — verified by a --snapshot render: setting the attribute on #app
  // produced byte-identical light/dark PNGs because the CSS selector never matched.
  document.documentElement.setAttribute('data-theme', theme);
}

async function initTheme(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('theme');
  if (override === 'light' || override === 'dark') {
    applyTheme(override);
  } else {
    applyTheme(await window.tokenelo.getTheme());
  }
  window.tokenelo.onThemeChanged((theme) => {
    // A query-string override (snapshot mode) wins for the lifetime of this window.
    if (!override) applyTheme(theme);
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  wireControls();
  await initTheme();
  const fixtureMarker: SnapshotFixtureMarker = await window.tokenelo.getSnapshotFixtureMarker();
  state.fixtureExample = fixtureMarker === 'FILED-EXAMPLE';
  const fixtureBanner = document.getElementById('fixture-example-banner') as HTMLElement;
  const fixtureNotice = fixtureExampleNotice(fixtureMarker);
  fixtureBanner.hidden = fixtureNotice === null;
  fixtureBanner.textContent = fixtureNotice ?? '';
  const params = new URLSearchParams(window.location.search);
  const initialTab = (params.get('tab') as TabName) ?? 'now';
  const tab = TABS.includes(initialTab) ? initialTab : 'now';
  state.range = initialRange(params.get('range'));
  setActiveButton(document.getElementById('range-switch') as HTMLElement, '.range-btn', 'data-range', state.range);
  await selectTab(tab);
  // A failed badge read keeps the last badge (see doctor-view.ts); nothing else depends on it.
  contain(refreshDoctorBadge('background'), () => undefined);

  // The current view's commit signals readiness. The initial selection may already
  // have been retired while boot awaited it; boot completion is not view readiness.
}

contain(boot(), showFatal);
