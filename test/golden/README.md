# ccusage golden baseline — S6 (M4a)

## Tool version

```
$ npx -y ccusage@latest --version
ccusage 20.0.24
```

Resolved package: `ccusage@20.0.24`, installed via npx cache at
`~/.npm/_npx/<hash>/node_modules/ccusage`. `package.json` shows this is now a
thin Node CLI shim (`src/cli.js`) that spawns a platform-specific native (Rust) binary
(`@ccusage/ccusage-darwin-arm64@20.0.24`). There is no bundled JS parser source to grep for
dedup-key or subagent logic in this installed version — see "What could not be verified" below.

## Exact commands run

Claude Code daily totals, 2026-09-19 through 2026-09-25 inclusive, timezone America/Denver,
JSON output, offline (cached) pricing:

```
npx -y ccusage@latest claude daily \
  --since 20260919 --until 20260925 \
  --timezone America/Denver \
  --json --offline \
  > ccusage-claude-M4a-20260919-20260925.json
```

Codex daily totals, same range/timezone/flags (ccusage has a first-class `codex` subcommand,
confirmed via `ccusage --help` and `ccusage codex --help`):

```
npx -y ccusage@latest codex daily \
  --since 20260919 --until 20260925 \
  --timezone America/Denver \
  --json --offline \
  > ccusage-codex-M4a-20260919-20260925.json
```

Note on date-flag format: `ccusage claude daily --help` documents `--since`/`--until` as
`YYYYMMDD`; the top-level unified `ccusage daily --help` and `ccusage codex daily --help` document
`YYYY-MM-DD or YYYYMMDD`. `YYYYMMDD` was used for both since it is accepted by all three per
their own `--help` text.

Both commands exited 0 with no stderr.

## Timezone

`America/Denver` was requested via `-z/--timezone`, accepted by both `claude daily` and
`codex daily` (IANA timezone, per `--help`). Day boundaries in the JSON below are grouped in that
timezone, per ccusage's own `--help` description ("Timezone for date grouping").

## Offline / pricing mode

`-O/--offline` was passed to both commands ("use cached pricing data instead of fetching from
[LiteLLM/API]", per each subcommand's own `--help`). Both runs exited 0, so cached pricing data
was available locally and no network pricing fetch was attempted (or needed).

## Claude Code per-day totals (America/Denver, offline pricing)

From `ccusage-claude-M4a-20260919-20260925.json`:

| Date | Input | Output | Cache Create | Cache Read | Total Tokens | Cost (USD) |
|---|---|---|---|---|---|---|
| 2026-09-19 | 13,352 | 8,281,761 | 27,989,331 | 1,973,897,454 | 2,010,181,898 | $1,189.49 |
| 2026-09-20 | 12,150 | 8,748,546 | 41,347,252 | 1,503,497,010 | 1,553,604,958 | $1,070.66 |
| 2026-09-21 | 22,080 | 6,452,478 | 26,462,882 | 1,479,179,942 | 1,512,117,382 | $840.40 |
| 2026-09-22 | 12,320 | 5,577,121 | 22,353,434 | 1,235,586,820 | 1,263,529,695 | $262.45 |
| 2026-09-23 | 17,358 | 7,646,123 | 32,526,103 | 2,050,366,112 | 2,090,555,696 | $317.92 |
| 2026-09-24 | 10,896 | 5,939,877 | 21,364,695 | 1,241,533,182 | 1,268,848,650 | $216.00 |
| 2026-09-25 | 152,728 | 9,723,511 | 40,040,897 | 2,455,269,936 | 2,505,187,072 | $288.88 |
| **Total** | **240,884** | **52,369,417** | **212,084,594** | **11,939,330,456** | **12,204,025,351** | **$4,185.80** |

Caveat on cost: the `totals.unpricedModels` array in the JSON lists three model names ccusage's
offline (cached LiteLLM) pricing table has no entry for: `claude-opus-5-5`, and two local
GGUF/HF model identifiers (`Qwen3.8-27B-UD-Q4_K_M.gguf`,
`hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL`). Those rows' `cost` is `0` with `missingPricing: true`
in the per-model breakdown, so the daily/total costs above are undercounts on any day that used
`claude-opus-5-5` (2026-09-22 through 2026-09-25) — ccusage silently zeros unpriced usage rather
than erroring. This is a real gap to account for when comparing against tokenelo's own totals for
those same days.

Also notable: the Claude-Code-log-derived JSON for 2026-09-21 and 2026-09-25 includes
`modelsUsed` entries that are not Claude models at all — `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL`,
`Qwen3.8-27B-UD-Q4_K_M.gguf`, and `gemma4:26b` — meaning whatever local `~/.claude/projects` JSONL
records exist on this machine for those days contain non-Claude model usage entries (e.g. local
Ollama/llama.cpp runs routed through a Claude Code session transcript). `ccusage claude daily`
does not filter these out; it reports whatever model name appears in the transcript's usage
records.

## Codex per-day totals (America/Denver, offline pricing)

From `ccusage-codex-M4a-20260919-20260925.json`:

| Date | Input | Output | Cache Read | Reasoning Output | Total Tokens | Cost (USD) |
|---|---|---|---|---|---|---|
| 2026-09-22 | 38,654 | 307 | 97,280 | 29 | 136,241 | $0.00 |
| 2026-09-23 | 40,582 | 171 | 50,688 | 0 | 91,441 | $0.00 |
| **Total** | **79,236** | **478** | **147,968** | **29** | **227,682** | **$0.00** |

Only 2026-09-19, 2026-09-20, 2026-09-21, 2026-09-24, and 2026-09-25 have zero Codex rows in the
output (no local Codex session data for those days in the queried range/timezone), so they are
simply absent from the `daily` array rather than present with zero tokens.

Cost caveat: `totals.unpricedModels` = `["gpt-6-luna"]`. The single model used in this range
(`gpt-6-luna`) has no offline pricing entry, so `costUSD` is `0` for both days and the total —
this is an unpriced-model gap, not evidence that Codex usage was actually free.

## Dedup key and project roots — what ccusage's own docs/`--help` say, and what I verified

- Per `docs/research/deep-research-1-market-pricing.md` (existing project research, sourced from
  ccusage's GitHub repo and docs site as of 2026-09-26): ccusage deduplicates Claude Code usage
  records on **`message.id` + `requestId`**, reading JSONL under **`~/.claude/projects`**. That
  same research doc also flags that "ccusage's subagent-replay detection is a heuristic (it treats
  bursts of records less than 1 second apart as replays), and its README and code have drifted
  apart" — i.e. even the project's own prior research treats this as somewhat uncertain/version-
  drifted, not settled fact.
- **I could not independently re-verify the dedup key or the exact project-root discovery logic
  against the code** for the `20.0.24` build actually installed here: as of v20, ccusage ships as
  a thin Node shim that spawns a compiled native Rust binary
  (`@ccusage/ccusage-darwin-arm64@20.0.24`); there is no JS/TS parser source in the installed
  package to grep (`grep -rn -i "dedup" .../ccusage/src` returned nothing, and `src/` contains only
  `cli.js`, the spawn shim). The installed `README.md` and `config-schema.json` do not document a
  `claudePath`/project-root config key or the dedup key explicitly (confirmed by grep — only
  `openClawPath` and `piPath` appear as `*Path` config keys in `config-schema.json`).
- What I *did* verify directly: `ccusage claude daily --help` and `ccusage codex daily --help`
  (full text captured this session) confirm `--since`/`--until`/`--json`/`--timezone`/`--offline`
  flags exist and behave as described above (both commands ran and produced output consistent
  with those flag descriptions). `ccusage --help` confirms a first-class `claude` and `codex`
  subcommand tree (plus many other agent CLIs) exists in this build.
- Whether ccusage's Claude parser includes or excludes subagent/sub-session transcript files:
  **could not verify** from this installed build (no source to inspect, and `--help` text does not
  state this). The prior research doc's claim about subagent handling is specific to Codex
  ("forked or subagent sessions count only usage past the inherited parent snapshot"), not to the
  Claude Code parser, so it does not answer this for Claude.

## Files in this directory

- `ccusage-claude-M4a-20260919-20260925.json` — raw `ccusage claude daily --json` output.
- `ccusage-codex-M4a-20260919-20260925.json` — raw `ccusage codex daily --json` output.
- `README.md` — this file.
