import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures");

function grepExits(pattern, file) {
  try {
    execSync(`grep -q ${pattern} "${file}"`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("build-openclaw.sh grep patterns", () => {
  // Fixed pattern: grep -q "gosu" instead of "docker.io" to avoid false positives
  // from OCI labels like FROM docker.io/library/node in multi-stage Dockerfiles.
  describe('grep -q "gosu" (patch detection)', () => {
    it("matches patched Dockerfile (has gosu)", () => {
      expect(grepExits('"gosu"', join(FIXTURES, "Dockerfile.patched"))).toBe(true);
    });

    it("does NOT match unpatched Dockerfile", () => {
      expect(grepExits('"gosu"', join(FIXTURES, "Dockerfile.unpatched"))).toBe(false);
    });

    it("does NOT match OCI label Dockerfile (no false positive)", () => {
      // OCI label has docker.io/library/node but NOT gosu — correctly detected
      // as needing the patch.
      expect(grepExits('"gosu"', join(FIXTURES, "Dockerfile.oci-label"))).toBe(false);
    });
  });

  describe("grep -q '^data/' .dockerignore", () => {
    it("matches when data/ exclusion exists", () => {
      expect(grepExits("'^data/'", join(FIXTURES, "dockerignore.with-data"))).toBe(true);
    });

    it("does not match when data/ is absent", () => {
      expect(grepExits("'^data/'", join(FIXTURES, "dockerignore.with-git"))).toBe(false);
    });
  });

  describe("grep -q '^\\.git$' .dockerignore", () => {
    it("matches exact .git line", () => {
      expect(grepExits("'^\\.git$'", join(FIXTURES, "dockerignore.with-git"))).toBe(true);
    });

    it("does not match when .git is absent", () => {
      expect(grepExits("'^\\.git$'", join(FIXTURES, "dockerignore.no-git"))).toBe(false);
    });
  });

  describe("grep -q 'rm.*tmp/jiti' Dockerfile (jiti cache patch)", () => {
    it("does not match unpatched Dockerfile", () => {
      expect(grepExits("'rm.*tmp/jiti'", join(FIXTURES, "Dockerfile.unpatched"))).toBe(false);
    });
  });

  describe("broken import pattern", () => {
    it("matches broken import path", () => {
      expect(
        grepExits('"openclaw/plugin-sdk/keyed-async-queue"', join(FIXTURES, "send-queue.broken.ts"))
      ).toBe(true);
    });

    it("does not match fixed import path", () => {
      expect(
        grepExits('"openclaw/plugin-sdk/keyed-async-queue"', join(FIXTURES, "send-queue.fixed.ts"))
      ).toBe(false);
    });
  });
});
