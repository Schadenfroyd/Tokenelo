import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RuntimeBuildIdentityState } from '../core/types.js';

export interface BuildIdentity {
  schemaVersion: 1;
  sourceRevision: string | null;
  sourceDirty: boolean | null;
  distManifestSha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Parse only the small, path-free identity embedded in dist by the clean build step. */
export function parseBuildIdentity(value: unknown): BuildIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1) return null;
  if (!(row.sourceRevision === null || (typeof row.sourceRevision === 'string' && GIT_REVISION.test(row.sourceRevision)))) return null;
  if (!(row.sourceDirty === null || typeof row.sourceDirty === 'boolean')) return null;
  if (typeof row.distManifestSha256 !== 'string' || !SHA256.test(row.distManifestSha256)) return null;
  return {
    schemaVersion: 1,
    sourceRevision: row.sourceRevision as string | null,
    sourceDirty: row.sourceDirty as boolean | null,
    distManifestSha256: row.distManifestSha256,
  };
}

/** Only a complete, revision-bound identity can qualify a worker for the current package. */
export function hasCompleteBuildIdentity(value: unknown): value is BuildIdentity {
  const identity = parseBuildIdentity(value);
  return identity !== null && identity.sourceRevision !== null && identity.sourceDirty !== null;
}

/** Compare path-free package identities; missing metadata stays unknown, never a match. */
export function compareBuildIdentities(expected: unknown, observed: unknown): RuntimeBuildIdentityState {
  const left = parseBuildIdentity(expected);
  const right = parseBuildIdentity(observed);
  if (!left || !right || !left.sourceRevision || !right.sourceRevision
    || left.sourceDirty === null || right.sourceDirty === null) return 'unknown';
  const equal = left.sourceRevision === right.sourceRevision
    && left.sourceDirty === right.sourceDirty
    && left.distManifestSha256 === right.distManifestSha256;
  if (!equal) return 'mismatch';
  return left.sourceDirty ? 'matching-dirty' : 'matching';
}

/** Load once at daemon startup. Missing or malformed build metadata is explicitly unknown. */
export function loadBuildIdentity(
  identityPath = fileURLToPath(new URL('./build-identity.json', import.meta.url)),
): BuildIdentity | null {
  try {
    return parseBuildIdentity(JSON.parse(readFileSync(identityPath, 'utf8')));
  } catch {
    return null;
  }
}
