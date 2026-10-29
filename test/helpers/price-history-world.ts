/**
 * Synthetic price-history world for the price-retention tests (2026-10-18).
 *
 * Two fully fabricated price tables are pinned as JSON files in test/fixtures/price-history-2026-10-18/.
 * "old" is the world a row was first priced in; "today" is a later world whose prices differ. Nothing here
 * reads rates/prices.json, so a legitimate change to the shipped table can never move these hand-computed
 * expectations.
 *
 * The fixtures are fabricated stand-ins: not a measurement, a vendor price or an invoice.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPricingEngine } from '../../src/core/pricing.js';
import { defaultConfig } from '../../src/daemon/config.js';
import type { PriceRow, PricingEngine, TokeneloConfig, TokenCounts, UsageComponent, UsageEvent } from '../../src/core/types.js';

const DIR = fileURLToPath(new URL('../fixtures/price-history-2026-10-18/', import.meta.url));
function readJson<T>(name: string): T { return JSON.parse(fs.readFileSync(DIR + name, 'utf8')) as T; }

/** Table versions pinned at fixture creation. A drift between these and the files fails the fixture self-check. */
export const PINNED = {
  oldPriceVersion: 'e357da3f1675c3cd9eabffe064dd82a562113816cc3fd13d4b517a1750d06ccd',
  todayPriceVersion: '6f40d1cf2ee3096201ed9cb1385884561fbf6be87e5166777ab20b89dab73578',
} as const;

export type WorldName = 'old' | 'today';

export interface World {
  name: WorldName;
  priceRows: PriceRow[];
  pricing: PricingEngine;
}

/** Build one price world from its pinned table. */
export function buildWorld(name: WorldName): World {
  const priceRows = readJson<PriceRow[]>(`prices-${name}.json`);
  return { name, priceRows, pricing: createPricingEngine(priceRows) };
}

export const T0 = Date.UTC(2026, 8, 20, 12, 0, 0); // 2026-09-20T12:00:00Z, the "historical" ingest time
export const NOW = Date.UTC(2026, 9, 18, 12, 0, 0); // 2026-10-18T12:00:00Z, "today"
export const HOUR = 3_600_000;

export function tokens(t: Partial<TokenCounts> = {}): TokenCounts {
  return { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, ...t };
}

/** A minimal event whose derived fields are inert placeholders; the ledger recomputes them. */
export function synthEvent(o: {
  id: string;
  model: string;
  source?: UsageEvent['source'];
  provider?: UsageEvent['provider'];
  host?: string;
  ts?: number;
  tokens: Partial<TokenCounts>;
  component?: Partial<UsageComponent>;
  thinking?: boolean | null;
  effort?: string;
  speed?: UsageEvent['speed'];
  serviceTier?: string;
  inferenceGeo?: string;
  project?: string;
  durationMs?: number;
  flags?: UsageEvent['flags'];
}): UsageEvent {
  const t = tokens(o.tokens);
  const component: UsageComponent = { model: o.model, tokens: t, ...o.component };
  const event: UsageEvent = {
    id: o.id, host: o.host ?? 'H1', source: o.source ?? 'ollama-log', ts: o.ts ?? T0, tsSource: 'line',
    sessionId: 'synthetic-session', isSubagent: false, model: o.model, provider: o.provider ?? 'unknown',
    components: [component], tokens: t, flags: o.flags ?? [],
    apiEquivUsd: -999, priceStatus: 'UNPRICED', priceVersion: 'placeholder', reservedValue: -999, ucuRateStatus: 'NONE', eacsDefSha256: 'placeholder',
  };
  if (o.thinking !== undefined) event.thinking = o.thinking;
  if (o.effort !== undefined) event.effort = o.effort;
  if (o.speed !== undefined) event.speed = o.speed;
  if (o.serviceTier !== undefined) event.serviceTier = o.serviceTier;
  if (o.inferenceGeo !== undefined) event.inferenceGeo = o.inferenceGeo;
  if (o.project !== undefined) event.project = o.project;
  if (o.durationMs !== undefined) event.durationMs = o.durationMs;
  return event;
}

/** Default config for host H1 with local capture on. */
export function synthConfig(): TokeneloConfig {
  const cfg = defaultConfig({ hostLabel: 'H1' });
  cfg.local.capture = 'serverlog';
  return cfg;
}

/** The fields a row's price is recorded by: dollars, status, table version and provider. */
export function economics(e: UsageEvent) {
  return {
    apiEquivUsd: e.apiEquivUsd, priceStatus: e.priceStatus, priceVersion: e.priceVersion, provider: e.provider,
  };
}
