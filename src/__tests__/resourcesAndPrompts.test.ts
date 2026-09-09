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

  it("library resource returns the manager's library info as JSON", async () => {
    const server = fakeServer();
    registerResourcesAndPrompts(server as never, mockManager());
    const out = (await server.resources.get("library")!(new URL("photos://library"))) as {
      contents: { text: string }[];
    };
    expect(JSON.parse(out.contents[0].text)).toEqual({ libraryPath: "/L", photoCount: 3 });
  });

  it("photo template resource decodes the uuid variable", async () => {
    const server = fakeServer();
    const getPhoto = vi.fn(async (uuid: string) => ({ uuid, filename: "p.jpg" }));
    registerResourcesAndPrompts(server as never, mockManager({ getPhoto }));
    const out = (await server.resources.get("photo")!(new URL("photos://photo/ABC%20123"), {
      uuid: "ABC%20123",
    })) as { contents: { text: string }[] };
    expect(getPhoto).toHaveBeenCalledWith("ABC 123");
    expect(JSON.parse(out.contents[0].text).uuid).toBe("ABC 123");
  });

  // vitest 4's AST-aware v8 remapping stopped crediting registered-but-never-invoked
  // callbacks, which exposed that the albums/persons/keywords resources and most of
  // the catch paths had no test at all. These drive each one directly.
  it.each([
    ["albums", { count: 1, albums: [{ uuid: "a", title: "A" }] }],
    ["persons", { count: 1, persons: [{ name: "Bob", count: 2 }] }],
    ["keywords", { count: 1, keywords: [{ keyword: "k", count: 5 }] }],
  ] as const)("%s resource returns the manager's payload as JSON", async (name, expected) => {
    const server = fakeServer();
    registerResourcesAndPrompts(server as never, mockManager());
    const out = (await server.resources.get(name)!(new URL(`photos://${name}`))) as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    expect(out.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(out.contents[0].text)).toEqual(expected);
  });

  // Every resource catch does `err instanceof Error ? err.message : String(err)`,
  // so each one is driven with both a thrown Error and a thrown non-Error to
  // exercise both sides of that ternary.
  it.each([
    ["library", "getLibraryInfo"],
    ["albums", "listAlbums"],
    ["persons", "listPersons"],
    ["keywords", "listKeywords"],
    ["photo", "getPhoto"],
  ] as const)("%s resource degrades a thrown Error into a JSON error payload", async (name, fn) => {
    const server = fakeServer();
    registerResourcesAndPrompts(
      server as never,
      mockManager({
        [fn]: () => {
          throw new Error("Operation not permitted");
        },
      })
    );
    const out = (await server.resources.get(name)!(new URL(`photos://${name}`), {
      uuid: "ZZZ",
    })) as { contents: { text: string }[] };
    expect(JSON.parse(out.contents[0].text).error).toBe("Operation not permitted");
  });

  it.each([
    ["library", "getLibraryInfo"],
    ["albums", "listAlbums"],
    ["persons", "listPersons"],
    ["keywords", "listKeywords"],
    ["photo", "getPhoto"],
  ] as const)(
    "%s resource stringifies a thrown non-Error rather than losing it",
    async (name, fn) => {
      const server = fakeServer();
      registerResourcesAndPrompts(
        server as never,
        mockManager({
          [fn]: () => {
            throw "plain string failure";
          },
        })
      );
      const out = (await server.resources.get(name)!(new URL(`photos://${name}`), {
        uuid: "ZZZ",
      })) as { contents: { text: string }[] };
      expect(JSON.parse(out.contents[0].text).error).toBe("plain string failure");
    }
  );

  it("a failing resource returns a JSON error payload instead of rejecting", async () => {
    const server = fakeServer();
    registerResourcesAndPrompts(
      server as never,
      mockManager({
        getLibraryInfo: () => {
          throw new Error("Operation not permitted");
        },
      })
    );
    const out = (await server.resources.get("library")!(new URL("photos://library"))) as {
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
