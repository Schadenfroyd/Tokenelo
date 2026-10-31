#!/usr/bin/env bash
# Installs (or removes, with --uninstall) a user-level macOS LaunchAgent that runs the Tokenelo
# daemon at login (DESIGN §12, §15: "macOS LaunchAgent co.eloai.tokenelo.daemon"). User-level only
# — writes to ~/Library/LaunchAgents, never /Library/LaunchDaemons, and is never invoked with sudo.
#
# The label ("co.eloai.tokenelo.daemon") and plist path MUST match
# src/tray/service-detect.ts#serviceUnitInstalled exactly, or the tray will wrongly think no
# service is installed and start its own daemon copy alongside this one.
#
# This script writes the user's service files and calls launchctl. Installer tests redirect the
# two output directories in an isolated copy and use a log-only launchctl stub.
#
# Usage:
#   scripts/install-service-macos.sh              install (or reinstall) and load the agent
#   scripts/install-service-macos.sh --uninstall   unload and remove it
#   scripts/install-service-macos.sh --node /path/to/node   use a specific node binary
#   scripts/install-service-macos.sh --packaged-app /absolute/path/Tokenelo.app [--uninstall]
set -euo pipefail

# Package-native mode is explicit and dispatches to the typed runtime adapter in the same
# physical bundle. It intentionally does not enter or reuse the checkout helper below.
if [[ "${1:-}" == "--packaged-app" ]]; then
  if [[ $# -lt 2 || -z "${2:-}" ]]; then
    echo "Usage: $0 --packaged-app /absolute/path/Tokenelo.app [--uninstall]" >&2
    exit 2
  fi
  requested_app="$2"
  shift 2
  if [[ "$requested_app" != /* ]]; then
    echo "error: --packaged-app requires an absolute Tokenelo.app path" >&2
    exit 2
  fi
  uninstall=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uninstall)
        if [[ "$uninstall" == "1" ]]; then
          echo "error: --uninstall was supplied more than once" >&2
          exit 2
        fi
        uninstall=1
        shift
        ;;
      -h|--help)
        echo "Usage: $0 --packaged-app /absolute/path/Tokenelo.app [--uninstall]" >&2
        exit 0
        ;;
      *)
        echo "Unknown packaged lifecycle argument: $1" >&2
        exit 2
        ;;
    esac
  done

  if ! app_bundle_path="$(cd -P -- "$requested_app" 2>/dev/null && pwd -P)"; then
    echo "error: packaged app path is not an accessible directory" >&2
    exit 1
  fi
  if [[ "${app_bundle_path##*/}" != "Tokenelo.app" ]]; then
    echo "error: packaged lifecycle requires the physical Tokenelo.app bundle" >&2
    exit 1
  fi
  caller_path="${BASH_SOURCE[0]}"
  caller_directory="${caller_path%/*}"
  caller_name="${caller_path##*/}"
  if [[ "$caller_directory" == "$caller_path" ]]; then caller_directory="."; fi
  helper_directory="$(cd -P -- "$caller_directory" && pwd -P)"
  helper_path="${helper_directory}/${caller_name}"
  executable_path="${app_bundle_path}/Contents/MacOS/Tokenelo"
  runtime_path="${app_bundle_path}/Contents/Resources/app/dist/tray/macos-launch-agent-runtime.js"
  if [[ ! -f "$executable_path" || ! -x "$executable_path" || ! -f "$runtime_path" ]]; then
    echo "error: packaged Tokenelo executable or lifecycle runtime is missing" >&2
    exit 1
  fi

  if [[ "$uninstall" == "1" ]]; then
    exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$executable_path" "$runtime_path" \
      --packaged-app "$app_bundle_path" --helper-path "$helper_path" --uninstall
  fi
  exec /usr/bin/env ELECTRON_RUN_AS_NODE=1 "$executable_path" "$runtime_path" \
    --packaged-app "$app_bundle_path" --helper-path "$helper_path"
fi

LABEL="co.eloai.tokenelo.daemon"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCOUNT_HOME=""
PLIST_DIR=""
PLIST_PATH=""
LOG_DIR=""
LOCK_PATH=""
LOCK_HELD=0
NODE_BIN=""
ACTION="install"
WITH_TRAY=0
TRAY_LABEL="co.eloai.tokenelo.tray"
TRAY_PLIST_PATH=""

usage() {
  echo "Usage: $0 [--uninstall] [--node /path/to/node]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --with-tray)
      WITH_TRAY=1
      shift
      ;;
    --node)
      NODE_BIN="${2:-}"
      [[ -n "$NODE_BIN" ]] || usage
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

uid_domain() {
  echo "gui/$(id -u)"
}

ensure_owned_directory() {
  local directory="$1"
  local create_if_missing="${2:-0}"
  if [[ -L "$directory" ]]; then
    echo "error: refusing symlinked lifecycle directory: ${directory}" >&2
    return 1
  fi
  if [[ ! -e "$directory" ]]; then
    if [[ "$create_if_missing" != "1" ]]; then
      echo "error: lifecycle directory is missing: ${directory}" >&2
      return 1
    fi
    /bin/mkdir -m 700 "$directory"
    if [[ -L "$directory" || ! -d "$directory" ]]; then
      echo "error: lifecycle directory changed while it was being created: ${directory}" >&2
      return 1
    fi
    /bin/chmod 700 "$directory"
  fi
  if [[ ! -d "$directory" ]]; then
    echo "error: lifecycle path is not a directory: ${directory}" >&2
    return 1
  fi
  local physical
  physical="$(cd -P -- "$directory" && pwd -P)" || return 1
  if [[ "$physical" != "$directory" ]]; then
    echo "error: lifecycle directory is not physically canonical: ${directory}" >&2
    return 1
  fi
  local owner mode details
  details="$(/usr/bin/stat -f '%u %Lp' "$directory")" || return 1
  read -r owner mode <<<"$details"
  if [[ "$owner" != "$(id -u)" || ! "$mode" =~ ^[0-7]+$ ]]; then
    echo "error: lifecycle directory ownership or permissions could not be verified: ${directory}" >&2
    return 1
  fi
  local mode_value=$((8#$mode))
  if (( (mode_value & 0022) != 0 || (mode_value & 0300) != 0300 )); then
    echo "error: lifecycle directory must be owner-writable/traversable and not group/world writable: ${directory}" >&2
    return 1
  fi
}

resolve_account_home() {
  local uid account_info line account_uid account_home uid_count dir_count account_physical home_physical
  uid="$(id -u)" || return 1
  if [[ ! "$uid" =~ ^[0-9]+$ || "$uid" == "0" ]]; then
    echo "error: legacy macOS service lifecycle requires a non-root numeric uid" >&2
    return 1
  fi
  account_info="$(/usr/bin/dscacheutil -q user -a uid "$uid")" || {
    echo "error: could not resolve the uid account home from the local directory service" >&2
    return 1
  }
  account_uid=""
  account_home=""
  uid_count=0
  dir_count=0
  while IFS= read -r line; do
    case "$line" in
      uid:*)
        uid_count=$((uid_count + 1))
        if [[ "$line" =~ ^uid:\ ([0-9]+)$ ]]; then account_uid="${BASH_REMATCH[1]}"; fi
        ;;
      dir:*)
        dir_count=$((dir_count + 1))
        if [[ "$line" == "dir: "* ]]; then account_home="${line#dir: }"; fi
        ;;
    esac
  done <<<"$account_info"
  if [[ "$uid_count" != "1" || "$dir_count" != "1" || "$account_uid" != "$uid" ||
        -z "$account_home" || "$account_home" != /* ]]; then
    echo "error: local directory service returned an ambiguous uid account-home record" >&2
    return 1
  fi
  if [[ -z "${HOME:-}" || "$HOME" != "$account_home" ]]; then
    echo "error: HOME does not exactly match the uid account home; refusing legacy service changes" >&2
    return 1
  fi
  account_physical="$(cd -P -- "$account_home" 2>/dev/null && pwd -P)" || {
    echo "error: uid account home is not an accessible physical directory" >&2
    return 1
  }
  home_physical="$(cd -P -- "$HOME" 2>/dev/null && pwd -P)" || {
    echo "error: HOME is not an accessible physical directory" >&2
    return 1
  }
  if [[ "$account_physical" != "$account_home" || "$home_physical" != "$account_home" ]]; then
    echo "error: HOME and the uid account home must both be physical canonical paths" >&2
    return 1
  fi
  ensure_owned_directory "$account_home" || return 1
  ACCOUNT_HOME="$account_home"
}

acquire_lifecycle_lock() {
  ensure_owned_directory "${ACCOUNT_HOME}/Library"
  if ! /bin/mkdir -m 700 "$LOCK_PATH" 2>/dev/null; then
    echo "error: a packaged or legacy Tokenelo LaunchAgent transaction already owns ${LOCK_PATH}" >&2
    return 1
  fi
  LOCK_HELD=1
  if [[ -L "$LOCK_PATH" || ! -d "$LOCK_PATH" ]]; then
    echo "error: lifecycle transaction lock changed while it was being created" >&2
    return 1
  fi
  /bin/chmod 700 "$LOCK_PATH"
  ensure_owned_directory "$LOCK_PATH"
}

release_lifecycle_lock() {
  if [[ "$LOCK_HELD" == "1" ]]; then
    LOCK_HELD=0
    /bin/rmdir "$LOCK_PATH" 2>/dev/null || true
  fi
}

# The packaged runtime takes this same mkdir lock before preflight. It coordinates the two
# updated helper modes; path checks plus rename/unlink do not claim protection from arbitrary
# same-uid writers that ignore the lock.
trap release_lifecycle_lock EXIT

# Resolve independently before deriving service paths or taking a lock. A caller-selected HOME
# must not let the legacy helper lock one directory while mutating this uid's gui launchd domain.
resolve_account_home
PLIST_DIR="${ACCOUNT_HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${ACCOUNT_HOME}/Library/Logs/Tokenelo"
LOCK_PATH="${ACCOUNT_HOME}/Library/.tokenelo-launch-agent-transaction"
TRAY_PLIST_PATH="${PLIST_DIR}/${TRAY_LABEL}.plist"

unload_if_loaded() {
  # bootout fails (harmlessly) if the agent isn't currently loaded — ignore that case only.
  launchctl bootout "$(uid_domain)/${LABEL}" >/dev/null 2>&1 || true
}

if [[ "$ACTION" == "uninstall" ]]; then
  acquire_lifecycle_lock
  if [[ -e "$PLIST_DIR" || -L "$PLIST_DIR" ]]; then ensure_owned_directory "$PLIST_DIR"; fi
  unload_if_loaded
  launchctl bootout "$(uid_domain)/${TRAY_LABEL}" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH" "$TRAY_PLIST_PATH"
  echo "Removed ${PLIST_PATH} and unloaded ${LABEL}."
  exit 0
fi

if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    echo "error: node not found on PATH; pass --node /path/to/node" >&2
    exit 1
  fi
fi

DAEMON_ENTRY="${REPO_ROOT}/dist/daemon/main.js"
if [[ ! -f "$DAEMON_ENTRY" ]]; then
  echo "warning: ${DAEMON_ENTRY} does not exist yet — run 'npm run build' first. Writing the agent anyway; it will fail to start until the build exists." >&2
fi

acquire_lifecycle_lock
ensure_owned_directory "${ACCOUNT_HOME}/Library/LaunchAgents" 1
ensure_owned_directory "${ACCOUNT_HOME}/Library/Logs" 1
ensure_owned_directory "$LOG_DIR" 1

# The daemon also serves user-requested reports. Standard keeps launchd's light resource limits;
# Background throttles its report workers too (17.5s vs 3.2s on the same preserved Mac ledger).
# This policy does not show a window or change the collector's cooperative yield pacing.

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${DAEMON_ENTRY}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Standard</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/daemon.out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/daemon.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLIST

unload_if_loaded
launchctl bootstrap "$(uid_domain)" "$PLIST_PATH"
echo "Installed and loaded ${LABEL} from ${PLIST_PATH}."
echo "Logs: ${LOG_DIR}/daemon.out.log / daemon.err.log"

if [[ "$WITH_TRAY" == "1" ]]; then
  ELECTRON_BIN="${REPO_ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  TRAY_ENTRY="${REPO_ROOT}/dist/tray/main.js"
  if [[ ! -x "$ELECTRON_BIN" ]]; then
    echo "error: ${ELECTRON_BIN} not found — run 'npm ci' first." >&2
    exit 1
  fi
  cat > "$TRAY_PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${TRAY_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${ELECTRON_BIN}</string>
        <string>${TRAY_ENTRY}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/tray.out.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/tray.err.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "$(uid_domain)/${TRAY_LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "$(uid_domain)" "$TRAY_PLIST_PATH"
  echo "Installed and loaded ${TRAY_LABEL} (tray at login)."
fi
