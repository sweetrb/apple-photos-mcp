/**
 * Guard B — the README `## Tool Reference` matches the advertised tool surface.
 *
 * Truth comes from the BUILT SERVER over stdio (initialize -> tools/list), not
 * from regexing src/index.ts: the wire is the contract users actually see, and
 * a tool can be registered in source yet fail to reach the wire.
 *
 * Both directions are asserted separately, because a one-directional check
 * misses half the drift:
 *   (i)  no advertised tool is undocumented  (a new tool shipped without docs)
 *   (ii) no documented tool is absent from the server (renamed/removed tool
 *        still in the docs)
 *
 * Runs in the UNIT suite (vitest.config.ts) so it sits behind the required
 * `test (22)` / `test (24)` contexts. build/index.js is safe to depend on here:
 * it is git-tracked, so it exists at checkout, AND package.json's `prepare`
 * script runs `pnpm run build` during `pnpm install --frozen-lockfile`, which
 * CI performs before the test step. There is deliberately NO skip-if-missing
 * branch — that would let this guard pass vacuously forever.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(REPO_ROOT, "build", "index.js");
const README = join(REPO_ROOT, "README.md");

/** Ask the built server for its tool list over a real stdio MCP handshake. */
function advertisedTools(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Pin the config surface so a developer's host config file cannot
        // perturb the advertised tool set relative to CI.
        APPLE_PHOTOS_MCP_CONFIG_FILE: join(REPO_ROOT, "does-not-exist.json"),
        APPLE_PHOTOS_MCP_NO_AUTO_SETUP: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    const done = (err: Error | null, tools?: string[]) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (err) reject(err);
      else resolve(tools!);
    };
    const timer = setTimeout(
      () => done(new Error(`server did not answer tools/list in 60s\nstderr:\n${stderr}`)),
      60_000
    );

    child.on("error", (e) => done(e));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      stdout += d;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON banner noise on stdout
        }
        if (msg.id === 1) {
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
              "\n" +
              JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) +
              "\n"
          );
        } else if (msg.id === 2) {
          const tools = msg.result?.tools;
          if (!tools) return done(new Error(`tools/list returned no tools: ${line}`));
          return done(null, tools.map((t) => t.name).sort());
        }
      }
    });

    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "tool-reference-guard", version: "0" },
        },
      }) + "\n"
    );
  });
}

/**
 * Tool names documented in the `## Tool Reference` section ONLY — the rest of
 * the README mentions tool names in prose and workflow examples, which are not
 * documentation entries.
 */
function documentedTools(readme: string = readFileSync(README, "utf8")): string[] {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => /^##\s+Tool Reference\s*$/.test(l));
  if (start === -1) {
    throw new Error("README.md has no `## Tool Reference` section");
  }
  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((l) => /^##\s+\S/.test(l));
  const section = endOffset === -1 ? rest : rest.slice(0, endOffset);

  const names = section.flatMap((l) => {
    const m = /^####\s+`([a-z0-9][a-z0-9-]*)`\s*$/.exec(l);
    return m ? [m[1]] : [];
  });
  return [...names].sort();
}

describe("Guard B — README Tool Reference matches the advertised tool surface", () => {
  let advertised: string[];
  let documented: string[];

  beforeAll(async () => {
    expect(
      existsSync(BUNDLE),
      `build/index.js is missing. It is git-tracked and rebuilt by the \`prepare\` ` +
        `lifecycle during \`pnpm install\`; run \`pnpm run build\` before \`pnpm test\`.`
    ).toBe(true);
    advertised = await advertisedTools();
    documented = documentedTools();
  }, 90_000);

  it("finds a non-empty tool surface on both sides", () => {
    // Vacuity guard: deleting the whole Tool Reference section, or getting an
    // empty tools/list, must FAIL rather than make the diffs below trivially
    // empty.
    expect(advertised.length, "server advertised no tools").toBeGreaterThan(0);
    expect(
      documented.length,
      "README `## Tool Reference` documents no tools (`#### `name`` entries)"
    ).toBeGreaterThan(0);
  });

  it("documents every tool the server advertises", () => {
    const undocumented = advertised.filter((t) => !documented.includes(t));
    expect(
      undocumented,
      `Tool(s) advertised by the server but missing from the README ` +
        `\`## Tool Reference\` section — a tool shipped without docs. Add a ` +
        `\`#### \\\`name\\\`\` entry for:\n  ${undocumented.join("\n  ")}`
    ).toEqual([]);
  });

  it("documents no tool the server does not advertise", () => {
    const phantom = documented.filter((t) => !advertised.includes(t));
    expect(
      phantom,
      `Tool(s) documented in the README \`## Tool Reference\` section that the ` +
        `server does not advertise — renamed or removed but still in the docs:\n  ` +
        phantom.join("\n  ")
    ).toEqual([]);
  });
});
