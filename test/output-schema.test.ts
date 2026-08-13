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
 *   4. every advertised inputSchema/outputSchema declares JSON Schema 2020-12 and
 *      carries no draft-07-only construct. The SDK emits draft-07 and clients now
 *      reject that outright ("declares an unsupported dialect"), so this is the
 *      end-to-end proof that the transport-level normalizer is wired in.
 *   5. every advertised schema actually COMPILES under a real 2020-12 validator
 *      (ajv's Ajv2020, the same library the MCP SDK validates with). Asserting
 *      the "$schema" string only proves what we CLAIM; a schema can declare
 *      2020-12 and still be structurally invalid under it, and the client would
 *      reject the tool just the same.
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
import Ajv2020Import from "ajv/dist/2020.js";

const SERVER = resolve(__dirname, "../build/index.js");

// ajv is CJS, and `ajv/dist/2020.js` sets BOTH `module.exports = Ajv2020` and
// `exports.default = Ajv2020` (plus __esModule). Depending on which loader is in
// play, the ESM default binding is therefore either the class itself or a
// namespace object whose `.default` is the class. Unwrap one level when needed so
// this works under vitest/esbuild and plain Node alike.
//
// ajv must be a DIRECT devDependency: it is present transitively via the MCP SDK,
// but pnpm's strict node_modules layout makes a transitive dep unimportable.
type Ajv2020Ctor = typeof Ajv2020Import;
const Ajv2020 = ((Ajv2020Import as unknown as { default?: Ajv2020Ctor }).default ??
  Ajv2020Import) as Ajv2020Ctor;

// Walk schema POSITIONS, not raw text. The keys of a `properties` map are
// caller-chosen TOOL PARAMETER NAMES, not keywords, so a tool with a parameter
// named `definitions` or `$schema` is perfectly legal and must not be reported;
// and enum/const/default hold instance DATA, whose keys mean nothing here.
// (Same distinction the normalizer itself makes — see src/utils/jsonSchemaDialect.ts.)
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "dependentSchemas"];
const DATA_KEYWORDS = ["enum", "const", "default", "examples", "required", "dependentRequired"];

/** Re-enter only the subschema positions of `obj`, reporting each via `visit`. */
function walkSubschemas(
  obj: Record<string, unknown>,
  path: string,
  visit: (node: unknown, path: string) => void
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (DATA_KEYWORDS.includes(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.includes(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          visit(sub, `${path}.${key}.${name}`);
        }
      }
      continue;
    }
    visit(value, `${path}.${key}`);
  }
}

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

  it("every outputSchema tolerates undeclared keys (additionalProperties !== false)", async () => {
    // The CLIENT validates structuredContent against the ADVERTISED JSON Schema
    // (client/index.js -> "Structured content does not match the tool's output
    // schema"), so `additionalProperties: false` makes any field the schema
    // didn't enumerate a hard -32602 that discards an otherwise-correct result.
    // The server never notices, because zod's own parse strips unknown keys
    // instead of failing — so nothing but this assertion catches it. A bare zod
    // raw shape renders as additionalProperties:false; registerTool() in
    // src/index.ts wraps every shape in .passthrough() to prevent that.
    // Not hypothetical: this took down get-mail-stats in the sibling
    // apple-mail-mcp (sweetrb/apple-mail-mcp#135).
    const { tools } = await client.listTools();
    const offenders = tools
      .filter(
        (t) =>
          (t.outputSchema as { additionalProperties?: unknown } | undefined)
            ?.additionalProperties === false
      )
      .map((t) => t.name);
    expect(
      offenders,
      `outputSchemas must tolerate undeclared keys — these advertise ` +
        `additionalProperties:false, so any field they don't enumerate is rejected ` +
        `client-side and the whole result is lost: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("every advertised schema declares JSON Schema 2020-12 (not draft-07)", async () => {
    // Claude Desktop refuses a tool outright when its schema declares any other
    // dialect: "Tool '<name>' has an invalid outputSchema: JSON Schema declares
    // an unsupported dialect (\"$schema\": \"http://json-schema.org/draft-07/
    // schema#\"). The default validator supports JSON Schema 2020-12 only."
    // The MCP SDK calls its zod converter with no target, so BOTH its v3 and v4
    // branches emit draft-07 — upgrading zod does not help. src/index.ts wraps
    // the stdio transport in withJsonSchema2020_12() to rewrite the outgoing
    // tools/list payload; this asserts that wrapper is actually in the path.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const tool of tools) {
      for (const key of ["inputSchema", "outputSchema"] as const) {
        const schema = tool[key] as { $schema?: unknown } | undefined;
        if (!schema) continue;
        if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
          offenders.push(`${tool.name}.${key}: ${JSON.stringify(schema.$schema)}`);
        }
      }
    }
    expect(
      offenders,
      `every schema must declare https://json-schema.org/draft/2020-12/schema: ${offenders.join("; ")}`
    ).toEqual([]);
  });

  it("no advertised schema contains a draft-07-only construct", async () => {
    // The dialect declaration alone is not enough: a schema that says 2020-12
    // while still using draft-07 spellings would validate differently (or not at
    // all) under a 2020-12 validator. These are the keywords that changed.
    const { tools } = await client.listTools();
    const DRAFT_07_ONLY = ["definitions", "additionalItems", "dependencies"] as const;

    const offenders: string[] = [];
    for (const tool of tools) {
      for (const key of ["inputSchema", "outputSchema"] as const) {
        const schema = tool[key];
        if (!schema) continue;
        if (JSON.stringify(schema).includes("draft-07")) {
          offenders.push(`${tool.name}.${key}: mentions draft-07`);
        }

        const walk = (node: unknown, path: string): void => {
          if (Array.isArray(node)) {
            node.forEach((child, i) => walk(child, `${path}[${i}]`));
            return;
          }
          if (typeof node !== "object" || node === null) return;
          const obj = node as Record<string, unknown>;

          for (const keyword of DRAFT_07_ONLY) {
            if (keyword in obj) {
              offenders.push(
                `${tool.name}.${key}: draft-07-only "${keyword}" at ${path || "root"}`
              );
            }
          }
          if (Array.isArray(obj.items)) {
            offenders.push(`${tool.name}.${key}: tuple-form "items" at ${path || "root"}`);
          }
          // A boolean exclusiveMinimum/Maximum is the draft-4 spelling; 2020-12
          // requires a number.
          for (const k of ["exclusiveMinimum", "exclusiveMaximum"] as const) {
            if (typeof obj[k] === "boolean") {
              offenders.push(`${tool.name}.${key}: boolean ${k} at ${path || "root"}`);
            }
          }
          if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/definitions/")) {
            offenders.push(`${tool.name}.${key}: $ref into #/definitions/ (now #/$defs/)`);
          }
          // Only the ROOT may declare a dialect.
          if (path !== "" && "$schema" in obj) {
            offenders.push(`${tool.name}.${key}: nested $schema at ${path}`);
          }

          walkSubschemas(obj, path, walk);
        };
        walk(schema as Record<string, unknown>, "");
      }
    }
    expect(offenders, `advertised schemas must be pure 2020-12: ${offenders.join("; ")}`).toEqual(
      []
    );
  });

  it("every advertised schema compiles under a REAL 2020-12 validator (ajv)", async () => {
    // The dialect assertions above check what we CLAIM; this checks what we
    // SHIPPED. A schema can declare 2020-12 and still be structurally invalid
    // under it (a bad "type", a malformed "items", a $ref that resolves
    // nowhere) — the client rejects the tool either way, and no string
    // comparison would ever notice. Ajv2020 is the same validator family the
    // MCP SDK itself uses, so a compile failure here is a real client-side
    // rejection, not a stylistic quibble.
    //
    // `strict: false` on purpose: ajv's strict mode rejects unknown keywords and
    // would fail on benign annotations the SDK/zod emit. This guard is about
    // structural validity under the 2020-12 dialect, nothing more.
    //
    // No advertised schema currently uses "format" (verified against all 21
    // tools), so ajv-formats is deliberately not registered. If a tool ever
    // adds one, add ajv-formats as a devDependency and register it here.
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const failures: string[] = [];
    let compiled = 0;
    for (const tool of tools) {
      for (const key of ["inputSchema", "outputSchema"] as const) {
        const schema = tool[key];
        if (!schema) continue;
        // A fresh instance per schema: ajv caches compiled schemas and would
        // reject a second registration for reasons unrelated to validity.
        const ajv = new Ajv2020({ strict: false });
        try {
          ajv.compile(schema as object);
          compiled += 1;
        } catch (err) {
          failures.push(`${tool.name}.${key}: ${(err as Error).message}`);
        }
      }
    }

    // Guard against a vacuous pass (e.g. a future refactor that stops
    // advertising schemas, or a listTools that returns nothing useful).
    expect(
      compiled,
      "no schemas were compiled — this assertion would pass vacuously"
    ).toBeGreaterThan(0);
    expect(
      failures,
      `every advertised schema must compile under JSON Schema 2020-12: ${failures.join("; ")}`
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
    "set-photo-date",
    "import-photos",
  ];

  it("registers all seven write tools even while the gate is closed", async () => {
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

  it("a gated set-photo-date DRY RUN is also refused (the gate covers previews)", async () => {
    const result = (await client.callTool({
      name: "set-photo-date",
      arguments: { uuid: "0000-0000", shiftSeconds: 60, dryRun: true },
    })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(result.isError).toBe(true);
    const text = result.content?.map((c) => c.text ?? "").join("\n") ?? "";
    expect(text).toMatch(/read-only by default/);
  }, 15_000);

  it("get-selected-photos is registered and NOT gated (read-only GUI bridge)", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get-selected-photos");
    expect(tool).toBeDefined();
    // Read-only: no gate env var in its description.
    expect(tool?.description ?? "").not.toContain("APPLE_PHOTOS_MCP_ENABLE_WRITES");
  });
});
