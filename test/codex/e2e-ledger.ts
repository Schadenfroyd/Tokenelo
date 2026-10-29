/**
 * Real-data end-to-end run (NOT a vitest file): CodexCollector → real SqliteLedger (temp DB) with the real
 * pricing engine and valuation seam, against a CODEX_HOME read-only. Scans twice (the second scan must read nothing) and
 * prints only numbers. Usage:
 *   npx tsx test/codex/e2e-ledger.ts <CODEX_HOME> <tempDbFile>
 * or bundle with esbuild (--bundle --platform=node --format=esm) and run with node on another host.
 */
import { performance } from 'node:perf_hooks';
import { CodexCollector } from '../../src/collectors/codex.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import type { TokeneloConfig } from '../../src/core/types.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';

async function main(): Promise<void> {
  const [home, dbFile, pricesPath] = process.argv.slice(2);
  if (!home || !dbFile) throw new Error('usage: e2e-ledger <CODEX_HOME> <tempDbFile> [prices.json]');
  const db = openDb({ file: dbFile });
  const pricing = defaultPricingEngine(pricesPath);
  const computeUnits = createNullEngine();
  const store = new SqliteLedger(db, pricing, computeUnits);
  const ctx = {
    host: 'e2e',
    config: { hostLabel: 'e2e', codex: { homes: [home] } } as unknown as TokeneloConfig,
    store,
    pricing,
    computeUnits,
    log: () => {},
    now: () => Date.now(),
  };
  const c = new CodexCollector();
  const t0 = performance.now();
  const s1 = await c.scan(ctx);
  const t1 = performance.now();
  const s2 = await c.scan(ctx);
  const t2 = performance.now();
  const q = (sql: string) => db.prepare(sql).all();
  const report = {
    scan1: { ...s1, warnings: s1.warnings.length, firstWarnings: s1.warnings.slice(0, 3), ms: Math.round(t1 - t0) },
    scan2: { ...s2, warnings: s2.warnings.length, ms: Math.round(t2 - t1) },
    totals: q(`SELECT count(*) n, sum(input_fresh) input_fresh, sum(cache_read) cache_read, sum(cache_write_5m) cw5m,
      sum(output) output, sum(reasoning) reasoning, sum(input_fresh+cache_read+cache_write_5m+cache_write_1h+output) billable,
      round(sum(api_equiv_usd),2) usd, sum(api_equiv_usd IS NULL) unpriced FROM events WHERE source='codex'`),
    byModel: q(`SELECT model, price_status, count(*) n, sum(input_fresh+cache_read+cache_write_5m+cache_write_1h+output) billable,
      round(sum(api_equiv_usd),2) usd FROM events WHERE source='codex'
      GROUP BY model, price_status ORDER BY billable DESC`),
    tsSource: q(`SELECT ts_source, count(*) n FROM events GROUP BY ts_source`),
    flags: q(`SELECT flags_json, count(*) n FROM events GROUP BY flags_json ORDER BY n DESC LIMIT 12`),
    limits: q(`SELECT captured_at, plan_type, windows_json FROM limits ORDER BY captured_at DESC LIMIT 1`),
    activity: q(`SELECT kind, count(*) n, sum(duration_ms) dur FROM activity GROUP BY kind`),
    states: q(`SELECT count(*) n, sum(offset) bytes FROM ingest_state`),
  };
  process.stdout.write(JSON.stringify(report, null, 1) + '\n');
  db.close();
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
