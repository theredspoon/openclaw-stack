# Local Browser Node

Run an OpenClaw **node host** with headless Chromium on your local machine. The VPS gateway's main agent auto-routes browser tool calls to this node.

## Why

The VPS main agent (running as `non-main`) can't use a sandbox browser. This container provides a browser via the existing node proxy system — the main agent's browser tool auto-discovers it.

## Prerequisites

- Docker + Docker Compose
- Your VPS gateway running behind Cloudflare Access
- A **Cloudflare Access service token** (see setup below)
- Your **OpenClaw gateway token** (from `stack.yml` or `.env`)

## Setup

### 1. Create a Cloudflare Access Service Token

The node's WebSocket connection must pass through Cloudflare Access. A service token lets the `cloudflared` sidecar authenticate without interactive login.

1. Go to [CF Dashboard](https://one.dash.cloudflare.com/) → **Zero Trust** → **Access** → **Service Tokens**
2. Click **Create Service Token**
3. Name it (e.g., `browser-node`)
4. Copy the **Client ID** and **Client Secret** (the secret is only shown once)

### 2. Add a Service Auth Policy

The Access application protecting your gateway needs a policy that accepts the service token.

1. Go to **Zero Trust** → **Access** → **Applications** → your OpenClaw app
2. Add a new policy:
   - **Policy name**: `Browser node service auth`
   - **Action**: `Service Auth`
   - **Include**: Service Token → select your token
3. Save

### 3. Configure

```bash
cd docker/local-browser-node
cp .env.example .env
```

Edit `.env`:

| Variable | Value |
|----------|-------|
| `GATEWAY_DOMAIN` | Your gateway hostname (e.g., `openclaw.example.com`) |
| `CF_ACCESS_CLIENT_ID` | Service token Client ID |
| `CF_ACCESS_CLIENT_SECRET` | Service token Client Secret |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway token from your VPS `.env` or `stack.yml` |

### 4. Build & Start

```bash
docker compose up --build -d
```

First build takes ~5 min (git clone + pnpm install + build + Chromium).

## How It Works

```
Mac                                     Cloudflare                     VPS
┌──────────────┐                    ┌───────────────┐           ┌──────────────┐
│ browser-node │ ws://localhost ──► │ cloudflared   │ ─wss──►  │ CF Edge      │
│ (Chromium)   │                   │ access proxy  │           │ ↓ Access     │
│              │ ◄──────────────── │ (sidecar)     │ ◄──────── │ ↓ Tunnel     │
└──────────────┘                   └───────────────┘           │ ↓ Gateway    │
      shared network namespace                                 └──────────────┘
```

1. **cloudflared sidecar** listens on `localhost:18789`, authenticates through CF Access with the service token
2. **browser-node** connects via `ws://localhost:18789` (shared network namespace, loopback)
3. Gateway token auth succeeds → node registered with `caps: ["system", "browser"]`
4. VPS main agent's browser tool auto-discovers the node (`resolveBrowserNodeTarget()`)
5. Browser actions flow: main agent → node proxy → headless Chromium → result back

## Verification

```bash
# Check logs
docker compose logs -f

# Expected: cloudflared connects, then node host connects to gateway
# Look for: "node host gateway connect" success message
```

On the VPS:
```bash
openclaw nodes status
# Should list the node with "browser" capability
```

Test: ask the main agent to browse a URL — it should work via the node proxy.

## Operations

```bash
# Stop
docker compose down

# Rebuild (pick up new OpenClaw version)
docker compose build --no-cache
docker compose up -d

# View logs
docker compose logs -f browser-node
docker compose logs -f cloudflared-access
```

## Caveats

- **Latency**: browser actions route Mac → CF → VPS → CF → Mac → Chromium → back
- **Mac must be running**: browser only available while the container is up
- **First build**: ~5 min (subsequent starts are instant)
- **Chromium memory**: ~200-400MB per tab on top of container overhead

## Advanced: Direct Connection (No CF Access)

If your gateway isn't behind Cloudflare Access (e.g., Tailscale), you can bypass the cloudflared sidecar. Set these in `.env`:

```env
GATEWAY_HOST=your-gateway-host
GATEWAY_PORT=443
GATEWAY_TLS=true
```

Then use this simplified `docker-compose.override.yml`:

```yaml
services:
  cloudflared-access:
    profiles: ["disabled"]
  browser-node:
    network_mode: bridge
```
