# Refactor Playbook 04 for Multi-Claw

## Context

Playbook 04 (`playbooks/04-vps1-openclaw.md`) has stale single-instance references and ~100 lines of inline bash that should be in scripts. The deploy scripts (`setup-infra.sh`, `deploy-config.sh`, `openclaw-multi.sh`) already handle multi-claw correctly, but the playbook still documents old paths and has complex inline verification logic.

**Goal:** Extract inline bash into reusable scripts, fix all stale path/container references, and make the playbook a thin orchestration layer.

---

## Stale References to Fix

| Line(s) | Current | Fix |
|---------|---------|-----|
| 216 | `deploy/openclaw.json` → `/home/openclaw/.openclaw/openclaw.json` | → `/home/openclaw/instances/<name>/.openclaw/openclaw.json` (per-claw) |
| 217 | `deploy/models.json` → `/home/openclaw/.openclaw/agents/*/agent/models.json` | → `/home/openclaw/instances/<name>/.openclaw/agents/...` (per-claw) |
| 664 | `curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/` | → Loop over claws with dynamic ports from `docker ps` |
| 710 | `sudo chown -R 1000:1000 /home/openclaw/.openclaw` | → Loop: `for inst in /home/openclaw/instances/*/; do sudo chown -R 1000:1000 "$inst/.openclaw"; done` |
| 780, 805 | Hardcoded `localhost:18789` in Update/Rollback sections | → Note: "use assigned port for the claw being tested (first claw defaults to 18789)" |

---

## New Scripts

### 1. `deploy/scripts/start-claws.sh`

Replaces the inline §4.4 startup block. Handles build + container startup, returns quickly (does NOT wait for sandbox builds).

**What it does:**

1. Build `openclaw:local` image via `build-openclaw.sh`
2. If multi-claw: start only the first claw
3. If single-claw: start all services
4. Optionally start Vector if `ENABLE_VECTOR_LOG_SHIPPING=true`
5. Output the first claw's container name to stdout (for the playbook to poll)

**Interface:**

- Env vars: `ENABLE_VECTOR_LOG_SHIPPING` (optional)
- Stdout: `FIRST_CLAW=openclaw-<name>` then `START_CLAWS_OK`
- Stderr: progress messages
- Expects: staging dir at `/tmp/deploy-staging/`, scripts already deployed

**Why separate from openclaw-multi.sh:** This script handles a deploy-time concern (building the Docker image, staggered first start). `openclaw-multi.sh start` is for steady-state operations (generate + up -d all). They have different lifecycles.

```bash
#!/bin/bash
set -euo pipefail

# start-claws.sh — Build image and start claw containers (playbook 04, §4.4)
#
# Multi-claw: starts only the first claw for sandbox builds.
# Single-claw: starts all services.
# Does NOT wait for sandbox builds — caller handles the wait.
#
# Interface:
#   Env vars in: ENABLE_VECTOR_LOG_SHIPPING (optional)
#   Stdout: FIRST_CLAW=<container-name>, then START_CLAWS_OK
#   Stderr: progress
#   Exit: 0 success, 1 failure

OPENCLAW_HOME="/home/openclaw"

# Discover configured instances
STAGING_DIR="/tmp/deploy-staging"
if [ -d "${STAGING_DIR}/openclaws" ]; then
  INSTANCE_NAMES=$(ls -d "${STAGING_DIR}"/openclaws/*/ 2>/dev/null \
    | xargs -I{} basename {} | grep -v '^_' | tr '\n' ' ')
fi
INSTANCE_NAMES="${INSTANCE_NAMES:-main-claw}"
CLAW_COUNT=$(echo "$INSTANCE_NAMES" | wc -w)
FIRST_CLAW=$(echo "$INSTANCE_NAMES" | awk '{print $1}')

echo "Instances: ${INSTANCE_NAMES}(${CLAW_COUNT} claw(s))" >&2

# Build image
echo "Building openclaw:local image..." >&2
sudo -u openclaw "${OPENCLAW_HOME}/scripts/build-openclaw.sh" >&2

# Start containers
if [ "$CLAW_COUNT" -gt 1 ]; then
  echo "Multi-claw: starting openclaw-${FIRST_CLAW} first for sandbox builds..." >&2
  sudo -u openclaw bash -c \
    "cd ${OPENCLAW_HOME}/openclaw && docker compose up -d openclaw-${FIRST_CLAW}"
else
  echo "Single-claw: starting all services..." >&2
  sudo -u openclaw bash -c \
    "cd ${OPENCLAW_HOME}/openclaw && docker compose up -d"
fi

# Start Vector if enabled
if [ "${ENABLE_VECTOR_LOG_SHIPPING:-false}" = "true" ]; then
  echo "Starting Vector..." >&2
  sudo -u openclaw bash -c "cd ${OPENCLAW_HOME}/vector && docker compose up -d" >&2
fi

# Output for caller
echo "FIRST_CLAW=openclaw-${FIRST_CLAW}"
echo "CLAW_COUNT=${CLAW_COUNT}"
echo "START_CLAWS_OK"
```

### 2. `deploy/scripts/verify-deployment.sh`

Replaces the ~70-line inline sandbox verification + the Verification section endpoint checks.

**What it does:**

1. Discover all running claw containers
2. For each claw:
   a. Check all 3 sandbox images exist
   b. Verify USER=1000 on toolkit image
   c. Test key binaries (go, rustc, bun, node, git, curl, claude, etc.)
   d. Check image age / staleness
   e. Fix `.openclaw` ownership (container-side)
   f. Test health endpoint using actual mapped port
3. Check Vector status (if running)
4. Output structured results, exit 1 if any failures

**Interface:**

- Env vars: `OPENCLAW_DOMAIN_PATH` (optional, for health check URL)
- Stdout: `VERIFY_DEPLOYMENT_OK` or `VERIFY_DEPLOYMENT_FAILED`
- Stderr: detailed per-claw results
- Exit: 0 all pass, 1 any failure

```bash
#!/bin/bash
set -euo pipefail

# verify-deployment.sh — Verify OpenClaw deployment (playbook 04, verification)
#
# Checks all running claws: sandbox images, binaries, permissions, health.
# Discovers containers and ports dynamically — no hardcoded names or ports.
#
# Interface:
#   Env vars in: OPENCLAW_DOMAIN_PATH (optional)
#   Stdout: VERIFY_DEPLOYMENT_OK or VERIFY_DEPLOYMENT_FAILED
#   Stderr: detailed results
#   Exit: 0 all pass, 1 any failure

DOMAIN_PATH="${OPENCLAW_DOMAIN_PATH:-}"
FAILED=0

# Discover running claws
CLAWS=$(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' \
  | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-' | sort)

[ -n "$CLAWS" ] || { echo "ERROR: No running claw containers found" >&2; exit 1; }
echo "Verifying claws: $CLAWS" >&2

for CLAW in $CLAWS; do
  echo "" >&2
  echo "=== $CLAW ===" >&2

  # 1. Check sandbox images exist
  for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-toolkit:bookworm-slim \
             openclaw-sandbox-browser:bookworm-slim; do
    if sudo docker exec "$CLAW" docker image inspect "$img" > /dev/null 2>&1; then
      echo "  $img: OK" >&2
    else
      echo "  $img: MISSING" >&2
      FAILED=1
    fi
  done

  # 2. Verify USER=1000 on toolkit
  USER_VAL=$(sudo docker exec "$CLAW" docker image inspect \
    openclaw-sandbox-toolkit:bookworm-slim 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null || echo "?")
  if [ "$USER_VAL" = "1000" ]; then
    echo "  toolkit USER: 1000 (OK)" >&2
  else
    echo "  toolkit USER: $USER_VAL (EXPECTED 1000)" >&2
    FAILED=1
  fi

  # 3. Test key binaries
  for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert claude gifgrep; do
    if sudo docker exec "$CLAW" docker run --rm openclaw-sandbox-toolkit:bookworm-slim \
      which "$bin" > /dev/null 2>&1; then
      echo "  toolkit/$bin: OK" >&2
    else
      echo "  toolkit/$bin: MISSING" >&2
      FAILED=1
    fi
  done

  # 4. Image age
  for img in openclaw-sandbox-toolkit:bookworm-slim openclaw-sandbox-browser:bookworm-slim; do
    BUILD_DATE=$(sudo docker exec "$CLAW" docker image inspect "$img" \
      --format '{{index .Config.Labels "openclaw.build-date"}}' 2>/dev/null)
    if [ -n "$BUILD_DATE" ] && [ "$BUILD_DATE" != "<no value>" ]; then
      AGE_DAYS=$(( ( $(date +%s) - $(date -d "$BUILD_DATE" +%s 2>/dev/null || echo 0) ) / 86400 ))
      if [ "$AGE_DAYS" -gt 30 ]; then
        echo "  $img: ${AGE_DAYS} days old — consider rebuilding" >&2
      else
        echo "  $img: ${AGE_DAYS} days old (OK)" >&2
      fi
    fi
  done

  # 5. Fix .openclaw ownership (container-side)
  sudo docker exec "$CLAW" chown -R 1000:1000 /home/node/.openclaw 2>/dev/null
  echo "  .openclaw ownership: fixed" >&2

  # 6. Health endpoint (discover mapped port from docker inspect)
  GW_PORT=$(sudo docker port "$CLAW" 2>/dev/null | grep -oP '0\.0\.0\.0:\K\d+' | head -1 || true)
  if [ -n "$GW_PORT" ]; then
    if curl -sf "http://localhost:${GW_PORT}${DOMAIN_PATH}/" > /dev/null 2>&1; then
      echo "  health (port ${GW_PORT}): OK" >&2
    else
      echo "  health (port ${GW_PORT}): UNREACHABLE" >&2
      # Not fatal — may still be starting
    fi
  fi
done

# 7. Check Vector
if sudo docker ps --format '{{.Names}}' | grep -q '^vector$'; then
  echo "" >&2
  echo "=== Vector ===" >&2
  echo "  status: running" >&2
fi

# 8. Intermediate images check
FIRST_CLAW=$(echo "$CLAWS" | head -1)
if sudo docker exec "$FIRST_CLAW" docker images 2>/dev/null | grep -q base-root; then
  echo "" >&2
  echo "WARNING: intermediate base-root image not cleaned up" >&2
fi

echo "" >&2
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed." >&2
  echo "VERIFY_DEPLOYMENT_OK"
else
  echo "Some checks FAILED — see above." >&2
  echo "VERIFY_DEPLOYMENT_FAILED"
  exit 1
fi
```

---

## Playbook §4.4 Rewrite

The new §4.4 becomes a thin orchestration layer calling scripts:

```markdown
## 4.4 Build, Start, and Verify

### Step 1: Start claws

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env ENABLE_VECTOR_LOG_SHIPPING='${ENABLE_VECTOR_LOG_SHIPPING}' \
  bash /tmp/deploy-staging/scripts/start-claws.sh"
```

Captures `FIRST_CLAW=openclaw-<name>` and `CLAW_COUNT=N` from stdout.

### Step 2: Wait for sandbox builds (~15-25 min first boot)

[Interactive polling pattern — stays in playbook, uses FIRST_CLAW from Step 1]

1. Background wait for "Executing as node" log line
2. Poll progress every 30s
3. Check background task completion

### Step 3: Sync images + start remaining claws (multi-claw only)

If CLAW_COUNT > 1:

```bash
ssh ... "bash /tmp/deploy-staging/scripts/openclaw-multi.sh sync-images --source <first>"
ssh ... "sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'"
```

### Step 4: Verify deployment

```bash
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} \
  "env OPENCLAW_DOMAIN_PATH='${OPENCLAW_DOMAIN_PATH}' \
  bash /tmp/deploy-staging/scripts/verify-deployment.sh"
```

Expects VERIFY_DEPLOYMENT_OK on stdout.

```

---

## Other §4 Fixes

### §4.3 File manifest (lines 216-217)

Update per-claw config destinations:

| Current | Fixed |
|---------|-------|
| `/home/openclaw/.openclaw/openclaw.json` | `/home/openclaw/instances/<name>/.openclaw/openclaw.json` |
| `/home/openclaw/.openclaw/agents/*/agent/models.json` | `/home/openclaw/instances/<name>/.openclaw/agents/*/agent/models.json` |

Add note: "Deployed per-claw by `deploy-config.sh`"

### Verification section (line 650+)

Replace inline bash with call to `verify-deployment.sh`. Keep Vector check inline (it's two lines).

### Troubleshooting: Permission Denied (line 708-716)

Fix host-side path:
```bash
# Fix ownership on host (per-claw instances)
for inst_dir in /home/openclaw/instances/*/; do
  sudo chown -R 1000:1000 "${inst_dir}.openclaw"
done

# Or fix inside each container
for CLAW in $(sudo docker ps --format '{{.Names}}' --filter 'name=^openclaw-' | grep -v '^openclaw-cli$' | grep -v '^openclaw-sbx-'); do
  sudo docker exec "$CLAW" chown -R 1000:1000 /home/node/.openclaw
done
```

### Update/Rollback sections (lines 755-805)

Replace hardcoded `localhost:18789` with note about dynamic ports:

```bash
# Verify — use the assigned port for the claw being tested
# First claw defaults to 18789; check actual ports: docker compose ps
```

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `deploy/scripts/start-claws.sh` | **Create** — build + staggered start |
| `deploy/scripts/verify-deployment.sh` | **Create** — sandbox + health verification |
| `playbooks/04-vps1-openclaw.md` | **Modify** — rewrite §4.4, fix stale refs throughout |

---

## Verification

1. **Single-claw deploy:** `start-claws.sh` builds and starts all. `verify-deployment.sh` checks the one claw.
2. **Multi-claw deploy:** `start-claws.sh` starts first claw only. After wait, sync-images + start rest. `verify-deployment.sh` checks all claws with dynamic ports.
3. **Stale references:** No remaining `/home/openclaw/.openclaw` paths (should be per-instance). No hardcoded `18789` without context note.
4. **Script reuse:** Both scripts work from the VPS — no dependency on playbook state. Can be run manually for maintenance.
