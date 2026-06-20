import { describe, it, expect } from "vitest";
import {
  successResponse,
  errorResponse,
  textResponse,
  withErrorHandling,
} from "@/tools/respond.js";

describe("respond helpers", () => {
  it("successResponse carries text and optional structuredContent", () => {
    const r = successResponse("hello", { count: 1 });
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.structuredContent).toEqual({ count: 1 });
    expect(r.isError).toBeUndefined();
  });

  it("successResponse omits structuredContent when not provided", () => {
    const r = successResponse("hi");
    expect(r.structuredContent).toBeUndefined();
  });

  it("errorResponse sets isError and optional structured payload", () => {
    const r = errorResponse("boom", { code: 7 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("boom");
    expect(r.structuredContent).toEqual({ code: 7 });
  });

  it("textResponse is a plain text result", () => {
    const r = textResponse("plain");
    expect(r).toEqual({ content: [{ type: "text", text: "plain" }] });
  });

  it("withErrorHandling passes through a successful result", () => {
    const wrapped = withErrorHandling(() => successResponse("ok"), "ctx");
    expect(wrapped({}).content[0].text).toBe("ok");
  });

  it("withErrorHandling converts a thrown error into a prefixed error response", () => {
    const wrapped = withErrorHandling(() => {
      throw new Error("nope");
    }, "doing thing");
    const r = wrapped({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("doing thing: nope");
  });

  it("withErrorHandling stringifies non-Error throws", () => {
    const wrapped = withErrorHandling(() => {
      throw "raw string";
    }, "ctx");
    expect(wrapped({}).content[0].text).toBe("ctx: raw string");
  });
});
