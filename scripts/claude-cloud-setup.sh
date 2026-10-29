#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_root"
node_version="$(tr -d '\r\n' < .nvmrc)"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid pinned Node version' >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || { echo 'Cloud setup targets Linux; see docs/cloud/CLAUDE-CLOUD-HANDOFF.md for local setup.' >&2; exit 1; }

# Use an exact existing runtime first, including the documented Claude cloud path.
for candidate in "$(command -v node || true)" /opt/node22/bin/node; do
  if [[ -x "$candidate" ]] && [[ "$("$candidate" --version)" == "v$node_version" ]]; then
    export PATH="$(dirname -- "$candidate"):$PATH"
    break
  fi
done
if ! command -v node >/dev/null || [[ "$(node --version)" != "v$node_version" ]]; then
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo 'Unsupported Linux CPU architecture' >&2; exit 1 ;;
  esac
  runtime_root="$repo_root/.claude/cloud-cache/node-v$node_version-linux-$node_arch"
  if [[ ! -x "$runtime_root/bin/node" ]]; then
    command -v curl >/dev/null
    command -v sha256sum >/dev/null
    command -v tar >/dev/null
    mkdir -p -- "$repo_root/.claude/cloud-cache"
    install_root="$(mktemp -d "$repo_root/.claude/cloud-cache/install.XXXXXX")"
    node_file="node-v$node_version-linux-$node_arch.tar.xz"
    node_url="https://nodejs.org/dist/v$node_version"
    curl --fail --location --silent --show-error --connect-timeout 15 --max-time 120 "$node_url/SHASUMS256.txt" -o "$install_root/SHASUMS256.txt"
    curl --fail --location --silent --show-error --connect-timeout 15 --max-time 120 "$node_url/$node_file" -o "$install_root/$node_file"
    expected="$(awk -v name="$node_file" '$2 == name { print $1 }' "$install_root/SHASUMS256.txt")"
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { echo 'Missing Node archive checksum' >&2; exit 1; }
    actual="$(sha256sum "$install_root/$node_file" | awk '{ print $1 }')"
    [[ "$actual" == "$expected" ]] || { echo 'Node archive checksum mismatch' >&2; exit 1; }
    tar -xJf "$install_root/$node_file" -C "$install_root"
    mv -- "$install_root/node-v$node_version-linux-$node_arch" "$runtime_root"
    rm -- "$install_root/$node_file" "$install_root/SHASUMS256.txt"
    rmdir -- "$install_root"
  fi
  export PATH="$runtime_root/bin:$PATH"
fi
[[ "$(node --version)" == "v$node_version" ]] || { echo 'Pinned Node runtime is unavailable' >&2; exit 1; }
node scripts/claude-cloud-check.mjs --setup

# Persist the selected runtime for subsequent Bash tools, if Claude supplies its
# supported environment file. The command is printed with shell-safe quoting.
if [[ "${CLAUDE_CODE_REMOTE:-}" == true ]] && [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  printf 'export PATH=%q:$PATH\n' "$(dirname -- "$(command -v node)")" >> "$CLAUDE_ENV_FILE"
fi
printf 'Tokenelo cloud dependencies ready: Node %s; headless; no services started.\n' "$(node --version)"
