/**
 * Validate the Authorization header using timing-safe comparison.
 * Returns the provided token string on success, or null on failure.
 */
export async function validateAuthToken(
  request: Request,
  expectedToken: string
): Promise<string | null> {
  // Accept either "Authorization: Bearer <token>" (OpenAI-style)
  // or "x-api-key: <token>" (Anthropic-style)
  let provided: string | undefined;

  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) {
      return null;
    }
    provided = authHeader.slice(7);
  } else {
    const apiKey = request.headers.get("x-api-key");
    if (apiKey) {
      provided = apiKey;
    }
  }

  if (!provided) {
    return null;
  }

  // Check exact match first
  if (await timingSafeEqual(provided, expectedToken)) {
    return provided;
  }

  // If the token contains dashes, check if the last segment matches
  // (supports prefixed keys like "sk-ant-api03-xxxxx-AUTH_TOKEN")
  if (provided.includes("-")) {
    const lastSegment = provided.split("-").pop()!;
    if (await timingSafeEqual(lastSegment, expectedToken)) {
      return provided;
    }
  }

  return null;
}

/** Constant-time string comparison via SHA-256 digest. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);

  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);

  if (viewA.length !== viewB.length) return false;

  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= viewA[i] ^ viewB[i];
  }
  return result === 0;
}
