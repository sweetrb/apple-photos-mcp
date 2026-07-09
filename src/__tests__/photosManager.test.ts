import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/python.js", () => ({
  runPhotosReader: vi.fn(),
  checkDependencies: vi.fn(),
}));

import { PhotosManager } from "../services/photosManager.js";
import { runPhotosReader, checkDependencies } from "../utils/python.js";

const runMock = vi.mocked(runPhotosReader);
const checkMock = vi.mocked(checkDependencies);

describe("PhotosManager", () => {
  let manager: PhotosManager;

  beforeEach(() => {
    manager = new PhotosManager();
    runMock.mockReset();
    checkMock.mockReset();
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
