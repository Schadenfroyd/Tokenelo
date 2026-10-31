import type { UsageEvent } from '../core/types.js';

// Keep the original columns first so consumers selecting by header keep working.
// Version 3 adds read-side field evidence while preserving earlier columns.
// This edition omits the reserved valuation columns (value, rate status, definition hash, rate selection) that
// the stored events keep; every remaining column keeps its relative order.
export const EXPORT_COLUMNS = [
  'id', 'host', 'source', 'ts', 'sessionId', 'model', 'provider', 'apiEquivUsd', 'priceStatus',
  'priceVersion',
  'inputFresh', 'cacheWrite5m', 'cacheWrite1h', 'cacheWriteUnassigned', 'cacheWriteAssumed1h',
  'cacheRead', 'output', 'reasoning', 'countQuality', 'ucuCountQuality',
  'tsSource', 'engine', 'thinking', 'speed', 'effort', 'serviceTier', 'inferenceGeo',
  'flags', 'components',
  'costBasis', 'exportSchemaVersion',
  'fieldEvidence',
] as const;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Model/source identifiers are untrusted strings. Quoting alone does not stop
  // spreadsheet formulas. This changes only the CSV presentation, never stored data or JSON.
  if (typeof value === 'string' && (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function eventsToCsv(events: readonly UsageEvent[]): string {
  const rows = events.map((event) => {
    const row: Record<string, unknown> = {
      ...event,
      ...event.tokens,
      countQuality: event.tokens.countQuality ?? 'unrecorded',
      ucuCountQuality: event.tokens.ucuCountQuality ?? event.tokens.countQuality ?? 'unrecorded',
      costBasis: 'api-equivalent-not-billed',
      exportSchemaVersion: 3,
    };
    return EXPORT_COLUMNS.map((column) => cell(row[column])).join(',');
  });
  return [EXPORT_COLUMNS.join(','), ...rows].join('\n') + '\n';
}
