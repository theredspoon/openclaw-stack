# Plan: Refactor scripts/ into BubbleTea CLI (Phase 1)

## Context

The `scripts/` directory has 19 individual bash scripts for managing OpenClaw instances. Now that multi-claw support is implemented, invoking individual scripts with `--instance` flags is cumbersome. We're building a unified Go TUI using [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) that replaces the TypeScript CLI and consolidates claw-level scripts into a single interactive tool.

**Phase 1 scope:** Framework, claw picker, action menu, and two actions (Logs + SSH). No scripts deleted.

Phase 1 has been implemented. Phase 2 and 3 still need implementing.

**Binary name:** `claw`

---

## Menu Tree (all phases)

```
claw (CLI entry)
│
├─ [auto] Detect claws from deploy/openclaws/
│    If multiple → Claw Picker
│    If single   → skip to Action Menu
│
└─ Action Menu ──────────────────────────────────
   │
   │  Phase 1 (this plan)
   ├── Logs             exec: docker logs --tail 100 -f <project_name>-openclaw-<name>
   ├── SSH              exec: docker exec -it -u node <project_name>-openclaw-<name> bash
   │
   │  Phase 2
   ├── Health           openclaw health / doctor / status
   ├── Restart          docker compose restart <project_name>-openclaw-<name>
   ├── OpenClaw ►       submenu
   │   ├── Config       openclaw config get/set/schema
   │   ├── Models       openclaw models list/set/aliases
   │   ├── Channels     openclaw channels list/status/logs
   │   ├── Agent        openclaw agent --message
   │   ├── Skills       openclaw skills list
   │   ├── Sessions     openclaw sessions
   │   ├── Scheduler    openclaw cron list/add/run/remove
   │   ├── Nodes        openclaw nodes list/pending
   │   └── Security     openclaw security audit
   │
   │  Phase 3
   ├── Update ►         submenu
   │   ├── OpenClaw     git pull + rebuild + up -d
   │   ├── Sandboxes    force-rebuild sandbox images
   │   └── Toolkit      sync toolkit + rebuild
   ├── Sandboxes ►      submenu
   │   ├── Restart      remove + recreate sandbox containers
   │   ├── Agent SSH    pick agent → SSH into sandbox
   │   └── Browser      start browser container for agent
   ├── Session Logs     interactive session transcript viewer
   ├── Sync Media       rsync /home/openclaw/instances/<name>/.openclaw/media/
   ├── Backups ►        submenu
   │   ├── Run          run manual backup
   │   ├── List         list backups
   │   └── View Log     backup log + cron
   └── Infrastructure ► submenu
       ├── Firewall     ufw status
       ├── Disk         df -h
       └── Resources    free -h + uptime
```

**Not migrated** (stay as standalone scripts — VPS-level, not claw-level):

- `ssh-vps.sh` — direct SSH to VPS host
- `logs-docker.sh` — all Docker container logs
- `telegram-test.sh` — test Telegram alerting

---

## Phase 1 Implementation

### Project structure

```
cli/
├── go.mod                    # module: github.com/openclaw/vps-beast/cli
├── main.go                   # entry point
└── internal/
    ├── config/
    │   └── config.go         # load openclaw-config.env + discover claws
    ├── ssh/
    │   └── ssh.go            # build SSH exec.Cmd (stream, interactive)
    └── tui/
        ├── model.go          # root tea.Model, state machine
        ├── claw_picker.go    # claw selection (bubbles/list)
        └── action_menu.go    # action menu (bubbles/list)
```

### Key design decisions

1. **Claw discovery is LOCAL** — Read `deploy/openclaws/` directories (skip `_` prefixed). Same logic as `discover_instances()` in `openclaw-multi.sh`. Works even when VPS is offline.

2. **Shell handoff via `tea.ExecProcess`** — When user picks Logs or SSH, BubbleTea suspends the TUI, gives full terminal control to the SSH subprocess, then resumes the TUI when the process exits. This is BubbleTea's built-in pattern for interactive subprocesses.

3. **Config loading** — Parse `openclaw-config.env` for SSH credentials (`VPS1_IP`, `SSH_KEY_PATH`, `SSH_USER`, `SSH_PORT`). Same env file parser pattern as current code.

4. **Binary name: `claw`** — clear, short, descriptive. Run from project root: `go run ./cli` or `./claw`.

### Files to create

#### `cli/go.mod`

- Module path, Go 1.22+
- Dependencies: `github.com/charmbracelet/bubbletea`, `github.com/charmbracelet/bubbles`, `github.com/charmbracelet/lipgloss`

#### `cli/main.go`

- Find project root (walk up looking for `openclaw-config.env`)
- Load config
- Discover claws from `deploy/openclaws/`
- Launch BubbleTea program with initial state based on claw count

#### `cli/internal/config/config.go`

- `type Config struct` — SSH fields + project root path
- `LoadConfig(projectRoot string) (Config, error)` — parse env file, validate required fields, resolve `~` in SSH_KEY_PATH
- `DiscoverClaws(projectRoot string) ([]string, error)` — read `deploy/openclaws/`, filter `_` prefixed, return sorted list

#### `cli/internal/ssh/ssh.go`

- `StreamCmd(cfg Config, container string) *exec.Cmd` — builds `ssh ... "sudo docker logs --tail 100 -f <container>"` command
- `InteractiveCmd(cfg Config, container string) *exec.Cmd` — builds `ssh -t ... "sudo docker exec -it -u node <container> bash"` command
- Common `sshArgs(cfg) []string` helper

#### `cli/internal/tui/model.go`

- Root model with state enum: `statePicking`, `stateMenu`, `stateRunning`
- Holds selected claw name, config, list of claws
- Routes to claw_picker or action_menu based on state
- Handles `tea.ExecProcess` callbacks to return to menu after SSH exits

#### `cli/internal/tui/claw_picker.go`

- Uses `bubbles/list` component
- Items are claw names (e.g., "main-claw", "test-claw")
- On select → transition to `stateMenu`

#### `cli/internal/tui/action_menu.go`

- Uses `bubbles/list` component
- Items: "Logs", "SSH" (Phase 1), more in future phases
- On select → return `tea.ExecProcess` cmd with appropriate SSH command
- After process exits → return to action menu

### Files to delete

- All files under `cli/` (the current TypeScript CLI): `package.json`, `package-lock.json`, `tsconfig.json`, `cli.mjs`, `src/**/*.ts`, `README.md`

### SSH command patterns (replicated from bash scripts)

**Logs** (same as `logs-openclaw.sh`):

```
TERM=xterm-256color ssh -i <key> -p <port> <user>@<ip> "sudo docker logs --tail 100 -f <project_name>-openclaw-<name>"
```

**SSH** (same as `ssh-gateway.sh`):

```
TERM=xterm-256color ssh -t -i <key> -p <port> <user>@<ip> "sudo docker exec -it -u node <project_name>-openclaw-<name> bash"
```

---

## Verification

1. `cd cli && go build -o ../claw .` — compiles
2. `./claw` with 2+ claws in `deploy/openclaws/` → shows claw picker
3. Select a claw → shows action menu with Logs and SSH options
4. Select Logs → streams logs from VPS, Ctrl+C returns to menu
5. Select SSH → opens interactive shell in container, `exit` returns to menu
6. `q` or Ctrl+C from menus → clean exit
7. With only 1 claw → skips picker, goes straight to action menu
