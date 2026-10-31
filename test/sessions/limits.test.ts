import { describe, it, expect } from 'vitest';
import {
  computeClaudeBlockEstimates,
  computeClaudeBlocks,
  newestCodexSnapshotPerAccount,
  newestSnapshotPerSeries,
  resolveAccount,
} from '../../src/core/limits.ts';
import { ZERO_TOKENS } from '../../src/core/types.ts';
import type { AccountConfig, LimitSnapshot, UsageComponent, UsageEvent } from '../../src/core/types.ts';

const HOUR = 60 * 60 * 1000;
const FIVE_HOURS = 5 * HOUR;

function mkEvent(overrides: {
  id: string;
  ts: number;
  host?: string;
  model?: string;
  priceVersion?: string;
  provider?: UsageEvent['provider'];
  servingRoute?: UsageComponent['servingRoute'];
  priceStatus?: UsageEvent['priceStatus'];
  tsSource?: UsageEvent['tsSource'];
  countQuality?: NonNullable<UsageEvent['tokens']['countQuality']>;
  inputFresh?: number;
  output?: number;
  apiEquivUsd?: number | null;
}): UsageEvent {
  const tokens = {
    ...ZERO_TOKENS,
    inputFresh: overrides.inputFresh ?? 0,
    output: overrides.output ?? 0,
    ...(overrides.countQuality ? { countQuality: overrides.countQuality } : {}),
  };
  const model = overrides.model ?? 'claude-sonnet-5';
  const component: UsageComponent = { model, tokens, ...(overrides.servingRoute ? { servingRoute: overrides.servingRoute } : {}) };
  return {
    id: overrides.id,
    host: overrides.host ?? 'M4a',
    source: 'claude',
    ts: overrides.ts,
    tsSource: overrides.tsSource ?? 'line',
    sessionId: 'S1',
    isSubagent: false,
    model,
    provider: overrides.provider ?? 'anthropic',
    components: [component],
    tokens,
    flags: [],
    apiEquivUsd: overrides.apiEquivUsd === undefined ? 0 : overrides.apiEquivUsd,
    priceStatus: overrides.priceStatus ?? 'LIST',
    priceVersion: overrides.priceVersion ?? 'v1',
    reservedValue: 0,
    ucuRateStatus: 'MEASURED',
    eacsDefSha256: 'sha',
  };
}

// ── computeClaudeBlocks ──────────────────────────────────────────────────

describe('computeClaudeBlocks', () => {
  it('a single block starts at the first activity floored to the hour and lasts 5h', () => {
    // 10:17:00 floors to 10:00:00; block = [10:00, 15:00)
    const t0 = new Date('2026-09-26T10:17:00.000Z').getTime();
    const blocks = computeClaudeBlocks([t0]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].start).toBe(new Date('2026-09-26T10:00:00.000Z').getTime());
    expect(blocks[0].end).toBe(blocks[0].start + FIVE_HOURS);
  });

  it('activity within the block does not start a new one, even if it floors to a different hour', () => {
    const start = new Date('2026-09-26T10:00:00.000Z').getTime();
    const within = start + 3 * HOUR + 10 * 60 * 1000; // 13:10, still inside [10:00,15:00)
    const blocks = computeClaudeBlocks([start, within]);
    expect(blocks).toHaveLength(1);
  });

  it('activity after a block ends starts a new block, floored to its own hour', () => {
    const start = new Date('2026-09-26T10:00:00.000Z').getTime();
    const afterEnd = start + FIVE_HOURS + 47 * 60 * 1000; // 15:47, after [10:00,15:00) ends
    const blocks = computeClaudeBlocks([start, afterEnd]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].start).toBe(new Date('2026-09-26T15:00:00.000Z').getTime());
  });

  it('empty input -> no blocks', () => {
    expect(computeClaudeBlocks([])).toEqual([]);
  });
});

// ── computeClaudeBlockEstimates ──────────────────────────────────────────

describe('computeClaudeBlockEstimates', () => {
  it('hand-computed tokens/$/projected total for the current (last) block', () => {
    const blockStart = new Date('2026-09-26T10:00:00.000Z').getTime();
    const now = blockStart + HOUR; // 1h into a 5h block -> elapsed 1h, remaining 4h
    const activity = [blockStart, blockStart + 30 * 60_000, now - 1000];

    const events = [
      mkEvent({ id: 'a', ts: blockStart + 100, inputFresh: 100, output: 100, apiEquivUsd: 1 }), // 200 tok
      mkEvent({ id: 'b', ts: blockStart + 30 * 60_000, inputFresh: 200, output: 200, apiEquivUsd: 2 }), // 400 tok
    ];

    const accounts: AccountConfig[] = [{ id: 'acct-claude', kind: 'claude', hosts: ['M4a'] }];
    const results = computeClaudeBlockEstimates(
      new Map([['M4a', activity]]),
      new Map([['M4a', events]]),
      accounts,
      now
    );

    expect(results).toHaveLength(1);
    const snapshot = results[0];
    const w = snapshot.windows[0];
    expect(snapshot.source).toBe('claude-block-estimate');
    expect(snapshot.estimate).toBe(true);
    expect(snapshot.account).toBe('acct-claude');
    expect(w.id).toBe('block_estimate');
    expect(w.usedPercent).toBeNull();
    expect(w.startedAt).toBe(blockStart);
    expect(w.resetsAt).toBe(blockStart + FIVE_HOURS);
    expect(w.windowMinutes).toBe(300);

    // totals in block so far: tokens 200+400=600, usd 1+2=3
    expect(w.tokens).toBe(600);
    expect(w.apiEquivUsd).toBe(3);
    // elapsed = 1h = 3_600_000ms; rate = 600/3_600_000 tok/ms; remaining = 4h = 14_400_000ms
    // projected = 600 + (600/3_600_000)*14_400_000 = 600 + 2400 = 3000
    expect(w.projectedTokens).toBeCloseTo(3000, 6);
    // usd projected = 3 + (3/3_600_000)*14_400_000 = 3 + 12 = 15
    expect(w.projectedUsd).toBeCloseTo(15, 6);
    // burn: tokensPerMin = 600 / 60min = 10
    expect(w.burnTokensPerMin).toBeCloseTo(10, 6);
    expect(snapshot.contributors).toHaveLength(1);
    expect(Object.keys(snapshot).sort()).toEqual(['account', 'capturedAt', 'contributors', 'estimate', 'host', 'source', 'windows']);
  });

  it('a finished block (now past its end) projects exactly its actual total; events outside the block are excluded', () => {
    const blockStart = new Date('2026-09-26T10:00:00.000Z').getTime();
    const now = blockStart + 7 * HOUR; // block [10:00, 15:00] is over
    const results = computeClaudeBlockEstimates(
      new Map([['M4a', [blockStart + 10 * 60_000]]]),
      new Map([
        [
          'M4a',
          [
            mkEvent({ id: 'in', ts: blockStart + 10 * 60_000, inputFresh: 50, output: 50, apiEquivUsd: 0.5 }),
            mkEvent({ id: 'before', ts: blockStart - 1, inputFresh: 1000, output: 1000, apiEquivUsd: 10 }),
          ],
        ],
      ]),
      [],
      now
    );
    const w = results[0].windows[0];
    expect(w.tokens).toBe(100);
    expect(w.projectedTokens).toBe(100); // remaining = 0
    expect(w.projectedUsd).toBe(0.5);
    // elapsed = min(now,end) - start = 5h = 300 min → 100 / 300 tok/min
    expect(w.burnTokensPerMin).toBeCloseTo(100 / 300, 9);
  });

  it('apiEquivUsd/projectedUsd are null only when every in-block event is unpriced (never a fabricated $0)', () => {
    const t0 = new Date('2026-09-26T10:00:00.000Z').getTime();
    const onlyUnpriced = computeClaudeBlockEstimates(
      new Map([['M4a', [t0]]]),
      new Map([['M4a', [mkEvent({ id: 'u', ts: t0, inputFresh: 5, output: 5, apiEquivUsd: null })]]]),
      [],
      t0 + HOUR
    )[0].windows[0];
    expect(onlyUnpriced.apiEquivUsd).toBeNull();
    expect(onlyUnpriced.projectedUsd).toBeNull();
    expect(onlyUnpriced.tokens).toBe(10);
    const mixed = computeClaudeBlockEstimates(
      new Map([['M4a', [t0]]]),
      new Map([
        [
          'M4a',
          [
            mkEvent({ id: 'u', ts: t0, inputFresh: 5, output: 5, apiEquivUsd: null }),
            mkEvent({ id: 'p', ts: t0 + 1, inputFresh: 5, output: 5, apiEquivUsd: 2 }),
          ],
        ],
      ]),
      [],
      t0 + HOUR
    )[0].windows[0];
    expect(mixed.apiEquivUsd).toBe(2);
  });

  it('falls back to grouping by host when no account is configured for it', () => {
    const t0 = new Date('2026-09-26T10:00:00.000Z').getTime();
    const results = computeClaudeBlockEstimates(
      new Map([['ryzen', [t0]]]),
      new Map([['ryzen', []]]),
      [], // no accounts configured — never guess an identity
      t0 + 1000
    );
    expect(results).toHaveLength(1);
    expect(results[0].account).toBeUndefined();
    expect(results[0].host).toBe('ryzen');
  });

  it('returns privacy-safe grouped contributors with host, event-time, count and price evidence', () => {
    const start = new Date('2026-09-26T10:00:00.000Z').getTime();
    const reset = start + FIVE_HOURS;
    const accounts: AccountConfig[] = [{ id: 'acct-shared', kind: 'claude', hosts: ['M4a', 'A2000'] }];
    const results = computeClaudeBlockEstimates(
      new Map([
        ['M4a', [start + 100]],
        ['A2000', [start + 200]],
      ]),
      new Map([
        ['M4a', [
          mkEvent({ id: 'private-event-a', ts: start + 100, host: 'M4a', inputFresh: 100, output: 20, apiEquivUsd: 0.004, priceVersion: 'v1', countQuality: 'complete' }),
          mkEvent({ id: 'other-price-version', ts: start + 120, host: 'M4a', inputFresh: 1, output: 0, apiEquivUsd: 0.003, priceVersion: 'v2', countQuality: 'complete' }),
          mkEvent({ id: 'other-time-source', ts: start + 130, host: 'M4a', inputFresh: 2, output: 0, apiEquivUsd: 0.004, priceVersion: 'v1', tsSource: 'turn', countQuality: 'complete' }),
          mkEvent({ id: 'private-event-b', ts: reset, host: 'M4a', inputFresh: 10, output: 5, apiEquivUsd: null, priceStatus: 'UNPRICED', priceVersion: 'v1', countQuality: 'incomplete' }),
          mkEvent({ id: 'outside-event', ts: reset + 1, host: 'M4a', inputFresh: 900, output: 900, apiEquivUsd: 9, priceVersion: 'v1', countQuality: 'complete' }),
        ]],
        ['A2000', [
          mkEvent({ id: 'private-event-c', ts: start + 2 * 60_000, host: 'A2000', model: 'claude-opus-5', inputFresh: 30, output: 10, apiEquivUsd: 0.02, priceStatus: 'ESTIMATE', priceVersion: 'v2', tsSource: 'turn', countQuality: 'complete' }),
        ]],
      ]),
      accounts,
      start + 4 * HOUR
    );

    expect(results).toHaveLength(1);
    const snapshot = results[0]!;
    expect(snapshot.account).toBe('acct-shared');
    expect(snapshot.contributors).toHaveLength(4);
    const m4a = snapshot.contributors!.find((row) => row.host === 'M4a')!;
    expect(m4a).toMatchObject({
      host: 'M4a',
      model: 'claude-sonnet-5',
      priceVersion: 'v1',
      tsSource: 'line',
      firstEventAt: start + 100,
      lastEventAt: reset,
      events: 2,
      knownApiEquivUsd: 0.004,
      priceStatusCounts: { LIST: 1, ESTIMATE: 0, UNPRICED: 1, unknown: 0 },
      priceEvidence: { events: 2, issuesEvents: 0, aggregateAmountInvalid: false },
    });
    expect(m4a.tokens).toMatchObject({ inputFresh: 110, output: 25, countQuality: 'incomplete' });
    expect(snapshot.contributors!
      .filter((row) => row.host === 'M4a' && row.model === 'claude-sonnet-5')
      .map((row) => [row.priceVersion, row.tsSource, row.events]))
      .toEqual([['v1', 'line', 2], ['v1', 'turn', 1], ['v2', 'line', 1]]);
    const a2000 = snapshot.contributors!.find((row) => row.host === 'A2000')!;
    expect(a2000).toMatchObject({ model: 'claude-opus-5', tsSource: 'turn', events: 1, priceStatusCounts: { ESTIMATE: 1 } });
    expect(JSON.stringify(snapshot.contributors)).not.toContain('private-event');
    expect(JSON.stringify(snapshot.contributors)).not.toContain('S1');
  });

  it('withholds a contributor subtotal when a numeric amount conflicts with its price status', () => {
    const start = new Date('2026-09-26T10:00:00.000Z').getTime();
    const snapshot = computeClaudeBlockEstimates(
      new Map([['M4a', [start + 100]]]),
      new Map([['M4a', [
        mkEvent({ id: 'priced', ts: start + 100, apiEquivUsd: 0.02, priceStatus: 'LIST' }),
        mkEvent({ id: 'conflict', ts: start + 200, apiEquivUsd: 0.99, priceStatus: 'UNPRICED' }),
      ]]]),
      [],
      start + HOUR
    )[0]!;
    expect(snapshot.contributors).toHaveLength(1);
    expect(snapshot.contributors![0]).toMatchObject({
      events: 2,
      knownApiEquivUsd: null,
      priceEvidence: { statusAmountConflictEvents: 1, issuesEvents: 1 },
    });
  });

  it('keeps same-model contributors separate when provider or route evidence differs', () => {
    const start = new Date('2026-09-26T10:00:00.000Z').getTime();
    const snapshot = computeClaudeBlockEstimates(
      new Map([['M4a', [start + 100]]]),
      new Map([['M4a', [
        mkEvent({ id: 'local-routed', ts: start + 100, provider: 'local', servingRoute: { kind: 'local', evidence: 'metered-engine' }, apiEquivUsd: 0 }),
        mkEvent({ id: 'legacy-route', ts: start + 200, provider: 'local', apiEquivUsd: null, priceStatus: 'UNPRICED' }),
        mkEvent({ id: 'unknown-provider', ts: start + 300, provider: 'unknown', servingRoute: { kind: 'unknown', evidence: 'conflicting-reports' }, apiEquivUsd: null, priceStatus: 'UNPRICED' }),
      ]]]),
      [],
      start + HOUR
    )[0]!;
    expect(snapshot.contributors).toHaveLength(3);
    expect(snapshot.contributors).toMatchObject([
      { provider: 'local', servingRoutes: [{ kind: 'local', evidence: 'metered-engine' }] },
      { provider: 'local', servingRoutes: [{ kind: 'unrecorded' }] },
      { provider: 'unknown', servingRoutes: [{ kind: 'unknown', evidence: 'conflicting-reports' }] },
    ]);
  });

  it('keeps activity marks distinct from an empty usage-event contribution set', () => {
    const start = new Date('2026-09-26T10:00:00.000Z').getTime();
    const snapshot = computeClaudeBlockEstimates(
      new Map([['M4a', [start + 100]]]),
      new Map([['M4a', []]]),
      [],
      start + HOUR
    )[0]!;
    expect(snapshot.windows[0]!.tokens).toBe(0);
    expect(snapshot.contributors).toEqual([]);
  });

  it('does not collide an account id with an unconfigured host label', () => {
    const t0 = new Date('2026-09-26T10:00:00.000Z').getTime();
    const accounts: AccountConfig[] = [{ id: 'A', kind: 'claude', hosts: ['B'] }];
    const results = computeClaudeBlockEstimates(
      new Map([
        ['B', [t0]],
        ['A', [t0 + 6 * HOUR]],
      ]),
      new Map([
        ['B', [mkEvent({ id: 'acct-event', ts: t0, inputFresh: 10, output: 10, apiEquivUsd: 0.1, host: 'B' })]],
        ['A', [mkEvent({ id: 'host-event', ts: t0 + 6 * HOUR, inputFresh: 20, output: 20, apiEquivUsd: 0.2, host: 'A' })]],
      ]),
      accounts,
      t0 + 7 * HOUR
    );
    expect(results).toHaveLength(2);
    expect(results.find((snapshot) => snapshot.host === 'B')?.windows[0].tokens).toBe(20);
    expect(results.find((snapshot) => snapshot.host === 'A')?.windows[0].tokens).toBe(40);
  });

  it('merges activity across every host belonging to the same account (fleet-merged)', () => {
    const t0 = new Date('2026-09-26T10:00:00.000Z').getTime();
    const accounts: AccountConfig[] = [{ id: 'acct-claude', kind: 'claude', hosts: ['M4a', 'A2000'] }];
    const results = computeClaudeBlockEstimates(
      new Map([
        ['M4a', [t0]],
        ['A2000', [t0 + 60_000]],
      ]),
      new Map([
        ['M4a', [mkEvent({ id: 'a', ts: t0, inputFresh: 10, output: 10, apiEquivUsd: 0.1, host: 'M4a' })]],
        ['A2000', [mkEvent({ id: 'b', ts: t0 + 60_000, inputFresh: 20, output: 20, apiEquivUsd: 0.2, host: 'A2000' })]],
      ]),
      accounts,
      t0 + 120_000
    );
    expect(results).toHaveLength(1); // one row for the whole account, not one per host
    expect(results[0].windows[0].tokens).toBe(60); // 20 + 40
    expect(results[0].windows[0].apiEquivUsd).toBeCloseTo(0.3, 6);
  });

  it('no activity for an account -> no result row', () => {
    const results = computeClaudeBlockEstimates(new Map(), new Map(), [], Date.now());
    expect(results).toEqual([]);
  });
});

// ── resolveAccount / newestCodexSnapshotPerAccount ───────────────────────

describe('resolveAccount', () => {
  const accounts: AccountConfig[] = [
    { id: 'work-claude', kind: 'claude', hosts: ['M4a'] },
    { id: 'work-codex', kind: 'codex', hosts: ['M4a', 'A2000'] },
  ];

  it('finds the account matching kind + host', () => {
    expect(resolveAccount('A2000', 'codex', accounts)?.id).toBe('work-codex');
  });

  it('undefined when nothing matches (never guessed)', () => {
    expect(resolveAccount('ryzen', 'codex', accounts)).toBeUndefined();
    expect(resolveAccount('M4a', 'codex' as const, [])).toBeUndefined();
  });
});

describe('newestCodexSnapshotPerAccount', () => {
  function mkSnap(host: string, capturedAt: number): LimitSnapshot {
    return { source: 'codex', host, capturedAt, windows: [], estimate: false };
  }

  it('picks the newest snapshot per resolved account, collapsing multiple hosts', () => {
    const accounts: AccountConfig[] = [{ id: 'acct', kind: 'codex', hosts: ['M4a', 'A2000'] }];
    const snapshots = [mkSnap('M4a', 1000), mkSnap('A2000', 5000), mkSnap('M4a', 3000)];
    const result = newestCodexSnapshotPerAccount(snapshots, accounts);
    expect(result).toHaveLength(1);
    expect(result[0].capturedAt).toBe(5000);
    expect(result[0].host).toBe('A2000');
  });

  it('non-codex snapshots are ignored', () => {
    const claudeSnap: LimitSnapshot = {
      source: 'claude-block-estimate',
      host: 'M4a',
      capturedAt: 9999,
      windows: [],
      estimate: true,
    };
    const result = newestCodexSnapshotPerAccount([claudeSnap], []);
    expect(result).toEqual([]);
  });

  it('unconfigured hosts each get their own row', () => {
    const result = newestCodexSnapshotPerAccount([mkSnap('M4a', 1), mkSnap('ryzen', 2)], []);
    expect(result).toHaveLength(2);
  });
});

describe('limits are keyed by (source, account, limitId) — DESIGN §15.9.5', () => {
  function snap(limitId: string | undefined, host: string, capturedAt: number, used: number): LimitSnapshot {
    return {
      source: 'codex',
      ...(limitId ? { limitId } : {}),
      host,
      capturedAt,
      windows: [{ id: 'primary', usedPercent: used, windowMinutes: 10080 }],
      estimate: false,
    };
  }

  it('a newer snapshot of another limit id never replaces the main codex limit', () => {
    const accounts: AccountConfig[] = [{ id: 'acct', kind: 'codex', hosts: ['M4a', 'A2000'] }];
    const result = newestSnapshotPerSeries(
      [snap('codex', 'M4a', 100, 44), snap('codex_bengalfox', 'A2000', 900, 0), snap('codex', 'A2000', 200, 46)],
      accounts
    );
    const byId = new Map(result.map((r) => [r.limitId, r]));
    expect(result).toHaveLength(2);
    expect(byId.get('codex')!.capturedAt).toBe(200); // newest of the 'codex' series across both hosts
    expect(byId.get('codex')!.windows[0].usedPercent).toBe(46);
    expect(byId.get('codex_bengalfox')!.capturedAt).toBe(900);
  });

  it('keeps an account id distinct from an unconfigured host with the same label', () => {
    const accounts: AccountConfig[] = [{ id: 'A', kind: 'codex', hosts: ['B'] }];
    const result = newestSnapshotPerSeries([snap('codex', 'B', 100, 1), snap('codex', 'A', 200, 2)], accounts);
    expect(result).toHaveLength(2);
  });

  it('newestCodexSnapshotPerAccount keeps one row per (account, limitId)', () => {
    const result = newestCodexSnapshotPerAccount([snap('codex', 'M4a', 1, 1), snap('premium', 'M4a', 2, 2)], []);
    expect(result.map((r) => r.limitId).sort()).toEqual(['codex', 'premium']);
  });
});
