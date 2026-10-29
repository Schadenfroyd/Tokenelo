/**
 * Limits (DESIGN §6/§15.7.2):
 *   - Claude 5-hour block ESTIMATE, per account (config.accounts host→account mapping). Blocks
 *     start at the first activity floored to the hour and last 5h; the next activity after a
 *     block's end starts a new block (purely activity-driven, never a wall-clock timer running
 *     independent of usage). "estimate" because Claude Code does not persist plan-window usage
 *     locally (DESIGN §6) — labelled `estimate: true` / `source: 'claude-block-estimate'`.
 *   - Newest Codex `rate_limits` snapshot per account (Codex collector's job to parse the raw
 *     snapshots off disk; this module's job is only to pick the newest one per account once
 *     several hosts/snapshots exist for the same account).
 *
 * Block-estimate windows carry the DESIGN §6 numbers directly in `LimitWindow` (types.ts v0.2.1,
 * §15.9.5): `tokens`/`apiEquivUsd` inside the current block, `burnTokensPerMin`, the linear
 * `projectedTokens`/`projectedUsd` to the block's end, and `startedAt`. `usedPercent` stays
 * `null` — no quota/denominator is known locally, so a percentage would be fabricated.
 *
 * Snapshots are keyed by (source, account, limitId) (§15.9.5): Codex emits several rate-limit
 * ids per account and one must never overwrite another.
 */
import type {
  AccountConfig,
  HostLabel,
  LimitContributor,
  LimitSnapshot,
  LimitWindow,
  PriceStatus,
  LimitContributorRouteEvidence,
  TsSource,
  TokenCounts,
  UsageEvent,
} from './types.js';
import { ZERO_TOKENS } from './types.js';
import { addTokenCounts, weakestCountQuality } from './token-counts.js';
import { addPriceEvidence, emptyPriceEvidence, qualifyAggregateAmount } from './price-evidence.js';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

// ── account resolution ──────────────────────────────────────────────────────

/** First nonblank configured account of `kind` whose `hosts` includes `host`; if only blank IDs
 * match, preserve the first blank mapping so callers can disclose it while grouping by host. */
export function resolveAccount(
  host: HostLabel,
  kind: 'claude' | 'codex',
  accounts: readonly AccountConfig[]
): AccountConfig | undefined {
  const matches = accounts.filter((a) => a.kind === kind && a.hosts.includes(host));
  return matches.find((a) => nonBlankAccountId(a.id) !== undefined) ?? matches[0];
}

/** Blank account ids are not identities. Preserve non-empty configured ids verbatim. */
function nonBlankAccountId(id: string | undefined): string | undefined {
  return id !== undefined && id.trim().length > 0 ? id : undefined;
}

/** A blank snapshot ID is missing attribution, so use the host's configured account when present. */
function snapshotAccount(
  snap: Pick<LimitSnapshot, 'source' | 'host' | 'account'>,
  accounts: readonly AccountConfig[]
): string | undefined {
  if (nonBlankAccountId(snap.account) !== undefined) return snap.account;
  const kind = snap.source === 'codex' ? 'codex' : 'claude';
  return resolveAccount(snap.host, kind, accounts)?.id ?? snap.account;
}

/** Internal identity for grouping. Account ids and host labels are separate namespaces. */
export function accountGroupKey(
  host: HostLabel,
  kind: 'claude' | 'codex',
  accounts: readonly AccountConfig[]
): string {
  const accountId = nonBlankAccountId(resolveAccount(host, kind, accounts)?.id);
  return accountId === undefined ? `host:${host}` : `account:${accountId}`;
}

/** Groups hosts by their resolved account id for `kind`; a host with no configured account is its
 * own singleton group keyed by the host label itself (honest fallback, not a guess: DESIGN never
 * wants a made-up account name, and a per-host group is exactly what "no account configured"
 * means operationally). */
function groupHostsByAccount(
  hosts: readonly HostLabel[],
  kind: 'claude' | 'codex',
  accounts: readonly AccountConfig[]
): Map<string, { account: AccountConfig | undefined; hosts: HostLabel[] }> {
  const groups = new Map<string, { account: AccountConfig | undefined; hosts: HostLabel[] }>();
  for (const host of hosts) {
    const account = resolveAccount(host, kind, accounts);
    const groupKey = accountGroupKey(host, kind, accounts);
    let g = groups.get(groupKey);
    if (!g) {
      g = { account, hosts: [] };
      groups.set(groupKey, g);
    }
    g.hosts.push(host);
  }
  return groups;
}

// ── Claude 5-hour block estimate ────────────────────────────────────────────

function floorToHour(ts: number): number {
  return Math.floor(ts / ONE_HOUR_MS) * ONE_HOUR_MS;
}

export interface BlockInterval {
  start: number;
  end: number;
}

/**
 * Splits a sorted-ascending list of activity timestamps into 5-hour blocks (DESIGN §6): the first
 * block starts at `floorToHour(ts[0])`; any later timestamp that falls at or before the current
 * block's end stays in it (the block's own end never moves); a timestamp AFTER the current
 * block's end starts a brand new block, floored to ITS hour. Returns one interval per block, in
 * order; the last one is the "current" block for reporting purposes (block boundaries are purely
 * activity-driven — an idle account simply never gets a new block until it is used again, so
 * "current" is not a wall-clock notion here).
 */
export function computeClaudeBlocks(sortedTs: readonly number[]): BlockInterval[] {
  const blocks: BlockInterval[] = [];
  let currentEnd = -Infinity;
  for (const ts of sortedTs) {
    if (blocks.length === 0 || ts > currentEnd) {
      const start = floorToHour(ts);
      const end = start + FIVE_HOURS_MS;
      blocks.push({ start, end });
      currentEnd = end;
    }
  }
  return blocks;
}

function totalTokensOf(e: UsageEvent): number {
  return (
    e.tokens.inputFresh + e.tokens.cacheWrite5m + e.tokens.cacheWrite1h + (e.tokens.cacheWriteUnassigned ?? 0) + e.tokens.cacheRead + e.tokens.output
  );
}

interface MutableLimitContributor {
  host: HostLabel;
  model: string;
  provider: UsageEvent['provider'];
  servingRoutes: LimitContributorRouteEvidence[];
  priceVersion: string;
  tsSource: TsSource;
  firstEventAt: number;
  lastEventAt: number;
  events: number;
  tokens: TokenCounts;
  knownApiEquivUsd: number;
  pricedAmountEvents: number;
  invalidAmount: boolean;
  priceStatusCounts: { LIST: number; ESTIMATE: number; UNPRICED: number; unknown: number };
  priceEvidence: ReturnType<typeof emptyPriceEvidence>;
}

function routeEvidenceKey(route: LimitContributorRouteEvidence): string {
  if (route.kind === 'unrecorded') return '0:unrecorded';
  return `${route.kind}:${route.evidence}`;
}

function contributorRouteEvidence(event: UsageEvent): LimitContributorRouteEvidence[] {
  const byKey = new Map<string, LimitContributorRouteEvidence>();
  for (const component of event.components) {
    const route: LimitContributorRouteEvidence = component.servingRoute ?? { kind: 'unrecorded' };
    byKey.set(routeEvidenceKey(route), route);
  }
  if (byKey.size === 0) byKey.set('0:unrecorded', { kind: 'unrecorded' });
  return [...byKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, route]) => route);
}

function contributorRows(rows: Iterable<MutableLimitContributor>): LimitContributor[] {
  return [...rows]
    .map((row) => {
      const rawKnownApiEquivUsd = row.invalidAmount || row.priceEvidence.issuesEvents > 0
        || row.priceEvidence.aggregateAmountInvalid || row.pricedAmountEvents === 0
        ? null : row.knownApiEquivUsd;
      qualifyAggregateAmount(row.priceEvidence, rawKnownApiEquivUsd);
      const knownApiEquivUsd = typeof rawKnownApiEquivUsd === 'number'
        && Number.isFinite(rawKnownApiEquivUsd) && rawKnownApiEquivUsd >= 0
        ? rawKnownApiEquivUsd
        : null;
      return {
        host: row.host,
        model: row.model,
        provider: row.provider,
        servingRoutes: row.servingRoutes,
        priceVersion: row.priceVersion,
        tsSource: row.tsSource,
        firstEventAt: row.firstEventAt,
        lastEventAt: row.lastEventAt,
        events: row.events,
        tokens: row.tokens,
        knownApiEquivUsd,
        priceStatusCounts: row.priceStatusCounts,
        priceEvidence: row.priceEvidence,
      };
    })
    .sort((a, b) =>
      a.host.localeCompare(b.host) ||
      a.model.localeCompare(b.model) ||
      a.provider.localeCompare(b.provider) ||
      JSON.stringify(a.servingRoutes).localeCompare(JSON.stringify(b.servingRoutes)) ||
      a.priceVersion.localeCompare(b.priceVersion) ||
      a.tsSource.localeCompare(b.tsSource)
    );
}

/**
 * One estimate snapshot per Claude account (or per host, when unconfigured) that has any Claude
 * activity. `activityByHost` holds every Claude activity timestamp for the relevant hosts
 * (fleet-merged per account, DESIGN §15.7.1); `eventsByHost` is used only to total tokens/$ inside
 * the current (last) block — pass at least every Claude event with ts ≥ (last activity − 5 h).
 *
 * Window numbers (hand-computable): tokens = Σ all token fields of events with ts in
 * [block.start, block.end]; elapsed = min(now, end) − start (≥ 1 ms); burnTokensPerMin =
 * tokens / (elapsed / 60 000); projected = tokens + tokens/elapsed × (end − min(now, end)) (equals
 * the actual total once the block is over). apiEquivUsd is null only when the block has events and
 * every one of them is unpriced; otherwise Σ of the priced ones.
 */
export function computeClaudeBlockEstimates(
  activityByHost: ReadonlyMap<HostLabel, readonly number[]>,
  eventsByHost: ReadonlyMap<HostLabel, readonly UsageEvent[]>,
  accounts: readonly AccountConfig[],
  now: number
): LimitSnapshot[] {
  const hosts = [...activityByHost.keys()];
  const accountGroups = groupHostsByAccount(hosts, 'claude', accounts);

  const results: LimitSnapshot[] = [];
  for (const g of accountGroups.values()) {
    const ts: number[] = [];
    for (const h of g.hosts) for (const t of activityByHost.get(h) ?? []) ts.push(t);
    if (ts.length === 0) continue;
    ts.sort((a, b) => a - b);

    const blocks = computeClaudeBlocks(ts);
    const current = blocks[blocks.length - 1]!;

    let tokens = 0;
    let countQuality: import('./types.js').TokenCounts['countQuality'];
    let usd = 0;
    let inBlock = 0;
    let priced = 0;
    const priceEvidence = emptyPriceEvidence();
    const contributors = new Map<string, MutableLimitContributor>();
    for (const h of g.hosts) {
      for (const e of eventsByHost.get(h) ?? []) {
        if (e.ts < current.start || e.ts > current.end) continue;
        inBlock++;
        addPriceEvidence(priceEvidence, e.apiEquivUsd, e.priceStatus);
        tokens += totalTokensOf(e);
        if (countQuality !== undefined || e.tokens.countQuality !== undefined)
          countQuality = countQuality === undefined && inBlock === 1 ? e.tokens.countQuality : weakestCountQuality(countQuality, e.tokens.countQuality);
        if (e.apiEquivUsd !== null) {
          priced++;
          usd += e.apiEquivUsd;
        }

        const servingRoutes = contributorRouteEvidence(e);
        const key = JSON.stringify([e.host, e.model, e.provider, servingRoutes.map(routeEvidenceKey), e.priceVersion, e.tsSource]);
        let row = contributors.get(key);
        if (!row) {
          row = {
            host: e.host,
            model: e.model,
            provider: e.provider,
            servingRoutes,
            priceVersion: e.priceVersion,
            tsSource: e.tsSource,
            firstEventAt: e.ts,
            lastEventAt: e.ts,
            events: 0,
            tokens: { ...ZERO_TOKENS },
            knownApiEquivUsd: 0,
            pricedAmountEvents: 0,
            invalidAmount: false,
            priceStatusCounts: { LIST: 0, ESTIMATE: 0, UNPRICED: 0, unknown: 0 },
            priceEvidence: emptyPriceEvidence(),
          };
          contributors.set(key, row);
        }
        row.events++;
        row.firstEventAt = Math.min(row.firstEventAt, e.ts);
        row.lastEventAt = Math.max(row.lastEventAt, e.ts);
        addTokenCounts(row.tokens, e.tokens);
        addPriceEvidence(row.priceEvidence, e.apiEquivUsd, e.priceStatus);
        switch (e.priceStatus as PriceStatus) {
          case 'LIST': row.priceStatusCounts.LIST++; break;
          case 'ESTIMATE': row.priceStatusCounts.ESTIMATE++; break;
          case 'UNPRICED': row.priceStatusCounts.UNPRICED++; break;
          default: row.priceStatusCounts.unknown++; break;
        }
        if (e.apiEquivUsd !== null) {
          if (typeof e.apiEquivUsd === 'number' && Number.isFinite(e.apiEquivUsd) && e.apiEquivUsd >= 0) {
            if (e.priceStatus === 'LIST' || e.priceStatus === 'ESTIMATE') {
              row.knownApiEquivUsd += e.apiEquivUsd;
              row.pricedAmountEvents++;
            }
          } else {
            row.invalidAmount = true;
          }
        }
      }
    }
    const apiEquivUsd = inBlock > 0 && priced === 0 ? null : usd;
    qualifyAggregateAmount(priceEvidence, apiEquivUsd);

    const clampedNow = Math.min(now, current.end);
    const elapsedMs = Math.max(1, clampedNow - current.start);
    const remainingMs = Math.max(0, current.end - clampedNow);

    const window: LimitWindow = {
      id: 'block_estimate',
      usedPercent: null, // no quota/denominator known locally — never fabricated
      windowMinutes: FIVE_HOURS_MS / 60_000,
      resetsAt: current.end,
      startedAt: current.start,
      tokens,
      ...(countQuality ? { countQuality } : {}),
      apiEquivUsd,
      priceEvidence,
      burnTokensPerMin: tokens / (elapsedMs / 60_000),
      projectedTokens: tokens + (tokens / elapsedMs) * remainingMs,
      projectedUsd: apiEquivUsd === null || priceEvidence.issuesEvents > 0 || priceEvidence.aggregateAmountInvalid ? null : apiEquivUsd + (apiEquivUsd / elapsedMs) * remainingMs,
    };

    results.push({
      source: 'claude-block-estimate',
      host: g.hosts[0]!,
      ...(g.account ? { account: g.account.id } : {}),
      capturedAt: now,
      windows: [window],
      estimate: true,
      contributors: contributorRows(contributors.values()),
    });
  }

  return results;
}

// ── newest Codex snapshot per account ───────────────────────────────────────

/**
 * Given every raw Codex `rate_limits` `LimitSnapshot` collected across hosts (the Codex collector's
 * job to produce, DESIGN §4.2 "persist the newest rate_limits snapshot per host"), returns the
 * single newest (`capturedAt` max) snapshot per RESOLVED account AND limit id — collapsing
 * multiple hosts that share one Codex account down to one row per limit id, per DESIGN §6 "newest
 * Codex snapshot per account" + §15.9.5. A host with no configured account is its own group.
 */
export function newestCodexSnapshotPerAccount(
  snapshots: readonly LimitSnapshot[],
  accounts: readonly AccountConfig[]
): LimitSnapshot[] {
  // Keyed by (account, limitId): collapsing across limit ids would let e.g. 'codex_bengalfox'
  // overwrite the main 'codex' plan limit (DESIGN §15.9.5).
  return newestSnapshotPerSeries(
    snapshots.filter((s) => s.source === 'codex'),
    accounts
  );
}

/** Identity of a limit series: (source, resolved account, limitId) — DESIGN §15.9.5. */
export function limitSeriesKey(snap: LimitSnapshot, accounts: readonly AccountConfig[]): string {
  const account = snapshotAccount(snap, accounts);
  const accountId = nonBlankAccountId(account);
  const group = accountId === undefined ? `host:${snap.host}` : `account:${accountId}`;
  return `${snap.source}\u0000${group}\u0000${snap.limitId ?? ''}`;
}

/**
 * Newest snapshot (max capturedAt) per (source, account, limitId). A snapshot without a nonblank
 * `account` is attributed through config.accounts (host → account), else to its host — never a
 * guessed account. Configured account attribution is returned on the selected snapshot while its
 * `host` continues to identify the host that actually observed it. Each Codex limit id stays its own row.
 */
export function newestSnapshotPerSeries(
  snapshots: readonly LimitSnapshot[],
  accounts: readonly AccountConfig[]
): LimitSnapshot[] {
  const newest = new Map<string, LimitSnapshot>();
  for (const input of snapshots) {
    const resolvedAccount = snapshotAccount(input, accounts);
    const snap = resolvedAccount === input.account ? input : { ...input, account: resolvedAccount };
    const key = limitSeriesKey(snap, accounts);
    const cur = newest.get(key);
    if (!cur || snap.capturedAt > cur.capturedAt) newest.set(key, snap);
  }
  return [...newest.values()];
}
