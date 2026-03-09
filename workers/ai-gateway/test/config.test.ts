import { describe, it, expect } from "vitest";
import { PROVIDER_DEFAULTS, getGenericProviderConfig } from "../src/config";

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
