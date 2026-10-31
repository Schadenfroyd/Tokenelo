import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCli } from '../../src/cli/index.js';
import { getPaths, ensureDirs } from '../../src/daemon/paths.js';
import { defaultConfig, saveConfig } from '../../src/daemon/config.js';
import { openDb } from '../../src/store/db.js';
import { SqliteLedger } from '../../src/store/ledger.js';
import { createNullEngine } from '../../src/core/null-engine.js';
import { createPricingEngine, loadPriceRows } from '../../src/core/pricing.js';
import type { UsageEvent } from '../../src/core/types.js';

const prefix = 'tokenelo-reprice-intent-';
const rejected = [
  ['--dry-run', 'yes'], ['--dryrun'], ['--dry-run=false'], ['--dry-run=maybe'],
  ['junk'], ['--dry-run', 'junk'], ['--dry-run', '--unknown'],
  ['--dry-run=false', '--dry-run'], ['--dry-run', '--dry-run=false'],
  ['--dry-run=true', '--dry-run=1'], ['--range', 'all'], ['--dry-run=true', 'extra'],
];
let root: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  previousHome = process.env.TOKENELO_HOME;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.TOKENELO_HOME;
  else process.env.TOKENELO_HOME = previousHome;
  // Only the absolute temporary directory this case created may be removed.
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith(prefix)) {
    throw new Error('owned fixture path escaped');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function invoke(args: string[]): Promise<{ code: number; preview: boolean }> {
  const out: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: string) => { out.push(String(chunk)); return true; };
  (process.stderr.write as unknown) = () => true;
  try {
    const code = await runCli(['reprice', ...args]);
    let preview = false;
    try { preview = JSON.parse(out.join('')).dryRun === true; } catch { /* rejected invocation */ }
    return { code, preview };
  } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
}

async function invokeJson(args: string[]): Promise<Record<string, any>> {
  const out: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  (process.stdout.write as unknown) = (chunk: string) => { out.push(String(chunk)); return true; };
  try {
    expect(await runCli(['reprice', ...args])).toBe(0);
    return JSON.parse(out.join(''));
  } finally { process.stdout.write = realOut; }
}

function seed(): string {
  process.env.TOKENELO_HOME = root;
  const paths = getPaths();
  ensureDirs(paths);
  const roots = ['claude', 'codex', 'qwen', 'desktop'].map(name => path.join(root, name));
  for (const dir of roots) fs.mkdirSync(dir);
  const cfg = defaultConfig({ hostLabel: 'owned-reprice-intent' });
  saveConfig(paths, { ...cfg, claude: { roots: [roots[0]!] }, codex: { homes: [roots[1]!] },
    qwen: { roots: [roots[2]!] }, claudeDesktop: { root: roots[3]! }, local: { ...cfg.local, capture: 'off' } });
  const oldRows = loadPriceRows().map(row => row.id === 'claude-sonnet-5'
    ? { ...row, rates: { ...row.rates, in: 1, out: 5 } } : row);
  const tokens = { inputFresh: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 2000, reasoning: 0 };
  const db = openDb({ file: paths.dbFile });
  try {
    new SqliteLedger(db, createPricingEngine(oldRows), createNullEngine()).upsertEvents([{
      id: 'owned-reprice-intent', host: 'owned-reprice-intent', source: 'claude', ts: 1791900000000,
      tsSource: 'line', sessionId: 'owned-session', isSubagent: false, model: 'claude-sonnet-5', provider: 'anthropic',
      components: [{ model: 'claude-sonnet-5', tokens: { ...tokens } }], tokens, flags: [],
      apiEquivUsd: -999, priceStatus: 'UNPRICED', priceVersion: 'owned-old-table',
      reservedValue: -999, ucuRateStatus: 'NONE', eacsDefSha256: 'owned-old-definition',
    } as UsageEvent]);
  } finally { db.close(); }
  return paths.dbFile;
}

function state(file: string): { digest: string; usd: number } {
  const db = openDb({ file, readOnly: true });
  try {
    const schema = db.prepare("SELECT name,type,sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger') ORDER BY name").all() as { name: string; type: string }[];
    const stringify = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === 'bigint' ? `${x}n` : x);
    const rows = Object.fromEntries(schema.filter(x => x.type === 'table').map(({ name }) => {
      const table = `main."${name.replaceAll('"', '""')}"`;
      let values: unknown[];
      try { values = db.prepare(`SELECT rowid AS __rowid,* FROM ${table}`).all(); }
      catch { values = db.prepare(`SELECT * FROM ${table}`).all(); }
      return [name, values.map(stringify).sort()];
    }));
    const usd = (db.prepare("SELECT api_equiv_usd AS usd FROM main.event_projection WHERE id='owned-reprice-intent'").get() as { usd: number }).usd;
    return { digest: crypto.createHash('sha256').update(stringify({ schema, rows })).digest('hex'), usd };
  } finally { db.close(); }
}

describe('repricing requires unambiguous write intent', () => {
  it.each(['--dry-run', '--dry-run=true', '--dry-run=1'])('%s previews without changing any logical table or schema', async flag => {
    const file = seed();
    const before = state(file);
    expect(before.usd).toBeCloseTo(0.011, 10);
    expect(await invoke([flag])).toEqual({ code: 0, preview: true });
    expect(state(file)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'data', 'backups'))).toBe(false);
  });
  it('reports price and measurement changes only: the preview receipt and the written result carry no valuation keys', async () => {
    const changeKeys = ['countQualityChanged', 'priceStatusChanged', 'priceVersionChanged', 'providerChanged', 'tokensChanged', 'usdChanged'];
    seed();
    const preview = await invokeJson(['--dry-run']);
    expect(Object.keys(preview.totals).sort()).toEqual(['events', ...changeKeys].sort());
    expect(preview.totals).toMatchObject({ events: 1, usdChanged: 1 });
    expect(preview.groups).toHaveLength(1);
    expect(Object.keys(preview.groups[0]).sort()).toEqual(['events', 'mode', 'model', ...changeKeys].sort());
    expect(preview.groups[0]).toMatchObject({ model: 'claude-sonnet-5', events: 1, usdChanged: 1 });
    const written = await invokeJson([]);
    expect(Object.keys(written).sort()).toEqual(['backup', 'inserted', 'unchanged', 'updated', ...changeKeys].sort());
    expect(written).toMatchObject({ inserted: 0, updated: 1, unchanged: 0, usdChanged: 1 });
  });
  it.each(rejected.map(args => [JSON.stringify(args), args] as const))('refuses %s before modifying an existing ledger', async (_, args) => {
    const file = seed();
    const before = state(file);
    expect(await invoke([...args])).toEqual({ code: 1, preview: false });
    expect(state(file)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'data', 'backups'))).toBe(false);
  });
  it('explicit plain reprice still performs its documented write', async () => {
    const file = seed();
    const before = state(file);
    expect(await invoke([])).toEqual({ code: 0, preview: false });
    expect(state(file).usd).toBeCloseTo(0.022, 10);
    expect(state(file).digest).not.toBe(before.digest);
    expect(fs.readdirSync(path.join(root, 'data', 'backups'))).toHaveLength(1);
  });
  it.each(rejected.slice(0, 6).map(args => [JSON.stringify(args), args] as const))('refuses %s before creating a missing home', async (_, args) => {
    const absent = path.join(root, 'not-created');
    process.env.TOKENELO_HOME = absent;
    expect(await invoke([...args])).toEqual({ code: 1, preview: false });
    expect(fs.existsSync(absent)).toBe(false);
  });
});
