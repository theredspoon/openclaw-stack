/**
 * Extract the bearer token from Authorization or x-api-key header.
 * Returns the raw token string, or null if no token is present.
 */
export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization')
  if (authHeader) {
    if (!authHeader.startsWith('Bearer ')) return null
    return authHeader.slice(7)
  }

  return request.headers.get('x-api-key') ?? null
}

/**
 * Look up a user token in KV. Returns the userId or null if the token
 * is invalid/expired (expired tokens are auto-deleted by KV TTL).
 *
 * Handles provider-prefixed tokens: OpenClaw may send the gateway token
 * with a provider prefix prepended (e.g. "sk-ant-api03-xxxxx-GATEWAY_TOKEN").
 * If the full token isn't found in KV, the last dash-segment is tried.
 */
export async function authenticateRequest(
  request: Request,
  kv: KVNamespace
): Promise<string | null> {
  const token = extractToken(request)
  if (!token) return null

  // Try exact match first
  const userId = await kv.get(`token:${token}`)
  if (userId) return userId

  // Fallback: strip provider prefix (last dash-segment is the real token)
  if (token.includes('-')) {
    const lastSegment = token.split('-').pop()!
    return kv.get(`token:${lastSegment}`)
  }

  return null
}

/**
 * Validate the admin token from the request against the expected value.
 * Uses timing-safe comparison via SHA-256 digest.
 */
export async function validateAdminToken(
  request: Request,
  expectedToken: string
): Promise<boolean> {
  const token = extractToken(request)
  if (!token) return false
  return timingSafeEqual(token, expectedToken)
}

/** Constant-time string comparison via SHA-256 digest. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ])

  const viewA = new Uint8Array(digestA)
  const viewB = new Uint8Array(digestB)

  if (viewA.length !== viewB.length) return false

  let result = 0
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i]
  }
  return result === 0
}
