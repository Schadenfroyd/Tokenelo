/** Private count history for snapshots the caller asserts belong to ONE component.
 * No event identity/grouping, model selection, persistent journal or dedup is inferred.
 * Imported envelopes remain consistency evidence, not authenticated measurements.
 */
import { captureComponentCounts, componentCountProjection, mergeComponentCounts, COMPONENT_COUNT_POLICY } from './component-count-evidence.js';
import { importCountEnvelope, type CountEnvelopeImportResult } from './count-envelope-import.js';
import { restoreCountEnvelopeObservations } from './count-envelope-observations.js';
import type { CountEnvelope, CountField } from './count-envelope-types.js';
import type { UsageComponent } from '../core/types.js';

export const COUNT_HISTORY_VERSION = 'tokenelo/same-component-count-history@v0';
export const MAX_COUNT_HISTORY_PACKETS = 64;
/** UTF-16 code units, not transport bytes. */
export const MAX_COUNT_HISTORY_JSON_LENGTH = 262_144;
type PacketRefusal = Extract<CountEnvelopeImportResult, { kind: 'rejected' }>['reason'];
function copyField(field: CountField): CountField {
  return field.state === 'reported' ? { state: 'reported', value: field.value } : { state: field.state, value: null };
}
export type CountHistoryResult = {
  kind: 'count-history'; contractVersion: typeof COUNT_HISTORY_VERSION;
  scope: 'caller-selected-same-component-history';
  policies: { componentCount: CountEnvelope['policies']['componentCount']; identity: 'caller-unverified'; eventDedup: 'not-applied'; valuation: 'not-applied' };
  history: { receivedPackets: number; distinctSnapshots: number; mergeState: 'monotone' | 'incomparable' | 'legacy-mixed'; countHistoryInvalid: boolean; ttlHistoryInvalid: boolean };
  observations: CountEnvelope['observations']; categories: CountEnvelope['categories']; totals: CountEnvelope['totals']; cache: CountEnvelope['cache'];
} | {
  kind: 'rejected'; contractVersion: typeof COUNT_HISTORY_VERSION;
  reason: 'history-string-required' | 'history-too-large' | 'invalid-history-json' | 'packet-list-required' | 'history-packet-limit' | 'packet-refused';
  packetIndex?: number; packetReason?: PacketRefusal;
};

export function captureCountHistory(serializedPackets: unknown): CountHistoryResult {
  const rejected = (reason: Extract<CountHistoryResult, { kind: 'rejected' }>['reason'], packetIndex?: number, packetReason?: PacketRefusal): CountHistoryResult =>
    ({ kind: 'rejected', contractVersion: COUNT_HISTORY_VERSION, reason, ...(packetIndex === undefined ? {} : { packetIndex, packetReason }) });
  if (typeof serializedPackets !== 'string') return rejected('history-string-required');
  if (serializedPackets.length > MAX_COUNT_HISTORY_JSON_LENGTH) return rejected('history-too-large');
  let packets: unknown;
  try { packets = JSON.parse(serializedPackets); } catch { return rejected('invalid-history-json'); }
  if (!Array.isArray(packets) || packets.length === 0) return rejected('packet-list-required');
  // Refuse rather than truncate a history the caller has not bounded or grouped correctly.
  if (packets.length > MAX_COUNT_HISTORY_PACKETS) return rejected('history-packet-limit');
  let merged: UsageComponent | null = null;
  for (let index = 0; index < packets.length; index++) {
    const imported = importCountEnvelope(packets[index]);
    if (imported.kind === 'rejected') return rejected('packet-refused', index, imported.reason);
    const evidence = captureComponentCounts(restoreCountEnvelopeObservations({ observations: imported.envelope.observations }));
    // Static placeholder satisfies the existing production merge adapter's carrier type.
    // It never identifies a model, enters valuation or appears in the count-only result.
    const next: UsageComponent = { model: 'count-only-history-carrier', tokens: componentCountProjection(evidence).tokens, countEvidence: evidence };
    merged = merged === null ? next : mergeComponentCounts(merged, next, true);
  }
  const evidence = merged!.countEvidence!;
  const { tokens, cache, ttlHistoryInvalid } = componentCountProjection(evidence);
  const fresh = tokens.inputFresh + tokens.cacheWrite5m + tokens.cacheWrite1h + (tokens.cacheWriteUnassigned ?? 0) + tokens.output;
  const fullQuality = tokens.countQuality ?? 'unrecorded', freshQuality = tokens.ucuCountQuality ?? fullQuality;
  return {
    kind: 'count-history', contractVersion: COUNT_HISTORY_VERSION, scope: 'caller-selected-same-component-history',
    policies: { componentCount: COMPONENT_COUNT_POLICY, identity: 'caller-unverified', eventDedup: 'not-applied', valuation: 'not-applied' },
    history: { receivedPackets: packets.length, distinctSnapshots: evidence.snapshots.length, mergeState: evidence.mergeState, countHistoryInvalid: evidence.countHistoryInvalid === true, ttlHistoryInvalid },
    observations: {
      inputFresh: copyField(evidence.inputFresh),
      output: copyField(evidence.output),
      cacheRead: copyField(evidence.cacheRead),
      cacheCreation: {
        flatTotal: copyField(evidence.cacheCreation.flatTotal),
        container: evidence.cacheCreation.container,
        ephemeral5m: copyField(evidence.cacheCreation.ephemeral5m),
        ephemeral1h: copyField(evidence.cacheCreation.ephemeral1h),
      },
    },
    categories: { inputFresh: tokens.inputFresh, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite5m: tokens.cacheWrite5m, cacheWrite1h: tokens.cacheWrite1h, cacheWriteUnassigned: tokens.cacheWriteUnassigned ?? 0, cacheWriteAssumed1h: tokens.cacheWriteAssumed1h ?? 0 },
    totals: { full: { quality: fullQuality, value: fullQuality === 'complete' ? fresh + tokens.cacheRead : null }, freshWork: { quality: freshQuality, value: freshQuality === 'complete' ? fresh : null } },
    cache: { exactCreationCount: cache.exactCacheWork, unassignedTtlCount: cache.unassignedTtl, ttlBasis: cache.priceBasis, invalidTtlEvidence: ttlHistoryInvalid },
  };
}
