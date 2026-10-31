import { priceFieldReview, priceFieldsUsable } from './price-evidence.js';
import { API_EQUIVALENT_BASIS_NOTE, priceEvidenceLabel } from './quality.js';
import { positionChartTooltip } from './chart-tooltip.js';
import { countBasisLabel, exactTokenLabel, tokenTotalText } from './token-counts.js';
import { tokenCountBreakdown } from './token-count-breakdown.js';
import { activityTimeLabel } from './activity-time.js';
/**
 * Session-detail window renderer (founder req. 2026-09-27 "session listing should open to more
 * data when clicked, in a larger window"; DESIGN §10). Loaded by detail.html under the SAME
 * strict CSP as the popover (index.html) — talks to the main process only through
 * `window.tokenelo` (preload.ts), never fetch/XHR directly.
 *
 * Renders: header (source glyph, project, model(s), recent/recorded activity, elapsed/active), summary stat
 * tiles, a stacked token/$ timeline chart (charts.ts, same palette/theme rules as the popover's
 * Usage tab), a per-model table with thinking mode, a clickable subagent
 * list (clicking one loads THAT subagent's own detail in this same window — no IPC round trip,
 * just another `getSessionDetail` call), and a flags summary.
 */
import type { EventFlag, Source, SessionDetail, TimeseriesPoint, TokeneloBridge } from './api-types.js';
import { chartLegend, describePoint, renderStackedBarChart, sessionTimelineMetric, tokenTimelineIssue, type ChartMetric } from './charts.js';
import {
  formatCompactNumber,
  formatDuration,
  formatMoney,
  formatPreciseMoney,
  formatPercent,
  sessionDisplayName,
  statusTone,
} from './format.js';
import { failureMessage } from './request-failure.js';
import { createDetailLoader, DETAIL_IDENTITY_MISMATCH, type DetailTicket } from './detail-load.js';
import type { SnapshotFailure } from './snapshot-outcome.js';
import { createReadyGate } from './detail-ready.js';
import { burnLine } from './detail-burn.js';
import { createDetailNavigator } from './detail-history.js';
import { failureContext, pendingContext, sourceLabel, type DetailContext } from './detail-context.js';

type SessionDetailLike = SessionDetail;

// The FULL bridge type (api-types.ts#TokeneloBridge) is shared with app.ts's own `declare
// global` for the exact same reason `isMainFrame`'s edge case is pinned in ipc-guard.test.ts:
// TypeScript merges every `declare global` augmentation of the SAME ambient interface across a
// whole compilation unit (tsconfig.tray.json includes every file under this directory), so two
// files augmenting `Window.tokenelo` with two DIFFERENT, incompatible types is a compile error —
// verified empirically (a local, narrower `TokeneloDetailBridge` here conflicted with app.ts's
// own local `TokeneloBridge` the moment both files were typechecked together). Importing one
// shared, superset type into both files instead of each declaring its own subset is the fix.
declare global {
  interface Window {
    tokenelo: TokeneloBridge;
    __tokeneloReady?: boolean;
    __tokeneloFailure?: SnapshotFailure | null;
  }
}

// ── small DOM helper (identical rule to app.ts's `el()` — style goes through .style.cssText, a
// CSP `style-src 'self'` silently drops `setAttribute('style', …)`; see that file's comment). ──

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

function thinkingModeLabel(mode: 'thinking' | 'non-thinking' | 'unknown'): string {
  return mode === 'thinking' ? 'thinking' : mode === 'non-thinking' ? 'non-thinking' : 'mode unknown';
}

/** Legacy live means activity within five minutes; it does not prove a running process or a session end. */
function hasRecentActivity(live: boolean, end: number, now = Date.now()): boolean {
  return live && now - end < 5 * 60_000;
}

const FLAG_LABELS: Partial<Record<EventFlag, string>> = {
  sessionAttributionConflict: 'Conflicting session claims',
  sessionContextUnrecorded: 'Session context unavailable',
  sessionAttributionEnriched: 'Session assigned from recorded evidence',
  countSnapshotsIncomparable: 'Conflicting whole-count snapshots',
  countSnapshotsCapped: 'Count snapshot retention bound exceeded',
  cacheTtlConflict: 'Reported cache TTL counters exceed the flat total',
  cacheTtlInvalid: 'Invalid cache TTL evidence',
  cacheTtlUnassigned: 'Cache writes with unknown TTL',
  countBasisIncomplete: 'Complete count basis unavailable',
  countBasisInvalid: 'Invalid count basis',
  countPolicyUnsupported: 'Unsupported count evidence version',
  priceTierUnsupported: 'Processing-tier price unavailable',
  priceContextInvalid: 'Request context size invalid',
  servingRouteUnpriced: 'Local zero rate unavailable for this serving route',
  servingRouteInvalid: 'Recorded serving-route evidence invalid',
  servingRouteConflict: 'Conflicting reported serving routes',
  servingRouteMisaligned: 'Reported route cannot be attributed across mismatched components; economic value unavailable',
  legacyCountEvidenceMixed: 'Raw count evidence mixed with an older writer',
  cacheSplitAssumed: 'cache split assumed (1h)',
  speedAssumed: 'Standard speed assumed for priced usage',
  importedContext: 'imported context',
  inheritedBaselineSuspect: 'inherited baseline (suspect)',
  counterReset: 'counter reset',
  recordReconciled: 'reconciled from records',
  serverlogEstimate: 'server-log estimate',
  localViaClaudeJsonl: 'local model via Claude JSONL',
  reasoningClamped: 'reasoning clamped',
  unpricedModel: 'unpriced model',
  longContextBracket: 'long-context bracket',
  thinkingUnknown: 'thinking mode unknown',
  mergedComponentsMisaligned: 'Conflicting model or speed components',
};

function headerEl(): HTMLElement {
  return document.getElementById('detail-header') as HTMLElement;
}
function panelEl(): HTMLElement {
  return document.getElementById('detail-panel') as HTMLElement;
}
function navEl(): HTMLElement {
  return document.getElementById('detail-nav') as HTMLElement;
}

/** Pending/failed header: source only, from detail-context.ts — nothing from a previous session. */
function renderContextHeader(ctx: DetailContext): void {
  document.title = ctx.documentTitle;
  headerEl().replaceChildren(
    el('div', { class: 'detail-title-block' }, [
      el('div', { class: 'detail-title' }, [ctx.title]),
      el('div', { class: 'detail-subtitle' }, [ctx.subtitle]),
    ])
  );
}

function statTile(label: string, value: string, sub?: string): HTMLElement {
  return el('div', { class: 'stat-tile' }, [
    el('div', { class: 'stat-tile-label' }, [label]),
    el('div', { class: 'stat-tile-value' }, [value]),
    ...(sub ? [el('div', { class: 'stat-tile-sub' }, [sub])] : []),
  ]);
}

function renderHeader(d: SessionDetailLike): void {
  const elapsed = Math.max(0, d.end - d.start);
  const live = hasRecentActivity(d.live, d.end);
  const title = sessionDisplayName(d);
  const models = d.models.length ? d.models.join(', ') : '(no model recorded)';
  headerEl().replaceChildren(
    el('span', { class: `source-dot ${d.source}` }),
    el('div', { class: 'detail-title-block' }, [
      el('div', { class: 'detail-title', title: `Session ${d.sessionId}` }, [title]),
      el('div', { class: 'detail-subtitle' }, [`${sourceLabel(d.source)} · ${d.host} · ${models}`]),
    ]),
    el('div', { class: 'detail-header-metrics' }, [
      el('span', { class: `badge ${live ? 'tone-good' : 'tone-neutral'} badge-sm`,
        title: live ? 'Recorded activity within the last 5 minutes; this does not confirm a running process.' : 'Recorded session history; running process state is not inferred.' }, [live ? 'RECENT' : 'RECORDED']),
      el('span', { class: 'num' }, [`elapsed ${formatDuration(elapsed)}`]),
      el('span', { class: 'num', title: activityTimeLabel(d).title }, [activityTimeLabel(d).text]),
    ])
  );
}

function renderStatTiles(d: SessionDetailLike): HTMLElement {
  const tokens = tokenTotalText(d.tokens);
  const cacheShareText = d.cacheReadShare === null ? '—' : formatPercent(d.cacheReadShare);
  const thinkingShareText = d.thinkingShare === null ? '—' : formatPercent(d.thinkingShare);
  const thinkingEvidence = [
    d.thinkingShare === null ? null : 'share of events with a known mode',
    d.thinkingUnknownEvents > 0 ? `${d.thinkingUnknownEvents} events unknown` : null,
  ].filter(Boolean).join(' · ') || undefined;
  const grid = el('div', { class: 'stat-tiles' }, [
    statTile('Tokens', tokens, countBasisLabel(d.tokens, d.events)),
    statTile('API-equiv $', !priceFieldsUsable(d) || d.apiEquivUsd === null ? '—' : formatPreciseMoney(d.apiEquivUsd), priceEvidenceLabel(d) ?? undefined),
    statTile('Events', formatCompactNumber(d.events)),
    statTile('Subagents', formatCompactNumber(d.subagents)),
    statTile('Wall time', formatDuration(d.wallMs), activityTimeLabel(d).text),
    statTile('Cache reuse', cacheShareText, 'share of gross prompt tokens'),
    statTile(
      'Thinking mode',
      thinkingShareText,
      thinkingEvidence
    ),
  ]);
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Recorded session history']),
    el('div', { class: 'label-note detail-scope-note' }, ['Totals cover the records captured for this session. The Sessions list follows its selected date range.']),
    el('div', { class: 'label-note api-equiv-basis-note' }, [API_EQUIVALENT_BASIS_NOTE]),
    grid,
    tokenCountBreakdown(d.tokens, d.events),
  ]);
}

function wireChartTooltip(host: HTMLElement, points: TimeseriesPoint[], sources: Source[], bucket: 'minute' | 'hour' | 'day', metric: ChartMetric): void {
  let tooltip: HTMLElement | null = null;

  function showFor(g: Element): void {
    const t = Number(g.getAttribute('data-bucket-t'));
    const point = points.find((p) => p.t === t);
    if (!point) return;
    const desc = describePoint(point, sources, bucket, metric);
    if (!tooltip) {
      tooltip = el('div', { class: 'chart-tooltip', role: 'status' });
      host.append(tooltip);
    }
    tooltip.replaceChildren(
      el('div', { class: 'chart-tooltip-time' }, [desc.timeLabel]),
      el('div', { class: 'chart-tooltip-total' }, [desc.totalText]),
      ...desc.bySource.map((s) => el('div', { class: 'chart-tooltip-row' }, [`${s.label}: ${s.valueText}`])),
      ...(metric === 'apiEquivUsd' && priceEvidenceLabel(point) ? [el('div', { class: 'chart-tooltip-row' }, [priceEvidenceLabel(point)!])] : [])
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

/** Fallback SVG viewBox width used for the very first paint, before the ResizeObserver below
 * reports the chart-host's real rendered width — close to this window's typical content width
 * (`.detail-content`'s 900px max-width minus its card padding) so the chart never visibly flashes
 * from narrow to wide. The observer corrects it to the exact box on the next frame regardless. */
const FALLBACK_CHART_WIDTH = 820;

/**
 * Founder req. 2026-09-27 item 7: the chart used to render at charts.ts's fixed default
 * `viewBox` width (340), letterboxed inside this window's much wider `.chart-wrap svg { width:
 * 100%; height: 132px }` box (see that CSS rule) — `preserveAspectRatio`'s default (`xMidYMid
 * meet`) fits a 340×200 viewBox inside a ~800×200 box by shrinking it to fit, leaving empty space
 * on both sides (exactly the "renders narrow" bug in test-output/tray/detail-dark.png). Fix: draw
 * the SVG's viewBox at the chart-host's OWN actual pixel width (so the box and the viewBox share
 * the same aspect ratio — no letterboxing, no non-uniform stretch/distortion either) and keep it
 * in sync via ResizeObserver as the (resizable, min-width 480) detail window is resized.
 */
function renderChart(d: SessionDetailLike): HTMLElement {
  // This series is filtered to the session's source. Local-only sessions have zero API dollars;
  // show their recorded tokens, preserving real activity without inventing per-source shares.
  const sources = [d.source];
  const localOnly = d.telemetry?.length
    ? d.telemetry.every((feed) => feed.provider === 'local')
    : d.byModel.length > 0 && d.byModel.every((row) => row.provider === 'local');
  const hasTotalTokens = d.timeseries.points.every((point) => point.totalTokens !== undefined);
  const priceAvailable = typeof d.apiEquivUsd === 'number' && Number.isFinite(d.apiEquivUsd) && d.apiEquivUsd >= 0 && priceFieldsUsable(d)
    && d.timeseries.points.every(point => priceFieldsUsable(point));
  const unpriced = d.unpricedEvents;
  const metric: ChartMetric = sessionTimelineMetric(localOnly, hasTotalTokens, priceAvailable, unpriced === undefined ? null : unpriced);
  const usingTokens = metric !== 'apiEquivUsd';
  const bucket: 'minute' | 'hour' | 'day' =
    d.timeseries.bucketMs >= 86_400_000 ? 'day' : d.timeseries.bucketMs >= 3_600_000 ? 'hour' : 'minute';
  const chartTitle = usingTokens ? hasTotalTokens ? 'Tokens over time' : 'Fresh/write/output tokens over time' : 'API-equivalent activity over time';
  const chartCard = el('div', { class: 'card chart-wrap' }, [el('div', { class: 'section-title' }, [`${chartTitle} · UTC`])]);
  if (!localOnly && usingTokens) {
    chartCard.append(el('div', { class: 'label-note' }, [typeof unpriced === 'number' && unpriced > 0
      ? 'Some events have no supported dollar price. The dollar subtotal is incomplete; recorded token activity is shown.'
      : priceAvailable
        ? 'Dollar price coverage is unavailable. Recorded token activity is shown.'
        : priceFieldsUsable(d) && d.timeseries.points.every(point => priceFieldsUsable(point))
          ? 'Dollar timeline unavailable: no usable priced session total. Recorded token activity is shown.'
          : 'Dollar timeline unavailable: recorded price fields need review. Recorded token activity is shown.']));
  }
  if (!usingTokens) {
    const priceBasis = priceEvidenceLabel(d);
    if (priceBasis) chartCard.append(el('div', { class: 'label-note' }, [priceBasis]));
  }
  if (usingTokens && !hasTotalTokens) chartCard.append(el('div', { class: 'label-note' }, ['This daemon version excludes cache reads from the token timeline.']));
  if (usingTokens) {
    const unavailable = d.timeseries.points.filter(point => tokenTimelineIssue(point, metric)).length;
    if (unavailable) chartCard.append(el('div', { class: 'label-note' }, [
      `${unavailable} ${unavailable === 1 ? 'bucket has an unavailable token total' : 'buckets have unavailable token totals'}. Gaps do not mean zero activity.`,
    ]));
  }
  const chartHost = el('div', { class: 'chart-host' });
  if (d.timeseries.points.length === 0) {
    chartCard.append(el('div', { class: 'detail-empty' }, [d.events === 0
      ? 'No usage events recorded for this timeline.'
      : 'No usage timeline points were provided.']));
    return chartCard;
  }
  const draw = (width: number): void => {
    chartHost.innerHTML = renderStackedBarChart(d.timeseries.points, { bucket, sources, metric, height: 200, width });
  };
  draw(FALLBACK_CHART_WIDTH);
  chartCard.append(chartHost);
  // Wired ONCE, on the stable `chartHost` element — its listeners survive every later
  // `innerHTML` replacement from `draw()` above (they delegate via `closest('[data-bucket-t]')`
  // on events bubbled up to `chartHost` itself, never bound to the SVG's own children directly).
  wireChartTooltip(chartHost, d.timeseries.points, sources, bucket, metric);
  const legend = el('div', { class: 'legend' });
  for (const entry of chartLegend(d.timeseries.points, sources, metric)) {
    legend.append(
      el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch', style: `background:${entry.colorVar}` }), entry.label])
    );
  }
  chartCard.append(legend);

  if (typeof ResizeObserver !== 'undefined') {
    let lastWidth = FALLBACK_CHART_WIDTH;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0 && Math.abs(w - lastWidth) > 2) {
        lastWidth = w;
        draw(w);
      }
    });
    ro.observe(chartHost);
  }
  return chartCard;
}

function renderModelTable(d: SessionDetailLike): HTMLElement {
  const modelModeCounts = new Map<string, number>();
  const modelModeKey = (row: SessionDetail['byModel'][number]) => JSON.stringify([row.model, row.thinking]);
  for (const row of d.byModel) {
    const key = modelModeKey(row);
    modelModeCounts.set(key, (modelModeCounts.get(key) ?? 0) + 1);
  }
  const rows = d.byModel.map((row) => {
    const tokens = tokenTotalText(row.tokens);
    const nameText = `${row.displayName} · ${thinkingModeLabel(row.thinking)}`;
    const providerName = ({ openai: 'OpenAI', anthropic: 'Anthropic', local: 'Local', unknown: 'Provider not identified' } as Record<string, string>)[row.provider] ?? row.provider;
    const providerContext = modelModeCounts.get(modelModeKey(row))! > 1 ? `${sourceLabel(row.source)} · ${providerName}` : null;
    return el('tr', {}, [
      el('td', { class: 'model-name', title: `${nameText} · ${row.model} · ${sourceLabel(row.source)} · ${providerName}` }, [
        nameText,
        ...(providerContext ? [el('div', { class: 'label-note model-provider-context' }, [providerContext])] : []),
      ]),
      el('td', { class: 'num', title: countBasisLabel(row.tokens) }, [tokens]),
      el('td', { class: 'num' }, [!priceFieldsUsable(row) || row.apiEquivUsd === null ? '—' : formatPreciseMoney(row.apiEquivUsd), ...(row.priceStatus !== 'LIST' ? [badge(row.priceStatus ?? 'Price evidence conflicts')] : [])]),
    ]);
  });
  const table = el('table', { class: 'data-table model-table' }, [
    el('colgroup', {}, [
      el('col', { class: 'col-model' }),
      el('col', { class: 'col-num' }),
      el('col', { class: 'col-num' }),
    ]),
    el('thead', {}, [
      el('tr', {}, [el('th', {}, ['Model']), el('th', { class: 'num' }, ['Tokens']), el('th', { class: 'num' }, ['API-equiv $'])]),
    ]),
    el('tbody', {}, rows),
  ]);
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Per model']),
    d.byModel.length ? table : el('div', { class: 'detail-empty' }, ['No usage recorded.']),
  ]);
}

function renderSubagents(d: SessionDetailLike): HTMLElement {
  const rows = d.subagentSessions.map((sub) => {
    const elapsed = Math.max(0, sub.end - sub.start);
    const live = hasRecentActivity(sub.live, sub.end);
    const started = new Date(sub.start);
    const startedIso = Number.isFinite(started.getTime()) ? started.toISOString() : null;
    return el(
      'div',
      { class: 'row-item subagent-row', tabindex: '0', role: 'button', 'data-session-id': sub.sessionId },
      [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title', title: sub.models.join(', ') || 'Model unrecorded' }, [sub.models.join(', ') || '(unknown model)']),
          el('div', { class: 'subagent-token-summary num', title: exactTokenLabel(sub.tokens) }, [`${tokenTotalText(sub.tokens)} tokens`]),
          el('div', { class: 'label-note subagent-count-basis' }, [countBasisLabel(sub.tokens)]),
          el('time', {
            class: 'label-note subagent-start',
            ...(startedIso ? { datetime: startedIso } : {}),
            title: `${startedIso ? `Recorded start ${startedIso}` : 'Recorded start unavailable'} · Session ${sub.sessionId}`,
          }, [startedIso ? `Recorded start ${started.toLocaleString()}` : 'Recorded start unavailable']),
          el('div', { class: 'row-sub' }, [`${formatDuration(elapsed)} · ${live ? 'recent activity' : 'recorded activity'}`]),
          ...(Number.isSafeInteger(sub.subagents) && sub.subagents! > 0
            ? [el('div', { class: 'label-note' }, [`Includes ${sub.subagents} nested ${sub.subagents === 1 ? 'subagent' : 'subagents'}`])]
            : []),
        ]),
        el('div', { class: 'row-metrics' }, [
          el('span', { class: 'num' }, [!priceFieldsUsable(sub) || sub.apiEquivUsd === null ? '—' : formatMoney(sub.apiEquivUsd)]),
          ...(priceEvidenceLabel(sub) ? [el('span', { class: 'label-note price-quality' }, [priceEvidenceLabel(sub)!])] : []),
        ]),
      ]
    );
  });
  const list = el('div', { class: 'row-list subagent-list' }, rows);
  list.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-session-id]');
    if (target) void detailNav.child(d.source, target.dataset.sessionId as string);
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-session-id]');
    if (target) {
      e.preventDefault();
      void detailNav.child(d.source, target.dataset.sessionId as string);
    }
  });
  return el('div', { class: 'card subagent-card' }, [
    el('div', { class: 'section-title' }, ['Subagents']),
    ...(d.subagentSessions.length ? [el('div', { class: 'label-note subagent-inclusion' }, [
      'These branches are included in this session’s totals, including nested subagents. Open a branch to inspect its recorded usage.',
    ])] : []),
    d.subagentSessions.length ? list : el('div', { class: 'detail-empty' }, ['No subagents.']),
  ]);
}

function renderFlags(d: SessionDetailLike): HTMLElement {
  const entries = Object.entries(d.flags) as [EventFlag, number][];
  const rows = entries.map(([flag, count]) =>
    el('div', { class: 'flag-row' }, [el('span', { class: 'flag-name' }, [FLAG_LABELS[flag] ?? flag]), el('span', { class: 'num' }, [String(count)])])
  );
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Flags']),
    ...((d.flags.servingRouteUnpriced ?? 0) > 0 ? [el('p', { class: 'detail-hint' }, [
      'The model matches a local weights entry, but local serving is not established. Reported Qwen OAuth, an OpenAI-compatible method that may serve locally or remotely, or missing authentication evidence cannot establish that entry’s zero-dollar rate. Authentication is client-reported. Token counts remain recorded; no vendor charge or invoice is inferred.',
    ])] : []),
    ...((d.flags.sessionAttributionConflict ?? 0) > 0 ? [el('p', { class: 'detail-hint' }, [
      'Duplicate usage claimed another session. Usage has one retained recorded owner; original ownership is unverified. Counts retain the largest reported values, subject to count-evidence qualifications.',
    ])] : []),
    ...((d.flags.mergedComponentsMisaligned ?? 0) > 0 ? [el('p', { class: 'detail-hint' }, [
      'Reported snapshots disagree about model or processing speed. Dollar comparisons may use one snapshot’s components rather than the largest token fields. Treat these values as qualified comparisons, not reconciled charges.',
    ])] : []),
    ...((d.flags.sessionContextUnrecorded ?? 0) > 0 ? [el('p', { class: 'detail-hint' }, [
      'Activity evidence supplied this assignment. Available recorded context is retained, but activity alone does not establish parent, repository, branch, entrypoint or main/subagent role. Economic context may come from a snapshot that claimed another session; check recorded fields and later owner evidence.',
    ])] : []),
    ...((d.flags.sessionAttributionEnriched ?? 0) > 0 ? [el('p', { class: 'detail-hint' }, [
      'A usage record lacked a session ID. Recorded session or activity evidence supplied this assignment; original ownership and complete context remain unverified.',
    ])] : []),
    rows.length ? el('div', {}, rows) : el('div', { class: 'detail-empty' }, ['No flags recorded.']),
  ]);
}

function renderMetaCard(d: SessionDetailLike): HTMLElement | string {
  const parts: (Node | string)[] = [
    el('div', { class: 'row-sub session-identity' }, [`Session ID ${d.sessionId}`]),
    el('div', { class: 'row-sub session-span' }, [`Recorded span ${new Date(d.start).toLocaleString()} through ${new Date(d.end).toLocaleString()}`]),
  ];
  if (d.project) parts.push(el('div', { class: 'row-sub session-workspace' }, [`Recorded workspace ${d.project}`]));
  if (d.gitBranch) parts.push(el('div', { class: 'row-sub' }, [`Branch: ${d.gitBranch}`]));
  if (d.entrypoint) parts.push(el('div', { class: 'row-sub' }, [`Entrypoint: ${d.entrypoint}`]));
  if (d.firstEventTs !== null && d.lastEventTs !== null) {
    parts.push(
      el('div', { class: 'row-sub' }, [
        `First event ${new Date(d.firstEventTs).toLocaleString()} · Last event ${new Date(d.lastEventTs).toLocaleString()}`,
      ])
    );
  }
  const burn = burnLine(d.burn);
  if (burn) parts.push(el('div', { class: 'row-sub detail-burn' }, [burn]));
  if (parts.length === 0) return '';
  return el('div', { class: 'card' }, [el('div', { class: 'section-title' }, ['Details']), ...parts]);
}

function captureLabel(source: Source): string {
  switch (source) {
    case 'claude': return 'Claude Code JSONL';
    case 'codex': return 'Codex rollout usage';
    case 'qwen-code': return 'Qwen Code JSONL';
    case 'ollama-proxy': return 'Local metering proxy';
    case 'ollama-log': return 'Ollama server log';
    case 'bench': return 'Benchmark results';
  }
}

function renderTelemetry(d: SessionDetailLike): HTMLElement {
  const rows = (d.telemetry ?? []).map((feed) => {
    const flags = Object.entries(feed.flags).map(([flag, count]) => `${FLAG_LABELS[flag as EventFlag] ?? flag} (${count})`);
    const provider = feed.provider === 'local' ? 'Local provider' : feed.provider === 'unknown' ? 'Provider not identified' : feed.provider === 'anthropic' ? 'Anthropic' : feed.provider === 'openai' ? 'OpenAI' : feed.provider;
    const details: (Node | string)[] = [
      el('div', { class: 'row-title' }, [`${captureLabel(feed.source)} · ${feed.host}`]),
      el('div', { class: 'label-note' }, [
        provider,
        feed.engine !== undefined ? ` · engine ${feed.engine}` : feed.provider === 'local' ? ' · engine not recorded' : '',
      ]),
      el('div', { class: 'label-note' }, [`Models: ${feed.models.join(', ') || 'not recorded'}`]),
      el('div', { class: 'label-note' }, [
        `${formatCompactNumber(feed.events)} events · ${tokenTotalText(feed.tokens)} tokens · API-equiv ${!priceFieldsUsable(feed) || feed.apiEquivUsd === null ? '—' : formatMoney(feed.apiEquivUsd)} · ${countBasisLabel(feed.tokens, feed.events)}`,
      ]),
      ...(priceEvidenceLabel(feed) ? [el('div', { class: 'label-note price-quality' }, [priceEvidenceLabel(feed)!])] : []),
      el('div', { class: 'label-note' }, [`Usage ${new Date(feed.firstEventAt).toLocaleString()} through ${new Date(feed.lastEventAt).toLocaleString()}`]),
    ];
    if (flags.length) details.push(el('div', { class: 'label-note' }, [flags.join(' · ')]));
    return el('div', { class: 'row-item telemetry-feed' }, [el('div', { class: 'row-main' }, details)]);
  });
  return el('div', { class: 'card' }, [
    el('div', { class: 'section-title' }, ['Capture provenance']),
    el('div', { class: 'label-note' }, ['This breakdown uses recorded usage events. Event times describe activity; they do not show when the collector last scanned.']),
    rows.length ? el('div', { class: 'row-list' }, rows) : el('div', { class: 'detail-empty' }, [
      d.telemetry === undefined ? 'Capture details are unavailable from this daemon version.' : 'This session has activity timestamps but no recorded usage events.',
    ]),
  ]);
}

function renderDesktopContext(d: SessionDetailLike): HTMLElement | string {
  const meta = d.desktopMeta;
  if (!meta) return '';
  const parts: (Node | string)[] = [
    el('div', { class: 'section-title' }, ['Claude Desktop context']),
    el('div', { class: 'label-note' }, ['Linked to this Claude Code session. Desktop context adds no usage events to the totals.']),
  ];
  if (meta.title) parts.push(el('div', { class: 'row-title' }, [meta.title]));
  if (meta.model || meta.effort) parts.push(el('div', { class: 'label-note' }, [
    [meta.model ? `Model ${meta.model}` : '', meta.effort ? `Effort ${meta.effort}` : ''].filter(Boolean).join(' · '),
  ]));
  if (meta.isArchived !== undefined) parts.push(el('div', { class: 'label-note' }, [meta.isArchived ? 'Archived in Desktop' : 'Not archived in Desktop']));
  if (meta.cwd) parts.push(el('div', { class: 'label-note' }, [`Desktop workspace: ${meta.cwd}`]));
  if (meta.originCwd && meta.originCwd !== meta.cwd) parts.push(el('div', { class: 'label-note' }, [`Origin workspace: ${meta.originCwd}`]));
  if (meta.createdAt !== undefined) parts.push(el('div', { class: 'label-note' }, [`Created ${new Date(meta.createdAt).toLocaleString()}`]));
  if (meta.lastActivityAt !== undefined) parts.push(el('div', { class: 'label-note' }, [`Desktop activity ${new Date(meta.lastActivityAt).toLocaleString()}`]));
  if (meta.prNumber !== undefined) parts.push(el('div', { class: 'label-note' }, [`PR ${meta.prRepository ? `${meta.prRepository} ` : ''}#${meta.prNumber}${meta.prState ? ` · ${meta.prState}` : ''}`]));
  if (meta.prUrl) parts.push(el('div', { class: 'label-note' }, [`PR URL: ${meta.prUrl}`]));
  return el('div', { class: 'card desktop-context' }, parts);
}

function signalReady(): void {
  // Signal readiness for --snapshot's capture wait (main.ts), same protocol as the popover.
  window.__tokeneloReady = true;
  window.__tokeneloFailure = null;
  window.dispatchEvent(new Event('tokenelo:ready'));
}

function signalFailure(category: SnapshotFailure): void {
  window.__tokeneloReady = false;
  window.__tokeneloFailure = category;
  window.dispatchEvent(new Event('tokenelo:failed'));
}

const detailLoader = createDetailLoader((source, sessionId) => window.tokenelo.getSessionDetail(source, sessionId));
// Set by boot() before its first intent: ready waits for the applied initial theme (detail-ready.ts).
let readyGate: ((ticket: DetailTicket) => Promise<boolean>) | null = null;

// Every intent (boot, popover IPC, subagent, Back) goes through this one route: detail-history.ts
// records history, then detail-load.ts decides which response may paint or set ready.
const detailNav = createDetailNavigator(
  detailLoader,
  {
    pending: (key, canGoBack) => {
      window.__tokeneloReady = false;
      window.__tokeneloFailure = null;
      navEl().hidden = !canGoBack;
      renderContextHeader(pendingContext(key.source));
      panelEl().replaceChildren(el('div', { class: 'detail-empty' }, ['Loading…']));
    },
    success: paintDetail,
    failure: (err, ticket) => {
      renderContextHeader(failureContext(ticket.key.source));
      panelEl().replaceChildren(el('div', { class: 'detail-empty' }, [`Could not load session: ${failureMessage(err)}`]));
      signalFailure(err instanceof Error && err.message === DETAIL_IDENTITY_MISMATCH ? 'detail-identity' : 'detail-load');
    },
    ready: (ticket) => void readyGate?.(ticket),
  }
);

function paintDetail(d: SessionDetailLike): void {
  const panel = panelEl();
  document.title = `Tokenelo — ${sessionDisplayName(d)}`;
  renderHeader(d);
  const content = el('div', { class: 'detail-content' }, [
    renderStatTiles(d),
    priceFieldReview(d),
    renderChart(d),
    el('div', { class: `detail-columns${d.subagentSessions.length > 6 ? ' detail-columns--many-branches' : ''}` }, [renderModelTable(d), renderSubagents(d)]),
    renderMetaCard(d),
    renderTelemetry(d),
    renderDesktopContext(d),
    renderFlags(d),
  ]);
  panel.replaceChildren(content);
}

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
}

async function initTheme(override: string | null): Promise<void> {
  if (override === 'light' || override === 'dark') {
    applyTheme(override);
  } else {
    applyTheme(await window.tokenelo.getTheme());
  }
  window.tokenelo.onThemeChanged((theme) => {
    if (!override) applyTheme(theme);
  });
}

function wireKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') void window.tokenelo.closeSessionDetail();
  });
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const source = (params.get('source') as Source) ?? 'claude';
  const sessionId = params.get('sessionId') ?? '';

  wireKeyboard();
  navEl().querySelector('button')?.addEventListener('click', () => void detailNav.back());
  // initTheme applies an explicit override synchronously; only the OS-theme read is awaited.
  const themed = initTheme(params.get('theme'));
  readyGate = createReadyGate(themed, detailLoader.isCurrent, signalReady);
  // The boot intent starts before any await, and the popover listener is registered right after
  // it, so a popover load arriving during the theme read is neither dropped nor overwritten by boot.
  void detailNav.root(source, sessionId);
  window.tokenelo.onLoadSession((session) => void detailNav.root(session.source, session.sessionId));
  await themed;
}

void boot().catch(() => signalFailure('renderer-load'));
