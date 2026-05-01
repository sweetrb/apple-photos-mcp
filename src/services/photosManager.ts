import { runPhotosReader, checkDependencies } from "../utils/python.js";
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

export class PhotosManager {
  /**
   * Build the CLI args common to every subcommand.
   * Library path is optional; when omitted, osxphotos uses the system library.
   */
  private libraryArgs(library?: string): string[] {
    return library ? ["--library", library] : [];
  }

  private run<T>(command: string, args: string[], timeoutMs?: number): T {
    const result = runPhotosReader<T>(command, args, timeoutMs);
    if (result.error) {
      throw new Error(result.error);
    }
    if (!result.data) {
      throw new Error("Python script returned no data");
    }
    return result.data;
  }

  healthCheck(): { ok: boolean; message: string } {
    const dep = checkDependencies();
    if (!dep.ok) return dep;
    try {
      const result = this.run<{
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

  getLibraryInfo(library?: string): LibraryInfo {
    return this.run<LibraryInfo>("library-info", this.libraryArgs(library));
  }

  query(filters: QueryFilters, library?: string): QueryResult {
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
          args.push(flag, v);
        }
      }
    }

    if (filters.fromDate) args.push("--from-date", filters.fromDate);
    if (filters.toDate) args.push("--to-date", filters.toDate);
    if (filters.favorite) args.push("--favorite");
    if (filters.notFavorite) args.push("--not-favorite");
    if (filters.hidden) args.push("--hidden");
    if (filters.notHidden) args.push("--not-hidden");
    if (filters.photos) args.push("--photos");
    if (filters.movies) args.push("--movies");
    if (filters.title) args.push("--title", filters.title);
    if (filters.description) args.push("--description", filters.description);
    if (filters.limit !== undefined) args.push("--limit", String(filters.limit));

    return this.run<QueryResult>("query", args);
  }

  getPhoto(uuid: string, library?: string): PhotoDetail {
    const result = this.run<{ photo: PhotoDetail }>("get-photo", [
      ...this.libraryArgs(library),
      "--uuid",
      uuid,
    ]);
    return result.photo;
  }

  listAlbums(library?: string): { count: number; albums: AlbumInfo[] } {
    return this.run("list-albums", this.libraryArgs(library));
  }

  listFolders(library?: string): { count: number; folders: FolderInfo[] } {
    return this.run("list-folders", this.libraryArgs(library));
  }

  listKeywords(limit?: number, library?: string): { count: number; keywords: KeywordCount[] } {
    const args = this.libraryArgs(library);
    if (limit !== undefined) args.push("--limit", String(limit));
    return this.run("list-keywords", args);
  }

  listPersons(limit?: number, library?: string): { count: number; persons: PersonCount[] } {
    const args = this.libraryArgs(library);
    if (limit !== undefined) args.push("--limit", String(limit));
    return this.run("list-persons", args);
  }

  exportPhotos(
    uuids: string[],
    dest: string,
    options: {
      edited?: boolean;
      live?: boolean;
      raw?: boolean;
      overwrite?: boolean;
      library?: string;
    } = {}
  ): ExportResult {
    if (uuids.length === 0) {
      throw new Error("At least one UUID is required to export");
    }
    const args = this.libraryArgs(options.library);
    for (const uuid of uuids) {
      args.push("--uuid", uuid);
    }
    args.push("--dest", dest);
    if (options.edited) args.push("--edited");
    if (options.live) args.push("--live");
    if (options.raw) args.push("--raw");
    if (options.overwrite) args.push("--overwrite");

    // Generous timeout: when originals aren't on disk we fall back to
    // Photos.app/AppleScript, which downloads from iCloud on demand. A batch
    // of missing photos can move serious bytes.
    return this.run<ExportResult>("export", args, 30 * 60 * 1000);
  }
}
