/**
 * Deterministic, hand-computable stub PricingEngine and valuation-seam double for ledger.ts tests. Not a
 * test file itself (vitest only picks up test/**\/*.test.ts); it is imported by the ledger tests.
 *
 * StubPricingEngine: $1 per 1000 (inputFresh + output) tokens, summed over components. Always
 * status 'LIST'.
 * StubEacsEngine: a seam test double for the ledger's reserved valuation fields (the EacsEngine interface in
 * core/types.ts: defSha256, ucuForEvent, rateBasisOf). It is NOT the behaviour of this edition (the real
 * seam is createNullEngine() in core/null-engine.ts, which records an unknown value). It exists so a test can
 * observe that the ledger writes whatever the injected seam returns for a new or changed row and keeps a
 * stored value while its measurement inputs are unchanged. Its value per component is
 * (inputFresh + cacheWrite5m + cacheWrite1h + output) / 100, summed over components, with status 'MEASURED'.
 *
 * Both are intentionally trivial linear functions so every expected value in the tests can be
 * hand-computed from the raw token fields.
 */
import type {
  EacsEngine,
  PriceResult,
  PriceRow,
  PricingEngine,
  Provider,
  RateStatus,
  TokenCounts,
  UsageComponent,
  UsageEvent,
} from '../../src/core/types.js';

export const STUB_PRICE_VERSION = 'stub-price-v1';
export const STUB_DEF_SHA256 = 'stub-def-sha256';
export const STUB_USD_PER_1K = 1; // $1 / 1000 (inputFresh+output) tokens
export const STUB_TOKENS_PER_UCU = 100;

function componentUsd(c: UsageComponent): number {
  return ((c.tokens.inputFresh + c.tokens.output) / 1000) * STUB_USD_PER_1K;
}

export class StubPricingEngine implements PricingEngine {
  readonly version = STUB_PRICE_VERSION;

  resolve(_model: string): PriceRow | null {
    return null; // not exercised by ledger tests
  }

  providerOf(_model: string): Provider {
    return 'anthropic';
  }

  priceComponent(c: UsageComponent): PriceResult {
    return { usd: componentUsd(c), status: 'LIST', rowId: 'stub', flags: [] };
  }

  priceEvent(e: Pick<UsageEvent, 'components' | 'inferenceGeo'>): PriceResult {
    const usd = e.components.reduce((sum, c) => sum + componentUsd(c), 0);
    return { usd, status: 'LIST', rowId: 'stub', flags: [] };
  }
}

function componentValuationTokens(t: TokenCounts): number {
  return t.inputFresh + t.cacheWrite5m + t.cacheWrite1h + t.output;
}

export class StubEacsEngine implements EacsEngine {
  readonly defSha256: string = STUB_DEF_SHA256;

  rateBasisOf(components: readonly UsageComponent[]): { rateKey: string; resolvedSha256: string } {
    const rateKey = `[${[...new Set(components.map((c) => JSON.stringify([c.model, null])))].sort().join(',')}]`;
    return { rateKey, resolvedSha256: `stub-identity:${STUB_TOKENS_PER_UCU}:${rateKey}` };
  }

  ucuForEvent(e: Pick<UsageEvent, 'components' | 'effort' | 'thinking'>): { reservedValue: number | null; status: RateStatus } {
    const reservedValue = e.components.reduce(
      (sum, c) => sum + componentValuationTokens(c.tokens) / STUB_TOKENS_PER_UCU,
      0
    );
    return { reservedValue, status: 'MEASURED' };
  }
}

/** Builds a minimally-valid, hand-inspectable UsageEvent for tests. All derived fields are
 * placeholders — upsertEvents always recomputes them from `components`, so their initial values
 * here are deliberately wrong/inert to prove that recomputation actually happens. */
export function makeEvent(overrides: {
  id: string;
  ts?: number;
  sessionId?: string;
  model?: string;
  inputFresh: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
  output: number;
  reasoning?: number;
  host?: string;
  source?: UsageEvent['source'];
  thinking?: boolean | null;
  flags?: UsageEvent['flags'];
}): UsageEvent {
  const tokens: TokenCounts = {
    inputFresh: overrides.inputFresh,
    cacheWrite5m: overrides.cacheWrite5m ?? 0,
    cacheWrite1h: overrides.cacheWrite1h ?? 0,
    cacheRead: overrides.cacheRead ?? 0,
    output: overrides.output,
    reasoning: overrides.reasoning ?? 0,
  };
  const model = overrides.model ?? 'claude-sonnet-5';
  const component: UsageComponent = { model, tokens };
  return {
    id: overrides.id,
    host: overrides.host ?? 'M4a',
    source: overrides.source ?? 'claude',
    ts: overrides.ts ?? 1_000_000,
    tsSource: 'line',
    sessionId: overrides.sessionId ?? 'session-1',
    isSubagent: false,
    model,
    provider: 'anthropic',
    components: [component],
    tokens,
    thinking: overrides.thinking,
    flags: overrides.flags ?? [],
    // Placeholders — must never survive upsertEvents unchanged unless the recompute genuinely
    // produces the same value.
    apiEquivUsd: -999,
    priceStatus: 'UNPRICED',
    priceVersion: 'placeholder',
    reservedValue: -999,
    ucuRateStatus: 'NONE',
    eacsDefSha256: 'placeholder',
  };
}
