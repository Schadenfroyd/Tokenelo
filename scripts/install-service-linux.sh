#!/usr/bin/env bash
# Installs (or removes, with --uninstall) a user-level systemd unit that runs the Tokenelo daemon
# (DESIGN §12, §15: Linux systemd --user tokenelo-daemon.service). The unit is never system-wide.
# With --with-tray, sudo may set Electron's chrome-sandbox to root:4755 before registering the unit.
#
# The unit filename ("tokenelo-daemon.service") and its directory MUST match
# src/tray/service-detect.ts#serviceUnitInstalled exactly ($XDG_CONFIG_HOME/systemd/user, falling
# back to ~/.config/systemd/user), or the tray will wrongly think no service is installed.
#
# Automated policy tests execute an isolated copy with stub systemctl and sudo commands; they do
# not register or change a real user service.
#
# Usage:
#   scripts/install-service-linux.sh                install, enable and start the unit now
#   scripts/install-service-linux.sh --uninstall    stop, disable and remove the unit
#   scripts/install-service-linux.sh --node /path/to/node
set -euo pipefail
# Keep directories created by this lifecycle private even when the caller has a permissive umask.
umask 077

UNIT_NAME="tokenelo-daemon.service"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCOUNT_HOME=""
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-}"
UNIT_DIR=""
UNIT_PATH=""
AUTOSTART_DIR=""
AUTOSTART_PATH=""
SERVICE_LOCK_PATH=""
SERVICE_LOCK_HELD=0
KEEP_SERVICE_LOCK=0
NODE_BIN=""
ACTION="install"
WITH_TRAY=0
DAEMON_ENTRY="${REPO_ROOT}/dist/daemon/main.js"
ELECTRON_BIN="${REPO_ROOT}/node_modules/electron/dist/electron"
TRAY_ENTRY="${REPO_ROOT}/dist/tray/main.js"
SANDBOX_BIN="${REPO_ROOT}/node_modules/electron/dist/chrome-sandbox"
ENABLEMENT_LINK_BACKUP=""
UNINSTALL_UNIT_REMOVED=0
UNINSTALL_AUTOSTART_REMOVED=0
UNINSTALL_ENABLEMENT_REMOVED=0
UNINSTALL_UNIT_SHA256=""
UNINSTALL_AUTOSTART_SHA256=""
UNINSTALL_PRE_ENABLED_STATE=""
UNINSTALL_PRE_ACTIVE_STATE=""
UNINSTALL_UNIT_PRESENT=0
UNINSTALL_AUTOSTART_PRESENT=0
UNINSTALL_STOPPED=0
UNINSTALL_ENABLEMENT_LINK=""
UNINSTALL_ENABLEMENT_LINK_TARGET=""
UNINSTALL_ENABLEMENT_LINK_BACKUP=""
UNINSTALL_UNIT_QUARANTINE_DIR=""
UNINSTALL_AUTOSTART_QUARANTINE_DIR=""

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

CURRENT_UID=""
XDG_NEAREST_PARENT=""
PROVISIONED_SERVICE_DIRS=()

assert_owned_directory() {
  local directory="$1"
  local details owner mode mode_value physical
  if [[ -L "$directory" || ! -d "$directory" ]]; then
    echo "error: refusing a missing, symlinked, or non-directory service root: $directory" >&2
    return 1
  fi
  physical="$(cd -P -- "$directory" 2>/dev/null && pwd -P)" || {
    echo "error: cannot resolve physical service directory: $directory" >&2
    return 1
  }
  if [[ "$physical" != "$directory" ]]; then
    echo "error: service directory is not a physical canonical path: $directory" >&2
    return 1
  fi
  details="$(/usr/bin/stat -c '%u %a' -- "$directory")" || {
    echo "error: cannot inspect service directory owner and mode: $directory" >&2
    return 1
  }
  read -r owner mode <<<"$details"
  if [[ "$owner" != "$CURRENT_UID" || ! "$mode" =~ ^[0-7]+$ ]]; then
    echo "error: service directory is not owned by the current uid: $directory" >&2
    return 1
  fi
  mode_value=$((8#$mode))
  if (( (mode_value & 0022) != 0 || (mode_value & 0300) != 0300 )); then
    echo "error: service directory must be owner-writable/traversable and not group/world writable: $directory" >&2
    return 1
  fi
}

canonical_directory_candidate() {
  local candidate="$1"
  local current suffix parent physical resolved
  if [[ "$candidate" != /* || "$candidate" == *//* || "$candidate" == *'/./'* ||
        "$candidate" == *'/../'* || "$candidate" == *'/.' || "$candidate" == *'/..' ||
        ( "$candidate" != '/' && "$candidate" == */ ) ]]; then
    echo "error: service root must be an absolute normalized path: $candidate" >&2
    return 1
  fi
  current="$candidate"
  suffix=""
  while [[ ! -e "$current" && ! -L "$current" ]]; do
    parent="${current%/*}"
    [[ -n "$parent" ]] || parent='/'
    if [[ "$parent" == "$current" ]]; then
      echo "error: service root has no existing physical ancestor: $candidate" >&2
      return 1
    fi
    suffix="/${current##*/}${suffix}"
    current="$parent"
  done
  if [[ -L "$current" || ! -d "$current" ]]; then
    echo "error: service root crosses a symlink or non-directory ancestor: $candidate" >&2
    return 1
  fi
  physical="$(cd -P -- "$current" 2>/dev/null && pwd -P)" || return 1
  if [[ "$physical" == '/' ]]; then resolved="/${suffix#/}"; else resolved="${physical%/}${suffix}"; fi
  if [[ "$resolved" != "$candidate" ]]; then
    echo "error: service root is not physically canonical: $candidate" >&2
    return 1
  fi
  XDG_NEAREST_PARENT="$current"
  if [[ -e "$candidate" ]]; then
    assert_owned_directory "$candidate"
  else
    assert_owned_directory "$current"
  fi
}

validate_account_and_service_roots() {
  local account_record passwd_name passwd_password passwd_uid passwd_gid passwd_gecos passwd_home passwd_shell
  local account_physical home_physical
  CURRENT_UID="$(/usr/bin/id -u)" || return 1
  if [[ ! "$CURRENT_UID" =~ ^[0-9]+$ || "$CURRENT_UID" == "0" ]]; then
    echo "error: Linux user service lifecycle requires a non-root numeric uid" >&2
    return 1
  fi
  account_record="$(/usr/bin/getent passwd "$CURRENT_UID")" || {
    echo "error: cannot resolve the current uid account record" >&2
    return 1
  }
  if [[ -z "$account_record" || "$account_record" == *$'\n'* ]]; then
    echo "error: current uid account lookup returned an ambiguous record" >&2
    return 1
  fi
  IFS=: read -r passwd_name passwd_password passwd_uid passwd_gid passwd_gecos passwd_home passwd_shell <<<"$account_record"
  if [[ "$passwd_uid" != "$CURRENT_UID" || -z "$passwd_home" || "$passwd_home" != /* ]]; then
    echo "error: passwd record does not identify a physical account home for the current uid" >&2
    return 1
  fi
  if [[ -z "${HOME:-}" || "$HOME" != "$passwd_home" ]]; then
    echo "error: HOME does not exactly match the current uid account home" >&2
    return 1
  fi
  account_physical="$(cd -P -- "$passwd_home" 2>/dev/null && pwd -P)" || {
    echo "error: current uid account home is not accessible" >&2
    return 1
  }
  home_physical="$(cd -P -- "$HOME" 2>/dev/null && pwd -P)" || return 1
  if [[ "$account_physical" != "$passwd_home" || "$home_physical" != "$passwd_home" ]]; then
    echo "error: HOME and passwd account home must both be physical canonical paths" >&2
    return 1
  fi
  ACCOUNT_HOME="$passwd_home"
  assert_owned_directory "$ACCOUNT_HOME" || return 1

  if [[ -z "$XDG_CONFIG_HOME" ]]; then XDG_CONFIG_HOME="${ACCOUNT_HOME}/.config"; fi
  canonical_directory_candidate "$XDG_CONFIG_HOME" || return 1
  UNIT_DIR="${XDG_CONFIG_HOME}/systemd/user"
  UNIT_PATH="${UNIT_DIR}/${UNIT_NAME}"
  AUTOSTART_DIR="${XDG_CONFIG_HOME}/autostart"
  AUTOSTART_PATH="${AUTOSTART_DIR}/tokenelo-tray.desktop"
  canonical_directory_candidate "$UNIT_DIR" || return 1
  if [[ "$ACTION" == "uninstall" || "$WITH_TRAY" == "1" ]]; then
    canonical_directory_candidate "$AUTOSTART_DIR" || return 1
  fi
  SERVICE_LOCK_PATH="${ACCOUNT_HOME}/.tokenelo-linux-service-transaction"
}

track_missing_service_directories() {
  local candidate="$1" current="$1" parent directory existing found index
  local -a missing=()
  while [[ ! -e "$current" && ! -L "$current" ]]; do
    missing+=("$current")
    parent="${current%/*}"
    [[ -n "$parent" ]] || parent='/'
    [[ "$parent" != "$current" ]] || break
    current="$parent"
  done
  for ((index=${#missing[@]} - 1; index >= 0; index--)); do
    directory="${missing[index]}"
    found=0
    for existing in "${PROVISIONED_SERVICE_DIRS[@]}"; do
      if [[ "$existing" == "$directory" ]]; then found=1; break; fi
    done
    if [[ "$found" == "0" ]]; then PROVISIONED_SERVICE_DIRS+=("$directory"); fi
  done
}

cleanup_failed_service_provision() {
  local index directory
  for ((index=${#PROVISIONED_SERVICE_DIRS[@]} - 1; index >= 0; index--)); do
    directory="${PROVISIONED_SERVICE_DIRS[index]}"
    if [[ -e "$directory" || -L "$directory" ]]; then
      if [[ -d "$directory" && ! -L "$directory" ]] && assert_owned_directory "$directory" >/dev/null 2>&1; then
        if ! /bin/rmdir -- "$directory" 2>/dev/null; then
          echo "warning: could not remove an empty newly-created service directory: $directory" >&2
        fi
      else
        echo "warning: left a changed or unsafe newly-created service directory path in place: $directory" >&2
      fi
    fi
  done
  PROVISIONED_SERVICE_DIRS=()
}

provision_service_directories() {
  track_missing_service_directories "$XDG_CONFIG_HOME"
  track_missing_service_directories "$UNIT_DIR"
  if [[ "$WITH_TRAY" == "1" ]]; then track_missing_service_directories "$AUTOSTART_DIR"; fi

  if ! mkdir -p -- "$XDG_CONFIG_HOME" "$UNIT_DIR"; then
    echo "error: could not create Tokenelo user service directories" >&2
    cleanup_failed_service_provision
    return 1
  fi
  if [[ "$WITH_TRAY" == "1" ]] && ! mkdir -p -- "$AUTOSTART_DIR"; then
    echo "error: could not create Tokenelo user service directories" >&2
    cleanup_failed_service_provision
    return 1
  fi
  if ! assert_owned_directory "$XDG_CONFIG_HOME" || ! assert_owned_directory "$UNIT_DIR"; then
    echo "error: Tokenelo user service directories did not pass owner, mode, and path checks" >&2
    cleanup_failed_service_provision
    return 1
  fi
  if [[ "$WITH_TRAY" == "1" ]] && ! assert_owned_directory "$AUTOSTART_DIR"; then
    echo "error: Tokenelo user service directories did not pass owner, mode, and path checks" >&2
    cleanup_failed_service_provision
    return 1
  fi
  # Once all roots are safe, later install rollback leaves the established user directories intact.
  PROVISIONED_SERVICE_DIRS=()
}

release_service_lock() {
  if [[ "$SERVICE_LOCK_HELD" != "1" ]]; then return 0; fi
  SERVICE_LOCK_HELD=0
  if [[ "$KEEP_SERVICE_LOCK" == "1" ]]; then
    echo "warning: retained service lifecycle lock and recovery state at $SERVICE_LOCK_PATH" >&2
    return 0
  fi
  /bin/rmdir -- "$SERVICE_LOCK_PATH" 2>/dev/null || true
}

retain_service_recovery() {
  local reason="$1"
  KEEP_SERVICE_LOCK=1
  if [[ -d "$SERVICE_LOCK_PATH" && ! -L "$SERVICE_LOCK_PATH" ]]; then
    printf '%s\n' "$reason" > "${SERVICE_LOCK_PATH}/recovery.txt" || true
    chmod 0600 "${SERVICE_LOCK_PATH}/recovery.txt" 2>/dev/null || true
  fi
}

acquire_service_lock() {
  if ! mkdir -m 700 -- "$SERVICE_LOCK_PATH" 2>/dev/null; then
    echo "error: a Tokenelo Linux service transaction or recovery already owns $SERVICE_LOCK_PATH" >&2
    return 1
  fi
  SERVICE_LOCK_HELD=1
  if [[ -L "$SERVICE_LOCK_PATH" || ! -d "$SERVICE_LOCK_PATH" ]]; then
    echo "error: service transaction lock changed while being created" >&2
    return 1
  fi
  chmod 0700 -- "$SERVICE_LOCK_PATH"
  assert_owned_directory "$SERVICE_LOCK_PATH"
}

validate_account_and_service_roots
trap release_service_lock EXIT
acquire_service_lock

if [[ "$ACTION" == "install" && -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  else
    echo "error: node not found on PATH; pass --node /path/to/node" >&2
    exit 1
  fi
fi

if [[ "$ACTION" == "install" && ! -f "$DAEMON_ENTRY" ]]; then
  echo "warning: ${DAEMON_ENTRY} does not exist yet — run 'npm run build' first. Writing the unit anyway; it will fail to start until the build exists." >&2
fi

# Preflight all optional tray inputs before writing or enabling the daemon service.
if [[ "$ACTION" == "install" && "$WITH_TRAY" == "1" ]]; then
  ELECTRON_BIN="$REPO_ROOT/node_modules/electron/dist/electron"
  SANDBOX_BIN="$REPO_ROOT/node_modules/electron/dist/chrome-sandbox"
  TRAY_ENTRY="$REPO_ROOT/dist/tray/main.js"
  [[ -x "$ELECTRON_BIN" ]] || { echo "error: $ELECTRON_BIN not found — run 'npm ci' first." >&2; exit 1; }
  [[ -f "$TRAY_ENTRY" ]] || { echo "error: $TRAY_ENTRY not found — run 'npm run build' first." >&2; exit 1; }
  [[ -f "$SANDBOX_BIN" ]] || { echo "error: $SANDBOX_BIN not found — run 'npm ci' first." >&2; exit 1; }
  # Complete the only privileged sandbox preparation before creating or enabling a service.
  if [[ "$(stat -c '%U %a' "$SANDBOX_BIN")" != "root 4755" ]]; then
    echo "Setting root:4755 on $SANDBOX_BIN (sudo) so the tray keeps Chromium's sandbox enabled..."
    if ! sudo chown root:root "$SANDBOX_BIN"; then
      echo "error: could not set root ownership on $SANDBOX_BIN" >&2
      exit 1
    fi
    if ! sudo chmod 4755 "$SANDBOX_BIN"; then
      echo "error: could not set sandbox mode on $SANDBOX_BIN" >&2
      exit 1
    fi
  fi
fi
INSTALL_TEMP_FILES=()
INSTALL_BACKUP_FILES=()
KEEP_INSTALL_BACKUPS=0
UNIT_PREEXISTED=0
UNIT_BACKUP=""
UNIT_STAGE=""
UNIT_COMMITTED=0
AUTOSTART_PREEXISTED=0
AUTOSTART_BACKUP=""
AUTOSTART_STAGE=""
AUTOSTART_COMMITTED=0
UNIT_CANDIDATE_SHA256=""
AUTOSTART_CANDIDATE_SHA256=""

cleanup_install_temps() {
  local temp
  for temp in "${INSTALL_TEMP_FILES[@]}"; do
    rm -f -- "$temp"
  done
  if [[ "$KEEP_INSTALL_BACKUPS" != "1" ]]; then
    for temp in "${INSTALL_BACKUP_FILES[@]}"; do
      rm -f -- "$temp"
    done
  fi
}

retain_install_backups() {
  local backup
  KEEP_INSTALL_BACKUPS=1
  retain_service_recovery "installer/uninstaller rollback incomplete; retained service files and backup copies"
  for backup in "${INSTALL_BACKUP_FILES[@]}"; do
    echo "warning: retained prior file copy at $backup" >&2
  done
}
trap 'cleanup_install_temps; release_service_lock' EXIT

snapshot_install_file() {
  local path="$1"
  local existed_var="$2"
  local backup_var="$3"
  local parent base backup

  if [[ -L "$path" || ( -e "$path" && ! -f "$path" ) ]]; then
    echo "error: refusing to replace non-regular install path: $path" >&2
    return 1
  fi

  if [[ -f "$path" ]]; then
    parent="$(dirname "$path")"
    base="$(basename "$path")"
    backup="$(mktemp "${parent}/.${base}.tokenelo-backup.XXXXXX")" || return 1
    INSTALL_BACKUP_FILES+=("$backup")
    if ! cp -p -- "$path" "$backup"; then
      echo "error: could not preserve existing bytes at $path" >&2
      return 1
    fi
    printf -v "$existed_var" '%s' 1
    printf -v "$backup_var" '%s' "$backup"
  else
    printf -v "$existed_var" '%s' 0
    printf -v "$backup_var" '%s' ""
  fi
}

read_unit_state() {
  local property="$1"
  local result_var="$2"
  local output=""
  local state

  if output="$(systemctl --user "$property" "$UNIT_NAME" 2>/dev/null)"; then
    :
  else
    # is-enabled and is-active use nonzero statuses for ordinary disabled/inactive states.
    :
  fi

  case "$property:$output" in
    is-enabled:enabled|is-enabled:enabled-runtime|is-enabled:linked|is-enabled:linked-runtime|is-enabled:alias)
      state="enabled" ;;
    is-enabled:disabled|is-enabled:not-found)
      state="$output" ;;
    is-active:active)
      state="active" ;;
    is-active:inactive|is-active:failed|is-active:not-found)
      state="inactive" ;;
    *)
      echo "error: cannot safely determine ${UNIT_NAME} ${property} state (got '${output:-no status}')" >&2
      return 1 ;;
  esac

  printf -v "$result_var" '%s' "$state"
}

read_unit_fragment() {
  local result_var="$1"
  local loaded_fragment
  if ! loaded_fragment="$(systemctl --user show --property=FragmentPath --value "$UNIT_NAME" 2>/dev/null)"; then
    echo "error: cannot safely determine the loaded fragment for ${UNIT_NAME}" >&2
    return 1
  fi
  if [[ -n "$loaded_fragment" && "$loaded_fragment" != "$UNIT_PATH" ]]; then
    echo "error: ${UNIT_NAME} is currently loaded from '${loaded_fragment}', not '${UNIT_PATH}'" >&2
    return 1
  fi
  printf -v "$result_var" '%s' "$loaded_fragment"
}

render_daemon_unit() {
  cat <<UNIT
[Unit]
Description=Tokenelo usage/spend daemon
After=default.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${DAEMON_ENTRY}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT
}

render_tray_autostart() {
  local electron_bin="${REPO_ROOT}/node_modules/electron/dist/electron"
  local tray_entry="${REPO_ROOT}/dist/tray/main.js"
  cat <<DESKTOP
[Desktop Entry]
Type=Application
Name=Tokenelo
Comment=AI token usage and spend tray
Exec=$electron_bin --ozone-platform-hint=auto $tray_entry
X-GNOME-Autostart-enabled=true
NoDisplay=true
DESKTOP
}

sha256_path() {
  sha256sum < "$1" | cut -d ' ' -f 1
}

assert_owned_regular_file() {
  local file="$1" expected_mode="$2" details owner mode
  if [[ -L "$file" || ! -f "$file" ]]; then
    echo "error: refusing a symlinked or non-regular service file: $file" >&2
    return 1
  fi
  details="$(/usr/bin/stat -c '%u %a' -- "$file")" || return 1
  read -r owner mode <<<"$details"
  if [[ "$owner" != "$CURRENT_UID" || "$mode" != "$expected_mode" ]]; then
    echo "error: service file owner or mode is not the package-owned policy: $file" >&2
    return 1
  fi
}

verify_owned_unit_file() {
  local exec_start="" line count=0 node_path daemon_path expected_hash actual_hash
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ExecStart=*) count=$((count + 1)); exec_start="${line#ExecStart=}" ;;
    esac
  done < "$UNIT_PATH"
  if [[ "$count" != "1" || ! "$exec_start" =~ ^([^[:space:]]+)[[:space:]]+([^[:space:]]+)$ ]]; then
    echo "error: installed unit does not have one supported exact ExecStart action" >&2
    return 1
  fi
  node_path="${BASH_REMATCH[1]}"
  daemon_path="${BASH_REMATCH[2]}"
  if [[ "$daemon_path" != "$DAEMON_ENTRY" || ( -n "$NODE_BIN" && "$NODE_BIN" != "$node_path" ) ]]; then
    echo "error: installed unit action does not match the current Tokenelo daemon path" >&2
    return 1
  fi
  NODE_BIN="$node_path"
  expected_hash="$(render_daemon_unit | sha256sum | cut -d ' ' -f 1)"
  actual_hash="$(sha256_path "$UNIT_PATH")"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "error: installed unit bytes are not the exact Tokenelo unit definition" >&2
    return 1
  fi
}

verify_loaded_unit_action() {
  local loaded_action prefix suffix suffix_regex
  if ! loaded_action="$(systemctl --user show --property=ExecStart --value "$UNIT_NAME" 2>/dev/null)"; then
    echo "error: cannot verify the loaded ${UNIT_NAME} ExecStart action" >&2
    return 1
  fi
  prefix="{ path=${NODE_BIN} ; argv[]=${NODE_BIN} ${DAEMON_ENTRY} ; ignore_errors=no ; start_time="
  if [[ "$loaded_action" != "$prefix"* ]]; then
    echo "error: loaded ${UNIT_NAME} ExecStart does not match the exact Tokenelo daemon action" >&2
    return 1
  fi
  suffix="${loaded_action#"$prefix"}"
  suffix_regex='^\[.*\] ; stop_time=\[.*\] ; pid=[0-9]+ ; code=\([^)]*\) ; status=[0-9]+/[0-9]+ \}$'
  if [[ ! "$suffix" =~ $suffix_regex ]]; then
    echo "error: loaded ${UNIT_NAME} ExecStart has an unsupported systemd property shape" >&2
    return 1
  fi
}

verify_unit_has_no_overrides() {
  local dropins need_reload
  if ! dropins="$(systemctl --user show --property=DropInPaths --value "$UNIT_NAME" 2>/dev/null)" ||
      [[ -n "$dropins" ]]; then
    echo "error: ${UNIT_NAME} has systemd drop-ins or its drop-in state is unknown" >&2
    return 1
  fi
  if ! need_reload="$(systemctl --user show --property=NeedDaemonReload --value "$UNIT_NAME" 2>/dev/null)" ||
      [[ "$need_reload" != "no" ]]; then
    echo "error: systemd's loaded ${UNIT_NAME} state differs from or cannot be matched to disk" >&2
    return 1
  fi
}

expected_enablement_link() {
  printf '%s/default.target.wants/%s' "$UNIT_DIR" "$UNIT_NAME"
}

verify_enablement_links() {
  local state="$1" expected wants_dir resolved details owner kind
  expected="$(expected_enablement_link)"
  wants_dir="$(dirname "$expected")"
  if [[ -e "$wants_dir" || -L "$wants_dir" ]]; then
    assert_owned_directory "$wants_dir" || return 1
  fi
  if [[ "$state" == "enabled" ]]; then
    if [[ ! -L "$expected" ]]; then
      echo "error: enabled ${UNIT_NAME} has no exact package-owned default.target link" >&2
      return 1
    fi
    details="$(/usr/bin/stat -c '%u %F' -- "$expected")" || return 1
    read -r owner kind <<<"$details"
    resolved="$(readlink -f -- "$expected")" || return 1
    if [[ "$owner" != "$CURRENT_UID" || "$kind" != "symbolic link" || "$resolved" != "$UNIT_PATH" ]]; then
      echo "error: ${UNIT_NAME} enablement link is foreign or does not point to the exact unit" >&2
      return 1
    fi
  elif [[ -e "$expected" || -L "$expected" ]]; then
    echo "error: ${UNIT_NAME} has an enablement link while systemd reports it disabled" >&2
    return 1
  fi
}

restore_install_file() {
  local path="$1"
  local existed="$2"
  local backup="$3"
  local committed="$4"
  local candidate_sha256="$5"
  local parent base restore_temp
  [[ "$committed" == "1" ]] || return 0

  if ! candidate_file_is_still_ours "$path" "$candidate_sha256"; then
    echo "error: $path changed after candidate install; left it untouched" >&2
    return 1
  fi

  if [[ "$existed" == "1" ]]; then
    parent="$(dirname "$path")"
    base="$(basename "$path")"
    restore_temp="$(mktemp "${parent}/.${base}.tokenelo-restore.XXXXXX")" || return 1
    INSTALL_TEMP_FILES+=("$restore_temp")
    if ! cp -p -- "$backup" "$restore_temp" || ! mv -f -- "$restore_temp" "$path"; then
      echo "error: could not restore the previous bytes at $path" >&2
      return 1
    fi
  elif ! rm -f -- "$path"; then
    echo "error: could not remove the uncommitted candidate at $path" >&2
    return 1
  fi

  return 0
}

restore_candidate_files() {
  local restore_unit="${1:-1}"
  local ok=0
  if [[ "$restore_unit" == "1" ]]; then
    if ! restore_install_file "$UNIT_PATH" "$UNIT_PREEXISTED" "$UNIT_BACKUP" "$UNIT_COMMITTED" "$UNIT_CANDIDATE_SHA256"; then
      ok=1
    else
      UNIT_COMMITTED=0
    fi
  else
    if [[ "$UNIT_COMMITTED" == "1" ]]; then
      echo "warning: leaving candidate unit in place because service state rollback was incomplete" >&2
      ok=1
    fi
  fi
  if [[ "$WITH_TRAY" == "1" ]]; then
    if ! restore_install_file "$AUTOSTART_PATH" "$AUTOSTART_PREEXISTED" "$AUTOSTART_BACKUP" "$AUTOSTART_COMMITTED" "$AUTOSTART_CANDIDATE_SHA256"; then
      ok=1
    else
      AUTOSTART_COMMITTED=0
    fi
  fi
  if [[ "$ok" == "1" ]]; then
    retain_install_backups
  fi
  return "$ok"
}

candidate_file_is_still_ours() {
  local path="$1"
  local expected_sha256="$2"
  [[ -f "$path" && ! -L "$path" && -n "$expected_sha256" ]] || return 1
  [[ "$(sha256sum < "$path" | cut -d ' ' -f 1)" == "$expected_sha256" ]]
}

restore_uninstall_state() {
  local fragment current_enabled current_active ok=0
  [[ "$UNINSTALL_UNIT_PRESENT" == "1" ]] || return 0
  if [[ "$UNINSTALL_UNIT_REMOVED" != "1" && "$UNINSTALL_ENABLEMENT_REMOVED" != "1" && "$UNINSTALL_STOPPED" != "1" ]]; then
    return 0
  fi
  if ! systemctl --user daemon-reload; then
    echo "error: rollback could not reload the restored Tokenelo unit" >&2
    ok=1
  fi
  if ! read_unit_fragment fragment || [[ "$fragment" != "$UNIT_PATH" ]] ||
      ! verify_owned_unit_file || ! verify_loaded_unit_action || ! verify_unit_has_no_overrides; then
    echo "error: rollback cannot prove the restored Tokenelo unit action" >&2
    return 1
  fi
  if ! read_unit_state is-enabled current_enabled || ! read_unit_state is-active current_active; then
    echo "error: rollback cannot determine restored Tokenelo service state" >&2
    return 1
  fi
  if ! verify_enablement_links "$current_enabled"; then ok=1; fi
  if [[ "$UNINSTALL_PRE_ENABLED_STATE" == "enabled" ]]; then
    if [[ "$current_enabled" != "enabled" ]]; then
      echo "error: rollback did not restore the prior enabled state" >&2
      ok=1
    fi
  elif [[ "$current_enabled" == "enabled" ]]; then
    echo "error: rollback found an unexpected enabled Tokenelo unit" >&2
    ok=1
  fi
  if [[ "$UNINSTALL_PRE_ACTIVE_STATE" == "active" && "$current_active" != "active" ]]; then
    if ! systemctl --user start "$UNIT_NAME" || ! read_unit_state is-active current_active || [[ "$current_active" != "active" ]]; then
      echo "error: rollback could not restore the previously active Tokenelo unit" >&2
      ok=1
    fi
  elif [[ "$UNINSTALL_PRE_ACTIVE_STATE" != "active" && "$current_active" == "active" ]]; then
    if ! systemctl --user stop "$UNIT_NAME" || ! read_unit_state is-active current_active || [[ "$current_active" == "active" ]]; then
      echo "error: rollback could not restore the previously inactive Tokenelo unit" >&2
      ok=1
    fi
  fi
  return "$ok"
}

rollback_uninstall() {
  local reason="$1" ok=0
  if [[ "$UNINSTALL_UNIT_REMOVED" == "1" ]] &&
      ! restore_uninstall_file "$UNIT_PATH" "$UNIT_PREEXISTED" "$UNIT_BACKUP" "$UNINSTALL_UNIT_SHA256" unit; then ok=1; fi
  if [[ "$UNINSTALL_AUTOSTART_REMOVED" == "1" ]] &&
      ! restore_uninstall_file "$AUTOSTART_PATH" "$AUTOSTART_PREEXISTED" "$AUTOSTART_BACKUP" "$UNINSTALL_AUTOSTART_SHA256" autostart; then ok=1; fi
  if [[ "$UNINSTALL_ENABLEMENT_REMOVED" == "1" ]] && ! restore_uninstall_enablement_link; then ok=1; fi
  if ! restore_uninstall_state; then ok=1; fi
  if ! clear_uninstall_quarantine; then ok=1; fi
  if [[ "$ok" == "1" ]]; then
    retain_install_backups
    echo "error: ${reason}; uninstall rollback was incomplete; backups and lock retained" >&2
    return 1
  fi
  echo "error: ${reason}; prior service state was restored and verified" >&2
  return 0
}

fail_uninstall() {
  local reason="$1"
  rollback_uninstall "$reason" || return 1
  return 1
}

verify_uninstall_loaded_unit() {
  local fragment=""
  assert_owned_regular_file "$UNIT_PATH" 644 || return 1
  if [[ "$(sha256_path "$UNIT_PATH")" != "$UNINSTALL_UNIT_SHA256" ]]; then
    echo "error: Tokenelo unit changed during uninstall" >&2
    return 1
  fi
  if ! read_unit_fragment fragment || [[ "$fragment" != "$UNIT_PATH" ]] ||
      ! verify_owned_unit_file || ! verify_loaded_unit_action || ! verify_unit_has_no_overrides; then
    echo "error: systemd's loaded Tokenelo action changed during uninstall" >&2
    return 1
  fi
}

uninstall_owned_service() {
  local fragment="" unit_hash="" auto_hash="" current_enabled="" current_active=""
  local expected_link target backup_link backup_target file
  UNINSTALL_UNIT_PRESENT=0
  UNINSTALL_AUTOSTART_PRESENT=0
  UNINSTALL_UNIT_REMOVED=0
  UNINSTALL_AUTOSTART_REMOVED=0
  UNINSTALL_STOPPED=0
  UNINSTALL_ENABLEMENT_REMOVED=0
  UNINSTALL_UNIT_QUARANTINE_DIR=""
  UNINSTALL_AUTOSTART_QUARANTINE_DIR=""
  UNINSTALL_ENABLEMENT_LINK=""
  UNINSTALL_ENABLEMENT_LINK_BACKUP=""
  UNINSTALL_PRE_ENABLED_STATE=""
  UNINSTALL_PRE_ACTIVE_STATE=""

  if [[ -e "$UNIT_DIR" || -L "$UNIT_DIR" ]]; then assert_owned_directory "$UNIT_DIR"; fi
  if [[ -e "$AUTOSTART_DIR" || -L "$AUTOSTART_DIR" ]]; then assert_owned_directory "$AUTOSTART_DIR"; fi
  if [[ -e "$UNIT_PATH" || -L "$UNIT_PATH" ]]; then
    assert_owned_regular_file "$UNIT_PATH" 644
    verify_owned_unit_file
    UNINSTALL_UNIT_PRESENT=1
    unit_hash="$(sha256_path "$UNIT_PATH")"
    UNINSTALL_UNIT_SHA256="$unit_hash"
  fi
  if [[ -e "$AUTOSTART_PATH" || -L "$AUTOSTART_PATH" ]]; then
    assert_owned_regular_file "$AUTOSTART_PATH" 644
    auto_hash="$(render_tray_autostart | sha256sum | cut -d ' ' -f 1)"
    if [[ "$(sha256_path "$AUTOSTART_PATH")" != "$auto_hash" ]]; then
      echo "error: tray autostart bytes are not the exact Tokenelo definition; refusing to retire the service" >&2
      return 1
    fi
    UNINSTALL_AUTOSTART_PRESENT=1
    UNINSTALL_AUTOSTART_SHA256="$auto_hash"
  fi

  read_unit_state is-enabled UNINSTALL_PRE_ENABLED_STATE
  read_unit_state is-active UNINSTALL_PRE_ACTIVE_STATE
  read_unit_fragment fragment
  if [[ "$UNINSTALL_UNIT_PRESENT" == "1" ]]; then
    if [[ "$fragment" != "$UNIT_PATH" ]]; then
      echo "error: ${UNIT_NAME} is not loaded from its exact XDG unit path; refusing to retire it" >&2
      return 1
    fi
    if [[ "$UNINSTALL_PRE_ENABLED_STATE" != "enabled" && "$UNINSTALL_PRE_ENABLED_STATE" != "disabled" ]]; then
      echo "error: ${UNIT_NAME} has an unsupported enabled state; refusing to retire it" >&2
      return 1
    fi
    verify_loaded_unit_action
    verify_unit_has_no_overrides
    verify_enablement_links "$UNINSTALL_PRE_ENABLED_STATE"
  elif [[ -n "$fragment" || "$UNINSTALL_PRE_ENABLED_STATE" == "enabled" || "$UNINSTALL_PRE_ACTIVE_STATE" == "active" ]]; then
    echo "error: systemd reports Tokenelo unit state without an exact owned unit file; refusing to retire it" >&2
    return 1
  fi

  if [[ "$UNINSTALL_UNIT_PRESENT" != "1" && "$UNINSTALL_AUTOSTART_PRESENT" != "1" ]]; then
    echo "No owned Tokenelo Linux startup entries were found; nothing was changed."
    return 0
  fi

  UNIT_PREEXISTED=0; UNIT_BACKUP=""
  AUTOSTART_PREEXISTED=0; AUTOSTART_BACKUP=""
  snapshot_install_file "$UNIT_PATH" UNIT_PREEXISTED UNIT_BACKUP
  snapshot_install_file "$AUTOSTART_PATH" AUTOSTART_PREEXISTED AUTOSTART_BACKUP
  if [[ "$UNIT_PREEXISTED" == "1" ]]; then
    UNINSTALL_UNIT_SHA256="$(sha256_path "$UNIT_PATH")"
    UNINSTALL_UNIT_PRESENT=1
  fi
  if [[ "$AUTOSTART_PREEXISTED" == "1" ]]; then
    UNINSTALL_AUTOSTART_SHA256="$(sha256_path "$AUTOSTART_PATH")"
    UNINSTALL_AUTOSTART_PRESENT=1
  fi

  if [[ "$UNINSTALL_UNIT_PRESENT" == "1" ]]; then
    # Recheck disk and the manager's exact action immediately before stop.
    if ! verify_uninstall_loaded_unit ||
        ! read_unit_state is-enabled current_enabled || [[ "$current_enabled" != "$UNINSTALL_PRE_ENABLED_STATE" ]] ||
        ! read_unit_state is-active current_active || [[ "$current_active" != "$UNINSTALL_PRE_ACTIVE_STATE" ]] ||
        ! verify_enablement_links "$current_enabled"; then
      echo "error: Tokenelo unit state changed after uninstall preflight" >&2
      return 1
    fi
    if [[ "$UNINSTALL_PRE_ACTIVE_STATE" == "active" ]]; then
      if ! systemctl --user stop "$UNIT_NAME"; then
        if ! read_unit_state is-active current_active || [[ "$current_active" != "active" ]]; then
          UNINSTALL_STOPPED=1
        fi
        fail_uninstall "systemd could not stop the exact Tokenelo unit"
        return 1
      fi
      UNINSTALL_STOPPED=1
      if ! read_unit_state is-active current_active || [[ "$current_active" == "active" ]]; then
        fail_uninstall "systemd did not retire the exact Tokenelo unit process"
        return 1
      fi
    fi
    if [[ "$UNINSTALL_PRE_ENABLED_STATE" == "enabled" ]]; then
      if ! verify_uninstall_loaded_unit ||
          ! read_unit_state is-enabled current_enabled || [[ "$current_enabled" != "enabled" ]] ||
          ! read_unit_state is-active current_active || [[ "$current_active" == "active" ]] ||
          ! verify_enablement_links "$current_enabled"; then
        fail_uninstall "Tokenelo unit state changed before enablement-link retirement"
        return 1
      fi
      expected_link="$(expected_enablement_link)"
      UNINSTALL_ENABLEMENT_LINK="$expected_link"
      UNINSTALL_ENABLEMENT_LINK_BACKUP="${SERVICE_LOCK_PATH}/enablement.backup"
      if [[ -e "$UNINSTALL_ENABLEMENT_LINK_BACKUP" || -L "$UNINSTALL_ENABLEMENT_LINK_BACKUP" ]]; then
        fail_uninstall "uninstall recovery link path is unexpectedly occupied"
        return 1
      fi
      target="$(readlink "$expected_link")" || { fail_uninstall "could not read the owned enablement link"; return 1; }
      if ! ln -s -- "$target" "$UNINSTALL_ENABLEMENT_LINK_BACKUP"; then
        fail_uninstall "could not preserve the exact enablement link before retirement"
        return 1
      fi
      backup_target="$(readlink -f -- "$UNINSTALL_ENABLEMENT_LINK_BACKUP")" || { fail_uninstall "enablement link backup did not resolve"; return 1; }
      if [[ "$backup_target" != "$UNIT_PATH" ]]; then
        fail_uninstall "enablement link backup does not target the exact Tokenelo unit"
        return 1
      fi
      if ! verify_enablement_links enabled || [[ "$(readlink -- "$expected_link")" != "$target" ]]; then
        fail_uninstall "Tokenelo enablement link changed before retirement"
        return 1
      fi
      UNINSTALL_ENABLEMENT_REMOVED=1
      if ! rm -f -- "$expected_link"; then
        fail_uninstall "could not retire the exact Tokenelo enablement link"
        return 1
      fi
      if [[ -e "$expected_link" || -L "$expected_link" ]]; then
        fail_uninstall "Tokenelo enablement link remained after retirement"
        return 1
      fi
      if ! verify_uninstall_loaded_unit ||
          ! read_unit_state is-active current_active || [[ "$current_active" == "active" ]]; then
        fail_uninstall "Tokenelo loaded action changed before systemd enablement refresh"
        return 1
      fi
      if ! systemctl --user daemon-reload; then
        fail_uninstall "systemd daemon-reload failed after retiring the exact enablement link"
        return 1
      fi
      if ! read_unit_state is-enabled current_enabled ||
          [[ "$current_enabled" == "enabled" || "$current_enabled" == "not-found" ]]; then
        fail_uninstall "systemd still reports an enabled or unknown Tokenelo unit after link retirement"
        return 1
      fi
    fi
  fi

  if [[ "$UNINSTALL_UNIT_PRESENT" == "1" ]]; then
    if ! verify_uninstall_loaded_unit; then
      fail_uninstall "Tokenelo loaded action changed before unit-file retirement"
      return 1
    fi
    if ! move_owned_file_to_quarantine "$UNIT_PATH" unit "$UNINSTALL_UNIT_SHA256"; then
      fail_uninstall "Tokenelo unit retirement failed"
      return 1
    fi
  fi
  if [[ "$UNINSTALL_AUTOSTART_PRESENT" == "1" ]]; then
    assert_owned_regular_file "$AUTOSTART_PATH" 644
    if [[ "$(sha256_path "$AUTOSTART_PATH")" != "$UNINSTALL_AUTOSTART_SHA256" ]]; then
      fail_uninstall "Tokenelo tray autostart changed before file retirement"
      return 1
    fi
    if ! move_owned_file_to_quarantine "$AUTOSTART_PATH" autostart "$UNINSTALL_AUTOSTART_SHA256"; then
      fail_uninstall "Tokenelo tray autostart retirement failed"
      return 1
    fi
  fi

  if [[ "$UNINSTALL_UNIT_PRESENT" == "1" ]]; then
    if ! systemctl --user daemon-reload; then
      fail_uninstall "systemd daemon-reload failed after retiring the exact Tokenelo unit"
      return 1
    fi
    if ! read_unit_fragment fragment || [[ -n "$fragment" ]]; then
      fail_uninstall "systemd still reports a loaded Tokenelo fragment after unit retirement"
      return 1
    fi
    if ! read_unit_state is-enabled current_enabled || [[ "$current_enabled" == "enabled" ]]; then
      fail_uninstall "systemd still reports Tokenelo enabled after unit retirement"
      return 1
    fi
    if ! read_unit_state is-active current_active || [[ "$current_active" == "active" ]]; then
      fail_uninstall "systemd still reports Tokenelo active after unit retirement"
      return 1
    fi
  fi
  if [[ "$UNINSTALL_UNIT_PRESENT" != "1" && ( -e "$UNIT_PATH" || -L "$UNIT_PATH" ) ]]; then
    fail_uninstall "an unexpected unit path appeared during uninstall"
    return 1
  fi
  if [[ "$UNINSTALL_AUTOSTART_PRESENT" != "1" && ( -e "$AUTOSTART_PATH" || -L "$AUTOSTART_PATH" ) ]]; then
    fail_uninstall "an unexpected tray autostart path appeared during uninstall"
    return 1
  fi

  if ! clear_uninstall_quarantine; then
    retain_install_backups
    echo "error: service entries were retired, but quarantine cleanup was incomplete; recovery retained" >&2
    return 1
  fi
  echo "Removed exact owned Tokenelo user startup entries. Any running tray application was left untouched."
  return 0
}

rollback_activation() {
  local reason="$1"
  local fragment="" current_active="" current_enabled=""
  local restore_unit=1
  local rollback_incomplete=0

  # Never stop or disable a pre-existing active/enabled service. If systemd still
  # points at this exact candidate and it became active during this attempt, it is
  # safe to stop only that newly-started candidate; likewise, disable only a link
  # that was absent before this invocation.
  if read_unit_fragment fragment && [[ "$fragment" == "$UNIT_PATH" ]] && candidate_file_is_still_ours "$UNIT_PATH" "$UNIT_CANDIDATE_SHA256"; then
    if [[ "$PRE_ACTIVE_STATE" != "active" ]]; then
      if read_unit_state is-active current_active; then
        if [[ "$current_active" == "active" ]]; then
          if ! systemctl --user stop "$UNIT_NAME"; then
            echo "error: rollback could not stop the candidate ${UNIT_NAME}" >&2
            rollback_incomplete=1
            restore_unit=0
          elif ! read_unit_state is-active current_active || [[ "$current_active" == "active" ]]; then
            echo "error: candidate ${UNIT_NAME} remains active after rollback stop" >&2
            rollback_incomplete=1
            restore_unit=0
          fi
        fi
      else
        echo "error: rollback could not determine whether ${UNIT_NAME} is active" >&2
        rollback_incomplete=1
        restore_unit=0
      fi
    fi
    if [[ "$PRE_ENABLED_STATE" == "disabled" || "$PRE_ENABLED_STATE" == "not-found" ]]; then
      if read_unit_state is-enabled current_enabled; then
        if [[ "$current_enabled" == "enabled" ]]; then
          if ! systemctl --user disable "$UNIT_NAME"; then
            echo "error: rollback could not disable the candidate ${UNIT_NAME}" >&2
            rollback_incomplete=1
            restore_unit=0
          elif ! read_unit_state is-enabled current_enabled || [[ "$current_enabled" == "enabled" ]]; then
            echo "error: candidate ${UNIT_NAME} remains enabled after rollback disable" >&2
            rollback_incomplete=1
            restore_unit=0
          fi
        fi
      else
        echo "error: rollback could not determine whether ${UNIT_NAME} is enabled" >&2
        rollback_incomplete=1
        restore_unit=0
      fi
    fi
  else
    echo "warning: systemd no longer identifies the loaded unit as this candidate; left service state untouched" >&2
    rollback_incomplete=1
    restore_unit=0
  fi

  if ! restore_candidate_files "$restore_unit"; then
    rollback_incomplete=1
  fi
  if ! systemctl --user daemon-reload; then
    echo "error: rollback could not reload the restored unit file" >&2
    rollback_incomplete=1
  fi
  if [[ "$rollback_incomplete" == "0" ]]; then
    echo "error: ${reason}; candidate rollback completed" >&2
  else
    echo "error: ${reason}; rollback was incomplete" >&2
  fi
  return "$rollback_incomplete"
}

move_owned_file_to_quarantine() {
  local file="$1" role="$2" expected_hash="$3"
  local parent base quarantine destination actual_hash
  assert_owned_regular_file "$file" 644 || return 1
  actual_hash="$(sha256_path "$file")"
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    echo "error: $file changed after uninstall preflight; refusing to retire it" >&2
    return 1
  fi
  parent="$(dirname "$file")"
  base="$(basename "$file")"
  quarantine="$(mktemp -d "${parent}/.${base}.tokenelo-uninstall.XXXXXX")" || return 1
  chmod 0700 -- "$quarantine"
  assert_owned_directory "$quarantine" || return 1
  destination="${quarantine}/retired"
  if ! mv -- "$file" "$destination"; then
    rmdir -- "$quarantine" 2>/dev/null || true
    echo "error: could not move the exact owned file into uninstall recovery staging: $file" >&2
    return 1
  fi
  if [[ "$role" == "unit" ]]; then
    UNINSTALL_UNIT_QUARANTINE_DIR="$quarantine"
    UNINSTALL_UNIT_REMOVED=1
  else
    UNINSTALL_AUTOSTART_QUARANTINE_DIR="$quarantine"
    UNINSTALL_AUTOSTART_REMOVED=1
  fi
  if ! assert_owned_regular_file "$destination" 644 || [[ "$(sha256_path "$destination")" != "$expected_hash" ]]; then
    echo "error: $role changed while being moved; preserving it for guarded recovery" >&2
    return 1
  fi
}

restore_uninstall_file() {
  local path="$1" existed="$2" backup="$3" expected_hash="$4" role="$5"
  local quarantine_dir quarantine_file temp
  if [[ "$existed" != "1" ]]; then
    if [[ -e "$path" || -L "$path" ]]; then
      echo "error: $path appeared during uninstall; left the unexpected file untouched" >&2
      return 1
    fi
    return 0
  fi

  if [[ -e "$path" || -L "$path" ]]; then
    if assert_owned_regular_file "$path" 644 && [[ "$(sha256_path "$path")" == "$expected_hash" ]]; then
      return 0
    fi
    echo "error: $path is now foreign; refusing to overwrite it during uninstall rollback" >&2
    return 1
  fi

  quarantine_dir=""
  if [[ "$role" == "unit" ]]; then quarantine_dir="$UNINSTALL_UNIT_QUARANTINE_DIR"; fi
  if [[ "$role" == "autostart" ]]; then quarantine_dir="$UNINSTALL_AUTOSTART_QUARANTINE_DIR"; fi
  quarantine_file="${quarantine_dir}/retired"
  if [[ -n "$quarantine_dir" && ( -e "$quarantine_file" || -L "$quarantine_file" ) ]]; then
    if assert_owned_regular_file "$quarantine_file" 644 && [[ "$(sha256_path "$quarantine_file")" == "$expected_hash" ]]; then
      if ! mv -- "$quarantine_file" "$path"; then
        echo "error: could not restore the exact retired file from quarantine: $path" >&2
        return 1
      fi
      if [[ "$role" == "unit" ]]; then UNINSTALL_UNIT_REMOVED=0; else UNINSTALL_AUTOSTART_REMOVED=0; fi
      assert_owned_regular_file "$path" 644 && [[ "$(sha256_path "$path")" == "$expected_hash" ]]
      return $?
    fi
    # The moved path changed after retirement. Restore the original filesystem object if the
    # destination is still absent; do not discard or overwrite that changed object.
    if ! mv -- "$quarantine_file" "$path"; then
      echo "error: a changed object remains in uninstall quarantine at $quarantine_file" >&2
      return 1
    fi
    echo "error: a changed object was restored at $path; prior bytes remain in the backup" >&2
    return 1
  fi

  if [[ ! -f "$backup" || -L "$backup" || "$(sha256_path "$backup")" != "$expected_hash" ]]; then
    echo "error: uninstall backup is missing or changed for $path" >&2
    return 1
  fi
  temp="$(mktemp "$(dirname "$path")/.$(basename "$path").tokenelo-restore.XXXXXX")" || return 1
  INSTALL_TEMP_FILES+=("$temp")
  if ! cp -p -- "$backup" "$temp" || ! mv -f -- "$temp" "$path"; then
    echo "error: could not restore uninstall backup at $path" >&2
    return 1
  fi
  assert_owned_regular_file "$path" 644 && [[ "$(sha256_path "$path")" == "$expected_hash" ]]
}

restore_uninstall_enablement_link() {
  local current_target backup_target details owner kind
  [[ "$UNINSTALL_ENABLEMENT_REMOVED" == "1" ]] || return 0
  if [[ -L "$UNINSTALL_ENABLEMENT_LINK" ]]; then
    current_target="$(readlink -f -- "$UNINSTALL_ENABLEMENT_LINK")" || return 1
    if [[ "$current_target" == "$UNIT_PATH" ]]; then
      if ! rm -f -- "$UNINSTALL_ENABLEMENT_LINK_BACKUP"; then
        echo "error: could not discard the exact duplicate enablement-link backup" >&2
        return 1
      fi
      UNINSTALL_ENABLEMENT_REMOVED=0
      return 0
    fi
    echo "error: a foreign enablement link occupies the Tokenelo link path" >&2
    return 1
  fi
  if [[ -e "$UNINSTALL_ENABLEMENT_LINK" ]]; then
    echo "error: a foreign path occupies the Tokenelo enablement link path" >&2
    return 1
  fi
  if [[ ! -L "$UNINSTALL_ENABLEMENT_LINK_BACKUP" ]]; then
    echo "error: the original Tokenelo enablement link backup is unavailable" >&2
    return 1
  fi
  backup_target="$(readlink -f -- "$UNINSTALL_ENABLEMENT_LINK_BACKUP")" || return 1
  if [[ "$backup_target" != "$UNIT_PATH" ]]; then
    echo "error: the saved enablement link no longer points to the exact Tokenelo unit" >&2
    return 1
  fi
  if ! mv -- "$UNINSTALL_ENABLEMENT_LINK_BACKUP" "$UNINSTALL_ENABLEMENT_LINK"; then
    echo "error: could not restore the exact Tokenelo enablement link" >&2
    return 1
  fi
  details="$(/usr/bin/stat -c '%u %F' -- "$UNINSTALL_ENABLEMENT_LINK")" || return 1
  read -r owner kind <<<"$details"
  current_target="$(readlink -f -- "$UNINSTALL_ENABLEMENT_LINK")" || return 1
  if [[ "$owner" != "$CURRENT_UID" || "$kind" != "symbolic link" || "$current_target" != "$UNIT_PATH" ]]; then
    echo "error: restored Tokenelo enablement link did not verify" >&2
    return 1
  fi
  UNINSTALL_ENABLEMENT_REMOVED=0
}

clear_uninstall_quarantine() {
  local directory role file hash
  for role in unit autostart; do
    directory=""
    hash=""
    if [[ "$role" == "unit" ]]; then directory="$UNINSTALL_UNIT_QUARANTINE_DIR"; hash="$UNINSTALL_UNIT_SHA256"; fi
    if [[ "$role" == "autostart" ]]; then directory="$UNINSTALL_AUTOSTART_QUARANTINE_DIR"; hash="$UNINSTALL_AUTOSTART_SHA256"; fi
    [[ -n "$directory" ]] || continue
    file="${directory}/retired"
    if [[ -e "$file" || -L "$file" ]]; then
      if ! assert_owned_regular_file "$file" 644 || [[ "$(sha256_path "$file")" != "$hash" ]]; then
        echo "error: quarantine contains a changed object; it was retained at $directory" >&2
        return 1
      fi
      if ! rm -f -- "$file"; then
        echo "error: could not remove the retired file copy at $file" >&2
        return 1
      fi
    fi
    if ! rmdir -- "$directory"; then
      echo "error: could not remove the empty uninstall quarantine directory $directory" >&2
      return 1
    fi
    if [[ "$role" == "unit" ]]; then UNINSTALL_UNIT_QUARANTINE_DIR=""; else UNINSTALL_AUTOSTART_QUARANTINE_DIR=""; fi
  done
  if [[ -n "$UNINSTALL_ENABLEMENT_LINK_BACKUP" && -L "$UNINSTALL_ENABLEMENT_LINK_BACKUP" ]]; then
    if ! rm -f -- "$UNINSTALL_ENABLEMENT_LINK_BACKUP"; then
      echo "error: could not remove the retired enablement-link backup" >&2
      return 1
    fi
  fi
}

if [[ "$ACTION" == "uninstall" ]]; then
  uninstall_owned_service
  exit 0
fi

provision_service_directories

# Snapshot and fully stage both files before replacing either one or changing
# systemd state. A tray write failure therefore cannot leave a new daemon unit.
snapshot_install_file "$UNIT_PATH" UNIT_PREEXISTED UNIT_BACKUP
if [[ "$WITH_TRAY" == "1" ]]; then
  snapshot_install_file "$AUTOSTART_PATH" AUTOSTART_PREEXISTED AUTOSTART_BACKUP
fi

UNIT_STAGE="$(mktemp "${UNIT_DIR}/.${UNIT_NAME}.tokenelo-install.XXXXXX")"
INSTALL_TEMP_FILES+=("$UNIT_STAGE")
render_daemon_unit > "$UNIT_STAGE"
chmod 0644 "$UNIT_STAGE"

if [[ "$WITH_TRAY" == "1" ]]; then
  AUTOSTART_STAGE="$(mktemp "$(dirname "$AUTOSTART_PATH")/.tokenelo-tray.desktop.tokenelo-install.XXXXXX")"
  INSTALL_TEMP_FILES+=("$AUTOSTART_STAGE")
  render_tray_autostart > "$AUTOSTART_STAGE"
  chmod 0644 "$AUTOSTART_STAGE"
  AUTOSTART_CANDIDATE_SHA256="$(sha256sum < "$AUTOSTART_STAGE" | cut -d ' ' -f 1)"
fi

# Refuse ambiguous manager states before touching either destination. In
# particular, a same-named unit loaded from another directory is not ours to
# replace or stop.
read_unit_state is-enabled PRE_ENABLED_STATE
read_unit_state is-active PRE_ACTIVE_STATE
read_unit_fragment PRE_FRAGMENT_PATH

UNIT_CANDIDATE_SHA256="$(sha256sum < "$UNIT_STAGE" | cut -d ' ' -f 1)"
if ! mv -f -- "$UNIT_STAGE" "$UNIT_PATH"; then
  echo "error: could not write candidate unit at $UNIT_PATH" >&2
  exit 1
fi
UNIT_COMMITTED=1

if [[ "$WITH_TRAY" == "1" ]]; then
  if ! mv -f -- "$AUTOSTART_STAGE" "$AUTOSTART_PATH"; then
    echo "error: could not write candidate autostart file at $AUTOSTART_PATH" >&2
    if ! restore_candidate_files; then
      echo "error: rollback could not restore all prior installer files" >&2
    fi
    exit 1
  fi
  AUTOSTART_COMMITTED=1
fi

if ! systemctl --user daemon-reload; then
  echo "error: systemd daemon-reload failed" >&2
  if ! restore_candidate_files; then
    echo "error: rollback could not restore all prior installer files" >&2
  fi
  if ! systemctl --user daemon-reload; then
    echo "error: rollback could not reload the restored unit file" >&2
  fi
  exit 1
fi

if ! systemctl --user enable "$UNIT_NAME"; then
  rollback_activation "systemd enable failed"
  exit 1
fi

if ! systemctl --user start "$UNIT_NAME"; then
  rollback_activation "systemd start failed"
  exit 1
fi

echo "Installed, enabled and started ${UNIT_NAME} from ${UNIT_PATH}."
echo "Logs: journalctl --user -u ${UNIT_NAME} -f"

if [[ "$WITH_TRAY" == "1" ]]; then
  echo "Installed tray autostart: $AUTOSTART_PATH"
fi
