import { describe, it, expect, vi } from "vitest";
import { registerResourcesAndPrompts } from "@/tools/resourcesAndPrompts.js";
import type { PhotosManager } from "@/services/photosManager.js";

/** Minimal fake McpServer capturing resource/prompt registrations. */
function fakeServer() {
  const resources = new Map<string, (uri: URL, vars?: Record<string, unknown>) => unknown>();
  const prompts = new Map<string, (args: Record<string, unknown>) => unknown>();
  return {
    resources,
    prompts,

    resource(name: string, _uriOrTemplate: any, cb: any) {
      resources.set(name, cb);
    },
    // prompt(name, description, [argsSchema], cb)

    prompt(name: string, _desc: string, schemaOrCb: any, maybeCb?: any) {
      prompts.set(name, typeof schemaOrCb === "function" ? schemaOrCb : maybeCb);
    },
  };
}

function mockManager(overrides: Partial<Record<keyof PhotosManager, unknown>> = {}) {
  return {
    getLibraryInfo: () => ({ libraryPath: "/L", photoCount: 3 }),
    listAlbums: () => ({ count: 1, albums: [{ uuid: "a", title: "A" }] }),
    listPersons: () => ({ count: 1, persons: [{ name: "Bob", count: 2 }] }),
    listKeywords: () => ({ count: 1, keywords: [{ keyword: "k", count: 5 }] }),
    getPhoto: (uuid: string) => ({ uuid, filename: "p.jpg" }),
    ...overrides,
  } as unknown as PhotosManager;
}

describe("registerResourcesAndPrompts", () => {
  it("registers all resources and prompts", () => {
    const server = fakeServer();
    registerResourcesAndPrompts(server as never, mockManager());
    expect([...server.resources.keys()].sort()).toEqual([
      "albums",
      "keywords",
      "library",
      "persons",
      "photo",
    ]);
    expect([...server.prompts.keys()].sort()).toEqual([
      "export-photos",
      "find-photos",
      "photo-summary",
    ]);
  });

  it("library resource returns the manager's library info as JSON", () => {
    const server = fakeServer();
    registerResourcesAndPrompts(server as never, mockManager());
    const out = server.resources.get("library")!(new URL("photos://library")) as {
      contents: { text: string }[];
    };
    expect(JSON.parse(out.contents[0].text)).toEqual({ libraryPath: "/L", photoCount: 3 });
  });

  it("photo template resource decodes the uuid variable", () => {
    const server = fakeServer();
    const getPhoto = vi.fn((uuid: string) => ({ uuid, filename: "p.jpg" }));
    registerResourcesAndPrompts(server as never, mockManager({ getPhoto }));
    const out = server.resources.get("photo")!(new URL("photos://photo/ABC%20123"), {
      uuid: "ABC%20123",
    }) as { contents: { text: string }[] };
    expect(getPhoto).toHaveBeenCalledWith("ABC 123");
    expect(JSON.parse(out.contents[0].text).uuid).toBe("ABC 123");
  });

  it("a failing resource returns a JSON error payload instead of throwing", () => {
    const server = fakeServer();
    registerResourcesAndPrompts(
      server as never,
      mockManager({
        getLibraryInfo: () => {
          throw new Error("Operation not permitted");
        },
      })
    );
    const out = server.resources.get("library")!(new URL("photos://library")) as {
      contents: { text: string }[];
    };
    expect(JSON.parse(out.contents[0].text).error).toContain("not permitted");
  });

  it("prompts produce a user message referencing their inputs", () => {
    const server = fakeServer();
    registerResourcesAndPrompts(server as never, mockManager());
    const find = server.prompts.get("find-photos")!({ criteria: "sunset" }) as {
      messages: { content: { text: string } }[];
    };
    expect(find.messages[0].content.text).toContain("sunset");
    const exp = server.prompts.get("export-photos")!({ criteria: "dogs", dest: "/tmp/out" }) as {
      messages: { content: { text: string } }[];
    };
    expect(exp.messages[0].content.text).toContain("dogs");
    expect(exp.messages[0].content.text).toContain("/tmp/out");
    const sum = server.prompts.get("photo-summary")!({}) as {
      messages: { content: { text: string } }[];
    };
    expect(sum.messages[0].content.text).toContain("library-info");
  });
});
