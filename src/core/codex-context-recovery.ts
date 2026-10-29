import type { IngestState } from './types.js';
import { isCodexPrefixWitness } from './codex-prefix-witness.js';

/** Strict structural gate shared by the Codex collector and its ledger recovery writer. */
export function isUnownedCodexContextState(extra: unknown, sessionId: string): boolean {
  try {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || !isRecord(extra)
      || extra.v !== 1 || typeof extra.sessionId !== 'string' || extra.sessionId !== sessionId) return false;
    if (!Number.isSafeInteger(extra.lineIndex) || (extra.lineIndex as number) < 0) return false;
    if (extra.ownTurnStarted !== false || extra.ownTurnSeen !== false) return false;
    if (extra.hasRecords !== false) return false;
    if (!Array.isArray(extra.pending) || extra.pending.length !== 0) return false;
    if (!Array.isArray(extra.responseIds) || extra.responseIds.length !== 0) return false;
    if (Object.hasOwn(extra, 'emittedAhead') || Object.hasOwn(extra, 'lastLimits')) return false;
    if (extra.limitsById !== undefined && (!isRecord(extra.limitsById) || Object.keys(extra.limitsById).length !== 0)) return false;

    const summary = extra.summary;
    return isRecord(summary)
      && summary.ownBillableEmitted === 0
      && summary.ownTotalDerived === 0
      && summary.records === 0;
  } catch {
    return false;
  }
}

const CODEX_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function isCanonicalCodexSessionId(value: unknown): value is string {
  return typeof value === 'string' && CODEX_SESSION_ID.test(value);
}

/** Bind metadata and a structurally valid prefix witness to the cursor it accompanies.
 * This verifies stored shape and inode correspondence only; the collector owns file hashing/attestation. */
export function isStructurallyBoundCodexContextState(state: IngestState, sessionId: string): boolean {
  try {
    if (!state || typeof state !== 'object' || !isCanonicalCodexSessionId(sessionId)
      || !Number.isSafeInteger(state.offset) || state.offset <= 0 || !Number.isSafeInteger(state.size)
      || state.offset > state.size || typeof state.ino !== 'number' || !Number.isSafeInteger(state.ino)) return false;
    if (!isRecord(state.extra) || !isRecord(state.extra.meta) || state.extra.meta.id !== sessionId) return false;
    const witness = state.extra.consumedPrefix;
    if (!isCodexPrefixWitness(witness) || witness.bytes !== state.offset) return false;
    // Match fswalk.safeIno: reduce the exact decimal file id modulo 2^53 - 1.
    return Number(BigInt(witness.object.ino) % BigInt(Number.MAX_SAFE_INTEGER)) === state.ino;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
