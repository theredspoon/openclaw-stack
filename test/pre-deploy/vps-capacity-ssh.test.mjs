import { describe, it, expect } from "vitest";
import { buildVpsSshArgs } from "../../build/pre-deploy-lib.mjs";

describe("buildVpsSshArgs", () => {
  const base = { VPS_IP: "1.2.3.4", SSH_USER: "adminclaw", SSH_PORT: "222" };

  it("includes -i when SSH_KEY is set", () => {
    const args = buildVpsSshArgs({ ...base, SSH_KEY: "/home/u/.ssh/key" }, "/home/u");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("/home/u/.ssh/key");
    expect(args.join(" ")).not.toContain("IdentityAgent");
  });

  it("includes IdentityAgent when SSH_IDENTITY_AGENT is set", () => {
    const args = buildVpsSshArgs({ ...base, SSH_IDENTITY_AGENT: "/tmp/agent.sock" }, "/home/u");
    expect(args).toContain("-o");
    expect(args).toContain("IdentityAgent=/tmp/agent.sock");
    expect(args).not.toContain("-i");
  });

  it("includes both -i and IdentityAgent when both are set", () => {
    const args = buildVpsSshArgs(
      { ...base, SSH_KEY: "/home/u/.ssh/key", SSH_IDENTITY_AGENT: "/tmp/agent.sock" },
      "/home/u",
    );
    expect(args).toContain("-i");
    expect(args).toContain("IdentityAgent=/tmp/agent.sock");
  });

  it("omits -i and IdentityAgent when neither is set", () => {
    const args = buildVpsSshArgs(base, "/home/u");
    expect(args).not.toContain("-i");
    expect(args.join(" ")).not.toContain("IdentityAgent");
  });

  it("expands tilde in SSH_KEY using provided homedir", () => {
    const args = buildVpsSshArgs({ ...base, SSH_KEY: "~/.ssh/foo" }, "/home/u");
    expect(args[args.indexOf("-i") + 1]).toBe("/home/u/.ssh/foo");
  });
});
