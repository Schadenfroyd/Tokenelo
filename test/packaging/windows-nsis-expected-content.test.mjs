import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assembleNsisExpectedContent, nsisExpectedContentSupplierContract } from '../../scripts/windows/assemble-nsis-expected-content.mjs';
import { buildWindowsNsisPayloadBridge, windowsNsisPayloadBridgeContract } from '../../scripts/windows/build-nsis-payload-bridge.mjs';
import { windowsPayloadManifestContract } from '../../scripts/windows/write-nsis-payload-manifest.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const scratchRoot = os.tmpdir();

const sourceBinding = {
  npmSourceReceiptSha256: '1'.repeat(64),
  npmTarballSha512SRI: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
  npmChecksumMapExpectedWin32X64ZipSha256: '',
  requestReceiptSha256: '2'.repeat(64),
  outerReceiptSha256: '3'.repeat(64),
  downloadRouteSha256: '4'.repeat(64),
  downloadUrl: 'https://github.com/electron/electron/releases/download/v44.9.3/electron-v44.9.3-win32-x64.zip',
};
const toolPins = {
  nodeVersion: 'v24.19.0', appBuilderLibVersion: '26.18.0', builderUtilVersion: '26.16.0',
  reseditVersion: '1.7.2', peLibraryVersion: '0.4.1', resEditSourceSha256: '5'.repeat(64),
  appInfoSourceSha256: '6'.repeat(64), winPackagerSourceSha256: '7'.repeat(64), packageLockSha256: '8'.repeat(64),
};
const EXE_BYTES = Buffer.from('synthetic edited executable bytes\n');
const ICON_SHA = '9'.repeat(64);

function createFixture(t, { vendorPathMutation, stageMutation, outputInsideStage = false, reportedPathStyle = 'windows' } = {}) {
  const parent = fs.mkdtempSync(path.join(scratchRoot, 'expected-content-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const inputs = path.join(parent, 'inputs');
  const stageContainer = path.join(inputs, 'stage');
  const stageRoot = path.join(stageContainer, 'app');
  const vendorDir = path.join(inputs, 'vendor');
  const receiptDir = path.join(inputs, 'edit');
  const outputDir = path.join(parent, 'output');
  for (const dir of [stageRoot, vendorDir, receiptDir, outputDir]) fs.mkdirSync(dir, { recursive: true });

  const appFiles = new Map([
    ['package.json', jsonBytes({ name: 'tokenelo', version: '0.1.0', private: true, type: 'module', main: 'dist/tray/main.js' })],
    ['dist/tray/main.js', Buffer.from('export const fixture = true;\n')],
  ]);
  for (const [relative, bytes] of appFiles) {
    const file = path.join(stageRoot, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  if (stageMutation === 'extra') fs.writeFileSync(path.join(stageRoot, 'extra.txt'), 'unlisted\n', { flag: 'wx' });
  if (stageMutation === 'drift') fs.writeFileSync(path.join(stageRoot, 'dist/tray/main.js'), 'changed\n');
  if (stageMutation === 'missing') fs.rmSync(path.join(stageRoot, 'dist/tray/main.js'));

  const payload = {
    schemaVersion: 1, root: 'app',
    files: [...appFiles.entries()].map(([filePath, bytes]) => ({ path: filePath, sizeBytes: bytes.length, sha256: sha256(bytes) })).sort((a, b) => ordinal(a.path, b.path)),
  };
  const payloadBytes = jsonBytes(payload);
  const payloadPath = path.join(stageContainer, 'payload-manifest.private.json');
  fs.writeFileSync(payloadPath, payloadBytes, { flag: 'wx' });
  const revision = 'a'.repeat(40);
  const stage = {
    schemaVersion: 1, kind: 'tokenelo-private-electron-stage', privacy: 'private',
    releasePolicy: { publish: 'never', publicAutoUpdates: false },
    source: { revision, dirty: false, distManifestSha256: 'b'.repeat(64), verificationScope: 'synthetic fixture' },
    application: { name: 'tokenelo', version: '0.1.0', private: true, type: 'module', main: 'dist/tray/main.js', electronVersion: '44.9.3', electronBuilderVersion: '26.18.0' },
    payload: { fileCount: payload.files.length, manifest: 'payload-manifest.private.json', manifestSha256: sha256(payloadBytes),
      sha256: sha256(Buffer.from(JSON.stringify({ schemaVersion: 1, files: payload.files }), 'utf8')) },
  };
  const stageBytes = jsonBytes(stage);
  const stagePath = path.join(stageContainer, 'stage-manifest.private.json');
  fs.writeFileSync(stagePath, stageBytes, { flag: 'wx' });

  const vendorContent = new Map([
    ['electron.exe', Buffer.from('synthetic pristine exe bytes\n')],
    ['LICENSE', Buffer.from('vendor license\n')],
    ['LICENSES.chromium.html', Buffer.from('chromium licenses\n')],
    ['version', Buffer.from('44.9.3\n')],
    ['resources/default_app.asar', Buffer.from('default app fixture\n')],
    ['icudtl.dat', Buffer.from('icu\n')],
    ['resources.pak', Buffer.from('resources\n')],
    ['libEGL.dll', Buffer.from('egl\n')],
    ['libGLESv2.dll', Buffer.from('gles\n')],
    ['v8_context_snapshot.bin', Buffer.from('snapshot\n')],
    ['locales/en-US.pak', Buffer.from('locale us\n')],
    ['locales/fr.pak', Buffer.from('locale fr\n')],
  ]);
  let vendorRows = [...vendorContent.entries()].map(([filePath, bytes]) => ({ path: filePath, sizeBytes: bytes.length, sha256: sha256(bytes) }));
  if (vendorPathMutation) vendorRows = vendorPathMutation(vendorRows);
  vendorRows.sort((a, b) => a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : ordinal(a.path, b.path));
  const archiveSha256 = sha256(Buffer.from('synthetic pinned archive identity\n'));
  const binding = { ...sourceBinding, npmChecksumMapExpectedWin32X64ZipSha256: archiveSha256 };
  const vendorDoc = {
    schemaVersion: 1, sourceBinding: binding, inventoryScriptSha256: 'd'.repeat(64),
    archiveSha256, archiveBytes: 128, files: vendorRows,
  };
  const vendorBytes = jsonBytes(vendorDoc);
  const vendorPath = path.join(vendorDir, 'member-manifest.private.json');
  fs.writeFileSync(vendorPath, vendorBytes, { flag: 'wx' });

  const outputPath = path.join(outputDir, 'expected-content.private.json');
  if (outputInsideStage) fs.mkdirSync(path.join(stageRoot, 'output'), { recursive: true });
  const exePath = path.join(receiptDir, 'Tokenelo.exe');
  fs.writeFileSync(exePath, EXE_BYTES, { flag: 'wx' });
  const options = { productVersion: '0.1.0.0', fileVersion: '0.1.0', iconSha256: ICON_SHA };
  const reported = reportedPathStyle === 'windows'
    ? { nodePath: 'C:\\Synthetic\\node.exe', archivePath: 'C:\\Synthetic\\electron-v44.9.3-win32-x64.zip',
      pristinePath: 'C:\\Synthetic\\pristine-electron.exe', outputPath: 'C:\\Synthetic\\edited\\Tokenelo.exe',
      iconPath: 'C:\\Synthetic\\tokenelo-windows.ico' }
    : { nodePath: '/synthetic/tools/node', archivePath: '/synthetic/vendor/electron-v44.9.3-win32-x64.zip',
      pristinePath: '/synthetic/temp/pristine-electron.exe', outputPath: '/synthetic/edited/Tokenelo.exe',
      iconPath: '/synthetic/assets/tokenelo-windows.ico' };
  const resourceReceipt = {
    schema: 'tokenelo.windows-electron-resource-edit-result.v1', status: 'success', recordedAtUtc: '2026-10-22T00:00:00Z',
    mode: 'pristine-vendor-copy-only', tool: { nodePath: reported.nodePath, ...toolPins },
    input: { archivePath: reported.archivePath, archiveSha256, memberPath: 'electron.exe',
      pristinePath: reported.pristinePath, sha256: sha256(vendorContent.get('electron.exe')),
      sizeBytes: vendorContent.get('electron.exe').length, peMachine: '0x8664' },
    appInfoStressCase: { version: '0.1.0', buildNumber: '0', buildVersion: '0.1.0', productVersion: '0.1.0.0',
      productName: 'Tokenelo', productFilename: 'Tokenelo', companyName: 'Elo AI', copyright: 'Copyright © 2026 Elo AI', appId: 'com.elostudios.tokenelo' },
    options: { file: reported.outputPath, productVersion: options.productVersion, fileVersion: options.fileVersion, requestedExecutionLevel: 'asInvoker', iconPath: reported.iconPath, iconSha256: ICON_SHA,
      versionStrings: { FileDescription: 'Tokenelo', ProductName: 'Tokenelo', InternalName: 'Tokenelo', CompanyName: 'Elo AI',
        LegalCopyright: 'Copyright © 2026 Elo AI', OriginalFilename: '' } },
    output: { path: reported.outputPath, sizeBytes: EXE_BYTES.length, sha256: sha256(EXE_BYTES) },
    editorElapsedMs: 1, codeSigningInvoked: false, childProcessAttempts: [], inputUnchanged: true,
    supervisorReadbackSha256: sha256(EXE_BYTES), supervisorReadbackSizeBytes: EXE_BYTES.length,
  };
  const resourceBytes = jsonBytes(resourceReceipt);
  const resourcePath = path.join(receiptDir, 'resource-edit-result.private.json');
  fs.writeFileSync(resourcePath, resourceBytes, { flag: 'wx' });

  const vendorTotal = vendorRows.reduce((sum, row) => sum + row.sizeBytes, 0);
  const expectedContext = {
    sourceRevision: revision, applicationVersion: '0.1.0', electronVersion: '44.9.3', electronBuilderVersion: '26.18.0',
    stageManifestSha256: sha256(stageBytes), stagedPayloadManifestSha256: sha256(payloadBytes), vendorArchiveSha256: archiveSha256,
  };
  const expectedVendor = {
    archiveSha256, archiveBytes: 128, memberManifestSha256: sha256(vendorBytes), inventoryScriptSha256: 'd'.repeat(64),
    fileCount: vendorRows.length, totalUncompressedBytes: vendorTotal, sourceBinding: binding,
  };
  const expectedResourceEdit = {
    receiptSha256: sha256(resourceBytes), outputSha256: sha256(EXE_BYTES), outputSizeBytes: EXE_BYTES.length,
    iconSha256: ICON_SHA, toolPins, options,
  };
  const input = {
    stageRoot, stageManifestPath: stagePath, payloadManifestPath: payloadPath, vendorMemberManifestPath: vendorPath,
    resourceEditReceiptPath: resourcePath, editedExecutablePath: exePath,
    outputPath: outputInsideStage ? path.join(stageRoot, 'output', 'forbidden.json') : outputPath,
    expectedContext, expectedVendor, expectedResourceEdit,
    transformMapVersion: nsisExpectedContentSupplierContract.transformMapVersion,
  };
  return { parent, stageRoot, stagePath, payloadPath, vendorPath, resourcePath, exePath, outputPath: input.outputPath, input,
    appFiles, vendorContent, vendorRows, editedExe: EXE_BYTES, context: expectedContext };
}

function makeUnpackedFromExpected(t, fixture, manifest, { consumerName = 'consumer', omitPaths = [] } = {}) {
  const consumerRoot = path.join(fixture.parent, consumerName);
  const root = path.join(consumerRoot, 'win-unpacked');
  const pins = path.join(consumerRoot, 'pins');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(pins, { recursive: true });
  for (const record of manifest.files) {
    if (omitPaths.includes(record.relativePath)) continue;
    const full = path.join(root, ...record.relativePath.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    let bytes;
    if (record.provenance.sourceClass === 'app-stage') bytes = fixture.appFiles.get(record.provenance.sourceRelativePath);
    else if (record.relativePath === 'Tokenelo.exe') bytes = fixture.editedExe;
    else bytes = fixture.vendorContent.get(record.provenance.sourceRelativePath);
    assert.ok(bytes, `fixture bytes missing for ${record.relativePath}`);
    fs.writeFileSync(full, bytes, { flag: 'wx' });
  }
  const manifestPath = path.join(consumerRoot, 'expected-content.private.json');
  fs.writeFileSync(manifestPath, fs.readFileSync(fixture.outputPath), { flag: 'wx' });
  const pinIncludePath = path.join(pins, 'tokenelo-payload-pin.nsh');
  return { root, manifestPath, pinIncludePath };
}

function runBridgeConsumer(fixture, result, unpacked) {
  return buildWindowsNsisPayloadBridge({
    winUnpackedRoot: unpacked.root,
    expectedManifestPath: unpacked.manifestPath,
    expectedManifestSha256: result.outputSha256,
    expectedContext: {
      platform: 'win32', architecture: 'x64', outputDirectoryName: 'win-unpacked',
      packageIdentity: 'com.elostudios.tokenelo', applicationPackageName: 'tokenelo',
      applicationVersion: fixture.context.applicationVersion, electronVersion: fixture.context.electronVersion,
      electronBuilderVersion: fixture.context.electronBuilderVersion, sourceRevision: fixture.context.sourceRevision,
      stageManifestSha256: fixture.context.stageManifestSha256,
      stagedPayloadManifestSha256: fixture.context.stagedPayloadManifestSha256,
      vendorArchiveSha256: fixture.context.vendorArchiveSha256,
    },
    pinIncludePath: unpacked.pinIncludePath,
  });
}

test('joins only pinned stage/vendor/edit inputs and feeds the real bridge consumer', t => {
  const fixture = createFixture(t);
  const result = assembleNsisExpectedContent(fixture.input);
  const bytes = fs.readFileSync(fixture.outputPath);
  assert.equal(result.status, 'expected_content_complete');
  assert.equal(result.outputSha256, sha256(bytes));
  const manifest = JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.toString('utf8').endsWith('\n'), true);
  assert.equal(manifest.kind, 'tokenelo-windows-expected-content-manifest');
  const byPath = new Map(manifest.files.map(row => [row.relativePath, row]));
  assert.equal(byPath.get('Tokenelo.exe').provenance.sourceClass, 'verified-transform');
  assert.equal(byPath.get('Tokenelo.exe').provenance.sourceRelativePath, 'electron.exe');
  assert.equal(byPath.get('LICENSE.electron.txt').provenance.transformId, 'electron-license-rename-v1');
  assert.equal(byPath.has('LICENSE'), false);
  for (const retained of ['version', 'resources/default_app.asar', 'locales/en-US.pak', 'locales/fr.pak']) assert.equal(byPath.has(retained), true);
  assert.equal(manifest.files.some(row => row.relativePath.includes('win-unpacked')), false);

  const unpacked = makeUnpackedFromExpected(t, fixture, manifest);
  const bridgeResult = runBridgeConsumer(fixture, result, unpacked);
  assert.equal(bridgeResult.sourceManifestSha256, result.outputSha256);
  assert.equal(bridgeResult.sourceFileCount, manifest.files.length);
  assert.equal(bridgeResult.fullRootReady, false);
  assert.equal(bridgeResult.restoreInputAllowed, false);
});

test('accepts the target inventory without legacy ANGLE DLLs while requiring the shared four core sentinels', t => {
  const anglePaths = new Set(['libEGL.dll', 'libGLESv2.dll']);
  const fixture = createFixture(t, { vendorPathMutation: rows => rows.filter(row => !anglePaths.has(row.path)) });
  const result = assembleNsisExpectedContent(fixture.input);
  const manifest = JSON.parse(fs.readFileSync(fixture.outputPath, 'utf8'));
  const byPath = new Map(manifest.files.map(row => [row.relativePath, row]));
  for (const anglePath of anglePaths) assert.equal(byPath.has(anglePath), false);
  for (const core of ['icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak']) {
    assert.equal(byPath.has(core), true, `core sentinel missing from expected content: ${core}`);
  }
  assert.equal(manifest.files.filter(row => row.provenance.sourceClass !== 'app-stage').length, fixture.vendorRows.length,
    'the producer omitted a row from the complete pinned vendor inventory');
  const unpacked = makeUnpackedFromExpected(t, fixture, manifest);
  const bridgeResult = runBridgeConsumer(fixture, result, unpacked);
  assert.equal(bridgeResult.sourceFileCount, manifest.files.length);

  for (const missingCore of ['icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak']) {
    const incomplete = createFixture(t, { vendorPathMutation: rows => rows.filter(row => row.path !== missingCore) });
    assert.throws(() => assembleNsisExpectedContent(incomplete.input), /supplier_vendor_required_member_missing/u, missingCore);
    assert.equal(fs.existsSync(incomplete.outputPath), false);
  }
});

test('keeps any inventory-declared ANGLE file exact and requires it in the complete tree', t => {
  const anglePaths = ['libEGL.dll', 'libGLESv2.dll'];
  const fixture = createFixture(t);
  const result = assembleNsisExpectedContent(fixture.input);
  const manifest = JSON.parse(fs.readFileSync(fixture.outputPath, 'utf8'));
  const byPath = new Map(manifest.files.map(row => [row.relativePath, row]));
  for (const anglePath of anglePaths) {
    assert.equal(byPath.get(anglePath)?.sha256, sha256(fixture.vendorContent.get(anglePath)),
      `declared vendor member was not retained exactly: ${anglePath}`);
    const unpacked = makeUnpackedFromExpected(t, fixture, manifest, {
      consumerName: `missing-${anglePath.replaceAll('.', '-')}`,
      omitPaths: [anglePath],
    });
    assert.throws(() => runBridgeConsumer(fixture, result, unpacked), /bridge_tree_missing_file/u, anglePath);
    assert.equal(fs.existsSync(path.join(unpacked.root, 'resources/app/windows-payload-inventory.json')), false);
    assert.equal(fs.existsSync(path.join(unpacked.root, 'resources/app/windows-payload-manifest.template.json')), false);
  }
});

test('fails closed on stage drift, missing/extra vendor rows, and wrong revision pins', t => {
  const extra = createFixture(t, { stageMutation: 'extra' });
  assert.throws(() => assembleNsisExpectedContent(extra.input), /supplier_tree_unexpected_file/u);
  assert.equal(fs.existsSync(extra.outputPath), false);

  const drift = createFixture(t, { stageMutation: 'drift' });
  assert.throws(() => assembleNsisExpectedContent(drift.input), /supplier_tree_content_mismatch/u);
  assert.equal(fs.existsSync(drift.outputPath), false);

  const missing = createFixture(t, { stageMutation: 'missing' });
  assert.throws(() => assembleNsisExpectedContent(missing.input), /supplier_tree_file_set_mismatch/u);
  assert.equal(fs.existsSync(missing.outputPath), false);

  const wrongRevision = createFixture(t);
  wrongRevision.input.expectedContext = { ...wrongRevision.input.expectedContext, sourceRevision: 'e'.repeat(40) };
  assert.throws(() => assembleNsisExpectedContent(wrongRevision.input), /supplier_stage_manifest_binding_reject/u);
  assert.equal(fs.existsSync(wrongRevision.outputPath), false);

  for (const change of [doc => ({ ...doc, files: doc.files.slice(1) }), doc => ({ ...doc, files: [...doc.files, { ...doc.files[0], path: 'extra-runtime.bin' }] })]) {
    const altered = createFixture(t);
    const vendorDoc = JSON.parse(fs.readFileSync(altered.vendorPath, 'utf8'));
    fs.writeFileSync(altered.vendorPath, jsonBytes(change(vendorDoc)));
    assert.throws(() => assembleNsisExpectedContent(altered.input), /supplier_vendor_manifest_pin_mismatch/u);
    assert.equal(fs.existsSync(altered.outputPath), false);
  }
});

test('rejects unsafe paths, duplicate case-folded names, wrong transform version, and observed-output inputs', t => {
  for (const badPath of ['../escape.dll', 'data/secret.txt', 'state.sqlite', 'resources/CON.txt', 'resources/app/extra.txt']) {
    const fixture = createFixture(t, { vendorPathMutation: rows => [...rows, { path: badPath, sizeBytes: 1, sha256: 'f'.repeat(64) }] });
    assert.throws(() => assembleNsisExpectedContent(fixture.input), /supplier_(?:path_reject|sensitive_or_reserved_path_reject|vendor_case_collision|vendor_app_namespace_reject|output_case_collision)/u);
    assert.equal(fs.existsSync(fixture.outputPath), false);
  }
  const collision = createFixture(t, { vendorPathMutation: rows => [...rows, { ...rows[0], path: rows[0].path.toUpperCase() }] });
  assert.throws(() => assembleNsisExpectedContent(collision.input), /supplier_vendor_case_collision/u);

  const unknownTransform = createFixture(t);
  unknownTransform.input.transformMapVersion = 'unreviewed-map';
  assert.throws(() => assembleNsisExpectedContent(unknownTransform.input), /supplier_transform_map_version_reject/u);

  const observed = createFixture(t);
  observed.input.winUnpackedRoot = path.join(observed.parent, 'win-unpacked');
  assert.throws(() => assembleNsisExpectedContent(observed.input), /supplier_input_contract_reject/u);
});

test('binds stage/version/vendor archive and resource-edit receipts to independent pins', t => {
  const stagePin = createFixture(t);
  stagePin.input.expectedContext = { ...stagePin.input.expectedContext, stageManifestSha256: '0'.repeat(64) };
  assert.throws(() => assembleNsisExpectedContent(stagePin.input), /supplier_stage_manifest_pin_mismatch/u);
  assert.equal(fs.existsSync(stagePin.outputPath), false);

  const version = createFixture(t);
  version.input.expectedContext = { ...version.input.expectedContext, applicationVersion: '0.1.1' };
  version.input.expectedResourceEdit = { ...version.input.expectedResourceEdit, options: { ...version.input.expectedResourceEdit.options, productVersion: '0.1.1.0', fileVersion: '0.1.1' } };
  assert.throws(() => assembleNsisExpectedContent(version.input), /supplier_stage_manifest_binding_reject/u);
  assert.equal(fs.existsSync(version.outputPath), false);

  const archive = createFixture(t);
  archive.input.expectedContext = { ...archive.input.expectedContext, vendorArchiveSha256: 'e'.repeat(64) };
  assert.throws(() => assembleNsisExpectedContent(archive.input), /supplier_vendor_context_pin_mismatch/u);
  assert.equal(fs.existsSync(archive.outputPath), false);

  const receiptPin = createFixture(t);
  receiptPin.input.expectedResourceEdit = { ...receiptPin.input.expectedResourceEdit, receiptSha256: 'f'.repeat(64) };
  assert.throws(() => assembleNsisExpectedContent(receiptPin.input), /supplier_resource_receipt_pin_mismatch/u);
  assert.equal(fs.existsSync(receiptPin.outputPath), false);

  const attemptedChild = createFixture(t);
  const attemptedReceipt = JSON.parse(fs.readFileSync(attemptedChild.resourcePath, 'utf8'));
  attemptedReceipt.childProcessAttempts = [{ executable: 'unexpected' }];
  const attemptedReceiptBytes = jsonBytes(attemptedReceipt);
  fs.writeFileSync(attemptedChild.resourcePath, attemptedReceiptBytes);
  attemptedChild.input.expectedResourceEdit = {
    ...attemptedChild.input.expectedResourceEdit,
    receiptSha256: sha256(attemptedReceiptBytes),
  };
  assert.throws(() => assembleNsisExpectedContent(attemptedChild.input), /supplier_resource_receipt_status_reject/u);
  assert.equal(fs.existsSync(attemptedChild.outputPath), false);

  const exeDrift = createFixture(t);
  const changedExe = Buffer.from(EXE_BYTES);
  changedExe[0] ^= 1;
  fs.writeFileSync(exeDrift.exePath, changedExe);
  assert.throws(() => assembleNsisExpectedContent(exeDrift.input), /supplier_edited_executable_pin_mismatch/u);
  assert.equal(fs.existsSync(exeDrift.outputPath), false);
});

test('accepts Windows and POSIX receipt path syntax as metadata only, and rejects a conflicting recorded origin', t => {
  for (const reportedPathStyle of ['windows', 'posix']) {
    const fixture = createFixture(t, { reportedPathStyle });
    const result = assembleNsisExpectedContent(fixture.input);
    assert.equal(result.status, 'expected_content_complete');
    assert.equal(fs.existsSync(fixture.outputPath), true);
  }

  const mismatch = createFixture(t);
  const receipt = JSON.parse(fs.readFileSync(mismatch.resourcePath, 'utf8'));
  receipt.options.file = 'C:\\Other\\Tokenelo.exe';
  const alteredBytes = jsonBytes(receipt);
  fs.writeFileSync(mismatch.resourcePath, alteredBytes);
  mismatch.input.expectedResourceEdit = {
    ...mismatch.input.expectedResourceEdit,
    receiptSha256: sha256(alteredBytes),
  };
  assert.throws(() => assembleNsisExpectedContent(mismatch.input), /supplier_resource_output_path_binding_reject/u);
  assert.equal(fs.existsSync(mismatch.outputPath), false);

  const relative = createFixture(t);
  const relativeReceipt = JSON.parse(fs.readFileSync(relative.resourcePath, 'utf8'));
  relativeReceipt.tool.nodePath = 'relative/node.exe';
  const relativeBytes = jsonBytes(relativeReceipt);
  fs.writeFileSync(relative.resourcePath, relativeBytes);
  relative.input.expectedResourceEdit = { ...relative.input.expectedResourceEdit, receiptSha256: sha256(relativeBytes) };
  assert.throws(() => assembleNsisExpectedContent(relative.input), /supplier_resource_tool_path_reject/u);
  assert.equal(fs.existsSync(relative.outputPath), false);
});

test('refuses output overlap and preexisting output without changing it', t => {
  const overlap = createFixture(t, { outputInsideStage: true });
  assert.throws(() => assembleNsisExpectedContent(overlap.input), /supplier_output_source_overlap_reject/u);

  const existing = createFixture(t);
  const before = Buffer.from('preserve foreign existing output\n');
  fs.writeFileSync(existing.outputPath, before, { flag: 'wx' });
  assert.throws(() => assembleNsisExpectedContent(existing.input), /supplier_output_already_exists/u);
  assert.deepEqual(fs.readFileSync(existing.outputPath), before);
});
