#!/bin/bash
set -euo pipefail

# ── OpenClaw config ────────────────────────────────────────────
mkdir -p /home/node/.openclaw
cat > /home/node/.openclaw/openclaw.json << 'OCEOF'
{
  "browser": {
    "enabled": true,
    "headless": false,
    "noSandbox": true,
    "executablePath": "/usr/bin/chromium"
  },
  "gateway": {
    "mode": "remote"
  }
}
OCEOF

# ── Display server ───────────────────────────────────────────
echo "[browser-node] Starting Xvfb on :99"
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1

echo "[browser-node] Starting Xfce4 desktop"
export DISPLAY=:99
startxfce4 &
sleep 2

echo "[browser-node] Starting x11vnc"
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &
sleep 0.5

echo "[browser-node] Starting noVNC on port 6080"
websockify --web /usr/share/novnc 6080 localhost:5900 &
sleep 0.5

# ── Launch Chromium on desktop ───────────────────────────────
echo "[browser-node] Launching Chromium"
chromium --no-sandbox --start-maximized --disable-gpu --display=:99 &

# ── CF Access WebSocket proxy ──────────────────────────────────
if [ -n "${GATEWAY_DOMAIN:-}" ]; then
  echo "[browser-node] Starting WS proxy → wss://${GATEWAY_DOMAIN}"
  node /app/ws-proxy.mjs &
  sleep 0.5
fi

# ── Start node host ───────────────────────────────────────────
echo "[browser-node] Starting node host → 127.0.0.1:18789"
node /app/openclaw.mjs node run \
  --host 127.0.0.1 \
  --port 18789 \
  --display-name "${NODE_DISPLAY_NAME:-local-browser-node}"
