/**
 * daemon/config.ts host-label map (DESIGN §15.9.9) and host-dependent defaults on load. Verified
 * real `os.hostname()` values 2026-09-26: M4a "Elos-MacBook-Pro.local", A2000 "HOST-1",
 * ryzen "peer-box".
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultHostLabel, defaultConfig, loadConfig } from '../../src/daemon/config.js';
import { getPaths } from '../../src/daemon/paths.js';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('defaultHostLabel', () => {
  it('maps the three verified hostnames (and the bare M4a name) to their labels', () => {
    expect(defaultHostLabel('Elos-MacBook-Pro.local')).toBe('M4a');
    expect(defaultHostLabel('Elos-MacBook-Pro')).toBe('M4a');
    expect(defaultHostLabel('HOST-1')).toBe('A2000');
    expect(defaultHostLabel('peer-box')).toBe('ryzen');
  });

  it('keeps the original founder-table keys', () => {
    expect(defaultHostLabel('Mac16,8')).toBe('M4a');
    expect(defaultHostLabel('this Mac')).toBe('M4a');
  });

  it('unknown hostnames fall through unchanged (never guessed)', () => {
    expect(defaultHostLabel('some-other-box')).toBe('some-other-box');
    expect(defaultHostLabel('elos-macbook-pro.local')).toBe('elos-macbook-pro.local'); // exact match only
  });

  it('M4a defaults to dual capture, everything else to proxy (DESIGN §15.3.4)', () => {
    expect(defaultConfig({ hostLabel: defaultHostLabel('Elos-MacBook-Pro.local') }).local.capture).toBe('both');
    expect(defaultConfig({ hostLabel: defaultHostLabel('HOST-1') }).local.capture).toBe('proxy');
    expect(defaultConfig({ hostLabel: defaultHostLabel('peer-box') }).local.capture).toBe('proxy');
  });
});

describe('loadConfig: host-dependent defaults follow the FILE hostLabel, not this machine', () => {
  it('a partial config naming another host gets that host\'s capture default', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-cfg-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmp } });
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.configFile, JSON.stringify({ hostLabel: 'ryzen' }));
    expect(loadConfig(paths).local.capture).toBe('proxy');
    fs.writeFileSync(paths.configFile, JSON.stringify({ hostLabel: 'M4a' }));
    expect(loadConfig(paths).local.capture).toBe('both');
    fs.writeFileSync(paths.configFile, JSON.stringify({ hostLabel: 'M4a', local: { capture: 'off' } }));
    expect(loadConfig(paths).local.capture).toBe('off'); // explicit value always wins
  });
});
