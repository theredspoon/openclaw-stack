# Local Browser Node

Run an OpenClaw **node host** with Chromium on your local machine. The VPS gateway's main agent auto-routes browser tool calls to this node. You can see and interact with the browser via KasmVNC at **<https://localhost:6901>** — log into websites, and OpenClaw uses those authenticated sessions.

## Why

The VPS main agent (running as `non-main`) can't use a sandbox browser. This container provides a browser via the existing node proxy system — the main agent's browser tool auto-discovers it.

## Prerequisites

- Docker + Docker Compose
- Your VPS gateway running behind Cloudflare Access
- A **Cloudflare Access service token** (see setup below)

## Setup

### 1. Create a Cloudflare Access Service Token

1. Go to [CF Dashboard](https://one.dash.cloudflare.com/) → **Zero Trust** → **Access** → **Service Tokens**
2. Click **Create Service Token**, name it (e.g., `browser-node`)
3. Copy the **Client ID** and **Client Secret** (the secret is only shown once)

### 2. Add a Service Auth Policy

1. Go to **Zero Trust** → **Access** → **Applications** → your OpenClaw app
2. Add a policy: **Action** = `Service Auth`, **Include** = Service Token → your token
3. Save

### 3. Configure

Add to your root `.env`:

```env
LOCAL_BROWSER_NODE_CLAW=personal-claw
CF_ACCESS_CLIENT_ID=your-client-id
CF_ACCESS_CLIENT_SECRET=your-client-secret
```

That's it — the gateway domain and token are resolved automatically from `stack.yml` via the claw name.

### 4. Build & Start

```bash
cd docker/local-browser-node
./run.sh up --build
```

First build takes ~5 min (git clone + pnpm install + build + Chromium).

### 5. Access the Browser

Open **<https://localhost:6901>** in your browser to see and interact with the containerized Chromium via KasmVNC. Log into websites here — OpenClaw's agent will use those authenticated sessions.

Default credentials: `kasm_user` / `password`

## How It Works

```
┌──────────────────────────────────────────────┐
│            browser-node container             │
│                                               │
│  Chromium ◄──── KasmVNC desktop ─────────────│──► https://localhost:6901
│     ▲                                         │
│     │ CDP                                     │
│  openclaw node run ──► ws-proxy.mjs ──────────┼──► wss://gateway.domain
│  (ws://localhost:18789)  (CF Access headers)   │
└──────────────────────────────────────────────┘
```

1. `run.sh` sources `source-config.sh` → resolves gateway domain and token from the claw name
2. KasmVNC provides a full desktop environment with Chromium visible
3. `ws-proxy.mjs` listens on `localhost:18789`, proxies to `wss://<gateway>` with CF Access headers
4. `openclaw node run` connects via the proxy → registered with `caps: ["system", "browser"]`
5. Main agent's browser tool auto-discovers the node and routes through it
6. You interact with Chromium via KasmVNC at `https://localhost:6901`

## Operations

```bash
# All commands via run.sh (resolves config automatically)
./run.sh up --build            # Build & start (foreground, see logs)
./run.sh up --build -d         # Build & start (background)
./run.sh logs -f               # Follow logs
./run.sh down                  # Stop
./run.sh build --no-cache      # Rebuild (new OpenClaw version)

# Headless mode (no GUI, lighter weight)
./run.sh --profile headless up --build
```

## Verification

On the VPS:

```bash
openclaw nodes status
# Should list the node with "browser" capability
```

Test: ask the main agent to browse a URL — you'll see it happen in the KasmVNC window.

## Caveats

- **Latency**: browser actions route Mac → CF → VPS → CF → Mac → Chromium → back
- **Mac must be running**: browser only available while the container is up
- **First build**: ~5 min (subsequent starts are instant)
- **Chromium memory**: ~200-400MB per tab on top of container overhead

## Resources

- <https://demo.fingerprint.com/playground> - test if your settings make you look like a bot
