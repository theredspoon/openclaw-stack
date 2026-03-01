#!/usr/bin/env bash
# Reset SSH known_hosts entry for the VPS and reconnect.
# Use after reinstalling the OS to re-confirm the new host key fingerprint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/../deploy/host/source-config.sh"

: "${ENV__VPS_IP:?ENV__VPS_IP not set in stack.env}"
: "${ENV__SSH_KEY:=~/.ssh/vps1_openclaw_ed25519}"
: "${ENV__SSH_USER:=ubuntu}"
: "${ENV__SSH_PORT:=22}"

# Expand ~ in SSH key path
ENV__SSH_KEY="${ENV__SSH_KEY/#\~/$HOME}"

echo "Removing $ENV__VPS_IP from known_hosts (all ports)..."
ssh-keygen -R "$ENV__VPS_IP" 2>/dev/null || true
ssh-keygen -R "[$ENV__VPS_IP]:$ENV__SSH_PORT" 2>/dev/null || true

echo ""
echo "Connecting to $ENV__SSH_USER@$ENV__VPS_IP:$ENV__SSH_PORT"
echo "You will be prompted to confirm the new host key fingerprint."
echo ""

 TERM=xterm-256color exec ssh -t -i "$ENV__SSH_KEY" -p "$ENV__SSH_PORT" "$ENV__SSH_USER@$ENV__VPS_IP"
