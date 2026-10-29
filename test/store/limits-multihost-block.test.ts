/**
 * Claude five-hour block across hosts (PM-02; integration-owner decision D2, 2026-10-17).
 *
 * When several hosts map to one configured Claude account, getLimits() must anchor the block chain over the
 * UNION of that account's activity. A host with no configured account stays its own group. Each case builds a
 * synthetic ledger through the real SqliteLedger and reads the real queries.getLimits(); the expected block is
 * hand-computed from the documented rule (first block starts at floor-to-hour of the first activity and lasts 5 h;
 * a later timestamp at or before the block end stays in it; a later one opens a new block), with one event of
 * 1,000 tokens per activity timestamp.
 *
 * Before the fix, the SQL cut each host's activity at that host's own last gap over 5 h, so a gap on one host that
 * another host of the same account fills dropped activity that moves the block.
 */
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type { AccountConfig, UsageEvent } from '../../src/core/types.js';

const H = 3_600_000;
const DAY = Date.UTC(2026, 9, 13);
const at = (h: number, m = 0) => DAY + h * H + m * 60_000;
const pricing = defaultPricingEngine();
const computeUnits = createNullEngine();
const acct = (id: string, hosts: string[]): AccountConfig => ({ id, kind: 'claude', hosts, monthlyUsd: 100 });

function event(host: string, ts: number, n: number): UsageEvent {
  const tokens = { inputFresh: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 };
  return {
    id: `claude:${host}:${n}`, host, source: 'claude', ts, tsSource: 'line', sessionId: `s-${host}`, isSubagent: false,
    model: 'claude-sonnet-5', provider: 'anthropic', components: [{ model: 'claude-sonnet-5', tokens }], tokens, flags: [],
    apiEquivUsd: null, priceStatus: 'UNPRICED', priceVersion: '', reservedValue: null, ucuRateStatus: 'NONE', eacsDefSha256: '',
  };
}

async function blockRows(accounts: AccountConfig[], acts: Record<string, number[]>, now: number) {
  const db = openDb({ file: ':memory:' });
  try {
    const ledger = new SqliteLedger(db, pricing, computeUnits);
    const config = defaultConfig({ hostLabel: 'A' });
    config.accounts = accounts;
    let n = 0;
    for (const [host, ts] of Object.entries(acts)) {
      ledger.recordActivity(ts.map((t) => ({ source: 'claude' as const, sessionId: `s-${host}`, ts: t, uuid: `u-${host}-${t}`, host })));
      ledger.upsertEvents(ts.map((t) => event(host, t, n++)));
    }
    const res = await createQueries(db, config, { now: () => now, pricing, probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: 0 }) }).getLimits();
    return res.snapshots.filter((s) => s.source === 'claude-block-estimate').map((s) => ({
      host: s.host,
      account: s.account,
      start: s.windows[0]!.startedAt,
      end: s.windows[0]!.resetsAt,
      tokens: s.windows[0]!.tokens,
    }));
  } finally { db.close(); }
}

async function blocks(accounts: AccountConfig[], acts: Record<string, number[]>, now: number) {
  const rows = await blockRows(accounts, acts, now);
  return Object.fromEntries(rows.map((s) => [s.account ?? s.host, { start: s.start, end: s.end, tokens: s.tokens }]));
}

describe('Claude five-hour block is anchored over the account-wide activity union', () => {
  it('a gap on one host that another host of the account fills does not move the block', async () => {
    // Union 11:30, 13:00, 16:00, 17:00: block 11:00-16:00 holds the first three, 17:00 opens 17:00-22:00.
    const r = await blocks([acct('acct', ['A', 'B'])], { A: [at(11, 30), at(17)], B: [at(13), at(16)] }, at(18));
    expect(r).toEqual({ acct: { start: at(17), end: at(22), tokens: 1000 } });
  });

  it('the block is not shown as ended while the account is still inside it', async () => {
    // Union 08:30, 10:00, 12:30, 14:00: block 08:00-13:00, then 14:00 opens 14:00-19:00. At 15:30 it is active.
    const r = await blocks([acct('acct', ['A', 'B'])], { A: [at(8, 30), at(14)], B: [at(10), at(12, 30)] }, at(15, 30));
    expect(r).toEqual({ acct: { start: at(14), end: at(19), tokens: 1000 } });
    expect(r.acct!.end!).toBeGreaterThan(at(15, 30));
  });

  it('does not depend on which host holds the gap', async () => {
    const r = await blocks([acct('acct', ['A', 'B'])], { B: [at(11, 30), at(17)], A: [at(13), at(16)] }, at(18));
    expect(r).toEqual({ acct: { start: at(17), end: at(22), tokens: 1000 } });
  });

  it('three hosts: union 01:00, 03:00, 04:00, 07:00, 10:00 gives block 07:00-12:00 with two events', async () => {
    const r = await blocks([acct('acct', ['A', 'B', 'C'])], { A: [at(1), at(7)], B: [at(3)], C: [at(4), at(10)] }, at(11));
    expect(r).toEqual({ acct: { start: at(7), end: at(12), tokens: 2000 } });
  });

  it('a real gap over 5 h in the merged series still resets the chain', async () => {
    // Union 05:00, 06:00, 16:00, 17:00: 06:00 -> 16:00 is 10 h, so 16:00 opens the block 16:00-21:00.
    const r = await blocks([acct('acct', ['A', 'B'])], { A: [at(5), at(17)], B: [at(6), at(16)] }, at(18));
    expect(r).toEqual({ acct: { start: at(16), end: at(21), tokens: 2000 } });
  });

  it('with no gap over 5 h on any host nothing is dropped', async () => {
    const r = await blocks([acct('acct', ['A', 'B'])], { A: [at(11, 30), at(15)], B: [at(13), at(16)] }, at(18));
    expect(r).toEqual({ acct: { start: at(11), end: at(16), tokens: 4000 } });
  });

  it('hosts with no configured account stay separate groups, each with its own chain', async () => {
    const r = await blocks([], { A: [at(11, 30), at(17)], B: [at(13), at(16)] }, at(18));
    expect(r).toEqual({
      A: { start: at(17), end: at(22), tokens: 1000 },
      B: { start: at(13), end: at(18), tokens: 2000 },
    });
  });

  it('hosts on different accounts stay separate', async () => {
    const r = await blocks([acct('one', ['A']), acct('two', ['B'])], { A: [at(11, 30), at(17)], B: [at(13), at(16)] }, at(18));
    expect(r).toEqual({
      one: { start: at(17), end: at(22), tokens: 1000 },
      two: { start: at(13), end: at(18), tokens: 2000 },
    });
  });

  it('does not let an earlier blank mapping split a host from its configured account group', async () => {
    const r = await blocks([acct('', ['A']), acct('acct', ['A', 'B'])], { A: [at(11, 30), at(17)], B: [at(13), at(16)] }, at(18));
    expect(r).toEqual({ acct: { start: at(17), end: at(22), tokens: 1000 } });
  });

  it('a host outside the account is not merged into it', async () => {
    // Account holds A and B; C is unconfigured and keeps its own chain even though its activity is interleaved.
    const r = await blocks([acct('acct', ['A', 'B'])], { A: [at(11, 30), at(17)], B: [at(13), at(16)], C: [at(12), at(20)] }, at(21));
    expect(r).toEqual({
      acct: { start: at(17), end: at(22), tokens: 1000 },
      C: { start: at(20), end: at(25), tokens: 1000 },
    });
  });
  it('keeps an unconfigured host separate when its label matches another account id', async () => {
    const rows = await blockRows([acct('A', ['B'])], { B: [at(9)], A: [at(16)] }, at(17));
    expect(rows.sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'A', account: undefined, start: at(16), end: at(21), tokens: 1000 },
      { host: 'B', account: 'A', start: at(9), end: at(14), tokens: 1000 },
    ]);
  });

  it('keeps hosts separate when a configured account ID is blank', async () => {
    const rows = await blockRows([acct('', ['A']), acct('', ['B'])], { A: [at(14)], B: [at(16)] }, at(17));
    expect(rows.sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'A', account: '', start: at(14), end: at(19), tokens: 1000 },
      { host: 'B', account: '', start: at(16), end: at(21), tokens: 1000 },
    ]);
  });

  it('keeps hosts separate when configured account IDs contain only whitespace', async () => {
    const rows = await blockRows([acct('   ', ['A']), acct('   ', ['B'])], { A: [at(14)], B: [at(16)] }, at(17));
    expect(rows.sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'A', account: '   ', start: at(14), end: at(19), tokens: 1000 },
      { host: 'B', account: '   ', start: at(16), end: at(21), tokens: 1000 },
    ]);
  });

});
