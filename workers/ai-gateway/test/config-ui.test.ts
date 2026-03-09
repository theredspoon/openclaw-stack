import { describe, it, expect, beforeAll } from "vitest";
import { serveConfigPage } from "../src/config-ui";

describe("config-ui buildUpdate error handling", () => {
  let html: string;

  // Extract the HTML once — structural tests only, no DOM needed
  beforeAll(async () => {
    const res = serveConfigPage();
    html = await res.text();
  });

  it("hasError flag pattern prevents partial updates", () => {
    expect(html).toContain("let hasError = false");
    expect(html).toContain("if (hasError) return null");
  });

  it("save() guards against null from buildUpdate", () => {
    expect(html).toContain("if (!update)");
  });
});
