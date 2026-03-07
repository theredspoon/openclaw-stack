# Proposal: feat/manifest-gateway — Intelligent LLM Routing via Manifest.build

**Status:** Proposed
**Branch:** `feat/manifest-gateway` (not yet created)
**Depends on:** None (addable post-deployment, idempotent)

---

## Problem

The current AI Gateway Worker routes requests to a hardcoded set of providers (Anthropic, OpenAI, OpenAI-Codex). Adding a new provider requires code changes. There is no cost-optimizing or performance-optimizing routing — every request goes to the model the user specified, even if a cheaper or faster model could produce equivalent output.

---

## Goal

Add intelligent multi-provider routing via [Manifest.build](https://manifest.build) while keeping all provider API keys in Cloudflare KV (single source of truth). Manifest's 23-dimension scoring algorithm picks the best provider/model for each request in <2ms. All provider keys remain in the existing KV store — they are never stored by Manifest.

---

## Architecture

```
OpenClaw agent
  → Manifest plugin (openclaw.jsonc)
    → Manifest backend sidecar (Docker, VPS)
      [scores request, picks provider/model]
      → AI Gateway Worker (Cloudflare)
        [validates user auth, fetches provider key from KV]
        → Real provider API (Anthropic, OpenAI, etc.)
```

Key property: Manifest never sees real provider keys. Manifest stores the user's gateway auth token as its "API key" per provider. The Worker validates the token and fetches the real key from KV.

Pricing data: Manifest's `PricingSyncService` fetches from `https://openrouter.ai/api/v1/models` (OpenRouter public API, no auth required) on startup and daily. No Manifest cloud servers are in the data path. `MANIFEST_TELEMETRY_OPTOUT=1` removes the only optional cloud dependency.

---

## Provider Support

Manifest supports 11 providers. 9 are OpenAI-compatible (generic passthrough in the Worker). 2 need format adapters.

| Provider   | Format        | Worker handling    |
|------------|---------------|--------------------|
| openai     | OpenAI        | existing passthrough |
| deepseek   | OpenAI        | generic passthrough |
| mistral    | OpenAI        | generic passthrough |
| xai        | OpenAI        | generic passthrough |
| openrouter | OpenAI        | generic passthrough |
| ollama     | OpenAI        | generic passthrough |
| minimax    | OpenAI        | generic passthrough |
| moonshot   | OpenAI        | generic passthrough |
| zai        | OpenAI        | generic passthrough |
| anthropic  | Anthropic     | existing adapter   |
| google     | Gemini REST   | new adapter needed |

---

## Changes Required

### 1. Manifest fork/PR (`mnfst/manifest`)

File: `packages/backend/src/routing/proxy/provider-endpoints.ts`

For each of the 11 providers, change the hardcoded base URL to read from an env var with a fallback:

```typescript
// Before:
openai: { baseUrl: 'https://api.openai.com', ... }

// After:
openai: {
  baseUrl: process.env.MANIFEST_OPENAI_BASE_URL ?? 'https://api.openai.com',
  ...
}
```

~11 lines total. Submit as PR to upstream. If rejected, maintain as a fork — MIT licensed, no code outside `packages/backend` is affected.

Env vars needed (one per provider):
`MANIFEST_OPENAI_BASE_URL`, `MANIFEST_ANTHROPIC_BASE_URL`, `MANIFEST_GOOGLE_BASE_URL`,
`MANIFEST_DEEPSEEK_BASE_URL`, `MANIFEST_MISTRAL_BASE_URL`, `MANIFEST_XAI_BASE_URL`,
`MANIFEST_OPENROUTER_BASE_URL`, `MANIFEST_OLLAMA_BASE_URL`, `MANIFEST_MINIMAX_BASE_URL`,
`MANIFEST_MOONSHOT_BASE_URL`, `MANIFEST_ZAI_BASE_URL`

---

### 2. Worker changes (`workers/ai-gateway/`)

#### `routing.ts`

Add a generic dynamic route pattern alongside the existing static routes:

```
/proxy/{provider}/v1/chat/completions   POST
/proxy/{provider}/v1/responses          POST
/proxy/{provider}/v1/embeddings         POST
/proxy/{provider}/v1/models             GET
```

The `{provider}` segment becomes the lookup key. `matchProviderRoute` needs to handle this wildcard pattern for the new `/proxy/` prefix. Existing static routes (`/anthropic/`, `/openai/`, `/openai-codex/`) remain unchanged for backward compatibility.

The `Provider` type should be widened to `string` for the generic path, or a separate `GenericProvider` type introduced.

#### `config.ts`

Replace the hardcoded switch with KV lookup, falling back to known defaults:

```typescript
// KV key: `provider-config:{provider}` → JSON { baseUrl: string }
export async function getProviderConfig(
  provider: string,
  kv: KVNamespace
): Promise<ProviderConfig> {
  const override = await kv.get(`provider-config:${provider}`)
  if (override) return JSON.parse(override)
  return PROVIDER_DEFAULTS[provider] ?? { baseUrl: '' }
}
```

`PROVIDER_DEFAULTS` contains the 11 real provider URLs as a fallback lookup table so the Worker works without KV overrides if needed.

#### `keys.ts`

Extend `getProviderApiKey` to handle generic providers:

```typescript
// Existing: creds.anthropic.apiKey, creds.openai.apiKey
// New: creds.providers?.[provider]?.apiKey

if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openai-codex') {
  const key = creds.providers?.[provider]?.apiKey
  if (!key) log.warn(`[keys] no credentials found for provider ${provider}`)
  return key
}
```

KV credential schema addition:
```json
{
  "providers": {
    "deepseek": { "apiKey": "..." },
    "mistral":  { "apiKey": "..." }
  }
}
```

#### `providers/generic.ts` (new)

Thin OpenAI-compatible passthrough for the 9 generic providers. Nearly identical to the existing `openai.ts` but without any OpenAI-specific header handling:

```typescript
export async function proxyGeneric(
  apiKey: string,
  request: Request,
  config: ProviderConfig,
  path: string,
  log: Log,
  preReadBody?: string
): Promise<Response>
```

#### `providers/google.ts` (new)

Gemini REST format adapter. Translates OpenAI-format chat completions to Gemini's `generateContent` API format and back. Key differences:
- URL: `/v1beta/models/{model}:generateContent` (streaming: `:streamGenerateContent`)
- Auth: `?key={apiKey}` query param (not a header)
- Request body: `{ contents: [...], generationConfig: {...} }` (not `messages`)
- Response body: `{ candidates: [{ content: { parts: [...] } }] }` (not `choices`)

This is the most complex adapter. Streaming support requires translating SSE chunks from Gemini's format to OpenAI's format.

#### `index.ts`

Wire up the new `/proxy/` route prefix:

```typescript
// After existing route match fails, try generic proxy route
const genericRoute = matchGenericRoute(request.method, pathname)
if (genericRoute) {
  // same auth + key lookup + dispatch flow, using proxyGeneric or proxyAnthropic/Google
}
```

---

### 3. Docker Compose (`docker-compose.yml.hbs`)

Add a `manifest-backend` service alongside openclaw:

```yaml
manifest-backend:
  image: ghcr.io/mnfst/manifest:latest  # or self-built from fork
  restart: unless-stopped
  environment:
    - MANIFEST_MODE=local
    - MANIFEST_TELEMETRY_OPTOUT=1
    - MANIFEST_OPENAI_BASE_URL=${GATEWAY_URL}/proxy/openai/v1
    - MANIFEST_ANTHROPIC_BASE_URL=${GATEWAY_URL}/proxy/anthropic/v1
    - MANIFEST_GOOGLE_BASE_URL=${GATEWAY_URL}/proxy/google/v1
    - MANIFEST_DEEPSEEK_BASE_URL=${GATEWAY_URL}/proxy/deepseek/v1
    - MANIFEST_MISTRAL_BASE_URL=${GATEWAY_URL}/proxy/mistral/v1
    - MANIFEST_XAI_BASE_URL=${GATEWAY_URL}/proxy/xai/v1
    - MANIFEST_OPENROUTER_BASE_URL=${GATEWAY_URL}/proxy/openrouter/v1
    - MANIFEST_OLLAMA_BASE_URL=${GATEWAY_URL}/proxy/ollama/v1
    - MANIFEST_MINIMAX_BASE_URL=${GATEWAY_URL}/proxy/minimax/v1
    - MANIFEST_MOONSHOT_BASE_URL=${GATEWAY_URL}/proxy/moonshot/v1
    - MANIFEST_ZAI_BASE_URL=${GATEWAY_URL}/proxy/zai/v1
  networks:
    - openclaw-net
  ports:
    - "127.0.0.1:3000:3000"
```

`MANIFEST_MODE=local` disables API key validation on the Manifest side (the Worker handles auth). The Manifest backend is stateless — no volumes needed. SQLite (used for pricing data) can be ephemeral; pricing re-syncs from OpenRouter on startup.

---

### 4. OpenClaw config (`openclaw.jsonc` template)

Add the Manifest plugin in the claw's plugin list:

```jsonc
{
  "plugins": [
    {
      "name": "manifest",
      "endpoint": "http://localhost:3000",
      "apiKey": "${OPENCLAW_GATEWAY_TOKEN}",
      "mode": "auto"   // or "manual" to keep explicit model selection
    }
  ]
}
```

The gateway token (`OPENCLAW_GATEWAY_TOKEN`) is already in the claw's environment. It serves as Manifest's "API key" per provider — the Worker uses it to look up the real provider key.

---

### 5. Config UI (`workers/ai-gateway/src/config-ui/`)

The `/config` page already lists Anthropic and OpenAI credential fields. Extend it to show fields for each of the 11 providers. Since the provider list is now dynamic (read from KV), the UI should either:

- List all providers the Worker knows about (from `PROVIDER_DEFAULTS` keys), or
- Let the user add arbitrary provider/key pairs

This is a UI enhancement, not a blocker for the core feature.

---

## Auth Flow (detailed)

1. User configures provider keys via `/config` UI or `/auth/creds` API — stored in KV under `creds:{userId}`
2. Manifest plugin in OpenClaw is configured with `apiKey: "${OPENCLAW_GATEWAY_TOKEN}"`
3. When Manifest routes a request to, say, DeepSeek:
   - Manifest calls `${GATEWAY_URL}/proxy/deepseek/v1/chat/completions`
   - Uses the gateway token as the `Authorization: Bearer` header
4. Worker receives the request:
   - Validates the gateway token → resolves `userId`
   - Looks up `creds:{userId}` from KV → finds `creds.providers.deepseek.apiKey`
   - Calls DeepSeek API with the real key
5. DeepSeek responds → Worker returns to Manifest → Manifest returns to OpenClaw

---

## Fork Strategy

If the Manifest base URL PR is not merged upstream:

1. Fork `mnfst/manifest` to `{org}/manifest`
2. Apply the ~11-line change to `provider-endpoints.ts`
3. Update `docker-compose.yml.hbs` to build from the fork or use a fork-built image
4. The fork only diverges by ~11 lines — easy to rebase on upstream releases

No Manifest cloud servers are in the data path in either case. The only optional cloud touch point is telemetry, disabled by `MANIFEST_TELEMETRY_OPTOUT=1`.

---

## Phased Implementation

### Phase 1: Worker generalization (no Manifest yet)

Implement the dynamic `/proxy/{provider}/` routes, KV-based base URL config, generic passthrough, and extended key lookup. This makes the Worker open-ended (any provider, not just the hardcoded 3) independently of Manifest.

Benefit: multi-provider support is live immediately. Users can add DeepSeek, Mistral, etc. keys via the config UI and use them directly from OpenClaw without the routing layer.

### Phase 2: Manifest integration

Add the Manifest sidecar, openclaw.jsonc plugin config, and Manifest PR/fork. This adds the routing intelligence on top of Phase 1.

### Phase 3: Google adapter (optional)

Implement the Gemini format adapter if Google models are a priority. The generic passthrough works for all other providers. Google can be deferred or proxied through OpenRouter (which normalizes it to OpenAI format) as an interim.

---

## Open Questions

1. **Docker image source**: Use the official `ghcr.io/mnfst/manifest` image with env var overrides, or build from fork? The env var approach only works if the PR is merged. Fork requires maintaining a Docker image.

2. **Manifest SQLite**: The pricing sync service writes to a SQLite DB. With `MANIFEST_MODE=local`, is SQLite still required? If so, the service needs a volume or tmpfs mount. Needs verification.

3. **Streaming**: Manifest's routing decision happens before the upstream call. Streaming responses from the real provider are passed through. Verify Manifest correctly streams SSE from the chosen provider.

4. **Google adapter complexity**: Full OpenAI↔Gemini translation is non-trivial (especially streaming). Consider deferring to Phase 3 and using OpenRouter as a Gemini proxy in the meantime.

5. **Manifest plugin API**: The openclaw-plugin for Manifest calls `/api/v1/routing/resolve` to get a routing decision, then makes the completion call separately. The plugin source should be read before finalizing the openclaw.jsonc config schema.
