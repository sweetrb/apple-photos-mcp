/**
 * outputSchema contract — belt-and-suspenders for the registerTool/outputSchema
 * migration. Boots the REAL built server over stdio and verifies the MCP
 * output-schema guarantees end-to-end through the SDK:
 *
 *   1. every tool advertises an outputSchema (none slipped back to plain server.tool)
 *   2. every outputSchema is permissive — no required fields — so the SDK's
 *      structuredContent validation can never reject a valid success result for a
 *      conditionally-absent field
 *   3. the diagnostic tools round-trip without a validation rejection. The SDK's
 *      validateToolOutput (server mcp.js) THROWS McpError when a success result's
 *      structuredContent is missing or fails the schema, which rejects callTool —
 *      so a resolving call proves a real payload validates against its schema.
 *      (Environment failures return isError results, which the SDK exempts.)
 *
 * Needs no Photos library, so it always runs (including CI). The Python sidecar
 * auto-bootstrap is disabled so the diagnostic round-trip stays fast and offline.
 * Requires build/ — `npm ci` runs prepare→build and test:integration runs after
 * the build in CI.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve } from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = resolve(__dirname, "../build/index.js");

describe("outputSchema contract (real server over stdio)", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      // ENABLE_WRITES is pinned to "0" (an explicit env var also beats any
      // config.json on the host machine) so the write-gate assertions below
      // are deterministic everywhere.
      env: {
        ...process.env,
        APPLE_PHOTOS_MCP_NO_AUTO_SETUP: "1",
        APPLE_PHOTOS_MCP_ENABLE_WRITES: "0",
      } as Record<string, string>,
    });
    client = new Client({ name: "outputschema-contract-test", version: "0.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it("registers tools, and every tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
    expect(missing, `tools missing an outputSchema: ${missing.join(", ")}`).toEqual([]);
  });

  it("every outputSchema is permissive — no required fields", async () => {
    const { tools } = await client.listTools();
    const offenders = tools
      .filter((t) => {
        const req = (t.outputSchema as { required?: unknown } | undefined)?.required;
        return Array.isArray(req) && req.length > 0;
      })
      .map(
        (t) =>
          `${t.name}: requires [${(t.outputSchema as { required: string[] }).required.join(", ")}]`
      );
    expect(
      offenders,
      `outputSchemas must not require fields (a missing field would reject a valid result): ${offenders.join("; ")}`
    ).toEqual([]);
  });

  it("diagnostic tools' real output validates against their outputSchema (when reachable)", async () => {
    // The SDK throws an "Output validation error" McpError when a success
    // result's structuredContent is missing or fails its schema — the only
    // failure we treat as a bug. A slow or unavailable backend (e.g. AppleScript
    // timing out on a headless CI runner) is tolerated, not failed.
    for (const name of ["health-check", "doctor"]) {
      const call = client.callTool({ name, arguments: {} });
      try {
        await Promise.race([
          call,
          new Promise((resolve) => setTimeout(() => resolve(undefined), 8000)),
        ]);
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err);
        if (/output validation error|invalid structured content/i.test(msg)) throw err;
        // otherwise: environment/transport error — the tool couldn't run here
      }
      // Swallow any late rejection (e.g. when the client closes mid-call).
      void Promise.resolve(call).catch(() => {});
    }
  }, 30_000);

  // --- write tools: registration + gate contract (2.0.0 design decision) ---
  //
  // The write tools are ALWAYS REGISTERED — even with the gate closed — and a
  // gated call returns an isError result carrying the opt-in recipe. This is
  // deliberate: MCP clients cache the tool list at startup, so hiding the
  // tools adds no safety (a gate flip needs a restart either way) but destroys
  // discoverability. These tests pin that contract through a real server.

  const WRITE_TOOLS = [
    "create-album",
    "add-to-album",
    "remove-from-album",
    "set-photo-metadata",
    "set-keywords",
  ];

  it("registers all five write tools even while the gate is closed", async () => {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const tool of WRITE_TOOLS) {
      expect(names.has(tool), `missing write tool: ${tool}`).toBe(true);
    }
  });

  it("every write tool's description carries a Safety: line naming the gate", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools.filter((t) => WRITE_TOOLS.includes(t.name))) {
      expect(tool.description, `${tool.name} description`).toMatch(/Safety:/);
      expect(tool.description, `${tool.name} description`).toContain(
        "APPLE_PHOTOS_MCP_ENABLE_WRITES"
      );
    }
  });

  it("a gated write call returns a clear isError result with the opt-in recipe (not a protocol error)", async () => {
    const result = (await client.callTool({
      name: "create-album",
      arguments: { name: "Gate Contract Test" },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(result.isError).toBe(true);
    const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
    expect(text).toMatch(/read-only by default/);
    expect(text).toContain("APPLE_PHOTOS_MCP_ENABLE_WRITES=1");
    expect(text).toContain("config.json");
  }, 15_000);
});
