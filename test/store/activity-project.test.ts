import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createQueries } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { buildSessions } from '../../src/core/sessions.js';
import type { ActivityMark } from '../../src/core/types.js';

const NOW = 1791283625188;
const mark = (patch: Partial<ActivityMark> = {}): ActivityMark => ({
  host: 'owned-host', source: 'claude', sessionId: 'owned-session', ts: NOW - 60_000, ...patch,
});
const opts = { now: () => NOW, idleGapMs: 300_000 };
const opened: TokeneloDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe('recorded activity workspace context', () => {
  it('shows one unambiguous recorded workspace without inventing usage', () => {
    const rows = buildSessions([mark({ project: '/owned-workspace' }), mark({ ts: NOW - 30_000, project: '/owned-workspace' })], [], opts);
    expect(rows[0]?.project).toBe('/owned-workspace');
    expect(rows[0]?.telemetry).toEqual([]);
    expect(rows[0]?.apiEquivUsd).toBe(0);
    expect(rows[0]?.tokens.output).toBe(0);
  });

  it('leaves changing workspace context unknown when no usage event selects one', () => {
    const rows = buildSessions([mark({ project: '/first-workspace' }), mark({ ts: NOW - 30_000, project: '/other-workspace' })], [], opts);
    expect(rows[0]?.project).toBeUndefined();
  });

  it('does not borrow another source, host or session workspace', () => {
    const rows = buildSessions([
      mark(), mark({ source: 'codex', project: '/wrong-source' }),
      mark({ host: 'other-host', project: '/wrong-host' }),
      mark({ sessionId: 'other-session', project: '/wrong-session' }),
    ], [], opts);
    expect(rows.find(r => r.host === 'owned-host' && r.source === 'claude' && r.sessionId === 'owned-session')?.project).toBeUndefined();
  });

  it('keeps truly absent and empty workspace metadata unknown', () => {
    expect(buildSessions([mark(), mark({ project: '' })], [], opts)[0]?.project).toBeUndefined();
  });

  async function queried(marks: ActivityMark[]) {
    const db = openDb({ file: ':memory:' }); opened.push(db);
    const pricing = defaultPricingEngine(), valuationEngine = createNullEngine();
    new SqliteLedger(db, pricing, valuationEngine).recordActivity(marks);
    const queries = createQueries(db, defaultConfig({ hostLabel: 'owned-host' }), {
      now: () => NOW, pricing,
      probeOllama: async () => ({ servers: [], manifests: new Map(), generatedAt: NOW }),
    });
    return { list: await queries.getSessions({ range: '30d', activeOnly: false }),
      detail: await queries.getSessionDetail('claude', 'owned-session') };
  }

  it('keeps list and detail metadata coherent with the same recorded workspace', async () => {
    const { list, detail } = await queried([mark({ project: '/owned-workspace' })]);
    expect(list.sessions[0]?.project).toBe('/owned-workspace');
    expect(detail?.project).toBe('/owned-workspace');
    expect(detail?.events).toBe(0);
    expect(detail?.telemetry).toEqual([]);
  });

  it('keeps list and detail workspace unknown when recorded workspace choices conflict', async () => {
    const { list, detail } = await queried([mark({ project: '/first' }), mark({ ts: NOW - 30_000, project: '/second' })]);
    expect(list.sessions[0]?.project).toBeUndefined();
    expect(detail?.project).toBeUndefined();
  });
});
