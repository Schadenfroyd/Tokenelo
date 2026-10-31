import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LINUX_TOKENELO_AUTOSTART_NAME,
  LINUX_TOKENELO_PACKAGE_CONTRACT,
  LINUX_TOKENELO_TRANSACTION_LOCK,
  LINUX_TOKENELO_UNIT_NAME,
  planLinuxServiceLifecycle,
  type LinuxLifecyclePlanningEvidence,
  type LinuxPathIdentity,
  type LinuxServiceLifecyclePlan,
  type LinuxSystemdUnitObservation,
} from './linux-service-lifecycle.js';

const COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const RECOVERY_FILE = 'transaction.json';

export interface LinuxRuntimeCommandResult { status: number; stdout: string; stderr: string; timedOut?: boolean; }
export interface LinuxRuntimeFileSystem {
  lstat(file: string): LinuxPathIdentity | null;
  realpath(file: string): string;
  readFile(file: string): string;
  readLink(file: string): string;
  list(directory: string): string[];
  readPrefix(file: string, bytes: number): Buffer;
  mkdir(directory: string, mode: number): void;
  writeFile(file: string, contents: string, mode: number, exclusive?: boolean): void;
  rename(from: string, to: string): void;
  unlink(file: string): void;
  rmdir(directory: string): void;
  symlink(target: string, link: string): void;
  chmod(file: string, mode: number): void;
  syncFile(file: string): void;
  syncDirectory(directory: string): void;
}
export interface LinuxRuntimeSystemd {
  command(args: readonly string[]): LinuxRuntimeCommandResult;
  state(unitName: string): { enabled: 'enabled' | 'disabled' | 'not-found' | 'masked' | 'linked' | 'static' | 'unknown'; active: 'active' | 'inactive' | 'failed' | 'not-found' | 'unknown' };
  observation(unitName: string, executable: string, daemonEntry: string): LinuxSystemdUnitObservation | null;
}
export interface LinuxServiceRuntimeHost {
  platform: string;
  uid: number;
  home: string;
  environment: Readonly<Record<string, string | undefined>>;
  runtimePath: string;
  entryPath: string;
  appRoot: string;
  packageRoot: string;
  fs: LinuxRuntimeFileSystem;
  systemd: LinuxRuntimeSystemd;
  collectEvidence(): LinuxLifecyclePlanningEvidence;
}
export interface LinuxLifecyclePreflight { plan: LinuxServiceLifecyclePlan; evidence: LinuxLifecyclePlanningEvidence; }
export type LinuxActivationResult =
  | { status: 'cancelled' }
  | { status: 'already-current' }
  | { status: 'activated' }
  | { status: 'needs-review'; reason: 'package-identity' | 'configuration-identity' | 'service-state' | 'transaction-owned' | 'daemon-not-quiescent'; rollbackComplete?: boolean; recoveryRetained?: boolean; recoveryPath?: string }
  | { status: 'failed'; reason: 'install-failed'; recoveryRetained: boolean; rollbackComplete: boolean; recoveryPath?: string };
export type LinuxRecoveryInspection =
  | { status: 'none' }
  | { status: 'verified-manual-review'; recoveryPath: string }
  | { status: 'needs-review'; recoveryPath: string; reason:
      'active-operation' | 'host-identity' | 'foreign-lock' | 'unexpected-entry' | 'receipt-missing' |
      'receipt-invalid' | 'incomplete-receipt' | 'current-state-unverifiable' | 'current-state-changed' |
      'snapshot-mismatch' | 'backup-mismatch' | 'recovery-note-invalid' };
export interface LinuxDaemonQuiescence { quiescent: boolean; stoppedOwnedTransient: boolean; }
export interface LinuxTransientChildHandle {
  pid?: number;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}
export interface LinuxActivationHooks {
  confirm(): Promise<boolean>;
  ensureDaemonQuiescent(): Promise<LinuxDaemonQuiescence>;
  resumeTransientDaemon(): Promise<void>;
}

let activationInProgress = false;

export async function terminateOwnedTransientDaemon(
  child: LinuxTransientChildHandle,
  waitForExit: (timeoutMs: number) => Promise<boolean>,
): Promise<boolean> {
  if (!Number.isInteger(child.pid) || child.pid! <= 0 || child.exitCode !== null || child.signalCode !== null || child.killed) return false;
  try { child.kill('SIGTERM'); } catch { return false; }
  // The daemon's signal handler drains collectors and report-job cgroups before exit.
  // If that ownership proof takes too long, refuse activation; a forced kill could orphan work.
  return await waitForExit(30_000) || child.exitCode !== null || child.signalCode !== null;
}

class RuntimeRefusal extends Error {
  constructor(readonly reason: 'package-identity' | 'configuration-identity' | 'service-state' | 'transaction-owned' | 'daemon-not-quiescent') { super(reason); }
}
class RecoveryInspectionRefusal extends Error {
  constructor(readonly reason: Exclude<LinuxRecoveryInspection, { status: 'none' | 'verified-manual-review' }>['reason']) { super(reason); }
}

function sha256(bytes: string): string { return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex'); }
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function requirePhysicalDirectory(host: LinuxServiceRuntimeHost, directory: string, uid: number, exactMode?: number): LinuxPathIdentity {
  const identity = host.fs.lstat(directory);
  if (!identity || identity.kind !== 'directory' || identity.uid !== uid || identity.realPath !== directory ||
      (identity.mode & 0o022) !== 0 || (identity.mode & 0o300) !== 0o300 ||
      (exactMode !== undefined && (identity.mode & 0o7777) !== exactMode)) throw new RuntimeRefusal('package-identity');
  return identity;
}
function requirePhysicalFile(host: LinuxServiceRuntimeHost, file: string, uid: number, executable = false): LinuxPathIdentity {
  const identity = host.fs.lstat(file);
  if (!identity || identity.kind !== 'file' || identity.uid !== uid || identity.realPath !== file ||
      (identity.mode & 0o022) !== 0 || (executable && (identity.mode & 0o111) === 0)) throw new RuntimeRefusal('package-identity');
  return identity;
}

function serviceObject(fsApi: LinuxRuntimeFileSystem, file: string, uid: number) {
  const identity = fsApi.lstat(file);
  if (!identity) return null;
  if (identity.kind !== 'file' || identity.uid !== uid || (identity.mode & 0o7777) !== 0o644 || identity.realPath !== file) {
    return { identity };
  }
  return { identity, contents: fsApi.readFile(file) };
}

export function prepareLinuxServiceInstall(host: LinuxServiceRuntimeHost): LinuxLifecyclePreflight {
  try {
    if (host.environment.TOKENELO_HOME !== undefined) throw new RuntimeRefusal('configuration-identity');
    if (host.platform !== 'linux' || !Number.isInteger(host.uid) || host.uid <= 0 ||
        host.home !== host.environment.HOME || host.runtimePath !== path.posix.join(host.packageRoot, 'tokenelo') ||
        host.entryPath !== path.posix.join(host.appRoot, 'dist/tray/main.js') ||
        path.posix.basename(host.runtimePath) !== LINUX_TOKENELO_PACKAGE_CONTRACT.executableName ||
        path.posix.normalize(host.runtimePath) !== host.runtimePath || host.runtimePath.includes('\\') ||
        /[\u0000-\u001f\u007f]/u.test(host.runtimePath) ||
        /[\s;]/u.test(host.runtimePath) || /[\u0000-\u001f\u007f]/u.test(host.appRoot)) throw new RuntimeRefusal('package-identity');
    const accountHome = host.home;
    requirePhysicalDirectory(host, accountHome, host.uid);
    const packageRoot = requirePhysicalDirectory(host, host.packageRoot, host.uid);
    const appRoot = requirePhysicalDirectory(host, host.appRoot, host.uid);
    const resources = requirePhysicalDirectory(host, path.posix.join(packageRoot.path, 'resources'), host.uid);
    if (appRoot.path !== path.posix.join(resources.path, 'app') || path.posix.dirname(host.runtimePath) !== packageRoot.path) {
      throw new RuntimeRefusal('package-identity');
    }
    requirePhysicalFile(host, host.runtimePath, host.uid, true);
    const executablePrefix = host.fs.readPrefix(host.runtimePath, 4);
    if (executablePrefix.toString('hex') !== '7f454c46') throw new RuntimeRefusal('package-identity');
    const appPackageJson = path.posix.join(appRoot.path, 'package.json');
    const packageJsonIdentity = requirePhysicalFile(host, appPackageJson, host.uid);
    if (packageJsonIdentity.mode & 0o022) throw new RuntimeRefusal('package-identity');
    const packageJsonContents = host.fs.readFile(appPackageJson);
    if (packageJsonContents.length > 64 * 1024) throw new RuntimeRefusal('package-identity');
    const lifecycleEntry = path.posix.join(appRoot.path, LINUX_TOKENELO_PACKAGE_CONTRACT.lifecycleEntry);
    const daemonEntry = path.posix.join(appRoot.path, LINUX_TOKENELO_PACKAGE_CONTRACT.daemonEntry);
    const trayEntry = path.posix.join(appRoot.path, LINUX_TOKENELO_PACKAGE_CONTRACT.trayEntry);
    const sandboxPath = path.posix.join(packageRoot.path, LINUX_TOKENELO_PACKAGE_CONTRACT.sandboxEntry);
    const packageMetadata: unknown = JSON.parse(packageJsonContents);
    if (!isPlainRecord(packageMetadata) || packageMetadata.name !== LINUX_TOKENELO_PACKAGE_CONTRACT.packageName ||
        packageMetadata.private !== true || packageMetadata.type !== LINUX_TOKENELO_PACKAGE_CONTRACT.packageType ||
        packageMetadata.main !== LINUX_TOKENELO_PACKAGE_CONTRACT.packageMain) throw new RuntimeRefusal('package-identity');
    const lifecycleIdentity = requirePhysicalFile(host, lifecycleEntry, host.uid);
    const daemonIdentity = requirePhysicalFile(host, daemonEntry, host.uid);
    const trayIdentity = requirePhysicalFile(host, trayEntry, host.uid);
    requirePhysicalFile(host, host.entryPath, host.uid);
    const sandbox = host.fs.lstat(sandboxPath);
    if (!sandbox || sandbox.kind !== 'file' || sandbox.realPath !== sandboxPath || (sandbox.mode & 0o022) !== 0) {
      throw new RuntimeRefusal('package-identity');
    }
    const sandboxCapability = sandbox.uid === 0 && (sandbox.mode & 0o7777) === 0o4755
      ? 'setuid-helper' as const
      : sandbox.uid === host.uid && (sandbox.mode & 0o7777) === 0o755
        ? 'user-namespace' as const : 'unknown' as const;
    const configHome = host.environment.XDG_CONFIG_HOME || path.posix.join(accountHome, '.config');
    const dataHome = host.environment.XDG_DATA_HOME || path.posix.join(accountHome, '.local', 'share');
    const stateHome = host.environment.XDG_STATE_HOME || path.posix.join(accountHome, '.local', 'state');
    let configIdentity: LinuxPathIdentity, dataIdentity: LinuxPathIdentity, stateIdentity: LinuxPathIdentity;
    try {
      configIdentity = requirePhysicalDirectory(host, configHome, host.uid);
      dataIdentity = requirePhysicalDirectory(host, dataHome, host.uid);
      stateIdentity = requirePhysicalDirectory(host, stateHome, host.uid);
    } catch { throw new RuntimeRefusal('configuration-identity'); }
    const systemEnvIdentity = requirePhysicalFile(host, '/usr/bin/env', 0, true);
    requirePhysicalFile(host, '/usr/bin/systemctl', 0, true);
    const policyUnitPath = path.posix.join(configHome, 'systemd', 'user', LINUX_TOKENELO_UNIT_NAME);
    const autoPath = path.posix.join(configHome, 'autostart', LINUX_TOKENELO_AUTOSTART_NAME);
    const linkPath = path.posix.join(configHome, 'systemd', 'user', 'default.target.wants', LINUX_TOKENELO_UNIT_NAME);
    const linkIdentity = host.fs.lstat(linkPath);
    const enablementLink = linkIdentity ? {
      identity: linkIdentity,
      ...(linkIdentity.kind === 'symlink' ? { linkTarget: host.fs.readLink(linkPath) } : {}),
    } : null;
    const manager = host.systemd.observation(LINUX_TOKENELO_UNIT_NAME, host.runtimePath, daemonEntry);
    const state = host.systemd.state(LINUX_TOKENELO_UNIT_NAME);
    const evidence: LinuxLifecyclePlanningEvidence = {
      platform: host.platform, uid: host.uid, runtimeHome: host.home, accountHome,
      homeEnvironment: host.environment.HOME, tokeneloHomeEnvironment: host.environment.TOKENELO_HOME,
      pathEnvironment: host.environment.PATH, configHomeEnvironment: host.environment.XDG_CONFIG_HOME,
      dataHomeEnvironment: host.environment.XDG_DATA_HOME, stateHomeEnvironment: host.environment.XDG_STATE_HOME,
      accountHomeIdentity: requirePhysicalDirectory(host, accountHome, host.uid),
      configHomeIdentity: configIdentity, dataHomeIdentity: dataIdentity, stateHomeIdentity: stateIdentity,
      systemEnvIdentity,
      package: {
        packageRoot, resourcesDirectory: resources, appDirectory: appRoot,
        packageJson: { identity: packageJsonIdentity, contents: packageJsonContents }, packageJsonContents,
        lifecycleEntry: lifecycleIdentity, daemonEntry: daemonIdentity, trayEntry: trayIdentity,
        executable: requirePhysicalFile(host, host.runtimePath, host.uid, true), executableFormat: 'ELF',
        executableBasename: path.posix.basename(host.runtimePath), sandbox, sandboxCapability,
      },
      service: {
        unitFile: serviceObject(host.fs, policyUnitPath, host.uid), trayAutostartFile: serviceObject(host.fs, autoPath, host.uid),
        enablementLink, manager, enabled: state.enabled, active: state.active,
      },
    };
    let plan: LinuxServiceLifecyclePlan;
    try { plan = planLinuxServiceLifecycle({ operation: 'install', evidence }); }
    catch { throw new RuntimeRefusal('service-state'); }
    return { plan, evidence };
  } catch (error) {
    if (error instanceof RuntimeRefusal) throw error;
    throw new RuntimeRefusal('package-identity');
  }
}

function matchesPath(host: LinuxServiceRuntimeHost, file: string, expectedSha: string | null): boolean {
  const current = host.fs.lstat(file);
  if (expectedSha === null) return current === null;
  return current !== null && current.kind === 'file' && current.uid === host.uid &&
    (current.mode & 0o7777) === 0o644 && current.realPath === file &&
    sha256(host.fs.readFile(file)) === expectedSha;
}
function safeSystemdObservation(plan: LinuxServiceLifecyclePlan, observation: LinuxSystemdUnitObservation | null): boolean {
  return observation !== null && observation.fragmentPath === plan.policy.unitPath &&
    observation.execStartArgv !== null && observation.execStartArgv.length === plan.policy.unitArgv.length &&
    observation.execStartArgv.every((arg, index) => arg === plan.policy.unitArgv[index]) &&
    observation.dropInPaths?.length === 0 && observation.needDaemonReload === 'no';
}
function supportedInstallPlan(plan: LinuxServiceLifecyclePlan): boolean {
  const p = plan.policy;
  const candidates = [
    { path: p.unitPath, sha256: p.unitSha256, mode: 0o644 },
    { path: p.autostartPath, sha256: p.autostartSha256, mode: 0o644 },
  ];
  const expected = [
    { kind: 'acquire-same-user-lock', path: p.transactionLockPath, mode: 0o700 },
    { kind: 'revalidate-preflight-under-lock' },
    { kind: 'provision-service-directories', paths: [path.posix.dirname(p.unitPath), path.posix.dirname(p.autostartPath), path.posix.dirname(p.enablementLinkPath)], mode: 0o700 },
    { kind: 'capture-immutable-originals', paths: [p.unitPath, p.autostartPath, p.enablementLinkPath], mode: 0o600 },
    { kind: 'stage-candidates', candidates },
    { kind: 'verify-candidates-before-publication', candidates },
    { kind: 'publish-owned-file', path: p.unitPath, sha256: p.unitSha256, mode: 0o644 },
    { kind: 'verify-published-file', path: p.unitPath, sha256: p.unitSha256, mode: 0o644 },
    { kind: 'daemon-reload' },
    { kind: 'verify-loaded-unit', fragmentPath: p.unitPath, execStartArgv: p.unitArgv, dropInPaths: 0 },
    { kind: 'ensure-exact-enablement-link', path: p.enablementLinkPath, target: p.unitPath },
    { kind: 'publish-owned-file', path: p.autostartPath, sha256: p.autostartSha256, mode: 0o644 },
    { kind: 'verify-published-file', path: p.autostartPath, sha256: p.autostartSha256, mode: 0o644 },
    { kind: 'start-exact-unit', unitName: LINUX_TOKENELO_UNIT_NAME },
    { kind: 'verify-final-state', operation: 'install' },
    { kind: 'release-lock-after-verification', path: p.transactionLockPath },
  ];
  return plan.operation === 'install' && JSON.stringify(plan.steps) === JSON.stringify(expected);
}
function ensureOwnedDirectory(fsApi: LinuxRuntimeFileSystem, directory: string, uid: number, made: string[]): void {
  const current = fsApi.lstat(directory);
  if (current) {
    if (current.kind !== 'directory' || current.uid !== uid || current.realPath !== directory ||
        (current.mode & 0o022) !== 0 || (current.mode & 0o300) !== 0o300) throw new Error('unsafe service directory');
    return;
  }
  const parent = path.posix.dirname(directory);
  if (parent === directory) throw new Error('service directory parent missing');
  ensureOwnedDirectory(fsApi, parent, uid, made);
  fsApi.mkdir(directory, 0o700);
  const created = fsApi.lstat(directory);
  if (!created || created.kind !== 'directory' || created.uid !== uid || created.realPath !== directory ||
      (created.mode & 0o7777) !== 0o700) throw new Error('service directory changed during creation');
  made.push(directory);
  fsApi.syncDirectory(parent);
}

interface Snapshot { path: string; contents: string | null; mode: number | null; linkTarget: string | null; }
function snapshot(host: LinuxServiceRuntimeHost, file: string, uid: number): Snapshot {
  const status = host.fs.lstat(file);
  if (!status) return { path: file, contents: null, mode: null, linkTarget: null };
  if (status.uid !== uid || (status.kind !== 'file' && status.kind !== 'symlink')) {
    throw new Error('unexpected existing lifecycle object');
  }
  if (status.kind === 'symlink') {
    const target = host.fs.readLink(file);
    if (status.realPath !== target) throw new Error('existing link does not resolve to its exact target');
    return { path: file, contents: null, mode: status.mode & 0o7777, linkTarget: target };
  }
  if (status.realPath !== file) throw new Error('existing service file is not physical');
  return { path: file, contents: host.fs.readFile(file), mode: status.mode & 0o7777, linkTarget: null };
}
function verifySnapshot(host: LinuxServiceRuntimeHost, before: Snapshot): boolean {
  const current = host.fs.lstat(before.path);
  if (before.contents === null && before.linkTarget === null) return current === null;
  if (!current || current.uid !== host.uid || current.realPath !== (before.linkTarget ?? before.path) ||
      (current.mode & 0o7777) !== before.mode) return false;
  if (before.linkTarget !== null) return current.kind === 'symlink' && host.fs.readLink(before.path) === before.linkTarget;
  return current.kind === 'file' && host.fs.readFile(before.path) === before.contents;
}

function writeRecoveryReceipt(host: LinuxServiceRuntimeHost, lock: string, snapshots: Snapshot[], identitySha256: string,
                              failure?: { phase: 'pre-snapshot'; reason: 'service-state' | 'snapshot-failed' }): void {
  const data = JSON.stringify({ schemaVersion: 1, identitySha256, snapshots: snapshots.map(s => ({
    path: s.path, existed: s.contents !== null || s.linkTarget !== null,
    sha256: s.contents === null ? null : sha256(s.contents), mode: s.mode, linkTarget: s.linkTarget,
  })), ...(failure ? { failure } : {}) });
  host.fs.writeFile(path.posix.join(lock, RECOVERY_FILE), data, 0o600, true);
  host.fs.chmod(path.posix.join(lock, RECOVERY_FILE), 0o600);
  host.fs.syncFile(path.posix.join(lock, RECOVERY_FILE));
  const receiptPath = path.posix.join(lock, RECOVERY_FILE);
  const receiptStatus = host.fs.lstat(receiptPath);
  if (!receiptStatus || receiptStatus.kind !== 'file' || receiptStatus.uid !== host.uid ||
      (receiptStatus.mode & 0o7777) !== 0o600 || receiptStatus.realPath !== receiptPath ||
      sha256(host.fs.readFile(receiptPath)) !== sha256(data)) throw new Error('recovery receipt verification failed');
  host.fs.syncDirectory(lock);
  snapshots.forEach((s, i) => {
    if (s.contents !== null) {
      const backup = path.posix.join(lock, i === 0 ? 'unit.original' : 'autostart.original');
      host.fs.writeFile(backup, s.contents, 0o600, true);
      host.fs.chmod(backup, 0o600);
      host.fs.syncFile(backup);
      const backupStatus = host.fs.lstat(backup);
      if (!backupStatus || backupStatus.kind !== 'file' || backupStatus.uid !== host.uid ||
          (backupStatus.mode & 0o7777) !== 0o600 || backupStatus.realPath !== backup ||
          sha256(host.fs.readFile(backup)) !== sha256(s.contents)) throw new Error('original backup verification failed');
    }
  });
  host.fs.syncDirectory(lock);
}

function removeOwnedLock(host: LinuxServiceRuntimeHost, lock: string): void {
  const status = host.fs.lstat(lock);
  if (!status) return;
  if (status.kind !== 'directory' || status.uid !== host.uid || status.realPath !== lock || (status.mode & 0o7777) !== 0o700) {
    throw new Error('transaction lock changed');
  }
  const entries: string[] = [];
  const allowed = new Set(['unit.original', 'autostart.original', RECOVERY_FILE]);
  if (host.fs.list(lock).some(name => !allowed.has(name))) throw new Error('unexpected transaction recovery object');
  for (const name of ['unit.original', 'autostart.original', RECOVERY_FILE]) {
    const file = path.posix.join(lock, name);
    const item = host.fs.lstat(file);
    if (!item) continue;
    if (item.kind !== 'file' || item.uid !== host.uid || (item.mode & 0o7777) !== 0o600 || item.realPath !== file) {
      throw new Error('transaction recovery object changed');
    }
    entries.push(file);
  }
  for (const file of entries) host.fs.unlink(file);
  host.fs.rmdir(lock);
  host.fs.syncDirectory(path.posix.dirname(lock));
}

function readOwnedRecoveryFile(host: LinuxServiceRuntimeHost, file: string, reason: 'receipt-invalid' | 'backup-mismatch' | 'recovery-note-invalid', maxBytes: number): string {
  const before = host.fs.lstat(file);
  if (!before || before.kind !== 'file' || before.uid !== host.uid || before.realPath !== file ||
      (before.mode & 0o7777) !== 0o600) throw new RecoveryInspectionRefusal(reason);
  const first = host.fs.readFile(file);
  if (Buffer.byteLength(first, 'utf8') > maxBytes) throw new RecoveryInspectionRefusal(reason);
  const after = host.fs.lstat(file);
  if (!after || after.kind !== 'file' || after.uid !== host.uid || after.realPath !== file ||
      (after.mode & 0o7777) !== 0o600 || host.fs.readFile(file) !== first) {
    throw new RecoveryInspectionRefusal(reason);
  }
  return first;
}

function recoverySnapshotMatches(actual: Snapshot, receipt: Record<string, unknown>, expectedPath: string): boolean {
  const existed = actual.contents !== null || actual.linkTarget !== null;
  return receipt.path === expectedPath && receipt.existed === existed &&
    receipt.sha256 === (actual.contents === null ? null : sha256(actual.contents)) &&
    receipt.mode === actual.mode && receipt.linkTarget === actual.linkTarget;
}

/** Read-only inspection. It never removes the lock or restores service files. */
export function inspectLinuxServiceRecovery(host: LinuxServiceRuntimeHost): LinuxRecoveryInspection {
  const recoveryPath = path.posix.join(host.home, LINUX_TOKENELO_TRANSACTION_LOCK);
  if (activationInProgress) return { status: 'needs-review', recoveryPath, reason: 'active-operation' };
  if (host.platform !== 'linux' || !Number.isInteger(host.uid) || host.uid <= 0 ||
      !path.posix.isAbsolute(host.home) || path.posix.normalize(host.home) !== host.home ||
      host.environment.HOME !== host.home || host.environment.TOKENELO_HOME !== undefined) {
    return { status: 'needs-review', recoveryPath, reason: 'host-identity' };
  }
  const lock = host.fs.lstat(recoveryPath);
  if (!lock) return { status: 'none' };
  if (lock.kind !== 'directory' || lock.uid !== host.uid || lock.realPath !== recoveryPath ||
      (lock.mode & 0o7777) !== 0o700) return { status: 'needs-review', recoveryPath, reason: 'foreign-lock' };
  try {
    const entries = host.fs.list(recoveryPath).sort();
    const allowed = new Set(['autostart.original', 'recovery.txt', 'transaction.json', 'unit.original']);
    if (entries.some(name => !allowed.has(name))) throw new RecoveryInspectionRefusal('unexpected-entry');
    const receiptPath = path.posix.join(recoveryPath, RECOVERY_FILE);
    if (!entries.includes(RECOVERY_FILE)) throw new RecoveryInspectionRefusal('receipt-missing');
    const receiptText = readOwnedRecoveryFile(host, receiptPath, 'receipt-invalid', 128 * 1024);
    let raw: unknown;
    try { raw = JSON.parse(receiptText); } catch { throw new RecoveryInspectionRefusal('receipt-invalid'); }
    if (!isPlainRecord(raw) || !["identitySha256,schemaVersion,snapshots", "failure,identitySha256,schemaVersion,snapshots"].includes(Object.keys(raw).sort().join(',')) ||
        raw.schemaVersion !== 1 || typeof raw.identitySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.identitySha256) || !Array.isArray(raw.snapshots)) {
      throw new RecoveryInspectionRefusal('receipt-invalid');
    }
    const prepared = prepareLinuxServiceInstall(host);
    if (prepared.plan.result !== 'plan-transaction' || prepared.plan.recovery.identitySha256 !== raw.identitySha256) {
      throw new RecoveryInspectionRefusal('current-state-changed');
    }
    const paths = [prepared.plan.policy.unitPath, prepared.plan.policy.autostartPath, prepared.plan.policy.enablementLinkPath];
    if (raw.snapshots.length !== 3) {
      const failure = raw.failure;
      if (raw.snapshots.length === 0 && isPlainRecord(failure) &&
          Object.keys(failure).sort().join(',') === 'phase,reason' && failure.phase === 'pre-snapshot' &&
          (failure.reason === 'service-state' || failure.reason === 'snapshot-failed')) {
        throw new RecoveryInspectionRefusal('incomplete-receipt');
      }
      throw new RecoveryInspectionRefusal('receipt-invalid');
    }
    if (raw.failure !== undefined) throw new RecoveryInspectionRefusal('receipt-invalid');
    const expectedSnapshotKeys = 'existed,linkTarget,mode,path,sha256';
    const actualSnapshots = paths.map(file => snapshot(host, file, host.uid));
    for (let index = 0; index < paths.length; index++) {
      const item = raw.snapshots[index];
      if (!isPlainRecord(item) || Object.keys(item).sort().join(',') !== expectedSnapshotKeys ||
          !recoverySnapshotMatches(actualSnapshots[index]!, item, paths[index]!)) {
        throw new RecoveryInspectionRefusal('snapshot-mismatch');
      }
      const backupName = index === 0 ? 'unit.original' : index === 1 ? 'autostart.original' : null;
      const requiresBackup = item.existed === true && item.linkTarget === null;
      if (backupName && requiresBackup) {
        if (!entries.includes(backupName) || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256))
          throw new RecoveryInspectionRefusal('backup-mismatch');
        const backup = readOwnedRecoveryFile(host, path.posix.join(recoveryPath, backupName), 'backup-mismatch', 1024 * 1024);
        if (sha256(backup) !== item.sha256) throw new RecoveryInspectionRefusal('backup-mismatch');
      } else if (backupName && entries.includes(backupName)) {
        throw new RecoveryInspectionRefusal('backup-mismatch');
      }
    }
    if (entries.includes('recovery.txt')) {
      const note = readOwnedRecoveryFile(host, path.posix.join(recoveryPath, 'recovery.txt'), 'recovery-note-invalid', 4096);
      if (note !== 'Linux service rollback requires review\n') throw new RecoveryInspectionRefusal('recovery-note-invalid');
    }
    if (host.fs.readFile(receiptPath) !== receiptText) throw new RecoveryInspectionRefusal('receipt-invalid');
    return { status: 'verified-manual-review', recoveryPath };
  } catch (error) {
    const reason = error instanceof RecoveryInspectionRefusal ? error.reason : 'current-state-unverifiable';
    return { status: 'needs-review', recoveryPath, reason };
  }
}

interface StagedCandidate { path: string; sha256: string; }
function stageCandidate(host: LinuxServiceRuntimeHost, file: string, contents: string, expectedSha: string, uid: number, staged: StagedCandidate[]): string {
  const temp = `${file}.tokenelo-candidate-${crypto.randomUUID()}`;
  staged.push({ path: temp, sha256: expectedSha });
  host.fs.writeFile(temp, contents, 0o644, true);
  host.fs.chmod(temp, 0o644);
  host.fs.syncFile(temp);
  const status = host.fs.lstat(temp);
  if (!status || status.kind !== 'file' || status.uid !== uid || status.realPath !== temp ||
      (status.mode & 0o7777) !== 0o644 || sha256(host.fs.readFile(temp)) !== expectedSha) throw new Error('candidate verification failed');
  return temp;
}

function runSystemd(host: LinuxServiceRuntimeHost, args: readonly string[]): void {
  const result = host.systemd.command(args);
  if (result.timedOut || result.status !== 0) throw new Error('systemd command failed');
}
function planStillMatches(host: LinuxServiceRuntimeHost, expected: LinuxServiceLifecyclePlan): LinuxLifecyclePlanningEvidence {
  const fresh = host.collectEvidence();
  let next: LinuxServiceLifecyclePlan;
  try { next = planLinuxServiceLifecycle({ operation: 'install', evidence: fresh }); }
  catch { throw new RuntimeRefusal('service-state'); }
  if (next.recovery.identitySha256 !== expected.recovery.identitySha256 || next.result !== expected.result) {
    throw new RuntimeRefusal('service-state');
  }
  return fresh;
}
function createParentDirectories(host: LinuxServiceRuntimeHost, plan: LinuxServiceLifecyclePlan, made: string[]): void {
  for (const directory of [
    path.posix.dirname(plan.policy.unitPath),
    path.posix.dirname(plan.policy.enablementLinkPath),
    path.posix.dirname(plan.policy.autostartPath),
  ]) ensureOwnedDirectory(host.fs, directory, plan.policy.uid, made);
}
function verifyManager(host: LinuxServiceRuntimeHost, plan: LinuxServiceLifecyclePlan): void {
  const manager = host.systemd.observation(LINUX_TOKENELO_UNIT_NAME, plan.policy.executablePath, plan.policy.daemonEntryPath);
  if (!safeSystemdObservation(plan, manager)) throw new Error('loaded unit does not match the exact candidate');
}
function verifyEnablementLink(host: LinuxServiceRuntimeHost, plan: LinuxServiceLifecyclePlan): void {
  const link = host.fs.lstat(plan.policy.enablementLinkPath);
  if (!link || link.kind !== 'symlink' || link.uid !== plan.policy.uid ||
      link.realPath !== plan.policy.unitPath || host.fs.readLink(plan.policy.enablementLinkPath) !== plan.policy.unitPath) {
    throw new Error('enablement link verification failed');
  }
}
function ensureEnablementLink(host: LinuxServiceRuntimeHost, plan: LinuxServiceLifecyclePlan): boolean {
  const current = host.fs.lstat(plan.policy.enablementLinkPath);
  if (current) {
    if (current.kind !== 'symlink' || current.uid !== plan.policy.uid || current.realPath !== plan.policy.unitPath ||
        host.fs.readLink(plan.policy.enablementLinkPath) !== plan.policy.unitPath) throw new Error('enablement path is foreign');
    return false;
  }
  host.fs.symlink(plan.policy.unitPath, plan.policy.enablementLinkPath);
  return true;
}
function verifyFinalInstall(host: LinuxServiceRuntimeHost, plan: LinuxServiceLifecyclePlan): void {
  if (!matchesPath(host, plan.policy.unitPath, plan.policy.unitSha256) ||
      !matchesPath(host, plan.policy.autostartPath, plan.policy.autostartSha256)) throw new Error('published service files do not match');
  verifyEnablementLink(host, plan);
  verifyManager(host, plan);
  const state = host.systemd.state(LINUX_TOKENELO_UNIT_NAME);
  if (state.enabled !== 'enabled' || state.active !== 'active') throw new Error('service did not reach enabled active state');
}

function restoreSnapshot(host: LinuxServiceRuntimeHost, before: Snapshot, candidateSha: string, lock: string, backupName: string): void {
  if (before.linkTarget !== null) {
    // The planner permits only the exact pre-existing enablement link.
    verifySnapshot(host, before) || (() => { throw new Error('prior link changed during install'); })();
    return;
  }
  const current = host.fs.lstat(before.path);
  if (before.contents === null) {
    if (!current) return;
    if (current.kind !== 'file' || current.uid !== host.uid || current.realPath !== before.path ||
        (current.mode & 0o7777) !== 0o644 || sha256(host.fs.readFile(before.path)) !== candidateSha) {
      throw new Error('candidate file changed before rollback');
    }
    host.fs.unlink(before.path);
    host.fs.syncDirectory(path.posix.dirname(before.path));
    return;
  }
  if (!current || current.kind !== 'file' || current.uid !== host.uid || current.realPath !== before.path ||
      (current.mode & 0o7777) !== 0o644 || sha256(host.fs.readFile(before.path)) !== candidateSha) {
    throw new Error('candidate file changed before rollback');
  }
  const backup = path.posix.join(lock, backupName);
  const backupStatus = host.fs.lstat(backup);
  if (!backupStatus || backupStatus.kind !== 'file' || backupStatus.uid !== host.uid ||
      (backupStatus.mode & 0o7777) !== 0o600 || backupStatus.realPath !== backup ||
      sha256(host.fs.readFile(backup)) !== sha256(before.contents)) throw new Error('original backup verification failed');
  const temp = `${before.path}.tokenelo-rollback-${crypto.randomUUID()}`;
  host.fs.writeFile(temp, host.fs.readFile(backup), before.mode ?? 0o644, true);
  host.fs.chmod(temp, before.mode ?? 0o644);
  host.fs.syncFile(temp);
  host.fs.rename(temp, before.path);
  host.fs.syncDirectory(path.posix.dirname(before.path));
}

async function executeInstallPlan(host: LinuxServiceRuntimeHost, initial: LinuxLifecyclePreflight,
                                 ensureDaemonQuiescent: () => Promise<LinuxDaemonQuiescence>): Promise<LinuxActivationResult> {
  const plan = initial.plan;
  if (plan.result === 'already-current') return { status: 'already-current' };
  if (plan.execution !== 'plan-only' || !supportedInstallPlan(plan)) {
    return { status: 'needs-review', reason: 'service-state' };
  }
  const lock = plan.policy.transactionLockPath;
  try { host.fs.mkdir(lock, 0o700); }
  catch { return { status: 'needs-review', reason: 'transaction-owned', recoveryPath: lock }; }
  const lockId = host.fs.lstat(lock);
  if (!lockId || lockId.kind !== 'directory' || lockId.uid !== plan.policy.uid ||
      lockId.realPath !== lock || (lockId.mode & 0o7777) !== 0o700) {
    if (lockId?.kind === 'directory' && lockId.uid === plan.policy.uid && lockId.realPath === lock) {
      try { host.fs.rmdir(lock); host.fs.syncDirectory(path.posix.dirname(lock)); } catch { /* changed lock evidence remains for review */ }
    }
    return { status: 'needs-review', reason: 'transaction-owned', recoveryPath: lock };
  }
  host.fs.syncDirectory(path.posix.dirname(lock));
  const createdDirectories: string[] = [];
  const staged: StagedCandidate[] = [];
  let snapshots: Snapshot[] = [];
  let snapshotsCaptured = false;
  let mutationsStarted = false;
  let unitPublished = false, autostartPublished = false, linkCreated = false, startAttempted = false;
  let receiptDurable = false;
  let originalActive: string = initial.evidence.service.active;
  try {
    const currentEvidence = planStillMatches(host, plan);
    snapshots = [
      snapshot(host, plan.policy.unitPath, plan.policy.uid),
      snapshot(host, plan.policy.autostartPath, plan.policy.uid),
      snapshot(host, plan.policy.enablementLinkPath, plan.policy.uid),
    ];
    snapshotsCaptured = true;
    originalActive = currentEvidence.service.active;
    writeRecoveryReceipt(host, lock, snapshots, plan.recovery.identitySha256);
    receiptDurable = true;
    const quiescence = await ensureDaemonQuiescent();
    if (!quiescence.quiescent) {
      if (!planStillMatches(host, plan) || !snapshots.every(s => verifySnapshot(host, s)))
        throw new RuntimeRefusal('service-state');
      removeOwnedLock(host, lock);
      return { status: 'needs-review', reason: 'daemon-not-quiescent', rollbackComplete: true };
    }
    mutationsStarted = true;
    createParentDirectories(host, plan, createdDirectories);
    if (!snapshots.every(s => verifySnapshot(host, s))) throw new RuntimeRefusal('service-state');

    const unitStage = stageCandidate(host, plan.policy.unitPath, plan.policy.unitContents, plan.policy.unitSha256, plan.policy.uid, staged);
    const trayStage = stageCandidate(host, plan.policy.autostartPath, plan.policy.autostartContents, plan.policy.autostartSha256, plan.policy.uid, staged);
    if (!matchesPath(host, unitStage, plan.policy.unitSha256) || !matchesPath(host, trayStage, plan.policy.autostartSha256)) {
      throw new Error('candidate stage verification failed');
    }
    if (!snapshots.every(s => verifySnapshot(host, s))) throw new RuntimeRefusal('service-state');

    host.fs.rename(unitStage, plan.policy.unitPath);
    staged.splice(staged.findIndex(candidate => candidate.path === unitStage), 1);
    unitPublished = true;
    host.fs.syncDirectory(path.posix.dirname(plan.policy.unitPath));
    if (!matchesPath(host, plan.policy.unitPath, plan.policy.unitSha256)) throw new Error('unit publication verification failed');
    runSystemd(host, ['daemon-reload']);
    verifyManager(host, plan);

    linkCreated = ensureEnablementLink(host, plan);
    if (linkCreated) host.fs.syncDirectory(path.posix.dirname(plan.policy.enablementLinkPath));
    verifyEnablementLink(host, plan);
    if (!snapshots.every((s, i) => i === 2 || verifySnapshot(host, s) ||
        (i === 0 && matchesPath(host, s.path, plan.policy.unitSha256)))) {
      throw new RuntimeRefusal('service-state');
    }
    host.fs.rename(trayStage, plan.policy.autostartPath);
    staged.splice(staged.findIndex(candidate => candidate.path === trayStage), 1);
    autostartPublished = true;
    host.fs.syncDirectory(path.posix.dirname(plan.policy.autostartPath));
    if (!matchesPath(host, plan.policy.autostartPath, plan.policy.autostartSha256)) throw new Error('autostart publication verification failed');
    startAttempted = true;
    runSystemd(host, ['start', LINUX_TOKENELO_UNIT_NAME]);
    verifyFinalInstall(host, plan);
    removeOwnedLock(host, lock);
    return { status: 'activated' };
  } catch (error) {
    let rollbackComplete = true;
    try {
      if (!snapshotsCaptured) {
        let originalStateProven = false;
        try { planStillMatches(host, plan); originalStateProven = true; } catch { /* require retained evidence */ }
        if (originalStateProven) {
          removeOwnedLock(host, lock);
          return { status: 'needs-review', reason: 'service-state', rollbackComplete: true };
        }
        writeRecoveryReceipt(host, lock, [], plan.recovery.identitySha256, {
          phase: 'pre-snapshot', reason: error instanceof RuntimeRefusal ? 'service-state' : 'snapshot-failed',
        });
        receiptDurable = true;
        return { status: 'failed', reason: 'install-failed', rollbackComplete: false, recoveryRetained: true, recoveryPath: lock };
      }
      if (!mutationsStarted) {
        let originalStateProven = false;
        try {
          planStillMatches(host, plan);
          originalStateProven = snapshots.every(s => verifySnapshot(host, s));
        } catch { /* retain a receipt if the original state cannot be established */ }
        if (originalStateProven) {
          removeOwnedLock(host, lock);
          return { status: 'needs-review', reason: 'service-state', rollbackComplete: true };
        }
        if (!receiptDurable) {
          try {
            writeRecoveryReceipt(host, lock, snapshots, plan.recovery.identitySha256);
            receiptDurable = true;
          } catch { /* retain the owned lock; the result identifies its expected path */ }
        }
        throw new Error('pre-mutation state could not be revalidated');
      }
      if (!unitPublished && !autostartPublished && !linkCreated && !startAttempted &&
          (!receiptDurable || !planStillMatches(host, plan) || !snapshots.every(s => verifySnapshot(host, s)))) {
        throw new Error('service state changed before publication');
      }
      for (const candidate of staged) {
        const tempStatus = host.fs.lstat(candidate.path);
        if (!tempStatus) continue;
        if (tempStatus.kind !== 'file' || tempStatus.uid !== plan.policy.uid || tempStatus.realPath !== candidate.path ||
            (tempStatus.mode & 0o7777) !== 0o644 || sha256(host.fs.readFile(candidate.path)) !== candidate.sha256) {
          throw new Error('staged candidate changed before cleanup');
        }
        host.fs.unlink(candidate.path);
      }
      if (startAttempted) {
        const state = host.systemd.state(LINUX_TOKENELO_UNIT_NAME);
        if (state.active === 'active' && originalActive !== 'active') {
          verifyManager(host, plan);
          runSystemd(host, ['stop', LINUX_TOKENELO_UNIT_NAME]);
        } else if (state.active === 'unknown' || state.active === 'failed') {
          throw new Error('service state unknown during rollback');
        }
      }
      if (linkCreated) restoreLink(host, snapshots[2]!, plan.policy.unitPath);
      if (autostartPublished) restoreSnapshot(host, snapshots[1]!, plan.policy.autostartSha256, lock, 'autostart.original');
      if (unitPublished) restoreSnapshot(host, snapshots[0]!, plan.policy.unitSha256, lock, 'unit.original');
      if (unitPublished) runSystemd(host, ['daemon-reload']);
      const after = host.collectEvidence();
      if (after.service.active !== originalActive ||
          !verifySnapshot(host, snapshots[0]!) || !verifySnapshot(host, snapshots[1]!) || !verifySnapshot(host, snapshots[2]!)) {
        throw new Error('rollback postcondition failed');
      }
      if (unitPublished) {
        const manager = host.systemd.observation(LINUX_TOKENELO_UNIT_NAME, plan.policy.executablePath, plan.policy.daemonEntryPath);
        const prior = initial.evidence.service.manager;
        if (prior === null ? manager !== null : !manager || manager.fragmentPath !== prior.fragmentPath ||
            JSON.stringify(manager.execStartArgv) !== JSON.stringify(prior.execStartArgv) ||
            JSON.stringify(manager.dropInPaths) !== JSON.stringify(prior.dropInPaths) || manager.needDaemonReload !== prior.needDaemonReload) {
          throw new Error('prior manager state did not return');
        }
        const state = host.systemd.state(LINUX_TOKENELO_UNIT_NAME);
        if (state.active !== initial.evidence.service.active || state.enabled !== initial.evidence.service.enabled) {
          throw new Error('prior service state did not return');
        }
      }
      removeOwnedLock(host, lock);
      for (const directory of createdDirectories.reverse()) {
        const current = host.fs.lstat(directory);
        if (current && current.kind === 'directory' && current.uid === plan.policy.uid && current.realPath === directory) {
          try { host.fs.rmdir(directory); } catch { /* empty owned service directories may remain after rollback */ }
        }
      }
    } catch {
      rollbackComplete = false;
      if (receiptDurable) {
        try {
          const recoveryNote = path.posix.join(lock, 'recovery.txt');
          host.fs.writeFile(recoveryNote, 'Linux service rollback requires review\n', 0o600, true);
          host.fs.chmod(recoveryNote, 0o600);
          host.fs.syncFile(recoveryNote);
          host.fs.syncDirectory(lock);
        } catch { /* retain everything already captured */ }
      }
    }
    if (error instanceof RuntimeRefusal && rollbackComplete) {
      return { status: 'needs-review', reason: error.reason as 'package-identity' | 'configuration-identity' | 'service-state' | 'transaction-owned' | 'daemon-not-quiescent', rollbackComplete: true };
    }
    return { status: 'failed', reason: 'install-failed', rollbackComplete, recoveryRetained: !rollbackComplete,
      ...(!rollbackComplete ? { recoveryPath: lock } : {}) };
  }
}

export async function runLinuxBackgroundActivation(host: LinuxServiceRuntimeHost, hooks: LinuxActivationHooks): Promise<LinuxActivationResult> {
  if (!await hooks.confirm()) return { status: 'cancelled' };
  if (activationInProgress) return { status: 'needs-review', reason: 'transaction-owned' };
  activationInProgress = true;
  try {
    let prepared: LinuxLifecyclePreflight;
    try { prepared = prepareLinuxServiceInstall(host); }
    catch (error) {
      return { status: 'needs-review', reason: error instanceof RuntimeRefusal ? error.reason : 'package-identity' };
    }
    if (prepared.plan.result === 'already-current') return { status: 'already-current' };
    let quiescence: LinuxDaemonQuiescence = { quiescent: false, stoppedOwnedTransient: false };
    const result = await executeInstallPlan(host, prepared, async () => {
      quiescence = await hooks.ensureDaemonQuiescent();
      return quiescence;
    });
    const safeToResume = quiescence.stoppedOwnedTransient &&
      (result.status === 'needs-review' ? result.rollbackComplete === true :
        result.status === 'failed' && result.rollbackComplete);
    if (safeToResume) {
      try { await hooks.resumeTransientDaemon(); } catch { /* report current activation result; tray can retry a normal read later */ }
    }
    return result;
  } finally {
    activationInProgress = false;
  }
}


function restoreLink(host: LinuxServiceRuntimeHost, before: Snapshot, target: string): void {
  const current = host.fs.lstat(before.path);
  if (before.linkTarget !== null) {
    if (!current || current.kind !== 'symlink' || current.uid !== host.uid || current.realPath !== target || host.fs.readLink(before.path) !== target) {
      throw new Error('enablement link changed before rollback');
    }
    return;
  }
  if (!current) return;
  if (current.kind !== 'symlink' || current.uid !== host.uid || current.realPath !== target || host.fs.readLink(before.path) !== target) {
    throw new Error('enablement link changed before rollback');
  }
  host.fs.unlink(before.path);
  host.fs.syncDirectory(path.posix.dirname(before.path));
}

function createNodeFileSystem(): LinuxRuntimeFileSystem {
  const get = (file: string): LinuxPathIdentity | null => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    let realPath = file;
    try { realPath = fs.realpathSync(file); } catch { /* retain lstat evidence for broken or aliased objects; never treat them as missing */ }
    return { path: file, realPath, kind: st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'directory' : 'other', uid: st.uid, mode: st.mode & 0o7777 };
  };
  return {
    lstat: get, realpath: file => fs.realpathSync(file), readFile: file => fs.readFileSync(file, 'utf8'),
    readLink: file => fs.readlinkSync(file),
    list: directory => fs.readdirSync(directory),
    readPrefix(file, bytes) { const fd = fs.openSync(file, 'r'); try { const buffer = Buffer.alloc(bytes); const count = fs.readSync(fd, buffer, 0, bytes, 0); return buffer.subarray(0, count); } finally { fs.closeSync(fd); } },
    mkdir(file, mode) { fs.mkdirSync(file, { mode }); },
    writeFile(file, contents, mode, exclusive = false) { fs.writeFileSync(file, contents, { encoding: 'utf8', mode, flag: exclusive ? 'wx' : 'w' }); },
    rename: (from, to) => fs.renameSync(from, to), unlink: file => fs.unlinkSync(file), rmdir: file => fs.rmdirSync(file),
    symlink: (target, link) => fs.symlinkSync(target, link), chmod: (file, mode) => fs.chmodSync(file, mode),
    syncFile(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
    syncDirectory(file) { const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
  };
}

function commandResult(args: readonly string[]): LinuxRuntimeCommandResult {
  try {
    const stdout = childProcess.execFileSync('/usr/bin/systemctl', ['--user', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL', maxBuffer: MAX_COMMAND_OUTPUT, env: process.env,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null; signal?: NodeJS.Signals | null; killed?: boolean; stdout?: Buffer | string; stderr?: Buffer | string };
    const timedOut = failure.code === 'ETIMEDOUT' || (failure.killed === true && failure.signal === 'SIGKILL');
    return {
      status: typeof failure.status === 'number' ? failure.status : timedOut ? 124 : 127,
      stdout: Buffer.isBuffer(failure.stdout) ? failure.stdout.toString('utf8') : String(failure.stdout ?? ''),
      stderr: Buffer.isBuffer(failure.stderr) ? failure.stderr.toString('utf8') : String(failure.stderr ?? ''),
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

function parseManagerState(unitName: string, executable: string, daemonEntry: string, command: (args: readonly string[]) => LinuxRuntimeCommandResult): LinuxRuntimeSystemd {
  const observation = (): LinuxSystemdUnitObservation | null => {
    const fragment = command(['show', '--property=FragmentPath', '--value', unitName]);
    if (fragment.timedOut) throw new RuntimeRefusal('service-state');
    const fragmentPath = fragment.stdout.trim();
    if (fragment.status !== 0) {
      const enabled = state('is-enabled');
      const active = state('is-active');
      if (enabled === 'not-found' && active === 'not-found' && fragment.status === 1) return null;
      throw new RuntimeRefusal('service-state');
    }
    if (!fragmentPath) return null;
    const exec = command(['show', '--property=ExecStart', '--value', unitName]);
    const dropins = command(['show', '--property=DropInPaths', '--value', unitName]);
    const reload = command(['show', '--property=NeedDaemonReload', '--value', unitName]);
    if ([exec, dropins, reload].some(r => r.timedOut || r.status !== 0)) throw new RuntimeRefusal('service-state');
    const prefix = `{ path=${executable} ; argv[]=${executable} ${daemonEntry} ; ignore_errors=no ; start_time=`;
    const suffix = exec.stdout.trim().slice(prefix.length);
    const exactAction = exec.stdout.trim().startsWith(prefix) && /^\[.*\] ; stop_time=\[.*\] ; pid=[0-9]+ ; code=\([^)]*\) ; status=[0-9]+\/[0-9]+ \}$/u.test(suffix);
    const dropInPaths = dropins.stdout.trim() === '' ? [] : ['present'];
    return {
      fragmentPath, execStartArgv: exactAction ? [executable, daemonEntry] : ['unrecognized-action'],
      dropInPaths, needDaemonReload: reload.stdout.trim() === 'yes' || reload.stdout.trim() === 'no' ? reload.stdout.trim() as 'yes' | 'no' : null,
    };
  };
  const state = (name: 'is-enabled' | 'is-active') => {
    const result = command([name, unitName]);
    if (result.timedOut || result.status > 4) return 'unknown';
    const value = result.stdout.trim();
    if (name === 'is-enabled') {
      if (['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias'].includes(value)) return 'enabled';
      if (value === 'disabled') return 'disabled';
      if (value === 'not-found') return 'not-found';
      if (value === 'masked') return 'masked';
      if (value === 'static') return 'static';
      return 'unknown';
    }
    if (value === 'active') return 'active';
    if (value === 'inactive') return 'inactive';
    if (value === 'failed') return 'failed';
    if (value === 'not-found') return 'not-found';
    return 'unknown';
  };
  return {
    command,
    state: name => ({ enabled: state('is-enabled') as ReturnType<LinuxRuntimeSystemd['state']>['enabled'], active: state('is-active') as ReturnType<LinuxRuntimeSystemd['state']>['active'] }),
    observation: () => observation(),
  };
}

export function createNodeLinuxServiceRuntimeHost(expectedAppRoot?: string, expectedEntryPath?: string): LinuxServiceRuntimeHost {
  const runtimePath = fs.realpathSync(process.execPath);
  const packageRoot = path.posix.dirname(runtimePath);
  const appRoot = path.posix.join(packageRoot, 'resources', 'app');
  const entryPath = expectedEntryPath ? fs.realpathSync(expectedEntryPath) : path.posix.join(appRoot, 'dist/tray/main.js');
  if ((expectedAppRoot && fs.realpathSync(expectedAppRoot) !== appRoot) || entryPath !== path.posix.join(appRoot, 'dist/tray/main.js')) {
    throw new RuntimeRefusal('package-identity');
  }
  const filesystem = createNodeFileSystem();
  const systemd = parseManagerState(LINUX_TOKENELO_UNIT_NAME, runtimePath,
    path.posix.join(appRoot, LINUX_TOKENELO_PACKAGE_CONTRACT.daemonEntry), commandResult);
  const environment = { ...process.env };
  const uid = process.getuid?.() ?? -1;
  const home = os.userInfo().homedir;
  return {
    platform: process.platform, uid, home, environment, runtimePath, entryPath, appRoot, packageRoot, fs: filesystem, systemd,
    collectEvidence() {
      const daemonEntry = path.posix.join(appRoot, LINUX_TOKENELO_PACKAGE_CONTRACT.daemonEntry);
      const configHome = environment.XDG_CONFIG_HOME || path.posix.join(home, '.config');
      const dataHome = environment.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
      const stateHome = environment.XDG_STATE_HOME || path.posix.join(home, '.local', 'state');
      const unitPath = path.posix.join(configHome, 'systemd', 'user', LINUX_TOKENELO_UNIT_NAME);
      const autoPath = path.posix.join(configHome, 'autostart', LINUX_TOKENELO_AUTOSTART_NAME);
      const linkPath = path.posix.join(configHome, 'systemd', 'user', 'default.target.wants', LINUX_TOKENELO_UNIT_NAME);
      const packageJsonPath = path.posix.join(appRoot, 'package.json');
      const packageJsonContents = filesystem.readFile(packageJsonPath);
      const sandboxPath = path.posix.join(packageRoot, LINUX_TOKENELO_PACKAGE_CONTRACT.sandboxEntry);
      const sandboxIdentity = filesystem.lstat(sandboxPath);
      const sandboxCapability = sandboxIdentity?.uid === 0 && (sandboxIdentity.mode & 0o7777) === 0o4755
        ? 'setuid-helper' as const
        : sandboxIdentity?.uid === uid && (sandboxIdentity.mode & 0o7777) === 0o755 ? 'user-namespace' as const : 'unknown' as const;
      const enablementId = filesystem.lstat(linkPath);
      return {
        platform: process.platform, uid, runtimeHome: home, accountHome: os.userInfo().homedir,
        homeEnvironment: environment.HOME, tokeneloHomeEnvironment: environment.TOKENELO_HOME,
        pathEnvironment: environment.PATH, configHomeEnvironment: environment.XDG_CONFIG_HOME,
        dataHomeEnvironment: environment.XDG_DATA_HOME, stateHomeEnvironment: environment.XDG_STATE_HOME,
        accountHomeIdentity: filesystem.lstat(home)!, configHomeIdentity: filesystem.lstat(configHome)!,
        dataHomeIdentity: filesystem.lstat(dataHome)!, stateHomeIdentity: filesystem.lstat(stateHome)!,
        systemEnvIdentity: filesystem.lstat('/usr/bin/env')!,
        package: {
          packageRoot: filesystem.lstat(packageRoot)!,
          resourcesDirectory: filesystem.lstat(path.posix.join(packageRoot, 'resources'))!,
          appDirectory: filesystem.lstat(appRoot)!,
          packageJson: { identity: filesystem.lstat(packageJsonPath)!, contents: packageJsonContents }, packageJsonContents,
          lifecycleEntry: filesystem.lstat(path.posix.join(appRoot, LINUX_TOKENELO_PACKAGE_CONTRACT.lifecycleEntry))!,
          daemonEntry: filesystem.lstat(daemonEntry)!,
          trayEntry: filesystem.lstat(path.posix.join(appRoot, LINUX_TOKENELO_PACKAGE_CONTRACT.trayEntry))!,
          executable: filesystem.lstat(runtimePath)!, executableFormat: filesystem.readPrefix(runtimePath, 4).toString('hex') === '7f454c46' ? 'ELF' : 'other',
          executableBasename: path.posix.basename(runtimePath), sandbox: sandboxIdentity!, sandboxCapability,
        },
        service: {
          unitFile: serviceObject(filesystem, unitPath, uid),
          trayAutostartFile: serviceObject(filesystem, autoPath, uid),
          enablementLink: enablementId ? {
            identity: enablementId,
            ...(enablementId.kind === 'symlink' ? { linkTarget: filesystem.readLink(linkPath) } : {}),
          } : null,
          manager: systemd.observation(LINUX_TOKENELO_UNIT_NAME, runtimePath, daemonEntry),
          ...systemd.state(LINUX_TOKENELO_UNIT_NAME),
        },
      };
    },
  };
}
