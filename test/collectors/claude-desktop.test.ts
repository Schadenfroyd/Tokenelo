/**
 * Claude Desktop collectors (build items 2/3) — hand-computed against the real, verified shapes
 * (this Mac, 2026-09-27; see claude-desktop.ts's own doc comment for the exact field-level
 * evidence: plan-usage-history.json's `{t, org, u:{fh, sd}}` samples and claude-code-sessions'
 * `local_<uuid>.json` metadata schema).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import {
  ClaudeDesktopPlanUsageCollector,
  ClaudeDesktopSessionsCollector,
  hashOrgId,
  parsePlanUsageSample,
  parseDesktopSessionFile,
  resolveClaudeDesktopRoot,
} from '../../src/collectors/claude-desktop.js';
import type { IngestContext, TokeneloConfig } from '../../src/core/types.js';

function makeConfig(root: string): TokeneloConfig {
  return {
    hostLabel: 'M4a',
    accounts: [],
    idleGapMs: 300_000,
    claude: {},
    codex: {},
    qwen: {},
    claudeDesktop: { root },
    local: { capture: 'off', ollamaUpstream: 'http://127.0.0.1:11434', proxyPort: 11444, proxyInjectUsage: false },
    api: { port: 47821 },
    fleet: { peers: [], sharePaths: false },
  };
}

function makeCtx(config: TokeneloConfig) {
  const db = openDb({ file: ':memory:' });
  const pricing = defaultPricingEngine();
  const valuationEngine = createNullEngine();
  const ledger = new SqliteLedger(db, pricing, valuationEngine);
  let clock = 1_800_000_000_000;
  const ctx: IngestContext = { host: config.hostLabel, config, store: ledger, pricing, valuationEngine, log: () => {}, now: () => clock++ };
  return { db, ledger, ctx };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-claude-desktop-'));
}

describe('parsePlanUsageSample', () => {
  it('accepts the verified real shape {t, org, u:{fh, sd}}', () => {
    expect(parsePlanUsageSample({ t: 1000, org: 'org-1', u: { fh: 42, sd: 71 } })).toEqual({ t: 1000, org: 'org-1', fh: 42, sd: 71 });
  });
  it('rejects a flat-number u (an unverified/different schema version) rather than guessing', () => {
    expect(parsePlanUsageSample({ t: 1000, org: 'org-1', u: 42 })).toBeNull();
  });
  it('rejects a sample missing org/t or a non-numeric fh/sd', () => {
    expect(parsePlanUsageSample({ org: 'org-1', u: { fh: 1, sd: 2 } })).toBeNull();
    expect(parsePlanUsageSample({ t: 1000, u: { fh: 1, sd: 2 } })).toBeNull();
    expect(parsePlanUsageSample({ t: 1000, org: 'o', u: { fh: 'x', sd: 2 } })).toBeNull();
    expect(parsePlanUsageSample(null)).toBeNull();
    expect(parsePlanUsageSample('nope')).toBeNull();
  });
});

describe('hashOrgId', () => {
  it('is deterministic, 16 hex chars, and never equal to the raw input (never stores the raw org id)', () => {
    const h = hashOrgId('7107b9bc-c969-4af8-be33-10e0da6be1a6');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).toBe(hashOrgId('7107b9bc-c969-4af8-be33-10e0da6be1a6'));
    expect(h).not.toContain('7107b9bc');
    expect(hashOrgId('a-different-org')).not.toBe(h);
  });
});

describe('ClaudeDesktopPlanUsageCollector', () => {
  it('real-shaped samples: five_hour/seven_day windows mapped verbatim, account hashed, estimate:false', async () => {
    const root = tmpRoot();
    const samples = [
      { t: 1787951668284, org: '7107b9bc-c969-4af8-be33-10e0da6be1a6', u: { fh: 0, sd: 64 } },
      { t: 1787952568355, org: '7107b9bc-c969-4af8-be33-10e0da6be1a6', u: { fh: 1, sd: 64 } },
      { t: 1787953468403, org: '7107b9bc-c969-4af8-be33-10e0da6be1a6', u: { fh: 17, sd: 67 } },
    ];
    fs.writeFileSync(path.join(root, 'plan-usage-history.json'), JSON.stringify({ version: 2, samples }));
    const config = makeConfig(root);
    const { ledger, ctx, db } = makeCtx(config);
    try {
      const stats = await new ClaudeDesktopPlanUsageCollector().scan(ctx);
      expect(stats.eventsEmitted).toBe(3);
      // recordLimits went straight to the ledger; read back via the raw db (LedgerWriter has no
      // "getLimits" — that's queries.ts's job, tested separately).
      const rows = db.prepare(`SELECT * FROM limits WHERE source = 'claude-desktop' ORDER BY captured_at ASC`).all() as Array<{
        account: string;
        captured_at: number;
        windows_json: string;
        estimate: number;
      }>;
      expect(rows).toHaveLength(3);
      expect(rows[0]!.account).toBe(hashOrgId('7107b9bc-c969-4af8-be33-10e0da6be1a6'));
      expect(rows[0]!.estimate).toBe(0);
      expect(JSON.parse(rows[2]!.windows_json)).toEqual([
        { id: 'five_hour', usedPercent: 17 },
        { id: 'seven_day', usedPercent: 67 },
      ]);
      void ledger;
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('incremental: a second scan of the same (unchanged) file inserts nothing new; only newer samples are picked up on append', async () => {
    const root = tmpRoot();
    const filePath = path.join(root, 'plan-usage-history.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 2, samples: [{ t: 1000, org: 'o1', u: { fh: 1, sd: 2 } }] }));
    const config = makeConfig(root);
    const { ctx, db } = makeCtx(config);
    try {
      const collector = new ClaudeDesktopPlanUsageCollector();
      await collector.scan(ctx);
      const again = await collector.scan(ctx);
      expect(again.eventsEmitted).toBe(0);

      fs.writeFileSync(
        filePath,
        JSON.stringify({ version: 2, samples: [{ t: 1000, org: 'o1', u: { fh: 1, sd: 2 } }, { t: 2000, org: 'o1', u: { fh: 5, sd: 3 } }] })
      );
      const third = await collector.scan(ctx);
      expect(third.eventsEmitted).toBe(1); // only the t:2000 sample is new
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM limits WHERE source='claude-desktop'`).get() as { n: number }).n;
      expect(count).toBe(2);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing plan-usage-history.json (no Desktop app / never used Code) yields zero files scanned, not an error', async () => {
    const root = tmpRoot();
    const config = makeConfig(root);
    const { ctx, db } = makeCtx(config);
    try {
      const stats = await new ClaudeDesktopPlanUsageCollector().scan(ctx);
      expect(stats.filesScanned).toBe(0);
      expect(stats.warnings).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseDesktopSessionFile', () => {
  it('allow-lists exactly the documented fields — every other real key (permission state, MCP config, spawn seed, …) is dropped', () => {
    const raw = {
      sessionId: 'local_f2f8f655-85b9-4209-becc-2cf1a9ae4eae',
      cliSessionId: 'fe959cb2-dcfd-4400-8cae-fd9f80c41175',
      cwd: '/Users/example/Workspaces/fixture',
      originCwd: '/Users/example/Workspaces/fixture',
      lastFocusedAt: 123,
      createdAt: 1783274052246,
      lastActivityAt: 1783285091104,
      model: 'claude-haiku-4-5-20251001',
      effort: 'xhigh',
      isArchived: true,
      title: 'Fixture session',
      titleSource: 'auto',
      permissionMode: 'bypassPermissions',
      remoteMcpServersConfig: { secretToken: 'do-not-store-me' },
      prNumber: 1226,
      prUrl: 'https://github.com/example/fixture-repo/pull/1226',
      prRepository: 'example/fixture-repo',
      prState: 'MERGED',
      prs: [{ prNumber: 1226 }],
      chromePermissionMode: 'x',
      completedTurns: 13,
      bridgeSessionIds: ['a'],
      alwaysAllowedReasons: ['b'],
      sessionPermissionUpdates: ['c'],
      spawnSeed: 'seed-value',
    };
    const meta = parseDesktopSessionFile(raw);
    expect(meta).toEqual({
      cliSessionId: 'fe959cb2-dcfd-4400-8cae-fd9f80c41175',
      cwd: '/Users/example/Workspaces/fixture',
      originCwd: '/Users/example/Workspaces/fixture',
      title: 'Fixture session',
      model: 'claude-haiku-4-5-20251001',
      effort: 'xhigh',
      isArchived: true,
      createdAt: 1783274052246,
      lastActivityAt: 1783285091104,
      prNumber: 1226,
      prUrl: 'https://github.com/example/fixture-repo/pull/1226',
      prRepository: 'example/fixture-repo',
      prState: 'MERGED',
    });
    // Every disallowed key is genuinely absent from the parsed result, not merely unchecked.
    for (const k of ['remoteMcpServersConfig', 'prs', 'bridgeSessionIds', 'alwaysAllowedReasons', 'sessionPermissionUpdates', 'spawnSeed', 'permissionMode']) {
      expect(Object.prototype.hasOwnProperty.call(meta, k)).toBe(false);
    }
  });

  it('a file with no cliSessionId (e.g. the real scheduled-tasks.json sibling) is not a session-meta document', () => {
    expect(parseDesktopSessionFile({ tasks: [] })).toBeNull();
  });
});

describe('ClaudeDesktopSessionsCollector', () => {
  it('never descends into a local_<uuid> DIRECTORY (a session output-artifacts tree, e.g. a vendored node_modules) — real bug found on this Mac 2026-09-27', async () => {
    const root = tmpRoot();
    const sessionsDir = path.join(root, 'claude-code-sessions', 'inst-1', 'org-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'local_real.json'), JSON.stringify({ cliSessionId: 'cli-real' }));
    // local_baeeb764.../outputs/node_modules/jszip/tsconfig.json — a directory, not a file, with a
    // deeply nested non-JSON-superset file (tsconfig.json has comments) that must never be reached.
    const outputsDir = path.join(sessionsDir, 'local_baeeb764-9f06-4d17-99ac-4c99b250b25b', 'outputs', 'node_modules', 'jszip');
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'tsconfig.json'), '{ // not valid JSON\n "x": 1 }');
    fs.writeFileSync(path.join(outputsDir, 'package.json'), JSON.stringify({ name: 'jszip', cliSessionId: 'should-never-be-read' }));

    const config = makeConfig(root);
    const { ctx, db } = makeCtx(config);
    try {
      const stats = await new ClaudeDesktopSessionsCollector().scan(ctx);
      expect(stats.filesScanned).toBe(1); // only local_real.json — the outputs/ tree is never walked
      expect(stats.warnings).toEqual([]); // no parse-error warning from tsconfig.json
      expect(stats.eventsEmitted).toBe(1);
      const row = db.prepare(`SELECT cli_session_id FROM desktop_sessions WHERE cli_session_id = 'should-never-be-read'`).get();
      expect(row).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('upserts real-shaped local_<uuid>.json files, skips a non-session sibling, and is a no-op on an unchanged re-scan', async () => {
    const root = tmpRoot();
    const sessionsDir = path.join(root, 'claude-code-sessions', 'inst-1', 'org-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'local_abc.json'),
      JSON.stringify({ cliSessionId: 'cli-session-1', cwd: '/fixture', title: 'Fixture', prNumber: 42 })
    );
    fs.writeFileSync(path.join(sessionsDir, 'scheduled-tasks.json'), JSON.stringify({ tasks: [] }));

    const config = makeConfig(root);
    const { ctx, db } = makeCtx(config);
    try {
      const collector = new ClaudeDesktopSessionsCollector();
      const stats = await collector.scan(ctx);
      expect(stats.filesScanned).toBe(2);
      expect(stats.eventsEmitted).toBe(1); // only the real session file

      const row = db.prepare(`SELECT * FROM desktop_sessions WHERE cli_session_id = ?`).get('cli-session-1') as {
        cwd: string;
        title: string;
        pr_number: number;
      };
      expect(row.cwd).toBe('/fixture');
      expect(row.title).toBe('Fixture');
      expect(row.pr_number).toBe(42);

      const again = await collector.scan(ctx);
      expect(again.eventsEmitted).toBe(0); // unchanged mtime/size — never re-parsed
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveClaudeDesktopRoot', () => {
  it('config override wins; else platform default (never the bare CLI\'s ~/.claude)', () => {
    expect(resolveClaudeDesktopRoot({ claudeDesktop: { root: '/custom' } } as never)).toBe('/custom');
    const darwin = resolveClaudeDesktopRoot({ claudeDesktop: {} } as never, { platform: 'darwin', home: '/Users/x', env: {} });
    expect(darwin).toBe(path.join('/Users/x', 'Library', 'Application Support', 'Claude'));
    const win = resolveClaudeDesktopRoot({ claudeDesktop: {} } as never, { platform: 'win32', home: 'C:\\Users\\x', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } });
    expect(win).toBe(path.join('C:\\Users\\x\\AppData\\Roaming', 'Claude'));
  });
});
