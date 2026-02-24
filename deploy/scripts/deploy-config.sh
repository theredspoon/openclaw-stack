#!/bin/bash
set -euo pipefail

# deploy-config.sh — OpenClaw configuration deployment (playbook 04, section 4.3)
#
# Copies files from staging, substitutes template variables, sets permissions,
# creates host crons, deploys plugins.
#
# Modes (backward compatible — all modes produce the same result for single-instance):
#   Default:              Deploy everything (shared + single-instance config)
#   SHARED_ONLY=true:     Deploy shared files only (compose, Vector, entrypoint, plugins, crons, scripts)
#   INSTANCE_NAME=<name>: Deploy instance-specific config only (openclaw.json, models.json, CLI wrapper)
#                         Uses instance config from deploy/openclaws/<name>/config.env
#
# Interface:
#   Env vars in: OPENCLAW_DOMAIN_PATH, YOUR_TELEGRAM_ID, OPENCLAW_INSTANCE_ID,
#                VPS_HOSTNAME, ENABLE_EVENTS_LOGGING, ENABLE_LLEMTRY_LOGGING,
#                LOG_WORKER_TOKEN, LOG_WORKER_URL, AI_GATEWAY_WORKER_URL,
#                ENABLE_VECTOR_LOG_SHIPPING, VPS1_IP,
#                CRON_MINUTE, CRON_HOUR, CRON_MAINTENANCE_MINUTE, CRON_MAINTENANCE_HOUR,
#                HOSTALERT_TELEGRAM_BOT_TOKEN, HOSTALERT_TELEGRAM_CHAT_ID,
#                INSTANCE_NAME, SHARED_ONLY
#   Reads GATEWAY_TOKEN from /home/openclaw/openclaw/.env (not passed in) for single-instance mode
#   Stdout: DEPLOY_CONFIG_OK on success (progress -> stderr)
#   Exit: 0 success, 1 failure (e.g. unsubstituted {{VAR}} found)

# ---- Mode detection ----
INSTANCE_NAME="${INSTANCE_NAME:-}"
SHARED_ONLY="${SHARED_ONLY:-false}"

# Determine what to deploy
DEPLOY_SHARED=true
DEPLOY_INSTANCE=true
if [ -n "$INSTANCE_NAME" ]; then
  DEPLOY_SHARED=false
  echo "Mode: instance-specific (${INSTANCE_NAME})" >&2
elif [ "$SHARED_ONLY" = "true" ]; then
  DEPLOY_INSTANCE=false
  echo "Mode: shared files only" >&2
else
  echo "Mode: single-instance (default)" >&2
fi

# ---- Defaults for optional vars ----
YOUR_TELEGRAM_ID="${YOUR_TELEGRAM_ID:-}"
OPENCLAW_DOMAIN_PATH="${OPENCLAW_DOMAIN_PATH:-}"
OPENCLAW_INSTANCE_ID="${OPENCLAW_INSTANCE_ID:-}"
VPS_HOSTNAME="${VPS_HOSTNAME:-}"
ENABLE_EVENTS_LOGGING="${ENABLE_EVENTS_LOGGING:-false}"
ENABLE_LLEMTRY_LOGGING="${ENABLE_LLEMTRY_LOGGING:-false}"
LOG_WORKER_TOKEN="${LOG_WORKER_TOKEN:-}"
LOG_WORKER_URL="${LOG_WORKER_URL:-}"
ENABLE_VECTOR_LOG_SHIPPING="${ENABLE_VECTOR_LOG_SHIPPING:-false}"
HOSTALERT_TELEGRAM_BOT_TOKEN="${HOSTALERT_TELEGRAM_BOT_TOKEN:-}"
HOSTALERT_TELEGRAM_CHAT_ID="${HOSTALERT_TELEGRAM_CHAT_ID:-}"

# Derived URLs
LLEMTRY_URL="${LOG_WORKER_URL/\/logs/\/llemtry}"
EVENTS_URL="${LOG_WORKER_URL/\/logs/\/events}"

# Instance-specific config directory (multi-instance mode)
if [ -n "$INSTANCE_NAME" ]; then
  INSTANCE_CONFIG_DIR="/home/openclaw/.openclaw/instances/${INSTANCE_NAME}"
  # In instance mode, generate a new token if not provided
  GATEWAY_TOKEN="${GATEWAY_TOKEN:-$(openssl rand -hex 32)}"
  echo "  Instance config dir: ${INSTANCE_CONFIG_DIR}" >&2
  echo "  Gateway token: ${GATEWAY_TOKEN}" >&2
else
  # Read the gateway token generated in section 4.2
  GATEWAY_TOKEN=$(sudo grep OPENCLAW_GATEWAY_TOKEN /home/openclaw/openclaw/.env | cut -d= -f2)
fi

STAGING="/tmp/deploy-staging"

# ── Shared files (compose, Vector, scripts, crons, plugins) ──────────
if [ "$DEPLOY_SHARED" = "true" ]; then

# 1. Docker Compose override (static)
# Building happens separately via the build script (section 4.4), not via docker compose build.
sudo -u openclaw cp "${STAGING}/docker-compose.override.yml" /home/openclaw/openclaw/docker-compose.override.yml
echo "Deployed docker-compose.override.yml" >&2

# 2. Vector log shipper (static, conditional)
if [ "${ENABLE_VECTOR_LOG_SHIPPING}" = "true" ]; then
  sudo -u openclaw mkdir -p /home/openclaw/vector/data

  sudo -u openclaw cp "${STAGING}/vector/docker-compose.yml" /home/openclaw/vector/docker-compose.yml
  sudo -u openclaw cp "${STAGING}/vector/vector.yaml" /home/openclaw/vector/vector.yaml

  # Create Vector .env with log shipping credentials
  sudo -u openclaw tee /home/openclaw/vector/.env > /dev/null << VECTOREOF
# Vector log shipping — Cloudflare Log Receiver Worker
LOG_WORKER_URL=${LOG_WORKER_URL}
LOG_WORKER_TOKEN=${LOG_WORKER_TOKEN}
VPS1_IP=${VPS1_IP}
VECTOREOF

  sudo chmod 600 /home/openclaw/vector/.env
  echo "Deployed Vector configuration." >&2
else
  echo "Vector log shipping disabled, skipping." >&2
fi

fi  # DEPLOY_SHARED

# ── Instance-specific config (openclaw.json, models.json) ────────────
if [ "$DEPLOY_INSTANCE" = "true" ]; then

# Determine config target path and openclaw.json source
if [ -n "$INSTANCE_NAME" ]; then
  CONFIG_TARGET="${INSTANCE_CONFIG_DIR}"
  # Check for instance-specific openclaw.json, fall back to default
  if [ -f "${STAGING}/openclaws/${INSTANCE_NAME}/openclaw.json" ]; then
    JSON_SOURCE="${STAGING}/openclaws/${INSTANCE_NAME}/openclaw.json"
    echo "  Using instance-specific openclaw.json" >&2
  else
    JSON_SOURCE="${STAGING}/openclaw.json"
  fi
else
  CONFIG_TARGET="/home/openclaw/.openclaw"
  JSON_SOURCE="${STAGING}/openclaw.json"
fi

# 3. OpenClaw configuration (template)
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

sudo cp "${JSON_SOURCE}" "${CONFIG_TARGET}/openclaw.json"

# Substitute all template variables — use | as sed delimiter (URLs contain /)
sudo sed -i \
  -e "s|{{GATEWAY_TOKEN}}|${GATEWAY_TOKEN}|g" \
  -e "s|{{OPENCLAW_DOMAIN_PATH}}|${OPENCLAW_DOMAIN_PATH}|g" \
  -e "s|{{YOUR_TELEGRAM_ID}}|${YOUR_TELEGRAM_ID}|g" \
  -e "s|{{OPENCLAW_INSTANCE_ID}}|${OPENCLAW_INSTANCE_ID:-${INSTANCE_NAME}}|g" \
  -e "s|{{VPS_HOSTNAME}}|${VPS_HOSTNAME}|g" \
  -e "s|{{ENABLE_EVENTS_LOGGING}}|${ENABLE_EVENTS_LOGGING}|g" \
  -e "s|{{ENABLE_LLEMTRY_LOGGING}}|${ENABLE_LLEMTRY_LOGGING}|g" \
  -e "s|{{EVENTS_URL}}|${EVENTS_URL}|g" \
  -e "s|{{LLEMTRY_URL}}|${LLEMTRY_URL}|g" \
  -e "s|{{LOG_WORKER_TOKEN}}|${LOG_WORKER_TOKEN}|g" \
  "${CONFIG_TARGET}/openclaw.json"

# Verify no unsubstituted {{VAR}} placeholders remain (exclude comments)
if sudo grep -v '^\s*//' "${CONFIG_TARGET}/openclaw.json" | grep -q '{{'; then
  echo "ERROR: Unsubstituted template placeholders found:" >&2
  sudo grep -n '{{' "${CONFIG_TARGET}/openclaw.json" | grep -v '^\s*//' >&2
  exit 1
fi

# Ensure container (uid 1000) can read/write, and not world-readable
sudo chown 1000:1000 "${CONFIG_TARGET}/openclaw.json"
sudo chmod 600 "${CONFIG_TARGET}/openclaw.json"
echo "Deployed openclaw.json with template substitution." >&2

# 4. Agent model configuration (template)
# IMPORTANT: The embedded agent reads models.json from the agent directory,
# NOT from openclaw.json. The built-in "anthropic" provider ignores the
# ANTHROPIC_BASE_URL env var — this file is the only way to override the base URL.
#
# The format must be "override-only" (baseUrl without a models array).
# If you include a "models" array, the registry creates new model entries
# instead of overriding the built-in anthropic models, and the built-in
# entries (with hardcoded api.anthropic.com) take precedence.

for agent in main code skills; do
  sudo mkdir -p "${CONFIG_TARGET}/agents/${agent}/agent"
  sudo cp "${STAGING}/models.json" "${CONFIG_TARGET}/agents/${agent}/agent/models.json"

  # Substitute template variable
  sudo sed -i "s|{{AI_GATEWAY_WORKER_URL}}|${AI_GATEWAY_WORKER_URL}|g" \
    "${CONFIG_TARGET}/agents/${agent}/agent/models.json"

  # Pre-create session store — the gateway lazily creates this dir only when the
  # first session is saved, but `openclaw doctor` reports CRITICAL if it's missing.
  sudo mkdir -p "${CONFIG_TARGET}/agents/${agent}/sessions"
  [ -f "${CONFIG_TARGET}/agents/${agent}/sessions/sessions.json" ] || \
    echo '{}' | sudo tee "${CONFIG_TARGET}/agents/${agent}/sessions/sessions.json" > /dev/null
  sudo chown -R 1000:1000 "${CONFIG_TARGET}/agents/${agent}"
  sudo chmod 600 "${CONFIG_TARGET}/agents/${agent}/agent/models.json"
  sudo chmod 600 "${CONFIG_TARGET}/agents/${agent}/sessions/sessions.json"
done
echo "Deployed per-agent models.json." >&2

fi  # DEPLOY_INSTANCE

# ── Shared files continued (scripts, crons, plugins, etc.) ───────────
if [ "$DEPLOY_SHARED" = "true" ]; then

# 5. Build script and patches (static)
# Instead of maintaining a forked Dockerfile, we patch upstream source files
# in-place before building. Each patch auto-skips when already applied.
# Five patches applied by build-openclaw.sh (each auto-skips when upstream fixes the issue).
sudo -u openclaw mkdir -p /home/openclaw/scripts
sudo -u openclaw cp "${STAGING}/build-openclaw.sh" /home/openclaw/scripts/build-openclaw.sh
sudo chmod +x /home/openclaw/scripts/build-openclaw.sh
echo "Deployed build-openclaw.sh." >&2

# 6. Gateway entrypoint script (static)
# Runs as root (user: "0:0"). Handles lock cleanup, permission fixes, dockerd startup,
# sandbox image builds, then drops to node via gosu. See inline comments for details.
sudo -u openclaw mkdir -p /home/openclaw/openclaw/scripts
sudo -u openclaw cp "${STAGING}/entrypoint-gateway.sh" /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
sudo chmod +x /home/openclaw/openclaw/scripts/entrypoint-gateway.sh
echo "Deployed entrypoint-gateway.sh." >&2

# 7. Host alerter & maintenance checker (static)
sudo cp "${STAGING}/host-alert.sh" /home/openclaw/scripts/host-alert.sh
sudo chmod +x /home/openclaw/scripts/host-alert.sh

sudo cp "${STAGING}/host-maintenance-check.sh" /home/openclaw/scripts/host-maintenance-check.sh
sudo chmod +x /home/openclaw/scripts/host-maintenance-check.sh

# Create cron entries — alerter every 15 minutes, daily report if Telegram configured
# CRON_MINUTE/CRON_HOUR are computed by Claude from HOSTALERT_DAILY_REPORT_TIME
# and passed in as env vars. Cron runs in the server's local timezone.
{
  echo "# OpenClaw host alerter — checks disk, memory, CPU, container health"
  echo "*/15 * * * * root /home/openclaw/scripts/host-alert.sh"

  # Only include the daily report line if Telegram is configured
  if [ -n "${HOSTALERT_TELEGRAM_BOT_TOKEN}" ] && [ -n "${HOSTALERT_TELEGRAM_CHAT_ID}" ]; then
    echo "# Daily health report (time configured via HOSTALERT_DAILY_REPORT_TIME)"
    echo "${CRON_MINUTE} ${CRON_HOUR} * * * root /home/openclaw/scripts/host-alert.sh --report"
  fi
} | sudo tee /etc/cron.d/openclaw-alerts > /dev/null

sudo chmod 644 /etc/cron.d/openclaw-alerts

# Maintenance checker cron — runs daily, 30 min before daily report so data is fresh
# Always runs (not gated on Telegram) — JSON is needed by OpenClaw agents
{
  echo "# OpenClaw host maintenance checker — detects pending OS updates, required reboots, failed services"
  echo "# Runs 30 min before daily report so data is fresh for both Telegram and OpenClaw"
  echo "${CRON_MAINTENANCE_MINUTE} ${CRON_MAINTENANCE_HOUR} * * * root /home/openclaw/scripts/host-maintenance-check.sh"
} | sudo tee /etc/cron.d/openclaw-maintenance > /dev/null

sudo chmod 644 /etc/cron.d/openclaw-maintenance
echo "Deployed host cron jobs." >&2

# 8. OpenClaw CLI host wrapper (inline)
# Write wrapper directly to /usr/local/bin (not a symlink — adminclaw can't
# traverse /home/openclaw/scripts/ due to directory permissions)
# Multi-instance aware: auto-detects running containers, supports --instance flag
sudo tee /usr/local/bin/openclaw > /dev/null << 'WRAPEOF'
#!/bin/bash
# OpenClaw CLI wrapper — multi-instance aware
# Resolves target container via:
#   1. --instance <name> flag (explicit, stripped before passing to openclaw)
#   2. Auto-detect: single running container = use it, multiple = interactive picker

CONTAINER=""

# Check --instance flag
if [ "$1" = "--instance" ] && [ -n "$2" ]; then
  CONTAINER="openclaw-$2"
  shift 2
fi

# Auto-detect from running containers
if [ -z "$CONTAINER" ]; then
  RUNNING=$(sudo docker ps --filter "name=openclaw-" --filter "status=running" \
    --format '{{.Names}}' | grep -v 'openclaw-cli' | sort)
  COUNT=$(echo "$RUNNING" | grep -c . || true)

  if [ "$COUNT" -eq 0 ]; then
    echo "No openclaw containers running." >&2
    exit 1
  elif [ "$COUNT" -eq 1 ]; then
    CONTAINER="$RUNNING"
  else
    echo "Multiple openclaw instances running:" >&2
    i=1
    while IFS= read -r name; do
      echo "  $i) $name" >&2
      i=$((i + 1))
    done <<< "$RUNNING"
    printf "Select instance [1-%d]: " "$COUNT" >&2
    read -r choice
    CONTAINER=$(echo "$RUNNING" | sed -n "${choice}p")
    if [ -z "$CONTAINER" ]; then
      echo "Invalid selection." >&2
      exit 1
    fi
  fi
fi

TTY_FLAG=""
[ -t 0 ] && [ -t 1 ] && TTY_FLAG="-it"
exec sudo docker exec $TTY_FLAG --user node "$CONTAINER" openclaw "$@"
WRAPEOF

sudo chmod +x /usr/local/bin/openclaw
echo "Deployed openclaw CLI wrapper." >&2

# 9. Deploy plugins (static)
# Plugins are loaded via plugins.load.paths in openclaw.json (pointing to /app/deploy/plugins).
# They are NOT copied into ~/.openclaw/extensions/ — this avoids name collisions
# with any plugins bundled by OpenClaw.
# Must be owned by uid 1000 (container's node user), not openclaw (uid 1002).
# OpenClaw's plugin security check blocks candidates with unexpected ownership.
sudo -u openclaw mkdir -p /home/openclaw/openclaw/deploy/plugins
sudo cp -r "${STAGING}/plugins/"* /home/openclaw/openclaw/deploy/plugins/
sudo chown -R 1000:1000 /home/openclaw/openclaw/deploy/plugins/
echo "Deployed plugins." >&2

# 10. Sandbox toolkit, rebuild script, and dashboard (static)
# These files are bind-mounted into the container via ./deploy:/app/deploy:ro.
# They must exist on the host before the container starts, otherwise Docker
# creates empty directories as mount targets and sandbox builds fail.
sudo -u openclaw cp "${STAGING}/sandbox-toolkit.yaml" /home/openclaw/openclaw/deploy/sandbox-toolkit.yaml
sudo -u openclaw cp "${STAGING}/parse-toolkit.mjs" /home/openclaw/openclaw/deploy/parse-toolkit.mjs
sudo -u openclaw cp "${STAGING}/rebuild-sandboxes.sh" /home/openclaw/openclaw/deploy/rebuild-sandboxes.sh
sudo chmod +x /home/openclaw/openclaw/deploy/rebuild-sandboxes.sh
sudo -u openclaw mkdir -p /home/openclaw/openclaw/deploy/dashboard
sudo -u openclaw cp -r "${STAGING}/dashboard/"* /home/openclaw/openclaw/deploy/dashboard/
echo "Deployed sandbox toolkit, rebuild script, and dashboard." >&2

# 11. Log rotation config (static)
sudo cp "${STAGING}/logrotate-openclaw" /etc/logrotate.d/openclaw
sudo chmod 644 /etc/logrotate.d/openclaw

# Dry-run test — should show "rotating pattern" for each log file with no errors
sudo logrotate -d /etc/logrotate.d/openclaw >&2 2>&1
echo "Deployed logrotate configuration." >&2

fi  # DEPLOY_SHARED

# Cleanup
rm -rf "${STAGING}"

echo "" >&2
echo "Configuration deployment complete." >&2

echo "DEPLOY_CONFIG_OK"
