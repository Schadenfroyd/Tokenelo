import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeBuildIdentity } from '../../scripts/write-build-identity.mjs';
import { compareBuildIdentities, hasCompleteBuildIdentity, loadBuildIdentity, parseBuildIdentity } from '../../src/daemon/build-identity.js';

const roots: string[] = [];
function fixtureRoot(): string { const root = mkdtempSync(path.join(tmpdir(), 'tokenelo-build-identity-')); roots.push(root); return root; }

function gitFixtureRoot(): string {
  const root = fixtureRoot();
  mkdirSync(path.join(root, 'dist', 'daemon'), { recursive: true });
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'empty-hooks'));
  writeFileSync(path.join(root, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'dist', 'daemon', 'main.js'), 'export const value = 1;\n');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(['add', 'src/main.ts', 'dist/daemon/main.js']);
  git(['-c', 'user.name=Tokenelo fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${path.join(root, 'empty-hooks')}`, 'commit', '--quiet', '-m', 'fixture']);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const identity = { schemaVersion: 1 as const, sourceRevision: 'a'.repeat(40), sourceDirty: false, distManifestSha256: 'b'.repeat(64) };

describe('build identity', () => {
  it('loads only a well-formed embedded identity and treats missing metadata as unknown', () => {
    const root = fixtureRoot();
    const file = path.join(root, 'build-identity.json');
    writeFileSync(file, JSON.stringify(identity));
    expect(loadBuildIdentity(file)).toEqual(identity);
    expect(loadBuildIdentity(path.join(root, 'missing.json'))).toBeNull();
    expect(parseBuildIdentity({ ...identity, sourceDirty: 'false' })).toBeNull();
    expect(parseBuildIdentity({ ...identity, distManifestSha256: '0' })).toBeNull();
    expect(parseBuildIdentity({ ...identity, schemaVersion: 2 })).toBeNull();
    expect(parseBuildIdentity({ ...identity, sourceRevision: null, sourceDirty: null })).toEqual({ ...identity, sourceRevision: null, sourceDirty: null });
  });

  it('compares complete package identities and keeps incomplete values unknown', () => {
    expect(hasCompleteBuildIdentity(identity)).toBe(true);
    expect(hasCompleteBuildIdentity({ ...identity, sourceRevision: null, sourceDirty: null })).toBe(false);
    expect(compareBuildIdentities(identity, identity)).toBe('matching');
    expect(compareBuildIdentities({ ...identity, sourceDirty: true }, { ...identity, sourceDirty: true })).toBe('matching-dirty');
    expect(compareBuildIdentities(identity, { ...identity, distManifestSha256: 'c'.repeat(64) })).toBe('mismatch');
    expect(compareBuildIdentities(identity, null)).toBe('unknown');
    expect(compareBuildIdentities({ ...identity, sourceRevision: null, sourceDirty: null }, identity)).toBe('unknown');
  });

  it('writes a deterministic complete dist manifest and binds the embedded identity to it', () => {
    const root = fixtureRoot();
    const dist = path.join(root, 'dist');
    mkdirSync(path.join(dist, 'daemon'), { recursive: true });
    mkdirSync(path.join(dist, 'tray'), { recursive: true });
    writeFileSync(path.join(dist, 'daemon', 'main.js'), 'daemon');
    writeFileSync(path.join(dist, 'tray', 'main.js'), 'tray');
    const written = writeBuildIdentity(root);
    const manifestBytes = readFileSync(path.join(dist, 'package-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const embedded = parseBuildIdentity(JSON.parse(readFileSync(path.join(dist, 'daemon', 'build-identity.json'), 'utf8')));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(['daemon/main.js', 'tray/main.js']);
    expect(written.sourceRevision).toBeNull();
    expect(written.sourceDirty).toBeNull();
    expect(embedded).toEqual(written);
    expect(written.distManifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'));
  });

  it('keeps generated dist changes separate from uncommitted source changes', () => {
    const root = gitFixtureRoot();
    const clean = writeBuildIdentity(root);
    expect(clean.sourceRevision).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim());
    expect(clean.sourceDirty).toBe(false);
    writeFileSync(path.join(root, 'dist', 'daemon', 'main.js'), 'export const value = 2;\n');
    const rebuilt = writeBuildIdentity(root);
    expect(rebuilt.sourceDirty).toBe(false);
    expect(rebuilt.distManifestSha256).not.toBe(clean.distManifestSha256);
    writeFileSync(path.join(root, 'src', 'main.ts'), 'export const value = 2;\n');
    expect(writeBuildIdentity(root).sourceDirty).toBe(true);
  });

  it('does not attribute an exported source directory to an enclosing repository', () => {
    const parent = gitFixtureRoot();
    const exported = path.join(parent, 'exported');
    mkdirSync(path.join(exported, 'dist', 'daemon'), { recursive: true });
    writeFileSync(path.join(exported, 'dist', 'daemon', 'main.js'), 'exported build\n');
    const written = writeBuildIdentity(exported);
    expect(written.sourceRevision).toBeNull();
    expect(written.sourceDirty).toBeNull();
  });
});
