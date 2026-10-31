/**
 * Persisted incomplete-capture markers. A collector that must stop at a line it will not ingest
 * records the hold in its own `ingest_state` row's `extra`, under CLAUDE_HOLD_KEY. The row's
 * `offset`, `ino`, `size` and `mtime_ms` already identify the held file, so the marker carries only
 * when the hold began, the line cap, and optionally the complete capped-prefix digest.
 *
 * Only aggregate metadata leaves this module. No paths, line text, or session content.
 */
import type { IncompleteCaptureStatus } from './types.js';

/** Key inside a Claude file's `ingest_state.extra`. Claude rows are written only by the Claude
 * collector, so no other collector's `extra` shape is affected. */
export const CLAUDE_HOLD_KEY = 'claudeHold';

export interface ClaudeHoldMarker {
  /** Epoch ms when the file was first held at this offset under this identity. */
  heldSince: number;
  /** Line cap in effect when the hold was recorded. A different cap re-checks the file. */
  maxLineBytes: number;
  /** SHA256 of all bytes inspected at the cap, not the complete overlong line. Collector-private;
   * older markers lack it and cannot establish prefix identity after a file change. */
  prefixSha256?: string;
}

/** A rolled-back batch could not merge a stored component row. The collector must retry even
 * when the source file is unchanged: a verified ledger repair can make the same batch usable. */
export interface ClaudeStoredEvidenceHoldMarker {
  heldSince: number;
  reason: 'stored-component-evidence';
  /** Complete original rejected byte prefix, used only to qualify continuous hold age after
   * append/touch. Never exposed through Coverage; missing legacy identity forces a recheck. */
  batchBytes?: number;
  batchSha256?: string;
}

export function readClaudeStoredEvidenceHold(extra: unknown): ClaudeStoredEvidenceHoldMarker | null {
  if (!extra || typeof extra !== 'object') return null;
  const marker = (extra as Record<string, unknown>)[CLAUDE_HOLD_KEY];
  if (!marker || typeof marker !== 'object') return null;
  const { heldSince, reason, batchBytes, batchSha256 } = marker as Record<string, unknown>;
  if (reason !== 'stored-component-evidence' || typeof heldSince !== 'number' || !Number.isFinite(heldSince)) return null;
  return { heldSince, reason, ...(typeof batchBytes === 'number' && Number.isSafeInteger(batchBytes) && batchBytes > 0
    && typeof batchSha256 === 'string' && /^[a-f0-9]{64}$/.test(batchSha256) ? { batchBytes, batchSha256 } : {}) };
}

/** Reads the Claude hold out of a collector-private `extra` value. Anything malformed is "not held". */
export function readClaudeHold(extra: unknown): ClaudeHoldMarker | null {
  if (!extra || typeof extra !== 'object') return null;
  const marker = (extra as Record<string, unknown>)[CLAUDE_HOLD_KEY];
  if (!marker || typeof marker !== 'object') return null;
  if ((marker as Record<string, unknown>).reason !== undefined) return null;
  const { heldSince, maxLineBytes, prefixSha256 } = marker as Record<string, unknown>;
  if (typeof heldSince !== 'number' || !Number.isFinite(heldSince)) return null;
  if (typeof maxLineBytes !== 'number' || !Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) return null;
  return { heldSince, maxLineBytes,
    ...(typeof prefixSha256 === 'string' && /^[a-f0-9]{64}$/.test(prefixSha256) ? { prefixSha256 } : {}) };
}

/** Aggregates persisted `extra_json` values into the Coverage status. Always returns a Claude entry,
 * so zero held files is an explicit zero rather than an absent field. */
export function summarizeClaudeHolds(extraJsonValues: Iterable<string | null>): IncompleteCaptureStatus {
  let heldFiles = 0;
  let oldestHeldAt: number | null = null;
  let oldestLineLimit: number | null = null;
  let storedComponentEvidenceHeldFiles = 0;
  for (const raw of extraJsonValues) {
    if (!raw) continue;
    let marker: ClaudeHoldMarker | ClaudeStoredEvidenceHoldMarker | null;
    try {
      const extra: unknown = JSON.parse(raw);
      marker = readClaudeStoredEvidenceHold(extra) ?? readClaudeHold(extra);
    } catch {
      marker = null;
    }
    if (!marker) continue;
    heldFiles++;
    if ('reason' in marker) storedComponentEvidenceHeldFiles++;
    if (oldestHeldAt === null || marker.heldSince < oldestHeldAt) {
      oldestHeldAt = marker.heldSince;
      oldestLineLimit = 'maxLineBytes' in marker ? marker.maxLineBytes : null;
    }
  }
  return {
    collector: 'claude',
    heldFiles,
    oldestHeldAt,
    maxLineBytes: oldestLineLimit,
    ...(storedComponentEvidenceHeldFiles > 0 ? { storedComponentEvidenceHeldFiles } : {}),
  };
}
