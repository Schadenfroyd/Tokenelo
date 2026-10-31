import type { ModelRow } from './api-types.js';
import { formatCompactNumber, formatPreciseMoney } from './format.js';
import { priceFieldsUsable } from './price-evidence.js';
import { sourceLabel } from './detail-context.js';
import { countBasisLabel, tokenCategoryText, tokenSubtotal, tokenTotalText, unresolvedCounts } from './token-counts.js';

export type UsageModelView = 'usage' | 'local';

function thinkingModeLabel(mode: ModelRow['thinking']): string {
  return mode === 'thinking' ? 'thinking' : mode === 'non-thinking' ? 'non-thinking' : 'mode unknown';
}

function providerLabel(provider: ModelRow['provider']): string {
  return ({ openai: 'OpenAI', anthropic: 'Anthropic', local: 'Local' } as Record<string, string>)[provider] ?? provider;
}

/**
 * The plain-text data contract used by Usage/Local model rows and their expanded disclosure.
 * Kept free of DOM so a source-bound ledger oracle can verify what the screen will display.
 */
export function usageModelRowCopy(row: ModelRow, view: UsageModelView = 'usage') {
  const source = sourceLabel(row.source);
  const mode = thinkingModeLabel(row.thinking);
  const name = `${row.displayName} · ${mode}`;
  const provider = providerLabel(row.provider);
  const countBasis = countBasisLabel(row.tokens, row.events);
  const summaryCountQualification = view === 'local' && countBasis !== 'Reported count basis' ? countBasis : '';
  const summarySourceQualification = view === 'local' && row.source === 'ollama-log' ? 'Server-log counts are estimates' : '';
  const tokensTotal = tokenSubtotal(row.tokens);
  const priceUsable = priceFieldsUsable(row) && row.apiEquivUsd !== null;
  const categories = {
    inputFresh: tokenCategoryText(row.tokens, 'inputFresh'),
    cacheWrite5m: tokenCategoryText(row.tokens, 'cacheWrite5m'),
    cacheWrite1h: tokenCategoryText(row.tokens, 'cacheWrite1h'),
    cacheWriteUnassigned: tokenCategoryText(row.tokens, 'cacheWriteUnassigned'),
    cacheRead: tokenCategoryText(row.tokens, 'cacheRead'),
    output: tokenCategoryText(row.tokens, 'output'),
    reasoning: tokenCategoryText(row.tokens, 'reasoning'),
  };

  return {
    mode,
    name,
    provider,
    source,
    identity: view === 'local' ? `${name}, ${row.model}, ${source}` : `${name}, ${source}`,
    summaryCount: view === 'local' ? formatCompactNumber(row.events) : tokenTotalText(row.tokens),
    summaryCountTitle: countBasis,
    summaryCountQualification,
    summarySourceQualification,
    summaryCountQualificationTone: countBasis.startsWith('Complete token total unavailable') ? 'warn' : 'neutral',
    summaryValue: view === 'local' ? tokenTotalText(row.tokens) : priceUsable ? formatPreciseMoney(row.apiEquivUsd!) : '—',
    summaryValueTitle: view === 'local' ? countBasis : '',
    tokenSubtotal: tokensTotal,
    categories,
    countBasis,
    detailsIdentity: `Model ${row.model} · ${source} · ${provider} · ${row.events.toLocaleString()} recorded ${row.events === 1 ? 'event' : 'events'}`,
    categoryLine: `${unresolvedCounts(row.tokens) || row.tokens.fieldEvidence ? 'Normalized category subtotal' : 'Usage token categories'} ${tokensTotal.toLocaleString()} · fresh input ${categories.inputFresh} · cache write (5 min) ${categories.cacheWrite5m} · cache write (1 hr, including assumptions) ${categories.cacheWrite1h} · unknown TTL ${categories.cacheWriteUnassigned} · cache read ${categories.cacheRead} · output ${categories.output}`,
    reasoningLine: `Recorded reasoning ${categories.reasoning} is part of output and is not added to usage tokens again.`,
    apiValuePrefix: !priceUsable
      ? 'API-equivalent value unavailable · '
      : `Recorded API-equivalent $${row.apiEquivUsd!.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 8 })} · `,
    priceStatus: row.priceStatus ?? 'Price evidence conflicts',
  };
}

/** Accessible name of the model disclosure, including Local-only source and count qualifiers. */
export function usageModelToggleLabel(copy: ReturnType<typeof usageModelRowCopy>): string {
  const qualifications = [copy.summarySourceQualification, copy.summaryCountQualification].filter(Boolean);
  return `Usage breakdown for ${copy.identity}${qualifications.length ? ` · ${qualifications.join(' · ')}` : ''}`;
}
