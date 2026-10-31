/**
 * Test-only harness for the Claude collector: a real in-memory SqliteLedger wired to the REAL
 * pricing engine (src/core/pricing.ts + rates/*.json) and the neutral valuation seam
 * (src/core/null-engine.ts), so every dollar assertion in claude.test.ts checks real,
 * hand-verifiable numbers and every reserved valuation column stays unknown.
 * Not a test file itself (vitest only collects test/**\/*.test.ts).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type TokeneloDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import type { IngestContext, TokeneloConfig } from '../../src/core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(__dirname, '..', 'fixtures', 'claude');
export const PROJECTS_ROOT = path.join(FIXTURES, 'projects');
export const SYNC_VAULT_ROOT = path.join(FIXTURES, 'sync-vault');

export function baseTestConfig(overrides?: Partial<TokeneloConfig['claude']>): TokeneloConfig {
  return {
    hostLabel: 'TEST',
    accounts: [],
    idleGapMs: 300_000,
    claude: { roots: [PROJECTS_ROOT], ...overrides },
    codex: {},
    local: {
      capture: 'proxy',
      ollamaUpstream: 'http://127.0.0.1:11434',
      proxyPort: 11444,
      proxyInjectUsage: false,
    },
    api: { port: 47821 },
    fleet: { peers: [], sharePaths: false },
  };
}

export interface TestHarness {
  db: TokeneloDb;
  ledger: SqliteLedger;
  ctx: IngestContext;
  logs: { level: string; msg: string; data?: Record<string, unknown> }[];
  close(): void;
}

let clock = 1_700_000_000_000;

export function makeHarness(config: TokeneloConfig): TestHarness {
  const db = openDb({ file: ':memory:' });
  const pricing = defaultPricingEngine();
  const valuationEngine = createNullEngine();
  const ledger = new SqliteLedger(db, pricing, valuationEngine);
  const logs: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const ctx: IngestContext = {
    host: config.hostLabel,
    config,
    store: ledger,
    pricing,
    valuationEngine,
    log: (level, msg, data) => {
      logs.push({ level, msg, data });
    },
    now: () => clock++,
  };
  return { db, ledger, ctx, logs, close: () => db.close() };
}
