import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/python.js", () => ({
  runPhotosReader: vi.fn(),
  checkDependencies: vi.fn(),
  sidecarBusy: vi.fn(() => false),
  isVenvReady: vi.fn(() => true),
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
import { runPhotosReader, checkDependencies, sidecarBusy, isVenvReady } from "../utils/python.js";

const runMock = vi.mocked(runPhotosReader);
const checkMock = vi.mocked(checkDependencies);
const busyMock = vi.mocked(sidecarBusy);
const venvReadyMock = vi.mocked(isVenvReady);
const statMock = vi.mocked(statSync);
const existsMock = vi.mocked(existsSync);
const realpathMock = vi.mocked(realpathSync);

describe("PhotosManager", () => {
  let manager: PhotosManager;

  beforeEach(() => {
    manager = new PhotosManager();
    runMock.mockReset();
    checkMock.mockReset();
    busyMock.mockReset();
    busyMock.mockReturnValue(false);
    venvReadyMock.mockReset();
    venvReadyMock.mockReturnValue(true);
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
    it("returns failure when osxphotos isn't installed", async () => {
      checkMock.mockResolvedValue({ ok: false, message: "not installed" });
      const result = await manager.healthCheck();
      expect(result.ok).toBe(false);
      expect(runMock).not.toHaveBeenCalled();
    });

    it("returns success summary when osxphotos works", async () => {
      checkMock.mockResolvedValue({ ok: true, message: "0.69.0 available" });
      runMock.mockResolvedValue({
        data: {
          ok: true,
          osxphotosVersion: "0.69.0",
          libraryPath: "/Library.photoslibrary",
          photoCount: 1234,
        },
      });
      const result = await manager.healthCheck();
      expect(result.ok).toBe(true);
      expect(result.message).toContain("0.69.0");
      expect(result.message).toContain("1234");
    });

    it("answers immediately from the pure-TS liveness path while a sidecar operation is in flight", async () => {
      busyMock.mockReturnValue(true);
      venvReadyMock.mockReturnValue(true);

      const result = await manager.healthCheck();

      expect(result.ok).toBe(true);
      expect(result.message).toMatch(/in flight/i);
      expect(result.message).toContain("venv ready");
      // The fast path must not spawn anything: no dependency probe, no sidecar.
      expect(checkMock).not.toHaveBeenCalled();
      expect(runMock).not.toHaveBeenCalled();
    });

    it("reports unverified deps on the liveness path when the venv isn't ready", async () => {
      busyMock.mockReturnValue(true);
      venvReadyMock.mockReturnValue(false);

      const result = await manager.healthCheck();

      expect(result.ok).toBe(true);
      expect(result.message).toContain("not verified");
    });

    it("resolves while a slow sidecar call is still pending (responsiveness contract)", async () => {
      // Simulate the real gate: a slow query marks the sidecar busy until it
      // resolves. The health-check issued mid-flight must resolve FIRST.
      let releaseQuery!: (v: { data: unknown }) => void;
      const slow = new Promise<{ data: unknown }>((r) => {
        releaseQuery = r;
      });
      let busy = false;
      busyMock.mockImplementation(() => busy);
      runMock.mockImplementation(() => {
        busy = true;
        return slow as never;
      });

      const order: string[] = [];
      const queryPromise = manager.query({ favorite: true }).then((r) => {
        order.push("query");
        return r;
      });
      const healthResult = await manager.healthCheck().then((r) => {
        order.push("health");
        return r;
      });

      // Health-check answered while the query was still pending.
      expect(order).toEqual(["health"]);
      expect(healthResult.ok).toBe(true);
      expect(healthResult.message).toMatch(/in flight/i);

      releaseQuery({ data: { count: 0, returned: 0, photos: [] } });
      busy = false;
      await queryPromise;
      expect(order).toEqual(["health", "query"]);
    });
  });

  describe("query", () => {
    it("translates filters to CLI flags", async () => {
      runMock.mockResolvedValue({ data: { count: 0, photos: [] } });
      await manager.query({
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

    it("includes --library when provided", async () => {
      runMock.mockResolvedValue({ data: { count: 0, photos: [] } });
      await manager.query({}, "/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args.slice(0, 1)).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });

    it("rejects when the python script returns an error", async () => {
      runMock.mockResolvedValue({ error: "library locked" });
      await expect(manager.query({})).rejects.toThrow("library locked");
    });

    it("passes leading-dash filter values safely via the joined --flag=value form", async () => {
      // argparse would reject ["--keyword", "-summer"] with "expected one
      // argument"; the joined form survives values that start with a dash.
      runMock.mockResolvedValue({ data: { count: 0, returned: 0, photos: [] } });
      await manager.query({ keyword: ["-summer"], title: "-2020" });
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--keyword=-summer", "--title=-2020"]);
    });

    it("forwards date filters in ISO 8601 form", async () => {
      runMock.mockResolvedValue({ data: { count: 0, photos: [] } });
      await manager.query({ fromDate: "2025-01-01", toDate: "2025-12-31T23:59:59" });
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--from-date=2025-01-01", "--to-date=2025-12-31T23:59:59"]);
    });

    it("forwards mutually-exclusive media type flags", async () => {
      runMock.mockResolvedValue({ data: { count: 0, photos: [] } });
      await manager.query({ movies: true });
      expect(runMock.mock.calls[0][1]).toEqual(["--movies"]);

      runMock.mockClear();
      await manager.query({ photos: true });
      expect(runMock.mock.calls[0][1]).toEqual(["--photos"]);
    });
  });

  describe("exportPhotos", () => {
    it("rejects empty uuid list before invoking python", async () => {
      await expect(manager.exportPhotos([], "/tmp")).rejects.toThrow(/at least one uuid/i);
      expect(runMock).not.toHaveBeenCalled();
    });

    it("forwards each uuid as a repeated --uuid flag", async () => {
      runMock.mockResolvedValue({
        data: {
          destination: "/tmp/out",
          exportedCount: 2,
          skippedCount: 0,
          exported: ["a.jpg", "b.jpg"],
          skipped: [],
        },
      });
      await manager.exportPhotos(["A", "B"], "/tmp/out", { edited: true });
      const [, args] = runMock.mock.calls[0];
      expect(args.filter((a) => a.startsWith("--uuid="))).toHaveLength(2);
      expect(args).toContain("--uuid=A");
      expect(args).toContain("--uuid=B");
      expect(args).toContain("--edited");
    });

    it("returns the skipped list when the python sidecar reports missing photos", async () => {
      runMock.mockResolvedValue({
        data: {
          destination: "/tmp/out",
          exportedCount: 1,
          skippedCount: 1,
          exported: ["a.jpg"],
          skipped: [{ uuid: "MISSING-UUID", error: "original not downloaded from iCloud" }],
        },
      });
      const result = await manager.exportPhotos(["A", "MISSING-UUID"], "/tmp/out");
      expect(result.exportedCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.skipped[0]).toEqual({
        uuid: "MISSING-UUID",
        error: "original not downloaded from iCloud",
      });
    });

    it("uses a 30-minute subprocess timeout to allow on-demand iCloud downloads", async () => {
      runMock.mockResolvedValue({
        data: {
          destination: "/tmp/out",
          exportedCount: 1,
          skippedCount: 0,
          exported: ["a.jpg"],
          skipped: [],
        },
      });
      await manager.exportPhotos(["A"], "/tmp/out");
      const [, , timeout] = runMock.mock.calls[0];
      expect(timeout).toBe(30 * 60 * 1000);
    });
  });

  describe("listKeywords", () => {
    it("passes --limit when supplied", async () => {
      runMock.mockResolvedValue({ data: { count: 0, keywords: [] } });
      await manager.listKeywords(20);
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--limit=20"]);
    });
  });

  describe("getLibraryInfo", () => {
    it("returns the library info data and passes no library args by default", async () => {
      const info = { photoCount: 100, movieCount: 5, albumCount: 3 };
      runMock.mockResolvedValue({ data: info });
      const result = await manager.getLibraryInfo();
      expect(result).toBe(info);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("library-info");
      expect(args).toEqual([]);
    });

    it("passes --library when a library path is given", async () => {
      runMock.mockResolvedValue({ data: { photoCount: 0 } });
      await manager.getLibraryInfo("/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });
  });

  describe("getPhoto", () => {
    it("returns the inner photo object and forwards the uuid", async () => {
      const photo = { uuid: "ABC-123", filename: "a.jpg" };
      runMock.mockResolvedValue({ data: { photo } });
      const result = await manager.getPhoto("ABC-123");
      expect(result).toBe(photo);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("get-photo");
      expect(args).toEqual(["--uuid=ABC-123"]);
    });

    it("includes --library before the uuid flag when provided", async () => {
      runMock.mockResolvedValue({ data: { photo: { uuid: "X" } } });
      await manager.getPhoto("X", "/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary", "--uuid=X"]);
    });
  });

  describe("listAlbums", () => {
    it("returns count and albums and passes no args by default", async () => {
      const data = { count: 2, albums: [{ title: "Vacation" }, { title: "Family" }] };
      runMock.mockResolvedValue({ data });
      const result = await manager.listAlbums();
      expect(result).toBe(data);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("list-albums");
      expect(args).toEqual([]);
    });

    it("passes --library when provided", async () => {
      runMock.mockResolvedValue({ data: { count: 0, albums: [] } });
      await manager.listAlbums("/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });
  });

  describe("listFolders", () => {
    it("returns count and folders and passes no args by default", async () => {
      const data = { count: 1, folders: [{ title: "Trips" }] };
      runMock.mockResolvedValue({ data });
      const result = await manager.listFolders();
      expect(result).toBe(data);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("list-folders");
      expect(args).toEqual([]);
    });

    it("passes --library when provided", async () => {
      runMock.mockResolvedValue({ data: { count: 0, folders: [] } });
      await manager.listFolders("/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--library=/tmp/Other.photoslibrary"]);
    });
  });

  describe("listPersons", () => {
    it("returns count and persons and passes no args without a limit", async () => {
      const data = { count: 1, persons: [{ name: "Alice", count: 9 }] };
      runMock.mockResolvedValue({ data });
      const result = await manager.listPersons();
      expect(result).toBe(data);
      const [command, args] = runMock.mock.calls[0];
      expect(command).toBe("list-persons");
      expect(args).toEqual([]);
    });

    it("appends --limit when supplied", async () => {
      runMock.mockResolvedValue({ data: { count: 0, persons: [] } });
      await manager.listPersons(15);
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--limit=15"]);
    });

    it("combines --library and --limit when both are given", async () => {
      runMock.mockResolvedValue({ data: { count: 0, persons: [] } });
      await manager.listPersons(15, "/tmp/Other.photoslibrary");
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

    it("rejects a destination outside the allowed roots without spawning the sidecar", async () => {
      await expect(manager.exportPhotos(["A"], "/etc/photos")).rejects.toThrow(
        /home directory, \/tmp, \/private\/tmp, or \/Volumes/
      );
      expect(runMock).not.toHaveBeenCalled();
    });

    it("rejects a /Volumes prefix-sharing sibling (segment boundary)", async () => {
      await expect(manager.exportPhotos(["A"], "/Volumesx/evil")).rejects.toThrow(
        /allowed export roots/
      );
      expect(runMock).not.toHaveBeenCalled();
    });

    it("rejects a ..-escape from an allowed root", async () => {
      await expect(manager.exportPhotos(["A"], "/tmp/../etc/photos")).rejects.toThrow(
        /allowed export roots/
      );
      expect(runMock).not.toHaveBeenCalled();
    });

    it("expands ~ and passes the resolved destination to the sidecar", async () => {
      runMock.mockResolvedValue(okResult);
      await manager.exportPhotos(["A"], "~/Desktop/exports");
      const [, args] = runMock.mock.calls[0];
      expect(args).toContain(`--dest=${homedir()}/Desktop/exports`);
    });

    it("accepts destinations under /tmp and /Volumes", async () => {
      runMock.mockResolvedValue(okResult);
      await manager.exportPhotos(["A"], "/tmp/out");
      expect(runMock.mock.calls[0][1]).toContain("--dest=/tmp/out");

      runMock.mockClear();
      runMock.mockResolvedValue(okResult);
      await manager.exportPhotos(["A"], "/Volumes/USB/exports");
      expect(runMock.mock.calls[0][1]).toContain("--dest=/Volumes/USB/exports");
    });
  });

  describe("metadata cache", () => {
    const fakeStat = (mtimeMs: number) => ({ mtimeMs }) as unknown as ReturnType<typeof statSync>;
    const albums = { count: 1, albums: [{ title: "Vacation" }] };

    it("serves a repeat catalog call from the cache (no second sidecar spawn)", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValue({ data: albums });

      const first = await manager.listAlbums();
      const second = await manager.listAlbums();

      expect(runMock).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    });

    it("stats the library DB file that backs the cache key", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValue({ data: albums });

      await manager.listAlbums();

      const statted = String(statMock.mock.calls[0]?.[0]);
      expect(statted).toContain("Photos Library.photoslibrary/database/Photos.sqlite");
      expect(statted.startsWith(homedir())).toBe(true);
    });

    it("busts the cache when the library DB mtime changes", async () => {
      statMock.mockReturnValueOnce(fakeStat(1111)).mockReturnValue(fakeStat(2222));
      runMock.mockResolvedValue({ data: albums });

      await manager.listAlbums();
      await manager.listAlbums();

      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache when the DB file cannot be stat'ed", async () => {
      // beforeEach default: statSync throws.
      runMock.mockResolvedValue({ data: albums });

      await manager.listAlbums();
      await manager.listAlbums();

      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("caches per (command, args, library): different libraries don't collide", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValue({ data: albums });

      await manager.listAlbums();
      await manager.listAlbums("/tmp/Other.photoslibrary");

      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("covers all five catalog commands", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValue({
        data: { count: 0, albums: [], folders: [], keywords: [], persons: [] },
      });

      await manager.getLibraryInfo();
      await manager.getLibraryInfo();
      await manager.listFolders();
      await manager.listFolders();
      await manager.listKeywords(5);
      await manager.listKeywords(5);
      await manager.listPersons();
      await manager.listPersons();

      // 4 distinct calls, each repeated once from cache.
      expect(runMock).toHaveBeenCalledTimes(4);
    });

    it("does NOT cache query or get-photo", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValue({ data: { count: 0, returned: 0, photos: [] } });
      await manager.query({ favorite: true });
      await manager.query({ favorite: true });
      expect(runMock).toHaveBeenCalledTimes(2);

      runMock.mockClear();
      runMock.mockResolvedValue({ data: { photo: { uuid: "A" } } });
      await manager.getPhoto("A");
      await manager.getPhoto("A");
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("does not cache error results", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValueOnce({ error: "library locked" });
      await expect(manager.listAlbums()).rejects.toThrow("library locked");

      runMock.mockResolvedValueOnce({ data: albums });
      await expect(manager.listAlbums()).resolves.toEqual(albums);
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("keeps a different limit as a different cache entry", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      runMock.mockResolvedValue({ data: { count: 0, keywords: [] } });

      await manager.listKeywords(10);
      await manager.listKeywords(20);
      await manager.listKeywords(10);

      expect(runMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("in-flight coalescing", () => {
    const fakeStat = (mtimeMs: number) => ({ mtimeMs }) as unknown as ReturnType<typeof statSync>;
    const albums = { count: 1, albums: [{ title: "Vacation" }] };

    it("coalesces two concurrent same-key catalog calls into ONE sidecar spawn", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      let release!: (v: { data: unknown }) => void;
      runMock.mockImplementation(
        () =>
          new Promise((r) => {
            release = r;
          }) as never
      );

      const p1 = manager.listAlbums();
      const p2 = manager.listAlbums();
      expect(runMock).toHaveBeenCalledTimes(1);

      release({ data: albums });
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual(albums);
      expect(r2).toEqual(albums);

      // And a THIRD call after settling is served by the mtime cache — still
      // exactly one spawn total.
      const r3 = await manager.listAlbums();
      expect(r3).toEqual(albums);
      expect(runMock).toHaveBeenCalledTimes(1);
    });

    it("does not coalesce different keys", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      const pending: Array<(v: { data: unknown }) => void> = [];
      runMock.mockImplementation(
        () =>
          new Promise((r) => {
            pending.push(r);
          }) as never
      );

      const p1 = manager.listAlbums();
      const p2 = manager.listFolders();
      expect(runMock).toHaveBeenCalledTimes(2);

      pending[0]({ data: albums });
      pending[1]({ data: { count: 0, folders: [] } });
      await Promise.all([p1, p2]);
    });

    it("does not join an in-flight call when the library mtime changed in between", async () => {
      statMock.mockReturnValueOnce(fakeStat(1111)).mockReturnValue(fakeStat(2222));
      const pending: Array<(v: { data: unknown }) => void> = [];
      runMock.mockImplementation(
        () =>
          new Promise((r) => {
            pending.push(r);
          }) as never
      );

      const p1 = manager.listAlbums(); // sees mtime 1111
      const p2 = manager.listAlbums(); // sees mtime 2222 — must not join
      expect(runMock).toHaveBeenCalledTimes(2);

      pending[0]({ data: albums });
      pending[1]({ data: albums });
      await Promise.all([p1, p2]);
    });

    it("propagates a failure to every joined caller and does not poison later calls", async () => {
      statMock.mockReturnValue(fakeStat(1111));
      let reject!: (e: Error) => void;
      runMock.mockImplementationOnce(
        () =>
          new Promise((_r, rej) => {
            reject = rej;
          }) as never
      );

      const p1 = manager.listAlbums();
      const p2 = manager.listAlbums();
      expect(runMock).toHaveBeenCalledTimes(1);

      reject(new Error("sidecar exploded"));
      await expect(p1).rejects.toThrow("sidecar exploded");
      await expect(p2).rejects.toThrow("sidecar exploded");

      // The failed in-flight entry is cleared: a fresh call spawns again.
      runMock.mockResolvedValueOnce({ data: albums });
      await expect(manager.listAlbums()).resolves.toEqual(albums);
      expect(runMock).toHaveBeenCalledTimes(2);
    });

    it("does not coalesce when the DB file cannot be stat'ed (caching disabled)", async () => {
      // beforeEach default: statSync throws => no cache key, no dedup.
      const pending: Array<(v: { data: unknown }) => void> = [];
      runMock.mockImplementation(
        () =>
          new Promise((r) => {
            pending.push(r);
          }) as never
      );

      const p1 = manager.listAlbums();
      const p2 = manager.listAlbums();
      expect(runMock).toHaveBeenCalledTimes(2);

      pending[0]({ data: albums });
      pending[1]({ data: albums });
      await Promise.all([p1, p2]);
    });
  });

  describe("run error paths", () => {
    it("rejects with the python error message when one is returned", async () => {
      runMock.mockResolvedValueOnce({ error: "unable to open database" });
      await expect(manager.listAlbums()).rejects.toThrow("unable to open database");
    });

    it("rejects when the python script returns no data and no error", async () => {
      runMock.mockResolvedValueOnce({});
      await expect(manager.listAlbums()).rejects.toThrow("Python script returned no data");
    });
  });
});
