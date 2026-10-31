import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWindowsNsisPayloadBridge } from './windows/build-nsis-payload-bridge.mjs';

const PROJECT_SOURCE_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'packaging/electron-builder.config.cjs',
  'scripts/stage-private-package.mjs',
]);
const PLAN_SCHEMA_VERSION = 2;
const APPLICATION_VERSION = '0.1.0';
const ELECTRON_VERSION = '44.9.3';
const ELECTRON_BUILDER_VERSION = '26.18.0';
const VENDOR_MEMBER_COUNT = 73;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_STAGE_FILES = 1024;
const MAX_STAGE_FILE_BYTES = 512 * 1024 * 1024;
const MAX_STAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ELECTRON_ARCHIVE_BYTES = 256 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/u;
const TASK_RE = /^[a-z0-9][a-z0-9-]{5,63}$/u;
const OWNER_ALLOWED = new Set(['S-1-5-18', 'S-1-5-32-544']);

// Project source pins are supplied by the separately reviewed, hash-pinned
// build plan. They are never derived from staged or built output.

const BRIDGE_SOURCE_PINS = Object.freeze([
  ['scripts/windows/assemble-nsis-expected-content.mjs', '4138e25f1b29a78e3395cfda2a17910694411220bbcb8f214319463be6a3b6af'],
  ['scripts/windows/write-nsis-payload-manifest.mjs', 'b9e887d0ce8ebb1756d54b28454bf2707a6c2fad241948630fe4bd42fde1f770'],
  ['scripts/windows/build-nsis-payload-bridge.mjs', '250a5047b6cd9aa32226f4605b52c433df8dd7ed601976359c614d75d569ee7d'],
]);

const BUILDER_SOURCE_PINS = Object.freeze([
  ['electron-builder/package.json', 'e1c7adf030ab298b3c4829f47239d789337e2a65329ed2f6ae63f64e9203316d'],
  ['electron-builder/out/index.js', '88bdbc15527e0345b44c9a92a6e2ae53f18ba182f383ef0b26a51befdda5e18e'],
  ['electron-builder/out/builder.js', 'ff70223a0872e050879e6c4f9947dccccdd99d3c11ed27bedb7c9642c8c4d246'],
  ['app-builder-lib/package.json', 'f61b13ff5b071b1b8968a09944912df3a9f064ef4ac32428f5e55e4941622f64'],
  ['app-builder-lib/out/index.js', '6faff0217276059f045039b314e691114263ea6e5fe3be0df11de442d6be6120'],
  ['app-builder-lib/out/core.js', 'a733c6296d6a80ce9a59a01b39e0bf4e611f609723b09f37d8c6bb1fffe7aec1'],
  ['app-builder-lib/out/packager.js', '420d958bc3db4c603a79acbd28b22b8de5ed480c2ceabf88d9cccf9ce0fc6e76'],
  ['app-builder-lib/out/platformPackager.js', 'f9d3e570e0c2f96f8c717e92aedf139c1b38a533269cffc620c46d2c2e9c1535'],
  ['app-builder-lib/out/fileTransformer.js', '0c4e855d5c9c6682a165c78dfc7206f35b17fd57321627cbb5259dce433c6ec9'],
  ['app-builder-lib/out/fileMatcher.js', 'fb3f2039238d502a84eb1a465c77e14115d79c64d0069a30dc6cd65409e28c10'],
  ['app-builder-lib/out/util/appFileCopier.js', '39472cb1e37cf13462ab8d298ad25e1c42bd4d18dff6765cfe3f3e7bdbc28840'],
  ['app-builder-lib/out/util/AppFileWalker.js', '5cb6cd95a74b31a8fd16b993e6caa83a7abe9b0f7dbdf5b5c631f87571cf23f9'],
  ['app-builder-lib/out/util/config/config.js', 'd2edce3e690c3bee805a8431d8256770d4f8c6dd7a3ea88ee28303101c4fe79f'],
  ['app-builder-lib/out/util/packageMetadata.js', 'e48c3a5b8723cdb312abd9aa0f72269e907b4edc2bd47bcfd83def96a3d0c529'],
  ['app-builder-lib/out/configuration.d.ts', '05827289b80b796d1746a60ea530a2c1264fc44a162ab869a9add5d954d6f13e'],
  ['app-builder-lib/out/configuration.js', '86c7e2055861e8bc3be5bb441b732a4cacd1a61e9f769fa0a411e4f940e8a469'],
  ['app-builder-lib/out/appInfo.js', 'd10fa4b8196933d6dd7480d107941671790062f87c81e9a7179463034779fc09'],
  ['app-builder-lib/out/packagerApi.js', 'a5ec2820b899dc4bc0c87d969ad9e3214a4675c25080568f06c613ab51b5ea38'],
  ['app-builder-lib/out/util/resolve.js', 'b6fdb156fed12c049ec19daba5d2a80ab52c72a163f7f53221044a7003906c2a'],
  ['app-builder-lib/out/node-module-collector/nodeModulesCollector.js', '2b72f9a1b37a99387dd743f4f879764a70fb827e8d470f40e14d8ecc6df02640'],
  ['app-builder-lib/out/util/yarn.js', 'ca802222639a465070e2c16fabb25abe440c9bca50c771a60aaafe1e2d1ec759'],
  ['app-builder-lib/out/util/rebuild.js', 'cc7b8a24442cda85d35b9fc3b894ffe45ee154089069fd6d41f48057930f93cf'],
  ['app-builder-lib/helpers/remote-rebuild.js', '156ed3ce6667ad4c73a3a29ac6eae5e9a70dbcf334ee1dd9c5fb63cb74033577'],
  ['app-builder-lib/out/winPackager.js', 'ac4ae48193db71cc50be3eeb6017d4e35f934637eac0ae7ef4e0c62fbd9db552'],
  ['app-builder-lib/out/electron/ElectronFramework.js', '33e70c0586a3bf8e718781f1b04ef9dda4a3e66c80f1989dd2885daeff936773'],
  ['app-builder-lib/out/targets/nsis/NsisTarget.js', 'f91b31d96cae53852f263ed89d2bc406ae2be7ff40ce3539b46e1cafe34a41b9'],
  ['app-builder-lib/out/targets/targetFactory.js', '52da7313d9c1f404fb164cd4969ba16aa800e5301908100d632d0046d51745df'],
  ['app-builder-lib/out/util/resEdit.js', '02ddb3dee119c3f8aaf6a427e7fea8b2765a61778e5db6f5e02df1cbb5b16cde'],
  ['builder-util/package.json', '36ff1cf73a2179b169eff079268db39929b265dad0e42721a3ed96aad896cca9'],
  ['builder-util/out/arch.js', '2a736be1d9e9c090267f66d797544ff7a5dfde02d10adaf202bbfc7e3c81af32'],
  ['builder-util/out/fs.js', '69c433388691bb4dde009f5d50f9650aeaa600ce4d8340c971ac3de98d6afa51'],
  ['builder-util-runtime/package.json', '9f249743b25861f34d64878df8db522f0365d7e621b53b1982bb8bcab4172f78'],
  ['builder-util-runtime/out/index.js', '140b927a94d361c3298a019ba7cf64f355b8ebf40e04b748be3c5b30ceb1e0c6'],
  ['electron-publish/package.json', '053b342032667f1b0bd28bbaa3c66aeb7ccede210fdaa30c27448a18fb8277db'],
  ['electron-publish/out/index.js', '81ccec73b7b964bfdd8e2c0817de2d52ff30be178f582b67b24e23f2c507a26a'],
  ['@electron/rebuild/package.json', '2bee82805966cb218afa7599b90807099840a777a179518321334cbeb1406a4f'],
  ['@electron/rebuild/lib/module-walker.js', 'ff31aefac31ec065244f1bd526091b6dc9177e6cac561f5778196b21634cd9e0'],
  ['@electron/rebuild/lib/rebuild.js', '582ae0823a1b9098312505e8b16a539ece277f2a817812c9f9dbecbc2801b7b6'],
  ['app-builder-lib/out/node-module-collector/index.js', 'b174cb8ed03e40e187f40f800632a2417160cb665a09aae4209129c3d72454ef'],
  ['app-builder-lib/out/packager.d.ts', '73f5b87c8d3ddfd959cba9a6e8d4a5c5a2175a25e5e5ac7b9598146b20103504'],
  ['app-builder-lib/out/index.d.ts', '104c3e1407a84b4e326b812940abf185f6ae03ab6f5579811ca97117b6006ac5'],
]);

const PLAN_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'taskId', 'driverSha256', 'sourceRevision', 'applicationVersion', 'electronVersion',
  'electronBuilderVersion', 'privateRoot', 'privateRootReceiptSha256', 'projectDir', 'projectSourcePins', 'stageRoot',
  'appDir', 'stageManifestPath', 'stageManifestSha256', 'payloadManifestPath', 'payloadManifestSha256',
  'electronZipPath', 'electronZipSha256', 'vendorMemberManifestPath', 'vendorMemberManifestSha256',
  'resourceEditReceiptPath', 'resourceEditReceiptSha256', 'editedExecutablePath', 'editedExecutableSha256',
  'expectedManifestPath', 'expectedManifestSha256', 'builderRoot', 'expectedContext',
]);

const CONTEXT_KEYS = Object.freeze([
  'sourceRevision', 'applicationVersion', 'electronVersion', 'electronBuilderVersion',
  'stageManifestSha256', 'stagedPayloadManifestSha256', 'vendorArchiveSha256',
]);

const fail = code => { throw new Error(code); };
const STAGE_DEPENDENCY_KEYS = Object.freeze([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'bundleDependencies', 'bundledDependencies',
]);
const STAGE_BUNDLE_DEPENDENCY_KEYS = new Set(['bundleDependencies', 'bundledDependencies']);
const SOURCE_CONFIG_HOOK_KEYS = Object.freeze([
  'beforePack', 'afterExtract', 'afterPack', 'afterSign', 'artifactBuildStarted',
  'artifactBuildCompleted', 'afterAllArtifactBuild', 'msiProjectCreated',
  'appxManifestCreated', 'onNodeModuleFile', 'beforeBuild', 'electronDist',
]);
const skipDependencyInstallForEmptyStage = async () => false;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toUpperCase() === path.resolve(right).toUpperCase()
  : path.resolve(left) === path.resolve(right);

function exactKeys(value, expected, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) fail(code);
}

function checkHash(value, code) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail(code);
}

function validateProjectSourcePins(value) {
  if (!Array.isArray(value) || value.length !== PROJECT_SOURCE_PATHS.length) fail('project_source_pin_list_rejected');
  for (let index = 0; index < PROJECT_SOURCE_PATHS.length; index += 1) {
    const pin = value[index];
    exactKeys(pin, ['path', 'sha256'], 'project_source_pin_contract_rejected');
    if (pin.path !== PROJECT_SOURCE_PATHS[index]) fail('project_source_pin_pathlist_rejected');
    checkHash(pin.sha256, 'project_source_pin_hash_rejected');
  }
  return value;
}

function within(candidate, parent) {
  const full = path.resolve(candidate);
  const base = path.resolve(parent);
  if (samePath(full, base)) return true;
  const relative = path.relative(base, full);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function assertNoReparsePath(fullPath, allowMissingLeaf = false) {
  const full = path.resolve(fullPath);
  const parsed = path.parse(full);
  let current = parsed.root;
  const parts = full.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return;
      fail('path_missing_or_unreadable');
    }
    if (stat.isSymbolicLink()) fail('reparse_path_rejected');
    let real;
    try { real = fs.realpathSync.native(current); } catch { fail('path_unreadable'); }
    if (!samePath(real, current)) fail('path_alias_rejected');
    if (index < parts.length - 1 && !stat.isDirectory()) fail('path_parent_not_directory');
  }
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':');
}

function stableRead(fullPath, maxBytes = MAX_JSON_BYTES) {
  let fd;
  try {
    const full = path.resolve(fullPath);
    assertNoReparsePath(full);
    const beforePath = fs.lstatSync(full);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1 ||
        beforePath.size < 0 || beforePath.size > maxBytes) fail('regular_input_file_rejected');
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const beforeFd = fs.fstatSync(fd);
    if (!beforeFd.isFile() || statSignature(beforeFd) !== statSignature(beforePath)) fail('input_changed_before_read');
    const chunks = [];
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      if (bytes > maxBytes) fail('input_size_limit');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(full);
    if (statSignature(afterFd) !== statSignature(beforeFd) ||
        statSignature(afterPath) !== statSignature(beforePath) || afterPath.isSymbolicLink() ||
        bytes !== beforeFd.size || !samePath(fs.realpathSync.native(full), full)) fail('input_changed_during_read');
    return { bytes: Buffer.concat(chunks, bytes), stat: afterFd };
  } catch (error) {
    if (typeof error?.message === 'string' && /^[a-z0-9_]+$/u.test(error.message)) throw error;
    fail('input_read_failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function stableHash(fullPath, expectedSha256, expectedSize = null, maxBytes = MAX_STAGE_FILE_BYTES) {
  checkHash(expectedSha256, 'hash_pin_invalid');
  let fd;
  try {
    const full = path.resolve(fullPath);
    assertNoReparsePath(full);
    const beforePath = fs.lstatSync(full);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1 ||
        beforePath.size < 0 || beforePath.size > maxBytes || (expectedSize !== null && beforePath.size !== expectedSize)) fail('regular_input_file_rejected');
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const beforeFd = fs.fstatSync(fd);
    if (!beforeFd.isFile() || statSignature(beforeFd) !== statSignature(beforePath)) fail('input_changed_before_hash');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      if (size > maxBytes) fail('input_size_limit');
      hash.update(buffer.subarray(0, count));
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(full);
    if (statSignature(afterFd) !== statSignature(beforeFd) || statSignature(afterPath) !== statSignature(beforePath) ||
        afterPath.isSymbolicLink() || size !== beforeFd.size || !samePath(fs.realpathSync.native(full), full)) fail('input_changed_during_hash');
    if (hash.digest('hex') !== expectedSha256) fail('input_hash_mismatch');
    return { sizeBytes: size, signature: statSignature(afterFd) };
  } catch (error) {
    if (typeof error?.message === 'string' && /^[a-z0-9_]+$/u.test(error.message)) throw error;
    fail('input_hash_failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readJsonPinned(fullPath, expectedSha256, maxBytes = MAX_JSON_BYTES) {
  const result = stableRead(fullPath, maxBytes);
  if (sha256(result.bytes) !== expectedSha256) fail('json_hash_mismatch');
  const text = result.bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(result.bytes) || text.startsWith('\uFEFF')) fail('json_encoding_rejected');
  try { return { value: JSON.parse(text), bytes: result.bytes, stat: result.stat }; }
  catch { fail('json_parse_rejected'); }
}

function assertAbsolutePhysicalDirectory(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !samePath(value, path.resolve(value))) fail(code);
  const full = path.resolve(value);
  assertNoReparsePath(full);
  const stat = fs.lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(full), full)) fail(code);
  return full;
}

function assertAbsolutePhysicalFile(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !samePath(value, path.resolve(value))) fail(code);
  const full = path.resolve(value);
  assertNoReparsePath(full);
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync.native(full), full)) fail(code);
  return full;
}

function validateExpectedContext(plan) {
  exactKeys(plan.expectedContext, CONTEXT_KEYS, 'expected_context_contract_rejected');
  const expected = {
    sourceRevision: plan.sourceRevision,
    applicationVersion: APPLICATION_VERSION,
    electronVersion: ELECTRON_VERSION,
    electronBuilderVersion: ELECTRON_BUILDER_VERSION,
    stageManifestSha256: plan.stageManifestSha256,
    stagedPayloadManifestSha256: plan.payloadManifestSha256,
    vendorArchiveSha256: plan.electronZipSha256,
  };
  for (const key of CONTEXT_KEYS) {
    if (plan.expectedContext[key] !== expected[key]) fail('expected_context_binding_rejected');
  }
}

function validatePrivateRootReceipt(plan, root, controlRoot) {
  const receiptPath = path.join(controlRoot, 'owned-root.private.json');
  const receipt = readJsonPinned(receiptPath, plan.privateRootReceiptSha256, 256 * 1024).value;
  const keys = ['schemaVersion', 'status', 'createdExclusive', 'root', 'ownerUsername', 'ownerSid',
    'protectedDacl', 'allowedReadSids', 'allowedWriteSids', 'unexpectedAceCount'];
  exactKeys(receipt, keys, 'owned_root_receipt_contract_rejected');
  const sidList = values => Array.isArray(values) && values.every(value => typeof value === 'string');
  const expectedSids = [receipt.ownerSid, ...OWNER_ALLOWED].sort();
  if (receipt.schemaVersion !== 1 || receipt.status !== 'verified' || receipt.createdExclusive !== true ||
      receipt.root !== root || receipt.ownerUsername !== os.userInfo().username ||
      typeof receipt.ownerSid !== 'string' || !/^S-1-5-21-(?:\d+-){2}\d+-\d+$/u.test(receipt.ownerSid) ||
      receipt.protectedDacl !== true || receipt.unexpectedAceCount !== 0 ||
      !sidList(receipt.allowedReadSids) || !sidList(receipt.allowedWriteSids) ||
      JSON.stringify([...receipt.allowedReadSids].sort()) !== JSON.stringify(expectedSids) ||
      JSON.stringify([...receipt.allowedWriteSids].sort()) !== JSON.stringify(expectedSids)) fail('owned_root_receipt_rejected');
}

function parsePlan(planBytes, expectedPlanSha256) {
  checkHash(expectedPlanSha256, 'plan_hash_pin_invalid');
  if (!Buffer.isBuffer(planBytes) || planBytes.length === 0 || planBytes.length > MAX_PLAN_BYTES ||
      sha256(planBytes) !== expectedPlanSha256) fail('plan_hash_mismatch');
  const text = planBytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(planBytes) || text.startsWith('\uFEFF')) fail('plan_encoding_rejected');
  let plan;
  try { plan = JSON.parse(text); } catch { fail('plan_json_rejected'); }
  exactKeys(plan, PLAN_KEYS, 'plan_contract_rejected');
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION || plan.kind !== 'tokenelo-windows-private-directory-build-plan' ||
      typeof plan.taskId !== 'string' || !TASK_RE.test(plan.taskId) ||
      typeof plan.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/u.test(plan.sourceRevision) ||
      plan.applicationVersion !== APPLICATION_VERSION ||
      plan.electronVersion !== ELECTRON_VERSION || plan.electronBuilderVersion !== ELECTRON_BUILDER_VERSION) fail('plan_identity_rejected');
  for (const key of ['driverSha256', 'privateRootReceiptSha256', 'stageManifestSha256', 'payloadManifestSha256',
    'electronZipSha256', 'vendorMemberManifestSha256', 'resourceEditReceiptSha256',
    'editedExecutableSha256', 'expectedManifestSha256']) checkHash(plan[key], 'plan_pin_invalid');
  validateProjectSourcePins(plan.projectSourcePins);
  validateExpectedContext(plan);
  return plan;
}

export function verifyFrozenSources(plan, driverRoot) {
  const projectRoot = assertAbsolutePhysicalDirectory(plan.projectDir, 'project_root_rejected');
  const builderRoot = assertAbsolutePhysicalDirectory(plan.builderRoot, 'builder_root_rejected');
  const projectPins = validateProjectSourcePins(plan.projectSourcePins);
  const pinsByPath = new Map(projectPins.map(pin => [pin.path, pin.sha256]));
  for (const [relative, expected] of projectPins.map(pin => [pin.path, pin.sha256])) {
    stableHash(path.join(projectRoot, relative), expected);
  }
  for (const [relative, expected] of BRIDGE_SOURCE_PINS) stableHash(path.join(driverRoot, relative), expected);
  for (const [relative, expected] of BUILDER_SOURCE_PINS) stableHash(path.join(builderRoot, relative), expected);
  const appPackage = readJsonPinned(path.join(projectRoot, 'package.json'), pinsByPath.get('package.json'), 1024 * 1024).value;
  const lock = readJsonPinned(path.join(projectRoot, 'package-lock.json'), pinsByPath.get('package-lock.json'), 4 * 1024 * 1024).value;
  const packageBuilder = readJsonPinned(path.join(builderRoot, 'electron-builder', 'package.json'), BUILDER_SOURCE_PINS[0][1], 1024 * 1024).value;
  const packageLib = readJsonPinned(path.join(builderRoot, 'app-builder-lib', 'package.json'), BUILDER_SOURCE_PINS[3][1], 1024 * 1024).value;
  const packageUtil = readJsonPinned(path.join(builderRoot, 'builder-util', 'package.json'), BUILDER_SOURCE_PINS[28][1], 1024 * 1024).value;
  const packageRebuild = readJsonPinned(path.join(builderRoot, '@electron', 'rebuild', 'package.json'), BUILDER_SOURCE_PINS[35][1], 1024 * 1024).value;
  if (appPackage.name !== 'tokenelo' || appPackage.version !== APPLICATION_VERSION ||
      lock.packages?.['node_modules/electron']?.version !== ELECTRON_VERSION ||
      lock.packages?.['node_modules/electron-builder']?.version !== ELECTRON_BUILDER_VERSION ||
      packageBuilder.version !== ELECTRON_BUILDER_VERSION || packageLib.version !== ELECTRON_BUILDER_VERSION ||
      packageUtil.version !== '26.16.0' || packageRebuild.version !== '4.2.1') fail('toolchain_version_rejected');
  return { projectRoot, builderRoot };
}

function validateRelativePath(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\\') ||
      relative.startsWith('/') || /^[A-Za-z]:/u.test(relative) || /[\u0000-\u001f<>:"|?*]/u.test(relative) ||
      relative.normalize('NFC') !== relative) fail('stage_path_rejected');
  const parts = relative.split('/');
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || reserved.test(part))) fail('stage_path_rejected');
  return parts;
}

function assertDependencyFreeStagePackage(stagedPackage) {
  for (const key of STAGE_DEPENDENCY_KEYS) {
    if (!Object.hasOwn(stagedPackage, key)) continue;
    const value = stagedPackage[key];
    const isEmptyContainer = value !== null && typeof value === 'object' && Object.keys(value).length === 0;
    const isDisabledBundle = STAGE_BUNDLE_DEPENDENCY_KEYS.has(key) && value === false;
    if (!isEmptyContainer && !isDisabledBundle) fail('stage_dependencies_rejected');
  }
}

function verifyPayloadStage(plan, stageRoot, appDir) {
  const stageDoc = readJsonPinned(plan.stageManifestPath, plan.stageManifestSha256, MAX_JSON_BYTES).value;
  const payloadDoc = readJsonPinned(plan.payloadManifestPath, plan.payloadManifestSha256, MAX_JSON_BYTES).value;
  if (stageDoc.schemaVersion !== 1 || stageDoc.kind !== 'tokenelo-private-electron-stage' ||
      stageDoc.privacy !== 'private' || stageDoc.releasePolicy?.publish !== 'never' ||
      stageDoc.source?.revision !== plan.sourceRevision || stageDoc.source?.dirty !== false ||
      stageDoc.application?.name !== 'tokenelo' || stageDoc.application?.version !== APPLICATION_VERSION ||
      stageDoc.application?.private !== true || stageDoc.application?.type !== 'module' ||
      stageDoc.application?.main !== 'dist/tray/main.js' ||
      stageDoc.application?.electronVersion !== ELECTRON_VERSION ||
      stageDoc.application?.electronBuilderVersion !== ELECTRON_BUILDER_VERSION ||
      stageDoc.payload?.manifest !== path.basename(plan.payloadManifestPath) ||
      stageDoc.payload?.manifestSha256 !== plan.payloadManifestSha256 ||
      payloadDoc.schemaVersion !== 1 || payloadDoc.root !== 'app' || !Array.isArray(payloadDoc.files) ||
      stageDoc.payload?.fileCount !== payloadDoc.files.length || payloadDoc.files.length < 1 ||
      payloadDoc.files.length > MAX_STAGE_FILES ||
      stageDoc.payload?.sha256 !== sha256(Buffer.from(JSON.stringify({ schemaVersion: 1, files: payloadDoc.files }), 'utf8'))) fail('stage_manifest_binding_rejected');
  if (!samePath(appDir, path.join(stageRoot, 'app'))) fail('stage_app_path_rejected');

  const expected = new Map();
  let total = 0;
  let lastPath = '';
  for (const entry of payloadDoc.files) {
    exactKeys(entry, ['path', 'sizeBytes', 'sha256'], 'stage_payload_file_contract_rejected');
    validateRelativePath(entry.path);
    checkHash(entry.sha256, 'stage_payload_file_hash_rejected');
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.path <= lastPath || expected.has(entry.path)) fail('stage_payload_file_rejected');
    lastPath = entry.path;
    total += entry.sizeBytes;
    if (!Number.isSafeInteger(total) || total > MAX_STAGE_BYTES) fail('stage_payload_size_rejected');
    expected.set(entry.path, entry);
  }
  const actual = new Set();
  function walk(dir, relative = '') {
    assertNoReparsePath(dir);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.toLowerCase() === 'node_modules') fail('stage_node_modules_rejected');
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const segments = validateRelativePath(childRelative);
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) fail('stage_reparse_entry_rejected');
      if (stat.isDirectory()) walk(full, childRelative);
      else if (stat.isFile()) {
        const record = expected.get(childRelative);
        if (!record || stat.nlink !== 1 || stat.size !== record.sizeBytes) fail('stage_payload_tree_mismatch');
        stableHash(full, record.sha256, record.sizeBytes, MAX_STAGE_FILE_BYTES);
        actual.add(childRelative);
      } else fail('stage_special_entry_rejected');
    }
  }
  walk(appDir);
  if (actual.size !== expected.size || [...expected.keys()].some(file => !actual.has(file))) fail('stage_payload_tree_mismatch');
  const packageEntry = expected.get('package.json');
  if (!packageEntry) fail('stage_package_missing');
  const stagedPackage = JSON.parse(stableRead(path.join(appDir, 'package.json'), 1024 * 1024).bytes.toString('utf8'));
  if (stagedPackage.name !== 'tokenelo' || stagedPackage.version !== APPLICATION_VERSION || stagedPackage.private !== true ||
      stagedPackage.type !== 'module' || stagedPackage.main !== 'dist/tray/main.js') fail('stage_package_identity_rejected');
  assertDependencyFreeStagePackage(stagedPackage);
  return packageEntry.sha256;
}

function assertConfigShape(sourceConfig, appDir, outputRoot, electronZipPath) {
  if (sourceConfig.appId !== 'com.elostudios.tokenelo' || sourceConfig.productName !== 'Tokenelo' ||
      sourceConfig.buildVersion !== APPLICATION_VERSION || sourceConfig.buildNumber !== '0' ||
      sourceConfig.electronVersion !== ELECTRON_VERSION || sourceConfig.asar !== false || sourceConfig.publish !== null ||
      sourceConfig.win?.signExecutable !== false || sourceConfig.win?.requestedExecutionLevel !== 'asInvoker' ||
      sourceConfig.nsis?.allowElevation !== false || sourceConfig.nsis?.packElevateHelper !== false ||
      sourceConfig.nsis?.perMachine !== false || sourceConfig.extraMetadata !== undefined ||
      sourceConfig.extraFiles !== undefined || sourceConfig.extraResources !== undefined) fail('source_build_config_rejected');
  if (SOURCE_CONFIG_HOOK_KEYS.some(key => sourceConfig[key] !== undefined) || sourceConfig.nodeGypRebuild !== undefined) fail('source_build_config_rejected');
  if (sourceConfig.win?.signAndEditExecutable === false || sourceConfig.forceCodeSigning === true) fail('resource_edit_policy_rejected');
  const config = {
    ...sourceConfig,
    publish: null,
    buildVersion: APPLICATION_VERSION,
    buildNumber: '0',
    electronVersion: ELECTRON_VERSION,
    electronDist: electronZipPath,
    asar: false,
    nodeGypRebuild: false,
    // npmRebuild must be true to reach beforeBuild. The hook returning false marks this empty stage external and skips dependency collection/rebuild.
    npmRebuild: true,
    beforeBuild: skipDependencyInstallForEmptyStage,
    directories: { ...sourceConfig.directories, app: appDir, output: outputRoot },
    win: { ...sourceConfig.win, target: ['dir'], defaultArch: 'x64', signExecutable: false },
  };
  if (config.extraMetadata !== undefined || config.extraFiles !== undefined || config.extraResources !== undefined ||
      config.afterPack !== undefined || config.beforePack !== undefined || config.publish !== null ||
      config.nodeGypRebuild !== false || config.npmRebuild !== true ||
      config.beforeBuild !== skipDependencyInstallForEmptyStage || config.asar !== false || config.buildNumber !== '0' ||
      config.directories.app !== appDir || config.directories.output !== outputRoot ||
      JSON.stringify(config.win.target) !== '["dir"]' || config.win.signExecutable !== false) fail('effective_build_config_rejected');
  return config;
}

function validateManifestBeforeBuild(plan, privateRoot, outputRoot, controlRoot) {
  try { fs.lstatSync(path.resolve(plan.expectedManifestPath)); }
  catch (error) { if (error?.code === 'ENOENT') fail('expected_manifest_missing'); fail('expected_manifest_unreadable'); }
  const expectedPath = assertAbsolutePhysicalFile(plan.expectedManifestPath, 'expected_manifest_missing');
  const manifest = readJsonPinned(expectedPath, plan.expectedManifestSha256, MAX_JSON_BYTES).value;
  const context = plan.expectedContext;
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'tokenelo-windows-expected-content-manifest' ||
      manifest.platform !== 'win32' || manifest.architecture !== 'x64' || manifest.outputDirectoryName !== 'win-unpacked' ||
      manifest.packageIdentity !== 'com.elostudios.tokenelo' || manifest.applicationPackageName !== 'tokenelo' ||
      manifest.applicationVersion !== context.applicationVersion || manifest.electronVersion !== context.electronVersion ||
      manifest.electronBuilderVersion !== context.electronBuilderVersion || manifest.sourceRevision !== context.sourceRevision ||
      manifest.stageManifestSha256 !== context.stageManifestSha256 ||
      manifest.stagedPayloadManifestSha256 !== context.stagedPayloadManifestSha256 ||
      manifest.vendorArchiveSha256 !== context.vendorArchiveSha256 || !Array.isArray(manifest.files) ||
      manifest.files.length < 1 || manifest.files.length > MAX_STAGE_FILES) fail('expected_manifest_context_rejected');
  const exe = manifest.files.find(entry => entry?.relativePath === 'Tokenelo.exe');
  const exeStat = fs.lstatSync(plan.editedExecutablePath);
  if (!exe || exe.sha256 !== plan.editedExecutableSha256 || exe.sizeBytes !== exeStat.size) fail('expected_manifest_executable_binding_rejected');
  if (within(expectedPath, outputRoot) || within(outputRoot, expectedPath) || !within(expectedPath, controlRoot) || within(expectedPath, privateRoot) === false) {
    fail('expected_manifest_location_rejected');
  }
  return manifest.files.length;
}

function ensurePaths(plan, driverRoot) {
  const privateRoot = assertAbsolutePhysicalDirectory(plan.privateRoot, 'private_root_rejected');
  const controlRoot = assertAbsolutePhysicalDirectory(path.join(privateRoot, 'control'), 'control_root_rejected');
  const projectRoot = assertAbsolutePhysicalDirectory(plan.projectDir, 'project_root_rejected');
  const stageRoot = assertAbsolutePhysicalDirectory(plan.stageRoot, 'stage_root_rejected');
  const appDir = assertAbsolutePhysicalDirectory(plan.appDir, 'app_stage_root_rejected');
  const builderRoot = assertAbsolutePhysicalDirectory(plan.builderRoot, 'builder_root_rejected');
  if (!samePath(appDir, path.join(stageRoot, 'app'))) fail('stage_app_path_rejected');
  const outputRoot = path.join(privateRoot, `out-${plan.taskId}`);
  assertNoReparsePath(outputRoot, true);
  try { fs.lstatSync(outputRoot); fail('build_output_already_exists'); }
  catch (error) { if (error?.message === 'build_output_already_exists') throw error; if (error?.code !== 'ENOENT') fail('build_output_path_unreadable'); }
  const pinIncludePath = path.join(controlRoot, `${plan.taskId}-payload-pins.nsh`);
  assertNoReparsePath(pinIncludePath, true);
  try { fs.lstatSync(pinIncludePath); fail('build_pin_already_exists'); }
  catch (error) { if (error?.message === 'build_pin_already_exists') throw error; if (error?.code !== 'ENOENT') fail('build_pin_path_unreadable'); }
  validatePrivateRootReceipt(plan, privateRoot, controlRoot);
  const fileInputs = [
    ['stageManifestPath', plan.stageManifestSha256], ['payloadManifestPath', plan.payloadManifestSha256],
    ['electronZipPath', plan.electronZipSha256], ['vendorMemberManifestPath', plan.vendorMemberManifestSha256],
    ['resourceEditReceiptPath', plan.resourceEditReceiptSha256], ['editedExecutablePath', plan.editedExecutableSha256],
  ];
  for (const [key, hash] of fileInputs) {
    const full = assertAbsolutePhysicalFile(plan[key], `${key}_rejected`);
    stableHash(full, hash);
    if (within(full, outputRoot) || within(outputRoot, full)) fail('build_output_input_overlap');
  }
  for (const root of [projectRoot, stageRoot, builderRoot, driverRoot]) {
    if (within(outputRoot, root) || within(root, outputRoot)) fail('build_output_root_overlap');
  }
  for (const file of [plan.electronZipPath, plan.vendorMemberManifestPath, plan.resourceEditReceiptPath,
    plan.editedExecutablePath, plan.expectedManifestPath]) {
    if (within(file, outputRoot) || within(outputRoot, file)) fail('build_output_input_overlap');
  }
  const vendor = readJsonPinned(plan.vendorMemberManifestPath, plan.vendorMemberManifestSha256, MAX_JSON_BYTES).value;
  const zipStat = fs.lstatSync(plan.electronZipPath);
  if (!Number.isSafeInteger(zipStat.size) || zipStat.size < 1 || zipStat.size > MAX_ELECTRON_ARCHIVE_BYTES ||
      vendor.archiveSha256 !== plan.electronZipSha256 || vendor.archiveBytes !== zipStat.size ||
      !Array.isArray(vendor.files) || vendor.files.length !== VENDOR_MEMBER_COUNT) fail('vendor_manifest_binding_rejected');
  let vendorTotal = 0;
  const vendorNames = new Set();
  for (const row of vendor.files) {
    if (row === null || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).some(key => !['path', 'sizeBytes', 'sha256', 'peHeader'].includes(key)) ||
        !['path', 'sizeBytes', 'sha256'].every(key => Object.hasOwn(row, key))) fail('vendor_row_contract_rejected');
    validateRelativePath(row.path);
    checkHash(row.sha256, 'vendor_row_hash_rejected');
    if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > MAX_STAGE_FILE_BYTES ||
        vendorNames.has(row.path.normalize('NFC').toUpperCase())) fail('vendor_row_rejected');
    vendorNames.add(row.path.normalize('NFC').toUpperCase());
    vendorTotal += row.sizeBytes;
    if (!Number.isSafeInteger(vendorTotal) || vendorTotal > MAX_STAGE_BYTES) fail('vendor_total_size_rejected');
  }
  stableHash(plan.electronZipPath, plan.electronZipSha256, zipStat.size, MAX_ELECTRON_ARCHIVE_BYTES);
  stableHash(plan.editedExecutablePath, plan.editedExecutableSha256);
  const stagedPackageSha256 = verifyPayloadStage(plan, stageRoot, appDir);
  const expectedContentFileCount = validateManifestBeforeBuild(plan, privateRoot, outputRoot, controlRoot);
  return { privateRoot, controlRoot, projectRoot, stageRoot, appDir, stagedPackageSha256, builderRoot, outputRoot, pinIncludePath, expectedContentFileCount };
}

function loadPinnedConfig(projectRoot) {
  const configPath = path.join(projectRoot, 'packaging', 'electron-builder.config.cjs');
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));
  return requireFromProject(configPath);
}

async function loadAppBuilderLib(builderRoot) {
  const requireFromBuilder = createRequire(path.join(builderRoot, 'app-builder-lib', 'package.json'));
  return requireFromBuilder('app-builder-lib');
}

function readWorkspaceFreePackage(packagePath, expectedSha256, reason) {
  const value = readJsonPinned(packagePath, expectedSha256, 1024 * 1024).value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${reason}_package_rejected`);
  if (Object.hasOwn(value, 'workspaces')) fail(`${reason}_workspaces_rejected`);
  return value;
}

export function createIsolatedSingleProjectPackager(Packager, scope) {
  if (typeof Packager !== 'function' || typeof Packager.prototype?.getWorkspaceRoot !== 'function') fail('app_builder_packager_api_rejected');
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) fail('builder_workspace_scope_rejected');
  const projectRoot = assertAbsolutePhysicalDirectory(scope.projectDir, 'builder_project_root_rejected');
  const stageRoot = assertAbsolutePhysicalDirectory(scope.stageRoot, 'builder_stage_root_rejected');
  const appDir = assertAbsolutePhysicalDirectory(scope.appDir, 'builder_app_dir_rejected');
  if (!samePath(appDir, path.join(stageRoot, 'app')) || within(projectRoot, stageRoot) || within(stageRoot, projectRoot)) fail('builder_workspace_scope_rejected');
  checkHash(scope.projectPackageSha256, 'project_package_pin_invalid');
  checkHash(scope.stagedPackageSha256, 'stage_package_pin_invalid');
  const projectPackagePath = path.join(projectRoot, 'package.json');
  const stagedPackagePath = path.join(appDir, 'package.json');
  const projectPackageSha256 = scope.projectPackageSha256;
  const stagedPackageSha256 = scope.stagedPackageSha256;

  readWorkspaceFreePackage(projectPackagePath, projectPackageSha256, 'project');
  readWorkspaceFreePackage(stagedPackagePath, stagedPackageSha256, 'stage');

  return class IsolatedSingleProjectPackager extends Packager {
    async getWorkspaceRoot() {
      const configuredProjectDir = this.options?.projectDir;
      const configuredAppDir = this.options?.config?.directories?.app;
      const currentAppDir = this.appDir;
      if (typeof this.projectDir !== 'string' || !samePath(this.projectDir, projectRoot) ||
          typeof configuredProjectDir !== 'string' || !samePath(configuredProjectDir, projectRoot) ||
          typeof configuredAppDir !== 'string' || !samePath(configuredAppDir, appDir) ||
          typeof currentAppDir !== 'string' || (!samePath(currentAppDir, projectRoot) && !samePath(currentAppDir, appDir))) {
        fail('builder_workspace_scope_rejected');
      }
      assertAbsolutePhysicalDirectory(projectRoot, 'builder_project_root_rejected');
      assertAbsolutePhysicalDirectory(stageRoot, 'builder_stage_root_rejected');
      assertAbsolutePhysicalDirectory(appDir, 'builder_app_dir_rejected');
      readWorkspaceFreePackage(projectPackagePath, projectPackageSha256, 'project');
      readWorkspaceFreePackage(stagedPackagePath, stagedPackageSha256, 'stage');
      return projectRoot;
    }
  };
}

export async function buildWithIsolatedSingleProjectPackager(builder, options, scope) {
  if (builder === null || typeof builder !== 'object' || typeof builder.build !== 'function' ||
      typeof builder.Packager !== 'function' || typeof builder.Packager.prototype?.getWorkspaceRoot !== 'function') {
    fail('app_builder_api_rejected');
  }
  const IsolatedPackager = createIsolatedSingleProjectPackager(builder.Packager, scope);
  let packager;
  try { packager = new IsolatedPackager(options); }
  catch { fail('app_builder_packager_constructor_rejected'); }
  if (!(packager instanceof builder.Packager)) fail('app_builder_packager_constructor_rejected');
  const artifactPaths = await builder.build(options, packager);
  if (!Array.isArray(artifactPaths)) fail('electron_builder_result_rejected');
  return { packager, artifactPaths };
}

function withTaskEnvironment(operation) {
  const names = [
    'CSC_LINK', 'CSC_INSTALLER_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'CSC_FOR_PULL_REQUEST',
    'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_NAME', 'USE_HARD_LINKS', 'VITEST',
  ];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  const previousDiscovery = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return Promise.resolve().then(operation).finally(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    if (previousDiscovery === undefined) delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
    else process.env.CSC_IDENTITY_AUTO_DISCOVERY = previousDiscovery;
  });
}

function validateBridgeResult(result, plan, appOutDir, pinIncludePath, expectedContentFileCount) {
  if (result === null || typeof result !== 'object' || result.targetPlatform !== 'win32' ||
      result.targetArchitecture !== 'x64' || result.sourceManifestSha256 !== plan.expectedManifestSha256 ||
      !Number.isSafeInteger(result.sourceFileCount) || result.sourceFileCount !== expectedContentFileCount ||
      result.inventoryRelativePath !== 'resources/app/windows-payload-inventory.json' ||
      result.templatePath !== path.join(appOutDir, 'resources', 'app', 'windows-payload-manifest.template.json') ||
      typeof result.inventorySha256 !== 'string' || !HASH_RE.test(result.inventorySha256) ||
      typeof result.templateSha256 !== 'string' || !HASH_RE.test(result.templateSha256) ||
      result.pinIncludePath !== pinIncludePath || typeof result.pinIncludeSha256 !== 'string' ||
      !HASH_RE.test(result.pinIncludeSha256) || result.fullRootReady !== false || result.restoreInputAllowed !== false) {
    fail('bridge_completion_contract_rejected');
  }
}

export async function runPrivateDirectoryBuild({ planBytes, expectedPlanSha256, dependencies = {} }) {
  const plan = parsePlan(planBytes, expectedPlanSha256);
  stableHash(fileURLToPath(import.meta.url), plan.driverSha256);
  const driverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const paths = ensurePaths(plan, driverRoot);
  verifyFrozenSources(plan, driverRoot);
  const expectedManifestBefore = stableHash(plan.expectedManifestPath, plan.expectedManifestSha256);
  const outputAppDir = path.join(paths.outputRoot, 'win-unpacked');
  const sourceConfig = loadPinnedConfig(paths.projectRoot);
  const config = assertConfigShape(sourceConfig, paths.appDir, paths.outputRoot, path.resolve(plan.electronZipPath));

  let afterSignCalls = 0;
  let bridgeResult = null;
  let archEnum = null;
  config.afterSign = async context => {
    afterSignCalls += 1;
    if (afterSignCalls !== 1) fail('after_sign_called_multiple_times');
    if (context?.electronPlatformName !== 'win32' || context?.arch === undefined ||
        archEnum?.[context.arch] !== 'x64' ||
        typeof context.appOutDir !== 'string' || !samePath(context.appOutDir, outputAppDir)) fail('after_sign_context_mismatch');
    assertAbsolutePhysicalDirectory(context.appOutDir, 'after_sign_output_not_physical');
    bridgeResult = buildWindowsNsisPayloadBridge({
      winUnpackedRoot: context.appOutDir,
      expectedManifestPath: plan.expectedManifestPath,
      expectedManifestSha256: plan.expectedManifestSha256,
      expectedContext: {
        platform: 'win32',
        architecture: 'x64',
        outputDirectoryName: 'win-unpacked',
        packageIdentity: 'com.elostudios.tokenelo',
        applicationPackageName: 'tokenelo',
        applicationVersion: plan.expectedContext.applicationVersion,
        electronVersion: plan.expectedContext.electronVersion,
        electronBuilderVersion: plan.expectedContext.electronBuilderVersion,
        sourceRevision: plan.expectedContext.sourceRevision,
        stageManifestSha256: plan.expectedContext.stageManifestSha256,
        stagedPayloadManifestSha256: plan.expectedContext.stagedPayloadManifestSha256,
        vendorArchiveSha256: plan.expectedContext.vendorArchiveSha256,
      },
      pinIncludePath: paths.pinIncludePath,
    });
    if (bridgeResult && typeof bridgeResult.then === 'function') bridgeResult = await bridgeResult;
    validateBridgeResult(bridgeResult, plan, outputAppDir, paths.pinIncludePath, paths.expectedContentFileCount);
  };

  const invocation = async () => {
    const builder = dependencies.builder ?? await loadAppBuilderLib(paths.builderRoot);
    if (typeof builder?.build !== 'function' || !builder.Platform?.WINDOWS?.createTarget || builder.Arch?.x64 === undefined) fail('app_builder_api_rejected');
    if (dependencies.hostPlatform !== undefined && (!dependencies.builder || dependencies.hostPlatform !== 'win32')) fail('windows_build_host_required');
    if (dependencies.hostPlatform === undefined && process.platform !== 'win32') fail('windows_build_host_required');
    const expectedArchName = builder.Arch[builder.Arch.x64];
    if (expectedArchName !== 'x64') fail('app_builder_arch_api_rejected');
    archEnum = builder.Arch;
    const targets = builder.Platform.WINDOWS.createTarget('dir', builder.Arch.x64);
    const options = {
      projectDir: paths.projectRoot,
      targets,
      config,
      publish: null,
    };
    const projectPackagePin = plan.projectSourcePins.find(pin => pin.path === 'package.json')?.sha256;
    if (typeof projectPackagePin !== 'string') fail('project_package_pin_missing');
    const { artifactPaths: returned } = await buildWithIsolatedSingleProjectPackager(builder, options, {
      projectDir: paths.projectRoot,
      stageRoot: paths.stageRoot,
      appDir: paths.appDir,
      projectPackageSha256: projectPackagePin,
      stagedPackageSha256: paths.stagedPackageSha256,
    });
    if (afterSignCalls !== 1 || bridgeResult === null) fail('after_sign_not_observed');
    assertAbsolutePhysicalDirectory(outputAppDir, 'private_directory_output_lost');
    const inventoryPath = path.join(outputAppDir, 'resources', 'app', 'windows-payload-inventory.json');
    stableHash(inventoryPath, bridgeResult.inventorySha256);
    stableHash(bridgeResult.templatePath, bridgeResult.templateSha256);
    const pinStat = stableHash(paths.pinIncludePath, bridgeResult.pinIncludeSha256);
    if (pinStat.sizeBytes < 1) fail('bridge_pin_readback_rejected');
    if (stableHash(plan.expectedManifestPath, plan.expectedManifestSha256).signature !== expectedManifestBefore.signature) fail('expected_manifest_changed_during_build');
    return Object.freeze({
      status: 'private_directory_build_complete',
      target: 'win32-x64-dir',
      outputRoot: paths.outputRoot,
      appOutDir: outputAppDir,
      expectedManifestSha256: plan.expectedManifestSha256,
      sourceFileCount: bridgeResult.sourceFileCount,
      inventorySha256: bridgeResult.inventorySha256,
      templateSha256: bridgeResult.templateSha256,
      pinIncludePath: paths.pinIncludePath,
      pinIncludeSha256: bridgeResult.pinIncludeSha256,
      fullRootReady: false,
      restoreInputAllowed: false,
    });
  };
  return withTaskEnvironment(invocation);
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--run', '--plan', '--plan-sha256'].includes(key)) fail('cli_argument_rejected');
    if (key === '--run') { if (args.has(key)) fail('cli_argument_rejected'); args.set(key, true); continue; }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('--') || args.has(key)) fail('cli_argument_rejected');
    args.set(key, value);
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.has('--run')) {
    process.stderr.write('No build started. Use --run --plan <absolute-file> --plan-sha256 <sha256> after independent review.\n');
    process.exitCode = 2;
    return;
  }
  if (process.platform !== 'win32' || !args.has('--plan') || !args.has('--plan-sha256')) fail('cli_run_contract_rejected');
  const planPath = path.resolve(args.get('--plan'));
  if (!path.isAbsolute(args.get('--plan')) || !samePath(planPath, args.get('--plan'))) fail('cli_plan_path_rejected');
  const planBytes = stableRead(planPath, MAX_PLAN_BYTES).bytes;
  const result = await runPrivateDirectoryBuild({ planBytes, expectedPlanSha256: args.get('--plan-sha256') });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export const privateDirectoryBuildContract = Object.freeze({
  kind: 'tokenelo-windows-private-directory-build-plan',
  schemaVersion: PLAN_SCHEMA_VERSION,
  sourceRevisionFormat: 'git-sha1-lowercase-40-hex (plan-bound)',
  target: 'win32-x64-dir',
  outputDirectoryName: 'win-unpacked',
  appStageRootName: 'app',
  electronVersion: ELECTRON_VERSION,
  electronBuilderVersion: ELECTRON_BUILDER_VERSION,
  builderSources: BUILDER_SOURCE_PINS.length,
  appSources: PROJECT_SOURCE_PATHS.length,
  bridgeSources: BRIDGE_SOURCE_PINS.length,
});

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error?.message && /^[a-z0-9_]+$/u.test(error.message) ? error.message : 'private_directory_build_failed'}\n`);
    process.exitCode = 1;
  });
}
