/**
 * The serverlog `Collector` (collectors/ollama-serverlog.ts#OllamaServerlogCollector) wired against
 * the REAL SqliteLedger + the real pricing engine: IngestState persistence across scans,
 * deterministic ids, rotation, and the double-count guard reading `ollama-proxy` events through
 * `LedgerWriter.recentEvents` (DESIGN §15.3.4, §15.9.6).
 *
 * Synthetic log text uses the exact real line formats (see test/fixtures/ollama/serverlog-slice-
 * homebrew.log). Every test owns its temp dir + DB (created and torn down inside the test, no
 * shared mutable module state), and GIN timestamps are parsed as LOCAL time (no tz offset in the
 * line) — every expected endTs below is built with `new Date(y, m, d, h, mi, s)` (local) to match.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialServerLogState, OllamaServerlogCollector, tailServerLog } from '../../src/collectors/ollama-serverlog.js';
import { safeIno, statSafe } from '../../src/collectors/fswalk.js';
import type { OllamaProbeResult, OllamaServerProbe } from '../../src/collectors/ollama-probe.js';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { MeteringBacklog } from '../../src/store/metering-backlog.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { IngestContext, UsageEvent } from '../../src/core/types.js';

function ginLine(minute: number, second = 0): string {
  const h = String(Math.floor(minute / 60)).padStart(2, '0');
  const m = String(minute % 60).padStart(2, '0');
  const s = String(second).padStart(2, '0');
  return `[GIN] 2026/09/26 - ${h}:${m}:${s} | 200 | 500.000000ms |       127.0.0.1 | POST     "/api/chat"`;
}

function block(minute: number, promptTokens: number, evalTokens: number): string {
  return [
    `time=2026-09-26T15:39:00.000-00:00 level=INFO source=images.go:374 msg="template selection" model=gemma4:26b selected=gguf_chat_template renderer="" parser="" go_template="[completion]" chat_template="[completion]" harmony=null renderer_parser=null`,
    `slot print_timing: id  0 | task 0 | prompt eval time =    100.00 ms /    ${promptTokens} tokens (   1.00 ms per token,    1.00 tokens per second)`,
    `slot print_timing: id  0 | task 0 |        eval time =    200.00 ms /    ${evalTokens} tokens (   1.00 ms per token,    1.00 tokens per second)`,
    `slot print_timing: id  0 | task 0 |       total time =    300.00 ms /    ${promptTokens + evalTokens} tokens`,
    ginLine(minute),
  ].join('\n');
}

/** Local-time endTs of ginLine(minute) on 2026-09-26. */
function endTsOf(minute: number): number {
  return new Date(2026, 8, 26, Math.floor(minute / 60), minute % 60, 0).getTime();
}

interface Harness {
  dir: string;
  logPath: string;
  db: TokeneloDb;
  store: SqliteLedger;
  ctx: IngestContext;
  collector: OllamaServerlogCollector;
  logEvents(): UsageEvent[];
  close(): void;
}

function harness(initialLog: string): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-serverlog-'));
  const logPath = path.join(dir, 'ollama.log');
  fs.writeFileSync(logPath, initialLog);
  const db = openDb({ file: ':memory:' });
  const pricing = defaultPricingEngine();
  const valuationEngine = createNullEngine();
  const store = new SqliteLedger(db, pricing, valuationEngine);
  const base = defaultConfig({ hostLabel: 'M4a' });
  const config = { ...base, local: { ...base.local, capture: 'serverlog' as const, serverLogPath: logPath } };
  const ctx: IngestContext = { host: 'M4a', config, store, pricing, valuationEngine, log: () => {}, now: () => Date.now() };
  const collector = new OllamaServerlogCollector({ modelsDir: path.join(dir, 'no-models') });
  return {
    dir,
    logPath,
    db,
    store,
    ctx,
    collector,
    logEvents: () => store.recentEvents('ollama-log', 0, Number.MAX_SAFE_INTEGER),
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rawCursorRow(db: TokeneloDb, key: string): unknown {
  const stmt = db.prepare('SELECT key, size, mtime_ms, offset, ino, extra_json FROM ingest_state WHERE key = ?');
  stmt.setReadBigInts(true);
  return stmt.get(key);
}

function probeServer(logPath: string, port: number): OllamaServerProbe {
  return {
    address: '127.0.0.1', port, family: 'IPv4', reachable: true, version: 'fixture', process: null,
    log: { path: logPath, source: 'unknown', available: true },
  };
}

function proxyEvent(id: string, endTs: number, durationMs: number, evalCount: number): UsageEvent {
  const tokens = { inputFresh: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: evalCount, reasoning: 0 };
  return {
    id,
    host: 'M4a',
    source: 'ollama-proxy',
    ts: endTs - durationMs,
    tsSource: 'request',
    sessionId: 'ua:gemma4:26b:2026-09-26',
    isSubagent: false,
    model: 'gemma4:26b',
    provider: 'local',
    components: [{ model: 'gemma4:26b', tokens }],
    tokens,
    durationMs,
    flags: [],
    apiEquivUsd: null,
    priceStatus: 'UNPRICED',
    priceVersion: '',
    reservedValue: null,
    ucuRateStatus: 'NONE',
    eacsDefSha256: '',
  };
}

describe('OllamaServerlogCollector (real ledger + pricing engine)', () => {
  it('emits one priced event with a deterministic id; a second scan with nothing new emits nothing', async () => {
    const h = harness(block(0, 54, 8) + '\n');
    try {
      const s1 = await h.collector.scan(h.ctx);
      expect(s1.filesScanned).toBe(1);
      expect(s1.eventsEmitted).toBe(1);
      const [e] = h.logEvents();
      expect(e!.id).toBe(`ollama-log:M4a:${endTsOf(0)}:54:8`);
      expect(e!.model).toBe('gemma4:26b');
      expect(e!.provider).toBe('local');
      expect(e!.tokens.inputFresh).toBe(54);
      expect(e!.tokens.output).toBe(8);
      expect(e!.flags).toContain('serverlogEstimate');
      expect(e!.priceStatus).not.toBe('UNPRICED'); // recomputed by upsertEvents from the real pricing engine
      // The reserved valuation fields of a new row are neutral: unknown value, no rate status, no definition hash.
      expect(e!.reservedValue).toBeNull();
      expect(e!.ucuRateStatus).toBe('NONE');
      expect(e!.eacsDefSha256).toBe('');

      const s2 = await h.collector.scan(h.ctx);
      expect(s2.eventsEmitted).toBe(0);
      expect(h.logEvents()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('an appended block is picked up incrementally (the first is not re-read)', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    try {
      await h.collector.scan(h.ctx);
      fs.appendFileSync(h.logPath, block(5, 20, 6) + '\n');
      const s2 = await h.collector.scan(h.ctx);
      expect(s2.eventsEmitted).toBe(1);
      expect(h.logEvents().map((e) => e.tokens.output)).toEqual([5, 6]);
    } finally {
      h.close();
    }
  });

  it('normalizes an exact NTFS inode above 2^53 at the opened-handle cursor boundary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-serverlog-bigino-'));
    const logPath = path.join(dir, 'ollama.log');
    fs.writeFileSync(logPath, block(0, 10, 5) + '\n');
    const exactIno = 9_851_624_185_066_820n;
    const expectedSafeId = 844_424_930_325_829; // exactIno % (2^53 - 1)
    expect(safeIno(exactIno)).toBe(expectedSafeId);
    const safeId = expectedSafeId;
    let bigintStatCalls = 0;
    const originalOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (String(filePath) !== logPath) return handle;
      const originalStat = handle.stat.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (options?: { bigint?: boolean }) => {
              const stat = await originalStat(options as never);
              if (options?.bigint !== true) return stat;
              bigintStatCalls++;
              return new Proxy(stat, {
                get(value, key) {
                  if (key === 'ino') return exactIno;
                  const member = Reflect.get(value, key, value);
                  return typeof member === 'function' ? member.bind(value) : member;
                },
              }) as typeof stat;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof handle;
    });
    try {
      const parse = (state: ReturnType<typeof initialServerLogState>) =>
        tailServerLog(logPath, state, new Map(), () => [], { host: 'M4a', expectedInode: safeId });
      const first = await parse(initialServerLogState());
      expect(Number.isSafeInteger(safeId)).toBe(true);
      expect(Number.isSafeInteger(Number(exactIno))).toBe(false);
      expect(first.fileInfo?.ino).toBe(safeId);
      expect(first.events).toHaveLength(1);

      const unchanged = await parse(first.state);
      expect(unchanged.fileInfo?.ino).toBe(safeId);
      expect(unchanged.events).toHaveLength(0);
      expect(unchanged.state.offset).toBe(first.state.offset);

      fs.appendFileSync(logPath, block(1, 11, 6) + '\n');
      const appended = await parse(unchanged.state);
      expect(appended.fileInfo?.ino).toBe(safeId);
      expect(appended.events).toHaveLength(1);
      expect(appended.events[0]!.tokens.output).toBe(6);
      expect(bigintStatCalls).toBeGreaterThan(0);
    } finally {
      openSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported BigInt handle size or mtime without changing parser state', async () => {
    const cases = [
      { field: 'size', value: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
      { field: 'mtimeMs', value: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    ] as const;
    for (const { field, value } of cases) {
      const h = harness(block(0, 10, 5) + '\n');
      const state = {
        ...initialServerLogState(),
        currentModel: 'held-model',
        pendingBlocks: [{ model: 'held-model', promptEvalCount: 10, evalCount: 5, totalMs: 300, endTs: 1_000, durationMs: 500, path: '/api/chat' }],
        historyIncomplete: true,
        pendingLimitReached: true,
        cursorGuard: 'a'.repeat(64),
      };
      const before = structuredClone(state);
      const originalOpen = fsp.open.bind(fsp);
      const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        if (String(filePath) !== h.logPath) return handle;
        const originalStat = handle.stat.bind(handle);
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat') {
              return async (options?: { bigint?: boolean }) => {
                const stat = await originalStat(options as never);
                if (options?.bigint !== true) return stat;
                return new Proxy(stat, {
                  get(valueTarget, key) {
                    if (key === field) return value;
                    const member = Reflect.get(valueTarget, key, valueTarget);
                    return typeof member === 'function' ? member.bind(valueTarget) : member;
                  },
                }) as typeof stat;
              };
            }
            const member = Reflect.get(target, property, target);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        }) as typeof handle;
      });
      try {
        await expect(tailServerLog(h.logPath, state, new Map(), () => [], { host: 'M4a' }))
          .rejects.toThrow('unsupported server-log size or mtime');
        expect(state).toEqual(before);
      } finally {
        openSpy.mockRestore();
        h.close();
      }
    }
  });

  it('rolls back parser state when post-read BigInt metadata cannot be represented safely', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    const state = {
      ...initialServerLogState(),
      offset: 1,
      currentModel: 'held-model',
      pendingPromptTokens: 10,
      pendingEvalTokens: 5,
      pendingTotalMs: 300,
      pendingBlocks: [{ model: 'held-model', promptEvalCount: 10, evalCount: 5, totalMs: 300, endTs: 1_000, durationMs: 500, path: '/api/chat' }],
      historyIncomplete: true,
      cursorGuard: null,
    };
    const before = structuredClone(state);
    const originalOpen = fsp.open.bind(fsp);
    let statCalls = 0;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (String(filePath) !== h.logPath) return handle;
      const originalStat = handle.stat.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (options?: { bigint?: boolean }) => {
              const stat = await originalStat(options as never);
              if (options?.bigint !== true) return stat;
              statCalls++;
              if (statCalls !== 2) return stat;
              return new Proxy(stat, {
                get(valueTarget, key) {
                  if (key === 'mtimeMs') return BigInt(Number.MAX_SAFE_INTEGER) + 1n;
                  const member = Reflect.get(valueTarget, key, valueTarget);
                  return typeof member === 'function' ? member.bind(valueTarget) : member;
                },
              }) as typeof stat;
            };
          }
          const member = Reflect.get(target, property, target);
          return typeof member === 'function' ? member.bind(target) : member;
        },
      }) as typeof handle;
    });
    try {
      await expect(tailServerLog(h.logPath, state, new Map(), () => [], {
        host: 'M4a', expectedInode: statSafe(h.logPath).ino + 1,
      }))
        .rejects.toThrow('unsupported server-log size or mtime');
      expect(statCalls).toBe(2);
      expect(state).toEqual(before);
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('rejects negative, fractional, and unsafe parser-private offsets before file access', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    const openSpy = vi.spyOn(fsp, 'open');
    try {
      for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const state = { ...initialServerLogState(), offset, pendingBlocks: [] };
        const before = structuredClone(state);
        await expect(tailServerLog(h.logPath, state, new Map(), () => [], { host: 'M4a' }))
          .rejects.toThrow('unsupported server-log cursor offset');
        expect(state).toEqual(before);
      }
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('preserves persisted server-log history when saved parser metadata has an unsafe offset', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    const stateKey = `ollama-serverlog:${h.logPath}`;
    try {
      const persisted = {
        ...initialServerLogState(),
        offset: Number.MAX_SAFE_INTEGER + 1,
        currentModel: 'held-model',
        pendingBlocks: [{ model: 'held-model', promptEvalCount: 10, evalCount: 5, totalMs: 300, endTs: 1_000, durationMs: 500, path: '/api/chat' }],
        historyIncomplete: true,
      };
      h.store.setState({
        key: stateKey,
        size: 0,
        mtimeMs: 0,
        offset: 0,
        ino: statSafe(h.logPath).ino,
        extra: persisted,
      });
      const before = h.store.getState(stateKey);
      const result = await h.collector.scan(h.ctx);

      expect(result.filesSkipped).toBe(1);
      expect(result.eventsEmitted).toBe(0);
      expect(result.warnings).toContain(`${h.logPath}: unsupported server-log cursor metadata; preserving the saved cursor and history.`);
      expect(h.store.getState(stateKey)).toEqual(before);
      expect(h.logEvents()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('does not write a zero-size fallback cursor when both path and handle metadata are unavailable', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    const stateKey = `ollama-serverlog:${h.logPath}`;
    try {
      const size = Buffer.byteLength(fs.readFileSync(h.logPath));
      const extra = { ...initialServerLogState(), offset: size, pendingBlocks: [], historyIncomplete: true };
      h.store.setState({ key: stateKey, size, mtimeMs: 5.5, offset: size, ino: statSafe(h.logPath).ino, extra });
      const before = h.store.getState(stateKey);
      fs.rmSync(h.logPath);

      const result = await h.collector.scan(h.ctx);
      expect(result.filesSkipped).toBe(1);
      expect(result.eventsEmitted).toBe(0);
      expect(result.warnings).toContain(`${h.logPath}: file cursor metadata unavailable; preserving the saved cursor and history.`);
      expect(h.store.getState(stateKey)).toEqual(before);
      expect(h.logEvents()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('holds a path stat with unsafe size or mtime and continues scanning a valid sibling log', async () => {
    for (const field of ['size', 'mtimeMs'] as const) {
      const h = harness(block(0, 10, 5) + '\n');
      const badPath = h.logPath;
      const goodPath = path.join(h.dir, 'good.log');
      fs.writeFileSync(goodPath, block(1, 11, 6) + '\n');
      const badKey = `ollama-serverlog:${badPath}`;
      const badBytes = Buffer.byteLength(fs.readFileSync(badPath));
      const savedExtra = {
        ...initialServerLogState(),
        offset: badBytes,
        pendingBlocks: [{ model: 'held-model', promptEvalCount: 3, evalCount: 2, totalMs: 4, endTs: 5, durationMs: 1, path: '/api/chat' }],
        historyIncomplete: true,
      };
      h.store.setState({
        key: badKey,
        size: badBytes,
        mtimeMs: 5.5,
        offset: badBytes,
        ino: statSafe(badPath).ino,
        extra: savedExtra,
      });
      const before = h.store.getState(badKey);
      const originalStat = fs.statSync.bind(fs);
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((filePath: fs.PathLike, options?: fs.StatSyncOptions) => {
        const stat = originalStat(filePath, options as never);
        if (String(filePath) !== badPath || (options as { bigint?: boolean } | undefined)?.bigint !== true) return stat;
        return new Proxy(stat, {
          get(target, key) {
            if (key === field) return BigInt(Number.MAX_SAFE_INTEGER) + 1n;
            const member = Reflect.get(target, key, target);
            return typeof member === 'function' ? member.bind(target) : member;
          },
        }) as typeof stat;
      }) as typeof fs.statSync);
      delete h.ctx.config.local.serverLogPath;
      const result: OllamaProbeResult = {
        servers: [probeServer(badPath, 11434), probeServer(goodPath, 11435)],
        manifests: new Map(),
        generatedAt: Date.now(),
      };
      const collector = new OllamaServerlogCollector({
        modelsDir: path.join(h.dir, 'no-models'),
        probe: async () => result,
      });
      try {
        const scan = await collector.scan(h.ctx);
        expect(scan.filesScanned).toBe(2);
        expect(scan.filesSkipped).toBe(1);
        expect(scan.eventsEmitted).toBe(1);
        expect(scan.warnings).toContain(`${badPath}: unsupported file cursor metadata; preserving the saved cursor and history.`);
        expect(h.store.getState(badKey)).toEqual(before);
        expect(h.logEvents().map((event) => event.tokens.output)).toEqual([6]);
      } finally {
        statSpy.mockRestore();
        h.close();
      }
    }
  });

  it('holds invalid legacy outer size/offset rows and continues without losing eligible sibling usage', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    let existingEventId = '';
    const badSizePath = h.logPath;
    const badOffsetPath = path.join(h.dir, 'bad-offset.log');
    const badFractionalOffsetPath = path.join(h.dir, 'bad-fractional-offset.log');
    const mismatchedCursorPath = path.join(h.dir, 'mismatched-cursor.log');
    const goodPath = path.join(h.dir, 'good.log');
    fs.writeFileSync(badOffsetPath, block(1, 11, 6) + '\n');
    fs.writeFileSync(badFractionalOffsetPath, block(2, 12, 7) + '\n');
    fs.writeFileSync(mismatchedCursorPath, block(3, 13, 8) + '\n');
    fs.writeFileSync(goodPath, block(4, 14, 9) + '\n');
    const badPaths = [badSizePath, badOffsetPath, badFractionalOffsetPath, mismatchedCursorPath];
    const before = new Map<string, unknown>();
    try {
      const initial = await h.collector.scan(h.ctx);
      expect(initial.eventsEmitted).toBe(1);
      existingEventId = h.logEvents()[0]!.id;
      for (const logPath of badPaths) {
        const key = `ollama-serverlog:${logPath}`;
        const size = Buffer.byteLength(fs.readFileSync(logPath));
        const extra = {
          ...initialServerLogState(),
          offset: logPath === mismatchedCursorPath ? size - 1 : size,
          pendingBlocks: [],
          historyIncomplete: true,
        };
        h.store.setState({ key, size, mtimeMs: 5.5, offset: size, ino: statSafe(logPath).ino, extra });
      }
      const badSizeKey = `ollama-serverlog:${badSizePath}`;
      const badOffsetKey = `ollama-serverlog:${badOffsetPath}`;
      const badFractionalOffsetKey = `ollama-serverlog:${badFractionalOffsetPath}`;
      h.db.prepare('UPDATE ingest_state SET size = ? WHERE key = ?').run(1.5, badSizeKey);
      h.db.prepare('UPDATE ingest_state SET offset = ? WHERE key = ?')
        .run(BigInt(Number.MAX_SAFE_INTEGER) + 1n, badOffsetKey);
      h.db.prepare('UPDATE ingest_state SET offset = ? WHERE key = ?').run(1.5, badFractionalOffsetKey);
      for (const logPath of badPaths) {
        const key = `ollama-serverlog:${logPath}`;
        before.set(key, rawCursorRow(h.db, key));
      }

      delete h.ctx.config.local.serverLogPath;
      const probeResult: OllamaProbeResult = {
        servers: [
          probeServer(badSizePath, 11434),
          probeServer(badOffsetPath, 11435),
          probeServer(badFractionalOffsetPath, 11436),
          probeServer(mismatchedCursorPath, 11437),
          probeServer(goodPath, 11438),
        ],
        manifests: new Map(),
        generatedAt: Date.now(),
      };
      const collector = new OllamaServerlogCollector({
        modelsDir: path.join(h.dir, 'no-models'),
        probe: async () => probeResult,
      });
      const result = await collector.scan(h.ctx);

      expect(result.filesScanned).toBe(5);
      expect(result.filesSkipped).toBe(4);
      expect(result.eventsEmitted).toBe(1);
      for (const logPath of badPaths) {
        const key = `ollama-serverlog:${logPath}`;
        const warning = logPath === mismatchedCursorPath
          ? `${logPath}: inconsistent server-log cursor metadata; preserving the saved cursor and history.`
          : `${logPath}: unsupported saved server-log cursor; preserving its cursor and history.`;
        expect(result.warnings).toContain(warning);
        expect(rawCursorRow(h.db, key)).toEqual(before.get(key));
      }
      expect(h.logEvents().map((event) => event.id)).toContain(existingEventId);
      expect(h.logEvents().map((event) => event.tokens.output)).toEqual([5, 9]);
    } finally {
      h.close();
    }
  });

  it('marks dual-capture history incomplete when same-inode truncation races after the collector stat', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      expect(before.offset).toBe(before.size);

      // New bytes are visible to statSafe; truncate after that stat but before tailServerLog's fsp.stat.
      fs.appendFileSync(h.logPath, block(20, 10, 9) + '\n');
      let truncateNextCaptureRead = true;
      Object.defineProperty(h.ctx.config.local, 'capture', {
        configurable: true,
        get: () => {
          if (truncateNextCaptureRead) {
            truncateNextCaptureRead = false;
            fs.truncateSync(h.logPath, 0);
          }
          return 'both';
        },
      });

      const result = await h.collector.scan(h.ctx);
      expect(result.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(h.store.getState(stateKey)?.extra).toMatchObject({ historyIncomplete: true });
    } finally {
      h.close();
    }
  });

  it('marks dual-capture history incomplete and starts at zero when a new inode replaces the log after stat', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const replacementPath = h.logPath + '.replacement';
    const oldPath = h.logPath + '.previous';
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      expect(before.offset).toBe(before.size);
      expect(Number.isSafeInteger(before.ino)).toBe(true);

      // The outer collector stat sees unread bytes on the old inode. Replace the path from the
      // config getter, which runs after that stat but before tailServerLog opens the path.
      fs.appendFileSync(h.logPath, block(20, 20, 9) + '\n');
      const replacement = block(30, 30, 10) + '\n' + block(31, 31, 11) + '\n';
      fs.writeFileSync(replacementPath, replacement);
      let replaceNextCaptureRead = true;
      Object.defineProperty(h.ctx.config.local, 'capture', {
        configurable: true,
        get: () => {
          if (replaceNextCaptureRead) {
            replaceNextCaptureRead = false;
            fs.renameSync(h.logPath, oldPath);
            fs.renameSync(replacementPath, h.logPath);
          }
          return 'both';
        },
      });

      const result = await h.collector.scan(h.ctx);
      const after = h.store.getState(stateKey)!;
      expect(result.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(after.extra).toMatchObject({ historyIncomplete: true });
      expect(after.ino).toBe(statSafe(h.logPath).ino);
      expect(after.offset).toBe(Buffer.byteLength(replacement));
      expect(after.extra.pendingBlocks?.map((pending) => pending.evalCount)).toEqual([8, 10, 11]);
    } finally {
      h.close();
    }
  });

  it('finishes reading the opened inode when the log path is replaced before tail read', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const replacementPath = h.logPath + '.replacement';
    const oldPath = h.logPath + '.previous';
    let replaceOnOpen = false;
    const originalOpen = fsp.open.bind(fsp);
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (replaceOnOpen && String(filePath) === h.logPath) {
        replaceOnOpen = false;
        fs.renameSync(h.logPath, oldPath);
        fs.renameSync(replacementPath, h.logPath);
      }
      return handle;
    });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      fs.appendFileSync(h.logPath, block(20, 20, 9) + '\n');
      const replacement = block(30, 30, 10) + '\n';
      fs.writeFileSync(replacementPath, replacement);
      replaceOnOpen = true;

      const raced = await h.collector.scan(h.ctx);
      const afterOldInode = h.store.getState(stateKey)!;
      expect(replaceOnOpen).toBe(false);
      expect(afterOldInode.ino).toBe(before.ino);
      expect(afterOldInode.offset).toBe(afterOldInode.size);
      expect(afterOldInode.extra.pendingBlocks?.map((pending) => pending.evalCount)).toEqual([8, 9]);
      expect(raced.warnings).not.toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');

      const newInode = statSafe(h.logPath).ino;
      expect(newInode).not.toBe(before.ino);
      const afterNewInode = await h.collector.scan(h.ctx);
      const final = h.store.getState(stateKey)!;
      expect(afterNewInode.warnings).not.toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(final.ino).toBe(newInode);
      expect(final.offset).toBe(Buffer.byteLength(replacement));
      expect(final.extra.pendingBlocks?.map((pending) => pending.evalCount)).toEqual([8, 9, 10]);
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('marks dual-capture history incomplete when same-inode truncation happens after the handle stat', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const originalOpen = fsp.open.bind(fsp);
    let truncateBeforeRead = false;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      if (!truncateBeforeRead || String(filePath) !== h.logPath) return handle;
      truncateBeforeRead = false;
      let truncated = false;
      const originalRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...args: Parameters<typeof handle.read>) => {
              if (!truncated) {
                truncated = true;
                fs.truncateSync(h.logPath, 0);
              }
              return originalRead(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof handle;
    });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      fs.appendFileSync(h.logPath, block(20, 20, 9) + '\n');
      truncateBeforeRead = true;

      const result = await h.collector.scan(h.ctx);
      const after = h.store.getState(stateKey)!;
      expect(truncateBeforeRead).toBe(false);
      expect(result.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(after.extra).toMatchObject({ historyIncomplete: true });
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(0);
      expect(after.offset).toBe(0);
      expect(after.extra.pendingBlocks?.map((pending) => pending.evalCount)).toEqual([8]);
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('marks dual-capture history incomplete when same-inode rewrite keeps the opened size', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const originalOpen = fsp.open.bind(fsp);
    const replacement = block(30, 30, 7) + '\n' + block(40, 40, 6) + '\n';
    let replaceBeforeRead = false;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const replaceThisOpen = replaceBeforeRead && String(filePath) === h.logPath;
      const handle = await originalOpen(filePath, replaceThisOpen ? 'r+' : flags, mode);
      if (!replaceThisOpen) return handle;
      replaceBeforeRead = false;
      let replaced = false;
      const originalRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...args: Parameters<typeof handle.read>) => {
              if (!replaced) {
                replaced = true;
                const prior = await handle.stat();
                await handle.truncate(0);
                const bytes = Buffer.from(replacement);
                await handle.write(bytes, 0, bytes.length, 0);
                await handle.utimes(new Date(), new Date(prior.mtimeMs + 2_000));
                await handle.sync();
              }
              return originalRead(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof handle;
    });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      fs.appendFileSync(h.logPath, block(20, 20, 9) + '\n');
      const openedSize = fs.statSync(h.logPath).size;
      expect(Buffer.byteLength(replacement)).toBe(openedSize);
      replaceBeforeRead = true;

      const result = await h.collector.scan(h.ctx);
      const after = h.store.getState(stateKey)!;
      expect(replaceBeforeRead).toBe(false);
      expect(statSafe(h.logPath).ino).toBe(before.ino);
      expect(result.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(after.extra).toMatchObject({ historyIncomplete: true });
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBe(openedSize);
      expect(after.offset).toBe(0);
      expect(after.extra.pendingBlocks?.map((pending) => pending.evalCount)).toEqual([8]);
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('marks dual-capture history incomplete when same-inode rewrite grows after the handle stat', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const originalOpen = fsp.open.bind(fsp);
    const replacement = block(30, 30, 7) + '\n' + block(40, 40, 6) + '\n' + block(50, 50, 5) + '\n';
    let replaceBeforeRead = false;
    let replacedAtRead = false;
    let targetReadOffset = -1;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const replaceThisOpen = replaceBeforeRead && String(filePath) === h.logPath;
      const handle = await originalOpen(filePath, replaceThisOpen ? 'r+' : flags, mode);
      if (!replaceThisOpen) return handle;
      replaceBeforeRead = false;
      let replaced = false;
      const originalRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...args: Parameters<typeof handle.read>) => {
              if (!replaced && args[3] === targetReadOffset) {
                replaced = true;
                replacedAtRead = true;
                const prior = await handle.stat();
                await handle.truncate(0);
                const bytes = Buffer.from(replacement);
                await handle.write(bytes, 0, bytes.length, 0);
                await handle.utimes(new Date(), new Date(prior.mtimeMs + 2_000));
                await handle.sync();
              }
              return originalRead(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof handle;
    });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      fs.appendFileSync(h.logPath, block(20, 20, 9) + '\n');
      const openedSize = fs.statSync(h.logPath).size;
      expect(Buffer.byteLength(replacement)).toBeGreaterThan(openedSize);
      targetReadOffset = before.offset;
      replaceBeforeRead = true;

      const result = await h.collector.scan(h.ctx);
      const after = h.store.getState(stateKey)!;
      expect(replaceBeforeRead).toBe(false);
      expect(replacedAtRead).toBe(true);
      expect(statSafe(h.logPath).ino).toBe(before.ino);
      expect(result.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(after.extra).toMatchObject({ historyIncomplete: true });
      expect(after.ino).toBe(before.ino);
      expect(after.size).toBeGreaterThan(openedSize);
      expect(after.offset).toBe(0);
      expect(after.extra.pendingBlocks?.map((pending) => pending.evalCount)).toEqual([8]);
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('persists the bounded cursor guard and held blocks across a collector restart', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const replacement = block(30, 30, 7) + '\n' + block(40, 40, 6) + '\n' + block(50, 50, 5) + '\n';
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      expect(before.extra).toMatchObject({ pendingBlocks: [{ evalCount: 8 }] });
      expect(before.extra).toMatchObject({ cursorGuard: expect.stringMatching(/^[a-f0-9]{64}$/) });

      const replacementFd = fs.openSync(h.logPath, 'r+');
      try {
        fs.ftruncateSync(replacementFd, 0);
        const replacementBytes = Buffer.from(replacement);
        fs.writeSync(replacementFd, replacementBytes, 0, replacementBytes.length, 0);
        fs.fsyncSync(replacementFd);
      } finally {
        fs.closeSync(replacementFd);
      }
      expect(statSafe(h.logPath).ino).toBe(before.ino);
      expect(fs.statSync(h.logPath).size).toBeGreaterThan(before.size);
      const restarted = new OllamaServerlogCollector({ modelsDir: path.join(h.dir, 'no-models') });
      const held = await restarted.scan(h.ctx);
      const afterRewrite = h.store.getState(stateKey)!;
      expect(held.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(held.eventsEmitted).toBe(0);
      expect(afterRewrite.extra).toMatchObject({ historyIncomplete: true, pendingBlocks: [{ evalCount: 8 }], offset: 0 });

      const resumed = await new OllamaServerlogCollector({ modelsDir: path.join(h.dir, 'no-models') }).scan(h.ctx);
      const afterResume = h.store.getState(stateKey)!;
      expect(resumed.eventsEmitted).toBe(0);
      expect(afterResume.extra).toMatchObject({ historyIncomplete: true, pendingBlocks: [{ evalCount: 8 }, { evalCount: 7 }, { evalCount: 6 }, { evalCount: 5 }] });
      expect(afterResume.extra?.cursorGuard).toMatch(/^[a-f0-9]{64}$/);
      expect(h.logEvents()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('rejects a larger same-inode rewrite after reading when it preserves the consumed cursor prefix', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const originalOpen = fsp.open.bind(fsp);
    const replacement = block(10, 10, 8) + '\n' + block(40, 40, 6) + '\n' + block(50, 50, 5) + '\n';
    let replaceAfterRead = false;
    let replacedAtRead = false;
    let targetReadOffset = -1;
    const openSpy = vi.spyOn(fsp, 'open').mockImplementation(async (filePath, flags, mode) => {
      const replaceThisOpen = replaceAfterRead && String(filePath) === h.logPath;
      const handle = await originalOpen(filePath, replaceThisOpen ? 'r+' : flags, mode);
      if (!replaceThisOpen) return handle;
      replaceAfterRead = false;
      let replaced = false;
      const originalRead = handle.read.bind(handle);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'read') {
            return async (...args: Parameters<typeof handle.read>) => {
              const result = await originalRead(...args);
              if (!replaced && args[3] === targetReadOffset) {
                replaced = true;
                replacedAtRead = true;
                const prior = await handle.stat();
                await handle.truncate(0);
                const bytes = Buffer.from(replacement);
                await handle.write(bytes, 0, bytes.length, 0);
                await handle.utimes(new Date(), new Date(prior.mtimeMs + 2_000));
                await handle.sync();
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as typeof handle;
    });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.primaryOllamaActiveRequests = () => 1;
      await h.collector.scan(h.ctx);
      const stateKey = 'ollama-serverlog:' + h.logPath;
      const before = h.store.getState(stateKey)!;
      fs.appendFileSync(h.logPath, block(20, 20, 9) + '\n');
      const openedSize = fs.statSync(h.logPath).size;
      expect(Buffer.byteLength(replacement)).toBeGreaterThan(openedSize);
      targetReadOffset = before.offset;
      replaceAfterRead = true;

      const result = await h.collector.scan(h.ctx);
      const after = h.store.getState(stateKey)!;
      expect(replaceAfterRead).toBe(false);
      expect(replacedAtRead).toBe(true);
      expect(statSafe(h.logPath).ino).toBe(before.ino);
      expect(result.warnings).toContain('Dual-capture server-log history may be incomplete after a concurrent file change while unread bytes remained.');
      expect(result.eventsEmitted).toBe(0);
      expect(after.extra).toMatchObject({ historyIncomplete: true, pendingBlocks: [{ evalCount: 8 }], offset: 0 });
      expect(after.size).toBe(Buffer.byteLength(replacement));
    } finally {
      openSpy.mockRestore();
      h.close();
    }
  });

  it('a truncated/rotated log is re-read from 0 WITHOUT double counting (deterministic ids)', async () => {
    const h = harness(block(0, 10, 5) + '\n' + block(1, 11, 6) + '\n');
    try {
      await h.collector.scan(h.ctx);
      expect(h.logEvents()).toHaveLength(2);
      // Rotation: same content rewritten shorter than the saved offset, then one new block.
      fs.writeFileSync(h.logPath, block(1, 11, 6) + '\n');
      await h.collector.scan(h.ctx);
      fs.appendFileSync(h.logPath, block(2, 12, 7) + '\n');
      await h.collector.scan(h.ctx);
      expect(h.logEvents().map((e) => e.tokens.output)).toEqual([5, 6, 7]);
    } finally {
      h.close();
    }
  });

  it('double-count guard: a block whose evalCount + end time match a stored ollama-proxy event (via recentEvents) is dropped', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    try {
      // Proxy request that STARTED 10 min before the log block ended (long generation) and ended
      // 1.5 s after it: found only because the collector looks back PROXY_GUARD_LOOKBACK_MS for the
      // start while matching on the END time.
      h.store.upsertEvents([proxyEvent('ollama:M4a:1:1', endTsOf(10) + 1500, 600_000, 8)]);
      const s = await h.collector.scan(h.ctx);
      expect(s.eventsEmitted).toBe(0);
      expect(h.logEvents()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('does not suppress an Ollama log event because an extra upstream shares output count and time', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    try {
      h.store.upsertEvents([{ ...proxyEvent('vllm:M4a:1:1', endTsOf(10), 1000, 8), engine: 'vllm' }]);
      const s = await h.collector.scan(h.ctx);
      expect(s.eventsEmitted).toBe(1);
      expect(h.logEvents()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
  it('does not double count an Ollama log when its matching proxy event is durable but still queued', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const q = new MeteringBacklog(path.join(h.dir, 'metering-backlog'), () => {}, { autoDrain: false });
    try {
      h.ctx.pendingProxyEvents = q.pendingProxyEvents.bind(q);
      q.enqueue({ kind: 'event', event: { ...proxyEvent('ollama:M4a:queued:1', endTsOf(10), 1000, 8), engine: 'ollama' } });
      expect(h.store.recentEvents('ollama-proxy', endTsOf(10) - 1000, endTsOf(10) + 2000)).toHaveLength(0);
      const s = await h.collector.scan(h.ctx);
      expect(s.eventsEmitted).toBe(0);
      expect(h.logEvents()).toHaveLength(0);
      expect(q.status().pending).toBe(1);
    } finally {
      q.close();
      h.close();
    }
  });
  it('persists a recent dual-capture log block and settles it after proxy requests and backlog are quiet', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    let now = endTsOf(10) + 500;
    let active = 1;
    const q = new MeteringBacklog(path.join(h.dir, 'metering-backlog'), () => {}, { autoDrain: false, now: () => now });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.now = () => now;
      h.ctx.primaryOllamaActiveRequests = () => active;
      h.ctx.meteringBacklogStatus = () => q.status();
      const first = await h.collector.scan(h.ctx);
      expect(first.eventsEmitted).toBe(0);
      expect(h.store.getState(`ollama-serverlog:${h.logPath}`)?.extra).toMatchObject({ pendingBlocks: [{ evalCount: 8, promptEvalCount: 10 }] });
      expect(first.warnings).toContain('Dual capture is holding 1 server-log estimates for proxy/backlog settlement.');

      active = 0;
      now = endTsOf(10) + 3_000;
      const resumed = new OllamaServerlogCollector({ modelsDir: path.join(h.dir, 'no-models') });
      const second = await resumed.scan(h.ctx);
      expect(second.eventsEmitted).toBe(1);
      expect(h.logEvents()).toHaveLength(1);
      expect(h.store.getState(`ollama-serverlog:${h.logPath}`)?.extra).toMatchObject({ pendingBlocks: [] });
      expect(h.logEvents()[0]!.flags).toContain('serverlogEstimate');
    } finally {
      q.close();
      h.close();
    }
  });
  it('holds a dual-capture log block while the durable backlog reports ledger contention, then settles after drain', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    let locked = true;
    const now = endTsOf(10) + 3_000;
    const q = new MeteringBacklog(path.join(h.dir, 'metering-backlog'), () => { if (locked) throw new Error('database is locked'); }, { autoDrain: false, now: () => now });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.now = () => now;
      h.ctx.primaryOllamaActiveRequests = () => 0;
      h.ctx.meteringBacklogStatus = () => q.status();
      q.enqueue({ kind: 'unmetered', count: 1 });
      q.flush();
      expect(q.status().lastError).toBe('ledger-busy');
      expect((await h.collector.scan(h.ctx)).eventsEmitted).toBe(0);
      expect(h.logEvents()).toHaveLength(0);

      locked = false;
      q.flush();
      expect(q.status().pending).toBe(0);
      expect((await h.collector.scan(h.ctx)).eventsEmitted).toBe(1);
      expect(h.logEvents()).toHaveLength(1);
    } finally {
      q.close();
      h.close();
    }
  });
  it('suppresses a matching queued proxy completion immediately in both mode', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const now = endTsOf(10) + 500;
    const q = new MeteringBacklog(path.join(h.dir, 'metering-backlog'), () => {}, { autoDrain: false, now: () => now });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.now = () => now;
      h.ctx.primaryOllamaActiveRequests = () => 1;
      h.ctx.meteringBacklogStatus = () => q.status();
      h.ctx.pendingProxyEvents = q.pendingProxyEvents.bind(q);
      q.enqueue({ kind: 'event', event: { ...proxyEvent('ollama:M4a:both-queued:1', endTsOf(10), 1000, 8), engine: 'ollama' } });
      const s = await h.collector.scan(h.ctx);
      expect(s.eventsEmitted).toBe(0);
      expect(h.logEvents()).toHaveLength(0);
      expect(h.store.getState(`ollama-serverlog:${h.logPath}`)?.extra).toMatchObject({ pendingBlocks: [] });
      expect(q.status().pending).toBe(1);
    } finally {
      q.close();
      h.close();
    }
  });
  it('retains a pending block across log rotation and finalizes a deterministic duplicate once', async () => {
    const source = block(10, 10, 8) + '\n';
    const h = harness(source);
    let now = endTsOf(10) + 500;
    let active = 1;
    const q = new MeteringBacklog(path.join(h.dir, 'metering-backlog'), () => {}, { autoDrain: false, now: () => now });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.now = () => now;
      h.ctx.primaryOllamaActiveRequests = () => active;
      h.ctx.meteringBacklogStatus = () => q.status();
      expect((await h.collector.scan(h.ctx)).eventsEmitted).toBe(0);

      fs.renameSync(h.logPath, `${h.logPath}.rotated`);
      fs.writeFileSync(h.logPath, source);
      now = endTsOf(10) + 3_000;
      active = 0;
      const resumed = new OllamaServerlogCollector({ modelsDir: path.join(h.dir, 'no-models') });
      const settled = await resumed.scan(h.ctx);
      expect(settled.eventsEmitted).toBe(1);
      expect(h.logEvents()).toHaveLength(1);
      expect(h.store.getState(`ollama-serverlog:${h.logPath}`)?.extra).toMatchObject({ pendingBlocks: [], historyIncomplete: false });
    } finally {
      q.close();
      h.close();
    }
  });
  it('drains already-parsed settle blocks when configuration changes from both to serverlog', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    const now = endTsOf(10) + 500;
    const q = new MeteringBacklog(path.join(h.dir, 'metering-backlog'), () => {}, { autoDrain: false, now: () => now });
    try {
      h.ctx.config.local.capture = 'both';
      h.ctx.now = () => now;
      h.ctx.primaryOllamaActiveRequests = () => 1;
      h.ctx.meteringBacklogStatus = () => q.status();
      expect((await h.collector.scan(h.ctx)).eventsEmitted).toBe(0);
      const savedBeforeSwitch = h.store.getState(`ollama-serverlog:${h.logPath}`)!;
      expect(savedBeforeSwitch.extra?.cursorGuard).toMatch(/^[a-f0-9]{64}$/);
      const guardStart = Math.max(0, savedBeforeSwitch.offset - 16 * 1024);
      const currentPrefix = fs.readFileSync(h.logPath).subarray(guardStart, savedBeforeSwitch.offset);
      expect(savedBeforeSwitch.extra.cursorGuard).toBe(createHash('sha256').update(currentPrefix).digest('hex'));
      h.ctx.config.local.capture = 'serverlog';
      h.ctx.primaryOllamaActiveRequests = () => 0;
      const drained = await h.collector.scan(h.ctx);
      expect(drained.eventsEmitted).toBe(1);
      expect(h.logEvents()).toHaveLength(1);
      expect(h.store.getState(`ollama-serverlog:${h.logPath}`)?.extra).toMatchObject({ pendingBlocks: [] });
    } finally {
      q.close();
      h.close();
    }
  });
  it('holds the cursor when the dual-capture pending-block bound is reached', async () => {
    const h = harness(block(10, 10, 8) + '\n');
    try {
      const result = await tailServerLog(h.logPath, initialServerLogState(), new Map(), () => [], {
        host: 'M4a', deferBlocks: true, maxPendingBlocks: 0,
      });
      expect(result.events).toEqual([]);
      expect(result.bytesRead).toBe(0);
      expect(result.state.offset).toBe(0);
      expect(result.state.pendingLimitReached).toBe(true);
    } finally {
      h.close();
    }
  });
  it('guard discriminates: different evalCount, or an end time 2.5 s away, is NOT a double count', async () => {
    const h = harness(block(10, 10, 8) + '\n' + block(20, 10, 8) + '\n');
    try {
      h.store.upsertEvents([
        proxyEvent('ollama:M4a:1:1', endTsOf(10), 1000, 999), // same end, different evalCount
        proxyEvent('ollama:M4a:2:2', endTsOf(20) + 2500, 1000, 8), // same evalCount, outside ±2 s
      ]);
      const s = await h.collector.scan(h.ctx);
      expect(s.eventsEmitted).toBe(2);
    } finally {
      h.close();
    }
  });

  it('the event write and the cursor commit together (collector uses the reentrant store.transaction)', async () => {
    const h = harness(block(0, 10, 5) + '\n');
    try {
      const real = h.store.upsertEvents.bind(h.store);
      let calls = 0;
      h.store.upsertEvents = (events) => {
        calls++;
        real(events);
        throw new Error('disk full');
      };
      await expect(h.collector.scan(h.ctx)).rejects.toThrow('disk full');
      // Rolled back together: neither the event nor the advanced cursor survived.
      expect(h.logEvents()).toHaveLength(0);
      expect(h.store.getState(`ollama-serverlog:${h.logPath}`)).toBeUndefined();
      h.store.upsertEvents = real;
      await h.collector.scan(h.ctx);
      expect(h.logEvents()).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      h.close();
    }
  });
});
