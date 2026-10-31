/**
 * Live process sniffer (build item 5): "every ~15s list running agent processes ... without
 * reading command-line arguments beyond the executable name + subcommand". This module is
 * deliberately NOT a `Collector` — it emits no `UsageEvent`s and is never persisted; it is
 * queried live, on demand, by `store/queries.ts#getProcesses` (`GET /v1/processes`) so the tray's
 * Now tab can show "running now" even before any collector's log has flushed.
 *
 * Cross-platform, one listing function per OS, all funneling into the same `ProcessInfo[]` shape
 * and the same `data/agent-catalog.ts` matching. Only the macOS path is exercised against this
 * host's real process table (`docs/research/agent-inventory-2026-09-27.md`'s own process/port
 * scan already verified the shapes this module parses: Claude/Codex CLI, Rocky.app's codex
 * process tree, Ollama/llama-server, Docker Model Runner). Windows PowerShell 5.1 creation-date
 * serialization is additionally checked against the real A2000 process table in the R255/R256
 * internal evidence. That process check does not establish source capture completeness.
 *
 * Argv redaction (privacy — DESIGN §2 "no prompt/response content ever stored" extends to argv,
 * which can carry a literal prompt via `-p "..."`): `extractSafeArgInfo` NEVER returns the raw
 * command line. Only unambiguous leading subcommands/model options are considered. Parsing
 * stops at prompt/print flags, positional arguments, end-of-options or an unknown option;
 * model information beyond that boundary is unknown. Raw process listings lose argv quoting,
 * so scanning later tokens could mistake prompt text for a model option.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { HostLabel, ProcessInfo } from '../core/types.js';
import { AGENT_CATALOG } from '../core/agent-catalog.js';

const execFileAsync = promisify(execFile);

/** Runs a command and returns stdout; used only for a handful of fixed, argument-free-of-user-
 * input invocations (`ps -axo ...`, a fixed PowerShell script) — never built from anything this
 * process didn't hardcode itself. Injectable for tests. */
export type Runner = (cmd: string, args: string[]) => Promise<string>;

const defaultRunner: Runner = async (cmd, args) => {
  // Bounded: a slow lsof/ps under load must not stall the sniffer (macOS lsof measured at 31 s).
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 3000, windowsHide: true });
  return stdout;
};

// ── argv redaction (shared by every platform) ───────────────────────────────

const ALLOWED_BARE_TOKENS = new Set(['exec', 'serve', 'app-server', '-p']);
const SAFE_MODEL_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/;

/** Reads only the unambiguous leading argv prefix. An unfamiliar option's arity is unknown,
 * and `ps`/CIM command strings cannot reliably distinguish prompt words from flags. Stop at
 * either boundary instead of returning apparent model flags embedded in prompt/option values.
 * The executable (first token) is skipped, unless it is itself a recognized subcommand/option
 * for callers passing an argument-only list. Missing model metadata remains unknown. */
export function extractSafeArgInfo(argv: readonly string[]): { subcommand?: string; model?: string } {
  let subcommand: string | undefined;
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (i === 0 && !tok.startsWith('-') && !ALLOWED_BARE_TOKENS.has(tok)) continue;
    if (tok === '-p') {
      subcommand ??= tok; // Presence only; nothing after a possible prompt boundary is inspected.
      break;
    }
    if (ALLOWED_BARE_TOKENS.has(tok)) {
      if (subcommand !== undefined) break; // A second bare word can be the prompt.
      subcommand = tok;
      continue;
    }
    if (tok === '--model' || tok === '-m' || tok.startsWith('--model=')) {
      const equals = tok.startsWith('--model=');
      const value = equals ? tok.slice('--model='.length) : argv[i + 1];
      if (value === undefined || !SAFE_MODEL_TOKEN.test(value)) break;
      model ??= value;
      if (!equals) i++;
      continue;
    }
    break;
  }
  return { ...(subcommand !== undefined ? { subcommand } : {}), ...(model !== undefined ? { model } : {}) };
}

/** Raw macOS `ps args=`/Windows CIM command strings lose argument boundaries. Splitting is
 * useful only for the conservative leading-prefix reader above; quoted paths/values may
 * suppress model metadata. Never reconstruct or search a possible prompt's later words. */
function tokenize(commandLine: string): string[] {
  return commandLine.trim().length === 0 ? [] : commandLine.trim().split(/\s+/);
}

/** Matches an executable path/name against the catalog; `undefined` if nothing matches (not a
 * recognized agent process — never included in the result). */
function matchCatalog(exe: string): string | undefined {
  for (const entry of AGENT_CATALOG) {
    if (!entry.processMatch?.test(exe)) continue;
    if (entry.excludeMatch?.test(exe)) continue;
    return entry.id;
  }
  return undefined;
}

// ── macOS ────────────────────────────────────────────────────────────────────

/** `ps -axo pid=,ppid=,lstart=` line -> {pid, ppid, startedAt}. `lstart` has no explicit
 * timezone — it is the system's local wall-clock time (same convention as ollama-serverlog.ts's
 * Go-log timestamps), so `tzOffsetMinutes` lets tests pin a deterministic offset. */
export function parsePsLstartLine(line: string, tzOffsetMinutes?: number): { pid: number; ppid: number; startedAt: number | null } | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 7) return null;
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  // parts = [pid, ppid, Dow, Mon, Day, Time, Year] — skip pid, ppid, AND the unused weekday.
  const [, , , mon, day, time, year] = parts;
  const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const monthIdx = months[mon!];
  const [hh, mm, ss] = (time ?? '').split(':').map(Number);
  if (monthIdx === undefined || !Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss) || !Number.isFinite(Number(day)) || !Number.isFinite(Number(year))) {
    return { pid, ppid, startedAt: null };
  }
  let startedAt: number;
  if (tzOffsetMinutes !== undefined) {
    startedAt = Date.UTC(Number(year), monthIdx, Number(day), hh, mm, ss) - tzOffsetMinutes * 60_000;
  } else {
    startedAt = new Date(Number(year), monthIdx, Number(day), hh, mm, ss).getTime();
  }
  return { pid, ppid, startedAt };
}

/** `ps -axo pid=,comm=`/`ps -axo pid=,args=` line -> {pid, rest} (comm/args can contain spaces —
 * pid is always the first, purely-numeric whitespace-delimited token, so splitting on the FIRST
 * run of whitespace is unambiguous). */
function splitPidAndRest(line: string): { pid: number; rest: string } | null {
  const trimmed = line.replace(/^\s+/, '');
  const m = trimmed.match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  return { pid: Number(m[1]), rest: m[2]! };
}

export async function listProcessesDarwin(host: HostLabel, run: Runner = defaultRunner): Promise<ProcessInfo[]> {
  const [lstartOut, commOut, argsOut] = await Promise.all([
    run('ps', ['-axo', 'pid=,ppid=,lstart=']),
    run('ps', ['-axo', 'pid=,comm=']),
    run('ps', ['-axo', 'pid=,args=']),
  ]);

  const byPid = new Map<number, { ppid: number; startedAt: number | null }>();
  for (const line of lstartOut.split('\n')) {
    const parsed = parsePsLstartLine(line);
    if (parsed) byPid.set(parsed.pid, { ppid: parsed.ppid, startedAt: parsed.startedAt });
  }
  // A `ps` that ran always prints at least one process, so no parsed row means the primary output is missing.
  if (byPid.size === 0) throw new Error('empty primary ps listing');
  const exeByPid = new Map<number, string>();
  for (const line of commOut.split('\n')) {
    const s = splitPidAndRest(line);
    if (s) exeByPid.set(s.pid, s.rest);
  }
  const argsByPid = new Map<number, string>();
  for (const line of argsOut.split('\n')) {
    const s = splitPidAndRest(line);
    if (s) argsByPid.set(s.pid, s.rest);
  }

  const out: ProcessInfo[] = [];
  for (const [pid, exe] of exeByPid) {
    const tool = matchCatalog(exe);
    if (!tool) continue;
    const timing = byPid.get(pid);
    const argInfo = extractSafeArgInfo(tokenize(argsByPid.get(pid) ?? ''));
    out.push({
      pid,
      ppid: timing?.ppid ?? null,
      startedAt: timing?.startedAt ?? null,
      exe,
      host,
      tool,
      ...argInfo,
    });
  }
  await attachCwdViaLsof(out, run);
  return out;
}

/** Best-effort cwd via `lsof -p <pid> -a -d cwd -Fn` (macOS/Linux) — only for the (small) set of
 * already-matched processes, never for every process on the system. A failed/denied lookup for
 * one pid never blocks the others. */
async function attachCwdViaLsof(processes: ProcessInfo[], run: Runner): Promise<void> {
  await Promise.all(
    processes.map(async (p) => {
      try {
        const out = await run('lsof', ['-p', String(p.pid), '-a', '-d', 'cwd', '-Fn']);
        // `-Fn` field output: a 'p<pid>' line, then 'n<path>' — take the first 'n' line's value.
        const line = out.split('\n').find((l) => l.startsWith('n'));
        if (line) p.cwd = line.slice(1);
      } catch {
        // best-effort: permissions, process exited between listing and lookup, lsof absent, etc.
      }
    })
  );
}

// ── Linux (/proc) ────────────────────────────────────────────────────────────

/** Parses `/proc/<pid>/stat`'s space-separated fields, correctly skipping the `(comm)` field even
 * when the process name itself contains spaces or parentheses (the kernel wraps it in the LAST
 * matching `)` before the remaining fixed-count numeric fields — the standard, documented way to
 * parse this file). Returns `{ppid, starttimeTicks}` or `null`. */
export function parseProcStat(content: string): { ppid: number; starttimeTicks: number } | null {
  const afterParen = content.lastIndexOf(')');
  if (afterParen === -1) return null;
  const rest = content.slice(afterParen + 1).trim().split(/\s+/);
  // rest[0] = state, rest[1] = ppid, ... rest[19] = starttime (fields 4 and 22 overall, 1-indexed,
  // minus the 2 consumed by pid+comm already).
  const ppid = Number(rest[1]);
  const starttimeTicks = Number(rest[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(starttimeTicks)) return null;
  return { ppid, starttimeTicks };
}

/** `/proc/uptime`'s first field (seconds since boot) -> epoch ms of boot, given `nowMs`. */
export function bootTimeMsFromUptime(uptimeContent: string, nowMs: number): number | null {
  const seconds = Number(uptimeContent.trim().split(/\s+/)[0]);
  if (!Number.isFinite(seconds)) return null;
  return nowMs - seconds * 1000;
}

const CLOCK_TICKS_PER_SEC = 100; // USER_HZ — standard on every Linux distro this app targets

/**
 * Primary: enumerating `procRoot` (default /proc). If that fails, or yields no numeric entries, this throws, and
 * the checked listing reports unavailable. Per-process reads below are best-effort races (a process can exit
 * between readdir and read, or belong to another user): those skip or blank that field and never fail the listing.
 * Not covered: a /proc mounted with hidepid hides other users' processes, so a zero here can mean "not visible"
 * rather than "not running". The alpha hosts are Windows and macOS; this is not verified on a hidepid host.
 */
export async function listProcessesLinux(host: HostLabel, now: () => number = Date.now, procRoot = '/proc'): Promise<ProcessInfo[]> {
  const pids = (await fs.readdir(procRoot)).filter((n) => /^\d+$/.test(n));
  if (pids.length === 0) throw new Error('empty /proc enumeration');
  let bootTimeMs: number | null = null;
  try {
    bootTimeMs = bootTimeMsFromUptime(await fs.readFile(`${procRoot}/uptime`, 'utf8'), now());
  } catch {
    bootTimeMs = null;
  }

  const out: ProcessInfo[] = [];
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    let exe: string | undefined;
    try {
      exe = await fs.readlink(`${procRoot}/${pidStr}/exe`);
    } catch {
      try {
        exe = (await fs.readFile(`${procRoot}/${pidStr}/comm`, 'utf8')).trim();
      } catch {
        continue; // process gone or unreadable — skip, never guess
      }
    }
    const tool = matchCatalog(exe);
    if (!tool) continue;

    let ppid: number | null = null;
    let startedAt: number | null = null;
    try {
      const stat = parseProcStat(await fs.readFile(`${procRoot}/${pidStr}/stat`, 'utf8'));
      if (stat) {
        ppid = stat.ppid;
        startedAt = bootTimeMs !== null ? bootTimeMs + (stat.starttimeTicks / CLOCK_TICKS_PER_SEC) * 1000 : null;
      }
    } catch {
      // process may have exited between readdir and here
    }

    let argv: string[] = [];
    try {
      const raw = await fs.readFile(`${procRoot}/${pidStr}/cmdline`, 'utf8');
      argv = raw.split('\0').filter((s) => s.length > 0);
    } catch {
      // permissions or already gone
    }

    let cwd: string | undefined;
    try {
      cwd = await fs.readlink(`${procRoot}/${pidStr}/cwd`);
    } catch {
      // permissions (a different user's process) — best-effort
    }

    out.push({ pid, ppid, startedAt, exe, host, tool, cwd, ...extractSafeArgInfo(argv) });
  }
  return out;
}

// ── Windows (CIM via PowerShell) ─────────────────────────────────────────────

interface CimProcessRow {
  ProcessId: number;
  ParentProcessId: number | null;
  CreationDate: string | null; // Windows PowerShell 5.1 /Date(milliseconds)/, or ISO 8601.
  ExecutablePath: string | null;
  CommandLine: string | null;
}

/** Parses the fixed CIM command's single-object or array result without exposing raw argv. */
export function parseCimProcessJson(json: string): CimProcessRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []; // ConvertTo-Json omits the array wrapper for a single result
  return arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).ProcessId === 'number')
    .map((r) => ({
      ProcessId: r.ProcessId as number,
      ParentProcessId: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : null,
      CreationDate: typeof r.CreationDate === 'string' ? r.CreationDate : null,
      ExecutablePath: typeof r.ExecutablePath === 'string' ? r.ExecutablePath : null,
      CommandLine: typeof r.CommandLine === 'string' ? r.CommandLine : null,
    }));
}

const POWERSHELL_LIST_PROCESSES_SCRIPT =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress';

/** The legacy PowerShell JSON date carries UTC epoch milliseconds, not an ISO string.
 * Preserve unavailable/invalid dates as unknown rather than inventing a process age. */
export function parseCimCreationDate(value: string | null): number | null {
  if (!value) return null;
  const legacy = /^\/Date\((-?\d+)\)\/$/.exec(value);
  const ms = legacy ? Number(legacy[1]) : Date.parse(value);
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : null;
}

export async function listProcessesWindows(host: HostLabel, run: Runner = defaultRunner): Promise<ProcessInfo[]> {
  let stdout: string;
  try {
    stdout = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_LIST_PROCESSES_SCRIPT]);
  } catch {
    return [];
  }
  // A failed or unusable listing is not zero processes. Only a CIM listing whose rows all carry a ProcessId is usable.
  if (!usableCimListing(stdout)) throw new Error('unusable Windows process listing');
  const rows = parseCimProcessJson(stdout);
  const out: ProcessInfo[] = [];
  for (const r of rows) {
    const exe = r.ExecutablePath ?? tokenize(r.CommandLine ?? '')[0] ?? '';
    if (!exe) continue;
    const tool = matchCatalog(exe);
    if (!tool) continue;
    const startedAt = parseCimCreationDate(r.CreationDate);
    out.push({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      startedAt,
      exe,
      host,
      tool,
      ...extractSafeArgInfo(tokenize(r.CommandLine ?? '')),
    });
  }
  return out;
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/** Lists every currently-running process recognized as a known agent/LLM client (`AGENT_CATALOG`),
 * on whichever platform this process is running on (or `opts.platform` override, for tests). Any
 * failure at the OS-command level (missing tool, permission denial, non-zero exit) yields an empty
 * array rather than throwing — a diagnostics endpoint must never take the daemon down. */
/** A process listing that either succeeded (possibly with zero matches) or could not be taken. An
 * unavailable listing is unknown: it must never be reported as "no agents running". */
export type ProcessListing = { status: 'ok'; processes: ProcessInfo[] } | { status: 'unavailable' };

/** Checked listing: a failed OS command, a timeout, or unusable output yields `unavailable`. Only a
 * listing that ran and parsed yields `ok`, and `ok` with an empty array means zero matches. */
export async function listAgentProcessesChecked(
  host: HostLabel,
  opts?: { platform?: NodeJS.Platform; run?: Runner; now?: () => number; procRoot?: string }
): Promise<ProcessListing> {
  const platform = opts?.platform ?? os.platform();
  const base = opts?.run ?? defaultRunner;
  // Only a failure of a PRIMARY command makes the listing unavailable. Best-effort enrichment (lsof for cwd)
  // may fail per process without discarding the identity that the primary listing already measured.
  let primaryCommandFailed = false;
  const run: Runner = async (cmd, args) => {
    try {
      return await base(cmd, args);
    } catch (err) {
      if (!BEST_EFFORT_COMMANDS.has(cmd)) primaryCommandFailed = true;
      throw err;
    }
  };
  try {
    const processes =
      platform === 'darwin'
        ? await listProcessesDarwin(host, run)
        : platform === 'win32'
          ? await listProcessesWindows(host, run)
          : await listProcessesLinux(host, opts?.now, opts?.procRoot);
    // Windows swallows its own primary command failure into [], so the recorded flag is what makes it unavailable.
    return primaryCommandFailed ? { status: 'unavailable' } : { status: 'ok', processes };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Commands whose failure is per-process and best-effort (see attachCwdViaLsof). Every other command is primary. */
const BEST_EFFORT_COMMANDS: ReadonlySet<string> = new Set(['lsof']);

/** Back-compatible: unavailable is reported as an empty list, exactly as before. Use the checked variant
 * wherever the difference between "none" and "unknown" matters. */
export async function listAgentProcesses(
  host: HostLabel,
  opts?: { platform?: NodeJS.Platform; run?: Runner; now?: () => number; procRoot?: string }
): Promise<ProcessInfo[]> {
  const listing = await listAgentProcessesChecked(host, opts);
  return listing.status === 'ok' ? listing.processes : [];
}

/**
 * True only for a usable Win32_Process listing: JSON that is a non-empty array, or a single object (ConvertTo-Json
 * drops the array for one result), in which every row has a numeric ProcessId. Valid JSON that is not a listing
 * (null, a bare number or string, `{}`, `[]`, rows without ProcessId) is unusable. A listing with rows that match
 * no recognized agent is usable and is a measured zero, because only the catalog match decides agent presence.
 */
export function usableCimListing(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim());
  } catch {
    return false;
  }
  const rows: unknown[] | null = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === 'object' ? [parsed] : null;
  if (!rows || rows.length === 0) return false;
  return rows.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r) && typeof (r as Record<string, unknown>).ProcessId === 'number');
}
