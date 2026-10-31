import crypto from 'node:crypto';
import path from 'node:path';

export const LINUX_TOKENELO_PACKAGE_CONTRACT = Object.freeze({
  packageName: 'tokenelo', packagePrivate: true, packageType: 'module', packageMain: 'dist/tray/main.js',
  executableName: 'tokenelo', lifecycleEntry: 'dist/tray/linux-service-lifecycle.js',
  daemonEntry: 'dist/daemon/main.js', trayEntry: 'dist/tray/main.js', sandboxEntry: 'chrome-sandbox',
} as const);
export const LINUX_TOKENELO_UNIT_NAME = 'tokenelo-daemon.service';
export const LINUX_TOKENELO_AUTOSTART_NAME = 'tokenelo-tray.desktop';
export const LINUX_TOKENELO_TRANSACTION_LOCK = '.tokenelo-linux-service-transaction';
const SYSTEM_ENV_PATH = '/usr/bin/env';

export type LinuxLifecycleOperation = 'install' | 'uninstall';
export type LinuxEnabledState = 'enabled' | 'disabled' | 'not-found' | 'masked' | 'linked' | 'static' | 'unknown';
export type LinuxActiveState = 'active' | 'inactive' | 'failed' | 'not-found' | 'unknown';
export type LinuxSandboxCapability = 'setuid-helper' | 'user-namespace' | 'unknown';

export interface LinuxPathIdentity {
  path: string; realPath: string; kind: 'directory' | 'file' | 'symlink' | 'other'; uid: number; mode: number;
}
export interface LinuxObservedObject { identity: LinuxPathIdentity; contents?: string; linkTarget?: string; }
export interface LinuxPackageEvidence {
  packageRoot: LinuxPathIdentity; resourcesDirectory: LinuxPathIdentity; appDirectory: LinuxPathIdentity;
  packageJson: LinuxObservedObject; packageJsonContents: string;
  lifecycleEntry: LinuxPathIdentity; daemonEntry: LinuxPathIdentity; trayEntry: LinuxPathIdentity;
  executable: LinuxPathIdentity; executableFormat: 'ELF' | 'other' | 'unknown'; executableBasename: string;
  sandbox: LinuxPathIdentity; sandboxCapability: LinuxSandboxCapability;
}
export interface LinuxSystemdUnitObservation {
  fragmentPath: string | null; execStartArgv: readonly string[] | null; dropInPaths: readonly string[] | null;
  needDaemonReload: 'yes' | 'no' | null;
}
export interface LinuxServiceStateEvidence {
  unitFile: LinuxObservedObject | null; trayAutostartFile: LinuxObservedObject | null;
  enablementLink: LinuxObservedObject | null; manager: LinuxSystemdUnitObservation | null;
  enabled: LinuxEnabledState; active: LinuxActiveState;
}
export interface LinuxLifecyclePlanningEvidence {
  platform: string; uid: number; runtimeHome: string; accountHome: string;
  homeEnvironment: string | undefined; tokeneloHomeEnvironment: string | undefined;
  pathEnvironment: string | undefined; configHomeEnvironment: string | undefined;
  dataHomeEnvironment: string | undefined; stateHomeEnvironment: string | undefined;
  accountHomeIdentity: LinuxPathIdentity; configHomeIdentity: LinuxPathIdentity;
  dataHomeIdentity: LinuxPathIdentity; stateHomeIdentity: LinuxPathIdentity;
  systemEnvIdentity: LinuxPathIdentity;
  package: LinuxPackageEvidence; service: LinuxServiceStateEvidence;
}
export interface LinuxLifecyclePlanningInput { operation: LinuxLifecycleOperation; evidence: LinuxLifecyclePlanningEvidence; }

export type LinuxManagedFile =
  | { state: 'missing' }
  | { state: 'owned'; path: string; mode: number; sha256: string }
  | { state: 'foreign'; reason: 'wrong-path' | 'wrong-type' | 'wrong-owner' | 'wrong-mode' | 'bytes-mismatch' };
export type LinuxManagerOwnership =
  | { state: 'missing' }
  | { state: 'owned' }
  | { state: 'foreign'; reason: 'fragment-mismatch' | 'action-mismatch' | 'drop-ins-present' | 'reload-pending' | 'unknown-observation' };

export interface LinuxServicePolicy {
  uid: number; userHome: string; configHome: string; dataHome: string; stateHome: string;
  packageRoot: string; appRoot: string; executablePath: string; daemonEntryPath: string; trayEntryPath: string;
  unitPath: string; autostartPath: string; enablementLinkPath: string; transactionLockPath: string;
  unitArgv: readonly [string, string];
  trayArgv: readonly [string, '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'TOKENELO_HOME', '-u', 'NODE_OPTIONS',
    string, string, string, string, string, '--ozone-platform-hint=auto', string];
  unitContents: string; autostartContents: string; unitSha256: string; autostartSha256: string;
}
export type LinuxLifecycleStep =
  | { kind: 'acquire-same-user-lock'; path: string; mode: 0o700 }
  | { kind: 'revalidate-preflight-under-lock' }
  | { kind: 'provision-service-directories'; paths: readonly string[]; mode: 0o700 }
  | { kind: 'capture-immutable-originals'; paths: readonly string[]; mode: 0o600 }
  | { kind: 'stage-candidates'; candidates: readonly { path: string; sha256: string; mode: 0o644 }[] }
  | { kind: 'verify-candidates-before-publication'; candidates: readonly { path: string; sha256: string; mode: 0o644 }[] }
  | { kind: 'publish-owned-file'; path: string; sha256: string; mode: 0o644 }
  | { kind: 'verify-published-file'; path: string; sha256: string; mode: 0o644 }
  | { kind: 'retire-owned-file-to-recovery'; path: string }
  | { kind: 'daemon-reload' }
  | { kind: 'verify-loaded-unit'; fragmentPath: string; execStartArgv: readonly string[]; dropInPaths: 0 }
  | { kind: 'ensure-exact-enablement-link'; path: string; target: string }
  | { kind: 'remove-exact-enablement-link'; path: string; target: string }
  | { kind: 'stop-exact-unit'; unitName: string }
  | { kind: 'start-exact-unit'; unitName: string }
  | { kind: 'verify-final-state'; operation: LinuxLifecycleOperation }
  | { kind: 'release-lock-after-verification'; path: string };
export interface LinuxRecoveryPlan {
  identitySha256: string; lockPath: string;
  immutableBackups: readonly { sourcePath: string; backupName: 'unit.original' | 'autostart.original' | 'enablement.original'; sha256: string | null; mode: number | null }[];
  candidateSha256: { unit: string; autostart: string };
  rollback: {
    restoreOnlyIfCurrentStateMatchesTransaction: true; preserveForeignOrChangedObjects: true;
    retainBackupsAndLockOnMismatchOrRollbackFailure: true; neverDeleteUserDataOrDatabaseFiles: true;
  };
  retention: {
    success: 'remove-transient-candidates-and-release-lock-after-postcondition-check';
    failure: 'retain-private-recovery-files-and-lock';
  };
}
export interface LinuxServiceLifecyclePlan {
  operation: LinuxLifecycleOperation; trigger: 'explicit-user-action';
  result: 'plan-transaction' | 'already-current' | 'already-absent';
  execution: 'plan-only';
  preconditions: { physicalXdgRootsMustAlreadyExist: true; packageInputsMustNotBeGroupOrWorldWritable: true };
  policy: LinuxServicePolicy;
  observed: { unit: LinuxManagedFile; trayAutostart: LinuxManagedFile; manager: LinuxManagerOwnership };
  steps: readonly LinuxLifecycleStep[]; recovery: LinuxRecoveryPlan;
  concurrencyLimit: 'same-user-cooperating-writers-only';
}

function sha256(value: string): string { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function abs(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value === '/' || !path.posix.isAbsolute(value) ||
      path.posix.normalize(value) !== value || value.endsWith('/') || value.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(label + ' must be a normalized absolute POSIX path');
  return value;
}
function identity(id: LinuxPathIdentity, expected: string, kind: LinuxPathIdentity['kind'], uid: number, label: string, root = false): void {
  if (abs(id.path, label + ' path') !== expected || abs(id.realPath, label + ' physical path') !== expected ||
      id.kind !== kind || (id.uid !== uid && !(root && id.uid === 0)) || !Number.isInteger(id.mode))
    throw new Error(label + ' does not identify the expected physical object');
}
function ownedDirectory(id: LinuxPathIdentity, expected: string, uid: number, label: string): void {
  identity(id, expected, 'directory', uid, label);
  if ((id.mode & 0o022) !== 0) throw new Error(label + ' is group- or world-writable');
}
function file(id: LinuxPathIdentity, expected: string, uid: number, label: string): void {
  identity(id, expected, 'file', uid, label);
  if ((id.mode & 0o022) !== 0) throw new Error(label + ' is group- or world-writable');
}
function systemdWord(value: string, label: string): string {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(label + ' contains a systemd control character');
  // Dollar signs are literal in Environment= and WorkingDirectory=. ExecStart uses
  // systemd's ':' executable prefix to disable environment substitution entirely.
  return '"' + value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/%/gu, '%%') + '"';
}
function desktopWord(value: string, label: string): string {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(label + ' contains a desktop-entry control character');
  // Build the Exec command-line quoting first, then escape its backslashes for
  // the enclosing desktop-entry string value (the spec requires both layers).
  const quotedArgument = '"' + value.replace(/[\\`"$]/gu, character => '\\' + character).replace(/%/gu, '%%') + '"';
  return quotedArgument.replace(/\\/gu, '\\\\');
}
function renderUnit(p: { app: string; exe: string; daemon: string; home: string; config: string; data: string; state: string; path?: string }): string {
  const env = ['ELECTRON_RUN_AS_NODE=1', 'NODE_ENV=production', 'HOME=' + p.home,
    'XDG_CONFIG_HOME=' + p.config, 'XDG_DATA_HOME=' + p.data, 'XDG_STATE_HOME=' + p.state];
  if (p.path !== undefined && p.path !== '') {
    if (/[\u0000-\u001f\u007f]/u.test(p.path)) throw new Error('PATH contains a systemd control character');
    env.push('PATH=' + p.path);
  }
  // User managers can retain shell variables. Explicit XDG values preserve the selected ledger roots;
  // UnsetEnvironment removes inherited profile redirection and Node option injection for this daemon.
  return ['[Unit]', 'Description=Tokenelo usage/spend daemon', 'After=default.target', '', '[Service]', 'Type=simple',
    'WorkingDirectory=' + systemdWord(p.app, 'app root'),
    'ExecStart=:' + systemdWord(p.exe, 'bundled executable') + ' ' + systemdWord(p.daemon, 'daemon entry'),
    'Restart=on-failure', 'RestartSec=5', 'UnsetEnvironment=TOKENELO_HOME NODE_OPTIONS',
    ...env.map(v => 'Environment=' + systemdWord(v, 'service environment')),
    '', '[Install]', 'WantedBy=default.target', ''].join('\n');
}
function renderAutostart(env: string, exe: string, tray: string,
                         roots: { home: string; config: string; data: string; state: string }): string {
  return ['[Desktop Entry]', 'Type=Application', 'Name=Tokenelo', 'Comment=AI token usage and spend tray',
    'Exec=' + desktopWord(env, 'native env executable') + ' ' + desktopWord('-u', 'env unset option') + ' ' +
      desktopWord('ELECTRON_RUN_AS_NODE', 'Electron environment name') + ' ' + desktopWord('-u', 'env unset option') + ' ' +
      desktopWord('TOKENELO_HOME', 'Tokenelo profile environment name') + ' ' + desktopWord('-u', 'env unset option') + ' ' +
      desktopWord('NODE_OPTIONS', 'Node options environment name') + ' ' +
      desktopWord('HOME=' + roots.home, 'home environment') + ' ' +
      desktopWord('XDG_CONFIG_HOME=' + roots.config, 'config environment') + ' ' +
      desktopWord('XDG_DATA_HOME=' + roots.data, 'data environment') + ' ' +
      desktopWord('XDG_STATE_HOME=' + roots.state, 'state environment') + ' ' + desktopWord(exe, 'bundled executable') + ' ' +
      desktopWord('--ozone-platform-hint=auto', 'tray platform option') + ' ' + desktopWord(tray, 'tray entry'),
    'X-GNOME-Autostart-enabled=true', 'NoDisplay=true', ''].join('\n');
}
function overlap(a: string, b: string): boolean { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }

export function classifyLinuxManagedFile(object: LinuxObservedObject | null, expectedPath: string, bytes: string, uid: number): LinuxManagedFile {
  if (object === null) return { state: 'missing' };
  const id = object.identity;
  if (id.path !== expectedPath || id.realPath !== expectedPath) return { state: 'foreign', reason: 'wrong-path' };
  if (id.kind !== 'file' || typeof object.contents !== 'string') return { state: 'foreign', reason: 'wrong-type' };
  if (id.uid !== uid) return { state: 'foreign', reason: 'wrong-owner' };
  if ((id.mode & 0o7777) !== 0o644) return { state: 'foreign', reason: 'wrong-mode' };
  if (object.contents !== bytes) return { state: 'foreign', reason: 'bytes-mismatch' };
  return { state: 'owned', path: expectedPath, mode: 0o644, sha256: sha256(bytes) };
}
export function classifyLinuxManagerOwnership(unitPath: string, argv: readonly string[], seen: LinuxSystemdUnitObservation | null): LinuxManagerOwnership {
  if (seen === null) return { state: 'missing' };
  if (seen.fragmentPath === null || seen.execStartArgv === null || seen.dropInPaths === null || seen.needDaemonReload === null)
    return { state: 'foreign', reason: 'unknown-observation' };
  if (seen.fragmentPath !== unitPath) return { state: 'foreign', reason: 'fragment-mismatch' };
  if (seen.execStartArgv.length !== argv.length || seen.execStartArgv.some((arg, i) => arg !== argv[i]))
    return { state: 'foreign', reason: 'action-mismatch' };
  if (seen.dropInPaths.length !== 0) return { state: 'foreign', reason: 'drop-ins-present' };
  if (seen.needDaemonReload !== 'no') return { state: 'foreign', reason: 'reload-pending' };
  return { state: 'owned' };
}
function requireOwned(result: LinuxManagedFile, label: string): void {
  if (result.state === 'foreign') throw new Error(label + ' is foreign (' + result.reason + ')');
}
function inspectService(service: LinuxServiceStateEvidence, p: LinuxServicePolicy) {
  const unit = classifyLinuxManagedFile(service.unitFile, p.unitPath, p.unitContents, p.uid);
  const tray = classifyLinuxManagedFile(service.trayAutostartFile, p.autostartPath, p.autostartContents, p.uid);
  requireOwned(unit, 'systemd unit'); requireOwned(tray, 'tray autostart');
  let hasLink = false;
  if (service.enablementLink !== null) {
    const link = service.enablementLink;
    if (link.identity.path !== p.enablementLinkPath || link.identity.realPath !== p.unitPath ||
        link.identity.kind !== 'symlink' || link.identity.uid !== p.uid || link.linkTarget !== p.unitPath)
      throw new Error('systemd enablement path is not the exact Tokenelo link');
    hasLink = true;
  }
  if (!['active', 'inactive', 'failed', 'not-found'].includes(service.active)) throw new Error('systemd active state is unknown');
  if (hasLink ? service.enabled !== 'enabled' : service.enabled !== 'disabled' && service.enabled !== 'not-found')
    throw new Error('systemd enabled state disagrees with the exact enablement link');
  const manager = classifyLinuxManagerOwnership(p.unitPath, p.unitArgv, service.manager);
  if (unit.state === 'owned') {
    if (manager.state !== 'owned') throw new Error('loaded unit is not the exact Tokenelo action');
  } else if (manager.state !== 'missing' || hasLink || service.active === 'active' || service.active === 'failed' ||
      service.enabled === 'enabled' || service.enabled === 'masked' || service.enabled === 'linked' ||
      service.enabled === 'static' || service.enabled === 'unknown') {
    throw new Error('systemd reports Tokenelo state without an exact owned unit');
  }
  return { unit, tray, manager, hasLink, active: service.active };
}
function stepsFor(operation: LinuxLifecycleOperation, p: LinuxServicePolicy, state: ReturnType<typeof inspectService>): LinuxLifecycleStep[] {
  const installed = state.unit.state === 'owned' && state.tray.state === 'owned' && state.hasLink && state.manager.state === 'owned';
  const absent = state.unit.state === 'missing' && state.tray.state === 'missing' && !state.hasLink &&
    state.manager.state === 'missing' && state.active !== 'active' && state.active !== 'failed';
  if (operation === 'install' && installed && state.active === 'active') return [];
  if (operation === 'uninstall' && absent) return [];
  const out: LinuxLifecycleStep[] = [
    { kind: 'acquire-same-user-lock', path: p.transactionLockPath, mode: 0o700 },
    { kind: 'revalidate-preflight-under-lock' },
  ];
  if (operation === 'install') out.push({ kind: 'provision-service-directories', paths: [
    path.posix.dirname(p.unitPath), path.posix.dirname(p.autostartPath), path.posix.dirname(p.enablementLinkPath),
  ], mode: 0o700 });
  out.push({ kind: 'capture-immutable-originals', paths: [p.unitPath, p.autostartPath, p.enablementLinkPath], mode: 0o600 });
  if (operation === 'install') {
    const candidates = [
      { path: p.unitPath, sha256: p.unitSha256, mode: 0o644 as const },
      { path: p.autostartPath, sha256: p.autostartSha256, mode: 0o644 as const },
    ];
    out.push({ kind: 'stage-candidates', candidates }, { kind: 'verify-candidates-before-publication', candidates },
      { kind: 'publish-owned-file', path: p.unitPath, sha256: p.unitSha256, mode: 0o644 },
      { kind: 'verify-published-file', path: p.unitPath, sha256: p.unitSha256, mode: 0o644 },
      { kind: 'daemon-reload' },
      { kind: 'verify-loaded-unit', fragmentPath: p.unitPath, execStartArgv: p.unitArgv, dropInPaths: 0 },
      { kind: 'ensure-exact-enablement-link', path: p.enablementLinkPath, target: p.unitPath },
      { kind: 'publish-owned-file', path: p.autostartPath, sha256: p.autostartSha256, mode: 0o644 },
      { kind: 'verify-published-file', path: p.autostartPath, sha256: p.autostartSha256, mode: 0o644 },
      { kind: 'start-exact-unit', unitName: LINUX_TOKENELO_UNIT_NAME },
      { kind: 'verify-final-state', operation },
      { kind: 'release-lock-after-verification', path: p.transactionLockPath });
  } else {
    if (state.active === 'active') out.push({ kind: 'stop-exact-unit', unitName: LINUX_TOKENELO_UNIT_NAME });
    if (state.hasLink) out.push({ kind: 'remove-exact-enablement-link', path: p.enablementLinkPath, target: p.unitPath });
    if (state.unit.state === 'owned') out.push({ kind: 'retire-owned-file-to-recovery', path: p.unitPath });
    if (state.tray.state === 'owned') out.push({ kind: 'retire-owned-file-to-recovery', path: p.autostartPath });
    if (state.unit.state === 'owned') out.push({ kind: 'daemon-reload' });
    out.push({ kind: 'verify-final-state', operation }, { kind: 'release-lock-after-verification', path: p.transactionLockPath });
  }
  return out;
}

export function planLinuxServiceLifecycle(input: LinuxLifecyclePlanningInput): LinuxServiceLifecyclePlan {
  if (!isRecord(input) || Object.keys(input).sort().join(',') !== 'evidence,operation' ||
      (input.operation !== 'install' && input.operation !== 'uninstall') || !isRecord(input.evidence))
    throw new Error('Linux lifecycle requires one explicit install or uninstall operation and validated evidence');
  const e = input.evidence as unknown as LinuxLifecyclePlanningEvidence;
  if (e.platform !== 'linux') throw new Error('Linux package lifecycle is available only on Linux');
  if (!Number.isInteger(e.uid) || e.uid <= 0) throw new Error('Linux package lifecycle refuses root or an invalid uid');
  const home = abs(e.accountHome, 'uid account home');
  if (abs(e.runtimeHome, 'runtime HOME') !== home || e.homeEnvironment !== home)
    throw new Error('runtime HOME and HOME must exactly match the uid account home');
  if (e.tokeneloHomeEnvironment !== undefined) throw new Error('TOKENELO_HOME profile override is refused');
  ownedDirectory(e.accountHomeIdentity, home, e.uid, 'uid account home');
  identity(e.systemEnvIdentity, SYSTEM_ENV_PATH, 'file', 0, 'physical /usr/bin/env');
  if ((e.systemEnvIdentity.mode & 0o111) === 0 || (e.systemEnvIdentity.mode & 0o022) !== 0)
    throw new Error('physical /usr/bin/env is not executable or has unsafe permissions');

  const config = abs(e.configHomeEnvironment || path.posix.join(home, '.config'), 'XDG_CONFIG_HOME');
  const data = abs(e.dataHomeEnvironment || path.posix.join(home, '.local', 'share'), 'XDG_DATA_HOME');
  const stateHome = abs(e.stateHomeEnvironment || path.posix.join(home, '.local', 'state'), 'XDG_STATE_HOME');
  // This planner requires the selected XDG roots to exist physically; it only plans service subdirectories.
  ownedDirectory(e.configHomeIdentity, config, e.uid, 'XDG_CONFIG_HOME');
  ownedDirectory(e.dataHomeIdentity, data, e.uid, 'XDG_DATA_HOME');
  ownedDirectory(e.stateHomeIdentity, stateHome, e.uid, 'XDG_STATE_HOME');
  const roots = [config, data, stateHome];
  if (new Set(roots).size !== roots.length || roots.some((a, i) => roots.some((b, j) => i !== j && overlap(a, b))))
    throw new Error('XDG roots must be distinct and non-overlapping');

  const b = e.package;
  const packageRoot = abs(b.packageRoot.path, 'package root');
  const resources = path.posix.join(packageRoot, 'resources');
  const app = path.posix.join(resources, 'app');
  ownedDirectory(b.packageRoot, packageRoot, e.uid, 'package root');
  ownedDirectory(b.resourcesDirectory, resources, e.uid, 'resources directory');
  ownedDirectory(b.appDirectory, app, e.uid, 'app directory');
  const executable = path.posix.join(packageRoot, 'tokenelo');
  const packageJsonPath = path.posix.join(app, 'package.json');
  const lifecycle = path.posix.join(app, LINUX_TOKENELO_PACKAGE_CONTRACT.lifecycleEntry);
  const daemon = path.posix.join(app, LINUX_TOKENELO_PACKAGE_CONTRACT.daemonEntry);
  const tray = path.posix.join(app, LINUX_TOKENELO_PACKAGE_CONTRACT.trayEntry);
  const sandbox = path.posix.join(packageRoot, LINUX_TOKENELO_PACKAGE_CONTRACT.sandboxEntry);
  file(b.executable, executable, e.uid, 'bundled executable');
  if ((b.executable.mode & 0o111) === 0 || (b.executable.mode & 0o022) !== 0 ||
      b.executableFormat !== 'ELF' || b.executableBasename !== 'tokenelo')
    throw new Error('bundled executable is not a safe physical Tokenelo ELF');
  file(b.packageJson.identity, packageJsonPath, e.uid, 'package.json');
  if (b.packageJson.contents !== b.packageJsonContents) throw new Error('package.json evidence bytes disagree');
  file(b.lifecycleEntry, lifecycle, e.uid, 'lifecycle entry');
  file(b.daemonEntry, daemon, e.uid, 'daemon entry');
  file(b.trayEntry, tray, e.uid, 'tray entry');
  let metadata: unknown;
  try { metadata = JSON.parse(b.packageJsonContents); } catch { throw new Error('package.json is not valid JSON'); }
  if (!isRecord(metadata) || metadata.name !== 'tokenelo' || metadata.private !== true ||
      metadata.type !== 'module' || metadata.main !== 'dist/tray/main.js')
    throw new Error('package.json does not match the private Tokenelo package contract');
  identity(b.sandbox, sandbox, 'file', e.uid, 'chrome-sandbox', true);
  if (b.sandboxCapability === 'setuid-helper') {
    if (b.sandbox.uid !== 0 || (b.sandbox.mode & 0o7777) !== 0o4755) throw new Error('setuid sandbox must already be root-owned mode 4755');
  } else if (b.sandboxCapability === 'user-namespace') {
    if (b.sandbox.uid !== e.uid || (b.sandbox.mode & 0o7777) !== 0o755) throw new Error('user-namespace sandbox evidence does not match helper');
  } else throw new Error('Linux Electron sandbox capability is unknown; refusing service planning');
  if ([packageRoot, app].some(pkgPath => roots.some(root => overlap(pkgPath, root))))
    throw new Error('XDG roots must not overlap the packaged application');
  if (e.pathEnvironment !== undefined && /[\u0000-\u001f\u007f]/u.test(e.pathEnvironment))
    throw new Error('PATH contains a control character');

  const unitPath = path.posix.join(config, 'systemd', 'user', LINUX_TOKENELO_UNIT_NAME);
  const autostartPath = path.posix.join(config, 'autostart', LINUX_TOKENELO_AUTOSTART_NAME);
  const linkPath = path.posix.join(config, 'systemd', 'user', 'default.target.wants', LINUX_TOKENELO_UNIT_NAME);
  const lockPath = path.posix.join(home, LINUX_TOKENELO_TRANSACTION_LOCK);
  const unitArgv = [executable, daemon] as const;
  const trayArgv = [SYSTEM_ENV_PATH, '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'TOKENELO_HOME', '-u', 'NODE_OPTIONS',
    'HOME=' + home, 'XDG_CONFIG_HOME=' + config, 'XDG_DATA_HOME=' + data, 'XDG_STATE_HOME=' + stateHome,
    executable, '--ozone-platform-hint=auto', tray] as const;
  const unitContents = renderUnit({ app, exe: executable, daemon, home, config, data, state: stateHome, path: e.pathEnvironment });
  const autostartContents = renderAutostart(SYSTEM_ENV_PATH, executable, tray, { home, config, data, state: stateHome });
  const p: LinuxServicePolicy = {
    uid: e.uid, userHome: home, configHome: config, dataHome: data, stateHome,
    packageRoot, appRoot: app, executablePath: executable, daemonEntryPath: daemon, trayEntryPath: tray,
    unitPath, autostartPath, enablementLinkPath: linkPath, transactionLockPath: lockPath,
    unitArgv, trayArgv, unitContents, autostartContents,
    unitSha256: sha256(unitContents), autostartSha256: sha256(autostartContents),
  };
  const observed = inspectService(e.service, p);
  const steps = stepsFor(input.operation, p, observed);
  const identityHash = sha256(JSON.stringify({
    operation: input.operation, uid: e.uid, home, unitPath, autostartPath, linkPath,
    unitBefore: observed.unit, trayBefore: observed.tray, linkTarget: e.service.enablementLink?.linkTarget ?? null,
    unitCandidate: p.unitSha256, trayCandidate: p.autostartSha256,
  }));
  const backups: LinuxRecoveryPlan['immutableBackups'] = [
    { sourcePath: unitPath, backupName: 'unit.original', sha256: observed.unit.state === 'owned' ? observed.unit.sha256 : null, mode: observed.unit.state === 'owned' ? observed.unit.mode : null },
    { sourcePath: autostartPath, backupName: 'autostart.original', sha256: observed.tray.state === 'owned' ? observed.tray.sha256 : null, mode: observed.tray.state === 'owned' ? observed.tray.mode : null },
    { sourcePath: linkPath, backupName: 'enablement.original', sha256: e.service.enablementLink === null ? null : sha256(e.service.enablementLink.linkTarget ?? ''), mode: null },
  ];
  return {
    operation: input.operation, trigger: 'explicit-user-action',
    result: steps.length === 0 ? input.operation === 'install' ? 'already-current' : 'already-absent' : 'plan-transaction',
    execution: 'plan-only',
    preconditions: { physicalXdgRootsMustAlreadyExist: true, packageInputsMustNotBeGroupOrWorldWritable: true },
    policy: p, observed: { unit: observed.unit, trayAutostart: observed.tray, manager: observed.manager }, steps,
    recovery: {
      identitySha256: identityHash, lockPath, immutableBackups: backups,
      candidateSha256: { unit: p.unitSha256, autostart: p.autostartSha256 },
      rollback: {
        restoreOnlyIfCurrentStateMatchesTransaction: true, preserveForeignOrChangedObjects: true,
        retainBackupsAndLockOnMismatchOrRollbackFailure: true, neverDeleteUserDataOrDatabaseFiles: true,
      },
      retention: {
        success: 'remove-transient-candidates-and-release-lock-after-postcondition-check',
        failure: 'retain-private-recovery-files-and-lock',
      },
    },
    concurrencyLimit: 'same-user-cooperating-writers-only',
  };
}
