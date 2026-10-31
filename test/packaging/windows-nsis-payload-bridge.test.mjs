import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWindowsNsisPayloadBridge,
  windowsNsisPayloadBridgeContract,
} from '../../scripts/windows/build-nsis-payload-bridge.mjs';
import {
  serializeTrustedWindowsPayloadInventory,
  windowsPayloadManifestContract,
} from '../../scripts/windows/write-nsis-payload-manifest.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ordinalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const stageManifestBytes = Buffer.from('synthetic stage manifest pin\n', 'utf8');
const stagedPayloadManifestBytes = Buffer.from('synthetic staged app payload pin\n', 'utf8');
const vendorArchiveBytes = Buffer.from('synthetic pinned Electron archive bytes\n', 'utf8');
const transformSourceBytes = Buffer.from('synthetic source Electron executable\n', 'utf8');

function baseContext() {
  return {
    platform: 'win32',
    architecture: 'x64',
    outputDirectoryName: 'win-unpacked',
    packageIdentity: windowsPayloadManifestContract.packageIdentity,
    applicationPackageName: 'tokenelo',
    applicationVersion: '0.1.0',
    electronVersion: '44.9.3',
    electronBuilderVersion: '26.18.0',
    sourceRevision: 'a'.repeat(40),
    stageManifestSha256: sha256(stageManifestBytes),
    stagedPayloadManifestSha256: sha256(stagedPayloadManifestBytes),
    vendorArchiveSha256: sha256(vendorArchiveBytes),
  };
}

function createFixture(t, { extraFiles = [], omitFiles = [], provenanceOverrides = {} } = {}) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-nsis-bridge-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'win-unpacked');
  const pinDirectory = path.join(parent, 'build-resources');
  fs.mkdirSync(root);
  fs.mkdirSync(pinDirectory);
  const context = baseContext();
  const required = windowsPayloadManifestContract.requiredFiles;
  const paths = [...new Set([...required, ...extraFiles])].filter(item => !omitFiles.includes(item)).sort(ordinalCompare);
  const fileEntries = [];

  for (const relativePath of paths) {
    const fullPath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    const bytes = relativePath === windowsPayloadManifestContract.applicationPackageJson
      ? Buffer.from(JSON.stringify({
        name: context.applicationPackageName,
        version: context.applicationVersion,
        private: true,
        type: 'module',
        main: 'dist/tray/main.js',
      }) + '\n', 'utf8')
      : relativePath === 'Tokenelo.exe'
        ? Buffer.from('synthetic builder-transformed Tokenelo executable\n', 'utf8')
        : Buffer.from(`synthetic content for ${relativePath}\n`, 'utf8');
    fs.writeFileSync(fullPath, bytes, { flag: 'wx' });
    fileEntries.push({
      relativePath,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
      provenance: provenanceOverrides[relativePath] ?? provenanceFor(relativePath, context),
    });
  }

  const manifest = {
    schemaVersion: 1,
    kind: windowsNsisPayloadBridgeContract.expectedManifestKind,
    ...context,
    files: fileEntries,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
  const manifestPath = path.join(parent, 'expected-content-manifest.private.json');
  fs.writeFileSync(manifestPath, manifestBytes, { flag: 'wx' });
  const pinIncludePath = path.join(pinDirectory, 'tokenelo-payload-pin.nsh');
  return { parent, root, pinDirectory, context, fileEntries, manifest, manifestBytes, manifestPath, pinIncludePath };
}

function provenanceFor(relativePath, context) {
  if (relativePath === 'Tokenelo.exe') {
    return {
      sourceClass: 'verified-transform',
      sourceArtifactSha256: context.vendorArchiveSha256,
      sourceRelativePath: 'electron.exe',
      sourceBytesSha256: sha256(transformSourceBytes),
      transformId: 'fixture-electron-exe-to-tokenelo-exe-v1',
    };
  }
  if (relativePath.startsWith('resources/app/')) {
    return {
      sourceClass: 'app-stage',
      sourceArtifactSha256: context.stagedPayloadManifestSha256,
      sourceRelativePath: relativePath.slice('resources/app/'.length),
    };
  }
  return {
    sourceClass: 'vendor-electron',
    sourceArtifactSha256: context.vendorArchiveSha256,
    sourceRelativePath: relativePath,
  };
}

function runBridge(fixture, overrides = {}) {
  return buildWindowsNsisPayloadBridge({
    winUnpackedRoot: fixture.root,
    expectedManifestPath: fixture.manifestPath,
    expectedManifestSha256: sha256(fixture.manifestBytes),
    expectedContext: fixture.context,
    pinIncludePath: fixture.pinIncludePath,
    ...overrides,
  });
}

function derivedOutputs(fixture) {
  return [
    path.join(fixture.root, ...windowsNsisPayloadBridgeContract.inventoryRelativePath.split('/')),
    path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/')),
    fixture.pinIncludePath,
  ];
}

function assertNoDerivedOutputs(fixture) {
  for (const output of derivedOutputs(fixture)) assert.equal(fs.existsSync(output), false, `unexpected output: ${output}`);
}

function withPatchedFs(patches, callback) {
  const originals = new Map();
  for (const [name, replacement] of Object.entries(patches)) {
    originals.set(name, fs[name]);
    fs[name] = replacement;
  }
  try { return callback(); }
  finally {
    for (const [name, original] of originals) fs[name] = original;
  }
}

test('checks complete pinned content before deriving self-listed inventory, template, and NSIS hex pins', t => {
  const fixture = createFixture(t);
  const result = runBridge(fixture);
  const inventoryPath = derivedOutputs(fixture)[0];
  const templatePath = derivedOutputs(fixture)[1];
  const inventoryBytes = fs.readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const pin = fs.readFileSync(fixture.pinIncludePath, 'ascii');

  assert.equal(result.fullRootReady, false);
  assert.equal(result.restoreInputAllowed, false);
  assert.equal(result.targetPlatform, 'win32');
  assert.equal(result.targetArchitecture, 'x64');
  assert.equal(result.sourceFileCount, fixture.fileEntries.length);
  assert.deepEqual(inventory.files, [...fixture.fileEntries.map(entry => entry.relativePath),
    windowsNsisPayloadBridgeContract.inventoryRelativePath].sort(ordinalCompare));
  assert.equal(inventory.files.includes(windowsNsisPayloadBridgeContract.inventoryRelativePath), true,
    'path inventory did not include its own installed filename');
  assert.equal(template.trustedExpectedFileSetSha256, sha256(inventoryBytes));
  assert.equal(template.files.some(file => file.relativePath === windowsPayloadManifestContract.templateRelativePath), false,
    'template listed itself');
  assert.equal(template.files.some(file => file.relativePath === windowsPayloadManifestContract.uninstallerExe), false,
    'template listed the separate NSIS-generated uninstaller');
  assert.equal(template.files.find(file => file.relativePath === windowsNsisPayloadBridgeContract.inventoryRelativePath).sha256,
    sha256(inventoryBytes));
  assert.equal(result.inventorySha256, sha256(inventoryBytes));
  assert.equal(result.templateSha256, sha256(fs.readFileSync(templatePath)));
  assert.equal(path.relative(fixture.root, result.pinIncludePath).startsWith('..'), true);
  const defineLines = pin.trimEnd().split('\n');
  assert.equal(defineLines.length, 6);
  for (const line of defineLines) assert.match(line, /^!define TOKENELO_[A-Z0-9_]+ "[a-f0-9]{64}"$/u);
  assert.match(pin, new RegExp(`TOKENELO_COMPILED_TEMPLATE_SHA256 "${result.templateSha256}"`, 'u'));
  assert.match(pin, new RegExp(`TOKENELO_TRUSTED_INVENTORY_SHA256 "${result.inventorySha256}"`, 'u'));
});

test('rejects wrong target pins, manifest pins, and derived-path collisions before outputs', t => {
  const wrongArch = createFixture(t);
  assert.throws(() => runBridge(wrongArch, {
    expectedContext: { ...wrongArch.context, architecture: 'arm64' },
  }), /bridge_context_identity_reject/u);
  assertNoDerivedOutputs(wrongArch);

  const wrongManifestPin = createFixture(t);
  assert.throws(() => runBridge(wrongManifestPin, { expectedManifestSha256: '0'.repeat(64) }), /bridge_manifest_pin_mismatch/u);
  assertNoDerivedOutputs(wrongManifestPin);

  const wrongStagePin = createFixture(t);
  assert.throws(() => runBridge(wrongStagePin, {
    expectedContext: { ...wrongStagePin.context, stagedPayloadManifestSha256: '0'.repeat(64) },
  }), /bridge_manifest_context_mismatch/u);
  assertNoDerivedOutputs(wrongStagePin);

  const wrongProvenance = createFixture(t, {
    provenanceOverrides: {
      'resources/app/package.json': {
        sourceClass: 'app-stage',
        sourceArtifactSha256: sha256(vendorArchiveBytes),
        sourceRelativePath: 'package.json',
      },
    },
  });
  assert.throws(() => runBridge(wrongProvenance), /bridge_manifest_provenance_pin_reject/u);
  assertNoDerivedOutputs(wrongProvenance);

  const derivedCollision = createFixture(t);
  const collision = {
    ...derivedCollision.manifest,
    files: [...derivedCollision.manifest.files, {
      relativePath: windowsNsisPayloadBridgeContract.inventoryRelativePath,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
      provenance: provenanceFor('resources/app/placeholder.txt', derivedCollision.context),
    }].sort((left, right) => ordinalCompare(left.relativePath, right.relativePath)),
  };
  const collisionBytes = Buffer.from(`${JSON.stringify(collision)}\n`, 'utf8');
  const collisionPath = path.join(derivedCollision.parent, 'derived-collision.private.json');
  fs.writeFileSync(collisionPath, collisionBytes, { flag: 'wx' });
  assert.throws(() => runBridge(derivedCollision, {
    expectedManifestPath: collisionPath,
    expectedManifestSha256: sha256(collisionBytes),
  }), /bridge_manifest_derived_path_collision/u);
  assertNoDerivedOutputs(derivedCollision);
});

test('rejects content drift, extra or missing files, and manifest paths inside the unpacked tree before outputs', t => {
  const drift = createFixture(t);
  const changedPath = path.join(drift.root, 'icudtl.dat');
  fs.writeFileSync(changedPath, 'changed bytes not named by the external manifest\n');
  assert.throws(() => runBridge(drift), /bridge_tree_content_mismatch/u);
  assertNoDerivedOutputs(drift);

  const extra = createFixture(t);
  fs.writeFileSync(path.join(extra.root, 'unlisted-runtime.dll'), 'unexpected file\n', { flag: 'wx' });
  assert.throws(() => runBridge(extra), /bridge_tree_unexpected_file/u);
  assertNoDerivedOutputs(extra);

  const missing = createFixture(t);
  fs.rmSync(path.join(missing.root, 'resources.pak'));
  assert.throws(() => runBridge(missing), /bridge_tree_missing_file/u);
  assertNoDerivedOutputs(missing);

  const inside = createFixture(t);
  const insideManifest = path.join(inside.root, 'resources/app/expected-content-manifest.json');
  fs.copyFileSync(inside.manifestPath, insideManifest);
  assert.throws(() => runBridge(inside, { expectedManifestPath: insideManifest }), /bridge_manifest_inside_unpacked_root_reject/u);
  assertNoDerivedOutputs(inside);
});

test('retains partial outputs after pin write failure and refuses reuse', { concurrency: false }, t => {
  const fixture = createFixture(t);
  const pinPath = fixture.pinIncludePath;
  const originalOpenSync = fs.openSync;
  const originalWriteSync = fs.writeSync;
  let pinFd;
  let injected = false;
  withPatchedFs({
    openSync(filePath, ...args) {
      const fd = originalOpenSync.call(fs, filePath, ...args);
      if (path.resolve(String(filePath)) === path.resolve(pinPath) && args[0] === 'wx') pinFd = fd;
      return fd;
    },
    writeSync(fd, buffer, offset, length, position) {
      if (fd === pinFd && !injected) {
        injected = true;
        const count = Math.min(7, length ?? buffer.length);
        originalWriteSync.call(fs, fd, buffer, offset ?? 0, count, position ?? null);
        throw new Error('injected pin partial write');
      }
      return originalWriteSync.call(fs, fd, buffer, offset, length, position);
    },
  }, () => assert.throws(() => runBridge(fixture), /bridge_output_write_failed/u));

  assert.equal(injected, true);
  const [inventoryPath, templatePath] = derivedOutputs(fixture);
  assert.equal(fs.existsSync(inventoryPath), true, 'inventory was removed after a later failure');
  assert.equal(fs.existsSync(templatePath), true, 'template was removed after a later failure');
  assert.equal(fs.existsSync(pinPath), true, 'partial pin include was removed after a write failure');
  const partialPin = fs.readFileSync(pinPath);
  assert.ok(partialPin.length > 0 && partialPin.length < 64, 'pin include was not retained as a partial output');
  const retainedHashes = [inventoryPath, templatePath, pinPath].map(filePath => sha256(fs.readFileSync(filePath)));
  assert.throws(() => runBridge(fixture), /bridge_output_already_exists/u);
  assert.deepEqual([inventoryPath, templatePath, pinPath].map(filePath => sha256(fs.readFileSync(filePath))), retainedHashes,
    'a refused retry changed one of the retained partial outputs');
});


test('rejects caller-pinned SQLite sidecars before any derived output', t => {
  for (const filename of ['state.db-journal', 'state.sqlite-journal', 'STATE.SQLITE3-JOURNAL', 'usage.bin-journal', 'state-journal', 'capture-wal', 'usage-shm']) {
    const relativePath = `resources/app/cache/${filename}`;
    const fixture = createFixture(t, { extraFiles: [relativePath] });
    const fullPath = path.join(fixture.root, ...relativePath.split('/'));
    const before = fs.readFileSync(fullPath);
    // Journal contents need not start with the main database's SQLite format magic.
    assert.equal(before.subarray(0, 16).toString('binary') === 'SQLite format 3\0', false);
    assert.throws(() => runBridge(fixture), /bridge_manifest_sensitive_path_reject/u);
    assertNoDerivedOutputs(fixture);
    assert.equal(fs.readFileSync(fullPath).equals(before), true);
  }
});
