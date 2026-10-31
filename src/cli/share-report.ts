import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Range, TokenCounts } from '../core/types.js';
import { USAGE_SOURCES } from '../core/types.js';
import { getPaths } from '../daemon/paths.js';
import { readUsageAggregate, type UsageAggregateResponse } from '../store/usage-aggregate.js';
import { priceEvidenceProblem, type PriceEvidence } from '../core/price-evidence.js';
import { validTokenFieldCoverage } from '../core/token-field-evidence.js';

const COMPONENTS = ['inputFresh', 'cacheRead', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnassigned'] as const;
const QUALITIES = ['complete', 'incomplete', 'invalid', 'conflict', 'unrecorded'] as const;
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const amount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const countOrNull = (n: unknown): number | null => count(n) ? n : null;

/** Versioned allowlist: never spread a summary, token object, model name or caller-supplied metadata. */
function tokenEvidence(tokens: TokenCounts) {
  const fieldsValid = validTokenFieldCoverage(tokens);
  const normalized = Object.fromEntries(COMPONENTS.map(key => [key, countOrNull(tokens[key])])) as Record<(typeof COMPONENTS)[number], number | null>;
  const components = Object.fromEntries(COMPONENTS.map(key => [key, !fieldsValid ? null : tokens.fieldEvidence
    ? tokens.fieldEvidence[key].knownParts ? tokens.fieldEvidence[key].knownValue : null : normalized[key]])) as typeof normalized;
  const quality = QUALITIES.includes(tokens.countQuality!) ? tokens.countQuality! : 'unrecorded';
  const reasoning = tokens.fieldEvidence ? fieldsValid && tokens.fieldEvidence.reasoning.knownParts ? tokens.fieldEvidence.reasoning.knownValue : null : countOrNull(tokens.reasoning);
  const assumed1h = countOrNull(tokens.cacheWriteAssumed1h);
  const missingComponents = COMPONENTS.filter(key => components[key] === null);
  const sum = missingComponents.length ? null : COMPONENTS.reduce((n, key) => n + components[key]!, 0);
  const subtotal = count(sum) ? sum : null;
  const subsetsConsistent = count(tokens.reasoning) && normalized.output !== null && tokens.reasoning <= normalized.output
    && (assumed1h === null && tokens.cacheWriteAssumed1h === undefined || assumed1h !== null && normalized.cacheWrite1h !== null && assumed1h <= normalized.cacheWrite1h);
  const fieldsComplete = fieldsValid && COMPONENTS.every(k => !tokens.fieldEvidence || !tokens.fieldEvidence[k].missingParts && !tokens.fieldEvidence[k].invalidParts && tokens.fieldEvidence[k].unrecordedParts <= tokens.fieldEvidence[k].normalizedParts);
  const complete = quality === 'complete' && subtotal !== null && subsetsConsistent && fieldsComplete;
  const normalizedSum = COMPONENTS.reduce((n, key) => n + (normalized[key] ?? 0), 0);
  const normalizedSubtotal = COMPONENTS.every(k => normalized[k] !== null) && count(normalizedSum) ? normalizedSum : null;
  const knownSum = COMPONENTS.reduce((n, k) => n + (components[k] ?? 0), 0);
  return {
    components, countQuality: quality, missingComponents,
    ...(tokens.fieldEvidence ? { fieldEvidence: fieldsValid ? tokens.fieldEvidence : null,
      normalizedComponents: normalized, knownCategorySubtotal: fieldsValid && count(knownSum) ? knownSum : null,
      fieldEvidenceScope: 'component-contributions-and-uninspected-legacy-rows;not-event-counts' } : {}),
    normalizedCategorySubtotal: normalizedSubtotal, completeTotal: complete ? subtotal : null,
    totalStatus: complete ? tokens.fieldEvidence?.cacheRead.assumedParts ? 'complete-with-policy-assumptions' as const : 'reported-complete' as const : 'unavailable' as const,
    subsets: { reasoningIncludedInOutput: reasoning, assumed1hIncludedInCacheWrite1h: assumed1h, consistent: subsetsConsistent },
  };
}

function priceEvidence(row: { events: number; apiEquivUsd: number; unpricedEvents?: number; estimatedPriceEvents?: number; priceStatus?: string | null; priceEvidence?: PriceEvidence }) {
  const events = countOrNull(row.events);
  const unpriced = countOrNull(row.unpricedEvents);
  const estimated = countOrNull(row.estimatedPriceEvents);
  const countsConsistent = events !== null && unpriced !== null && estimated !== null && unpriced + estimated <= events;
  const evidence = row.priceEvidence;
  const fieldsKnown = evidence !== undefined && events !== null && priceEvidenceProblem(evidence, events) === null;
  const fields = fieldsKnown ? { version: 1, events: evidence!.events, invalidAmountEvents: evidence!.invalidAmountEvents,
    unknownStatusEvents: evidence!.unknownStatusEvents, statusAmountConflictEvents: evidence!.statusAmountConflictEvents,
    issuesEvents: evidence!.issuesEvents, aggregateAmountInvalid: evidence!.aggregateAmountInvalid } : null;
  const conflicts = fieldsKnown && (evidence!.issuesEvents > 0 || evidence!.aggregateAmountInvalid);
  return {
    storedApiEquivalentUsd: amount(row.apiEquivUsd) ? row.apiEquivUsd : null,
    unpricedEvents: unpriced, estimatedPriceEvents: estimated,
    priceStatus: !conflicts && (row.priceStatus === 'LIST' || row.priceStatus === 'ESTIMATE' || row.priceStatus === 'UNPRICED') ? row.priceStatus : null,
    partial: countsConsistent ? unpriced! > 0 : null, countsConsistent,
    recordedFieldChecks: fields, fieldState: !fieldsKnown ? 'unavailable' : conflicts ? 'conflict' : 'checked',
  };
}

/** Canonical v1 bytes: recursively sorted object keys, JSON scalars, original array order, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

/** Projects exactly one selected Summary snapshot. Collector IDs are not vendor billing identities. */
export function buildShareReport(summary: UsageAggregateResponse, expectedRange: Range) {
  if (summary.range !== expectedRange) throw new Error('Share report range mismatch');
  const totals = { events: countOrNull(summary.totals.events), tokens: tokenEvidence(summary.totals.tokens), pricing: priceEvidence(summary.totals) };
  const entries = Object.entries(summary.bySource ?? {});
  const unknownSources = entries.some(([source]) => !(USAGE_SOURCES as readonly string[]).includes(source));
  const sources = USAGE_SOURCES.flatMap(source => {
    const row = summary.bySource?.[source];
    return row ? [{ source, events: countOrNull(row.events), tokens: tokenEvidence(row.tokens), pricing: priceEvidence(row) }] : [];
  });
  const sumEvents = sources.reduce((n, row) => n + (row.events ?? NaN), 0);
  const normalizedOf = (value: ReturnType<typeof tokenEvidence>) => value.normalizedComponents ?? value.components;
  // Only inspected not-applicable or validated complete normalized coverage can
  // explain an omitted optional write category. Unknown legacy absence remains
  // unavailable. Never relabel the raw field or complete-total assessment.
  const comparisonOf = (value: ReturnType<typeof tokenEvidence>, original: TokenCounts) => {
    const field = validTokenFieldCoverage(original) ? original.fieldEvidence?.cacheWriteUnassigned : undefined;
    const knownOmission = field && field.knownValue === 0 && field.knownParts > 0
      && field.notApplicableParts + field.normalizedParts === field.knownParts
      && field.unrecordedParts <= field.normalizedParts && field.missingParts === 0 && field.invalidParts === 0;
    return { ...normalizedOf(value), cacheWriteUnassigned: original.cacheWriteUnassigned === undefined && knownOmission
      ? 0 : normalizedOf(value).cacheWriteUnassigned };
  };
  const totalComparison = comparisonOf(totals.tokens, summary.totals.tokens);
  const sourceComparisons = sources.map(row => comparisonOf(row.tokens, summary.bySource[row.source]!.tokens));
  const sourceNumericsAvailable = !unknownSources && sources.length > 0 && count(sumEvents) && totals.events !== null
    && COMPONENTS.every(key => totalComparison[key] !== null && sourceComparisons.every(row => row[key] !== null));
  const sourceState = !sourceNumericsAvailable ? 'unavailable' as const : sumEvents === totals.events && COMPONENTS.every(key => {
    const sum = sourceComparisons.reduce((n, row) => n + row[key]!, 0);
    return count(sum) && sum === totalComparison[key];
  }) ? 'match' as const : 'mismatch' as const;
  const basis = summary.timeBasis;
  const timeValid = basis && count(basis.asOfMs) && (basis.startMs === null || count(basis.startMs) && basis.startMs <= basis.asOfMs)
    && basis.asOfMs === summary.generatedAt && basis.endInclusive === true && basis.timestampBasis === 'recorded-timestamps'
    && count(basis.excludedFutureEvents) && count(basis.excludedFutureActivity);
  const payload = {
    schema: 'tokenelo.aggregate-report.v3', range: expectedRange,
    queryScope: timeValid ? { startMs: basis.startMs, asOfMs: basis.asOfMs, endInclusive: true, timestampBasis: 'recorded-timestamps',
      excludedFutureEvents: basis.excludedFutureEvents, excludedFutureActivity: basis.excludedFutureActivity } : null,
    totals, sources, sourceReconciliation: { status: sourceState, basis: 'event-count-and-six-disjoint-token-components',
      optionalUnassignedComparison: 'known-not-applicable-or-normalized-omission-as-zero;unknown-legacy-absence-unavailable' },
    qualifications: {
      captureCompleteness: 'not-attested', sourceMeaning: 'collector-feed-not-vendor-billing-identity',
      tokenSemantics: 'reasoning-is-subset-of-output;assumed-1h-is-subset-of-1h-writes;subsets-not-added-again',
      priceBasis: 'stored-event-api-equivalent-estimates;not-invoiced-spend;rate-versions-not-in-this-report',
      privacy: 'identifiers-paths-models-and-accounts-excluded-by-allowlist;component-count-coverage-aggregates-and-timestamps-can-still-identify-activity',
      authenticity: 'unsigned-integrity-digest;not-vendor-attestation-or-invoice-reconciliation',
    },
  };
  return { ...payload, integrity: { algorithm: 'sha256', serialization: 'tokenelo-canonical-json-v1', sha256: digest(payload) } };
}

export type ShareReport = ReturnType<typeof buildShareReport>;
/** Checks bytes for accidental alteration only; a caller can change a report and recompute an unsigned digest. */
export function verifyShareReportDigest(report: ShareReport): boolean {
  const { integrity, ...payload } = report;
  return integrity?.algorithm === 'sha256' && integrity.serialization === 'tokenelo-canonical-json-v1' && integrity.sha256 === digest(payload);
}

/** No runtime bootstrap, migrations, config reads/writes, pricing engines, collectors, network or exclusive lock.
 * SQLite may create/update WAL shared-memory housekeeping. One narrow snapshot supplies the selected aggregate. */
export async function readShareReport(range: Range): Promise<ShareReport> {
  const paths = getPaths();
  if (!fs.existsSync(paths.dbFile)) throw new Error('No recorded Tokenelo ledger found; collect usage before creating an aggregate report.');
  return buildShareReport(await readUsageAggregate(paths.dbFile, range), range);
}
