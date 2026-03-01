import type { Log } from './types'
import type { UserCredentials, UserEntry, UsersRegistry } from './types'
import { jsonError } from './errors'

/** Generate a random hex string of the given byte length. */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('')
}

/** Read the users registry from KV, returning an empty object if missing. */
async function getRegistry(kv: KVNamespace): Promise<UsersRegistry> {
  const raw = await kv.get('users')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Write the users registry back to KV. */
async function putRegistry(kv: KVNamespace, registry: UsersRegistry): Promise<void> {
  await kv.put('users', JSON.stringify(registry))
}

// Path patterns for admin routes
const USER_CREDS_RE = /^\/admin\/users\/([^/]+)\/creds$/
const USER_ID_RE = /^\/admin\/users\/([^/]+)$/

/**
 * Handle all /admin/* requests. Caller has already validated the admin token.
 */
export async function handleAdminRequest(
  request: Request,
  pathname: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  // POST /admin/users — create user
  if (request.method === 'POST' && pathname === '/admin/users') {
    return createUser(request, kv, log)
  }

  // GET /admin/users — list users
  if (request.method === 'GET' && pathname === '/admin/users') {
    return listUsers(kv)
  }

  // PUT /admin/users/:id/creds — update credentials
  const credsMatch = pathname.match(USER_CREDS_RE)
  if (request.method === 'PUT' && credsMatch) {
    return updateUserCreds(request, credsMatch[1], kv, log)
  }

  // DELETE /admin/users/:id — delete user
  const deleteMatch = pathname.match(USER_ID_RE)
  if (request.method === 'DELETE' && deleteMatch) {
    return deleteUser(deleteMatch[1], kv, log)
  }

  return jsonError('Not found', 404)
}

/**
 * Handle POST /auth/rotate — generate a new token, expire old ones in 1 hour.
 * Caller has already authenticated the user.
 */
export async function handleTokenRotation(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const registry = await getRegistry(kv)
  const user = registry[userId]
  if (!user) {
    return jsonError('User not found', 404)
  }

  const newToken = randomHex(24)
  const expiresInSeconds = 3600 // 1 hour

  // Create new token mapping (no TTL — permanent until rotated)
  await kv.put(`token:${newToken}`, userId)

  // Set TTL on all old tokens (they'll auto-delete after 1 hour)
  const oldTokens = user.tokens
  const expireAt = Math.floor(Date.now() / 1000) + expiresInSeconds
  for (const oldToken of oldTokens) {
    await kv.put(`token:${oldToken}`, userId, { expiration: expireAt })
  }

  // Update registry with new token appended
  user.tokens = [...oldTokens, newToken]
  registry[userId] = user
  await putRegistry(kv, registry)

  log.info(`[admin] rotated token for user ${userId}, ${oldTokens.length} old token(s) expire in ${expiresInSeconds}s`)

  return jsonResponse({
    token: newToken,
    oldTokensExpireAt: new Date(expireAt * 1000).toISOString(),
  })
}

// --- CRUD handlers ---

async function createUser(
  request: Request,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  let body: { name?: string; ip?: string; creds?: UserCredentials }
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  if (!body.name || typeof body.name !== 'string') {
    return jsonError('Missing required field: name', 400)
  }

  const userId = `usr_${randomHex(8)}`
  const token = randomHex(24)

  // Store token → userId mapping
  await kv.put(`token:${token}`, userId)

  // Store credentials (default to empty if not provided)
  const creds: UserCredentials = body.creds ?? {}
  await kv.put(`creds:${userId}`, JSON.stringify(creds))

  // Update users registry
  const registry = await getRegistry(kv)
  const entry: UserEntry = {
    name: body.name,
    ip: body.ip,
    tokens: [token],
    createdAt: new Date().toISOString(),
  }
  registry[userId] = entry
  await putRegistry(kv, registry)

  log.info(`[admin] created user ${userId} (${body.name})`)

  return jsonResponse({ userId, token }, 201)
}

async function listUsers(kv: KVNamespace): Promise<Response> {
  const registry = await getRegistry(kv)
  return jsonResponse(registry)
}

async function updateUserCreds(
  request: Request,
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const registry = await getRegistry(kv)
  if (!registry[userId]) {
    return jsonError('User not found', 404)
  }

  let creds: UserCredentials
  try {
    creds = await request.json()
  } catch {
    return jsonError('Invalid JSON body', 400)
  }

  await kv.put(`creds:${userId}`, JSON.stringify(creds))
  log.info(`[admin] updated credentials for user ${userId}`)

  return jsonResponse({ ok: true })
}

async function deleteUser(
  userId: string,
  kv: KVNamespace,
  log: Log
): Promise<Response> {
  const registry = await getRegistry(kv)
  const user = registry[userId]
  if (!user) {
    return jsonError('User not found', 404)
  }

  // Delete all token mappings
  for (const token of user.tokens) {
    await kv.delete(`token:${token}`)
  }

  // Delete credentials
  await kv.delete(`creds:${userId}`)

  // Remove from registry
  delete registry[userId]
  await putRegistry(kv, registry)

  log.info(`[admin] deleted user ${userId} (${user.name})`)

  return jsonResponse({ ok: true })
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
