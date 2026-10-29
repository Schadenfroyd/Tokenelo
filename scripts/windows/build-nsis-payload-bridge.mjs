import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  serializeTrustedWindowsPayloadInventory,
  windowsPayloadManifestContract,
  writeNsisPayloadManifestTemplate,
} from './write-nsis-payload-manifest.mjs';

const CONTENT_MANIFEST_KIND = 'tokenelo-windows-expected-content-manifest';
const INVENTORY_RELATIVE_PATH = 'resources/app/windows-payload-inventory.json';
const MAX_CONTENT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_TEMPLATE_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SEMVER_RE = /^\d+\.\d+\.\d+$/u;
const PATH_SEGMENT_REJECT_RE = /[\u0000-\u001f<>"|?*]/u;
const SENSITIVE_SEGMENT_RE = /^(?:\.env(?:\..*)?|data|user[-_ ]?data|app[-_ ]?data|logs?|ledger|history|session[-_ ]?history)$/iu;
const SENSITIVE_BASE_RE = /^(?:tokens?|secrets?|credentials?|fleet[-_.]?token|api[-_.]?(?:token|key)|private[-_.]?key|wallet|config\.json)(?:\..*)?$/iu;
const SQLITE_SUFFIX_RE = /(?:\.(?:sqlite3?|db)|-(?:wal|shm|journal))$/iu;
const INVENTORY_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'platform', 'architecture', 'outputDirectoryName', 'packageIdentity',
  'applicationPackageName', 'applicationVersion', 'electronVersion', 'electronBuilderVersion',
  'sourceRevision', 'stageManifestSha256', 'stagedPayloadManifestSha256', 'vendorArchiveSha256', 'files',
]);
const CONTEXT_KEYS = Object.freeze(INVENTORY_KEYS.filter(key => !['schemaVersion', 'kind', 'files'].includes(key)));
const FILE_KEYS = Object.freeze(['relativePath', 'sizeBytes', 'sha256', 'provenance']);
const APP_PROVENANCE_KEYS = Object.freeze(['sourceClass', 'sourceArtifactSha256', 'sourceRelativePath']);
const VENDOR_PROVENANCE_KEYS = Object.freeze(['sourceClass', 'sourceArtifactSha256', 'sourceRelativePath']);
const TRANSFORM_PROVENANCE_KEYS = Object.freeze([
  'sourceClass', 'sourceArtifactSha256', 'sourceRelativePath', 'sourceBytesSha256', 'transformId',
]);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const ordinalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, keys, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function pathCaseKey(value) {
  return value.normalize('NFC').toUpperCase();
}

function normalizeRelativePath(relativePath, code = 'bridge_manifest_path_reject') {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') ||
      relativePath.includes(':') || relativePath.startsWith('/') || relativePath.endsWith('/')) {
    fail(code);
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    const deviceBase = segment.split('.')[0].toUpperCase();
    if (!segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' ') ||
        PATH_SEGMENT_REJECT_RE.test(segment) || segment.normalize('NFC') !== segment ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceBase)) {
      fail(code, relativePath);
    }
  }
  return relativePath;
}

function isKnownSensitivePath(relativePath) {
  const segments = relativePath.split('/');
  const base = segments.at(-1).toLowerCase();
  return segments.some(segment => SENSITIVE_SEGMENT_RE.test(segment)) ||
    SENSITIVE_BASE_RE.test(base) || SQLITE_SUFFIX_RE.test(base);
}

function normalizeAbsolutePath(value, code) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) fail(code);
  const full = path.resolve(value);
  if (!samePath(value, full)) fail(code);
  return full;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b;
}

function pathWithin(candidate, parent) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedParent = path.resolve(parent);
  const left = process.platform === 'win32' ? resolvedCandidate.toUpperCase() : resolvedCandidate;
  const right = process.platform === 'win32' ? resolvedParent.toUpperCase() : resolvedParent;
  if (left === right) return true;
  const relative = path.relative(right, left);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`);
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':');
}

function assertNoReparseAncestors(filePath, { allowMissingLeaf = false } = {}) {
  const fullPath = path.resolve(filePath);
  const parsed = path.parse(fullPath);
  const pieces = fullPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < pieces.length; index += 1) {
    current = path.join(current, pieces[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingLeaf && index === pieces.length - 1 && error?.code === 'ENOENT') return;
      fail('bridge_path_read_reject');
    }
    if (stat.isSymbolicLink()) fail('bridge_path_reparse_reject');
    let real;
    try { real = fs.realpathSync.native(current); }
    catch { fail('bridge_path_read_reject'); }
    if (!samePath(real, current)) fail('bridge_path_alias_reject');
    if (index < pieces.length - 1 && !stat.isDirectory()) fail('bridge_path_parent_type_reject');
  }
}

function assertRealDirectory(directoryPath, basename = null) {
  const fullPath = normalizeAbsolutePath(directoryPath, 'bridge_root_path_reject');
  let stat;
  let real;
  try {
    stat = fs.lstatSync(fullPath);
    real = fs.realpathSync.native(fullPath);
  } catch { fail('bridge_root_missing'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('bridge_root_type_reject');
  if (!samePath(fullPath, real)) fail('bridge_root_physical_alias_reject');
  if (basename !== null && path.basename(fullPath).toLowerCase() !== basename.toLowerCase()) {
    fail('bridge_root_context_reject');
  }
  return fullPath;
}

function readStableRegularFile(filePath, maxBytes, code) {
  let fd;
  try {
    const fullPath = normalizeAbsolutePath(filePath, code);
    const beforePath = fs.lstatSync(fullPath);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1 ||
        beforePath.size < 0 || beforePath.size > maxBytes) fail(code);
    if (!samePath(fs.realpathSync.native(fullPath), fullPath)) fail(code);
    fd = fs.openSync(fullPath, 'r');
    const beforeFd = fs.fstatSync(fd);
    if (!beforeFd.isFile() || statSignature(beforeFd) !== statSignature(beforePath)) fail(code);
    const chunks = [];
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, maxBytes)));
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      size += count;
      if (size > maxBytes) fail(code);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(fullPath);
    if (statSignature(afterFd) !== statSignature(beforeFd) ||
        statSignature(afterPath) !== statSignature(beforePath) ||
        afterPath.isSymbolicLink() || size !== beforeFd.size ||
        !samePath(fs.realpathSync.native(fullPath), fullPath)) fail(code);
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error?.message === code || error?.message?.startsWith(`${code}:`)) throw error;
    fail(code);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function hashStableRegularFile(filePath, code) {
  let fd;
  try {
    const fullPath = normalizeAbsolutePath(filePath, code);
    const beforePath = fs.lstatSync(fullPath);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1 || beforePath.size < 0) fail(code);
    if (!samePath(fs.realpathSync.native(fullPath), fullPath)) fail(code);
    fd = fs.openSync(fullPath, 'r');
    const beforeFd = fs.fstatSync(fd);
    if (!beforeFd.isFile() || statSignature(beforeFd) !== statSignature(beforePath)) fail(code);
    const hash = crypto.createHash('sha256');
    const header = Buffer.alloc(16);
    let headerBytes = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sizeBytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      if (headerBytes < header.length) {
        const copyLength = Math.min(count, header.length - headerBytes);
        buffer.copy(header, headerBytes, 0, copyLength);
        headerBytes += copyLength;
      }
      hash.update(buffer.subarray(0, count));
      sizeBytes += count;
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(fullPath);
    if (statSignature(afterFd) !== statSignature(beforeFd) || statSignature(afterPath) !== statSignature(beforePath) ||
        afterPath.isSymbolicLink() || sizeBytes !== beforeFd.size || !samePath(fs.realpathSync.native(fullPath), fullPath)) {
      fail(code);
    }
    return { sizeBytes, sha256: hash.digest('hex'), signature: statSignature(beforeFd), header };
  } catch (error) {
    if (error?.message === code || error?.message?.startsWith(`${code}:`)) throw error;
    fail(code);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function assertHash(value, code) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(code);
}

function validateContext(context) {
  assertExactKeys(context, CONTEXT_KEYS, 'bridge_context_contract_reject');
  if (context.platform !== 'win32' || context.architecture !== 'x64' ||
      context.outputDirectoryName !== 'win-unpacked' ||
      context.packageIdentity !== windowsPayloadManifestContract.packageIdentity ||
      context.applicationPackageName !== 'tokenelo' ||
      typeof context.applicationVersion !== 'string' || !SEMVER_RE.test(context.applicationVersion) ||
      typeof context.electronVersion !== 'string' || !SEMVER_RE.test(context.electronVersion) ||
      context.electronBuilderVersion !== '26.18.0' ||
      typeof context.sourceRevision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(context.sourceRevision)) {
    fail('bridge_context_identity_reject');
  }
  assertHash(context.stageManifestSha256, 'bridge_context_pin_reject');
  assertHash(context.stagedPayloadManifestSha256, 'bridge_context_pin_reject');
  assertHash(context.vendorArchiveSha256, 'bridge_context_pin_reject');
}

function validateProvenance(provenance, context, relativePath) {
  if (!isRecord(provenance) || typeof provenance.sourceClass !== 'string') fail('bridge_manifest_provenance_reject');
  if (provenance.sourceClass === 'app-stage') {
    assertExactKeys(provenance, APP_PROVENANCE_KEYS, 'bridge_manifest_provenance_reject');
    assertHash(provenance.sourceArtifactSha256, 'bridge_manifest_provenance_reject');
    if (provenance.sourceArtifactSha256 !== context.stagedPayloadManifestSha256 ||
        !relativePath.startsWith('resources/app/')) fail('bridge_manifest_provenance_pin_reject');
    normalizeRelativePath(provenance.sourceRelativePath, 'bridge_manifest_provenance_reject');
  } else if (provenance.sourceClass === 'vendor-electron') {
    assertExactKeys(provenance, VENDOR_PROVENANCE_KEYS, 'bridge_manifest_provenance_reject');
    assertHash(provenance.sourceArtifactSha256, 'bridge_manifest_provenance_reject');
    if (provenance.sourceArtifactSha256 !== context.vendorArchiveSha256 ||
        relativePath.startsWith('resources/app/')) fail('bridge_manifest_provenance_pin_reject');
    normalizeRelativePath(provenance.sourceRelativePath, 'bridge_manifest_provenance_reject');
  } else if (provenance.sourceClass === 'verified-transform') {
    assertExactKeys(provenance, TRANSFORM_PROVENANCE_KEYS, 'bridge_manifest_provenance_reject');
    assertHash(provenance.sourceArtifactSha256, 'bridge_manifest_provenance_reject');
    assertHash(provenance.sourceBytesSha256, 'bridge_manifest_provenance_reject');
    if (![context.stagedPayloadManifestSha256, context.vendorArchiveSha256].includes(provenance.sourceArtifactSha256) ||
        typeof provenance.transformId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(provenance.transformId)) {
      fail('bridge_manifest_provenance_pin_reject');
    }
    normalizeRelativePath(provenance.sourceRelativePath, 'bridge_manifest_provenance_reject');
  } else {
    fail('bridge_manifest_provenance_reject');
  }
}

function parseExpectedContentManifest(bytes, expectedSha256, context) {
  assertHash(expectedSha256, 'bridge_manifest_pin_reject');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_CONTENT_MANIFEST_BYTES || sha256(bytes) !== expectedSha256) {
    fail('bridge_manifest_pin_mismatch');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.startsWith('\uFEFF')) fail('bridge_manifest_encoding_reject');
  let manifest;
  try { manifest = JSON.parse(text); }
  catch { fail('bridge_manifest_json_reject'); }
  assertExactKeys(manifest, INVENTORY_KEYS, 'bridge_manifest_contract_reject');
  if (manifest.schemaVersion !== 1 || manifest.kind !== CONTENT_MANIFEST_KIND) fail('bridge_manifest_contract_reject');
  for (const key of CONTEXT_KEYS) {
    if (manifest[key] !== context[key]) fail('bridge_manifest_context_mismatch', key);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail('bridge_manifest_files_reject');

  const files = [];
  const seen = new Set();
  for (const entry of manifest.files) {
    assertExactKeys(entry, FILE_KEYS, 'bridge_manifest_file_contract_reject');
    const relativePath = normalizeRelativePath(entry.relativePath, 'bridge_manifest_path_reject');
    const key = pathCaseKey(relativePath);
    if (seen.has(key)) fail('bridge_manifest_case_collision', relativePath);
    seen.add(key);
    if (isKnownSensitivePath(relativePath)) fail('bridge_manifest_sensitive_path_reject', relativePath);
    if (relativePath.toUpperCase() === INVENTORY_RELATIVE_PATH.toUpperCase() ||
        relativePath.toUpperCase() === windowsPayloadManifestContract.templateRelativePath.toUpperCase() ||
        relativePath.toUpperCase() === windowsPayloadManifestContract.uninstallerExe.toUpperCase()) {
      fail('bridge_manifest_derived_path_collision', relativePath);
    }
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) fail('bridge_manifest_file_contract_reject');
    assertHash(entry.sha256, 'bridge_manifest_file_contract_reject');
    validateProvenance(entry.provenance, context, relativePath);
    files.push({ relativePath, sizeBytes: entry.sizeBytes, sha256: entry.sha256 });
  }
  const sorted = [...files].sort((left, right) => ordinalCompare(left.relativePath, right.relativePath));
  if (files.some((entry, index) => entry.relativePath !== sorted[index].relativePath)) fail('bridge_manifest_order_reject');
  const canonical = { ...manifest, files: manifest.files };
  if (!jsonBytes(canonical).equals(bytes)) fail('bridge_manifest_canonical_encoding_reject');

  // The producer owns the sentinel and Windows path-policy checks. This call has no writes.
  const derivedInventoryBytes = serializeTrustedWindowsPayloadInventory([
    ...files.map(entry => entry.relativePath), INVENTORY_RELATIVE_PATH,
  ]);
  if (derivedInventoryBytes.length > MAX_INVENTORY_BYTES) fail('bridge_inventory_size_reject');
  return { files, inventoryBytes: derivedInventoryBytes, inventorySha256: sha256(derivedInventoryBytes) };
}

function scanExpectedTree(rootReal, expectedFiles) {
  const expectedByPath = new Map(expectedFiles.map(entry => [entry.relativePath, entry]));
  const expectedDirectories = new Set(['']);
  for (const entry of expectedFiles) {
    const segments = entry.relativePath.split('/');
    for (let index = 1; index < segments.length; index += 1) expectedDirectories.add(segments.slice(0, index).join('/'));
  }
  const actual = [];
  const seenCasePaths = new Map();
  const directoryIdentities = new Set();
  const signatures = new Map();
  const rootStat = fs.lstatSync(rootReal);
  signatures.set('', statSignature(rootStat));
  function walk(directory, relativeDirectory = '') {
    let names;
    try { names = fs.readdirSync(directory).sort(ordinalCompare); }
    catch { fail('bridge_tree_read_reject', relativeDirectory || '.'); }
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      normalizeRelativePath(relativePath, 'bridge_tree_path_reject');
      const key = pathCaseKey(relativePath);
      const prior = seenCasePaths.get(key);
      if (prior !== undefined) fail('bridge_tree_case_collision', `${prior} / ${relativePath}`);
      seenCasePaths.set(key, relativePath);
      if (isKnownSensitivePath(relativePath)) fail('bridge_tree_sensitive_path_reject', relativePath);
      if (relativePath.toUpperCase() === windowsPayloadManifestContract.templateRelativePath.toUpperCase() ||
          relativePath.toUpperCase() === windowsPayloadManifestContract.uninstallerExe.toUpperCase()) {
        fail('bridge_tree_reserved_path_present', relativePath);
      }

      const fullPath = path.join(rootReal, ...relativePath.split('/'));
      let stat;
      let realPath;
      try { stat = fs.lstatSync(fullPath); realPath = fs.realpathSync.native(fullPath); }
      catch { fail('bridge_tree_entry_read_reject', relativePath); }
      if (stat.isSymbolicLink() || !samePath(realPath, fullPath)) fail('bridge_tree_physical_alias_reject', relativePath);
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) fail('bridge_tree_unexpected_directory', relativePath);
        if (process.platform !== 'win32') {
          const identity = `${stat.dev}:${stat.ino}`;
          if (directoryIdentities.has(identity)) fail('bridge_tree_physical_alias_reject', relativePath);
          directoryIdentities.add(identity);
        }
        signatures.set(relativePath, statSignature(stat));
        walk(fullPath, relativePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail('bridge_tree_file_type_reject', relativePath);
      const file = hashStableRegularFile(fullPath, 'bridge_tree_file_read_reject');
      if (file.sizeBytes >= 16 && file.header.toString('binary') === 'SQLite format 3\0') {
        fail('bridge_tree_database_reject', relativePath);
      }
      const record = { relativePath, sizeBytes: file.sizeBytes, sha256: file.sha256 };
      const expected = expectedByPath.get(relativePath);
      if (!expected) fail('bridge_tree_unexpected_file', relativePath);
      if (record.sizeBytes !== expected.sizeBytes || record.sha256 !== expected.sha256) {
        fail('bridge_tree_content_mismatch', relativePath);
      }
      actual.push(record);
      signatures.set(relativePath, statSignature(fs.lstatSync(fullPath)));
    }
  }
  walk(rootReal);
  actual.sort((left, right) => ordinalCompare(left.relativePath, right.relativePath));
  const missing = expectedFiles.filter(entry => !actual.some(record => record.relativePath === entry.relativePath));
  if (missing.length > 0) fail('bridge_tree_missing_file', missing[0].relativePath);
  if (actual.length !== expectedFiles.length) fail('bridge_tree_file_set_mismatch');
  return { files: actual, signatures };
}

function recheckTreeSignatures(rootReal, signatures) {
  for (const [relativePath, expectedSignature] of signatures) {
    const fullPath = relativePath ? path.join(rootReal, ...relativePath.split('/')) : rootReal;
    let stat;
    let real;
    try { stat = fs.lstatSync(fullPath); real = fs.realpathSync.native(fullPath); }
    catch { fail('bridge_tree_changed_before_output', relativePath || '.'); }
    if (stat.isSymbolicLink() || statSignature(stat) !== expectedSignature || !samePath(real, fullPath)) {
      fail('bridge_tree_changed_before_output', relativePath || '.');
    }
  }
}

function assertOutputAbsent(filePath, rootReal, code, { allowInsideRoot = false } = {}) {
  const fullPath = normalizeAbsolutePath(filePath, code);
  if (!allowInsideRoot && pathWithin(fullPath, rootReal)) fail(code);
  assertNoReparseAncestors(fullPath, { allowMissingLeaf: true });
  try { fs.lstatSync(fullPath); fail('bridge_output_already_exists', fullPath); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return fullPath;
}

function writeDurableExclusiveFile(filePath, bytes) {
  let fd;
  let offset = 0;
  try {
    fd = fs.openSync(filePath, 'wx', 0o644);
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isInteger(count) || count <= 0) fail('bridge_output_write_failed');
      offset += count;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.message?.startsWith('bridge_output_')) throw error;
    fail('bridge_output_write_failed');
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); }
      catch { fail('bridge_output_close_failed'); }
    }
  }
  const readback = readStableRegularFile(filePath, bytes.length, 'bridge_output_readback_failed');
  if (!readback.equals(bytes)) fail('bridge_output_readback_failed');
  return { sizeBytes: readback.length, sha256: sha256(readback) };
}

function verifyTemplateAgainstExpected(templatePath, templateSha256, expectedFiles, inventoryBytes, inventorySha256) {
  assertHash(templateSha256, 'bridge_template_pin_reject');
  const bytes = readStableRegularFile(templatePath, MAX_TEMPLATE_BYTES, 'bridge_template_readback_failed');
  if (sha256(bytes) !== templateSha256) fail('bridge_template_readback_failed');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.startsWith('\uFEFF')) fail('bridge_template_encoding_reject');
  let template;
  try { template = JSON.parse(text); }
  catch { fail('bridge_template_json_reject'); }
  if (template?.kind !== windowsPayloadManifestContract.templateKind || template.fullRootReady !== false ||
      template.restoreInputAllowed !== false || template.fullInstallRoot !== false ||
      template.trustedExpectedFileSetSha256 !== inventorySha256 || !Array.isArray(template.files)) {
    fail('bridge_template_contract_reject');
  }
  const expected = [
    ...expectedFiles,
    { relativePath: INVENTORY_RELATIVE_PATH, sizeBytes: inventoryBytes.length, sha256: inventorySha256 },
  ].sort((left, right) => ordinalCompare(left.relativePath, right.relativePath));
  if (template.files.length !== expected.length) fail('bridge_template_file_set_mismatch');
  for (let index = 0; index < expected.length; index += 1) {
    const actual = template.files[index];
    const wanted = expected[index];
    if (actual.relativePath !== wanted.relativePath || actual.sizeBytes !== wanted.sizeBytes || actual.sha256 !== wanted.sha256) {
      fail('bridge_template_content_mismatch', wanted.relativePath);
    }
  }
  return { bytes, templateSha256 };
}

function verifyApplicationPackageIdentity(rootReal, expectedFiles, context) {
  const relativePath = windowsPayloadManifestContract.applicationPackageJson;
  const expected = expectedFiles.find(entry => entry.relativePath === relativePath);
  if (!expected || expected.sizeBytes > 1024 * 1024) fail('bridge_app_package_missing_or_oversize');
  const fullPath = path.join(rootReal, ...relativePath.split('/'));
  const bytes = readStableRegularFile(fullPath, 1024 * 1024, 'bridge_app_package_read_reject');
  if (bytes.length !== expected.sizeBytes || sha256(bytes) !== expected.sha256) fail('bridge_app_package_content_mismatch');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { fail('bridge_app_package_json_reject'); }
  if (!isRecord(parsed) || parsed.name !== context.applicationPackageName || parsed.private !== true ||
      parsed.type !== 'module' || parsed.main !== 'dist/tray/main.js' || parsed.version !== context.applicationVersion) {
    fail('bridge_app_package_identity_reject');
  }
}

function nsisPinInclude(context, expectedManifestSha256, inventorySha256, templateSha256) {
  const defines = [
    ['TOKENELO_EXPECTED_CONTENT_MANIFEST_SHA256', expectedManifestSha256],
    ['TOKENELO_STAGE_MANIFEST_SHA256', context.stageManifestSha256],
    ['TOKENELO_STAGED_PAYLOAD_MANIFEST_SHA256', context.stagedPayloadManifestSha256],
    ['TOKENELO_VENDOR_ARCHIVE_SHA256', context.vendorArchiveSha256],
    ['TOKENELO_TRUSTED_INVENTORY_SHA256', inventorySha256],
    ['TOKENELO_COMPILED_TEMPLATE_SHA256', templateSha256],
  ];
  for (const [, value] of defines) assertHash(value, 'bridge_nsis_pin_contract_reject');
  return Buffer.from(`${defines.map(([name, value]) => `!define ${name} "${value}"`).join('\n')}\n`, 'ascii');
}

export const windowsNsisPayloadBridgeContract = Object.freeze({
  expectedManifestKind: CONTENT_MANIFEST_KIND,
  inventoryRelativePath: INVENTORY_RELATIVE_PATH,
  targetPlatform: 'win32',
  targetArchitecture: 'x64',
  outputDirectoryName: 'win-unpacked',
  packageIdentity: windowsPayloadManifestContract.packageIdentity,
  applicationPackageName: 'tokenelo',
  electronBuilderVersion: '26.18.0',
});

/**
 * Verifies a caller-pinned full-content manifest against the unpacked output before writing.
 * Provenance labels are caller-supplied data; this helper does not authenticate vendor or CI inputs.
 */
export function buildWindowsNsisPayloadBridge({
  winUnpackedRoot,
  expectedManifestPath,
  expectedManifestSha256,
  expectedContext,
  pinIncludePath,
}) {
  validateContext(expectedContext);
  assertHash(expectedManifestSha256, 'bridge_manifest_pin_reject');
  const rootReal = assertRealDirectory(winUnpackedRoot, expectedContext.outputDirectoryName);
  const manifestPath = normalizeAbsolutePath(expectedManifestPath, 'bridge_manifest_path_reject');
  assertNoReparseAncestors(manifestPath);
  if (pathWithin(manifestPath, rootReal)) fail('bridge_manifest_inside_unpacked_root_reject');

  const manifestBytes = readStableRegularFile(manifestPath, MAX_CONTENT_MANIFEST_BYTES, 'bridge_manifest_read_reject');
  const manifest = parseExpectedContentManifest(manifestBytes, expectedManifestSha256, expectedContext);
  const pinPath = normalizeAbsolutePath(pinIncludePath, 'bridge_pin_path_reject');
  if (pathWithin(pinPath, rootReal) || pathWithin(pinPath, manifestPath) || pathWithin(manifestPath, pinPath)) {
    fail('bridge_pin_path_overlap_reject');
  }
  assertNoReparseAncestors(path.dirname(pinPath));
  const pinParentStat = fs.lstatSync(path.dirname(pinPath));
  if (!pinParentStat.isDirectory() || pinParentStat.isSymbolicLink() ||
      !samePath(fs.realpathSync.native(path.dirname(pinPath)), path.dirname(pinPath))) {
    fail('bridge_pin_parent_reject');
  }
  const inventoryPath = path.join(rootReal, ...INVENTORY_RELATIVE_PATH.split('/'));
  const templatePath = path.join(rootReal, ...windowsPayloadManifestContract.templateRelativePath.split('/'));
  const uninstallerPath = path.join(rootReal, windowsPayloadManifestContract.uninstallerExe);
  assertOutputAbsent(inventoryPath, rootReal, 'bridge_inventory_output_path_reject', { allowInsideRoot: true });
  assertOutputAbsent(templatePath, rootReal, 'bridge_template_output_path_reject', { allowInsideRoot: true });
  assertOutputAbsent(pinPath, rootReal, 'bridge_pin_output_path_reject');
  assertNoReparseAncestors(uninstallerPath, { allowMissingLeaf: true });
  try { fs.lstatSync(uninstallerPath); fail('bridge_uninstaller_preexists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }

  const tree = scanExpectedTree(rootReal, manifest.files);
  verifyApplicationPackageIdentity(rootReal, manifest.files, expectedContext);
  recheckTreeSignatures(rootReal, tree.signatures);

  // Inventory lists its own installed path. Its bytes are derived from paths, not caller-trusted payload content.
  const inventoryWrite = writeDurableExclusiveFile(inventoryPath, manifest.inventoryBytes);
  if (inventoryWrite.sha256 !== manifest.inventorySha256) fail('bridge_inventory_readback_failed');

  const templateResult = writeNsisPayloadManifestTemplate({
    winUnpackedRoot: rootReal,
    trustedInventoryBytes: manifest.inventoryBytes,
    trustedInventorySha256: manifest.inventorySha256,
  });
  if (templateResult.templatePath !== templatePath || templateResult.fullInstallRoot !== false ||
      templateResult.fileCount !== manifest.files.length + 1) {
    fail('bridge_template_writer_contract_reject');
  }
  verifyTemplateAgainstExpected(templatePath, templateResult.templateSha256,
    manifest.files, manifest.inventoryBytes, manifest.inventorySha256);

  const pinBytes = nsisPinInclude(expectedContext, expectedManifestSha256,
    manifest.inventorySha256, templateResult.templateSha256);
  const pinWrite = writeDurableExclusiveFile(pinPath, pinBytes);
  if (pinWrite.sha256 !== sha256(pinBytes)) fail('bridge_nsis_pin_readback_failed');

  return Object.freeze({
    targetPlatform: expectedContext.platform,
    targetArchitecture: expectedContext.architecture,
    sourceManifestSha256: expectedManifestSha256,
    sourceFileCount: manifest.files.length,
    inventoryRelativePath: INVENTORY_RELATIVE_PATH,
    inventorySha256: manifest.inventorySha256,
    templatePath,
    templateSha256: templateResult.templateSha256,
    pinIncludePath: pinPath,
    pinIncludeSha256: pinWrite.sha256,
    fullRootReady: false,
    restoreInputAllowed: false,
  });
}
