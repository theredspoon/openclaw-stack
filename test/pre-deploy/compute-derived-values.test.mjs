import { describe, it, expect, vi } from "vitest";
import { computeDerivedValues } from "../../build/pre-deploy-lib.mjs";

/** Minimal claw that passes validation and has the fields computeDerivedValues reads. */
function makeClaw(overrides = {}) {
  return {
    domain: "example.com",
    gateway_port: 3000,
    dashboard_port: 3001,
    ...overrides,
  };
}

/** Minimal stack config with required ai_gateway. */
function makeStack(overrides = {}) {
  return {
    ai_gateway: { url: "https://gw.example.com", token: "gw-token" },
    ...overrides,
  };
}

const noopResolveToken = vi.fn((value) => value || "auto-token");

describe("computeDerivedValues", () => {
  // ── telegram_enabled ────────────────────────────────────────────────────

  it("sets telegram_enabled true when telegram.enabled is true", () => {
    const claws = { alpha: makeClaw({ telegram: { enabled: true, bot_token: "t" } }) };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.telegram_enabled).toBe(true);
  });

  it("sets telegram_enabled false when telegram.enabled is false", () => {
    const claws = { alpha: makeClaw({ telegram: { enabled: false } }) };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.telegram_enabled).toBe(false);
  });

  it("sets telegram_enabled false when telegram is absent", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.telegram_enabled).toBe(false);
  });

  // ── matrix_enabled ──────────────────────────────────────────────────────

  it("sets matrix_enabled true when matrix.enabled is true", () => {
    const claws = { alpha: makeClaw({ matrix: { enabled: true, homeserver: "h", access_token: "t" } }) };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.matrix_enabled).toBe(true);
  });

  it("sets matrix_enabled false when matrix.enabled is false", () => {
    const claws = { alpha: makeClaw({ matrix: { enabled: false } }) };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.matrix_enabled).toBe(false);
  });

  it("sets matrix_enabled false when matrix is absent", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.matrix_enabled).toBe(false);
  });

  // ── Gateway URLs ────────────────────────────────────────────────────────

  it("constructs gateway URLs from stack ai_gateway", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack({ ai_gateway: { url: "https://gw", token: "tok" } }), {}, null, noopResolveToken);
    expect(claws.alpha.anthropic_base_url).toBe("https://gw/anthropic");
    expect(claws.alpha.openai_base_url).toBe("https://gw/openai/v1");
    expect(claws.alpha.openai_codex_base_url).toBe("https://gw/openai-codex");
    expect(claws.alpha.anthropic_api_key).toBe("tok");
    expect(claws.alpha.openai_api_key).toBe("tok");
  });

  it("uses per-claw ai_gateway override when present", () => {
    const claws = { alpha: makeClaw({ ai_gateway: { url: "https://claw-gw", token: "claw-tok" } }) };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.anthropic_base_url).toBe("https://claw-gw/anthropic");
    expect(claws.alpha.anthropic_api_key).toBe("claw-tok");
  });

  // ── allowed_origin ──────────────────────────────────────────────────────

  it("derives allowed_origin from domain", () => {
    const claws = { alpha: makeClaw({ domain: "my.example.com" }) };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.allowed_origin).toBe("https://my.example.com");
  });

  // ── vps_hostname ────────────────────────────────────────────────────────

  it("sets vps_hostname from host config", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack(), { hostname: "vps1" }, null, noopResolveToken);
    expect(claws.alpha.vps_hostname).toBe("vps1");
  });

  it("defaults vps_hostname to empty string", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.vps_hostname).toBe("");
  });

  // ── events_url / llemtry_url ────────────────────────────────────────────

  it("sets events_url and llemtry_url when logging worker_url is configured", () => {
    const claws = { alpha: makeClaw() };
    const stack = makeStack({ logging: { worker_url: "https://log.example.com", worker_token: "lt" } });
    computeDerivedValues(claws, stack, {}, null, noopResolveToken);
    expect(claws.alpha.events_url).toBe("https://log.example.com/openclaw/events");
    expect(claws.alpha.llemtry_url).toBe("https://log.example.com/llemtry");
    expect(claws.alpha.log_worker_url).toBe("https://log.example.com");
    expect(claws.alpha.log_worker_token).toBe("lt");
  });

  it("sets events_url and llemtry_url to empty when no logging worker_url", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.events_url).toBe("");
    expect(claws.alpha.llemtry_url).toBe("");
    expect(claws.alpha.log_worker_url).toBe("");
    expect(claws.alpha.log_worker_token).toBe("");
  });

  // ── enable_events_logging / enable_llemtry_logging ──────────────────────

  it("sets enable_events_logging from stack logging config", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack({ logging: { events: true } }), {}, null, noopResolveToken);
    expect(claws.alpha.enable_events_logging).toBe(true);
  });

  it("defaults enable_events_logging to false", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.enable_events_logging).toBe(false);
  });

  it("sets enable_llemtry_logging from stack logging config", () => {
    const claws = { alpha: makeClaw() };
    computeDerivedValues(claws, makeStack({ logging: { llemtry: true } }), {}, null, noopResolveToken);
    expect(claws.alpha.enable_llemtry_logging).toBe(true);
  });

  // ── stack.vector ────────────────────────────────────────────────────────

  it("sets stack.vector true when logging.vector is true", () => {
    const stack = makeStack({ logging: { vector: true } });
    computeDerivedValues({ a: makeClaw() }, stack, {}, null, noopResolveToken);
    expect(stack.vector).toBe(true);
  });

  it("sets stack.vector false when logging absent", () => {
    const stack = makeStack();
    computeDerivedValues({ a: makeClaw() }, stack, {}, null, noopResolveToken);
    expect(stack.vector).toBe(false);
  });

  // ── egress_proxy token ──────────────────────────────────────────────────

  it("resolves egress_proxy auth_token via resolveTokenFn", () => {
    const mockResolve = vi.fn(() => "resolved-egress");
    const stack = makeStack({ egress_proxy: { auth_token: "" } });
    const result = computeDerivedValues({ a: makeClaw() }, stack, {}, null, mockResolve);
    expect(mockResolve).toHaveBeenCalledWith("", "stack.egress_proxy.auth_token", null);
    expect(stack.egress_proxy.auth_token).toBe("resolved-egress");
    expect(result.EGRESS_PROXY_AUTH_TOKEN).toBe("resolved-egress");
  });

  // ── sandbox_registry ───────────────────────────────────────────────────

  it("resolves sandbox_registry token and sets container mode when port-only", () => {
    const mockResolve = vi.fn(() => "resolved-sr");
    const stack = makeStack({ sandbox_registry: { port: 5000 } });
    const result = computeDerivedValues({ a: makeClaw() }, stack, {}, null, mockResolve);
    expect(result.SANDBOX_REGISTRY_TOKEN).toBe("resolved-sr");
    expect(stack.sandbox_registry_container).toBe(true);
    expect(stack.sandbox_registry_port).toBe(5000);
  });

  it("sets non-container mode when sandbox_registry has url", () => {
    const mockResolve = vi.fn(() => "resolved-sr");
    const stack = makeStack({ sandbox_registry: { url: "https://reg.example.com" } });
    computeDerivedValues({ a: makeClaw() }, stack, {}, null, mockResolve);
    expect(stack.sandbox_registry_container).toBe(false);
    expect(stack.sandbox_registry_url).toBe("https://reg.example.com");
  });

  // ── multiple claws ─────────────────────────────────────────────────────

  it("computes derived values for all claws", () => {
    const claws = {
      alpha: makeClaw({ domain: "a.example.com", telegram: { enabled: true } }),
      beta: makeClaw({ domain: "b.example.com", matrix: { enabled: true } }),
    };
    computeDerivedValues(claws, makeStack(), {}, null, noopResolveToken);
    expect(claws.alpha.telegram_enabled).toBe(true);
    expect(claws.alpha.matrix_enabled).toBe(false);
    expect(claws.beta.telegram_enabled).toBe(false);
    expect(claws.beta.matrix_enabled).toBe(true);
    expect(claws.alpha.allowed_origin).toBe("https://a.example.com");
    expect(claws.beta.allowed_origin).toBe("https://b.example.com");
  });
});
