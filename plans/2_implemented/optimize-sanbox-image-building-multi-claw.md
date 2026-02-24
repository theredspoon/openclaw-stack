# Optimize Sandbox Image Building for Multi-Claw

## Context

Each claw runs its own Sysbox-isolated nested Docker daemon with a separate `/var/lib/docker` bind mount (`/home/openclaw/instances/<name>/docker/`). On first boot, every claw independently runs `rebuild-sandboxes.sh`, building identical sandbox images from the same `sandbox-toolkit.yaml`. With N claws, this means N identical ~15-25 min builds, wasting VPS CPU and bandwidth.

**Goal:** Build sandbox images once (in the first claw), then export and load them into other claws' nested Docker daemons — reducing subsequent claws from ~15-25 min build to ~30 sec load.

## Design Decisions

**Staggered startup during deploy.** Start only the first claw, wait for its sandbox builds to complete, export images, pre-place tars in other claws' Docker data dirs, then start remaining claws. Their entrypoints detect the pre-placed tar and load instead of building.

**`sync-images` also works post-start.** If claws are already running, `sync-images` uses `docker exec ... docker load` directly instead of relying on entrypoint loading. This covers both initial deploy and future ad-hoc syncing.

**Entrypoint gets a second archive check path.** Currently only checks `/app/deploy/sandbox-images.tar` (read-only mount). Add a check for `/var/lib/docker/sandbox-images.tar` (writable, per-claw). The `sync-images` command places tars at this path on the host, which maps to `/var/lib/docker/` inside the container.

---

## Implementation

### 1. Add archive check path to entrypoint (`deploy/entrypoint-gateway.sh`)

Currently (lines 149-163):

```bash
SANDBOX_ARCHIVE="/app/deploy/sandbox-images.tar"
if [ -f "$SANDBOX_ARCHIVE" ]; then
  ...
fi
```

Add a second check for `/var/lib/docker/sandbox-images.tar` (writable per-claw data dir). After loading, delete the tar to reclaim disk space (~2-4 GB):

```bash
# Check both locations: read-only deploy mount AND writable Docker data dir
for SANDBOX_ARCHIVE in "/app/deploy/sandbox-images.tar" "/var/lib/docker/sandbox-images.tar"; do
  if [ -f "$SANDBOX_ARCHIVE" ]; then
    if ! docker image inspect openclaw-sandbox-toolkit:bookworm-slim > /dev/null 2>&1; then
      echo "[entrypoint] Loading pre-built sandbox images from ${SANDBOX_ARCHIVE}..."
      docker load < "$SANDBOX_ARCHIVE"
      echo "[entrypoint] Sandbox images loaded"
    else
      echo "[entrypoint] Sandbox images already present, skipping archive load"
    fi
    # Clean up writable archive after loading (don't delete read-only deploy mount copy)
    if [ "$SANDBOX_ARCHIVE" = "/var/lib/docker/sandbox-images.tar" ]; then
      rm -f "$SANDBOX_ARCHIVE"
      echo "[entrypoint] Cleaned up sandbox archive from Docker data dir"
    fi
    break  # Only load from first found archive
  fi
done
```

### 2. Add `sync-images` subcommand to `deploy/scripts/openclaw-multi.sh`

New command: `openclaw-multi.sh sync-images [--source <name>] [--force]`

**Behavior:**

1. Identify source claw (default: first running claw, or `--source <name>`)
2. Verify source has sandbox images built
3. Export all 3 sandbox images from source's nested Docker to a tar in its data dir
4. For each target claw:
   - **If target is running** (has nested Docker): `docker exec ... docker load` directly, then cleanup
   - **If target is NOT running**: copy tar to target's Docker data dir for entrypoint to load on next start
5. Cleanup export tar from source

**Flags:**

- `--source <name>` — specify source claw (default: auto-detect first claw with images)
- `--force` — overwrite images even if target already has them

```bash
cmd_sync_images() {
  local source_name="" force=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --source) source_name="$2"; shift 2 ;;
      --force)  force=true; shift ;;
      *)        die "Unknown flag: $1" ;;
    esac
  done

  # Discover running claw containers
  local running_claws
  mapfile -t running_claws < <(sudo docker ps --format '{{.Names}}' \
    --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' | sort)

  # Discover all configured claws (may include stopped ones)
  local configured_claws
  mapfile -t configured_claws < <(discover_instances)

  # Find source claw
  local source_container=""
  if [ -n "$source_name" ]; then
    source_container="openclaw-${source_name}"
  else
    # Auto-detect: first running claw with sandbox images
    for claw in "${running_claws[@]}"; do
      if sudo docker exec "$claw" docker image inspect \
        openclaw-sandbox-toolkit:bookworm-slim > /dev/null 2>&1; then
        source_container="$claw"
        source_name="${claw#openclaw-}"
        break
      fi
    done
  fi

  [ -n "$source_container" ] || die "No source claw with sandbox images found"

  # Verify source has images
  local images=(
    "openclaw-sandbox:bookworm-slim"
    "openclaw-sandbox-toolkit:bookworm-slim"
    "openclaw-sandbox-browser:bookworm-slim"
  )
  for img in "${images[@]}"; do
    sudo docker exec "$source_container" docker image inspect "$img" > /dev/null 2>&1 \
      || die "Source $source_container missing image: $img"
  done

  echo "Source: $source_container" >&2

  # Export images from source's nested Docker
  local export_host_path="${OPENCLAW_HOME}/instances/${source_name}/docker/sandbox-export.tar"
  echo "Exporting sandbox images..." >&2
  sudo docker exec "$source_container" docker save \
    "${images[@]}" -o /var/lib/docker/sandbox-export.tar
  local tar_size
  tar_size=$(sudo du -h "$export_host_path" | cut -f1)
  echo "Exported (${tar_size})" >&2

  # Sync to each target claw
  local synced=0
  for name in "${configured_claws[@]}"; do
    [ "$name" = "$source_name" ] && continue
    local target_container="openclaw-${name}"
    local target_docker_dir="${OPENCLAW_HOME}/instances/${name}/docker"

    # Check if target already has images (skip unless --force)
    local target_running=false
    for rc in "${running_claws[@]}"; do
      [ "$rc" = "$target_container" ] && target_running=true && break
    done

    if [ "$target_running" = true ] && [ "$force" = false ]; then
      if sudo docker exec "$target_container" docker image inspect \
        openclaw-sandbox-toolkit:bookworm-slim > /dev/null 2>&1; then
        echo "  $target_container: images already present, skipping (use --force to overwrite)" >&2
        continue
      fi
    fi

    if [ "$target_running" = true ]; then
      # Load directly into running claw's nested Docker
      echo "  $target_container: loading (running)..." >&2
      sudo cp "$export_host_path" "${target_docker_dir}/sandbox-images.tar"
      sudo chown 1000:1000 "${target_docker_dir}/sandbox-images.tar"
      sudo docker exec "$target_container" docker load -i /var/lib/docker/sandbox-images.tar
      sudo rm -f "${target_docker_dir}/sandbox-images.tar"
    else
      # Pre-place tar for entrypoint to load on next start
      echo "  $target_container: pre-placing tar (not running)..." >&2
      sudo cp "$export_host_path" "${target_docker_dir}/sandbox-images.tar"
      sudo chown 1000:1000 "${target_docker_dir}/sandbox-images.tar"
    fi
    synced=$((synced + 1))
  done

  # Cleanup export
  sudo rm -f "$export_host_path"
  echo "Synced to ${synced} claw(s)." >&2
}
```

Also update: `usage()`, the `case` dispatch, and the help comment at top of file.

### 3. Update playbook `playbooks/04-vps1-openclaw.md` §4.4

Change the startup flow from "start all at once" to staggered when multiple claws exist:

```markdown
## 4.4 Build, Start, and Verify

...

# Start the first claw to build sandbox images
FIRST_CLAW_SERVICE=$(echo "$CLAWS" | head -1 | sed 's/^openclaw-//')  # e.g., "main-claw"

# Build image
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# Start first claw only
sudo -u openclaw bash -c "cd /home/openclaw/openclaw && docker compose up -d openclaw-${FIRST_CLAW_SERVICE}"

# Wait for sandbox builds (~15-25 min on first boot)
...

# If multiple claws: sync sandbox images before starting the rest
if [ $(echo "$INSTANCE_NAMES" | wc -w) -gt 1 ]; then
  echo "Syncing sandbox images to other claws..."
  bash /tmp/deploy-staging/scripts/openclaw-multi.sh sync-images --source "${FIRST_CLAW_SERVICE}"

  # Start remaining claws (entrypoints will load pre-placed tar instead of building)
  sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'
fi
```

> **Single-claw:** When only `main-claw` exists, the sync step is skipped and behavior is unchanged.

---

## Files to Modify

| File | Changes |
|------|---------|
| `deploy/entrypoint-gateway.sh` | Add `/var/lib/docker/sandbox-images.tar` as second archive check path; cleanup after load |
| `deploy/scripts/openclaw-multi.sh` | New `sync-images` subcommand (~80 lines); update usage/dispatch |
| `playbooks/04-vps1-openclaw.md` | Stagger claw startup in §4.4 for multi-claw deploys |

---

## Verification

1. **Single-claw deploy**: No behavioral change. First claw builds normally, no sync step runs.
2. **Multi-claw deploy**: First claw builds (~15-25 min). `sync-images` exports tar (~30 sec). Other claws start and load tar via entrypoint (~30 sec). Total savings: ~15-25 min per additional claw.
3. **Post-start sync**: With all claws running, `openclaw-multi.sh sync-images` exports from source and `docker load`s into targets directly.
4. **Idempotency**: Running `sync-images` when target already has images → skips (unless `--force`).
5. **Entrypoint cleanup**: After loading from `/var/lib/docker/sandbox-images.tar`, the tar is deleted to reclaim ~2-4 GB disk space.
