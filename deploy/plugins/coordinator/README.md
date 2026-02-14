# Coordinator Plugin

Builds a sub-agent routing table and writes it to the coordinator agent's `AGENTS.md` workspace file, enabling capability-based task delegation via the system prompt.

## Why

The coordinator pattern splits agents by capability: a main agent handles conversation and delegates skill-based tasks to specialized sub-agents. This plugin automates the routing — it writes a routing table to `AGENTS.md` so the coordinator knows exactly which sub-agent handles each skill.

## How It Works

1. Gateway loads the plugin from `~/.openclaw/extensions/coordinator/`
2. At **registration time**, the plugin writes a routing section to:
   - The template workspace `AGENTS.md` (so new sandboxes inherit it)
   - The coordinator agent's existing sandbox `AGENTS.md` (for immediate effect)
3. OpenClaw's native workspace file injection loads `AGENTS.md` into the **system prompt**
4. The coordinator uses `sessions_spawn` to delegate skill tasks to the right sub-agent
5. On `before_agent_start`, the plugin also writes to `ctx.workspaceDir` to catch any new sandboxes created between restarts

### Why AGENTS.md?

OpenClaw only injects a [hardcoded list of workspace files](https://github.com/openclaw/openclaw/blob/main/src/agents/workspace.ts) into the system prompt (AGENTS.md, SOUL.md, TOOLS.md, etc.). Custom filenames like `ROUTING.md` are not auto-discovered. AGENTS.md is the natural home for agent instructions and routing context.

The routing section is wrapped in HTML comment sentinels (`<!-- coordinator-plugin:start -->` / `<!-- coordinator-plugin:end -->`) so it can be updated without disturbing user content.

### Skill Filtering

Per-agent skill filtering is configured in `openclaw.json` via `agents.list[].skills`:
- `"skills": []` — agent sees no skills (pure coordinator)
- `"skills": ["gifgrep", "weather"]` — agent only sees listed skills

The plugin's `routes` config should mirror these skill assignments.

## Plugin Files

| File | Purpose |
|------|---------|
| `openclaw.plugin.json` | Plugin manifest — `id`, `name`, `version`, and `configSchema` |
| `index.js` | Plugin logic — writes routing table to AGENTS.md at registration and via hook |

## Configuration

Configuration lives in **`openclaw.json`**, not in the plugin directory.

```json5
{
  "plugins": {
    "enabled": true,
    "allow": ["coordinator"],
    "entries": {
      "coordinator": {
        "enabled": true,
        "config": {
          "coordinatorAgent": "main",
          "routes": [
            { "id": "code", "name": "Code Agent", "skills": ["coding-agent", "github", "clawhub", "skill-creator"] },
            { "id": "skills", "name": "Skills Agent", "skills": ["gifgrep", "weather", "..."] }
          ]
        }
      }
    }
  }
}
```

### Config fields

- **`coordinatorAgent`** — Agent ID that acts as coordinator (default: `"main"`)
- **`routes`** — Sub-agent routing table:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Sub-agent ID (e.g. `"skills"`) |
| `name` | string | Display name (e.g. `"Skills Agent"`) |
| `skills` | string[] | Skills this sub-agent handles |

## Adding a New Skill

1. Install the skill globally (e.g. `~/.openclaw/skills/jira/`)
2. Add `"jira"` to the appropriate agent's `"skills"` array in `openclaw.json`
3. Add `"jira"` to the same agent's entry in `plugins.entries.coordinator.config.routes`
4. Restart gateway — plugin writes updated routing to AGENTS.md automatically
5. Clear session caches if needed (see below)

Steps 2 and 3 are manual — deciding which agent handles the new skill and keeping the routes in sync.

## Deployment

The entrypoint (section 1h) copies this plugin from `/app/deploy/plugins/coordinator/` to `~/.openclaw/extensions/coordinator/` on boot. The compose override bind-mounts `deploy/plugins/` read-only into the container.

To update after changes: SCP to VPS, restart the gateway.

## Session Cache

After changing skill filters, clear session caches to force a skill snapshot rebuild:
```bash
docker exec openclaw-gateway sh -c 'find /home/node/.openclaw/agents -name "sessions.json" -exec sh -c '"'"'echo "{}" > "$1"'"'"' _ {} \;'
```

## Technical Notes

- **Routes are static** — defined in plugin config, not read from `api.runtime` (which only exposes `loadConfig`/`writeConfigFile` functions, not agent data)
- **AGENTS.md is written at registration time** — before any messages, so the system prompt has routing context from the first interaction
- **The `before_agent_start` hook** is kept as a fallback to catch new sandboxes created after registration
- **No `prependContext`** — earlier versions used `prependContext` which polluted the user message bubble in the chat UI. The AGENTS.md approach puts routing in the system prompt cleanly.
