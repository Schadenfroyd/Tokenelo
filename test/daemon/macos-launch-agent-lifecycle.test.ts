import { describe, expect, it } from 'vitest';
import {
  MACOS_TOKENELO_LABELS,
  createMacLaunchAgentPolicy,
  serializeMacLaunchAgentPlist,
  type MacLaunchAgentExpectation,
  type MacLaunchAgentPolicy,
} from '../../src/tray/macos-launch-agent-policy.js';
import {
  runMacLaunchAgentLifecycle,
  type MacLaunchAgentLifecycleIO,
  type MacLaunchAgentRole,
  type MacLoadedLaunchAgent,
  type MacLifecycleFileStatus,
  type MacLifecycleFileSystem,
} from '../../src/tray/macos-launch-agent-lifecycle.js';
import {
  parseLaunchctlPrint,
  runMacPackagedLaunchAgentLifecycle,
  type MacPackagedRuntimeHost,
} from '../../src/tray/macos-launch-agent-runtime.js';

const UID = 501;
const APP = '/Applications/Apps & Tools/Tokenelo.app';
const ROOT = `${APP}/Contents/Resources/app`;
const HOME = '/Users/example';
const LIBRARY = `${HOME}/Library`;
const LAUNCH_AGENTS = `${HOME}/Library/LaunchAgents`;
const TRANSACTION = `${LIBRARY}/.tokenelo-launch-agent-transaction`;
const MARKER = `${HOME}/Library/Application Support/Tokenelo/keep-me.json`;

interface FileItem { contents: string; uid: number; mode: number }

class FakeFileSystem implements MacLifecycleFileSystem {
  readonly directories = new Map<string, { uid: number; mode: number }>();
  readonly files = new Map<string, FileItem>();
  readonly symlinks = new Map<string, string>();
  readonly physicalAliases = new Map<string, string>();
  beforeRename: ((from: string, to: string) => void) | null = null;
  afterDirectorySync: ((directory: string) => void) | null = null;

  constructor() {
    for (const directory of [
      '/', '/Applications', '/Applications/Apps & Tools', APP,
      `${APP}/Contents`, `${APP}/Contents/MacOS`, `${APP}/Contents/Resources`, ROOT,
      `${ROOT}/dist`, `${ROOT}/dist/daemon`, `${ROOT}/dist/tray`, `${ROOT}/scripts`,
      '/Users', HOME, `${HOME}/Library`, LAUNCH_AGENTS,
      `${HOME}/Library/Application Support`, `${HOME}/Library/Application Support/Tokenelo`,
    ]) this.directories.set(directory, { uid: UID, mode: directory === LAUNCH_AGENTS ? 0o755 : 0o755 });
  }

  lstat(value: string): MacLifecycleFileStatus | null {
    if (this.symlinks.has(value)) return { kind: 'symlink', uid: UID, mode: 0o777 };
    const file = this.files.get(value);
    if (file) return { kind: 'file', uid: file.uid, mode: file.mode };
    const directory = this.directories.get(value);
    if (directory) return { kind: 'directory', ...directory };
    return null;
  }

  realpath(value: string): string { return this.symlinks.get(value) ?? this.physicalAliases.get(value) ?? value; }

  readFile(value: string): string {
    const file = this.files.get(value);
    if (!file) throw new Error(`ENOENT: ${value}`);
    return file.contents;
  }

  writeFile(value: string, contents: string, mode: number, exclusive = false): void {
    if (exclusive && (this.files.has(value) || this.directories.has(value) || this.symlinks.has(value))) {
      throw new Error(`EEXIST: ${value}`);
    }
    if (!this.directories.has(value.slice(0, value.lastIndexOf('/')))) throw new Error(`ENOENT parent: ${value}`);
    this.files.set(value, { contents, uid: UID, mode: mode & 0o777 });
  }

  mkdir(value: string, mode: number): void {
    if (this.lstat(value)) throw new Error(`EEXIST: ${value}`);
    if (!this.directories.has(value.slice(0, value.lastIndexOf('/')))) throw new Error(`ENOENT parent: ${value}`);
    this.directories.set(value, { uid: UID, mode: mode & 0o777 });
  }

  rename(from: string, to: string): void {
    this.beforeRename?.(from, to);
    const file = this.files.get(from);
    if (!file) throw new Error(`ENOENT: ${from}`);
    if (this.directories.has(to)) throw new Error(`EISDIR: ${to}`);
    if (!this.directories.has(to.slice(0, to.lastIndexOf('/')))) throw new Error(`ENOENT parent: ${to}`);
    this.files.set(to, file);
    this.files.delete(from);
  }

  unlink(value: string): void {
    if (this.symlinks.delete(value)) return;
    if (!this.files.delete(value)) throw new Error(`ENOENT: ${value}`);
  }

  rmdir(value: string): void {
    if ([...this.files.keys()].some(file => file.startsWith(value + '/')) ||
        [...this.directories.keys()].some(directory => directory !== value && directory.startsWith(value + '/'))) {
      throw new Error(`ENOTEMPTY: ${value}`);
    }
    if (!this.directories.delete(value)) throw new Error(`ENOENT: ${value}`);
  }

  chmod(value: string, mode: number): void {
    const file = this.files.get(value);
    if (file) {
      file.mode = mode & 0o777;
      return;
    }
    const directory = this.directories.get(value);
    if (!directory) throw new Error(`ENOENT: ${value}`);
    directory.mode = mode & 0o777;
  }

  syncFile(_value: string): void {}
  syncDirectory(value: string): void { this.afterDirectorySync?.(value); }
}

function makePolicy(tokeneloHome?: string): MacLaunchAgentPolicy {
  const metadata = {
    appBundlePath: APP,
    bundleIdentifier: 'com.elostudios.tokenelo',
    bundleExecutable: 'Tokenelo',
    executablePath: `${APP}/Contents/MacOS/Tokenelo`,
    executablePresent: true,
    executableIsExecutable: true,
    resourcesAppPath: ROOT,
    packageName: 'tokenelo',
    packagePrivate: true,
    packageType: 'module',
    packageMain: 'dist/tray/main.js',
    daemonEntryPath: `${ROOT}/dist/daemon/main.js`,
    daemonEntryPresent: true,
    trayEntryPath: `${ROOT}/dist/tray/main.js`,
    trayEntryPresent: true,
    helperPath: `${ROOT}/scripts/install-service-macos.sh`,
    helperPresent: true,
  };
  return createMacLaunchAgentPolicy({
    appMetadata: metadata,
    userHome: HOME,
    ...(tokeneloHome === undefined ? {} : { tokeneloHome }),
  });
}

class FakeLaunchctl {
  readonly calls: string[] = [];
  readonly loaded = new Map<MacLaunchAgentRole, MacLoadedLaunchAgent>();
  readonly failures = new Map<string, number>();
  readonly overrides = new Map<MacLaunchAgentRole, MacLoadedLaunchAgent>();
  readonly stuckBootout = new Set<MacLaunchAgentRole>();
  beforeMutation: (() => void) | null = null;

  constructor(readonly policy: MacLaunchAgentPolicy) {}

  private shouldFail(key: string): boolean {
    const remaining = this.failures.get(key) ?? 0;
    if (remaining <= 0) return false;
    this.failures.set(key, remaining - 1);
    return true;
  }

  print(expectation: MacLaunchAgentExpectation): MacLoadedLaunchAgent | null {
    const role = expectation.definition.Label === MACOS_TOKENELO_LABELS.daemon ? 'daemon' : 'tray';
    return this.overrides.get(role) ?? this.loaded.get(role) ?? null;
  }

  bootout(expectation: MacLaunchAgentExpectation): void {
    const role = expectation.definition.Label === MACOS_TOKENELO_LABELS.daemon ? 'daemon' : 'tray';
    if (this.calls.length === 0) this.beforeMutation?.();
    this.calls.push(`bootout:${role}:${expectation.plistPath}`);
    if (this.shouldFail(`bootout:${role}`)) throw new Error(`fake bootout failed: ${role}`);
    if (this.stuckBootout.has(role)) return;
    this.loaded.delete(role);
    this.overrides.delete(role);
  }

  bootstrap(expectation: MacLaunchAgentExpectation): void {
    const role = expectation.definition.Label === MACOS_TOKENELO_LABELS.daemon ? 'daemon' : 'tray';
    if (this.calls.length === 0) this.beforeMutation?.();
    this.calls.push(`bootstrap:${role}:${expectation.plistPath}`);
    if (this.shouldFail(`bootstrap:${role}`)) throw new Error(`fake bootstrap failed: ${role}`);
    const definition = expectation.definition;
    this.loaded.set(role, {
      plistPath: expectation.plistPath,
      programArguments: definition.ProgramArguments,
      workingDirectory: definition.WorkingDirectory,
      environmentVariables: definition.EnvironmentVariables,
    });
  }
}

function fixture(options: { tokeneloHome?: string; existing?: boolean; loaded?: boolean } = {}) {
  const policy = makePolicy(options.tokeneloHome);
  const fs = new FakeFileSystem();
  fs.files.set(MARKER, { contents: '{"keep":true}\n', uid: UID, mode: 0o600 });
  const launchctl = new FakeLaunchctl(policy);
  if (options.existing) {
    for (const [role, expectation] of [['daemon', policy.daemon], ['tray', policy.tray]] as const) {
      fs.files.set(expectation.plistPath, {
        contents: serializeMacLaunchAgentPlist(expectation.definition),
        uid: UID,
        mode: 0o600,
      });
      if (options.loaded) {
        const definition = expectation.definition;
        launchctl.loaded.set(role, {
          plistPath: expectation.plistPath,
          programArguments: definition.ProgramArguments,
          workingDirectory: definition.WorkingDirectory,
          environmentVariables: definition.EnvironmentVariables,
        });
      }
    }
  }
  const io: MacLaunchAgentLifecycleIO = { fs, launchctl };
  return { policy, fs, launchctl, io };
}

describe('macOS package-native LaunchAgent lifecycle transaction', () => {
  it('preflights and stages both roles, then atomically activates the exact daemon and tray actions', () => {
    const f = fixture({ tokeneloHome: '/Users/example/Tokenelo Data', existing: true, loaded: true });
    const beforeDaemon = f.fs.readFile(f.policy.daemon.plistPath);
    const beforeTray = f.fs.readFile(f.policy.tray.plistPath);
    f.launchctl.beforeMutation = () => {
      const lockPath = TRANSACTION;
      expect(f.fs.lstat(`${lockPath}/daemon.candidate.plist`)?.kind).toBe('file');
      expect(f.fs.lstat(`${lockPath}/tray.candidate.plist`)?.kind).toBe('file');
    };
    const result = runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io);

    expect(result).toEqual({ operation: 'install' });
    expect(f.launchctl.calls.map(call => call.split(':')[0] + ':' + call.split(':')[1]))
      .toEqual(['bootout:daemon', 'bootout:tray', 'bootstrap:daemon', 'bootstrap:tray']);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toBe(beforeDaemon);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe(beforeTray);
    expect(f.launchctl.loaded.size).toBe(2);
    expect(f.launchctl.loaded.get('daemon')?.environmentVariables.TOKENELO_HOME).toBe('/Users/example/Tokenelo Data');
    expect(f.launchctl.loaded.get('tray')?.environmentVariables).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(f.fs.readFile(MARKER)).toBe('{"keep":true}\n');
    expect(f.fs.lstat(TRANSACTION)).toBeNull();
  });

  it('creates missing LaunchAgents and log directories with private owned modes before install', () => {
    const f = fixture();
    f.fs.directories.delete(LAUNCH_AGENTS);

    expect(runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io)).toEqual({ operation: 'install' });
    for (const directory of [
      LAUNCH_AGENTS,
      `${LIBRARY}/Logs`,
      `${LIBRARY}/Logs/Tokenelo`,
    ]) {
      expect(f.fs.lstat(directory)).toEqual({ kind: 'directory', uid: UID, mode: 0o700 });
    }
    expect(f.fs.lstat(TRANSACTION)).toBeNull();
  });

  it('refuses unsafe LaunchAgents or log directories before launchctl or plist mutation', () => {
    for (const unsafe of [
      'launch-agents-symlink', 'log-parent-symlink', 'log-child-symlink', 'log-owner', 'log-writable',
    ]) {
      const f = fixture();
      if (unsafe === 'launch-agents-symlink') {
        f.fs.directories.delete(LAUNCH_AGENTS);
        f.fs.symlinks.set(LAUNCH_AGENTS, `${LIBRARY}/somewhere-else`);
      } else if (unsafe === 'log-parent-symlink') {
        f.fs.symlinks.set(`${LIBRARY}/Logs`, `${HOME}/somewhere-else`);
      } else if (unsafe === 'log-child-symlink') {
        f.fs.directories.set(`${LIBRARY}/Logs`, { uid: UID, mode: 0o755 });
        f.fs.symlinks.set(`${LIBRARY}/Logs/Tokenelo`, `${HOME}/somewhere-else`);
      } else if (unsafe === 'log-owner') {
        f.fs.directories.set(`${LIBRARY}/Logs`, { uid: UID + 1, mode: 0o700 });
      } else {
        f.fs.directories.set(`${LIBRARY}/Logs`, { uid: UID, mode: 0o775 });
      }

      expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io)).toThrow(/directory/);
      expect(f.launchctl.calls).toEqual([]);
      expect(f.fs.lstat(f.policy.daemon.plistPath)).toBeNull();
      expect(f.fs.readFile(MARKER)).toBe('{"keep":true}\n');
      expect(f.fs.lstat(TRANSACTION)).toBeNull();
    }
  });

  it('takes the shared transaction lock before reading either role', () => {
    const f = fixture({ existing: true, loaded: true });
    f.fs.directories.set(TRANSACTION, { uid: UID, mode: 0o700 });

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io)).toThrow(/previous or concurrent/);
    expect(f.launchctl.calls).toEqual([]);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toContain('<key>Label</key>');
    expect(f.fs.readFile(f.policy.tray.plistPath)).toContain('<key>Label</key>');
  });

  it('refuses a foreign role before bootout, publication, or sibling cleanup', () => {
    const f = fixture({ existing: true, loaded: true });
    f.fs.files.set(f.policy.tray.plistPath, { contents: '<plist>legacy checkout</plist>', uid: UID, mode: 0o600 });

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io)).toThrow(/ownership check failed/);
    expect(f.launchctl.calls).toEqual([]);
    expect(f.launchctl.loaded.size).toBe(2);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe('<plist>legacy checkout</plist>');
  });

  it('rejects a staged candidate whose bytes change before publication and restores prior state', () => {
    const f = fixture({ existing: true, loaded: true });
    const before = [f.fs.readFile(f.policy.daemon.plistPath), f.fs.readFile(f.policy.tray.plistPath)];
    const candidatePath = `${TRANSACTION}/daemon.candidate.plist`;
    f.launchctl.beforeMutation = () => {
      const staged = f.fs.files.get(candidatePath);
      if (!staged) throw new Error('expected daemon candidate to be staged before bootout');
      staged.contents += '<!-- tampered -->';
    };

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io)).toThrow(/candidate hash changed/);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toBe(before[0]);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe(before[1]);
    expect(f.launchctl.loaded.size).toBe(2);
    expect(f.fs.lstat(TRANSACTION)).toBeNull();
  });

  it('retains recovery files when role two changes after role one publishes and rollback reaches it', () => {
    const f = fixture({ existing: true, loaded: true });
    const daemonOriginal = f.fs.readFile(f.policy.daemon.plistPath);
    const foreignTray = '<plist>concurrent replacement</plist>';
    f.fs.beforeRename = from => {
      if (from === `${TRANSACTION}/daemon.candidate.plist`) {
        const tray = f.fs.files.get(f.policy.tray.plistPath);
        if (!tray) throw new Error('expected tray plist before daemon publication');
        tray.contents = foreignTray;
      }
    };

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io))
      .toThrow(/rollback incomplete:.*recovery files retained/);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toBe(daemonOriginal);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe(foreignTray);
    expect(f.fs.lstat(TRANSACTION)?.kind).toBe('directory');
    expect(f.fs.readFile(`${TRANSACTION}/journal.json`)).toContain('rollback-started');
    expect(f.fs.readFile(`${TRANSACTION}/tray.original.plist`)).toContain('<key>Label</key>');
    expect(f.launchctl.calls.some(call => call.startsWith('bootstrap:'))).toBe(false);
  });

  it('detects published bytes changed before bootstrap and retains an uncertain recovery journal', () => {
    const f = fixture();
    let tampered = false;
    f.fs.afterDirectorySync = directory => {
      if (directory !== LAUNCH_AGENTS || tampered) return;
      tampered = true;
      const published = f.fs.files.get(f.policy.daemon.plistPath);
      if (!published) throw new Error('expected daemon plist to be published before directory sync');
      published.contents += '<!-- changed after publish -->';
    };

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io))
      .toThrow(/rollback incomplete:.*recovery files retained/);
    expect(tampered).toBe(true);
    expect(f.launchctl.calls.some(call => call.startsWith('bootstrap:'))).toBe(false);
    expect(f.fs.lstat(TRANSACTION)?.kind).toBe('directory');
    expect(f.fs.readFile(`${TRANSACTION}/journal.json`)).toContain('rollback-started');
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toContain('changed after publish');
  });

  it('restores files and prior loaded states after a tray bootout failure', () => {
    const f = fixture({ existing: true, loaded: true });
    const before = [f.fs.readFile(f.policy.daemon.plistPath), f.fs.readFile(f.policy.tray.plistPath)];
    f.launchctl.failures.set('bootout:tray', 1);

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io))
      .toThrow(/prior LaunchAgent state was restored and verified/);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toBe(before[0]);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe(before[1]);
    expect(f.launchctl.loaded.size).toBe(2);
    expect(f.fs.lstat(TRANSACTION)).toBeNull();
  });

  it('compensates a partial bootstrap and restores both original loaded agents', () => {
    const f = fixture({ existing: true, loaded: true });
    const before = [f.fs.readFile(f.policy.daemon.plistPath), f.fs.readFile(f.policy.tray.plistPath)];
    f.launchctl.failures.set('bootstrap:tray', 1);

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io))
      .toThrow(/prior LaunchAgent state was restored and verified/);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toBe(before[0]);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe(before[1]);
    expect(f.launchctl.loaded.size).toBe(2);
    expect(f.launchctl.loaded.get('daemon')?.plistPath).toBe(f.policy.daemon.plistPath);
    expect(f.launchctl.loaded.get('tray')?.plistPath).toBe(f.policy.tray.plistPath);
  });

  it('retains the journal and byte backups when rollback cannot prove bootout cleanup', () => {
    const f = fixture({ existing: true });
    f.launchctl.failures.set('bootstrap:tray', 1);
    f.launchctl.failures.set('bootout:daemon', 1);

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io))
      .toThrow(/rollback incomplete:.*recovery files retained/);
    const lockPath = TRANSACTION;
    expect(f.fs.lstat(lockPath)?.kind).toBe('directory');
    expect(f.fs.readFile(`${lockPath}/journal.json`)).toContain('rollback-bootout-daemon');
    expect(f.fs.readFile(`${lockPath}/daemon.original.plist`)).toContain('<key>Label</key>');
  });

  it('uninstalls only exact owned plists and leaves user data untouched', () => {
    const f = fixture({ existing: true, loaded: true });
    const result = runMacLaunchAgentLifecycle(f.policy, 'uninstall', UID, f.io);

    expect(result).toEqual({ operation: 'uninstall' });
    expect(f.fs.lstat(f.policy.daemon.plistPath)).toBeNull();
    expect(f.fs.lstat(f.policy.tray.plistPath)).toBeNull();
    expect(f.launchctl.loaded.size).toBe(0);
    expect(f.fs.readFile(MARKER)).toBe('{"keep":true}\n');
  });

  it('restores an uninstall plist removed before a later directory-sync failure', () => {
    const f = fixture({ existing: true, loaded: true });
    const before = [f.fs.readFile(f.policy.daemon.plistPath), f.fs.readFile(f.policy.tray.plistPath)];
    let failOnce = true;
    f.fs.afterDirectorySync = directory => {
      if (directory === LAUNCH_AGENTS && failOnce) {
        failOnce = false;
        throw new Error('fake LaunchAgents directory sync failure');
      }
    };

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'uninstall', UID, f.io))
      .toThrow(/prior LaunchAgent state was restored and verified/);
    expect(f.fs.readFile(f.policy.daemon.plistPath)).toBe(before[0]);
    expect(f.fs.readFile(f.policy.tray.plistPath)).toBe(before[1]);
    expect(f.launchctl.loaded.size).toBe(2);
    expect(f.fs.lstat(TRANSACTION)).toBeNull();
  });

  it('refuses a loaded label whose plist path differs, without unloading by label', () => {
    const f = fixture({ existing: true, loaded: true });
    f.launchctl.overrides.set('daemon', {
      ...f.launchctl.loaded.get('daemon')!,
      plistPath: '/Users/example/checkout/LaunchAgents/co.eloai.tokenelo.daemon.plist',
    });

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'uninstall', UID, f.io)).toThrow(/loaded-path-mismatch/);
    expect(f.launchctl.calls).toEqual([]);
    expect(f.fs.lstat(f.policy.daemon.plistPath)?.kind).toBe('file');
  });

  it('keeps the OS registration and recovery journal when bootout reports success but the job remains loaded', () => {
    const f = fixture({ existing: true, loaded: true });
    f.launchctl.stuckBootout.add('daemon');

    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', UID, f.io))
      .toThrow(/rollback incomplete:.*recovery files retained/);
    expect(f.launchctl.loaded.has('daemon')).toBe(true);
    expect(f.fs.lstat(TRANSACTION)?.kind).toBe('directory');
  });

  it('rejects root before filesystem or launchctl activity', () => {
    const f = fixture();
    expect(() => runMacLaunchAgentLifecycle(f.policy, 'install', 0, f.io)).toThrow(/non-root user/);
    expect(f.launchctl.calls).toEqual([]);
    expect(f.fs.lstat(TRANSACTION)).toBeNull();
  });

  it('parses exact launchctl program, argv, working directory and environment fields', () => {
    const parsed = parseLaunchctlPrint([
      'gui/501/co.eloai.tokenelo.daemon = {',
      '  path = /Users/example/Library/LaunchAgents/co.eloai.tokenelo.daemon.plist',
      '  program = /Applications/Apps & Tools/Tokenelo.app/Contents/MacOS/Tokenelo',
      '  arguments = {',
      '    /Applications/Apps & Tools/Tokenelo.app/Contents/MacOS/Tokenelo',
      '    /Applications/Apps & Tools/Tokenelo.app/Contents/Resources/app/dist/daemon/main.js',
      '  }',
      '  working directory = /Applications/Apps & Tools/Tokenelo.app/Contents/Resources/app',
      '  environment = {',
      '    ELECTRON_RUN_AS_NODE => 1',
      '    PATH => /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
      '  }',
      '}',
    ].join('\n'));
    expect(parsed.plistPath).toBe('/Users/example/Library/LaunchAgents/co.eloai.tokenelo.daemon.plist');
    expect(parsed.programArguments).toEqual([
      '/Applications/Apps & Tools/Tokenelo.app/Contents/MacOS/Tokenelo',
      '/Applications/Apps & Tools/Tokenelo.app/Contents/Resources/app/dist/daemon/main.js',
    ]);
    expect(parsed.environmentVariables).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    });
  });

  it('fails closed on duplicate launchctl fields, nested unknown blocks, and extra service records', () => {
    const valid = [
      'gui/501/co.eloai.tokenelo.daemon = {',
      '  path = /Users/example/Library/LaunchAgents/co.eloai.tokenelo.daemon.plist',
      '  program = /Applications/Tokenelo.app/Contents/MacOS/Tokenelo',
      '  arguments = {',
      '    /Applications/Tokenelo.app/Contents/MacOS/Tokenelo',
      '    /Applications/Tokenelo.app/Contents/Resources/app/dist/daemon/main.js',
      '  }',
      '  working directory = /Applications/Tokenelo.app/Contents/Resources/app',
      '}',
    ].join('\n');
    const cases = [
      {
        output: valid.replace('  program =', '  path = /Users/example/contradictory.plist\n  program ='),
        message: /duplicate path fields/,
      },
      {
        output: valid.replace('  working directory =', '  mystery = {\n    value = unsafe\n  }\n  working directory ='),
        message: /unsupported nested mystery/,
      },
      {
        output: `${valid}\ngui/501/co.eloai.tokenelo.tray = {\n}`,
        message: /one fully closed service record/,
      },
      {
        output: valid.replace('  working directory =', '  arguments = {\n  }\n  working directory ='),
        message: /duplicate arguments fields/,
      },
      {
        output: valid.replace(
          '  arguments = {\n    /Applications/Tokenelo.app/Contents/MacOS/Tokenelo',
          '  arguments = {\n    /Applications/Other.app/Contents/MacOS/Other',
        ),
        message: /argv\[0\]/,
      },
      {
        output: valid.replace(
          '    /Applications/Tokenelo.app/Contents/MacOS/Tokenelo\n    /Applications/Tokenelo.app/Contents/Resources/app/dist/daemon/main.js',
          '',
        ),
        message: /argv\[0\]/,
      },
    ];
    for (const testCase of cases) expect(() => parseLaunchctlPrint(testCase.output)).toThrow(testCase.message);
    expect(() => parseLaunchctlPrint(valid, 'gui/502/co.eloai.tokenelo.daemon')).toThrow(/does not match the requested uid and label/);
  });
});

function bundleFileSystem(): FakeFileSystem {
  const fs = new FakeFileSystem();
  fs.files.set(MARKER, { contents: '{"keep":true}\n', uid: UID, mode: 0o600 });
  fs.files.set(`${APP}/Contents/Info.plist`, { contents: 'fixture plist', uid: UID, mode: 0o644 });
  fs.files.set(`${APP}/Contents/MacOS/Tokenelo`, { contents: 'fixture executable', uid: UID, mode: 0o755 });
  fs.files.set(`${ROOT}/package.json`, {
    contents: JSON.stringify({ name: 'tokenelo', private: true, type: 'module', main: 'dist/tray/main.js' }),
    uid: UID,
    mode: 0o644,
  });
  for (const file of [
    `${ROOT}/dist/daemon/main.js`,
    `${ROOT}/dist/tray/main.js`,
    `${ROOT}/dist/tray/macos-launch-agent-runtime.js`,
    `${ROOT}/scripts/install-service-macos.sh`,
  ]) fs.files.set(file, { contents: 'fixture', uid: UID, mode: 0o755 });
  return fs;
}

describe('macOS packaged runtime adapter physical preflight', () => {
  it('checks the physical caller, package metadata, current home and non-root identity before idempotent uninstall', () => {
    const fs = bundleFileSystem();
    const commandCalls: string[] = [];
    const commandTimeouts: number[] = [];
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin',
      uid: UID,
      home: HOME,
      accountHome: HOME,
      environment: { HOME },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`,
      fs,
      execFile(command, args, options) {
        commandCalls.push(`${command} ${args.join(' ')}`);
        commandTimeouts.push(options.timeoutMs);
        if (command === '/usr/bin/plutil' && args[0] === '-extract') {
          return { status: 0, stdout: args[1] === 'CFBundleExecutable' ? 'Tokenelo\n' : 'com.elostudios.tokenelo\n', stderr: '' };
        }
        if (command === '/bin/launchctl' && args[0] === 'print') {
          return { status: 113, stdout: '', stderr: 'Could not find service in domain' };
        }
        throw new Error(`unexpected command ${command}`);
      },
    };

    expect(runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    }, host)).toEqual({ operation: 'uninstall' });
    expect(commandCalls.some(call => call.includes('CFBundleExecutable'))).toBe(true);
    expect(commandCalls.some(call => call.includes('CFBundleIdentifier'))).toBe(true);
    expect(commandTimeouts.length).toBeGreaterThan(0);
    expect(commandTimeouts.every(timeout => timeout === 15_000)).toBe(true);
    expect(fs.lstat(TRANSACTION)).toBeNull();
  });

  it('rejects a caller-selected HOME that differs from the uid account database home', () => {
    const fs = bundleFileSystem();
    const selectedHome = `${HOME}/different-home`;
    fs.directories.set(selectedHome, { uid: UID, mode: 0o755 });
    const launchctlCalls: string[] = [];
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: selectedHome, accountHome: HOME,
      environment: { HOME: selectedHome },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile(command, args) {
        if (command === '/usr/bin/plutil' && args[0] === '-extract') {
          return { status: 0, stdout: args[1] === 'CFBundleExecutable' ? 'Tokenelo\n' : 'com.elostudios.tokenelo\n', stderr: '' };
        }
        if (command === '/bin/launchctl') launchctlCalls.push(args.join(' '));
        throw new Error(`unexpected command ${command}`);
      },
    };

    expect(() => runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    }, host)).toThrow(/uid account home/);
    expect(launchctlCalls).toEqual([]);
    expect(fs.lstat(TRANSACTION)).toBeNull();
  });

  it('resolves the nearest existing TOKENELO_HOME ancestor before checking app-bundle overlap', () => {
    const fs = bundleFileSystem();
    const alias = `${HOME}/bundle-link`;
    fs.symlinks.set(alias, APP);
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: HOME, accountHome: HOME,
      environment: { HOME, TOKENELO_HOME: `${alias}/mutable-data` },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile(_command, args) {
        return { status: 0, stdout: args[1] === 'CFBundleExecutable' ? 'Tokenelo\n' : 'com.elostudios.tokenelo\n', stderr: '' };
      },
    };

    expect(() => runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    }, host)).toThrow(/physical target must not overlap/);
    expect(fs.lstat(TRANSACTION)).toBeNull();
  });

  it('refuses a helper whose real path escapes the packaged bundle', () => {
    const fs = bundleFileSystem();
    fs.files.set(`${ROOT}/scripts/linked-helper.sh`, { contents: 'fixture', uid: UID, mode: 0o755 });
    fs.physicalAliases.set(`${ROOT}/scripts/linked-helper.sh`, '/Users/example/checkout/install-service-macos.sh');
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: HOME, accountHome: HOME, environment: { HOME },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile() { throw new Error('plutil must not run before helper path validation'); },
    };

    expect(() => runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/linked-helper.sh`,
      operation: 'uninstall',
    }, host)).toThrow(/physical canonical path/);
  });

  it('rejects a physical bundle or executable alias before changing LaunchAgents', () => {
    const fs = bundleFileSystem();
    fs.physicalAliases.set(APP, '/Applications/Other.app');
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: HOME, accountHome: HOME, environment: { HOME },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile() { throw new Error('metadata command must not run for a nonphysical app root'); },
    };
    expect(() => runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    }, host)).toThrow(/physical canonical path/);
    expect(fs.lstat(TRANSACTION)).toBeNull();
  });

  it('rejects an executable whose caller path resolves outside the physical bundle', () => {
    const fs = bundleFileSystem();
    fs.physicalAliases.set(`${APP}/Contents/MacOS/Tokenelo`, '/Applications/Other.app/Contents/MacOS/Tokenelo');
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: HOME, accountHome: HOME, environment: { HOME },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile(_command, args) {
        return {
          status: 0,
          stdout: args[1] === 'CFBundleExecutable' ? 'Tokenelo\n' : 'com.elostudios.tokenelo\n',
          stderr: '',
        };
      },
    };
    expect(() => runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    }, host)).toThrow(/physical canonical path/);
    expect(fs.lstat(TRANSACTION)).toBeNull();
  });

  it('keeps the registered TOKENELO_HOME when the helper inherits a different shell value', () => {
    const fs = bundleFileSystem();
    const savedHome = '/Users/example/Existing Tokenelo Data';
    const policy = makePolicy(savedHome);
    for (const expectation of [policy.daemon, policy.tray]) {
      fs.files.set(expectation.plistPath, {
        contents: serializeMacLaunchAgentPlist(expectation.definition),
        uid: UID,
        mode: 0o600,
      });
    }
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: HOME, accountHome: HOME,
      environment: { HOME, TOKENELO_HOME: '/Users/example/New Shell Value' },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile(_command, args) {
        if (args[0] === '-extract') {
          return { status: 0, stdout: args[1] === 'CFBundleExecutable' ? 'Tokenelo\n' : 'com.elostudios.tokenelo\n', stderr: '' };
        }
        if (args[0] === '-convert') {
          return {
            status: 0,
            stdout: JSON.stringify({ EnvironmentVariables: { TOKENELO_HOME: savedHome } }),
            stderr: '',
          };
        }
        if (args[0] === 'print') return { status: 113, stdout: '', stderr: 'Could not find service in domain' };
        throw new Error(`unexpected command ${args[0]}`);
      },
    };

    expect(runMacPackagedLaunchAgentLifecycle({
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    }, host)).toEqual({ operation: 'uninstall' });
    expect(fs.readFile(MARKER)).toBe('{"keep":true}\n');
    expect(fs.lstat(policy.daemon.plistPath)).toBeNull();
    expect(fs.lstat(policy.tray.plistPath)).toBeNull();
  });

  it('recognizes the current flat launchctl print shape and ignores only launchd-added XPC_SERVICE_NAME', () => {
    const fs = bundleFileSystem();
    const policy = makePolicy();
    const loaded = new Map<MacLaunchAgentRole, MacLoadedLaunchAgent>();
    for (const [role, expectation] of [['daemon', policy.daemon], ['tray', policy.tray]] as const) {
      const definition = expectation.definition;
      fs.files.set(expectation.plistPath, {
        contents: serializeMacLaunchAgentPlist(definition), uid: UID, mode: 0o600,
      });
      loaded.set(role, {
        plistPath: expectation.plistPath,
        programArguments: definition.ProgramArguments,
        workingDirectory: definition.WorkingDirectory,
        environmentVariables: definition.EnvironmentVariables,
      });
    }
    const calls: string[] = [];
    const commandTimeouts: number[] = [];
    let xpcValueOverride: string | null = null;
    let timeoutFirstBootout = true;
    const host: MacPackagedRuntimeHost = {
      platform: 'darwin', uid: UID, home: HOME, accountHome: HOME, environment: { HOME },
      runtimePath: `${ROOT}/dist/tray/macos-launch-agent-runtime.js`, fs,
      execFile(_command, args, options) {
        calls.push(args.join(' '));
        commandTimeouts.push(options.timeoutMs);
        if (args[0] === '-extract') {
          return { status: 0, stdout: args[1] === 'CFBundleExecutable' ? 'Tokenelo\n' : 'com.elostudios.tokenelo\n', stderr: '' };
        }
        if (args[0] === '-convert') {
          const role = args.at(-1)?.includes(MACOS_TOKENELO_LABELS.daemon) ? 'daemon' : 'tray';
          return {
            status: 0,
            stdout: JSON.stringify({ EnvironmentVariables: policy[role].definition.EnvironmentVariables }),
            stderr: '',
          };
        }
        if (args[0] === 'print') {
          const role = args[1].endsWith(MACOS_TOKENELO_LABELS.daemon) ? 'daemon' : 'tray';
          const value = loaded.get(role);
          if (!value) return { status: 113, stdout: '', stderr: 'Could not find service in domain' };
          const environment = Object.entries(value.environmentVariables)
            .map(([key, item]) => `    ${key} => ${item}`);
          environment.push(`    XPC_SERVICE_NAME => ${xpcValueOverride ?? policy[role].definition.Label}`);
          return {
            status: 0,
            stderr: '',
            stdout: [
              `${args[1]} = {`,
              `  path = ${value.plistPath}`,
              `  program = ${value.programArguments[0]}`,
              '  arguments = {',
              ...value.programArguments.map(argument => `    ${argument}`),
              '  }',
              `  working directory = ${value.workingDirectory}`,
              '  environment = {',
              ...environment,
              '  }',
              '}',
            ].join('\n'),
          };
        }
        if (args[0] === 'bootout') {
          if (timeoutFirstBootout) {
            timeoutFirstBootout = false;
            return { status: 124, stdout: '', stderr: 'command timed out', timedOut: true };
          }
          const role = args[2].endsWith(MACOS_TOKENELO_LABELS.daemon + '.plist') ? 'daemon' : 'tray';
          loaded.delete(role);
          return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'bootstrap') {
          const role = args[2].endsWith(MACOS_TOKENELO_LABELS.daemon + '.plist') ? 'daemon' : 'tray';
          const definition = policy[role].definition;
          loaded.set(role, {
            plistPath: policy[role].plistPath,
            programArguments: definition.ProgramArguments,
            workingDirectory: definition.WorkingDirectory,
            environmentVariables: definition.EnvironmentVariables,
          });
          return { status: 0, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected command ${args[0]}`);
      },
    };

    const request = {
      appBundlePath: APP,
      helperPath: `${ROOT}/scripts/install-service-macos.sh`,
      operation: 'uninstall',
    } as const;
    xpcValueOverride = 'foreign.launchd.label';
    expect(() => runMacPackagedLaunchAgentLifecycle(request, host)).toThrow(/action-mismatch/);
    expect(calls.filter(call => call.startsWith('bootout '))).toEqual([]);
    xpcValueOverride = null;
    expect(() => runMacPackagedLaunchAgentLifecycle(request, host))
      .toThrow(/launchctl bootout timed out.*prior LaunchAgent state was restored and verified/);
    expect(loaded.size).toBe(2);
    expect(fs.lstat(policy.daemon.plistPath)?.kind).toBe('file');
    expect(fs.lstat(policy.tray.plistPath)?.kind).toBe('file');
    expect(fs.lstat(TRANSACTION)).toBeNull();
    expect(commandTimeouts.length).toBeGreaterThan(0);
    expect(commandTimeouts.every(timeout => timeout === 15_000)).toBe(true);
    calls.length = 0;
    expect(runMacPackagedLaunchAgentLifecycle(request, host)).toEqual({ operation: 'uninstall' });
    expect(calls.filter(call => call.startsWith('bootout '))).toEqual([
      `bootout gui/${UID} ${policy.daemon.plistPath}`,
      `bootout gui/${UID} ${policy.tray.plistPath}`,
    ]);
    expect(fs.lstat(policy.daemon.plistPath)).toBeNull();
    expect(fs.lstat(policy.tray.plistPath)).toBeNull();
    expect(fs.readFile(MARKER)).toBe('{"keep":true}\n');
  });
});
