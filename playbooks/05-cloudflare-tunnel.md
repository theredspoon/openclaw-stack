# Cloudflare Tunnel Setup

Secure OpenClaw behind Cloudflare Tunnel with zero exposed ports.

> **No SSL certificates required!** Cloudflare Tunnel handles TLS automatically.
> You only need a Cloudflare account with your domain's DNS managed by Cloudflare.

## Overview

This playbook configures:

- cloudflared installation on VPS-1
- Token-based tunnel (remotely managed via Cloudflare Dashboard)
- Port 443 removal from firewall
- Optional: Cloudflare Access authentication

## Why Cloudflare Tunnel?

| Before (Origin Exposed) | After (Tunnel) |
|------------------------|----------------|
| Port 443 open to internet | Port 443 closed |
| Origin IP discoverable | Origin IP hidden |
| Direct IP access possible | Direct IP access blocked |
| Cloudflare can be bypassed | All traffic through Cloudflare |

## Prerequisites

- Core playbooks (01, 03, 04) completed on VPS-1
- Cloudflare account with your domain added
- Domain DNS managed by Cloudflare
- SSH access as `adminclaw` on port 222
- `CF_TUNNEL_TOKEN` set in `openclaw-config.env` (see "Create Tunnel in Dashboard" below)

## Variables

From `../openclaw-config.env`:

- `OPENCLAW_DOMAIN` - Domain for OpenClaw (e.g., openclaw.example.com)
- `OPENCLAW_DOMAIN_PATH` - URL subpath for OpenClaw (from openclaw-config.env)
- `CF_TUNNEL_TOKEN` - Tunnel token from Cloudflare Dashboard

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Internet                              │
│                                                               │
│    User ──► openclaw.example.com ──► Cloudflare Edge          │
│                                        │                      │
│                              Cloudflare Access                │
│                                  (auth check)                 │
│                                        │                      │
└────────────────────────────────────────┼──────────────────────┘
                                         │
                        Encrypted Tunnel (outbound)
                                         │
┌────────────────────────────────────────┼──────────────────────┐
│  VPS-1 (Origin - No inbound ports needed)                     │
│                                        │                      │
│    cloudflared ◄───────────────────────┘                      │
│        │                                                      │
│        ▼                                                      │
│    localhost:18789 (OpenClaw Gateway)                         │
│                                                               │
│    Port 443: CLOSED                                           │
│    Port 80:  CLOSED                                           │
└───────────────────────────────────────────────────────────────┘
```

---

## Create Tunnel in Cloudflare Dashboard

Before running the VPS steps, create the tunnel in the Cloudflare Dashboard:

1. Go to **Cloudflare Dashboard** -> **Zero Trust** -> **Networks** -> **Tunnels**
2. Click **Create a tunnel** -> Choose **Cloudflared**
3. Name it (e.g., `openclaw`)
4. Copy the **tunnel token** (long base64 string starting with `ey...`)
5. Configure the public hostname:
   - **Subdomain:** `openclaw` (or your choice)
   - **Domain:** `example.com` (select your domain)
   - **Service:** `http://localhost:18789`
6. Save the tunnel

Add the token to `openclaw-config.env`:

```bash
CF_TUNNEL_TOKEN=eyJhIjoiYWJj...  # Paste the full token here
```

> **Why token-based?** The older `cloudflared tunnel login` + `tunnel create` flow requires
> browser authentication on the VPS (a headless server), which means manually downloading
> `cert.pem` and uploading it. Token-based tunnels are created entirely in the Dashboard —
> no browser needed on the server. All tunnel config (hostname routing, origin settings)
> lives in the Dashboard, not in local config files.

---

## VPS-1 Setup (OpenClaw)

### Step 1: Install cloudflared

```bash
ssh -p 222 adminclaw@<VPS1_IP>

# Download and install cloudflared
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# Verify installation
cloudflared --version
```

### Step 2: Install as Service with Token

The tunnel token contains all connection info — no cert.pem, credentials.json, or config.yml needed.

```bash
# Install cloudflared as a systemd service using the tunnel token
sudo cloudflared service install ${CF_TUNNEL_TOKEN}

# Enable and start the service
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Check status
sudo systemctl status cloudflared
```

### Step 3: Remove Port 443 from Firewall

Once the tunnel is working, close port 443:

```bash
# Remove HTTPS from firewall (no longer needed)
sudo ufw delete allow 443/tcp

# Verify
sudo ufw status
```

---

## Cloudflare Access Configuration (Optional)

Add authentication via Cloudflare Access for additional security.

### In Cloudflare Dashboard

1. Go to **Zero Trust** -> **Access** -> **Applications**
2. Click **Add an application** -> **Self-hosted**
3. Configure:
   - **Application name:** OpenClaw
   - **Session duration:** 24 hours
   - **Application domain:** `<OPENCLAW_DOMAIN>`
   - **Path:** `<OPENCLAW_DOMAIN_PATH>/*` (or leave blank to protect entire domain)

4. Add a policy:
   - **Policy name:** Allowed Users
   - **Action:** Allow
   - **Include:**
     - Emails: `your-email@example.com`
     - Or: Login Methods -> GitHub/Google

### Test Access Protection

1. Open `https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/` in an incognito window
2. You should see the Cloudflare Access login page
3. Authenticate with your configured method
4. You should now see the OpenClaw UI

---

## Verification

```bash
# Check tunnel service
sudo systemctl status cloudflared

# Verify port 443 is closed
sudo ufw status | grep 443 || echo "Port 443 not in UFW (correct)"

# Test external access
curl -s https://<OPENCLAW_DOMAIN><OPENCLAW_DOMAIN_PATH>/ | head -5

# Verify direct IP access fails
curl -sk --connect-timeout 5 https://<VPS1_IP>/ || echo "Direct access blocked (expected)"
```

---

## Troubleshooting

### Tunnel Not Starting

```bash
# Check logs
sudo journalctl -u cloudflared -f

# Verify the token is valid (look for auth errors in logs)
sudo journalctl -u cloudflared --no-pager | tail -30
```

### DNS Not Resolving

```bash
# Check if CNAME is configured
dig <OPENCLAW_DOMAIN>

# Should show CNAME to <tunnel-id>.cfargotunnel.com
# DNS is managed in the Dashboard — check the public hostname config
```

### 502 Bad Gateway

The origin service isn't responding:

```bash
# Check OpenClaw is running
sudo -u openclaw docker compose ps

# Check it's listening on localhost
curl -s http://localhost:18789/
```

### Token Issues

```bash
# If the token was set incorrectly, reinstall the service:
sudo cloudflared service uninstall
sudo cloudflared service install ${CF_TUNNEL_TOKEN}
sudo systemctl start cloudflared
```

---

## Maintenance

### Updating cloudflared

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
sudo systemctl restart cloudflared
```

### Viewing Tunnel Metrics

Cloudflare Dashboard -> Zero Trust -> Networks -> Tunnels -> (your tunnel) -> Metrics

### Changing Tunnel Configuration

All routing config lives in the Cloudflare Dashboard. To change hostnames, origins, or add new routes:

1. Go to **Cloudflare Dashboard** -> **Zero Trust** -> **Networks** -> **Tunnels**
2. Click your tunnel -> **Configure**
3. Edit the public hostname settings
4. Changes take effect within seconds — no service restart needed

### Rotating Tunnel Token

If the token is compromised:

1. Go to the tunnel in Cloudflare Dashboard
2. Regenerate the token
3. On VPS:
   ```bash
   sudo cloudflared service uninstall
   sudo cloudflared service install <NEW_TOKEN>
   sudo systemctl start cloudflared
   ```
4. Update `CF_TUNNEL_TOKEN` in `openclaw-config.env`

---

## Security Checklist

After completing setup, verify:

- [ ] Port 443 is closed (`sudo ufw status` shows no 443/tcp rule)
- [ ] Port 80 is closed (was never opened)
- [ ] Tunnel is running (`sudo systemctl status cloudflared`)
- [ ] DNS routes through tunnel (`dig <DOMAIN>` shows CNAME)
- [ ] Cloudflare Access is enabled (incognito browser shows login page)
- [ ] Direct IP access fails (`curl -sk https://<VPS1_IP>/` times out or refused)
- [ ] Telegram/Slack bots still work (use outbound connections)

---

## Related Files

- `/etc/systemd/system/cloudflared.service` - Systemd unit (created by `cloudflared service install`)
