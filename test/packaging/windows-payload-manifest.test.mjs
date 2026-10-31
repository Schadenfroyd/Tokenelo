import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  serializeTrustedWindowsPayloadInventory,
  windowsPayloadManifestContract,
  writeNsisPayloadManifestTemplate,
} from '../../scripts/windows/write-nsis-payload-manifest.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const writerPath = path.join(repositoryRoot, 'scripts/windows/write-nsis-payload-manifest.mjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ordinalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const baseFiles = [
  'Tokenelo.exe',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'locales/en-US.pak',
  'resources.pak',
  'resources/app/dist/daemon/main.js',
  'resources/app/dist/tray/main.js',
  'resources/app/package.json',
  'resources/app/rates/prices.json',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
].sort(ordinalCompare);

function fixtureBytes(relativePath) {
  if (relativePath === 'resources/app/package.json') {
    return Buffer.from(JSON.stringify({
      name: 'tokenelo', private: true, type: 'module', main: 'dist/tray/main.js', version: '0.1.0',
    }) + '\n', 'utf8');
  }
  return Buffer.from(`synthetic win-unpacked fixture: ${relativePath}\n`, 'utf8');
}

function createFixture(t, files = baseFiles, inventoryFiles = files) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-nsis-manifest-test-'));
  const root = path.join(parent, 'win-unpacked');
  fs.mkdirSync(root);
  for (const relativePath of files) {
    const fullPath = path.join(root, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, fixtureBytes(relativePath));
  }
  t.after(() => {
    const resolvedParent = path.resolve(parent);
    const resolvedTemp = path.resolve(os.tmpdir());
    const boundary = resolvedTemp.endsWith(path.sep) ? resolvedTemp : `${resolvedTemp}${path.sep}`;
    if (!resolvedParent.startsWith(boundary)) throw new Error('Refusing to remove fixture outside os.tmpdir');
    fs.rmSync(resolvedParent, { recursive: true, force: true });
  });
  const inventoryBytes = serializeTrustedWindowsPayloadInventory(inventoryFiles);
  return { parent, root, inventoryBytes, inventorySha256: sha256(inventoryBytes) };
}

function writeTemplate(fixture, overrides = {}) {
  return writeNsisPayloadManifestTemplate({
    winUnpackedRoot: fixture.root,
    trustedInventoryBytes: fixture.inventoryBytes,
    trustedInventorySha256: fixture.inventorySha256,
    ...overrides,
  });
}

function readTemplate(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ...windowsPayloadManifestContract.templateRelativePath.split('/')), 'utf8'));
}

function withPatchedFs(patches, callback) {
  const originals = new Map(Object.keys(patches).map(name => [name, fs[name]]));
  try {
    for (const [name, replacement] of Object.entries(patches)) fs[name] = replacement;
    return callback();
  } finally {
    for (const [name, original] of originals) fs[name] = original;
  }
}

function assertFailedOutputIsImmutable(fixture, outputPath, payloadBefore, neighborPath, neighborBytes, outputCheck) {
  assert.equal(fs.existsSync(outputPath), true);
  const retainedOutput = fs.readFileSync(outputPath);
  outputCheck(retainedOutput);
  for (const [relativePath, digest] of payloadBefore) {
    assert.equal(sha256(fs.readFileSync(path.join(fixture.root, ...relativePath.split('/')))), digest, relativePath);
  }
  assert.equal(fs.readFileSync(neighborPath).equals(neighborBytes), true);
  assert.throws(() => writeTemplate(fixture), /manifest_reserved_runtime_path_already_exists/);
  assert.equal(fs.readFileSync(outputPath).equals(retainedOutput), true);
  for (const [relativePath, digest] of payloadBefore) {
    assert.equal(sha256(fs.readFileSync(path.join(fixture.root, ...relativePath.split('/')))), digest, relativePath);
  }
  assert.equal(fs.readFileSync(neighborPath).equals(neighborBytes), true);
}

function failureFixture(t) {
  const fixture = createFixture(t);
  const outputPath = path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'));
  const payloadBefore = JSON.parse(fixture.inventoryBytes.toString('utf8')).files.map(relativePath => [
    relativePath, sha256(fs.readFileSync(path.join(fixture.root, ...relativePath.split('/')))),
  ]);
  const neighborPath = path.join(fixture.parent, 'neighbor-sentinel.txt');
  const neighborBytes = Buffer.from('preserve unrelated task-owned neighbor bytes\n', 'utf8');
  fs.writeFileSync(neighborPath, neighborBytes);
  return { fixture, outputPath, payloadBefore, neighborPath, neighborBytes };
}

test('writes a distinct template over the complete expected Electron runtime tree', t => {
  const fixture = createFixture(t);
  const result = writeTemplate(fixture);
  const template = readTemplate(fixture.root);

  assert.equal(result.fullInstallRoot, false);
  assert.equal(template.schemaVersion, 1);
  assert.equal(template.kind, 'tokenelo-windows-nsis-payload-template');
  assert.equal(template.manifestScope, 'unpacked-install-template');
  assert.equal(template.packageIdentity, 'com.elostudios.tokenelo');
  assert.equal(template.fullInstallRoot, false);
  assert.equal(template.fullRootReady, false);
  assert.equal(template.restoreInputAllowed, false);
  assert.equal(template.trustedExpectedFileSetSha256, fixture.inventorySha256);
  assert.match(template.expectedFileSetProvenance, /caller-supplied/);
  assert.deepEqual(template.files.map(file => file.relativePath), baseFiles);
  assert.ok(template.files.some(file => file.relativePath === 'd3dcompiler_47.dll'));
  assert.ok(template.files.some(file => file.relativePath === 'resources/app/rates/prices.json'));
  assert.ok(template.files.every(file => Object.keys(file).sort().join(',') === 'relativePath,sha256,sizeBytes'));
  assert.equal(template.files.some(file => file.relativePath === windowsPayloadManifestContract.templateRelativePath), false);
  assert.equal(template.files.some(file => file.relativePath === 'Uninstall Tokenelo.exe'), false);
  assert.deepEqual(template.runtimeBindingContract, {
    templateSelfIncluded: false,
    generatedUninstallerIncluded: false,
    compiledNsisMustPinTemplateSha256: true,
    runtimeAssemblerMustAddTemplateAndVerifiedUninstaller: true,
    runtimeAssemblerMustVerifyEveryFileSizeAndSha256: true,
    windowsFileAttributesOwnerAndAcl: 'runtime-bound-after-content-match',
    windowsReparsePoints: 'must-be-rejected-by-windows-runtime-assembler',
    ntfsAlternateStreams: 'must-be-rejected-by-windows-runtime-assembler',
    pathBasedChecksDoNotProveHostileConcurrentWriterSafety: true,
    signedPackageOrPackageAuthenticityAttested: false,
  });
  const bytes = fs.readFileSync(result.templatePath);
  assert.equal(result.templateSha256, sha256(bytes));
  assert.equal(fs.readFileSync(result.templatePath, 'utf8').endsWith('\n'), true);
});

test('requires a separately supplied pinned expected file set and rejects missing or extra runtime files', t => {
  const fixture = createFixture(t);
  const extra = path.join(fixture.root, 'unexpected-runtime.dll');
  fs.writeFileSync(extra, 'not in trusted builder inventory\n');
  assert.throws(() => writeTemplate(fixture), /manifest_tree_file_set_mismatch/);
  assert.equal(fs.existsSync(path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);

  const missingFixture = createFixture(t);
  fs.rmSync(path.join(missingFixture.root, 'd3dcompiler_47.dll'));
  assert.throws(() => writeTemplate(missingFixture), /manifest_tree_file_set_mismatch/);
  assert.equal(fs.existsSync(path.join(missingFixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
});

test('uses the shared four-file core sentinels and keeps each declared legacy ANGLE file mandatory', t => {
  const targetFixture = createFixture(t);
  const targetResult = writeTemplate(targetFixture);
  const targetTemplate = readTemplate(targetFixture.root);
  assert.deepEqual(windowsPayloadManifestContract.requiredFiles.filter(file => !file.startsWith('resources/app/')),
    ['Tokenelo.exe', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak']);
  assert.equal(targetTemplate.files.some(file => file.relativePath === 'libEGL.dll'), false);
  assert.equal(targetTemplate.files.some(file => file.relativePath === 'libGLESv2.dll'), false);
  assert.equal(targetResult.fileCount, baseFiles.length);

  for (const anglePath of ['libEGL.dll', 'libGLESv2.dll']) {
    const declaredFiles = [...baseFiles, anglePath].sort(ordinalCompare);
    const declaredFixture = createFixture(t, declaredFiles, declaredFiles);
    const result = writeTemplate(declaredFixture);
    const template = readTemplate(declaredFixture.root);
    const entry = template.files.find(file => file.relativePath === anglePath);
    assert.ok(entry, `${anglePath} was omitted despite being caller-declared`);
    assert.equal(entry.sizeBytes, fixtureBytes(anglePath).length);
    assert.equal(entry.sha256, sha256(fixtureBytes(anglePath)));
    assert.equal(result.fileCount, declaredFiles.length);

    const missingFixture = createFixture(t, baseFiles, declaredFiles);
    assert.throws(() => writeTemplate(missingFixture), /manifest_tree_file_set_mismatch/u);
    assert.equal(fs.existsSync(path.join(missingFixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
  }
});

test('rejects a missing shared core sentinel before publishing an inventory', t => {
  for (const core of ['icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak']) {
    const remaining = baseFiles.filter(file => file !== core);
    const fixture = createFixture(t, remaining, remaining);
    assert.throws(() => writeTemplate(fixture), /manifest_required_runtime_file_missing/u, core);
    assert.equal(fs.existsSync(path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
  }
});

test('rejects a mismatched inventory digest before writing any template', t => {
  const fixture = createFixture(t);
  assert.throws(() => writeTemplate(fixture, { trustedInventorySha256: '0'.repeat(64) }), /manifest_inventory_hash_mismatch/);
  assert.equal(fs.existsSync(path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
});

test('rejects case-colliding expected paths and Windows-invalid or ADS-like path syntax', () => {
  assert.throws(() => serializeTrustedWindowsPayloadInventory([...baseFiles, 'Resources.pak']), /manifest_inventory_case_collision/);
  assert.throws(() => serializeTrustedWindowsPayloadInventory([...baseFiles, 'resources/app/data:stream']), /manifest_path_reject/);
  assert.throws(() => serializeTrustedWindowsPayloadInventory([...baseFiles, 'resources/app/CON.txt']), /manifest_path_reject/);
});

test('rejects known sensitive paths and SQLite database content before publishing', t => {
  const sensitive = createFixture(t, [...baseFiles, 'resources/app/data/session.json'].sort(ordinalCompare), baseFiles);
  assert.throws(() => writeTemplate(sensitive), /manifest_sensitive_path_reject/);
  assert.equal(fs.existsSync(path.join(sensitive.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);

  const sqliteFiles = [...baseFiles, 'resources/app/state.bin'].sort(ordinalCompare);
  const sqlite = createFixture(t, sqliteFiles, sqliteFiles);
  fs.writeFileSync(path.join(sqlite.root, 'resources/app/state.bin'), Buffer.from('SQLite format 3\0synthetic fixture'));
  sqlite.inventoryBytes = serializeTrustedWindowsPayloadInventory(sqliteFiles);
  sqlite.inventorySha256 = sha256(sqlite.inventoryBytes);
  assert.throws(() => writeTemplate(sqlite), /manifest_database_header_reject/);
  assert.equal(fs.existsSync(path.join(sqlite.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
});

test('rejects hardlinked physical aliases and symlink/junction entries', t => {
  const hardlinkFixture = createFixture(t);
  const source = path.join(hardlinkFixture.root, 'resources/app/dist/tray/main.js');
  const alias = path.join(hardlinkFixture.root, 'resources/app/dist/tray/alias.js');
  fs.linkSync(source, alias);
  hardlinkFixture.inventoryBytes = serializeTrustedWindowsPayloadInventory([...baseFiles, 'resources/app/dist/tray/alias.js'].sort(ordinalCompare));
  hardlinkFixture.inventorySha256 = sha256(hardlinkFixture.inventoryBytes);
  assert.throws(() => writeTemplate(hardlinkFixture), /manifest_physical_alias_reject/);
  assert.equal(fs.existsSync(path.join(hardlinkFixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);

  const symlinkFixture = createFixture(t);
  const outside = path.join(symlinkFixture.parent, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'foreign.dll'), 'outside fixture\n');
  const junction = path.join(symlinkFixture.root, 'resources/app/foreign-runtime');
  try {
    fs.symlinkSync(outside, junction, 'junction');
  } catch (error) {
    t.skip(`Task-owned junction fixture unavailable: ${error.code ?? error.message}`);
    return;
  }
  t.after(() => {
    try { fs.rmdirSync(junction); } catch { /* The test only removes its own junction. */ }
  });
  assert.throws(() => writeTemplate(symlinkFixture), /manifest_physical_alias_reject/);
  assert.equal(fs.existsSync(path.join(symlinkFixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
});

test('rejects a physical alias for the win-unpacked root itself', t => {
  const fixture = createFixture(t);
  const alias = path.join(fixture.parent, 'win-unpacked-alias');
  try {
    fs.symlinkSync(fixture.root, alias, 'junction');
  } catch (error) {
    t.skip(`Task-owned root junction fixture unavailable: ${error.code ?? error.message}`);
    return;
  }
  t.after(() => {
    try { fs.rmdirSync(alias); } catch { /* The test only removes its own junction. */ }
  });
  assert.throws(() => writeNsisPayloadManifestTemplate({
    winUnpackedRoot: alias,
    trustedInventoryBytes: fixture.inventoryBytes,
    trustedInventorySha256: fixture.inventorySha256,
  }), /manifest_root_(?:type|physical_alias)_reject/);
  assert.equal(fs.existsSync(path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
});

test('refuses preexisting template and generated uninstaller without changing them', t => {
  const templateFixture = createFixture(t);
  const templatePath = path.join(templateFixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'));
  fs.writeFileSync(templatePath, 'existing template sentinel\n');
  assert.throws(() => writeTemplate(templateFixture), /manifest_reserved_runtime_path_already_exists/);
  assert.equal(fs.readFileSync(templatePath, 'utf8'), 'existing template sentinel\n');

  const uninstallFixture = createFixture(t);
  const uninstallerPath = path.join(uninstallFixture.root, 'Uninstall Tokenelo.exe');
  fs.writeFileSync(uninstallerPath, 'separate runtime-bound uninstaller sentinel\n');
  assert.throws(() => writeTemplate(uninstallFixture), /manifest_reserved_runtime_path_already_exists/);
  assert.equal(fs.readFileSync(uninstallerPath, 'utf8'), 'separate runtime-bound uninstaller sentinel\n');
});

test('refuses package identity drift and non-regular tree entries', t => {
  const identityFixture = createFixture(t);
  fs.writeFileSync(path.join(identityFixture.root, 'resources/app/package.json'), JSON.stringify({ name: 'other', private: true, type: 'module', main: 'dist/tray/main.js' }) + '\n');
  assert.throws(() => writeTemplate(identityFixture), /manifest_app_package_identity_reject/);

  const typeFixture = createFixture(t);
  const directoryInFileSlot = path.join(typeFixture.root, 'resources/app/rates/prices.json');
  fs.rmSync(directoryInFileSlot);
  fs.mkdirSync(directoryInFileSlot);
  assert.throws(() => writeTemplate(typeFixture), /manifest_tree_file_set_mismatch/);
});

test('CLI requires an external inventory file and writes only a synthetic template', t => {
  const fixture = createFixture(t);
  const inventoryPath = path.join(fixture.parent, 'trusted-expected-files.private.json');
  fs.writeFileSync(inventoryPath, fixture.inventoryBytes);
  const output = execFileSync(process.execPath, [
    writerPath,
    '--win-unpacked-root', fixture.root,
    '--trusted-inventory', inventoryPath,
    '--trusted-inventory-sha256', fixture.inventorySha256,
  ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(output);
  assert.equal(result.fullInstallRoot, false);
  assert.equal(result.fileCount, baseFiles.length);
  assert.equal(result.expectedFileSetSha256, fixture.inventorySha256);
  assert.equal(fs.existsSync(path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), true);
});

test('output write failure is immutable and requires a fresh manual build root', t => {
  const { fixture, outputPath, payloadBefore, neighborPath, neighborBytes } = failureFixture(t);
  const originalOpenSync = fs.openSync;
  const originalWriteFileSync = fs.writeFileSync;
  let outputFd;
  withPatchedFs({
    openSync(filePath, flags, mode) {
      const fd = originalOpenSync.call(fs, filePath, flags, mode);
      if (path.resolve(String(filePath)) === path.resolve(outputPath) && flags === 'wx') outputFd = fd;
      return fd;
    },
    writeFileSync(fileOrFd, data, ...args) {
      if (fileOrFd === outputFd) {
        originalWriteFileSync.call(fs, fileOrFd, Buffer.from('partial template sentinel\n'), ...args);
        throw new Error('injected output write failure');
      }
      return originalWriteFileSync.call(fs, fileOrFd, data, ...args);
    },
  }, () => assert.throws(() => writeTemplate(fixture), /manifest_template_write_failed/));
  assertFailedOutputIsImmutable(fixture, outputPath, payloadBefore, neighborPath, neighborBytes, bytes => {
    assert.equal(bytes.toString('utf8'), 'partial template sentinel\n');
  });
});

test('output fsync failure leaves complete bytes immutable and requires a fresh manual build root', t => {
  const { fixture, outputPath, payloadBefore, neighborPath, neighborBytes } = failureFixture(t);
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  let outputFd;
  withPatchedFs({
    openSync(filePath, flags, mode) {
      const fd = originalOpenSync.call(fs, filePath, flags, mode);
      if (path.resolve(String(filePath)) === path.resolve(outputPath) && flags === 'wx') outputFd = fd;
      return fd;
    },
    fsyncSync(fd) {
      if (fd === outputFd) throw new Error('injected output fsync failure');
      return originalFsyncSync.call(fs, fd);
    },
  }, () => assert.throws(() => writeTemplate(fixture), /manifest_template_write_failed/));
  assertFailedOutputIsImmutable(fixture, outputPath, payloadBefore, neighborPath, neighborBytes, bytes => {
    const parsed = JSON.parse(bytes.toString('utf8'));
    assert.equal(parsed.kind, 'tokenelo-windows-nsis-payload-template');
  });
});

test('output readback failure leaves complete bytes immutable and requires a fresh manual build root', t => {
  const { fixture, outputPath, payloadBefore, neighborPath, neighborBytes } = failureFixture(t);
  const originalOpenSync = fs.openSync;
  const originalReadSync = fs.readSync;
  let outputCreated = false, outputReadFd;
  withPatchedFs({
    openSync(filePath, flags, mode) {
      const fd = originalOpenSync.call(fs, filePath, flags, mode);
      if (path.resolve(String(filePath)) === path.resolve(outputPath)) {
        if (flags === 'wx') outputCreated = true;
        else if (flags === 'r' && outputCreated) outputReadFd = fd;
      }
      return fd;
    },
    readSync(fd, ...args) {
      if (fd === outputReadFd) throw new Error('injected output readback failure');
      return originalReadSync.call(fs, fd, ...args);
    },
  }, () => assert.throws(() => writeTemplate(fixture), /manifest_template_readback_failed/));
  assertFailedOutputIsImmutable(fixture, outputPath, payloadBefore, neighborPath, neighborBytes, bytes => {
    const parsed = JSON.parse(bytes.toString('utf8'));
    assert.equal(parsed.kind, 'tokenelo-windows-nsis-payload-template');
  });
});


test('rejects SQLite sidecar paths in both caller inventory and observed tree', t => {
  for (const filename of ['state.db-journal', 'state.sqlite-journal', 'STATE.SQLITE3-JOURNAL', 'usage.bin-journal', 'state-journal', 'capture-wal', 'usage-shm']) {
    const relativePath = `resources/app/cache/${filename}`;
    assert.throws(() => serializeTrustedWindowsPayloadInventory([...baseFiles, relativePath].sort(ordinalCompare)),
      /manifest_sensitive_path_reject/u);
    const fixture = createFixture(t, [...baseFiles, relativePath].sort(ordinalCompare), baseFiles);
    const fullPath = path.join(fixture.root, ...relativePath.split('/'));
    const before = fs.readFileSync(fullPath);
    assert.throws(() => writeTemplate(fixture), /manifest_sensitive_path_reject/u);
    assert.equal(fs.existsSync(path.join(fixture.root, ...windowsPayloadManifestContract.templateRelativePath.split('/'))), false);
    assert.equal(fs.readFileSync(fullPath).equals(before), true);
  }
});
