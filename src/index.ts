#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PhotosManager } from "./services/photosManager.js";
import { killActiveSidecars } from "./utils/python.js";
import type { SidecarProgress } from "./utils/sidecarClient.js";
import { imageResponse, successResponse, withErrorHandling } from "./tools/respond.js";
import { runDoctor, formatDoctorReport } from "./tools/doctor.js";
import { registerResourcesAndPrompts } from "./tools/resourcesAndPrompts.js";
import { loadFileConfig } from "./services/fileConfig.js";

// Load file-based config FIRST — before anything reads APPLE_PHOTOS_MCP_* env
// vars — so settings survive a host that strips the MCP env block.
loadFileConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const version: string = pkg.version;

const manager = new PhotosManager();

const server = new McpServer({
  name: "apple-photos",
  version,
  description:
    "MCP server for Apple Photos via osxphotos. Query the Photos library by date, import " +
    "date, album, keyword, person, ML label, place, year, media type (screenshot, selfie, " +
    "panorama, burst, …), file size, or favorite/hidden flags; list " +
    "albums/folders/keywords/persons; fetch full photo metadata (location, dimensions, " +
    "EXIF camera data, type flags) singly or in batches; return inline viewable " +
    "thumbnails; find exact-duplicate groups; and export originals or edited versions to " +
    "a directory. Read-only against the Photos library BY DEFAULT: the write tools " +
    "(create-album, add-to-album, remove-from-album, set-photo-metadata, set-keywords) " +
    "only work when the user opts in with APPLE_PHOTOS_MCP_ENABLE_WRITES=1, and can " +
    "never delete photos. Read tools also return structuredContent (typed JSON) " +
    "alongside the text.",
});

const libraryArg = {
  library: z
    .string()
    .max(4096)
    .optional()
    .describe("Path to a .photoslibrary (default: system Photos library)"),
};

/** Photos UUIDs are hex segments separated by dashes — reject junk before spawning the sidecar. */
const uuidSchema = z
  .string()
  .max(256)
  .regex(
    /^[0-9A-Fa-f-]+$/,
    "must be a Photos UUID — hexadecimal segments separated by dashes " +
      "(e.g. 1EB2B765-0765-43BA-A90C-0F0AE547B343)"
  );

// --- health-check ---
server.registerTool(
  "health-check",
  {
    description:
      "Use when: you want a quick smoke test that osxphotos is installed and the Photos library can be opened.\n" +
      "Returns: ok/fail plus the osxphotos version, library path, and total photo count. While another operation (a long query or export) is running, it responds immediately with a liveness summary instead of queueing behind it — re-run after the operation completes for the full result.\n" +
      "Do not use when: you need a full setup diagnostic that pinpoints whether the failure is a missing osxphotos, an unreadable library, or denied Full Disk Access — use doctor instead.",
    inputSchema: {},
    outputSchema: {
      ok: z.boolean().optional(),
      message: z.string().optional(),
    },
  },
  withErrorHandling(async () => {
    const result = await manager.healthCheck();
    return successResponse(result.ok ? `OK ${result.message}` : `FAIL ${result.message}`, {
      ...result,
    });
  }, "health-check")
);

// --- doctor ---
server.registerTool(
  "doctor",
  {
    description:
      "Use when: a tool returns a permission, 'unable to open', or 'write tools are disabled' error, or you want a full setup diagnostic before querying, exporting, or writing.\n" +
      "Returns: six checks — Python interpreter (path + version; warns below 3.11), osxphotos install, sidecar mode (persistent vs one-shot, plus last respawn), the write-tools gate (enabled/disabled, with the opt-in recipe and — when enabled — whether the photoscript backend and Photos.app look usable), Photos library readability, and Full Disk Access — each reported ok/warn/fail with actionable advice.\n" +
      "Do not use when: you only need the lightweight is-it-working smoke test — use health-check instead.",
    inputSchema: {},
    outputSchema: {
      healthy: z.boolean().optional(),
      checks: z
        .array(
          z
            .object({
              name: z.string().optional(),
              status: z.string().optional(),
              detail: z.string().optional(),
            })
            .passthrough()
        )
        .optional(),
    },
  },
  withErrorHandling(async () => {
    const report = await runDoctor(manager);
    return successResponse(formatDoctorReport(report), { ...report });
  }, "doctor")
);

// --- library-info ---
server.registerTool(
  "library-info",
  {
    description:
      "Use when: you want high-level stats about the whole library — total counts of photos, movies, albums, folders, keywords, and persons — or to confirm which library you're targeting before drilling in.\n" +
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
  },
  withErrorHandling(async ({ library }) => {
    const info = await manager.getLibraryInfo(library);
    return successResponse(
      `Library: ${info.libraryPath}\n` +
        `Photos DB version: ${info.dbVersion} (Photos.app ${info.photosVersion})\n\n` +
        `Photos:    ${info.photoCount}\n` +
        `Movies:    ${info.movieCount}\n` +
        `Total:     ${info.totalCount}\n` +
        `Albums:    ${info.albumCount}\n` +
        `Folders:   ${info.folderCount}\n` +
        `Keywords:  ${info.keywordCount}\n` +
        `Persons:   ${info.personCount}`,
      { ...info }
    );
  }, "library-info")
);

// --- query ---
server.registerTool(
  "query",
  {
    description:
      "Use when: you need to find photos matching one or more filters — album, keyword, person, ML label, place, folder, taken-date or import-date range (addedAfter/addedInLast for 'recently imported'), year, file size, media type (screenshot, screen recording, selfie, panorama, live, portrait, time-lapse, slow-mo, burst, video), favorite/hidden flags, or title/description substrings — and get back a list of matches. This is the primary search/discovery tool; start here when you don't already have a UUID. Hidden photos are excluded unless hidden=true. Pass newestFirst=true with a limit to get the N most recent matches.\n" +
      "Returns: count (the TOTAL number of matches), returned (the number of summaries in this response — capped at limit, default 500), and photo summaries (UUID, filename, date, dimensions, favorite/hidden/movie flags) — feed a UUID into get-photo/get-photos for full metadata, get-thumbnail to see it, or export to copy files.\n" +
      "Do not use when: you already have UUIDs and want full metadata — use get-photo / get-photos; you want to see an image — use get-thumbnail; or you just want the catalog of album/keyword/person names — use list-albums / list-keywords / list-persons.",
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
      toDate: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 upper bound on photo date. A bare date (e.g. 2025-06-30) includes that " +
            "whole day; pass a full datetime (e.g. 2025-06-30T18:00:00) for a precise " +
            "exclusive bound"
        ),
      favorite: z.boolean().optional().describe("Only favorites"),
      notFavorite: z.boolean().optional().describe("Exclude favorites"),
      hidden: z.boolean().optional().describe("Only hidden photos"),
      notHidden: z.boolean().optional().describe("Exclude hidden photos (default behavior)"),
      photos: z.boolean().optional().describe("Include still photos"),
      movies: z.boolean().optional().describe("Include movies"),
      title: z.string().max(1024).optional().describe("Substring match on title"),
      description: z.string().max(2048).optional().describe("Substring match on description"),
      addedAfter: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 inclusive lower bound on IMPORT date (dateAdded — when the photo " +
            "entered the library, not when it was taken)"
        ),
      addedBefore: z
        .string()
        .max(64)
        .optional()
        .describe(
          "ISO 8601 upper bound on IMPORT date. A bare date includes that whole day; a " +
            "full datetime is a precise exclusive bound"
        ),
      addedInLast: z
        .string()
        .max(32)
        .regex(
          /^\s*\d+(\.\d+)?\s*[smhdw]\s*$/i,
          'must be <number><unit> with unit s/m/h/d/w — e.g. "7d", "24h"'
        )
        .optional()
        .describe(
          'Imported within the trailing duration — "<number><unit>", unit s(econds) / ' +
            'm(inutes) / h(ours) / d(ays) / w(eeks), e.g. "7d" or "24h". The natural way ' +
            'to express "recently imported"'
        ),
      label: z
        .array(z.string().max(1024))
        .max(100)
        .optional()
        .describe(
          "ML classification label(s) from Photos object detection (the labels field of " +
            "get-photo, e.g. Dog, Beach, Text); ANY-match, exact whole-string"
        ),
      folder: z
        .array(z.string().max(1024))
        .max(100)
        .optional()
        .describe(
          "Folder name(s)/path(s) — matches photos in albums that live inside the " +
            "folder; ANY-match (see list-folders for names)"
        ),
      place: z
        .array(z.string().max(1024))
        .max(100)
        .optional()
        .describe(
          "Place-name substring(s) from reverse geocoding (city, region, landmark). " +
            "NOTE: multiple values are ANDed, not ORed — a photo must match every value"
        ),
      hasLocation: z
        .boolean()
        .optional()
        .describe(
          "true = only photos WITH GPS coordinates; false = only photos WITHOUT; omit " +
            "for no location filter"
        ),
      year: z
        .array(z.number().int().min(0).max(9999))
        .max(100)
        .optional()
        .describe("Taken in calendar year(s); ANY-match (e.g. [2024, 2025])"),
      minSize: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Original file size at least this many bytes"),
      maxSize: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Original file size at most this many bytes"),
      noKeyword: z.boolean().optional().describe("Only photos carrying no keyword at all"),
      burst: z.boolean().optional().describe("Only burst photos"),
      screenshot: z.boolean().optional().describe("Only screenshots"),
      screenRecording: z.boolean().optional().describe("Only screen recordings"),
      selfie: z.boolean().optional().describe("Only selfies (front-camera photos)"),
      panorama: z.boolean().optional().describe("Only panoramas"),
      live: z.boolean().optional().describe("Only live photos"),
      portrait: z.boolean().optional().describe("Only portrait-mode (depth-effect) photos"),
      timelapse: z.boolean().optional().describe("Only time-lapse videos"),
      slowMo: z.boolean().optional().describe("Only slow-motion videos"),
      video: z.boolean().optional().describe("Only videos/movies (alias of movies)"),
      newestFirst: z
        .boolean()
        .optional()
        .describe(
          "Sort matches by taken date, newest first, BEFORE limit is applied — so limit " +
            "means 'the N most recent matches' instead of 'N in database order'"
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(100000)
        .optional()
        .describe(
          "Cap the number of results returned (default 500 when omitted; " +
            "count still reports the total matches)"
        ),
    },
    outputSchema: {
      count: z.number().optional(),
      returned: z.number().optional(),
      photos: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(async ({ library, ...filters }) => {
    const result = await manager.query(filters, library);
    if (result.count === 0) {
      return successResponse("No photos matched the query.", {
        count: 0,
        returned: 0,
        photos: [],
      });
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
    const returned = result.returned ?? result.photos.length;
    const header =
      result.count > returned
        ? `Found ${result.count} photo(s), returning the first ${returned} (raise limit for more):`
        : `Found ${result.count} photo(s):`;
    return successResponse(`${header}\n\n${lines.join("\n")}`, {
      count: result.count,
      returned,
      photos: result.photos,
    });
  }, "query")
);

// --- get-photo ---
server.registerTool(
  "get-photo",
  {
    description:
      "Use when: you have a single photo's UUID (typically from query) and want its complete metadata.\n" +
      "Returns: dimensions and original dimensions, dates, title/description, location and place, albums, keywords, persons, labels, file paths, size, EXIF camera data (make/model, lens, ISO, aperture, shutter speed, focal length — null when Photos recorded none), and type flags (HDR/live/raw/edited/portrait/panorama/etc.).\n" +
      "Do not use when: you don't have a UUID yet — use query to find matches first; you have several UUIDs — use get-photos for one batched call; or you want to see the image — use get-thumbnail.",
    inputSchema: {
      ...libraryArg,
      uuid: uuidSchema.describe("Photo UUID (hex-with-dashes, as returned by query)"),
    },
    outputSchema: {
      photo: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(async ({ library, uuid }) => {
    const p = await manager.getPhoto(uuid, library);
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
    if (p.exif && (p.exif.cameraMake || p.exif.cameraModel)) {
      const camera = [p.exif.cameraMake, p.exif.cameraModel].filter(Boolean).join(" ");
      const settings = [
        p.exif.iso != null ? `ISO ${p.exif.iso}` : null,
        p.exif.aperture != null ? `f/${p.exif.aperture}` : null,
        p.exif.focalLength != null ? `${p.exif.focalLength}mm` : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`Camera:      ${camera}${settings ? ` (${settings})` : ""}`);
    }
    return successResponse(lines.join("\n"), { photo: p });
  }, "get-photo")
);

// --- get-photos ---
server.registerTool(
  "get-photos",
  {
    description:
      "Use when: you have SEVERAL UUIDs (typically from query or find-duplicates) and want full metadata for all of them — a dedupe review, an EXIF audit, a captioning pass. One batched sidecar round-trip (max 50 UUIDs) instead of N get-photo calls.\n" +
      "Returns: count, photos (full per-photo detail — the same shape as get-photo, including the exif block), and notFound listing any requested UUIDs that matched nothing.\n" +
      "Do not use when: you have a single UUID — use get-photo; you don't have UUIDs yet — use query; or you want to see the images — use get-thumbnail per photo.",
    inputSchema: {
      ...libraryArg,
      uuid: z.array(uuidSchema).min(1).max(50).describe("Photo UUIDs (1–50, as returned by query)"),
    },
    outputSchema: {
      count: z.number().optional(),
      photos: z.array(z.object({}).passthrough()).optional(),
      notFound: z.array(z.string()).optional(),
    },
  },
  withErrorHandling(async ({ library, uuid }) => {
    const result = await manager.getPhotos(uuid, library);
    const lines = result.photos.map((p) => {
      const flags: string[] = [];
      if (p.favorite) flags.push("★");
      if (p.hidden) flags.push("hidden");
      if (p.isMovie) flags.push("movie");
      if (p.isEdited) flags.push("edited");
      const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
      const dims = p.width && p.height ? ` ${p.width}×${p.height}` : "";
      const camera = p.exif?.cameraModel ? ` — ${p.exif.cameraModel}` : "";
      return `${p.date ?? "?"} ${p.uuid} — ${p.filename}${dims}${flagStr}${camera}`;
    });
    if (result.notFound.length) {
      lines.push("", `Not found: ${result.notFound.join(", ")}`);
    }
    return successResponse(
      `${result.count} photo(s) (full details in structuredContent):\n\n${lines.join("\n")}`,
      { count: result.count, photos: result.photos, notFound: result.notFound }
    );
  }, "get-photos")
);

// --- get-thumbnail ---
server.registerTool(
  "get-thumbnail",
  {
    description:
      "Use when: you (or the user) want to SEE a photo — visual triage ('show me…'), picking the best shot, eyeballing duplicate groups, or reading text in an image — without exporting anything to disk. Prefer this over export whenever the goal is to LOOK at a photo rather than to obtain the file.\n" +
      "Returns: the photo as an inline MCP image content block (base64 JPEG/PNG a vision-capable client renders directly), plus a text summary and structured metadata (source path, width/height, MIME type, byte size, isDerivative). It serves the smallest Photos-generated preview derivative whose long edge is at least minSize pixels (default 360) — raise minSize (e.g. 1024) when you need detail like small text; isDerivative=false means no suitable derivative existed and the original was downscaled/converted via sips.\n" +
      "Do not use when: you need the full-resolution file on disk — use export; or you only need metadata — use get-photo. Movies get a thumbnail only when Photos generated a poster-frame derivative; an iCloud-only photo with no local derivative or original cannot be thumbnailed (export it first, which downloads on demand).",
    inputSchema: {
      ...libraryArg,
      uuid: uuidSchema.describe("Photo UUID (hex-with-dashes, as returned by query)"),
      minSize: z
        .number()
        .int()
        .positive()
        .max(8192)
        .optional()
        .describe(
          "Smallest acceptable long-edge size in pixels (default 360). The smallest " +
            "qualifying derivative is served, so higher values return larger images"
        ),
    },
    outputSchema: {
      uuid: z.string().optional(),
      path: z.string().optional(),
      width: z.number().nullable().optional(),
      height: z.number().nullable().optional(),
      mimeType: z.string().optional(),
      byteSize: z.number().optional(),
      isDerivative: z.boolean().optional(),
    },
  },
  withErrorHandling(async ({ library, uuid, minSize }) => {
    const t = await manager.getThumbnail(uuid, minSize, library);
    // The base64 payload belongs ONLY in the image content block — echoing it
    // into structuredContent would double a multi-hundred-KB response.
    const { base64, ...meta } = t;
    const dims = t.width && t.height ? `${t.width}×${t.height}` : "unknown dimensions";
    const source = t.isDerivative ? "Photos derivative" : "rendered from original";
    return imageResponse(
      `Thumbnail for ${t.uuid}: ${dims} ${t.mimeType}, ${Math.round(t.byteSize / 1024)} KB (${source})`,
      { data: base64, mimeType: t.mimeType },
      { ...meta }
    );
  }, "get-thumbnail")
);

// --- find-duplicates ---
server.registerTool(
  "find-duplicates",
  {
    description:
      "Use when: you want to find exact duplicates across the library — cleaning up after a double import, checking whether files were re-uploaded, or auditing before a migration/export.\n" +
      "Returns: groupCount (total duplicate groups found), returned (groups in this response, capped at limit, default 100), and groups ordered newest-first — each with the member UUIDs plus per-member filename, date, size, dimensions, and movie flag. Use get-thumbnail on members to eyeball a group before acting on it.\n" +
      "Do not use when: you're looking for near-duplicates or similar shots — Photos' fingerprint matches EXACT duplicates (identical image data) only; edited copies, resized versions, and burst siblings will NOT group.\n" +
      "Safety: read-only. This server cannot delete photos — to act on duplicates, quarantine the extra copies into an album (create-album + add-to-album when writes are enabled, otherwise by hand in Photos.app) and review/delete inside Photos.app.",
    inputSchema: {
      ...libraryArg,
      limit: z
        .number()
        .int()
        .positive()
        .max(10000)
        .optional()
        .describe("Max duplicate groups to return (default 100; groupCount reports the total)"),
    },
    outputSchema: {
      groupCount: z.number().optional(),
      returned: z.number().optional(),
      groups: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(async ({ library, limit }) => {
    const result = await manager.findDuplicates(limit, library);
    if (result.groupCount === 0) {
      return successResponse("No exact duplicates found.", {
        groupCount: 0,
        returned: 0,
        groups: [],
      });
    }
    const lines = result.groups.map((g, i) => {
      const members = g.photos
        .map((m) => `${m.filename}${m.size != null ? ` (${Math.round(m.size / 1024)} KB)` : ""}`)
        .join(" = ");
      const date = g.photos[0]?.date ?? "?";
      return `${i + 1}. ${g.count}× ${members} — ${date}\n   ${g.uuids.join(", ")}`;
    });
    const header =
      result.groupCount > result.returned
        ? `Found ${result.groupCount} duplicate group(s), returning the first ${result.returned} (raise limit for more):`
        : `Found ${result.groupCount} duplicate group(s):`;
    return successResponse(`${header}\n\n${lines.join("\n")}`, { ...result });
  }, "find-duplicates")
);

// --- list-albums ---
server.registerTool(
  "list-albums",
  {
    description:
      "Use when: you want the catalog of albums — e.g. to discover exact album names before filtering query by album, or to browse the library's organization.\n" +
      "Returns: every album's title, folder path, photo count, shared status, and UUID.\n" +
      "Do not use when: you want the photos inside an album — use query with the album filter; you want the folder hierarchy rather than albums — use list-folders; or you just want a total album count — use library-info.",
    inputSchema: libraryArg,
    outputSchema: {
      count: z.number().optional(),
      albums: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(async ({ library }) => {
    const { count, albums } = await manager.listAlbums(library);
    if (count === 0) return successResponse("No albums.", { count: 0, albums: [] });
    const lines = albums.map((a) => {
      const path = a.folder.length ? `${a.folder.join(" / ")} / ` : "";
      const shared = a.isShared ? " [shared]" : "";
      return `${path}${a.title} (${a.photoCount})${shared} — ${a.uuid}`;
    });
    return successResponse(`${count} album(s):\n\n${lines.join("\n")}`, { count, albums });
  }, "list-albums")
);

// --- list-folders ---
server.registerTool(
  "list-folders",
  {
    description:
      "Use when: you want the library's folder hierarchy — the containers that hold albums and subfolders — to understand how albums are nested.\n" +
      "Returns: every folder's title, parent folder, album count, and subfolder count.\n" +
      "Do not use when: you want the albums themselves (with their photo counts) — use list-albums; or you just want a total folder count — use library-info.",
    inputSchema: libraryArg,
    outputSchema: {
      count: z.number().optional(),
      folders: z.array(z.object({}).passthrough()).optional(),
    },
  },
  withErrorHandling(async ({ library }) => {
    const { count, folders } = await manager.listFolders(library);
    if (count === 0) return successResponse("No folders.", { count: 0, folders: [] });
    const lines = folders.map(
      (f) =>
        `${f.title}${f.parent ? ` (in ${f.parent})` : ""} — ${f.albumCount} albums, ${f.subfolderCount} subfolders`
    );
    return successResponse(`${count} folder(s):\n\n${lines.join("\n")}`, { count, folders });
  }, "list-folders")
);

// --- list-keywords ---
server.registerTool(
  "list-keywords",
  {
    description:
      "Use when: you want the catalog of keywords (tags) in the library — e.g. to discover exact keyword spellings before filtering query by keyword, or to see which tags are most used. Pass limit for the top-N.\n" +
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
  },
  withErrorHandling(async ({ library, limit }) => {
    const { count, keywords } = await manager.listKeywords(limit, library);
    if (count === 0) return successResponse("No keywords.", { count: 0, keywords: [] });
    const lines = keywords.map((k) => `${k.count.toString().padStart(6)}  ${k.keyword}`);
    return successResponse(`${count} keyword(s):\n\n${lines.join("\n")}`, { count, keywords });
  }, "list-keywords")
);

// --- list-persons ---
server.registerTool(
  "list-persons",
  {
    description:
      "Use when: you want the catalog of named people from Photos face recognition — e.g. to discover exact person names before filtering query by person, or to see who appears most. Pass limit for the top-N; unidentified faces appear as _UNKNOWN_.\n" +
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
  },
  withErrorHandling(async ({ library, limit }) => {
    const { count, persons } = await manager.listPersons(limit, library);
    if (count === 0) return successResponse("No persons.", { count: 0, persons: [] });
    const lines = persons.map((p) => `${p.count.toString().padStart(6)}  ${p.name}`);
    return successResponse(`${count} person(s):\n\n${lines.join("\n")}`, { count, persons });
  }, "list-persons")
);

// --- export ---
server.registerTool(
  "export",
  {
    description:
      "Use when: you want to copy one or more photos (by UUID, typically from query) out to a destination directory on disk. By default exports the original; set edited=true for the edited version, live=true to also include the live-photo video, raw=true to also include the raw image. Large batches report per-photo MCP progress notifications when the request carries a progressToken.\n" +
      "Returns: the destination path, counts of files exported and skipped, the exported file paths, and a per-UUID reason for anything skipped (e.g. file already exists at the destination, UUID not found / in trash, iCloud download failed).\n" +
      "Do not use when: you only need metadata or file paths rather than copies on disk — use get-photo; or you're still figuring out which photos to export — use query first.\n" +
      "Safety: this is the only side-effecting tool — it writes files into the destination directory (created if missing). dest must resolve (after expanding ~ and following symlinks) to a path under your home directory, /tmp, /private/tmp, or /Volumes; anything else is rejected. With overwrite=true it OVERWRITES existing files of the same name in place; without it, existing files are skipped and reported per-UUID. If an original isn't on disk (iCloud 'Optimize Mac Storage'), the export falls back to driving Photos.app via AppleScript to download it on demand — this is slow for large batches and requires Photos.app installed, signed in to iCloud, and Automation permission granted.",
    inputSchema: {
      ...libraryArg,
      uuid: z.array(z.string().max(256)).min(1).max(1000).describe("Photo UUID(s) to export"),
      dest: z
        .string()
        .min(1)
        .max(4096)
        .describe(
          "Destination directory (created if missing). Must be under the home " +
            "directory, /tmp, /private/tmp, or /Volumes"
        ),
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
  },
  withErrorHandling(async ({ library, uuid, dest, edited, live, raw, overwrite }, extra) => {
    // Forward the sidecar's per-photo progress as MCP progress notifications —
    // but only when the client asked for them by sending a progressToken.
    // Notification failures must never fail the export itself.
    const progressToken = extra?._meta?.progressToken;
    const onProgress =
      progressToken === undefined
        ? undefined
        : (p: SidecarProgress): void => {
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: p.done,
                  total: p.total,
                  message: p.current
                    ? `Exporting ${p.current} (${p.done + 1}/${p.total})`
                    : `Exported ${p.done}/${p.total}`,
                },
              })
              .catch(() => {});
          };
    const result = await manager.exportPhotos(uuid, dest, {
      edited,
      live,
      raw,
      overwrite,
      library,
      onProgress,
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
  }, "export")
);

// ---------------------------------------------------------------------------
// Write tools — OPT-IN, gated behind APPLE_PHOTOS_MCP_ENABLE_WRITES.
//
// Always registered (MCP clients cache the tool list at startup, so hiding
// them would cost discoverability without adding safety); when the gate is
// closed every call returns a clear how-to-enable error. The gate is enforced
// in PhotosManager before anything spawns, and again inside the Python
// sidecar. None of these tools can delete a photo from the library.
// ---------------------------------------------------------------------------

/** Every write tool result's album projection. */
const writeAlbumOutput = {
  album: z
    .object({
      uuid: z.string().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
    })
    .passthrough()
    .optional(),
};

// --- create-album ---
server.registerTool(
  "create-album",
  {
    description:
      "Use when: you need an album to file photos into — a new album by name, optionally nested inside a folder path (e.g. for a quarantine album before a dedupe review, or a per-trip album).\n" +
      "Returns: album {uuid, name, path} and created — false means an album of that name already existed and was returned instead of creating a duplicate (idempotent: safe to re-run; without folder the name is matched anywhere in the library, with folder only inside that folder).\n" +
      "Do not use when: you want to list existing albums — use list-albums; or you want to put photos into the album — follow up with add-to-album.\n" +
      "Safety: WRITE tool — disabled unless APPLE_PHOTOS_MCP_ENABLE_WRITES=1 (run doctor to check). Only creates albums/folders; never deletes, moves, or modifies photos. Drives Photos.app via AppleScript: Photos is launched if not running, and macOS Automation permission is required (one-time system prompt on first write). Writes always target the library currently open in Photos.app — there is no library parameter.",
    inputSchema: {
      name: z.string().min(1).max(255).describe("Album name"),
      folder: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe(
          'Folder path to nest the album under, "/"-separated for nesting ' +
            '(e.g. "Trips/2026"); folders are created as needed'
        ),
    },
    outputSchema: {
      ...writeAlbumOutput,
      created: z.boolean().optional(),
    },
  },
  withErrorHandling(async ({ name, folder }) => {
    const result = await manager.createAlbum(name, folder);
    const verb = result.created ? "Created album" : "Album already exists";
    return successResponse(`${verb}: ${result.album.path} (${result.album.uuid})`, {
      ...result,
    });
  }, "create-album")
);

// --- add-to-album ---
server.registerTool(
  "add-to-album",
  {
    description:
      "Use when: you have photo UUIDs (from query / find-duplicates) and want to file them into an album — e.g. collecting duplicate extras into a quarantine album, or filing a trip's photos.\n" +
      "Returns: the album {uuid, name, path}, addedCount, added (UUIDs newly added), alreadyPresent (UUIDs that were already members — adding is idempotent), and notFound (requested UUIDs that don't exist in the library). Fails only when the album doesn't exist or NO requested photo exists.\n" +
      "Do not use when: the album doesn't exist yet — call create-album first; or you want photos OUT of an album — use remove-from-album.\n" +
      "Safety: WRITE tool — disabled unless APPLE_PHOTOS_MCP_ENABLE_WRITES=1 (run doctor to check). Changes album membership only: photos are never copied, modified, or deleted, and each target is validated to exist first. Max 100 UUIDs per call. Drives Photos.app via AppleScript (launches it if needed; requires macOS Automation permission — one-time prompt). Writes target the library currently open in Photos.app.",
    inputSchema: {
      album: z
        .string()
        .min(1)
        .max(1024)
        .describe("Album name or UUID (UUID-looking values try the id lookup first)"),
      uuid: z
        .array(uuidSchema)
        .min(1)
        .max(100)
        .describe("Photo UUID(s) to add (1–100, as returned by query)"),
    },
    outputSchema: {
      ...writeAlbumOutput,
      addedCount: z.number().optional(),
      added: z.array(z.string()).optional(),
      alreadyPresent: z.array(z.string()).optional(),
      notFound: z.array(z.string()).optional(),
    },
  },
  withErrorHandling(async ({ album, uuid }) => {
    const result = await manager.addToAlbum(album, uuid);
    const lines = [
      `Album:           ${result.album.path} (${result.album.uuid})`,
      `Added:           ${result.addedCount}`,
    ];
    if (result.alreadyPresent.length) {
      lines.push(`Already present: ${result.alreadyPresent.length}`);
    }
    if (result.notFound.length) {
      lines.push(`Not found:       ${result.notFound.join(", ")}`);
    }
    return successResponse(lines.join("\n"), { ...result });
  }, "add-to-album")
);

// --- remove-from-album ---
server.registerTool(
  "remove-from-album",
  {
    description:
      "Use when: you want to take photos OUT of an album — undoing a mis-filing, or clearing reviewed items from a quarantine album. This removes ALBUM MEMBERSHIP only.\n" +
      "Returns: the album AFTER the operation ({uuid, name, path} — note the uuid CHANGES when anything was removed), removedCount, removed, notInAlbum (requested UUIDs that weren't members — no-ops), albumRecreated, and previousAlbumUuid.\n" +
      "Do not use when: you want to delete photos from the library — this server cannot delete photos at all (quarantine them in an album and review in Photos.app instead); or the photos aren't in the album (harmless, but pointless).\n" +
      "Safety: WRITE tool — disabled unless APPLE_PHOTOS_MCP_ENABLE_WRITES=1 (run doctor to check). NEVER deletes photos from the library — removed photos stay in All Photos and every other album. Photos' AppleScript has no remove-from-album verb, so the album is REBUILT (same name and remaining photos): its UUID changes and any custom manual sort order is lost; re-fetch the album UUID from the response. When none of the UUIDs are members, nothing is rebuilt. Max 100 UUIDs per call. Drives Photos.app via AppleScript (requires macOS Automation permission). Writes target the library currently open in Photos.app.",
    inputSchema: {
      album: z
        .string()
        .min(1)
        .max(1024)
        .describe("Album name or UUID (UUID-looking values try the id lookup first)"),
      uuid: z
        .array(uuidSchema)
        .min(1)
        .max(100)
        .describe("Photo UUID(s) to remove from the album (1–100)"),
    },
    outputSchema: {
      ...writeAlbumOutput,
      removedCount: z.number().optional(),
      removed: z.array(z.string()).optional(),
      notInAlbum: z.array(z.string()).optional(),
      albumRecreated: z.boolean().optional(),
      previousAlbumUuid: z.string().optional(),
    },
  },
  withErrorHandling(async ({ album, uuid }) => {
    const result = await manager.removeFromAlbum(album, uuid);
    const lines = [
      `Album:        ${result.album.path} (${result.album.uuid})`,
      `Removed:      ${result.removedCount} (from the album only — photos stay in the library)`,
    ];
    if (result.albumRecreated) {
      lines.push(
        `Note:         album rebuilt — its UUID changed (was ${result.previousAlbumUuid})`
      );
    }
    if (result.notInAlbum.length) {
      lines.push(`Not in album: ${result.notInAlbum.join(", ")}`);
    }
    return successResponse(lines.join("\n"), { ...result });
  }, "remove-from-album")
);

// --- set-photo-metadata ---
server.registerTool(
  "set-photo-metadata",
  {
    description:
      "Use when: you want to set a photo's title, description, or favorite flag — captioning passes, marking the best shot of a burst, titling scans.\n" +
      "Returns: uuid, updated (which fields were written), and the full before/after values of all three fields — so any change can be reverted by writing the before values back.\n" +
      "Do not use when: you want keywords — use set-keywords (it has union semantics; this tool doesn't touch keywords); or you only want to READ metadata — use get-photo.\n" +
      "Safety: WRITE tool — disabled unless APPLE_PHOTOS_MCP_ENABLE_WRITES=1 (run doctor to check). Metadata only — never touches the image asset, and only the fields you pass are modified (an empty string clears title/description). The target photo is validated to exist first. Drives Photos.app via AppleScript (requires macOS Automation permission). Writes target the library currently open in Photos.app.",
    inputSchema: {
      uuid: uuidSchema.describe("Photo UUID (hex-with-dashes, as returned by query)"),
      title: z.string().max(255).optional().describe("New title (empty string clears it)"),
      description: z
        .string()
        .max(2048)
        .optional()
        .describe("New description (empty string clears it)"),
      favorite: z.boolean().optional().describe("Set or clear the favorite flag"),
    },
    outputSchema: {
      uuid: z.string().optional(),
      updated: z.array(z.string()).optional(),
      before: z.object({}).passthrough().optional(),
      after: z.object({}).passthrough().optional(),
    },
  },
  withErrorHandling(async ({ uuid, title, description, favorite }) => {
    const result = await manager.setPhotoMetadata(uuid, { title, description, favorite });
    const lines = [`Updated ${result.updated.join(", ")} on ${result.uuid}:`];
    for (const field of result.updated) {
      const key = field as keyof typeof result.before;
      lines.push(
        `  ${field}: ${JSON.stringify(result.before[key])} → ${JSON.stringify(result.after[key])}`
      );
    }
    return successResponse(lines.join("\n"), { ...result });
  }, "set-photo-metadata")
);

// --- set-keywords ---
server.registerTool(
  "set-keywords",
  {
    description:
      "Use when: you want to add and/or remove keywords (tags) on a photo — tagging workflows, fixing a mis-tag — without disturbing its other keywords.\n" +
      "Returns: uuid, before/after keyword lists (revert by re-running with the diff inverted), added and removed (what actually changed — adding an existing keyword or removing an absent one is a no-op), and changed.\n" +
      "Do not use when: you want to browse keywords — use list-keywords; or find photos by keyword — use query. A keyword passed in both add and remove is rejected.\n" +
      "Safety: WRITE tool — disabled unless APPLE_PHOTOS_MCP_ENABLE_WRITES=1 (run doctor to check). UNION semantics — the photo's current keywords are read first and edits are merged in, so existing keywords you don't mention are ALWAYS preserved (never a blind replace). Metadata only — the image asset is untouched; the target photo is validated to exist first. Drives Photos.app via AppleScript (requires macOS Automation permission). Writes target the library currently open in Photos.app.",
    inputSchema: {
      uuid: uuidSchema.describe("Photo UUID (hex-with-dashes, as returned by query)"),
      add: z
        .array(z.string().min(1).max(255))
        .max(100)
        .optional()
        .describe("Keywords to add (created in Photos if new)"),
      remove: z
        .array(z.string().min(1).max(255))
        .max(100)
        .optional()
        .describe("Keywords to remove from this photo (exact match)"),
    },
    outputSchema: {
      uuid: z.string().optional(),
      before: z.array(z.string()).optional(),
      after: z.array(z.string()).optional(),
      added: z.array(z.string()).optional(),
      removed: z.array(z.string()).optional(),
      changed: z.boolean().optional(),
    },
  },
  withErrorHandling(async ({ uuid, add, remove }) => {
    const result = await manager.setKeywords(uuid, { add, remove });
    const lines = [
      `Keywords on ${result.uuid}${result.changed ? "" : " (no change needed)"}:`,
      `  before: ${result.before.length ? result.before.join(", ") : "(none)"}`,
      `  after:  ${result.after.length ? result.after.join(", ") : "(none)"}`,
    ];
    if (result.added.length) lines.push(`  added:   ${result.added.join(", ")}`);
    if (result.removed.length) lines.push(`  removed: ${result.removed.join(", ")}`);
    return successResponse(lines.join("\n"), { ...result });
  }, "set-keywords")
);

// Register read-only resources (photos://library, albums, persons, keywords,
// photo/{uuid}) and workflow prompts.
registerResourcesAndPrompts(server, manager);

async function main() {
  // Defense-in-depth: an unhandled rejection or a stray EventEmitter "error"
  // must never take down this long-lived MCP server. EPIPE on stdout means the
  // MCP client disconnected — exit cleanly rather than crash.
  process.on("uncaughtException", (err) => {
    if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
      killActiveSidecars();
      process.exit(0);
    }
    console.error("[uncaughtException]", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
  });

  // Deterministic shutdown: sidecar children run asynchronously (execFile), so
  // these handlers actually fire mid-operation — with the old execFileSync
  // layer, signal callbacks queued behind the blocked event loop and the host
  // had to escalate to SIGKILL during long exports. Kill any in-flight python
  // child before exiting so an exiting server can't orphan a sidecar that
  // could otherwise keep running (an iCloud export can take many minutes).
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[shutdown] ${signal} received, exiting`);
    killActiveSidecars();
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
