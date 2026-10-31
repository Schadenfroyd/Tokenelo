import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureTrayProfile } from '../../src/tray/profile.js';
import { getPaths } from '../../src/daemon/paths.js';

const owned: string[] = [];
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-tray-profile-'));
  owned.push(dir);
  return dir;
}
function app(ready = false) {
  const changes: Record<string, string> = {};
  return {
    changes,
    isReady: () => ready,
    setPath: (name: string, value: string) => { changes[name] = value; },
    setAppLogsPath: (value: string) => { changes.logs = value; },
  };
}
afterEach(() => {
  for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('explicit tray profile', () => {
  it('leaves default Electron paths entirely untouched when no custom home is supplied', () => {
    const defaults = app(true);
    expect(configureTrayProfile(defaults, {})).toBeNull();
    expect(configureTrayProfile(defaults, { TOKENELO_HOME: '' })).toBeNull();
    expect(defaults.changes).toEqual({});
  });

  it('gives two homes independent browser state, sessions, crash dumps and Electron logs', () => {
    const a = app(), b = app();
    const first = configureTrayProfile(a, { TOKENELO_HOME: home() })!;
    const second = configureTrayProfile(b, { TOKENELO_HOME: home() })!;
    for (const key of ['userData', 'sessionData', 'crashDumps', 'logs'] as const) {
      expect(first[key]).not.toBe(second[key]);
      expect(fs.statSync(first[key]).isDirectory()).toBe(true);
      expect(fs.statSync(second[key]).isDirectory()).toBe(true);
    }
    expect(a.changes).toEqual(first);
    expect(b.changes).toEqual(second);
    expect(first.sessionData).not.toBe(first.userData);
  });

  it('resolves relative homes to the same tracker data/log locations without changing the environment', () => {
    const root = home();
    const env = { TOKENELO_HOME: path.relative(process.cwd(), root) };
    const original = { ...env };
    const tracker = getPaths({ env });
    const profile = configureTrayProfile(app(), env)!;
    expect(profile.userData).toBe(path.resolve(tracker.dataDir, 'electron', 'user-data'));
    expect(profile.logs).toBe(path.resolve(tracker.logsDir, 'electron'));
    expect(Object.values(profile).every(p => path.isAbsolute(p))).toBe(true);
    expect(env).toEqual(original);
  });

  it('rejects late setup before making directories or overriding any path', () => {
    const root = path.join(home(), 'not-created');
    const late = app(true);
    expect(() => configureTrayProfile(late, { TOKENELO_HOME: root })).toThrow('before Electron is ready');
    expect(fs.existsSync(root)).toBe(false);
    expect(late.changes).toEqual({});
  });

  it('refuses a blocked location instead of falling back to the default profile', () => {
    const root = home();
    fs.writeFileSync(path.join(root, 'data'), 'blocked');
    const blocked = app();
    expect(() => configureTrayProfile(blocked, { TOKENELO_HOME: root })).toThrow('cannot use TOKENELO_HOME profile');
    expect(blocked.changes).toEqual({});
  });

  it('reports invalid home paths before changing Electron paths', () => {
    const invalid = app();
    expect(() => configureTrayProfile(invalid, { TOKENELO_HOME: 'invalid\u0000home' })).toThrow('cannot use TOKENELO_HOME profile');
    expect(invalid.changes).toEqual({});
  });

  it('requires every directory to be usable before changing Electron paths', () => {
    const root = home();
    fs.mkdirSync(path.join(root, 'logs'));
    fs.writeFileSync(path.join(root, 'logs', 'electron'), 'blocked');
    const blocked = app();
    expect(() => configureTrayProfile(blocked, { TOKENELO_HOME: root })).toThrow('cannot use TOKENELO_HOME profile');
    expect(blocked.changes).toEqual({});
  });

  it('preserves existing browser files when the same home is started again', () => {
    const env = { TOKENELO_HOME: home() };
    const profile = configureTrayProfile(app(), env)!;
    const cookie = path.join(profile.sessionData, 'existing-state');
    fs.writeFileSync(cookie, 'retained');
    expect(configureTrayProfile(app(), env)).toEqual(profile);
    expect(fs.readFileSync(cookie, 'utf8')).toBe('retained');
  });
});
