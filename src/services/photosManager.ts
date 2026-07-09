import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runPhotosReader, checkDependencies, sidecarBusy, isVenvReady } from "../utils/python.js";
import type { SidecarProgress } from "../utils/sidecarClient.js";
import { FDA_REMEDIATION } from "../utils/docsUrls.js";
import { resolveExportDest } from "../utils/exportPath.js";
import type {
  AlbumInfo,
  ExportResult,
  FolderInfo,
  KeywordCount,
  LibraryInfo,
  PersonCount,
  PhotoDetail,
  QueryFilters,
  QueryResult,
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
    ];
    for (const [key, flag] of repeatable) {
      const values = filters[key] as string[] | undefined;
      if (values) {
        for (const v of values) {
          args.push(flagArg(flag, v));
        }
      }
    }

    if (filters.fromDate) args.push(flagArg("--from-date", filters.fromDate));
    if (filters.toDate) args.push(flagArg("--to-date", filters.toDate));
    if (filters.favorite) args.push("--favorite");
    if (filters.notFavorite) args.push("--not-favorite");
    if (filters.hidden) args.push("--hidden");
    if (filters.notHidden) args.push("--not-hidden");
    if (filters.photos) args.push("--photos");
    if (filters.movies) args.push("--movies");
    if (filters.title) args.push(flagArg("--title", filters.title));
    if (filters.description) args.push(flagArg("--description", filters.description));
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
