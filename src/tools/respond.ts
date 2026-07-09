/**
 * Shared MCP tool-response helpers.
 *
 * Every read tool returns a human-readable `text` block AND a machine-readable
 * `structuredContent` payload, so agents can consume results without parsing
 * prose. Mirrors the helpers used in apple-notes-mcp / apple-mail-mcp.
 */

export interface ToolResponse {
  content: { type: "text"; text: string; [k: string]: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [k: string]: unknown;
}

/** A successful result: human text plus optional typed JSON for agents. */
export function successResponse(
  message: string,
  structured?: Record<string, unknown>
): ToolResponse {
  const res: ToolResponse = { content: [{ type: "text", text: message }] };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

/** An error result. Optional structured payload carries machine-readable detail. */
export function errorResponse(message: string, structured?: Record<string, unknown>): ToolResponse {
  const res: ToolResponse = {
    content: [{ type: "text", text: message }],
    isError: true,
  };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

/** Plain text result with no structured payload (kept for back-compat). */
export function textResponse(text: string): ToolResponse {
  return { content: [{ type: "text", text }] };
}

/**
 * Wrap a tool handler so any thrown error (or rejected promise) becomes a
 * clean error response with a consistent prefix, instead of crashing the tool
 * call. Handlers may be sync or async — the result is awaited either way.
 */
export function withErrorHandling<T>(
  handler: (params: T) => ToolResponse | Promise<ToolResponse>,
  prefix: string
): (params: T) => Promise<ToolResponse> {
  return async (params: T) => {
    try {
      return await handler(params);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return errorResponse(`${prefix}: ${msg}`);
    }
  };
}
