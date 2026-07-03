#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PhotosManager } from "./services/photosManager.js";
import { successResponse, withErrorHandling } from "./tools/respond.js";
import { runDoctor, formatDoctorReport } from "./tools/doctor.js";
import { registerResourcesAndPrompts } from "./tools/resourcesAndPrompts.js";
import { loadFileConfig } from "./services/fileConfig.js";
// Load file-based config FIRST — before anything reads APPLE_PHOTOS_MCP_* env
// vars — so settings survive a host that strips the MCP env block.
loadFileConfig();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const version = pkg.version;
const manager = new PhotosManager();
const server = new McpServer({
    name: "apple-photos",
    version,
    description: "MCP server for Apple Photos via osxphotos. Query the Photos library by date, album, " +
        "keyword, person, or favorite/hidden flags; list albums/folders/keywords/persons; " +
        "fetch full photo metadata (location, dimensions, EXIF-derived flags); and export " +
        "originals or edited versions to a directory. Read-only against the Photos library. " +
        "Read tools also return structuredContent (typed JSON) alongside the text.",
});
const libraryArg = {
    library: z
        .string()
        .max(4096)
        .optional()
        .describe("Path to a .photoslibrary (default: system Photos library)"),
};
// --- health-check ---
server.registerTool("health-check", {
    description: "Use when: you want a quick smoke test that osxphotos is installed and the Photos library can be opened.\n" +
        "Returns: ok/fail plus the osxphotos version, library path, and total photo count.\n" +
        "Do not use when: you need a full setup diagnostic that pinpoints whether the failure is a missing osxphotos, an unreadable library, or denied Full Disk Access — use doctor instead.",
    inputSchema: {},
    outputSchema: {
        ok: z.boolean().optional(),
        message: z.string().optional(),
    },
}, withErrorHandling(() => {
    const result = manager.healthCheck();
    return successResponse(result.ok ? `OK ${result.message}` : `FAIL ${result.message}`, {
        ...result,
    });
}, "health-check"));
// --- doctor ---
server.registerTool("doctor", {
    description: "Use when: a tool returns a permission or 'unable to open' error, or you want a full setup diagnostic before querying or exporting.\n" +
        "Returns: three checks — osxphotos install, Photos library readability, and Full Disk Access — each reported ok/warn/fail with actionable advice.\n" +
        "Do not use when: you only need the lightweight is-it-working smoke test — use health-check instead.",
    inputSchema: {},
    outputSchema: {
        healthy: z.boolean().optional(),
        checks: z
            .array(z
            .object({
            name: z.string().optional(),
            status: z.string().optional(),
            detail: z.string().optional(),
        })
            .passthrough())
            .optional(),
    },
}, withErrorHandling(() => {
    const report = runDoctor(manager);
    return successResponse(formatDoctorReport(report), { ...report });
}, "doctor"));
// --- library-info ---
server.registerTool("library-info", {
    description: "Use when: you want high-level stats about the whole library — total counts of photos, movies, albums, folders, keywords, and persons — or to confirm which library you're targeting before drilling in.\n" +
        "Returns: the library path, Photos DB and Photos.app versions, and the six counts.\n" +
        "Do not use when: you want the actual albums/keywords/persons rather than just their counts — use list-albums / list-keywords / list-persons; or you want to find specific photos — use query.",
    inputSchema: libraryArg,
    outputSchema: {
        libraryPath: z.string().optional(),
        dbVersion: z.string().optional(),
        photosVersion: z.union([z.string(), z.number()]).optional(),
        photoCount: z.number().optional(),
        movieCount: z.number().optional(),
        totalCount: z.number().optional(),
        albumCount: z.number().optional(),
        folderCount: z.number().optional(),
        keywordCount: z.number().optional(),
        personCount: z.number().optional(),
    },
}, withErrorHandling(({ library }) => {
    const info = manager.getLibraryInfo(library);
    return successResponse(`Library: ${info.libraryPath}\n` +
        `Photos DB version: ${info.dbVersion} (Photos.app ${info.photosVersion})\n\n` +
        `Photos:    ${info.photoCount}\n` +
        `Movies:    ${info.movieCount}\n` +
        `Total:     ${info.totalCount}\n` +
        `Albums:    ${info.albumCount}\n` +
        `Folders:   ${info.folderCount}\n` +
        `Keywords:  ${info.keywordCount}\n` +
        `Persons:   ${info.personCount}`, { ...info });
}, "library-info"));
// --- query ---
server.registerTool("query", {
    description: "Use when: you need to find photos matching one or more filters — album, keyword, person, ISO date range, favorite/hidden flags, photo/movie type, or title/description substrings — and get back a list of matches. This is the primary search/discovery tool; start here when you don't already have a UUID.\n" +
        "Returns: a count plus photo summaries (UUID, filename, date, dimensions, favorite/hidden/movie flags) — feed a UUID into get-photo for full metadata or into export to copy files.\n" +
        "Do not use when: you already have a UUID and want full metadata for that one photo — use get-photo; or you just want the catalog of album/keyword/person names — use list-albums / list-keywords / list-persons.",
    inputSchema: {
        ...libraryArg,
        uuid: z.array(z.string().max(256)).max(1000).optional().describe("Specific UUIDs to fetch"),
        album: z.array(z.string().max(1024)).max(100).optional().describe("Album name(s); ANY-match"),
        keyword: z.array(z.string().max(1024)).max(100).optional().describe("Keyword(s); ANY-match"),
        person: z
            .array(z.string().max(1024))
            .max(100)
            .optional()
            .describe("Person name(s); ANY-match"),
        fromDate: z.string().max(64).optional().describe("ISO 8601 lower bound on photo date"),
        toDate: z.string().max(64).optional().describe("ISO 8601 upper bound on photo date"),
        favorite: z.boolean().optional().describe("Only favorites"),
        notFavorite: z.boolean().optional().describe("Exclude favorites"),
        hidden: z.boolean().optional().describe("Only hidden photos"),
        notHidden: z.boolean().optional().describe("Exclude hidden photos (default behavior)"),
        photos: z.boolean().optional().describe("Include still photos"),
        movies: z.boolean().optional().describe("Include movies"),
        title: z.string().max(1024).optional().describe("Substring match on title"),
        description: z.string().max(2048).optional().describe("Substring match on description"),
        limit: z
            .number()
            .int()
            .positive()
            .max(100000)
            .optional()
            .describe("Cap the number of results"),
    },
    outputSchema: {
        count: z.number().optional(),
        photos: z.array(z.object({}).passthrough()).optional(),
    },
}, withErrorHandling(({ library, ...filters }) => {
    const result = manager.query(filters, library);
    if (result.count === 0) {
        return successResponse("No photos matched the query.", { count: 0, photos: [] });
    }
    const lines = result.photos.map((p) => {
        const flags = [];
        if (p.favorite)
            flags.push("★");
        if (p.hidden)
            flags.push("hidden");
        if (p.isMovie)
            flags.push("movie");
        const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
        const dims = p.width && p.height ? ` ${p.width}×${p.height}` : "";
        return `${p.date ?? "?"} ${p.uuid} — ${p.filename}${dims}${flagStr}`;
    });
    return successResponse(`Found ${result.count} photo(s):\n\n${lines.join("\n")}`, {
        count: result.count,
        photos: result.photos,
    });
}, "query"));
// --- get-photo ---
server.registerTool("get-photo", {
    description: "Use when: you have a single photo's UUID (typically from query) and want its complete metadata.\n" +
        "Returns: dimensions and original dimensions, dates, title/description, location and place, albums, keywords, persons, labels, file paths, size, and type flags (HDR/live/raw/edited/portrait/panorama/etc.).\n" +
        "Do not use when: you don't have a UUID yet, or you want to inspect many photos at once — use query to find and summarize matches first.",
    inputSchema: {
        ...libraryArg,
        uuid: z.string().describe("Photo UUID"),
    },
    outputSchema: {
        photo: z.object({}).passthrough().optional(),
    },
}, withErrorHandling(({ library, uuid }) => {
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
    if (p.albums.length)
        lines.push(`Albums:      ${p.albums.join(", ")}`);
    if (p.keywords.length)
        lines.push(`Keywords:    ${p.keywords.join(", ")}`);
    if (p.persons.length)
        lines.push(`Persons:     ${p.persons.join(", ")}`);
    if (p.labels.length)
        lines.push(`Labels:      ${p.labels.join(", ")}`);
    return successResponse(lines.join("\n"), { photo: p });
}, "get-photo"));
// --- list-albums ---
server.registerTool("list-albums", {
    description: "Use when: you want the catalog of albums — e.g. to discover exact album names before filtering query by album, or to browse the library's organization.\n" +
        "Returns: every album's title, folder path, photo count, shared status, and UUID.\n" +
        "Do not use when: you want the photos inside an album — use query with the album filter; you want the folder hierarchy rather than albums — use list-folders; or you just want a total album count — use library-info.",
    inputSchema: libraryArg,
    outputSchema: {
        count: z.number().optional(),
        albums: z.array(z.object({}).passthrough()).optional(),
    },
}, withErrorHandling(({ library }) => {
    const { count, albums } = manager.listAlbums(library);
    if (count === 0)
        return successResponse("No albums.", { count: 0, albums: [] });
    const lines = albums.map((a) => {
        const path = a.folder.length ? `${a.folder.join(" / ")} / ` : "";
        const shared = a.isShared ? " [shared]" : "";
        return `${path}${a.title} (${a.photoCount})${shared} — ${a.uuid}`;
    });
    return successResponse(`${count} album(s):\n\n${lines.join("\n")}`, { count, albums });
}, "list-albums"));
// --- list-folders ---
server.registerTool("list-folders", {
    description: "Use when: you want the library's folder hierarchy — the containers that hold albums and subfolders — to understand how albums are nested.\n" +
        "Returns: every folder's title, parent folder, album count, and subfolder count.\n" +
        "Do not use when: you want the albums themselves (with their photo counts) — use list-albums; or you just want a total folder count — use library-info.",
    inputSchema: libraryArg,
    outputSchema: {
        count: z.number().optional(),
        folders: z.array(z.object({}).passthrough()).optional(),
    },
}, withErrorHandling(({ library }) => {
    const { count, folders } = manager.listFolders(library);
    if (count === 0)
        return successResponse("No folders.", { count: 0, folders: [] });
    const lines = folders.map((f) => `${f.title}${f.parent ? ` (in ${f.parent})` : ""} — ${f.albumCount} albums, ${f.subfolderCount} subfolders`);
    return successResponse(`${count} folder(s):\n\n${lines.join("\n")}`, { count, folders });
}, "list-folders"));
// --- list-keywords ---
server.registerTool("list-keywords", {
    description: "Use when: you want the catalog of keywords (tags) in the library — e.g. to discover exact keyword spellings before filtering query by keyword, or to see which tags are most used. Pass limit for the top-N.\n" +
        "Returns: keywords with their photo counts, sorted most-used first.\n" +
        "Do not use when: you want photos carrying a keyword — use query with the keyword filter; or you want people/faces rather than tags — use list-persons.",
    inputSchema: {
        ...libraryArg,
        limit: z.number().int().positive().max(100000).optional().describe("Top-N keywords"),
    },
    outputSchema: {
        count: z.number().optional(),
        keywords: z.array(z.object({}).passthrough()).optional(),
    },
}, withErrorHandling(({ library, limit }) => {
    const { count, keywords } = manager.listKeywords(limit, library);
    if (count === 0)
        return successResponse("No keywords.", { count: 0, keywords: [] });
    const lines = keywords.map((k) => `${k.count.toString().padStart(6)}  ${k.keyword}`);
    return successResponse(`${count} keyword(s):\n\n${lines.join("\n")}`, { count, keywords });
}, "list-keywords"));
// --- list-persons ---
server.registerTool("list-persons", {
    description: "Use when: you want the catalog of named people from Photos face recognition — e.g. to discover exact person names before filtering query by person, or to see who appears most. Pass limit for the top-N; unidentified faces appear as _UNKNOWN_.\n" +
        "Returns: persons with their photo counts, sorted most-photographed first.\n" +
        "Do not use when: you want photos of a person — use query with the person filter; or you want subject tags rather than people — use list-keywords.",
    inputSchema: {
        ...libraryArg,
        limit: z.number().int().positive().max(100000).optional().describe("Top-N persons"),
    },
    outputSchema: {
        count: z.number().optional(),
        persons: z.array(z.object({}).passthrough()).optional(),
    },
}, withErrorHandling(({ library, limit }) => {
    const { count, persons } = manager.listPersons(limit, library);
    if (count === 0)
        return successResponse("No persons.", { count: 0, persons: [] });
    const lines = persons.map((p) => `${p.count.toString().padStart(6)}  ${p.name}`);
    return successResponse(`${count} person(s):\n\n${lines.join("\n")}`, { count, persons });
}, "list-persons"));
// --- export ---
server.registerTool("export", {
    description: "Use when: you want to copy one or more photos (by UUID, typically from query) out to a destination directory on disk. By default exports the original; set edited=true for the edited version, live=true to also include the live-photo video, raw=true to also include the raw image.\n" +
        "Returns: the destination path, counts of files exported and skipped, the exported file paths, and a per-UUID reason for anything skipped (e.g. edited=true requested but no edits exist).\n" +
        "Do not use when: you only need metadata or file paths rather than copies on disk — use get-photo; or you're still figuring out which photos to export — use query first.\n" +
        "Safety: this is the only side-effecting tool — it writes files into the destination directory (created if missing). With overwrite=true it OVERWRITES existing files of the same name in place; without it, existing files are skipped. If an original isn't on disk (iCloud 'Optimize Mac Storage'), the export falls back to driving Photos.app via AppleScript to download it on demand — this is slow for large batches and requires Photos.app installed, signed in to iCloud, and Automation permission granted.",
    inputSchema: {
        ...libraryArg,
        uuid: z.array(z.string().max(256)).min(1).max(1000).describe("Photo UUID(s) to export"),
        dest: z.string().max(4096).describe("Destination directory (created if missing)"),
        edited: z.boolean().optional().describe("Export the edited version instead of the original"),
        live: z.boolean().optional().describe("Also export the live-photo video"),
        raw: z.boolean().optional().describe("Also export the raw image"),
        overwrite: z.boolean().optional().describe("Overwrite existing files at the destination"),
    },
    outputSchema: {
        destination: z.string().optional(),
        exportedCount: z.number().optional(),
        skippedCount: z.number().optional(),
        exported: z.array(z.string()).optional(),
        skipped: z.array(z.object({}).passthrough()).optional(),
    },
}, withErrorHandling(({ library, uuid, dest, edited, live, raw, overwrite }) => {
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
    return successResponse(lines.join("\n"), { ...result });
}, "export"));
// Register read-only resources (photos://library, albums, persons, keywords,
// photo/{uuid}) and workflow prompts.
registerResourcesAndPrompts(server, manager);
async function main() {
    // Defense-in-depth: an unhandled rejection or a stray EventEmitter "error"
    // must never take down this long-lived MCP server. EPIPE on stdout means the
    // MCP client disconnected — exit cleanly rather than crash.
    process.on("uncaughtException", (err) => {
        if (err?.code === "EPIPE")
            process.exit(0);
        console.error("[uncaughtException]", err);
    });
    process.on("unhandledRejection", (reason) => {
        console.error("[unhandledRejection]", reason);
    });
    // Deterministic shutdown: every osxphotos/AppleScript child is spawned
    // synchronously (execFileSync), so there is nothing to await — exit cleanly on
    // the usual termination signals and when the client closes stdin (EOF), rather
    // than lingering as an orphan after the MCP host goes away.
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        console.error(`[shutdown] ${signal} received, exiting`);
        process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.stdin.on("end", () => shutdown("stdin EOF"));
    process.stdin.on("close", () => shutdown("stdin close"));
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`apple-photos-mcp v${version} running on stdio`);
}
main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
