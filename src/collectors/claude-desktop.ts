/**
 * Claude Desktop app collectors (build items 2/3; docs/research/agent-inventory-2026-09-27.md
 * "Claude Desktop app is a second, uncounted Claude Code usage surface"). Two independent,
 * read-only scanners over `~/Library/Application Support/Claude` (macOS)/`%APPDATA%\Claude`
 * (Windows)/`$XDG_CONFIG_HOME/Claude` (Linux, unverified — no Desktop install found on ryzen this
 * pass, kept for completeness):
 *
 * 1. `ClaudeDesktopPlanUsageCollector` — `plan-usage-history.json`: `{version:2, samples:[{t, org,
 *    u:{fh, sd}}]}`. Verified empirically on this host, 2026-09-27 (538 samples, ~15-min cadence,
 *    2026-08-28..2026-09-27): `fh` resets to a low value 55 times over 30 days (every few hours of
 *    active use — matches a **five-hour** window), `sd` resets only 8 times (roughly weekly —
 *    matches **seven-day**); both range 0-100, i.e. PERCENTAGES, not fractions. This is exactly the
 *    live plan-window telemetry DESIGN §6/log-formats.md §1.7 said the bare CLI never persists —
 *    the Desktop app does, whenever it (not the bare CLI) is running. Mapped straight onto the
 *    existing `LimitWindow` ids `'five_hour'`/`'seven_day'` (no new id needed) with
 *    `estimate: false` (contrast `claude-block-estimate`). `org` is a real account UUID — hashed
 *    (truncated SHA-256) before it's ever stored, per the task's "never store raw account
 *    identifiers beyond what's needed". Incremental: a per-file cursor (`IngestState.extra.
 *    lastSampleT`) means the first scan backfills the whole history (deliberate — "time series of
 *    plan usage available via API") and every later scan appends only newer samples, so the
 *    `limits` table never re-inserts the same sample twice.
 *
 * 2. `ClaudeDesktopSessionsCollector` — `claude-code-sessions/**\/local_<uuid>.json` and
 *    `local-agent-mode-sessions/**\/local_<uuid>.json` (same schema; verified real file,
 *    2026-09-27): per-session bookkeeping keyed by `cliSessionId` (the REAL Claude Code CLI
 *    session id, already ingested from `~/.claude/projects/**\/*.jsonl` by `claude.ts` — this
 *    module never emits a UsageEvent or touches tokens at all, only repo/PR/title attribution for
 *    the session-detail window). Explicitly allow-lists the fields it reads (never the whole
 *    object) — the real file also carries `remoteMcpServersConfig`, `sessionPermissionUpdates`,
 *    `bridgeSessionIds`, `spawnSeed`, none of which are prompt/response content but none of which
 *    this app needs either, so they are simply never read. A file with no `cliSessionId` at all
 *    (e.g. the real `local-agent-mode-sessions/**\/scheduled-tasks.json` sibling found on this
 *    host) is skipped, not an error. Change detection is `mtimeMs`+`size` (IngestState), like every
 *    other collector's incremental-skip check, and never a byte-offset read (these are small,
 *    whole-file JSON documents, not append-only logs).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Collector,
  DesktopSessionMeta,
  IngestContext,
  IngestStats,
  LimitSnapshot,
  TokeneloConfig,
} from '../core/types.js';
import { statSafe, type SafeStat } from './fswalk.js';

export interface ResolveClaudeDesktopRootOpts {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

/** `config.claudeDesktop.root`, else the platform's Claude Desktop `Application Support`-
 * equivalent dir (never the bare CLI's `~/.claude` — a different app, a different store). */
export function resolveClaudeDesktopRoot(config: TokeneloConfig, opts?: ResolveClaudeDesktopRootOpts): string {
  if (config.claudeDesktop.root) return config.claudeDesktop.root;
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const home = opts?.home ?? os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ── 1. plan-usage-history.json ──────────────────────────────────────────────

/** Truncated SHA-256 (16 hex chars) of an org id — enough to distinguish accounts without ever
 * persisting the raw identifier (task spec: "hash the org id; never store raw account identifiers
 * beyond what's needed"). */
export function hashOrgId(org: string): string {
  return createHash('sha256').update(org).digest('hex').slice(0, 16);
}

interface PlanUsageSample {
  t: number;
  org: string;
  fh: number;
  sd: number;
}

/** Parses one `samples[]` entry; `null` for any shape other than the verified `{t, org,
 * u:{fh, sd}}` (never guessed — an older/newer format is simply not ingested, and would show up
 * as "0 events" from this collector rather than a fabricated number). */
export function parsePlanUsageSample(raw: unknown): PlanUsageSample | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const t = o.t;
  const org = o.org;
  const u = o.u;
  if (typeof t !== 'number' || !Number.isFinite(t) || typeof org !== 'string' || !org) return null;
  if (!u || typeof u !== 'object') return null;
  const fh = (u as Record<string, unknown>).fh;
  const sd = (u as Record<string, unknown>).sd;
  if (typeof fh !== 'number' || !Number.isFinite(fh) || typeof sd !== 'number' || !Number.isFinite(sd)) return null;
  return { t, org, fh, sd };
}

export function buildPlanUsageSnapshot(sample: PlanUsageSample, host: string): LimitSnapshot {
  return {
    source: 'claude-desktop',
    host,
    account: hashOrgId(sample.org),
    capturedAt: sample.t,
    windows: [
      { id: 'five_hour', usedPercent: sample.fh },
      { id: 'seven_day', usedPercent: sample.sd },
    ],
    estimate: false,
  };
}

interface PlanUsageCursor {
  lastSampleT: number;
}
function isPlanUsageCursor(x: unknown): x is PlanUsageCursor {
  return !!x && typeof x === 'object' && typeof (x as PlanUsageCursor).lastSampleT === 'number';
}

export class ClaudeDesktopPlanUsageCollector implements Collector {
  readonly name = 'claude-desktop-plan-usage';

  async scan(ctx: IngestContext): Promise<IngestStats> {
    const startedAt = ctx.now();
    const warnings: string[] = [];
    const root = resolveClaudeDesktopRoot(ctx.config);
    const filePath = path.join(root, 'plan-usage-history.json');

    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      // No Desktop app / never used the Code feature on this host — not an error.
      return { collector: this.name, filesScanned: 0, filesSkipped: 0, eventsEmitted: 0, bytesRead: 0, warnings, durationMs: ctx.now() - startedAt };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      warnings.push(`parse error in ${filePath}: ${err instanceof Error ? err.name : 'UnknownError'}`);
      return { collector: this.name, filesScanned: 1, filesSkipped: 1, eventsEmitted: 0, bytesRead: text.length, warnings, durationMs: ctx.now() - startedAt };
    }
    const samples = Array.isArray((parsed as Record<string, unknown> | null)?.samples)
      ? ((parsed as Record<string, unknown>).samples as unknown[])
      : [];

    const stateKey = `claude-desktop-plan-usage:${filePath}`;
    const prev = ctx.store.getState(stateKey);
    const lastSampleT = isPlanUsageCursor(prev?.extra) ? prev.extra.lastSampleT : -Infinity;
    let maxSeenT = lastSampleT;
    let emitted = 0;

    for (const raw of samples) {
      const sample = parsePlanUsageSample(raw);
      if (!sample) continue;
      if (sample.t <= lastSampleT) continue;
      ctx.store.recordLimits(buildPlanUsageSnapshot(sample, ctx.host));
      emitted++;
      if (sample.t > maxSeenT) maxSeenT = sample.t;
    }

    let stat: SafeStat | undefined;
    try {
      stat = statSafe(filePath);
    } catch {
      stat = undefined;
    }
    ctx.store.setState({
      key: stateKey,
      size: stat?.size ?? text.length,
      mtimeMs: stat?.mtimeMs ?? 0,
      offset: 0,
      ...(stat ? { ino: stat.ino } : {}),
      extra: { lastSampleT: maxSeenT },
    });

    return {
      collector: this.name,
      filesScanned: 1,
      filesSkipped: 0,
      eventsEmitted: emitted,
      bytesRead: text.length,
      warnings,
      durationMs: ctx.now() - startedAt,
    };
  }
}

// ── 2. claude-code-sessions / local-agent-mode-sessions metadata ───────────

const SESSION_META_SUBDIRS = ['claude-code-sessions', 'local-agent-mode-sessions'];

/** Recursively collects every `*.json` file under `dir`, bounded to EXACTLY the documented real
 * layout depth: `<root>/<subdir>/<installId>/<orgId>/local_<uuid>.json` — two directory levels
 * (installId, orgId) below `dir` (`<root>/<subdir>`), then leaf files only. Verified necessary,
 * not just defensive: a real scan on this host found `local_baeeb764-.../` is sometimes a
 * DIRECTORY (a session's own output artifacts) containing a full `outputs/node_modules/...` tree
 * with thousands of unrelated `.json` files (`package.json`, `tsconfig.json`, …) — a deeper cap
 * (this module's first version used 6) walks straight into that and both wastes tens of seconds
 * scanning a node_modules tree AND hits real parse errors on non-JSON-superset files like
 * `tsconfig.json` (comments). Capping at exactly 2 means a `local_<uuid>` that turns out to be
 * such a directory is never descended into at all — it simply isn't a leaf `.json` file at the
 * orgId level, exactly like any other non-file entry there. */
function listJsonFilesRecursive(dir: string, depth = 2): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out.push(...listJsonFilesRecursive(full, depth - 1));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
      out.push(full);
    }
  }
  return out;
}

/** Allow-lists exactly the fields this app uses; every other real key on the file (permission
 * state, MCP config, bridge ids, …) is never read. `null` when the file isn't a session-meta
 * document at all (no `cliSessionId`) — e.g. the real `scheduled-tasks.json` sibling. */
export function parseDesktopSessionFile(obj: Record<string, unknown>): DesktopSessionMeta | null {
  const cliSessionId = strOrUndef(obj.cliSessionId);
  if (!cliSessionId) return null;
  return {
    cliSessionId,
    cwd: strOrUndef(obj.cwd),
    originCwd: strOrUndef(obj.originCwd),
    title: strOrUndef(obj.title),
    model: strOrUndef(obj.model),
    effort: strOrUndef(obj.effort),
    isArchived: typeof obj.isArchived === 'boolean' ? obj.isArchived : undefined,
    createdAt: numOrUndef(obj.createdAt),
    lastActivityAt: numOrUndef(obj.lastActivityAt),
    prNumber: numOrUndef(obj.prNumber),
    prUrl: strOrUndef(obj.prUrl),
    prRepository: strOrUndef(obj.prRepository),
    prState: strOrUndef(obj.prState),
  };
}

export class ClaudeDesktopSessionsCollector implements Collector {
  readonly name = 'claude-desktop-sessions';

  async scan(ctx: IngestContext): Promise<IngestStats> {
    const startedAt = ctx.now();
    const warnings: string[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let eventsEmitted = 0;
    let bytesRead = 0;

    const root = resolveClaudeDesktopRoot(ctx.config);
    const rows: (DesktopSessionMeta & { sourceFile: string })[] = [];

    for (const subdir of SESSION_META_SUBDIRS) {
      for (const filePath of listJsonFilesRecursive(path.join(root, subdir))) {
        filesScanned++;
        let stat: SafeStat;
        try {
          stat = statSafe(filePath);
        } catch (err) {
          filesSkipped++;
          warnings.push(`stat failed: ${filePath}: ${String(err)}`);
          continue;
        }
        const prev = ctx.store.getState(filePath);
        if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) continue; // unchanged since last scan

        let text: string;
        try {
          text = fs.readFileSync(filePath, 'utf8');
        } catch (err) {
          filesSkipped++;
          warnings.push(`read failed: ${filePath}: ${String(err)}`);
          continue;
        }
        bytesRead += text.length;

        let obj: unknown;
        try {
          obj = JSON.parse(text);
        } catch (err) {
          filesSkipped++;
          warnings.push(`parse error in ${filePath}: ${err instanceof Error ? err.name : 'UnknownError'}`);
          continue;
        }
        const meta = obj && typeof obj === 'object' ? parseDesktopSessionFile(obj as Record<string, unknown>) : null;
        if (meta) {
          rows.push({ ...meta, sourceFile: filePath });
          eventsEmitted++;
        }
        ctx.store.setState({ key: filePath, size: stat.size, mtimeMs: stat.mtimeMs, offset: stat.size, ino: stat.ino });
      }
    }

    if (rows.length > 0) ctx.store.upsertDesktopSessionMeta(rows);

    return { collector: this.name, filesScanned, filesSkipped, eventsEmitted, bytesRead, warnings, durationMs: ctx.now() - startedAt };
  }
}
