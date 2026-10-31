import { describe, expect, it } from 'vitest';
import {
  LINUX_TOKENELO_TRANSACTION_LOCK,
  LINUX_TOKENELO_UNIT_NAME,
  planLinuxServiceLifecycle,
  type LinuxLifecyclePlanningEvidence,
  type LinuxLifecyclePlanningInput,
  type LinuxPackageEvidence,
  type LinuxPathIdentity,
  type LinuxServiceLifecyclePlan,
  type LinuxSystemdUnitObservation,
} from '../../src/tray/linux-service-lifecycle.js';

const uid = 1000;
const home = '/home/example';
const packageRoot = '/opt/Tokenelo';

function id(path: string, kind: LinuxPathIdentity['kind'], mode: number, owner = uid, realPath = path): LinuxPathIdentity {
  return { path, realPath, kind, uid: owner, mode };
}
function file(path: string, contents: string, mode = 0o644, owner = uid) {
  return { identity: id(path, 'file', mode, owner), contents };
}
function evidence(packageRootPath = packageRoot, pathValue = '/usr/bin:/bin'): LinuxLifecyclePlanningEvidence {
  const app = packageRootPath + '/resources/app';
  const packageJsonContents = JSON.stringify({
    name: 'tokenelo', private: true, type: 'module', main: 'dist/tray/main.js', version: '0.1.0',
  });
  const pkg: LinuxPackageEvidence = {
    packageRoot: id(packageRootPath, 'directory', 0o755),
    resourcesDirectory: id(packageRootPath + '/resources', 'directory', 0o755),
    appDirectory: id(app, 'directory', 0o755),
    packageJson: file(app + '/package.json', packageJsonContents),
    packageJsonContents,
    lifecycleEntry: id(app + '/dist/tray/linux-service-lifecycle.js', 'file', 0o644),
    daemonEntry: id(app + '/dist/daemon/main.js', 'file', 0o644),
    trayEntry: id(app + '/dist/tray/main.js', 'file', 0o644),
    executable: id(packageRootPath + '/tokenelo', 'file', 0o755),
    executableFormat: 'ELF',
    executableBasename: 'tokenelo',
    sandbox: id(packageRootPath + '/chrome-sandbox', 'file', 0o755),
    sandboxCapability: 'user-namespace',
  };
  return {
    platform: 'linux',
    uid,
    runtimeHome: home,
    accountHome: home,
    homeEnvironment: home,
    tokeneloHomeEnvironment: undefined,
    pathEnvironment: pathValue,
    configHomeEnvironment: undefined,
    dataHomeEnvironment: undefined,
    stateHomeEnvironment: undefined,
    accountHomeIdentity: id(home, 'directory', 0o755),
    configHomeIdentity: id(home + '/.config', 'directory', 0o700),
    dataHomeIdentity: id(home + '/.local/share', 'directory', 0o700),
    stateHomeIdentity: id(home + '/.local/state', 'directory', 0o700),
    systemEnvIdentity: id('/usr/bin/env', 'file', 0o755, 0),
    package: pkg,
    service: {
      unitFile: null,
      trayAutostartFile: null,
      enablementLink: null,
      manager: null,
      enabled: 'not-found',
      active: 'not-found',
    },
  };
}
function plan(e: LinuxLifecyclePlanningEvidence, operation: 'install' | 'uninstall' = 'install'): LinuxServiceLifecyclePlan {
  return planLinuxServiceLifecycle({ operation, evidence: e });
}
function managerFor(p: LinuxServiceLifecyclePlan, overrides: Partial<LinuxSystemdUnitObservation> = {}): LinuxSystemdUnitObservation {
  return {
    fragmentPath: p.policy.unitPath,
    execStartArgv: [...p.policy.unitArgv],
    dropInPaths: [],
    needDaemonReload: 'no',
    ...overrides,
  };
}
function withInstalledState(e: LinuxLifecyclePlanningEvidence): LinuxServiceLifecyclePlan {
  const initial = plan(e);
  e.service = {
    unitFile: file(initial.policy.unitPath, initial.policy.unitContents),
    trayAutostartFile: file(initial.policy.autostartPath, initial.policy.autostartContents),
    enablementLink: {
      identity: id(initial.policy.enablementLinkPath, 'symlink', 0o777, uid, initial.policy.unitPath),
      linkTarget: initial.policy.unitPath,
    },
    manager: managerFor(initial),
    enabled: 'enabled',
    active: 'active',
  };
  return initial;
}

describe('Linux package lifecycle planner', () => {
  it('renders exact bundled daemon and tray actions for an explicit install plan', () => {
    const e = evidence();
    const before = JSON.stringify(e);
    const result = plan(e);

    expect(result.trigger).toBe('explicit-user-action');
    expect(result.result).toBe('plan-transaction');
    expect(result.execution).toBe('plan-only');
    expect(result.preconditions.physicalXdgRootsMustAlreadyExist).toBe(true);
    expect(result.preconditions.packageInputsMustNotBeGroupOrWorldWritable).toBe(true);
    expect(result.policy.unitArgv).toEqual([
      packageRoot + '/tokenelo',
      packageRoot + '/resources/app/dist/daemon/main.js',
    ]);
    expect(result.policy.trayArgv).toEqual([
      '/usr/bin/env',
      '-u',
      'ELECTRON_RUN_AS_NODE',
      '-u',
      'TOKENELO_HOME',
      '-u',
      'NODE_OPTIONS',
      'HOME=/home/example',
      'XDG_CONFIG_HOME=/home/example/.config',
      'XDG_DATA_HOME=/home/example/.local/share',
      'XDG_STATE_HOME=/home/example/.local/state',
      packageRoot + '/tokenelo',
      '--ozone-platform-hint=auto',
      packageRoot + '/resources/app/dist/tray/main.js',
    ]);
    expect(result.policy.unitContents).toContain('ExecStart=:"/opt/Tokenelo/tokenelo" "/opt/Tokenelo/resources/app/dist/daemon/main.js"');
    expect(result.policy.unitContents).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(result.policy.unitContents).toContain('Environment="HOME=/home/example"');
    expect(result.policy.autostartContents).toContain('Exec="/usr/bin/env" "-u" "ELECTRON_RUN_AS_NODE" "-u" "TOKENELO_HOME" "-u" "NODE_OPTIONS" "HOME=/home/example" "XDG_CONFIG_HOME=/home/example/.config" "XDG_DATA_HOME=/home/example/.local/share" "XDG_STATE_HOME=/home/example/.local/state" "/opt/Tokenelo/tokenelo" "--ozone-platform-hint=auto" "/opt/Tokenelo/resources/app/dist/tray/main.js"');
    expect(result.policy.autostartContents).not.toContain('ELECTRON_RUN_AS_NODE=');
    expect(result.policy.unitContents).toContain('UnsetEnvironment=TOKENELO_HOME NODE_OPTIONS');
    expect(result.policy.unitContents).toContain('Environment="XDG_DATA_HOME=/home/example/.local/share"');
    expect(JSON.stringify(e)).toBe(before);
  });

  it('preserves literal special path and environment bytes through systemd and Desktop Exec parsing', () => {
    const specialRoot = '/opt/Token ${HOME} %n "quoted" `tick`';
    const pathValue = '/usr/bin:$HOME/bin%h';
    const result = plan(evidence(specialRoot, pathValue));
    const expectedExe = specialRoot + '/tokenelo';
    const expectedDaemon = specialRoot + '/resources/app/dist/daemon/main.js';

    expect(result.policy.unitArgv).toEqual([expectedExe, expectedDaemon]);
    expect(result.policy.unitContents).toContain('WorkingDirectory="/opt/Token ${HOME} %%n \\"quoted\\" `tick`/resources/app"');
    expect(result.policy.unitContents).toContain('ExecStart=:"/opt/Token ${HOME} %%n \\"quoted\\" `tick`/tokenelo" "/opt/Token ${HOME} %%n \\"quoted\\" `tick`/resources/app/dist/daemon/main.js"');
    expect(result.policy.unitContents).toContain('Environment="HOME=/home/example"');
    expect(result.policy.unitContents).toContain('Environment="PATH=/usr/bin:$HOME/bin%%h"');

    const desktopExec = result.policy.autostartContents.split('\n').find(line => line.startsWith('Exec='));
    expect(desktopExec).toBe(
      'Exec="/usr/bin/env" "-u" "ELECTRON_RUN_AS_NODE" ' +
      '"-u" "TOKENELO_HOME" "-u" "NODE_OPTIONS" ' +
      '"HOME=/home/example" "XDG_CONFIG_HOME=/home/example/.config" "XDG_DATA_HOME=/home/example/.local/share" "XDG_STATE_HOME=/home/example/.local/state" ' +
      '"/opt/Token \\\\${HOME} %%n \\\\"quoted\\\\" \\\\`tick\\\\`/tokenelo" ' +
      '"--ozone-platform-hint=auto" ' +
      '"/opt/Token \\\\${HOME} %%n \\\\"quoted\\\\" \\\\`tick\\\\`/resources/app/dist/tray/main.js"',
    );
    expect(result.policy.trayArgv).toEqual([
      '/usr/bin/env', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'TOKENELO_HOME', '-u', 'NODE_OPTIONS',
      'HOME=/home/example', 'XDG_CONFIG_HOME=/home/example/.config', 'XDG_DATA_HOME=/home/example/.local/share', 'XDG_STATE_HOME=/home/example/.local/state', expectedExe,
      '--ozone-platform-hint=auto', specialRoot + '/resources/app/dist/tray/main.js',
    ]);
  });

  it('plans guarded publication, exact manager verification, and retained recovery intent', () => {
    const result = plan(evidence());
    const kinds = result.steps.map(step => step.kind);
    expect(result.policy.transactionLockPath).toBe(home + '/' + LINUX_TOKENELO_TRANSACTION_LOCK);
    expect(result.recovery.lockPath).toBe(result.policy.transactionLockPath);
    expect(result.recovery.immutableBackups.map(item => item.backupName)).toEqual([
      'unit.original', 'autostart.original', 'enablement.original',
    ]);
    expect(result.recovery.candidateSha256).toEqual({
      unit: result.policy.unitSha256,
      autostart: result.policy.autostartSha256,
    });
    expect(result.recovery.rollback.retainBackupsAndLockOnMismatchOrRollbackFailure).toBe(true);
    expect(result.concurrencyLimit).toBe('same-user-cooperating-writers-only');
    expect(kinds.indexOf('verify-candidates-before-publication')).toBeLessThan(kinds.indexOf('publish-owned-file'));
    expect(kinds.indexOf('verify-published-file')).toBeLessThan(kinds.indexOf('daemon-reload'));
    expect(kinds.indexOf('verify-loaded-unit')).toBeLessThan(kinds.indexOf('start-exact-unit'));
    const managerStep = result.steps.find(step => step.kind === 'verify-loaded-unit');
    expect(managerStep).toMatchObject({
      kind: 'verify-loaded-unit',
      fragmentPath: result.policy.unitPath,
      execStartArgv: result.policy.unitArgv,
      dropInPaths: 0,
    });
  });

  it('accepts only the exact observed systemd fragment and full argv', () => {
    const base = evidence();
    const initial = plan(base);
    base.service.unitFile = file(initial.policy.unitPath, initial.policy.unitContents);
    base.service.manager = managerFor(initial);
    base.service.enabled = 'disabled';
    base.service.active = 'inactive';

    expect(() => plan(base)).not.toThrow();

    const mismatches: Partial<LinuxSystemdUnitObservation>[] = [
      { execStartArgv: [initial.policy.executablePath, initial.policy.executablePath, initial.policy.daemonEntryPath] },
      { fragmentPath: initial.policy.unitPath + '.foreign' },
      { dropInPaths: ['/home/example/.config/systemd/user/tokenelo-daemon.service.d/override.conf'] },
      { needDaemonReload: 'yes' },
      { execStartArgv: null },
    ];
    for (const mismatch of mismatches) {
      const changed = evidence();
      const p = plan(changed);
      changed.service.unitFile = file(p.policy.unitPath, p.policy.unitContents);
      changed.service.manager = managerFor(p, mismatch);
      changed.service.enabled = 'disabled';
      changed.service.active = 'inactive';
      expect(() => plan(changed)).toThrow();
    }
  });

  it('refuses foreign unit, tray, or enablement objects without claiming ownership', () => {
    const base = evidence();
    const p = plan(base);
    const foreignUnit = structuredClone(base);
    foreignUnit.service.unitFile = file(p.policy.unitPath, p.policy.unitContents + '# edited\n');
    foreignUnit.service.manager = managerFor(p);
    foreignUnit.service.enabled = 'disabled';
    foreignUnit.service.active = 'inactive';
    expect(() => plan(foreignUnit)).toThrow(/foreign/u);

    const foreignTray = structuredClone(base);
    foreignTray.service.trayAutostartFile = file(p.policy.autostartPath, p.policy.autostartContents, 0o600);
    expect(() => plan(foreignTray)).toThrow(/foreign/u);

    const foreignLink = structuredClone(base);
    foreignLink.service.enablementLink = {
      identity: id(p.policy.enablementLinkPath, 'symlink', 0o777, uid, '/foreign/unit.service'),
      linkTarget: '/foreign/unit.service',
    };
    foreignLink.service.enabled = 'enabled';
    expect(() => plan(foreignLink)).toThrow(/exact Tokenelo link/u);
  });

  it('requires physical account, XDG, and package identities and rejects profile overrides', () => {
    const homeMismatch = evidence();
    homeMismatch.runtimeHome = '/home/other';
    expect(() => plan(homeMismatch)).toThrow(/HOME/u);

    const homeAlias = evidence();
    homeAlias.accountHomeIdentity = id(home, 'directory', 0o755, uid, '/mnt/alias');
    expect(() => plan(homeAlias)).toThrow(/physical/u);

    const profileOverride = evidence();
    profileOverride.tokeneloHomeEnvironment = '/tmp/profile';
    expect(() => plan(profileOverride)).toThrow(/TOKENELO_HOME/u);

    const xdgAlias = evidence();
    xdgAlias.configHomeIdentity = id(home + '/.config', 'directory', 0o700, uid, '/tmp/config-alias');
    expect(() => plan(xdgAlias)).toThrow(/physical/u);

    const packageAlias = evidence();
    packageAlias.package.daemonEntry = id(
      packageRoot + '/resources/app/dist/daemon/main.js',
      'file',
      0o664,
      uid,
      '/tmp/daemon.js',
    );
    expect(() => plan(packageAlias)).toThrow(/physical/u);
  });

  it('requires physical native env and refuses writable package inputs', () => {
    const envAlias = evidence();
    envAlias.systemEnvIdentity = id('/usr/bin/env', 'file', 0o755, 0, '/bin/env');
    expect(() => plan(envAlias)).toThrow(/physical object/u);

    const unownedEnv = evidence();
    unownedEnv.systemEnvIdentity.uid = uid;
    expect(() => plan(unownedEnv)).toThrow(/physical object/u);

    const writableEnv = evidence();
    writableEnv.systemEnvIdentity.mode = 0o775;
    expect(() => plan(writableEnv)).toThrow(/physical.*env/u);

    const writableInputs: Array<(value: LinuxLifecyclePlanningEvidence) => void> = [
      value => { value.package.packageJson.identity.mode = 0o664; },
      value => { value.package.lifecycleEntry.mode = 0o664; },
      value => { value.package.daemonEntry.mode = 0o664; },
      value => { value.package.trayEntry.mode = 0o664; },
      value => { value.package.packageJson.identity.mode = 0o646; },
    ];
    for (const makeWritable of writableInputs) {
      const changed = evidence();
      makeWritable(changed);
      expect(() => plan(changed)).toThrow(/group- or world-writable/u);
    }
  });

  it('fails closed when the ELF or sandbox assessment is not qualified', () => {
    const badElf = evidence();
    badElf.package.executableBasename = 'electron';
    expect(() => plan(badElf)).toThrow(/ELF/u);

    const unknownSandbox = evidence();
    unknownSandbox.package.sandboxCapability = 'unknown';
    expect(() => plan(unknownSandbox)).toThrow(/sandbox capability is unknown/u);

    const badSandboxMode = evidence();
    badSandboxMode.package.sandbox.mode = 0o4755;
    expect(() => plan(badSandboxMode)).toThrow(/user-namespace sandbox/u);
  });

  it('produces an uninstall plan only from exact owned files and retains their recovery identity', () => {
    const e = evidence();
    const initial = withInstalledState(e);
    const result = plan(e, 'uninstall');
    const kinds = result.steps.map(step => step.kind);

    expect(result.result).toBe('plan-transaction');
    expect(result.recovery.identitySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.recovery.immutableBackups[0]).toMatchObject({
      sourcePath: initial.policy.unitPath,
      sha256: initial.policy.unitSha256,
      mode: 0o644,
    });
    expect(kinds.indexOf('stop-exact-unit')).toBeLessThan(kinds.indexOf('retire-owned-file-to-recovery'));
    expect(kinds).toContain('remove-exact-enablement-link');
    expect(kinds).toContain('verify-final-state');
    expect(kinds.at(-1)).toBe('release-lock-after-verification');
  });

  it('returns no-op plans for exact installed and absent states', () => {
    const installed = evidence();
    withInstalledState(installed);
    const current = plan(installed);
    expect(current.result).toBe('already-current');
    expect(current.steps).toEqual([]);

    const absent = plan(evidence(), 'uninstall');
    expect(absent.result).toBe('already-absent');
    expect(absent.steps).toEqual([]);
  });

  it('rejects implicit or malformed operations', () => {
    const e = evidence();
    expect(() => planLinuxServiceLifecycle({ evidence: e } as LinuxLifecyclePlanningInput)).toThrow(/explicit/u);
    expect(() => planLinuxServiceLifecycle({ operation: 'install', evidence: e, automatic: true } as unknown as LinuxLifecyclePlanningInput)).toThrow(/explicit/u);
  });
});
