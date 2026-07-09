import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/python.js", () => ({
  checkDependencies: vi.fn(),
  getPythonInfo: vi.fn(),
  getSidecarInfo: vi.fn(),
  sidecarBusy: vi.fn(() => false),
}));

import { runDoctor, formatDoctorReport } from "../tools/doctor.js";
import { checkDependencies, getPythonInfo, getSidecarInfo, sidecarBusy } from "../utils/python.js";
import type { PhotosManager } from "../services/photosManager.js";
import type { LibraryInfo } from "../types.js";

const checkMock = vi.mocked(checkDependencies);
const pythonInfoMock = vi.mocked(getPythonInfo);
const sidecarInfoMock = vi.mocked(getSidecarInfo);
const busyMock = vi.mocked(sidecarBusy);

/** Build a fake PhotosManager exposing just what runDoctor touches. */
function fakeManager(getLibraryInfo: () => LibraryInfo): PhotosManager {
  return { getLibraryInfo: async () => getLibraryInfo() } as unknown as PhotosManager;
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

/** Default sidecar-mode info: persistent, healthy, already serving. */
const persistentInfo = {
  mode: "persistent" as const,
  running: true,
  pid: 4242,
  spawnCount: 1,
  lastSpawnAt: "2026-07-09T12:00:00.000Z",
};

describe("runDoctor", () => {
  beforeEach(() => {
    checkMock.mockReset();
    pythonInfoMock.mockReset();
    sidecarInfoMock.mockReset();
    sidecarInfoMock.mockReturnValue(persistentInfo);
    busyMock.mockReset();
    busyMock.mockReturnValue(false);
    pythonInfoMock.mockResolvedValue({
      path: "/repo/venv/bin/python3",
      version: "Python 3.12.4",
    });
  });

  it("reports healthy when python, osxphotos, and the library are all fine", async () => {
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

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

    const sidecar = report.checks.find((c) => c.name === "sidecar_mode");
    expect(sidecar?.status).toBe("ok");
    expect(sidecar?.detail).toContain("persistent");
    expect(sidecar?.detail).toContain("4242");
    expect(sidecar?.detail).toContain("2026-07-09T12:00:00.000Z");
  });

  it("reports one-shot mode as ok when disabled deliberately via env", async () => {
    sidecarInfoMock.mockReturnValue({
      mode: "one-shot",
      reason: "disabled via APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR",
      running: false,
      spawnCount: 0,
      lastSpawnAt: null,
    });
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    const sidecar = report.checks.find((c) => c.name === "sidecar_mode");
    expect(sidecar?.status).toBe("ok");
    expect(sidecar?.detail).toContain("one-shot");
    expect(sidecar?.detail).toContain("APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR");
    expect(report.healthy).toBe(true);
  });

  it("warns on one-shot mode when the serve handshake failed (unplanned fallback)", async () => {
    sidecarInfoMock.mockReturnValue({
      mode: "one-shot",
      reason: "serve handshake failed: unexpected handshake line: garbage",
      running: false,
      spawnCount: 1,
      lastSpawnAt: "2026-07-09T12:00:00.000Z",
    });
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    const sidecar = report.checks.find((c) => c.name === "sidecar_mode");
    expect(sidecar?.status).toBe("warn");
    expect(sidecar?.detail).toContain("handshake failed");
    // A warn never flips healthy.
    expect(report.healthy).toBe(true);
  });

  it("fails and is unhealthy when osxphotos is missing", async () => {
    checkMock.mockResolvedValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    expect(report.healthy).toBe(false);
    const osx = report.checks.find((c) => c.name === "osxphotos");
    expect(osx?.status).toBe("fail");
    expect(osx?.detail).toContain("osxphotos not installed");
  });

  it("warns (with brew advice) when the resolved Python is older than 3.11", async () => {
    pythonInfoMock.mockResolvedValue({ path: "/usr/bin/python3", version: "Python 3.9.6" });
    checkMock.mockResolvedValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("warn");
    expect(py?.detail).toContain("Python 3.9.6");
    expect(py?.detail).toContain("/usr/bin/python3");
    expect(py?.detail).toContain(">= 3.11");
    expect(py?.detail).toContain("brew install python@3.12");
    expect(py?.detail).toContain("https://github.com/sweetrb/apple-photos-mcp#troubleshooting");
  });

  it("accepts a Python at or above 3.11", async () => {
    pythonInfoMock.mockResolvedValue({ path: "/opt/python3.11", version: "Python 3.11.9" });
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("ok");
  });

  it("fails (and is unhealthy) when no Python interpreter resolves", async () => {
    pythonInfoMock.mockResolvedValue(null);
    checkMock.mockResolvedValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    expect(report.healthy).toBe(false);
    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("fail");
    expect(py?.detail).toContain("Python 3 not found");
    expect(py?.detail).toContain("brew install python@3.12");
  });

  it("only warns on python_interpreter when getPythonInfo itself throws", async () => {
    pythonInfoMock.mockImplementation(() => {
      throw new Error("weird");
    });
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const report = await runDoctor(manager);

    const py = report.checks.find((c) => c.name === "python_interpreter");
    expect(py?.status).toBe("warn");
    expect(report.healthy).toBe(true);
  });

  it("flags Full Disk Access when the library throws a permission error", async () => {
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => {
      throw new Error("Operation not permitted");
    });

    const report = await runDoctor(manager);

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

  it("warns (not fails) on full_disk_access when the library error is unrelated to permissions", async () => {
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => {
      throw new Error("library locked");
    });

    const report = await runDoctor(manager);

    const lib = report.checks.find((c) => c.name === "photos_library");
    expect(lib?.status).toBe("fail");

    const fda = report.checks.find((c) => c.name === "full_disk_access");
    expect(fda?.status).toBe("warn");
  });

  it("never throws even if getLibraryInfo throws a non-Error value", async () => {
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => {
      throw "boom";
    });

    await expect(runDoctor(manager)).resolves.toBeDefined();
  });

  it("skips the library probe (warn, not queue) while a sidecar operation is in flight", async () => {
    busyMock.mockReturnValue(true);
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const getLibraryInfo = vi.fn(async () => healthyLibrary);
    const manager = { getLibraryInfo } as unknown as PhotosManager;

    const report = await runDoctor(manager);

    // The light interpreter probes still ran…
    expect(report.checks.find((c) => c.name === "python_interpreter")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "osxphotos")?.status).toBe("ok");
    // …but the DB-touching probe was skipped, NOT enqueued behind the gate.
    expect(getLibraryInfo).not.toHaveBeenCalled();

    const lib = report.checks.find((c) => c.name === "photos_library");
    expect(lib?.status).toBe("warn");
    expect(lib?.detail).toMatch(/in flight/i);

    const fda = report.checks.find((c) => c.name === "full_disk_access");
    expect(fda?.status).toBe("warn");
    // Warns never flip healthy to false.
    expect(report.healthy).toBe(true);
  });
});

describe("formatDoctorReport", () => {
  beforeEach(() => {
    checkMock.mockReset();
    pythonInfoMock.mockReset();
    sidecarInfoMock.mockReset();
    sidecarInfoMock.mockReturnValue(persistentInfo);
    busyMock.mockReset();
    busyMock.mockReturnValue(false);
    pythonInfoMock.mockResolvedValue({
      path: "/repo/venv/bin/python3",
      version: "Python 3.12.4",
    });
  });

  it("renders icons and check names", async () => {
    checkMock.mockResolvedValue({ ok: true, message: "osxphotos 0.76.1 available" });
    const manager = fakeManager(() => healthyLibrary);

    const text = formatDoctorReport(await runDoctor(manager));

    expect(text).toContain("✅");
    expect(text).toContain("apple-photos-mcp doctor");
    expect(text).toContain("python_interpreter");
    expect(text).toContain("osxphotos");
    expect(text).toContain("sidecar_mode");
    expect(text).toContain("photos_library");
    expect(text).toContain("full_disk_access");
  });

  it("shows the failure icon and ISSUES FOUND header when unhealthy", async () => {
    checkMock.mockResolvedValue({ ok: false, message: "osxphotos not installed" });
    const manager = fakeManager(() => healthyLibrary);

    const text = formatDoctorReport(await runDoctor(manager));

    expect(text).toContain("❌");
    expect(text).toContain("ISSUES FOUND");
  });
});
