/**
 * queries.ts's build-item 5/6/2/3 additions: getProcesses, getCoverage, getPlanUsageHistory, and
 * getSessionDetail's desktopMeta attachment. Hand-seeded rows, hand-verified expected output —
 * same convention as queries.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { createQueries as realCreateQueries, PROCESS_LISTING_TTL_MS, PROCESS_LISTING_WAIT_MS, type CreateQueriesOpts } from '../../src/store/queries.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { ProcessInfo, TokeneloConfig } from '../../src/core/types.js';

const stubProbe: NonNullable<CreateQueriesOpts['probeOllama']> = async () => ({ servers: [], manifests: new Map(), generatedAt: 0 });

function createQueries(d: TokeneloDb, c: TokeneloConfig, o?: CreateQueriesOpts) {
  return realCreateQueries(d, c, { probeOllama: stubProbe, listProcesses: async () => [], ...o });
}

let db: TokeneloDb;
let config: TokeneloConfig;

beforeEach(() => {
  db = openDb({ file: ':memory:' });
  config = defaultConfig({ hostLabel: 'M4a' });
});

afterEach(() => {
  db.close();
});

function seedEvent(source: string, ts: number, provider = 'anthropic', engine: string | null = null): void {
  db.prepare(
    `INSERT INTO events (
      id, host, source, ts, ts_source, session_id, is_subagent, model, provider, engine, components_json,
      input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, flags_json,
      api_equiv_usd, price_status, price_version, ucu_rate_status, eacs_def_sha256
    ) VALUES (?, 'M4a', ?, ?, 'line', 's1', 0, 'm', ?, ?, '[]', 10, 0, 0, 0, 5, 0, '[]', 0.1, 'LIST', 'v1', 'MEASURED', 'd1')`
  ).run(`${source}-${ts}`, source, ts, provider, engine);
}

function seedLimit(source: string, capturedAt: number, windowsJson: string): void {
  db.prepare(`INSERT INTO limits (source, host, captured_at, windows_json, estimate) VALUES (?, 'M4a', ?, ?, 0)`).run(
    source,
    capturedAt,
    windowsJson
  );
}

describe('getProcesses', () => {
  it('forwards the injected listProcesses(hostLabel) result verbatim', async () => {
    const proc: ProcessInfo = { pid: 1, ppid: null, startedAt: 1000, exe: '/bin/claude', host: 'M4a', tool: 'claude-code-cli' };
    const q = createQueries(db, config, { listProcesses: async (host) => (host === 'M4a' ? [proc] : []) });
    const res = await q.getProcesses();
    expect(res.host).toBe('M4a');
    expect(res.processes).toEqual([proc]);
  });
});

describe('getCoverage', () => {
  it('exposes aggregate dual-capture settle state without a log path or claiming completeness', async () => {
    config.local.capture = 'both';
    db.prepare(`INSERT INTO ingest_state (key,size,mtime_ms,offset,extra_json) VALUES (?,?,?,?,?)`).run(
      'ollama-serverlog:/Users/private/server.log', 100, 10, 100,
      JSON.stringify({
        offset: 100, currentModel: null, pendingPromptTokens: null, pendingEvalTokens: null, pendingTotalMs: null,
        pendingBlocks: [{ model: 'local-model', promptEvalCount: 10, evalCount: 8, totalMs: 300, endTs: 1_800, durationMs: 500, path: '/api/chat' }],
        historyIncomplete: false, pendingLimitReached: false,
      })
    );
    const q = createQueries(db, config, {
      now: () => 2_000,
      getPrimaryOllamaActiveRequests: () => 1,
      getMeteringBacklogStatus: () => ({ observedAt: 1_990, pending: 0, quarantined: 0, writeFailures: 0,
        failureEvidenceStored: null, historyIncomplete: false, bytes: 0, oldestQueuedAt: null, lastError: null }),
    });
    const res = await q.getCoverage();
    expect(res.localCapture).toMatchObject({ mode: 'both', observedAt: 2_000,
      dualSettle: { state: 'settling', pendingLogEstimates: 1, pendingLimitReached: false,
        historyIncomplete: false, activePrimaryProxyRequests: 1, backlogPending: 0, backlogReviewRequired: false } });
    expect(JSON.stringify(res.localCapture)).not.toContain('server.log');
    expect(JSON.stringify(res.localCapture)).not.toContain('local-model');
  });

  it('reports an absent dual-capture settle row as unobserved, not zero held records', async () => {
    config.local.capture = 'both';
    const q = createQueries(db, config, {
      getPrimaryOllamaActiveRequests: () => 0,
      getMeteringBacklogStatus: () => ({ observedAt: 1_990, pending: 0, quarantined: 0, writeFailures: 0,
        failureEvidenceStored: null, historyIncomplete: false, bytes: 0, oldestQueuedAt: null, lastError: null }),
    });
    const res = await q.getCoverage();
    expect(res.localCapture?.dualSettle).toMatchObject({ state: 'unobserved', pendingLogEstimates: null, pendingLimitReached: null });
  });

  it('separates unsupported collectors from tools outside current capture scope without claiming telemetry', async () => {
    const result = await createQueries(db, config).getCoverage();
    const copilot = result.tools.find(tool => tool.id === 'github-copilot')!;
    expect(copilot).toMatchObject({ captureSupport: 'unsupported', captured: false, lastEventAt: null });
    expect(copilot.reason).toContain('optional local OpenTelemetry token metadata exports');
    expect(result.tools.find(tool => tool.id === 'comfyui')).toMatchObject({ captureSupport: 'not-capturable', captured: false });
    expect(result.tools.find(tool => tool.id === 'claude-code-cli')).not.toHaveProperty('captureSupport');
  });
  it('keeps measured scan completion separate from older usage telemetry and omits unavailable observations', async () => {
    seedEvent('claude', 5000);
    const scans = [{ name: 'claude', intervalMs: 30_000, running: false, rerunQueued: false,
      currentStartedAt: null, lastStartedAt: 9990, lastFinishedAt: 10000, lastCompletedAt: 10000,
      lastFailedAt: null, lastOutcome: 'completed' as const, lastDurationMs: 10,
      lastStats: { filesScanned: 1, filesSkipped: 0, recordsEmitted: 0, bytesRead: 0, warningCount: 0 } }];
    const q = createQueries(db, config, { now: () => 10000, getCollectorScans: () => scans });
    const res = await q.getCoverage();
    expect(res.collectorScans).toEqual(scans);
    expect(res.tools.find((tool) => tool.id === 'claude-code-cli')).toMatchObject({ captured: true, lastEventAt: 5000, lastTelemetryTimeBasis: 'event-recorded' });
    expect(await createQueries(db, config).getCoverage()).not.toHaveProperty('collectorScans');
  });
  it('a running process marks its catalog entry running+installed; a claude source event marks claude-code-cli captured', async () => {
    seedEvent('claude', 5000);
    const proc: ProcessInfo = { pid: 1, ppid: null, startedAt: 1000, exe: '/bin/ollama', host: 'M4a', tool: 'ollama' };
    const q = createQueries(db, config, { listProcesses: async () => [proc] });
    const res = await q.getCoverage();
    const claudeEntry = res.tools.find((t) => t.id === 'claude-code-cli')!;
    expect(claudeEntry.captured).toBe(true);
    expect(claudeEntry.lastEventAt).toBe(5000);
    expect(claudeEntry.lastTelemetryTimeBasis).toBe('event-recorded');
    const ollamaEntry = res.tools.find((t) => t.id === 'ollama')!;
    expect(ollamaEntry.running).toBe(true);
    expect(ollamaEntry.installed).toBe(true);
    const vllmEntry = res.tools.find((t) => t.id === 'vllm')!;
    expect(vllmEntry.running).toBe(false);
    expect(vllmEntry.captured).toBe(false);
    expect(vllmEntry.lastTelemetryTimeBasis).toBeNull();
  });

  it('a claude-desktop LimitSnapshot (not a UsageEvent) marks the claude-desktop entry captured via limitsSource', async () => {
    seedLimit('claude-desktop', 9000, JSON.stringify([{ id: 'five_hour', usedPercent: 10 }]));
    seedEvent('claude', 12000); // A newer unrelated event cannot define the plan timestamp basis.
    const q = createQueries(db, config);
    const res = await q.getCoverage();
    const entry = res.tools.find((t) => t.id === 'claude-desktop')!;
    expect(entry.captured).toBe(true);
    expect(entry.lastEventAt).toBe(9000);
    expect(entry.lastTelemetryTimeBasis).toBe('plan-captured');
    expect(res.tools.find((t) => t.id === 'claude-code-cli')).toMatchObject({ lastEventAt: 12000, lastTelemetryTimeBasis: 'event-recorded' });
  });

  it('matches each local telemetry feed to its actual provider and engine', async () => {
    seedEvent('ollama-log', 2000, 'local');
    seedEvent('ollama-proxy', 3000, 'local', 'ollama');
    seedEvent('ollama-proxy', 4000, 'local', 'vllm');
    seedEvent('claude', 5000, 'local');
    seedEvent('claude', 6000, 'anthropic');

    const res = await createQueries(db, config).getCoverage();
    const entry = (id: string) => res.tools.find((tool) => tool.id === id)!;
    expect(entry('ollama')).toMatchObject({ captured: true, lastEventAt: 3000, lastTelemetryTimeBasis: 'event-recorded' });
    expect(entry('vllm')).toMatchObject({ captured: true, lastEventAt: 4000, lastTelemetryTimeBasis: 'event-recorded' });
    expect(entry('docker-model-runner')).toMatchObject({ captured: false, lastEventAt: null, lastTelemetryTimeBasis: null });
    expect(entry('claude-local-models')).toMatchObject({ captured: true, lastEventAt: 5000, lastTelemetryTimeBasis: 'event-recorded' });
    expect(entry('claude-code-cli')).toMatchObject({ captured: true, lastEventAt: 6000, lastTelemetryTimeBasis: 'event-recorded' });
  });

  it('reports persisted held captures as an explicit aggregate: zero when none, counts/oldest/cap only, no paths', async () => {
    const zero = await createQueries(db, config).getCoverage();
    expect(zero.incompleteCapture).toEqual([{ collector: 'claude', heldFiles: 0, oldestHeldAt: null, maxLineBytes: null }]);
    const zeroDoctor = await createQueries(db, config).getDoctor();
    expect(zeroDoctor.incompleteCapture).toEqual(zero.incompleteCapture);

    const insert = db.prepare('INSERT INTO ingest_state (key, size, mtime_ms, offset, ino, extra_json) VALUES (?, ?, ?, ?, ?, ?)');
    const secretPath = '/home/someone/.claude/projects/p/secret-session-path.jsonl';
    insert.run(secretPath, 100, 1, 10, 7, JSON.stringify({ claudeHold: { heldSince: 2000, maxLineBytes: 8 } }));
    insert.run('/home/someone/.claude/projects/p/other.jsonl', 100, 1, 10, 8, JSON.stringify({ claudeHold: { heldSince: 1500, maxLineBytes: 16 } }));
    insert.run('/home/someone/.codex/sessions/rollout.jsonl', 100, 1, 10, 9, JSON.stringify({ totals: { input: 5 } })); // collector-private, ignored
    insert.run('/home/someone/.claude/projects/p/malformed.jsonl', 100, 1, 10, 10, JSON.stringify({ claudeHold: { heldSince: 'soon' } }));
    insert.run('/home/someone/.claude/projects/p/broken.jsonl', 100, 1, 10, 11, '{"claudeHold":{"heldSince":'); // truncated: ignored, never throws

    const res = await createQueries(db, config).getCoverage();
    expect(res.incompleteCapture).toEqual([{ collector: 'claude', heldFiles: 2, oldestHeldAt: 1500, maxLineBytes: 16 }]);
    expect(JSON.stringify(res)).not.toContain('secret-session-path');
    expect(JSON.stringify(res)).not.toContain('/home/someone');
    const doctor = await createQueries(db, config).getDoctor();
    expect(doctor.incompleteCapture).toEqual(res.incompleteCapture);
    expect(JSON.stringify(doctor.incompleteCapture)).not.toContain('secret-session-path');
    expect(JSON.stringify(doctor.incompleteCapture)).not.toContain('/home/someone');
  });

  it('a failed process listing is reported as unavailable with no observation time, on Coverage and on processes', async () => {
    const q = createQueries(db, config, {
      listProcesses: async () => {
        throw new Error('listing timed out');
      },
    });
    expect((await q.getCoverage()).processListing).toEqual({ status: 'unavailable', observedAt: null });
    expect((await q.getProcesses()).listing).toEqual({ status: 'unavailable', observedAt: null });
  });

  it('a successful listing is reused for the TTL, refreshed after it, and concurrent requests share one listing', async () => {
    let t = 1_000_000;
    let calls = 0;
    const q = createQueries(db, config, {
      now: () => t,
      listProcesses: async () => {
        calls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [];
      },
    });
    await Promise.all([q.getCoverage(), q.getCoverage()]);
    expect(calls).toBe(1);

    t += PROCESS_LISTING_TTL_MS - 1;
    const warm = await q.getCoverage();
    expect(calls).toBe(1);
    expect(warm.processListing).toEqual({ status: 'ok', observedAt: 1_000_000 });

    t += 2;
    expect((await q.getCoverage()).processListing).toEqual({ status: 'ok', observedAt: t });
    expect(calls).toBe(2);
  });

  it('a failed listing is never cached: the next request tries again and can report ok', async () => {
    let calls = 0;
    const q = createQueries(db, config, {
      now: () => 5_000,
      listProcesses: async () => {
        calls++;
        if (calls === 1) throw new Error('listing timed out');
        return [];
      },
    });
    expect((await q.getCoverage()).processListing).toEqual({ status: 'unavailable', observedAt: null });
    expect((await q.getCoverage()).processListing).toEqual({ status: 'ok', observedAt: 5_000 });
    expect(calls).toBe(2);
  });

  it('a not-capturable catalog entry always surfaces its reason, regardless of detection', async () => {
    const q = createQueries(db, config);
    const res = await q.getCoverage();
    const cursor = res.tools.find((t) => t.id === 'cursor')!;
    expect(cursor.captured).toBe(false);
    expect(cursor.reason).toBeTruthy();
  });

  it('a process-listing failure never fails the whole endpoint', async () => {
    const q = createQueries(db, config, {
      listProcesses: async () => {
        throw new Error('boom');
      },
    });
    const res = await q.getCoverage();
    expect(res.tools.length).toBeGreaterThan(0);
    expect(res.tools.every((t) => t.running === false)).toBe(true);
  });
});

describe('process listing wait budget: an uncached probe never holds the response past PROCESS_LISTING_WAIT_MS', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a probe still running after the budget is unknown for that response (unavailable, observedAt null), not zero; Coverage and processes agree', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release!: (rows: ProcessInfo[]) => void;
    const q = createQueries(db, config, {
      now: () => 1_000,
      listProcesses: () => {
        calls++;
        return new Promise<ProcessInfo[]>((resolve) => {
          release = resolve;
        });
      },
    });
    const coverage = q.getCoverage();
    const processes = q.getProcesses();
    await vi.advanceTimersByTimeAsync(PROCESS_LISTING_WAIT_MS);
    const cov = await coverage;
    expect(cov.processListing).toEqual({ status: 'unavailable', observedAt: null, probePending: true });
    expect((await processes).listing).toEqual({ status: 'unavailable', observedAt: null, probePending: true });
    expect(cov.tools.length).toBeGreaterThan(0); // every catalog entry is still reported
    expect(calls).toBe(1); // both requests shared one probe
    release([]);
  });

  it('a late result of the same probe is cached with its own completion time, and the next request reuses it without a second probe', async () => {
    vi.useFakeTimers();
    let t = 1_000;
    let calls = 0;
    let release!: (rows: ProcessInfo[]) => void;
    const q = createQueries(db, config, {
      now: () => t,
      listProcesses: () => {
        calls++;
        return new Promise<ProcessInfo[]>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = q.getCoverage();
    await vi.advanceTimersByTimeAsync(PROCESS_LISTING_WAIT_MS);
    expect((await first).processListing).toEqual({ status: 'unavailable', observedAt: null, probePending: true });

    t = 2_500;
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    const later = await q.getCoverage();
    expect(calls).toBe(1);
    expect(later.processListing).toEqual({ status: 'ok', observedAt: 2_500 });
  });

  it('a probe that fails after the budget is never cached: the next request starts a fresh probe and can report ok', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let fail!: (err: Error) => void;
    const q = createQueries(db, config, {
      now: () => 9_000,
      listProcesses: () => {
        calls++;
        if (calls === 1) {
          return new Promise<ProcessInfo[]>((_resolve, reject) => {
            fail = reject;
          });
        }
        return Promise.resolve([]);
      },
    });
    const first = q.getCoverage();
    await vi.advanceTimersByTimeAsync(PROCESS_LISTING_WAIT_MS);
    expect((await first).processListing).toEqual({ status: 'unavailable', observedAt: null, probePending: true });

    fail(new Error('listing failed'));
    await vi.advanceTimersByTimeAsync(0);
    const second = await q.getCoverage();
    expect(calls).toBe(2);
    expect(second.processListing).toEqual({ status: 'ok', observedAt: 9_000 });
  });

  it('a probe that completes inside the budget returns ok at once, leaves no timer behind, and keeps the same Coverage entries', async () => {
    vi.useFakeTimers();
    const fast = createQueries(db, config, { now: () => 3_000, listProcesses: async () => [] });
    const res = await fast.getCoverage();
    expect(res.processListing).toEqual({ status: 'ok', observedAt: 3_000 });
    expect(vi.getTimerCount()).toBe(0);

    const failing = createQueries(db, config, {
      listProcesses: async () => {
        throw new Error('listing failed');
      },
    });
    const unknown = await failing.getCoverage();
    expect(res.tools.map((t) => t.id)).toEqual(unknown.tools.map((t) => t.id));
  });
});

describe('getPlanUsageHistory', () => {
  it('groups claude-desktop limit snapshots by account, mapping five_hour/seven_day windows to points; ignores non-claude-desktop sources', async () => {
    seedLimit('claude-desktop', 1000, JSON.stringify([{ id: 'five_hour', usedPercent: 10 }, { id: 'seven_day', usedPercent: 20 }]));
    db.prepare(`UPDATE limits SET account = 'acct-a' WHERE captured_at = 1000`).run();
    seedLimit('claude-desktop', 2000, JSON.stringify([{ id: 'five_hour', usedPercent: 15 }, { id: 'seven_day', usedPercent: 21 }]));
    db.prepare(`UPDATE limits SET account = 'acct-a' WHERE captured_at = 2000`).run();
    seedLimit('codex', 3000, JSON.stringify([{ id: 'primary', usedPercent: 50 }]));

    const q = createQueries(db, config);
    const res = await q.getPlanUsageHistory();
    expect(res.series).toHaveLength(1);
    expect(res.series[0]!.account).toBe('acct-a');
    expect(res.series[0]!.points).toEqual([
      { t: 1000, fiveHourUsedPercent: 10, sevenDayUsedPercent: 20 },
      { t: 2000, fiveHourUsedPercent: 15, sevenDayUsedPercent: 21 },
    ]);
  });

  it('empty when no claude-desktop snapshots exist', async () => {
    const q = createQueries(db, config);
    expect((await q.getPlanUsageHistory()).series).toEqual([]);
  });
});

describe('getSessionDetail: desktopMeta attachment (build item 3)', () => {
  it('attaches the desktop_sessions row by cliSessionId === sessionId for a claude session', async () => {
    seedEvent('claude', 1000);
    db.prepare(
      `INSERT INTO events (id, host, source, ts, ts_source, session_id, is_subagent, model, provider, components_json,
        input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, flags_json,
        api_equiv_usd, price_status, price_version, ucu_rate_status, eacs_def_sha256)
       VALUES ('claude-real-1', 'M4a', 'claude', 1000, 'line', 's1', 0, 'm', 'anthropic', '[]', 10, 0, 0, 0, 5, 0, '[]', 0.1, 'LIST', 'v1', 'MEASURED', 'd1')`
    ).run();
    db.prepare(
      `INSERT INTO desktop_sessions (cli_session_id, cwd, title, pr_number, pr_url, source_file, updated_at)
       VALUES ('s1', '/fixture/repo', 'Fixture title', 42, 'https://github.com/x/y/pull/42', '/fixture/local_x.json', 0)`
    ).run();
    const q = createQueries(db, config);
    const detail = await q.getSessionDetail('claude', 's1');
    expect(detail?.desktopMeta).toEqual({
      cliSessionId: 's1',
      cwd: '/fixture/repo',
      title: 'Fixture title',
      prNumber: 42,
      prUrl: 'https://github.com/x/y/pull/42',
    });
  });

  it('omits desktopMeta entirely when no matching row exists (never a guessed/empty object)', async () => {
    seedEvent('claude', 1000);
    const q = createQueries(db, config);
    const detail = await q.getSessionDetail('claude', 's1');
    expect(detail && 'desktopMeta' in detail).toBe(false);
  });

  it('never looked up for a non-claude source (the table is keyed by the Claude CLI session id only)', async () => {
    db.prepare(
      `INSERT INTO events (id, host, source, ts, ts_source, session_id, is_subagent, model, provider, components_json,
        input_fresh, cache_write_5m, cache_write_1h, cache_read, output, reasoning, flags_json,
        api_equiv_usd, price_status, price_version, ucu_rate_status, eacs_def_sha256)
       VALUES ('codex-1', 'M4a', 'codex', 1000, 'line', 's1', 0, 'm', 'openai', '[]', 10, 0, 0, 0, 5, 0, '[]', 0.1, 'LIST', 'v1', 'MEASURED', 'd1')`
    ).run();
    db.prepare(
      `INSERT INTO desktop_sessions (cli_session_id, source_file, updated_at) VALUES ('s1', '/fixture/local_x.json', 0)`
    ).run();
    const q = createQueries(db, config);
    const detail = await q.getSessionDetail('codex', 's1');
    expect(detail && 'desktopMeta' in detail).toBe(false);
  });
});
