import type { Env, Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/** Proxy the request to Anthropic via AI Gateway. */
export async function proxyAnthropic(
  apiKey: string,
  request: Request,
  env: Env,
  gwPath: string,
  log: Log
): Promise<Response> {
  const url = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/${gwPath}`

  const headers = new Headers()

  // Set Cloudflare Gateway auth token
  headers.set('cf-aig-authorization', `Bearer ${env.CF_AI_GATEWAY_TOKEN}`)

  // Merge request headers, skipping auth and cf-* headers
  for (const [key, value] of request.headers) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key' || lower.startsWith('cf-')) continue
    if (!headers.has(key)) headers.set(key, value)
  }

  // Ensure anthropic-version is set
  if (!headers.has('anthropic-version')) {
    headers.set('anthropic-version', DEFAULT_ANTHROPIC_VERSION)
  }

  if (apiKey.startsWith('sk-ant-oat')) {
    // Using OAuth token
    headers.set('authorization', `Bearer: ${apiKey}`)
    log.debug(`[anthropic] Using OAuth Token: ${apiKey.substring(0, 10)}...`)
  } else {
    // Using regular API key
    headers.set('x-api-key', apiKey)
    log.debug(`[anthropic] Using API key: ${apiKey.substring(0, 10)}...`)
  }

  const body = await request.text()

  log.debug('[anthropic] upstream headers', sanitizeHeaders(headers))
  log.debug('[anthropic] request body', truncateBody(body))

  return fetch(url, {
    method: 'POST',
    headers,
    body,
  })
}
