# How OpenClaw Requests Work

OpenClaw is composed of two main components:

1. Gateway
2. Agents

The gateway runs as the main docker container on the VPS. It's job is to provide an HTTP server
for the API and the webchat (ControlUI / Dashboard).

When the gateway receives a new user request on a channel (Telegram, webchat, etc.), it builds a LLM prompt:

- Skills, tools, AGENTS.md, SOUL.md, etc as the system prompt
- User messages for the entire chat session

Under the hood, it's using pi-ai's messaging system for both the LLM calls and internal messaging between agents.

See [OpenClaw Agent Runtime](https://docs.openclaw.ai/concepts/agent)

When the gateway is done processing the inbound message (assembling all the prompt details), it sends the request to the LLM.

---
The session key pattern tells the story: agent:<agentId>:<source>

- agent:main:main — main agent handling a direct user request
- agent:code:main — code agent, spawned from main
- agent:skills:main — skills agent, spawned from main

  Each agent gets its own complete context:

  When main delegates to code (via sessions_spawn), the gateway bootstraps a completely new LLM session for the code agent
  with:

- Its own workspace: /home/node/.openclaw/sandboxes/agent-code-d70aca26/
- Its own AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, etc.
- Its own tool permissions, sandbox config (image, network, memory)
- A fresh system prompt built from all of the above

  So yes — your understanding is correct. The delegation isn't a "context switch" within the same LLM conversation. It's the
  gateway creating an entirely new LLM session with the target agent's full config as the system prompt, running the task to
  completion, and then announcing the result back to the main agent's conversation.

  The main agent never "becomes" the code agent. It calls sessions_spawn, the gateway runs a parallel session with the code
  agent's identity, and the result flows back
  ---

Request Flow

1. Every user message goes to the main agent  — there's no "gateway-only" mode for simple chat. The session key is always
agent:main:main, meaning the gateway immediately routes to the main agent config.
2. The gateway process makes all LLM API calls itself — agents aren't separate processes. An "agent" is just a configuration
profile (sandbox image, network, memory limits, env vars). The gateway's embedded runtime (pi-agent-core) calls the LLM API
directly.
3. Sandbox containers are for tool execution only — when the LLM response includes tool calls (exec, read, write, browser,
etc.), the gateway runs them inside the agent's sandbox container via docker exec. The LLM itself is never inside the
sandbox.
4. Subagents are spawned by the main agent via the sessions_spawn tool. The debug logs show:

- agent=code source=main — the code agent was spawned from main
- agent=skills source=main — same for skills

The skill-router plugin rewrites prompts so the LLM knows to delegate (e.g., gifgrep tasks → skills agent).

## Overview Flow

```text
  User message → Gateway → always routes to "main" agent config
                            → Gateway calls LLM API
                            → Tool calls? → docker exec in main's sandbox
                            → LLM decides to delegate? → sessions_spawn → new agent config (code/skills)
                                                         → Gateway calls LLM again with that agent's context
                                                         → Tool calls? → docker exec in that agent's sandbox
```

The gateway is the single brain. Agents are just isolated sandboxes for tool execution with different permissions.

The gateway reads the MD files directly from the host filesystem (inside the gateway container) at
  /home/node/.openclaw/sandboxes/agent-main-0d71ad7a/, loads their contents, and injects them into the system prompt when
  making LLM API calls. The sandbox never reads them itself — it's just sleep infinity.

  The bind mount (/home/node/.openclaw/sandboxes/agent-main-0d71ad7a → /workspace) exists so that when the LLM uses tools like
  read, write, or exec inside the sandbox, the agent can access and modify those files (e.g., updating MEMORY.md). But the
  initial loading into the prompt is done by the gateway process, not by anything running in the sandbox.
