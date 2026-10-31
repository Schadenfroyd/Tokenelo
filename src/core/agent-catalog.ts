/**
 * Known-agent/LLM-client catalog (build item 6: "keep the known-tool catalog in a data file so
 * it's easy to extend"). One row per tool named in
 * `docs/research/agent-inventory-2026-09-27.md`'s per-host matrix — this file is the single
 * source of truth `queries.ts#getCoverage` and `collectors/processes.ts` both read, so adding a
 * newly-discovered agent/tool means adding one entry here, not touching either of those modules.
 *
 * `processMatch` is tested against a running process's executable path (case-insensitive
 * substring/regex on the full path, so it matches both a bare binary name on PATH and an app
 * bundle's nested executable, e.g. `/Applications/Rocky.app/.../codex`). `installPaths` are
 * extra, home-relative paths (per platform) whose mere EXISTENCE proves "installed" even with no
 * process currently running (e.g. `~/.qwen` after Qwen Code has been used at least once). `source`
 * is the `UsageEvent.source` a real tokenelo collector attributes this tool's usage to, when one
 * exists — `getCoverage` uses it to look up "captured / last event" from the ledger. `capturedVia`
 * documents which collector, for humans reading this file. `notCapturableReason`, when set, is
 * shown regardless of any process/install detection — it means "this codebase made a deliberate,
 * evidence-based decision not to build a collector for this tool" (docs/research/
 * agent-inventory-2026-09-27.md's "Not recommended" list), never "not detected yet".
 */
import type { CoverageCategory, LimitSnapshot, Provider, Source } from './types.js';

/** The exact event family that proves one tool/source is producing local telemetry. */
export interface EventTelemetrySelector {
  source: Source;
  provider?: Provider;
  engine?: string;
  /** Older proxy-ledger rows predate engine attribution; accept them only where unambiguous. */
  allowMissingEngine?: boolean;
}

export interface AgentCatalogEntry {
  id: string;
  name: string;
  category: CoverageCategory;
  /** Case-insensitive; tested against a live process's resolved executable path. */
  processMatch?: RegExp;
  /** When set and it matches too, `processMatch` is treated as a non-match — lets a narrow CLI
   * pattern (e.g. `/claude$/i`) exclude a same-named binary bundled inside an unrelated app (see
   * `claude-code-cli`'s own comment for the real false-positive this guards against). */
  excludeMatch?: RegExp;
  /** Home-relative paths (no leading slash) per platform, checked for existence. */
  installPaths?: Partial<Record<'darwin' | 'win32' | 'linux', string[]>>;
  /** Set when this tool's usage is captured as `UsageEvent`s (the `events` table). */
  source?: Source;
  /** When set, narrows/extends `source` to the actual telemetry feed(s) for this tool. */
  eventSelectors?: readonly EventTelemetrySelector[];
  /** Set when this tool is captured as `LimitSnapshot`s instead (the `limits` table) — e.g.
   * Claude Desktop's plan-usage-history.json, which carries no tokens at all, only plan-window
   * percentages (build item 2). Mutually exclusive with `source` in every real catalog entry. */
  limitsSource?: LimitSnapshot['source'];
  capturedVia?: string;
  notCapturableReason?: string;
  /** Current collector boundary, distinct from whether a vendor can emit telemetry. */
  captureSupport?: 'unsupported' | 'not-capturable';
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  // ── Captured by a real tokenelo collector ──────────────────────────────────
  {
    id: 'claude-code-cli',
    name: 'Claude Code CLI',
    category: 'cloud-agent-cli',
    processMatch: /(^|[\\/])claude(\.exe)?$/i,
    // REAL BUG found on this Mac, 2026-09-27: without this exclusion, the Claude DESKTOP app's
    // own main process (`/Applications/Claude.app/Contents/MacOS/Claude`) also matches
    // `processMatch` (its path ends in "/Claude", case-insensitively) and was mislabeled as the
    // CLI — wrongly reporting "CLI running" when only the Desktop app was. Any `.app/Contents/`
    // bundle path is never a bare CLI binary on macOS.
    excludeMatch: /\.app[\\/]Contents[\\/]/i,
    installPaths: { darwin: ['.claude'], win32: ['.claude'], linux: ['.claude'] },
    source: 'claude',
    capturedVia: 'collectors/claude.ts',
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    category: 'cloud-agent-cli',
    processMatch: /(^|[\\/])codex(\.exe)?$/i,
    installPaths: { darwin: ['.codex'], win32: ['.codex'], linux: ['.codex'] },
    source: 'codex',
    capturedVia: 'collectors/codex.ts, codex-sqlite.ts',
  },
  {
    id: 'codex-desktop-rocky',
    name: 'Codex Desktop ("Rocky")',
    category: 'cloud-agent-desktop',
    // Rocky.app's process tree spawns the vendored codex binary from inside the app bundle
    // (agent-inventory-2026-09-27.md "Rocky.app identified") — same CLI, already captured via
    // ~/.codex/sessions; this entry exists only so the live Rocky.app/ChatGPT.app (codex-family)
    // processes are recognized and attributed to the SAME tool as codex-cli, not left unmatched.
    processMatch: /Rocky\.app|codex-code-mode-host|codex-computer-use|codex-windows-sandbox-service|ChatGPT\.app.*Codex/i,
    source: 'codex',
    capturedVia: 'collectors/codex.ts (originator "rocky-desktop" is the same ~/.codex/sessions tree)',
  },
  {
    id: 'qwen-code-cli',
    name: 'Qwen Code CLI',
    category: 'cloud-agent-cli',
    processMatch: /(^|[\\/])qwen(\.exe)?$/i,
    installPaths: { darwin: ['.qwen'], win32: ['.qwen'], linux: ['.qwen'] },
    source: 'qwen-code',
    capturedVia: 'collectors/qwen-code.ts',
  },
  {
    id: 'ollama',
    name: 'Ollama',
    category: 'local-llm-server',
    processMatch: /(^|[\\/])ollama(\.exe)?$|llama-server/i,
    source: 'ollama-proxy',
    eventSelectors: [
      { source: 'ollama-proxy', provider: 'local', engine: 'ollama', allowMissingEngine: true },
      { source: 'ollama-log', provider: 'local' },
    ],
    capturedVia: 'collectors/ollama-proxy.ts (source \'ollama-proxy\') or ollama-serverlog.ts (source \'ollama-log\')',
  },
  {
    id: 'claude-local-models',
    name: 'Local models via Claude Code',
    category: 'local-llm-server',
    source: 'claude',
    eventSelectors: [{ source: 'claude', provider: 'local' }],
    capturedVia: 'collectors/claude.ts (local-provider event from Claude JSONL)',
  },
  {
    id: 'docker-model-runner',
    name: 'Docker Model Runner',
    category: 'local-llm-server',
    processMatch: /com\.docker.*model-runner|docker-model-runner/i,
    eventSelectors: [{ source: 'ollama-proxy', provider: 'local', engine: 'docker-model-runner' }],
    capturedVia: "collectors/ollama-proxy.ts via config.local.upstreams[] (UsageEvent.engine = the configured name)",
  },
  {
    id: 'vllm',
    name: 'vLLM',
    category: 'local-llm-server',
    processMatch: /vllm/i,
    eventSelectors: [{ source: 'ollama-proxy', provider: 'local', engine: 'vllm' }],
    capturedVia: "collectors/ollama-proxy.ts via config.local.upstreams[] (UsageEvent.engine = the configured name)",
  },

  // ── Detected (metadata only) / not a usage source ───────────────────────────
  {
    id: 'claude-desktop',
    name: 'Claude Desktop app',
    category: 'cloud-agent-desktop',
    processMatch: /Claude\.app|Claude Helper/i,
    installPaths: { darwin: ['Library/Application Support/Claude'], win32: ['AppData/Roaming/Claude'], linux: ['.config/Claude'] },
    limitsSource: 'claude-desktop',
    capturedVia: 'collectors/claude-desktop.ts (plan-usage-history.json real plan-window %; claude-code-sessions metadata) — the plain claude.ai chat surface itself is NOT capturable, see its own entry',
  },
  {
    id: 'claude-desktop-chat',
    name: 'Claude Desktop — plain chat (non-Code)',
    category: 'cloud-agent-desktop',
    notCapturableReason:
      'claude.ai chat conversations are metered server-side against the account plan; only a usage-PERCENT history persists locally (plan-usage-history.json, captured — see "Claude Desktop app"), never per-message token counts',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    category: 'cloud-agent-desktop',
    processMatch: /Cursor\.app|(^|[\\/])Cursor(\.exe)?$/i,
    installPaths: { darwin: ['.cursor', 'Library/Application Support/Cursor'], win32: ['.cursor'], linux: ['.cursor'] },
    notCapturableReason:
      "the local ai-tracking/ai-code-tracking.db has zero token/cost columns in any table (schema-verified); real usage lives only in Cursor's cloud dashboard",
  },
  {
    id: 'comfyui',
    name: 'ComfyUI',
    category: 'other',
    processMatch: /comfyui/i,
    notCapturableReason: 'image generation, not a text-LLM token source — out of this tool\'s token/cost domain',
  },

  // ── Confirmed absent on every host swept, kept for future re-detection ──────
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    category: 'cloud-agent-cli',
    processMatch: /(^|[\\/])gemini(\.exe)?$/i,
    installPaths: { darwin: ['.gemini'], win32: ['.gemini'], linux: ['.gemini'] },
  },
  { id: 'opencode', name: 'OpenCode', category: 'cloud-agent-cli', installPaths: { darwin: ['.local/share/opencode'], linux: ['.local/share/opencode'] } },
  { id: 'amp', name: 'Amp', category: 'cloud-agent-cli' },
  { id: 'aider', name: 'Aider', category: 'cloud-agent-cli' },
  { id: 'goose', name: 'Goose', category: 'cloud-agent-cli' },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    category: 'other',
    captureSupport: 'unsupported',
    notCapturableReason: 'Tokenelo has no Copilot collector. VS Code supports optional local OpenTelemetry token metadata exports; their configuration, installed extension compatibility and capture completeness have not been verified here.',
  },
  { id: 'continue', name: 'Continue', category: 'other' },
  { id: 'cline-roo-kilo', name: 'Cline / Roo / Kilo', category: 'other' },
  { id: 'windsurf', name: 'Windsurf', category: 'cloud-agent-desktop' },
  { id: 'zed', name: 'Zed', category: 'cloud-agent-desktop' },
  { id: 'jetbrains-ai', name: 'JetBrains AI', category: 'other' },
  { id: 'warp-ai', name: 'Warp AI', category: 'other' },
  { id: 'raycast-ai', name: 'Raycast AI', category: 'other' },
  {
    id: 'lm-studio',
    name: 'LM Studio',
    category: 'local-llm-server',
    processMatch: /LM ?Studio/i,
    installPaths: { darwin: ['.lmstudio'], win32: ['.lmstudio'], linux: ['.lmstudio'] },
  },
  { id: 'jan', name: 'Jan', category: 'local-llm-server' },
  { id: 'gpt4all', name: 'GPT4All', category: 'local-llm-server' },
  { id: 'open-webui', name: 'Open WebUI', category: 'local-llm-server' },
];
