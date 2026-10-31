import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureApiToken } from '../../src/daemon/main.js';
import { ensureFleetToken } from '../../src/daemon/fleet.js';
import {
  ensureDirs,
  getPaths,
  restrictToCurrentUserWindows,
  verifyPrivateWindowsDirectory,
  writeSecretFileAtomically,
  type WindowsAclCommandOptions,
  type WindowsAclExec,
} from '../../src/daemon/paths.js';

const FILE = 'C:\\synthetic\\tokenelo\\api-token';
const SID = 'S-1-5-21-2247203710-36551213-924235045-1002';

function aclReadback(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    operation: 'file',
    currentSid: SID,
    parentOwnerSid: SID,
    parentPrivate: true,
    parentIsReparsePoint: false,
    fileOwnerSid: SID,
    fileIsDirectory: false,
    fileIsReparsePoint: false,
    daclProtected: true,
    aceCount: 1,
    aceSid: SID,
    aceType: 'Allow',
    aceIsInherited: false,
    rightsMask: 0x13019f,
    expectedRightsMask: 0x13019f,
    expectedRights: 'Read|Write|Delete',
    ...overrides,
  });
}

function directoryReadback(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    operation: 'directory',
    currentSid: SID,
    directoryOwnerSid: SID,
    directoryPrivate: true,
    directoryIsReparsePoint: false,
    ...overrides,
  });
}

function syntheticExecutor(output: string, fail = false) {
  const calls: Array<{ command: string; args: string[]; options: WindowsAclCommandOptions }> = [];
  const execFile: WindowsAclExec = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options, env: { ...options.env } } });
    if (fail) throw new Error('synthetic PowerShell ACL failure');
    return output;
  };
  return { calls, execFile };
}

/** The fixed PowerShell script the helper passes with -EncodedCommand, decoded. */
function decodedAclScript(): string {
  const { calls, execFile } = syntheticExecutor(aclReadback());
  expect(restrictToCurrentUserWindows(FILE, { platform: 'win32', systemRoot: 'C:\\Windows', execFile })).toBe(true);
  return Buffer.from(calls[0]!.args[4]!, 'base64').toString('utf16le');
}

describe('Windows token ACL verification (synthetic only)', () => {
  it('checks parent privacy before staging and accepts only current-owned, safe directory readback', () => {
    const { calls, execFile } = syntheticExecutor(directoryReadback());
    expect(verifyPrivateWindowsDirectory('C:\\synthetic\\tokenelo\\data', {
      platform: 'win32', systemRoot: 'C:\\Windows', execFile,
    })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.env.TOKENELO_ACL_MODE).toBe('directory');
    expect(calls[0]!.args).not.toContain('C:\\synthetic\\tokenelo\\data');
    const script = Buffer.from(calls[0]!.args[4]!, 'base64').toString('utf16le');
    expect(script).toContain('Get-CheckedPrivateDirectory');
    expect(script.indexOf("if ($mode -eq 'directory')")).toBeLessThan(script.indexOf('[System.IO.File]::SetAccessControl'));
    expect(script).toContain('exit 0');
  });

  it('uses fixed hidden PowerShell code and accepts a matching SID/DACL readback', () => {
    const { calls, execFile } = syntheticExecutor(aclReadback());
    expect(restrictToCurrentUserWindows(FILE, { platform: 'win32', systemRoot: 'C:\\Windows', execFile })).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command.toLowerCase()).toMatch(/\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/);
    expect(call.args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive']);
    expect(call.args[3]).toBe('-EncodedCommand');
    expect(call.args).not.toContain(FILE);
    expect(JSON.stringify(call.args)).not.toContain('a'.repeat(64));
    expect(call.options.env.TOKENELO_ACL_TARGET).toBe(FILE);
    expect(Object.keys(call.options.env).every(key =>
      ['SystemRoot', 'windir', 'TEMP', 'TMP', 'TOKENELO_ACL_TARGET', 'TOKENELO_ACL_MODE'].includes(key),
    )).toBe(true);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.timeout).toBe(5000);
    expect(call.options.maxBuffer).toBe(65536);
    const script = Buffer.from(call.args[4]!, 'base64').toString('utf16le');
    expect(script).toContain('WindowsIdentity]::GetCurrent().User');
    expect(script).toContain('FileSecurity]::new()');
    expect(script).toContain('[System.IO.File]::SetAccessControl');
    expect(script).toContain('GetAccessRules');
    expect(script).toContain('parentOwnerSid');
    expect(call.options.env.TOKENELO_ACL_MODE).toBe('file');
    expect(script).toContain('S-1-5-32-544');
    expect(script).not.toContain('USERNAME');
    expect(script).not.toContain(FILE);
    expect(script).not.toContain('/reset');
  });

  it('uses no cmdlet-style commands and no pipelines', () => {
    // A tripwire for the regression that mattered: a module cmdlet in this script ran far past the helper's deadline for a
    // fresh standard user on a hosted Windows image with no module analysis cache (most likely PowerShell analyzing the
    // many modules on the machine's module path), so the token writer failed closed and never wrote the token.
    // It looks at the decoded script with comments and quoted strings removed, for any Verb-Noun name in any letter case
    // (PowerShell is case-insensitive) and for pipelines. Bare aliases such as `iex` or `dir` cannot be told apart from
    // other words this way; the Windows-only test below parses the script with PowerShell itself and covers them.
    const script = decodedAclScript();
    const code = script.replace(/^\s*#.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toContain('|');
    const cmdletLike = code.match(/\b[A-Za-z]+-[A-Za-z][A-Za-z0-9]*\b/g) ?? [];
    // The only Verb-Noun name is the function the script defines itself, which resolves without loading a module.
    expect([...new Set(cmdletLike)]).toEqual(['Get-CheckedPrivateDirectory']);
    // Every helper the script calls is defined in it (a typo would otherwise become a command-not-found lookup).
    const defined = new Set([...script.matchAll(/\bfunction\s+([A-Za-z][\w-]*)/g)].map((match) => match[1]));
    for (const helper of new Set(code.match(/\bJson[A-Za-z]+\b/g) ?? [])) expect(defined.has(helper), helper).toBe(true);
  });

  it('rejects untrusted parent access, owner mismatch, reparse files, extra ACEs, and rights drift', () => {
    const invalidReadbacks = [
      { operation: 'directory' },
      { parentPrivate: false },
      { parentOwnerSid: 'S-1-5-21-1-2-3-1001' },
      { fileOwnerSid: 'S-1-5-21-1-2-3-1001' },
      { fileIsReparsePoint: true },
      { aceCount: 2 },
      { aceSid: 'S-1-5-21-1-2-3-1001' },
      { rightsMask: 12346 },
      { rightsMask: 0x1f01ff, expectedRightsMask: 0x1f01ff },
      { aceIsInherited: true },
    ];
    for (const override of invalidReadbacks) {
      const { execFile } = syntheticExecutor(aclReadback(override));
      expect(restrictToCurrentUserWindows(FILE, { platform: 'win32', systemRoot: 'C:\\Windows', execFile })).toBe(false);
    }
  });

  it('fails closed when the native helper fails or returns malformed structured data', () => {
    const thrown = syntheticExecutor('', true);
    expect(restrictToCurrentUserWindows(FILE, { platform: 'win32', systemRoot: 'C:\\Windows', execFile: thrown.execFile })).toBe(false);
    const malformed = syntheticExecutor('not-json');
    expect(restrictToCurrentUserWindows(FILE, { platform: 'win32', systemRoot: 'C:\\Windows', execFile: malformed.execFile })).toBe(false);
  });

  it('preserves a reused API token and refuses to return it when Windows ACL verification fails', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-api-acl-'));
    try {
      const paths = getPaths({ env: { TOKENELO_HOME: home } });
      ensureDirs(paths);
      const originalBytes = 'b'.repeat(64) + '\n';
      fs.writeFileSync(paths.apiTokenFile, originalBytes, { mode: 0o600 });
      expect(() => ensureApiToken(paths, undefined, {
        platform: 'win32',
        tightenPermissions: () => false,
      })).toThrow(/refusing to start the local API/);
      expect(fs.readFileSync(paths.apiTokenFile, 'utf8')).toBe(originalBytes);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('checks an empty file before writing, truncates untrusted precheck bytes, and cleans up on refusal', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-secret-stage-'));
    try {
      const allowedPath = path.join(home, 'allowed-token');
      let allowedSize = -1;
      expect(writeSecretFileAtomically(allowedPath, 'd'.repeat(64), (emptyFile) => {
        allowedSize = fs.statSync(emptyFile).size;
        fs.writeFileSync(emptyFile, 'synthetic-precheck-bytes');
        return true;
      }, true, () => true)).toBe(true);
      expect(allowedSize).toBe(0);
      expect(fs.readFileSync(allowedPath, 'utf8')).toBe('d'.repeat(64));
      expect(fs.readdirSync(home)).toEqual(['allowed-token']);

      const deniedPath = path.join(home, 'denied-token');
      let deniedSize = -1;
      expect(writeSecretFileAtomically(deniedPath, 'e'.repeat(64), (emptyFile) => {
        deniedSize = fs.statSync(emptyFile).size;
        return false;
      }, true, () => true)).toBe(false);
      expect(deniedSize).toBe(0);
      expect(fs.existsSync(deniedPath)).toBe(false);
      expect(fs.readdirSync(home)).toEqual(['allowed-token']);

      const racedPath = path.join(home, 'existing-token');
      const priorBytes = 'f'.repeat(64) + '\n';
      fs.writeFileSync(racedPath, priorBytes, { mode: 0o600 });
      expect(() => writeSecretFileAtomically(racedPath, '0'.repeat(64), () => true, false, () => true)).toThrow();
      expect(fs.readFileSync(racedPath, 'utf8')).toBe(priorBytes);
      expect(fs.readdirSync(home).sort()).toEqual(['allowed-token', 'existing-token']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not retain or return a fresh API token when permission checks fail', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-api-acl-fresh-'));
    try {
      const paths = getPaths({ env: { TOKENELO_HOME: home } });
      ensureDirs(paths);
      let emptyFileSeen = false;
      expect(() => ensureApiToken(paths, undefined, {
        platform: 'win32',
        tightenPermissions: (emptyFile) => {
          emptyFileSeen = fs.statSync(emptyFile).size === 0;
          return false;
        },
        verifyDirectory: () => true,
      })).toThrow(/refusing to start the local API/);
      expect(emptyFileSeen).toBe(true);
      expect(fs.existsSync(paths.apiTokenFile)).toBe(false);
      expect(fs.readdirSync(paths.dataDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not retain or return a fresh fleet token when permission checks fail', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-fleet-acl-fresh-'));
    try {
      const paths = getPaths({ env: { TOKENELO_HOME: home } });
      let emptyFileSeen = false;
      expect(() => ensureFleetToken(paths, (emptyFile) => {
        emptyFileSeen = fs.statSync(emptyFile).size === 0;
        return false;
      }, () => true)).toThrow(/could not restrict fleet-token/);
      expect(emptyFileSeen).toBe(true);
      expect(fs.existsSync(paths.fleetTokenFile)).toBe(false);
      expect(fs.readdirSync(paths.dataDir)).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'win32')('Windows ACL script command resolution (real Windows PowerShell parser)', () => {
  it('invokes only functions that the script defines itself', () => {
    // Parses the decoded script with Windows PowerShell and lists every command it invokes. Anything not defined in the
    // script (a cmdlet, an alias, a typo) would be resolved at run time and could load or search modules. The probe itself
    // uses no cmdlets, so it does not depend on module analysis either.
    const probe = [
      '$tokens = $null; $errors = $null',
      '$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:TOKENELO_TEST_SCRIPT, [ref]$tokens, [ref]$errors)',
      "if ($errors.Count -ne 0) { throw 'the script does not parse' }",
      '$defined = @{}',
      'foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { $defined[$node.Name] = $true }',
      '$invoked = @{}',
      'foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)) { $invoked[[string]$node.GetCommandName()] = $true }',
      "'defined=' + [string]::Join(',', [string[]]$defined.Keys)",
      "'invoked=' + [string]::Join(',', [string[]]$invoked.Keys)",
    ].join('\n');
    const stdout = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64'),
    ], {
      env: { ...process.env, TOKENELO_TEST_SCRIPT: decodedAclScript() },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const names = (key: string): string[] =>
      (stdout.split(/\r?\n/).find((line) => line.startsWith(`${key}=`)) ?? '').slice(key.length + 1).split(',').filter(Boolean);
    const defined = names('defined');
    const invoked = names('invoked');
    expect(defined).toContain('Get-CheckedPrivateDirectory');
    expect(invoked.length).toBeGreaterThan(0);
    expect(invoked.filter((name) => !defined.includes(name))).toEqual([]);
  });
});
