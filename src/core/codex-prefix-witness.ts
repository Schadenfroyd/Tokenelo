/** Fixed prefix chunk size shared by witness construction and pure structural validation. */
export const CODEX_PREFIX_CHUNK_BYTES = 1024 * 1024;

/** Content-free shape of the Codex rollout bytes already consumed by a cursor. */
export interface CodexPrefixWitness {
  v: 1;
  bytes: number;
  chunks: string[];
  tail: string;
  object: { dev: string; ino: string; birthNs: string };
  establishedAt: number;
  readBytes: number;
}

/** Structural validation only: this does not hash a file or attest that a witness matches source bytes. */
export function isCodexPrefixWitness(value: unknown): value is CodexPrefixWitness {
  try {
    if (!isRecord(value) || value.v !== 1 || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0
      || !Array.isArray(value.chunks) || value.chunks.length !== Math.floor((value.bytes as number) / CODEX_PREFIX_CHUNK_BYTES)
      || !value.chunks.every(isSha256) || !isSha256(value.tail) || !isRecord(value.object)
      || ![value.object.dev, value.object.ino, value.object.birthNs].every(isUnsignedDecimal)
      || typeof value.establishedAt !== 'number' || !Number.isFinite(value.establishedAt)
      || !Number.isSafeInteger(value.readBytes) || (value.readBytes as number) < 0) return false;
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isUnsignedDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
