#!/usr/bin/env bash
# source-config.sh — Canonical configuration resolver for OpenClaw scripts.
# Auto-detects local (dev machine) vs VPS (staging/deployed) context.
#
# Usage (sourced by other scripts):
#   source "$SCRIPT_DIR/../deploy/scripts/source-config.sh"  # from scripts/
#   source "$SCRIPT_DIR/source-config.sh"                     # from deploy/scripts/
#
# Usage (standalone):
#   ./source-config.sh <VAR_NAME>   # Print single variable value
#   ./source-config.sh --all        # Print all config variables
#
# Exports:
#   OPENCLAW_CONTEXT    — "local" or "vps"
#   REPO_ROOT           — Repo root (empty on VPS)
#   DEPLOY_DIR          — deploy/ directory (local or staging)
#   OPENCLAWS_DIR       — openclaws/ directory (claw configurations)
#   INSTALL_DIR         — VPS install base (default: /home/openclaw)
#   VPS_INSTANCES_DIR   — VPS instances path ($INSTALL_DIR/instances)
#   STAGING_DIR         — VPS deploy staging ($INSTALL_DIR/.deploy-staging)
#   CONFIG_ENV_PATH     — Path to openclaw-config.env (repo root or staging)
#   + all vars from openclaw-config.env

_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_DEPLOY_DIR="$(cd "$_SELF_DIR/.." && pwd)"
_CANDIDATE_ROOT="$(cd "$_DEPLOY_DIR/.." 2>/dev/null && pwd)"

# Capture env BEFORE sourcing (for --all diff)
_BEFORE_ENV=$(env | sort)

# ── Context detection ──
if [ -f "${_CANDIDATE_ROOT}/openclaw-config.env" ]; then
  # Local: deploy/scripts/ is inside repo
  OPENCLAW_CONTEXT="local"
  REPO_ROOT="$_CANDIDATE_ROOT"
  DEPLOY_DIR="${REPO_ROOT}/deploy"
  OPENCLAWS_DIR="${REPO_ROOT}/openclaws"
  CONFIG_ENV_PATH="${REPO_ROOT}/openclaw-config.env"

  set -a
  # shellcheck disable=SC1091
  source "$CONFIG_ENV_PATH"
  set +a
else
  # VPS: running from staging dir or installed location
  OPENCLAW_CONTEXT="vps"
  REPO_ROOT=""
  DEPLOY_DIR="$_DEPLOY_DIR"
  OPENCLAWS_DIR="${DEPLOY_DIR}/openclaws"
  CONFIG_ENV_PATH="${DEPLOY_DIR}/openclaw-config.env"
fi

# ── Defaults (all VPS paths derive from INSTALL_DIR) ──
INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-stable}"
ALLOW_OPENCLAW_UPDATES="${ALLOW_OPENCLAW_UPDATES:-false}"
VPS_INSTANCES_DIR="${INSTALL_DIR}/instances"
STAGING_DIR="${INSTALL_DIR}/.deploy-staging"

# ── Project name → stack-scoped Docker image tag ──
# Derive from INSTALL_DIR if not explicitly set: /home/mybot/openclaw → "mybot-openclaw"
# Strip /home/ prefix, replace path separators with hyphens, lowercase
if [ -z "${OPENCLAW_PROJECT_NAME:-}" ]; then
  OPENCLAW_PROJECT_NAME=$(echo "$INSTALL_DIR" | sed 's|^/home/||; s|^/||; s|/$||; s|/|-|g' | tr '[:upper:]' '[:lower:]')
fi
OPENCLAW_IMAGE="openclaw-${OPENCLAW_PROJECT_NAME}:local"

export OPENCLAW_CONTEXT REPO_ROOT DEPLOY_DIR OPENCLAWS_DIR INSTALL_DIR VPS_INSTANCES_DIR STAGING_DIR CONFIG_ENV_PATH OPENCLAW_PROJECT_NAME OPENCLAW_IMAGE

# ── Standalone query mode ──
if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  if [[ "$1" == "--all" ]]; then
    _AFTER_ENV=$(env | sort)
    comm -13 <(echo "$_BEFORE_ENV") <(echo "$_AFTER_ENV")
  elif [[ -n "$1" ]]; then
    echo "${!1}"
  else
    echo "Usage: source-config.sh <VAR_NAME|--all>" >&2
    exit 1
  fi
fi
