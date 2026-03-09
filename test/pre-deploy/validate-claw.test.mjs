import { describe, it, expect, vi } from "vitest";
import { validateClaw } from "../../build/pre-deploy-lib.mjs";

describe("validateClaw", () => {
  const validClaw = {
    domain: "example.com",
    gateway_port: 18789,
    dashboard_port: 6090,
    telegram: { enabled: true, bot_token: "123:abc" },
  };

  it("accepts a valid claw", () => {
    expect(() => validateClaw("main", validClaw, () => {})).not.toThrow();
  });

  it("throws on missing domain", () => {
    const claw = { ...validClaw, domain: undefined };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: domain");
  });

  it("throws on missing gateway_port", () => {
    const claw = { ...validClaw, gateway_port: undefined };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: gateway_port");
  });

  it("throws on missing dashboard_port", () => {
    const claw = { ...validClaw, dashboard_port: undefined };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: dashboard_port");
  });

  it("throws on empty string domain", () => {
    const claw = { ...validClaw, domain: "" };
    expect(() => validateClaw("main", claw, () => {})).toThrow("missing required field: domain");
  });

  // Telegram validation: only warns when enabled AND bot_token missing
  it("warns when telegram.enabled is true but bot_token is missing", () => {
    const onWarn = vi.fn();
    const claw = { ...validClaw, telegram: { enabled: true } };
    validateClaw("main", claw, onWarn);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("bot_token")
    );
  });

  it("does not warn when telegram.enabled is false and bot_token is missing", () => {
    const onWarn = vi.fn();
    const claw = { ...validClaw, telegram: { enabled: false } };
    validateClaw("main", claw, onWarn);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("does not warn when telegram section is missing entirely", () => {
    const onWarn = vi.fn();
    const claw = { domain: "ex.com", gateway_port: 1, dashboard_port: 2 };
    validateClaw("main", claw, onWarn);
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("does not warn when telegram.bot_token is present", () => {
    const onWarn = vi.fn();
    validateClaw("main", validClaw, onWarn);
    expect(onWarn).not.toHaveBeenCalled();
  });

  // Matrix validation
  it("throws when matrix.enabled is true but homeserver is missing", () => {
    const claw = { ...validClaw, matrix: { enabled: true, access_token: "tok" } };
    expect(() => validateClaw("main", claw, () => {})).toThrow("matrix.homeserver");
  });

  it("throws when matrix.enabled is true but access_token is missing", () => {
    const claw = { ...validClaw, matrix: { enabled: true, homeserver: "https://hs.example.com" } };
    expect(() => validateClaw("main", claw, () => {})).toThrow("matrix.access_token");
  });

  it("does not throw when matrix.enabled is false", () => {
    const claw = { ...validClaw, matrix: { enabled: false } };
    expect(() => validateClaw("main", claw, () => {})).not.toThrow();
  });

  it("does not throw when matrix section is missing entirely", () => {
    expect(() => validateClaw("main", validClaw, () => {})).not.toThrow();
  });

  it("accepts valid matrix config", () => {
    const claw = {
      ...validClaw,
      matrix: { enabled: true, homeserver: "https://hs.example.com", access_token: "tok" },
    };
    expect(() => validateClaw("main", claw, () => {})).not.toThrow();
  });

  it("includes claw name in error messages", () => {
    const claw = { ...validClaw, domain: undefined };
    expect(() => validateClaw("test-claw", claw, () => {})).toThrow("test-claw");
  });
});
