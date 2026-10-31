import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveBaseDirs,
  getPaths,
  ensureDirs,
  writeApiToken,
  tightenTokenFilePermissions,
  tightenSecretFilePermissions,
  tightenDataDirPermissions,
} from '../../src/daemon/paths.js';

describe('resolveBaseDirs', () => {
  it('TOKENELO_HOME override wins on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const dirs = resolveBaseDirs({ platform, env: { TOKENELO_HOME: '/tmp/tk-test' } });
      expect(dirs).toEqual({
        configDir: path.join('/tmp/tk-test', 'config'),
        dataDir: path.join('/tmp/tk-test', 'data'),
        logsDir: path.join('/tmp/tk-test', 'logs'),
      });
    }
  });

  it('macOS: Application Support + Library/Logs (DESIGN §2.2)', () => {
    const dirs = resolveBaseDirs({ platform: 'darwin', env: {}, home: '/Users/example' });
    expect(dirs.configDir).toBe('/Users/example/Library/Application Support/Tokenelo');
    expect(dirs.dataDir).toBe('/Users/example/Library/Application Support/Tokenelo');
    expect(dirs.logsDir).toBe('/Users/example/Library/Logs/Tokenelo');
  });

  it('Linux: XDG dirs, defaulting when unset', () => {
    const dirs = resolveBaseDirs({ platform: 'linux', env: {}, home: '/home/example' });
    expect(dirs.configDir).toBe('/home/example/.config/tokenelo');
    expect(dirs.dataDir).toBe('/home/example/.local/share/tokenelo');
    expect(dirs.logsDir).toBe('/home/example/.local/state/tokenelo');
  });

  it('Linux: honors explicit XDG_* env vars', () => {
    const dirs = resolveBaseDirs({
      platform: 'linux',
      env: {
        XDG_CONFIG_HOME: '/custom/config',
        XDG_DATA_HOME: '/custom/data',
        XDG_STATE_HOME: '/custom/state',
      },
      home: '/home/example',
    });
    expect(dirs).toEqual({
      configDir: '/custom/config/tokenelo',
      dataDir: '/custom/data/tokenelo',
      logsDir: '/custom/state/tokenelo',
    });
  });

  it('Windows: %APPDATA%\\Tokenelo config, %LOCALAPPDATA%\\Tokenelo data/logs', () => {
    const dirs = resolveBaseDirs({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\example\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
      home: 'C:\\Users\\example',
    });
    expect(dirs.configDir).toBe(path.join('C:\\Users\\example\\AppData\\Roaming', 'Tokenelo'));
    expect(dirs.dataDir).toBe(path.join('C:\\Users\\example\\AppData\\Local', 'Tokenelo'));
    expect(dirs.logsDir).toBe(path.join('C:\\Users\\example\\AppData\\Local', 'Tokenelo', 'logs'));
  });
});

describe('getPaths', () => {
  it('derives configFile/dbFile/apiTokenFile/lockFile from the base dirs', () => {
    const paths = getPaths({ platform: 'darwin', env: {}, home: '/Users/example' });
    expect(paths.configFile).toBe('/Users/example/Library/Application Support/Tokenelo/config.json');
    expect(paths.dbFile).toBe('/Users/example/Library/Application Support/Tokenelo/tokenelo.db');
    expect(paths.apiTokenFile).toBe('/Users/example/Library/Application Support/Tokenelo/api-token');
    expect(paths.lockFile).toBe('/Users/example/Library/Application Support/Tokenelo/tokenelo.lock');
  });
});

describe('ensureDirs / writeApiToken (real filesystem, TOKENELO_HOME sandbox)', () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('ensureDirs creates config/data/logs dirs', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-paths-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    ensureDirs(paths);
    expect(fs.statSync(paths.configDir).isDirectory()).toBe(true);
    expect(fs.statSync(paths.dataDir).isDirectory()).toBe(true);
    expect(fs.statSync(paths.logsDir).isDirectory()).toBe(true);
  });

  it('writeApiToken writes the token and restricts permissions to 0600 (POSIX)', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-paths-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    writeApiToken(paths, 'super-secret-token');
    expect(fs.readFileSync(paths.apiTokenFile, 'utf8')).toBe('super-secret-token');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(paths.apiTokenFile).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('tightenTokenFilePermissions re-restricts a token file that was left group/world readable (POSIX)', () => {
    if (process.platform === 'win32') return;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-paths-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    writeApiToken(paths, 'super-secret-token');
    fs.chmodSync(paths.apiTokenFile, 0o644); // simulate a token file that got loosened somehow
    expect(fs.statSync(paths.apiTokenFile).mode & 0o777).toBe(0o644);

    const ok = tightenTokenFilePermissions(paths);
    expect(ok).toBe(true);
    expect(fs.statSync(paths.apiTokenFile).mode & 0o777).toBe(0o600);
  });

  it('tightenDataDirPermissions chmods the data dir to 0700 and tokenelo.db/-wal/-shm to 0600 (POSIX)', () => {
    if (process.platform === 'win32') return;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-paths-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    ensureDirs(paths);
    fs.chmodSync(paths.dataDir, 0o755); // simulate a loosened data dir
    fs.writeFileSync(paths.dbFile, 'x', { mode: 0o644 });
    fs.writeFileSync(`${paths.dbFile}-wal`, 'x', { mode: 0o644 });
    // -shm deliberately absent — tightenDataDirPermissions must skip a missing sibling, not throw

    tightenDataDirPermissions(paths);

    expect(fs.statSync(paths.dataDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.dbFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(`${paths.dbFile}-wal`).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${paths.dbFile}-shm`)).toBe(false); // still doesn't exist, no crash
  });
});

/**
 * Native ACL of `filePath` as SIDs + numeric rights masks, read by a bounded Windows PowerShell child
 * via .NET Framework [System.IO.File]::GetAccessControl. Structured SID/mask output avoids parsing
 * localized icacls account names and rights text. The path is passed through the environment, never
 * interpolated into the script.
 *
 * The script uses no module cmdlets (no Get-Acl, ConvertTo-Json, ForEach-Object): a child spawned
 * from PowerShell 7 can inherit a PSModulePath whose Microsoft.PowerShell.Security/Utility resolve to
 * PS7-only modules that Windows PowerShell 5.1 cannot load. Output is plain `key=value` lines instead.
 */
interface NativeAcl {
  currentSid: string;
  protected: boolean;
  rules: { sid: string; rights: number; type: string; inherited: boolean }[];
}
function readNativeAcl(filePath: string): NativeAcl {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$sidType = [System.Security.Principal.SecurityIdentifier]',
    '$acl = [System.IO.File]::GetAccessControl($env:TOKENELO_TEST_ACL_PATH)',
    "'sid=' + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "'protected=' + [bool]$acl.AreAccessRulesProtected",
    'foreach ($r in $acl.GetAccessRules($true, $true, $sidType)) {',
    "  'rule=' + (@($r.IdentityReference.Value, [int64]$r.FileSystemRights.value__,",
    "    $r.AccessControlType.ToString(), [bool]$r.IsInherited) -join '|') }",
  ].join('\n');
  const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, TOKENELO_TEST_ACL_PATH: filePath },
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = stdout.split(/\r?\n/).filter((l) => l !== '');
  const single = (key: string): string => {
    const hits = lines.filter((l) => l.startsWith(`${key}=`));
    if (hits.length !== 1) throw new Error(`ACL reader: expected one ${key}= line, got ${hits.length}`);
    return hits[0].slice(key.length + 1);
  };
  const flag = (value: string): boolean => {
    if (value !== 'True' && value !== 'False') throw new Error(`ACL reader: unexpected boolean ${value}`);
    return value === 'True';
  };
  const ruleLines = lines.filter((l) => l.startsWith('rule='));
  if (lines.length !== ruleLines.length + 2) throw new Error('ACL reader: unexpected output lines');
  const rules = ruleLines.map((l) => {
    const fields = l.slice('rule='.length).split('|');
    if (fields.length !== 4 || !/^-?\d+$/.test(fields[1])) throw new Error(`ACL reader: malformed rule ${l}`);
    // value__ is a signed Int32; normalize to the unsigned access mask.
    return { sid: fields[0], rights: Number(fields[1]) >>> 0, type: fields[2], inherited: flag(fields[3]) };
  });
  return { currentSid: single('sid'), protected: flag(single('protected')), rules };
}

// Win32 access-mask bits (winnt.h). icacls R = FILE_GENERIC_READ, W = FILE_GENERIC_WRITE, D = DELETE.
const FILE_GENERIC_READ = 0x120089;
const FILE_GENERIC_WRITE = 0x120116;
const DELETE = 0x10000;
const FORBIDDEN_RIGHTS = {
  FILE_EXECUTE: 0x20,
  FILE_DELETE_CHILD: 0x40,
  WRITE_DAC: 0x40000,
  WRITE_OWNER: 0x80000,
  GENERIC_ALL: 0x10000000,
  GENERIC_EXECUTE: 0x20000000,
};

describe.skipIf(process.platform !== 'win32')('Windows secret-file ACL (owned synthetic temp fixtures only)', () => {
  let tmpHome = '';

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = '';
  });

  // Synthetic values only; compared via booleans so a failure never prints them.
  const SYNTHETIC_API = 'synthetic-api-value-not-a-real-secret';
  const SYNTHETIC_API_ROTATED = 'synthetic-api-value-rotated-not-a-real-secret';
  const SYNTHETIC_FLEET = `${'a'.repeat(64)}\n`;
  const SYNTHETIC_FLEET_ROTATED = `${'b'.repeat(64)}\n`;

  it('API token: owner can read, overwrite (rotate) and delete after writeApiToken', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-acl-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    writeApiToken(paths, SYNTHETIC_API);
    expect(fs.readFileSync(paths.apiTokenFile, 'utf8') === SYNTHETIC_API).toBe(true);

    writeApiToken(paths, SYNTHETIC_API_ROTATED); // rotation path: overwrite + re-tighten
    expect(fs.readFileSync(paths.apiTokenFile, 'utf8') === SYNTHETIC_API_ROTATED).toBe(true);
    expect(tightenTokenFilePermissions(paths)).toBe(true);

    fs.unlinkSync(paths.apiTokenFile); // EPERM under the previous (R,W)-only grant
    expect(fs.existsSync(paths.apiTokenFile)).toBe(false);

    fs.rmSync(tmpHome, { recursive: true });
    expect(fs.existsSync(tmpHome)).toBe(false);
    tmpHome = '';
  });

  it('fleet-like secret: owner can read, overwrite and delete after tightenSecretFilePermissions', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-acl-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    // Mirrors writeFleetPeerToken (src/daemon/fleet.ts) layout without importing fleet code.
    const file = path.join(paths.dataDir, 'fleet-peers', 'synthetic-peer.token');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, SYNTHETIC_FLEET, { mode: 0o600 });
    expect(tightenSecretFilePermissions(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8') === SYNTHETIC_FLEET).toBe(true);

    fs.writeFileSync(file, SYNTHETIC_FLEET_ROTATED, { mode: 0o600 });
    expect(tightenSecretFilePermissions(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8') === SYNTHETIC_FLEET_ROTATED).toBe(true);

    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);

    fs.rmSync(tmpHome, { recursive: true });
    expect(fs.existsSync(tmpHome)).toBe(false);
    tmpHome = '';
  });

  // A second principal cannot be exercised without elevation or another account, so "no other
  // principal has access" is proven structurally: exactly one ACE, for the current user's SID.
  it('fresh secrets carry exactly one explicit Allow ACE for the current user: Read+Write+Delete, nothing else', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-acl-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    writeApiToken(paths, SYNTHETIC_API);
    const fleetFile = path.join(paths.dataDir, 'fleet-peers', 'synthetic-peer.token');
    fs.mkdirSync(path.dirname(fleetFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fleetFile, SYNTHETIC_FLEET, { mode: 0o600 });
    expect(tightenSecretFilePermissions(fleetFile)).toBe(true);

    for (const file of [paths.apiTokenFile, fleetFile]) {
      const acl = readNativeAcl(file);
      expect(acl.protected).toBe(true); // inheritance disabled
      expect(acl.rules).toHaveLength(1);
      const [rule] = acl.rules;
      expect(rule.sid).toBe(acl.currentSid);
      expect(rule.type).toBe('Allow');
      expect(rule.inherited).toBe(false);
      expect(rule.rights & FILE_GENERIC_READ).toBe(FILE_GENERIC_READ);
      expect(rule.rights & FILE_GENERIC_WRITE).toBe(FILE_GENERIC_WRITE);
      expect(rule.rights & DELETE).toBe(DELETE);
      for (const [name, bit] of Object.entries(FORBIDDEN_RIGHTS)) {
        expect({ name, granted: (rule.rights & bit) !== 0 }).toEqual({ name, granted: false });
      }
    }

    fs.unlinkSync(paths.apiTokenFile);
    fs.unlinkSync(fleetFile);
    fs.rmSync(tmpHome, { recursive: true });
    expect(fs.existsSync(tmpHome)).toBe(false);
    tmpHome = '';
  }, 60_000); // two PowerShell child starts; per-test only, global timeout unchanged
});
