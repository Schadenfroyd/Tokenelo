import type { TokenCounts, UsageComponent } from './types.js';
import { nativeCounterProjection, supportedNativeCounters } from '../measurement/native-counter-evidence.js';

export const TOKEN_FIELD_KEYS = ['inputFresh', 'cacheRead', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnassigned', 'reasoning'] as const;
export type TokenFieldKey = typeof TOKEN_FIELD_KEYS[number];
/** Parts are component contributions, or a legacy row whose components were not
 * inspected. They are not request/event counts. Validation issues may overlap known parts. */
export interface TokenFieldEvidence {
  knownValue: number;
  knownParts: number;
  reportedParts: number;
  derivedParts: number;
  normalizedParts: number;
  assumedParts: number;
  notApplicableParts: number;
  missingParts: number;
  invalidParts: number;
  unrecordedParts: number;
}
export type TokenFieldCoverage = Record<TokenFieldKey, TokenFieldEvidence>;
const COUNTERS = ['knownValue', 'knownParts', 'reportedParts', 'derivedParts', 'normalizedParts', 'assumedParts', 'notApplicableParts', 'missingParts', 'invalidParts', 'unrecordedParts'] as const;
const empty = (): TokenFieldEvidence => ({ knownValue: 0, knownParts: 0, reportedParts: 0, derivedParts: 0, normalizedParts: 0, assumedParts: 0, notApplicableParts: 0, missingParts: 0, invalidParts: 0, unrecordedParts: 0 });
export function unrecordedTokenFields(parts = 1): TokenFieldCoverage {
  return Object.fromEntries(TOKEN_FIELD_KEYS.map(k => [k, { ...empty(), unrecordedParts: parts }])) as TokenFieldCoverage;
}
/** A complete recorded category vector remains usable without pretending its raw
 * fields were inspected. Unknown legacy vectors remain distinct from these. */
export function normalizedTokenFields(tokens: TokenCounts, parts = 1): TokenFieldCoverage {
  const fields = unrecordedTokenFields(parts);
  if (tokens.countQuality === 'complete') for (const key of TOKEN_FIELD_KEYS) {
    const value = tokens[key] ?? (key === 'cacheWriteUnassigned' ? 0 : undefined);
    if (Number.isSafeInteger(value) && value! >= 0) fields[key] = { ...fields[key], knownValue: value!, knownParts: parts, normalizedParts: parts };
  }
  return fields;
}
export function addTokenFieldCoverage(a: TokenFieldCoverage | undefined, b: TokenFieldCoverage): TokenFieldCoverage {
  return Object.fromEntries(TOKEN_FIELD_KEYS.map(k => {
    const field = empty();
    for (const n of COUNTERS) field[n] = (a?.[k][n] ?? 0) + b[k][n];
    return [k, field];
  })) as TokenFieldCoverage;
}
export function validTokenFieldCoverage(t: TokenCounts): boolean {
  if (t.fieldEvidence === undefined) return true;
  const evidence = t.fieldEvidence;
  return !!evidence && typeof evidence === 'object' && Object.keys(evidence).every(k => (TOKEN_FIELD_KEYS as readonly string[]).includes(k)) && TOKEN_FIELD_KEYS.every(key => {
    const field = evidence[key];
    return !!field && typeof field === 'object' && Object.keys(field).every(k => (COUNTERS as readonly string[]).includes(k)) && COUNTERS.every(k => Number.isSafeInteger(field[k]) && field[k] >= 0)
      && field.knownValue <= (t[key] ?? 0) && (field.knownParts > 0 || field.knownValue === 0)
      && ['reportedParts', 'derivedParts', 'normalizedParts', 'assumedParts', 'notApplicableParts'].every(k => field[k as keyof TokenFieldEvidence] <= field.knownParts);
  });
}

/** Read disclosure only: never changes stored counters, historical prices, or raw evidence. */
export function nativeTokenFieldCoverage(components: readonly UsageComponent[], totals: TokenCounts): TokenFieldCoverage | undefined {
  if (!components.some(c => c.nativeCounterEvidence)) return undefined;
  let result: TokenFieldCoverage | undefined;
  const projectedTotals = Object.fromEntries(TOKEN_FIELD_KEYS.map(k => [k, 0])) as Record<TokenFieldKey, number>;
  for (const c of components) {
    const e = c.nativeCounterEvidence;
    let part = unrecordedTokenFields();
    for (const k of TOKEN_FIELD_KEYS) projectedTotals[k] += c.tokens[k] ?? 0;
    if (e && supportedNativeCounters(e) && !e.legacyMixed) {
      const p = nativeCounterProjection(e);
      const observe = (key: 'prompt_eval_count' | 'prompt_eval_cached_count' | 'eval_count') => {
        const rows = e.snapshots.map(s => s[key]);
        return { known: e.largestReported?.[key] !== undefined || rows.some(f => f.state === 'reported'),
          invalid: rows.some(f => f.state === 'invalid') };
      };
      const input = observe('prompt_eval_count'), cache = observe('prompt_eval_cached_count'), output = observe('eval_count');
      const field = (value: number, known: boolean, invalid: boolean, kind: 'reportedParts' | 'derivedParts' | 'notApplicableParts', assumed = false): TokenFieldEvidence => ({
        ...empty(), knownValue: known ? value : 0, knownParts: known ? 1 : 0, [kind]: known ? 1 : 0,
        assumedParts: known && assumed ? 1 : 0, missingParts: !known && !invalid ? 1 : 0, invalidParts: invalid ? 1 : 0,
      });
      const invalidFresh = input.invalid || cache.invalid;
      // A cache/prompt invariant failure makes the derived fresh category unknown.
      const gross = Math.max(0, e.largestReported?.prompt_eval_count ?? 0, ...e.snapshots.map(s => s.prompt_eval_count.state === 'reported' ? s.prompt_eval_count.value : 0));
      const badCache = input.known && cache.known && p.cacheRead > gross;
      const freshKnown = input.known && !cache.invalid && !badCache;
      part = {
        inputFresh: field(p.inputFresh, freshKnown, invalidFresh || badCache, 'derivedParts', !cache.known),
        cacheRead: field(p.cacheRead, cache.known || !cache.invalid, cache.invalid, 'reportedParts', !cache.known && !cache.invalid),
        output: field(p.output, output.known, output.invalid, 'reportedParts'),
        cacheWrite5m: field(0, true, false, 'notApplicableParts'),
        cacheWrite1h: field(0, true, false, 'notApplicableParts'),
        cacheWriteUnassigned: field(0, true, false, 'notApplicableParts'),
        reasoning: field(0, false, false, 'reportedParts'),
      };
      if (!cache.known && !cache.invalid) part.cacheRead.reportedParts = 0;
      for (const k of TOKEN_FIELD_KEYS) {
        // MAX/legacy merges can retain a numerical vector different from this raw
        // projection. Do not attribute that category to the raw native fields.
        if ((c.tokens[k] ?? 0) !== (p[k] ?? 0)) part[k] = unrecordedTokenFields()[k];
      }
    }
    result = addTokenFieldCoverage(result, part);
  }
  for (const key of TOKEN_FIELD_KEYS) if (projectedTotals[key] !== (totals[key] ?? 0)) result![key] = unrecordedTokenFields(components.length)[key];
  return result;
}
export function storedNativeTokenFields(raw: string | null | undefined, totals: TokenCounts, revision?: number | null): TokenFieldCoverage | undefined {
  if (!raw) return undefined;
  const invalid = () => {
    const fields = unrecordedTokenFields();
    for (const key of TOKEN_FIELD_KEYS) fields[key].invalidParts = 1;
    if (totals.countQuality !== 'conflict') totals.countQuality = 'invalid';
    delete totals.ucuCountQuality;
    return fields;
  };
  let components: unknown;
  try { components = JSON.parse(raw); } catch { return invalid(); }
  if (!Array.isArray(components) || components.some(c => !c || typeof c !== 'object' || !c.tokens || typeof c.tokens !== 'object')) return invalid();
  const native = (components as UsageComponent[]).some(c => c.nativeCounterEvidence);
  if (native && revision == null) {
    if (totals.countQuality !== 'invalid' && totals.countQuality !== 'conflict') totals.countQuality = 'incomplete';
    delete totals.ucuCountQuality;
    return unrecordedTokenFields(components.length);
  }
  return nativeTokenFieldCoverage(components as UsageComponent[], totals);
}
