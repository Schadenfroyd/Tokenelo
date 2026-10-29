import crypto from 'node:crypto';
import path from 'node:path';
import {
  classifyMacLaunchAgentOwnership,
  serializeMacLaunchAgentPlist,
  type MacLaunchAgentExpectation,
  type MacLaunchAgentObservation,
  type MacLaunchAgentPolicy,
  type MacLaunchAgentDefinition,
} from './macos-launch-agent-policy.js';

export type MacLaunchAgentRole = 'daemon' | 'tray';
export type MacLaunchAgentOperation = 'install' | 'uninstall';

export interface MacLifecycleFileStatus {
  kind: 'file' | 'directory' | 'symlink' | 'other';
  uid: number;
  mode: number;
}

export interface MacLifecycleFileSystem {
  lstat(path: string): MacLifecycleFileStatus | null;
  realpath(path: string): string;
  readFile(path: string): string;
  writeFile(path: string, contents: string, mode: number, exclusive?: boolean): void;
  mkdir(path: string, mode: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
  syncFile(path: string): void;
  syncDirectory(path: string): void;
}

export interface MacLoadedLaunchAgent {
  plistPath: string;
  programArguments: readonly string[];
  workingDirectory: string;
  environmentVariables: Readonly<Record<string, string>>;
}

export interface MacLaunchctlBoundary {
  print(expectation: MacLaunchAgentExpectation): MacLoadedLaunchAgent | null;
  bootout(expectation: MacLaunchAgentExpectation): void;
  bootstrap(expectation: MacLaunchAgentExpectation): void;
}

export interface MacLaunchAgentLifecycleIO {
  fs: MacLifecycleFileSystem;
  launchctl: MacLaunchctlBoundary;
}

interface AgentSnapshot {
  role: MacLaunchAgentRole;
  expectation: MacLaunchAgentExpectation;
  exists: boolean;
  bytes: string | null;
  mode: number | null;
  loaded: boolean;
}

interface JournalEntry {
  role: MacLaunchAgentRole;
  plistPath: string;
  existedBefore: boolean;
  originalMode: number | null;
  originalSha256: string | null;
  candidateSha256: string;
  loadedBefore: boolean;
}

interface LifecycleJournal {
  schemaVersion: 1;
  operation: MacLaunchAgentOperation;
  uid: number;
  userHome: string;
  status: string;
  lastIntent: string | null;
  entries: JournalEntry[];
}

const FILE_MODE = 0o600;
const LOCK_NAME = '.tokenelo-launch-agent-transaction';

function roleExpectations(policy: MacLaunchAgentPolicy): readonly [
  { role: 'daemon'; expectation: MacLaunchAgentExpectation },
  { role: 'tray'; expectation: MacLaunchAgentExpectation },
] {
  return [
    { role: 'daemon', expectation: policy.daemon },
    { role: 'tray', expectation: policy.tray },
  ];
}

function roleDefinition(expectation: MacLaunchAgentExpectation): MacLaunchAgentDefinition {
  return expectation.definition;
}

function actionObservation(
  expectation: MacLaunchAgentExpectation,
  plistText: string,
  loaded: MacLoadedLaunchAgent | null,
): MacLaunchAgentObservation {
  const definition = roleDefinition(expectation);
  return {
    plistPath: expectation.plistPath,
    plistText,
    loadedPath: loaded?.plistPath ?? null,
    programArguments: loaded?.programArguments ?? definition.ProgramArguments,
    workingDirectory: loaded?.workingDirectory ?? definition.WorkingDirectory,
    environmentVariables: loaded?.environmentVariables ?? definition.EnvironmentVariables,
  };
}

function assertSafeDirectory(
  io: MacLaunchAgentLifecycleIO,
  directory: string,
  uid: number,
  label: string,
): void {
  const status = io.fs.lstat(directory);
  if (!status || status.kind !== 'directory' || status.uid !== uid ||
      (status.mode & 0o022) !== 0 || (status.mode & 0o300) !== 0o300) {
    throw new Error(`${label} must be current-user-owned, owner-writable/traversable, and not group/world writable`);
  }
  if (io.fs.realpath(directory) !== directory) {
    throw new Error(`${label} must already be a physical canonical path`);
  }
}

function ensureSafeDirectory(
  io: MacLaunchAgentLifecycleIO,
  directory: string,
  uid: number,
  label: string,
  create: boolean,
): boolean {
  if (io.fs.lstat(directory) === null) {
    if (!create) return false;
    const parent = path.posix.dirname(directory);
    assertSafeDirectory(io, parent, uid, `${label} parent`);
    io.fs.mkdir(directory, 0o700);
    const created = io.fs.lstat(directory);
    if (!created || created.kind !== 'directory' || created.uid !== uid ||
        (created.mode & 0o022) !== 0 || io.fs.realpath(directory) !== directory) {
      throw new Error(`${label} changed while it was being created`);
    }
    io.fs.chmod(directory, 0o700);
  }
  assertSafeDirectory(io, directory, uid, label);
  return true;
}

function ensureInstallDirectories(
  io: MacLaunchAgentLifecycleIO,
  policy: MacLaunchAgentPolicy,
  uid: number,
): void {
  const library = path.posix.join(policy.userHome, 'Library');
  assertSafeDirectory(io, library, uid, 'User Library directory');
  ensureSafeDirectory(
    io,
    path.posix.join(library, 'LaunchAgents'),
    uid,
    'LaunchAgents directory',
    true,
  );
  const logs = path.posix.join(library, 'Logs');
  ensureSafeDirectory(io, logs, uid, 'Logs directory', true);
  ensureSafeDirectory(io, path.posix.join(logs, 'Tokenelo'), uid, 'Tokenelo log directory', true);
}

function readSnapshot(
  io: MacLaunchAgentLifecycleIO,
  role: MacLaunchAgentRole,
  expectation: MacLaunchAgentExpectation,
  uid: number,
): AgentSnapshot {
  const status = io.fs.lstat(expectation.plistPath);
  const loaded = io.launchctl.print(expectation);
  if (status === null) {
    if (loaded !== null) {
      throw new Error(`${role} LaunchAgent is loaded without an inspectable package-owned plist`);
    }
    return { role, expectation, exists: false, bytes: null, mode: null, loaded: false };
  }
  if (status.kind !== 'file' || status.uid !== uid) {
    throw new Error(`${role} LaunchAgent plist is not a regular file owned by the current user`);
  }
  if ((status.mode & 0o777) !== FILE_MODE) {
    throw new Error(`${role} LaunchAgent plist permissions do not match the package-owned 0600 policy`);
  }
  const bytes = io.fs.readFile(expectation.plistPath);
  const ownership = classifyMacLaunchAgentOwnership(
    expectation,
    actionObservation(expectation, bytes, loaded),
  );
  if (ownership.state !== 'owned') {
    throw new Error(`${role} LaunchAgent ownership check failed: ${ownership.reason}`);
  }
  return {
    role,
    expectation,
    exists: true,
    bytes,
    mode: status.mode & 0o777,
    loaded: ownership.loaded,
  };
}

function sameSnapshot(actual: AgentSnapshot, expected: AgentSnapshot): boolean {
  return actual.role === expected.role && actual.exists === expected.exists &&
    actual.bytes === expected.bytes && actual.mode === expected.mode && actual.loaded === expected.loaded;
}

function assertSnapshotUnchanged(
  io: MacLaunchAgentLifecycleIO,
  expected: AgentSnapshot,
  uid: number,
): void {
  const actual = readSnapshot(io, expected.role, expected.expectation, uid);
  if (!sameSnapshot(actual, expected)) {
    throw new Error(`${expected.role} LaunchAgent changed after lifecycle preflight`);
  }
}

function assertNoLoadedAgent(io: MacLaunchAgentLifecycleIO, snapshot: AgentSnapshot): void {
  const loaded = io.launchctl.print(snapshot.expectation);
  if (loaded !== null) {
    throw new Error(`${snapshot.role} LaunchAgent remained loaded after exact-path bootout`);
  }
}

function assertLoadedAgent(io: MacLaunchAgentLifecycleIO, snapshot: AgentSnapshot): void {
  const loaded = io.launchctl.print(snapshot.expectation);
  if (loaded === null) {
    throw new Error(`${snapshot.role} LaunchAgent did not load`);
  }
  const candidate = serializeMacLaunchAgentPlist(snapshot.expectation.definition);
  const ownership = classifyMacLaunchAgentOwnership(snapshot.expectation, {
    plistPath: snapshot.expectation.plistPath,
    plistText: candidate,
    loadedPath: loaded.plistPath,
    programArguments: loaded.programArguments,
    workingDirectory: loaded.workingDirectory,
    environmentVariables: loaded.environmentVariables,
  });
  if (ownership.state !== 'owned' || !ownership.loaded) {
    throw new Error(`${snapshot.role} loaded action failed package ownership verification`);
  }
}

function expectedCurrentFile(
  io: MacLaunchAgentLifecycleIO,
  snapshot: AgentSnapshot,
  acceptedBytes: readonly string[],
  uid: number,
  allowMissing = false,
): string | null {
  const status = io.fs.lstat(snapshot.expectation.plistPath);
  if (status === null) {
    if (snapshot.exists && !allowMissing) {
      throw new Error(`${snapshot.role} LaunchAgent disappeared after lifecycle preflight`);
    }
    return null;
  }
  if (status.kind !== 'file' || status.uid !== uid || (status.mode & 0o777) !== FILE_MODE) {
    throw new Error(`${snapshot.role} LaunchAgent changed to a non-owned file during recovery`);
  }
  const contents = io.fs.readFile(snapshot.expectation.plistPath);
  if (!acceptedBytes.includes(contents)) {
    throw new Error(`${snapshot.role} LaunchAgent bytes changed during recovery; refusing to overwrite`);
  }
  return contents;
}

function assertCandidateFile(
  io: MacLaunchAgentLifecycleIO,
  candidatePath: string,
  snapshot: AgentSnapshot,
  expectedSha256: string,
  uid: number,
): string {
  const status = io.fs.lstat(candidatePath);
  if (!status || status.kind !== 'file' || status.uid !== uid || (status.mode & 0o777) !== FILE_MODE) {
    throw new Error(`${snapshot.role} staged plist candidate is missing or no longer private`);
  }
  const contents = io.fs.readFile(candidatePath);
  if (hashText(contents) !== expectedSha256 ||
      contents !== serializeMacLaunchAgentPlist(snapshot.expectation.definition)) {
    throw new Error(`${snapshot.role} staged plist candidate hash changed; refusing publication`);
  }
  return contents;
}

function assertPublishedCandidate(
  io: MacLaunchAgentLifecycleIO,
  snapshot: AgentSnapshot,
  expectedSha256: string,
  uid: number,
): void {
  const status = io.fs.lstat(snapshot.expectation.plistPath);
  if (!status || status.kind !== 'file' || status.uid !== uid || (status.mode & 0o777) !== FILE_MODE) {
    throw new Error(`${snapshot.role} published plist is missing or no longer private`);
  }
  const contents = io.fs.readFile(snapshot.expectation.plistPath);
  if (hashText(contents) !== expectedSha256 ||
      contents !== serializeMacLaunchAgentPlist(snapshot.expectation.definition)) {
    throw new Error(`${snapshot.role} published plist bytes changed; refusing lifecycle action`);
  }
}

function hashText(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function paths(lockPath: string, role: MacLaunchAgentRole) {
  return {
    backup: `${lockPath}/${role}.original.plist`,
    candidate: `${lockPath}/${role}.candidate.plist`,
  };
}

function journalEntry(journal: LifecycleJournal, role: MacLaunchAgentRole): JournalEntry {
  const entry = journal.entries.find(candidate => candidate.role === role);
  if (!entry) throw new Error(`${role} LaunchAgent recovery journal entry is missing`);
  return entry;
}

function writeJournal(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  journal: LifecycleJournal,
): void {
  const temporaryPath = `${lockPath}/journal.next`;
  const journalPath = `${lockPath}/journal.json`;
  const contents = JSON.stringify(journal, null, 2) + '\n';
  io.fs.writeFile(temporaryPath, contents, FILE_MODE, true);
  io.fs.syncFile(temporaryPath);
  io.fs.rename(temporaryPath, journalPath);
  io.fs.syncDirectory(lockPath);
}

function removeIfPresent(io: MacLaunchAgentLifecycleIO, path: string): void {
  if (io.fs.lstat(path) !== null) io.fs.unlink(path);
}

function cleanupTransaction(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
): void {
  for (const name of [
    'daemon.original.plist', 'daemon.candidate.plist',
    'daemon.restore.plist',
    'tray.original.plist', 'tray.candidate.plist',
    'tray.restore.plist',
    'journal.next', 'journal.json',
  ]) {
    removeIfPresent(io, `${lockPath}/${name}`);
  }
  io.fs.syncDirectory(lockPath);
  io.fs.rmdir(lockPath);
  const parent = lockPath.slice(0, lockPath.lastIndexOf('/')) || '/';
  io.fs.syncDirectory(parent);
}

function persistIntent(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  journal: LifecycleJournal,
  intent: string,
): void {
  journal.lastIntent = intent;
  journal.status = `intent:${intent}`;
  writeJournal(io, lockPath, journal);
}

function persistStatus(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  journal: LifecycleJournal,
  status: string,
): void {
  journal.lastIntent = null;
  journal.status = status;
  writeJournal(io, lockPath, journal);
}

function startTransaction(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  snapshots: readonly AgentSnapshot[],
  operation: MacLaunchAgentOperation,
  uid: number,
  policy: MacLaunchAgentPolicy,
): LifecycleJournal {
  const lockStatus = io.fs.lstat(lockPath);
  if (!lockStatus || lockStatus.kind !== 'directory' || lockStatus.uid !== uid ||
      (lockStatus.mode & 0o777) !== 0o700 || io.fs.realpath(lockPath) !== lockPath) {
    throw new Error('Could not establish the private macOS lifecycle recovery directory');
  }
  const journal: LifecycleJournal = {
    schemaVersion: 1,
    operation,
    uid,
    userHome: policy.userHome,
    status: 'preparing',
    lastIntent: null,
    entries: snapshots.map(snapshot => {
      const filePaths = paths(lockPath, snapshot.role);
      const candidate = serializeMacLaunchAgentPlist(snapshot.expectation.definition);
      if (snapshot.bytes !== null) {
        io.fs.writeFile(filePaths.backup, snapshot.bytes, FILE_MODE, true);
        io.fs.syncFile(filePaths.backup);
      }
      io.fs.writeFile(filePaths.candidate, candidate, FILE_MODE, true);
      io.fs.syncFile(filePaths.candidate);
      return {
        role: snapshot.role,
        plistPath: snapshot.expectation.plistPath,
        existedBefore: snapshot.exists,
        originalMode: snapshot.mode,
        originalSha256: snapshot.bytes === null ? null : hashText(snapshot.bytes),
        candidateSha256: hashText(candidate),
        loadedBefore: snapshot.loaded,
      };
    }),
  };
  writeJournal(io, lockPath, journal);
  io.fs.syncDirectory(lockPath);
  return journal;
}

function rollback(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  journal: LifecycleJournal,
  snapshots: readonly AgentSnapshot[],
  uid: number,
): void {
  journal.status = 'rollback-started';
  journal.lastIntent = null;
  writeJournal(io, lockPath, journal);

  for (const snapshot of snapshots) {
    const loaded = io.launchctl.print(snapshot.expectation);
    if (loaded !== null) {
      const current = io.fs.lstat(snapshot.expectation.plistPath);
      if (loaded.plistPath !== snapshot.expectation.plistPath ||
        !current || current.kind !== 'file' || current.uid !== uid ||
        (current.mode & 0o777) !== FILE_MODE) {
        throw new Error(`${snapshot.role} loaded state is no longer provably package-owned`);
      }
      const currentBytes = io.fs.readFile(snapshot.expectation.plistPath);
      const candidate = serializeMacLaunchAgentPlist(snapshot.expectation.definition);
      if (currentBytes !== candidate && currentBytes !== snapshot.bytes) {
        throw new Error(`${snapshot.role} loaded bytes are foreign; rollback retained its recovery files`);
      }
      const observed = classifyMacLaunchAgentOwnership(snapshot.expectation, {
        plistPath: snapshot.expectation.plistPath,
        plistText: currentBytes,
        loadedPath: loaded.plistPath,
        programArguments: loaded.programArguments,
        workingDirectory: loaded.workingDirectory,
        environmentVariables: loaded.environmentVariables,
      });
      if (observed.state !== 'owned' || !observed.loaded) {
        throw new Error(`${snapshot.role} loaded action is foreign; rollback retained its recovery files`);
      }
      journal.lastIntent = `rollback-bootout-${snapshot.role}`;
      journal.status = `intent:${journal.lastIntent}`;
      writeJournal(io, lockPath, journal);
      const currentBeforeBootout = io.launchctl.print(snapshot.expectation);
      if (!currentBeforeBootout || currentBeforeBootout.plistPath !== snapshot.expectation.plistPath) {
        throw new Error(`${snapshot.role} loaded state changed before rollback bootout`);
      }
      const currentBytesBeforeBootout = expectedCurrentFile(io, snapshot, [
        serializeMacLaunchAgentPlist(snapshot.expectation.definition),
        ...(snapshot.bytes === null ? [] : [snapshot.bytes]),
      ], uid);
      if (currentBytesBeforeBootout === null) {
        throw new Error(`${snapshot.role} loaded agent has no current plist before rollback bootout`);
      }
      const currentOwnership = classifyMacLaunchAgentOwnership(snapshot.expectation, {
        plistPath: snapshot.expectation.plistPath,
        plistText: currentBytesBeforeBootout,
        loadedPath: currentBeforeBootout.plistPath,
        programArguments: currentBeforeBootout.programArguments,
        workingDirectory: currentBeforeBootout.workingDirectory,
        environmentVariables: currentBeforeBootout.environmentVariables,
      });
      if (currentOwnership.state !== 'owned' || !currentOwnership.loaded) {
        throw new Error(`${snapshot.role} loaded action changed before rollback bootout`);
      }
      io.launchctl.bootout(snapshot.expectation);
      assertNoLoadedAgent(io, snapshot);
      journal.lastIntent = null;
      journal.status = `rollback-unloaded-${snapshot.role}`;
      writeJournal(io, lockPath, journal);
    }
  }

  for (const snapshot of snapshots) {
    const files = paths(lockPath, snapshot.role);
    const candidate = serializeMacLaunchAgentPlist(snapshot.expectation.definition);
    expectedCurrentFile(io, snapshot, [candidate, ...(snapshot.bytes === null ? [] : [snapshot.bytes])], uid, true);
    if (snapshot.bytes === null) {
      journal.lastIntent = `rollback-remove-${snapshot.role}`;
      journal.status = `intent:${journal.lastIntent}`;
      writeJournal(io, lockPath, journal);
      assertNoLoadedAgent(io, snapshot);
      expectedCurrentFile(io, snapshot, [candidate], uid);
      removeIfPresent(io, snapshot.expectation.plistPath);
    } else {
      const backupStatus = io.fs.lstat(files.backup);
      if (!backupStatus || backupStatus.kind !== 'file' || backupStatus.uid !== uid) {
        throw new Error(`${snapshot.role} original plist backup is unavailable; rollback retained its recovery files`);
      }
      const backup = io.fs.readFile(files.backup);
      if (backup !== snapshot.bytes) throw new Error(`${snapshot.role} original plist backup bytes do not match the journal snapshot`);
      const restorePath = `${lockPath}/${snapshot.role}.restore.plist`;
      io.fs.writeFile(restorePath, backup, snapshot.mode ?? FILE_MODE, true);
      io.fs.syncFile(restorePath);
      // The same-user transaction lock coordinates the packaged and updated legacy helpers.
      // The Node pathname API cannot atomically bind this check to rename against an arbitrary
      // same-uid writer; that stronger hostile-writer guarantee is not claimed.
      assertNoLoadedAgent(io, snapshot);
      expectedCurrentFile(io, snapshot, [candidate, snapshot.bytes], uid, true);
      io.fs.rename(restorePath, snapshot.expectation.plistPath);
      io.fs.chmod(snapshot.expectation.plistPath, snapshot.mode ?? FILE_MODE);
      const restoredStatus = io.fs.lstat(snapshot.expectation.plistPath);
      if (!restoredStatus || restoredStatus.kind !== 'file' || restoredStatus.uid !== uid ||
          (restoredStatus.mode & 0o777) !== snapshot.mode || io.fs.readFile(snapshot.expectation.plistPath) !== snapshot.bytes) {
        throw new Error(`${snapshot.role} restored plist bytes or mode changed during rollback`);
      }
    }
    io.fs.syncDirectory(lockPath);
    io.fs.syncDirectory(snapshot.expectation.plistPath.slice(0, snapshot.expectation.plistPath.lastIndexOf('/')));
  }

  for (const snapshot of snapshots) {
    if (snapshot.loaded) {
      journal.lastIntent = `rollback-bootstrap-${snapshot.role}`;
      journal.status = `intent:${journal.lastIntent}`;
      writeJournal(io, lockPath, journal);
      if (snapshot.bytes === null) {
        throw new Error(`${snapshot.role} prior loaded state has no original plist to restore`);
      }
      assertNoLoadedAgent(io, snapshot);
      expectedCurrentFile(io, snapshot, [snapshot.bytes], uid);
      io.launchctl.bootstrap(snapshot.expectation);
      assertLoadedAgent(io, snapshot);
    } else {
      assertNoLoadedAgent(io, snapshot);
    }
    const restored = readSnapshot(io, snapshot.role, snapshot.expectation, uid);
    if (!sameSnapshot(restored, snapshot)) {
      throw new Error(`${snapshot.role} prior state did not verify after rollback`);
    }
  }

  journal.lastIntent = null;
  journal.status = 'rollback-verified';
  writeJournal(io, lockPath, journal);
}

function performInstall(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  journal: LifecycleJournal,
  snapshots: readonly AgentSnapshot[],
  uid: number,
): void {
  for (const snapshot of snapshots) {
    assertSnapshotUnchanged(io, snapshot, uid);
    if (snapshot.loaded) {
      persistIntent(io, lockPath, journal, `bootout-${snapshot.role}`);
      assertSnapshotUnchanged(io, snapshot, uid);
      io.launchctl.bootout(snapshot.expectation);
      assertNoLoadedAgent(io, snapshot);
      persistStatus(io, lockPath, journal, `unloaded-${snapshot.role}`);
    }
  }

  for (const snapshot of snapshots) {
    const entry = journalEntry(journal, snapshot.role);
    const candidatePath = paths(lockPath, snapshot.role).candidate;
    persistIntent(io, lockPath, journal, `publish-${snapshot.role}`);
    assertNoLoadedAgent(io, snapshot);
    expectedCurrentFile(io, snapshot, snapshot.bytes === null ? [] : [snapshot.bytes], uid);
    assertCandidateFile(io, candidatePath, snapshot, entry.candidateSha256, uid);
    // The shared mkdir lock excludes cooperating helper modes. A path-based check followed by
    // rename still cannot defeat a hostile arbitrary same-uid writer between those syscalls.
    io.fs.rename(candidatePath, snapshot.expectation.plistPath);
    io.fs.chmod(snapshot.expectation.plistPath, FILE_MODE);
    assertPublishedCandidate(io, snapshot, entry.candidateSha256, uid);
    io.fs.syncDirectory(lockPath);
    io.fs.syncDirectory(snapshot.expectation.plistPath.slice(0, snapshot.expectation.plistPath.lastIndexOf('/')));
    persistStatus(io, lockPath, journal, `published-${snapshot.role}`);
  }

  for (const snapshot of snapshots) {
    const entry = journalEntry(journal, snapshot.role);
    persistIntent(io, lockPath, journal, `bootstrap-${snapshot.role}`);
    assertNoLoadedAgent(io, snapshot);
    assertPublishedCandidate(io, snapshot, entry.candidateSha256, uid);
    io.launchctl.bootstrap(snapshot.expectation);
    assertLoadedAgent(io, snapshot);
    persistStatus(io, lockPath, journal, `loaded-${snapshot.role}`);
  }

  for (const snapshot of snapshots) {
    assertPublishedCandidate(io, snapshot, journalEntry(journal, snapshot.role).candidateSha256, uid);
    assertLoadedAgent(io, snapshot);
  }
}

function performUninstall(
  io: MacLaunchAgentLifecycleIO,
  lockPath: string,
  journal: LifecycleJournal,
  snapshots: readonly AgentSnapshot[],
  uid: number,
): void {
  for (const snapshot of snapshots) {
    assertSnapshotUnchanged(io, snapshot, uid);
    if (snapshot.loaded) {
      persistIntent(io, lockPath, journal, `bootout-${snapshot.role}`);
      assertSnapshotUnchanged(io, snapshot, uid);
      io.launchctl.bootout(snapshot.expectation);
      assertNoLoadedAgent(io, snapshot);
      persistStatus(io, lockPath, journal, `unloaded-${snapshot.role}`);
    }
  }

  for (const snapshot of snapshots) {
    assertNoLoadedAgent(io, snapshot);
    if (snapshot.exists) {
      persistIntent(io, lockPath, journal, `remove-${snapshot.role}`);
      assertNoLoadedAgent(io, snapshot);
      expectedCurrentFile(io, snapshot, snapshot.bytes === null ? [] : [snapshot.bytes], uid);
      io.fs.unlink(snapshot.expectation.plistPath);
      io.fs.syncDirectory(snapshot.expectation.plistPath.slice(0, snapshot.expectation.plistPath.lastIndexOf('/')));
      persistStatus(io, lockPath, journal, `removed-${snapshot.role}`);
    }
  }

  for (const snapshot of snapshots) {
    if (io.fs.lstat(snapshot.expectation.plistPath) !== null) {
      throw new Error(`${snapshot.role} plist remains after uninstall`);
    }
    assertNoLoadedAgent(io, snapshot);
  }
}

export function runMacLaunchAgentLifecycle(
  policy: MacLaunchAgentPolicy,
  operation: MacLaunchAgentOperation,
  uid: number,
  io: MacLaunchAgentLifecycleIO,
): { operation: MacLaunchAgentOperation; recoveryPath?: string } {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('macOS LaunchAgent lifecycle requires a non-root user');
  const libraryDirectory = path.posix.join(policy.userHome, 'Library');
  assertSafeDirectory(io, libraryDirectory, uid, 'User Library directory');
  const plistDirectory = policy.daemon.plistPath.slice(0, policy.daemon.plistPath.lastIndexOf('/'));
  const lockPath = `${libraryDirectory}/${LOCK_NAME}`;
  if (io.fs.lstat(lockPath) !== null) {
    throw new Error(`A previous or concurrent macOS LaunchAgent transaction owns ${lockPath}; recovery files were left untouched`);
  }

  let journal: LifecycleJournal | null = null;
  let lockCreated = false;
  let recoveryPath: string | undefined;
  const snapshots: AgentSnapshot[] = [];
  try {
    io.fs.mkdir(lockPath, 0o700);
    lockCreated = true;
    const createdLock = io.fs.lstat(lockPath);
    if (!createdLock || createdLock.kind !== 'directory' || createdLock.uid !== uid ||
        (createdLock.mode & 0o022) !== 0 ||
        io.fs.realpath(lockPath) !== lockPath) {
      throw new Error('Lifecycle transaction lock changed while it was being created');
    }
    io.fs.chmod(lockPath, 0o700);
    assertSafeDirectory(io, lockPath, uid, 'Lifecycle transaction lock');
    io.fs.syncDirectory(libraryDirectory);
    if (operation === 'install') {
      ensureInstallDirectories(io, policy, uid);
    } else if (io.fs.lstat(plistDirectory) !== null) {
      assertSafeDirectory(io, plistDirectory, uid, 'LaunchAgents directory');
    }
    for (const { role, expectation } of roleExpectations(policy)) {
      snapshots.push(readSnapshot(io, role, expectation, uid));
    }
    if (operation === 'uninstall' && snapshots.every(snapshot => !snapshot.exists && !snapshot.loaded)) {
      cleanupTransaction(io, lockPath);
      lockCreated = false;
      return { operation };
    }
    journal = startTransaction(io, lockPath, snapshots, operation, uid, policy);
    if (operation === 'install') performInstall(io, lockPath, journal, snapshots, uid);
    else performUninstall(io, lockPath, journal, snapshots, uid);
    persistStatus(io, lockPath, journal, 'committed');
    try {
      cleanupTransaction(io, lockPath);
    } catch {
      recoveryPath = lockPath;
    }
    lockCreated = false;
    return { operation, ...(recoveryPath === undefined ? {} : { recoveryPath }) };
  } catch (error) {
    if (!lockCreated) {
      throw error;
    }
    if (journal === null) {
      try {
        cleanupTransaction(io, lockPath);
        lockCreated = false;
      } catch {
        recoveryPath = io.fs.lstat(lockPath) === null ? undefined : lockPath;
      }
      if (recoveryPath) throw new Error(`${(error as Error).message}; staged recovery files retained at ${recoveryPath}`);
      throw error;
    }
    try {
      rollback(io, lockPath, journal!, snapshots, uid);
      try {
        cleanupTransaction(io, lockPath);
        lockCreated = false;
      } catch {
        recoveryPath = io.fs.lstat(lockPath) === null ? undefined : lockPath;
      }
    } catch (rollbackError) {
      recoveryPath = lockPath;
      throw new Error(`${(error as Error).message}; rollback incomplete: ${(rollbackError as Error).message}; recovery files retained at ${recoveryPath}`);
    }
    throw new Error(`${(error as Error).message}; prior LaunchAgent state was restored and verified` +
      (recoveryPath === undefined ? '' : `; recovery files retained at ${recoveryPath}`));
  }
}
