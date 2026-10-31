# Support matrix — release draft

This describes source capabilities observed in the internal implementation. It is not a public compatibility guarantee. The released version must record tested source versions and platforms.

| Source | Capture path | Main limitation |
| --- | --- | --- |
| Claude Code | Configured JSONL usage records | Source-format changes, model fallback components, cache-duration omissions and legacy quality metadata |
| Codex | Configured rollout records with optional local state metadata | Cumulative counters, imported/inherited context, subagents and changing source formats |
| Qwen Code | Configured usage records | Available counters depend on that tool's record format |
| Selected Claude Desktop metadata | Configured local metadata/plan records | Metadata/plan observations are not comprehensive per-request token capture |
| Local inference proxy | Explicitly configured upstream metering | Requests must pass through the proxy and the upstream must report usable counts |
| Local server log | Explicit server-log configuration | Best-effort estimates; a running engine alone does not establish captured usage |
| Other running apps | Coverage/process observations where available | Detection is not a token-usage adapter |

## Platform acceptance

Windows, macOS and Linux paths exist in the code. The source edition must complete clean setup and relevant smoke tests on each platform before advertising supported installation. The dated private Linux default suite and selected Windows native reviews do not prove every platform/adapter combination.

## Data and pricing

Pricing tables are versioned assumptions. Unpriced models stay unpriced. Public price/provenance text and model/source examples require review independent of the code license. A price-table field marked LIST is not proof it is still current at the time of a report.
