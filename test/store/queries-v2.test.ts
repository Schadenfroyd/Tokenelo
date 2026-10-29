/**
 * store/queries.ts integration fixes (M1 findings 1, 8, 9): the LocalValue block (comparator values
 * explicitly unavailable, energy / net / decode tok/s), limits keyed by (source, account, limitId) +
 * live Claude block estimate, doctor codex per-file counts from ingest_state summaries, ollama
 * servers[] from the probe.
 *
 * Money figures are hand-computed below from the real pricing rate file (rates/prices.json), whose
 * relevant values are asserted first (so a rates change fails loudly here instead of silently
 * shifting the maths): claude-sonnet-5 and gpt-6-sol both list $2 in / $10 out per M.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import {
  createQueries as realCreateQueries,
  computeLocalValue,
  estimateLocalEnergy,
  weightedDecodeTokPerSec,
  executablePathOnly,
  type CreateQueriesOpts,
} from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type { TokeneloConfig, UsageEvent } from '../../src/core/types.js';
import type { OllamaProbeResult } from '../../src/collectors/ollama-probe.js';
import { createProfiler, setActiveProfiler } from '../../src/core/phase-profile.js';

const NOW = Date.UTC(2026, 8, 26, 18, 0, 0);
const HOUR = 3_600_000;
const pricing = defaultPricingEngine();
const computeUnits = createNullEngine();

let db: TokeneloDb;
let ledger: SqliteLedger;
let config: TokeneloConfig;

const emptyProbe = async (): Promise<OllamaProbeResult> => ({ servers: [], manifests: new Map(), generatedAt: 0 });
function createQueries(o?: CreateQueriesOpts) {
  return realCreateQueries(db, config, { now: () => NOW, pricing, probeOllama: emptyProbe, ...o });
}

function ev(p: {
  id: string;
  model: string;
  source?: UsageEvent['source'];
  provider?: UsageEvent['provider'];
  ts?: number;
  host?: string;
  inputFresh: number;
  output: number;
  durationMs?: number;
  decode?: number;
}): UsageEvent {
  const tokens = { inputFresh: p.inputFresh, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: p.output, reasoning: 0 };
  const e: UsageEvent = {
    id: p.id,
    host: p.host ?? 'M4a',
    source: p.source ?? 'ollama-log',
    ts: p.ts ?? NOW - HOUR,
    tsSource: 'line',
    sessionId: 's',
    isSubagent: false,
    model: p.model,
    provider: p.provider ?? pricing.providerOf(p.model),
    components: [{ model: p.model, tokens }],
    tokens,
    flags: [],
    apiEquivUsd: null,
    priceStatus: 'UNPRICED',
    priceVersion: '',
    reservedValue: null,
    ucuRateStatus: 'NONE',
    eacsDefSha256: '',
  };
  if (p.durationMs !== undefined) e.durationMs = p.durationMs;
  if (p.decode !== undefined) e.perf = { decodeTokPerSec: p.decode };
  return e;
}

beforeEach(() => {
  db = openDb({ file: ':memory:' });
  ledger = new SqliteLedger(db, pricing, computeUnits);
  config = defaultConfig({ hostLabel: 'M4a' });
});

afterEach(() => {
  db.close();
});

describe('price-file values the hand computations below depend on', () => {
  it('are what the comments say', () => {
    expect(pricing.resolve('claude-sonnet-5')!.rates).toMatchObject({ in: 2, out: 10 });
    expect(pricing.resolve('gpt-6-sol')!.rates).toMatchObject({ in: 2, out: 10 });
  });
});

describe('getSummary().local — finding 1 (comparator values explicitly unavailable; energy, net and decode kept)', () => {
  function seedLocal(): void {
    ledger.upsertEvents([
      ev({ id: 'A', model: 'gemma4:26b', inputFresh: 1000, output: 500, durationMs: 1_800_000, decode: 50 }),
      ev({ id: 'B', model: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL', inputFresh: 3000, output: 1000, durationMs: 1_800_000, decode: 100 }),
      ev({ id: 'C', model: 'mystery-local-xyz', provider: 'local', inputFresh: 10, output: 10, durationMs: 0 }),
      // Outside the 7d range: must not leak into the range's value (the old code used all-time events).
      ev({ id: 'OLD', model: 'gemma4:26b', ts: NOW - 8 * 24 * HOUR, inputFresh: 999_999, output: 999_999, durationMs: 1 }),
      // Non-local event: never part of the local value.
      ev({ id: 'CLOUD', model: 'claude-sonnet-5', source: 'claude', inputFresh: 5000, output: 5000 }),
    ]);
  }

  it('comparator values are explicitly unavailable (unknown, never zero); energy, net and decode are unchanged', async () => {
    seedLocal();
    const local = (await createQueries().getSummary('7d')).local;
    expect(local.captured).toBe(true);
    expect(local.valueVsClaude.usd).toBeNull();
    expect(local.valueVsGpt.usd).toBeNull();
    expect(local.valueVsClaude).toEqual({ usd: null, comparator: 'claude-sonnet-5', status: 'NONE', unratedEvents: 0 });
    expect(local.valueVsGpt).toEqual({ usd: null, comparator: 'gpt-6-sol', status: 'NONE', unratedEvents: 0 });
    // No watts/tariff configured → energy unknown → net is null (never the gross value relabelled).
    expect(local.energy).toEqual({ kwh: null, usd: null, status: 'NONE' });
    expect(local.netSavingsVsClaude).toBeNull();
    // decode: (500 + 1000) tokens / (500/50 + 1000/100) s = 1500 / 20 = 75 tok/s
    expect(local.decodeTokPerSec).toBeCloseTo(75, 12);
  });

  it('with watts + tariff: energy ESTIMATE (hand-computed); net stays unknown because the comparator value is unavailable', async () => {
    seedLocal();
    config = { ...config, local: { ...config.local, wattsEstimate: 60, tariffUsdPerKwh: 0.3 } };
    const local = (await createQueries().getSummary('7d')).local;
    // Σ durationMs in range = 1.8e6 + 1.8e6 + 0 = 3.6e6 ms = 1 h; 60 W → 0.06 kWh; × $0.30 = $0.018
    expect(local.energy.status).toBe('ESTIMATE');
    expect(local.energy.kwh).toBeCloseTo(0.06, 12);
    expect(local.energy.usd).toBeCloseTo(0.018, 12);
    expect(local.netSavingsVsClaude).toBeNull();
    expect(local.netSavingsVsClaudeStatus).toBe('NONE');
  });

  it('capture "off" and no local events → "local capture not configured", never $0', async () => {
    config = { ...config, local: { ...config.local, capture: 'off' } };
    const local = (await createQueries().getSummary('7d')).local;
    expect(local.captured).toBe(false);
    expect(local.reason).toBe('local capture not configured');
    expect(local.valueVsClaude.usd).toBeNull();
  });

  it('capture configured but no local events in range → captured, and the comparator value is still unavailable (never $0)', async () => {
    const local = (await createQueries().getSummary('7d')).local;
    expect(local.captured).toBe(true);
    expect(local.valueVsClaude).toEqual({ usd: null, comparator: 'claude-sonnet-5', status: 'NONE', unratedEvents: 0 });
  });
});

describe('estimateLocalEnergy / weightedDecodeTokPerSec / computeLocalValue units', () => {
  it('energy is NONE when any event lacks durationMs (no silent undercount) or when not configured', () => {
    expect(estimateLocalEnergy([{ durationMs: 1000 }, {}], 60, 0.3).status).toBe('NONE');
    expect(estimateLocalEnergy([{ durationMs: 1000 }], undefined, 0.3).status).toBe('NONE');
    expect(estimateLocalEnergy([{ durationMs: 1000 }], 60, undefined).status).toBe('NONE');
    // 7.2e6 ms = 2 h × 150 W = 0.3 kWh × $0.25 = $0.075
    expect(estimateLocalEnergy([{ durationMs: 7_200_000 }], 150, 0.25)).toEqual({ kwh: 0.3, usd: 0.075, status: 'ESTIMATE' });
  });

  it('decode average ignores events without perf and is undefined when none report it', () => {
    const t = (o: number) => ({ inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: o, reasoning: 0 });
    expect(weightedDecodeTokPerSec([{ tokens: t(100) }])).toBeUndefined();
    expect(weightedDecodeTokPerSec([{ tokens: t(100), perf: { decodeTokPerSec: 20 } }, { tokens: t(50) }])).toBe(20);
  });

  it('computeLocalValue reports both comparators as unavailable (usd null, status NONE), never a value', () => {
    const lv = computeLocalValue(config, [ev({ id: 'x', model: 'mystery-local-xyz', provider: 'local', inputFresh: 1, output: 1 })]);
    expect(lv.valueVsClaude).toEqual({ usd: null, comparator: 'claude-sonnet-5', status: 'NONE', unratedEvents: 0 });
    expect(lv.valueVsGpt).toEqual({ usd: null, comparator: 'gpt-6-sol', status: 'NONE', unratedEvents: 0 });
  });
});

describe('subscriptions are charged only their own kind', () => {
  it('a claude account is not charged codex spend on the same host', async () => {
    config.accounts = [{ id: 'c', kind: 'claude', hosts: ['M4a'], monthlyUsd: 300 }];
    db.prepare(
      `INSERT INTO events (id, host, source, ts, ts_source, session_id, model, provider, components_json, price_status, price_version, ucu_rate_status, eacs_def_sha256, api_equiv_usd)
       VALUES ('a','M4a','claude',?, 'line','s','m','anthropic','[]','LIST','v','NONE','x', 10),
              ('b','M4a','codex', ?, 'line','s','m','openai','[]','LIST','v','NONE','x', 90)`
    ).run(NOW - 1000, NOW - 1000);
    const sub = (await createQueries().getSummary('7d')).subscriptions[0]!;
    expect(sub.apiEquivUsd).toBe(10);
    expect(sub.billedUsd).toBeCloseTo(70, 10); // 300 × 7/30
  });
});

describe('getLimits — finding 8', () => {
  it('Codex snapshots stay separate per limitId (newest per id); the Claude block estimate is included with filled window fields', async () => {
    config.accounts = [{ id: 'acct-codex', kind: 'codex', hosts: ['M4a'] }];
    ledger.recordLimits({ source: 'codex', limitId: 'codex', host: 'M4a', capturedAt: 100, windows: [{ id: 'primary', usedPercent: 44 }], estimate: false });
    ledger.recordLimits({ source: 'codex', limitId: 'codex', host: 'M4a', capturedAt: 200, windows: [{ id: 'primary', usedPercent: 46 }], estimate: false });
    ledger.recordLimits({ source: 'codex', limitId: 'codex_bengalfox', host: 'M4a', capturedAt: 900, windows: [{ id: 'primary', usedPercent: 0 }], estimate: false });

    // Claude activity 00:30, 04:50, 05:10, 09:20 (every gap < 5 h, so the chain starts at 00:30):
    // blocks [00:00, 05:00] (00:30, 04:50), then 05:10 > 05:00 → [05:00, 10:00] (05:10, 09:20).
    // A reader that looked back only 5 h from the last activity (04:20) would see 04:50 first and
    // wrongly produce [04:00, 09:00] then [09:00, 14:00] — the LAG() anchor avoids that.
    const d = (h: number, m: number) => Date.UTC(2026, 8, 26, h, m, 0);
    ledger.recordActivity([
      { source: 'claude', sessionId: 's', ts: d(0, 30), uuid: 'u1', host: 'M4a' },
      { source: 'claude', sessionId: 's', ts: d(4, 50), uuid: 'u2', host: 'M4a' },
      { source: 'claude', sessionId: 's', ts: d(5, 10), uuid: 'u3', host: 'M4a' },
      { source: 'claude', sessionId: 's', ts: d(9, 20), uuid: 'u4', host: 'M4a' },
    ]);
    ledger.upsertEvents([
      ev({ id: 'claude:1', model: 'claude-sonnet-5', source: 'claude', ts: d(4, 50), inputFresh: 1000, output: 1000 }),
      ev({ id: 'claude:2', model: 'claude-sonnet-5', source: 'claude', ts: d(5, 10), inputFresh: 1000, output: 2000 }),
    ]);
    const now = d(9, 30);
    const res = await realCreateQueries(db, config, { now: () => now, pricing, probeOllama: emptyProbe }).getLimits();

    const codex = res.snapshots.filter((s) => s.source === 'codex');
    expect(codex.map((s) => [s.limitId, s.capturedAt]).sort()).toEqual([
      ['codex', 200],
      ['codex_bengalfox', 900],
    ]);
    expect(codex.every((s) => s.account === 'acct-codex' && s.host === 'M4a')).toBe(true);
    const block = res.snapshots.find((s) => s.source === 'claude-block-estimate')!;
    const w = block.windows[0]!;
    expect(w.startedAt).toBe(d(5, 0));
    expect(w.resetsAt).toBe(d(10, 0));
    expect(w.tokens).toBe(3000); // only claude:2 (1000 + 2000) is inside [05:00, 10:00]
    // claude:2 priced at sonnet-5 list: 1000 × $2/M + 2000 × $10/M = $0.022
    expect(w.apiEquivUsd).toBeCloseTo(0.022, 12);
    // elapsed 4.5 h (270 min), remaining 0.5 h: burn 3000/270 tok/min; projected 3000 × 5/4.5
    expect(w.burnTokensPerMin).toBeCloseTo(3000 / 270, 9);
    expect(w.projectedTokens).toBeCloseTo(3000 * (5 / 4.5), 9);
    expect(w.projectedUsd).toBeCloseTo(0.022 * (5 / 4.5), 12);
    expect(w.usedPercent).toBeNull();
  });

  it('keeps stored limit snapshots host-scoped when configured account IDs are blank', async () => {
    config.accounts = [
      { id: '', kind: 'codex', hosts: ['A'] },
      { id: '', kind: 'codex', hosts: ['B'] },
    ];
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'A', account: '', capturedAt: 100, windows: [{ id: 'primary', usedPercent: 10 }], estimate: false });
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'B', account: '', capturedAt: 200, windows: [{ id: 'primary', usedPercent: 20 }], estimate: false });

    const codex = (await createQueries().getLimits()).snapshots.filter((snapshot) => snapshot.source === 'codex');
    expect(codex).toHaveLength(2);
    expect(codex.map((snapshot) => snapshot.host).sort()).toEqual(['A', 'B']);
    expect(codex.every((snapshot) => snapshot.account === '')).toBe(true);
  });

  it('keeps stored limit snapshots host-scoped when configured account IDs are whitespace', async () => {
    config.accounts = [
      { id: '   ', kind: 'codex', hosts: ['A'] },
      { id: '   ', kind: 'codex', hosts: ['B'] },
    ];
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'A', account: '   ', capturedAt: 100, windows: [{ id: 'primary', usedPercent: 10 }], estimate: false });
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'B', account: '   ', capturedAt: 200, windows: [{ id: 'primary', usedPercent: 20 }], estimate: false });

    const codex = (await createQueries().getLimits()).snapshots.filter((snapshot) => snapshot.source === 'codex');
    expect(codex).toHaveLength(2);
    expect(codex.map((snapshot) => snapshot.host).sort()).toEqual(['A', 'B']);
    expect(codex.every((snapshot) => snapshot.account === '   ')).toBe(true);
  });

  it.each(['', '   '])('uses the configured account for a blank stored snapshot ID (%j)', async blankAccount => {
    config.accounts = [{ id: 'acct-codex', kind: 'codex', hosts: ['A'] }];
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'A', account: 'acct-codex', capturedAt: 100, windows: [{ id: 'primary', usedPercent: 10 }], estimate: false });
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'A', account: blankAccount, capturedAt: 200, windows: [{ id: 'primary', usedPercent: 20 }], estimate: false });

    const codex = (await createQueries().getLimits()).snapshots.filter((snapshot) => snapshot.source === 'codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ host: 'A', account: 'acct-codex', capturedAt: 200 });
    expect(codex[0]!.windows[0]?.usedPercent).toBe(20);
  });

  it('does not let an earlier blank account mapping shadow a configured account ID', async () => {
    config.accounts = [
      { id: '', kind: 'codex', hosts: ['A'] },
      { id: 'acct-codex', kind: 'codex', hosts: ['A'] },
    ];
    ledger.recordLimits({ source: 'codex', limitId: 'primary', host: 'A', account: '', capturedAt: 200, windows: [{ id: 'primary', usedPercent: 20 }], estimate: false });

    const codex = (await createQueries().getLimits()).snapshots.filter((snapshot) => snapshot.source === 'codex');
    expect(codex).toHaveLength(1);
    expect(codex[0]).toMatchObject({ host: 'A', account: 'acct-codex', capturedAt: 200 });
  });
});

describe('getDoctor — finding 9', () => {
  it('returns zero census counters for an empty ledger', async () => {
    const doc = await createQueries().getDoctor();
    expect(doc.priceEvidence.events).toBe(0);
    expect(doc.thinkingUnknownEvents).toBe(0);
    expect(doc.claude).toEqual({ speedAssumed: 0, cacheSplitAssumed: 0, iterationEvents: 0, reasoningClamped: 0 });
  });

  it('keeps source/null and stored flag-label semantics while excluding other-source malformed components', async () => {
    ledger.upsertEvents([
      ev({ id: 'census-claude', source: 'claude', model: 'claude-sonnet-5', inputFresh: 1, output: 2 }),
      ev({ id: 'census-codex', source: 'codex', model: 'gpt-6-sol', inputFresh: 1, output: 2 }),
      ev({ id: 'census-local', source: 'ollama-log', model: 'gemma4:26b', inputFresh: 1, output: 2 }),
    ]);
    db.prepare(`UPDATE events SET flags_json = ?, components_json = ?, thinking = ? WHERE id = ?`)
      .run('{"speedAssumed":false,"cacheSplitAssumed":true,"reasoningClamped":true}', '[{},{}]', 0, 'census-claude');
    db.prepare(`UPDATE events SET flags_json = ?, components_json = ?, thinking = NULL WHERE id IN (?,?)`)
      .run('["speedAssumed","cacheSplitAssumed","reasoningClamped"]', 'not-json', 'census-codex', 'census-local');
    const doc = await createQueries().getDoctor();
    expect(doc.priceEvidence.events).toBe(3);
    expect(doc.thinkingUnknownEvents).toBe(2);
    expect(doc.claude).toEqual({ speedAssumed: 1, cacheSplitAssumed: 1, iterationEvents: 1, reasoningClamped: 1 });
    expect(doc.warnings.some(w => w.startsWith('ollama-log:') && w.includes('1 event(s)'))).toBe(true);
  });

  it('still refuses malformed Claude components rather than silently omitting their count', async () => {
    ledger.upsertEvents([ev({ id: 'census-bad-claude', source: 'claude', model: 'claude-sonnet-5', inputFresh: 1, output: 2 })]);
    db.prepare('UPDATE events SET components_json = ? WHERE id = ?').run('not-json', 'census-bad-claude');
    await expect(createQueries().getDoctor()).rejects.toThrow();
  });

  it('refuses an already cancelled census before entering any query or probe', async () => {
    const controller = new AbortController(), reason = new Error('census cancelled');
    controller.abort(reason);
    let probes = 0;
    const queries = createQueries({ probeOllama: async () => { probes++; return emptyProbe(); } });
    await expect(queries.getDoctor({ signal: controller.signal })).rejects.toBe(reason);
    expect(probes).toBe(0);
  });

  it('propagates report cancellation through the probe rather than converting it into an empty server warning', async () => {
    const controller = new AbortController(), reason = new Error('owned read cancelled');
    const queries = createQueries({ probeOllama: async (_upstream, signal) => {
      expect(signal).toBe(controller.signal); controller.abort(reason); throw reason;
    } });
    await expect(queries.getDoctor({ signal: controller.signal })).rejects.toBe(reason);
  });

  it('records static SQL phases and an awaited probe interval without counting probe waiting as synchronous work', async () => {
    let clock = 1; const lines: Record<string, unknown>[] = [];
    const profiler = createProfiler({ sink: { write: line => lines.push(line), flush() {} }, now: () => clock++ });
    setActiveProfiler(profiler);
    try {
      const diagnosticPhases: string[] = [];
      const queries = createQueries({ probeOllama: async () => { clock += 1000; return emptyProbe(); } });
      await queries.getDoctor({ onDiagnosticPhase: phase => diagnosticPhases.push(phase) }); profiler.close();
      const encoded = JSON.stringify(lines);
      expect(encoded).toContain('doctor.event-census'); expect(encoded).toContain('doctor.ollama-probe');
      expect(diagnosticPhases).toContain('doctor.event-census.money-sum');
      expect(diagnosticPhases).toContain('doctor.event-census.row-batches');
      const stats = lines.filter(line => line.type === 'stats').flatMap(line => Object.entries(line.phases as Record<string, { maxMs: number }>));
      expect(stats.filter(([name]) => name.startsWith('doctor.')).every(([, value]) => value.maxMs < 1000)).toBe(true);
      expect(encoded).not.toContain(config.local.ollamaUpstream);
    } finally { setActiveProfiler(null); }
  });

  function seedState(key: string, extra: unknown): void {
    ledger.setState({ key, size: 1, mtimeMs: 1, offset: 1, extra });
  }

  it('codex per-file counts come from ingest_state summaries (hand-seeded), claude/serverlog rows ignored', async () => {
    seedState('/c/f1.jsonl', { v: 1, lineIndex: 9, summary: { tokenCountEvents: 5, resets: 2, baselineTotal: 0, replayEvents: 0, olderTurnEvents: 0, inheritedBaselineSuspect: false, recordEvents: 3, nonZeroCacheWrite: 0 } });
    seedState('/c/f2.jsonl', { v: 1, lineIndex: 9, summary: { tokenCountEvents: 1, resets: 0, baselineTotal: 1000, replayEvents: 0, olderTurnEvents: 0, inheritedBaselineSuspect: true, recordEvents: 0, nonZeroCacheWrite: 2 } });
    seedState('/c/f3.jsonl', { v: 1, lineIndex: 9, summary: { tokenCountEvents: 0, resets: 0, baselineTotal: 0, replayEvents: 4, olderTurnEvents: 0, inheritedBaselineSuspect: false, recordEvents: 0, nonZeroCacheWrite: 0 } });
    // §15.10.1 wrapper-nested own events (2 + 1 in two files) and one file with finalized trailing records
    seedState('/c/f4.jsonl', { v: 1, lineIndex: 9, summary: { tokenCountEvents: 9, resets: 0, baselineTotal: 7, replayEvents: 0, olderTurnEvents: 0, inheritedBaselineSuspect: false, recordEvents: 0, nonZeroCacheWrite: 0, ownInWrapperEvents: 2, trailingRecords: 1 } });
    seedState('/c/f5.jsonl', { v: 1, lineIndex: 9, summary: { tokenCountEvents: 3, resets: 0, baselineTotal: 0, replayEvents: 0, olderTurnEvents: 0, inheritedBaselineSuspect: false, recordEvents: 0, nonZeroCacheWrite: 0, ownInWrapperEvents: 1, trailingRecords: 0 } });
    seedState('/claude/x.jsonl', undefined);
    seedState('ollama-serverlog:/l.log', { offset: 5, currentModel: null });
    const doc = await createQueries().getDoctor();
    // inheritedBaselineFiles: f2 (baseline 1000), f3 (replay 4), f4 (baseline 7) = 3; ownInWrapper: f4 + f5, 2 + 1 = 3
    expect(doc.codex).toEqual({
      resetFiles: 1, inheritedBaselineFiles: 3, suspectFiles: 1, recordReconciledFiles: 1, nonZeroCacheWrite: 2,
      ownInWrapperFiles: 2, ownInWrapperEvents: 3, trailingRecordFiles: 1,
    });
    expect(doc.warnings.some((w) => w.includes('non-zero cache_write_input_tokens'))).toBe(true);
  });

  it('ollama.servers lists every LIVE server from the probe (IPv4 + IPv6), with binary/log; a silent listener becomes a warning', async () => {
    const probe = async (): Promise<OllamaProbeResult> => ({
      generatedAt: 0,
      manifests: new Map(),
      servers: [
        { address: '127.0.0.1', port: 11434, family: 'IPv4', reachable: true, version: '0.32.13', process: { pid: 1, command: '/opt/homebrew/bin/ollama', family: 'IPv4', localAddress: '127.0.0.1', port: 11434 }, log: { path: '/opt/homebrew/var/log/ollama.log', source: 'homebrew', available: true } },
        { address: '::1', port: 11434, family: 'IPv6', reachable: true, version: '0.34.2', process: { pid: 2, command: '/Applications/Ollama.app/Contents/Resources/ollama', family: 'IPv6', localAddress: '*', port: 11434 }, log: { path: null, source: 'ollama-app', available: false } },
        { address: '127.0.0.1', port: 11434, family: 'IPv4', reachable: false, version: null, process: { pid: 3, command: 'x', family: 'IPv4', localAddress: '127.0.0.1', port: 11434 }, log: { path: null, source: 'unknown', available: false } },
      ],
    });
    const doc = await createQueries({ probeOllama: probe }).getDoctor();
    expect(doc.ollama.servers).toEqual([
      { address: '127.0.0.1', family: 'IPv4', version: '0.32.13', binary: '/opt/homebrew/bin/ollama', logPath: '/opt/homebrew/var/log/ollama.log', logAvailable: true },
      { address: '::1', family: 'IPv6', version: '0.34.2', binary: '/Applications/Ollama.app/Contents/Resources/ollama', logAvailable: false },
    ]);
    expect(doc.ollama.capture).toBe('both'); // M4a default
    expect(doc.warnings.filter((w) => w.startsWith('ollama:'))).toHaveLength(1);
  });

  it('a throwing probe degrades to servers [] + a warning, never a failed doctor', async () => {
    const doc = await createQueries({ probeOllama: async () => { throw new Error('lsof missing'); } }).getDoctor();
    expect(doc.ollama.servers).toEqual([]);
    expect(doc.warnings.some((w) => w.includes('lsof missing'))).toBe(true);
  });

  it('ollama-log events (thinking always NULL, per collectors/ollama-serverlog.ts) get their own doctor warning + are included in thinkingUnknownEvents', async () => {
    ledger.upsertEvents([
      ev({ id: 'log1', model: 'gemma4:26b', source: 'ollama-log', inputFresh: 10, output: 5 }),
      ev({ id: 'log2', model: 'gemma4:26b', source: 'ollama-log', inputFresh: 10, output: 5 }),
      // A non-ollama-log event with unknown thinking must be counted in the total but NOT drive the ollama-log-specific warning's count.
      ev({ id: 'claude1', model: 'claude-sonnet-5', source: 'claude', inputFresh: 10, output: 5 }),
    ]);
    const doc = await createQueries().getDoctor();
    expect(doc.thinkingUnknownEvents).toBe(3);
    expect(doc.warnings.some((w) => w.startsWith('ollama-log:') && w.includes('2 event(s)'))).toBe(true);
  });

  // Security audit #10: doctor must report only the LISTENER'S EXECUTABLE PATH, never its full
  // argv — `ps -ww -o command=` (ollama-probe.ts) returns the whole command line, e.g. flags that
  // could carry values an operator wouldn't expect to end up in a diagnostics report.
  it('strips argv from the process command before it reaches doc.ollama.servers[].binary', async () => {
    const probe = async (): Promise<OllamaProbeResult> => ({
      generatedAt: 0,
      manifests: new Map(),
      servers: [
        {
          address: '127.0.0.1',
          port: 11434,
          family: 'IPv4',
          reachable: true,
          version: '0.32.13',
          process: {
            pid: 1,
            command: '/opt/homebrew/bin/ollama serve --secret-flag=super-sensitive-value --another one',
            family: 'IPv4',
            localAddress: '127.0.0.1',
            port: 11434,
          },
          log: { path: null, source: 'homebrew', available: false },
        },
      ],
    });
    const doc = await createQueries({ probeOllama: probe }).getDoctor();
    expect(doc.ollama.servers).toHaveLength(1);
    expect(doc.ollama.servers[0]!.binary).toBe('/opt/homebrew/bin/ollama');
    // mutation check: the argv text must genuinely be gone, not just moved/renamed.
    expect(JSON.stringify(doc.ollama.servers[0])).not.toContain('secret-flag');
    expect(JSON.stringify(doc.ollama.servers[0])).not.toContain('sensitive');
  });
});

describe('executablePathOnly', () => {
  it('keeps a bare executable path untouched', () => {
    expect(executablePathOnly('/opt/homebrew/bin/ollama')).toBe('/opt/homebrew/bin/ollama');
  });

  it('strips everything from the first whitespace onward (flags/argv)', () => {
    expect(executablePathOnly('/opt/homebrew/bin/ollama serve --port 11434')).toBe('/opt/homebrew/bin/ollama');
    expect(executablePathOnly('C:\\Program Files\\Ollama\\ollama.exe serve')).toBe('C:\\Program');
  });

  it('trims leading/trailing whitespace first', () => {
    expect(executablePathOnly('  /usr/bin/ollama  ')).toBe('/usr/bin/ollama');
  });
});
