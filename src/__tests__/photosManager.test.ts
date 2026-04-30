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
        "--album",
        "Vacation",
        "--album",
        "Family",
        "--keyword",
        "sunset",
        "--from-date",
        "2025-01-01",
        "--favorite",
        "--limit",
        "50",
      ]);
    });

    it("includes --library when provided", () => {
      runMock.mockReturnValue({ data: { count: 0, photos: [] } });
      manager.query({}, "/tmp/Other.photoslibrary");
      const [, args] = runMock.mock.calls[0];
      expect(args.slice(0, 2)).toEqual(["--library", "/tmp/Other.photoslibrary"]);
    });

    it("throws when the python script returns an error", () => {
      runMock.mockReturnValue({ error: "library locked" });
      expect(() => manager.query({})).toThrow("library locked");
    });

    it("forwards date filters in ISO 8601 form", () => {
      runMock.mockReturnValue({ data: { count: 0, photos: [] } });
      manager.query({ fromDate: "2025-01-01", toDate: "2025-12-31T23:59:59" });
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--from-date", "2025-01-01", "--to-date", "2025-12-31T23:59:59"]);
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
      expect(args).toContain("--uuid");
      expect(args.filter((a) => a === "--uuid")).toHaveLength(2);
      expect(args).toContain("A");
      expect(args).toContain("B");
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
  });

  describe("listKeywords", () => {
    it("passes --limit when supplied", () => {
      runMock.mockReturnValue({ data: { count: 0, keywords: [] } });
      manager.listKeywords(20);
      const [, args] = runMock.mock.calls[0];
      expect(args).toEqual(["--limit", "20"]);
    });
  });
});
