import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_IDENTITY = 'com.elostudios.tokenelo';
const APP_PACKAGE_NAME = 'tokenelo';
const APPLICATION_EXE = 'Tokenelo.exe';
const UNINSTALLER_EXE = 'Uninstall Tokenelo.exe';
const APP_PACKAGE_JSON = 'resources/app/package.json';
const APP_MAIN = 'resources/app/dist/tray/main.js';
const TEMPLATE_RELATIVE_PATH = 'resources/app/windows-payload-manifest.template.json';
const INVENTORY_KIND = 'tokenelo-windows-payload-expected-inventory';
const TEMPLATE_KIND = 'tokenelo-windows-nsis-payload-template';
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;

// These are stable core runtime sentinels, not a substitute for the caller's complete
// builder/vendor inventory. A member such as a legacy ANGLE DLL is mandatory whenever
// that complete inventory declares it, because the writer still compares the exact tree.
const REQUIRED_FILES = [
  APPLICATION_EXE,
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
  'locales/en-US.pak',
  APP_PACKAGE_JSON,
  APP_MAIN,
];

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ordinalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function pathCaseKey(relativePath) {
  return relativePath.normalize('NFC').toUpperCase();
}

function normalizeRelativePath(relativePath, label = 'relative path') {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') ||
      relativePath.includes(':') || relativePath.startsWith('/') || relativePath.endsWith('/')) {
    fail('manifest_path_reject', label);
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') ||
        /[\u0000-\u001f<>"|?*]/u.test(segment) || segment.normalize('NFC') !== segment) {
      fail('manifest_path_reject', label);
    }
    const deviceBase = segment.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceBase)) fail('manifest_path_reject', label);
  }
  return relativePath;
}

function isReservedRuntimePath(relativePath) {
  const key = pathCaseKey(relativePath);
  return key === pathCaseKey(TEMPLATE_RELATIVE_PATH) || key === pathCaseKey(UNINSTALLER_EXE);
}

function isKnownSensitivePath(relativePath) {
  const segments = relativePath.split('/');
  const base = segments.at(-1).toLowerCase();
  if (segments.some(segment => /^(?:\.env(?:\..*)?|data|user[-_ ]?data|app[-_ ]?data|logs?|ledger|history|session[-_ ]?history)$/iu.test(segment))) return true;
  if (/^(?:tokens?|secrets?|credentials?|fleet[-_.]?token|api[-_.]?(?:token|key)|private[-_.]?key|wallet|config\.json)(?:\..*)?$/iu.test(base)) return true;
  if (/(?:\.(?:sqlite3?|db)|-(?:wal|shm|journal))$/iu.test(base)) return true;
  return false;
}

function samePhysicalPath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b;
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':');
}

function readBoundedFile(filePath, maxBytes, code) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size < 0 || before.size > maxBytes) fail(code);
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      if (size > maxBytes) fail(code);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (statSignature(fs.fstatSync(fd)) !== statSignature(before) || size !== before.size) fail(code);
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertRealRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) fail('manifest_root_must_be_absolute');
  let rootStat;
  let rootReal;
  try {
    rootStat = fs.lstatSync(rootPath);
    rootReal = fs.realpathSync.native(rootPath);
  } catch {
    fail('manifest_root_missing');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('manifest_root_type_reject');
  if (!samePhysicalPath(rootPath, rootReal)) fail('manifest_root_physical_alias_reject');
  return path.resolve(rootReal);
}

function parseTrustedInventory(inventoryBytes, expectedSha256) {
  if (!Buffer.isBuffer(inventoryBytes)) inventoryBytes = Buffer.from(inventoryBytes);
  if (inventoryBytes.length === 0 || inventoryBytes.length > MAX_INVENTORY_BYTES) fail('manifest_inventory_size_reject');
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedSha256) || sha256(inventoryBytes) !== expectedSha256) {
    fail('manifest_inventory_hash_mismatch');
  }
  const text = inventoryBytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(inventoryBytes) || text.startsWith('\uFEFF')) fail('manifest_inventory_encoding_reject');
  let inventory;
  try { inventory = JSON.parse(text); }
  catch { fail('manifest_inventory_json_reject'); }
  const keys = ['schemaVersion', 'kind', 'packageIdentity', 'applicationPackageName', 'files'];
  if (!isRecord(inventory) || Object.keys(inventory).length !== keys.length ||
      Object.keys(inventory).some(key => !keys.includes(key)) ||
      inventory.schemaVersion !== 1 || inventory.kind !== INVENTORY_KIND ||
      inventory.packageIdentity !== PACKAGE_IDENTITY || inventory.applicationPackageName !== APP_PACKAGE_NAME ||
      !Array.isArray(inventory.files) || inventory.files.length === 0) {
    fail('manifest_inventory_contract_reject');
  }
  const files = [];
  const seen = new Set();
  for (const item of inventory.files) {
    const relativePath = normalizeRelativePath(item, 'trusted inventory path');
    const key = pathCaseKey(relativePath);
    if (seen.has(key)) fail('manifest_inventory_case_collision', relativePath);
    if (isReservedRuntimePath(relativePath)) fail('manifest_inventory_runtime_binding_reject', relativePath);
    if (isKnownSensitivePath(relativePath)) fail('manifest_sensitive_path_reject', relativePath);
    seen.add(key);
    files.push(relativePath);
  }
  const sorted = [...files].sort(ordinalCompare);
  if (files.some((file, index) => file !== sorted[index])) fail('manifest_inventory_order_reject');
  const requiredSet = new Set(files);
  for (const required of REQUIRED_FILES) {
    if (!requiredSet.has(required)) fail('manifest_required_runtime_file_missing', required);
  }
  const canonical = {
    schemaVersion: 1,
    kind: INVENTORY_KIND,
    packageIdentity: PACKAGE_IDENTITY,
    applicationPackageName: APP_PACKAGE_NAME,
    files,
  };
  if (!jsonBytes(canonical).equals(inventoryBytes)) fail('manifest_inventory_canonical_encoding_reject');
  return canonical;
}

function assertUnlistedReservedPathsAbsent(rootReal) {
  for (const reserved of [TEMPLATE_RELATIVE_PATH, UNINSTALLER_EXE]) {
    const fullPath = path.join(rootReal, ...reserved.split('/'));
    try {
      fs.lstatSync(fullPath);
      fail('manifest_reserved_runtime_path_already_exists', reserved);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function hashRegularFile(fullPath, relativePath, beforeStat) {
  const fd = fs.openSync(fullPath, 'r');
  try {
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || statSignature(openedStat) !== statSignature(beforeStat) || openedStat.nlink !== 1) {
      fail('manifest_file_changed_during_scan', relativePath);
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      sizeBytes += count;
    }
    const afterFdStat = fs.fstatSync(fd);
    let afterPathStat;
    try { afterPathStat = fs.lstatSync(fullPath); }
    catch { fail('manifest_file_changed_during_scan', relativePath); }
    const expectedRealPath = fullPath;
    let currentRealPath;
    try { currentRealPath = fs.realpathSync.native(fullPath); }
    catch { fail('manifest_file_changed_during_scan', relativePath); }
    if (statSignature(afterFdStat) !== statSignature(openedStat) ||
        statSignature(afterPathStat) !== statSignature(openedStat) ||
        afterPathStat.isSymbolicLink() || !samePhysicalPath(currentRealPath, expectedRealPath) ||
        sizeBytes !== openedStat.size) fail('manifest_file_changed_during_scan', relativePath);
    return { sizeBytes, sha256: hash.digest('hex'), signature: statSignature(openedStat) };
  } finally {
    fs.closeSync(fd);
  }
}

function readPackageIdentity(rootReal, scannedFiles) {
  const packagePath = path.join(rootReal, ...APP_PACKAGE_JSON.split('/'));
  const scannedPackage = scannedFiles.find(file => file.relativePath === APP_PACKAGE_JSON);
  if (!scannedPackage || scannedPackage.sizeBytes > 1024 * 1024) fail('manifest_app_package_changed_during_scan');
  let bytes;
  let parsed;
  try {
    bytes = readBoundedFile(packagePath, 1024 * 1024, 'manifest_app_package_json_reject');
    parsed = JSON.parse(bytes.toString('utf8'));
  }
  catch { fail('manifest_app_package_json_reject'); }
  if (!scannedPackage || sha256(bytes) !== scannedPackage.sha256) fail('manifest_app_package_changed_during_scan');
  if (!isRecord(parsed) || parsed.name !== APP_PACKAGE_NAME || parsed.private !== true ||
      parsed.type !== 'module' || parsed.main !== 'dist/tray/main.js') {
    fail('manifest_app_package_identity_reject');
  }
}

function scanUnpackedRoot(rootReal) {
  const files = [];
  const caseKeys = new Map();
  const signatures = new Map();
  const directoryIdentities = new Set();
  const rootStat = fs.lstatSync(rootReal);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('manifest_root_type_reject');
  if (process.platform !== 'win32') directoryIdentities.add(`${rootStat.dev}:${rootStat.ino}`);
  signatures.set('', statSignature(rootStat));
  function walk(directory, relativeDirectory = '') {
    let names;
    try { names = fs.readdirSync(directory).sort(ordinalCompare); }
    catch { fail('manifest_directory_read_reject', relativeDirectory || '.'); }
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      normalizeRelativePath(relativePath);
      const caseKey = pathCaseKey(relativePath);
      const priorCasePath = caseKeys.get(caseKey);
      if (priorCasePath !== undefined) fail('manifest_tree_case_collision', `${priorCasePath} / ${relativePath}`);
      caseKeys.set(caseKey, relativePath);
      if (isReservedRuntimePath(relativePath)) fail('manifest_reserved_runtime_path_already_exists', relativePath);
      if (isKnownSensitivePath(relativePath)) fail('manifest_sensitive_path_reject', relativePath);

      const fullPath = path.join(rootReal, ...relativePath.split('/'));
      let stat;
      let realPath;
      try {
        stat = fs.lstatSync(fullPath);
        realPath = fs.realpathSync.native(fullPath);
      } catch { fail('manifest_tree_entry_read_reject', relativePath); }
      if (stat.isSymbolicLink() || !samePhysicalPath(realPath, fullPath)) fail('manifest_physical_alias_reject', relativePath);
      if (stat.isDirectory()) {
        if (process.platform !== 'win32') {
          const identity = `${stat.dev}:${stat.ino}`;
          if (directoryIdentities.has(identity)) fail('manifest_physical_alias_reject', relativePath);
          directoryIdentities.add(identity);
        }
        signatures.set(relativePath, statSignature(stat));
        walk(fullPath, relativePath);
        continue;
      }
      if (!stat.isFile()) fail('manifest_unexpected_type_reject', relativePath);
      if (stat.nlink !== 1) fail('manifest_physical_alias_reject', relativePath);
      const record = hashRegularFile(fullPath, relativePath, stat);
      if (record.sizeBytes >= 16) {
        let header;
        const fd = fs.openSync(fullPath, 'r');
        try {
          header = Buffer.alloc(16);
          fs.readSync(fd, header, 0, 16, 0);
        } finally { fs.closeSync(fd); }
        if (header.toString('binary') === 'SQLite format 3\u0000') fail('manifest_database_header_reject', relativePath);
      }
      files.push({ relativePath, sizeBytes: record.sizeBytes, sha256: record.sha256 });
      signatures.set(relativePath, record.signature);
    }
  }
  walk(rootReal);
  files.sort((left, right) => ordinalCompare(left.relativePath, right.relativePath));
  return { files, signatures };
}

function assertExactFileSet(actualFiles, expectedFiles) {
  const actual = actualFiles.map(file => file.relativePath);
  const expected = expectedFiles;
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter(file => !expectedSet.has(file));
  const missing = expected.filter(file => !actualSet.has(file));
  if (unexpected.length || missing.length) {
    fail('manifest_tree_file_set_mismatch', JSON.stringify({
      unexpectedCount: unexpected.length, unexpectedSample: unexpected.slice(0, 8),
      missingCount: missing.length, missingSample: missing.slice(0, 8),
    }));
  }
}

function recheckTreeSignatures(rootReal, expectedSignatures) {
  for (const [relativePath, expected] of expectedSignatures) {
    const fullPath = relativePath ? path.join(rootReal, ...relativePath.split('/')) : rootReal;
    let stat;
    try { stat = fs.lstatSync(fullPath); }
    catch { fail('manifest_tree_changed_before_publish', relativePath || '.'); }
    if (stat.isSymbolicLink() || statSignature(stat) !== expected) fail('manifest_tree_changed_before_publish', relativePath || '.');
    let realPath;
    try { realPath = fs.realpathSync.native(fullPath); }
    catch { fail('manifest_tree_changed_before_publish', relativePath || '.'); }
    if (!samePhysicalPath(realPath, fullPath)) fail('manifest_tree_changed_before_publish', relativePath || '.');
  }
}

function makeTemplate({ inventorySha256, files }) {
  // This is intentionally not the payload-recovery module's schemaVersion 2
  // full-install-root manifest. NSIS must pin this file's hash; a Windows
  // runtime assembler must verify each listed byte stream, bind allowed live
  // Windows metadata, and add the template plus verified uninstaller image.
  return {
    schemaVersion: 1,
    kind: TEMPLATE_KIND,
    manifestScope: 'unpacked-install-template',
    packageIdentity: PACKAGE_IDENTITY,
    fullInstallRoot: false,
    fullRootReady: false,
    restoreInputAllowed: false,
    trustedExpectedFileSetSha256: inventorySha256,
    expectedFileSetProvenance: 'caller-supplied; this producer does not authenticate its origin',
    applicationExe: APPLICATION_EXE,
    applicationPackagePath: APP_PACKAGE_JSON,
    generatedUninstallerPath: UNINSTALLER_EXE,
    templateRelativePath: TEMPLATE_RELATIVE_PATH,
    files,
    runtimeBindingContract: {
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
    },
  };
}

export function serializeTrustedWindowsPayloadInventory(files) {
  const normalized = files.map(item => normalizeRelativePath(item, 'trusted inventory path'));
  const sorted = [...normalized].sort(ordinalCompare);
  const seen = new Set();
  for (const item of sorted) {
    const key = pathCaseKey(item);
    if (seen.has(key)) fail('manifest_inventory_case_collision', item);
    if (isReservedRuntimePath(item)) fail('manifest_inventory_runtime_binding_reject', item);
    if (isKnownSensitivePath(item)) fail('manifest_sensitive_path_reject', item);
    seen.add(key);
  }
  return jsonBytes({
    schemaVersion: 1,
    kind: INVENTORY_KIND,
    packageIdentity: PACKAGE_IDENTITY,
    applicationPackageName: APP_PACKAGE_NAME,
    files: sorted,
  });
}

export function writeNsisPayloadManifestTemplate({ winUnpackedRoot, trustedInventoryBytes, trustedInventorySha256 }) {
  const rootReal = assertRealRoot(winUnpackedRoot);
  const inventory = parseTrustedInventory(trustedInventoryBytes, trustedInventorySha256);
  assertUnlistedReservedPathsAbsent(rootReal);
  const scan = scanUnpackedRoot(rootReal);
  assertExactFileSet(scan.files, inventory.files);
  readPackageIdentity(rootReal, scan.files);
  recheckTreeSignatures(rootReal, scan.signatures);

  const template = makeTemplate({ inventorySha256: trustedInventorySha256, files: scan.files });
  const bytes = jsonBytes(template);
  const outputPath = path.join(rootReal, ...TEMPLATE_RELATIVE_PATH.split('/'));
  let outputParentReal;
  try { outputParentReal = fs.realpathSync.native(path.dirname(outputPath)); }
  catch { fail('manifest_output_parent_missing'); }
  if (!samePhysicalPath(outputParentReal, path.dirname(outputPath))) fail('manifest_output_parent_alias_reject');
  const outputParentStat = fs.lstatSync(path.dirname(outputPath));
  if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink()) fail('manifest_output_parent_type_reject');
  let fd;
  try {
    fd = fs.openSync(outputPath, 'wx', 0o644);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('manifest_template_already_exists');
    fail('manifest_template_write_failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let outputStat;
  let outputBytes;
  try {
    outputStat = fs.lstatSync(outputPath);
    if (!outputStat.isFile() || outputStat.isSymbolicLink()) fail('manifest_template_readback_failed');
    outputBytes = readBoundedFile(outputPath, bytes.length, 'manifest_template_readback_failed');
    const outputAfter = fs.lstatSync(outputPath);
    if (statSignature(outputAfter) !== statSignature(outputStat) ||
        !samePhysicalPath(fs.realpathSync.native(outputPath), outputPath)) fail('manifest_template_readback_failed');
  } catch (error) {
    if (error?.message === 'manifest_template_readback_failed') throw error;
    fail('manifest_template_readback_failed');
  }
  if (outputBytes.length !== bytes.length || sha256(outputBytes) !== sha256(bytes)) fail('manifest_template_readback_failed');
  return {
    templatePath: outputPath,
    templateSha256: sha256(bytes),
    expectedFileSetSha256: trustedInventorySha256,
    fileCount: scan.files.length,
    fullInstallRoot: false,
  };
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--win-unpacked-root', '--trusted-inventory', '--trusted-inventory-sha256'].includes(name) ||
        !value || values.has(name)) fail('manifest_cli_arguments_reject');
    values.set(name, value);
  }
  if (values.size !== 3) fail('manifest_cli_arguments_reject');
  return values;
}

function runCli(args) {
  const values = parseArgs(args);
  const rootPath = path.resolve(values.get('--win-unpacked-root'));
  const inventoryPath = path.resolve(values.get('--trusted-inventory'));
  const rootReal = assertRealRoot(rootPath);
  let inventoryReal;
  let inventoryStat;
  try {
    inventoryStat = fs.lstatSync(inventoryPath);
    inventoryReal = fs.realpathSync.native(inventoryPath);
  } catch { fail('manifest_inventory_file_missing'); }
  if (!inventoryStat.isFile() || inventoryStat.isSymbolicLink() || inventoryStat.nlink !== 1 || !samePhysicalPath(inventoryPath, inventoryReal)) {
    fail('manifest_inventory_file_type_reject');
  }
  const relative = path.relative(rootReal, inventoryReal);
  const insideRoot = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  if (insideRoot) fail('manifest_inventory_inside_payload_reject');
  if (inventoryStat.size > MAX_INVENTORY_BYTES) fail('manifest_inventory_size_reject');
  const bytes = readBoundedFile(inventoryReal, MAX_INVENTORY_BYTES, 'manifest_inventory_file_read_reject');
  let inventoryAfter;
  let inventoryPathAfter;
  try {
    inventoryAfter = fs.lstatSync(inventoryReal);
    inventoryPathAfter = fs.realpathSync.native(inventoryReal);
  } catch { fail('manifest_inventory_file_changed_during_read'); }
  if (inventoryAfter.isSymbolicLink() || statSignature(inventoryAfter) !== statSignature(inventoryStat) ||
      !samePhysicalPath(inventoryPathAfter, inventoryPath)) fail('manifest_inventory_file_changed_during_read');
  const result = writeNsisPayloadManifestTemplate({
    winUnpackedRoot: rootPath,
    trustedInventoryBytes: bytes,
    trustedInventorySha256: values.get('--trusted-inventory-sha256'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { runCli(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

export const windowsPayloadManifestContract = Object.freeze({
  packageIdentity: PACKAGE_IDENTITY,
  applicationExe: APPLICATION_EXE,
  uninstallerExe: UNINSTALLER_EXE,
  applicationPackageJson: APP_PACKAGE_JSON,
  applicationMain: APP_MAIN,
  templateRelativePath: TEMPLATE_RELATIVE_PATH,
  requiredFiles: [...REQUIRED_FILES],
  inventoryKind: INVENTORY_KIND,
  templateKind: TEMPLATE_KIND,
});
