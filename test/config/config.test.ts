import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultHostLabel, defaultConfig, mergeConfig, loadConfig, saveConfig } from '../../src/daemon/config.js';
import { getPaths } from '../../src/daemon/paths.js';

// Sections an earlier edition wrote into config.json that this edition no longer reads.
const RETIRED_SECTIONS = { eacs: { comparators: { claude: 'claude-opus-5-5', gpt: 'gpt-6-sol' } }, roi: { commitGraceMs: 999 } };
const CONFIG_SECTIONS = ['accounts', 'api', 'claude', 'claudeDesktop', 'codex', 'fleet', 'hostLabel', 'idleGapMs', 'local', 'qwen'];

describe('defaultHostLabel', () => {
  it('maps known hostnames per the founder-specified table', () => {
    expect(defaultHostLabel('Mac16,8')).toBe('M4a');
    expect(defaultHostLabel('this Mac')).toBe('M4a');
    expect(defaultHostLabel('HOST-1')).toBe('A2000');
    expect(defaultHostLabel('peer-box')).toBe('ryzen');
  });

  it('falls through to the raw hostname for anything unmapped', () => {
    // 'Elos-MacBook-Pro.local'/'Elos-MacBook-Pro' (this session's M4a) are now mapped explicitly
    // — see test/daemon/config-hostlabel.test.ts — so this only asserts the true-fallthrough case.
    expect(defaultHostLabel('some-other-box')).toBe('some-other-box');
  });
});

describe('defaultConfig', () => {
  it('matches every default from DESIGN.md §2.2/§15.7 and the scaffold task spec', () => {
    const cfg = defaultConfig({ hostLabel: 'M4a' });
    expect(cfg.hostLabel).toBe('M4a');
    expect(cfg.accounts).toEqual([]);
    expect(cfg.idleGapMs).toBe(300_000);
    expect(cfg.claude).toEqual({});
    expect(cfg.codex).toEqual({});
    expect(cfg.qwen).toEqual({});
    expect(cfg.claudeDesktop).toEqual({});
    expect(cfg.local.ollamaUpstream).toBe('http://127.0.0.1:11434');
    expect(cfg.local.proxyPort).toBe(11444);
    expect(cfg.local.proxyInjectUsage).toBe(false);
    expect(cfg.api.port).toBe(47821);
    expect(cfg.fleet).toEqual({ listenAddress: null, peers: [], sharePaths: false });
    // Exactly these sections; none of the retired ones is part of the default.
    expect(Object.keys(cfg).sort()).toEqual(CONFIG_SECTIONS);
  });

  it('local.capture defaults to both on M4a and proxy elsewhere (DESIGN §15.3.4)', () => {
    expect(defaultConfig({ hostLabel: 'M4a' }).local.capture).toBe('both');
    expect(defaultConfig({ hostLabel: 'A2000' }).local.capture).toBe('proxy');
    expect(defaultConfig({ hostLabel: 'ryzen' }).local.capture).toBe('proxy');
    expect(defaultConfig({ hostLabel: 'some-unmapped-host' }).local.capture).toBe('proxy');
  });
});

describe('mergeConfig', () => {
  it('fills in missing sections from defaults and ignores unknown top-level keys', () => {
    const defaults = defaultConfig({ hostLabel: 'M4a' });
    const merged = mergeConfig(defaults, {
      idleGapMs: 60_000,
      local: { proxyPort: 22222 },
      unknownFutureField: 'should be dropped',
    } as never);
    expect(merged.idleGapMs).toBe(60_000);
    // proxyPort overridden, but the rest of `local` keeps the defaults (not wiped out).
    expect(merged.local.proxyPort).toBe(22222);
    expect(merged.local.capture).toBe(defaults.local.capture);
    expect(merged.local.ollamaUpstream).toBe(defaults.local.ollamaUpstream);
    expect(merged.hostLabel).toBe('M4a');
    expect((merged as Record<string, unknown>).unknownFutureField).toBeUndefined();
  });

  it('rejects unsupported capture modes and preserves the host default when capture is undefined', () => {
    const defaults = defaultConfig({ hostLabel: 'M4a' });
    expect(mergeConfig(defaults, { local: { capture: undefined } } as never).local.capture).toBe('both');
    for (const capture of ['proxy-and-serverlog', null, 5]) {
      expect(() => mergeConfig(defaults, { local: { capture } } as never))
        .toThrow('local.capture must be exactly "proxy", "serverlog", "both", or "off"');
    }
  });

  it('ignores the retired sections of an old file: no throw, the other settings still merge, and the sections are absent from the result', () => {
    const defaults = defaultConfig({ hostLabel: 'M4a' });
    const merged = mergeConfig(defaults, { idleGapMs: 60_000, local: { proxyPort: 22222 }, ...RETIRED_SECTIONS } as never);
    expect(merged.idleGapMs).toBe(60_000);
    expect(merged.local.proxyPort).toBe(22222);
    expect(Object.keys(merged).sort()).toEqual(CONFIG_SECTIONS);
    for (const section of Object.keys(RETIRED_SECTIONS)) expect(merged, section).not.toHaveProperty(section);
    expect(JSON.stringify(merged)).not.toContain('claude-opus-5-5');
  });

  it('build items 1-4: qwen.roots, claudeDesktop.root, and local.upstreams[] all merge/round-trip', () => {
    const defaults = defaultConfig({ hostLabel: 'M4a' });
    const merged = mergeConfig(defaults, {
      qwen: { roots: ['/custom/.qwen'] },
      claudeDesktop: { root: '/custom/Claude' },
      local: { upstreams: [{ name: 'docker-model-runner', upstream: 'http://127.0.0.1:12434', listenPort: 12444 }] },
      fleet: { listenAddress: '100.64.0.7', peers: [{ label: 'ryzen', url: 'http://100.64.0.8:47822' }] },
    } as never);
    expect(merged.qwen.roots).toEqual(['/custom/.qwen']);
    expect(merged.claudeDesktop.root).toBe('/custom/Claude');
    expect(merged.local.upstreams).toEqual([{ name: 'docker-model-runner', upstream: 'http://127.0.0.1:12434', listenPort: 12444 }]);
    expect(merged.fleet.listenAddress).toBe('100.64.0.7');
    expect(merged.fleet.peers).toEqual([{ label: 'ryzen', url: 'http://100.64.0.8:47822' }]);
    // Unset in the loaded file -> defaults (empty), never crashes on the missing section.
    expect(mergeConfig(defaults, {} as never).qwen).toEqual({});
    expect(mergeConfig(defaults, {} as never).claudeDesktop).toEqual({});
  });
});

describe('loadConfig / saveConfig (TOKENELO_HOME sandbox)', () => {
  let tmpHome: string;

  afterEach(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('loadConfig returns defaultConfig() when no file exists yet', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-config-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    const loaded = loadConfig(paths);
    expect(loaded).toEqual(defaultConfig({ hostLabel: loaded.hostLabel }));
    expect(fs.existsSync(paths.configFile)).toBe(false); // loadConfig must not write
  });

  it('saveConfig then loadConfig round-trips exactly', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-config-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    const cfg = defaultConfig({ hostLabel: 'A2000' });
    cfg.idleGapMs = 123_456;
    cfg.accounts = [{ id: 'acct1', kind: 'claude', hosts: ['A2000'], monthlyUsd: 200 }];
    saveConfig(paths, cfg);
    const reloaded = loadConfig(paths);
    expect(reloaded).toEqual(cfg);
  });

  it('loads an old config file that still has the retired sections: no throw, sections absent, the rest applied, file left untouched', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-config-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    fs.mkdirSync(paths.configDir, { recursive: true });
    const bytes = JSON.stringify({ hostLabel: 'ryzen', idleGapMs: 61_000, api: { port: 9999 }, ...RETIRED_SECTIONS });
    fs.writeFileSync(paths.configFile, bytes);
    let loaded!: ReturnType<typeof loadConfig>;
    expect(() => { loaded = loadConfig(paths); }).not.toThrow();
    expect(loaded.hostLabel).toBe('ryzen');
    expect(loaded.idleGapMs).toBe(61_000);
    expect(loaded.api.port).toBe(9999);
    expect(loaded.local.capture).toBe('proxy'); // ryzen default
    expect(Object.keys(loaded).sort()).toEqual(CONFIG_SECTIONS);
    for (const section of Object.keys(RETIRED_SECTIONS)) expect(loaded, section).not.toHaveProperty(section);
    expect(fs.readFileSync(paths.configFile, 'utf8')).toBe(bytes); // loadConfig must not rewrite the file
  });

  it('saveConfig of a config loaded from an old file drops the retired sections and round-trips the remaining ones', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-config-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.configFile, JSON.stringify({
      hostLabel: 'A2000', idleGapMs: 61_000, accounts: [{ id: 'acct1', kind: 'claude', hosts: ['A2000'], monthlyUsd: 200 }],
      fleet: { listenAddress: '100.64.0.7', peers: [{ label: 'ryzen', url: 'http://100.64.0.8:47822' }] }, ...RETIRED_SECTIONS,
    }));
    const first = loadConfig(paths);
    saveConfig(paths, first);
    const written = JSON.parse(fs.readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(CONFIG_SECTIONS);
    for (const section of Object.keys(RETIRED_SECTIONS)) expect(written, section).not.toHaveProperty(section);
    const reloaded = loadConfig(paths);
    expect(reloaded).toEqual(first);
    expect(reloaded.idleGapMs).toBe(61_000);
    expect(reloaded.accounts).toEqual([{ id: 'acct1', kind: 'claude', hosts: ['A2000'], monthlyUsd: 200 }]);
    expect(reloaded.fleet.peers).toEqual([{ label: 'ryzen', url: 'http://100.64.0.8:47822' }]);
  });

  it('loadConfig on a partial on-disk file fills in the rest from defaults', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-config-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.configFile, JSON.stringify({ hostLabel: 'ryzen', api: { port: 9999 } }));
    const loaded = loadConfig(paths);
    expect(loaded.hostLabel).toBe('ryzen');
    expect(loaded.api.port).toBe(9999);
    expect(loaded.idleGapMs).toBe(300_000); // untouched default
    expect(loaded.local.capture).toBe('proxy'); // ryzen default
  });

  it('loads a persisted both mode without rewriting the file', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenelo-config-'));
    const paths = getPaths({ env: { TOKENELO_HOME: tmpHome } });
    fs.mkdirSync(paths.configDir, { recursive: true });
    const bytes = JSON.stringify({ hostLabel: 'M4a', local: { capture: 'both' } });
    fs.writeFileSync(paths.configFile, bytes);
    expect(loadConfig(paths).local.capture).toBe('both');
    expect(fs.readFileSync(paths.configFile, 'utf8')).toBe(bytes);
  });
});
