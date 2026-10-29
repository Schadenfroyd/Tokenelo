import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KIND = 'tokenelo-windows-expected-content-manifest';
const TRANSFORM_MAP_VERSION = 'electron-44.9.3-local-zip-v1';
const SOURCE_ZIP_URL = 'https://github.com/electron/electron/releases/download/v44.9.3/electron-v44.9.3-win32-x64.zip';
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const REVISION_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const REQUIRED_VENDOR_CORE_SENTINELS = [
  'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak',
];
const REQUIRED_VENDOR_TRANSFORM_INPUTS = [
  'electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'version', 'resources/default_app.asar',
];
const RESERVED = new Set([
  'resources/app/windows-payload-inventory.json',
  'resources/app/windows-payload-manifest.template.json',
  'uninstall tokenelo.exe',
]);
const INVALID_SEGMENT = /[\u0000-\u001f<>"|?*]/u;
const SENSITIVE_SEGMENT = /^(?:\.env(?:\..*)?|data|user[-_ ]?data|app[-_ ]?data|logs?|ledger|history|session[-_ ]?history)$/iu;
const SENSITIVE_BASE = /^(?:tokens?|secrets?|credentials?|fleet[-_.]?token|api[-_.]?(?:token|key)|private[-_.]?key|wallet|config\.json)(?:\..*)?$/iu;
const SQLITE_SUFFIX = /(?:\.(?:sqlite3?|db)|-(?:wal|shm|journal))$/iu;

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code) { throw new Error(code); }
function exactKeys(value, keys, code) {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      Object.keys(value).some(key => !keys.includes(key))) fail(code);
}
function hashPin(value, code) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(code);
}
function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toUpperCase() === right.toUpperCase() : left === right;
}
function within(candidate, parent) {
  const left = path.resolve(candidate);
  const right = path.resolve(parent);
  if (samePath(left, right)) return true;
  const relative = path.relative(right, left);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
function signature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.nlink, stat.mtimeMs, stat.ctimeMs].join(':');
}
function absolute(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !samePath(value, path.resolve(value))) fail(code);
  return path.resolve(value);
}
function isAbsoluteReportedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value) ||
      /[<>"|?*]/u.test(value)) return false;
  let parts;
  if (/^[A-Za-z]:[\\/]/u.test(value)) parts = value.slice(3).split(/[\\/]/u);
  else if (value.startsWith('\\\\')) {
    const uncParts = value.slice(2).split('\\');
    if (uncParts.length < 2 || !uncParts[0] || !uncParts[1]) return false;
    parts = uncParts;
  } else if (value.startsWith('/') && !value.startsWith('//')) parts = value.slice(1).split('/');
  else return false;
  return parts.length > 0 && parts.every(part => part.length > 0 && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' '));
}
function assertReportedAbsolutePath(value, code) {
  if (!isAbsoluteReportedPath(value)) fail(code);
}
function reportedBasename(value) { return value.split(/[\\/]/u).at(-1); }
function assertNoLinksThrough(fullPath, allowMissingLeaf = false) {
  const parsed = path.parse(fullPath);
  const parts = fullPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingLeaf && i === parts.length - 1 && error?.code === 'ENOENT') return;
      fail('supplier_path_missing_or_unreadable');
    }
    if (stat.isSymbolicLink()) fail('supplier_reparse_path_reject');
    let real;
    try { real = fs.realpathSync.native(current); } catch { fail('supplier_path_unreadable'); }
    if (!samePath(real, current)) fail('supplier_path_alias_reject');
    if (i < parts.length - 1 && !stat.isDirectory()) fail('supplier_path_parent_type_reject');
  }
}
function rootDirectory(input, code) {
  const full = absolute(input, code);
  let stat;
  try { stat = fs.lstatSync(full); } catch { fail(code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code);
  assertNoLinksThrough(full);
  if (!samePath(fs.realpathSync.native(full), full)) fail(code);
  return full;
}
function stableRead(filePath, maxBytes, code) {
  let fd;
  try {
    const full = absolute(filePath, code);
    assertNoLinksThrough(full);
    const beforePath = fs.lstatSync(full);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1 ||
        beforePath.size < 0 || beforePath.size > maxBytes) fail(code);
    if (!samePath(fs.realpathSync.native(full), full)) fail(code);
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlock = fs.constants.O_NONBLOCK ?? 0;
    fd = fs.openSync(full, fs.constants.O_RDONLY | noFollow | nonBlock);
    const beforeFd = fs.fstatSync(fd);
    if (!beforeFd.isFile() || signature(beforeFd) !== signature(beforePath)) fail(code);
    const chunks = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > maxBytes) fail(code);
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(full);
    if (signature(afterFd) !== signature(beforeFd) || signature(afterPath) !== signature(beforePath) ||
        afterPath.isSymbolicLink() || bytes !== beforeFd.size || !samePath(fs.realpathSync.native(full), full)) fail(code);
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function hashStable(filePath, expectedSize = null) {
  let fd;
  const code = 'supplier_source_file_invalid';
  try {
    const full = absolute(filePath, code);
    assertNoLinksThrough(full);
    const beforePath = fs.lstatSync(full);
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1 ||
        beforePath.size < 0 || beforePath.size > MAX_FILE_BYTES ||
        (expectedSize !== null && beforePath.size !== expectedSize)) fail(code);
    fd = fs.openSync(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const beforeFd = fs.fstatSync(fd);
    if (!beforeFd.isFile() || signature(beforeFd) !== signature(beforePath)) fail(code);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      size += count;
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(full);
    if (signature(afterFd) !== signature(beforeFd) || signature(afterPath) !== signature(beforePath) ||
        afterPath.isSymbolicLink() || !samePath(fs.realpathSync.native(full), full) || size !== beforeFd.size) fail(code);
    return { sizeBytes: size, sha256: hash.digest('hex'), signature: signature(beforeFd) };
  } catch (error) {
    if (error?.message === code) throw error;
    fail(code);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parsePinnedJson(file, expectedHash, label) {
  hashPin(expectedHash, `${label}_pin_invalid`);
  const bytes = stableRead(file, MAX_DOCUMENT_BYTES, `${label}_read_reject`);
  if (sha256(bytes) !== expectedHash) fail(`${label}_pin_mismatch`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.startsWith('\uFEFF')) fail(`${label}_encoding_reject`);
  let value;
  try { value = JSON.parse(text); } catch { fail(`${label}_json_reject`); }
  return { value, bytes };
}
function validateRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || relative.includes('\\') ||
      relative.includes(':') || relative.startsWith('/') || relative.endsWith('/')) fail('supplier_path_reject');
  const segments = relative.split('/');
  for (const segment of segments) {
    const stem = segment.split('.')[0].toUpperCase();
    if (!segment || segment === '.' || segment === '..' || segment.length > 255 ||
        segment.endsWith('.') || segment.endsWith(' ') || INVALID_SEGMENT.test(segment) ||
        segment.normalize('NFC') !== segment || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) fail('supplier_path_reject');
  }
  const lower = relative.toLowerCase();
  const base = segments.at(-1).toLowerCase();
  if (segments.some(part => SENSITIVE_SEGMENT.test(part)) || SENSITIVE_BASE.test(base) || SQLITE_SUFFIX.test(base) ||
      RESERVED.has(lower)) fail('supplier_sensitive_or_reserved_path_reject');
  return relative;
}
function keyFor(relative) { return relative.normalize('NFC').toUpperCase(); }
function verifyTree(root, expectedRows, sourceClass) {
  const expected = new Map(expectedRows.map(row => [row.path, row]));
  const seen = new Map();
  const actual = [];
  const signatures = new Map();
  const rootStat = fs.lstatSync(root);
  signatures.set('', signature(rootStat));
  const dirs = new Set();
  if (process.platform !== 'win32') dirs.add(`${rootStat.dev}:${rootStat.ino}`);
  function walk(dir, rel = '') {
    let entries;
    try { entries = fs.readdirSync(dir).sort(ordinal); } catch { fail('supplier_tree_read_reject'); }
    for (const name of entries) {
      const relativePath = rel ? `${rel}/${name}` : name;
      validateRelative(relativePath);
      const key = keyFor(relativePath);
      if (seen.has(key)) fail('supplier_tree_case_collision');
      seen.set(key, relativePath);
      const full = path.join(root, ...relativePath.split('/'));
      let stat;
      try { stat = fs.lstatSync(full); } catch { fail('supplier_tree_entry_read_reject'); }
      if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(full), full)) fail('supplier_tree_reparse_reject');
      if (stat.isDirectory()) {
        if (process.platform !== 'win32') {
          const identity = `${stat.dev}:${stat.ino}`;
          if (dirs.has(identity)) fail('supplier_tree_alias_reject');
          dirs.add(identity);
        }
        signatures.set(relativePath, signature(stat));
        walk(full, relativePath);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail('supplier_tree_file_type_reject');
      const pin = expected.get(relativePath);
      if (!pin) fail('supplier_tree_unexpected_file');
      const actualHash = hashStable(full);
      if (actualHash.sizeBytes !== pin.sizeBytes || actualHash.sha256 !== pin.sha256) fail('supplier_tree_content_mismatch');
      signatures.set(relativePath, actualHash.signature);
      actual.push({ path: relativePath, sizeBytes: actualHash.sizeBytes, sha256: actualHash.sha256, sourceClass });
    }
  }
  walk(root);
  if (actual.length !== expectedRows.length) fail('supplier_tree_file_set_mismatch');
  return { files: actual, signatures };
}
function recheckTree(root, signatures) {
  for (const [relative, expected] of signatures) {
    const full = relative ? path.join(root, ...relative.split('/')) : root;
    let stat;
    try { stat = fs.lstatSync(full); } catch { fail('supplier_tree_changed_before_publish'); }
    if (stat.isSymbolicLink() || signature(stat) !== expected || !samePath(fs.realpathSync.native(full), full)) {
      fail('supplier_tree_changed_before_publish');
    }
  }
}
function recheckPinnedFile(filePath, expectedHash, expectedSize = null) {
  const record = hashStable(filePath, expectedSize);
  if (record.sha256 !== expectedHash) fail('supplier_input_changed_before_publish');
}
function assertOutside(outputPath, sourcePaths) {
  for (const source of sourcePaths) {
    if (within(outputPath, source) || within(source, outputPath)) fail('supplier_output_source_overlap_reject');
  }
}
function validateContext(context) {
  exactKeys(context, [
    'sourceRevision', 'applicationVersion', 'electronVersion', 'electronBuilderVersion',
    'stageManifestSha256', 'stagedPayloadManifestSha256', 'vendorArchiveSha256',
  ], 'supplier_context_contract_reject');
  if (typeof context.sourceRevision !== 'string' || !REVISION_RE.test(context.sourceRevision) ||
      !SEMVER_RE.test(context.applicationVersion) || !SEMVER_RE.test(context.electronVersion) ||
      context.electronVersion !== '44.9.3' || context.electronBuilderVersion !== '26.18.0') fail('supplier_context_identity_reject');
  for (const key of ['stageManifestSha256', 'stagedPayloadManifestSha256', 'vendorArchiveSha256']) hashPin(context[key], 'supplier_context_pin_reject');
}
function validateVendorExpected(value) {
  exactKeys(value, [
    'archiveSha256', 'archiveBytes', 'memberManifestSha256', 'inventoryScriptSha256',
    'fileCount', 'totalUncompressedBytes', 'sourceBinding',
  ], 'supplier_vendor_expectation_contract_reject');
  for (const key of ['archiveSha256', 'memberManifestSha256', 'inventoryScriptSha256']) hashPin(value[key], 'supplier_vendor_pin_reject');
  if (!Number.isSafeInteger(value.archiveBytes) || value.archiveBytes < 1 || value.archiveBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(value.fileCount) || value.fileCount < 1 || value.fileCount > 1024 ||
      !Number.isSafeInteger(value.totalUncompressedBytes) || value.totalUncompressedBytes < 1 ||
      value.totalUncompressedBytes > MAX_TOTAL_BYTES) fail('supplier_vendor_expectation_value_reject');
  const bindingKeys = [
    'npmSourceReceiptSha256', 'npmTarballSha512SRI', 'npmChecksumMapExpectedWin32X64ZipSha256',
    'requestReceiptSha256', 'outerReceiptSha256', 'downloadRouteSha256', 'downloadUrl',
  ];
  exactKeys(value.sourceBinding, bindingKeys, 'supplier_vendor_binding_contract_reject');
  for (const key of ['npmSourceReceiptSha256', 'requestReceiptSha256', 'outerReceiptSha256', 'downloadRouteSha256']) hashPin(value.sourceBinding[key], 'supplier_vendor_binding_pin_reject');
  const sri = value.sourceBinding.npmTarballSha512SRI;
  const sriBase64 = typeof sri === 'string' && sri.startsWith('sha512-') ? sri.slice(7) : '';
  if (value.sourceBinding.npmChecksumMapExpectedWin32X64ZipSha256 !== value.archiveSha256 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(sriBase64) || Buffer.from(sriBase64, 'base64').length !== 64 ||
      Buffer.from(sriBase64, 'base64').toString('base64') !== sriBase64 ||
      value.sourceBinding.downloadUrl !== SOURCE_ZIP_URL) fail('supplier_vendor_binding_mismatch');
}
function parseVendorDocument(bytes, pins) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.startsWith('\uFEFF')) fail('supplier_vendor_manifest_encoding_reject');
  let doc;
  try { doc = JSON.parse(text); } catch { fail('supplier_vendor_manifest_json_reject'); }
  exactKeys(doc, ['schemaVersion', 'sourceBinding', 'inventoryScriptSha256', 'archiveSha256', 'archiveBytes', 'files'], 'supplier_vendor_manifest_contract_reject');
  if (doc.schemaVersion !== 1 || doc.archiveSha256 !== pins.archiveSha256 || doc.archiveBytes !== pins.archiveBytes ||
      doc.inventoryScriptSha256 !== pins.inventoryScriptSha256 || !Array.isArray(doc.files) ||
      doc.files.length !== pins.fileCount || !isRecord(doc.sourceBinding) ||
      Object.keys(doc.sourceBinding).length !== Object.keys(pins.sourceBinding).length ||
      Object.entries(pins.sourceBinding).some(([key, value]) => doc.sourceBinding[key] !== value)) fail('supplier_vendor_manifest_binding_reject');
  let total = 0;
  const seen = new Set();
  const rows = [];
  for (const item of doc.files) {
    if (!isRecord(item) || Object.keys(item).some(key => !['path', 'sizeBytes', 'sha256', 'peHeader'].includes(key)) ||
        !['path', 'sizeBytes', 'sha256'].every(key => Object.hasOwn(item, key))) fail('supplier_vendor_row_contract_reject');
    const relative = validateRelative(item.path);
    if (keyFor(relative).startsWith('RESOURCES/APP/')) fail('supplier_vendor_app_namespace_reject');
    const key = keyFor(relative);
    if (seen.has(key)) fail('supplier_vendor_case_collision');
    seen.add(key);
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES) fail('supplier_vendor_row_size_reject');
    hashPin(item.sha256, 'supplier_vendor_row_hash_reject');
    if (item.peHeader !== undefined && (!isRecord(item.peHeader) || item.peHeader.checked !== true)) fail('supplier_vendor_pe_metadata_reject');
    total += item.sizeBytes;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) fail('supplier_vendor_total_size_reject');
    rows.push({ path: relative, sizeBytes: item.sizeBytes, sha256: item.sha256 });
  }
  if (total !== pins.totalUncompressedBytes) fail('supplier_vendor_total_size_mismatch');
  for (const required of [...REQUIRED_VENDOR_CORE_SENTINELS, ...REQUIRED_VENDOR_TRANSFORM_INPUTS]) {
    if (!seen.has(keyFor(required))) fail('supplier_vendor_required_member_missing');
  }
  return rows;
}
function validateResourceEdit(receipt, pins, vendorRows, editedExecutablePath) {
  exactKeys(receipt, [
    'schema', 'status', 'recordedAtUtc', 'mode', 'tool', 'input', 'appInfoStressCase', 'options', 'output',
    'editorElapsedMs', 'codeSigningInvoked', 'childProcessAttempts', 'inputUnchanged',
    'supervisorReadbackSha256', 'supervisorReadbackSizeBytes',
  ], 'supplier_resource_receipt_contract_reject');
  if (receipt.schema !== 'tokenelo.windows-electron-resource-edit-result.v1' || receipt.status !== 'success' ||
      receipt.mode !== 'pristine-vendor-copy-only' || receipt.inputUnchanged !== true ||
      receipt.codeSigningInvoked !== false || !Array.isArray(receipt.childProcessAttempts) || receipt.childProcessAttempts.length !== 0 ||
      !Number.isFinite(receipt.editorElapsedMs) || receipt.editorElapsedMs < 0 ||
      !isRecord(receipt.tool) || !isRecord(receipt.input) || !isRecord(receipt.options) || !isRecord(receipt.output)) fail('supplier_resource_receipt_status_reject');
  exactKeys(receipt.tool, [
    'nodePath', 'nodeVersion', 'appBuilderLibVersion', 'builderUtilVersion', 'reseditVersion', 'peLibraryVersion',
    'resEditSourceSha256', 'appInfoSourceSha256', 'winPackagerSourceSha256', 'packageLockSha256',
  ], 'supplier_resource_tool_contract_reject');
  assertReportedAbsolutePath(receipt.tool.nodePath, 'supplier_resource_tool_path_reject');
  exactKeys(receipt.input, ['archivePath', 'archiveSha256', 'memberPath', 'pristinePath', 'sizeBytes', 'sha256', 'peMachine'],
    'supplier_resource_input_contract_reject');
  if (!isAbsoluteReportedPath(receipt.input.archivePath) || reportedBasename(receipt.input.archivePath) !== 'electron-v44.9.3-win32-x64.zip' ||
      !isAbsoluteReportedPath(receipt.input.pristinePath) || reportedBasename(receipt.input.pristinePath) !== 'pristine-electron.exe' ||
      receipt.input.peMachine !== '0x8664') {
    fail('supplier_resource_input_metadata_reject');
  }
  exactKeys(receipt.options, ['file', 'versionStrings', 'fileVersion', 'productVersion', 'requestedExecutionLevel', 'iconPath', 'iconSha256'],
    'supplier_resource_options_contract_reject');
  exactKeys(receipt.options.versionStrings, ['FileDescription', 'ProductName', 'LegalCopyright', 'InternalName', 'OriginalFilename', 'CompanyName'],
    'supplier_resource_version_strings_contract_reject');
  exactKeys(receipt.output, ['path', 'sizeBytes', 'sha256'], 'supplier_resource_output_contract_reject');
  exactKeys(receipt.appInfoStressCase, [
    'version', 'buildNumber', 'buildVersion', 'productVersion', 'productName', 'productFilename', 'companyName', 'copyright', 'appId',
  ], 'supplier_resource_stress_case_contract_reject');
  if (Object.values(receipt.appInfoStressCase).some(value => typeof value !== 'string')) fail('supplier_resource_stress_case_type_reject');
  const exe = vendorRows.find(row => row.path === 'electron.exe');
  if (!exe || receipt.input.archiveSha256 !== pins.archiveSha256 || receipt.input.memberPath !== 'electron.exe' ||
      receipt.input.sha256 !== exe.sha256 || receipt.input.sizeBytes !== exe.sizeBytes) fail('supplier_resource_input_binding_reject');
  if (!isAbsoluteReportedPath(receipt.output.path) || reportedBasename(receipt.output.path) !== 'Tokenelo.exe' ||
      receipt.options.file !== receipt.output.path || !isAbsoluteReportedPath(receipt.options.iconPath) ||
      reportedBasename(receipt.options.iconPath) !== 'tokenelo-windows.ico' ||
      typeof editedExecutablePath !== 'string' || !path.isAbsolute(editedExecutablePath)) fail('supplier_resource_output_path_binding_reject');
  for (const [key, value] of Object.entries(pins.toolPins)) if (receipt.tool[key] !== value) fail('supplier_resource_tool_binding_reject');
  if (receipt.output.sha256 !== pins.outputSha256 || receipt.output.sizeBytes !== pins.outputSizeBytes ||
      receipt.supervisorReadbackSha256 !== pins.outputSha256 || receipt.supervisorReadbackSizeBytes !== pins.outputSizeBytes ||
      receipt.options.productVersion !== pins.options.productVersion || receipt.options.fileVersion !== pins.options.fileVersion ||
      receipt.options.requestedExecutionLevel !== 'asInvoker' || receipt.options.iconSha256 !== pins.options.iconSha256 ||
      !isRecord(receipt.options.versionStrings) || receipt.options.versionStrings.FileDescription !== 'Tokenelo' ||
      receipt.options.versionStrings.ProductName !== 'Tokenelo' || receipt.options.versionStrings.InternalName !== 'Tokenelo' ||
      receipt.options.versionStrings.CompanyName !== 'Elo AI' ||
      receipt.options.versionStrings.LegalCopyright !== 'Copyright © 2026 Elo AI' ||
      receipt.options.versionStrings.OriginalFilename !== '') fail('supplier_resource_output_binding_reject');
}

/**
 * Joins separately pinned source inputs into the bridge's expected-content schema.
 * Provenance is descriptive caller-supplied evidence; this function does not attest
 * publisher signatures, builder output, package authenticity, or installation state.
 */
export function assembleNsisExpectedContent(input) {
  exactKeys(input, [
    'stageRoot', 'stageManifestPath', 'payloadManifestPath', 'vendorMemberManifestPath',
    'resourceEditReceiptPath', 'editedExecutablePath', 'outputPath', 'expectedContext',
    'expectedVendor', 'expectedResourceEdit', 'transformMapVersion',
  ], 'supplier_input_contract_reject');
  if (input.transformMapVersion !== TRANSFORM_MAP_VERSION) fail('supplier_transform_map_version_reject');
  validateContext(input.expectedContext);
  validateVendorExpected(input.expectedVendor);
  exactKeys(input.expectedResourceEdit, [
    'receiptSha256', 'outputSha256', 'outputSizeBytes', 'iconSha256', 'toolPins', 'options',
  ], 'supplier_resource_expectation_contract_reject');
  hashPin(input.expectedResourceEdit.receiptSha256, 'supplier_resource_pin_reject');
  hashPin(input.expectedResourceEdit.outputSha256, 'supplier_resource_pin_reject');
  hashPin(input.expectedResourceEdit.iconSha256, 'supplier_resource_pin_reject');
  if (!Number.isSafeInteger(input.expectedResourceEdit.outputSizeBytes) || input.expectedResourceEdit.outputSizeBytes < 1 ||
      !isRecord(input.expectedResourceEdit.toolPins) || !isRecord(input.expectedResourceEdit.options)) fail('supplier_resource_expectation_value_reject');
  exactKeys(input.expectedResourceEdit.toolPins, [
    'nodeVersion', 'appBuilderLibVersion', 'builderUtilVersion', 'reseditVersion', 'peLibraryVersion',
    'resEditSourceSha256', 'appInfoSourceSha256', 'winPackagerSourceSha256', 'packageLockSha256',
  ], 'supplier_resource_tool_expectation_contract_reject');
  exactKeys(input.expectedResourceEdit.options, ['productVersion', 'fileVersion', 'iconSha256'],
    'supplier_resource_options_expectation_contract_reject');
  for (const key of ['resEditSourceSha256', 'appInfoSourceSha256', 'winPackagerSourceSha256', 'packageLockSha256']) {
    hashPin(input.expectedResourceEdit.toolPins[key], 'supplier_resource_tool_pin_reject');
  }
  if (input.expectedResourceEdit.options.iconSha256 !== input.expectedResourceEdit.iconSha256 ||
      input.expectedResourceEdit.options.productVersion !== `${input.expectedContext.applicationVersion}.0` ||
      input.expectedResourceEdit.options.fileVersion !== input.expectedContext.applicationVersion) fail('supplier_resource_options_pin_reject');
  if (input.expectedContext.vendorArchiveSha256 !== input.expectedVendor.archiveSha256) fail('supplier_vendor_context_pin_mismatch');
  const stageRoot = rootDirectory(input.stageRoot, 'supplier_stage_root_reject');
  const sourceFiles = [
    stageRoot,
    absolute(input.stageManifestPath, 'supplier_stage_manifest_path_reject'),
    absolute(input.payloadManifestPath, 'supplier_payload_manifest_path_reject'),
    absolute(input.vendorMemberManifestPath, 'supplier_vendor_manifest_path_reject'),
    absolute(input.resourceEditReceiptPath, 'supplier_resource_receipt_path_reject'),
    absolute(input.editedExecutablePath, 'supplier_edited_executable_path_reject'),
  ];
  const sourceRoots = [stageRoot, ...sourceFiles.slice(1).map(filePath => path.dirname(filePath))];
  const outputPath = absolute(input.outputPath, 'supplier_output_path_reject');
  assertOutside(outputPath, sourceRoots);
  const outputParent = path.dirname(outputPath);
  rootDirectory(outputParent, 'supplier_output_parent_reject');
  assertNoLinksThrough(outputPath, true);
  try { fs.lstatSync(outputPath); fail('supplier_output_already_exists'); }
  catch (error) { if (error?.message === 'supplier_output_already_exists') throw error; if (error?.code !== 'ENOENT') throw error; }

  const { value: stage, bytes: stageBytes } = parsePinnedJson(input.stageManifestPath,
    input.expectedContext.stageManifestSha256, 'supplier_stage_manifest');
  if (!canonicalBytes(stage).equals(stageBytes)) fail('supplier_stage_manifest_encoding_reject');
  exactKeys(stage, ['schemaVersion', 'kind', 'privacy', 'releasePolicy', 'source', 'application', 'payload'], 'supplier_stage_manifest_contract_reject');
  if (stage.schemaVersion !== 1 || stage.kind !== 'tokenelo-private-electron-stage' || stage.privacy !== 'private' ||
      !isRecord(stage.releasePolicy) || stage.releasePolicy.publish !== 'never' || stage.releasePolicy.publicAutoUpdates !== false ||
      !isRecord(stage.source) || stage.source.dirty !== false || stage.source.revision !== input.expectedContext.sourceRevision ||
      !isRecord(stage.application) || stage.application.name !== 'tokenelo' || stage.application.private !== true ||
      stage.application.type !== 'module' || stage.application.main !== 'dist/tray/main.js' ||
      stage.application.version !== input.expectedContext.applicationVersion ||
      stage.application.electronVersion !== input.expectedContext.electronVersion ||
      stage.application.electronBuilderVersion !== input.expectedContext.electronBuilderVersion ||
      !isRecord(stage.payload) || stage.payload.manifest !== 'payload-manifest.private.json' ||
      stage.payload.manifestSha256 !== input.expectedContext.stagedPayloadManifestSha256 ||
      !Number.isSafeInteger(stage.payload.fileCount) || stage.payload.fileCount < 1 ||
      typeof stage.payload.sha256 !== 'string' || !SHA256_RE.test(stage.payload.sha256)) fail('supplier_stage_manifest_binding_reject');
  exactKeys(stage.releasePolicy, ['publish', 'publicAutoUpdates'], 'supplier_stage_release_policy_reject');
  exactKeys(stage.source, ['revision', 'dirty', 'distManifestSha256', 'verificationScope'], 'supplier_stage_source_contract_reject');
  hashPin(stage.source.distManifestSha256, 'supplier_stage_source_pin_reject');
  exactKeys(stage.application, ['name', 'version', 'private', 'type', 'main', 'electronVersion', 'electronBuilderVersion'],
    'supplier_stage_application_contract_reject');
  exactKeys(stage.payload, ['fileCount', 'manifest', 'manifestSha256', 'sha256'], 'supplier_stage_payload_contract_reject');
  const { value: payload, bytes: payloadBytes } = parsePinnedJson(input.payloadManifestPath,
    input.expectedContext.stagedPayloadManifestSha256, 'supplier_payload_manifest');
  if (!canonicalBytes(payload).equals(payloadBytes)) fail('supplier_payload_manifest_encoding_reject');
  exactKeys(payload, ['schemaVersion', 'root', 'files'], 'supplier_payload_manifest_contract_reject');
  if (payload.schemaVersion !== 1 || payload.root !== 'app' || !Array.isArray(payload.files) ||
      payload.files.length < 2 || payload.files.length !== stage.payload.fileCount) fail('supplier_payload_manifest_contract_reject');
  let appTotal = 0;
  const appRows = [];
  const appSeen = new Set();
  for (const item of payload.files) {
    exactKeys(item, ['path', 'sizeBytes', 'sha256'], 'supplier_payload_row_contract_reject');
    const relative = validateRelative(item.path);
    const key = keyFor(relative);
    if (appSeen.has(key) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_FILE_BYTES) fail('supplier_payload_row_reject');
    hashPin(item.sha256, 'supplier_payload_row_hash_reject');
    appSeen.add(key);
    appTotal += item.sizeBytes;
    if (!Number.isSafeInteger(appTotal) || appTotal > MAX_TOTAL_BYTES) fail('supplier_payload_total_size_reject');
    appRows.push({ path: relative, sizeBytes: item.sizeBytes, sha256: item.sha256 });
  }
  if (!appSeen.has(keyFor('package.json')) || !appSeen.has(keyFor('dist/tray/main.js'))) fail('supplier_payload_required_file_missing');
  const canonicalAppRows = [...appRows].sort((a, b) => ordinal(a.path, b.path));
  if (appRows.some((row, index) => row.path !== canonicalAppRows[index].path)) fail('supplier_payload_manifest_order_reject');
  appRows.sort((a, b) => ordinal(a.path, b.path));
  const stagePayloadSummarySha256 = sha256(Buffer.from(JSON.stringify({ schemaVersion: 1, files: appRows }), 'utf8'));
  if (stage.payload.sha256 !== stagePayloadSummarySha256) fail('supplier_stage_payload_summary_mismatch');
  const scannedApp = verifyTree(stageRoot, appRows, 'app-stage');
  const appActual = scannedApp.files;
  const packageRow = appRows.find(row => row.path === 'package.json');
  if (!packageRow || packageRow.sizeBytes > 1024 * 1024) fail('supplier_staged_package_reject');
  const stagedPackage = JSON.parse(stableRead(path.join(stageRoot, 'package.json'), 1024 * 1024, 'supplier_staged_package_reject').toString('utf8'));
  if (stagedPackage.name !== 'tokenelo' || stagedPackage.version !== input.expectedContext.applicationVersion ||
      stagedPackage.private !== true || stagedPackage.type !== 'module' || stagedPackage.main !== 'dist/tray/main.js') fail('supplier_staged_package_identity_reject');
  if (sha256(payloadBytes) !== input.expectedContext.stagedPayloadManifestSha256 || sha256(stageBytes) !== input.expectedContext.stageManifestSha256) fail('supplier_manifest_hash_internal_error');

  const vendorBytes = stableRead(input.vendorMemberManifestPath, MAX_DOCUMENT_BYTES, 'supplier_vendor_manifest_read_reject');
  if (sha256(vendorBytes) !== input.expectedVendor.memberManifestSha256) fail('supplier_vendor_manifest_pin_mismatch');
  const vendorRows = parseVendorDocument(vendorBytes, input.expectedVendor);
  const resourceBytes = stableRead(input.resourceEditReceiptPath, MAX_DOCUMENT_BYTES, 'supplier_resource_receipt_read_reject');
  if (sha256(resourceBytes) !== input.expectedResourceEdit.receiptSha256) fail('supplier_resource_receipt_pin_mismatch');
  const resourceText = resourceBytes.toString('utf8');
  if (!Buffer.from(resourceText, 'utf8').equals(resourceBytes) || resourceText.startsWith('\uFEFF')) fail('supplier_resource_receipt_encoding_reject');
  let resourceReceipt;
  try { resourceReceipt = JSON.parse(resourceText); } catch { fail('supplier_resource_receipt_json_reject'); }
  validateResourceEdit(resourceReceipt, {
    ...input.expectedResourceEdit,
    archiveSha256: input.expectedVendor.archiveSha256,
    options: { ...input.expectedResourceEdit.options },
  }, vendorRows, input.editedExecutablePath);
  const editedExe = hashStable(input.editedExecutablePath, input.expectedResourceEdit.outputSizeBytes);
  if (editedExe.sha256 !== input.expectedResourceEdit.outputSha256) fail('supplier_edited_executable_pin_mismatch');

  const records = appActual.map(row => ({
    relativePath: `resources/app/${row.path}`,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    provenance: {
      sourceClass: 'app-stage', sourceArtifactSha256: input.expectedContext.stagedPayloadManifestSha256,
      sourceRelativePath: row.path,
    },
  }));
  for (const row of vendorRows) {
    if (row.path === 'electron.exe') {
      records.push({ relativePath: 'Tokenelo.exe', sizeBytes: editedExe.sizeBytes, sha256: editedExe.sha256, provenance: {
        sourceClass: 'verified-transform', sourceArtifactSha256: input.expectedVendor.archiveSha256,
        sourceRelativePath: row.path, sourceBytesSha256: row.sha256, transformId: 'electron-exe-resource-edit-v1',
      } });
    } else if (row.path === 'LICENSE') {
      records.push({ relativePath: 'LICENSE.electron.txt', sizeBytes: row.sizeBytes, sha256: row.sha256, provenance: {
        sourceClass: 'verified-transform', sourceArtifactSha256: input.expectedVendor.archiveSha256,
        sourceRelativePath: row.path, sourceBytesSha256: row.sha256, transformId: 'electron-license-rename-v1',
      } });
    } else {
      records.push({ relativePath: row.path, sizeBytes: row.sizeBytes, sha256: row.sha256, provenance: {
        sourceClass: 'vendor-electron', sourceArtifactSha256: input.expectedVendor.archiveSha256,
        sourceRelativePath: row.path,
      } });
    }
  }
  records.sort((a, b) => ordinal(a.relativePath, b.relativePath));
  const paths = new Set();
  let totalBytes = 0;
  for (const record of records) {
    validateRelative(record.relativePath);
    const key = keyFor(record.relativePath);
    if (paths.has(key)) fail('supplier_output_case_collision');
    paths.add(key);
    if (!Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0) fail('supplier_output_size_reject');
    hashPin(record.sha256, 'supplier_output_hash_reject');
    totalBytes += record.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) fail('supplier_output_total_size_reject');
  }
  const required = [
    'Tokenelo.exe', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin',
    'locales/en-US.pak', 'resources/app/package.json', 'resources/app/dist/tray/main.js',
    'LICENSE.electron.txt', 'LICENSES.chromium.html', 'version', 'resources/default_app.asar',
  ];
  for (const item of required) if (!paths.has(keyFor(item))) fail('supplier_output_required_file_missing');
  const context = input.expectedContext;
  const manifest = {
    schemaVersion: 1,
    kind: KIND,
    platform: 'win32',
    architecture: 'x64',
    outputDirectoryName: 'win-unpacked',
    packageIdentity: 'com.elostudios.tokenelo',
    applicationPackageName: 'tokenelo',
    applicationVersion: context.applicationVersion,
    electronVersion: context.electronVersion,
    electronBuilderVersion: context.electronBuilderVersion,
    sourceRevision: context.sourceRevision,
    stageManifestSha256: context.stageManifestSha256,
    stagedPayloadManifestSha256: context.stagedPayloadManifestSha256,
    vendorArchiveSha256: context.vendorArchiveSha256,
    files: records,
  };
  const bytes = canonicalBytes(manifest);
  if (bytes.length > MAX_DOCUMENT_BYTES) fail('supplier_output_manifest_too_large');
  const outputHash = sha256(bytes);
  recheckTree(stageRoot, scannedApp.signatures);
  recheckPinnedFile(input.stageManifestPath, context.stageManifestSha256);
  recheckPinnedFile(input.payloadManifestPath, context.stagedPayloadManifestSha256);
  recheckPinnedFile(input.vendorMemberManifestPath, input.expectedVendor.memberManifestSha256);
  recheckPinnedFile(input.resourceEditReceiptPath, input.expectedResourceEdit.receiptSha256);
  recheckPinnedFile(input.editedExecutablePath, input.expectedResourceEdit.outputSha256, input.expectedResourceEdit.outputSizeBytes);
  let fd;
  try {
    fd = fs.openSync(outputPath, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) fail('supplier_output_write_failed');
      offset += written;
    }
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.message === 'supplier_output_already_exists' || error?.message === 'supplier_output_write_failed') throw error;
    if (error?.code === 'EEXIST') fail('supplier_output_already_exists');
    fail('supplier_output_write_failed');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  const saved = stableRead(outputPath, MAX_DOCUMENT_BYTES, 'supplier_output_readback_reject');
  if (saved.length !== bytes.length || sha256(saved) !== outputHash) fail('supplier_output_readback_reject');
  return Object.freeze({
    status: 'expected_content_complete',
    outputSha256: outputHash,
    fileCount: records.length,
    totalBytes,
    transformMapVersion: TRANSFORM_MAP_VERSION,
  });
}

export const nsisExpectedContentSupplierContract = Object.freeze({
  kind: KIND,
  transformMapVersion: TRANSFORM_MAP_VERSION,
  customZipPreservedMembers: Object.freeze(['version', 'resources/default_app.asar', 'locales/*']),
  outputSchema: Object.freeze(['schemaVersion', 'kind', 'platform', 'architecture', 'outputDirectoryName',
    'packageIdentity', 'applicationPackageName', 'applicationVersion', 'electronVersion',
    'electronBuilderVersion', 'sourceRevision', 'stageManifestSha256', 'stagedPayloadManifestSha256',
    'vendorArchiveSha256', 'files']),
});
