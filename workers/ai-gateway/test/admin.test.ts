import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { maskString, maskCredentials, mergeCredentials, handleCodexTokenGeneration, handleTokenRotation, handleAdminRequest } from "../src/admin";
import type { UserCredentials, UsersRegistry } from "../src/types";
import type { Log } from "../src/log";

describe("maskString", () => {
  it("returns *** for short strings", () => {
    expect(maskString("short")).toBe("***");
    expect(maskString("exactly16chars!!")).toBe("***");
  });

  it("shows first 8 + last 4 for long strings", () => {
    const long = "sk-ant-api03-abcdefghijklmnop";
    const result = maskString(long);
    expect(result).toBe("sk-ant-a...mnop");
  });

  it("returns *** for empty string", () => {
    expect(maskString("")).toBe("***");
  });
});

describe("maskCredentials", () => {
  it("masks anthropic apiKey", () => {
    const creds: UserCredentials = {
      anthropic: { apiKey: "sk-ant-api03-very-long-key-here-1234" },
    };
    const result = maskCredentials(creds);
    expect((result.anthropic as Record<string, unknown>).apiKey).toContain("...");
  });

  it("masks openai apiKey", () => {
    const creds: UserCredentials = {
      openai: { apiKey: "sk-proj-very-long-openai-key-5678" },
    };
    const result = maskCredentials(creds);
    expect((result.openai as Record<string, unknown>).apiKey).toContain("...");
  });

  it("shows oauth as configured status", () => {
    const creds: UserCredentials = {
      openai: {
        oauth: {
          accessToken: "secret",
          refreshToken: "also-secret",
          expiresAt: "2026-12-31",
        },
      },
    };
    const result = maskCredentials(creds);
    const openai = result.openai as Record<string, unknown>;
    const oauth = openai.oauth as Record<string, unknown>;
    expect(oauth.status).toBe("configured");
    expect(oauth.expiresAt).toBe("2026-12-31");
    expect(oauth).not.toHaveProperty("accessToken");
  });

  it("returns empty object for empty creds", () => {
    const result = maskCredentials({});
    expect(result).toEqual({});
  });

  it("handles creds with only anthropic", () => {
    const creds: UserCredentials = {
      anthropic: { oauthToken: "very-long-anthropic-oauth-token-here" },
    };
    const result = maskCredentials(creds);
    expect(result).toHaveProperty("anthropic");
    expect(result).not.toHaveProperty("openai");
  });

  it("masks generic provider API keys", () => {
    const creds: UserCredentials = {
      providers: {
        groq: { apiKey: "gsk-very-long-groq-api-key-here-1234" },
      },
    };
    const result = maskCredentials(creds);
    const providers = result.providers as Record<string, Record<string, unknown>>;
    expect(providers.groq.apiKey).toContain("...");
  });

  it("skips empty providers section", () => {
    const creds: UserCredentials = {};
    const result = maskCredentials(creds);
    expect(result).not.toHaveProperty("providers");
  });
});

describe("mergeCredentials", () => {
  it("sets a new field", () => {
    const existing: UserCredentials = {};
    const update = { anthropic: { apiKey: "new-key" } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBe("new-key");
  });

  it("updates an existing field", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "old-key" },
    };
    const update = { anthropic: { apiKey: "new-key" } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBe("new-key");
  });

  it("deletes a field when set to null", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "key", oauthToken: "token" },
    };
    const update = { anthropic: { apiKey: null } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBeUndefined();
    expect(result.anthropic?.oauthToken).toBe("token");
  });

  it("preserves fields not in update", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "keep" },
      openai: { apiKey: "also-keep" },
    };
    const update = { anthropic: { apiKey: "changed" } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic?.apiKey).toBe("changed");
    expect(result.openai?.apiKey).toBe("also-keep");
  });

  it("removes entire provider when set to null", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "key" },
    };
    const update = { anthropic: null };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic).toBeUndefined();
  });

  it("removes empty provider section after field deletion", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "only-field" },
    };
    const update = { anthropic: { apiKey: null } };
    const result = mergeCredentials(existing, update);
    expect(result.anthropic).toBeUndefined();
  });

  it("does not mutate existing credentials", () => {
    const existing: UserCredentials = {
      anthropic: { apiKey: "original" },
    };
    const update = { anthropic: { apiKey: "changed" } };
    mergeCredentials(existing, update);
    expect(existing.anthropic?.apiKey).toBe("original");
  });

  it("handles openai oauth updates", () => {
    const existing: UserCredentials = {};
    const update = {
      openai: {
        oauth: {
          accessToken: "at",
          refreshToken: "rt",
          expiresAt: "2026-12-31",
        },
      },
    };
    const result = mergeCredentials(existing, update);
    expect(result.openai?.oauth?.accessToken).toBe("at");
  });

  it("sets new generic provider key", () => {
    const existing: UserCredentials = {};
    const update = { providers: { groq: { apiKey: "new-key" } } };
    const result = mergeCredentials(existing, update);
    expect(result.providers?.groq?.apiKey).toBe("new-key");
  });

  it("deletes generic provider with null", () => {
    const existing: UserCredentials = {
      providers: { groq: { apiKey: "old-key" } },
    };
    const update = { providers: { groq: null } };
    const result = mergeCredentials(existing, update);
    expect(result.providers?.groq).toBeUndefined();
  });

  it("cleans up empty providers section", () => {
    const existing: UserCredentials = {
      providers: { groq: { apiKey: "only-key" } },
    };
    const update = { providers: { groq: null } };
    const result = mergeCredentials(existing, update);
    expect(result.providers).toBeUndefined();
  });

  it("preserves existing generic providers when updating another", () => {
    const existing: UserCredentials = {
      providers: {
        groq: { apiKey: "groq-key" },
        deepseek: { apiKey: "ds-key" },
      },
    };
    const update = { providers: { groq: { apiKey: "new-groq-key" } } };
    const result = mergeCredentials(existing, update);
    expect(result.providers?.groq?.apiKey).toBe("new-groq-key");
    expect(result.providers?.deepseek?.apiKey).toBe("ds-key");
  });
});

// --- Codex token expiry ---

const noopLog: Log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedUser(kv: KVNamespace, userId: string) {
  const registry: UsersRegistry = {
    [userId]: {
      name: "test",
      tokens: ["initial-token"],
      createdAt: new Date().toISOString(),
    },
  };
  await kv.put("users", JSON.stringify(registry));
  await kv.put(`token:initial-token`, userId);
  await kv.put(
    `creds:${userId}`,
    JSON.stringify({
      openai: {
        oauth: {
          accessToken: "fake-at",
          refreshToken: "fake-rt",
          expiresAt: "2099-12-31",
        },
      },
    } satisfies UserCredentials)
  );
}

describe("codex token expiry", () => {
  const kv = env.AUTH_KV;
  const userId = "usr_codex_test";

  it("first codex token sets tracking key", async () => {
    await seedUser(kv, userId);
    const res = await handleCodexTokenGeneration(userId, kv, noopLog);
    expect(res.status).toBe(200);

    const trackingHash = await kv.get(`codex:${userId}`);
    expect(trackingHash).toBeTruthy();

    // The tracked hash should resolve to our userId
    const resolved = await kv.get(`token:${trackingHash!}`);
    expect(resolved).toBe(userId);
  });

  it("regeneration updates tracking key and old token still resolves", async () => {
    await seedUser(kv, userId);

    // First generation
    const res1 = await handleCodexTokenGeneration(userId, kv, noopLog);
    const body1 = (await res1.json()) as { codexPasteToken: string };
    const firstHash = await sha256Hex(body1.codexPasteToken);
    const trackingAfterFirst = await kv.get(`codex:${userId}`);
    expect(trackingAfterFirst).toBe(firstHash);

    // Second generation
    const res2 = await handleCodexTokenGeneration(userId, kv, noopLog);
    const body2 = (await res2.json()) as { codexPasteToken: string };
    const secondHash = await sha256Hex(body2.codexPasteToken);

    // Tracking key should now point to the new hash
    const trackingAfterSecond = await kv.get(`codex:${userId}`);
    expect(trackingAfterSecond).toBe(secondHash);
    expect(secondHash).not.toBe(firstHash);

    // Old token still resolves during grace period (has TTL, not deleted)
    const oldResolved = await kv.get(`token:${firstHash}`);
    expect(oldResolved).toBe(userId);

    // New token also resolves
    const newResolved = await kv.get(`token:${secondHash}`);
    expect(newResolved).toBe(userId);
  });

  it("codex hash is not added to user.tokens registry", async () => {
    await seedUser(kv, userId);
    await handleCodexTokenGeneration(userId, kv, noopLog);

    const registry = JSON.parse((await kv.get("users"))!) as UsersRegistry;
    const user = registry[userId];
    // user.tokens should only contain the initial seed token, not the codex hash
    expect(user.tokens).toEqual(["initial-token"]);
  });

  it("token rotation does not resurrect expired codex hashes", async () => {
    await seedUser(kv, userId);

    // Generate a codex token
    const res = await handleCodexTokenGeneration(userId, kv, noopLog);
    const body = (await res.json()) as { codexPasteToken: string };
    const codexHash = await sha256Hex(body.codexPasteToken);

    // Simulate the codex token expiring out of KV
    await kv.delete(`token:${codexHash}`);
    const gone = await kv.get(`token:${codexHash}`);
    expect(gone).toBeNull();

    // Rotate normal tokens — should not touch codex hashes
    await handleTokenRotation(userId, kv, noopLog);

    // Codex hash should still be absent from KV
    const stillGone = await kv.get(`token:${codexHash}`);
    expect(stillGone).toBeNull();
  });

  it("user deletion revokes active codex token", async () => {
    await seedUser(kv, userId);

    // Generate a codex token
    const res = await handleCodexTokenGeneration(userId, kv, noopLog);
    const body = (await res.json()) as { codexPasteToken: string };
    const codexHash = await sha256Hex(body.codexPasteToken);

    // Verify it resolves before deletion
    expect(await kv.get(`token:${codexHash}`)).toBe(userId);

    // Delete the user via admin API
    const deleteReq = new Request("https://example.com/admin/users/" + userId, {
      method: "DELETE",
    });
    const deleteRes = await handleAdminRequest(deleteReq, `/admin/users/${userId}`, kv, noopLog);
    expect(deleteRes.status).toBe(200);

    // Codex token should be revoked
    expect(await kv.get(`token:${codexHash}`)).toBeNull();
    // Tracking key should be gone
    expect(await kv.get(`codex:${userId}`)).toBeNull();
  });
});
