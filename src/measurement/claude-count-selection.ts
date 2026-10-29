/** Private, unwired selection adapter for one parsed Claude usage object.
 * Nonempty iterations replace top-level final-iteration counts. Absent/null/empty arrays
 * select top-level counts. Malformed containers and bounded-out arrays are refused;
 * this is deliberately more conservative than the current collector's non-array fallback.
 * No models/content/paths/identities, dedup, history merge, pricing or valuation.
 */
import { captureCountEnvelope } from './count-envelope.js';
import type { CountEnvelopeResult, CountQuality, CountContainer } from './count-envelope-types.js';

export const CLAUDE_COUNT_SELECTION_VERSION = 'tokenelo/claude-count-selection@v0';
export const MAX_COUNT_COMPONENTS = 256;

export type ClaudeCountSelection = {
  kind: 'claude-count-selection';
  contractVersion: typeof CLAUDE_COUNT_SELECTION_VERSION;
  selection: 'top-level' | 'iterations';
  iterations: { container: CountContainer; length: number | null };
  components: { ordinal: number | null; final: boolean; envelope: CountEnvelopeResult }[];
  totals: { full: { quality: CountQuality; value: number | null }; freshWork: { quality: CountQuality; value: number | null } };
} | {
  kind: 'rejected';
  contractVersion: typeof CLAUDE_COUNT_SELECTION_VERSION;
  reason: 'usage-object-required' | 'iterations-malformed' | 'component-limit-exceeded';
  iterations: { container: CountContainer; length: number | null };
};

function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
const rank: Record<CountQuality, number> = { complete: 0, unrecorded: 1, incomplete: 2, invalid: 3, conflict: 4 };
function total(components: Extract<ClaudeCountSelection, { kind: 'claude-count-selection' }>['components'], basis: 'full' | 'freshWork') {
  let quality: CountQuality = 'complete', value = 0;
  for (const component of components) {
    if (component.envelope.kind === 'rejected') { if (rank[quality] < rank.incomplete) quality = 'incomplete'; continue; }
    const part = component.envelope.totals[basis];
    if (rank[part.quality] > rank[quality]) quality = part.quality;
    if (part.value !== null) value += part.value;
  }
  if (quality === 'complete' && !Number.isSafeInteger(value)) quality = 'invalid';
  return { quality, value: quality === 'complete' ? value : null };
}

export function captureClaudeCountSelection(rawUsage: unknown): ClaudeCountSelection {
  const rejected = (reason: Extract<ClaudeCountSelection, { kind: 'rejected' }>['reason'], container: CountContainer, length: number | null): ClaudeCountSelection =>
    ({ kind: 'rejected', contractVersion: CLAUDE_COUNT_SELECTION_VERSION, reason, iterations: { container, length } });
  if (!record(rawUsage)) return rejected('usage-object-required', 'absent', null);
  const descriptor = Object.getOwnPropertyDescriptor(rawUsage, 'iterations');
  if (descriptor && !('value' in descriptor)) return rejected('iterations-malformed', 'malformed', null);
  const rawIterations: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  const container: CountContainer = rawIterations === undefined ? 'absent' : rawIterations === null ? 'null' : Array.isArray(rawIterations) ? 'present' : 'malformed';
  if (container === 'malformed') return rejected('iterations-malformed', container, null);
  const length = Array.isArray(rawIterations) ? rawIterations.length : null;
  if (length !== null && length > MAX_COUNT_COMPONENTS) return rejected('component-limit-exceeded', container, length);
  const components: Extract<ClaudeCountSelection, { kind: 'claude-count-selection' }>['components'] = [];
  const selection = Array.isArray(rawIterations) && rawIterations.length > 0 ? 'iterations' : 'top-level';
  if (selection === 'iterations' && Array.isArray(rawIterations)) {
    for (let ordinal = 0; ordinal < rawIterations.length; ordinal++) {
      const entry = Object.getOwnPropertyDescriptor(rawIterations, String(ordinal));
      components.push({ ordinal, final: ordinal === rawIterations.length - 1, envelope: captureCountEnvelope(entry && 'value' in entry ? entry.value : undefined) });
    }
  } else {
    // Selection is now explicit. Remove only the message-level wrapper property;
    // the component producer itself still owns fixed-key numeric admission.
    const component = Object.create(null) as Record<string, unknown>;
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation']) {
      const field = Object.getOwnPropertyDescriptor(rawUsage, key);
      if (field) Object.defineProperty(component, key, field);
    }
    components.push({ ordinal: null, final: true, envelope: captureCountEnvelope(component) });
  }
  return { kind: 'claude-count-selection', contractVersion: CLAUDE_COUNT_SELECTION_VERSION, selection,
    iterations: { container, length }, components, totals: { full: total(components, 'full'), freshWork: total(components, 'freshWork') } };
}
