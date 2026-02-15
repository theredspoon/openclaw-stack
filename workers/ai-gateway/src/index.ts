import { validateAuthToken } from './auth'
import { handlePreflight, addCorsHeaders } from './cors'
import { jsonError } from './errors'
import { createLog, logInboundRequest } from './log'
import { matchProviderRoute } from './routing'
import { getProviderApiKey } from './keys'
import { proxyOpenAI } from './providers/openai'
import { proxyAnthropic } from './providers/anthropic'
import type { Env } from './types'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return handlePreflight()
    }

    const { pathname } = new URL(request.url)

    // Health check — no auth required
    if (request.method === 'GET' && pathname === '/health') {
      return addCorsHeaders(
        new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        })
      )
    }

    const log = createLog(env)

    // Auth check for all other routes
    const authToken = await validateAuthToken(request, env.AUTH_TOKEN)
    if (!authToken) {
      return addCorsHeaders(jsonError('Invalid or missing auth credentials', 401))
    }

    // Route to provider
    const route = matchProviderRoute(request.method, pathname)
    if (!route) {
      return addCorsHeaders(jsonError('Not found', 404))
    }

    const apiKey = getProviderApiKey(route.provider, authToken, env)

    if (env.LOG_LEVEL === 'debug') {
      logInboundRequest(log, request, route, apiKey)
    }

    if (!authToken) {
      return addCorsHeaders(jsonError('Invalid or missing auth credentials', 401))
    }

    let response: Response
    if (route.provider === 'anthropic') {
      response = await proxyAnthropic(apiKey, request, env, route.path, log)
    } else {
      response = await proxyOpenAI(apiKey, request, env, route.path, log)
    }
    return addCorsHeaders(response)
  },
} satisfies ExportedHandler<Env>
