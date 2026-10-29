import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  inspectLinuxServiceRecovery,
  prepareLinuxServiceInstall,
  runLinuxBackgroundActivation,
  terminateOwnedTransientDaemon,
  type LinuxRuntimeFileSystem,
  type LinuxRuntimeSystemd,
  type LinuxServiceRuntimeHost,
} from '../../src/tray/linux-service-runtime.js';
import { planLinuxServiceLifecycle, type LinuxLifecyclePlanningEvidence, type LinuxPathIdentity } from '../../src/tray/linux-service-lifecycle.js';
import { requestLinuxTrayQuit } from '../../src/tray/transient-daemon-quit.js';

const uid = 1000;
const home = '/home/example';
const packageRoot = '/opt/Tokenelo';
const appRoot = packageRoot + '/resources/app';
const runtimePath = packageRoot + '/tokenelo';
const unitPath = home + '/.config/systemd/user/tokenelo-daemon.service';
const trayPath = home + '/.config/autostart/tokenelo-tray.desktop';
const linkPath = home + '/.config/systemd/user/default.target.wants/tokenelo-daemon.service';

interface FakeEntry { identity: LinuxPathIdentity; contents?: string; target?: string; prefix?: Buffer; }
class FakeFileSystem implements LinuxRuntimeFileSystem {
  readonly entries = new Map<string, FakeEntry>();
  seedDirectory(file: string, owner = uid, mode = 0o700): void {
    this.entries.set(file, { identity: { path: file, realPath: file, kind: 'directory', uid: owner, mode } });
  }
  seedFile(file: string, contents = '', owner = uid, mode = 0o644, prefix?: Buffer): void {
    this.entries.set(file, { identity: { path: file, realPath: file, kind: 'file', uid: owner, mode }, contents, prefix });
  }
  lstat(file: string): LinuxPathIdentity | null { return this.entries.get(file)?.identity ?? null; }
  realpath(file: string): string { const entry = this.entries.get(file); if (!entry) throw new Error('missing'); return entry.identity.realPath; }
  readFile(file: string): string { const entry = this.entries.get(file); if (!entry || entry.identity.kind !== 'file') throw new Error('not a file'); return entry.contents ?? ''; }
  readLink(file: string): string { const entry = this.entries.get(file); if (!entry || entry.identity.kind !== 'symlink') throw new Error('not a link'); return entry.target ?? ''; }
  list(directory: string): string[] {
    const prefix = directory.endsWith('/') ? directory : directory + '/';
    return [...this.entries.keys()].filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map(file => file.slice(prefix.length));
  }
  readPrefix(file: string): Buffer { const entry = this.entries.get(file); return entry?.prefix ?? Buffer.alloc(0); }
  mkdir(file: string, mode: number): void {
    if (this.entries.has(file)) throw new Error('exists');
    this.seedDirectory(file, uid, mode);
  }
  writeFile(file: string, contents: string, mode: number, exclusive = false): void {
    if (exclusive && this.entries.has(file)) throw new Error('exists');
    this.seedFile(file, contents, uid, mode);
  }
  rename(from: string, to: string): void {
    const entry = this.entries.get(from);
    if (!entry) throw new Error('source missing');
    this.entries.delete(from);
    entry.identity = { ...entry.identity, path: to, realPath: to };
    this.entries.set(to, entry);
  }
  unlink(file: string): void { if (!this.entries.delete(file)) throw new Error('missing'); }
  rmdir(directory: string): void {
    if ([...this.entries.keys()].some(file => file.startsWith(directory + '/'))) throw new Error('not empty');
    if (!this.entries.delete(directory)) throw new Error('missing');
  }
  symlink(target: string, link: string): void {
    if (this.entries.has(link)) throw new Error('exists');
    this.entries.set(link, { identity: { path: link, realPath: target, kind: 'symlink', uid, mode: 0o777 }, target });
  }
  chmod(file: string, mode: number): void {
    const entry = this.entries.get(file); if (!entry) throw new Error('missing');
    entry.identity = { ...entry.identity, mode };
  }
  syncFile(file: string): void { if (!this.entries.has(file)) throw new Error('missing'); }
  syncDirectory(directory: string): void { if (!this.entries.has(directory)) throw new Error('missing'); }
}

class FakeSystemd implements LinuxRuntimeSystemd {
  failStart = false;
  onStart?: () => void;
  active = false;
  loaded = false;
  commandCount = 0;
  constructor(private readonly fs: FakeFileSystem, private readonly executable: string, private readonly daemon: string) {}
  command(args: readonly string[]) {
    this.commandCount++;
    const action = args[0];
    if (action === 'daemon-reload') {
      this.loaded = this.fs.lstat(unitPath)?.kind === 'file';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'start') {
      this.onStart?.();
      if (this.failStart) return { status: 1, stdout: '', stderr: 'fake start failure' };
      this.active = true;
      this.loaded = true;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (action === 'stop') { this.active = false; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  }
  state() {
    const unit = this.fs.lstat(unitPath);
    const link = this.fs.lstat(linkPath);
    return {
      enabled: link?.kind === 'symlink' ? 'enabled' as const : unit ? 'disabled' as const : 'not-found' as const,
      active: this.active ? 'active' as const : unit ? 'inactive' as const : 'not-found' as const,
    };
  }
  observation() {
    if (!this.loaded || this.fs.lstat(unitPath)?.kind !== 'file') return null;
    return { fragmentPath: unitPath, execStartArgv: [this.executable, this.daemon], dropInPaths: [], needDaemonReload: 'no' as const };
  }
}

function makeHost(): { host: LinuxServiceRuntimeHost; fs: FakeFileSystem; systemd: FakeSystemd } {
  const fs = new FakeFileSystem();
  fs.seedDirectory('/home', 0, 0o755);
  fs.seedDirectory(home);
  fs.seedDirectory(home + '/.config');
  fs.seedDirectory(home + '/.local', uid, 0o755);
  fs.seedDirectory(home + '/.local/share');
  fs.seedDirectory(home + '/.local/state');
  fs.seedDirectory('/opt', 0, 0o755);
  fs.seedDirectory(packageRoot, uid, 0o755);
  fs.seedDirectory(packageRoot + '/resources', uid, 0o755);
  fs.seedDirectory(appRoot, uid, 0o755);
  fs.seedDirectory(appRoot + '/dist', uid, 0o755);
  fs.seedDirectory(appRoot + '/dist/tray', uid, 0o755);
  fs.seedDirectory(appRoot + '/dist/daemon', uid, 0o755);
  fs.seedDirectory(appRoot + '/scripts', uid, 0o755);
  fs.seedFile('/usr/bin/env', '', 0, 0o755);
  fs.seedFile('/usr/bin/systemctl', '', 0, 0o755);
  fs.seedFile(runtimePath, '', uid, 0o755, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  fs.seedFile(packageRoot + '/chrome-sandbox', '', uid, 0o755);
  fs.seedFile(appRoot + '/package.json', JSON.stringify({ name: 'tokenelo', private: true, type: 'module', main: 'dist/tray/main.js' }));
  fs.seedFile(appRoot + '/dist/tray/linux-service-lifecycle.js');
  fs.seedFile(appRoot + '/dist/tray/main.js');
  fs.seedFile(appRoot + '/dist/daemon/main.js');
  fs.seedFile(home + '/.local/share/keep-ledger-sentinel', 'ledger bytes');
  fs.seedFile(home + '/.local/share/keep-prices-sentinel', 'price bytes');
  const systemd = new FakeSystemd(fs, runtimePath, appRoot + '/dist/daemon/main.js');
  let host: LinuxServiceRuntimeHost;
  host = {
    platform: 'linux', uid, home, environment: { HOME: home, PATH: '/usr/bin:/bin' },
    runtimePath, entryPath: appRoot + '/dist/tray/main.js', packageRoot, appRoot, fs, systemd,
    collectEvidence(): LinuxLifecyclePlanningEvidence {
      const packageJsonContents = fs.readFile(appRoot + '/package.json');
      const sandbox = fs.lstat(packageRoot + '/chrome-sandbox')!;
      const unit = fs.lstat(unitPath);
      const autostart = fs.lstat(trayPath);
      const link = fs.lstat(linkPath);
      return {
        platform: 'linux', uid, runtimeHome: home, accountHome: home, homeEnvironment: home,
        tokeneloHomeEnvironment: undefined, pathEnvironment: '/usr/bin:/bin', configHomeEnvironment: undefined,
        dataHomeEnvironment: undefined, stateHomeEnvironment: undefined,
        accountHomeIdentity: fs.lstat(home)!, configHomeIdentity: fs.lstat(home + '/.config')!,
        dataHomeIdentity: fs.lstat(home + '/.local/share')!, stateHomeIdentity: fs.lstat(home + '/.local/state')!,
        systemEnvIdentity: fs.lstat('/usr/bin/env')!,
        package: {
          packageRoot: fs.lstat(packageRoot)!, resourcesDirectory: fs.lstat(packageRoot + '/resources')!,
          appDirectory: fs.lstat(appRoot)!, packageJson: { identity: fs.lstat(appRoot + '/package.json')!, contents: packageJsonContents },
          packageJsonContents, lifecycleEntry: fs.lstat(appRoot + '/dist/tray/linux-service-lifecycle.js')!,
          daemonEntry: fs.lstat(appRoot + '/dist/daemon/main.js')!, trayEntry: fs.lstat(appRoot + '/dist/tray/main.js')!,
          executable: fs.lstat(runtimePath)!, executableFormat: 'ELF', executableBasename: 'tokenelo', sandbox,
          sandboxCapability: 'user-namespace',
        },
        service: {
          unitFile: unit ? { identity: unit, ...(unit.kind === 'file' ? { contents: fs.readFile(unitPath) } : {}) } : null,
          trayAutostartFile: autostart ? { identity: autostart, ...(autostart.kind === 'file' ? { contents: fs.readFile(trayPath) } : {}) } : null,
          enablementLink: link ? { identity: link, linkTarget: fs.readLink(linkPath) } : null,
          manager: systemd.observation(), ...systemd.state(),
        },
      };
    },
  };
  return { host, fs, systemd };
}

describe('Linux packaged background activation', () => {
  it('reports no recovery without inspecting the service manager when the private lock is absent', () => {
    const { host, systemd } = makeHost();
    expect(inspectLinuxServiceRecovery(host)).toEqual({ status: 'none' });
    expect(systemd.commandCount).toBe(0);
  });

  it('verifies a well-formed retained receipt as manual-only evidence without changing it', () => {
    const { host, fs, systemd } = makeHost();
    const plan = prepareLinuxServiceInstall(host).plan;
    const lock = plan.policy.transactionLockPath;
    fs.seedDirectory(lock, uid, 0o700);
    const snapshots = [plan.policy.unitPath, plan.policy.autostartPath, plan.policy.enablementLinkPath].map(path => ({
      path, existed: false, sha256: null, mode: null, linkTarget: null,
    }));
    const receiptPath = lock + '/transaction.json';
    const receipt = JSON.stringify({ schemaVersion: 1, identitySha256: plan.recovery.identitySha256, snapshots });
    fs.seedFile(receiptPath, receipt, uid, 0o600);
    const before = [...fs.entries.keys()].sort();
    expect(inspectLinuxServiceRecovery(host)).toEqual({ status: 'verified-manual-review', recoveryPath: lock });
    expect([...fs.entries.keys()].sort()).toEqual(before);
    expect(fs.readFile(receiptPath)).toBe(receipt);
    expect(systemd.commandCount).toBe(0);
  });

  it('verifies immutable original backups by hash and refuses a changed backup', () => {
    const { host, fs, systemd } = makeHost();
    const firstPlan = prepareLinuxServiceInstall(host).plan;
    const originalUnit = firstPlan.policy.unitContents;
    fs.seedFile(unitPath, originalUnit, uid, 0o644);
    systemd.loaded = true;
    const plan = prepareLinuxServiceInstall(host).plan;
    const lock = plan.policy.transactionLockPath;
    fs.seedDirectory(lock, uid, 0o700);
    fs.seedFile(lock + '/unit.original', originalUnit, uid, 0o600);
    const snapshots = [
      { path: unitPath, existed: true, sha256: createHash('sha256').update(originalUnit, 'utf8').digest('hex'), mode: 0o644, linkTarget: null },
      { path: trayPath, existed: false, sha256: null, mode: null, linkTarget: null },
      { path: linkPath, existed: false, sha256: null, mode: null, linkTarget: null },
    ];
    fs.seedFile(lock + '/transaction.json', JSON.stringify({
      schemaVersion: 1, identitySha256: plan.recovery.identitySha256, snapshots,
    }), uid, 0o600);
    expect(inspectLinuxServiceRecovery(host)).toEqual({ status: 'verified-manual-review', recoveryPath: lock });
    fs.seedFile(lock + '/unit.original', 'altered backup', uid, 0o600);
    expect(inspectLinuxServiceRecovery(host)).toEqual({ status: 'needs-review', recoveryPath: lock, reason: 'backup-mismatch' });
  });

  it('refuses foreign, malformed, and state-mismatched retained recovery evidence without mutation', () => {
    const foreign = makeHost();
    const lock = home + '/.tokenelo-linux-service-transaction';
    foreign.fs.seedDirectory(lock, 2000, 0o700);
    expect(inspectLinuxServiceRecovery(foreign.host)).toEqual({ status: 'needs-review', recoveryPath: lock, reason: 'foreign-lock' });

    const malformed = makeHost();
    malformed.fs.seedDirectory(lock, uid, 0o700);
    malformed.fs.seedFile(lock + '/transaction.json', '{bad json', uid, 0o600);
    expect(inspectLinuxServiceRecovery(malformed.host)).toEqual({ status: 'needs-review', recoveryPath: lock, reason: 'receipt-invalid' });

    const changed = makeHost();
    const plan = prepareLinuxServiceInstall(changed.host).plan;
    changed.fs.seedDirectory(lock, uid, 0o700);
    const snapshots = [plan.policy.unitPath, plan.policy.autostartPath, plan.policy.enablementLinkPath].map(path => ({
      path, existed: false, sha256: null, mode: null, linkTarget: null,
    }));
    changed.fs.seedFile(lock + '/transaction.json', JSON.stringify({
      schemaVersion: 1, identitySha256: plan.recovery.identitySha256, snapshots,
    }), uid, 0o600);
    changed.fs.seedFile(unitPath, 'foreign service edit');
    const before = [...changed.fs.entries.keys()].sort();
    expect(inspectLinuxServiceRecovery(changed.host)).toEqual({ status: 'needs-review', recoveryPath: lock, reason: 'current-state-unverifiable' });
    expect([...changed.fs.entries.keys()].sort()).toEqual(before);
  });

  it('honors cancellation before package or service inspection', async () => {
    const { host, systemd } = makeHost();
    let inspections = 0;
    host.collectEvidence = () => { inspections++; throw new Error('should not inspect after cancel'); };
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => false,
      ensureDaemonQuiescent: async () => ({ quiescent: true, stoppedOwnedTransient: false }),
      resumeTransientDaemon: async () => undefined,
    });
    expect(result).toEqual({ status: 'cancelled' });
    expect(inspections).toBe(0);
    expect(systemd.commandCount).toBe(0);
  });

  it('refuses an unquiesced daemon without publishing unit or autostart files', async () => {
    const { host, fs, systemd } = makeHost();
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => ({ quiescent: false, stoppedOwnedTransient: false }),
      resumeTransientDaemon: async () => undefined,
    });
    expect(result.status).toBe('needs-review');
    expect(fs.lstat(unitPath)).toBeNull();
    expect(fs.lstat(trayPath)).toBeNull();
    expect(fs.lstat(linkPath)).toBeNull();
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
    expect(systemd.commandCount).toBe(0);
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });

  it('releases a lock after a one-off pre-snapshot inspection failure only when plan revalidation proves the original state', async () => {
    const { host, fs, systemd } = makeHost();
    const collect = host.collectEvidence;
    let calls = 0, quiescenceChecks = 0, resumed = 0;
    host.collectEvidence = () => {
      calls++;
      if (calls === 1) throw new Error('injected one-off pre-snapshot inspection error');
      return collect();
    };
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => { quiescenceChecks++; return { quiescent: true, stoppedOwnedTransient: false }; },
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'service-state', rollbackComplete: true });
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
    expect(quiescenceChecks).toBe(0);
    expect(resumed).toBe(0);
    expect(systemd.commandCount).toBe(0);
  });

  it('journals snapshots before quiescence and never resumes an unreported child after a quiescence error', async () => {
    const { host, fs, systemd } = makeHost();
    let resumed = 0;
    const lock = home + '/.tokenelo-linux-service-transaction';
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => { throw new Error('injected quiescence error'); },
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'service-state', rollbackComplete: true });
    expect(fs.lstat(lock)).toBeNull();
    expect(resumed).toBe(0);
    expect(systemd.commandCount).toBe(0);
  });

  it('removes an empty lock after receipt-write failure only when the original state is revalidated', async () => {
    const { host, fs, systemd } = makeHost();
    const writeFile = fs.writeFile.bind(fs);
    let receiptWriteFailed = false, quiescenceChecks = 0;
    fs.writeFile = (file, contents, mode, exclusive = false) => {
      if (!receiptWriteFailed && file.endsWith('/transaction.json')) {
        receiptWriteFailed = true;
        throw new Error('injected receipt write failure');
      }
      writeFile(file, contents, mode, exclusive);
    };
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => { quiescenceChecks++; return { quiescent: true, stoppedOwnedTransient: false }; },
      resumeTransientDaemon: async () => undefined,
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'service-state', rollbackComplete: true });
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
    expect(quiescenceChecks).toBe(0);
    expect(systemd.commandCount).toBe(0);
  });

  it('resumes a stopped owned transient only after the pre-mutation state is revalidated', async () => {
    const { host, fs, systemd } = makeHost();
    let resumed = 0;
    const lock = home + '/.tokenelo-linux-service-transaction';
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => ({ quiescent: false, stoppedOwnedTransient: true }),
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'daemon-not-quiescent', rollbackComplete: true });
    expect(fs.lstat(lock)).toBeNull();
    expect(resumed).toBe(1);
    expect(systemd.commandCount).toBe(0);
  });

  it('retains a durable refusal receipt and does not resume if quiescence returns after service state drifts', async () => {
    const { host, fs, systemd } = makeHost();
    let resumed = 0;
    const lock = home + '/.tokenelo-linux-service-transaction';
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => {
        fs.seedFile(unitPath, 'foreign concurrent unit');
        return { quiescent: false, stoppedOwnedTransient: true };
      },
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'failed', reason: 'install-failed', rollbackComplete: false, recoveryRetained: true, recoveryPath: lock });
    expect(fs.lstat(lock)).not.toBeNull();
    expect(fs.readFile(lock + '/transaction.json')).toContain('identitySha256');
    expect(fs.readFile(lock + '/recovery.txt')).toContain('requires review');
    expect(resumed).toBe(0);
    expect(systemd.commandCount).toBe(0);
  });

  it('refuses a pre-existing lifecycle lease before asking to stop a daemon', async () => {
    const { host, fs } = makeHost();
    fs.seedDirectory(home + '/' + '.tokenelo-linux-service-transaction', uid, 0o700);
    let quiescenceChecks = 0;
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => { quiescenceChecks++; return { quiescent: true, stoppedOwnedTransient: false }; },
      resumeTransientDaemon: async () => undefined,
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'transaction-owned', recoveryPath: home + '/.tokenelo-linux-service-transaction' });
    expect(quiescenceChecks).toBe(0);
    expect(fs.lstat(unitPath)).toBeNull();
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });

  it('activates only the exact user-level plan after quiescence and retains ledger/pricing bytes', async () => {
    const { host, fs, systemd } = makeHost();
    let resumed = 0;
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => ({ quiescent: true, stoppedOwnedTransient: true }),
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'activated' });
    expect(resumed).toBe(0);
    expect(systemd.state().enabled).toBe('enabled');
    expect(systemd.state().active).toBe('active');
    expect(fs.readFile(unitPath)).toContain('UnsetEnvironment=TOKENELO_HOME NODE_OPTIONS');
    expect(fs.readFile(unitPath)).toContain('XDG_DATA_HOME=/home/example/.local/share');
    expect(fs.readFile(trayPath)).toContain('/usr/bin/env');
    expect(fs.readLink(linkPath)).toBe(unitPath);
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });

  it('rolls back a failed systemd start and resumes only after verified restoration', async () => {
    const { host, fs, systemd } = makeHost();
    systemd.failStart = true;
    let resumed = 0;
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => ({ quiescent: true, stoppedOwnedTransient: true }),
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'failed', reason: 'install-failed', rollbackComplete: true, recoveryRetained: false });
    expect(resumed).toBe(1);
    expect(fs.lstat(unitPath)).toBeNull();
    expect(fs.lstat(trayPath)).toBeNull();
    expect(fs.lstat(linkPath)).toBeNull();
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
    expect(systemd.state().active).toBe('not-found');
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });

  it('restores exact prior owned unit, tray entry, and enablement state after a failed update', async () => {
    const { host, fs, systemd } = makeHost();
    const prior = planLinuxServiceLifecycle({ operation: 'install', evidence: host.collectEvidence() }).policy;
    fs.seedFile(unitPath, prior.unitContents);
    fs.seedFile(trayPath, prior.autostartContents);
    fs.symlink(unitPath, linkPath);
    systemd.loaded = true;
    systemd.failStart = true;
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => ({ quiescent: true, stoppedOwnedTransient: true }),
      resumeTransientDaemon: async () => undefined,
    });
    expect(result).toEqual({ status: 'failed', reason: 'install-failed', rollbackComplete: true, recoveryRetained: false });
    expect(fs.readFile(unitPath)).toBe(prior.unitContents);
    expect(fs.readFile(trayPath)).toBe(prior.autostartContents);
    expect(fs.readLink(linkPath)).toBe(unitPath);
    expect(systemd.state()).toEqual({ enabled: 'enabled', active: 'inactive' });
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
  });

  it('retains recovery evidence and leaves a concurrently changed autostart file untouched', async () => {
    const { host, fs, systemd } = makeHost();
    systemd.failStart = true;
    systemd.onStart = () => fs.seedFile(trayPath, 'foreign concurrent edit');
    let resumed = 0;
    const lock = home + '/.tokenelo-linux-service-transaction';
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => ({ quiescent: true, stoppedOwnedTransient: true }),
      resumeTransientDaemon: async () => { resumed++; },
    });
    expect(result).toEqual({ status: 'failed', reason: 'install-failed', rollbackComplete: false, recoveryRetained: true, recoveryPath: lock });
    expect(resumed).toBe(0);
    expect(fs.readFile(trayPath)).toBe('foreign concurrent edit');
    expect(fs.lstat(lock)).not.toBeNull();
    expect(fs.readFile(lock + '/transaction.json')).toContain('identitySha256');
    expect(fs.readFile(lock + '/recovery.txt')).toContain('requires review');
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });

  it('refuses a package whose identity does not match the private Tokenelo contract', async () => {
    const { host, fs, systemd } = makeHost();
    fs.seedFile(appRoot + '/package.json', JSON.stringify({ name: 'foreign', private: false, type: 'commonjs', main: 'other.js' }));
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => { throw new Error('quiescence must not be reached'); },
      resumeTransientDaemon: async () => undefined,
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'package-identity' });
    expect(systemd.commandCount).toBe(0);
    expect(fs.lstat(unitPath)).toBeNull();
    expect(fs.lstat(home + '/.tokenelo-linux-service-transaction')).toBeNull();
  });

  it('refuses profile redirection before any service action', async () => {
    const { host, fs, systemd } = makeHost();
    host.environment = { ...host.environment, TOKENELO_HOME: '/tmp/tokenelo-test-profile' };
    const result = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => { throw new Error('quiescence must not be reached'); },
      resumeTransientDaemon: async () => undefined,
    });
    expect(result).toEqual({ status: 'needs-review', reason: 'configuration-identity' });
    expect(systemd.commandCount).toBe(0);
    expect(fs.lstat(unitPath)).toBeNull();
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });

  it('requests graceful exit only from the owned transient child and refuses if shutdown cannot be proved', async () => {
    const signals: string[] = [];
    const child = {
      pid: 222, exitCode: null as number | null, signalCode: null as string | null, killed: false,
      kill(signal: 'SIGTERM' | 'SIGKILL') {
        signals.push(signal);
        return true;
      },
    };
    const waits: number[] = [];
    const stopped = await terminateOwnedTransientDaemon(child, async timeoutMs => {
      waits.push(timeoutMs);
      return false;
    });
    expect(stopped).toBe(false);
    expect(signals).toEqual(['SIGTERM']);
    expect(waits).toEqual([30_000]);
  });

  it('refuses to signal an unowned child identity', async () => {
    let signals = 0;
    const child = { pid: undefined, exitCode: null, signalCode: null, killed: false, kill() { signals++; return true; } };
    const stopped = await terminateOwnedTransientDaemon(child, async () => true);
    expect(stopped).toBe(false);
    expect(signals).toBe(0);
  });

  it('lets a second tray own a fresh transient after explicit Quit, then activate the user service', async () => {
    const { host, fs, systemd } = makeHost();
    const firstChild = {
      pid: 301, exitCode: null as number | null, signalCode: null as string | null, killed: false,
      kill(signal: 'SIGTERM' | 'SIGKILL') { expect(signal).toBe('SIGTERM'); this.killed = true; return true; },
    };
    let firstTrayQuit = false;
    let quiescenceChecks = 0;

    const declined = await runLinuxBackgroundActivation(host, {
      confirm: async () => false,
      ensureDaemonQuiescent: async () => { quiescenceChecks++; return { quiescent: true, stoppedOwnedTransient: false }; },
      resumeTransientDaemon: async () => undefined,
    });
    expect(declined).toEqual({ status: 'cancelled' });
    expect(quiescenceChecks).toBe(0);

    const paused = await requestLinuxTrayQuit({
      ownership: 'owned-running', child: firstChild, configuredService: false,
      confirm: async prompt => prompt === 'pause-owned-transient',
      waitForExit: async timeoutMs => { expect(timeoutMs).toBe(30_000); firstChild.exitCode = 0; return true; },
      quit: () => { firstTrayQuit = true; }, stopFailure: () => undefined,
    });
    expect(paused).toBe('quit-after-pausing-transient');
    expect(firstTrayQuit).toBe(true);
    expect(firstChild.killed).toBe(true);
    expect(firstChild.exitCode).toBe(0);
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');

    const secondChild = {
      pid: 302, exitCode: null as number | null, signalCode: null as string | null, killed: false,
      kill(signal: 'SIGTERM' | 'SIGKILL') { expect(signal).toBe('SIGTERM'); this.killed = true; return true; },
    };
    expect(secondChild.pid).not.toBe(firstChild.pid);
    const activated = await runLinuxBackgroundActivation(host, {
      confirm: async () => true,
      ensureDaemonQuiescent: async () => {
        const stopped = await terminateOwnedTransientDaemon(secondChild, async timeoutMs => {
          expect(timeoutMs).toBe(30_000);
          secondChild.exitCode = 0;
          return true;
        });
        return { quiescent: stopped && secondChild.exitCode === 0, stoppedOwnedTransient: stopped };
      },
      resumeTransientDaemon: async () => undefined,
    });

    expect(activated).toEqual({ status: 'activated' });
    expect(systemd.state()).toEqual({ enabled: 'enabled', active: 'active' });
    expect(fs.readFile(home + '/.local/share/keep-ledger-sentinel')).toBe('ledger bytes');
    expect(fs.readFile(home + '/.local/share/keep-prices-sentinel')).toBe('price bytes');
  });
});
