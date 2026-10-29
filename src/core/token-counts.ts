import type { TokenCounts } from './types.js';
import { addTokenFieldCoverage, normalizedTokenFields, unrecordedTokenFields, validTokenFieldCoverage, TOKEN_FIELD_KEYS, type TokenFieldCoverage } from './token-field-evidence.js';

/** Disclosures never make malformed numerical counters valid. Do not clamp a
 * negative, fractional, missing or unsafe category into known work. */
export function hasInvalidTokenValues(tokens: TokenCounts): boolean {
  const required = ['inputFresh','cacheWrite5m','cacheWrite1h','cacheRead','output','reasoning'] as const;
  const optional = ['cacheWriteUnassigned','cacheWriteAssumed1h'] as const;
  const invalid = (value: unknown): boolean => !Number.isSafeInteger(value) || (value as number) < 0;
  const invalidQuality = (value: unknown): boolean => value !== undefined && !isCountQuality(value);
  return !validTokenFieldCoverage(tokens) || invalidQuality(tokens.countQuality) || invalidQuality(tokens.ucuCountQuality)
    || required.some(key => invalid(tokens[key]))
    || optional.some(key => tokens[key] !== undefined && invalid(tokens[key]));
}

/** Per-item attributed quantities may be fractional (documented cloud batch shares).
 * This is separate from the strict measured-counter validator above. */
export function hasInvalidTokenQuantities(tokens: TokenCounts): boolean {
  const required = ['inputFresh','cacheWrite5m','cacheWrite1h','cacheRead','output','reasoning'] as const;
  const optional = ['cacheWriteUnassigned','cacheWriteAssumed1h'] as const;
  const invalid = (v: unknown): boolean => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER;
  return required.some(k => invalid(tokens[k])) || optional.some(k => tokens[k] !== undefined && invalid(tokens[k]));
}

export type CountQuality = NonNullable<TokenCounts['countQuality']>;
const COUNT_QUALITY_VALUES: readonly CountQuality[] = ['complete', 'unrecorded', 'incomplete', 'invalid', 'conflict'];
export function isCountQuality(value: unknown): value is CountQuality {
  return typeof value === 'string' && COUNT_QUALITY_VALUES.includes(value as CountQuality);
}
/** Missing stored quality remains legacy/unrecorded; an unknown nonempty label fails closed as invalid. */
export function normalizeCountQuality(value: unknown): CountQuality {
  if (value === undefined || value === null) return 'unrecorded';
  return isCountQuality(value) ? value : 'invalid';
}
const rank: Record<CountQuality, number> = { complete: 0, unrecorded: 1, incomplete: 2, invalid: 3, conflict: 4 };
export function weakestCountQuality(a: CountQuality | undefined, b: CountQuality | undefined): CountQuality {
  const x = normalizeCountQuality(a), y = normalizeCountQuality(b);
  return rank[x] >= rank[y] ? x : y;
}

/** Category subtotal for inspection. It is NOT an accepted complete total on a bad count basis. */
export function tokenSubtotal(t: TokenCounts): number {
  return t.inputFresh + t.cacheWrite5m + t.cacheWrite1h + (t.cacheWriteUnassigned ?? 0) + t.cacheRead + t.output;
}
export function hasUnresolvedCounts(t: TokenCounts): boolean {
  const quality = normalizeCountQuality(t.countQuality);
  return quality === 'conflict' || quality === 'invalid' || quality === 'incomplete';
}
export function ucuCountQuality(t: TokenCounts): CountQuality {
  return normalizeCountQuality(t.ucuCountQuality ?? t.countQuality);
}
export function hasUnresolvedUcuCounts(t: TokenCounts): boolean {
  return ['conflict', 'invalid', 'incomplete'].includes(ucuCountQuality(t));
}
export function ucuTokenSubtotal(t: TokenCounts): number {
  return t.inputFresh + t.cacheWrite5m + t.cacheWrite1h + (t.cacheWriteUnassigned ?? 0) + t.output;
}
/** Absence remains legacy/unrecorded; callers must disclose it rather than claim verified counts. */
export function completeTokenTotal(t: TokenCounts): number | null {
  return hasUnresolvedCounts(t) ? null : tokenSubtotal(t);
}
// Track a fold's first row independently of its numeric value. A normalized
// legacy zero is still a contributing row, not proof of an empty accumulator.
const accumulated = new WeakSet<TokenCounts>();
const foldedRows = new WeakMap<TokenCounts, number>();
// Keep per-row normalized facts before the first inspected native contribution.
// Aggregate quality cannot recover which earlier rows had complete categories.
// These private facts are not serialized or treated as inspected raw evidence.
const deferredFields = new WeakMap<TokenCounts, TokenFieldCoverage>();
export function addTokenCounts(target: TokenCounts, value: TokenCounts): void {
  const empty = !accumulated.has(target) && tokenSubtotal(target) === 0 && target.countQuality === undefined;
  accumulated.add(target);
  const priorRows = foldedRows.get(target) ?? (empty ? 0 : 1);
  foldedRows.set(target, priorRows + 1);
  const priorFields = target.fieldEvidence ?? deferredFields.get(target)
    ?? (priorRows ? normalizedTokenFields(target, priorRows) : undefined);
  const incomingFields = value.fieldEvidence ?? deferredFields.get(value);
  if (target.fieldEvidence || value.fieldEvidence) {
    target.fieldEvidence = addTokenFieldCoverage(priorFields, incomingFields ?? normalizedTokenFields(value));
    deferredFields.delete(target);
  } else if (incomingFields) {
    deferredFields.set(target, addTokenFieldCoverage(priorFields, incomingFields));
  } else {
    const fields = priorFields ?? unrecordedTokenFields(0);
    for (const key of TOKEN_FIELD_KEYS) {
      const field = fields[key];field.unrecordedParts++;
      const quantity = value[key] ?? (key === 'cacheWriteUnassigned' ? 0 : undefined);
      if (value.countQuality === 'complete' && Number.isSafeInteger(quantity) && quantity! >= 0) {
        field.knownValue += quantity!;field.knownParts++;field.normalizedParts++;
      }
    }
    deferredFields.set(target, fields);
  }
  const priorUcuQuality = ucuCountQuality(target);
  const nextUcuQuality = empty ? ucuCountQuality(value) : weakestCountQuality(priorUcuQuality, ucuCountQuality(value));
  const hasUcuOverride = target.ucuCountQuality !== undefined || value.ucuCountQuality !== undefined;
  target.inputFresh += value.inputFresh;
  target.cacheWrite5m += value.cacheWrite5m;
  target.cacheWrite1h += value.cacheWrite1h;
  target.cacheRead += value.cacheRead;
  target.output += value.output;
  target.reasoning += value.reasoning;
  if (value.cacheWriteUnassigned !== undefined || target.cacheWriteUnassigned !== undefined)
    target.cacheWriteUnassigned = (target.cacheWriteUnassigned ?? 0) + (value.cacheWriteUnassigned ?? 0);
  if (value.cacheWriteAssumed1h !== undefined || target.cacheWriteAssumed1h !== undefined)
    target.cacheWriteAssumed1h = (target.cacheWriteAssumed1h ?? 0) + (value.cacheWriteAssumed1h ?? 0);
  if (value.countQuality !== undefined || target.countQuality !== undefined)
    target.countQuality = empty ? normalizeCountQuality(value.countQuality) : weakestCountQuality(target.countQuality, value.countQuality);
  if (target.countQuality === 'complete' && !Number.isSafeInteger(tokenSubtotal(target)))
    target.countQuality = weakestCountQuality(target.countQuality, 'invalid');
  const aggregateUcuQuality = nextUcuQuality === 'complete' && !Number.isSafeInteger(ucuTokenSubtotal(target)) ? 'invalid' : nextUcuQuality;
  if (hasUcuOverride || aggregateUcuQuality !== (target.countQuality ?? 'unrecorded')) {
    if (aggregateUcuQuality === (target.countQuality ?? 'unrecorded')) delete target.ucuCountQuality;
    else target.ucuCountQuality = aggregateUcuQuality;
  }
}
