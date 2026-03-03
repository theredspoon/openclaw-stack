# Plan: Workspace Sync UX Redesign

## Context

Workspaces are **VPS-primary** data — identity files (AGENTS.md, SOUL.md), memory files, and host-status reports are written by agents and cron jobs on the VPS. Local copies are snapshots. The current `deploy.sh` auto-syncs workspaces UP on every deploy, and `sync-workspaces.sh` uses `--ignore-existing` which is too blunt — it prevents *all* updates to existing files, even when the user explicitly wants to push newer local versions.

**Goal:** Replace `--ignore-existing` with smart per-file conflict detection. A "conflict" = overwriting a newer file on the destination side. The #1 priority is never accidentally clobbering important `.md` files.

## Feasibility Assessment

The interactive conflict resolution is **feasible and not brittle**. Core mechanism:

1. rsync `--dry-run --itemize-changes` → list of files that would transfer (reliable, stable format)
2. Single SSH call per agent to batch-get remote timestamps: `find <dir> -type f -printf '%T@ %s %P\n'`
3. Compare with local timestamps (`stat -f '%m %z'` on macOS)
4. Build `--exclude` list from skipped files/dirs
5. Execute actual rsync with those excludes

Typical workspace has 5-15 `.md` files, so prompting is manageable. The `ALL` option handles cases with many files.

## Changes

### 1. Remove workspace sync from deploy.sh

Remove Step 3 entirely. Deploy becomes 3 steps: pre-deploy → sync configs → auto-restart. Also remove the `MISSING_WORKSPACES` detection and sync-down hint.

**File:** `scripts/deploy.sh` — delete lines 118-149 (step 3 block), renumber steps, remove `MISSING_WORKSPACES` from summary.

### 2. Rename `host-status/` → `.host-status/`

Auto-excluded from rsync via existing `--exclude=.*`. One atomic rename on VPS + config updates.

**Files to update (6 files, ~8 locations):**

- `deploy/setup/setup-infra.sh` — mkdir path
- `deploy/host/host-alert.sh` — write path (lines 170, 286)
- `deploy/host/host-maintenance-check.sh` — write path (line 65)
- `deploy/host/register-cron-jobs.sh` — cron prompt text (line 170)
- `openclaw/default/openclaw.jsonc` — bind mount (line 204)
- `openclaw/default/openclaw.router.jsonc` — bind mount (line 208)

### 3. Redesign sync-workspaces.sh conflict resolution

#### New flags

```
sync-workspaces.sh up   [--instance <claw>] [--force] [-y|--yes]
sync-workspaces.sh down [--instance <claw>] [--all] [--force] [-y|--yes]
```

`-y`/`--yes` skips confirmation prompts (for scripted use). Non-interactive (piped stdin) auto-implies `-y` with safe defaults (skip conflicts).

#### Global excludes (both directions)

```bash
SYNC_EXCLUDE=(
  --exclude='*.live-version.*'   # Never sync drift-comparison files
  --exclude='.*'                 # Dotfiles/dirs (existing behavior, kept via RSYNC_EXTRA)
)
```

#### UP behavior (local → VPS)

**Without `--force`:**

For each agent within each claw:

1. rsync `--dry-run` to identify files that would transfer
2. SSH to get remote timestamps for all existing remote files (one call)
3. Categorize each file that would transfer:

| Category | Condition | Action |
|----------|-----------|--------|
| New file | Not on VPS | Auto-upload |
| No conflict | Remote is older or same age | Auto-upload |
| `.md` conflict | Remote is newer | Per-file prompt with date+size diff |
| Protected dir conflict | `memory/` has any remote-newer files | Block: skip or exit (need `--force`) |
| Subdir conflict | Other subdir has remote-newer files | Show summary, prompt: skip dir or overwrite all |

Per-file prompt format:

```
  Conflict: AGENTS.md
    Local:  2026-03-02 14:30 (2.1 KB)
    Remote: 2026-03-03 09:15 (2.4 KB)  ← newer
    [s]kip / [o]verwrite / [S]kip all .md / [O]verwrite all .md?
```

Protected dir prompt:

```
  ! memory/ has 3 files newer on VPS (would be overwritten)
    [s]kip memory/ / [q]uit (use --force to overwrite protected dirs)?
```

1. Build `--exclude` list from user choices
2. Execute rsync

**With `--force`:** rsync everything, no prompts, no `--ignore-existing`.

#### DOWN behavior (VPS → local)

**Without `--force`:**

For each agent within each claw:

1. rsync `--dry-run` to identify files that would transfer
2. Check local timestamps for existing local files
3. For each conflict (local is newer than remote):

```
  Conflict: memory/2026-03-02-session.md
    Local:  2026-03-03 10:00 (1.2 KB)  ← newer
    Remote: 2026-03-02 18:30 (0.8 KB)
    [s]kip / [o]verwrite / [A]LL (overwrite all conflicts for this claw)?
```

- `s`: skip this file
- `o`: overwrite this file
- `A`/`ALL`: overwrite all remaining conflicts for this claw (resets for next claw)

1. Build `--exclude` list, execute rsync

**With `--force`:** rsync everything, no prompts.

**`--all` vs default:** unchanged — default syncs `*.md` only, `--all` syncs everything.

### 4. Protected dirs list

Maintained as a bash array in `sync-workspaces.sh`:

```bash
# Dirs where remote-newer conflicts block UP sync (require --force)
PROTECTED_DIRS=(memory)
```

Start with just `memory/`. Easy to extend later.

## Implementation structure

The conflict resolution logic lives in two new functions in `sync-workspaces.sh`:

```bash
# Returns: sets CONFLICT_EXCLUDES array with --exclude flags
resolve_up_conflicts() {
  local local_dir="$1" remote_dir="$2" claw="$3" agent="$4"
  # 1. dry-run rsync → parse transfer list
  # 2. SSH batch-get remote timestamps
  # 3. Compare, categorize, prompt
  # 4. Build CONFLICT_EXCLUDES
}

resolve_down_conflicts() {
  local local_dir="$1" remote_dir="$2" claw="$3"
  # 1. dry-run rsync → parse transfer list
  # 2. local stat for timestamps
  # 3. Compare, prompt (with ALL tracking per-claw)
  # 4. Build CONFLICT_EXCLUDES
}
```

Shared helper for timestamp comparison and prompt formatting:

```bash
# Format timestamp + size for display
format_file_info() {
  local epoch="$1" size="$2"
  local date_str=$(date -r "$epoch" "+%Y-%m-%d %H:%M")
  local size_str=$(numfmt --to=iec "$size" 2>/dev/null || echo "${size}B")
  echo "${date_str} (${size_str})"
}
```

## deploy.sh after changes

```
Step 1/3: Build deployment artifacts
Step 2/3: Sync configs to VPS
Step 3/3: Service restart
```

No workspace sync step. No workspace-related flags.

## File summary

| File | Action |
|------|--------|
| `scripts/deploy.sh` | Remove step 3 (workspace sync), simplify to 3 steps |
| `scripts/sync-workspaces.sh` | Replace `--ignore-existing` with conflict resolution, add `-y` flag, add `*.live-version.*` exclude |
| `deploy/setup/setup-infra.sh` | `host-status` → `.host-status` |
| `deploy/host/host-alert.sh` | `host-status` → `.host-status` (2 locations) |
| `deploy/host/host-maintenance-check.sh` | `host-status` → `.host-status` |
| `deploy/host/register-cron-jobs.sh` | `host-status` → `.host-status` in prompt text |
| `openclaw/default/openclaw.jsonc` | `.host-status` bind mount |
| `openclaw/default/openclaw.router.jsonc` | `.host-status` bind mount |

## VPS migration note

Renaming `host-status/` → `.host-status/` on live VPS requires:

```bash
# On VPS, for each claw instance:
sudo mv instances/<claw>/.openclaw/workspace/host-status instances/<claw>/.openclaw/workspace/.host-status
```

The next cron run will write to the new path. Old path can be left (harmless) or removed.

## Verification

1. `scripts/deploy.sh -n` — confirm no workspace sync step
2. `scripts/sync-workspaces.sh up` with local `.md` files — confirm per-file conflict prompts appear for newer-on-VPS files
3. `scripts/sync-workspaces.sh up --force -y` — confirm no prompts, all files upload
4. `scripts/sync-workspaces.sh down` — confirm per-file conflict prompts with skip/overwrite/ALL
5. `scripts/sync-workspaces.sh down --all` — confirm non-md files also sync
6. Grep codebase for non-dot `host-status` — confirm none remain
7. Verify `*.live-version.*` files are excluded from sync in both directions
