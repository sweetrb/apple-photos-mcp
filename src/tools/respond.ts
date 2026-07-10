/**
 * Shared MCP tool-response helpers.
 *
 * Every read tool returns a human-readable `text` block AND a machine-readable
 * `structuredContent` payload, so agents can consume results without parsing
 * prose. Mirrors the helpers used in apple-notes-mcp / apple-mail-mcp.
 */

export type ContentBlock =
  | { type: "text"; text: string; [k: string]: unknown }
  | { type: "image"; data: string; mimeType: string; [k: string]: unknown };

export interface ToolResponse {
  content: ContentBlock[];
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
 * A successful result whose payload is an IMAGE the client can render inline
 * (MCP image content block), preceded by a brief text summary. The structured
 * payload should carry the image's metadata but NOT the base64 data — it would
 * double a multi-hundred-KB response for no benefit.
 */
export function imageResponse(
  message: string,
  image: { data: string; mimeType: string },
  structured?: Record<string, unknown>
): ToolResponse {
  const res: ToolResponse = {
    content: [
      { type: "text", text: message },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
  };
  if (structured !== undefined) res.structuredContent = structured;
  return res;
}

/**
 * Wrap a tool handler so any thrown error (or rejected promise) becomes a
 * clean error response with a consistent prefix, instead of crashing the tool
 * call. Handlers may be sync or async — the result is awaited either way.
 *
 * The SDK invokes tool callbacks as (args, extra); `extra` is passed through
 * untouched so handlers that need request context (progress notifications via
 * `extra.sendNotification` + `extra._meta.progressToken`) can take it, while
 * one-argument handlers simply ignore it.
 */
export function withErrorHandling<T, E = unknown>(
  handler: (params: T, extra: E) => ToolResponse | Promise<ToolResponse>,
  prefix: string
): (params: T, extra: E) => Promise<ToolResponse> {
  return async (params: T, extra: E) => {
    try {
      return await handler(params, extra);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return errorResponse(`${prefix}: ${msg}`);
    }
  };
}
