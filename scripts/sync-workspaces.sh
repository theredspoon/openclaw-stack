#!/usr/bin/env bash
# sync-workspaces.sh — Bidirectional sync of agent workspace files between
# local openclaw/<claw>/workspace/<agent>/ and VPS instances/<claw>/workspace[-<agent>]/
#
# Directory mapping:
#   Local: openclaw/<claw>/workspace/main/       → VPS: instances/<claw>/workspace/
#   Local: openclaw/<claw>/workspace/<agent-id>/  → VPS: instances/<claw>/workspace-<agent-id>/
#
# Usage:
#   ./scripts/sync-workspaces.sh up   [--instance <claw>] [--force] [-y|--yes]
#   ./scripts/sync-workspaces.sh down [--instance <claw>] [--all] [--force] [-y|--yes]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/source-config.sh"
source "$SCRIPT_DIR/lib/colors.sh"
source "$SCRIPT_DIR/lib/ssh.sh"
source "$SCRIPT_DIR/lib/instances.sh"

# ── Parse args ────────────────────────────────────────────────────────────────

DIRECTION=""
SYNC_INSTANCE=""
FORCE=false
ALL=false
YES=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    up|down)      DIRECTION="$1"; shift ;;
    --instance)   SYNC_INSTANCE="$2"; shift 2 ;;
    --force)      FORCE=true; shift ;;
    --all)        ALL=true; shift ;;
    -y|--yes)     YES=true; shift ;;
    *)            echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$DIRECTION" ]; then
  echo "Usage: sync-workspaces.sh <up|down> [--instance <claw>] [--force] [--all] [-y|--yes]" >&2
  exit 1
fi

# Auto-imply -y when stdin is not a terminal (piped/scripted use)
if [ ! -t 0 ]; then
  YES=true
fi

# Global excludes (both directions)
SYNC_EXCLUDE="--exclude=*.live-version.* --exclude=.*"

# Extra rsync flags for workspace sync (itemize changes + global excludes)
RSYNC_EXTRA="--itemize-changes ${SYNC_EXCLUDE}"

# Dirs where remote-newer conflicts block UP sync (require --force)
PROTECTED_DIRS=(memory)

resolve_instance_list "${SYNC_INSTANCE:-all}"

# ── Map agent name ↔ VPS directory ───────────────────────────────────────────
# "main" maps to bare workspace/, others to workspace-<agent-id>/

vps_workspace_dir() {
  local claw="$1" agent="$2"
  if [ "$agent" = "main" ]; then
    echo "${INSTALL_DIR}/instances/${claw}/.openclaw/workspace/"
  else
    echo "${INSTALL_DIR}/instances/${claw}/.openclaw/workspace-${agent}/"
  fi
}

# ── Helpers ──────────────────────────────────────────────────────────────────

# Format timestamp + size for display
format_file_info() {
  local epoch="$1" size="$2"
  local date_str
  # macOS date -r, Linux date -d @
  date_str=$(date -r "$epoch" "+%Y-%m-%d %H:%M" 2>/dev/null || date -d "@$epoch" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "unknown")
  local size_str
  if command -v numfmt &>/dev/null; then
    size_str=$(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B")
  elif (( size >= 1048576 )); then
    size_str="$(( size / 1048576 )).$(( (size % 1048576) * 10 / 1048576 )) MB"
  elif (( size >= 1024 )); then
    size_str="$(( size / 1024 )).$(( (size % 1024) * 10 / 1024 )) KB"
  else
    size_str="${size}B"
  fi
  echo "${date_str} (${size_str})"
}

# Check if a path is under a protected directory
is_protected() {
  local filepath="$1"
  for dir in "${PROTECTED_DIRS[@]}"; do
    if [[ "$filepath" == "${dir}/"* || "$filepath" == "$dir" ]]; then
      return 0
    fi
  done
  return 1
}

# ── Conflict resolution: UP (local → VPS) ───────────────────────────────────
# Sets CONFLICT_EXCLUDES array with --exclude flags for files to skip.

resolve_up_conflicts() {
  local local_dir="$1" remote_dir="$2" claw="$3" agent="$4"
  CONFLICT_EXCLUDES=()

  # 1. Dry-run rsync to identify files that would transfer
  local dry_output
  dry_output=$(RSYNC_EXTRA="--dry-run --itemize-changes ${SYNC_EXCLUDE}" \
    do_rsync "$local_dir" "${VPS}:${remote_dir}" 2>&1) || true

  # Parse files that would be transferred
  # rsync itemize: <f = file sent to remote (UP), >f = file received (DOWN)
  # Also match cf (checksum differs). The key is position 1 = 'f' (regular file).
  local transfer_files=()
  while IFS= read -r line; do
    if [[ "$line" =~ ^[\<\>cf][f] ]]; then
      # Extract filename (after the itemize flags and space)
      local fname="${line##* }"
      [ -n "$fname" ] && transfer_files+=("$fname")
    fi
  done <<< "$dry_output"

  if [ ${#transfer_files[@]} -eq 0 ]; then
    info "  ${agent}: nothing to sync"
    return
  fi

  # 2. Batch-get remote timestamps for all files in the remote dir
  # Format: epoch_seconds size relative_path
  local remote_info
  remote_info=$(${SSH_CMD} "${VPS}" "sudo find ${remote_dir} -type f -printf '%T@ %s %P\n'" 2>/dev/null) || true

  # Build associative-style lookup (bash 3 compatible — use parallel arrays)
  local remote_paths=() remote_epochs=() remote_sizes=()
  while IFS= read -r rline; do
    [ -z "$rline" ] && continue
    local repoch rsize rpath
    repoch="${rline%% *}"
    rline="${rline#* }"
    rsize="${rline%% *}"
    rpath="${rline#* }"
    remote_paths+=("$rpath")
    remote_epochs+=("${repoch%%.*}")
    remote_sizes+=("$rsize")
  done <<< "$remote_info"

  # Helper: look up remote file info by path
  get_remote_info() {
    local target="$1"
    for i in "${!remote_paths[@]}"; do
      if [ "${remote_paths[$i]}" = "$target" ]; then
        REMOTE_EPOCH="${remote_epochs[$i]}"
        REMOTE_SIZE="${remote_sizes[$i]}"
        return 0
      fi
    done
    return 1
  }

  # 3. Compare, categorize, prompt
  local skip_all_md=false
  local overwrite_all_md=false
  local protected_conflicts=()
  local skipped_files=()

  for fname in "${transfer_files[@]}"; do
    local local_file="${local_dir}${fname}"

    # Get local timestamp + size (macOS stat)
    local local_epoch local_size
    local_epoch=$(stat -f '%m' "$local_file" 2>/dev/null || stat -c '%Y' "$local_file" 2>/dev/null || echo 0)
    local_size=$(stat -f '%z' "$local_file" 2>/dev/null || stat -c '%s' "$local_file" 2>/dev/null || echo 0)

    # Check if file exists on remote
    if ! get_remote_info "$fname"; then
      # New file — auto-upload
      continue
    fi

    # File exists on both sides — check for conflict
    if (( REMOTE_EPOCH > local_epoch )); then
      # Remote is newer — this is a conflict

      # Check if it's in a protected dir
      if is_protected "$fname"; then
        protected_conflicts+=("$fname")
        skipped_files+=("$fname")
        continue
      fi

      # Check if it's a .md file (special per-file prompt)
      if [[ "$fname" == *.md ]]; then
        if $skip_all_md; then
          skipped_files+=("$fname")
          continue
        fi
        if $overwrite_all_md; then
          continue
        fi

        if $YES; then
          # Non-interactive: skip conflicts (safe default)
          skipped_files+=("$fname")
          continue
        fi

        echo ""
        warn "  Conflict: ${fname}"
        echo "    Local:  $(format_file_info "$local_epoch" "$local_size")"
        echo "    Remote: $(format_file_info "$REMOTE_EPOCH" "$REMOTE_SIZE")  ← newer"
        while true; do
          read -r -p "    [s]kip / [o]verwrite / [S]kip all .md / [O]verwrite all .md? " choice
          case "$choice" in
            s) skipped_files+=("$fname"); break ;;
            o) break ;;
            S) skip_all_md=true; skipped_files+=("$fname"); break ;;
            O) overwrite_all_md=true; break ;;
            *) echo "    Please enter s, o, S, or O" ;;
          esac
        done
      else
        # Non-md file conflict — auto-skip with warning
        warn "  Skipping ${fname} (remote is newer)"
        skipped_files+=("$fname")
      fi
    fi
    # else: remote is older or same age — auto-upload (no conflict)
  done

  # Handle protected dir conflicts
  if [ ${#protected_conflicts[@]} -gt 0 ]; then
    echo ""
    warn "  ${PROTECTED_DIRS[0]}/ has ${#protected_conflicts[@]} file(s) newer on VPS (would be overwritten)"
    for pf in "${protected_conflicts[@]}"; do
      echo "    - ${pf}"
    done

    if $YES; then
      info "  Skipping protected dir (non-interactive mode)"
    else
      while true; do
        read -r -p "    [s]kip ${PROTECTED_DIRS[0]}/ / [q]uit (use --force to overwrite protected dirs)? " choice
        case "$choice" in
          s) break ;;
          q) echo "Aborted."; exit 1 ;;
          *) echo "    Please enter s or q" ;;
        esac
      done
    fi
  fi

  # 4. Build --exclude list
  for sf in ${skipped_files[@]+"${skipped_files[@]}"}; do
    CONFLICT_EXCLUDES+=("--exclude=$sf")
  done
}

# ── Conflict resolution: DOWN (VPS → local) ─────────────────────────────────
# Sets CONFLICT_EXCLUDES array with --exclude flags for files to skip.

resolve_down_conflicts() {
  local local_dir="$1" remote_dir="$2" claw="$3"
  CONFLICT_EXCLUDES=()

  # 1. Dry-run rsync to identify files that would transfer
  local extra_flags=""
  if ! $ALL; then
    extra_flags="--include=*/ --include=*.md --exclude=*"
  fi

  local dry_output
  dry_output=$(RSYNC_EXTRA="--dry-run --itemize-changes ${SYNC_EXCLUDE} ${extra_flags}" \
    do_rsync "${VPS}:${remote_dir}" "$local_dir" 2>&1) || true

  # Parse files that would be transferred
  # rsync itemize: >f = file received from remote (DOWN), <f = sent (UP)
  local transfer_files=()
  while IFS= read -r line; do
    if [[ "$line" =~ ^[\<\>cf][f] ]]; then
      local fname="${line##* }"
      [ -n "$fname" ] && transfer_files+=("$fname")
    fi
  done <<< "$dry_output"

  if [ ${#transfer_files[@]} -eq 0 ]; then
    info "  nothing to sync"
    return
  fi

  # 2. Check local timestamps for existing files
  local skipped_files=()
  local overwrite_all=false

  for fname in "${transfer_files[@]}"; do
    local local_file="${local_dir}${fname}"

    # If file doesn't exist locally, no conflict
    [ -f "$local_file" ] || continue

    # Get local timestamp + size
    local local_epoch local_size
    local_epoch=$(stat -f '%m' "$local_file" 2>/dev/null || stat -c '%Y' "$local_file" 2>/dev/null || echo 0)
    local_size=$(stat -f '%z' "$local_file" 2>/dev/null || stat -c '%s' "$local_file" 2>/dev/null || echo 0)

    # Get remote timestamp + size via SSH
    local remote_stat
    remote_stat=$(${SSH_CMD} "${VPS}" "sudo stat -c '%Y %s' '${remote_dir}${fname}'" 2>/dev/null) || continue
    local remote_epoch="${remote_stat%% *}"
    local remote_size="${remote_stat##* }"

    # Conflict: local is newer than remote
    if (( local_epoch > remote_epoch )); then
      if $overwrite_all; then
        continue
      fi

      if $YES; then
        # Non-interactive: skip conflicts (safe default)
        skipped_files+=("$fname")
        continue
      fi

      echo ""
      warn "  Conflict: ${fname}"
      echo "    Local:  $(format_file_info "$local_epoch" "$local_size")  ← newer"
      echo "    Remote: $(format_file_info "$remote_epoch" "$remote_size")"
      while true; do
        read -r -p "    [s]kip / [o]verwrite / [A]LL (overwrite all conflicts for this claw)? " choice
        case "$choice" in
          s) skipped_files+=("$fname"); break ;;
          o) break ;;
          A|ALL) overwrite_all=true; break ;;
          *) echo "    Please enter s, o, or A" ;;
        esac
      done
    fi
  done

  # 3. Build --exclude list
  for sf in ${skipped_files[@]+"${skipped_files[@]}"}; do
    CONFLICT_EXCLUDES+=("--exclude=$sf")
  done
}

# ── Sync log ─────────────────────────────────────────────────────────────────

write_sync_log() {
  local claw="$1" agents="$2" rsync_output="$3"
  local log_dir="${REPO_ROOT}/openclaw/${claw}/workspace"
  mkdir -p "$log_dir"
  local log_file="${log_dir}/.sync-log"

  local mode_label="$DIRECTION"
  $FORCE && mode_label="${mode_label} (force)"
  $ALL && mode_label="${mode_label} (all)"

  {
    echo ""
    echo "# ── Workspace sync: ${mode_label} ───────────────────────────"
    echo "# Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# Instance: ${claw}"
    echo "# Agents: ${agents}"
    echo "$rsync_output"
  } >> "$log_file"
}

# ── UP: local → VPS ─────────────────────────────────────────────────────────

do_up() {
  local claw="$1"
  local workspace_root="${REPO_ROOT}/openclaw/${claw}/workspace"

  if [ ! -d "$workspace_root" ]; then
    warn "No workspace directory for '${claw}' (openclaw/${claw}/workspace/)"
    return
  fi

  # Discover agents from local subdirs
  local agents=()
  for agent_dir in "$workspace_root"/*/; do
    [ -d "$agent_dir" ] || continue
    agents+=("$(basename "$agent_dir")")
  done

  if [ ${#agents[@]} -eq 0 ]; then
    warn "No agent directories in openclaw/${claw}/workspace/"
    return
  fi

  info "Uploading workspaces for ${claw}: ${agents[*]}"

  local all_output=""
  for agent in "${agents[@]}"; do
    local local_dir="${workspace_root}/${agent}/"
    local remote_dir
    remote_dir=$(vps_workspace_dir "$claw" "$agent")

    # Ensure remote dir exists with correct ownership
    ${SSH_CMD} "${VPS}" "sudo mkdir -p ${remote_dir} && sudo chown -R 1000:1000 ${remote_dir}"

    local extra_flags=()
    if $FORCE; then
      info "  ${agent}: force uploading all files"
    else
      # Smart conflict resolution
      resolve_up_conflicts "$local_dir" "$remote_dir" "$claw" "$agent"
      extra_flags=("${CONFLICT_EXCLUDES[@]+"${CONFLICT_EXCLUDES[@]}"}")
    fi

    info "  ${agent}: openclaw/${claw}/workspace/${agent}/ → ${remote_dir}"
    local output
    output=$(do_rsync ${extra_flags[@]+"${extra_flags[@]}"} "$local_dir" "${VPS}:${remote_dir}" 2>&1) || true
    echo "$output" | grep -v '^$' || true
    all_output="${all_output}
--- ${agent} ---
${output}"

    # Fix ownership after upload
    ${SSH_CMD} "${VPS}" "sudo chown -R 1000:1000 ${remote_dir}"
  done

  write_sync_log "$claw" "$(IFS=,; echo "${agents[*]}")" "$all_output"
  success "Upload complete for ${claw}"
}

# ── DOWN: VPS → local ───────────────────────────────────────────────────────

do_down() {
  local claw="$1"

  # Discover agents from VPS workspace dirs
  local raw_dirs
  raw_dirs=$(${SSH_CMD} "${VPS}" "sudo bash -c 'ls -1d ${INSTALL_DIR}/instances/${claw}/.openclaw/workspace* 2>/dev/null'" 2>/dev/null) || true

  if [ -z "$raw_dirs" ]; then
    warn "No workspace directories found on VPS for '${claw}'"
    return
  fi

  local agents=()
  while IFS= read -r dir_path; do
    local dirname
    dirname=$(basename "$dir_path")
    if [ "$dirname" = "workspace" ]; then
      agents+=("main")
    else
      # workspace-<agent-id> → <agent-id>
      agents+=("${dirname#workspace-}")
    fi
  done <<< "$raw_dirs"

  info "Downloading workspaces for ${claw}: ${agents[*]}"

  local all_output=""
  for agent in "${agents[@]}"; do
    local remote_dir
    remote_dir=$(vps_workspace_dir "$claw" "$agent")
    local local_dir="${REPO_ROOT}/openclaw/${claw}/workspace/${agent}/"

    mkdir -p "$local_dir"

    local extra_flags=()

    if $FORCE; then
      # Force: download everything, no prompts
      if $ALL; then
        : # No extra flags — sync all files
      else
        extra_flags+=(--include='*/' --include='*.md' --exclude='*')
      fi
    else
      # Smart conflict resolution
      resolve_down_conflicts "$local_dir" "$remote_dir" "$claw"
      extra_flags=("${CONFLICT_EXCLUDES[@]+"${CONFLICT_EXCLUDES[@]}"}")

      if ! $ALL; then
        extra_flags+=(--include='*/' --include='*.md' --exclude='*')
      fi
    fi

    info "  ${agent}: ${remote_dir} → openclaw/${claw}/workspace/${agent}/"
    local output
    output=$(do_rsync ${extra_flags[@]+"${extra_flags[@]}"} "${VPS}:${remote_dir}" "$local_dir" 2>&1) || true
    echo "$output" | grep -v '^$' || true
    all_output="${all_output}
--- ${agent} ---
${output}"
  done

  write_sync_log "$claw" "$(IFS=,; echo "${agents[*]}")" "$all_output"
  success "Download complete for ${claw}"
}

# ── Main ─────────────────────────────────────────────────────────────────────

for claw in $INSTANCE_LIST; do
  if [ "$DIRECTION" = "up" ]; then
    do_up "$claw"
  else
    do_down "$claw"
  fi
done

echo ""
success "Workspace sync ($DIRECTION) complete."
