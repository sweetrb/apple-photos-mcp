#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PhotosManager } from "./services/photosManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const version: string = pkg.version;

const manager = new PhotosManager();

function errorResponse(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function withErrorHandling<T>(
  handler: (params: T) => ReturnType<typeof textResponse>,
  prefix: string
) {
  return (params: T) => {
    try {
      return handler(params);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return errorResponse(`${prefix}: ${msg}`);
    }
  };
}

const server = new McpServer({
  name: "apple-photos",
  version,
  description:
    "MCP server for Apple Photos via osxphotos. Query the Photos library by date, album, " +
    "keyword, person, or favorite/hidden flags; list albums/folders/keywords/persons; " +
    "fetch full photo metadata (location, dimensions, EXIF-derived flags); and export " +
    "originals or edited versions to a directory. Read-only against the Photos library.",
});

const libraryArg = {
  library: z
    .string()
    .optional()
    .describe("Path to a .photoslibrary (default: system Photos library)"),
};

// --- health-check ---
server.tool(
  "health-check",
  "Verify osxphotos is installed and the Photos library can be opened",
  {},
  withErrorHandling(() => {
    const result = manager.healthCheck();
    return textResponse(result.ok ? `OK ${result.message}` : `FAIL ${result.message}`);
  }, "health-check")
);

// --- library-info ---
server.tool(
  "library-info",
  "Get high-level stats about the Photos library: counts of photos, movies, albums, folders, keywords, and persons",
  libraryArg,
  withErrorHandling(({ library }) => {
    const info = manager.getLibraryInfo(library);
    return textResponse(
      `Library: ${info.libraryPath}\n` +
        `Photos DB version: ${info.dbVersion} (Photos.app ${info.photosVersion})\n\n` +
        `Photos:    ${info.photoCount}\n` +
        `Movies:    ${info.movieCount}\n` +
        `Total:     ${info.totalCount}\n` +
        `Albums:    ${info.albumCount}\n` +
        `Folders:   ${info.folderCount}\n` +
        `Keywords:  ${info.keywordCount}\n` +
        `Persons:   ${info.personCount}`
    );
  }, "library-info")
);

// --- query ---
server.tool(
  "query",
  "Search the Photos library. Combine filters (album, keyword, person, date range, favorite, " +
    "hidden, photo/movie type, title/description substrings) to narrow results. Returns photo " +
    "summaries with UUIDs — use get-photo for full details on a specific match.",
  {
    ...libraryArg,
    uuid: z.array(z.string()).optional().describe("Specific UUIDs to fetch"),
    album: z.array(z.string()).optional().describe("Album name(s); ANY-match"),
    keyword: z.array(z.string()).optional().describe("Keyword(s); ANY-match"),
    person: z.array(z.string()).optional().describe("Person name(s); ANY-match"),
    fromDate: z.string().optional().describe("ISO 8601 lower bound on photo date"),
    toDate: z.string().optional().describe("ISO 8601 upper bound on photo date"),
    favorite: z.boolean().optional().describe("Only favorites"),
    notFavorite: z.boolean().optional().describe("Exclude favorites"),
    hidden: z.boolean().optional().describe("Only hidden photos"),
    notHidden: z.boolean().optional().describe("Exclude hidden photos (default behavior)"),
    photos: z.boolean().optional().describe("Include still photos"),
    movies: z.boolean().optional().describe("Include movies"),
    title: z.string().optional().describe("Substring match on title"),
    description: z.string().optional().describe("Substring match on description"),
    limit: z.number().int().positive().optional().describe("Cap the number of results"),
  },
  withErrorHandling(({ library, ...filters }) => {
    const result = manager.query(filters, library);
    if (result.count === 0) {
      return textResponse("No photos matched the query.");
    }
    const lines = result.photos.map((p) => {
      const flags: string[] = [];
      if (p.favorite) flags.push("★");
      if (p.hidden) flags.push("hidden");
      if (p.isMovie) flags.push("movie");
      const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
      const dims = p.width && p.height ? ` ${p.width}×${p.height}` : "";
      return `${p.date ?? "?"} ${p.uuid} — ${p.filename}${dims}${flagStr}`;
    });
    return textResponse(`Found ${result.count} photo(s):\n\n${lines.join("\n")}`);
  }, "query")
);

// --- get-photo ---
server.tool(
  "get-photo",
  "Get full metadata for a single photo by UUID — dimensions, dates, location, place, " +
    "albums, keywords, persons, labels, and type flags (HDR/live/raw/edited/etc.)",
  {
    ...libraryArg,
    uuid: z.string().describe("Photo UUID"),
  },
  withErrorHandling(({ library, uuid }) => {
    const p = manager.getPhoto(uuid, library);
    const lines = [
      `UUID:        ${p.uuid}`,
      `Filename:    ${p.filename}`,
      `Date:        ${p.date ?? "(none)"}`,
      `Title:       ${p.title ?? "(none)"}`,
      `Description: ${p.description ?? "(none)"}`,
      `Dimensions:  ${p.width}×${p.height}` +
        (p.originalWidth && p.originalWidth !== p.width
          ? ` (original ${p.originalWidth}×${p.originalHeight})`
          : ""),
      `Type:        ${p.isMovie ? "movie" : "photo"}${p.isRaw ? " (raw)" : ""}${p.isEdited ? " (edited)" : ""}`,
      `Path:        ${p.path ?? "(missing)"}`,
    ];
    if (p.location) {
      lines.push(`Location:    ${p.location.latitude}, ${p.location.longitude}`);
    }
    if (p.place?.name) {
      lines.push(`Place:       ${p.place.name}${p.place.country ? ` (${p.place.country})` : ""}`);
    }
    if (p.albums.length) lines.push(`Albums:      ${p.albums.join(", ")}`);
    if (p.keywords.length) lines.push(`Keywords:    ${p.keywords.join(", ")}`);
    if (p.persons.length) lines.push(`Persons:     ${p.persons.join(", ")}`);
    if (p.labels.length) lines.push(`Labels:      ${p.labels.join(", ")}`);
    return textResponse(lines.join("\n"));
  }, "get-photo")
);

// --- list-albums ---
server.tool(
  "list-albums",
  "List all albums in the library, including their folder paths and photo counts",
  libraryArg,
  withErrorHandling(({ library }) => {
    const { count, albums } = manager.listAlbums(library);
    if (count === 0) return textResponse("No albums.");
    const lines = albums.map((a) => {
      const path = a.folder.length ? `${a.folder.join(" / ")} / ` : "";
      const shared = a.isShared ? " [shared]" : "";
      return `${path}${a.title} (${a.photoCount})${shared} — ${a.uuid}`;
    });
    return textResponse(`${count} album(s):\n\n${lines.join("\n")}`);
  }, "list-albums")
);

// --- list-folders ---
server.tool(
  "list-folders",
  "List all folders in the library with their parent and album/subfolder counts",
  libraryArg,
  withErrorHandling(({ library }) => {
    const { count, folders } = manager.listFolders(library);
    if (count === 0) return textResponse("No folders.");
    const lines = folders.map(
      (f) =>
        `${f.title}${f.parent ? ` (in ${f.parent})` : ""} — ${f.albumCount} albums, ${f.subfolderCount} subfolders`
    );
    return textResponse(`${count} folder(s):\n\n${lines.join("\n")}`);
  }, "list-folders")
);

// --- list-keywords ---
server.tool(
  "list-keywords",
  "List keywords sorted by usage count. Use limit to cap.",
  {
    ...libraryArg,
    limit: z.number().int().positive().optional().describe("Top-N keywords"),
  },
  withErrorHandling(({ library, limit }) => {
    const { count, keywords } = manager.listKeywords(limit, library);
    if (count === 0) return textResponse("No keywords.");
    const lines = keywords.map((k) => `${k.count.toString().padStart(6)}  ${k.keyword}`);
    return textResponse(`${count} keyword(s):\n\n${lines.join("\n")}`);
  }, "list-keywords")
);

// --- list-persons ---
server.tool(
  "list-persons",
  "List people detected by Photos face recognition, sorted by photo count",
  {
    ...libraryArg,
    limit: z.number().int().positive().optional().describe("Top-N persons"),
  },
  withErrorHandling(({ library, limit }) => {
    const { count, persons } = manager.listPersons(limit, library);
    if (count === 0) return textResponse("No persons.");
    const lines = persons.map((p) => `${p.count.toString().padStart(6)}  ${p.name}`);
    return textResponse(`${count} person(s):\n\n${lines.join("\n")}`);
  }, "list-persons")
);

// --- export ---
server.tool(
  "export",
  "Export one or more photos (by UUID) to a destination directory. " +
    "By default exports the original. Use edited=true to export the edited version, " +
    "live=true to include the live-photo video, raw=true to include the raw image. " +
    "If an original isn't on disk (iCloud-only), the export falls back to Photos.app " +
    "to download it on demand — same behavior as opening the photo in Photos. " +
    "This can be slow for large batches; expect waits proportional to download size.",
  {
    ...libraryArg,
    uuid: z.array(z.string()).min(1).describe("Photo UUID(s) to export"),
    dest: z.string().describe("Destination directory (created if missing)"),
    edited: z.boolean().optional().describe("Export the edited version instead of the original"),
    live: z.boolean().optional().describe("Also export the live-photo video"),
    raw: z.boolean().optional().describe("Also export the raw image"),
    overwrite: z.boolean().optional().describe("Overwrite existing files at the destination"),
  },
  withErrorHandling(({ library, uuid, dest, edited, live, raw, overwrite }) => {
    const result = manager.exportPhotos(uuid, dest, {
      edited,
      live,
      raw,
      overwrite,
      library,
    });
    const lines = [
      `Destination: ${result.destination}`,
      `Exported:    ${result.exportedCount} file(s)`,
      `Skipped:     ${result.skippedCount}`,
    ];
    if (result.exported.length) {
      lines.push("", "Files:", ...result.exported.map((f) => `  ${f}`));
    }
    if (result.skipped.length) {
      lines.push("", "Skipped:", ...result.skipped.map((s) => `  ${s.uuid}: ${s.error}`));
    }
    return textResponse(lines.join("\n"));
  }, "export")
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`apple-photos-mcp v${version} running on stdio`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
