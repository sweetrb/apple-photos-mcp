/**
 * Unit tests for the JSON Schema dialect normalizer that rewrites outgoing MCP
 * tool schemas from the SDK's draft-07 output to JSON Schema 2020-12.
 *
 * The converter is a no-op on today's schemas — zod-to-json-schema emits nothing
 * but the dialect declaration that changed — so the keyword-rewrite cases below
 * are the guard that keeps it correct if a new zod construct ever introduces
 * one. See src/utils/jsonSchemaDialect.ts for the root cause.
 */
import { describe, it, expect, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSON_SCHEMA_2020_12,
  normalizeOutgoingMessage,
  toJsonSchema2020_12,
  withJsonSchema2020_12,
} from "./jsonSchemaDialect.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

describe("toJsonSchema2020_12", () => {
  it("declares the 2020-12 dialect at the root", () => {
    const out = toJsonSchema2020_12({ type: "object", properties: {} }) as Record<string, unknown>;
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("replaces a draft-07 root declaration rather than keeping both", () => {
    const out = toJsonSchema2020_12({ $schema: DRAFT_07, type: "object" }) as Record<
      string,
      unknown
    >;
    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("strips $schema from nested subschemas — only the root declares a dialect", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        nested: { $schema: DRAFT_07, type: "string" },
        list: { type: "array", items: { $schema: DRAFT_07, type: "number" } },
      },
    }) as any;

    expect(out.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(out.properties.nested).toEqual({ type: "string" });
    expect(out.properties.list.items).toEqual({ type: "number" });
    expect(JSON.stringify(out).match(/\$schema/g)).toHaveLength(1);
  });

  it("renames definitions to $defs and rewrites #/definitions/ refs to #/$defs/", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      definitions: { Photo: { type: "string" } },
      properties: { photo: { $ref: "#/definitions/Photo" } },
    }) as any;

    expect(out.$defs).toEqual({ Photo: { type: "string" } });
    expect(out.definitions).toBeUndefined();
    expect(out.properties.photo.$ref).toBe("#/$defs/Photo");
  });

  it("leaves a non-definitions $ref (e.g. a sibling property pointer) untouched", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      properties: {
        dateFrom: { type: "string" },
        dateTo: { $ref: "#/properties/dateFrom" },
      },
    }) as any;

    expect(out.properties.dateTo.$ref).toBe("#/properties/dateFrom");
  });

  it("converts tuple items to prefixItems and a sibling additionalItems to items", () => {
    const out = toJsonSchema2020_12({
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: { type: "boolean" },
    }) as any;

    expect(out.prefixItems).toEqual([{ type: "string" }, { type: "number" }]);
    expect(out.items).toEqual({ type: "boolean" });
    expect(out.additionalItems).toBeUndefined();
  });

  it("drops a stray additionalItems when items is NOT a tuple, rather than clobbering items", () => {
    const out = toJsonSchema2020_12({
      type: "array",
      items: { type: "string" },
      additionalItems: { type: "boolean" },
    }) as any;

    expect(out.items).toEqual({ type: "string" });
    expect(out.additionalItems).toBeUndefined();
    expect(out.prefixItems).toBeUndefined();
  });

  it("splits dependencies into dependentRequired (arrays) and dependentSchemas (objects)", () => {
    const out = toJsonSchema2020_12({
      type: "object",
      dependencies: {
        creditCard: ["billingAddress"],
        shipped: { properties: { trackingNumber: { type: "string" } } },
      },
    }) as any;

    expect(out.dependencies).toBeUndefined();
    expect(out.dependentRequired).toEqual({ creditCard: ["billingAddress"] });
    expect(out.dependentSchemas).toEqual({
      shipped: { properties: { trackingNumber: { type: "string" } } },
    });
  });

  it("collapses boolean exclusiveMinimum:true + minimum into a numeric exclusiveMinimum", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      minimum: 5,
      exclusiveMinimum: true,
    }) as any;

    expect(out.exclusiveMinimum).toBe(5);
    expect(out.minimum).toBeUndefined();
  });

  it("drops exclusiveMinimum:false and keeps minimum", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      minimum: 5,
      exclusiveMinimum: false,
    }) as any;

    expect(out.minimum).toBe(5);
    expect(out.exclusiveMinimum).toBeUndefined();
  });

  it("collapses boolean exclusiveMaximum:true + maximum, and drops exclusiveMaximum:false", () => {
    const collapsed = toJsonSchema2020_12({
      type: "number",
      maximum: 10,
      exclusiveMaximum: true,
    }) as any;
    expect(collapsed.exclusiveMaximum).toBe(10);
    expect(collapsed.maximum).toBeUndefined();

    const kept = toJsonSchema2020_12({
      type: "number",
      maximum: 10,
      exclusiveMaximum: false,
    }) as any;
    expect(kept.maximum).toBe(10);
    expect(kept.exclusiveMaximum).toBeUndefined();
  });

  it("passes an already-numeric exclusiveMinimum/Maximum through unchanged", () => {
    const out = toJsonSchema2020_12({
      type: "number",
      exclusiveMinimum: 1,
      exclusiveMaximum: 9,
    }) as any;

    expect(out.exclusiveMinimum).toBe(1);
    expect(out.exclusiveMaximum).toBe(9);
  });

  it("returns non-object schemas (booleans, null) untouched", () => {
    expect(toJsonSchema2020_12(true)).toBe(true);
    expect(toJsonSchema2020_12(false)).toBe(false);
    expect(toJsonSchema2020_12(null)).toBe(null);
  });
});

describe("normalizeOutgoingMessage", () => {
  const toolsListResult = () => ({
    jsonrpc: "2.0" as const,
    id: 2,
    result: {
      tools: [
        {
          name: "query",
          inputSchema: { $schema: DRAFT_07, type: "object", properties: {} },
          outputSchema: { $schema: DRAFT_07, type: "object", properties: {} },
        },
        {
          name: "health-check",
          inputSchema: { $schema: DRAFT_07, type: "object", properties: {} },
        },
      ],
    },
  });

  it("rewrites inputSchema and outputSchema on every tool in a tools/list result", () => {
    const out = normalizeOutgoingMessage(toolsListResult()) as any;

    expect(out.result.tools).toHaveLength(2);
    for (const tool of out.result.tools) {
      expect(tool.inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    }
    expect(out.result.tools[0].outputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(JSON.stringify(out)).not.toContain("draft-07");
  });

  it("leaves a tool without an outputSchema alone (does not invent one)", () => {
    const out = normalizeOutgoingMessage(toolsListResult()) as any;

    expect(out.result.tools[1].name).toBe("health-check");
    expect("outputSchema" in out.result.tools[1]).toBe(false);
  });

  it("preserves every other field on the message and on each tool", () => {
    const message = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        nextCursor: "abc",
        tools: [
          {
            name: "query",
            title: "Query photos",
            description: "…",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object" },
          },
        ],
      },
    };
    const out = normalizeOutgoingMessage(message) as any;

    expect(out.jsonrpc).toBe("2.0");
    expect(out.id).toBe(2);
    expect(out.result.nextCursor).toBe("abc");
    expect(out.result.tools[0]).toMatchObject({
      name: "query",
      title: "Query photos",
      description: "…",
      annotations: { readOnlyHint: true },
    });
  });

  it("returns a tools/call result byte-identical", () => {
    const message = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "ok" }], structuredContent: { healthy: true } },
    };
    const out = normalizeOutgoingMessage(message);

    expect(out).toBe(message);
    expect(JSON.stringify(out)).toBe(JSON.stringify(message));
  });

  it("returns a notification byte-identical", () => {
    const message = {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 1, progress: 3, total: 10 },
    };
    const out = normalizeOutgoingMessage(message);

    expect(out).toBe(message);
    expect(JSON.stringify(out)).toBe(JSON.stringify(message));
  });

  it("returns an error response and non-object inputs unchanged", () => {
    const error = { jsonrpc: "2.0", id: 4, error: { code: -32601, message: "Method not found" } };
    expect(normalizeOutgoingMessage(error)).toBe(error);
    expect(normalizeOutgoingMessage(null)).toBe(null);
    expect(normalizeOutgoingMessage("not a message")).toBe("not a message");
  });
});

describe("withJsonSchema2020_12", () => {
  it("returns the same transport instance", () => {
    const transport = { send: vi.fn(async () => {}) } as unknown as Transport;
    expect(withJsonSchema2020_12(transport)).toBe(transport);
  });

  it("delegates to the original send with the NORMALIZED message, forwarding options", async () => {
    const sent: Array<{ message: unknown; options: unknown }> = [];
    const originalSend = vi.fn(async (message: unknown, options?: unknown) => {
      sent.push({ message, options });
    });
    const transport = { send: originalSend } as unknown as Transport;

    withJsonSchema2020_12(transport);

    await transport.send(
      {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            {
              name: "query",
              inputSchema: { $schema: DRAFT_07, type: "object" },
              outputSchema: { $schema: DRAFT_07, type: "object" },
            },
          ],
        },
      } as any,
      { relatedRequestId: 7 }
    );

    expect(originalSend).toHaveBeenCalledTimes(1);
    const delivered = sent[0].message as any;
    expect(delivered.result.tools[0].inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(delivered.result.tools[0].outputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
    expect(JSON.stringify(delivered)).not.toContain("draft-07");
    expect(sent[0].options).toEqual({ relatedRequestId: 7 });
  });

  it("passes a non-tools/list message straight through to the original send", async () => {
    const originalSend = vi.fn(async () => {});
    const transport = { send: originalSend } as unknown as Transport;
    const message = { jsonrpc: "2.0", method: "notifications/initialized" };

    withJsonSchema2020_12(transport);
    await transport.send(message as any);

    expect(originalSend).toHaveBeenCalledWith(message, undefined);
    expect(originalSend.mock.calls[0][0]).toBe(message);
  });

  it("keeps the original send bound to its transport (no lost `this`)", async () => {
    class FakeTransport {
      sentFrom: unknown = null;
      async send(message: unknown) {
        // Would throw on an unbound call.
        this.sentFrom = message;
      }
    }
    const transport = new FakeTransport() as unknown as Transport;
    withJsonSchema2020_12(transport);

    await transport.send({ jsonrpc: "2.0", method: "ping" } as any);
    expect((transport as unknown as FakeTransport).sentFrom).toEqual({
      jsonrpc: "2.0",
      method: "ping",
    });
  });
});
