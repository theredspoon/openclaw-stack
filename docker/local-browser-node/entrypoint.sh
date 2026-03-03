#!/bin/bash
set -euo pipefail

# Write openclaw.json config for browser support.
# - browser.enabled + headless + noSandbox: run Chromium headless inside Docker
# - executablePath: system Chromium (installed in Dockerfile)
# - gateway.mode: "remote": read auth token from OPENCLAW_GATEWAY_TOKEN env var
mkdir -p /home/node/.openclaw
cat > /home/node/.openclaw/openclaw.json << 'OCEOF'
{
  "browser": {
    "enabled": true,
    "headless": true,
    "noSandbox": true,
    "executablePath": "/usr/bin/chromium"
  },
  "gateway": {
    "mode": "remote"
  }
}
OCEOF

# Defaults point to the local cloudflared sidecar (shared network namespace).
# Override via env vars for direct connection without the sidecar.
GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_TLS="${GATEWAY_TLS:-false}"

TLS_ARG=""
if [ "$GATEWAY_TLS" = "true" ]; then
  TLS_ARG="--tls"
fi

echo "[browser-node] Starting node host → ${GATEWAY_HOST}:${GATEWAY_PORT} (tls=${GATEWAY_TLS})"
exec node /app/openclaw.mjs node run \
  --host "$GATEWAY_HOST" \
  --port "$GATEWAY_PORT" \
  ${TLS_ARG} \
  --display-name "${NODE_DISPLAY_NAME:-local-browser-node}"
