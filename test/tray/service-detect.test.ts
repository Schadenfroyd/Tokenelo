import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceUnitInstalled, windowsScheduledTaskInstalled } from '../../src/tray/service-detect.js';

describe('serviceUnitInstalled', () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('darwin: false when no LaunchAgents plist exists', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-home-'));
    expect(serviceUnitInstalled({ platform: 'darwin', home: tmpHome })).toBe(false);
  });

  it('darwin: true once co.eloai.tokenelo.daemon.plist exists under ~/Library/LaunchAgents', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-home-'));
    const dir = path.join(tmpHome, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'co.eloai.tokenelo.daemon.plist'), '<plist/>');
    expect(serviceUnitInstalled({ platform: 'darwin', home: tmpHome })).toBe(true);
  });

  it('linux: false when no systemd user unit exists', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-home-'));
    expect(serviceUnitInstalled({ platform: 'linux', home: tmpHome, env: {} })).toBe(false);
  });

  it('linux: true once tokenelo-daemon.service exists under XDG_CONFIG_HOME/systemd/user', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-home-'));
    const xdg = path.join(tmpHome, 'xdgconf');
    const dir = path.join(xdg, 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tokenelo-daemon.service'), '[Unit]\n');
    expect(serviceUnitInstalled({ platform: 'linux', home: tmpHome, env: { XDG_CONFIG_HOME: xdg } })).toBe(true);
  });

  it('linux: falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-home-'));
    const dir = path.join(tmpHome, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tokenelo-daemon.service'), '[Unit]\n');
    expect(serviceUnitInstalled({ platform: 'linux', home: tmpHome, env: {} })).toBe(true);
  });

  it('win32: always false (no file to stat; see windowsScheduledTaskInstalled)', () => {
    expect(serviceUnitInstalled({ platform: 'win32', home: os.tmpdir() })).toBe(false);
  });
});

describe('windowsScheduledTaskInstalled', () => {
  it('false on non-win32 platforms regardless of the runner', () => {
    expect(windowsScheduledTaskInstalled({ platform: 'darwin', runner: () => {} })).toBe(false);
  });

  it('true on win32 when the injected runner succeeds (schtasks exit 0)', () => {
    expect(windowsScheduledTaskInstalled({ platform: 'win32', runner: () => {} })).toBe(true);
  });

  it('false on win32 when the injected runner throws (schtasks exit non-zero: task not found)', () => {
    const runner = () => {
      throw new Error('ERROR: The system cannot find the file specified.');
    };
    expect(windowsScheduledTaskInstalled({ platform: 'win32', runner })).toBe(false);
  });

  it('passes the expected schtasks query arguments to the runner', () => {
    let seen: [string, string[]] | null = null;
    windowsScheduledTaskInstalled({
      platform: 'win32',
      runner: (cmd, args) => {
        seen = [cmd, args];
      },
    });
    expect(seen).toEqual(['schtasks', ['/query', '/tn', 'TokeneloDaemon']]);
  });
});
