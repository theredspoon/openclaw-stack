/** Strip Cloudflare-injected metadata headers (cf-*) from a Headers object. */
export function stripCloudflareHeaders(headers: Headers): void {
  for (const key of [...headers.keys()]) {
    if (key.startsWith('cf-')) headers.delete(key)
  }
}

/** Return the request body for upstream, or undefined for GET requests (which must not have a body). */
export function getRequestBody(body: string, method: string): string | undefined {
  return method !== 'GET' ? body : undefined
}
