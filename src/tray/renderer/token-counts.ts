import type { TokenCounts, TokenFieldKey, TokenFieldEvidence } from './api-types.js';
import { formatCompactNumber } from './format.js';

export const TOKEN_COMPONENTS = [
  ['inputFresh', 'Fresh input'], ['cacheRead', 'Cache reads'], ['output', 'Output'],
  ['cacheWrite5m', 'Cache writes · 5 min'], ['cacheWrite1h', 'Cache writes · 1 hr'],
  ['cacheWriteUnassigned', 'Cache writes · unknown TTL'],
] as const;
const exactCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// DTO shape/range validation only; raw counter interpretation remains in the backend.
function validTokenFieldCoverage(t: TokenCounts): boolean {
  if (t.fieldEvidence === undefined) return true;
  const keys: TokenFieldKey[] = ['inputFresh','cacheRead','output','cacheWrite5m','cacheWrite1h','cacheWriteUnassigned','reasoning'];
  const counters: (keyof TokenFieldEvidence)[] = ['knownValue','knownParts','reportedParts','derivedParts','normalizedParts','assumedParts','notApplicableParts','missingParts','invalidParts','unrecordedParts'];
  const e = t.fieldEvidence;
  return !!e && typeof e === 'object' && Object.keys(e).every(k => (keys as string[]).includes(k)) && keys.every(k => {
    const f = e[k];
    return !!f && typeof f === 'object' && Object.keys(f).every(n => (counters as string[]).includes(n)) && counters.every(n => exactCount(f[n]))
      && f.knownValue <= (t[k] ?? 0) && (f.knownParts > 0 || f.knownValue === 0)
      && ['reportedParts','derivedParts','normalizedParts','assumedParts','notApplicableParts'].every(n => f[n as keyof TokenFieldEvidence] <= f.knownParts);
  });
}
/** These categories are disjoint. Missing optional legacy evidence stays missing in the breakdown. */
export function tokenCountDetails(t: TokenCounts) {
  const components = TOKEN_COMPONENTS.map(([key, label]) => {
    const note = tokenFieldNote(t, key);
    return { key, label, value: tokenFieldValue(t, key), ...(note ? { note } : {}) };
  });
  const valid = validTokenFieldCoverage(t) && TOKEN_COMPONENTS.every(([key]) => exactCount(t[key]) || key === 'cacheWriteUnassigned' && t[key] === undefined);
  const raw = valid ? components.reduce((sum, row) => sum + (row.value ?? 0), 0) : NaN;
  const subtotal = exactCount(raw) ? raw : null;
  const fieldsComplete = TOKEN_COMPONENTS.every(([key]) => !t.fieldEvidence || !fieldHasGap(t, key));
  return { components, subtotal, totalAvailable: subtotal !== null && !unresolvedCounts(t) && fieldsComplete,
    reasoning: tokenFieldValue(t, 'reasoning'),
    assumed1h: exactCount(t.cacheWriteAssumed1h) ? t.cacheWriteAssumed1h : null };
}

function fieldHasGap(t: TokenCounts, key: TokenFieldKey): boolean {
  const f = t.fieldEvidence?.[key];
  return !!f && (f.missingParts > 0 || f.invalidParts > 0 || f.unrecordedParts > f.normalizedParts);
}
export function tokenFieldValue(t: TokenCounts, key: TokenFieldKey): number | null {
  if (!validTokenFieldCoverage(t)) return null;
  const f = t.fieldEvidence?.[key];
  return f ? f.knownParts > 0 ? f.knownValue : null : exactCount(t[key]) ? t[key]! : null;
}
export function tokenFieldNote(t: TokenCounts, key: TokenFieldKey): string {
  if (!validTokenFieldCoverage(t)) return 'Field evidence invalid';
  const f = t.fieldEvidence?.[key];
  if (!f) return '';
  if (f.notApplicableParts > 0 && !f.reportedParts && !f.derivedParts && !fieldHasGap(t, key)) return 'Not applicable to this usage';
  const notes: string[] = [];
  if (f.derivedParts) notes.push('Derived from reported counters');
  if (f.normalizedParts) notes.push('Includes validated stored categories');
  if (f.assumedParts) notes.push(key === 'cacheRead' ? 'Includes cache reads assumed zero' : 'Includes a source policy assumption');
  if (f.missingParts) notes.push(f.knownParts ? 'Known subtotal; some counts not reported' : 'Not reported');
  if (f.invalidParts) notes.push('Invalid count observations; complete quantity unavailable');
  if (f.unrecordedParts) notes.push(f.unrecordedParts > f.normalizedParts
    ? `Raw field presence unrecorded; stored normalized category ${(t[key] ?? 0).toLocaleString()}`
    : 'Raw field presence unrecorded for some usage');
  if (!notes.length && f.reportedParts) notes.push('Reported counter');
  return notes.join(' · ');
}
export function tokenCategoryText(t: TokenCounts, key: TokenFieldKey): string {
  const value = tokenFieldValue(t, key), note = tokenFieldNote(t, key);
  return `${value === null ? 'Unavailable' : value.toLocaleString()}${note ? ' · ' + note : ''}`;
}

export function unresolvedCounts(t: Pick<TokenCounts, 'countQuality'>): boolean {
  return t.countQuality === 'incomplete' || t.countQuality === 'invalid' || t.countQuality === 'conflict';
}
export function tokenSubtotal(t: TokenCounts): number {
  return t.inputFresh + t.cacheWrite5m + t.cacheWrite1h + (t.cacheWriteUnassigned ?? 0) + t.cacheRead + t.output;
}
export function hasKnownEmptyUsage(t: TokenCounts, events?: number | null): boolean {
  // A scoped zero is different from unknown legacy evidence. Contradictory or malformed
  // counters must keep their existing qualification even if an event count says zero.
  const zeroCounters = [t.inputFresh, t.cacheWrite5m, t.cacheWrite1h, t.cacheRead, t.output, t.reasoning].every(n => n === 0)
    && [t.cacheWriteUnassigned, t.cacheWriteAssumed1h].every(n => n === undefined || n === 0);
  return validTokenFieldCoverage(t) && Number.isSafeInteger(events) && events === 0 && zeroCounters && !unresolvedCounts(t);
}
export function countBasisLabel(t: TokenCounts, events?: number | null): string {
  if (!validTokenFieldCoverage(t)) return 'Complete token total unavailable · field evidence invalid';
  if (hasKnownEmptyUsage(t, events)) {
    return 'No usage events recorded in this scope';
  }
  const basis = unresolvedCounts(t) ? `Complete token total unavailable · ${t.countQuality} count evidence`
    : t.fieldEvidence && !tokenCountDetails(t).totalAvailable ? 'Complete token total unavailable · field evidence incomplete'
    : t.countQuality === 'complete' ? t.fieldEvidence?.inputFresh.derivedParts ? 'Reported and derived count basis' : 'Reported count basis' : 'Count evidence unrecorded · normalized categories only';
  const unknown = (t.cacheWriteUnassigned ?? 0) > 0 ? ` · ${t.cacheWriteUnassigned!.toLocaleString()} cache writes with unknown TTL` : '';
  const assumed = (t.cacheWriteAssumed1h ?? 0) > 0 ? ` · ${t.cacheWriteAssumed1h!.toLocaleString()} cache writes assumed 1 hour` : '';
  const fresh = unresolvedCounts(t) && t.ucuCountQuality === 'complete' ? ' · v1-fresh work count known; excludes cache reads' : '';
  const nativeCacheAssumption = t.fieldEvidence?.cacheRead.assumedParts ? ' · cache reads include an assumed-zero policy' : '';
  return basis + fresh + unknown + assumed + nativeCacheAssumption;
}
export function tokenTotalText(t: TokenCounts): string {
  const evidence = tokenCountDetails(t);
  return evidence.totalAvailable ? `${evidence.subtotal! >= 1000 ? '≈' : ''}${formatCompactNumber(evidence.subtotal!)}` : 'Unavailable';
}

/** Aggregate only returned reports; keep each report's count evidence and numeric limits. */
export function aggregateTokenText(counts: TokenCounts[]): { text: string; title: string } {
  const details = counts.map(tokenCountDetails);
  const subtotal = details.reduce((sum, row) => sum + (row.subtotal ?? 0), 0);
  if (!counts.length || details.some(row => !row.totalAvailable) || !exactCount(subtotal)) {
    return { text: 'Unavailable', title: 'Complete token total unavailable across the returned reports' };
  }
  const basis = counts.every(t => t.countQuality === 'complete') ? counts.some(t => t.fieldEvidence?.inputFresh.derivedParts) ? 'Reported and derived count basis' : 'Reported count basis'
    : 'Count evidence unrecorded on one or more reported hosts; normalized categories only';
  const assumptions = counts.some(t => t.fieldEvidence?.cacheRead.assumedParts) ? ' · cache reads include an assumed-zero policy' : '';
  return { text: `${subtotal >= 1000 ? '≈' : ''}${formatCompactNumber(subtotal)}`,
    title: `Exact category subtotal: ${subtotal.toLocaleString()} tokens · ${basis}${assumptions}` };
}

export function exactTokenLabel(t: TokenCounts): string {
  const evidence = tokenCountDetails(t);
  if (evidence.subtotal === null) return 'Exact token subtotal unavailable · invalid or unsupported numeric categories';
  return `${evidence.totalAvailable ? 'Exact category subtotal' : 'Known category subtotal; complete total unavailable'}: ${evidence.subtotal.toLocaleString()} tokens · ${countBasisLabel(t)}`;
}
