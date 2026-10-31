import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries, type CreateQueriesOpts } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { TokeneloConfig } from '../../src/core/types.js';

// M3e scope: each account's price-quality counts come from its own events (its hosts and kind), never a whole-host total.
const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });
const NOW = 1_700_000_000_000;
let db: TokeneloDb;
let config: TokeneloConfig;

function seed(id: string, host: string, source: string, priceStatus: 'LIST' | 'ESTIMATE' | 'UNPRICED', usd: number | null): void {
  db.prepare(
    `INSERT INTO events (id, host, source, ts, ts_source, session_id, is_subagent, model, provider, components_json,
       input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, flags_json, api_equiv_usd, price_status,
       price_version, ucu_rate_status, eacs_def_sha256, thinking)
     VALUES (?, ?, ?, ?, 'line', 's1', 0, 'claude-sonnet-5', 'anthropic', '[]', 1, 0, 0, 0, 1, 0, '[]', ?, ?, 'v', 'MEASURED', 'def-sha', NULL)`,
  ).run(id, host, source, NOW - 1000, usd, priceStatus);
}

beforeEach(() => {
  db = openDb({ file: ':memory:' });
  config = defaultConfig({ hostLabel: 'M4a' });
  // Host M4a, claude: 2 LIST, 1 ESTIMATE, 1 UNPRICED. Host M4b, claude: 3 UNPRICED. Host M4a, codex: 4 LIST (other kind).
  seed('a1', 'M4a', 'claude', 'LIST', 10);
  seed('a2', 'M4a', 'claude', 'LIST', 10);
  seed('a3', 'M4a', 'claude', 'ESTIMATE', 5);
  seed('a4', 'M4a', 'claude', 'UNPRICED', null);
  seed('b1', 'M4b', 'claude', 'UNPRICED', null);
  seed('b2', 'M4b', 'claude', 'UNPRICED', null);
  seed('b3', 'M4b', 'claude', 'UNPRICED', null);
  for (let i = 0; i < 4; i++) seed(`c${i}`, 'M4a', 'codex', 'LIST', 1);
});

afterEach(() => db.close());

async function subs(accounts: TokeneloConfig['accounts']) {
  config.accounts = accounts;
  const q = createQueries(db, config, { now: () => NOW, probeOllama: stubProbe });
  return (await q.getSummary('all')).subscriptions;
}

describe('M3e scope: account quality is derived from the account\'s own events', () => {
  it('a claude account on M4a: counts only its M4a claude events (4 events, 1 estimated, 1 unpriced); M4b and codex events do not leak in', async () => {
    const [acct] = await subs([{ id: 'claude-m4a', kind: 'claude', hosts: ['M4a'], monthlyUsd: 200 }]);
    expect(acct).toMatchObject({ unpricedEvents: 1, estimatedPriceEvents: 1, priceStatus: 'UNPRICED', partial: true });
    expect(acct!.apiEquivUsd).toBe(25);
  });

  it('a claude account on M4b: only its three unpriced events; priceStatus UNPRICED, not the host-wide mix', async () => {
    const [acct] = await subs([{ id: 'claude-m4b', kind: 'claude', hosts: ['M4b'], monthlyUsd: 200 }]);
    expect(acct).toMatchObject({ unpricedEvents: 3, estimatedPriceEvents: 0, priceStatus: 'UNPRICED', partial: true });
    expect(acct!.apiEquivUsd).toBe(0);
  });

  it('a codex account on M4a: all four LIST events; a known zero unpriced and estimated count, LIST status', async () => {
    const [acct] = await subs([{ id: 'codex-m4a', kind: 'codex', hosts: ['M4a'], monthlyUsd: 100 }]);
    expect(acct).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: 'LIST', partial: false });
    expect(acct!.apiEquivUsd).toBe(4);
  });

  it('an account with no hosts was never queried: every quality field is unknown (null), never zero or LIST', async () => {
    const [acct] = await subs([{ id: 'nohost', kind: 'claude', hosts: [], monthlyUsd: 200 }]);
    expect(acct).toMatchObject({ unpricedEvents: null, estimatedPriceEvents: null, priceStatus: null, partial: null });
  });

  it('an account whose hosts have no events in range: a known zero count, status null (no dollars to qualify)', async () => {
    const [acct] = await subs([{ id: 'empty', kind: 'claude', hosts: ['Ryzen'], monthlyUsd: 200 }]);
    expect(acct).toMatchObject({ unpricedEvents: 0, estimatedPriceEvents: 0, priceStatus: null });
  });
});
