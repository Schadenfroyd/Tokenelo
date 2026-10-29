import type { Range, Source, SummaryResponse, TokenCounts } from './api-types.js';
import { countBasisLabel, hasKnownEmptyUsage, tokenCountDetails, TOKEN_COMPONENTS } from './token-counts.js';
export { TOKEN_COMPONENTS } from './token-counts.js';
const SOURCES: readonly Source[] = ['claude', 'codex', 'ollama-proxy', 'ollama-log', 'qwen-code', 'bench'];
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export interface TokenPeriodEvidence {
  headline: 'Reported tokens' | 'Normalized token categories' | 'Complete token total' | 'Recorded tokens';
  subtotal: number | null;
  totalAvailable: boolean;
  empty: boolean;
  basis: string;
  components: { key: (typeof TOKEN_COMPONENTS)[number][0]; label: string; value: number | null; note?: string }[];
  reasoning: number | null;
  assumed1h: number | null;
  sources: { source: Source; events: number; tokens: TokenCounts }[];
  sourceState: 'match' | 'mismatch' | 'unavailable';
}

/** Same selected summary, no new collection/read and no inference of uncaptured usage.
 * Reasoning and assumed 1h writes are subsets; neither is added to categories again. */
export function tokenPeriodEvidence(summary: SummaryResponse, expectedRange: Range): TokenPeriodEvidence {
  if (summary.range !== expectedRange) throw new Error('Selected token summary range mismatch');
  const tokens = summary.totals.tokens;
  const details = tokenCountDetails(tokens);
  const components = details.components;
  const valid = TOKEN_COMPONENTS.every(([key]) => count(tokens[key]) || key === 'cacheWriteUnassigned' && tokens[key] === undefined);
  const subtotal = details.subtotal;
  const empty = subtotal !== null && hasKnownEmptyUsage(tokens, summary.totals.events);
  const totalAvailable = details.totalAvailable;
  let sourceState: TokenPeriodEvidence['sourceState'] = 'unavailable';
  const sources: TokenPeriodEvidence['sources'] = [];
  if (summary.bySource && typeof summary.bySource === 'object') {
    const entries = Object.entries(summary.bySource);
    const validSources = entries.every(([source, row]) => SOURCES.includes(source as Source) && row && count(row.events)
      && row.tokens && TOKEN_COMPONENTS.every(([key]) => count(row.tokens[key]) || key === 'cacheWriteUnassigned' && row.tokens[key] === undefined));
    if (validSources) {
      const rows = entries.map(([source, row]) => ({ source: source as Source, ...row }));
      for (const source of SOURCES) {
        const row = rows.find(row => row.source === source);
        if (row && row.events > 0) sources.push({ source, events: row.events, tokens: row.tokens });
      }
      const events = rows.reduce((total, row) => total + row.events, 0);
      sourceState = count(events) && events === summary.totals.events && valid && TOKEN_COMPONENTS.every(([key]) => {
        const total = rows.reduce((sum, row) => sum + (row.tokens[key] ?? 0), 0);
        return count(total) && total === (tokens[key] ?? 0);
      }) ? 'match' : 'mismatch';
    }
  }
  return {
    headline: empty ? 'Recorded tokens' : !totalAvailable ? 'Complete token total'
      : tokens.countQuality === 'complete' ? 'Reported tokens' : 'Normalized token categories',
    subtotal, totalAvailable, empty,
    basis: subtotal === null ? 'Numeric token categories unavailable or outside the exact supported range.' : countBasisLabel(tokens, summary.totals.events),
    components, reasoning: details.reasoning,
    assumed1h: count(tokens.cacheWriteAssumed1h) ? tokens.cacheWriteAssumed1h : null,
    sources, sourceState,
  };
}
