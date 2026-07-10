import { describe, it, expect } from "vitest";
import {
  successResponse,
  errorResponse,
  textResponse,
  imageResponse,
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

  it("imageResponse carries a text summary followed by an image content block", () => {
    const r = imageResponse(
      "a thumbnail",
      { data: "aGVsbG8=", mimeType: "image/jpeg" },
      { uuid: "A", byteSize: 5 }
    );
    expect(r.content).toEqual([
      { type: "text", text: "a thumbnail" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/jpeg" },
    ]);
    expect(r.structuredContent).toEqual({ uuid: "A", byteSize: 5 });
    expect(r.isError).toBeUndefined();
  });

  it("imageResponse omits structuredContent when not provided", () => {
    const r = imageResponse("t", { data: "x", mimeType: "image/png" });
    expect(r.structuredContent).toBeUndefined();
  });

  it("withErrorHandling passes through a successful result", async () => {
    const wrapped = withErrorHandling(() => successResponse("ok"), "ctx");
    expect((await wrapped({})).content[0].text).toBe("ok");
  });

  it("withErrorHandling awaits an async handler", async () => {
    const wrapped = withErrorHandling(async () => successResponse("async ok"), "ctx");
    expect((await wrapped({})).content[0].text).toBe("async ok");
  });

  it("withErrorHandling converts a thrown error into a prefixed error response", async () => {
    const wrapped = withErrorHandling(() => {
      throw new Error("nope");
    }, "doing thing");
    const r = await wrapped({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("doing thing: nope");
  });

  it("withErrorHandling converts a rejected async handler into a prefixed error response", async () => {
    const wrapped = withErrorHandling(async () => {
      throw new Error("async nope");
    }, "doing thing");
    const r = await wrapped({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("doing thing: async nope");
  });

  it("withErrorHandling stringifies non-Error throws", async () => {
    const wrapped = withErrorHandling(() => {
      throw "raw string";
    }, "ctx");
    expect((await wrapped({})).content[0].text).toBe("ctx: raw string");
  });
});
