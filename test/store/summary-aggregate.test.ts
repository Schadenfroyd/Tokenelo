/**
 * Summary's aggregate read and assembly against an independent reference: the original statement's row order, the original
 * array-based fold (provider partition added explicitly for R58), and the original arithmetic (copied below, not imported, so a change to the production
 * accumulator cannot pass by agreeing with itself). The reserved valuation columns are still stored on every row, but the aggregate neither reads
 * nor reports them.
 *
 * Float sums depend on the order of rows. The paged read must return exactly the original statement's order, row by row.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { aggregateRowQuery, createQueries, rangeSince, type CreateQueriesOpts } from '../../src/store/queries.js';
import { readRows } from '../../src/store/read-snapshot.js';
import { AGG_STEP_ROWS, SummaryAggregate, summaryAggregateSteps, type RawEventAgg } from '../../src/store/summary-aggregate.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { drainSteps } from '../../src/core/event-loop.js';
import { ZERO_TOKENS, type RateStatus, type TokenCounts } from '../../src/core/types.js';

const BASE = 1_700_000_000_000;
const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });

// ── original statement (the unpaged selectAgg, without the reserved valuation columns the aggregate no longer selects) ──

const ORIGINAL_AGG_SQL = `SELECT source, model, provider, price_status, api_equiv_usd,
        input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, thinking,
        cache_write_unassigned, cache_write_assumed_1h, count_quality, ucu_count_quality
 FROM events`;

function originalRows(db: TokeneloDb, since: number | undefined): RawEventAgg[] {
  const sql = since === undefined ? ORIGINAL_AGG_SQL : `${ORIGINAL_AGG_SQL} WHERE ts >= ?`;
  return db.prepare(sql).all(...(since === undefined ? [] : [since])) as unknown as RawEventAgg[];
}

// Price evidence is checked by its own tests; the reference fold has only the numeric arithmetic.
const NON_NUMERIC_KEYS = ['priceEvidence'];
// Source price-quality counts (M3e) are checked against their own rows in test/core/price-breakdowns.test.ts; this reference fold predates them.
function withoutSourcePriceQuality(bySource: unknown): unknown {
  const drop = new Set(['unpricedEvents', 'estimatedPriceEvents', 'priceStatus', 'priceEvidence']);
  return Object.fromEntries(Object.entries(bySource as Record<string, Record<string, unknown>>).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => !drop.has(kk)))]));
}

function numericOnly(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, v) => (NON_NUMERIC_KEYS.includes(key) ? undefined : v)));
}

// ── reference: original arithmetic; provider-aware model partition specified independently ──

function refSumTokens(rows: readonly RawEventAgg[]): TokenCounts {
  const t: TokenCounts = { ...ZERO_TOKENS };
  for (const r of rows) {
    t.inputFresh += r.input_fresh;
    t.cacheWrite5m += r.cache_write_5m;
    t.cacheWrite1h += r.cache_write_1h;
    t.cacheRead += r.cache_read;
    t.output += r.output;
    t.reasoning += r.reasoning;
  }
  // These legacy seed rows contain no raw count evidence. Expected quality is independently
  // specified here; numeric arithmetic remains the original reference, without product helpers.
  if (rows.length > 0) t.countQuality = 'unrecorded';
  return t;
}

function refBucket(v: number | null): string {
  return v === null ? 'unknown' : v !== 0 ? 'thinking' : 'non-thinking';
}

function refWeakestPriceStatus(rows: readonly RawEventAgg[]): string {
  let s = 'LIST';
  for (const r of rows) {
    if (r.price_status === 'UNPRICED') return 'UNPRICED';
    if (r.price_status === 'ESTIMATE') s = 'ESTIMATE';
  }
  return s;
}

function referenceAggregate(rows: readonly RawEventAgg[], displayName: (m: string) => string) {
  const unpricedEvents = rows.filter((r) => r.price_status === 'UNPRICED').length;
  const apiEquivUsd = rows.reduce((s, r) => s + (r.api_equiv_usd ?? 0), 0);
  const bySourceMap = new Map<string, RawEventAgg[]>();
  const byModelMap = new Map<string, RawEventAgg[]>();
  for (const r of rows) {
    const s = bySourceMap.get(r.source) ?? [];
    s.push(r);
    bySourceMap.set(r.source, s);
    // R58 changes the model partition only; retain each group's original row order and arithmetic.
    const key = JSON.stringify([r.source, r.provider, r.model, refBucket(r.thinking)]);
    const m = byModelMap.get(key) ?? [];
    m.push(r);
    byModelMap.set(key, m);
  }
  const bySource: Record<string, unknown> = {};
  for (const [source, srows] of bySourceMap) {
    bySource[source] = {
      events: srows.length,
      tokens: refSumTokens(srows),
      apiEquivUsd: srows.reduce((s, r) => s + (r.api_equiv_usd ?? 0), 0),
    };
  }
  const byModel: Array<Record<string, unknown>> = [];
  for (const mrows of byModelMap.values()) {
    const first = mrows[0]!;
    byModel.push({
      model: first.model,
      displayName: displayName(first.model),
      provider: first.provider,
      source: first.source,
      thinking: refBucket(first.thinking),
      events: mrows.length,
      tokens: refSumTokens(mrows),
      apiEquivUsd: mrows.every((r) => r.api_equiv_usd === null) ? null : mrows.reduce((s, r) => s + (r.api_equiv_usd ?? 0), 0),
      priceStatus: refWeakestPriceStatus(mrows),
      unpricedEvents: mrows.filter(r => r.api_equiv_usd === null).length,
      estimatedPriceEvents: mrows.filter(r => r.api_equiv_usd !== null && r.price_status === 'ESTIMATE').length,
    });
  }
  byModel.sort((a, b) => (b.events as number) - (a.events as number));
  return {
    totals: {
      events: rows.length,
      tokens: refSumTokens(rows),
      apiEquivUsd,
      unpricedEvents,
      estimatedPriceEvents: rows.filter((r) => r.price_status === 'ESTIMATE').length,
      priceStatus: rows.some((r) => r.price_status === 'UNPRICED') ? 'UNPRICED' : rows.some((r) => r.price_status === 'ESTIMATE') ? 'ESTIMATE' : 'LIST',
    },
    bySource,
    byModel,
  };
}

// ── fixture: out-of-order timestamps with ties, every bucket, fractional values ───────────

const SOURCES = ['claude', 'codex'] as const;
const MODELS = ['claude-sonnet-5', 'claude-opus-5-5', 'gpt-6-sol', 'unknown-model-xyz'];
// Stored valuation values (legacy rows keep them). The aggregate must never read or report them.
const STORED_STATUSES: RateStatus[] = ['MEASURED', 'PROVISIONAL-MEASURED', 'ESTIMATE', 'NONE'];

/** Deterministic PRNG (mulberry32), so the fixture is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureRow {
  id: string;
  ts: number;
  source: 'claude' | 'codex';
  model: string;
  provider: string;
  priceStatus: 'LIST' | 'ESTIMATE' | 'UNPRICED';
  apiEquivUsd: number | null;
  reservedValue: number | null;
  ucuStatus: RateStatus;
  thinking: number | null;
  tokens: number;
}

function fixtureRows(n: number, seed: number): FixtureRow[] {
  const rand = rng(seed);
  const out: FixtureRow[] = [];
  for (let i = 0; i < n; i++) {
    const priceRoll = rand();
    const priceStatus: FixtureRow['priceStatus'] = priceRoll < 0.1 ? 'UNPRICED' : priceRoll < 0.25 ? 'ESTIMATE' : 'LIST';
    const ucuRoll = rand();
    const ucuStatus = STORED_STATUSES[Math.floor(rand() * STORED_STATUSES.length)]!;
    out.push({
      id: `ev-${String(i).padStart(5, '0')}`,
      // Out of order: the timestamp is random within 4,000 seconds, so equal timestamps are common (ties).
      ts: BASE + Math.floor(rand() * 4000) * 1000,
      source: rand() < 0.6 ? 'claude' : 'codex',
      model: MODELS[Math.floor(rand() * MODELS.length)]!,
      provider: rand() < 0.1 ? 'local' : 'anthropic',
      priceStatus,
      // Fractional values whose sums are not exact in binary: the order of addition shows in the last digits.
      apiEquivUsd: priceStatus === 'UNPRICED' ? null : (rand() * 7 + 0.1) / 3,
      reservedValue: ucuRoll < 0.1 ? null : (rand() * 13 + 0.05) / 7,
      ucuStatus: ucuRoll < 0.1 ? 'NONE' : ucuStatus,
      thinking: rand() < 0.2 ? null : rand() < 0.5 ? 1 : 0,
      tokens: Math.floor(rand() * 1000),
    });
  }
  return out;
}

function seedFile(rows: FixtureRow[]): { db: TokeneloDb; file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-summary-agg-'));
  const file = path.join(dir, 'ledger.db');
  const db = openDb({ file });
  db.exec('BEGIN');
  const ins = db.prepare(
    `INSERT INTO events (id, host, source, ts, ts_source, session_id, model, provider, components_json,
                         input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, flags_json,
                         api_equiv_usd, price_status, price_version, ucu, ucu_rate_status, eacs_def_sha256, thinking)
     VALUES (?, 'M4a', ?, ?, 'line', ?, ?, ?, '[]', ?, 0, 0, 0, ?, 0, '[]', ?, ?, 'v', ?, ?, 'h', ?)`
  );
  for (const r of rows) {
    ins.run(
      r.id, r.source, r.ts, `s-${r.ts % 37}`, r.model, r.provider, r.tokens, r.tokens, r.apiEquivUsd,
      r.priceStatus, r.reservedValue, r.ucuStatus, r.thinking
    );
  }
  db.exec('COMMIT');
  return { db, file, dir };
}

const displayName = (m: string): string => defaultPricingEngine().resolve(m)?.displayName ?? m;

// ── tests ────────────────────────────────────────────────────────────────────────────────────

describe('the aggregate read returns the original statement order, page by page', () => {
  let db: TokeneloDb;
  let dir: string;
  beforeAll(() => {
    ({ db, dir } = seedFile(fixtureRows(6000, 7)));
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Keep only the aggregate columns, the same shape the original statement returns.
  const shape = (r: Record<string, unknown>): RawEventAgg => {
    const { rid: _rid, ts: _ts, ...rest } = r;
    return rest as unknown as RawEventAgg;
  };

  for (const [label, since] of [
    ['unfiltered (all)', undefined],
    ['a range (ties included)', BASE + 1_500_000],
  ] as const) {
    it(`${label}: paged rows equal the original statement's rows, in order, for several page sizes`, async () => {
      const expected = originalRows(db, since);
      expect(expected).toHaveLength(since === undefined ? 6000 : expected.length);
      // Fast first check: the first page's prefix in order, before the full page-size sweep.
      const first = await readRows<RawEventAgg & { ts: number; rid: number }, RawEventAgg>(
        db,
        aggregateRowQuery(since),
        { pageRows: 500, yieldNow: async () => {} },
        shape as (r: RawEventAgg & { ts: number; rid: number }) => RawEventAgg
      );
      expect(first.slice(0, 500)).toEqual(expected.slice(0, 500));
      for (const pageRows of [1, 7, 500, 4096]) {
        const paged = await readRows<RawEventAgg & { ts: number; rid: number }, RawEventAgg>(
          db,
          aggregateRowQuery(since),
          { pageRows, yieldNow: async () => {} },
          shape as (r: RawEventAgg & { ts: number; rid: number }) => RawEventAgg
        );
        // Exact equality of every row, in order: no skipped row, no duplicate, no changed float order.
        expect(paged).toEqual(expected);
      }
    });
  }
});

describe('Summary aggregate parts equal the reference fold', () => {
  let db: TokeneloDb;
  let dir: string;
  let file: string;
  beforeAll(() => {
    ({ db, dir, file } = seedFile(fixtureRows(6000, 7)));
  });
  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const nowFor = (since: number | undefined): number => (since === undefined ? BASE + 9_000_000 : since + 86_400_000);

  it('the whole Summary response is identical on the snapshot path and the synchronous path, and its aggregate fields equal the reference', async () => {
    let yields = 0;
    const config = defaultConfig({ hostLabel: 'M4a' });
    for (const range of ['all', '24h'] as const) {
      const since = rangeSince(range, nowFor(range === 'all' ? undefined : BASE + 2_000_000));
      const now = () => nowFor(range === 'all' ? undefined : BASE + 2_000_000);
      const sync = createQueries(db, config, { now, probeOllama: stubProbe });
      const snap = createQueries(db, config, {
        now,
        probeOllama: stubProbe,
        readSnapshotFile: file,
        pageRows: 500,
        yieldNow: async () => {
          yields++;
        },
      });
      const a = await sync.getSummary(range);
      const b = await snap.getSummary(range);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));

      const recordedRows = originalRows(db, since);
      expect(b.totals.priceEvidence).toEqual({ version: 1, events: recordedRows.length, invalidAmountEvents: 0, unknownStatusEvents: 0, statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false });
      for (const row of [...Object.values(b.bySource), ...b.byModel]) expect(row.priceEvidence).toMatchObject({ events: row.events, issuesEvents: 0, aggregateAmountInvalid: false });
      const ref = referenceAggregate(recordedRows, displayName);
      expect(JSON.stringify(numericOnly(b.totals))).toBe(JSON.stringify(numericOnly(ref.totals)));
      expect(JSON.stringify(numericOnly(withoutSourcePriceQuality(b.bySource)))).toBe(JSON.stringify(numericOnly(ref.bySource)));
      expect(JSON.stringify(numericOnly(b.byModel))).toBe(JSON.stringify(numericOnly(ref.byModel)));
      // The fixture rows store non-neutral valuation values; the comparisons above show that none of them reaches any reported aggregate.
      expect((db.prepare('SELECT COUNT(*) AS n FROM events WHERE ucu IS NOT NULL').get() as { n: number }).n).toBeGreaterThan(0);
    }
    // Pages of 500 over 6,000 rows: the aggregate read alone yields at each full page, before any assembly yield.
    expect(yields).toBeGreaterThanOrEqual(12);
  });
});

it('streaming Summary preserves one whole snapshot when capture commits during the aggregate pages', async () => {
  const owned = seedFile(fixtureRows(6000, 43));
  const config = defaultConfig({ hostLabel: 'M4a' }), now = () => BASE + 9_000_000;
  try {
    const expected = await createQueries(owned.db, config, { now, probeOllama: stubProbe }).getSummary('all');
    let committed = false;
    const streamed = createQueries(owned.db, config, { now, probeOllama: stubProbe, readSnapshotFile: owned.file, pageRows: 500,
      yieldNow: async () => {
        if (committed) return;
        owned.db.prepare(`INSERT INTO events(id,host,source,ts,ts_source,session_id,model,provider,components_json,
          price_status,price_version,ucu_rate_status,eacs_def_sha256,input_fresh,output)
          VALUES('during-stream','M4a','claude',?,'line','new-session','new-model','anthropic','[]','LIST','v','NONE','h',123,456)`).run(BASE + 300);
        owned.db.prepare(`INSERT INTO activity(host,source,session_id,ts,uuid,duration_ms)
          VALUES('M4a','claude','new-session',?,'during-stream-mark',37)`).run(BASE + 300);
        committed = true;
      },
    });
    expect(await streamed.getSummary('all')).toEqual(expected); expect(committed).toBe(true);
    expect(owned.db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n).toBe(6001);
    expect((await createQueries(owned.db, config, { now, probeOllama: stubProbe }).getSummary('all')).totals.events).toBe(6001);
    expect(owned.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy).toBe(0);
  } finally { owned.db.close(); fs.rmSync(owned.dir, { recursive: true, force: true }); }
});

it('sync and snapshot Summary paths exclude copied UUID timestamps from wall time', async () => {
  const owned = seedFile([]);
  const config = defaultConfig({ hostLabel: 'M4a' });
  const now = () => BASE + 20_000_000;
  try {
    const insert = owned.db.prepare('INSERT INTO activity(host,source,session_id,ts,uuid,duration_ms) VALUES(?,?,?,?,?,?)');
    insert.run('M4a', 'claude', 'claude-session', BASE + 100, 'copied-line', null);
    insert.run('M4a', 'claude', 'claude-session', BASE + 200, null, null);
    insert.run('M4a', 'codex', 'codex-session', BASE + 10_000_000, 'copied-line', null);
    insert.run('M4a', 'codex', 'codex-session', BASE + 10_000_100, null, null);

    const sync = await createQueries(owned.db, config, { now, probeOllama: stubProbe }).getSummary('all');
    const snapshot = await createQueries(owned.db, config, {
      now, probeOllama: stubProbe, readSnapshotFile: owned.file, pageRows: 1, yieldNow: async () => {},
    }).getSummary('all');
    expect(sync.activeTime).toEqual({ agentMs: 100, wallMs: 100 });
    expect(snapshot.activeTime).toEqual(sync.activeTime);
  } finally {
    owned.db.close();
    fs.rmSync(owned.dir, { recursive: true, force: true });
  }
});

it('a streaming producer can reuse its row object without changing first model identity or ordered fractional sums', () => {
  const first = toAgg({ ...fixtureRows(1, 17)[0]!, source: 'claude', provider: 'anthropic', model: 'first', priceStatus: 'LIST', apiEquivUsd: 0.1, thinking: 0 });
  const second = { ...first, model: 'second', api_equiv_usd: 0.2 };
  const expected = drainSteps(summaryAggregateSteps([first, second], displayName));
  const aggregate = new SummaryAggregate(displayName), reused = { ...first };
  aggregate.add(reused); Object.assign(reused, second); aggregate.add(reused);
  expect(aggregate.events).toBe(2); expect(aggregate.finish()).toEqual(expected);
});

/** A fixture row as the aggregate read returns it (the columns Summary folds). */
function toAgg(f: FixtureRow): RawEventAgg {
  return {
    source: f.source,
    model: f.model,
    provider: f.provider,
    price_status: f.priceStatus,
    api_equiv_usd: f.apiEquivUsd,
    input_fresh: f.tokens,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: f.tokens,
    reasoning: 0,
    thinking: f.thinking,
  };
}

describe('the assembly yields between steps, and the drained result is the same', () => {
  it('yields once per AGG_STEP_ROWS rows, and the drained steps equal a fresh fold', () => {
    const rows = fixtureRows(AGG_STEP_ROWS * 2 + 300, 11).map(toAgg);
    const gen = summaryAggregateSteps(rows, displayName);
    let pauses = 0;
    let r = gen.next();
    while (!r.done) {
      pauses++;
      r = gen.next();
    }
    expect(pauses).toBe(2); // rows at AGG_STEP_ROWS and 2 × AGG_STEP_ROWS are the two pauses
    const drained = drainSteps(summaryAggregateSteps(rows, displayName));
    expect(JSON.stringify(numericOnly(drained))).toBe(JSON.stringify(numericOnly(r.value)));
  });
});

describe('handcrafted buckets: unpriced and unknown thinking', () => {
  const row = (o: Partial<RawEventAgg> & Pick<RawEventAgg, 'source' | 'model'>): RawEventAgg => ({
    provider: 'anthropic',
    price_status: 'LIST',
    api_equiv_usd: 1,
    input_fresh: 1,
    cache_write_5m: 0,
    cache_write_1h: 0,
    cache_read: 0,
    output: 1,
    reasoning: 0,
    thinking: 1,
    ...o,
  });
  const rows: RawEventAgg[] = [
    row({ source: 'claude', model: 'm-a', api_equiv_usd: 1.5 }),
    row({ source: 'claude', model: 'm-a', price_status: 'UNPRICED', api_equiv_usd: null }),
    row({ source: 'claude', model: 'm-a', price_status: 'ESTIMATE', api_equiv_usd: 0.25 }),
    row({ source: 'codex', model: 'm-b', thinking: null, price_status: 'UNPRICED', api_equiv_usd: null }),
    row({ source: 'codex', model: 'm-b', thinking: 0, api_equiv_usd: 2 }),
  ];

  it('gives the exact totals, the unpriced count, the null-only USD rule, the unknown bucket and the price precedence', () => {
    const parts = drainSteps(summaryAggregateSteps(rows, (m) => `name:${m}`));
    expect(parts.unpricedEvents).toBe(2);
    expect(parts.apiEquivUsd).toBe(1.5 + 0.25 + 2);
    expect(parts.totalsTokens.output).toBe(5);
    expect(parts.bySource.claude!.events).toBe(3);
    expect(parts.bySource.claude!.apiEquivUsd).toBe(1.5 + 0.25);
    expect(parts.bySource.codex!.apiEquivUsd).toBe(2);

    // Order: most events first, ties in first-seen order (claude m-a, then codex m-b unknown, then codex m-b non-thinking).
    expect(parts.byModel.map((m) => `${m.model}/${m.thinking}`)).toEqual(['m-a/thinking', 'm-b/unknown', 'm-b/non-thinking']);
    const mA = parts.byModel[0]!;
    expect(mA.displayName).toBe('name:m-a');
    expect(mA.priceStatus).toBe('UNPRICED'); // any UNPRICED row makes the group UNPRICED, even with an ESTIMATE row
    expect(mA.apiEquivUsd).toBe(1.5 + 0.25);
    const mBUnknown = parts.byModel[1]!;
    expect(mBUnknown.apiEquivUsd).toBeNull(); // every row null: the group reports null, not 0
    expect(mBUnknown.priceStatus).toBe('UNPRICED');
    expect(parts.byModel[2]!.priceStatus).toBe('LIST');
  });

  it('an empty result gives zero totals', () => {
    const parts = drainSteps(summaryAggregateSteps([], (m) => m));
    expect(parts.totalsTokens).toEqual({ ...ZERO_TOKENS });
    expect(parts.byModel).toEqual([]);
  });
});

// Independent expected categories/quality: these cases exercise the aggregate targets,
// rather than comparing two paths through the same production count helper.
describe('Summary count quality and optional categories', () => {
  const row = (fields: Partial<RawEventAgg>): RawEventAgg => ({
    source: 'claude', model: 'quality-fixture', provider: 'anthropic',
    price_status: 'LIST',
    api_equiv_usd: 0, input_fresh: 0, cache_write_5m: 0, cache_write_1h: 0,
    cache_read: 0, output: 0, reasoning: 0, thinking: null, ...fields,
  });
  const targets = (rows: RawEventAgg[]) => {
    const parts = drainSteps(summaryAggregateSteps(rows, model => model));
    expect(parts.byModel).toHaveLength(1);
    expect(parts.bySource.claude!.events).toBe(rows.length);
    return [parts.totalsTokens, parts.bySource.claude!.tokens, parts.byModel[0]!.tokens];
  };
  it('a recorded legacy zero is not an empty target before a complete row', () => {
    const expected = { ...ZERO_TOKENS, inputFresh: 1, countQuality: 'unrecorded' };
    for (const actual of targets([
      row({ count_quality: 'unrecorded' }),
      row({ input_fresh: 1, count_quality: 'complete' }),
    ])) expect(actual).toEqual(expected);
  });
  it('retains optional TTL amounts and an independent count-quality override in each target', () => {
    const expected = { inputFresh: 9, cacheWrite5m: 11, cacheWrite1h: 13,
      cacheRead: 0, output: 0, reasoning: 0, cacheWriteUnassigned: 5,
      cacheWriteAssumed1h: 6, countQuality: 'incomplete', ucuCountQuality: 'complete' };
    for (const actual of targets([
      row({ input_fresh: 2, cache_write_5m: 3, cache_write_1h: 4,
        cache_write_unassigned: 5, cache_write_assumed_1h: 6,
        count_quality: 'incomplete', ucu_count_quality: 'complete' }),
      row({ input_fresh: 7, cache_write_5m: 8, cache_write_1h: 9,
        count_quality: 'complete' }),
    ])) expect(actual).toEqual(expected);
  });
  it('does not report complete counts when individually safe values overflow a target', () => {
    const expected = { ...ZERO_TOKENS, inputFresh: 9007199254740992, countQuality: 'invalid' };
    for (const actual of targets([
      row({ input_fresh: Number.MAX_SAFE_INTEGER, count_quality: 'complete' }),
      row({ input_fresh: 1, count_quality: 'complete' }),
    ])) expect(actual).toEqual(expected);
  });
});
