export type Provider = 'anthropic' | 'openai'

export interface RouteMatch {
  provider: Provider
  path: string
}

/** Method allowed per provider-prefixed route (pathname without leading slash). */
const ROUTES: Record<string, string> = {
  // Anthropic
  'anthropic/v1/messages': 'POST',
  // OpenAI
  'openai/v1/chat/completions': 'POST',
  'openai/v1/embeddings': 'POST',
  'openai/v1/models': 'GET',
}

/** AI Gateway sub-path: strip /v1/ segment → provider/rest */
function toGatewayPath(route: string): string {
  return route.replace('/v1/', '/')
}

/** Match a request to a provider route, returning the provider and AI Gateway sub-path. */
export function matchProviderRoute(method: string, pathname: string): RouteMatch | null {
  // Strip leading slash to match route keys
  const key = pathname.startsWith('/') ? pathname.slice(1) : pathname
  const allowed = ROUTES[key]
  if (!allowed || allowed !== method) return null

  const provider = key.split('/')[0] as Provider
  return { provider, path: toGatewayPath(key) }
}
