import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const scratchRoots: string[] = [];

function ensureFixtureDirectoryTree(root: string, directory: string, mode = 0o700): void {
  const physicalRoot = path.resolve(root);
  const target = path.resolve(directory);
  const relative = path.relative(physicalRoot, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Fixture directory escaped its root: ${directory}`);
  }
  let current = physicalRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode });
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Fixture path is not a physical directory: ${current}`);
    }
    fs.chmodSync(current, mode);
    const actualMode = fs.statSync(current).mode & 0o777;
    if (actualMode !== mode) {
      throw new Error(`Fixture directory mode mismatch at ${current}: expected ${mode.toString(8)}, got ${actualMode.toString(8)}`);
    }
  }
}

function writeFixtureServiceFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const actualMode = fs.statSync(file).mode & 0o777;
  if (actualMode !== 0o644) {
    throw new Error(`Fixture service file mode mismatch at ${file}: expected 644, got ${actualMode.toString(8)}`);
  }
}

function copyLinuxHelper(script: string, callerUmask?: string): void {
  const source = fs.readFileSync(path.resolve('scripts/install-service-linux.sh'), 'utf8');
  let isolated = source
    .replaceAll('/usr/bin/getent passwd', '"$TOKENELO_TEST_GETENT" passwd')
    .replaceAll('/usr/bin/stat -c', '"$TOKENELO_TEST_STAT" -c');
  if (callerUmask !== undefined) {
    expect(callerUmask).toMatch(/^[0-7]{3,4}$/);
    isolated = isolated.replace('set -euo pipefail\n', `set -euo pipefail\numask ${callerUmask}\n`);
  }
  expect(isolated).not.toBe(source);
  expect(isolated).toContain('"$TOKENELO_TEST_GETENT" passwd');
  expect(isolated).not.toContain('/usr/bin/getent passwd');
  expect(isolated).toContain('"$TOKENELO_TEST_STAT" -c');
  expect(isolated).not.toContain('/usr/bin/stat -c');
  fs.writeFileSync(script, isolated);
}

function writeLinuxIdentityMocks(mocks: string, accountHome: string, sandboxStat = 'root 4755') {
  const uid = process.getuid!();
  const getent = path.join(mocks, 'getent-for-test');
  const stat = path.join(mocks, 'stat');
  fs.writeFileSync(getent, [
    '#!/bin/sh',
    'set -eu',
    'printf "tokenelo-test:x:%s:1000::%s:/bin/sh\\n" "$TOKENELO_TEST_UID" "$TOKENELO_TEST_ACCOUNT_HOME"',
    '',
  ].join('\n'), { mode: 0o700 });
  fs.writeFileSync(stat, [
    '#!/bin/sh',
    'set -eu',
    '[ "$1" = "-c" ] || exit 2',
    'case "$2" in',
    '  "%u %a")',
    '    exec /usr/bin/stat -c "%u %a" -- "$4" ;;',
    '  "%U %a") printf "%s\\n" "$TOKENELO_TEST_SANDBOX_STAT" ;;',
    '  "%u %F") printf "%s symbolic link\\n" "$TOKENELO_TEST_UID" ;;',
    '  *) exit 2 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  return {
    uid,
    getent,
    env: {
      TOKENELO_TEST_UID: String(uid),
      TOKENELO_TEST_ACCOUNT_HOME: accountHome,
      TOKENELO_TEST_GETENT: getent,
      TOKENELO_TEST_STAT: stat,
      TOKENELO_TEST_SANDBOX_STAT: sandboxStat,
    },
  };
}

function createInstallRollbackFixture(options: {
  enabled?: 'enabled' | 'disabled';
  active?: 'active' | 'inactive';
  failEnable?: boolean;
  failDisable?: boolean;
  failStop?: boolean;
  failReloadOnce?: boolean;
  failStartAfterActivation?: boolean;
  failAutostartRename?: boolean;
  externalEdit?: 'unit' | 'autostart';
  callerUmask?: string;
  failProvision?: boolean;
} = {}) {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linux-rollback-')));
  scratchRoots.push(scratch);
  const repo = path.join(scratch, 'repo');
  const scripts = path.join(repo, 'scripts');
  const reviewHome = path.join(scratch, 'review-profile');
  const xdg = path.join(reviewHome, '.config');
  const mocks = path.join(scratch, 'mock-bin');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(mocks, { recursive: true });
  ensureFixtureDirectoryTree(scratch, reviewHome);

  const script = path.join(scripts, 'install-service-linux.sh');
  copyLinuxHelper(script, options.callerUmask);

  const unit = path.join(xdg, 'systemd/user/tokenelo-daemon.service');
  const autostart = path.join(xdg, 'autostart/tokenelo-tray.desktop');
  const daemon = path.join(repo, 'dist/daemon/main.js');
  const tray = path.join(repo, 'dist/tray/main.js');
  const electron = path.join(repo, 'node_modules/electron/dist/electron');
  const sandbox = path.join(repo, 'node_modules/electron/dist/chrome-sandbox');
  for (const entry of [daemon, tray, electron, sandbox]) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '', { mode: 0o700 });
  }

  const calls = path.join(scratch, 'service.calls');
  const pkillCalls = path.join(scratch, 'pkill.calls');
  const sudoCalls = path.join(scratch, 'sudo.calls');
  const enabledState = path.join(scratch, 'enabled.state');
  const activeState = path.join(scratch, 'active.state');
  const fragmentState = path.join(scratch, 'fragment.state');
  const enablementLink = path.join(xdg, 'systemd/user/default.target.wants/tokenelo-daemon.service');
  const reloadFailureMarker = path.join(scratch, 'reload.failed');
  const uninstallReloadFailureMarker = path.join(scratch, 'uninstall-reload.failed');
  fs.writeFileSync(enabledState, options.enabled ?? 'disabled');
  fs.writeFileSync(activeState, options.active ?? 'inactive');
  fs.writeFileSync(fragmentState, '');
  const identity = writeLinuxIdentityMocks(mocks, reviewHome);
  if ((options.enabled ?? 'disabled') === 'enabled') {
    ensureFixtureDirectoryTree(reviewHome, path.dirname(enablementLink));
    fs.symlinkSync(path.join(xdg, 'systemd/user/tokenelo-daemon.service'), enablementLink);
  }

  fs.writeFileSync(path.join(mocks, 'systemctl'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_CALLS"',
    'case "$*" in',
    '  "--user is-enabled tokenelo-daemon.service")',
    '    state=$(cat "$TOKENELO_TEST_ENABLED_STATE"); [ -L "$TOKENELO_TEST_ENABLEMENT_LINK" ] && state=enabled',
    '    if [ -L "$TOKENELO_TEST_ENABLEMENT_LINK" ]; then state=enabled; elif [ "$state" = "enabled" ]; then state=disabled; fi',
    '    printf "%s\\n" "$state"',
    '    [ "$state" = "enabled" ] && exit 0 || exit 1 ;;',
    '  "--user is-active tokenelo-daemon.service")',
    '    state=$(cat "$TOKENELO_TEST_ACTIVE_STATE")',
    '    printf "%s\\n" "$state"',
    '    [ "$state" = "active" ] && exit 0 || exit 3 ;;',
    '  "--user show --property=FragmentPath --value tokenelo-daemon.service")',
    '    cat "$TOKENELO_TEST_FRAGMENT_STATE"; exit 0 ;;',
    '  "--user show --property=ExecStart --value tokenelo-daemon.service")',
    '    printf "%s\\n" "$TOKENELO_TEST_EXECSTART"; exit 0 ;;',
    '  "--user show --property=DropInPaths --value tokenelo-daemon.service")',
    '    exit 0 ;;',
    '  "--user show --property=NeedDaemonReload --value tokenelo-daemon.service")',
    '    printf "no\\n"; exit 0 ;;',
    '  "--user daemon-reload")',
    '    if [ "${TOKENELO_TEST_FAIL_RELOAD_ONCE:-0}" = "1" ] && [ ! -e "$TOKENELO_TEST_RELOAD_FAILURE_MARKER" ]; then',
    '      : > "$TOKENELO_TEST_RELOAD_FAILURE_MARKER"; exit 71',
    '    fi',
    '    if [ "${TOKENELO_TEST_FAIL_UNINSTALL_RELOAD:-0}" = "1" ] && [ ! -f "$TOKENELO_TEST_UNIT_PATH" ] && [ ! -e "$TOKENELO_TEST_UNINSTALL_RELOAD_FAILURE_MARKER" ]; then',
    '      : > "$TOKENELO_TEST_UNINSTALL_RELOAD_FAILURE_MARKER"',
    '      if [ "${TOKENELO_TEST_EDIT_AUTOSTART_ON_UNINSTALL_RELOAD:-0}" = "1" ]; then printf "concurrent autostart edit\\n" > "$TOKENELO_TEST_AUTOSTART_PATH"; fi',
    '      exit 74',
    '    fi',
    '    if [ -f "$TOKENELO_TEST_UNIT_PATH" ]; then printf "%s\\n" "$TOKENELO_TEST_UNIT_PATH" > "$TOKENELO_TEST_FRAGMENT_STATE"; else : > "$TOKENELO_TEST_FRAGMENT_STATE"; fi',
    '    exit 0 ;;',
    '  "--user enable tokenelo-daemon.service")',
    '    printf "enabled" > "$TOKENELO_TEST_ENABLED_STATE"',
    '    mkdir -p "$(dirname "$TOKENELO_TEST_ENABLEMENT_LINK")"',
    '    ln -sfn "$TOKENELO_TEST_UNIT_PATH" "$TOKENELO_TEST_ENABLEMENT_LINK"',
    '    if [ "${TOKENELO_TEST_EXTERNAL_EDIT:-}" = "unit" ]; then printf "concurrent unit edit\\n" > "$TOKENELO_TEST_UNIT_PATH"; fi',
    '    if [ "${TOKENELO_TEST_EXTERNAL_EDIT:-}" = "autostart" ]; then printf "concurrent autostart edit\\n" > "$TOKENELO_TEST_AUTOSTART_PATH"; fi',
    '    [ "${TOKENELO_TEST_FAIL_ENABLE:-0}" = "1" ] && exit 72',
    '    exit 0 ;;',
    '  "--user start tokenelo-daemon.service")',
    '    printf "active" > "$TOKENELO_TEST_ACTIVE_STATE"',
    '    [ "${TOKENELO_TEST_FAIL_START_AFTER_ACTIVATION:-0}" = "1" ] && exit 73',
    '    exit 0 ;;',
    '  "--user stop tokenelo-daemon.service")',
    '    [ "${TOKENELO_TEST_FAIL_STOP:-0}" = "1" ] && exit 81',
    '    printf "inactive" > "$TOKENELO_TEST_ACTIVE_STATE"; exit 0 ;;',
    '  "--user disable tokenelo-daemon.service")',
    '    [ "${TOKENELO_TEST_FAIL_DISABLE:-0}" = "1" ] && exit 82',
    '    printf "disabled" > "$TOKENELO_TEST_ENABLED_STATE"',
    '    rm -f "$TOKENELO_TEST_ENABLEMENT_LINK"; exit 0 ;;',
    '  "--user disable --now tokenelo-daemon.service")',
    '    printf "disabled" > "$TOKENELO_TEST_ENABLED_STATE"',
    '    rm -f "$TOKENELO_TEST_ENABLEMENT_LINK"',
    '    printf "inactive" > "$TOKENELO_TEST_ACTIVE_STATE"; exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o700 });
  fs.writeFileSync(path.join(mocks, 'pkill'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_PKILL_CALLS"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(mocks, 'sudo'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_SUDO_CALLS"\nexit 97\n', { mode: 0o700 });
  fs.writeFileSync(path.join(mocks, 'mv'), [
    '#!/bin/sh',
    'after_separator=0',
    'source=""',
    'dest=""',
    'for arg do',
    '  if [ "$arg" = "--" ]; then after_separator=1; continue; fi',
    '  if [ "$after_separator" = "1" ]; then if [ -z "$source" ]; then source="$arg"; else dest="$arg"; fi; else case "$arg" in -*) ;; *) if [ -z "$source" ]; then source="$arg"; else dest="$arg"; fi ;; esac; fi',
    'done',
    'if [ -n "${TOKENELO_TEST_FAIL_MV_DEST:-}" ] && [ "$dest" = "$TOKENELO_TEST_FAIL_MV_DEST" ]; then exit 88; fi',
    'if [ -n "${TOKENELO_TEST_FAIL_MV_SOURCE:-}" ] && [ "$source" = "$TOKENELO_TEST_FAIL_MV_SOURCE" ]; then exit 88; fi',
    'exec /bin/mv "$@"',
  ].join('\n') + '\n', { mode: 0o700 });
  fs.writeFileSync(path.join(mocks, 'rm'), [
    '#!/bin/sh',
    'set -eu',
    'destination=""',
    'for arg do case "$arg" in -f|-- ) ;; *) destination="$arg" ;; esac; done',
    '[ -z "${TOKENELO_TEST_FAIL_RM_PATH:-}" ] || [ "$destination" != "$TOKENELO_TEST_FAIL_RM_PATH" ] || exit 89',
    '/bin/rm "$@"',
    'if [ "$destination" = "$TOKENELO_TEST_ENABLEMENT_LINK" ]; then printf "disabled" > "$TOKENELO_TEST_ENABLED_STATE"; fi',
  ].join('\n') + '\n', { mode: 0o700 });
  fs.writeFileSync(path.join(mocks, 'mkdir'), [
    '#!/bin/sh',
    'set -eu',
    'if [ -n "${TOKENELO_TEST_FAIL_MKDIR_PATH:-}" ]; then',
    '  for arg do',
    '    if [ "$arg" = "$TOKENELO_TEST_FAIL_MKDIR_PATH" ]; then',
    '      /bin/mkdir -p -- "$TOKENELO_TEST_PARTIAL_CREATED_DIR"',
    '      /usr/bin/stat -c "%a" -- "$TOKENELO_TEST_PARTIAL_CREATED_DIR" > "$TOKENELO_TEST_PARTIAL_MODE_FILE"',
    '      exit 88',
    '    fi',
    '  done',
    'fi',
    'exec /bin/mkdir "$@"',
  ].join('\n') + '\n', { mode: 0o700 });

  const execStart = `{ path=${process.execPath} ; argv[]=${process.execPath} ${daemon} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;
  const env = {
    ...process.env,
    HOME: reviewHome,
    XDG_CONFIG_HOME: xdg,
    PATH: mocks + path.delimiter + (process.env.PATH ?? ''),
    TOKENELO_SERVICE_TEST_CALLS: calls,
    TOKENELO_SERVICE_TEST_PKILL_CALLS: pkillCalls,
    TOKENELO_SERVICE_TEST_SUDO_CALLS: sudoCalls,
    TOKENELO_TEST_ENABLED_STATE: enabledState,
    TOKENELO_TEST_ACTIVE_STATE: activeState,
    TOKENELO_TEST_FRAGMENT_STATE: fragmentState,
    TOKENELO_TEST_RELOAD_FAILURE_MARKER: reloadFailureMarker,
    TOKENELO_TEST_UNINSTALL_RELOAD_FAILURE_MARKER: uninstallReloadFailureMarker,
    TOKENELO_TEST_UNIT_PATH: unit,
    TOKENELO_TEST_AUTOSTART_PATH: autostart,
    TOKENELO_TEST_ENABLEMENT_LINK: enablementLink,
    TOKENELO_TEST_EXECSTART: execStart,
    TOKENELO_TEST_FAIL_UNINSTALL_RELOAD: '0',
    TOKENELO_TEST_EDIT_AUTOSTART_ON_UNINSTALL_RELOAD: '0',
    TOKENELO_TEST_FAIL_RM_PATH: '',
    TOKENELO_TEST_FAIL_MV_SOURCE: '',
    TOKENELO_TEST_FAIL_MKDIR_PATH: options.failProvision ? path.dirname(unit) : '',
    TOKENELO_TEST_PARTIAL_CREATED_DIR: path.join(xdg, 'systemd'),
    TOKENELO_TEST_PARTIAL_MODE_FILE: path.join(scratch, 'partial-dir.mode'),
    ...identity.env,
    TOKENELO_TEST_FAIL_ENABLE: options.failEnable ? '1' : '0',
    TOKENELO_TEST_FAIL_DISABLE: options.failDisable ? '1' : '0',
    TOKENELO_TEST_FAIL_STOP: options.failStop ? '1' : '0',
    TOKENELO_TEST_FAIL_RELOAD_ONCE: options.failReloadOnce ? '1' : '0',
    TOKENELO_TEST_FAIL_START_AFTER_ACTIVATION: options.failStartAfterActivation ? '1' : '0',
    TOKENELO_TEST_FAIL_MV_DEST: options.failAutostartRename ? autostart : '',
    TOKENELO_TEST_EXTERNAL_EDIT: options.externalEdit ?? '',
  };

  return {
    scratch, repo, reviewHome, xdg, mocks, script, unit, autostart, calls, pkillCalls, sudoCalls, enablementLink,
    enabledState, activeState, fragmentState, env,
  };
}

function prepareExistingServiceDirectories(fixture: ReturnType<typeof createInstallRollbackFixture>): void {
  ensureFixtureDirectoryTree(fixture.reviewHome, path.dirname(fixture.unit));
  ensureFixtureDirectoryTree(fixture.reviewHome, path.dirname(fixture.autostart));
}

function installLinuxFixture(fixture: ReturnType<typeof createInstallRollbackFixture>): void {
  execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
    env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
  });
}

function tryUninstallLinuxFixture(
  fixture: ReturnType<typeof createInstallRollbackFixture>,
  env: NodeJS.ProcessEnv = fixture.env,
): unknown {
  try {
    execFileSync('bash', [fixture.script, '--uninstall'], {
      env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

function executionErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
  return `${error.message}\n${stderr?.toString() ?? ''}`;
}

function readFakeManagerEnablement(fixture: ReturnType<typeof createInstallRollbackFixture>): string {
  return execFileSync(path.join(fixture.mocks, 'systemctl'), ['--user', 'is-enabled', 'tokenelo-daemon.service'], {
    env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
  }).toString('utf8').trim();
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Linux service installation uses GNU coreutils (stat -c/readlink -f); this policy suite runs on Linux, with macOS/Windows service behavior covered separately.
describe.skipIf(process.platform !== 'linux')('Linux user service policy (Linux host only)', () => {
  it('installs and removes only user startup entries while retaining application data', () => {
    const fixture = createInstallRollbackFixture();
    const userData = path.join(fixture.repo, 'data/tokenelo.sqlite');
    const log = path.join(fixture.repo, 'logs/daemon.log');
    fs.mkdirSync(path.dirname(userData), { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(userData, 'fixture ledger sentinel');
    fs.writeFileSync(log, 'fixture log sentinel');
    const daemon = path.join(fixture.repo, 'dist/daemon/main.js');
    const tray = path.join(fixture.repo, 'dist/tray/main.js');
    const electron = path.join(fixture.repo, 'node_modules/electron/dist/electron');
    execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
      env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
    });

    const unitText = fs.readFileSync(fixture.unit, 'utf8');
    const autostartText = fs.readFileSync(fixture.autostart, 'utf8');
    expect(unitText).toContain('ExecStart=' + process.execPath + ' ' + daemon);
    expect(unitText).toContain('Restart=on-failure');
    expect(autostartText).toContain('Name=Tokenelo');
    expect(autostartText).toContain(electron + ' --ozone-platform-hint=auto ' + tray);
    expect(fs.existsSync(fixture.sudoCalls)).toBe(false);
    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(calls.slice(0, 6)).toEqual([
      '--user is-enabled tokenelo-daemon.service',
      '--user is-active tokenelo-daemon.service',
      '--user show --property=FragmentPath --value tokenelo-daemon.service',
      '--user daemon-reload',
      '--user enable tokenelo-daemon.service',
      '--user start tokenelo-daemon.service',
    ]);
    expect(fixture.env.HOME).toBe(fixture.reviewHome);
    expect(path.resolve(fixture.unit).startsWith(path.resolve(fixture.scratch) + path.sep)).toBe(true);
    expect(path.resolve(fixture.autostart).startsWith(path.resolve(fixture.scratch) + path.sep)).toBe(true);
    expect(path.resolve(fixture.enablementLink).startsWith(path.resolve(fixture.scratch) + path.sep)).toBe(true);

    expect(tryUninstallLinuxFixture(fixture)).toBeUndefined();
    expect(fs.existsSync(fixture.unit)).toBe(false);
    expect(fs.existsSync(fixture.autostart)).toBe(false);
    expect(fs.readFileSync(userData, 'utf8')).toBe('fixture ledger sentinel');
    expect(fs.readFileSync(log, 'utf8')).toBe('fixture log sentinel');
    const finalCalls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(finalCalls.slice(0, 6)).toEqual([
      '--user is-enabled tokenelo-daemon.service',
      '--user is-active tokenelo-daemon.service',
      '--user show --property=FragmentPath --value tokenelo-daemon.service',
      '--user daemon-reload',
      '--user enable tokenelo-daemon.service',
      '--user start tokenelo-daemon.service',
    ]);
    const uninstallCalls = finalCalls.slice(6);
    expect(uninstallCalls).toContain('--user stop tokenelo-daemon.service');
    expect(uninstallCalls.filter((call) => call === '--user daemon-reload')).toHaveLength(2);
    expect(uninstallCalls.filter((call) => call === '--user show --property=ExecStart --value tokenelo-daemon.service')).toHaveLength(5);
    expect(uninstallCalls).not.toContain('--user disable tokenelo-daemon.service');
    expect(uninstallCalls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
    expect(fs.existsSync(path.join(fixture.scratch, '.tokenelo-linux-service-transaction'))).toBe(false);
  });

  it('keeps newly created service directories private when the caller umask is 000', () => {
    const fixture = createInstallRollbackFixture({ callerUmask: '000' });
    installLinuxFixture(fixture);

    const mode = (entry: string) => fs.statSync(entry).mode & 0o777;
    expect(mode(fixture.xdg)).toBe(0o700);
    expect(mode(path.dirname(fixture.unit))).toBe(0o700);
    expect(mode(path.dirname(fixture.autostart))).toBe(0o700);
    expect(mode(path.dirname(fixture.enablementLink))).toBe(0o700);
    expect(mode(fixture.unit)).toBe(0o644);
    expect(mode(fixture.autostart)).toBe(0o644);
  });

  it('removes only newly created empty service directories after a failed provision under umask 000', () => {
    const fixture = createInstallRollbackFixture({ callerUmask: '000', failProvision: true });
    ensureFixtureDirectoryTree(fixture.reviewHome, fixture.xdg, 0o755);
    const sentinel = path.join(fixture.xdg, 'preexisting-sentinel');
    fs.writeFileSync(sentinel, 'keep existing user config', { mode: 0o600 });
    const originalXdgMode = fs.statSync(fixture.xdg).mode & 0o777;

    let installError: unknown;
    try {
      installLinuxFixture(fixture);
    } catch (error) {
      installError = error;
    }

    expect(installError).toBeDefined();
    expect(executionErrorText(installError)).toContain('could not create Tokenelo user service directories');
    expect(fs.readFileSync(fixture.env.TOKENELO_TEST_PARTIAL_MODE_FILE!, 'utf8').trim()).toBe('700');
    expect(fs.existsSync(path.join(fixture.xdg, 'systemd'))).toBe(false);
    expect(fs.existsSync(fixture.unit)).toBe(false);
    expect(fs.existsSync(fixture.autostart)).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep existing user config');
    expect(fs.statSync(fixture.xdg).mode & 0o777).toBe(originalXdgMode);
    expect(fs.readdirSync(fixture.xdg)).toEqual(['preexisting-sentinel']);
    expect(fs.existsSync(fixture.calls)).toBe(false);
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);
  });

  it('rejects alternate HOME and symlinked XDG roots before lock or manager access', () => {
    const fixture = createInstallRollbackFixture();
    const alternateHome = path.join(fixture.scratch, 'alternate-home');
    const xdgAlias = path.join(fixture.scratch, 'config-alias');
    ensureFixtureDirectoryTree(fixture.scratch, alternateHome);
    ensureFixtureDirectoryTree(fixture.reviewHome, fixture.xdg);
    fs.symlinkSync(fixture.xdg, xdgAlias, 'dir');

    const alternateHomeError = tryUninstallLinuxFixture(fixture, {
      ...fixture.env,
      HOME: alternateHome,
    });
    expect(alternateHomeError).toBeDefined();
    expect(fs.existsSync(fixture.calls)).toBe(false);
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);

    const symlinkRootError = tryUninstallLinuxFixture(fixture, {
      ...fixture.env,
      XDG_CONFIG_HOME: xdgAlias,
    });
    expect(symlinkRootError).toBeDefined();
    expect(fs.existsSync(fixture.calls)).toBe(false);
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);
    expect(fs.readdirSync(fixture.scratch).sort()).toContain('config-alias');
  });

  it('refuses a foreign loaded fragment before stopping or retiring package files', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active' });
    installLinuxFixture(fixture);
    const unitBefore = fs.readFileSync(fixture.unit, 'utf8');
    const autostartBefore = fs.readFileSync(fixture.autostart, 'utf8');
    const foreignFragment = path.join(fixture.scratch, 'foreign-tokenelo.service');
    fs.writeFileSync(fixture.fragmentState, foreignFragment);
    const callCountBefore = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').length;

    const uninstallError = tryUninstallLinuxFixture(fixture);
    expect(uninstallError).toBeDefined();
    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').slice(callCountBefore);
    expect(calls).toContain('--user show --property=FragmentPath --value tokenelo-daemon.service');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable tokenelo-daemon.service');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe(autostartBefore);
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
  });

  it('refuses a foreign loaded ExecStart action before stopping the unit', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active' });
    installLinuxFixture(fixture);
    const unitBefore = fs.readFileSync(fixture.unit, 'utf8');
    const callCountBefore = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').length;
    const foreignAction = `{ path=/usr/bin/false ; argv[]=/usr/bin/false ${path.join(fixture.repo, 'dist/daemon/main.js')} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`;

    const uninstallError = tryUninstallLinuxFixture(fixture, {
      ...fixture.env,
      TOKENELO_TEST_EXECSTART: foreignAction,
    });
    expect(uninstallError).toBeDefined();
    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').slice(callCountBefore);
    expect(calls).toContain('--user show --property=ExecStart --value tokenelo-daemon.service');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);
  });

  it('refuses foreign tray bytes and symlinked service entries without touching service state', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active' });
    installLinuxFixture(fixture);
    const unitBefore = fs.readFileSync(fixture.unit, 'utf8');
    const autostartBefore = fs.readFileSync(fixture.autostart, 'utf8');
    fs.writeFileSync(fixture.autostart, 'foreign tray action\n');
    const callCountBefore = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').length;

    const trayError = tryUninstallLinuxFixture(fixture);
    expect(trayError).toBeDefined();
    expect(fs.readFileSync(fixture.calls, 'utf8').trim().split('\n')).toHaveLength(callCountBefore);
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('foreign tray action\n');
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);

    fs.writeFileSync(fixture.autostart, autostartBefore);
    fs.rmSync(fixture.autostart);
    fs.symlinkSync(path.join(fixture.scratch, 'foreign-tray.desktop'), fixture.autostart);
    fs.writeFileSync(path.join(fixture.scratch, 'foreign-tray.desktop'), 'foreign symlink target\n');
    const symlinkError = tryUninstallLinuxFixture(fixture);
    expect(symlinkError).toBeDefined();
    expect(fs.lstatSync(fixture.autostart).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.readFileSync(fixture.calls, 'utf8').trim().split('\n')).toHaveLength(callCountBefore);
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
  });

  it('does not ignore a failed stop or retire entries after systemd refuses it', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active' });
    installLinuxFixture(fixture);
    const unitBefore = fs.readFileSync(fixture.unit, 'utf8');
    const autostartBefore = fs.readFileSync(fixture.autostart, 'utf8');
    const uninstallError = tryUninstallLinuxFixture(fixture, {
      ...fixture.env,
      TOKENELO_TEST_FAIL_STOP: '1',
    });

    expect(uninstallError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe(autostartBefore);
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('enabled');
    const uninstallCalls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n').slice(6);
    expect(uninstallCalls).toContain('--user stop tokenelo-daemon.service');
    expect(uninstallCalls).not.toContain('--user disable tokenelo-daemon.service');
    expect(uninstallCalls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(uninstallCalls).not.toContain('--user daemon-reload');
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);
  });

  it('restores service state when exact unit retirement fails', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active' });
    installLinuxFixture(fixture);
    const unitBefore = fs.readFileSync(fixture.unit, 'utf8');
    const autostartBefore = fs.readFileSync(fixture.autostart, 'utf8');

    const uninstallError = tryUninstallLinuxFixture(fixture, {
      ...fixture.env,
      TOKENELO_TEST_FAIL_MV_SOURCE: fixture.unit,
    });
    expect(uninstallError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe(autostartBefore);
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(readFakeManagerEnablement(fixture)).toBe('enabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(fs.existsSync(path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction'))).toBe(false);
    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(calls).toContain('--user stop tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
  });

  it('retains prior tray bytes and a recovery lock when concurrent foreign state blocks rollback', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active' });
    installLinuxFixture(fixture);
    const unitBefore = fs.readFileSync(fixture.unit, 'utf8');
    const autostartBefore = fs.readFileSync(fixture.autostart, 'utf8');
    const uninstallError = tryUninstallLinuxFixture(fixture, {
      ...fixture.env,
      TOKENELO_TEST_FAIL_UNINSTALL_RELOAD: '1',
      TOKENELO_TEST_EDIT_AUTOSTART_ON_UNINSTALL_RELOAD: '1',
    });

    expect(uninstallError).toBeDefined();
    expect(executionErrorText(uninstallError)).toContain('rollback was incomplete');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe(unitBefore);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('concurrent autostart edit\n');
    expect(fs.existsSync(fixture.enablementLink)).toBe(true);
    expect(readFakeManagerEnablement(fixture)).toBe('enabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    const lockPath = path.join(fixture.reviewHome, '.tokenelo-linux-service-transaction');
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(path.join(lockPath, 'recovery.txt'), 'utf8')).toContain('rollback incomplete');
    const backups = fs.readdirSync(path.dirname(fixture.autostart))
      .filter((name) => name.startsWith('.tokenelo-tray.desktop.tokenelo-backup.'));
    expect(backups.length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(path.dirname(fixture.autostart), backups[0]), 'utf8')).toBe(autostartBefore);
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
  });
  it('preflights a missing tray runtime before registering the daemon service', () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linux-preflight-')));
    scratchRoots.push(scratch);
    const repo = path.join(scratch, 'repo');
    const scripts = path.join(repo, 'scripts');
    const reviewHome = path.join(scratch, 'review-profile');
    const xdg = path.join(reviewHome, '.config');
    const mocks = path.join(scratch, 'mock-bin');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(mocks, { recursive: true });
    ensureFixtureDirectoryTree(scratch, reviewHome);

    const script = path.join(scripts, 'install-service-linux.sh');
    copyLinuxHelper(script);
    for (const entry of [
      path.join(repo, 'dist/daemon/main.js'),
      path.join(repo, 'dist/tray/main.js'),
    ]) {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '');
    }

    const calls = path.join(scratch, 'service.calls');
    const sudoCalls = path.join(scratch, 'sudo.calls');
    const identity = writeLinuxIdentityMocks(mocks, reviewHome);
    fs.writeFileSync(path.join(mocks, 'systemctl'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_CALLS"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(mocks, 'sudo'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_SUDO_CALLS"\nexit 97\n', { mode: 0o700 });

    let installError: unknown;
    try {
      execFileSync('bash', [script, '--node', process.execPath, '--with-tray'], {
        env: {
          ...process.env,
          HOME: reviewHome,
          XDG_CONFIG_HOME: xdg,
          PATH: mocks + path.delimiter + (process.env.PATH ?? ''),
          TOKENELO_SERVICE_TEST_CALLS: calls,
          TOKENELO_SERVICE_TEST_SUDO_CALLS: sudoCalls,
          ...identity.env,
        },
        stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    expect(installError).toBeDefined();
    expect(executionErrorText(installError)).toContain('not found');
    expect(fs.existsSync(path.join(xdg, 'systemd/user/tokenelo-daemon.service'))).toBe(false);
    expect(fs.existsSync(path.join(xdg, 'autostart/tokenelo-tray.desktop'))).toBe(false);
    expect(fs.existsSync(calls)).toBe(false);
    expect(fs.existsSync(sudoCalls)).toBe(false);
  });
  it('does not register the daemon when sandbox preparation fails', () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-linux-sandbox-failure-')));
    scratchRoots.push(scratch);
    const repo = path.join(scratch, 'repo');
    const scripts = path.join(repo, 'scripts');
    const reviewHome = path.join(scratch, 'review-profile');
    const xdg = path.join(reviewHome, '.config');
    const mocks = path.join(scratch, 'mock-bin');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(mocks, { recursive: true });
    ensureFixtureDirectoryTree(scratch, reviewHome);

    const script = path.join(scripts, 'install-service-linux.sh');
    copyLinuxHelper(script);
    const sandbox = path.join(repo, 'node_modules/electron/dist/chrome-sandbox');
    for (const entry of [
      path.join(repo, 'dist/daemon/main.js'),
      path.join(repo, 'dist/tray/main.js'),
      path.join(repo, 'node_modules/electron/dist/electron'),
      sandbox,
    ]) {
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, '', { mode: 0o700 });
    }

    const calls = path.join(scratch, 'service.calls');
    const sudoCalls = path.join(scratch, 'sudo.calls');
    const identity = writeLinuxIdentityMocks(mocks, reviewHome, 'elo 755');
    fs.writeFileSync(path.join(mocks, 'systemctl'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_CALLS"\n', { mode: 0o700 });
    fs.writeFileSync(path.join(mocks, 'sudo'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_SUDO_CALLS"\nexit 97\n', { mode: 0o700 });

    let installError: unknown;
    try {
      execFileSync('bash', [script, '--node', process.execPath, '--with-tray'], {
        env: {
          ...process.env,
          HOME: reviewHome,
          XDG_CONFIG_HOME: xdg,
          PATH: mocks + path.delimiter + (process.env.PATH ?? ''),
          TOKENELO_SERVICE_TEST_CALLS: calls,
          TOKENELO_SERVICE_TEST_SUDO_CALLS: sudoCalls,
          ...identity.env,
        },
        stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    expect(installError).toBeDefined();
    expect(fs.existsSync(path.join(xdg, 'systemd/user/tokenelo-daemon.service'))).toBe(false);
    expect(fs.existsSync(path.join(xdg, 'autostart/tokenelo-tray.desktop'))).toBe(false);
    expect(fs.existsSync(calls)).toBe(false);
    expect(fs.readFileSync(sudoCalls, 'utf8').trim()).toBe('chown root:root ' + sandbox);
  });

  it('restores existing unit and autostart bytes when daemon-reload fails', () => {
    const fixture = createInstallRollbackFixture({ failReloadOnce: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    expect(installError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('prior unit bytes\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('disabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('inactive');
    expect(fs.readFileSync(fixture.calls, 'utf8').trim().split('\n')).toEqual([
      '--user is-enabled tokenelo-daemon.service',
      '--user is-active tokenelo-daemon.service',
      '--user show --property=FragmentPath --value tokenelo-daemon.service',
      '--user daemon-reload',
      '--user daemon-reload',
    ]);
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
    expect(fs.existsSync(fixture.sudoCalls)).toBe(false);
  });

  it('disables only a newly enabled candidate and restores prior bytes after enable fails', () => {
    const fixture = createInstallRollbackFixture({ failEnable: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(installError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('prior unit bytes\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('disabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('inactive');
    expect(calls).toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(calls).not.toContain('--user start tokenelo-daemon.service');
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
    expect(fs.existsSync(fixture.sudoCalls)).toBe(false);
  });

  it('leaves a previously enabled and active service running when enable fails', () => {
    const fixture = createInstallRollbackFixture({ enabled: 'enabled', active: 'active', failEnable: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(installError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('prior unit bytes\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('enabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
    expect(fs.existsSync(fixture.sudoCalls)).toBe(false);
  });

  it('restores the unit without systemd activation when the autostart rename fails', () => {
    const fixture = createInstallRollbackFixture({ failAutostartRename: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(installError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('prior unit bytes\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(calls).toEqual([
      '--user is-enabled tokenelo-daemon.service',
      '--user is-active tokenelo-daemon.service',
      '--user show --property=FragmentPath --value tokenelo-daemon.service',
    ]);
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
    expect(fs.existsSync(fixture.sudoCalls)).toBe(false);
  });

  it('stops and disables a newly activated candidate after start fails', () => {
    const fixture = createInstallRollbackFixture({ failStartAfterActivation: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    expect(installError).toBeDefined();
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('prior unit bytes\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('disabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('inactive');
    expect(calls).toContain('--user stop tokenelo-daemon.service');
    expect(calls).toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(fs.existsSync(fixture.pkillCalls)).toBe(false);
    expect(fs.existsSync(fixture.sudoCalls)).toBe(false);
  });

  it('preserves a concurrent unit edit and reports incomplete activation rollback', () => {
    const fixture = createInstallRollbackFixture({ failEnable: true, externalEdit: 'unit' });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    const backupName = fs.readdirSync(path.dirname(fixture.unit))
      .find((name) => name.startsWith('.tokenelo-daemon.service.tokenelo-backup.'));
    expect(installError).toBeDefined();
    expect(executionErrorText(installError)).toContain('rollback was incomplete');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('concurrent unit edit\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('enabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('inactive');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable tokenelo-daemon.service');
    expect(backupName).toBeDefined();
    if (backupName) {
      expect(fs.readFileSync(path.join(path.dirname(fixture.unit), backupName), 'utf8')).toBe('prior unit bytes\n');
    }
  });

  it('preserves a concurrent autostart edit while rolling back the unchanged candidate unit', () => {
    const fixture = createInstallRollbackFixture({ failEnable: true, externalEdit: 'autostart' });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    const backupName = fs.readdirSync(path.dirname(fixture.autostart))
      .find((name) => name.startsWith('.tokenelo-tray.desktop.tokenelo-backup.'));
    expect(installError).toBeDefined();
    expect(executionErrorText(installError)).toContain('rollback was incomplete');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toBe('prior unit bytes\n');
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('concurrent autostart edit\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('disabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('inactive');
    expect(calls).toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(backupName).toBeDefined();
    if (backupName) {
      expect(fs.readFileSync(path.join(path.dirname(fixture.autostart), backupName), 'utf8')).toBe('prior autostart bytes\n');
    }
  });

  it('keeps the candidate unit and prior backup when stopping the new service fails', () => {
    const fixture = createInstallRollbackFixture({ failStartAfterActivation: true, failStop: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    const backupName = fs.readdirSync(path.dirname(fixture.unit))
      .find((name) => name.startsWith('.tokenelo-daemon.service.tokenelo-backup.'));
    expect(installError).toBeDefined();
    expect(executionErrorText(installError)).toContain('rollback was incomplete');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toContain(`ExecStart=${process.execPath} ${path.join(fixture.repo, 'dist/daemon/main.js')}`);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('disabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('active');
    expect(calls).toContain('--user stop tokenelo-daemon.service');
    expect(calls).toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user disable --now tokenelo-daemon.service');
    expect(backupName).toBeDefined();
    if (backupName) {
      expect(fs.readFileSync(path.join(path.dirname(fixture.unit), backupName), 'utf8')).toBe('prior unit bytes\n');
    }
  });

  it('keeps the candidate unit and prior backup when disabling the new service fails', () => {
    const fixture = createInstallRollbackFixture({ failEnable: true, failDisable: true });
    prepareExistingServiceDirectories(fixture);
    writeFixtureServiceFile(fixture.unit, 'prior unit bytes\n');
    writeFixtureServiceFile(fixture.autostart, 'prior autostart bytes\n');

    let installError: unknown;
    try {
      execFileSync('bash', [fixture.script, '--node', process.execPath, '--with-tray'], {
        env: fixture.env, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
    } catch (error) {
      installError = error;
    }

    const calls = fs.readFileSync(fixture.calls, 'utf8').trim().split('\n');
    const backupName = fs.readdirSync(path.dirname(fixture.unit))
      .find((name) => name.startsWith('.tokenelo-daemon.service.tokenelo-backup.'));
    expect(installError).toBeDefined();
    expect(executionErrorText(installError)).toContain('rollback was incomplete');
    expect(fs.readFileSync(fixture.unit, 'utf8')).toContain(`ExecStart=${process.execPath} ${path.join(fixture.repo, 'dist/daemon/main.js')}`);
    expect(fs.readFileSync(fixture.autostart, 'utf8')).toBe('prior autostart bytes\n');
    expect(fs.readFileSync(fixture.enabledState, 'utf8')).toBe('enabled');
    expect(fs.readFileSync(fixture.activeState, 'utf8')).toBe('inactive');
    expect(fs.readFileSync(fixture.fragmentState, 'utf8').trim()).toBe(fixture.unit);
    expect(calls).toContain('--user disable tokenelo-daemon.service');
    expect(calls).not.toContain('--user stop tokenelo-daemon.service');
    expect(calls).not.toContain('--user start tokenelo-daemon.service');
    expect(backupName).toBeDefined();
    if (backupName) {
      expect(fs.readFileSync(path.join(path.dirname(fixture.unit), backupName), 'utf8')).toBe('prior unit bytes\n');
    }
  });
});
