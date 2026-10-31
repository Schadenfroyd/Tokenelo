import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform === 'win32')('macOS user service policy', () => {
  it('renders a Standard daemon and Interactive tray with the same user labels and entry points', () => {
    const scratchAlias = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-mac-policy-'));
    const scratch = fs.realpathSync(scratchAlias);
    try {
      const repo = path.join(scratch, 'repo'), scripts = path.join(repo, 'scripts');
      const reviewHome = path.join(scratch, 'review-profile'), mocks = path.join(scratch, 'mock-bin');
      const alternateHome = path.join(scratch, 'alternate-home');
      fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(mocks);
      const library = path.join(reviewHome, 'Library');
      fs.mkdirSync(library, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(alternateHome, 'Library'), { recursive: true, mode: 0o700 });
      const source = fs.readFileSync(path.resolve('scripts/install-service-macos.sh'), 'utf8');
      // The copied helper resolves an isolated account record and routes stat through a scoped
      // Darwin/Linux shim; the installed helper has no test-only environment boundary.
      const isolated = source
        .replace(
          'details="$(/usr/bin/stat -f \'%u %Lp\' "$directory")" || return 1',
          'details="$("$TOKENELO_SERVICE_TEST_STAT" "$directory")" || return 1',
        )
        .replace(
          '/usr/bin/dscacheutil -q user -a uid',
          '"$TOKENELO_SERVICE_TEST_ACCOUNT_LOOKUP" -q user -a uid',
        );
      expect(isolated).not.toBe(source);
      expect(isolated).toContain('details="$("$TOKENELO_SERVICE_TEST_STAT" "$directory")" || return 1');
      expect(isolated).toContain('"$TOKENELO_SERVICE_TEST_ACCOUNT_LOOKUP" -q user -a uid');
      expect(isolated).not.toContain('/usr/bin/stat -f');
      expect(isolated).not.toContain('/usr/bin/dscacheutil');
      const script = path.join(scripts, 'install-service-macos.sh'); fs.writeFileSync(script, isolated);
      const daemon = path.join(repo, 'dist/daemon/main.js'), tray = path.join(repo, 'dist/tray/main.js');
      for (const entry of [daemon, tray]) { fs.mkdirSync(path.dirname(entry), { recursive: true }); fs.writeFileSync(entry, ''); }
      const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
      fs.mkdirSync(path.dirname(electron), { recursive: true }); fs.writeFileSync(electron, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const calls = path.join(scratch, 'launchctl.calls');
      const childHome = path.join(scratch, 'child-home');
      const statShim = path.join(mocks, 'stat-for-test');
      const accountShim = path.join(mocks, 'account-home-for-test');
      fs.writeFileSync(path.join(mocks, 'launchctl'), [
        '#!/bin/sh',
        'printf "%s\\n" "$HOME" > "$TOKENELO_SERVICE_TEST_HOME"',
        'printf "%s\\n" "$*" >> "$TOKENELO_SERVICE_TEST_CALLS"',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o700 });
      fs.writeFileSync(statShim, [
        '#!/bin/sh',
        'set -eu',
        'case "$(uname -s)" in',
        '  Darwin) exec /usr/bin/stat -f "%u %Lp" "$1" ;;',
        '  Linux) exec /usr/bin/stat -c "%u %a" -- "$1" ;;',
        '  *) exit 2 ;;',
        'esac',
        '',
      ].join('\n'), { mode: 0o700 });
      fs.writeFileSync(accountShim, [
        '#!/bin/sh',
        'set -eu',
        'printf "uid: %s\\ndir: %s\\n" "$(id -u)" "$TOKENELO_SERVICE_TEST_ACCOUNT_HOME"',
        '',
      ].join('\n'), { mode: 0o700 });
      const env = {
        ...process.env,
        HOME: reviewHome,
        PATH: mocks + path.delimiter + process.env.PATH,
        TOKENELO_SERVICE_TEST_CALLS: calls,
        TOKENELO_SERVICE_TEST_HOME: childHome,
        TOKENELO_SERVICE_TEST_STAT: statShim,
        TOKENELO_SERVICE_TEST_ACCOUNT_LOOKUP: accountShim,
        TOKENELO_SERVICE_TEST_ACCOUNT_HOME: reviewHome,
      };
      const args = [script, '--node', process.execPath, '--with-tray'];
      const lock = path.join(library, '.tokenelo-launch-agent-transaction');

      // Alternate same-uid HOME is refused for install and uninstall before any lock or launchctl.
      const alternateEnv = { ...env, HOME: alternateHome };
      expect(() => execFileSync('bash', args, { env: alternateEnv, stdio: 'pipe', timeout: 10_000, windowsHide: true })).toThrow();
      expect(() => execFileSync('bash', [script, '--uninstall'], {
        env: alternateEnv, stdio: 'pipe', timeout: 10_000, windowsHide: true,
      })).toThrow();
      expect(fs.existsSync(calls)).toBe(false);
      expect(fs.existsSync(path.join(library, '.tokenelo-launch-agent-transaction'))).toBe(false);
      expect(fs.existsSync(path.join(alternateHome, 'Library/.tokenelo-launch-agent-transaction'))).toBe(false);
      expect(fs.existsSync(path.join(reviewHome, 'Library/LaunchAgents'))).toBe(false);
      expect(fs.existsSync(path.join(reviewHome, 'Library/Logs'))).toBe(false);

      // A pre-existing package/legacy lock must refuse before any mocked launchctl operation.
      fs.mkdirSync(lock, { mode: 0o700 });
      expect(() => execFileSync('bash', args, { env, stdio: 'pipe', timeout: 10_000, windowsHide: true })).toThrow();
      expect(fs.existsSync(calls)).toBe(false);
      expect(fs.existsSync(path.join(reviewHome, 'Library/LaunchAgents'))).toBe(false);
      expect(fs.existsSync(path.join(reviewHome, 'Library/Logs'))).toBe(false);
      fs.rmdirSync(lock);

      execFileSync('bash', args, {
        env,
        stdio: 'pipe', timeout: 10_000, windowsHide: true,
      });
      const folder = path.join(reviewHome, 'Library/LaunchAgents');
      const daemonPlist = fs.readFileSync(path.join(folder, 'co.eloai.tokenelo.daemon.plist'), 'utf8');
      const trayPlist = fs.readFileSync(path.join(folder, 'co.eloai.tokenelo.tray.plist'), 'utf8');
      expect(fs.readFileSync(childHome, 'utf8').trim()).toBe(reviewHome);
      expect(daemonPlist).toContain(`<string>${path.join(reviewHome, 'Library/Logs/Tokenelo/daemon.out.log')}</string>`);
      expect(trayPlist).toContain(`<string>${path.join(reviewHome, 'Library/Logs/Tokenelo/tray.out.log')}</string>`);
      expect(fs.existsSync(lock)).toBe(false);
      expect(daemonPlist).toContain('<key>ProcessType</key>\n    <string>Standard</string>');
      expect(trayPlist).toContain('<key>ProcessType</key>\n    <string>Interactive</string>');
      expect(daemonPlist).toContain(`<string>${process.execPath}</string>\n        <string>${daemon}</string>`);
      expect(trayPlist).toContain(`<string>${electron}</string>\n        <string>${tray}</string>`);
      expect(daemonPlist).toContain('<key>SuccessfulExit</key>\n        <false/>');
      expect(trayPlist).toContain('<key>LimitLoadToSessionType</key>\n    <string>Aqua</string>');
      const domain = `gui/${process.getuid!()}`;
      expect(fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean)).toEqual([
        `bootout ${domain}/co.eloai.tokenelo.daemon`,
        `bootstrap ${domain} ${path.join(folder, 'co.eloai.tokenelo.daemon.plist')}`,
        `bootout ${domain}/co.eloai.tokenelo.tray`,
        `bootstrap ${domain} ${path.join(folder, 'co.eloai.tokenelo.tray.plist')}`,
      ]);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  });
});
