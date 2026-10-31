/**
 * GATE 4 (DESIGN.md §11.4 / this task's brief): reconstruct every modelUsage entry's costUSD from
 * 40 real `claude -p --output-format json` outputs (test/fixtures/claude-p-outputs.json, sanitized
 * — no prompt/response text, ids/timestamps/model names/usage numbers kept), treating
 * `cacheCreationInputTokens` entirely as 1-hour cache writes (spikes-2026-09-26.md S8: "43/43
 * exact under that assumption"). Every entry must reconstruct within $0.01 of the real costUSD
 * Claude Code itself reported (costBasis "list").
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPricingEngine } from '../../src/core/pricing.js';
import type { UsageComponent } from '../../src/core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/claude-p-outputs.json');

interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  costBasis?: string | null;
  canonicalModel?: string;
}

interface FixtureRow {
  file: string;
  session_id: string;
  total_cost_usd: number;
  modelUsage: Record<string, ModelUsageEntry>;
}

describe('GATE 4 — pricing vs Claude Code modelUsage.costUSD (costBasis "list")', () => {
  const engine = defaultPricingEngine();
  const rows: FixtureRow[] = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

  it('fixture shape: 40 rows, 43 modelUsage entries, only claude-sonnet-5 / claude-opus-5-5 appear', () => {
    expect(rows.length).toBe(40);
    const models = new Set<string>();
    let entryCount = 0;
    for (const row of rows) {
      for (const model of Object.keys(row.modelUsage)) {
        models.add(model);
        entryCount++;
      }
    }
    expect(entryCount).toBe(43);
    expect(models).toEqual(new Set(['claude-sonnet-5', 'claude-opus-5-5']));
  });

  it('reconstructs every entry within $0.01, cacheCreationInputTokens treated as 1h writes', () => {
    const diffs: { session: string; model: string; ours: number; theirs: number; diff: number }[] = [];

    for (const row of rows) {
      for (const [model, u] of Object.entries(row.modelUsage)) {
        const component: UsageComponent = {
          model,
          tokens: {
            inputFresh: u.inputTokens,
            cacheWrite5m: 0,
            cacheWrite1h: u.cacheCreationInputTokens,
            cacheRead: u.cacheReadInputTokens,
            output: u.outputTokens,
            reasoning: 0,
          },
        };
        const result = engine.priceComponent(component);
        expect(result.usd, `${row.session_id} / ${model} was UNPRICED`).not.toBeNull();
        const ours = result.usd as number;
        diffs.push({ session: row.session_id, model, ours, theirs: u.costUSD, diff: Math.abs(ours - u.costUSD) });
      }
    }

    expect(diffs.length).toBe(43);
    const failures = diffs.filter((d) => d.diff > 0.01);
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  });

  it('every entry is priced at status LIST (both models seen are independently vendor-verified this session)', () => {
    for (const row of rows) {
      for (const [model, u] of Object.entries(row.modelUsage)) {
        const result = engine.priceComponent({
          model,
          tokens: {
            inputFresh: u.inputTokens,
            cacheWrite5m: 0,
            cacheWrite1h: u.cacheCreationInputTokens,
            cacheRead: u.cacheReadInputTokens,
            output: u.outputTokens,
            reasoning: 0,
          },
        });
        expect(result.status).toBe('LIST');
      }
    }
  });
});
