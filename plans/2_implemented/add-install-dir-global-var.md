# Add INSTALL_DIR Global Variable

## Context

All deploy scripts and playbooks hardcode `/home/openclaw` as the installation directory. This prevents deploying multiple independent stacks (each with multiple claws) to the same VPS. Adding `INSTALL_DIR` as a configurable variable makes the installation path flexible.

**Scope:** ~65 occurrences across 11 deploy files, ~98 across 7 playbooks, 7 in CLAUDE.md.

---

## Design

### Variable Flow

1. **`openclaw-config.env`** defines `INSTALL_DIR=/home/openclaw`
2. **Playbooks** pass it to VPS scripts via SSH env vars (`env INSTALL_DIR=$INSTALL_DIR ...`)
3. **Deploy scripts** on VPS define `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` with fallback
4. **Cron entries** get `INSTALL_DIR=<value>` as an env var line at the top of each cron.d file
5. **Logrotate config** uses `{{INSTALL_DIR}}` template placeholders, substituted by deploy-config.sh
6. **Generated compose** (`openclaw-multi.sh`) derives volume paths from `OPENCLAW_HOME`

### Conventions

- Deploy scripts: `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top, derive all paths
- Scripts that already use `OPENCLAW_HOME`: change definition to `OPENCLAW_HOME="${INSTALL_DIR:-/home/openclaw}"`
- Scripts that already use `INSTANCES_DIR`: change to `INSTANCES_DIR="${INSTALL_DIR:-/home/openclaw}/instances"`
- Playbooks: `/home/openclaw` → `<INSTALL_DIR>` placeholder
- CLAUDE.md: same as playbooks

---

## File Changes

### 1. `openclaw-config.env.example` — Add variable

After the SSH section (~line 19), add:

```
# === INSTALL DIRECTORY ===
INSTALL_DIR=/home/openclaw                # Base directory on VPS. Change only for multi-stack deployments.
```

### 2. `deploy/scripts/setup-infra.sh` (16 occurrences)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top (after validation block, ~line 34)
- **Heredocs** (lines 56-63, 67-82, 103-107): Pass INSTALL_DIR via `bash -s` argument pattern (already used at line 67)
- **Inline paths** (lines 88-95): Replace `/home/openclaw/instances/` with `${INSTALL_DIR}/instances/`
- **Clone block** (line 105): `cd ${INSTALL_DIR}` via argument
- **.env creation** (line 117): `${INSTALL_DIR}/openclaw/.env`
- **.env permissions** (lines 159-160): `${INSTALL_DIR}/openclaw/.env`
- **.env content** (lines 146-147): `OPENCLAW_CONFIG_DIR` and `OPENCLAW_WORKSPACE_DIR` — these are legacy upstream vars (overridden by compose override) but update for correctness
- **Comments** (lines 10, 55): Update path references

### 3. `deploy/scripts/deploy-config.sh` (~25 occurrences)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top (after mode detection, ~line 40)
- **config_target** (line 65): `"${INSTALL_DIR}/instances/${name}/.openclaw"`
- **Vector paths** (lines 176-189): All 6 `/home/openclaw/vector/...` → `${INSTALL_DIR}/vector/...`
- **Scripts paths** (lines 225-243): All `sudo -u openclaw mkdir -p /home/openclaw/scripts` etc. → `${INSTALL_DIR}/scripts`
- **Cron entries** (lines 248-267): Script paths use `${INSTALL_DIR}/scripts/...`, PLUS add `INSTALL_DIR=${INSTALL_DIR}` env var line at top of each cron.d file
- **Entrypoint** (lines 233-235): `${INSTALL_DIR}/openclaw/scripts/...`
- **Plugins** (lines 333-335): `${INSTALL_DIR}/openclaw/deploy/plugins`
- **Sandbox/dashboard** (lines 342-347): `${INSTALL_DIR}/openclaw/deploy/...`
- **Logrotate** (line 351): Add sed substitution of `{{INSTALL_DIR}}` after copy
- **Comment** (line 274): update path reference

### 4. `deploy/scripts/openclaw-multi.sh` (4 occurrences)

- Line 29: `OPENCLAW_HOME="${INSTALL_DIR:-/home/openclaw}"`
- Lines 288-291 (compose generation): Already uses heredoc with variable expansion — the `OPENCLAW_HOME` variable will be expanded when generating compose, so just changing the definition suffices. BUT the volume paths currently hardcode `/home/openclaw/instances/...` — change to `${OPENCLAW_HOME}/instances/...`

### 5. `deploy/scripts/start-claws.sh` (1 definition + usage via OPENCLAW_HOME)

- Line 16: `OPENCLAW_HOME="${INSTALL_DIR:-/home/openclaw}"`
- All usage already goes through `${OPENCLAW_HOME}` — no other changes needed

### 6. `deploy/backup.sh` (5 occurrences)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top
- Line 7: `INSTANCES_DIR="${INSTALL_DIR}/instances"`
- Line 53: `SHARED_BACKUP_DIR="${INSTALL_DIR}/instances/.shared-backups"`
- Lines 55-56: `${INSTALL_DIR}/openclaw/.env`
- Comment (line 5): update

### 7. `deploy/session-prune.sh` (2 occurrences)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top
- Line 10: `INSTANCES_DIR="${INSTALL_DIR}/instances"`
- Comment (line 5): update

### 8. `deploy/host-alert.sh` (4 occurrences)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top
- Line 22: `CONFIG_FILE="${INSTALL_DIR}/openclaw/.env"`
- Line 23: `INSTANCES_DIR="${INSTALL_DIR}/instances"`
- Line 97: `for inst_dir in ${INSTALL_DIR}/instances/*/;` (backup freshness loop)
- Comment (line 5): update

### 9. `deploy/host-maintenance-check.sh` (1 occurrence)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top
- Line 11: `INSTANCES_DIR="${INSTALL_DIR}/instances"`

### 10. `deploy/build-openclaw.sh` (2 occurrences)

- Add `INSTALL_DIR="${INSTALL_DIR:-/home/openclaw}"` at top
- Line 14: `cd "${INSTALL_DIR}/openclaw"`
- Comment (line 11): update

### 11. `deploy/logrotate-openclaw` (2 path occurrences + 1 comment)

- Convert to template: `/home/openclaw/instances/` → `{{INSTALL_DIR}}/instances/`
- Comment (line 11): `/home/openclaw` → `{{INSTALL_DIR}}`
- `deploy-config.sh` will sed-substitute `{{INSTALL_DIR}}` when deploying

### 12. `deploy/vector/docker-compose.yml` (2 occurrences — comments only)

- Update usage hint comments: `/home/openclaw/vector` → `<INSTALL_DIR>/vector`

### 13. `scripts/update-openclaw.sh` (local script, 1 occurrence)

- Sources `openclaw-config.env` already (line 20)
- Line 23: `OPENCLAW_DIR="${INSTALL_DIR:-/home/openclaw}/openclaw"`

### 14. `scripts/update-sandboxes.sh` (no occurrences)

- No `/home/openclaw` paths — uses resolve-gateway.sh for container name. No changes needed.

### 15. `CLAUDE.md` (7 occurrences)

- Quick Reference SSH/Service Management section: `/home/openclaw/openclaw` → `<INSTALL_DIR>/openclaw`, `/home/openclaw/vector` → `<INSTALL_DIR>/vector`

### 16. Playbooks (7 files, ~98 occurrences)

Bulk replacement `/home/openclaw` → `<INSTALL_DIR>` in:

| File | Count |
|------|-------|
| `playbooks/04-vps1-openclaw.md` | ~28 |
| `playbooks/06-backup.md` | ~30 |
| `playbooks/07-verification.md` | ~24 |
| `playbooks/maintenance.md` | ~12 |
| `playbooks/08-post-deploy.md` | ~2 |
| `playbooks/02-base-setup.md` | ~1 |
| `playbooks/01-workers.md` | ~1 |

**Exception:** Keep literal `/home/openclaw` where it appears as a default value description or in explanatory text that says "default: `/home/openclaw`".

---

## Execution Order

1. `openclaw-config.env.example` (add INSTALL_DIR)
2. Deploy scripts (11 files) — update variable definitions and paths
3. `deploy/logrotate-openclaw` — convert to template
4. `scripts/update-openclaw.sh` — update remote path variable
5. `CLAUDE.md` — update Quick Reference
6. Playbooks (7 files) — bulk path replacement

---

## Verification

1. `grep -rn '/home/openclaw' deploy/ --include='*.sh' | grep -v 'INSTALL_DIR:-/home/openclaw' | grep -v '#'` — should return zero (all non-comment, non-default occurrences replaced)
2. `grep -rn '/home/openclaw' playbooks/` — should return zero (or only in "default" context)
3. `grep -c 'INSTALL_DIR' deploy/scripts/deploy-config.sh` — should be >10 (variable used throughout)
4. `grep 'INSTALL_DIR' deploy/scripts/setup-infra.sh` — present with fallback
5. `grep '{{INSTALL_DIR}}' deploy/logrotate-openclaw` — template placeholders present
6. Verify cron.d generation in deploy-config.sh includes `INSTALL_DIR=` env var line
7. `grep -rn '/home/openclaw' CLAUDE.md` — should return zero
