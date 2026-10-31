import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function collectDistManifest(distRoot) {
  const rootPath = path.resolve(distRoot);
  const excluded = new Set(['daemon/build-identity.json', 'package-manifest.json']);
  const files = [];
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const fullPath = path.join(directory, name);
      const stat = lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`dist manifest refuses symbolic link: ${path.relative(rootPath, fullPath)}`);
      if (stat.isDirectory()) { walk(fullPath); continue; }
      if (!stat.isFile()) throw new Error(`dist manifest refuses non-regular entry: ${path.relative(rootPath, fullPath)}`);
      const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');
      if (excluded.has(relativePath)) continue;
      const bytes = readFileSync(fullPath);
      files.push({ path: relativePath, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  walk(rootPath);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const content = JSON.stringify({ schemaVersion: 1, files });
  return { files, content, sha256: createHash('sha256').update(content, 'utf8').digest('hex') };
}

function gitOutput(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

function ownsRepositoryRoot(repoRoot) {
  const topLevel = gitOutput(repoRoot, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return false;
  try {
    const sourceRoot = realpathSync(repoRoot);
    const gitRoot = realpathSync(topLevel);
    return process.platform === 'win32' ? sourceRoot.toLowerCase() === gitRoot.toLowerCase() : sourceRoot === gitRoot;
  } catch { return false; }
}

export function writeBuildIdentity(repoRoot = root) {
  const distRoot = path.join(repoRoot, 'dist');
  const manifest = collectDistManifest(distRoot);
  // An exported source folder must not inherit the revision of an unrelated enclosing repo.
  const revision = ownsRepositoryRoot(repoRoot) ? gitOutput(repoRoot, ['rev-parse', 'HEAD']) : null;
  const sourceRevision = revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) ? revision : null;
  // Generated outputs have their own complete manifest. Rebuilding tracked dist files must not
  // label a clean input checkout dirty; edited/untracked source inputs still do.
  const status = sourceRevision === null ? null : gitOutput(repoRoot,
    ['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)dist']);
  const identity = {
    schemaVersion: 1,
    sourceRevision,
    sourceDirty: status === null ? null : status.length > 0,
    distManifestSha256: manifest.sha256,
  };
  writeFileSync(path.join(distRoot, 'package-manifest.json'), manifest.content, { flag: 'w' });
  writeFileSync(path.join(distRoot, 'daemon', 'build-identity.json'), `${JSON.stringify(identity)}\n`, { flag: 'w' });
  return identity;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeBuildIdentity();
