/**
 * Regression tests for src/core/serving-route.ts. This module decides whether a component may use the
 * zero-dollar local rate policy, so every state, merge rule and the "pins a local runtime" check is pinned.
 * Route evidence is a reported qualification, never an attestation.
 *
 * Two cases are titled "[pins current legacy policy]": they assert that a component with no route evidence
 * ('unrecorded') may use the local rate policy. That is today's behaviour, not a settled requirement; the
 * integration owner's decision D4 (2026-10-17) is that new unrecorded routes should stay unpriced. When that
 * is implemented, change those two cases with it. Every other case here is policy-neutral.
 */
import { describe, it, expect } from 'vitest';
import {
  allowsLocalRatePolicy, canonicalizeComponentRoute, componentRouteState, isServingRouteState,
  mergeComponentRoute, pinsLocalRuntime, reportedRouteState,
} from '../../src/core/serving-route.js';
import type { UsageComponent } from '../../src/core/types.js';

const comp = (servingRoute?: unknown, own = true): UsageComponent => {
  const c: Record<string, unknown> = { model: 'm', tokens: { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0 } };
  if (own) c.servingRoute = servingRoute;
  return c as unknown as UsageComponent;
};
const LOCAL = { kind: 'local', evidence: 'metered-engine' };
const HOSTED = { kind: 'hosted', evidence: 'qwen-oauth' };
const CONFLICT = { kind: 'unknown', evidence: 'conflicting-reports' };
const UNKNOWN_COMPAT = { kind: 'unknown', evidence: 'qwen-openai-compatible' };
const UNKNOWN_UNREC = { kind: 'unknown', evidence: 'unrecorded' };
const INVALID_ROUTE = { kind: 'unknown', evidence: 'invalid' };

describe('reportedRouteState', () => {
  it('maps each supported report to its state', () => {
    expect(reportedRouteState(LOCAL)).toBe('local-reported');
    expect(reportedRouteState(HOSTED)).toBe('hosted-reported');
    expect(reportedRouteState(CONFLICT)).toBe('conflict');
    expect(reportedRouteState(UNKNOWN_COMPAT)).toBe('unknown');
    expect(reportedRouteState(UNKNOWN_UNREC)).toBe('unknown');
  });
  it('treats anything else as invalid, never as a supported route', () => {
    for (const bad of [undefined, null, 'local', 7, [], [LOCAL], {}, { kind: 'local' }, { evidence: 'metered-engine' },
      { kind: 'local', evidence: 'qwen-oauth' }, { kind: 'hosted', evidence: 'metered-engine' }, { kind: 'hosted', evidence: 'x' },
      { kind: 'unknown', evidence: 'metered-engine' }, INVALID_ROUTE, { kind: 'cloud', evidence: 'qwen-oauth' }])
      expect(reportedRouteState(bad)).toBe('invalid');
  });
  it('rejects a report carrying any extra key, even a supported one', () => {
    for (const r of [LOCAL, HOSTED, CONFLICT, UNKNOWN_COMPAT]) expect(reportedRouteState({ ...r, note: 'extra' })).toBe('invalid');
  });
});

describe('componentRouteState and allowsLocalRatePolicy', () => {
  it('a component without a servingRoute key is unrecorded (legacy), and may use the local policy [pins current legacy policy]', () => {
    expect(componentRouteState(comp(undefined, false))).toBe('unrecorded');
    expect(allowsLocalRatePolicy('unrecorded')).toBe(true);
  });
  it('a present servingRoute key is judged by its value, including an explicitly undefined one', () => {
    expect(componentRouteState(comp(LOCAL))).toBe('local-reported');
    expect(componentRouteState(comp(HOSTED))).toBe('hosted-reported');
    expect(componentRouteState(comp(undefined, true))).toBe('invalid');
  });
  it('only unrecorded and local-reported allow the local rate policy [pins current legacy policy]', () => {
    const states = ['unrecorded', 'local-reported', 'hosted-reported', 'unknown', 'invalid', 'conflict'] as const;
    expect(states.filter(allowsLocalRatePolicy)).toEqual(['unrecorded', 'local-reported']);
  });
  it('isServingRouteState accepts exactly the six state names', () => {
    for (const s of ['unrecorded', 'local-reported', 'hosted-reported', 'unknown', 'invalid', 'conflict']) expect(isServingRouteState(s)).toBe(true);
    for (const s of ['local', 'hosted', '', undefined, null, 5]) expect(isServingRouteState(s)).toBe(false);
  });
});

describe('canonicalizeComponentRoute', () => {
  it('replaces an invalid present value with an explicit unknown-invalid marker, without mutating the input', () => {
    const input = comp({ kind: 'local', evidence: 'x' });
    const out = canonicalizeComponentRoute(input);
    expect(out.servingRoute).toEqual(INVALID_ROUTE);
    expect(out).not.toBe(input);
    expect((input.servingRoute as { evidence: string }).evidence).toBe('x');
  });
  it('returns every other component unchanged (same object)', () => {
    for (const c of [comp(undefined, false), comp(LOCAL), comp(HOSTED), comp(CONFLICT), comp(UNKNOWN_COMPAT)]) expect(canonicalizeComponentRoute(c)).toBe(c);
  });
});

describe('mergeComponentRoute', () => {
  const merge = (a: unknown, b: unknown, aOwn = true, bOwn = true) => mergeComponentRoute(comp(a, aOwn), comp(b, bOwn));
  it('an invalid report on either side wins over everything', () => {
    expect(merge({ kind: 'local', evidence: 'x' }, LOCAL)).toEqual(INVALID_ROUTE);
    expect(merge(LOCAL, { kind: 'local', evidence: 'x' })).toEqual(INVALID_ROUTE);
    expect(merge({ kind: 'local', evidence: 'x' }, CONFLICT)).toEqual(INVALID_ROUTE);
  });
  it('a conflict on either side yields conflicting-reports', () => {
    expect(merge(CONFLICT, LOCAL)).toEqual(CONFLICT);
    expect(merge(LOCAL, CONFLICT)).toEqual(CONFLICT);
    expect(merge(CONFLICT, undefined, true, false)).toEqual(CONFLICT);
  });
  it('missing evidence makes no claim: the other side is kept', () => {
    expect(merge(undefined, LOCAL, false, true)).toEqual(LOCAL);
    expect(merge(HOSTED, undefined, true, false)).toEqual(HOSTED);
    expect(merge(undefined, undefined, false, false)).toBeUndefined();
  });
  it('the same report on both sides is kept; different states or different evidence conflict', () => {
    expect(merge(LOCAL, LOCAL)).toEqual(LOCAL);
    expect(merge(UNKNOWN_COMPAT, UNKNOWN_COMPAT)).toEqual(UNKNOWN_COMPAT);
    expect(merge(LOCAL, HOSTED)).toEqual(CONFLICT);
    expect(merge(HOSTED, LOCAL)).toEqual(CONFLICT);
    expect(merge(UNKNOWN_COMPAT, UNKNOWN_UNREC)).toEqual(CONFLICT);
  });
  it('a merge involving a hosted or unknown report never produces a locally priceable route', () => {
    for (const other of [LOCAL, HOSTED, UNKNOWN_COMPAT]) {
      const merged = merge(HOSTED, other);
      expect(allowsLocalRatePolicy(componentRouteState(comp(merged)))).toBe(false);
    }
  });
});

describe('pinsLocalRuntime', () => {
  it('is false without a config or with none of the pinning fields', () => {
    expect(pinsLocalRuntime(undefined)).toBe(false);
    expect(pinsLocalRuntime({})).toBe(false);
    expect(pinsLocalRuntime({ unrelated: 1 })).toBe(false);
  });
  it('is true when any pinning field is present, even if falsy', () => {
    for (const key of ['modelBlobSha256', 'quant', 'numCtx', 'kvCacheType', 'flashAttn', 'backend', 'hardware', 'batch'])
      expect(pinsLocalRuntime({ [key]: key === 'flashAttn' ? false : 0 })).toBe(true);
  });
  it('a versioned engine string pins the runtime; an unversioned or non-string engine does not', () => {
    expect(pinsLocalRuntime({ engine: 'llama.cpp@b4000' })).toBe(true);
    expect(pinsLocalRuntime({ engine: 'llama.cpp' })).toBe(false);
    expect(pinsLocalRuntime({ engine: 5 })).toBe(false);
    expect(pinsLocalRuntime({ engine: undefined })).toBe(false);
  });
});
