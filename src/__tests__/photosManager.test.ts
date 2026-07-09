import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/python.js", () => ({
  runPhotosReader: vi.fn(),
  checkDependencies: vi.fn(),
}));

// node:fs is mocked so the metadata cache's mtime stat and the export-dest
// symlink resolution are deterministic (no dependence on the machine's real
// Photos library or /tmp contents). Defaults set in beforeEach: statSync
// throws (=> caching disabled), existsSync true + realpathSync identity
// (=> resolveExportDest is a pure normalization).
vi.mock("node:fs", () => ({
  statSync: vi.fn(),
  existsSync: vi.fn(),
  realpathSync: vi.fn(),
}));

import { statSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { PhotosManager } from "../services/photosManager.js";
import { runPhotosReader, checkDependencies } from "../utils/python.js";

const runMock = vi.mocked(runPhotosReader);
const checkMock = vi.mocked(checkDependencies);
const statMock = vi.mocked(statSync);
const existsMock = vi.mocked(existsSync);
const realpathMock = vi.mocked(realpathSync);

describe("PhotosManager", () => {
  let manager: PhotosManager;

  beforeEach(() => {
    manager = new PhotosManager();
    runMock.mockReset();
    checkMock.mockReset();
    statMock.mockReset();
    statMock.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });
    existsMock.mockReset();
    existsMock.mockReturnValue(true);
    realpathMock.mockReset();
    realpathMock.mockImplementation(((p: unknown) => String(p)) as typeof realpathSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("healthCheck", () => {
    it("returns failure when osxphotos isn't installed", () => {
      checkMock.mockReturnValue({ ok: false, message: "not installed" });
      const result = manager.healthCheck();
      expect(result.ok).toBe(false);
      expect(runMock).not.toHaveBeenCalled();
    });

    it("returns success summary when osxphotos works", () => {
      checkMock.mockReturnValue({ ok: true, message: "0.69.0 available" });
      runMock.mockReturnValue({
        data: {
          ok: true,
          osxphotosVersion: "0.69.0",
          libraryPath: "/Library.photoslibrary",
          photoCount: 1234,
        },
      });
      const result = manager.healthCheck();
      expect(result.ok).toBe(true);
      expect(result.message).toContain("0.69.0");
      expect(result.message).toContain("1234");
    });
  });

  describe("query", () => {
    it("translates filters to CLI flags", () => {
      runMock.mockReturnValue({ data: { count: 0, photos: [] } });
      manager.query({
        album: ["Vacation", "Family"],
        keyword: ["sunset"],
        favorite: true,
        fromDate: "2025-01-01",
        limit: 50,
      });
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual([
        "--album=Vacation",
        "--album=Family",
        "--keyword=sunset",
        "--from-date=2025-01-01",
        "--favorite",
        "--limit=50",
      ]);
    });

    it("includes --library when provided", () => {
      runMock.mockReturnValue({ data: { count: 0, photos: [] } });
      manager.query({}, "/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args.slice(0, 1)).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });

    it("throws when the python script returns an error", () => {
      runMock.mockReturnValue({ error: "library locked" });
      expect(() => manager.query({})).toThrow("library locked");
    });

    it("passes leading-dash filter values safely via the joined --flag=value form", () => {
      // argparse would reject ["--keyword", "-summer"] with "expected one
      // argument"; the joined form survives values that start with a dash.
      runMock.mockReturnValue({ data: { count: 0, returned: 0, photos: [] } });
      manager.query({ keyword: ["-summer"], title: "-2020" });
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--keyword=-summer", "--title=-2020"]);
    });

    it("forwards date filters in ISO 8601 form", () => {
      runMock.mockReturnValue({ data: { count: 0, photos: [] } });
      manager.query({ fromDate: "2025-01-01", toDate: "2025-12-31T23:59:59" });
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--from-date=2025-01-01", "--to-date=2025-12-31T23:59:59"]);
    });

    it("forwards mutually-exclusive media type flags", () => {
      runMock.mockReturnValue({ data: { count: 0, photos: [] } });
      manager.query({ movies: true });
      expect(runMock.mock.calls[0][1]).toEqual(["--movies"]);

      runMock.mockClear();
      manager.query({ photos: true });
      expect(runMock.mock.calls[0][1]).toEqual(["--photos"]);
    });
  });

  describe("exportPhotos", () => {
    it("rejects empty uuid list before invoking python", () => {
      expect(() => manager.exportPhotos([], "/tmp")).toThrow(/at least one uuid/i);
      expect(runMock).not.toHaveBeenCalled();
    });

    it("forwards each uuid as a repeated --uuid flag", () => {
      runMock.mockReturnValue({
        data: {
          destination: "/tmp/out",
          exportedCount: 2,
          skippedCount: 0,
          exported: ["a.jpg", "b.jpg"],
          skipped: [],
        },
      });
      manager.exportPhotos(["A", "B"], "/tmp/out", { edited: true });
      const [, args] = runMock.mock.calls[0];
      expect(args.filter((a) => a.startsWith("--uuid="))).toHaveLength(2);
      expect(args).toContain("--uuid=A");
      expect(args).toContain("--uuid=B");
      expect(args).toContain("--edited");
    });

    it("returns the skipped list when the python sidecar reports missing photos", () => {
      runMock.mockReturnValue({
        data: {
          destination: "/tmp/out",
          exportedCount: 1,
          skippedCount: 1,
          exported: ["a.jpg"],
          skipped: [{ uuid: "MISSING-UUID", error: "original not downloaded from iCloud" }],
        },
      });
      const result = manager.exportPhotos(["A", "MISSING-UUID"], "/tmp/out");
      expect(result.exportedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.skipped[0]).toEqual({
        uuid: "MISSING-UUID",
        error: "original not downloaded from iCloud",
      });
    });

    it("uses a 30-minute subprocess timeout to allow on-demand iCloud downloads", () => {
      runMock.mockReturnValue({
        data: {
          destination: "/tmp/out",
          exportedCount: 1,
          skippedCount: 0,
          exported: ["a.jpg"],
          skipped: [],
        },
      });
      manager.exportPhotos(["A"], "/tmp/out");
      const [, , timeout] = runMock.mock.calls[0];
      expect(timeout).toBe(30 * 60 * 1000);
    });
  });

  describe("listKeywords", () => {
    it("passes --limit when supplied", () => {
      runMock.mockReturnValue({ data: { count: 0, keywords: [] } });
      manager.listKeywords(20);
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--limit=20"]);
    });
  });

  describe("getLibraryInfo", () => {
    it("returns the library info data and passes no library args by default", () => {
      const info = { photoCount: 100, movieCount: 5, albumCount: 3 };
      runMock.mockReturnValue({ data: info });
      const result = manager.getLibraryInfo();
      expect(result).toBe(info);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("library-info");
      expect(args).toEqual([]);
    });

    it("passes --library when a library path is given", () => {
      runMock.mockReturnValue({ data: { photoCount: 0 } });
      manager.getLibraryInfo("/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });
  });

  describe("getPhoto", () => {
    it("returns the inner photo object and forwards the uuid", () => {
      const photo = { uuid: "ABC-123", filename: "a.jpg" };
      runMock.mockReturnValue({ data: { photo } });
      const result = manager.getPhoto("ABC-123");
      expect(result).toBe(photo);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("get-photo");
      expect(args).toEqual(["--uuid=ABC-123"]);
    });

    it("includes --library before the uuid flag when provided", () => {
      runMock.mockReturnValue({ data: { photo: { uuid: "X" } } });
      manager.getPhoto("X", "/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary", "--uuid=X"]);
    });
  });

  describe("listAlbums", () => {
    it("returns count and albums and passes no args by default", () => {
      const data = { count: 2, albums: [{ title: "Vacation" }, { title: "Family" }] };
      runMock.mockReturnValue({ data });
      const result = manager.listAlbums();
      expect(result).toBe(data);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("list-albums");
      expect(args).toEqual([]);
    });

    it("passes --library when provided", () => {
      runMock.mockReturnValue({ data: { count: 0, albums: [] } });
      manager.listAlbums("/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });
  });

  describe("listFolders", () => {
    it("returns count and folders and passes no args by default", () => {
      const data = { count: 1, folders: [{ title: "Trips" }] };
      runMock.mockReturnValue({ data });
      const result = manager.listFolders();
      expect(result).toBe(data);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("list-folders");
      expect(args).toEqual([]);
    });

    it("passes --library when provided", () => {
      runMock.mockReturnValue({ data: { count: 0, folders: [] } });
      manager.listFolders("/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });
  });

  describe("listPersons", () => {
    it("returns count and persons and passes no args without a limit", () => {
      const data = { count: 1, persons: [{ name: "Alice", count: 9 }] };
      runMock.mockReturnValue({ data });
      const result = manager.listPersons();
      expect(result).toBe(data);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("list-persons");
      expect(args).toEqual([]);
    });

    it("appends --limit when supplied", () => {
      runMock.mockReturnValue({ data: { count: 0, persons: [] } });
      manager.listPersons(15);
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--limit=15"]);
    });

    it("combines --library and --limit when both are given", () => {
      runMock.mockReturnValue({ data: { count: 0, persons: [] } });
      manager.listPersons(15, "/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary", "--limit=15"]);
    });
  });

  describe("export destination allowlist", () => {
    const okResult = {
      data: {
        destination: "/tmp/out",
        exportedCount: 1,
        skippedCount: 0,
        exported: ["a.jpg"],
        skipped: [],
      },
    };

    it("rejects a destination outside the allowed roots without spawning the sidecar", () => {
      expect(() => manager.exportPhotos(["A"], "/etc/photos")).toThrow(
        /home directory, \/tmp, \/private\/tmp, or \/Volumes/
      );
      expect(runMock).not.toHaveBeenCalled();
    });

    it("rejects a /Volumes prefix-sharing sibling (segment boundary)", () => {
      expect(() => manager.exportPhotos(["A"], "/Volumesx/evil")).toThrow(/allowed export roots/);
      expect(runMock).not.toHaveBeenCalled();
    });

    it("rejects a ..-escape from an allowed root", () => {
      expect(() => manager.exportPhotos(["A"], "/tmp/../etc/photos")).toThrow(
        /allowed export roots/
      );
      expect(runMock).not.toHaveBeenCalled();
    });

    it("expands ~ and passes the resolved destination to the sidecar", () => {
      runMock.mockReturnValue(okResult);
      manager.exportPhotos(["A"], "~/Desktop/exports");
      const [, args] = runMock.mock.calls[0];
      expect(args).toContain(`--dest=${homedir()}/Desktop/exports`);
    });

    it("accepts destinations under /tmp and /Volumes", () => {
      runMock.mockReturnValue(okResult);
      manager.exportPhotos(["A"], "/tmp/out");
      expect(runMock.mock.calls[0][1]).toContain("--dest=/tmp/out");

      runMock.mockClear();
      runMock.mockReturnValue(okResult);
      manager.exportPhotos(["A"], "/Volumes/USB/exports");
      expect(runMock.mock.calls[0][1]).toContain("--dest=/Volumes/USB/exports");
    });
  });

  describe("metadata cache", () => {
    const fakeStat = (mtimeMs: number) => ({ mtimeMs }) as unknown as ReturnType<typeof statSync>;
    const albums = { count: 1, albums: [{ title: "Vacation" }] };

    it("serves a repeat catalog call from the cache (no second sidecar spawn)", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValue({ data: albums });

      const first = manager.listAlbums();
      const second = manager.listAlbums();

      expect(runMock).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it("stats the library DB file that backs the cache key", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValue({ data: albums });

      manager.listAlbums();

      const statted = String(statMock.mock.calls[0]?.[0]);
      expect(statted).toContain("Photos Library.photoslibrary/database/Photos.sqlite");
      expect(statted.startsWith(homedir())).toBe(true);
    });

    it("busts the cache when the library DB mtime changes", () => {
      statMock.mockReturnValueOnce(fakeStat(1111)).mockReturnValue(fakeStat(2222));
      runMock.mockReturnValue({ data: albums });

      manager.listAlbums();
      manager.listAlbums();

      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache when the DB file cannot be stat'ed", () => {
      // beforeEach default: statSync throws.
      runMock.mockReturnValue({ data: albums });

      manager.listAlbums();
      manager.listAlbums();

      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("caches per (command, args, library): different libraries don't collide", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValue({ data: albums });

      manager.listAlbums();
      manager.listAlbums("/tmp/Other.photoslibrary");

      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("covers all five catalog commands", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValue({
        data: { count: 0, albums: [], folders: [], keywords: [], persons: [] },
      });

      manager.getLibraryInfo();
      manager.getLibraryInfo();
      manager.listFolders();
      manager.listFolders();
      manager.listKeywords(5);
      manager.listKeywords(5);
      manager.listPersons();
      manager.listPersons();

      // 4 distinct calls, each repeated once from cache.
      expect(runMock).toHaveBeenCalledTimes(4);
    });

    it("does NOT cache query or get-photo", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValue({ data: { count: 0, returned: 0, photos: [] } });
      manager.query({ favorite: true });
      manager.query({ favorite: true });
      expect(runMock).toHaveBeenCalledTimes(2);

      runMock.mockClear();
      runMock.mockReturnValue({ data: { photo: { uuid: "A" } } });
      manager.getPhoto("A");
      manager.getPhoto("A");
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache error results", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValueOnce({ error: "library locked" });
      expect(() => manager.listAlbums()).toThrow("library locked");

      runMock.mockReturnValueOnce({ data: albums });
      expect(manager.listAlbums()).toEqual(albums);
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("keeps a different limit as a different cache entry", () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockReturnValue({ data: { count: 0, keywords: [] } });

      manager.listKeywords(10);
      manager.listKeywords(20);
      manager.listKeywords(10);

      expect(runMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("run error paths", () => {
    it("throws the python error message when one is returned", () => {
      runMock.mockReturnValueOnce({ error: "unable to open database" });
      expect(() => manager.listAlbums()).toThrow("unable to open database");
    });

    it("throws when the python script returns no data and no error", () => {
      runMock.mockReturnValueOnce({});
      expect(() => manager.listAlbums()).toThrow("Python script returned no data");
    });
  });
});
