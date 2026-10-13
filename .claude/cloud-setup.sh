#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$repo_root"

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  if [ -x /opt/node22/bin/node ]; then
    export PATH="/opt/node22/bin:$PATH"
  else
    printf '%s\n' 'Node.js 22 or newer is required. No packages were downloaded.' >&2
    exit 1
  fi
fi

node scripts/cloud-check.mjs
