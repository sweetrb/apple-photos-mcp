/**
 * MCP resources & prompts for apple-photos.
 *
 * Resources expose read-only views agents can attach as context without a tool
 * round-trip (library info, albums, persons, keywords, and a photo-by-uuid
 * template). Prompts are reusable starting points for common Photos workflows.
 *
 * @module tools/resourcesAndPrompts
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PhotosManager } from "../services/photosManager.js";

const json = (uri: URL, data: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }],
});

export function registerResourcesAndPrompts(server: McpServer, manager: PhotosManager): void {
  // --- Resources ---
  // Async callbacks: the manager's sidecar calls are awaited (and serialized
  // through the same gate as the tools), so a resource read never blocks the
  // event loop either.
  server.resource("library", "photos://library", async (uri) => {
    try {
      return json(uri, await manager.getLibraryInfo());
    } catch (err) {
      return json(uri, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.resource("albums", "photos://albums", async (uri) => {
    try {
      return json(uri, await manager.listAlbums());
    } catch (err) {
      return json(uri, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.resource("persons", "photos://persons", async (uri) => {
    try {
      return json(uri, await manager.listPersons());
    } catch (err) {
      return json(uri, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.resource("keywords", "photos://keywords", async (uri) => {
    try {
      return json(uri, await manager.listKeywords());
    } catch (err) {
      return json(uri, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.resource(
    "photo",
    new ResourceTemplate("photos://photo/{uuid}", { list: undefined }),
    async (uri, variables) => {
      try {
        const uuid = decodeURIComponent(String(variables.uuid));
        return json(uri, await manager.getPhoto(uuid));
      } catch (err) {
        return json(uri, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  // --- Prompts ---
  server.prompt(
    "find-photos",
    "Find photos matching criteria and summarize them",
    { criteria: z.string().describe("What photos to look for (people, dates, keywords, etc.)") },
    ({ criteria }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the query tool to find photos matching: "${criteria}". Translate the criteria into appropriate filters (persons, keywords, date ranges, favorites, media type, etc.), run the query, and give me a concise summary of what you found including counts and a few representative photo UUIDs.`,
          },
        },
      ],
    })
  );

  server.prompt(
    "export-photos",
    "Find photos matching criteria and export them to a destination",
    {
      criteria: z.string().describe("What photos to look for (people, dates, keywords, etc.)"),
      dest: z.string().describe("Destination directory to export the photos to"),
    },
    ({ criteria, dest }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use the query tool to find photos matching: "${criteria}". Then export the matching photos to "${dest}" using the export tool. Confirm how many photos were exported and report any that failed.`,
          },
        },
      ],
    })
  );

  server.prompt("photo-summary", "Summarize the contents of the photo library", () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Use the library-info tool to get overall library stats, list-persons to see who appears most often, and list-keywords to see the top keywords. Combine these into a concise summary of what's in my photo library — total counts, the most-photographed people, and the dominant themes/keywords.",
        },
      },
    ],
  }));
}
