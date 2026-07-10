import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runPhotosReader, checkDependencies, sidecarBusy, isVenvReady } from "../utils/python.js";
import type { SidecarProgress } from "../utils/sidecarClient.js";
import { FDA_REMEDIATION } from "../utils/docsUrls.js";
import { resolveExportDest } from "../utils/exportPath.js";
import { assertWritesEnabled } from "../utils/writeGate.js";
import type {
  AddToAlbumResult,
  AlbumInfo,
  CreateAlbumResult,
  DuplicateGroupsResult,
  ExportResult,
  FolderInfo,
  KeywordCount,
  LibraryInfo,
  PersonCount,
  PhotoBatchResult,
  PhotoDetail,
  QueryFilters,
  QueryResult,
  RemoveFromAlbumResult,
  SetKeywordsResult,
  SetPhotoMetadataResult,
  ThumbnailResult,
} from "../types.js";

/**
 * macOS denies reading the Photos library without Full Disk Access; osxphotos
 * then surfaces a low-level error like "unable to open database file". Append
 * actionable guidance so the failure is self-service rather than cryptic.
 */
function augmentPermissionError(message: string): string {
  if (/not permitted|permission|full disk|denied|unable to open/i.test(message)) {
    return `${message}\n\nThis looks like a macOS permission issue: ${FDA_REMEDIATION}`;
  }
  return message;
}

/**
 * The Photos database file backing a library — the mtime witness for the
 * metadata cache. Mirrors the sidecar's resolution: an explicit library path
 * is ~-expanded and resolved; no library means the system default at
 * ~/Pictures/Photos Library.photoslibrary. Photos rewrites this SQLite file on
 * any library change, so its mtime is a reliable staleness signal.
 */
function libraryDbFile(library?: string): string {
  let lib: string;
  if (library) {
    const expanded =
      library === "~"
        ? homedir()
        : library.startsWith("~/")
          ? join(homedir(), library.slice(2))
          : library;
    lib = resolve(expanded);
  } else {
    lib = join(homedir(), "Pictures", "Photos Library.photoslibrary");
  }
  return lib.endsWith(".sqlite") ? lib : join(lib, "database", "Photos.sqlite");
}

/**
 * Commands whose results change only when the library itself changes — safe to
 * cache against the Photos.sqlite mtime. query/get-photo/export are NOT here:
 * query results are too varied to be worth the memory, and export has side
 * effects.
 */
const CACHEABLE_COMMANDS = new Set([
  "library-info",
  "list-albums",
  "list-folders",
  "list-keywords",
  "list-persons",
]);

/** Keep the cache tiny — it only needs to absorb repeat catalog lookups. */
const MAX_CACHE_ENTRIES = 8;

/**
 * Sidecar timeouts for the write commands. Generous because a write drives
 * Photos.app over AppleScript — the first call may LAUNCH Photos (photoscript
 * waits up to 300s for it) and every AppleScript round-trip is slow-ish.
 * remove-from-album additionally REBUILDS the album (Photos has no remove
 * verb), which scales with the album's size, so it gets the largest budget.
 */
const WRITE_TIMEOUT_MS = 5 * 60 * 1000;
const ALBUM_REBUILD_TIMEOUT_MS = 10 * 60 * 1000;

interface CacheEntry {
  mtimeMs: number;
  data: unknown;
}

interface InFlightEntry {
  mtimeMs: number;
  promise: Promise<unknown>;
}

/**
 * Join a flag and its user-supplied value into a single "--flag=value" token.
 * argparse treats a separate value token that starts with "-" as a new option
 * ("expected one argument" usage error), so a keyword like "-archive" or a
 * title search for "-2020" would crash the sidecar if passed as two tokens;
 * the joined form is parsed correctly regardless of leading dashes.
 */
function flagArg(flag: string, value: string | number): string {
  return `${flag}=${value}`;
}

export class PhotosManager {
  /**
   * In-process cache for the rarely-changing catalog commands
   * (CACHEABLE_COMMANDS). Every sidecar call pays a fixed spawn + full-DB-parse
   * cost (seconds on a large library), and agents habitually re-list
   * albums/keywords/persons within a session — this turns those repeats into
   * ~0ms. Entries are validated against the library DB file's mtime on every
   * hit, so a library change (import, edit, album rename) invalidates
   * immediately; when the DB file can't be stat'ed (no FDA, odd layout) the
   * cache simply stays out of the way.
   */
  private cache = new Map<string, CacheEntry>();

  /**
   * In-flight coalescing for the same catalog commands: now that calls are
   * async, two concurrent same-key requests can overlap before either result
   * lands in the mtime cache. The second joins the first's pending promise
   * instead of queueing a duplicate sidecar spawn behind the serial gate.
   * Entries are keyed like the cache and carry the mtime observed at spawn
   * time, so a call that sees a *different* mtime (library changed mid-flight)
   * never joins a stale in-flight result.
   */
  private inFlight = new Map<string, InFlightEntry>();

  /**
   * Build the CLI args common to every subcommand.
   * Library path is optional; when omitted, osxphotos uses the system library.
   */
  private libraryArgs(library?: string): string[] {
    return library ? [flagArg("--library", library)] : [];
  }

  private dbMtimeMs(library?: string): number | null {
    try {
      return statSync(libraryDbFile(library)).mtimeMs;
    } catch {
      return null;
    }
  }

  private async run<T>(
    command: string,
    args: string[],
    timeoutMs?: number,
    library?: string,
    onProgress?: (p: SidecarProgress) => void
  ): Promise<T> {
    const cacheable = CACHEABLE_COMMANDS.has(command);
    let cacheKey: string | null = null;
    let mtimeMs: number | null = null;

    if (cacheable) {
      mtimeMs = this.dbMtimeMs(library);
      if (mtimeMs !== null) {
        cacheKey = `${command} ${JSON.stringify(args)} ${libraryDbFile(library)}`;
        const hit = this.cache.get(cacheKey);
        if (hit && hit.mtimeMs === mtimeMs) {
          return hit.data as T;
        }
        if (hit) this.cache.delete(cacheKey);

        const pending = this.inFlight.get(cacheKey);
        if (pending && pending.mtimeMs === mtimeMs) {
          return pending.promise as Promise<T>;
        }
      }
    }

    const promise = this.spawnAndCache<T>(command, args, timeoutMs, cacheKey, mtimeMs, onProgress);

    if (cacheKey !== null && mtimeMs !== null) {
      const key = cacheKey;
      const entry: InFlightEntry = { mtimeMs, promise };
      this.inFlight.set(key, entry);
      const cleanup = () => {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      };
      // .then(cleanup, cleanup) — NOT .finally — so this bookkeeping branch
      // never itself becomes an unhandled rejection; callers still receive the
      // original rejection through `promise`.
      void promise.then(cleanup, cleanup);
    }
    return promise;
  }

  private async spawnAndCache<T>(
    command: string,
    args: string[],
    timeoutMs: number | undefined,
    cacheKey: string | null,
    mtimeMs: number | null,
    onProgress?: (p: SidecarProgress) => void
  ): Promise<T> {
    const result = await runPhotosReader<T>(command, args, timeoutMs, onProgress);
    if (result.error) {
      throw new Error(augmentPermissionError(result.error));
    }
    if (!result.data) {
      throw new Error("Python script returned no data");
    }

    if (cacheKey !== null && mtimeMs !== null) {
      this.cache.set(cacheKey, { mtimeMs, data: result.data });
      // Bounded: evict the oldest insertions (Map preserves insertion order).
      while (this.cache.size > MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return result.data;
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    // Fast liveness path: when a sidecar operation is already running or
    // queued (e.g. a long query, or an export that can take many minutes),
    // answer immediately from pure-TS state instead of queueing a full library
    // probe behind it. The whole point of the async sidecar layer is that
    // health-check RESPONDS during long operations; the full probe is one
    // re-run away once the operation completes.
    if (sidecarBusy()) {
      return {
        ok: true,
        message:
          "server responsive; a sidecar operation is currently in flight, so the library " +
          `probe was skipped (Python deps: ${isVenvReady() ? "venv ready" : "not verified"}). ` +
          "Re-run health-check after the operation completes for the full result.",
      };
    }
    const dep = await checkDependencies();
    if (!dep.ok) return dep;
    try {
      const result = await this.run<{
        ok: boolean;
        osxphotosVersion: string;
        libraryPath: string;
        photoCount: number;
      }>("health", []);
      return {
        ok: true,
        message: `osxphotos ${result.osxphotosVersion}, library ${result.libraryPath} (${result.photoCount} photos)`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getLibraryInfo(library?: string): Promise<LibraryInfo> {
    return this.run<LibraryInfo>("library-info", this.libraryArgs(library), undefined, library);
  }

  async query(filters: QueryFilters, library?: string): Promise<QueryResult> {
    const args = this.libraryArgs(library);

    const repeatable: Array<[keyof QueryFilters, string]> = [
      ["uuid", "--uuid"],
      ["album", "--album"],
      ["keyword", "--keyword"],
      ["person", "--person"],
      ["label", "--label"],
      ["folder", "--folder"],
      ["place", "--place"],
      ["year", "--year"],
    ];
    for (const [key, flag] of repeatable) {
      const values = filters[key] as Array<string | number> | undefined;
      if (values) {
        for (const v of values) {
          args.push(flagArg(flag, v));
        }
      }
    }

    if (filters.fromDate) args.push(flagArg("--from-date", filters.fromDate));
    if (filters.toDate) args.push(flagArg("--to-date", filters.toDate));
    if (filters.addedAfter) args.push(flagArg("--added-after", filters.addedAfter));
    if (filters.addedBefore) args.push(flagArg("--added-before", filters.addedBefore));
    if (filters.addedInLast) args.push(flagArg("--added-in-last", filters.addedInLast));
    if (filters.favorite) args.push("--favorite");
    if (filters.notFavorite) args.push("--not-favorite");
    if (filters.hidden) args.push("--hidden");
    if (filters.notHidden) args.push("--not-hidden");
    if (filters.photos) args.push("--photos");
    // `video` is a pure alias of `movies` — the sidecar knows only --movies.
    if (filters.movies || filters.video) args.push("--movies");
    if (filters.title) args.push(flagArg("--title", filters.title));
    if (filters.description) args.push(flagArg("--description", filters.description));
    // Tri-state: undefined = no location filter at all.
    if (filters.hasLocation === true) args.push("--has-location");
    if (filters.hasLocation === false) args.push("--no-location");
    if (filters.minSize !== undefined) args.push(flagArg("--min-size", filters.minSize));
    if (filters.maxSize !== undefined) args.push(flagArg("--max-size", filters.maxSize));
    if (filters.noKeyword) args.push("--no-keyword");
    if (filters.burst) args.push("--burst");
    if (filters.screenshot) args.push("--screenshot");
    if (filters.screenRecording) args.push("--screen-recording");
    if (filters.selfie) args.push("--selfie");
    if (filters.panorama) args.push("--panorama");
    if (filters.live) args.push("--live");
    if (filters.portrait) args.push("--portrait");
    if (filters.timelapse) args.push("--time-lapse");
    if (filters.slowMo) args.push("--slow-mo");
    if (filters.newestFirst) args.push("--newest-first");
    if (filters.limit !== undefined) args.push(flagArg("--limit", filters.limit));

    return this.run<QueryResult>("query", args);
  }

  async getPhoto(uuid: string, library?: string): Promise<PhotoDetail> {
    const result = await this.run<{ photo: PhotoDetail }>("get-photo", [
      ...this.libraryArgs(library),
      flagArg("--uuid", uuid),
    ]);
    return result.photo;
  }

  /**
   * Full details for a batch of UUIDs in ONE sidecar round-trip — the batch
   * equivalent of getPhoto (same per-photo shape, same trash fallback).
   * Unknown UUIDs come back in notFound instead of failing the batch.
   */
  async getPhotos(uuids: string[], library?: string): Promise<PhotoBatchResult> {
    if (uuids.length === 0) {
      throw new Error("At least one UUID is required");
    }
    const args = this.libraryArgs(library);
    for (const uuid of uuids) {
      args.push(flagArg("--uuid", uuid));
    }
    return this.run<PhotoBatchResult>("get-photos", args);
  }

  /**
   * A small renderable image (base64 JPEG/PNG) for one photo, from the preview
   * derivatives Photos has already generated — no export, no original-file
   * transfer. minSize is the smallest acceptable long-edge pixel size.
   */
  async getThumbnail(uuid: string, minSize?: number, library?: string): Promise<ThumbnailResult> {
    const args = [...this.libraryArgs(library), flagArg("--uuid", uuid)];
    if (minSize !== undefined) args.push(flagArg("--min-size", minSize));
    const result = await this.run<ThumbnailResult>("get-thumbnail", args);
    if (!result.base64) {
      throw new Error("Sidecar returned no image data");
    }
    return result;
  }

  /** Groups of exact duplicates (Photos' own fingerprint-based detection). */
  async findDuplicates(limit?: number, library?: string): Promise<DuplicateGroupsResult> {
    const args = this.libraryArgs(library);
    if (limit !== undefined) args.push(flagArg("--limit", limit));
    // Walking the duplicates adjacency touches every duplicate photo's
    // properties — give big libraries more room than the default 60s.
    return this.run<DuplicateGroupsResult>("find-duplicates", args, 5 * 60 * 1000, library);
  }

  async listAlbums(library?: string): Promise<{ count: number; albums: AlbumInfo[] }> {
    return this.run("list-albums", this.libraryArgs(library), undefined, library);
  }

  async listFolders(library?: string): Promise<{ count: number; folders: FolderInfo[] }> {
    return this.run("list-folders", this.libraryArgs(library), undefined, library);
  }

  async listKeywords(
    limit?: number,
    library?: string
  ): Promise<{ count: number; keywords: KeywordCount[] }> {
    const args = this.libraryArgs(library);
    if (limit !== undefined) args.push(flagArg("--limit", limit));
    return this.run("list-keywords", args, undefined, library);
  }

  async listPersons(
    limit?: number,
    library?: string
  ): Promise<{ count: number; persons: PersonCount[] }> {
    const args = this.libraryArgs(library);
    if (limit !== undefined) args.push(flagArg("--limit", limit));
    return this.run("list-persons", args, undefined, library);
  }

  // ---------------------------------------------------------------------------
  // Write tools (opt-in, gated behind APPLE_PHOTOS_MCP_ENABLE_WRITES)
  // ---------------------------------------------------------------------------

  /**
   * Shared write path: enforce the opt-in gate BEFORE anything spawns, run the
   * sidecar write command, and force-invalidate the metadata cache afterwards.
   *
   * The cache clear is unconditional (finally) and deliberately does NOT trust
   * the Photos.sqlite mtime bust: Photos commits through SQLite WAL, so the
   * main DB file's mtime may not change until a later checkpoint — an
   * mtime-validated hit could serve a pre-write albums list. A failed write
   * clears too (it may have partially mutated, e.g. a remove that died
   * mid-rebuild). The Python sidecar drops its resident PhotosDB for the same
   * reason, so the next read re-parses. Write commands are never in
   * CACHEABLE_COMMANDS, so nothing here can populate the cache either.
   */
  private async runWrite<T>(command: string, args: string[], timeoutMs: number): Promise<T> {
    assertWritesEnabled();
    try {
      return await this.run<T>(command, args, timeoutMs);
    } finally {
      this.cache.clear();
    }
  }

  /**
   * Create an album, or return the existing album of that name
   * (created=false). folder is a "/"-separated folder path, created as needed.
   */
  async createAlbum(name: string, folder?: string): Promise<CreateAlbumResult> {
    const args = [flagArg("--name", name)];
    if (folder !== undefined) args.push(flagArg("--folder", folder));
    return this.runWrite<CreateAlbumResult>("create-album", args, WRITE_TIMEOUT_MS);
  }

  /** Add photos (by UUID) to an album (by name or UUID). Idempotent. */
  async addToAlbum(album: string, uuids: string[]): Promise<AddToAlbumResult> {
    if (uuids.length === 0) {
      throw new Error("At least one UUID is required");
    }
    const args = [flagArg("--album", album)];
    for (const uuid of uuids) {
      args.push(flagArg("--uuid", uuid));
    }
    return this.runWrite<AddToAlbumResult>("add-to-album", args, WRITE_TIMEOUT_MS);
  }

  /**
   * Remove photos (by UUID) from an album — never from the library. The album
   * is rebuilt to effect the removal (its UUID changes; see the tool docs).
   */
  async removeFromAlbum(album: string, uuids: string[]): Promise<RemoveFromAlbumResult> {
    if (uuids.length === 0) {
      throw new Error("At least one UUID is required");
    }
    const args = [flagArg("--album", album)];
    for (const uuid of uuids) {
      args.push(flagArg("--uuid", uuid));
    }
    return this.runWrite<RemoveFromAlbumResult>(
      "remove-from-album",
      args,
      ALBUM_REBUILD_TIMEOUT_MS
    );
  }

  /** Set title / description / favorite on one photo (only the fields given). */
  async setPhotoMetadata(
    uuid: string,
    updates: { title?: string; description?: string; favorite?: boolean }
  ): Promise<SetPhotoMetadataResult> {
    const args = [flagArg("--uuid", uuid)];
    if (updates.title !== undefined) args.push(flagArg("--title", updates.title));
    if (updates.description !== undefined) {
      args.push(flagArg("--description", updates.description));
    }
    if (updates.favorite !== undefined) {
      args.push(flagArg("--favorite", updates.favorite ? "true" : "false"));
    }
    if (args.length === 1) {
      throw new Error("Nothing to update: pass at least one of title, description, favorite");
    }
    return this.runWrite<SetPhotoMetadataResult>("set-photo-metadata", args, WRITE_TIMEOUT_MS);
  }

  /**
   * Add/remove keywords on one photo with union semantics — existing keywords
   * not mentioned are preserved (the sidecar merges against the live list).
   */
  async setKeywords(
    uuid: string,
    edits: { add?: string[]; remove?: string[] }
  ): Promise<SetKeywordsResult> {
    const add = edits.add ?? [];
    const remove = edits.remove ?? [];
    if (add.length === 0 && remove.length === 0) {
      throw new Error("Nothing to do: pass add and/or remove");
    }
    const args = [flagArg("--uuid", uuid)];
    for (const k of add) {
      args.push(flagArg("--add", k));
    }
    for (const k of remove) {
      args.push(flagArg("--remove", k));
    }
    return this.runWrite<SetKeywordsResult>("set-keywords", args, WRITE_TIMEOUT_MS);
  }

  async exportPhotos(
    uuids: string[],
    dest: string,
    options: {
      edited?: boolean;
      live?: boolean;
      raw?: boolean;
      overwrite?: boolean;
      library?: string;
      /**
       * Per-photo progress callback. Only fires when the persistent sidecar
       * serves the export (one-shot fallback buffers its output, so a
       * fallback export completes without intermediate progress).
       */
      onProgress?: (p: SidecarProgress) => void;
    } = {}
  ): Promise<ExportResult> {
    if (uuids.length === 0) {
      throw new Error("At least one UUID is required to export");
    }
    // Canonicalize + allowlist-check the destination (home, /tmp, /private/tmp,
    // /Volumes) BEFORE spawning the sidecar, and pass the validated path so the
    // checked string and the written-to directory can't differ.
    const resolvedDest = resolveExportDest(dest);
    const args = this.libraryArgs(options.library);
    for (const uuid of uuids) {
      args.push(flagArg("--uuid", uuid));
    }
    args.push(flagArg("--dest", resolvedDest));
    if (options.edited) args.push("--edited");
    if (options.live) args.push("--live");
    if (options.raw) args.push("--raw");
    if (options.overwrite) args.push("--overwrite");

    // Generous timeout: when originals aren't on disk we fall back to
    // Photos.app/AppleScript, which downloads from iCloud on demand. A batch
    // of missing photos can move serious bytes.
    return this.run<ExportResult>("export", args, 30 * 60 * 1000, undefined, options.onProgress);
  }
}
