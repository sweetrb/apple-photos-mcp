/**
 * Shared MCP tool-response helpers.
 *
 * Every read tool returns a human-readable `text` block AND a machine-readable
 * `structuredContent` payload, so agents can consume results without parsing
 * prose. Mirrors the helpers used in apple-notes-mcp / apple-mail-mcp.
 */
/** A successful result: human text plus optional typed JSON for agents. */
export function successResponse(message, structured) {
    const res = { content: [{ type: "text", text: message }] };
    if (structured !== undefined)
        res.structuredContent = structured;
    return res;
}
/** An error result. Optional structured payload carries machine-readable detail. */
export function errorResponse(message, structured) {
    const res = {
        content: [{ type: "text", text: message }],
        isError: true,
    };
    if (structured !== undefined)
        res.structuredContent = structured;
    return res;
}
/** Plain text result with no structured payload (kept for back-compat). */
export function textResponse(text) {
    return { content: [{ type: "text", text }] };
}
/**
 * Wrap a tool handler so any thrown error becomes a clean error response with a
 * consistent prefix, instead of crashing the tool call.
 */
export function withErrorHandling(handler, prefix) {
    return (params) => {
        try {
            return handler(params);
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            return errorResponse(`${prefix}: ${msg}`);
        }
    };
}
