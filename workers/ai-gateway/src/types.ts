export interface Env {
  // Vars (wrangler.toml)
  /** Cloudflare AI Gateway ID */
  CF_AI_GATEWAY_ID: string

  //
  // Secrets (wrangler secret put)
  //

  /** Cloudflare Account ID */
  ACCOUNT_ID: string
  /** Token used to authorize requests to this worker */
  AUTH_TOKEN: string
  /** OpenAI API Key - can be omitted if BYOK is configured in Cloudflare AI Gateway */
  OPENAI_API_KEY: string
  /** Anthropic API Key - can be omitted if BYOK is configured in Cloudflare AI Gateway */
  ANTHROPIC_API_KEY: string
  /** Token used to authorize the forwarded request in the Cloudflare AI Gateway */
  CF_AI_GATEWAY_TOKEN: string
}
