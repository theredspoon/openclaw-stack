# REVIEW OF THIS PLAN FOR DOWNSIDES

1. Lifecycle coupling — cloudflared restarts whenever the gateway container restarts. If you docker compose down to update
  the gateway, the tunnel goes down too. Currently cloudflared is an independent systemd service that stays up through gateway
  restarts/rebuilds.

2. cloudflared updates require image rebuild — Today you update cloudflared independently with dpkg -i cloudflared.deb &&
  systemctl restart cloudflared (30 seconds). With this change, you'd need to rebuild the entire gateway image to get a new
  cloudflared version.

3. No independent crash recovery — If cloudflared crashes inside the container, the gateway stays healthy but becomes
  unreachable. There's no automatic restart for cloudflared unless you add a process supervisor (supervisord, s6). The only
  recovery is restarting the whole container. Today, systemd auto-restarts cloudflared independently.

4. Entrypoint complexity — The entrypoint already manages 7 steps (lock cleanup, permissions, dockerd, sandbox builds,
  privilege drop). Adding cloudflared as a backgrounded process is one more thing to reason about and debug.

5. Tunnel token in container — CF_TUNNEL_TOKEN would be in the container's environment. Sandboxes run in nested Docker with
  separate namespaces so they shouldn't have access, but it's a higher-value secret living closer to application code than it
  does today.

6. Port mapping stays anyway — The upstream docker-compose.yml has a ports: section that the override file can't remove
  (compose merges ports). So the host port mapping to 127.0.0.1:18789 stays even though nothing uses it. Not harmful, just
  slightly untidy.

  None of these are dealbreakers — they're manageable trade-offs. The question is whether a clean openclaw doctor output is
  worth the coupling. The alternative (accept the warning, zero changes) preserves independent lifecycle management for
  cloudflared.

---

# Plan: Fix `openclaw doctor` LAN Binding Warning

## Context

`openclaw doctor` warns about `bind: "lan"` because OpenClaw's security docs say non-loopback binds "expand the attack surface." The question is whether `lan` is still necessary or is a remnant from the old two-VPS WireGuard architecture.

**Finding: `lan` is NOT a WireGuard remnant — it's required by Docker networking.**

In the old two-VPS setup, `lan` enabled cross-VPS access over WireGuard. In the current single-VPS setup, it serves a different but equally necessary purpose: Docker port forwarding. When cloudflared (systemd on host) sends traffic to `localhost:18789`, Docker NATs it through the bridge network. Inside the container, traffic arrives from `172.30.0.1` (bridge gateway) on `eth0`, not on loopback. If the gateway uses `bind: loopback`, it only listens on `127.0.0.1` inside the container — Docker-forwarded traffic never reaches it.

## Options Evaluated

| Option | Fixes Warning? | Viable? | Complexity |
|--------|---------------|---------|------------|
| **A: cloudflared shares gateway network namespace** (`network_mode: service:`) | Yes | No — Sysbox blocks cross-namespace sharing | N/A |
| **B: cloudflared on same Docker network** | No — still needs `lan` | Yes | Low |
| **C: Accept the warning, document it** | No | Yes | None |
| **D: Run cloudflared inside the Sysbox container** | Yes | Yes | Medium-High |
| **E: Migrate gateway to native systemd** | Yes | Yes | Very High (major refactor) |

**Option A is blocked** — Sysbox creates isolated user+network namespaces. Non-Sysbox containers cannot join a Sysbox container's network namespace (same limitation as `--net=host` being blocked).

## Recommended Approach: Option D — Containerize cloudflared inside the gateway

Move cloudflared from a systemd service into the Sysbox gateway container. cloudflared connects to `localhost:18789` inside the same network namespace — true loopback.

### What changes

1. **`bind: "lan"` → `bind: "loopback"`** in compose command, `.env`, and `openclaw.json`
2. **`trustedProxies: ["172.30.0.1"]` → `trustedProxies: ["127.0.0.1"]`** in `openclaw.json`
3. **cloudflared installed in gateway Docker image** (new Dockerfile patch in build script)
4. **cloudflared started in entrypoint** as a background process before gosu privilege drop
5. **`CF_TUNNEL_TOKEN`** passed as env var to the container via compose
6. **Systemd cloudflared service removed** from VPS
7. **Host port mapping kept** (harmless — daemon.json binds to localhost, and compose override can't remove base file ports)

### Files to modify

| File | Change |
|------|--------|
| `playbooks/04-vps1-openclaw.md` § 4.5 | `.env`: change `OPENCLAW_GATEWAY_BIND=loopback`, add `CF_TUNNEL_TOKEN` |
| `playbooks/04-vps1-openclaw.md` § 4.6 | Compose override: `--bind loopback`, add `CF_TUNNEL_TOKEN` env var |
| `playbooks/04-vps1-openclaw.md` § 4.8 | `openclaw.json`: `bind: "loopback"`, `trustedProxies: ["127.0.0.1"]` |
| `playbooks/04-vps1-openclaw.md` § 4.8a | Build script: add cloudflared install as Dockerfile patch |
| `playbooks/04-vps1-openclaw.md` § 4.8c | Entrypoint: start cloudflared before gosu drop |
| `playbooks/05-cloudflare-tunnel.md` | Rewrite: cloudflared is containerized, not systemd. Keep Dashboard setup, remove systemd install steps, add compose env/entrypoint reference |
| `playbooks/07-verification.md` § 7.4 | Check cloudflared via `docker exec pgrep` instead of `systemctl status` |
| `REQUIREMENTS.md` | Update networking sections (3.4, 3.7), trustedProxies rationale |
| `CLAUDE.md` | Update service management (cloudflared is now in container) |
| `MEMORY.md` | Update Cloudflare Tunnel section |

### Entrypoint addition (between dockerd start and gosu drop)

```bash
# ── Start cloudflared tunnel (loopback access to gateway) ──────
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  echo "[entrypoint] Starting cloudflared tunnel..."
  cloudflared tunnel run --token "${CF_TUNNEL_TOKEN}" > /var/log/cloudflared.log 2>&1 &
  echo "[entrypoint] cloudflared started (PID: $!)"
else
  echo "[entrypoint] WARN: CF_TUNNEL_TOKEN not set, skipping cloudflared"
fi
```

### Build script addition (new Dockerfile patch)

```bash
# Patch 2: Install cloudflared for in-container tunnel (loopback binding)
sed -i '/^USER node/i RUN curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && dpkg -i /tmp/cloudflared.deb && rm /tmp/cloudflared.deb' Dockerfile
```

### Trade-offs

| Benefit | Cost |
|---------|------|
| Clean `openclaw doctor` output | cloudflared lifecycle coupled to gateway container |
| No host port exposure needed | cloudflared updates require image rebuild |
| Simpler trustedProxies (`127.0.0.1`) | Entrypoint adds one more background process step |
| Eliminates Docker bridge as attack surface | CF_TUNNEL_TOKEN in container environment |

### Risk mitigations

- **cloudflared crash**: Cloudflare Dashboard health checks detect tunnel down. Container restart (`restart: unless-stopped`) recovers both gateway and cloudflared.
- **Token exposure**: Environment variable only (not on filesystem). Sandboxes run in nested Docker with separate namespace — no access to parent env.
- **Port mapping stays**: Upstream `docker-compose.yml` has `ports:` that the override can't remove (compose merges ports). Harmless with daemon.json localhost binding.

## Verification

After implementation:

1. Rebuild gateway image (`scripts/build-openclaw.sh`) — confirm cloudflared is in the image
2. Restart compose — confirm cloudflared is running inside container: `sudo docker exec openclaw-gateway pgrep cloudflared`
3. Run `openclaw doctor` inside container — confirm no LAN binding warning
4. Test external access via tunnel — confirm `https://<OPENCLAW_DOMAIN>` works
5. Verify gateway health: `curl -s http://localhost:18789/health` (from inside container)
6. Run `openclaw security audit --deep` — confirm still passes
