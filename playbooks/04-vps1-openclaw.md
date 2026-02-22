# 04 - VPS-1 OpenClaw Setup

Install and configure OpenClaw gateway on VPS-1.

## Overview

This playbook configures:

- Sysbox runtime for secure container-in-container
- Docker networks for OpenClaw
- Directory structure and permissions
- OpenClaw repository and configuration
- Docker Compose with security hardening
- Vector for log shipping to Cloudflare
- Host alerter for Telegram notifications
- Maintenance checker for OS update monitoring

## Prerequisites

- [02-base-setup.md](02-base-setup.md) completed on VPS-1
- [03-docker.md](03-docker.md) completed on VPS-1
- SSH access as `adminclaw` on port `<SSH_PORT>`

## Variables

From `../openclaw-config.env`:

- `VPS1_IP` - Required, public IP of VPS-1
- `AI_GATEWAY_WORKER_URL` - Required, AI Gateway Worker URL
- `AI_GATEWAY_AUTH_TOKEN` - Required, AI Gateway auth token
- `LOG_WORKER_URL` - Optional, Log Receiver Worker URL (for Vector log shipping)
- `LOG_WORKER_TOKEN` - Optional, Log Receiver auth token (for Vector log shipping)
- `YOUR_TELEGRAM_ID` - Required, numeric Telegram user ID (for `tools.elevated` access gating)
- `OPENCLAW_TELEGRAM_BOT_TOKEN` - Required, Telegram bot token for OpenClaw channel (see `docs/TELEGRAM.md`)
- `HOSTALERT_TELEGRAM_BOT_TOKEN` - Optional (for host alerter; can reuse `OPENCLAW_TELEGRAM_BOT_TOKEN`)
- `HOSTALERT_TELEGRAM_CHAT_ID` - Optional (for host alerter)
- `HOSTALERT_DAILY_REPORT_TIME` - Optional, daily health report time (default: `9:00 AM UTC`)
- `OPENCLAW_DOMAIN_PATH` - URL subpath for the gateway UI (default: `/_openclaw`)
- `OPENCLAW_DASHBOARD_DOMAIN_PATH` - Base path for the dashboard server (e.g., `/dashboard`), empty if using a separate subdomain

---

## 4.1 Install Sysbox Runtime

Sysbox enables running Docker-in-Docker securely for OpenClaw sandboxes.

### Version check (fresh deployments only)

Before installing, fetch the latest release from GitHub:

```
https://github.com/nestybox/sysbox/releases
```

Compare the latest release tag against `SYSBOX_VERSION` below.

- **If a newer version exists:** Note the newer version in the output but proceed with the pinned version. Do not pause to ask — the pinned version has a verified checksum. The user can update later.
- **If the pinned version is already the latest:** Proceed directly.

<!-- Pinned version — update both values together -->
`SYSBOX_VERSION=0.6.7`
`SYSBOX_SHA256=b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e`

### Install

```bash
#!/bin/bash
SYSBOX_VERSION="0.6.7"
SYSBOX_SHA256="b7ac389e5a19592cadf16e0ca30e40919516128f6e1b7f99e1cb4ff64554172e"
SYSBOX_DEB="sysbox-ce_${SYSBOX_VERSION}-0.linux_amd64.deb"

# Download
wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"

# Verify download integrity
echo "${SYSBOX_SHA256}  ${SYSBOX_DEB}" | sha256sum -c -

# Install dependencies
sudo apt install -y jq fuse

# Install Sysbox
sudo dpkg -i "${SYSBOX_DEB}"

# Verify installation
sudo systemctl status sysbox

# Verify runtime is available
sudo docker info | grep -i "sysbox"

# Cleanup
rm "${SYSBOX_DEB}"
```

**If sha256sum fails:**

> "The Sysbox download didn't match the expected checksum. This could mean a
> corrupted download or a version mismatch. Delete the file and re-download:"
>
> `rm ${SYSBOX_DEB} && wget "https://downloads.nestybox.com/sysbox/releases/v${SYSBOX_VERSION}/${SYSBOX_DEB}"`

**If `dpkg -i` fails with dependency errors:**

> "Sysbox has unmet dependencies. Fix with:"
>
> `sudo apt --fix-broken install -y`

---

## 4.2 Infrastructure Setup

> **Single SSH session.** Creates networks, directories, clones the repo, and generates the `.env` file. Returns the generated `GATEWAY_TOKEN` which must be saved locally before proceeding.

```bash
#!/bin/bash
set -euo pipefail

# ============================================================
# Part 1: Create Docker Networks
# ============================================================
# IMPORTANT: Use 172.30.x.x subnets to avoid conflicts with Docker's default bridge (172.20.0.0/16)

# Gateway network (for OpenClaw)
docker network create \
    --driver bridge \
    --subnet 172.30.0.0/24 \
    openclaw-gateway-net

# Sandbox network (internal only, for sandboxes)
docker network create \
    --driver bridge \
    --internal \
    --subnet 172.31.0.0/24 \
    openclaw-sandbox-net

# ============================================================
# Part 2: Create Directory Structure
# ============================================================
sudo -u openclaw bash << 'DIREOF'
OPENCLAW_HOME="/home/openclaw"

# NOTE: Do NOT create ${OPENCLAW_HOME}/openclaw here — git clone creates it in Part 3
mkdir -p "${OPENCLAW_HOME}/.openclaw/workspace"
mkdir -p "${OPENCLAW_HOME}/.openclaw/credentials"
mkdir -p "${OPENCLAW_HOME}/.openclaw/logs"
mkdir -p "${OPENCLAW_HOME}/.openclaw/backups"
mkdir -p "${OPENCLAW_HOME}/scripts"

# Persistent sandbox home directories — agents opt in via openclaw.json binds
mkdir -p "${OPENCLAW_HOME}/sandboxes-home"

chmod 700 "${OPENCLAW_HOME}/.openclaw"
chmod 700 "${OPENCLAW_HOME}/.openclaw/credentials"
DIREOF

# ⚠️  IMPORTANT: Do NOT change 1000:1000 to openclaw:openclaw!
# The container runs as uid 1000 (node user inside Docker), which is typically
# 'ubuntu' on the host — NOT the openclaw user (uid 1002). Using the openclaw
# UID breaks container write access to these directories.
sudo chown -R 1000:1000 /home/openclaw/.openclaw
sudo chown -R 1000:1000 /home/openclaw/sandboxes-home

# Host status directory — written by root cron scripts, read by agents via workspace
# Lives under workspace/ so agents can read via relative path (host-status/health.json)
# Root-owned with 755/644 permissions so both root can write and container can read
sudo mkdir -p /home/openclaw/.openclaw/workspace/host-status
sudo chmod 755 /home/openclaw/.openclaw/workspace/host-status

# ============================================================
# Part 3: Clone OpenClaw Repository
# ============================================================
sudo -u openclaw bash << 'CLONEEOF'
cd /home/openclaw
git clone https://github.com/openclaw/openclaw.git openclaw

# Create data directory for bind mounts (not tracked by git)
mkdir -p /home/openclaw/openclaw/data/docker
CLONEEOF

# ============================================================
# Part 4: Create Environment File
# ============================================================
GATEWAY_TOKEN=$(openssl rand -hex 32)

# Dashboard base path — direct from config, no parsing needed
DASHBOARD_BASE_PATH="${OPENCLAW_DASHBOARD_DOMAIN_PATH:-}"

sudo -u openclaw tee /home/openclaw/openclaw/.env << EOF
# Gateway authentication
OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}

# AI Gateway — all provider API keys and base URLs are mapped in compose override
AI_GATEWAY_WORKER_URL=${AI_GATEWAY_WORKER_URL}
AI_GATEWAY_AUTH_TOKEN=${AI_GATEWAY_AUTH_TOKEN}

# Telegram channel — OpenClaw bot for chatting via Telegram
OPENCLAW_TELEGRAM_BOT_TOKEN=${OPENCLAW_TELEGRAM_BOT_TOKEN:-}

# Host alerter (Telegram notifications — see docs/TELEGRAM.md)
HOSTALERT_TELEGRAM_BOT_TOKEN=${HOSTALERT_TELEGRAM_BOT_TOKEN:-}
HOSTALERT_TELEGRAM_CHAT_ID=${HOSTALERT_TELEGRAM_CHAT_ID:-}

# Dashboard base path — from OPENCLAW_DASHBOARD_DOMAIN_PATH
# Empty = dashboard serves at root (e.g., dashboard on a separate subdomain)
DASHBOARD_BASE_PATH=${DASHBOARD_BASE_PATH}

# Gateway Control UI subpath — must match gateway.controlUi.basePath in openclaw.json.
# Used by Docker healthcheck and playbook verification commands.
# Empty = Control UI served at root (no subpath).
OPENCLAW_DOMAIN_PATH=${OPENCLAW_DOMAIN_PATH:-}

# Docker compose variables (required by repo's docker-compose.yml)
OPENCLAW_CONFIG_DIR=/home/openclaw/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/openclaw/.openclaw/workspace
# Port numbers only — DO NOT use IP:port format (e.g. 127.0.0.1:18789)
# OpenClaw CLI reads this env var and misparses IP:port as port number
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
# Gateway bind mode: "lan" is required for Docker deployments.
# loopback doesn't work because Docker port-forwards traffic through the bridge
# network (172.30.0.1), not loopback. The openclaw doctor warning about lan binding
# is expected — actual network security is enforced by daemon.json localhost binding.
OPENCLAW_GATEWAY_BIND=lan
EOF

sudo chmod 600 /home/openclaw/openclaw/.env
sudo chown openclaw:openclaw /home/openclaw/openclaw/.env

echo ""
echo "========================================="
echo "Generated Credentials (save these):"
echo "  Gateway Token: ${GATEWAY_TOKEN}"
if [ -n "${DASHBOARD_BASE_PATH}" ]; then
  echo "  Dashboard Base Path: ${DASHBOARD_BASE_PATH}"
fi
echo "========================================="
```

**If git clone fails with "fatal: unable to access":**

> "Can't reach GitHub from the VPS. Check network connectivity:"
>
> `curl -sI https://github.com` — if this times out, the VPS may have
> DNS or outbound connectivity issues.

**If git clone fails with "already exists and is not an empty directory":**

> "The openclaw directory already exists. This VPS may have a previous
> installation. Use `00-analysis-mode.md` to analyze it first, or
> remove it to start fresh:"
>
> `sudo rm -rf /home/openclaw/openclaw`

**Record gateway token locally:** Immediately after the script above runs, use the `Edit` tool to update the `GATEWAY_TOKEN` and `GATEWAY_URL` values in the `# DEPLOYED:` section of `openclaw-config.env`. Replace the existing `# DEPLOYED: GATEWAY_TOKEN=` and `# DEPLOYED: GATEWAY_URL=` lines with the generated token and composed URL (`https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/chat?token=<TOKEN>`). Do NOT use `sed` — it creates backup files on macOS.

> These are comments — `source openclaw-config.env` won't export them. They're a safety net in case the session ends before the deployment report (§ 8.6).

---

## 4.3 Deploy Configuration

> **Two-step batch:** SCP the entire `deploy/` directory to the VPS, then run a single SSH session that copies all files into place, substitutes template variables, and sets permissions.

### File manifest

| Source | Destination | Type | Notes |
|--------|------------|------|-------|
| `deploy/docker-compose.override.yml` | `/home/openclaw/openclaw/docker-compose.override.yml` | static | Security hardening + monitoring |
| `deploy/vector/docker-compose.yml` | `/home/openclaw/vector/docker-compose.yml` | static | Skip if `ENABLE_VECTOR_LOG_SHIPPING=false` |
| `deploy/vector/vector.yaml` | `/home/openclaw/vector/vector.yaml` | static | Skip if `ENABLE_VECTOR_LOG_SHIPPING=false` |
| `deploy/openclaw.json` | `/home/openclaw/.openclaw/openclaw.json` | template | See template variables below |
| `deploy/models.json` | `/home/openclaw/.openclaw/agents/*/agent/models.json` | template | Deployed per-agent (main, code, skills) |
| `deploy/build-openclaw.sh` | `/home/openclaw/scripts/build-openclaw.sh` | static | |
| `deploy/entrypoint-gateway.sh` | `/home/openclaw/openclaw/scripts/entrypoint-gateway.sh` | static | |
| `deploy/host-alert.sh` | `/home/openclaw/scripts/host-alert.sh` | static | |
| `deploy/host-maintenance-check.sh` | `/home/openclaw/scripts/host-maintenance-check.sh` | static | |
| `deploy/logrotate-openclaw` | `/etc/logrotate.d/openclaw` | static | |
| `deploy/plugins/*` | `/home/openclaw/openclaw/deploy/plugins/` | static | Owned by uid 1000 |

### Template variables

These are substituted server-side via `sed` after copying from staging:

| Variable | Source | Used in |
|----------|--------|---------|
| `GATEWAY_TOKEN` | Read from `.env` on VPS | `openclaw.json` |
| `OPENCLAW_DOMAIN_PATH` | `openclaw-config.env` | `openclaw.json` |
| `YOUR_TELEGRAM_ID` | `openclaw-config.env` | `openclaw.json` |
| `OPENCLAW_INSTANCE_ID` | `openclaw-config.env` | `openclaw.json` |
| `VPS_HOSTNAME` | `openclaw-config.env` | `openclaw.json` |
| `ENABLE_EVENTS_LOGGING` | `openclaw-config.env` | `openclaw.json` |
| `ENABLE_LLEMTRY_LOGGING` | `openclaw-config.env` | `openclaw.json` |
| `EVENTS_URL` | Derived: `LOG_WORKER_URL` with `/logs` → `/events` | `openclaw.json` |
| `LLEMTRY_URL` | Derived: `LOG_WORKER_URL` with `/logs` → `/llemtry` | `openclaw.json` |
| `LOG_WORKER_TOKEN` | `openclaw-config.env` | `openclaw.json` |
| `AI_GATEWAY_WORKER_URL` | `openclaw-config.env` | `models.json` |

### Step 1: SCP deploy directory to VPS

**Run from LOCAL machine:**

```bash
# Create staging directory on VPS
ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} ${SSH_USER}@${VPS1_IP} "mkdir -p /tmp/deploy-staging"

# Bulk-copy entire deploy/ directory
scp -P ${SSH_PORT} -i ${SSH_KEY_PATH} -r deploy/* ${SSH_USER}@${VPS1_IP}:/tmp/deploy-staging/
```

### Step 2: Deploy all files in a single SSH session

The script below receives config values as shell variables at the top, then copies static files and substitutes template variables using `sed`.

> **Important:** `OPENCLAW_DOMAIN_PATH` may be empty (serves UI at root). The `sed` command handles empty values correctly. ALL `{{VAR}}` placeholders must be substituted — never leave literal `{{...}}` in output.

```bash
#!/bin/bash
set -euo pipefail

# ---- Config values (passed from openclaw-config.env) ----
OPENCLAW_DOMAIN_PATH="${OPENCLAW_DOMAIN_PATH:-}"
YOUR_TELEGRAM_ID="${YOUR_TELEGRAM_ID}"
OPENCLAW_INSTANCE_ID="${OPENCLAW_INSTANCE_ID:-}"
VPS_HOSTNAME="${VPS_HOSTNAME:-}"
ENABLE_EVENTS_LOGGING="${ENABLE_EVENTS_LOGGING:-false}"
ENABLE_LLEMTRY_LOGGING="${ENABLE_LLEMTRY_LOGGING:-false}"
LOG_WORKER_TOKEN="${LOG_WORKER_TOKEN:-}"
LOG_WORKER_URL="${LOG_WORKER_URL:-}"
AI_GATEWAY_WORKER_URL="${AI_GATEWAY_WORKER_URL}"
ENABLE_VECTOR_LOG_SHIPPING="${ENABLE_VECTOR_LOG_SHIPPING:-false}"

# Derived URLs
LLEMTRY_URL="${LOG_WORKER_URL/\/logs/\/llemtry}"
EVENTS_URL="${LOG_WORKER_URL/\/logs/\/events}"

# Read the gateway token generated in section 4.2
GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)

STAGING="/tmp/deploy-staging"

# ============================================================
# 1. Docker Compose override (static)
# ============================================================
# Building happens separately via the build script (section 4.4), not via docker compose build.
sudo -u openclaw cp "${STAGING}/docker-compose.override.yml" /home/openclaw/openclaw/docker-compose.override.yml

# ============================================================
# 2. Vector log shipper (static, conditional)
# ============================================================
if [ "${ENABLE_VECTOR_LOG_SHIPPING}" = "true" ]; then
  sudo -u openclaw mkdir -p /home/openclaw/vector/data

  sudo -u openclaw cp "${STAGING}/vector/docker-compose.yml" /home/openclaw/vector/docker-compose.yml
  sudo -u openclaw cp "${STAGING}/vector/vector.yaml" /home/openclaw/vector/vector.yaml

  # Create Vector .env with log shipping credentials
  sudo -u openclaw tee /home/openclaw/vector/.env << VECTOREOF
# Vector log shipping — Cloudflare Log Receiver Worker
LOG_WORKER_URL=${LOG_WORKER_URL}
LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
VPS1_IP=${VPS1_IP}
VECTOREOF

  sudo chmod 600 /home/openclaw/vector/.env
fi

# ============================================================
# 3. OpenClaw configuration (template)
# ============================================================
# IMPORTANT: OpenClaw rejects unknown config keys — only use documented keys.
# bind: "lan" required (Docker bridge traffic, not loopback). openclaw doctor warning is expected.
# trustedProxies: exact IPs only, CIDR ranges NOT supported.
# Device pairing: tunnel users need CLI approval — see 08-post-deploy.md.
# gateway.auth.token + gateway.remote.token: must match OPENCLAW_GATEWAY_TOKEN from .env (section 4.2).
#   - auth.token: the gateway uses this for WebSocket auth (CLI flag --token overrides if set)
#   - remote.token: the CLI reads this to authenticate when connecting to the gateway
#   - Without remote.token, `openclaw doctor`, `openclaw devices list`, and `openclaw security audit --deep`
#     all fail with "gateway token mismatch".
# See REQUIREMENTS.md § 3.2 for sandbox config rationale.
#
# Tiered sandbox architecture (config-driven via deploy/sandbox-toolkit.yaml):
#   defaults → base sandbox (openclaw-sandbox:bookworm-slim), no network — used for non-operator sessions (group chats, spawned sessions)
#   "skills" agent → toolkit sandbox (openclaw-sandbox-toolkit:bookworm-slim), bridge network — runs skill binaries
#   "code" agent → toolkit sandbox (openclaw-sandbox-toolkit:bookworm-slim), bridge network, Claude Code CLI
#   All tools (gifgrep, claude-code, ffmpeg, etc.) are installed in sandbox-toolkit via sandbox-toolkit.yaml.
#   Main agent delegates to skills agent for skills needing network (gifgrep, weather, etc.)
#   Main agent delegates to code agent via sessions_spawn for coding tasks.
#   /opt/skill-bins is auto-shimmed from sandbox-toolkit.yaml (see entrypoint §1g).

sudo cp "${STAGING}/openclaw.json" /home/openclaw/.openclaw/openclaw.json

# Substitute all template variables — use | as sed delimiter (URLs contain /)
sudo sed -i \
  -e "s|{{GATEWAY_TOKEN}}|${GATEWAY_TOKEN}|g" \
  -e "s|{{OPENCLAW_DOMAIN_PATH}}|${OPENCLAW_DOMAIN_PATH}|g" \
  -e "s|{{YOUR_TELEGRAM_ID}}|${YOUR_TELEGRAM_ID}|g" \
  -e "s|{{OPENCLAW_INSTANCE_ID}}|${OPENCLAW_INSTANCE_ID}|g" \
  -e "s|{{VPS_HOSTNAME}}|${VPS_HOSTNAME}|g" \
  -e "s|{{ENABLE_EVENTS_LOGGING}}|${ENABLE_EVENTS_LOGGING}|g" \
  -e "s|{{ENABLE_LLEMTRY_LOGGING}}|${ENABLE_LLEMTRY_LOGGING}|g" \
  -e "s|{{EVENTS_URL}}|${EVENTS_URL}|g" \
  -e "s|{{LLEMTRY_URL}}|${LLEMTRY_URL}|g" \
  -e "s|{{LOG_WORKER_TOKEN}}|${LOG_WORKER_TOKEN}|g" \
  /home/openclaw/.openclaw/openclaw.json

# Verify no unsubstituted {{VAR}} placeholders remain (exclude comments)
if sudo grep -v '^\s*//' /home/openclaw/.openclaw/openclaw.json | grep -q '{{'; then
  echo "ERROR: Unsubstituted template placeholders found:"
  sudo grep -n '{{' /home/openclaw/.openclaw/openclaw.json | grep -v '^\s*//'
  exit 1
fi

# Ensure container (uid 1000) can read/write, and not world-readable
sudo chown 1000:1000 /home/openclaw/.openclaw/openclaw.json
sudo chmod 600 /home/openclaw/.openclaw/openclaw.json

# ============================================================
# 4. Agent model configuration (template)
# ============================================================
# IMPORTANT: The embedded agent reads models.json from the agent directory,
# NOT from openclaw.json. The built-in "anthropic" provider ignores the
# ANTHROPIC_BASE_URL env var — this file is the only way to override the base URL.
#
# The format must be "override-only" (baseUrl without a models array).
# If you include a "models" array, the registry creates new model entries
# instead of overriding the built-in anthropic models, and the built-in
# entries (with hardcoded api.anthropic.com) take precedence.

for agent in main code skills; do
  sudo mkdir -p /home/openclaw/.openclaw/agents/${agent}/agent
  sudo cp "${STAGING}/models.json" /home/openclaw/.openclaw/agents/${agent}/agent/models.json

  # Substitute template variable
  sudo sed -i "s|{{AI_GATEWAY_WORKER_URL}}|${AI_GATEWAY_WORKER_URL}|g" \
    /home/openclaw/.openclaw/agents/${agent}/agent/models.json

  # Pre-create session store — the gateway lazily creates this dir only when the
  # first session is saved, but `openclaw doctor` reports CRITICAL if it's missing.
  sudo mkdir -p /home/openclaw/.openclaw/agents/${agent}/sessions
  [ -f /home/openclaw/.openclaw/agents/${agent}/sessions/sessions.json ] || \
    echo '{}' | sudo tee /home/openclaw/.openclaw/agents/${agent}/sessions/sessions.json > /dev/null
  sudo chown -R 1000:1000 /home/openclaw/.openclaw/agents/${agent}
  sudo chmod 600 /home/openclaw/.openclaw/agents/${agent}/agent/models.json
  sudo chmod 600 /home/openclaw/.openclaw/agents/${agent}/sessions/sessions.json
done

# ============================================================
# 5. Build script and patches (static)
# ============================================================
# Instead of maintaining a forked Dockerfile, we patch upstream source files
# in-place before building. Each patch auto-skips when already applied.
# Two patches: Dockerfile (docker.io + gosu) and docker.ts (sandbox env vars).
sudo -u openclaw mkdir -p /home/openclaw/scripts
sudo -u openclaw cp "${STAGING}/build-openclaw.sh" /home/openclaw/scripts/build-openclaw.sh
sudo chmod +x /home/openclaw/scripts/build-openclaw.sh

# ============================================================
# 6. Gateway entrypoint script (static)
# ============================================================
# Runs as root (user: "0:0"). Handles lock cleanup, permission fixes, dockerd startup,
# sandbox image builds, then drops to node via gosu. See inline comments for details.
sudo -u openclaw mkdir -p /home/openclaw/openclaw/scripts
sudo -u openclaw cp "${STAGING}/entrypoint-gateway.sh" /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh

# ============================================================
# 7. Host alerter & maintenance checker (static)
# ============================================================
sudo cp "${STAGING}/host-alert.sh" /home/openclaw/scripts/host-alert.sh
sudo chmod +x /home/openclaw/scripts/host-alert.sh

sudo cp "${STAGING}/host-maintenance-check.sh" /home/openclaw/scripts/host-maintenance-check.sh
sudo chmod +x /home/openclaw/scripts/host-maintenance-check.sh

# Create cron entries — alerter every 15 minutes, daily report if Telegram configured
# HOSTALERT_DAILY_REPORT_TIME is human-readable (e.g., "9:00 AM PST") — Claude converts
# it to cron format at execution time. Default: 0 17 * * * (9:00 AM PST = 5PM UTC).
sudo tee /etc/cron.d/openclaw-alerts << 'CRONEOF'
# OpenClaw host alerter — checks disk, memory, CPU, container health
*/15 * * * * root /home/openclaw/scripts/host-alert.sh
# Daily health report (time configured via HOSTALERT_DAILY_REPORT_TIME)
<CRON_MINUTE> <CRON_HOUR> * * * root /home/openclaw/scripts/host-alert.sh --report
CRONEOF

sudo chmod 644 /etc/cron.d/openclaw-alerts

# Maintenance checker cron — runs daily, 30 min before daily report so data is fresh
# Always runs (not gated on Telegram) — JSON is needed by OpenClaw agents
sudo tee /etc/cron.d/openclaw-maintenance << 'CRONEOF'
# OpenClaw host maintenance checker — detects pending OS updates, required reboots, failed services
# Runs 30 min before daily report so data is fresh for both Telegram and OpenClaw
<CRON_MAINTENANCE_MINUTE> <CRON_MAINTENANCE_HOUR> * * * root /home/openclaw/scripts/host-maintenance-check.sh
CRONEOF

sudo chmod 644 /etc/cron.d/openclaw-maintenance

# ============================================================
# 8. OpenClaw CLI host wrapper (inline)
# ============================================================
# Write wrapper directly to /usr/local/bin (not a symlink — adminclaw can't
# traverse /home/openclaw/scripts/ due to directory permissions)
sudo tee /usr/local/bin/openclaw << 'WRAPEOF'
#!/bin/bash
# OpenClaw CLI wrapper — runs commands inside the gateway container as node user
# Detect TTY to avoid garbled output when called over non-interactive SSH
TTY_FLAG=""
if [ -t 0 ] && [ -t 1 ]; then
  TTY_FLAG="-it"
fi
exec sudo docker exec $TTY_FLAG --user node openclaw-gateway openclaw "$@"
WRAPEOF

sudo chmod +x /usr/local/bin/openclaw

# ============================================================
# 9. Deploy plugins (static)
# ============================================================
# Plugins are loaded via plugins.load.paths in openclaw.json (pointing to /app/deploy/plugins).
# They are NOT copied into ~/.openclaw/extensions/ — this avoids name collisions
# with any plugins bundled by OpenClaw.
# Must be owned by uid 1000 (container's node user), not openclaw (uid 1002).
# OpenClaw's plugin security check blocks candidates with unexpected ownership.
sudo -u openclaw mkdir -p /home/openclaw/openclaw/deploy/plugins
sudo cp -r "${STAGING}/plugins/"* /home/openclaw/openclaw/deploy/plugins/
sudo chown -R 1000:1000 /home/openclaw/openclaw/deploy/plugins/

# ============================================================
# 10. Log rotation config (static)
# ============================================================
sudo cp "${STAGING}/logrotate-openclaw" /etc/logrotate.d/openclaw
sudo chmod 644 /etc/logrotate.d/openclaw

# Dry-run test — should show "rotating pattern" for each log file with no errors
sudo logrotate -d /etc/logrotate.d/openclaw

# ============================================================
# Cleanup
# ============================================================
rm -rf "${STAGING}"

echo ""
echo "========================================="
echo "Configuration deployment complete."
echo "========================================="
```

**Cron generation rules:**

- **Cron runs in the server's local timezone**, not necessarily UTC. Before converting `HOSTALERT_DAILY_REPORT_TIME` to cron fields, check the server timezone: `timedatectl show -p Timezone --value` (or `cat /etc/timezone` as fallback). Convert the user's specified time to the server's local timezone, then write the cron minute/hour fields in that timezone. Include the server timezone and original user time in the cron comment for clarity.
- If `HOSTALERT_DAILY_REPORT_TIME` is not set, default to `9:00 AM UTC` — still convert to the server's local timezone.
- Only include the daily report cron line (`--report`) if both `HOSTALERT_TELEGRAM_BOT_TOKEN` and `HOSTALERT_TELEGRAM_CHAT_ID` are set in `openclaw-config.env`. If Telegram is not configured, write only the alerter line (the script exits silently without Telegram credentials, but there's no point scheduling the report).

**Maintenance cron generation rules:**

- Schedule 30 minutes before the daily report time. If the daily report runs at `9:00 AM`, the maintenance checker runs at `8:30 AM` (same timezone conversion rules as the report cron).
- If `HOSTALERT_DAILY_REPORT_TIME` is not set, default to 30 minutes before `9:00 AM UTC` (i.e., `8:30 AM UTC`).
- The maintenance cron **always** runs, even without Telegram — OpenClaw agents read the JSON independently.

**Current plugins:**

- **coordinator** — auto-discovers agent skills from `agents.list[].skills` arrays in `openclaw.json`, writes a routing table to `AGENTS.md` in the workspace, and injects delegation instructions into agent system prompts via `before_agent_start` hook.
- **telemetry** — unified event shipping to the Log Receiver Worker (LLM spans, session events, tool usage). Configured via `plugins.entries.telemetry.config` in `openclaw.json`.

To add a new skill to an agent, add it to the agent's `skills` array in `openclaw.json` under `agents.list[]`. The coordinator plugin reads these automatically and updates the routing table — no plugin config changes needed. Restart the gateway after updating `openclaw.json`.

---

## 4.4 Build, Start, and Verify

```bash
#!/bin/bash
# Build image with auto-patching
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# Start gateway
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# Start Vector (separate compose project — skip if disabled)
if [ "${ENABLE_VECTOR_LOG_SHIPPING}" = "true" ]; then
  sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose up -d'
fi

# Check status
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'
sudo docker logs --tail 20 openclaw-gateway
```

**If build fails:**

> "The Docker image build failed. Common causes:"
>
> - **Disk space:** `df -h` — need at least 10GB free
> - **Network:** build downloads npm packages — check `curl -sI https://registry.npmjs.org`
> - **Patch conflict:** the build script patches the Dockerfile — if upstream changed
>   significantly, the patch may fail. Check the build script output for "FAILED" messages.

**If `docker compose up -d` fails:**

> "Container failed to start. Check the error with:"
>
> `sudo docker logs openclaw-gateway`
>
> Common issues:
>
> - **Port already in use:** another process on port 18789 — `sudo ss -tlnp | grep 18789`
> - **Sysbox not available:** `sudo systemctl status sysbox` — must be active
> - **Invalid .env:** missing required variables — `cat /home/openclaw/openclaw/.env`

### Wait for full startup

On first boot, the entrypoint builds 3 sandbox images inside nested Docker (~15-25 min).
The gateway HTTP endpoint responds during this time, but WebSocket connections (needed for
device pairing) fail until the entrypoint finishes and drops to the node user.

**Wait for the entrypoint to complete with progress feedback:**

Use a background task + polling pattern to give the user visual feedback without flooding the context window:

1. **Start the wait in the background** using the Bash tool with `run_in_background: true`:

```bash
#!/bin/bash
# Wait for entrypoint to finish sandbox builds — looks for privilege drop message
timeout 900 bash -c 'until sudo docker logs openclaw-gateway 2>&1 | grep -q "Executing as node"; do sleep 10; done'
# Then wait for gateway health endpoint
timeout 120 bash -c 'until curl -sf http://localhost:18789<OPENCLAW_DOMAIN_PATH>/ > /dev/null 2>&1; do sleep 3; done'
echo "READY"
```

2. **Poll for progress every 30 seconds** from the main context. Each poll is a lightweight SSH command:

```bash
ssh -i <SSH_KEY_PATH> -p <SSH_PORT> <SSH_USER>@<VPS1_IP> \
  "sudo docker logs openclaw-gateway 2>&1 | grep '\[entrypoint\]' | tail -1"
```

Print the result as a status update to the user (e.g., `[entrypoint] Building toolkit sandbox image...`). Continue polling until the background task completes.

3. **Check background task completion** between polls using `TaskOutput` with `block: false`. When the background task returns `READY`, proceed to the next step.

> **Why not just check health?** The health endpoint (`curl`) responds as soon as the
> gateway HTTP server starts, which happens before sandbox builds finish. But device
> pairing requires the gateway to be fully initialized. Checking the "Executing as node"
> log line ensures the entrypoint has completed.
>
> **Why not delegate to a subagent?** Subagent output is invisible to the user until it
> returns. The background + polling pattern keeps the build in the main context cheaply
> (~100 tokens per poll) while giving real-time progress feedback.

### Fix .openclaw ownership

The gateway creates subdirectories (`identity/`, `devices/`) during startup as root
(before gosu drops to node). Fix ownership so the container can write to them:

```bash
sudo docker exec openclaw-gateway chown -R 1000:1000 /home/node/.openclaw
```

### Verify CLI access

The `openclaw` host wrapper and `docker exec` commands bypass WebSocket device pairing —
they execute directly inside the container, so no CLI pairing step is needed.

```bash
sudo /usr/local/bin/openclaw devices list
```

**Expected:** Command runs without pairing errors. On a fresh gateway with no browser
connections yet, the output will show an empty device list — that's normal.

### Sandbox Image Verification

Run after gateway startup to verify all sandbox images were built correctly. With the persistent `/var/lib/docker` bind mount, images survive restarts — the entrypoint only rebuilds missing images. On first boot, wait for logs to show build completion before checking.

```bash
#!/bin/bash
# Wait for entrypoint to finish sandbox builds (look for privilege drop message)
echo "Waiting for entrypoint to finish..."
timeout 600 bash -c 'until sudo docker logs openclaw-gateway 2>&1 | grep -q "Executing as node"; do sleep 5; done'

echo "=== Checking sandbox images ==="
FAILED=0

# 1. Check all 3 images exist (tools are in toolkit image via sandbox-toolkit.yaml)
for img in openclaw-sandbox:bookworm-slim openclaw-sandbox-toolkit:bookworm-slim \
           openclaw-sandbox-browser:bookworm-slim; do
  if sudo docker exec openclaw-gateway docker image inspect "$img" > /dev/null 2>&1; then
    echo "  $img: EXISTS"
  else
    echo "  $img: MISSING"
    FAILED=1
  fi
done

# 2. Security check: verify USER is 1000 (not root) on toolkit image
for img in openclaw-sandbox-toolkit:bookworm-slim; do
  USER=$(sudo docker exec openclaw-gateway docker image inspect "$img" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['Config']['User'])" 2>/dev/null)
  if [ "$USER" = "1000" ]; then
    echo "  $img USER: 1000 (OK)"
  else
    echo "  $img USER: $USER (EXPECTED 1000)"
    FAILED=1
  fi
done

# 3. Test key binaries in toolkit sandbox (all tools from sandbox-toolkit.yaml)
for bin in go rustc bun brew node npm pnpm git curl wget jq ffmpeg convert claude gifgrep; do
  if sudo docker exec openclaw-gateway docker run --rm openclaw-sandbox-toolkit:bookworm-slim which "$bin" > /dev/null 2>&1; then
    echo "  toolkit/$bin: OK"
  else
    echo "  toolkit/$bin: MISSING"
    FAILED=1
  fi
done

# 5. Check no intermediate images left
if sudo docker exec openclaw-gateway docker images | grep -q base-root; then
  echo "  WARNING: intermediate base-root image not cleaned up"
fi

# 6. Check image age (staleness)
echo ""
echo "=== Image age ==="
for img in openclaw-sandbox-toolkit:bookworm-slim openclaw-sandbox-browser:bookworm-slim; do
  BUILD_DATE=$(sudo docker exec openclaw-gateway docker image inspect "$img" \
    --format '{{index .Config.Labels "openclaw.build-date"}}' 2>/dev/null)
  if [ -n "$BUILD_DATE" ] && [ "$BUILD_DATE" != "<no value>" ]; then
    AGE_DAYS=$(( ( $(date +%s) - $(date -d "$BUILD_DATE" +%s 2>/dev/null || echo 0) ) / 86400 ))
    if [ "$AGE_DAYS" -gt 30 ]; then
      echo "  $img: ${AGE_DAYS} days old — consider running scripts/update-sandboxes.sh"
    else
      echo "  $img: ${AGE_DAYS} days old (OK)"
    fi
  else
    echo "  $img: no build-date label (pre-label image)"
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "SANDBOX VERIFICATION FAILED — check entrypoint logs:"
  echo "  sudo docker logs openclaw-gateway 2>&1 | grep '\\[entrypoint\\]'"
fi
```

**Expected:** All 3 images exist (base, toolkit, browser), USER is 1000 on toolkit, all binaries present including custom tools from `sandbox-toolkit.yaml` (claude, gifgrep). Images should have `openclaw.build-date` labels and be less than 30 days old. If verification fails, check entrypoint logs for ERROR messages.

---

## 4.5 Deploy OpenClaw Cron Jobs

After the gateway is running and the CLI is paired, deploy the cron jobs defined in `deploy/openclaw-crons.jsonc`.

The playbook reads each job from the reference file and runs `openclaw cron add` via SSH.

### Daily VPS Health Check

This job runs the main agent daily to read the health and maintenance JSON files written by the host cron scripts (§4.3). If everything is healthy, the agent responds with `HEARTBEAT_OK` and no notification is sent. If issues are found, the agent sends a concise alert.

```bash
#!/bin/bash
# SOURCE: deploy/openclaw-crons.jsonc — "Daily VPS Health Check"
# Schedule uses HOSTALERT_DAILY_REPORT_TIME converted to cron format in the configured timezone.
# Default: 30 9 * * * America/Los_Angeles (9:30 AM PST)

# Read the message from the reference file
# The message is a multi-line string — pass it via --message flag
openclaw cron add \
  --name "Daily VPS Health Check" \
  --cron "<CRON_EXPR>" \
  --tz "<CRON_TZ>" \
  --session isolated \
  --wake next-heartbeat \
  --agent main \
  --announce \
  --best-effort-deliver \
  <DELIVERY_FLAGS> \
  --message "Read the VPS health report files and analyze them:

1. Read host-status/health.json (resource metrics)
2. Read host-status/maintenance.json (OS maintenance)

Analyze for issues that need human attention:

Health (health.json):
- disk_pct approaching or exceeding disk_threshold
- memory_pct approaching or exceeding memory_threshold
- load_avg significantly above cpu_count
- docker_ok or gateway_ok is false
- crashed is non-empty (containers restarting)
- backup_ok is false or backup_age_hours > 36
- timestamp older than 30 minutes (monitoring may be broken)

Maintenance (maintenance.json):
- security_updates > 0 (pending security patches)
- reboot_required is true
- failed_services is not \"none\"
- uptime_days > 90 (consider scheduled reboot)
- timestamp older than 26 hours (checker may not be running)

If everything looks healthy, respond with exactly: HEARTBEAT_OK

If any issues are found, send a concise alert with:
- What's wrong (use emoji indicators: 🔴 critical, ⚠️ warning)
- Why it matters (one line per issue)
- Recommended action
Keep it brief — this goes to Telegram."
```

**Placeholder rules:**

- `<CRON_EXPR>` — cron expression derived from `HOSTALERT_DAILY_REPORT_TIME`. Same conversion rules as §4.3. Default: `30 9 * * *`.
- `<CRON_TZ>` — IANA timezone for the cron expression. Derive from the timezone specified in `HOSTALERT_DAILY_REPORT_TIME` (e.g., "PST" → `America/Los_Angeles`). Default: `America/Los_Angeles`.
- `<DELIVERY_FLAGS>` — conditional based on Telegram configuration:
  - **If `HOSTALERT_TELEGRAM_CHAT_ID` is set:** `--channel telegram --to <HOSTALERT_TELEGRAM_CHAT_ID>`
  - **If not set:** omit both `--channel` and `--to`. The CLI defaults to `channel: "last"` (delivers to wherever the user last interacted).

**Verify:**

```bash
openclaw cron list
```

**Expected:** Shows "Daily VPS Health Check" with status `ok` and the correct schedule.

---

## Verification

```bash
# Check containers are running
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose ps'

# Check gateway logs
sudo docker logs --tail 50 openclaw-gateway

# Test internal endpoint (must include basePath if controlUi.basePath is set)
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/ | head -5

# Check Vector is running (separate compose project)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose ps'

# Check Vector logs
sudo docker logs --tail 10 vector
```

---

## Troubleshooting

### Sysbox Not Found

```bash
# Check Sysbox service
sudo systemctl status sysbox

# Reinstall if needed
sudo dpkg -i sysbox-ce_*.deb
```

### Container Won't Start

```bash
# Check logs for config errors
sudo docker logs openclaw-gateway

# Common issue: Invalid config keys in openclaw.json
# Solution: Keep config minimal, only use documented keys

# Check resources
docker system df
free -h
df -h
```

### Permission Denied on .openclaw

The gateway creates subdirectories (`identity/`, `devices/`, `memory/`) during startup
as root (before gosu drops to node). The entrypoint's ownership fix (1d) runs before
these dirs exist, so they end up root-owned.

```bash
# Fix ownership on host
sudo chown -R 1000:1000 /home/openclaw/.openclaw

# Or fix inside the container
sudo docker exec openclaw-gateway chown -R 1000:1000 /home/node/.openclaw
```

### Vector Not Shipping Logs

```bash
# Check Vector logs for config errors
sudo docker logs vector 2>&1 | head -20

# Verify vector.yaml is mounted correctly
sudo docker exec vector ls -la /etc/vector/

# Test the Worker endpoint is reachable from within the container
sudo docker exec vector wget -q -O- <LOG_WORKER_URL_WITHOUT_PATH>/health

# Restart Vector after fixing (use `up -d` instead if .env values changed)
sudo -u openclaw bash -c 'cd /home/openclaw/vector && docker compose restart'
```

### CLI Commands Failing

The `openclaw` host wrapper uses `docker exec`, which bypasses WebSocket device pairing.
If CLI commands fail, check:

1. The gateway container is running: `sudo docker ps | grep openclaw-gateway`
2. The `.openclaw` directory has correct ownership: `sudo docker exec openclaw-gateway chown -R 1000:1000 /home/node/.openclaw`

### Network Issues

```bash
# Verify network exists
docker network ls | grep openclaw

# Recreate if needed
docker network rm openclaw-gateway-net
docker network create --driver bridge --subnet 172.30.0.0/24 openclaw-gateway-net
```

---

## Updating OpenClaw

The `openclaw update` CLI command does **not** work inside Docker — the `.git` directory is excluded by `.dockerignore`, so the update tool reports `not-git-install`. Instead, update by rebuilding from the host git repo using the build script.

The build script auto-patches the Dockerfile and restores the git working tree after building, so `git pull` always works cleanly.

```bash
#!/bin/bash
# 1. Tag current state for rollback
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git tag -f pre-update'
docker tag openclaw:local "openclaw:rollback-$(date +%Y%m%d)" 2>/dev/null || true

# 2. Review changes before applying
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git fetch origin main && git log --oneline HEAD..origin/main'
# (review output, then proceed)

# 3. Pull and rebuild
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git pull origin main'
sudo -u openclaw /home/openclaw/scripts/build-openclaw.sh

# 4. Recreate containers with the new image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 5. Verify new version
openclaw --version
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/

# 6. Cleanup old rollback images (keep last 3)
docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-' | sort -r | tail -n +4 | xargs -r docker rmi
```

> **Note:** Step 4 automatically stops the old container and starts a new one from the rebuilt image. Expect a brief gateway downtime during the restart.

### Rollback Procedure

If an update causes issues, roll back to the previous known-good state:

```bash
#!/bin/bash
# 1. Revert source to pre-update tag
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && git checkout pre-update'

# 2. Restore the previous Docker image
docker tag "openclaw:rollback-$(date +%Y%m%d)" openclaw:local

# 3. Recreate containers with the old image
sudo -u openclaw bash -c 'cd /home/openclaw/openclaw && docker compose up -d'

# 4. Verify
openclaw --version
curl -s http://localhost:18789<OPENCLAW_DOMAIN_PATH>/
```

> If the rollback date tag doesn't match today, list available rollback images with:
> `docker images --format '{{.Repository}}:{{.Tag}}' | grep 'openclaw:rollback-'`

---

## Security Notes

- `read_only: false` + `user: "0:0"` — required for Sysbox Docker-in-Docker. Sysbox user namespace isolation provides equivalent protection. Entrypoint drops to node via gosu.
- `no-new-privileges` prevents escalation; resource limits (cpus, memory, pids) prevent runaway containers
- tmpfs mounts limit persistent writable paths; inner Docker socket group set to `docker`
- See [REQUIREMENTS.md § 3.1](../REQUIREMENTS.md#31-gateway-container) for gateway container rationale
