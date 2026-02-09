# Using Claude Code Subscription

See <https://docs.openclaw.ai/gateway/authentication>

Claude Code OAuth tokens are designed for CI/CD that uses claude code.

```bash
# Get setup token from claude
claude setup-token

# in openclaw-gateway container...
node openclaw.mjs models auth setup-token --provider anthropic

# Or using auth token generated from another machine
node openclaw.mjs models auth paste-token --provider anthropic
```
