# Privacy model

Status: internal alpha; the source is released under Apache 2.0 and no installer is available. This is a product data-handling description, not a contract for a hosted service.

## Local records

The internal tracker stores normalized counts and metadata in a local SQLite ledger. It parses supported usage records; prompt and response bodies are not part of its normalized event contract. The local metering proxy handles request/response traffic to obtain counters, so request bodies can be processed in memory even though they are not stored as transcript records. The proxy listener starts by default when the daemon runs (`local.capture` defaults to `proxy`, and the listener binds to loopback only), and it sees traffic only when a client is pointed at it. Set `local.capture` to `off` to disable it.

Metadata can include source/model/provider, timestamps, token components, session/subagent identifiers, session titles from supported tools, host labels, local project paths, Git context and usage qualifications. Titles can contain sensitive user-entered text even though the normalized usage event does not store transcript bodies. This data can disclose work patterns or project identity and should be handled as sensitive operational data.

## Network boundaries

The internal daemon's local read API uses bearer authentication and a loopback listener. Optional fleet configuration can expose selected reporting to configured peers using separate credentials. The fleet summary is built from a fixed aggregate contract (totals, a per-source breakdown and active time) that carries no project paths; the `fleet.sharePaths` setting exists and defaults to false, but this edition does not read it. Local metering proxies can contact the upstream endpoint the operator configures.

This does not provide isolation from an administrator or a compromised account on the same computer. Endpoint protection and operating-system access controls remain relevant.

## Exports and issue reports

CSV includes event, host and session identifiers. JSON can include paths and additional metadata. Neither format is automatically anonymous. Review exports before sending them to a vendor or adding them to an issue. Never attach real usage databases, authentication files, raw transcripts or an unreviewed diagnostics bundle.

The release should provide explicit retention/deletion and platform path instructions. No automatic retention period or certified data-erasure guarantee is claimed now.

## Future services

No central analytics collection or hosted account requirement is announced. Any future telemetry, hosted fleet administration, or report upload needs explicit configuration, a documented data inventory and its own retention/access policy. Free local tracking is intended to remain independently useful.
