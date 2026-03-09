import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getGenericApiKey } from "../src/keys";
import type { Log } from "../src/log";

const noopLog: Log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("getGenericApiKey", () => {
  beforeEach(async () => {
    // Clear KV state between tests
    const keys = await env.AUTH_KV.list();
    for (const key of keys.keys) {
      await env.AUTH_KV.delete(key.name);
    }
  });

  it("returns API key from KV creds.providers", async () => {
    await env.AUTH_KV.put(
      "creds:user1",
      JSON.stringify({ providers: { groq: { apiKey: "gsk-test-key" } } })
    );
    const key = await getGenericApiKey("groq", "user1", env.AUTH_KV, noopLog);
    expect(key).toBe("gsk-test-key");
  });

  it("returns undefined for missing user", async () => {
    const key = await getGenericApiKey("groq", "no-such-user", env.AUTH_KV, noopLog);
    expect(key).toBeUndefined();
  });

  it("returns undefined when provider not in creds", async () => {
    await env.AUTH_KV.put(
      "creds:user1",
      JSON.stringify({ providers: { deepseek: { apiKey: "ds-key" } } })
    );
    const key = await getGenericApiKey("groq", "user1", env.AUTH_KV, noopLog);
    expect(key).toBeUndefined();
  });

  it("returns undefined for empty creds", async () => {
    await env.AUTH_KV.put("creds:user1", JSON.stringify({}));
    const key = await getGenericApiKey("groq", "user1", env.AUTH_KV, noopLog);
    expect(key).toBeUndefined();
  });
});
