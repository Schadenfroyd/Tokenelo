# Source checkout quick start — release draft

These instructions apply to the proposed source edition once it contains `package.json`, `src`, `rates`, reviewed tests and build scripts. The current public repository does not contain that edition yet. Clean public-install acceptance is still pending.

## Build

Use Node.js 22.13 or newer and npm (`.nvmrc` pins 22.23.4, the version the test suite was run on; the source CI workflow uses Node 24). Clone the public source release, then run:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The build produces the CLI/daemon and Electron tray assets in `dist`. A source build is not a signed installer. The repository remains private to npm publication (`private: true`); public GitHub source does not imply an npm package release.

## Choose capture before ingestion

Tokenelo can read supported usage logs on the local computer. Review collector roots and the privacy model first. The optional local metering proxy is a separate choice: for token reporting from existing Claude Code/Codex records only, set `local.capture` to `off` before running the daemon.

The config file is `config.json` in the platform configuration directory. `TOKENELO_HOME` overrides the configuration/data/log roots for isolated trials. A minimal tracker-only local-capture setting is:

```json
{
  "hostLabel": "example-workstation",
  "local": { "capture": "off" },
  "fleet": { "listenAddress": null, "peers": [], "sharePaths": false }
}
```

This disables local proxy capture and fleet sharing; supported source-log adapters still use their configured/default roots. Use empty, explicitly configured source roots for a synthetic trial. The source release must include a validated complete example of that isolated trial.

## Inspect recorded usage

```sh
node dist/cli/index.js ingest
node dist/cli/index.js report --range 7d
node dist/cli/index.js sessions --range today
node dist/cli/index.js doctor
node dist/cli/index.js export --format csv --range 7d > usage.csv
node dist/cli/index.js export --format json --range 7d > usage.json
```

`ingest` imports supported local records. Reports/export read the local ledger. Raw exports contain operational identifiers and may contain paths; review before sharing. Available ranges are `today`, `24h`, `7d`, `30d`, and `all`.

For ongoing capture, `node dist/cli/index.js serve` runs the daemon. `npm run tray` opens the tray application for the local user. Do not install a background service until the source release's platform service instructions and upgrade/rollback behavior have been verified.

## Platform locations

| Platform | Configuration | Data | Logs |
| --- | --- | --- | --- |
| Windows | `%APPDATA%\Tokenelo` | `%LOCALAPPDATA%\Tokenelo` | Data directory's `logs` |
| macOS | `~/Library/Application Support/Tokenelo` | Same directory | `~/Library/Logs/Tokenelo` |
| Linux | `$XDG_CONFIG_HOME/tokenelo`, default `~/.config/tokenelo` | `$XDG_DATA_HOME/tokenelo`, default `~/.local/share/tokenelo` | `$XDG_STATE_HOME/tokenelo/logs`, default `~/.local/state/tokenelo/logs` |

These are implementation paths, not acceptance of every advertised platform. Stop the owning daemon before replacing its package. Do not overwrite a current ledger with an old backup after new records have been captured.
