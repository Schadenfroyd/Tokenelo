/**
 * Qwen Code collector (build item 1) — hand-computed against sanitized real-shaped lines (the
 * exact field names/arithmetic verified live on this Mac, 2026-09-27, see qwen-code.ts's own doc
 * comment for the real sample lines this fixture is modeled on).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { QwenCodeCollector, resolveQwenRoots, makeQwenEventId } from '../../src/collectors/qwen-code.js';
import type { IngestContext, TokeneloConfig } from '../../src/core/types.js';

function makeConfig(qwenRoot: string): TokeneloConfig {
  return {
    hostLabel: 'TEST',
    accounts: [],
    idleGapMs: 300_000,
    claude: {},
    codex: {},
    qwen: { roots: [qwenRoot] },
    claudeDesktop: {},
    local: { capture: 'off', ollamaUpstream: 'http://127.0.0.1:11434', proxyPort: 11444, proxyInjectUsage: false },
    api: { port: 47821 },
    fleet: { peers: [], sharePaths: false },
  };
}

function makeCtx(config: TokeneloConfig) {
  const db = openDb({ file: ':memory:' });
  const pricing = defaultPricingEngine();
  const computeUnits = createNullEngine();
  const ledger = new SqliteLedger(db, pricing, computeUnits);
  let clock = 1_800_000_000_000;
  const ctx: IngestContext = {
    host: config.hostLabel,
    config,
    store: ledger,
    pricing,
    computeUnits,
    log: () => {},
    now: () => clock++,
  };
  return { db, ledger, ctx };
}

function tmpQwenRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-qwen-'));
  fs.mkdirSync(path.join(dir, 'usage'), { recursive: true });
  return dir;
}

const MODEL = 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL';

describe('QwenCodeCollector', () => {
  it.each([
    ['qwen3-coder-plus', 'qwen-oauth', 'hosted', 'qwen-oauth'],
    ['qwen3:8b', 'openai', 'unknown', 'qwen-openai-compatible'],
    [MODEL, 'openai', 'unknown', 'qwen-openai-compatible'],
    [MODEL, undefined, 'unknown', 'unrecorded'],
    ['gemma4:26b', 'openai', 'unknown', 'qwen-openai-compatible'],
    ['llama-3.3-70b-instruct', 'openai', 'unknown', 'qwen-openai-compatible'],
    ['some-other-model.gguf', 'private-credential-like-value', 'unknown', 'unrecorded'],
  ])('does not invent local/free execution for %s with %s authentication', async (model, authType, kind, evidence) => {
    const root = tmpQwenRoot();
    const { ledger, ctx, db } = makeCtx(makeConfig(root));
    try {
      fs.writeFileSync(path.join(root, 'usage', 'token-usage-2026-09.jsonl'), JSON.stringify({
        id: 'route-test', timestamp: '2026-09-21T00:00:00.000Z', sessionId: 'route-session',
        model, authType, inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtsTokens: 0,
      }) + '\n');
      await new QwenCodeCollector().scan(ctx);
      const [event] = ledger.getEvents({ source: 'qwen-code' });
      expect(event!.provider).toBe('unknown');
      expect(event!.apiEquivUsd).toBeNull();
      expect(event!.priceStatus).toBe('UNPRICED');
      expect(event!.flags).toContain('servingRouteUnpriced');
      expect((event!.components[0] as unknown as { servingRoute: unknown }).servingRoute).toEqual({ kind, evidence });
      expect(ctx.pricing.priceEvent(event!).usd).toBeNull(); // persisted component survives ledger repricing
      expect(JSON.stringify(event)).not.toContain('private-credential-like-value');
      expect(event!.tokens.inputFresh + event!.tokens.output).toBe(110);
    } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('two real-shaped lines: tokens map exactly (input/output/thoughts subset), project attributed from usage_record.jsonl, no double count', async () => {
    const root = tmpQwenRoot();
    const line1 = {
      schemaVersion: 1,
      id: 'e6954d75-534a-41d3-9f21-97cdd1c16e0d',
      timestamp: '2026-09-21T16:49:25.175Z',
      sessionId: '8a22879b-358c-4d5b-9858-3d30170ff82d',
      model: MODEL,
      source: 'main',
      inputTokens: 12524,
      outputTokens: 97,
      cachedTokens: 0,
      thoughtsTokens: 24,
      totalTokens: 12621,
      apiDurationMs: 247460,
    };
    const line2 = {
      schemaVersion: 1,
      id: '09873265-dccc-4498-8ad2-9114bad06835',
      timestamp: '2026-09-21T16:49:36.711Z',
      sessionId: '8a22879b-358c-4d5b-9858-3d30170ff82d',
      model: MODEL,
      source: 'main',
      inputTokens: 12622,
      outputTokens: 49,
      cachedTokens: 0,
      thoughtsTokens: 38,
      totalTokens: 12671,
      apiDurationMs: 11375,
    };
    fs.writeFileSync(
      path.join(root, 'usage', 'token-usage-2026-09.jsonl'),
      `${JSON.stringify(line1)}\n${JSON.stringify(line2)}\n`
    );
    // usage_record.jsonl: session-level rollup carrying `project` — must NOT produce any event.
    fs.writeFileSync(
      path.join(root, 'usage_record.jsonl'),
      `${JSON.stringify({
        version: 1,
        sessionId: '8a22879b-358c-4d5b-9858-3d30170ff82d',
        timestamp: 1790009376860,
        startTime: 1790009116834,
        project: '/private/var/folders/fixture/example-qwen-verify.Qd7nQL',
        durationMs: 260026,
        models: { [MODEL]: { requests: 2, inputTokens: 25146, outputTokens: 146, cachedTokens: 0, thoughtsTokens: 62, totalTokens: 25292, totalLatencyMs: 258835 } },
      })}\n`
    );

    const config = makeConfig(root);
    const { ledger, ctx, db } = makeCtx(config);
    try {
      const collector = new QwenCodeCollector();
      const stats = await collector.scan(ctx);
      expect(stats.eventsEmitted).toBe(2);
      expect(stats.filesSkipped).toBe(0);

      const events = ledger.getEvents({ source: 'qwen-code' });
      expect(events).toHaveLength(2);

      const e1 = events.find((e) => e.id === makeQwenEventId(line1.id))!;
      expect(e1).toBeTruthy();
      expect(e1.tokens).toEqual({ inputFresh: 12524, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 97, reasoning: 24 });
      expect(e1.thinking).toBe(true); // thoughtsTokens > 0
      expect(e1.project).toBe('/private/var/folders/fixture/example-qwen-verify.Qd7nQL'); // from usage_record, not the per-line fixture
      expect(e1.durationMs).toBe(247460);
      expect(e1.entrypoint).toBe('main');
      expect(e1.provider).toBe('unknown'); // weights name alone does not prove local serving
      expect(e1.apiEquivUsd).toBeNull(); // missing route evidence cannot establish a free rate
      expect(e1.components[0]!.servingRoute).toEqual({ kind: 'unknown', evidence: 'unrecorded' });

      const e2 = events.find((e) => e.id === makeQwenEventId(line2.id))!;
      expect(e2.tokens.output).toBe(49);
      expect(e2.tokens.reasoning).toBe(38);

      // Re-scanning (incremental cursor) must not double-count.
      const stats2 = await collector.scan(ctx);
      expect(stats2.eventsEmitted).toBe(0);
      expect(ledger.getEvents({ source: 'qwen-code' })).toHaveLength(2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an appended third line after a prior scan is picked up incrementally (byte-offset cursor)', async () => {
    const root = tmpQwenRoot();
    const filePath = path.join(root, 'usage', 'token-usage-2026-09.jsonl');
    const mk = (id: string, ts: string) =>
      JSON.stringify({ id, timestamp: ts, sessionId: 's1', model: MODEL, source: 'main', inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtsTokens: 0, totalTokens: 110 });
    fs.writeFileSync(filePath, `${mk('a', '2026-09-21T00:00:00.000Z')}\n`);

    const config = makeConfig(root);
    const { ledger, ctx, db } = makeCtx(config);
    try {
      const collector = new QwenCodeCollector();
      await collector.scan(ctx);
      expect(ledger.getEvents({ source: 'qwen-code' })).toHaveLength(1);

      fs.appendFileSync(filePath, `${mk('b', '2026-09-21T00:01:00.000Z')}\n`);
      const stats = await collector.scan(ctx);
      expect(stats.eventsEmitted).toBe(1);
      expect(ledger.getEvents({ source: 'qwen-code' })).toHaveLength(2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('thoughtsTokens > outputTokens is clamped and flagged reasoningClamped (never negative/over-counted)', async () => {
    const root = tmpQwenRoot();
    fs.writeFileSync(
      path.join(root, 'usage', 'token-usage-2026-09.jsonl'),
      `${JSON.stringify({ id: 'x', timestamp: '2026-09-21T00:00:00.000Z', sessionId: 's1', model: MODEL, inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtsTokens: 999 })}\n`
    );
    const config = makeConfig(root);
    const { ledger, ctx, db } = makeCtx(config);
    try {
      await new QwenCodeCollector().scan(ctx);
      const [e] = ledger.getEvents({ source: 'qwen-code' });
      expect(e!.tokens.reasoning).toBe(10); // clamped to output
      expect(e!.flags).toContain('reasoningClamped');
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a line missing required fields (no id/timestamp/sessionId/model) is silently skipped, not an error', async () => {
    const root = tmpQwenRoot();
    fs.writeFileSync(path.join(root, 'usage', 'token-usage-2026-09.jsonl'), `${JSON.stringify({ inputTokens: 5 })}\n{not json\n`);
    const config = makeConfig(root);
    const { ledger, ctx, db } = makeCtx(config);
    try {
      const stats = await new QwenCodeCollector().scan(ctx);
      expect(stats.eventsEmitted).toBe(0);
      expect(ledger.getEvents({ source: 'qwen-code' })).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  describe('resolveQwenRoots', () => {
    it('config.qwen.roots wins when set; else defaults to ~/.qwen', () => {
      expect(resolveQwenRoots({ qwen: { roots: ['/custom/qwen'] } } as never)).toEqual(['/custom/qwen']);
      const home = '/Users/fixture-home';
      expect(resolveQwenRoots({ qwen: {} } as never, home)).toEqual([path.join(home, '.qwen')]);
    });
  });
});
