import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLockedToolchain } from './check-locked-toolchain.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'tokenelo-locked-tools-'));
  const versions = { typescript: '5.9.3', esbuild: '0.28.2', vitest: '5.0.3', '@types/node': '22.18.0' };
  const manifest = { devDependencies: { ...versions } };
  const lock = { lockfileVersion: 3, packages: { '': structuredClone(manifest) } };
  const write = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  for (const [name, v] of Object.entries(versions)) {
    lock.packages[`node_modules/${name}`] = { version: v };
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    write(`node_modules/${name}/package.json`, { name, version: v });
  }
  const save = () => { write('package.json', manifest); write('package-lock.json', lock); };
  save();
  try { run({ root, manifest, lock, save, write }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const has = (result, code) => result.errors.some(error => error.code === code);

test('locked direct dependencies pass without changing metadata bytes', () => fixture(({ root }) => {
  const before = readFileSync(join(root, 'package-lock.json'));
  assert.deepEqual(checkLockedToolchain(root), { ok: true, checked: 4, errors: [] });
  assert.deepEqual(readFileSync(join(root, 'package-lock.json')), before);
}));
test('rejects the observed old Vitest before test discovery', () => fixture(({ root, write }) => {
  write('node_modules/vitest/package.json', { name: 'vitest', version: '2.1.9' });
  assert(has(checkLockedToolchain(root), 'installed-lock-mismatch'));
}));
test('rejects the observed old esbuild before bundling', () => fixture(({ root, write }) => {
  write('node_modules/esbuild/package.json', { name: 'esbuild', version: '0.24.2' });
  assert(has(checkLockedToolchain(root), 'installed-lock-mismatch'));
}));
test('rejects a missing installed required tool', () => fixture(({ root }) => {
  rmSync(join(root, 'node_modules/typescript/package.json'));
  assert(has(checkLockedToolchain(root), 'missing-or-invalid-installed-metadata'));
}));
test('rejects a changed manifest without the corresponding lock', () => fixture(({ root, manifest, save }) => {
  manifest.devDependencies.vitest = '5.0.4'; save();
  assert(has(checkLockedToolchain(root), 'manifest-lock-mismatch'));
}));
test('rejects an undeclared required tool', () => fixture(({ root, manifest, lock, save }) => {
  delete manifest.devDependencies.vitest; delete lock.packages[''].devDependencies.vitest; save();
  assert(has(checkLockedToolchain(root), 'required-tool-not-declared'));
}));
test('rejects invalid package paths without reading outside node_modules', () => fixture(({ root, manifest, lock, save }) => {
  manifest.devDependencies['../outside'] = '1.0.0';
  lock.packages[''].devDependencies['../outside'] = '1.0.0'; save();
  assert(has(checkLockedToolchain(root), 'invalid-package-name'));
}));
test('invalid JSON produces a bounded report without exposing its contents', () => fixture(({ root }) => {
  writeFileSync(join(root, 'package-lock.json'), 'invalid sentinel contents');
  assert.deepEqual(checkLockedToolchain(root), { ok: false, checked: 0, errors: [{ code: 'invalid-project-metadata' }] });
}));
test('metadata from a different package cannot impersonate the locked tool', () => fixture(({ root, write }) => {
  write('node_modules/vitest/package.json', { name: 'other', version: '5.0.3' });
  assert(has(checkLockedToolchain(root), 'installed-lock-mismatch'));
}));
test('platform-specific transitive optional packages are not required', () => fixture(({ root, lock, save }) => {
  lock.packages['node_modules/@esbuild/linux-arm64'] = { version: '0.28.2', optional: true }; save();
  assert.equal(checkLockedToolchain(root).ok, true);
}));
