import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildWithIsolatedSingleProjectPackager,
  createIsolatedSingleProjectPackager,
  runPrivateDirectoryBuild,
  privateDirectoryBuildContract,
  verifyFrozenSources,
} from '../../scripts/build-windows-private-directory.mjs';

const SOURCE_REVISION = 'c'.repeat(40);
const DRIVER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/build-windows-private-directory.mjs');
const DRIVER_ROOT = path.resolve(path.dirname(DRIVER_PATH), '..');
function resolveBuilderRoot() {
  const explicitRoot = process.env.TOKENELO_BUILDER_ROOT;
  if (typeof explicitRoot === 'string' && explicitRoot.length > 0) {
    const root = fs.realpathSync.native(path.resolve(explicitRoot));
    if (!fs.existsSync(path.join(root, 'app-builder-lib', 'package.json'))) {
      throw new Error('TOKENELO_BUILDER_ROOT must name a read-only builder node_modules root');
    }
    return root;
  }
  let lastError;
  const anchors = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
    process.cwd(),
  ];
  for (const anchor of [...new Set(anchors)]) {
    try {
      const requireFromAnchor = createRequire(path.join(anchor, 'package.json'));
      const physicalEntry = fs.realpathSync.native(requireFromAnchor.resolve('app-builder-lib'));
      return fs.realpathSync.native(path.resolve(path.dirname(physicalEntry), '../..'));
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('locked electron-builder source required for pin verification', { cause: lastError });
}
const BUILDER_ROOT = resolveBuilderRoot();
const requireFromBuilder = createRequire(path.join(BUILDER_ROOT, 'app-builder-lib', 'package.json'));
const PINNED_APP_BUILDER_LIB = requireFromBuilder('app-builder-lib');
const PINNED_APP_BUILDER_PACKAGE = JSON.parse(fs.readFileSync(path.join(BUILDER_ROOT, 'app-builder-lib', 'package.json'), 'utf8'));
const CHILD_PROCESS_GUARD = globalThis[Symbol.for('tokenelo.zero-child-process-guard.v1')];
const OWNER_SID = 'S-1-5-21-120001-120002-120003-1001';
const SYSTEM_SID = 'S-1-5-18';
const ADMIN_SID = 'S-1-5-32-544';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

function writeFile(root, relative, bytes) {
  const full = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes, { flag: 'wx' });
  return full;
}

function projectSourcePins(projectDir) {
  const paths = [
    'package.json',
    'package-lock.json',
    'packaging/electron-builder.config.cjs',
    'scripts/stage-private-package.mjs',
  ];
  return paths.map(relativePath => ({
    path: relativePath,
    sha256: sha256(fs.readFileSync(path.join(projectDir, ...relativePath.split('/')))),
  }));
}

function makeBuilder(fixture, behavior = {}) {
  const arch = { x64: 1, 0: 'ia32', 1: 'x64' };
  const windows = {
    createTarget(type, selectedArch) {
      return new Map([[windows, new Map([[selectedArch, [type]]])]]);
    },
  };
  const events = fixture.events;
  class FakePackager {
    constructor(options) {
      this.options = options;
      this.projectDir = options.projectDir;
      this.appDir = options.projectDir;
    }

    async getWorkspaceRoot() {
      fixture.defaultWorkspaceProbeCalls += 1;
      throw new Error('default lazy workspace probe must not run');
    }
  }
  return {
    Packager: FakePackager,
    Arch: arch,
    Platform: { WINDOWS: windows },
    async build(options, packager) {
      fixture.builderCalls += 1;
      fixture.options = options;
      fixture.receivedPackager = packager;
      assert.ok(packager instanceof FakePackager);
      assert.equal(await packager.getWorkspaceRoot(), fixture.plan.projectDir);
      events.push('isolated-workspace-root-resolved');
      packager.appDir = fixture.plan.appDir;
      assert.equal(await packager.getWorkspaceRoot(), fixture.plan.projectDir);
      assert.equal(fixture.defaultWorkspaceProbeCalls, 0);
      assert.equal(options.projectDir, fixture.plan.projectDir);
      assert.equal(options.publish, null);
      assert.equal(options.config.directories.app, fixture.plan.appDir);
      assert.equal(options.config.directories.output, fixture.outputRoot);
      assert.equal(options.config.electronDist, fixture.plan.electronZipPath);
      assert.equal(options.config.nodeGypRebuild, false);
      assert.equal(options.config.npmRebuild, true);
      assert.equal(typeof options.config.beforeBuild, 'function');
      assert.equal(options.config.beforePack, undefined);
      assert.equal(options.config.afterPack, undefined);
      assert.equal(await options.config.beforeBuild({
        appDir: fixture.plan.appDir, electronVersion: '44.9.3', platform: 'win32', arch: 'x64',
      }), false);
      events.push('dependency-skip-hook-returned-false');
      assert.equal(options.config.asar, false);
      assert.equal(options.config.buildNumber, '0');
      assert.equal(options.config.extraMetadata, undefined);
      assert.equal(options.config.win.signExecutable, false);
      assert.deepEqual(options.config.win.target, ['dir']);
      const winTargets = options.targets.get(windows);
      assert.deepEqual(winTargets.get(arch.x64), ['dir']);
      assert.equal(options.targets.size, 1);

      fs.mkdirSync(fixture.outputRoot, { recursive: false });
      const appOutDir = path.join(fixture.outputRoot, 'win-unpacked');
      fs.mkdirSync(appOutDir, { recursive: false });
      if (behavior.skipTree !== true) {
        for (const [relative, bytes] of fixture.outputFiles) {
          const adjusted = behavior.corruptRelative === relative ? Buffer.from('changed synthetic output') : bytes;
          writeFile(appOutDir, relative, adjusted);
        }
      }
      events.push('resource-edit-complete');
      if (behavior.skipHook !== true) {
        const context = {
          appOutDir: behavior.appOutDir ?? appOutDir,
          electronPlatformName: 'win32',
          arch: behavior.arch ?? arch.x64,
        };
        await options.config.afterSign(context);
        events.push('after-sign-returned');
        if (behavior.secondHook === true) await options.config.afterSign(context);
      }
      if (behavior.mutateExpectedManifest === true) {
        fs.appendFileSync(fixture.plan.expectedManifestPath, Buffer.from(' '));
      }
      assert.equal(await packager.getWorkspaceRoot(), fixture.plan.projectDir);
      assert.equal(fixture.defaultWorkspaceProbeCalls, 0);
      return fixture.artifactPaths;
    },
  };
}

function makeFixture({ stagePackageFields = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-private-dir-driver-test-'));
  const controlRoot = path.join(root, 'control');
  const stageRoot = path.join(root, 'stage');
  const appDir = path.join(stageRoot, 'app');
  const projectDir = path.join(root, 'project');
  const inputs = path.join(root, 'inputs');
  fs.mkdirSync(controlRoot);
  fs.mkdirSync(inputs);
  fs.mkdirSync(path.join(projectDir, 'packaging'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'dist', 'tray'), { recursive: true });

  const projectPackage = Buffer.from(JSON.stringify({
    name: 'tokenelo', version: '0.1.0', private: true, type: 'module', main: 'dist/tray/main.js',
  }), 'utf8');
  const projectLock = Buffer.from(JSON.stringify({
    name: 'tokenelo', version: '0.1.0', lockfileVersion: 3,
    packages: {
      '': { name: 'tokenelo', version: '0.1.0' },
      'node_modules/electron': { version: '44.9.3' },
      'node_modules/electron-builder': { version: '26.18.0' },
    },
  }), 'utf8');
  const sourceConfig = {
    appId: 'com.elostudios.tokenelo', productName: 'Tokenelo', buildVersion: '0.1.0', buildNumber: '0',
    electronVersion: '44.9.3', asar: false, publish: null,
    win: { signExecutable: false, requestedExecutionLevel: 'asInvoker' },
    nsis: { allowElevation: false, packElevateHelper: false, perMachine: false },
  };
  writeFile(root, 'project/package.json', projectPackage);
  writeFile(root, 'project/package-lock.json', projectLock);
  writeFile(root, 'project/packaging/electron-builder.config.cjs', Buffer.from(`module.exports = ${JSON.stringify(sourceConfig)};\n`, 'utf8'));
  writeFile(root, 'project/scripts/stage-private-package.mjs', Buffer.from('export const syntheticStageSource = true;\n', 'utf8'));

  const appPackage = Buffer.from(JSON.stringify({
    name: 'tokenelo', version: '0.1.0', private: true, type: 'module', main: 'dist/tray/main.js',
    ...stagePackageFields,
  }), 'utf8');
  const mainJs = Buffer.from('export const synthetic = true;\n', 'utf8');
  fs.writeFileSync(path.join(appDir, 'package.json'), appPackage);
  fs.writeFileSync(path.join(appDir, 'dist', 'tray', 'main.js'), mainJs);
  const payloadFiles = [
    { path: 'dist/tray/main.js', sizeBytes: mainJs.length, sha256: sha256(mainJs) },
    { path: 'package.json', sizeBytes: appPackage.length, sha256: sha256(appPackage) },
  ];
  const payloadBytes = jsonBytes({ schemaVersion: 1, root: 'app', files: payloadFiles });
  const payloadPath = writeFile(root, 'stage/payload-manifest.private.json', payloadBytes);
  const payloadSha = sha256(payloadBytes);
  const stageManifest = {
    schemaVersion: 1,
    kind: 'tokenelo-private-electron-stage',
    privacy: 'private',
    releasePolicy: { publish: 'never', publicAutoUpdates: false },
    source: { revision: SOURCE_REVISION, dirty: false },
    application: {
      name: 'tokenelo', version: '0.1.0', private: true, type: 'module', main: 'dist/tray/main.js',
      electronVersion: '44.9.3', electronBuilderVersion: '26.18.0',
    },
    payload: {
      fileCount: payloadFiles.length,
      manifest: 'payload-manifest.private.json',
      manifestSha256: payloadSha,
      sha256: sha256(Buffer.from(JSON.stringify({ schemaVersion: 1, files: payloadFiles }), 'utf8')),
    },
  };
  const stageBytes = jsonBytes(stageManifest);
  const stageManifestPath = writeFile(root, 'stage/stage-manifest.private.json', stageBytes);
  const stageSha = sha256(stageBytes);

  const zipBytes = Buffer.from('synthetic archive bytes; never executed');
  const electronZipPath = writeFile(root, 'inputs/electron.zip', zipBytes);
  const vendorRows = Array.from({ length: 73 }, (_, index) => {
    const bytes = Buffer.from(`synthetic vendor member ${index}`);
    return { path: `member-${String(index).padStart(2, '0')}.dat`, sizeBytes: bytes.length, sha256: sha256(bytes) };
  });
  const vendorDocument = {
    schemaVersion: 1, archiveSha256: sha256(zipBytes), archiveBytes: zipBytes.length,
    sourceBinding: {}, inventoryScriptSha256: sha256(Buffer.from('synthetic inventory source')),
    files: vendorRows,
  };
  const vendorBytes = jsonBytes(vendorDocument);
  const vendorManifestPath = writeFile(root, 'inputs/vendor-members.private.json', vendorBytes);

  const resourceReceiptBytes = jsonBytes({ schemaVersion: 1, status: 'synthetic-only' });
  const resourceEditReceiptPath = writeFile(root, 'inputs/resource-edit.private.json', resourceReceiptBytes);
  const editedExeBytes = Buffer.from('synthetic-edited-executable');
  const editedExecutablePath = writeFile(root, 'inputs/Tokenelo.exe', editedExeBytes);

  const privateRoot = root;
  const ownerSidList = [OWNER_SID, SYSTEM_SID, ADMIN_SID].sort();
  const rootReceiptBytes = jsonBytes({
    schemaVersion: 1,
    status: 'verified',
    createdExclusive: true,
    root: privateRoot,
    ownerUsername: os.userInfo().username,
    ownerSid: OWNER_SID,
    protectedDacl: true,
    allowedReadSids: ownerSidList,
    allowedWriteSids: ownerSidList,
    unexpectedAceCount: 0,
  });
  const rootReceiptPath = writeFile(root, 'control/owned-root.private.json', rootReceiptBytes);

  const context = {
    sourceRevision: SOURCE_REVISION,
    applicationVersion: '0.1.0',
    electronVersion: '44.9.3',
    electronBuilderVersion: '26.18.0',
    stageManifestSha256: stageSha,
    stagedPayloadManifestSha256: payloadSha,
    vendorArchiveSha256: sha256(zipBytes),
  };
  const outputFiles = new Map([
    ['Tokenelo.exe', editedExeBytes],
    ['icudtl.dat', Buffer.from('icu')],
    ['resources.pak', Buffer.from('resources')],
    ['v8_context_snapshot.bin', Buffer.from('snapshot')],
    ['locales/en-US.pak', Buffer.from('locale')],
    ['LICENSE.electron.txt', Buffer.from('license')],
    ['LICENSES.chromium.html', Buffer.from('<html>license</html>')],
    ['version', Buffer.from('44.9.3')],
    ['resources/default_app.asar', Buffer.from('default asar')],
    ['resources/app/package.json', appPackage],
    ['resources/app/dist/tray/main.js', mainJs],
  ]);
  const records = [...outputFiles.entries()].map(([relativePath, bytes]) => {
    let provenance;
    if (relativePath === 'Tokenelo.exe') {
      provenance = {
        sourceClass: 'verified-transform', sourceArtifactSha256: sha256(zipBytes),
        sourceRelativePath: 'electron.exe', sourceBytesSha256: sha256(Buffer.from('original synthetic exe')),
        transformId: 'synthetic.resource-edit.v1',
      };
    } else if (relativePath.startsWith('resources/app/')) {
      const sourceRelativePath = relativePath.slice('resources/app/'.length);
      provenance = { sourceClass: 'app-stage', sourceArtifactSha256: payloadSha, sourceRelativePath };
    } else {
      provenance = { sourceClass: 'vendor-electron', sourceArtifactSha256: sha256(zipBytes), sourceRelativePath: relativePath };
    }
    return { relativePath, sizeBytes: bytes.length, sha256: sha256(bytes), provenance };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const manifest = {
    schemaVersion: 1,
    kind: 'tokenelo-windows-expected-content-manifest',
    platform: 'win32', architecture: 'x64', outputDirectoryName: 'win-unpacked',
    packageIdentity: 'com.elostudios.tokenelo', applicationPackageName: 'tokenelo',
    applicationVersion: context.applicationVersion, electronVersion: context.electronVersion,
    electronBuilderVersion: context.electronBuilderVersion, sourceRevision: context.sourceRevision,
    stageManifestSha256: context.stageManifestSha256,
    stagedPayloadManifestSha256: context.stagedPayloadManifestSha256,
    vendorArchiveSha256: context.vendorArchiveSha256,
    files: records,
  };
  const expectedManifestBytes = jsonBytes(manifest);
  const expectedManifestPath = writeFile(root, 'control/expected-content.private.json', expectedManifestBytes);

  const plan = {
    schemaVersion: 2,
    kind: 'tokenelo-windows-private-directory-build-plan',
    taskId: `test-${crypto.randomBytes(5).toString('hex')}`,
    driverSha256: sha256(fs.readFileSync(DRIVER_PATH)),
    sourceRevision: SOURCE_REVISION,
    applicationVersion: '0.1.0',
    electronVersion: '44.9.3',
    electronBuilderVersion: '26.18.0',
    privateRoot,
    privateRootReceiptSha256: sha256(rootReceiptBytes),
    projectDir,
    projectSourcePins: projectSourcePins(projectDir),
    stageRoot,
    appDir,
    stageManifestPath,
    stageManifestSha256: stageSha,
    payloadManifestPath: payloadPath,
    payloadManifestSha256: payloadSha,
    electronZipPath,
    electronZipSha256: sha256(zipBytes),
    vendorMemberManifestPath: vendorManifestPath,
    vendorMemberManifestSha256: sha256(vendorBytes),
    resourceEditReceiptPath,
    resourceEditReceiptSha256: sha256(resourceReceiptBytes),
    editedExecutablePath,
    editedExecutableSha256: sha256(editedExeBytes),
    expectedManifestPath,
    expectedManifestSha256: sha256(expectedManifestBytes),
    builderRoot: BUILDER_ROOT,
    expectedContext: context,
  };
  return {
    root, plan, outputRoot: path.join(privateRoot, `out-${plan.taskId}`),
    outputFiles, events: [], builderCalls: 0, bridgeCalls: 0, defaultWorkspaceProbeCalls: 0,
    artifactPaths: [path.join(privateRoot, `out-${plan.taskId}`, 'win-unpacked', 'Tokenelo.exe')],
  };
}

function cleanup(fixture) {
  const base = path.resolve(os.tmpdir());
  const target = path.resolve(fixture.root);
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(target).startsWith('tokenelo-private-dir-driver-test-')) {
    throw new Error('refusing to remove a test root outside the task-owned temp area');
  }
  fs.rmSync(target, { recursive: true, force: false });
}

function dependenciesFor(fixture, behavior = {}) {
  return {
    hostPlatform: 'win32',
    builder: makeBuilder(fixture, behavior),
  };
}

async function run(fixture, dependencies = dependenciesFor(fixture)) {
  const planBytes = jsonBytes(fixture.plan);
  return runPrivateDirectoryBuild({ planBytes, expectedPlanSha256: sha256(planBytes), dependencies });
}

function isolatedScopeForFixture(fixture) {
  const projectPackageSha256 = fixture.plan.projectSourcePins.find(pin => pin.path === 'package.json')?.sha256;
  const payload = JSON.parse(fs.readFileSync(fixture.plan.payloadManifestPath, 'utf8'));
  const stagedPackageSha256 = payload.files.find(file => file.path === 'package.json')?.sha256;
  assert.match(projectPackageSha256, /^[a-f0-9]{64}$/u);
  assert.match(stagedPackageSha256, /^[a-f0-9]{64}$/u);
  return {
    projectDir: fixture.plan.projectDir,
    stageRoot: fixture.plan.stageRoot,
    appDir: fixture.plan.appDir,
    projectPackageSha256,
    stagedPackageSha256,
  };
}

function isolatedPackagerOptions(fixture) {
  return {
    projectDir: fixture.plan.projectDir,
    targets: new Map(),
    config: { directories: { app: fixture.plan.appDir } },
  };
}

function makeWorkspaceProbePackager(counter) {
  return class WorkspaceProbePackager {
    constructor(options) {
      this.options = options;
      this.projectDir = options.projectDir;
      this.appDir = options.projectDir;
    }

    async getWorkspaceRoot() {
      counter.calls += 1;
      throw new Error('default lazy workspace probe must not run');
    }
  };
}

test('pinned app-builder-lib 26.18 exposes the public constructor, workspace method, and injectable build API', () => {
  assert.equal(PINNED_APP_BUILDER_PACKAGE.version, '26.18.0');
  assert.equal(typeof PINNED_APP_BUILDER_LIB.Packager, 'function');
  assert.equal(typeof PINNED_APP_BUILDER_LIB.Packager.prototype.getWorkspaceRoot, 'function');
  assert.equal(typeof PINNED_APP_BUILDER_LIB.build, 'function');
  assert.equal(privateDirectoryBuildContract.builderSources, 41);
  assert.match(fs.readFileSync(path.join(BUILDER_ROOT, 'app-builder-lib', 'out', 'packager.d.ts'), 'utf8'), /getWorkspaceRoot\(\): Promise<string>/u);
  assert.match(fs.readFileSync(path.join(BUILDER_ROOT, 'app-builder-lib', 'out', 'index.d.ts'), 'utf8'), /build\(options: PackagerOptions & PublishOptions, packager\?: Packager\): Promise<Array<string>>/u);
});

test('isolated Packager passes the original artifact array and leaves dependency/hook policy callbacks intact', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const counter = { calls: 0 };
  const FakePackager = makeWorkspaceProbePackager(counter);
  const options = isolatedPackagerOptions(fixture);
  let beforeBuildCalls = 0;
  let afterSignCalls = 0;
  options.config.beforeBuild = async () => { beforeBuildCalls += 1; return false; };
  options.config.afterSign = async () => { afterSignCalls += 1; };
  const artifactArray = fixture.artifactPaths;
  let receivedPackager;
  const builder = {
    Packager: FakePackager,
    async build(receivedOptions, packager) {
      assert.strictEqual(receivedOptions, options);
      receivedPackager = packager;
      assert.strictEqual(await packager.getWorkspaceRoot(), fixture.plan.projectDir);
      assert.equal(await receivedOptions.config.beforeBuild(), false);
      packager.appDir = fixture.plan.appDir;
      assert.strictEqual(await packager.getWorkspaceRoot(), fixture.plan.projectDir);
      await receivedOptions.config.afterSign();
      return artifactArray;
    },
  };

  const result = await buildWithIsolatedSingleProjectPackager(builder, options, isolatedScopeForFixture(fixture));
  assert.strictEqual(result.packager, receivedPackager);
  assert.strictEqual(result.artifactPaths, artifactArray);
  assert.deepEqual([beforeBuildCalls, afterSignCalls, counter.calls], [1, 1, 0]);
  assert.equal(fs.existsSync(fixture.outputRoot), false, 'adapter tests do not create package output');
});

test('builder API and Packager constructor mismatches refuse before the builder is called', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  let buildCalls = 0;
  const counter = { calls: 0 };
  const options = isolatedPackagerOptions(fixture);
  const scope = isolatedScopeForFixture(fixture);
  const validBuilder = {
    Packager: makeWorkspaceProbePackager(counter),
    async build() { buildCalls += 1; return fixture.artifactPaths; },
  };
  for (const invalid of [
    { Packager: validBuilder.Packager },
    { build: validBuilder.build },
    { Packager: class MissingWorkspaceMethod {}, build: validBuilder.build },
  ]) {
    await assert.rejects(buildWithIsolatedSingleProjectPackager(invalid, options, scope), /app_builder_api_rejected|app_builder_packager_api_rejected/u);
  }

  class ThrowingPackager {
    constructor() { throw new Error('constructor sentinel'); }
    async getWorkspaceRoot() { return fixture.plan.projectDir; }
  }
  await assert.rejects(buildWithIsolatedSingleProjectPackager({
    Packager: ThrowingPackager,
    async build() { buildCalls += 1; return fixture.artifactPaths; },
  }, options, scope), /app_builder_packager_constructor_rejected/u);
  assert.equal(buildCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('isolated workspace root rejects a changed project/app root and changed workspace declarations', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const scope = isolatedScopeForFixture(fixture);
  const counter = { calls: 0 };
  const IsolatedPackager = createIsolatedSingleProjectPackager(makeWorkspaceProbePackager(counter), scope);
  const options = isolatedPackagerOptions(fixture);

  const projectEscape = new IsolatedPackager(options);
  projectEscape.projectDir = path.dirname(fixture.plan.projectDir);
  await assert.rejects(projectEscape.getWorkspaceRoot(), /builder_workspace_scope_rejected/u);

  const appEscape = new IsolatedPackager(options);
  appEscape.appDir = fixture.root;
  await assert.rejects(appEscape.getWorkspaceRoot(), /builder_workspace_scope_rejected/u);

  const projectDrift = new IsolatedPackager(options);
  const projectPackagePath = path.join(fixture.plan.projectDir, 'package.json');
  const originalProjectPackage = fs.readFileSync(projectPackagePath);
  const projectPackage = JSON.parse(fs.readFileSync(projectPackagePath, 'utf8'));
  projectPackage.workspaces = [];
  fs.writeFileSync(projectPackagePath, JSON.stringify(projectPackage));
  await assert.rejects(projectDrift.getWorkspaceRoot(), /json_hash_mismatch/u);
  fs.writeFileSync(projectPackagePath, originalProjectPackage);

  const stagePackagePath = path.join(fixture.plan.appDir, 'package.json');
  const stagedPackage = JSON.parse(fs.readFileSync(stagePackagePath, 'utf8'));
  delete stagedPackage.workspaces;
  fs.writeFileSync(stagePackagePath, JSON.stringify(stagedPackage));
  const freshScope = { ...scope, stagedPackageSha256: sha256(fs.readFileSync(stagePackagePath)) };
  const StageWorkspacePackager = createIsolatedSingleProjectPackager(makeWorkspaceProbePackager(counter), freshScope);
  const stageDrift = new StageWorkspacePackager(options);
  const changedStagePackage = JSON.parse(fs.readFileSync(stagePackagePath, 'utf8'));
  changedStagePackage.workspaces = [];
  fs.writeFileSync(stagePackagePath, JSON.stringify(changedStagePackage));
  await assert.rejects(stageDrift.getWorkspaceRoot(), /json_hash_mismatch/u);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('the real pinned Packager override resolves the fixed root without touching lazy npm workspace discovery', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const guard = CHILD_PROCESS_GUARD;
  const before = guard?.snapshot();
  const BaseWorkspaceMethod = PINNED_APP_BUILDER_LIB.Packager.prototype.getWorkspaceRoot;
  const IsolatedPackager = createIsolatedSingleProjectPackager(PINNED_APP_BUILDER_LIB.Packager, isolatedScopeForFixture(fixture));
  const options = isolatedPackagerOptions(fixture);
  const packager = new IsolatedPackager(options);
  assert.ok(packager instanceof PINNED_APP_BUILDER_LIB.Packager);
  assert.strictEqual(PINNED_APP_BUILDER_LIB.Packager.prototype.getWorkspaceRoot, BaseWorkspaceMethod, 'vendor prototype remains untouched');
  const lazyManager = packager._packageManager;
  let lazyValueReads = 0;
  Object.defineProperty(packager, '_packageManager', {
    configurable: true,
    value: new Proxy(lazyManager, {
      get(target, property, receiver) {
        if (property === 'value') { lazyValueReads += 1; throw new Error('lazy workspace probe sentinel'); }
        return Reflect.get(target, property, receiver);
      },
    }),
  });
  assert.equal(await packager.getWorkspaceRoot(), fixture.plan.projectDir);
  assert.equal(lazyValueReads, 0);
  if (guard) {
    assert.deepEqual(guard.snapshot(), before, 'zero-child guard saw no additional child process attempt');
    assert.equal(Object.values(guard.snapshot()).reduce((sum, count) => sum + count, 0), 0);
  }
});

test('contract pins plan-bound source identity, V4 bridge, Electron 44 and the unpacked-only target', () => {
  assert.equal(privateDirectoryBuildContract.schemaVersion, 2);
  assert.equal(privateDirectoryBuildContract.sourceRevisionFormat, 'git-sha1-lowercase-40-hex (plan-bound)');
  assert.equal(privateDirectoryBuildContract.target, 'win32-x64-dir');
  assert.equal(privateDirectoryBuildContract.outputDirectoryName, 'win-unpacked');
  assert.equal(privateDirectoryBuildContract.appSources, 4);
  assert.equal(privateDirectoryBuildContract.bridgeSources, 3);
  assert.equal(privateDirectoryBuildContract.electronBuilderVersion, '26.18.0');
});

test('plan-bound project, V4 bridge, and locked builder source pins match physical roots', () => {
  const fixture = makeFixture();
  try {
    const result = verifyFrozenSources(fixture.plan, DRIVER_ROOT);
    assert.equal(result.projectRoot, path.resolve(fixture.plan.projectDir));
    assert.equal(result.builderRoot, path.resolve(BUILDER_ROOT));
  } finally { cleanup(fixture); }
});

test('project source pin pathlist, keys, and digests are strict before build output', async t => {
  const cases = [
    ['malformed digest', pins => { pins[0].sha256 = '0'.repeat(63); }, /project_source_pin_hash_rejected/u],
    ['wrong digest', pins => { pins[0].sha256 = '0'.repeat(64); }, /input_hash_mismatch/u],
    ['path substitution', pins => { pins[0].path = 'package.json.bak'; }, /project_source_pin_pathlist_rejected/u],
    ['unknown key', pins => { pins[0].extra = true; }, /project_source_pin_contract_rejected/u],
    ['missing file pin', pins => { pins.pop(); }, /project_source_pin_list_rejected/u],
    ['extra file', pins => { pins.push({ path: 'extra.js', sha256: '0'.repeat(64) }); }, /project_source_pin_list_rejected/u],
  ];
  for (const [name, corrupt, expectedError] of cases) {
    await t.test(name, async subtest => {
      const fixture = makeFixture();
      subtest.after(() => cleanup(fixture));
      corrupt(fixture.plan.projectSourcePins);
      let builderCalls = 0;
      const dependencies = {
        ...dependenciesFor(fixture),
        builder: { ...makeBuilder(fixture), build: async () => { builderCalls += 1; return []; } },
      };
      await assert.rejects(run(fixture, dependencies), expectedError);
      assert.equal(builderCalls, 0);
      assert.equal(fs.existsSync(fixture.outputRoot), false);
    });
  }
});

test('project source drift is detected before output creation', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  fs.appendFileSync(path.join(fixture.plan.projectDir, 'scripts', 'stage-private-package.mjs'), '\n// drift\n');
  let builderCalls = 0;
  const dependencies = {
    ...dependenciesFor(fixture),
    builder: { ...makeBuilder(fixture), build: async () => { builderCalls += 1; return []; } },
  };
  await assert.rejects(run(fixture, dependencies), /input_hash_mismatch/u);
  assert.equal(builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('source revision requires a full exact Git SHA and matches expected context', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  fixture.plan.sourceRevision = 'a'.repeat(39);
  await assert.rejects(run(fixture), /plan_identity_rejected/u);
  assert.equal(fixture.builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);

  fixture.plan.sourceRevision = SOURCE_REVISION;
  fixture.plan.expectedContext.sourceRevision = 'd'.repeat(40);
  await assert.rejects(run(fixture), /expected_context_binding_rejected/u);
  assert.equal(fixture.builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('stage and expected manifest identities must agree with the plan source revision', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const stage = JSON.parse(fs.readFileSync(fixture.plan.stageManifestPath, 'utf8'));
  stage.source.revision = 'd'.repeat(40);
  const stageBytes = jsonBytes(stage);
  fs.writeFileSync(fixture.plan.stageManifestPath, stageBytes);
  fixture.plan.stageManifestSha256 = sha256(stageBytes);
  fixture.plan.expectedContext.stageManifestSha256 = fixture.plan.stageManifestSha256;
  await assert.rejects(run(fixture), /stage_manifest_binding_rejected/u);
  assert.equal(fixture.builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);

  const repairedStage = { ...stage, source: { ...stage.source, revision: SOURCE_REVISION } };
  const repairedStageBytes = jsonBytes(repairedStage);
  fs.writeFileSync(fixture.plan.stageManifestPath, repairedStageBytes);
  fixture.plan.stageManifestSha256 = sha256(repairedStageBytes);
  fixture.plan.expectedContext.stageManifestSha256 = fixture.plan.stageManifestSha256;
  const manifest = JSON.parse(fs.readFileSync(fixture.plan.expectedManifestPath, 'utf8'));
  manifest.sourceRevision = 'd'.repeat(40);
  manifest.stageManifestSha256 = fixture.plan.stageManifestSha256;
  const manifestBytes = jsonBytes(manifest);
  fs.writeFileSync(fixture.plan.expectedManifestPath, manifestBytes);
  fixture.plan.expectedManifestSha256 = sha256(manifestBytes);
  await assert.rejects(run(fixture), /expected_manifest_context_rejected/u);
  assert.equal(fixture.builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('driver-owned dependency bypass is exact and project hooks or node-gyp rebuild are rejected', async t => {
  const cases = [
    ['source beforeBuild', 'beforeBuild: () => { throw new Error("source_beforeBuild_ran"); }'],
    ['source beforePack', 'beforePack: () => {}'],
    ['source afterExtract', 'afterExtract: () => {}'],
    ['source afterPack', 'afterPack: () => {}'],
    ['source afterSign', 'afterSign: () => {}'],
    ['artifactBuildStarted', 'artifactBuildStarted: () => {}'],
    ['artifactBuildCompleted', 'artifactBuildCompleted: () => {}'],
    ['afterAllArtifactBuild', 'afterAllArtifactBuild: () => []'],
    ['msiProjectCreated', 'msiProjectCreated: () => {}'],
    ['appxManifestCreated', 'appxManifestCreated: () => {}'],
    ['onNodeModuleFile', 'onNodeModuleFile: () => false'],
    ['alternate Electron dist hook', 'electronDist: () => "unexpected"'],
    ['node-gyp rebuild', 'nodeGypRebuild: true'],
  ];
  for (const [name, property] of cases) {
    await t.test(name, async subtest => {
      const fixture = makeFixture();
      subtest.after(() => cleanup(fixture));
      const configPath = path.join(fixture.plan.projectDir, 'packaging', 'electron-builder.config.cjs');
      const configSource = fs.readFileSync(configPath, 'utf8');
      const injected = configSource.replace('module.exports = {', `module.exports = { ${property}, `);
      assert.notEqual(injected, configSource);
      fs.writeFileSync(configPath, injected);
      const configPin = fixture.plan.projectSourcePins.find(pin => pin.path === 'packaging/electron-builder.config.cjs');
      configPin.sha256 = sha256(fs.readFileSync(configPath));
      let builderCalls = 0;
      const dependencies = {
        ...dependenciesFor(fixture),
        builder: { ...makeBuilder(fixture), build: async () => { builderCalls += 1; return []; } },
      };
      await assert.rejects(run(fixture, dependencies), /source_build_config_rejected/u);
      assert.equal(builderCalls, 0);
      assert.equal(fs.existsSync(fixture.outputRoot), false);
    });
  }
});

test('dependency-free hook rejects nonempty staged dependency declarations before builder entry', async t => {
  const cases = [
    ['runtime production dependencies', { dependencies: { 'synthetic-runtime': '1.0.0' } }],
    ['development dependencies', { devDependencies: { 'synthetic-build-tool': '1.0.0' } }],
    ['optional dependencies', { optionalDependencies: { 'synthetic-optional': '1.0.0' } }],
    ['peer dependencies', { peerDependencies: { 'synthetic-peer': '1.0.0' } }],
    ['bundledDependencies', { bundledDependencies: ['synthetic-bundled'] }],
    ['bundleDependencies alias', { bundleDependencies: ['synthetic-bundled'] }],
  ];
  for (const [name, stagePackageFields] of cases) {
    await t.test(name, async subtest => {
      const fixture = makeFixture({ stagePackageFields });
      subtest.after(() => cleanup(fixture));
      await assert.rejects(run(fixture), /stage_dependencies_rejected/u);
      assert.equal(fixture.builderCalls, 0);
      assert.equal(fs.existsSync(fixture.outputRoot), false);
    });
  }
});

test('dependency-free hook rejects an empty staged node_modules directory before builder entry', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  fs.mkdirSync(path.join(fixture.plan.appDir, 'node_modules'));
  await assert.rejects(run(fixture), /stage_node_modules_rejected/u);
  assert.equal(fixture.builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('empty dependency declarations remain eligible for the guarded dependency bypass', async t => {
  const fixture = makeFixture({ stagePackageFields: {
    dependencies: {}, devDependencies: {}, optionalDependencies: {}, peerDependencies: {},
    bundleDependencies: [], bundledDependencies: [],
  } });
  t.after(() => cleanup(fixture));
  const result = await run(fixture);
  assert.equal(result.status, 'private_directory_build_complete');
  assert.equal(fixture.builderCalls, 1);
  assert.equal(result.fullRootReady, false);
});

test('successful fake directory build calls the V4 bridge after resource editing and leaves installer disabled', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const result = await run(fixture);
  assert.equal(result.status, 'private_directory_build_complete');
  assert.equal(result.target, 'win32-x64-dir');
  assert.equal(result.fullRootReady, false);
  assert.equal(result.restoreInputAllowed, false);
  assert.deepEqual(fixture.events, ['isolated-workspace-root-resolved', 'dependency-skip-hook-returned-false', 'resource-edit-complete', 'after-sign-returned']);
  assert.equal(fixture.builderCalls, 1);
  assert.equal(fs.existsSync(path.join(fixture.outputRoot, 'win-unpacked', 'resources', 'app', 'windows-payload-inventory.json')), true);
  assert.equal(fs.existsSync(path.join(fixture.outputRoot, 'win-unpacked', 'resources', 'app', 'windows-payload-manifest.template.json')), true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'control', `${fixture.plan.taskId}-payload-pins.nsh`)), true);
});

test('source pins and supplied plan hash reject a changed plan before loading the builder', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const planBytes = jsonBytes(fixture.plan);
  let loaded = 0;
  await assert.rejects(runPrivateDirectoryBuild({
    planBytes,
    expectedPlanSha256: '0'.repeat(64),
    dependencies: { loadBuilder: async () => { loaded += 1; return makeBuilder(fixture); } },
  }), /plan_hash_mismatch/u);
  assert.equal(loaded, 0);
  assert.equal(fixture.builderCalls, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('missing preexisting expected manifest refuses before builder and creates no output', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  fs.unlinkSync(fixture.plan.expectedManifestPath);
  let called = 0;
  const dependencies = { ...dependenciesFor(fixture), builder: { ...makeBuilder(fixture), build: async () => { called += 1; return []; } } };
  await assert.rejects(run(fixture, dependencies), /expected_manifest_missing/u);
  assert.equal(called, 0);
  assert.equal(fs.existsSync(fixture.outputRoot), false);
});

test('existing output root is preserved and never passed to the builder', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  fs.mkdirSync(fixture.outputRoot);
  const sentinel = writeFile(fixture.root, `out-${fixture.plan.taskId}/sentinel.txt`, Buffer.from('keep'));
  const before = fs.readFileSync(sentinel);
  let called = 0;
  const dependencies = { ...dependenciesFor(fixture), builder: { ...makeBuilder(fixture), build: async () => { called += 1; return []; } } };
  await assert.rejects(run(fixture, dependencies), /build_output_already_exists/u);
  assert.equal(called, 0);
  assert.deepEqual(fs.readFileSync(sentinel), before);
});

test('callback identity mismatch is refused before the bridge is invoked', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await assert.rejects(run(fixture, dependenciesFor(fixture, {
    appOutDir: path.join(fixture.outputRoot, 'wrong-unpacked'),
  })), /after_sign_context_mismatch/u);
  assert.equal(fixture.builderCalls, 1);
  assert.equal(fs.existsSync(path.join(fixture.outputRoot, 'win-unpacked')), true);
  assert.equal(fs.existsSync(path.join(fixture.outputRoot, 'wrong-unpacked')), false);
});

test('wrong architecture is refused before the bridge is invoked', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await assert.rejects(run(fixture, dependenciesFor(fixture, { arch: 0 })), /after_sign_context_mismatch/u);
  assert.equal(fixture.builderCalls, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, 'control', `${fixture.plan.taskId}-payload-pins.nsh`)), false);
});

test('missing afterSign observation cannot return complete', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await assert.rejects(run(fixture, dependenciesFor(fixture, { skipHook: true })), /after_sign_not_observed/u);
  assert.equal(fixture.builderCalls, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, 'control', `${fixture.plan.taskId}-payload-pins.nsh`)), false);
});

test('duplicate afterSign callback fails after the first bridge pass', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await assert.rejects(run(fixture, dependenciesFor(fixture, { secondHook: true })), /after_sign_called_multiple_times/u);
  assert.equal(fixture.builderCalls, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, 'control', `${fixture.plan.taskId}-payload-pins.nsh`)), true);
});

test('actual V4 bridge rejects an output that differs from the preexisting expected manifest', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await assert.rejects(run(fixture, dependenciesFor(fixture, { corruptRelative: 'resources.pak' })), /bridge_tree_content_mismatch/u);
  assert.equal(fixture.builderCalls, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, 'control', `${fixture.plan.taskId}-payload-pins.nsh`)), false);
});

test('task-local build environment strips signing secrets and hardlink/test overrides, then restores caller state', async t => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const previous = new Map();
  for (const [key, value] of Object.entries({ CSC_LINK: 'synthetic-secret-marker', WIN_CSC_KEY_PASSWORD: 'synthetic-password-marker', USE_HARD_LINKS: 'true', VITEST: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'true' })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const dependencies = dependenciesFor(fixture);
    const originalBuild = dependencies.builder.build;
    dependencies.builder.build = async (options, packager) => {
      assert.equal(process.env.CSC_LINK, undefined);
      assert.equal(process.env.WIN_CSC_KEY_PASSWORD, undefined);
      assert.equal(process.env.USE_HARD_LINKS, undefined);
      assert.equal(process.env.VITEST, undefined);
      assert.equal(process.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
      return originalBuild(options, packager);
    };
    await run(fixture, dependencies);
    assert.equal(process.env.CSC_LINK, 'synthetic-secret-marker');
    assert.equal(process.env.WIN_CSC_KEY_PASSWORD, 'synthetic-password-marker');
    assert.equal(process.env.USE_HARD_LINKS, 'true');
    assert.equal(process.env.VITEST, '1');
    assert.equal(process.env.CSC_IDENTITY_AUTO_DISCOVERY, 'true');
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
