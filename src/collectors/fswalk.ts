/**
 * Whitelist filesystem walk for the Claude Code collector (DESIGN §15.1.1).
 *
 * Ingest ONLY:
 *   <root>/<proj>/<uuid>.jsonl
 *   <root>/<proj>/<uuid>/subagents/**\/*.jsonl
 * (uuid = 8-4-4-4-12 hex, case-insensitive.)
 *
 * Never descend into `<proj>/memory/`, `.stversions`, `.stfolder`, or any path with a `.claude`
 * segment — this is what keeps the peer-box synced vault
 * (`~/.claude/projects/-home-example-Workspaces/memory/**\/.claude/projects/...`, verified real,
 * docs/research/log-formats.md §1.6) from ever being read, let alone counted: the walk simply
 * never opens the `memory/` directory to look inside it. Every directory-level exclusion and
 * every rejected `*.jsonl` is returned in `skipped` so the caller can `recordSkipped` it for
 * `doctor` (DESIGN §15.7.7) — this is a *whitelist*, so "not whitelisted" is the catch-all reason
 * for anything that doesn't match the two shapes above, not just the named vault/sync cases.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SkipReason } from '../core/types.js';
import { measure } from '../core/phase-profile.js';

/** 8-4-4-4-12 hex, case-insensitive (DESIGN §15.1.1). */
export const CLAUDE_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYNC_CONFLICT_RE = /\.sync-conflict-/i;

export interface ClaudeFileRef {
  /** Absolute path to the .jsonl file. */
  path: string;
  kind: 'session' | 'subagent';
  /** The <uuid> that names this file (session) or its containing session dir (subagent). */
  sessionUuid: string;
  /** For subagent files only: DESIGN §15.1's "parentSessionId = the <uuid> dir name" — same value
   * as sessionUuid here, kept as a distinct, self-documenting field so callers building
   * UsageEvent.parentSessionId don't have to remember which meaning sessionUuid has per kind. */
  parentUuid?: string;
}

export interface SkipRecord {
  path: string;
  reason: SkipReason;
}

export interface WalkResult {
  files: ClaudeFileRef[];
  skipped: SkipRecord[];
}

function reasonForExcludedDirName(name: string): SkipReason {
  // The names can alias the same physical directory on Windows and typical macOS
  // filesystems. Fold exclusions consistently, including nested subagent paths.
  name = name.toLowerCase();
  if (name === 'memory') return 'memory-vault';
  if (name === '.stversions' || name === '.stfolder') return 'syncthing-versions';
  if (name === '.claude') return 'nested-.claude';
  return 'not-whitelisted';
}

/**
 * The walk is one generator. It does no filesystem I/O itself: it yields a request for each directory read and each
 * `subagents` directory check, and the driver answers it. The synchronous walker answers with readdirSync/statSync. The
 * yielding walker answers with fs.promises, so the read itself runs on the libuv threadpool and the main thread stays
 * free while the OS lists the directory. A sampled M4 daemon stack showed synchronous directory discovery inside
 * native ReadDir → scandir → __getdirentries64 on the main thread; this walk is a source candidate. Order, guards,
 * skip records and reasons are identical for both
 * drivers, because both use the same uv_fs_scandir listing and the same generator.
 */
type FsRequest = { op: 'readdir'; path: string } | { op: 'isDir'; path: string };
/** readdir: entries or undefined on failure. isDir: true for a real directory, link for a symlink, otherwise false. */
type FsReply = fs.Dirent[] | boolean | 'link' | undefined;
type WalkSteps = Generator<FsRequest, void, FsReply>;

function* readDir(dir: string): Generator<FsRequest, fs.Dirent[] | undefined, FsReply> {
  return (yield { op: 'readdir', path: dir }) as fs.Dirent[] | undefined;
}

function* isDir(p: string): Generator<FsRequest, boolean | 'link', FsReply> {
  const reply = yield { op: 'isDir', path: p };
  return reply === 'link' ? 'link' : reply === true;
}

function answerSync(req: FsRequest): FsReply {
  if (req.op === 'readdir') {
    try {
      return fs.readdirSync(req.path, { withFileTypes: true });
    } catch {
      return undefined;
    }
  }
  try {
    const info = fs.lstatSync(req.path);
    return info.isSymbolicLink() ? 'link' : info.isDirectory();
  } catch {
    return false;
  }
}

async function answerAsync(req: FsRequest): Promise<FsReply> {
  if (req.op === 'readdir') {
    try {
      return await fsp.readdir(req.path, { withFileTypes: true });
    } catch {
      return undefined;
    }
  }
  try {
    const info = await fsp.lstat(req.path);
    return info.isSymbolicLink() ? 'link' : info.isDirectory();
  } catch {
    return false;
  }
}

/** Recursively collects `*.jsonl` under a session's `subagents/` dir (any depth: DESIGN's
 * `subagents/**\/*.jsonl`, e.g. `subagents/workflows/wf_<id>/agent-<id>.jsonl`), applying the same
 * exclusion guards as the top-level walk in case a sync/backup tool ever nests one of those names
 * this deep (defensive; not observed in real samples, but the rule in §15.1.1 is stated
 * path-generally — "any path with a `.claude` segment" — not "only at the project-dir level"). */
function* walkSubagentsDir(dir: string, parentUuid: string, files: ClaudeFileRef[], skipped: SkipRecord[]): WalkSteps {
  const entries = yield* readDir(dir);
  if (!entries) {
    skipped.push({ path: dir, reason: 'unreadable' });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const excludedReason = reasonForExcludedDirName(entry.name);
      if (excludedReason !== 'not-whitelisted') {
        skipped.push({ path: full, reason: excludedReason });
        continue;
      }
      yield* walkSubagentsDir(full, parentUuid, files, skipped);
    } else if (entry.isFile()) {
      if (!entry.name.toLowerCase().endsWith('.jsonl')) continue;
      if (SYNC_CONFLICT_RE.test(entry.name)) {
        skipped.push({ path: full, reason: 'sync-conflict' });
        continue;
      }
      files.push({ path: full, kind: 'subagent', sessionUuid: parentUuid, parentUuid });
    }
  }
}

/**
 * Walks every root in `roots` for whitelisted Claude Code transcript files. A root that does not
 * exist (e.g. a host with no Claude Code install) is silently skipped — that is not itself a
 * "skip to report", just nothing to scan. Every excluded project-dir entry and every rejected
 * `*.jsonl` directly under a root or project directory IS reported in `skipped`.
 */
export function walkClaudeRoots(roots: readonly string[]): WalkResult {
  const files: ClaudeFileRef[] = [];
  const skipped: SkipRecord[] = [];
  const steps = walkRootsSteps(roots, files, skipped);
  // run to completion: the synchronous walker never pauses
  let step = steps.next();
  while (!step.done) step = steps.next(answerSync(step.value));
  return { files, skipped };
}

/**
 * Pacing hooks for walkClaudeRootsYielding. `due()` is asked once per directory read; `yieldNow()` is awaited when it is
 * true. `aroundIo`, when given, wraps every awaited filesystem call, so a caller's profiling segment can be paused around it.
 */
export interface WalkPacing {
  due(): boolean;
  yieldNow(): Promise<void>;
  aroundIo?<T>(wait: () => Promise<T>): Promise<T>;
}

/**
 * The same walk as walkClaudeRoots, with every directory read and stat awaited off the main thread, and the event loop
 * also given a turn when `pacing.due()` says so. The result is identical to the synchronous walk for the same tree,
 * including order, skip records and reasons (tested). The caller decides how waits are measured; this function never
 * holds a profiling span across an await.
 */
export async function walkClaudeRootsYielding(roots: readonly string[], pacing: WalkPacing): Promise<WalkResult> {
  const files: ClaudeFileRef[] = [];
  const skipped: SkipRecord[] = [];
  const steps = walkRootsSteps(roots, files, skipped);
  let step = steps.next();
  while (!step.done) {
    const req = step.value;
    if (req.op === 'readdir' && pacing.due()) await pacing.yieldNow();
    const reply = pacing.aroundIo ? await pacing.aroundIo(() => answerAsync(req)) : await answerAsync(req);
    step = steps.next(reply);
  }
  return { files, skipped };
}

function* walkRootsSteps(roots: readonly string[], files: ClaudeFileRef[], skipped: SkipRecord[]): WalkSteps {
  for (const root of roots) {
    const projectDirs = yield* readDir(root);
    if (!projectDirs) continue; // root doesn't exist on this host/config — not an error

    for (const proj of projectDirs) {
      const projPath = path.join(root, proj.name);
      if (!proj.isDirectory()) {
        // A JSONL directly under the root is outside the project/session whitelist,
        // but still needs a skip record for Doctor. Never ingest or open its contents.
        if (proj.isFile() && proj.name.toLowerCase().endsWith('.jsonl')) {
          skipped.push({ path: projPath, reason: SYNC_CONFLICT_RE.test(proj.name) ? 'sync-conflict' : 'not-whitelisted' });
        }
        continue;
      }
      // Apply path-general exclusions before entering a project directory too.
      // A root-level project named memory is permitted: DESIGN excludes <proj>/memory,
      // whereas .claude and the Syncthing names are excluded at every descendant level.
      const excludedProjectReason = reasonForExcludedDirName(proj.name);
      if (excludedProjectReason === 'nested-.claude' || excludedProjectReason === 'syncthing-versions') {
        skipped.push({ path: projPath, reason: excludedProjectReason });
        continue;
      }

      const entries = yield* readDir(projPath);
      if (!entries) {
        skipped.push({ path: projPath, reason: 'unreadable' });
        continue;
      }

      for (const entry of entries) {
        const full = path.join(projPath, entry.name);

        if (entry.isFile()) {
          if (!entry.name.toLowerCase().endsWith('.jsonl')) continue; // not our concern at all
          if (SYNC_CONFLICT_RE.test(entry.name)) {
            skipped.push({ path: full, reason: 'sync-conflict' });
            continue;
          }
          const base = entry.name.slice(0, -'.jsonl'.length);
          if (CLAUDE_SESSION_UUID_RE.test(base)) {
            files.push({ path: full, kind: 'session', sessionUuid: base });
          } else {
            skipped.push({ path: full, reason: 'not-whitelisted' });
          }
          continue;
        }

        if (entry.isDirectory()) {
          if (CLAUDE_SESSION_UUID_RE.test(entry.name)) {
            // Only the exact `subagents` child is in the whitelist shape; any other sibling
            // (e.g. `tool-results/`) is simply not part of `<uuid>.jsonl | <uuid>/subagents/**`
            // and is neither walked nor reported — it was never a candidate transcript file.
            const subagentsDir = path.join(full, 'subagents');
            const subagentsKind = yield* isDir(subagentsDir);
            if (subagentsKind === true) {
              yield* walkSubagentsDir(subagentsDir, entry.name, files, skipped);
            } else if (subagentsKind === 'link') {
              // A junction can expose a vault or another project despite this lexical
              // path matching the whitelist. Match Dirent traversal's no-link policy.
              skipped.push({ path: subagentsDir, reason: 'not-whitelisted' });
            }
          } else {
            skipped.push({ path: full, reason: reasonForExcludedDirName(entry.name) });
          }
        }
      }
    }
  }
}

// ── bigint-safe stat (DESIGN §15.9.6) ──────────────────────────────────────

/** 2^53 − 1 as bigint. */
const SAFE_INT_MOD = 9007199254740991n;

/**
 * Reduces an exact file id to a JS safe integer: `Number(ino % (2^53 − 1))`. NTFS file ids exceed
 * 2^53 (A2000: 9,851,624,185,066,820) — node's plain `stat().ino` is then a lossy double, and a
 * raw id stored in SQLite cannot be read back by node:sqlite (RangeError). The reduced value is
 * still a stable per-file identity, which is all `IngestState.ino` is used for ("was this file
 * replaced?").
 */
export function safeIno(ino: bigint): number {
  return Number(ino % SAFE_INT_MOD);
}

export interface SafeStat {
  size: number;
  mtimeMs: number;
  /** Safe-integer file identity (see safeIno). */
  ino: number;
  isFile: boolean;
}

/** A file size or timestamp that cannot be represented exactly by the cursor's JS number fields. */
export class UnsafeStatMetadataError extends RangeError {
  constructor() {
    super('file size or modification time is outside the safe cursor range');
    this.name = 'UnsafeStatMetadataError';
  }
}

/** Converts BigInt stat metadata only when the Number value is exact and safe for cursor arithmetic. */
export function safeStatNumber(value: bigint): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && BigInt(number) === value ? number : undefined;
}

function safeStatFields(b: fs.BigIntStats): SafeStat {
  const size = safeStatNumber(b.size);
  const mtimeMs = safeStatNumber(b.mtimeMs);
  if (size === undefined || size < 0 || mtimeMs === undefined) throw new UnsafeStatMetadataError();
  return { size, mtimeMs, ino: safeIno(b.ino), isFile: b.isFile() };
}

/** Synchronous bigint metadata projection retained for standalone callers. Throws like statSync. */
export function statSafe(p: string): SafeStat {
  return safeStatFields(fs.statSync(p, { bigint: true }));
}

/** Off-thread metadata read for collector scans; preserves the synchronous helper's exact bigint projection. */
export async function statSafeAsync(p: string): Promise<SafeStat> {
  const b = await fsp.stat(p, { bigint: true });
  return measure('fs.stat_fields', () => safeStatFields(b));
}
