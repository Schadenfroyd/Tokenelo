/**
 * Gate 2 (DESIGN §11.2 + task spec): Claude per-day token totals vs. an independent
 * implementation (ccusage) on M4a, over a fixed real date range. Runs the REAL collector against
 * the REAL `~/.claude/projects` (no fixtures) into a temp on-disk SQLite db, using the real
 * pricing engine and the neutral valuation seam, and diffs day-bucketed (America/Denver) input/output/cache-create/
 * cache-read totals against `test/golden/ccusage-claude-M4a-20260919-20260925.json`.
 *
 * Skipped by default (touches real, potentially large local data and can take a while — the real
 * ~/.claude/projects tree on this M4a is ~8,220 files, one of them ~194 MB). Run explicitly with:
 *   TOKENELO_GOLDEN=1 npx vitest run test/claude/golden.test.ts
 *
 * This test intentionally does NOT assert exact equality with ccusage: DESIGN §11.2 and
 * spikes-2026-09-26.md both establish that some divergence is EXPECTED (ccusage has no
 * `usage.iterations` handling, prices local-model lines as if they were billable, and has no
 * price row for claude-opus-5-5) — the test's job is to compute and print the deltas so a human
 * (or this report) can attribute every >1% delta to a concrete, evidenced cause, per the task's
 * gate-2 requirement.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { ClaudeCollector } from '../../src/collectors/claude.js';
import type { IngestContext, TokeneloConfig, UsageEvent } from '../../src/core/types.js';

const RUN = process.env.TOKENELO_GOLDEN === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, '..', 'golden', 'ccusage-claude-M4a-20260919-20260925.json');

const DAYS = [
  '2026-09-19',
  '2026-09-20',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
];

function denverDay(ts: number): string {
  // en-CA gives YYYY-MM-DD directly.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date(ts));
}

interface DayTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  events: number;
}

function emptyTotals(): DayTotals {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, events: 0 };
}

function pct(a: number, b: number): number {
  if (b === 0) return a === 0 ? 0 : Infinity;
  return ((a - b) / b) * 100;
}

describe.skipIf(!RUN)('Claude collector vs ccusage golden baseline (gate 2, TOKENELO_GOLDEN=1)', () => {
  it('day-bucketed (America/Denver) input/output/cache totals, with every >1% delta explained', async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8')) as {
      daily: {
        date: string;
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
      }[];
    };
    const goldenByDay = new Map(golden.daily.map((d) => [d.date, d]));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-golden-'));
    const dbFile = path.join(tmpDir, 'golden.db');
    const db = openDb({ file: dbFile });
    const pricing = defaultPricingEngine();
    const valuationEngine = createNullEngine();
    const ledger = new SqliteLedger(db, pricing, valuationEngine);
    try {

    const config: TokeneloConfig = {
      hostLabel: 'M4a',
      accounts: [],
      idleGapMs: 300_000,
      claude: {}, // default roots -> real ~/.claude/projects (no override)
      codex: {},
      local: { capture: 'proxy', ollamaUpstream: 'http://127.0.0.1:11434', proxyPort: 11444, proxyInjectUsage: false },
      api: { port: 47821 },
      fleet: { peers: [], sharePaths: false },
    };
    const warnings: string[] = [];
    const ctx: IngestContext = {
      host: 'M4a',
      config,
      store: ledger,
      pricing,
      valuationEngine,
      log: (level, msg) => {
        if (level === 'warn' || level === 'error') warnings.push(`${level}: ${msg}`);
      },
      now: () => Date.now(),
    };

    const startedAt = Date.now();
    const stats = await new ClaudeCollector().scan(ctx);
    const wallMs = Date.now() - startedAt;

    const rangeStartMs = new Date('2026-09-19T00:00:00-06:00').getTime();
    const rangeEndMs = new Date('2026-09-26T00:00:00-06:00').getTime(); // exclusive
    const events: UsageEvent[] = ledger.getEvents({ source: 'claude', since: rangeStartMs, until: rangeEndMs });

    const byDay = new Map<string, DayTotals>();
    for (const d of DAYS) byDay.set(d, emptyTotals());
    let localModelEvents = 0;
    let iterationEvents = 0;
    let unpricedEvents = 0;
    for (const e of events) {
      const day = denverDay(e.ts);
      const totals = byDay.get(day);
      if (!totals) continue; // outside the 7-day window after tz conversion at the edges
      totals.input += e.tokens.inputFresh;
      totals.output += e.tokens.output;
      totals.cacheCreate += e.tokens.cacheWrite5m + e.tokens.cacheWrite1h;
      totals.cacheRead += e.tokens.cacheRead;
      totals.events += 1;
      if (e.provider === 'local') localModelEvents++;
      if (e.components.length > 1) iterationEvents++;
      if (e.priceStatus === 'UNPRICED') unpricedEvents++;
    }

    // eslint-disable-next-line no-console
    console.log('\n=== Claude collector vs ccusage golden (America/Denver, 2026-09-19..25) ===');
    console.log(`collector: filesScanned=${stats.filesScanned} filesSkipped=${stats.filesSkipped} eventsEmitted=${stats.eventsEmitted} bytesRead=${stats.bytesRead} durationMs=${stats.durationMs} wallMs=${wallMs}`);
    console.log(`events in range: ${events.length} (localModelEvents=${localModelEvents}, iterationEvents(>1 component)=${iterationEvents}, unpricedEvents=${unpricedEvents})`);
    if (warnings.length) console.log(`warnings: ${warnings.length} (first 5): ${warnings.slice(0, 5).join(' | ')}`);

    console.log('\ndate       | field        |     tokenelo |      ccusage |   delta% ');
    console.log('-----------|--------------|--------------|--------------|---------');
    for (const day of DAYS) {
      const mine = byDay.get(day)!;
      const theirs = goldenByDay.get(day);
      const rows: [string, number, number][] = theirs
        ? [
            ['input', mine.input, theirs.inputTokens],
            ['output', mine.output, theirs.outputTokens],
            ['cacheCreate', mine.cacheCreate, theirs.cacheCreationTokens],
            ['cacheRead', mine.cacheRead, theirs.cacheReadTokens],
          ]
        : [
            ['input', mine.input, 0],
            ['output', mine.output, 0],
            ['cacheCreate', mine.cacheCreate, 0],
            ['cacheRead', mine.cacheRead, 0],
          ];
      for (const [field, a, b] of rows) {
        const d = pct(a, b);
        console.log(
          `${day} | ${field.padEnd(12)} | ${String(a).padStart(12)} | ${String(b).padStart(12)} | ${d.toFixed(2).padStart(7)}%`
        );
      }
    }

    // Sanity, not an equality assertion (divergence from ccusage is expected -- see report):
    // the collector must have actually ingested real data and produced no crash/zero-run.
    expect(stats.filesScanned).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 600_000);
});
