import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileConfig, fileConfigPath } from "@/services/fileConfig.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "apmcp-cfg-"));
  file = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadFileConfig", () => {
  it("applies file values for keys not already in env", () => {
    writeFileSync(file, JSON.stringify({ APPLE_PHOTOS_MCP_MAX_BUFFER: "1048576", DEBUG: "1" }));
    const env: NodeJS.ProcessEnv = {};
    const applied = loadFileConfig(env, file);
    expect(env.APPLE_PHOTOS_MCP_MAX_BUFFER).toBe("1048576");
    expect(env.DEBUG).toBe("1");
    expect(applied.sort()).toEqual(["APPLE_PHOTOS_MCP_MAX_BUFFER", "DEBUG"]);
  });

  it("returns [] when the file is missing", () => {
    expect(loadFileConfig({}, join(dir, "nope.json"))).toEqual([]);
  });

  it("never overrides a value already set in the environment", () => {
    writeFileSync(file, JSON.stringify({ APPLE_PHOTOS_MCP_MAX_BUFFER: "1" }));
    const env: NodeJS.ProcessEnv = { APPLE_PHOTOS_MCP_MAX_BUFFER: "999" };
    loadFileConfig(env, file);
    expect(env.APPLE_PHOTOS_MCP_MAX_BUFFER).toBe("999");
  });

  it("treats empty-string env as unset and fills it", () => {
    writeFileSync(file, JSON.stringify({ DEBUG: "1" }));
    const env: NodeJS.ProcessEnv = { DEBUG: "" };
    loadFileConfig(env, file);
    expect(env.DEBUG).toBe("1");
  });

  it("ignores non-string values", () => {
    writeFileSync(file, JSON.stringify({ A: "ok", B: 5, C: true }));
    const env: NodeJS.ProcessEnv = {};
    expect(loadFileConfig(env, file)).toEqual(["A"]);
  });

  it("tolerates a malformed JSON file (returns [], does not throw)", () => {
    writeFileSync(file, "{ not json");
    expect(loadFileConfig({}, file)).toEqual([]);
  });
});

describe("fileConfigPath", () => {
  it("honors the APPLE_PHOTOS_MCP_CONFIG_FILE override", () => {
    expect(fileConfigPath({ APPLE_PHOTOS_MCP_CONFIG_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it("falls back to the Application Support path", () => {
    expect(fileConfigPath({})).toMatch(/apple-photos-mcp\/config\.json$/);
  });
});
