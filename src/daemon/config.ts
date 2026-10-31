/**
 * Load/save TokeneloConfig (src/core/types.ts) with the defaults specified in DESIGN.md §2.2/§15.7.
 * Config is a flat JSON file at paths.configFile; missing/partial files are filled in from
 * `defaultConfig()` section-by-section (never a deep-merge across unrelated sections) so an old
 * config file with only a few keys set still loads cleanly after new sections are added.
 */
import fs from 'node:fs';
import os from 'node:os';
import type { HostLabel, TokeneloConfig } from '../core/types.js';
import type { TokeneloPaths } from './paths.js';

/**
 * os.hostname() → HostLabel mapping (DESIGN §15.7, §15.9.9). Verified `os.hostname()` values:
 * M4a = "Elos-MacBook-Pro.local" (2026-09-26, this Mac; macOS may also report the bare
 * "Elos-MacBook-Pro" when the .local mDNS suffix is absent), A2000 = "HOST-1", ryzen =
 * "peer-box". The original founder-table keys ("Mac16,8", "this Mac") are kept for compatibility.
 * Unknown hostnames fall through to the raw hostname string; config.hostLabel always overrides.
 */
const HOSTNAME_TO_LABEL: Readonly<Record<string, HostLabel>> = Object.freeze({
  'Elos-MacBook-Pro.local': 'M4a',
  'Elos-MacBook-Pro': 'M4a',
  'Mac16,8': 'M4a',
  'this Mac': 'M4a',
  'HOST-1': 'A2000',
  'peer-box': 'ryzen',
});

export function defaultHostLabel(hostname: string = os.hostname()): HostLabel {
  return HOSTNAME_TO_LABEL[hostname] ?? hostname;
}

/** local.capture default: 'both' on M4a (proxy accuracy plus direct-client coverage),
 * 'proxy' everywhere else (DESIGN §15.3.4). */
function defaultLocalCapture(hostLabel: HostLabel): TokeneloConfig['local']['capture'] {
  return hostLabel === 'M4a' ? 'both' : 'proxy';
}

export function defaultConfig(opts?: { hostLabel?: HostLabel }): TokeneloConfig {
  const hostLabel = opts?.hostLabel ?? defaultHostLabel();
  return {
    hostLabel,
    accounts: [],
    idleGapMs: 300_000,
    claude: {},
    codex: {},
    qwen: {},
    claudeDesktop: {},
    local: {
      capture: defaultLocalCapture(hostLabel),
      ollamaUpstream: 'http://127.0.0.1:11434',
      proxyPort: 11444,
      proxyInjectUsage: false,
      proxyMaxBodyBytes: 33_554_432, // 32 MiB (security audit finding #2 — unbounded request buffering)
    },
    api: { port: 47821 },
    fleet: { listenAddress: null, peers: [], sharePaths: false },
  };
}

/**
 * Section-by-section merge: for each top-level key of TokeneloConfig, if the loaded JSON has
 * that key, its own sub-keys override the default's sub-keys (one level deep); scalars and
 * arrays (accounts, fleet.peers) are replaced wholesale when present. Unknown top-level keys in
 * the file are ignored (forward-compat: an older/newer daemon dropping a field never crashes), which
 * includes the sections of earlier configs for features this edition no longer has.
 */
export function mergeConfig(
  defaults: TokeneloConfig,
  loaded: Partial<TokeneloConfig> | Record<string, unknown> | null | undefined
): TokeneloConfig {
  const raw = (loaded ?? {}) as Partial<TokeneloConfig>;
  const rawLocal = (raw.local ?? {}) as Record<string, unknown>;
  const rawCapture = rawLocal.capture;
  if (rawCapture !== undefined && rawCapture !== 'proxy' && rawCapture !== 'serverlog' && rawCapture !== 'both' && rawCapture !== 'off') {
    throw new Error('local.capture must be exactly "proxy", "serverlog", "both", or "off".');
  }
  const local = { ...defaults.local, ...rawLocal } as TokeneloConfig['local'];
  if (rawCapture === undefined) local.capture = defaults.local.capture;
  return {
    hostLabel: raw.hostLabel ?? defaults.hostLabel,
    accounts: raw.accounts ?? defaults.accounts,
    idleGapMs: raw.idleGapMs ?? defaults.idleGapMs,
    claude: { ...defaults.claude, ...(raw.claude ?? {}) },
    codex: { ...defaults.codex, ...(raw.codex ?? {}) },
    qwen: { ...defaults.qwen, ...(raw.qwen ?? {}) },
    claudeDesktop: { ...defaults.claudeDesktop, ...(raw.claudeDesktop ?? {}) },
    local,
    api: { ...defaults.api, ...(raw.api ?? {}) },
    fleet: { ...defaults.fleet, ...(raw.fleet ?? {}) },
  };
}

/**
 * Loads config.json from paths.configFile, filling in any missing sections from
 * `defaultConfig()`. If the file does not exist, returns `defaultConfig()` untouched (does NOT
 * write the file — callers that want an on-disk config after first run should call
 * `saveConfig` explicitly).
 */
export function loadConfig(paths: TokeneloPaths): TokeneloConfig {
  if (!fs.existsSync(paths.configFile)) return defaultConfig();
  const text = fs.readFileSync(paths.configFile, 'utf8');
  const parsed = text.trim().length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
  // Host-dependent defaults (local.capture) follow the file's own hostLabel when it sets one —
  // never this machine's hostname (a 'ryzen' config read on M4a must still default to 'proxy').
  const fileHost = typeof parsed.hostLabel === 'string' && parsed.hostLabel.length > 0 ? parsed.hostLabel : undefined;
  return mergeConfig(defaultConfig(fileHost ? { hostLabel: fileHost } : undefined), parsed);
}

/** Writes `config` to paths.configFile as pretty-printed JSON, creating configDir if needed. */
export function saveConfig(paths: TokeneloPaths, config: TokeneloConfig): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  fs.writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + '\n', 'utf8');
}
