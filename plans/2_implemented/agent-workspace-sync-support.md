# Plan: Agent workspace sync script

## Context

OpenClaw seeds sandbox workspaces from agent workspace directories on the VPS (e.g. `instances/<claw>/workspace/` for main, `instances/<claw>/workspace-<agent-id>/` for others). These contain AGENTS.md, SOUL.md, skills/, etc. Currently there's no way to manage these files from the local repo — you have to SSH in or use Claude chat. This script adds bidirectional sync between local `openclaw/<claw>/workspace/<agent-id>/` dirs and VPS workspace dirs.

## Design

### Directory mapping

| Local | VPS |
|-------|-----|
| `openclaw/<claw>/workspace/main/` | `instances/<claw>/workspace/` |
| `openclaw/<claw>/workspace/<agent-id>/` | `instances/<claw>/workspace-<agent-id>/` |

The `main` agent is explicitly nested as `workspace/main/` locally, mapped to the bare `workspace/` on VPS (OpenClaw convention).

### Subcommands

```
sync-workspaces.sh up [--instance <claw>] [--force]     # Local → VPS
sync-workspaces.sh down [--instance <claw>] [--all]     # VPS → Local
```

**`up`** (local → VPS):

- Syncs ALL files from local workspace dirs to VPS
- Without `--force`: uses `--ignore-existing` (only new files transferred, existing files untouched)
- With `--force`: overwrites everything on VPS with local versions
- Excludes `.*` files/dirs on both sides

**`down`** (VPS → local):

- Default: syncs only `*.md` files (recursively) — the primary authored content
- With `--all`: syncs all files
- Always uses `--ignore-existing` (never overwrites local files)
- With `--force`: overwrites local files with VPS versions
- Excludes `.*` files/dirs always

### Metadata / logging

After each sync, append to `openclaw/<claw>/workspace/.sync-log`:

```
# ── Workspace sync: up (force) ───────────────────────────
# Date: 2026-03-03T01:50:00Z
# Instance: personal-claw
# Agents: main, code
<full rsync --itemize-changes output per agent>
```

Each run appended with a header block. Gitignored via existing `openclaw/*` pattern.

### Rsync flags

Common: `-avz --itemize-changes --exclude='.*'`

| Mode | Additional flags |
|------|-----------------|
| `up` (default) | `--ignore-existing` |
| `up --force` | (none — overwrites) |
| `down` (default) | `--ignore-existing --include='*/' --include='*.md' --exclude='*'` |
| `down --all` | `--ignore-existing` |
| `down --force` | md-only filter, no `--ignore-existing` |
| `down --force --all` | no filters, no `--ignore-existing` |

### Agent discovery

- **`up`**: iterate subdirs of `openclaw/<claw>/workspace/`
- **`down`**: SSH to list `instances/<claw>/workspace*` dirs, extract agent IDs (strip `workspace-` prefix, bare `workspace` → `main`)

### Integration with deploy flow

After config sync in `sync-deploy.sh`, print a reminder when instance configs were synced:

```
Tip: sync agent workspaces with: scripts/sync-workspaces.sh down
```

## Files

| File | Action |
|------|--------|
| `scripts/sync-workspaces.sh` | **New** — bidirectional workspace sync |
| `scripts/sync-deploy.sh` | **Modify** — add reminder line after instance config sync |

## Implementation notes

- Reuse `scripts/lib/source-config.sh` for SSH/VPS config (same as all sync scripts)
- Permissions: workspace dirs on VPS owned by `1000:1000` (container node user). Use `--rsync-path='sudo rsync'` and `chown -R 1000:1000` after upload
- For `down`, create local dirs with `mkdir -p`
- Iterate all claws from `$STACK__CLAWS__IDS` unless `--instance` narrows it

## Verification

1. Create test workspace: `mkdir -p openclaw/personal-claw/workspace/main && echo "# Test" > openclaw/personal-claw/workspace/main/AGENTS.md`
2. `sync-workspaces.sh up --instance personal-claw --force` — uploads to VPS `workspace/`
3. `sync-workspaces.sh down --instance personal-claw` — pulls *.md files, skips existing AGENTS.md
4. `sync-workspaces.sh down --instance personal-claw --all` — pulls all files, skips existing
5. Check `.sync-log` — should contain full rsync output
6. Modify file on VPS, run `down --force` — should overwrite local
