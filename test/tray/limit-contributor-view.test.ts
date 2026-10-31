import { describe, expect, it } from 'vitest';
import type { LimitContributor } from '../../src/tray/renderer/api-types.js';
import { limitContributorView } from '../../src/tray/renderer/limit-contributor-view.js';

const PRICE_EVIDENCE = {
  version: 1 as const,
  events: 3,
  invalidAmountEvents: 0,
  unknownStatusEvents: 0,
  statusAmountConflictEvents: 0,
  issuesEvents: 0,
  aggregateAmountInvalid: false,
};

function row(overrides: Partial<LimitContributor> = {}): LimitContributor {
  return {
    host: 'M4a',
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    servingRoutes: [{ kind: 'unrecorded' }],
    priceVersion: 'prices-2026-10-20',
    tsSource: 'line',
    firstEventAt: Date.UTC(2026, 9, 20, 9, 0),
    lastEventAt: Date.UTC(2026, 9, 20, 9, 30),
    events: 3,
    tokens: {
      inputFresh: 120,
      cacheWrite5m: 0,
      cacheWrite1h: 30,
      cacheRead: 40,
      output: 60,
      reasoning: 10,
      countQuality: 'complete',
    },
    knownApiEquivUsd: 0.024,
    priceStatusCounts: { LIST: 1, ESTIMATE: 1, UNPRICED: 1, unknown: 0 },
    priceEvidence: PRICE_EVIDENCE,
    ...overrides,
  };
}

describe('Limits contributor copy', () => {
  it('keeps subtotal, invoice, unpriced and stored price-basis language distinct', () => {
    const view = limitContributorView(row());
    expect(view.scope).toBe('Host M4a');
    expect(view.eventCount).toBe('3 event(s)');
    expect(view.timestampSource).toBe('source line timestamp');
    expect(view.eventTimeRange).toContain(new Date(row().firstEventAt).toLocaleString());
    expect(view.eventTimeRange).toContain(new Date(row().lastEventAt).toLocaleString());
    expect(view.apiEquivSubtotal).toBe('Known API-equivalent subtotal $0.02 (stored amount 0.024 USD) · not an invoice');
    expect(view.priceBasis).toContain('1 LIST');
    expect(view.priceBasis).toContain('1 ESTIMATE');
    expect(view.priceBasis).toContain('1 UNPRICED');
    expect(view.priceBasis).toContain('prices-2026-10-20');
    expect(view.priceReview).toBe('1 unpriced event(s) are excluded from the known subtotal.');
  });

  it('withholds the complete token total for unresolved counts while retaining category evidence', () => {
    const view = limitContributorView(row({
      tokens: {
        inputFresh: 120,
        cacheWrite5m: 0,
        cacheWrite1h: 30,
        cacheRead: 40,
        output: 60,
        reasoning: 10,
        countQuality: 'incomplete',
      },
    }));
    expect(view.countTotal).toBe('Token subtotal Unavailable');
    expect(view.countBasis).toContain('incomplete count evidence');
    expect(view.reasoning).toContain('Reasoning (subset of output)');
  });

  it('shows unknown counts and price-field conflicts explicitly rather than as zero or clean', () => {
    const view = limitContributorView(row({
      knownApiEquivUsd: null,
      priceStatusCounts: { LIST: 0, ESTIMATE: 0, UNPRICED: 0, unknown: 1 },
      priceEvidence: { ...PRICE_EVIDENCE, unknownStatusEvents: 1, issuesEvents: 1 },
      tokens: {
        inputFresh: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
        output: 0,
        reasoning: 0,
        countQuality: 'unrecorded',
      },
    }));
    expect(view.apiEquivSubtotal).toBe('Known API-equivalent subtotal unavailable · not an invoice');
    expect(view.priceBasis).toContain('unknown status');
    expect(view.priceReview).toContain('Price evidence needs review');
    expect(view.priceReview).toContain('API-equivalent subtotal withheld');
    expect(view.countBasis).toContain('Count evidence unrecorded');
  });

  it('withholds the subtotal when the aggregate amount itself is invalid', () => {
    const view = limitContributorView(row({
      knownApiEquivUsd: null,
      priceEvidence: { ...PRICE_EVIDENCE, aggregateAmountInvalid: true },
    }));
    expect(view.apiEquivSubtotal).toBe('Known API-equivalent subtotal unavailable · not an invoice');
    expect(view.priceReview).toBe('Stored aggregate price is invalid; API-equivalent subtotal withheld.');
  });

  it('states provider and distinguishes missing route metadata from explicit unknown evidence', () => {
    const view = limitContributorView(row({
      provider: 'local',
      servingRoutes: [
        { kind: 'local', evidence: 'metered-engine' },
        { kind: 'unknown', evidence: 'conflicting-reports' },
        { kind: 'unrecorded' },
      ],
    }));
    expect(view.provider).toBe('Local price-table provider');
    expect(view.servingRouteEvidence).toBe('local route · metered-engine · route unknown · conflicting-reports · serving route unrecorded');
  });

  it('emits only grouped metadata and does not expose session or path identifiers', () => {
    const input = {
      ...row(),
      id: 'SENSITIVE_EVENT_ID',
      sessionId: 'SENSITIVE_SESSION_ID',
      project: 'SENSITIVE_PROJECT',
      repoRoot: 'SENSITIVE_REPO',
      gitBranch: 'SENSITIVE_BRANCH',
    } as LimitContributor;
    const view = limitContributorView(input);
    const text = JSON.stringify(view);
    expect(text).not.toContain('SENSITIVE_');
  });
});
