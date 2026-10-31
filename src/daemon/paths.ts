/**
 * Per-OS config/data/log directories (DESIGN.md §2.2). All overridable for tests via
 * TOKENELO_HOME — when set, config, data and logs all live under
 * `<TOKENELO_HOME>/config`, `<TOKENELO_HOME>/data`, `<TOKENELO_HOME>/logs` respectively, so a
 * test never touches the real per-OS locations.
 *
 * | | Config | Data | Logs |
 * |---|---|---|---|
 * | macOS   | ~/Library/Application Support/Tokenelo/config.json | same dir /tokenelo.db | ~/Library/Logs/Tokenelo/ |
 * | Linux   | $XDG_CONFIG_HOME/tokenelo/config.json | $XDG_DATA_HOME/tokenelo/ | $XDG_STATE_HOME/tokenelo/ |
 * | Windows | %APPDATA%\Tokenelo\config.json | %LOCALAPPDATA%\Tokenelo\ | %LOCALAPPDATA%\Tokenelo\logs\ |
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface TokeneloPaths {
  configDir: string;
  configFile: string;
  dataDir: string;
  dbFile: string;
  logsDir: string;
  /** Data dir / api-token — bearer token for the daemon's local HTTP API (§15.7.3). Created 0600. */
  apiTokenFile: string;
  /** Data dir / fleet-token — optional Tailscale-only fleet listener bearer token. Created 0600. */
  fleetTokenFile: string;
  /** Daemon's exclusive lock file (single instance + "who owns the port") (§15.7.5). */
  lockFile: string;
}

/**
 * `resolveBaseDirs`/`getPaths` accept an explicit `platform` override so tests can exercise
 * every OS branch on a single host (DESIGN §2.2 table above). Node's default `path` module
 * always joins with the HOST's separator, though, so on a real Windows box a simulated
 * `platform: 'darwin'`/`'linux'` test would still get backslash-joined paths back — wrong, and
 * exactly backwards from what the override is for. The darwin/XDG branches below always target
 * a POSIX layout regardless of host, so they join with `path.posix.join`. The win32 branch is
 * deliberately left on plain `path.join`: it targets whatever the *host's* join gives (this
 * only matters for tests exercising it cross-platform, and every such test computes its
 * expected value the same host-native way, so the two stay in lockstep either way).
 */
function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}
function xdgStateHome(): string {
  return process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

/**
 * Computes the three base directories for the current OS (or TOKENELO_HOME override).
 * Pure function of (platform, env, homedir) — no filesystem access, so it is trivially testable.
 */
export function resolveBaseDirs(opts?: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}): { configDir: string; dataDir: string; logsDir: string } {
  const env = opts?.env ?? process.env;
  const testHome = env.TOKENELO_HOME;
  if (testHome) {
    return {
      configDir: path.join(testHome, 'config'),
      dataDir: path.join(testHome, 'data'),
      logsDir: path.join(testHome, 'logs'),
    };
  }

  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? os.homedir();

  if (platform === 'darwin') {
    return {
      configDir: path.posix.join(home, 'Library', 'Application Support', 'Tokenelo'),
      dataDir: path.posix.join(home, 'Library', 'Application Support', 'Tokenelo'),
      logsDir: path.posix.join(home, 'Library', 'Logs', 'Tokenelo'),
    };
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return {
      configDir: path.join(appData, 'Tokenelo'),
      dataDir: path.join(localAppData, 'Tokenelo'),
      logsDir: path.join(localAppData, 'Tokenelo', 'logs'),
    };
  }

  // Linux and everything else: XDG.
  const xdgEnv = {
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: env.XDG_DATA_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
  };
  const cfg = xdgEnv.XDG_CONFIG_HOME || path.posix.join(home, '.config');
  const data = xdgEnv.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
  const state = xdgEnv.XDG_STATE_HOME || path.posix.join(home, '.local', 'state');
  return {
    configDir: path.posix.join(cfg, 'tokenelo'),
    dataDir: path.posix.join(data, 'tokenelo'),
    logsDir: path.posix.join(state, 'tokenelo'),
  };
}

export function getPaths(opts?: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}): TokeneloPaths {
  const { configDir, dataDir, logsDir } = resolveBaseDirs(opts);
  // Match resolveBaseDirs' own join choice above: TOKENELO_HOME and the win32 branch there both
  // join with host-native `path.join`; darwin/XDG always join POSIX-style. Appending
  // config.json/tokenelo.db/etc. here must use the same separator those dirs were built with.
  const env = opts?.env ?? process.env;
  const platform = opts?.platform ?? process.platform;
  const join = env.TOKENELO_HOME || platform === 'win32' ? path.join : path.posix.join;
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    dataDir,
    dbFile: join(dataDir, 'tokenelo.db'),
    logsDir,
    apiTokenFile: join(dataDir, 'api-token'),
    fleetTokenFile: join(dataDir, 'fleet-token'),
    lockFile: join(dataDir, 'tokenelo.lock'),
  };
}

/** Ensures configDir/dataDir/logsDir exist (idempotent, 0700 on the data dir where secrets live). */
export function ensureDirs(paths: TokeneloPaths): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.logsDir, { recursive: true });
}

/**
 * Writes an API bearer token only after securing an empty file. New paths are claimed exclusively;
 * replacements use a same-directory temporary file before atomically replacing the old path.
 */
export type SecretFilePermissionCheck = (filePath: string) => boolean;

export function writeApiToken(
  paths: TokeneloPaths,
  token: string,
  checkPermissions: SecretFilePermissionCheck = tightenSecretFilePermissions,
  replaceExisting = true,
  checkDirectoryPermissions: SecretDirectoryPermissionCheck = verifySecretDirectoryPermissions,
): boolean {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  return writeSecretFileAtomically(paths.apiTokenFile, token, checkPermissions, replaceExisting, checkDirectoryPermissions);
}

/**
 * Re-applies the permission restriction to an existing API-token file. Fresh writes use
 * writeSecretFileAtomically, which verifies an empty file before writing token bytes.
 * The returned boolean is a security gate: callers must withhold the token when it is false.
 */
export function tightenTokenFilePermissions(paths: TokeneloPaths): boolean {
  return tightenSecretFilePermissions(paths.apiTokenFile);
}

/** Re-applies current-user-only permissions to any daemon secret file. */
export function tightenSecretFilePermissions(filePath: string): boolean {
  if (process.platform === 'win32') {
    return restrictToCurrentUserWindows(filePath);
  }
  try {
    fs.chmodSync(filePath, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes secret bytes only after the empty file passes the permission check. Replacements stage in
 * an exclusive same-directory file and rename it into place after writing and flushing. New paths
 * are claimed exclusively at the destination and cleaned up if permission verification fails.
 */
export function writeSecretFileAtomically(
  filePath: string,
  contents: string,
  checkPermissions: SecretFilePermissionCheck = tightenSecretFilePermissions,
  replaceExisting = true,
  checkDirectoryPermissions: SecretDirectoryPermissionCheck = verifySecretDirectoryPermissions,
): boolean {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!checkDirectoryPermissions(directory)) return false;
  let cleanupPath: string | undefined;
  let fileDescriptor: number | undefined;
  try {
    if (replaceExisting) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const candidate = path.join(
          directory,
          '.' + path.basename(filePath) + '.' + process.pid + '.' + crypto.randomBytes(12).toString('hex') + '.tmp',
        );
        try {
          fileDescriptor = fs.openSync(candidate, 'wx', 0o600);
          cleanupPath = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } else {
      // Claim a missing destination exclusively so a concurrent valid token cannot be replaced.
      fileDescriptor = fs.openSync(filePath, 'wx', 0o600);
      cleanupPath = filePath;
    }
    if (fileDescriptor === undefined || cleanupPath === undefined) {
      throw new Error('could not create a temporary secret file');
    }
    if (!checkPermissions(cleanupPath)) return false;
    fs.ftruncateSync(fileDescriptor, 0);
    fs.writeFileSync(fileDescriptor, contents, { encoding: 'utf8' });
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    if (replaceExisting) fs.renameSync(cleanupPath, filePath);
    cleanupPath = undefined;
    return true;
  } finally {
    if (fileDescriptor !== undefined) {
      try { fs.closeSync(fileDescriptor); } catch { /* best-effort cleanup */ }
    }
    if (cleanupPath !== undefined) {
      try { fs.rmSync(cleanupPath, { force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}
/**
 * Belt-and-suspenders permission tightening for the SQLite data files (security audit #7): chmod
 * the data dir to 0700 and `tokenelo.db` / `-wal` / `-shm` to 0600 on POSIX, independent of
 * whatever `umask` the daemon process happened to start with. A sibling file that doesn't exist
 * yet (e.g. `-wal`/`-shm` before the first write) is silently skipped, not an error.
 */
export function tightenDataDirPermissions(paths: TokeneloPaths): void {
  if (process.platform === 'win32') return; // POSIX modes are not meaningful there (see above)
  try {
    fs.chmodSync(paths.dataDir, 0o700);
  } catch {
    // best effort
  }
  for (const file of [paths.dbFile, `${paths.dbFile}-wal`, `${paths.dbFile}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  }
}

/** Permission check applied to a secret's parent directory before staging. */
export type SecretDirectoryPermissionCheck = (directoryPath: string) => boolean;

/** Structured options for the hidden Windows PowerShell ACL operation. */
export interface WindowsAclCommandOptions {
  encoding: 'utf8';
  stdio: readonly ['ignore', 'pipe', 'ignore'];
  windowsHide: true;
  timeout: number;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

export type WindowsAclExec = (
  command: string,
  args: string[],
  options: WindowsAclCommandOptions,
) => string | Buffer;

export interface RestrictToCurrentUserWindowsOptions {
  /** Test seams; production uses the host's SystemRoot Windows PowerShell 5.1 and process platform. */
  platform?: NodeJS.Platform;
  systemRoot?: string;
  execFile?: WindowsAclExec;
}

const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$target = $env:TOKENELO_ACL_TARGET",
  "$mode = $env:TOKENELO_ACL_MODE",
  "if ([string]::IsNullOrWhiteSpace($target)) { throw 'missing target' }",
  "",
  "$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "if ($null -eq $currentSid) { throw 'missing current SID' }",
  "$currentSidValue = $currentSid.Value",
  "",
  "# No module cmdlets. On a hosted Windows image, for a fresh standard user with no module analysis cache, a module",
  "# cmdlet in this script ran far past the helper's deadline (most likely PowerShell analyzing the many modules on the",
  "# machine's module path). The readback is composed from .NET calls and in-script functions, which need no module.",
  "# Every value given to JsonText is a SID or a fixed literal, so only the quote and the backslash are escaped.",
  "$quote = [string][char]34",
  "function JsonText([string]$value) { return $quote + $value.Replace('\\', '\\\\').Replace($quote, '\\' + $quote) + $quote }",
  "function JsonFlag([bool]$value) { if ($value) { return 'true' } return 'false' }",
  "function JsonNumber([int]$value) { return [string]$value }",
  "function JsonPair([string]$name, [string]$encoded) { return $quote + $name + $quote + ':' + $encoded }",
  "function JsonObject([string[]]$pairs) { return '{' + ($pairs -join ',') + '}' }",
  "",
  "function Get-CheckedPrivateDirectory([string]$directoryPath, [string]$sidValue) {",
  "  $attributes = [System.IO.File]::GetAttributes($directoryPath)",
  "  if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or",
  "      ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {",
  "    throw 'parent must be a non-reparse directory'",
  "  }",
  "  $directoryAcl = [System.IO.Directory]::GetAccessControl($directoryPath)",
  "  $ownerSid = $directoryAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "  if ($ownerSid -ne $sidValue) { throw 'parent owner mismatch' }",
  "  $trustedSids = @($sidValue, 'S-1-5-18', 'S-1-5-32-544')",
  "  $rules = $directoryAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
  "  foreach ($rule in $rules) {",
  "    $principalSid = $rule.IdentityReference.Value",
  "    $creatorOwnerTemplate = $principalSid -eq 'S-1-3-0' -and",
  "      (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)",
  "    $trusted = ($trustedSids -contains $principalSid) -or $creatorOwnerTemplate",
  "    # Reject all nonzero foreign Allow grants, including generic/unknown rights.",
  "    $unsafe = ([int]$rule.FileSystemRights -ne 0)",
  "    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and",
  "        -not $trusted -and $unsafe) {",
  "      throw 'parent grants an untrusted principal read or path-write access'",
  "    }",
  "  }",
  "  return [pscustomobject]@{ ownerSid = $ownerSid; private = $true; isReparsePoint = $false }",
  "}",
  "",
  "if ($mode -eq 'directory') {",
  "  $directoryState = Get-CheckedPrivateDirectory $target $currentSidValue",
  "  JsonObject @(",
  "    (JsonPair 'schemaVersion' (JsonNumber 1)),",
  "    (JsonPair 'operation' (JsonText 'directory')),",
  "    (JsonPair 'currentSid' (JsonText $currentSidValue)),",
  "    (JsonPair 'directoryOwnerSid' (JsonText ($directoryState.ownerSid))),",
  "    (JsonPair 'directoryPrivate' (JsonFlag ($directoryState.private))),",
  "    (JsonPair 'directoryIsReparsePoint' (JsonFlag ($directoryState.isReparsePoint)))",
  "  )",
  "  exit 0",
  "}",
  "if ($mode -ne 'file') { throw 'invalid operation' }",
  "",
  "$parentPath = [System.IO.Path]::GetDirectoryName($target)",
  "$parentState = Get-CheckedPrivateDirectory $parentPath $currentSidValue",
  "$fileAttributes = [System.IO.File]::GetAttributes($target)",
  "if (($fileAttributes -band [System.IO.FileAttributes]::Directory) -ne 0 -or",
  "    ($fileAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {",
  "  throw 'target must be a non-reparse file'",
  "}",
  "$fileAclBefore = [System.IO.File]::GetAccessControl($target)",
  "$fileOwnerBefore = $fileAclBefore.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "if ($fileOwnerBefore -ne $currentSidValue) { throw 'file owner mismatch' }",
  "",
  "$desiredRights = [System.Security.AccessControl.FileSystemRights]::Read -bor",
  "  [System.Security.AccessControl.FileSystemRights]::Write -bor",
  "  [System.Security.AccessControl.FileSystemRights]::Delete",
  "$replacementAcl = [System.Security.AccessControl.FileSecurity]::new()",
  "$replacementAcl.SetAccessRuleProtection($true, $false)",
  "$desiredRule = [System.Security.AccessControl.FileSystemAccessRule]::new(",
  "  $currentSid,",
  "  $desiredRights,",
  "  [System.Security.AccessControl.AccessControlType]::Allow",
  ")",
  "$replacementAcl.AddAccessRule($desiredRule)",
  "[System.IO.File]::SetAccessControl($target, $replacementAcl)",
  "",
  "$fileAttributesAfter = [System.IO.File]::GetAttributes($target)",
  "if (($fileAttributesAfter -band [System.IO.FileAttributes]::Directory) -ne 0 -or",
  "    ($fileAttributesAfter -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {",
  "  throw 'target changed to a directory or reparse point'",
  "}",
  "$fileAclAfter = [System.IO.File]::GetAccessControl($target)",
  "$fileOwnerAfter = $fileAclAfter.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "$rules = $fileAclAfter.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
  "if ($fileOwnerAfter -ne $currentSidValue -or -not $fileAclAfter.AreAccessRulesProtected -or $rules.Count -ne 1) {",
  "  throw 'DACL readback does not match the protected single-owner policy'",
  "}",
  "$rule = $rules[0]",
  "$rightsMask = [int]$rule.FileSystemRights",
  "$expectedRightsMask = [int]$desiredRule.FileSystemRights",
  "if ($rule.IdentityReference.Value -ne $currentSidValue -or",
  "    $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or",
  "    $rule.IsInherited -or $rightsMask -ne $expectedRightsMask) {",
  "  throw 'DACL readback differs from the requested current-SID grant'",
  "}",
  "JsonObject @(",
  "  (JsonPair 'schemaVersion' (JsonNumber 1)),",
  "  (JsonPair 'operation' (JsonText 'file')),",
  "  (JsonPair 'currentSid' (JsonText $currentSidValue)),",
  "  (JsonPair 'parentOwnerSid' (JsonText ($parentState.ownerSid))),",
  "  (JsonPair 'parentPrivate' (JsonFlag ($parentState.private))),",
  "  (JsonPair 'parentIsReparsePoint' (JsonFlag ($parentState.isReparsePoint))),",
  "  (JsonPair 'fileOwnerSid' (JsonText $fileOwnerAfter)),",
  "  (JsonPair 'fileIsDirectory' (JsonFlag $false)),",
  "  (JsonPair 'fileIsReparsePoint' (JsonFlag $false)),",
  "  (JsonPair 'daclProtected' (JsonFlag ($fileAclAfter.AreAccessRulesProtected))),",
  "  (JsonPair 'aceCount' (JsonNumber ($rules.Count))),",
  "  (JsonPair 'aceSid' (JsonText ($rule.IdentityReference.Value))),",
  "  (JsonPair 'aceType' (JsonText ($rule.AccessControlType.ToString()))),",
  "  (JsonPair 'aceIsInherited' (JsonFlag ($rule.IsInherited))),",
  "  (JsonPair 'rightsMask' (JsonNumber $rightsMask)),",
  "  (JsonPair 'expectedRightsMask' (JsonNumber $expectedRightsMask)),",
  "  (JsonPair 'expectedRights' (JsonText 'Read|Write|Delete'))",
  ")",
].join('\n');

const WINDOWS_ACL_SID_RE = /^S-\d+-\d+(?:-\d+)+$/i;

function parseWindowsAclReadback(output: string): Record<string, unknown> {
  const value: unknown = JSON.parse(output.trim());
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid ACL readback');
  return value as Record<string, unknown>;
}

function runWindowsAclScript(
  targetPath: string,
  mode: 'directory' | 'file',
  options: RestrictToCurrentUserWindowsOptions,
): Record<string, unknown> {
  const systemRoot = options.systemRoot ?? process.env.SystemRoot;
  if (!systemRoot) throw new Error('SystemRoot is unavailable');
  const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    TOKENELO_ACL_TARGET: targetPath,
    TOKENELO_ACL_MODE: mode,
  };
  for (const name of ['TEMP', 'TMP']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  const execFile: WindowsAclExec = options.execFile ?? ((executable, args, commandOptions) =>
    execFileSync(executable, args, commandOptions as never) as string | Buffer);
  const output = execFile(command, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 65536,
    env,
  });
  return parseWindowsAclReadback(Buffer.isBuffer(output) ? output.toString('utf8') : output);
}

function isSafeWindowsDirectoryReadback(record: Record<string, unknown>): boolean {
  const sid = record.currentSid;
  return record.schemaVersion === 1 &&
    record.operation === 'directory' &&
    typeof sid === 'string' && WINDOWS_ACL_SID_RE.test(sid) &&
    record.directoryOwnerSid === sid &&
    record.directoryPrivate === true &&
    record.directoryIsReparsePoint === false;
}

function isSafeWindowsAclReadback(record: Record<string, unknown>): boolean {
  const sid = record.currentSid;
  // Allow rules add Synchronize to the native Read|Write|Delete mask.
  const expectedRightsMask = 0x13019f;
  return record.schemaVersion === 1 &&
    record.operation === 'file' &&
    typeof sid === 'string' && WINDOWS_ACL_SID_RE.test(sid) &&
    record.parentOwnerSid === sid &&
    record.parentPrivate === true &&
    record.parentIsReparsePoint === false &&
    record.fileOwnerSid === sid &&
    record.fileIsDirectory === false &&
    record.fileIsReparsePoint === false &&
    record.daclProtected === true &&
    record.aceCount === 1 &&
    record.aceSid === sid &&
    record.aceType === 'Allow' &&
    record.aceIsInherited === false &&
    record.expectedRights === 'Read|Write|Delete' &&
    Number.isSafeInteger(record.rightsMask) &&
    Number.isSafeInteger(record.expectedRightsMask) &&
    record.rightsMask === expectedRightsMask &&
    record.expectedRightsMask === expectedRightsMask;
}

/** Checks a Windows parent directory without changing its DACL. */
export function verifyPrivateWindowsDirectory(
  directoryPath: string,
  options: RestrictToCurrentUserWindowsOptions = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'win32' || !path.win32.isAbsolute(directoryPath)) return false;
  try {
    return isSafeWindowsDirectoryReadback(runWindowsAclScript(directoryPath, 'directory', options));
  } catch {
    return false;
  }
}

/** POSIX file modes are checked at creation; Windows writers verify the parent before staging. */
export function verifySecretDirectoryPermissions(directoryPath: string): boolean {
  return process.platform !== 'win32' || verifyPrivateWindowsDirectory(directoryPath);
}

/**
 * Uses Windows PowerShell 5.1 with a fixed encoded script and .NET ACL APIs. The target path is
 * passed only in a narrowly scoped child environment, never interpolated into command text.
 * Parent/file owner, reparse, privacy, DACL replacement, and structured readback failures return
 * false so callers can withhold secret use and listener startup.
 */
export function restrictToCurrentUserWindows(
  filePath: string,
  options: RestrictToCurrentUserWindowsOptions = {},
): boolean {
  if ((options.platform ?? process.platform) !== 'win32' || !path.win32.isAbsolute(filePath)) return false;
  try {
    return isSafeWindowsAclReadback(runWindowsAclScript(filePath, 'file', options));
  } catch {
    return false;
  }
}

