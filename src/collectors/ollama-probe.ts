/**
 * ollama-probe.ts — detect the live Ollama server(s) behind `config.local.ollamaUpstream`,
 * identify the listening process, resolve its server-log path, and build the model-manifest map
 * (blob sha256 -> model name). DESIGN.md §4.3/§4.4 + §15.3.
 *
 * VERIFIED on M4a (2026-09-26, this host): two Ollama servers really do coexist on port 11434 —
 * Homebrew 0.32.13 owns the IPv4 loopback socket (`127.0.0.1:11434`, log
 * `/opt/homebrew/var/log/ollama.log`) and Ollama.app 0.34.2 owns the IPv6 wildcard socket
 * (`*:11434`, reachable at `[::1]:11434`, log `~/.ollama/logs/server.log`). `lsof -nP
 * -iTCP:11434 -sTCP:LISTEN` prints a `TYPE` column of literally `IPv4`/`IPv6` (not just an
 * address-string heuristic) — confirmed against real output:
 *   ollama  2282 example 3u IPv4 ... TCP 127.0.0.1:11434 (LISTEN)
 *   ollama  2830 example 3u IPv6 ... TCP *:11434 (LISTEN)
 * `ps -ww -p <pid> -o command=` gave the full binary path for each
 * (`/opt/homebrew/opt/ollama/bin/ollama serve`, `/Applications/Ollama.app/Contents/Resources/
 * ollama serve`), which is what `resolveLogPath` keys off. The manifest layout
 * (`~/.ollama/models/manifests/<registry>/<namespace>/<model>/<tag>`, a JSON file per tag with a
 * `layers[].mediaType === "application/vnd.ollama.image.model"` entry carrying the weights
 * blob's digest) was verified directly against this machine's real `gemma4:26b` and
 * `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL` manifests (see test/fixtures/ollama/manifests/).
 *
 * The Linux (`ss -ltnp`) and Windows (`netstat -ano` + `tasklist`) process-lookup parsers are
 * written against Linux/Windows CLI output *shapes as documented*, not verified against a live
 * ss/netstat/tasklist run in this task (ryzen/A2000 were out of scope for this collector's own
 * verification pass — this task never ran `ollama` on A2000 per the hard rule, and did not ssh
 * into ryzen for this file). Their line-parsing regexes are unit-tested against hand-built
 * fixture text that matches each tool's documented output format — label those parsers
 * "shape-only / unproven" until cross-checked against real `ss -ltnp`/`netstat -ano` output on
 * ryzen/A2000.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkRead } from '../core/read-control.js';
import { fetchWithoutContentDecoding } from '../core/no-compression-fetch.js';

const execFileAsync = promisify(execFile);
/** macOS lsof can take 30 s+ under load; probes must never block doctor/the daemon that long. */
export const PROBE_EXEC_TIMEOUT_MS = 3000;

export type AddressFamily = 'IPv4' | 'IPv6';

export interface ListeningProcess {
  pid: number;
  /** Best-effort full command / binary path (macOS/Linux: `ps`/`ss` process name; Windows: tasklist image name). */
  command: string;
  family: AddressFamily;
  /** Local address exactly as printed by the OS tool (e.g. '127.0.0.1', '*', '[::1]'). */
  localAddress: string;
  port: number;
}

export type OllamaLogSource = 'homebrew' | 'ollama-app' | 'linux-systemd' | 'windows' | 'unknown';

export interface OllamaLogResolution {
  path: string | null;
  source: OllamaLogSource;
  /** false ⇒ no structured token data is recoverable from this source at all (e.g. journalctl). */
  available: boolean;
  reason?: string;
}

export interface OllamaServerProbe {
  /** The address probed to reach this server ('127.0.0.1' | '::1' | ...). */
  address: string;
  port: number;
  family: AddressFamily;
  reachable: boolean;
  version: string | null;
  process: ListeningProcess | null;
  log: OllamaLogResolution;
  error?: string;
}

export interface OllamaProbeResult {
  servers: OllamaServerProbe[];
  /** blob sha256 (no 'sha256:' prefix) -> canonical model name, from ~/.ollama/models/manifests/**. */
  manifests: Map<string, string>;
  generatedAt: number;
}

// ── HTTP: GET /api/version ─────────────────────────────────────────────────

/**
 * GETs `${baseUrl}/api/version` with a short timeout. Returns the version string, or null if
 * unreachable/non-200/malformed. An explicitly cancelled report throws instead of appearing
 * to be an unreachable server. Its ordinary per-request timeout still returns null.
 */
export async function getOllamaVersion(baseUrl: string, timeoutMs = 2000, signal?: AbortSignal): Promise<string | null> {
  checkRead(signal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchWithoutContentDecoding(`${baseUrl.replace(/\/+$/, '')}/api/version`, {
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    checkRead(signal);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Listening-process discovery (per OS) ────────────────────────────────────

/**
 * Parses real `lsof -nP -iTCP:<port> -sTCP:LISTEN` output. Verified column layout (macOS,
 * 2026-09-26): `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME`, where TYPE is literally
 * `IPv4`/`IPv6` and NAME is `<addr>:<port> (LISTEN)`. One header line, one line per socket.
 */
export function parseLsofListenOutput(output: string, port: number): ListeningProcess[] {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  const results: ListeningProcess[] = [];
  for (const line of lines) {
    if (/^COMMAND\s+PID\s+USER/.test(line)) continue; // header
    const m = line.match(
      /^(\S+)\s+(\d+)\s+\S+\s+\S+\s+(IPv4|IPv6)\s+\S+\s+\S+\s+\S+\s+(.+?)(?:\s+\(LISTEN\))?\s*$/
    );
    if (!m) continue;
    const [, command, pidStr, family, name] = m;
    const addrMatch = name.match(/^(.*):(\d+)$/);
    const localAddress = addrMatch ? addrMatch[1] : name;
    results.push({
      pid: Number(pidStr),
      command,
      family: family as AddressFamily,
      localAddress,
      port,
    });
  }
  return results;
}

async function findListeningProcessesMac(port: number, signal?: AbortSignal): Promise<ListeningProcess[]> {
  checkRead(signal);
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { timeout: PROBE_EXEC_TIMEOUT_MS, windowsHide: true, signal });
    const parsed = parseLsofListenOutput(stdout, port);
    // lsof's COMMAND column is often truncated (e.g. "ollama"); resolve the full binary path via
    // `ps -ww -p <pid> -o command=` so resolveLogPath can distinguish Homebrew vs Ollama.app.
    for (const p of parsed) {
      checkRead(signal);
      try {
        const { stdout: cmdOut } = await execFileAsync('ps', ['-ww', '-p', String(p.pid), '-o', 'command='], { timeout: PROBE_EXEC_TIMEOUT_MS, windowsHide: true, signal });
        const full = cmdOut.trim();
        if (full) p.command = full;
      } catch {
        checkRead(signal);
        // best effort; keep lsof's short command name
      }
    }
    return parsed;
  } catch {
    checkRead(signal);
    return [];
  }
}

/**
 * Parses `ss -ltnp` output. Documented shape (not live-verified in this task):
 *   LISTEN 0      4096         127.0.0.1:11434       0.0.0.0:*     users:(("ollama",pid=1234,fd=7))
 *   LISTEN 0      4096              [::1]:11434          [::]:*    users:(("ollama",pid=1234,fd=8))
 * SHAPE-ONLY / UNPROVEN: not cross-checked against a live `ss -ltnp` run.
 */
export function parseSsListenOutput(output: string, port: number): ListeningProcess[] {
  const results: ListeningProcess[] = [];
  for (const line of output.split('\n')) {
    if (!/^LISTEN/.test(line.trim())) continue;
    const addrMatch = line.match(/(\[[0-9a-fA-F:]+\]|\*|[0-9.]+):(\d+)\s+\S+\s+users:\(\("([^"]+)",pid=(\d+)/);
    if (!addrMatch) continue;
    const [, addr, portStr, name, pidStr] = addrMatch;
    if (Number(portStr) !== port) continue;
    const family: AddressFamily = addr.startsWith('[') || addr === '*' && line.includes('[::]') ? 'IPv6' : addr.includes(':') ? 'IPv6' : 'IPv4';
    results.push({
      pid: Number(pidStr),
      command: name,
      family,
      localAddress: addr.replace(/^\[|\]$/g, ''),
      port,
    });
  }
  return results;
}

async function findListeningProcessesLinux(port: number, signal?: AbortSignal): Promise<ListeningProcess[]> {
  checkRead(signal);
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnp'], { timeout: PROBE_EXEC_TIMEOUT_MS, windowsHide: true, signal });
    return parseSsListenOutput(stdout, port);
  } catch {
    checkRead(signal);
    return [];
  }
}

/**
 * Parses `netstat -ano` output filtered to the target port, cross-referenced with
 * `tasklist /FI "PID eq <pid>" /FO CSV /NH` for the image name. Documented shape (not
 * live-verified in this task — Windows probing was out of this collector's verification scope):
 *   TCP    127.0.0.1:11434        0.0.0.0:0              LISTENING       1234
 *   TCP    [::1]:11434            [::]:0                 LISTENING       1234
 * SHAPE-ONLY / UNPROVEN.
 */
export function parseNetstatListenOutput(output: string, port: number): Omit<ListeningProcess, 'command'>[] {
  const results: Omit<ListeningProcess, 'command'>[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*TCP6?\s+(\[[0-9a-fA-F:]+\]|[0-9.]+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
    if (!m) continue;
    const [, addr, portStr, pidStr] = m;
    if (Number(portStr) !== port) continue;
    const family: AddressFamily = addr.startsWith('[') ? 'IPv6' : 'IPv4';
    results.push({ pid: Number(pidStr), family, localAddress: addr.replace(/^\[|\]$/g, ''), port });
  }
  return results;
}

/** Parses `tasklist /FI "PID eq <pid>" /FO CSV /NH` → `"image.exe","1234","Console","1","12,345 K"`. */
export function parseTasklistCsv(output: string): string | null {
  const line = output.split('\n').find((l) => l.trim().startsWith('"'));
  if (!line) return null;
  const m = line.match(/^"([^"]+)"/);
  return m ? m[1] : null;
}

async function findListeningProcessesWindows(port: number, signal?: AbortSignal): Promise<ListeningProcess[]> {
  checkRead(signal);
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: PROBE_EXEC_TIMEOUT_MS, windowsHide: true, signal });
    const partial = parseNetstatListenOutput(stdout, port);
    const results: ListeningProcess[] = [];
    for (const p of partial) {
      checkRead(signal);
      let command = 'unknown';
      try {
        const { stdout: tlOut } = await execFileAsync('tasklist', [
          '/FI',
          `PID eq ${p.pid}`,
          '/FO',
          'CSV',
          '/NH',
        ], { timeout: PROBE_EXEC_TIMEOUT_MS, windowsHide: true, signal });
        command = parseTasklistCsv(tlOut) ?? command;
      } catch {
        checkRead(signal);
        // best effort
      }
      results.push({ ...p, command });
    }
    return results;
  } catch {
    checkRead(signal);
    return [];
  }
}

/**
 * Dispatches to the OS-appropriate listening-process lookup. Returns one entry per distinct
 * (pid, family) socket bound to `port` — on M4a this legitimately returns TWO entries (Homebrew
 * IPv4 + Ollama.app IPv6) for the same port.
 */
export async function findListeningProcesses(
  port: number,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal
): Promise<ListeningProcess[]> {
  checkRead(signal);
  if (platform === 'darwin') return findListeningProcessesMac(port, signal);
  if (platform === 'linux') return findListeningProcessesLinux(port, signal);
  if (platform === 'win32') return findListeningProcessesWindows(port, signal);
  return [];
}

// ── Log path resolution ─────────────────────────────────────────────────────

/**
 * Resolves the server-log path for a given listening process. Never hardcodes a single path
 * (spikes-2026-09-26.md S7: "a naive log-tailer pointed at the 'obvious' path would silently get
 * stale/wrong data" — Ollama.app's own log goes stale while Homebrew's stays live, or vice versa,
 * depending on which binary owns the port being probed).
 *
 * - darwin + command contains '/homebrew/' → Homebrew's `<prefix>/var/log/ollama.log`
 *   (verified real path on this host: `/opt/homebrew/var/log/ollama.log`; Intel Homebrew installs
 *   to `/usr/local` — checked for via `homebrewPrefixOverride` for testability, else both
 *   candidate prefixes are tried on disk).
 * - darwin + command contains 'Ollama.app' → `~/.ollama/logs/server.log`.
 * - linux → always unavailable (DESIGN §15.3: journalctl carries no structured token data;
 *   verified empirically on peer-box in log-formats.md §3.3 — zero prompt_eval/print_timing
 *   matches in 30 sampled journal lines).
 * - win32 → `%LOCALAPPDATA%\Ollama\server.log`.
 * - unknown process / unknown platform → 'unknown' source, unavailable.
 */
export function resolveLogPath(
  proc: ListeningProcess | null,
  opts?: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    env?: Record<string, string | undefined>;
    /** Override Homebrew prefix candidates for testability (default ['/opt/homebrew', '/usr/local']). */
    homebrewPrefixes?: string[];
    /** Injectable existence check for testability. */
    exists?: (p: string) => boolean;
  }
): OllamaLogResolution {
  const platform = opts?.platform ?? process.platform;
  const homeDir = opts?.homeDir ?? os.homedir();
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? ((p: string) => fs.existsSync(p));

  if (platform === 'linux') {
    return {
      path: null,
      source: 'linux-systemd',
      available: false,
      reason:
        'journalctl -u ollama carries no structured prompt/eval token data on Linux (verified empirically, log-formats.md §3.3) — best-effort server-log capture is unavailable on this platform',
    };
  }

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    return {
      path: path.join(localAppData, 'Ollama', 'server.log'),
      source: 'windows',
      available: true,
    };
  }

  if (platform === 'darwin') {
    // darwin is always a POSIX target regardless of the HOST platform running this function (a
    // Windows host simulating `platform: 'darwin'` in a test must still get forward-slash paths
    // back) — path.posix.join, not path.join, which would use the host's native separator.
    const cmd = proc?.command ?? '';
    if (/\/homebrew\//i.test(cmd) || /homebrew/i.test(cmd)) {
      const prefixes = opts?.homebrewPrefixes ?? ['/opt/homebrew', '/usr/local'];
      for (const prefix of prefixes) {
        const candidate = path.posix.join(prefix, 'var', 'log', 'ollama.log');
        if (exists(candidate)) return { path: candidate, source: 'homebrew', available: true };
      }
      // Not found on disk yet (e.g. brand-new install before first log write) — still report the
      // canonical candidate rather than null, so the caller can watch for it to appear.
      return { path: path.posix.join(prefixes[0], 'var', 'log', 'ollama.log'), source: 'homebrew', available: false, reason: 'log file not found on disk yet' };
    }
    if (/Ollama\.app/i.test(cmd)) {
      return { path: path.posix.join(homeDir, '.ollama', 'logs', 'server.log'), source: 'ollama-app', available: true };
    }
    // Unknown darwin binary: try both known candidates, prefer whichever exists.
    const homebrewCandidate = path.posix.join('/opt/homebrew', 'var', 'log', 'ollama.log');
    const appCandidate = path.posix.join(homeDir, '.ollama', 'logs', 'server.log');
    if (exists(homebrewCandidate)) return { path: homebrewCandidate, source: 'homebrew', available: true };
    if (exists(appCandidate)) return { path: appCandidate, source: 'ollama-app', available: true };
    return { path: null, source: 'unknown', available: false, reason: 'could not identify the owning Ollama binary' };
  }

  return { path: null, source: 'unknown', available: false, reason: `unsupported platform ${platform}` };
}

// ── Model manifest map (blob sha256 -> model name) ──────────────────────────

const MODEL_LAYER_MEDIA_TYPE = 'application/vnd.ollama.image.model';

/**
 * Canonicalizes a manifest's path (relative to the `manifests/` root) into Ollama's own model
 * naming convention. Verified against this host's real manifests:
 *   registry.ollama.ai/library/gemma4/26b        -> gemma4:26b
 *   hf.co/unsloth/Qwen3.8-27B-GGUF/UD-Q4_K_XL     -> hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL
 * i.e. the default registry+namespace ("registry.ollama.ai/library/...") is dropped; any other
 * registry/namespace is kept verbatim as a prefix.
 */
export function canonicalManifestName(relParts: string[]): string {
  if (relParts.length < 2) return relParts.join('/');
  const tag = relParts[relParts.length - 1];
  const model = relParts[relParts.length - 2];
  let rest = relParts.slice(0, relParts.length - 2); // [registry, namespace, ...] or []
  // The default registry (registry.ollama.ai) is always dropped, matching Ollama's own CLI
  // naming (e.g. `ollama pull someuser/model` shows as "someuser/model:tag", never prefixed with
  // the registry host) — the 'library' namespace is additionally dropped since it is itself the
  // default namespace under that registry (verified: gemma4:26b's real manifest path is
  // registry.ollama.ai/library/gemma4/26b).
  if (rest[0] === 'registry.ollama.ai') {
    rest = rest.slice(1);
    if (rest[0] === 'library') rest = rest.slice(1);
  }
  return rest.length ? `${rest.join('/')}/${model}:${tag}` : `${model}:${tag}`;
}

async function walkFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  checkRead(signal);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    checkRead(signal);
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    checkRead(signal);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const f of await walkFiles(full, signal)) files.push(f);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

interface ManifestJson {
  layers?: { mediaType?: string; digest?: string }[];
}

/**
 * Walks `<modelsDir>/manifests/**` and builds `blobSha256 (no 'sha256:' prefix) -> model name`
 * from each manifest's `application/vnd.ollama.image.model` layer digest. Manifest files with no
 * such layer, or that fail to parse, are skipped (never thrown).
 */
export async function buildManifestMap(
  modelsDir: string = path.join(os.homedir(), '.ollama', 'models'),
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const manifestsRoot = path.join(modelsDir, 'manifests');
  const files = await walkFiles(manifestsRoot, signal);
  const map = new Map<string, string>();
  for (const file of files) {
    checkRead(signal);
    let json: ManifestJson;
    try {
      const text = await fsp.readFile(file, { encoding: 'utf8', signal });
      json = JSON.parse(text) as ManifestJson;
    } catch {
      checkRead(signal);
      continue;
    }
    const modelLayer = json.layers?.find((l) => l.mediaType === MODEL_LAYER_MEDIA_TYPE);
    if (!modelLayer?.digest) continue;
    const sha = modelLayer.digest.replace(/^sha256:/, '');
    const relParts = path.relative(manifestsRoot, file).split(path.sep);
    map.set(sha, canonicalManifestName(relParts));
  }
  return map;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Probes the Ollama server(s) actually listening on the port implied by `ollamaUpstream`
 * (default `http://127.0.0.1:11434`): finds every distinct listening process on that port (across
 * IPv4/IPv6 — on M4a this legitimately returns two), fetches each one's `/api/version` on its own
 * address family, resolves each one's log path, and builds the shared model-manifest map once.
 */
export async function probeOllama(opts?: {
  ollamaUpstream?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: Record<string, string | undefined>;
  modelsDir?: string;
  /** Server-only diagnostics do not consume model mappings. Collectors retain the default. */
  includeManifests?: boolean;
  now?: () => number;
  /** Owned readonly report cancellation; does not affect collector probes without a signal. */
  signal?: AbortSignal;
}): Promise<OllamaProbeResult> {
  const upstream = opts?.ollamaUpstream ?? 'http://127.0.0.1:11434';
  const signal = opts?.signal;
  checkRead(signal);
  const now = opts?.now ?? (() => Date.now());
  let port = 11434;
  try {
    port = Number(new URL(upstream).port) || 11434;
  } catch {
    // keep default
  }

  const platform = opts?.platform ?? process.platform;
  const processes = await findListeningProcesses(port, platform, signal);

  const servers: OllamaServerProbe[] = [];
  if (processes.length === 0) {
    // Nothing found via process inspection (e.g. permission denied, or unsupported platform) —
    // still attempt a direct version probe against the configured upstream so a working single
    // server is reported even when process discovery fails.
    const version = await getOllamaVersion(upstream, 2000, signal);
    let addr = '127.0.0.1';
    try {
      addr = new URL(upstream).hostname;
    } catch {
      // keep default
    }
    servers.push({
      address: addr,
      port,
      family: addr.includes(':') ? 'IPv6' : 'IPv4',
      reachable: version !== null,
      version,
      process: null,
      log: resolveLogPath(null, { platform, homeDir: opts?.homeDir, env: opts?.env }),
    });
  } else {
    for (const proc of processes) {
      checkRead(signal);
      const addr = proc.family === 'IPv6' ? '::1' : '127.0.0.1';
      const base = proc.family === 'IPv6' ? `http://[${addr}]:${port}` : `http://${addr}:${port}`;
      const version = await getOllamaVersion(base, 2000, signal);
      servers.push({
        address: addr,
        port,
        family: proc.family,
        reachable: version !== null,
        version,
        process: proc,
        log: resolveLogPath(proc, { platform, homeDir: opts?.homeDir, env: opts?.env }),
      });
    }
  }

  const manifests = opts?.includeManifests === false ? new Map<string, string>() : await buildManifestMap(opts?.modelsDir, signal);
  checkRead(signal);

  return { servers, manifests, generatedAt: now() };
}
