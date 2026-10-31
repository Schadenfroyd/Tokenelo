import type { LimitContributor } from './api-types.js';
import { formatCompactNumber, formatPreciseMoney } from './format.js';
import { countBasisLabel, tokenCategoryText, tokenTotalText, TOKEN_COMPONENTS } from './token-counts.js';

export interface LimitContributorView {
  heading: string;
  provider: string;
  servingRouteEvidence: string;
  scope: string;
  eventCount: string;
  timestampSource: string;
  eventTimeRange: string;
  countTotal: string;
  countBasis: string;
  tokenCategories: { label: string; value: string }[];
  reasoning: string;
  apiEquivSubtotal: string;
  priceBasis: string;
  priceReview: string | null;
}

function eventTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function timestampSourceLabel(source: LimitContributor['tsSource']): string {
  switch (source) {
    case 'line': return 'source line timestamp';
    case 'turn': return 'source turn timestamp';
    case 'record': return 'source record timestamp';
    case 'frozen-line': return 'frozen source-line timestamp';
    case 'request': return 'request timestamp';
    case 'activity': return 'activity timestamp';
  }
}

function providerLabel(provider: LimitContributor['provider']): string {
  switch (provider) {
    case 'anthropic': return 'Anthropic price-table provider';
    case 'openai': return 'OpenAI price-table provider';
    case 'local': return 'Local price-table provider';
    case 'unknown': return 'Price-table provider unknown';
  }
}

function routeLabel(route: LimitContributor['servingRoutes'][number]): string {
  if (route.kind === 'unrecorded') return 'serving route unrecorded';
  if (route.kind === 'local') return 'local route · ' + route.evidence;
  if (route.kind === 'hosted') return 'hosted route · ' + route.evidence;
  return 'route unknown · ' + route.evidence;
}

export function limitContributorView(row: LimitContributor): LimitContributorView {
  const statuses = row.priceStatusCounts;
  const statusParts = [
    statuses.LIST ? formatCompactNumber(statuses.LIST) + ' LIST' : '',
    statuses.ESTIMATE ? formatCompactNumber(statuses.ESTIMATE) + ' ESTIMATE' : '',
    statuses.UNPRICED ? formatCompactNumber(statuses.UNPRICED) + ' UNPRICED' : '',
    statuses.unknown ? formatCompactNumber(statuses.unknown) + ' unknown status' : '',
  ].filter(Boolean);
  const priceIssues = row.priceEvidence.issuesEvents;
  const priceReview = row.priceEvidence.aggregateAmountInvalid
    ? 'Stored aggregate price is invalid; API-equivalent subtotal withheld.'
    : priceIssues > 0
      ? 'Price evidence needs review (' + formatCompactNumber(priceIssues) + ' event(s)); API-equivalent subtotal withheld.'
      : statuses.UNPRICED > 0
        ? formatCompactNumber(statuses.UNPRICED) + ' unpriced event(s) are excluded from the known subtotal.'
        : statuses.unknown > 0
          ? 'Unknown price statuses are not treated as LIST or ESTIMATE.'
          : null;
  const amount = row.knownApiEquivUsd === null
    ? 'Known API-equivalent subtotal unavailable'
    : 'Known API-equivalent subtotal ' + formatPreciseMoney(row.knownApiEquivUsd)
      + ' (stored amount ' + row.knownApiEquivUsd.toString() + ' USD)';

  return {
    heading: row.model,
    provider: providerLabel(row.provider),
    servingRouteEvidence: row.servingRoutes.map(routeLabel).join(' · '),
    scope: 'Host ' + row.host,
    eventCount: formatCompactNumber(row.events) + ' event(s)',
    timestampSource: timestampSourceLabel(row.tsSource),
    eventTimeRange: row.firstEventAt === row.lastEventAt
      ? 'Source event time ' + eventTime(row.firstEventAt)
      : 'Source event times ' + eventTime(row.firstEventAt) + ' – ' + eventTime(row.lastEventAt),
    countTotal: 'Token subtotal ' + tokenTotalText(row.tokens),
    countBasis: countBasisLabel(row.tokens, row.events),
    tokenCategories: TOKEN_COMPONENTS.map(([key, label]) => ({ label, value: tokenCategoryText(row.tokens, key) })),
    reasoning: 'Reasoning (subset of output) ' + tokenCategoryText(row.tokens, 'reasoning'),
    apiEquivSubtotal: amount + ' · not an invoice',
    priceBasis: (statusParts.length ? statusParts.join(' · ') : 'Price status unavailable') + ' · price version ' + row.priceVersion,
    priceReview,
  };
}
