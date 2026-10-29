/**
 * Qwen Code CLI collector (build item 1; docs/research/agent-inventory-2026-09-27.md §"Qwen Code
 * CLI" — the cleanest, most self-contained usage schema found in the whole sweep: a per-request,
 * per-model, per-session ledger with cache/thinking token breakout already built in).
 *
 * Real verified files (this Mac, 2026-09-27, `~/.qwen/usage/token-usage-2026-09.jsonl`):
 *   {"schemaVersion":1,"id":"e6954d75-...","timestamp":"2026-09-21T16:49:25.175Z",
 *    "localDate":"2026-09-21","localMonth":"2026-09","sessionId":"8a22879b-...",
 *    "model":"hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL","authType":"openai","source":"main",
 *    "inputTokens":12524,"outputTokens":97,"cachedTokens":0,"thoughtsTokens":24,
 *    "totalTokens":12621,"apiDurationMs":247460}
 * Verified arithmetic on the real lines: `totalTokens === inputTokens + outputTokens` (cached and
 * thoughts are NOT added on top — they are subsets, matching this codebase's TokenCounts
 * convention: `output` INCLUDES reasoning; the input side's cache split is the usual
 * fresh-vs-cached-subset shape seen in every other collector). `thoughtsTokens <= outputTokens`
 * held on every real sample (24<=97, 38<=49) — consistent with "thoughts are inside output".
 * No real sample had `cachedTokens > 0`; treating it as a SUBSET of `inputTokens` (rather than
 * additional) is the standard convention this codebase already uses for Codex/Ollama and is the
 * only reading consistent with the verified `totalTokens` arithmetic (input+output, nothing else),
 * so `inputFresh = max(0, inputTokens - cachedTokens)` degrades correctly to `inputTokens` in
 * every real sample seen. Revisit if a future real line ever shows `cachedTokens>0` disagreeing
 * with this.
 *
 * `usage_record.jsonl` (session-level rollup) was checked against the per-request lines for the
 * SAME sessions and found to be a pure aggregate — e.g. one real session's two token-usage lines
 * (input 12524+12622, output 97+49, thoughts 24+38) sum to exactly its usage_record row's
 * `models[model]` totals (25146/146/62). Ingesting it as usage would double count, so it never
 * produces a UsageEvent (task spec: "only if it adds data without double counting — determine
 * from real files" — determined: it does not, for tokens). It DOES add one thing the per-request
 * lines lack: `project` (cwd) — used here only to attribute `UsageEvent.project` by sessionId,
 * never to emit additional events.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ActivityMark,
  Collector,
  EventFlag,
  IngestContext,
  IngestStats,
  TokenCounts,
  TokeneloConfig,
  UsageComponent,
  UsageEvent,
} from '../core/types.js';
import { statSafe, type SafeStat } from './fswalk.js';
import { readNewCompleteLines } from './claude.js';

const BATCH_SIZE = 2000;

/** `config.qwen.roots`, else `~/.qwen` (no env-var equivalent of CODEX_HOME/CLAUDE_CONFIG_DIR is
 * documented for Qwen Code; this matches the real install verified on this host). */
export function resolveQwenRoots(config: TokeneloConfig, home: string = os.homedir()): string[] {
  if (config.qwen.roots && config.qwen.roots.length > 0) return config.qwen.roots;
  return [path.join(home, '.qwen')];
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Every `usage/token-usage-*.jsonl` file under one root — new months simply appear as new files. */
function listUsageFiles(root: string): string[] {
  const dir = path.join(root, 'usage');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /^token-usage-.*\.jsonl$/i.test(e.name))
    .map((e) => path.join(dir, e.name));
}

/** `usage_record.jsonl` sits directly under the root (verified path). Absent on a fresh/older
 * install — callers treat "no file" the same as "no project attribution available", never an error. */
function usageRecordPath(root: string): string {
  return path.join(root, 'usage_record.jsonl');
}

/** `qwen-code:<line id>` — the line's own `id` field is already a per-request UUID (verified
 * unique across every real sample on this host), so it is a dedup key on its own; no fallback is
 * needed the way Claude's collector needs one for lines that sometimes lack `message.id`. */
export function makeQwenEventId(id: string): string {
  return `qwen-code:${id}`;
}

interface QwenUsageLine {
  id: string;
  timestamp: string;
  sessionId: string;
  model: string;
  authType?: 'qwen-oauth' | 'openai';
  source?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  thoughtsTokens: number;
  apiDurationMs?: number;
}

function parseUsageLine(raw: Record<string, unknown>): QwenUsageLine | null {
  const id = strOrUndef(raw.id);
  const timestamp = strOrUndef(raw.timestamp);
  const sessionId = strOrUndef(raw.sessionId);
  const model = strOrUndef(raw.model);
  if (!id || !timestamp || !sessionId || !model) return null;
  return {
    id,
    timestamp,
    sessionId,
    model,
    // Allowlisted method only: never persist arbitrary auth strings, keys or endpoints.
    authType: raw.authType === 'qwen-oauth' || raw.authType === 'openai' ? raw.authType : undefined,
    source: strOrUndef(raw.source),
    inputTokens: numOr0(raw.inputTokens),
    outputTokens: numOr0(raw.outputTokens),
    cachedTokens: numOr0(raw.cachedTokens),
    thoughtsTokens: numOr0(raw.thoughtsTokens),
    apiDurationMs: typeof raw.apiDurationMs === 'number' ? raw.apiDurationMs : undefined,
  };
}

function buildEvent(line: QwenUsageLine, ctx: IngestContext, project: string | undefined): UsageEvent | null {
  const ts = Date.parse(line.timestamp);
  if (!Number.isFinite(ts)) return null;

  const cacheRead = Math.min(line.cachedTokens, line.inputTokens);
  const inputFresh = Math.max(0, line.inputTokens - cacheRead);
  const reasoning = Math.min(line.thoughtsTokens, line.outputTokens);
  const reasoningClamped = line.thoughtsTokens > line.outputTokens;
  const tokens: TokenCounts = {
    inputFresh,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead,
    output: line.outputTokens,
    reasoning,
  };
  if (tokens.inputFresh === 0 && tokens.cacheRead === 0 && tokens.output === 0) return null; // all-zero, matches other collectors' skip rule

  const servingRoute: NonNullable<UsageComponent['servingRoute']> = line.authType === 'qwen-oauth'
    ? { kind: 'hosted', evidence: 'qwen-oauth' }
    : { kind: 'unknown', evidence: line.authType === 'openai' ? 'qwen-openai-compatible' : 'unrecorded' };
  const component: UsageComponent = { model: line.model, tokens, servingRoute };
  const provider = ctx.pricing.providerOf(line.model, servingRoute);
  const thinking = line.thoughtsTokens > 0; // task spec: "thinking from thoughtsTokens>0" — always determinable, never null

  const flags: EventFlag[] = [];
  if (reasoningClamped) flags.push('reasoningClamped');
  // Source identifies the client, not the serving location. OpenAI-compatible auth may
  // target a local or cloud endpoint; neither a GGUF name nor current config proves the
  // historical request's route.

  const priceResult = ctx.pricing.priceEvent({ components: [component] });
  for (const f of priceResult.flags) if (!flags.includes(f)) flags.push(f);
  const ucuResult = ctx.computeUnits.ucuForEvent({ components: [component], thinking });

  return {
    id: makeQwenEventId(line.id),
    host: ctx.host,
    source: 'qwen-code',
    ts,
    tsSource: 'line',
    sessionId: line.sessionId,
    isSubagent: false,
    project,
    entrypoint: line.source,
    model: line.model,
    provider,
    thinking,
    components: [component],
    tokens,
    durationMs: line.apiDurationMs,
    flags,
    apiEquivUsd: priceResult.usd,
    priceStatus: priceResult.status,
    priceVersion: ctx.pricing.version,
    reservedValue: ucuResult.reservedValue,
    ucuRateStatus: ucuResult.status,
    eacsDefSha256: ctx.computeUnits.defSha256,
  };
}

function buildActivityMark(line: QwenUsageLine, host: string): ActivityMark | null {
  const ts = Date.parse(line.timestamp);
  if (!Number.isFinite(ts)) return null;
  return { source: 'qwen-code', sessionId: line.sessionId, ts, uuid: line.id, host };
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Reads `usage_record.jsonl` in full each scan (small file — a per-session rollup log, not a
 * high-volume stream like the per-request ledger) and returns sessionId -> project. Never emits
 * events; see module doc for why. A missing/unreadable file yields an empty map, not an error.
 */
function readProjectBySession(root: string): Map<string, string> {
  const map = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(usageRecordPath(root), 'utf8');
  } catch {
    return map;
  }
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const sessionId = strOrUndef(obj.sessionId);
      const project = strOrUndef(obj.project);
      if (sessionId && project) map.set(sessionId, project);
    } catch {
      // best-effort; a malformed rollup line never blocks the real token-usage ingest
    }
  }
  return map;
}

export class QwenCodeCollector implements Collector {
  readonly name = 'qwen-code';

  async scan(ctx: IngestContext): Promise<IngestStats> {
    const startedAt = ctx.now();
    const warnings: string[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let eventsEmitted = 0;
    let bytesRead = 0;

    const roots = resolveQwenRoots(ctx.config);

    for (const root of roots) {
      const projectBySession = readProjectBySession(root);
      const files = listUsageFiles(root);

      for (const filePath of files) {
        let stat: SafeStat;
        try {
          stat = statSafe(filePath);
        } catch (err) {
          ctx.store.recordSkipped(filePath, 'unreadable');
          filesSkipped++;
          warnings.push(`stat failed: ${filePath}: ${String(err)}`);
          continue;
        }

        const prevState = ctx.store.getState(filePath);
        const inoChanged = prevState?.ino !== undefined && prevState.ino !== stat.ino;
        const shrunk = prevState !== undefined && stat.size < prevState.offset;
        const offset = !prevState || inoChanged || shrunk ? 0 : prevState.offset;

        filesScanned++;
        if (offset >= stat.size) {
          if (!prevState || prevState.size !== stat.size || prevState.mtimeMs !== stat.mtimeMs) {
            ctx.store.setState({ key: filePath, size: stat.size, mtimeMs: stat.mtimeMs, offset, ino: stat.ino });
          }
          continue;
        }

        let lines: string[];
        let newOffset: number;
        try {
          ({ lines, newOffset } = readNewCompleteLines(filePath, offset, stat.size));
        } catch (err) {
          ctx.store.recordSkipped(filePath, 'unreadable');
          filesSkipped++;
          warnings.push(`read failed: ${filePath}: ${String(err)}`);
          continue;
        }
        bytesRead += newOffset - offset;

        const events: UsageEvent[] = [];
        const marks: ActivityMark[] = [];
        for (const raw of lines) {
          if (raw.trim().length === 0) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(raw) as Record<string, unknown>;
          } catch (err) {
            const errName = err instanceof Error ? err.name : 'UnknownError';
            warnings.push(`parse error in ${filePath}: ${errName}`);
            continue;
          }
          const line = parseUsageLine(obj);
          if (!line) continue;
          const mark = buildActivityMark(line, ctx.host);
          if (mark) marks.push(mark);
          const event = buildEvent(line, ctx, projectBySession.get(line.sessionId));
          if (!event) continue;
          events.push(event);
          eventsEmitted++;
        }

        for (const batch of chunk(events, BATCH_SIZE)) ctx.store.upsertEvents(batch);
        for (const batch of chunk(marks, BATCH_SIZE)) ctx.store.recordActivity(batch);

        ctx.store.setState({ key: filePath, size: stat.size, mtimeMs: stat.mtimeMs, offset: newOffset, ino: stat.ino });
      }
    }

    return { collector: this.name, filesScanned, filesSkipped, eventsEmitted, bytesRead, warnings, durationMs: ctx.now() - startedAt };
  }
}
