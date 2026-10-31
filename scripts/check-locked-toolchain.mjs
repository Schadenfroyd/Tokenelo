import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Read metadata only: never load package code or repair a borrowed dependency tree.
export function checkLockedToolchain(root = process.cwd()) {
  const errors = [];
  const read = path => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { return undefined; }
  };
  const manifest = read(join(root, 'package.json'));
  const lock = read(join(root, 'package-lock.json'));
  if (!record(manifest) || !record(lock) || lock.lockfileVersion !== 3 ||
      !record(lock.packages) || !record(lock.packages[''])) {
    return { ok: false, checked: 0, errors: [{ code: 'invalid-project-metadata' }] };
  }
  const lockedRoot = lock.packages[''];
  const declared = new Map();
  for (const kind of ['dependencies', 'devDependencies']) {
    const actual = manifest[kind] ?? {};
    const expected = lockedRoot[kind] ?? {};
    if (!record(actual) || !record(expected)) {
      errors.push({ code: 'invalid-dependency-declarations', kind });
      continue;
    }
    for (const name of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
      if (!packageName.test(name)) {
        errors.push({ code: 'invalid-package-name', kind });
        continue;
      }
      if (typeof actual[name] !== 'string' || actual[name] !== expected[name]) {
        errors.push({ code: 'manifest-lock-mismatch', name });
      }
      declared.set(name, true);
    }
  }
  for (const name of ['typescript', 'esbuild', 'vitest']) {
    if (!declared.has(name)) errors.push({ code: 'required-tool-not-declared', name });
  }
  for (const name of declared.keys()) {
    const expected = lock.packages[`node_modules/${name}`];
    if (!record(expected) || typeof expected.version !== 'string' || !version.test(expected.version)) {
      errors.push({ code: 'invalid-locked-version', name });
      continue;
    }
    const installed = read(join(root, 'node_modules', ...name.split('/'), 'package.json'));
    if (!record(installed) || typeof installed.version !== 'string' || !version.test(installed.version)) {
      errors.push({ code: 'missing-or-invalid-installed-metadata', name });
    } else if (installed.name !== name || installed.version !== expected.version) {
      errors.push({ code: 'installed-lock-mismatch', name });
    }
  }
  return { ok: errors.length === 0, checked: declared.size, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkLockedToolchain(process.argv[2]);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}
