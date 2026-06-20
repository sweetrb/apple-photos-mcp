import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/python.js", () => ({
  checkDependencies: vi.fn(),
}));

import { runDoctor, formatDoctorReport } from "../tools/doctor.js";
import { checkDependencies } from "../utils/python.js";
import type { PhotosManager } from "../services/photosManager.js";
import type { LibraryInfo } from "../types.js";

const checkMock = vi.mocked(checkDependencies);

/** Build a fake PhotosManager exposing just what runDoctor touches. */
function fakeManager(getLibraryInfo: () => LibraryInfo): PhotosManager {
  return { getLibraryInfo } as unknown as PhotosManager;
}

const healthyLibrary: LibraryInfo = {
  libraryPath: "/Users/rob/Pictures/Photos Library.photoslibrary",
  dbVersion: "6000",
  photosVersion: 8,
  photoCount: 1234,
  movieCount: 56,
  totalCount: 1290,
  albumCount: 12,
  folderCount: 3,
  keywordCount: 40,
  personCount: 9,
};

describe("runDoctor", () => {
  beforeEach(() => {
    checkMock.mockReset();
  });

  it("reports healthy when osxphotos and the library are both fine", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    expect(report.healthy).toBe(true);
    expect(report.checks.every((c) => c.status === "ok")).toBe(true);

    const osx = report.checks.find((c) => c.name === "osxphotos");
    expect(osx?.detail).toContain("0.76.1");

    const lib = report.checks.find((c) => c.name === "photos_library");
    expect(lib?.detail).toContain("1234");
    expect(lib?.detail).toContain(healthyLibrary.libraryPath);

    const fda = report.checks.find((c) => c.name === "full_disk_access");
    expect(fda?.status).toBe("ok");
    expect(fda?.detail).toContain("readable");
  });

  it("fails and is unhealthy when osxphotos is missing", () => {
    checkMock.mockReturnValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    expect(report.healthy).toBe(false);
    const osx = report.checks.find((c) => c.name === "osxphotos");
    expect(osx?.status).toBe("fail");
    expect(osx?.detail).toContain("npm run setup");
  });

  it("flags Full Disk Access when the library throws a permission error", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => {
      throw new Error("Operation not permitted");
    });

    const report = runDoctor(manager);

    expect(report.healthy).toBe(false);

    const lib = report.checks.find((c) => c.name === "photos_library");
    expect(lib?.status).toBe("fail");

    const fda = report.checks.find((c) => c.name === "full_disk_access");
    expect(fda?.status).toBe("fail");
    expect(fda?.detail).toMatch(/Full Disk Access/i);
    expect(fda?.detail).toContain("docs/FULL-DISK-ACCESS.md");
  });

  it("warns (not fails) on full_disk_access when the library error is unrelated to permissions", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => {
      throw new Error("library locked");
    });

    const report = runDoctor(manager);

    const lib = report.checks.find((c) => c.name === "photos_library");
    expect(lib?.status).toBe("fail");

    const fda = report.checks.find((c) => c.name === "full_disk_access");
    expect(fda?.status).toBe("warn");
  });

  it("never throws even if getLibraryInfo throws a non-Error value", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => {
      throw "boom";
    });

    expect(() => runDoctor(manager)).not.toThrow();
  });
});

describe("formatDoctorReport", () => {
  it("renders icons and check names", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const text = formatDoctorReport(runDoctor(manager));

    expect(text).toContain("✅");
    expect(text).toContain("apple-photos-mcp doctor");
    expect(text).toContain("osxphotos");
    expect(text).toContain("photos_library");
    expect(text).toContain("full_disk_access");
  });

  it("shows the failure icon and ISSUES FOUND header when unhealthy", () => {
    checkMock.mockReturnValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const text = formatDoctorReport(runDoctor(manager));

    expect(text).toContain("❌");
    expect(text).toContain("ISSUES FOUND");
  });
});
