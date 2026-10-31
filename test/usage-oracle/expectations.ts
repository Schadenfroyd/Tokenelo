/**
 * Shared assertions: a live (or fixture) response against the oracle's expected values. Used by the query, HTTP and
 * fixture test files so every surface is held to the same cohort and the same rules.
 */
import { expect } from 'vitest';
import { IDLE_GAP_MS, NOW, type RangeName } from './cohort.js';
import { expectedSessions, near, rangeStart, type Agg, type Cats, type ExpectedSession } from './oracle.js';

export function expectCats(actual: any, expected: Cats): void {
  for (const k of ['inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'reasoning'] as const) expect(actual[k], `tokens.${k}`).toBe(expected[k]);
}

export function expectMoney(actual: number | null, expected: number | null, what: string): void {
  if (expected === null) expect(actual, what).toBeNull();
  else { expect(actual, what).not.toBeNull(); expect(near(actual!, expected), `${what}: ${actual} vs ${expected}`).toBe(true); }
}

export function expectPriceAndCounts(actual: any, a: Agg, opts: { nullWhenAllUnpriced: boolean }): void {
  expect(actual.events).toBe(a.events);
  expectCats(actual.tokens, a.tokens);
  expect(actual.tokens.countQuality).toBe(a.countQuality);
  expectMoney(actual.apiEquivUsd, opts.nullWhenAllUnpriced && a.allUnpriced ? null : a.apiEquivUsd, 'apiEquivUsd');
  expect(actual.unpricedEvents).toBe(a.unpricedEvents);
  expect(actual.estimatedPriceEvents).toBe(a.estimatedPriceEvents);
  expect(actual.priceStatus).toBe(a.priceStatus);
  expect(actual.priceEvidence).toMatchObject({ events: a.events, issuesEvents: 0, aggregateAmountInvalid: false });
}

export function expectSession(actual: any, e: ExpectedSession): void {
  const id = e.key.replace(/\u0000/g, '|');
  expect(actual.start, `${id} start`).toBe(e.start);
  expect(actual.end, `${id} end`).toBe(e.end);
  expect(actual.project, `${id} project`).toBe(e.project);
  expect(actual.models, `${id} models`).toEqual(e.models);
  expectCats(actual.tokens, e.tokens);
  expect(actual.tokens.countQuality, `${id} countQuality`).toBe(e.countQuality);
  expectMoney(actual.apiEquivUsd, e.apiEquivUsd, `${id} apiEquivUsd`);
  expect(actual.unpricedEvents, `${id} unpriced`).toBe(e.unpricedEvents);
  expect(actual.estimatedPriceEvents, `${id} estimated`).toBe(e.estimatedPriceEvents);
  expect(actual.priceStatus, `${id} priceStatus`).toBe(e.priceStatus);
  expect(actual.live, `${id} live`).toBe(e.live);
  expect(actual.subagents).toBe(0);
  expect(actual.activeMs, `${id} activeMs`).toBe(e.activeMs);
  expect(actual.activityEvidence, `${id} activityEvidence`).toEqual({ version: 1, basis: e.activityBasis, markCount: e.markCount, durationMarkCount: e.durationMarkCount, idleGapMs: IDLE_GAP_MS });
  if (e.burn === null) expect(actual.burn, `${id} burn`).toBeNull();
  else {
    expect(actual.burn.tokensPerMin).toBeCloseTo(e.burn.tokensPerMin, 9);
    expect(actual.burn.usdPerHour).toBeCloseTo(e.burn.usdPerHour, 9);
    expect(actual.burn.priceQuality).toMatchObject({ events: e.burn.events, unpricedEvents: e.burn.unpricedEvents, estimatedPriceEvents: e.burn.estimatedPriceEvents, priceStatus: e.burn.priceStatus });
  }
  expect(actual.telemetry.length, `${id} feeds`).toBe(e.feeds.length);
  for (const feed of e.feeds) {
    const got = actual.telemetry.find((f: any) => f.provider === feed.provider && (f.engine ?? null) === feed.engine);
    expect(got, `${id} feed ${feed.provider}/${feed.engine}`).toBeDefined();
    expect(got).toMatchObject({ host: e.host, source: e.source, events: feed.events, unpricedEvents: feed.unpricedEvents, estimatedPriceEvents: feed.estimatedPriceEvents,
      firstEventAt: feed.firstEventAt, lastEventAt: feed.lastEventAt });
  }
}

export function expectSessionsResponse(res: any, range: RangeName): void {
  const x = expectedSessions(range);
  expect(res).toMatchObject({ range, generatedAt: NOW });
  expect(res.timeBasis).toMatchObject({ startMs: rangeStart(range, NOW), asOfMs: NOW });
  expect(res.sessions.length).toBe(x.length);
  for (let i = 1; i < res.sessions.length; i++) expect(res.sessions[i - 1].start).toBeLessThanOrEqual(res.sessions[i].start);
  for (const e of x) {
    const actual = res.sessions.find((s: any) => s.host === e.host && s.source === e.source && s.sessionId === e.sessionId);
    expect(actual, `session ${e.key.replace(/\u0000/g, '|')} missing`).toBeDefined();
    expectSession(actual, e);
  }
}

