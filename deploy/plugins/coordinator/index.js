// Coordinator Plugin
// Builds a sub-agent routing table from plugin config and writes it to the
// coordinator agent's AGENTS.md workspace file. OpenClaw's native workspace
// file injection loads it into the system prompt — no user message pollution.
//
// Writes to both the template workspace (for new sandboxes) and the active
// sandbox (for immediate effect). Uses HTML comment sentinels to manage
// the routing section without disturbing user content.
//
// Config (in openclaw.json -> plugins.entries.coordinator.config):
//   coordinatorAgent: agent ID that acts as coordinator (default: "main")
//   routes: static routes array [{ id, name, skills }]

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Sentinel markers for the routing section in AGENTS.md
const ROUTING_START = '<!-- coordinator-plugin:start -->'
const ROUTING_END = '<!-- coordinator-plugin:end -->'

function buildRoutingSection(routes) {
  const table = routes
    .map(r => `- **${r.name}** (agentId: \`${r.id}\`): ${r.skills.join(', ')}`)
    .join('\n')

  return (
    `${ROUTING_START}\n` +
    `## Sub-Agent Routing\n\n` +
    `You are a coordinator. You do NOT have skill binaries installed.\n` +
    `When a task requires a skill listed below, delegate to the appropriate ` +
    `sub-agent using \`sessions_spawn\`.\n` +
    `Handle conversation, questions, and general chat directly.\n\n` +
    `### Sub-Agents\n${table}\n\n` +
    `### Delegation\n` +
    `Use \`sessions_spawn\` with the sub-agent's \`agentId\` and include the ` +
    `user's full request.\nWait for the result and relay it to the user.\n` +
    `${ROUTING_END}`
  )
}

function updateAgentsMd(filePath, routingSection, logger) {
  let content = ''
  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf-8')
  }

  // Check if routing section already exists and matches
  const startIdx = content.indexOf(ROUTING_START)
  const endIdx = content.indexOf(ROUTING_END)

  if (startIdx >= 0 && endIdx >= 0) {
    const existing = content.slice(startIdx, endIdx + ROUTING_END.length)
    if (existing === routingSection) {
      return false // unchanged
    }
    // Replace existing section
    content = content.slice(0, startIdx) + routingSection + content.slice(endIdx + ROUTING_END.length)
  } else {
    // Append routing section
    content = content.trimEnd() + '\n\n' + routingSection + '\n'
  }

  writeFileSync(filePath, content, 'utf-8')
  return true // written
}

// Gateway package.json has "type": "module" — plugins must use ESM exports
export default {
  id: 'coordinator',

  register(api) {
    const coordinatorAgent = api.pluginConfig?.coordinatorAgent || 'main'
    const routes = api.pluginConfig?.routes || []

    if (routes.length === 0) {
      api.logger.warn('[coordinator] No routes configured')
      return
    }

    const routingSection = buildRoutingSection(routes)

    // Write to template workspace at registration time so new sandboxes inherit it.
    // Also write to existing coordinator sandbox(es) for immediate effect.
    const ocDir = join(api.resolvePath('~'), '.openclaw')

    // 1. Template workspace
    const templateAgents = join(ocDir, 'workspace', 'AGENTS.md')
    try {
      if (updateAgentsMd(templateAgents, routingSection, api.logger)) {
        api.logger.info('[coordinator] Updated template workspace AGENTS.md')
      }
    } catch (e) {
      api.logger.warn(`[coordinator] Failed to update template AGENTS.md: ${e.message}`)
    }

    // 2. Existing sandboxes for the coordinator agent
    const sandboxesDir = join(ocDir, 'sandboxes')
    try {
      if (existsSync(sandboxesDir)) {
        const prefix = `agent-${coordinatorAgent}-`
        for (const entry of readdirSync(sandboxesDir)) {
          if (entry.startsWith(prefix)) {
            const sandboxAgents = join(sandboxesDir, entry, 'AGENTS.md')
            if (updateAgentsMd(sandboxAgents, routingSection, api.logger)) {
              api.logger.info(`[coordinator] Updated sandbox AGENTS.md: ${entry}`)
            }
          }
        }
      }
    } catch (e) {
      api.logger.warn(`[coordinator] Failed to update sandbox AGENTS.md files: ${e.message}`)
    }

    // Hook is still registered to catch new sandboxes that might be created
    // between registration and the next restart
    api.on('before_agent_start', async (event, ctx) => {
      if (ctx.agentId !== coordinatorAgent) return
      if (!ctx.workspaceDir) return

      try {
        if (updateAgentsMd(join(ctx.workspaceDir, 'AGENTS.md'), routingSection, api.logger)) {
          api.logger.info('[coordinator] Updated AGENTS.md via hook (new sandbox)')
        }
      } catch (e) {
        api.logger.warn(`[coordinator] Hook failed to update AGENTS.md: ${e.message}`)
      }
    })

    api.logger.info(`[coordinator] Plugin registered (${routes.length} routes, agent: ${coordinatorAgent})`)
  }
}
