/** Checks stored field consistency only; never vendor/rate/invoice authenticity. Counters can overlap. */
export interface PriceEvidence {
  version: 1;
  events: number;
  invalidAmountEvents: number;
  unknownStatusEvents: number;
  statusAmountConflictEvents: number;
  issuesEvents: number;
  aggregateAmountInvalid: boolean;
}
export function emptyPriceEvidence(): PriceEvidence {
  return { version: 1, events: 0, invalidAmountEvents: 0, unknownStatusEvents: 0, statusAmountConflictEvents: 0, issuesEvents: 0, aggregateAmountInvalid: false };
}
export function addPriceEvidence(target: PriceEvidence, amount: unknown, status: unknown): void {
  const invalid = amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0);
  const unknown = status !== 'LIST' && status !== 'ESTIMATE' && status !== 'UNPRICED';
  const conflict = !unknown && (amount === null ? status !== 'UNPRICED' : status === 'UNPRICED');
  target.events++;
  target.invalidAmountEvents += invalid ? 1 : 0;
  target.unknownStatusEvents += unknown ? 1 : 0;
  target.statusAmountConflictEvents += conflict ? 1 : 0;
  target.issuesEvents += invalid || unknown || conflict ? 1 : 0;
}
export function priceEvidenceOf(amount: unknown, status: unknown): PriceEvidence {
  const out = emptyPriceEvidence(); addPriceEvidence(out, amount, status); return out;
}
export function mergePriceEvidence(target: PriceEvidence, value: PriceEvidence): void {
  for (const key of ['events', 'invalidAmountEvents', 'unknownStatusEvents', 'statusAmountConflictEvents', 'issuesEvents'] as const) target[key] += value[key];
  target.aggregateAmountInvalid ||= value.aggregateAmountInvalid;
}
export function qualifyAggregateAmount(evidence: PriceEvidence, amount: unknown): void {
  if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) evidence.aggregateAmountInvalid = true;
}
export function priceEvidenceFromCounts(row: Pick<PriceEvidence, 'events' | 'invalidAmountEvents' | 'unknownStatusEvents' | 'statusAmountConflictEvents' | 'issuesEvents'>, amount: unknown): PriceEvidence {
  const evidence: PriceEvidence = { version: 1, ...row, aggregateAmountInvalid: false };
  qualifyAggregateAmount(evidence, amount); return evidence;
}
export function priceEvidenceProblem(value: unknown, expectedEvents?: number): string | null {
  if (!value || typeof value !== 'object') return 'price evidence absent';
  const row = value as Record<string, unknown>;
  if (row.version !== 1) return 'unsupported price evidence version';
  if (typeof row.aggregateAmountInvalid !== 'boolean') return 'aggregate amount check absent';
  const keys = ['events', 'invalidAmountEvents', 'unknownStatusEvents', 'statusAmountConflictEvents', 'issuesEvents'] as const;
  if (keys.some(key => typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || (row[key] as number) < 0)) return 'invalid price evidence count';
  const n = row as unknown as PriceEvidence;
  if (expectedEvents !== undefined && n.events !== expectedEvents) return 'price evidence scope mismatch';
  const parts = [n.invalidAmountEvents, n.unknownStatusEvents, n.statusAmountConflictEvents];
  if (n.issuesEvents > n.events || parts.some(count => count > n.issuesEvents) || n.issuesEvents > parts.reduce((a, b) => a + b, 0)) return 'price evidence union contradicts counts';
  return null;
}

/** Fixed SQL on event columns, shared by account and Doctor reads; no caller text interpolated. */
export const PRICE_EVIDENCE_SQL = {
  invalid: "(api_equiv_usd IS NOT NULL AND (typeof(api_equiv_usd) NOT IN ('integer','real') OR api_equiv_usd < 0 OR abs(api_equiv_usd) > 1.7976931348623157e308))",
  unknown: "(price_status IS NULL OR price_status NOT IN ('LIST','ESTIMATE','UNPRICED'))",
  conflict: "((api_equiv_usd IS NULL AND price_status IN ('LIST','ESTIMATE')) OR (api_equiv_usd IS NOT NULL AND price_status='UNPRICED'))",
} as const;
export const PRICE_EVIDENCE_AGG_SQL = [
  `COALESCE(SUM(CASE WHEN ${PRICE_EVIDENCE_SQL.invalid} THEN 1 ELSE 0 END),0) AS invalidAmountEvents`,
  `COALESCE(SUM(CASE WHEN ${PRICE_EVIDENCE_SQL.unknown} THEN 1 ELSE 0 END),0) AS unknownStatusEvents`,
  `COALESCE(SUM(CASE WHEN ${PRICE_EVIDENCE_SQL.conflict} THEN 1 ELSE 0 END),0) AS statusAmountConflictEvents`,
  `COALESCE(SUM(CASE WHEN ${PRICE_EVIDENCE_SQL.invalid} OR ${PRICE_EVIDENCE_SQL.unknown} OR ${PRICE_EVIDENCE_SQL.conflict} THEN 1 ELSE 0 END),0) AS issuesEvents`,
].join(',');
