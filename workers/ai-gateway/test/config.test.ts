import { describe, it, expect } from "vitest";
import { PROVIDER_DEFAULTS, getGenericProviderConfig, buildCodexHeaders } from "../src/config";

const EXPECTED_PROVIDERS = [
  "cohere", "deepseek", "fireworks", "groq", "minimax",
  "mistral", "moonshot", "openrouter", "perplexity", "together", "xai",
];

describe("PROVIDER_DEFAULTS", () => {
  it("contains all 11 providers", () => {
    expect(new Set(Object.keys(PROVIDER_DEFAULTS))).toEqual(new Set(EXPECTED_PROVIDERS));
  });

  it("each provider has a non-empty baseUrl", () => {
    for (const [name, entry] of Object.entries(PROVIDER_DEFAULTS)) {
      expect(entry.baseUrl.length, `${name} baseUrl should be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe("buildCodexHeaders", () => {
  it("returns undefined when neither auth mechanism is set", () => {
    expect(buildCodexHeaders({})).toBeUndefined();
  });

  it("returns only proxy auth when only EGRESS_PROXY_AUTH_TOKEN is set", () => {
    expect(buildCodexHeaders({ EGRESS_PROXY_AUTH_TOKEN: "tok123" })).toEqual({
      "X-Proxy-Auth": "Bearer tok123",
    });
  });

  it("returns only CF Access headers when only CF_ACCESS vars are set", () => {
    expect(
      buildCodexHeaders({
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "secret",
      })
    ).toEqual({
      "CF-Access-Client-Id": "id",
      "CF-Access-Client-Secret": "secret",
    });
  });

  it("returns all three headers when both mechanisms are configured", () => {
    expect(
      buildCodexHeaders({
        EGRESS_PROXY_AUTH_TOKEN: "tok",
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "secret",
      })
    ).toEqual({
      "X-Proxy-Auth": "Bearer tok",
      "CF-Access-Client-Id": "id",
      "CF-Access-Client-Secret": "secret",
    });
  });
});

describe("getGenericProviderConfig", () => {
  it("returns config for a known provider", () => {
    const config = getGenericProviderConfig("groq");
    expect(config).not.toBeNull();
    expect(config!.baseUrl).toBe("https://api.groq.com/openai");
  });

  it("returns null for unknown provider", () => {
    expect(getGenericProviderConfig("unknown")).toBeNull();
  });
});
