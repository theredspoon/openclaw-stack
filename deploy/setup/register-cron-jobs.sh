#!/bin/bash
set -euo pipefail

# register-cron-jobs.sh — Register OpenClaw cron jobs on all claws
#
# Self-contained: sources config from source-config.sh (stack.env).
# Iterates over all claws in the stack and registers the Daily VPS Health Check.
#
# Prerequisites: Gateway container(s) must be running and healthy.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=../host/source-config.sh
source "$SCRIPT_DIR/../host/source-config.sh"

# Read pre-resolved config
CLAW_IDS="${STACK__CLAWS__IDS:?STACK__CLAWS__IDS not set in stack.env}"
CRON_EXPR="${STACK__HOST__HOSTALERT__CRON_EXPR:-30 9 * * *}"
CRON_TZ="${STACK__HOST__HOSTALERT__CRON_TZ:-America/Los_Angeles}"
CHAT_ID="${ENV__HOSTALERT_TELEGRAM_CHAT_ID:-}"

# Build delivery flags (conditional on Telegram config)
DELIVERY_FLAGS=""
if [ -n "$CHAT_ID" ]; then
  DELIVERY_FLAGS="--channel telegram --to ${CHAT_ID}"
fi

# Register on each claw
IFS=',' read -ra CLAWS <<< "$CLAW_IDS"
for CLAW in "${CLAWS[@]}"; do
  echo "Checking claw: $CLAW"

  # Idempotent: skip if already registered
  # shellcheck disable=SC2086
  if openclaw --instance "$CLAW" cron list 2>/dev/null | grep -q "Daily VPS Health Check"; then
    echo "  Cron job 'Daily VPS Health Check' already registered on $CLAW, skipping."
    continue
  fi

  echo "  Registering 'Daily VPS Health Check' on $CLAW..."
  # shellcheck disable=SC2086
  openclaw --instance "$CLAW" cron add \
    --name "Daily VPS Health Check" \
    --cron "${CRON_EXPR}" \
    --tz "${CRON_TZ}" \
    --session isolated \
    --wake next-heartbeat \
    --agent main \
    --announce \
    --best-effort-deliver \
    ${DELIVERY_FLAGS} \
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
- What's wrong (use emoji indicators: critical, warning)
- Why it matters (one line per issue)
- Recommended action
Keep it brief - this goes to Telegram."

  echo "  Registered on $CLAW."
done

echo "Done. Cron registration complete for ${#CLAWS[@]} claw(s)."
