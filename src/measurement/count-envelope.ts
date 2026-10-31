/** Private count-only producer for one parsed Claude usage component.
 * Fixed-key output omits model/build strings, content, paths and identities. It accepts no
 * caller policy/metadata and performs no source selection, merge, dedup, I/O or valuation.
 * This is not a general redaction or hostile Proxy-object boundary. Import validation,
 * rights/notices/paper/counsel and a complete free tracker remain separate work.
 */
import { CLAUDE_OBSERVATION_POLICIES, type FieldObservation } from './claude-observation.js';
import { captureComponentCounts, componentCountProjection, COMPONENT_COUNT_POLICY } from './component-count-evidence.js';
import type { CountEnvelopeResult, CountField } from './count-envelope-types.js';
export type { CountEnvelope, CountEnvelopeResult } from './count-envelope-types.js';

export const COUNT_ENVELOPE_VERSION = 'tokenelo/count-envelope@v0';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Preserve own data/accessor presence for the existing parser without invoking getters.
 * Never pass a whole caller object or its iterations through the raw observation parser. */
function selectOwn(input: object, keys: readonly string[]): Record<string, unknown> {
  const selected = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor) Object.defineProperty(selected, key, descriptor);
  }
  return selected;
}
function field(observation: FieldObservation): CountField {
  return observation.state === 'reported' ? { state: 'reported', value: observation.value }
    : { state: observation.state, value: null };
}

export function captureCountEnvelope(rawComponent: unknown): CountEnvelopeResult {
  if (!record(rawComponent)) return { kind: 'rejected', reason: 'component-object-required' };
  // Top-level usage with iterations describes the final component, not the whole message.
  // Even an empty/accessor iterations property is outside this deliberately narrow v0 input.
  if (Object.getOwnPropertyDescriptor(rawComponent, 'iterations')) return { kind: 'rejected', reason: 'iterations-unsupported' };
  const raw = selectOwn(rawComponent, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']);
  const cacheDescriptor = Object.getOwnPropertyDescriptor(rawComponent, 'cache_creation');
  if (cacheDescriptor) {
    const descriptor = 'value' in cacheDescriptor && record(cacheDescriptor.value)
      ? { ...cacheDescriptor, value: selectOwn(cacheDescriptor.value, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']) }
      : cacheDescriptor;
    Object.defineProperty(raw, 'cache_creation', descriptor);
  }
  const evidence = captureComponentCounts(raw);
  if (evidence.fallbackPolicy !== 'assume-1h-if-no-ttl-reported') {
    throw new Error('Unsupported count-envelope source fallback policy');
  }
  const { tokens, cache, ttlHistoryInvalid } = componentCountProjection(evidence);
  const fullQuality = tokens.countQuality ?? 'unrecorded';
  const freshQuality = tokens.ucuCountQuality ?? fullQuality;
  const freshCount = tokens.inputFresh + tokens.cacheWrite5m + tokens.cacheWrite1h + (tokens.cacheWriteUnassigned ?? 0) + tokens.output;
  return {
    kind: 'count-envelope', contractVersion: COUNT_ENVELOPE_VERSION, scope: 'single-caller-selected-component',
    policies: { numericObservation: CLAUDE_OBSERVATION_POLICIES.parser, componentCount: COMPONENT_COUNT_POLICY,
      cacheProjection: cache.policyVersion, ttlFallback: evidence.fallbackPolicy,
      countConvention: 'nonnegative-safe-integer', componentSelection: 'caller', dedup: 'not-applied', merge: 'not-applied' },
    observations: { inputFresh: field(evidence.inputFresh), output: field(evidence.output), cacheRead: field(evidence.cacheRead),
      cacheCreation: { flatTotal: field(evidence.cacheCreation.flatTotal), container: evidence.cacheCreation.container,
        ephemeral5m: field(evidence.cacheCreation.ephemeral5m), ephemeral1h: field(evidence.cacheCreation.ephemeral1h) } },
    categories: { inputFresh: tokens.inputFresh, output: tokens.output, cacheRead: tokens.cacheRead,
      cacheWrite5m: tokens.cacheWrite5m, cacheWrite1h: tokens.cacheWrite1h,
      cacheWriteUnassigned: tokens.cacheWriteUnassigned ?? 0, cacheWriteAssumed1h: tokens.cacheWriteAssumed1h ?? 0 },
    totals: { full: { quality: fullQuality, value: fullQuality === 'complete' ? freshCount + tokens.cacheRead : null },
      freshWork: { quality: freshQuality, value: freshQuality === 'complete' ? freshCount : null } },
    cache: { exactCreationCount: cache.exactCacheWork, unassignedTtlCount: cache.unassignedTtl,
      ttlBasis: cache.priceBasis, invalidTtlEvidence: ttlHistoryInvalid },
  };
}
