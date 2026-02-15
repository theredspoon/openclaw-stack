import type { Env, Log } from '../types'
import { sanitizeHeaders, truncateBody } from '../log'

/** Proxy the request to OpenAI via AI Gateway. */
export async function proxyOpenAI(
  apiKey: string,
  request: Request,
  env: Env,
  gwPath: string,
  log: Log
): Promise<Response> {
  const url = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/${gwPath}`

  const headers = new Headers(request.headers)
  // Replace auth token with OpenAI API key
  headers.set('Authorization', `Bearer ${apiKey}`)
  // Authenticate to Cloudflare AI Gateway
  headers.set('cf-aig-authorization', `Bearer ${env.CF_AI_GATEWAY_TOKEN}`)

  const body = await request.text()
  log.debug('[openai] upstream headers', sanitizeHeaders(headers))
  log.debug('[openai] request body', truncateBody(body))

  return fetch(url, {
    method: request.method,
    headers,
    body,
  })
}
