/** Private serialized count import. Validates consistency with the current v0 producer,
 * not authenticity, source completeness, history, dedup, rights or a public privacy boundary.
 * Only JSON strings are accepted; arbitrary in-process objects/getters/Proxies are excluded.
 */
import { captureCountEnvelope, COUNT_ENVELOPE_VERSION } from './count-envelope.js';
import type { CountEnvelope } from './count-envelope-types.js';
import { restoreCountEnvelopeObservations } from './count-envelope-observations.js';

export const COUNT_ENVELOPE_IMPORT_VERSION = 'tokenelo/count-envelope-import@v0';
/** UTF-16 code units, not transport bytes. Applies before JSON parsing. */
export const MAX_COUNT_ENVELOPE_JSON_LENGTH = 65_536;
export type CountEnvelopeImportResult = {
  kind: 'count-envelope-import'; contractVersion: typeof COUNT_ENVELOPE_IMPORT_VERSION; envelope: CountEnvelope;
} | {
  kind: 'rejected'; contractVersion: typeof COUNT_ENVELOPE_IMPORT_VERSION;
  reason: 'json-string-required' | 'packet-too-large' | 'invalid-json' | 'unsupported-contract' | 'invalid-envelope' | 'inconsistent-envelope';
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Traversal follows the producer's fixed schema, never the caller's arbitrary nesting. */
function sameFixedShape(expected: unknown, actual: unknown): boolean {
  if (!record(expected)) return expected === actual;
  if (!record(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length
    && keys.every(key => Object.hasOwn(actual, key) && sameFixedShape(expected[key], actual[key]));
}

export function importCountEnvelope(serialized: unknown): CountEnvelopeImportResult {
  const rejected = (reason: Extract<CountEnvelopeImportResult, { kind: 'rejected' }>['reason']): CountEnvelopeImportResult =>
    ({ kind: 'rejected', contractVersion: COUNT_ENVELOPE_IMPORT_VERSION, reason });
  if (typeof serialized !== 'string') return rejected('json-string-required');
  if (serialized.length > MAX_COUNT_ENVELOPE_JSON_LENGTH) return rejected('packet-too-large');
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return rejected('invalid-json'); }
  if (!record(parsed)) return rejected('invalid-envelope');
  if (parsed.contractVersion !== COUNT_ENVELOPE_VERSION) return rejected('unsupported-contract');
  let raw: Record<string, unknown>;
  try { raw = restoreCountEnvelopeObservations(parsed); } catch { return rejected('invalid-envelope'); }
  const canonical = captureCountEnvelope(raw);
  if (canonical.kind !== 'count-envelope') return rejected('invalid-envelope');
  // Fixed schema also rejects any extra content/identity/model fields, policy changes,
  // contradictory categories/TTL/quality/totals and impossible container observations.
  if (!sameFixedShape(canonical, parsed)) return rejected('inconsistent-envelope');
  return { kind: 'count-envelope-import', contractVersion: COUNT_ENVELOPE_IMPORT_VERSION, envelope: canonical };
}
