import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/python.js", () => ({
  checkDependencies: vi.fn(),
  getPythonInfo: vi.fn(),
}));

import { runDoctor, formatDoctorReport } from "../tools/doctor.js";
import { checkDependencies, getPythonInfo } from "../utils/python.js";
import type { PhotosManager } from "../services/photosManager.js";
import type { LibraryInfo } from "../types.js";

const checkMock = vi.mocked(checkDependencies);
const pythonInfoMock = vi.mocked(getPythonInfo);

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
    pythonInfoMock.mockReset();
    pythonInfoMock.mockReturnValue({
      path: "/repo/venv/bin/python3",
      version: "Python 3.12.4",
    });
  });

  it("reports healthy when python, osxphotos, and the library are all fine", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    expect(report.healthy).toBe(true);
    expect(report.checks.every((c) => c.status === "ok")).toBe(true);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("ok");
    expect(py?.detail).toContain("Python 3.12.4");
    expect(py?.detail).toContain("/repo/venv/bin/python3");

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
    expect(osx?.detail).toContain("osxphotos not installed");
  });

  it("warns (with brew advice) when the resolved Python is older than 3.11", () => {
    pythonInfoMock.mockReturnValue({ path: "/usr/bin/python3", version: "Python 3.9.6" });
    checkMock.mockReturnValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("warn");
    expect(py?.detail).toContain("Python 3.9.6");
    expect(py?.detail).toContain("/usr/bin/python3");
    expect(py?.detail).toContain(">= 3.11");
    expect(py?.detail).toContain("brew install python@3.12");
    expect(py?.detail).toContain("https://github.com/sweetrb/apple-photos-mcp#troubleshooting");
  });

  it("accepts a Python at or above 3.11", () => {
    pythonInfoMock.mockReturnValue({ path: "/opt/python3.11", version: "Python 3.11.9" });
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("ok");
  });

  it("fails (and is unhealthy) when no Python interpreter resolves", () => {
    pythonInfoMock.mockReturnValue(null);
    checkMock.mockReturnValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    expect(report.healthy).toBe(false);
    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("fail");
    expect(py?.detail).toContain("Python 3 not found");
    expect(py?.detail).toContain("brew install python@3.12");
  });

  it("only warns on python_interpreter when getPythonInfo itself throws", () => {
    pythonInfoMock.mockImplementation(() => {
      throw new Error("weird");
    });
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = runDoctor(manager);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("warn");
    expect(report.healthy).toBe(true);
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
    expect(fda?.detail).toContain(
      "https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/FULL-DISK-ACCESS.md"
    );
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
  beforeEach(() => {
    checkMock.mockReset();
    pythonInfoMock.mockReset();
    pythonInfoMock.mockReturnValue({
      path: "/repo/venv/bin/python3",
      version: "Python 3.12.4",
    });
  });

  it("renders icons and check names", () => {
    checkMock.mockReturnValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const text = formatDoctorReport(runDoctor(manager));

    expect(text).toContain("✅");
    expect(text).toContain("apple-photos-mcp doctor");
    expect(text).toContain("python_interpreter");
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
