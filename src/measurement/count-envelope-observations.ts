/** Internal restoration for JSON-decoded envelopes. Root APIs validate consistency;
 * this helper is not an import or arbitrary in-process object boundary.
 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function restoreField(raw: Record<string, unknown>, key: string, field: unknown): void {
  if (!record(field)) throw new Error('Invalid count field');
  if (field.state === 'reported' && typeof field.value === 'number' && Number.isFinite(field.value) && field.value >= 0) raw[key] = field.value;
  else if (field.state === 'invalid' && field.value === null) raw[key] = 'invalid counter';
  else if (!(field.state === 'missing' && field.value === null)) throw new Error('Invalid count field');
}
export function restoreCountEnvelopeObservations(envelope: Record<string, unknown>): Record<string, unknown> {
  const observations = envelope.observations;
  if (!record(observations) || !record(observations.cacheCreation)) throw new Error('Invalid count observations');
  const raw: Record<string, unknown> = {};
  restoreField(raw, 'input_tokens', observations.inputFresh);
  restoreField(raw, 'output_tokens', observations.output);
  restoreField(raw, 'cache_read_input_tokens', observations.cacheRead);
  const cache = observations.cacheCreation;
  restoreField(raw, 'cache_creation_input_tokens', cache.flatTotal);
  if (cache.container === 'present') {
    const nested: Record<string, unknown> = {};
    restoreField(nested, 'ephemeral_5m_input_tokens', cache.ephemeral5m);
    restoreField(nested, 'ephemeral_1h_input_tokens', cache.ephemeral1h);
    raw.cache_creation = nested;
  } else if (cache.container === 'null') raw.cache_creation = null;
  else if (cache.container === 'malformed') raw.cache_creation = 'invalid container';
  else if (cache.container !== 'absent') throw new Error('Invalid cache container');
  return raw;
}
