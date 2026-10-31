import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectDistManifest } from '../../scripts/write-build-identity.mjs';
import { stagePrivatePackage } from '../../scripts/stage-private-package.mjs';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const builderConfig = require('../../packaging/electron-builder.config.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root, relativePath, content) {
  const fullPath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function refreshBuildIdentity(root) {
  const revision = git(root, ['rev-parse', 'HEAD']);
  const distManifest = collectDistManifest(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist/package-manifest.json'), distManifest.content);
  fs.writeFileSync(path.join(root, 'dist/daemon/build-identity.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourceRevision: revision,
    sourceDirty: false,
    distManifestSha256: distManifest.sha256,
  })}\n`);
}

function createFixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-r3259-stage-test-'));
  const root = path.join(parent, 'repo');
  fs.mkdirSync(root);
  fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(repositoryRoot, 'package-lock.json'), path.join(root, 'package-lock.json'));
  fs.copyFileSync(path.join(repositoryRoot, 'tsconfig.json'), path.join(root, 'tsconfig.json'));
  write(root, 'scripts/install-service-windows.ps1', 'fixture packaged lifecycle helper\n');
  write(root, 'scripts/install-service-macos.sh', '#!/bin/bash\n# fixture packaged macOS lifecycle helper\n');
  write(root, 'scripts/windows/TokeneloHiddenLauncher.cs', '// fixture packaged hidden launcher\n');
  write(root, 'scripts/not-included.ps1', 'not in the explicit package allowlist\n');

  const tscSources = [
    'src/tray/main.ts', 'src/tray/preload.ts', 'src/tray/argv.ts',
    'src/daemon/main.ts', 'src/daemon/report-process-entry.ts', 'src/daemon/report-worker.ts',
  ];
  for (const source of tscSources) {
    const sourceText = source === 'src/tray/main.ts'
      ? "import { ready } from './renderer/snapshot-outcome.js'; export { ready };\n"
      : source === 'src/tray/argv.ts'
        ? "import { scoped } from './renderer/initial-scope.js'; export { scoped };\n"
        : `export const fixture = '${source}';\n`;
    write(root, source, sourceText);
    const emitted = `dist/${source.slice('src/'.length, -'.ts'.length)}.js`;
    write(root, emitted, `compiled:${source}\n`);
    write(root, `${emitted}.map`, `map:${source}\n`);
  }
  for (const [source, sourceText] of [
    ['src/tray/renderer/initial-scope.ts', "import type { Range } from './api-types.js'; export const scoped: Range = 'today';\n"],
    ['src/tray/renderer/api-types.ts', 'export type Range = string;\n'],
    ['src/tray/renderer/snapshot-outcome.ts', 'export const ready = true;\n'],
  ]) {
    write(root, source, sourceText);
    const emitted = `dist/${source.slice('src/'.length, -'.ts'.length)}.js`;
    write(root, emitted, `compiled:${source}\n`);
    write(root, `${emitted}.map`, `map:${source}\n`);
  }
  for (const entry of ['app', 'detail']) {
    write(root, `src/tray/renderer/${entry}.ts`, `export const ${entry} = true;\n`);
    write(root, `dist/tray/renderer/${entry}.js`, `bundle:${entry}\n`);
    write(root, `dist/tray/renderer/${entry}.js.map`, `bundle-map:${entry}\n`);
  }
  for (const asset of ['index.html', 'styles.css', 'detail.html', 'detail.css']) {
    write(root, `src/tray/renderer/${asset}`, `asset:${asset}\n`);
    write(root, `dist/tray/renderer/${asset}`, `asset:${asset}\n`);
  }
  write(root, 'native/report-job-host.exe', 'fixture native helper\n');
  write(root, 'native/report-job-host.manifest.json', '{"fixture":true}\n');
  write(root, 'src/daemon/native/report-job-host.cs', '// fixture source\n');
  write(root, 'dist/daemon/native/report-job-host.exe', 'fixture native helper\n');
  write(root, 'rates/.gitkeep', '');
  for (const relativePath of ['rates/prices.json']) write(root, relativePath, `fixture:${relativePath}\n`);
  write(root, 'dist/package-manifest.json', 'pending\n');
  write(root, 'dist/daemon/build-identity.json', '{}\n');

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'packaging-test@example.invalid']);
  git(root, ['config', 'user.name', 'Packaging Fixture']);
  git(root, ['add', 'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'rates', 'native', 'scripts']);
  git(root, ['commit', '-q', '-m', 'synthetic packaging fixture']);
  refreshBuildIdentity(root);
  return { parent, root };
}

function removeFixture(fixture) {
  fs.rmSync(fixture.parent, { recursive: true, force: true });
}

test('builder config uses locked Electron, limits payload, and disables publishing', () => {
  const packageLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
  assert.equal(builderConfig.electronVersion, packageLock.packages['node_modules/electron'].version);
  assert.equal(builderConfig.asar, false);
  assert.equal(builderConfig.npmRebuild, false);
  assert.equal(builderConfig.win.signExecutable, false);
  assert.equal(builderConfig.win.signAndEditExecutable, undefined);
  assert.deepEqual(builderConfig.win.target, ['nsis']);
  assert.equal(builderConfig.buildVersion, JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version);
  assert.equal(builderConfig.buildNumber, '0');
  assert.equal(builderConfig.copyright, 'Copyright © 2026 Elo AI');
  assert.equal(builderConfig.win.requestedExecutionLevel, 'asInvoker');
  const iconDir = path.join(repositoryRoot, 'packaging', 'icons', 'generated');
  assert.equal(builderConfig.win.icon, path.join(iconDir, 'tokenelo-windows.ico'));
  assert.equal(builderConfig.mac.icon, path.join(iconDir, 'tokenelo-macos.icns'));
  assert.equal(builderConfig.linux.icon, path.join(iconDir, 'tokenelo-linux-512.png'));
  const ico = fs.readFileSync(builderConfig.win.icon);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  const icns = fs.readFileSync(builderConfig.mac.icon);
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const png = fs.readFileSync(builderConfig.linux.icon);
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.deepEqual(builderConfig.nsis, {
    include: path.join(repositoryRoot, 'scripts', 'windows', 'tokenelo-uninstall.nsh'),
    oneClick: true, perMachine: false, allowElevation: false, packElevateHelper: false, runAfterFinish: false,
    deleteAppDataOnUninstall: false, createDesktopShortcut: false,
  });
  const lifecycleHook = fs.lstatSync(builderConfig.nsis.include);
  assert.equal(lifecycleHook.isFile() && !lifecycleHook.isSymbolicLink(), true);
  assert.equal(builderConfig.publish, null);
  assert.deepEqual(builderConfig.files.map(entry => typeof entry === 'string' ? entry : entry.from), [
    'package.json', 'dist', 'rates', 'scripts/install-service-windows.ps1', 'scripts/install-service-macos.sh', 'scripts/windows/TokeneloHiddenLauncher.cs',
  ]);
});

test('stages exact dist and the prices file while omitting empty .gitkeep metadata', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  const first = stagePrivatePackage({ repositoryRoot: fixture.root, outDir: path.join(fixture.parent, 'stage-a') });
  const second = stagePrivatePackage({ repositoryRoot: fixture.root, outDir: path.join(fixture.parent, 'stage-b') });

  const appPackage = JSON.parse(fs.readFileSync(path.join(first.outDir, 'app/package.json'), 'utf8'));
  assert.deepEqual(appPackage, {
    name: 'tokenelo', version: '0.1.0', private: true, type: 'module', main: 'dist/tray/main.js',
    description: 'Local token tracking, reporting, and vendor accountability.',
    author: { name: 'Elo AI' }, license: 'UNLICENSED',
  });
  assert.equal(fs.existsSync(path.join(first.outDir, 'app/node_modules')), false);
  assert.equal(fs.readFileSync(path.join(first.outDir, 'app/scripts/install-service-windows.ps1'), 'utf8'), 'fixture packaged lifecycle helper\n');
  assert.equal(fs.readFileSync(path.join(first.outDir, 'app/scripts/windows/TokeneloHiddenLauncher.cs'), 'utf8'), '// fixture packaged hidden launcher\n');
  assert.equal(fs.readFileSync(path.join(first.outDir, 'app/scripts/install-service-macos.sh'), 'utf8'), '#!/bin/bash\n# fixture packaged macOS lifecycle helper\n');
  assert.equal(fs.existsSync(path.join(first.outDir, 'app/scripts/not-included.ps1')), false);
  assert.deepEqual(first.payloadManifest.files.map(file => file.path).filter(file => file.startsWith('scripts/')), [
    'scripts/install-service-macos.sh', 'scripts/install-service-windows.ps1', 'scripts/windows/TokeneloHiddenLauncher.cs',
  ]);
  assert.equal(fs.existsSync(path.join(first.outDir, 'app/rates/.gitkeep')), false);
  assert.equal(first.payloadManifest.files.some(file => file.path === 'rates/.gitkeep'), false);
  assert.equal(fs.readFileSync(path.join(first.outDir, 'app/dist/tray/renderer/api-types.js'), 'utf8'), 'compiled:src/tray/renderer/api-types.ts\n');
  assert.equal(first.stageManifest.source.dirty, false);
  assert.match(first.stageManifest.source.verificationScope, /does not independently attest compiler provenance/);
  assert.equal(first.stageManifest.application.main, 'dist/tray/main.js');
  assert.deepEqual(first.stageManifest.releasePolicy, { publish: 'never', publicAutoUpdates: false });
  assert.equal(first.stageManifest.payload.fileCount, first.payloadManifest.files.length);

  for (const name of ['payload-manifest.private.json', 'stage-manifest.private.json', 'SHA256SUMS']) {
    assert.equal(fs.readFileSync(path.join(first.outDir, name), 'utf8'), fs.readFileSync(path.join(second.outDir, name), 'utf8'));
  }
  const sums = fs.readFileSync(path.join(first.outDir, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(`${sha256(fs.readFileSync(path.join(first.outDir, 'app/rates/prices.json')))}  app/rates/prices.json`));
});

test('creates private output with safe payload modes under a permissive child umask', { skip: process.platform === 'win32' }, t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  const outDir = path.join(fixture.parent, 'permissive-umask-stage');
  const stageModule = pathToFileURL(path.join(repositoryRoot, 'scripts/stage-private-package.mjs')).href;
  const runner = [
    'import { stagePrivatePackage } from ' + JSON.stringify(stageModule) + ';',
    'process.umask(0o002);',
    'const result = stagePrivatePackage({',
    '  repositoryRoot: process.env.TOKENELO_STAGE_FIXTURE_ROOT,',
    '  outDir: process.env.TOKENELO_STAGE_FIXTURE_OUTPUT,',
    '});',
    'process.stdout.write(JSON.stringify({ fileCount: result.payloadManifest.files.length }));',
  ].join('\n');
  const parentUmask = process.umask();
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', runner], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      TOKENELO_STAGE_FIXTURE_ROOT: fixture.root,
      TOKENELO_STAGE_FIXTURE_OUTPUT: outDir,
    },
  });
  assert.equal(process.umask(), parentUmask);
  const childResult = JSON.parse(stdout);
  assert.ok(childResult.fileCount > 0);

  const expectedModes = [
    ['.', 0o700, 'directory'],
    ['app', 0o755, 'directory'],
    ['app/dist', 0o755, 'directory'],
    ['app/dist/tray/renderer', 0o755, 'directory'],
    ['app/rates', 0o755, 'directory'],
    ['app/scripts/windows', 0o755, 'directory'],
    ['app/package.json', 0o644, 'file'],
    ['app/dist/tray/main.js', 0o644, 'file'],
    ['app/rates/prices.json', 0o644, 'file'],
    ['app/scripts/install-service-macos.sh', 0o644, 'file'],
    ['payload-manifest.private.json', 0o600, 'file'],
    ['stage-manifest.private.json', 0o600, 'file'],
    ['SHA256SUMS', 0o600, 'file'],
  ];
  for (const [relativePath, expectedMode, expectedKind] of expectedModes) {
    const fullPath = relativePath === '.' ? outDir : path.join(outDir, relativePath);
    const stat = fs.lstatSync(fullPath);
    assert.equal(stat.isSymbolicLink(), false, relativePath);
    assert.equal(expectedKind === 'directory' ? stat.isDirectory() : stat.isFile(), true, relativePath);
    assert.equal(stat.mode & 0o7777, expectedMode, relativePath);
    assert.equal(stat.uid, process.getuid(), relativePath);
    assert.equal(fs.realpathSync(fullPath), fullPath, relativePath);
  }
});

test('refuses dirty source and tampered or missing built payloads', t => {
  const dirty = createFixture();
  t.after(() => removeFixture(dirty));
  write(dirty.root, 'untracked-source.ts', 'dirty\n');
  assert.throws(() => stagePrivatePackage({ repositoryRoot: dirty.root, outDir: path.join(dirty.parent, 'dirty-stage') }), /Source tree is dirty/);
  assert.equal(fs.existsSync(path.join(dirty.parent, 'dirty-stage')), false);

  const tampered = createFixture();
  t.after(() => removeFixture(tampered));
  write(tampered.root, 'dist/tray/main.js', 'changed after build\n');
  assert.throws(() => stagePrivatePackage({ repositoryRoot: tampered.root, outDir: path.join(tampered.parent, 'tampered-stage') }), /package-manifest/);

  const missing = createFixture();
  t.after(() => removeFixture(missing));
  fs.rmSync(path.join(missing.root, 'rates/prices.json'));
  assert.throws(() => stagePrivatePackage({ repositoryRoot: missing.root, outDir: path.join(missing.parent, 'missing-stage') }));
});

test('refuses a missing packaged Windows lifecycle helper', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  fs.rmSync(path.join(fixture.root, 'scripts/windows/TokeneloHiddenLauncher.cs'));
  git(fixture.root, ['add', '-u']);
  git(fixture.root, ['commit', '-q', '-m', 'fixture omits required Windows launcher']);
  refreshBuildIdentity(fixture.root);
  const outDir = path.join(fixture.parent, 'missing-lifecycle-stage');
  assert.throws(() => stagePrivatePackage({ repositoryRoot: fixture.root, outDir }), /Required package payload is missing: scripts\/windows\/TokeneloHiddenLauncher\.cs/);
  assert.equal(fs.existsSync(outDir), false);
});

test('refuses a missing packaged macOS lifecycle helper before staging', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  fs.rmSync(path.join(fixture.root, 'scripts/install-service-macos.sh'));
  git(fixture.root, ['add', '-u']);
  git(fixture.root, ['commit', '-q', '-m', 'fixture omits required macOS helper']);
  refreshBuildIdentity(fixture.root);
  const outDir = path.join(fixture.parent, 'missing-macos-lifecycle-stage');
  assert.throws(() => stagePrivatePackage({ repositoryRoot: fixture.root, outDir }), /Required package payload is missing: scripts\/install-service-macos\.sh/);
  assert.equal(fs.existsSync(outDir), false);
});

test('refuses build identity that is not verified clean at current HEAD', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  const identityPath = path.join(fixture.root, 'dist/daemon/build-identity.json');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  identity.sourceDirty = true;
  fs.writeFileSync(identityPath, `${JSON.stringify(identity)}\n`);
  assert.throws(() => stagePrivatePackage({ repositoryRoot: fixture.root, outDir: path.join(fixture.parent, 'unverified-stage') }), /Build identity/);
});

test('refuses output through a junction that resolves inside the source worktree', t => {
  const fixture = createFixture();
  const alias = path.join(fixture.parent, 'repo-junction');
  try { fs.symlinkSync(fixture.root, alias, 'junction'); }
  catch (error) { removeFixture(fixture); t.skip(`Windows directory junction unavailable: ${error.code ?? error.message}`); return; }
  t.after(() => {
    fs.rmSync(alias, { recursive: true, force: true });
    removeFixture(fixture);
  });
  const output = path.join(alias, 'hidden-stage');
  assert.throws(() => stagePrivatePackage({ repositoryRoot: fixture.root, outDir: output }), /outside the source repository/);
  assert.equal(fs.existsSync(path.join(fixture.root, 'hidden-stage')), false);
});

test('rejects injected secrets, non-runtime files, untracked dist outputs, and extra rates', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  const cases = [
    ['dist/personal-token.json', '{}\n', /sensitive-name payload/],
    ['dist/notes.txt', 'not a compiled asset\n', /payload extension/],
    ['dist/unreviewed-module.js', 'export {};\n', /outputs derived from committed source/],
  ];
  for (const [relativePath, content, expectedError] of cases) {
    write(fixture.root, relativePath, content);
    refreshBuildIdentity(fixture.root);
    assert.throws(() => stagePrivatePackage({
      repositoryRoot: fixture.root,
      outDir: path.join(fixture.parent, `injected-${path.basename(relativePath)}`),
    }), expectedError);
    fs.rmSync(path.join(fixture.root, ...relativePath.split('/')));
  }

  write(fixture.root, 'rates/private-key.json', '{}\n');
  git(fixture.root, ['add', 'rates/private-key.json']);
  git(fixture.root, ['commit', '-q', '-m', 'synthetic unexpected rate payload']);
  refreshBuildIdentity(fixture.root);
  assert.throws(() => stagePrivatePackage({
    repositoryRoot: fixture.root,
    outDir: path.join(fixture.parent, 'unexpected-rate-stage'),
  }), /one-file allowlist/);
});

test('accepts JS and source map outputs derived from a newly committed source file', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  write(fixture.root, 'src/tray/daemon-launch.ts', 'export const launch = true;\n');
  git(fixture.root, ['add', 'src/tray/daemon-launch.ts']);
  git(fixture.root, ['commit', '-q', '-m', 'synthetic new TypeScript input']);
  write(fixture.root, 'dist/tray/daemon-launch.js', 'compiled:src/tray/daemon-launch.ts\n');
  write(fixture.root, 'dist/tray/daemon-launch.js.map', 'map:src/tray/daemon-launch.ts\n');
  refreshBuildIdentity(fixture.root);

  assert.equal(git(fixture.root, ['ls-files', '--', 'dist/tray/daemon-launch.js']), '');
  const staged = stagePrivatePackage({ repositoryRoot: fixture.root, outDir: path.join(fixture.parent, 'new-source-stage') });
  const stagedPaths = staged.payloadManifest.files.map(file => file.path);
  assert.ok(stagedPaths.includes('dist/tray/daemon-launch.js'));
  assert.ok(stagedPaths.includes('dist/tray/daemon-launch.js.map'));
});

test('rejects stale committed dist files that no longer derive from source inputs', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  write(fixture.root, 'dist/stale-renderer-module.js', 'obsolete compiled output\n');
  git(fixture.root, ['add', '-f', 'dist/stale-renderer-module.js']);
  git(fixture.root, ['commit', '-q', '-m', 'synthetic obsolete dist file']);
  refreshBuildIdentity(fixture.root);
  assert.throws(() => stagePrivatePackage({
    repositoryRoot: fixture.root,
    outDir: path.join(fixture.parent, 'stale-dist-stage'),
  }), /outputs derived from committed source/);
});

test('rejects a nonempty rates/.gitkeep placeholder', t => {
  const fixture = createFixture();
  t.after(() => removeFixture(fixture));
  write(fixture.root, 'rates/.gitkeep', 'not empty\n');
  git(fixture.root, ['add', 'rates/.gitkeep']);
  git(fixture.root, ['commit', '-q', '-m', 'synthetic nonempty rate placeholder']);
  refreshBuildIdentity(fixture.root);
  assert.throws(() => stagePrivatePackage({
    repositoryRoot: fixture.root,
    outDir: path.join(fixture.parent, 'nonempty-gitkeep-stage'),
  }), /rates\/\.gitkeep.*must be empty/);
});
