import { describe, it, expect } from "vitest";
import { stripCloudflareHeaders, getRequestBody } from "../src/headers";

describe("stripCloudflareHeaders", () => {
  it("strips cf-* headers", () => {
    const h = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "cf-ray": "abc123",
      "cf-ipcountry": "US",
      "cf-visitor": '{"scheme":"https"}',
      authorization: "Bearer sk-test",
    });
    stripCloudflareHeaders(h);
    expect(h.has("cf-connecting-ip")).toBe(false);
    expect(h.has("cf-ray")).toBe(false);
    expect(h.has("cf-ipcountry")).toBe(false);
    expect(h.has("cf-visitor")).toBe(false);
  });

  it("preserves non-cf headers", () => {
    const h = new Headers({
      authorization: "Bearer sk-test",
      "content-type": "application/json",
      "user-agent": "test/1.0",
      "cf-ray": "abc123",
    });
    stripCloudflareHeaders(h);
    expect(h.get("authorization")).toBe("Bearer sk-test");
    expect(h.get("content-type")).toBe("application/json");
    expect(h.get("user-agent")).toBe("test/1.0");
  });

  it("handles empty Headers", () => {
    const h = new Headers();
    stripCloudflareHeaders(h);
    expect([...h.keys()]).toHaveLength(0);
  });

  it("handles headers with only cf-* entries", () => {
    const h = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "cf-ray": "abc123",
    });
    stripCloudflareHeaders(h);
    expect([...h.keys()]).toHaveLength(0);
  });
});

describe("getRequestBody", () => {
  it("returns undefined for GET", () => {
    expect(getRequestBody("data", "GET")).toBeUndefined();
  });

  it("returns body for POST", () => {
    expect(getRequestBody("data", "POST")).toBe("data");
  });

  it("returns body for PUT", () => {
    expect(getRequestBody("data", "PUT")).toBe("data");
  });
});
