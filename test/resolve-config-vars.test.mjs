import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "deploy", "openclaw-stack", "resolve-config-vars.mjs");
const TMP = join(__dirname, ".tmp-resolve-test");

function setup(configContent, composeContent) {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".deploy"), { recursive: true });
  const configPath = join(TMP, "openclaw.jsonc");
  writeFileSync(configPath, configContent);
  writeFileSync(join(TMP, ".deploy", "docker-compose.yml"), composeContent);
  return configPath;
}

function run(configPath, clawName) {
  return execSync(`node "${SCRIPT}" "${configPath}" "${clawName}"`, {
    encoding: "utf-8",
  });
}

function cleanup() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}

const composeYml = `
services:
  test-openclaw-main:
    environment:
      - TOKEN=abc123
      - PORT=8080
      - EMPTY_VAR=
      - DOMAIN=example.com
`;

describe("resolve-config-vars.mjs", () => {
  afterEach(cleanup);

  it("resolves ${VAR} with env value", () => {
    const configPath = setup('{"token": "${TOKEN}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"token": "abc123"');
  });

  it("resolves ${VAR:-default} with env value when set (coerced to number)", () => {
    const configPath = setup('{"port": "${PORT:-9090}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"port": 8080');
  });

  it("uses default when var is empty", () => {
    const configPath = setup('{"val": "${EMPTY_VAR:-fallback}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"val": "fallback"');
  });

  it("uses default when var is missing", () => {
    const configPath = setup('{"val": "${MISSING:-default_val}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"val": "default_val"');
  });

  it("resolves multiple vars in same file", () => {
    const configPath = setup(
      '{"a": "${TOKEN}", "b": "${DOMAIN}"}',
      composeYml
    );
    const result = run(configPath, "main");
    expect(result).toContain('"a": "abc123"');
    expect(result).toContain('"b": "example.com"');
  });

  it("preserves JSONC comments in output", () => {
    const configPath = setup(
      '// comment\n{"token": "${TOKEN}"}',
      composeYml
    );
    const result = run(configPath, "main");
    expect(result).toContain("// comment");
    expect(result).toContain('"token": "abc123"');
  });

  it("passes through unchanged when compose file is missing", () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    const configPath = join(TMP, "openclaw.jsonc");
    writeFileSync(configPath, '{"token": "${TOKEN}"}');
    const result = run(configPath, "main");
    expect(result).toContain("${TOKEN}");
  });

  // Boolean coercion: "${VAR}" as entire value → unquoted true/false
  it("coerces boolean string to unquoted boolean", () => {
    const compose = `
services:
  test-openclaw-main:
    environment:
      - ENABLED=true
      - DISABLED=false
`;
    const configPath = setup('{"a": "${ENABLED}", "b": "${DISABLED}"}', compose);
    const result = run(configPath, "main");
    // Should be unquoted booleans in JSON output
    expect(result).toContain('"a": true');
    expect(result).toContain('"b": false');
  });

  // Number coercion: "${VAR}" as entire value → unquoted number
  it("coerces numeric string to unquoted number", () => {
    const configPath = setup('{"port": "${PORT}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"port": 8080');
  });

  // String values remain quoted
  it("keeps non-boolean non-numeric strings quoted", () => {
    const configPath = setup('{"name": "${TOKEN}"}', composeYml);
    const result = run(configPath, "main");
    expect(result).toContain('"name": "abc123"');
  });

  // Channel stripping: disabled channel removed from output
  it("strips disabled telegram channel from output", () => {
    const compose = `
services:
  test-openclaw-main:
    environment:
      - TELEGRAM_ENABLED=false
`;
    const config = '{"channels": {"telegram": {"enabled": "${TELEGRAM_ENABLED}"}}}';
    const configPath = setup(config, compose);
    const result = run(configPath, "main");
    const parsed = JSON.parse(result);
    expect(parsed.channels.telegram).toBeUndefined();
  });

  it("strips disabled matrix channel from output", () => {
    const compose = `
services:
  test-openclaw-main:
    environment:
      - MATRIX_ENABLED=false
`;
    const config = '{"channels": {"matrix": {"enabled": "${MATRIX_ENABLED}"}}}';
    const configPath = setup(config, compose);
    const result = run(configPath, "main");
    const parsed = JSON.parse(result);
    expect(parsed.channels.matrix).toBeUndefined();
  });

  it("preserves enabled channels in output", () => {
    const compose = `
services:
  test-openclaw-main:
    environment:
      - TELEGRAM_ENABLED=true
      - TELEGRAM_BOT_TOKEN=bot:tok
`;
    const config = '{"channels": {"telegram": {"enabled": "${TELEGRAM_ENABLED}", "botToken": "${TELEGRAM_BOT_TOKEN}"}}}';
    const configPath = setup(config, compose);
    const result = run(configPath, "main");
    expect(result).toContain("telegram");
  });
});
