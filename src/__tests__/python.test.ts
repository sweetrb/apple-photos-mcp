import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "0.69.0\n"),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

import { execFileSync } from "node:child_process";
import { runPhotosReader, _resetPythonCache } from "../utils/python.js";

const execFileMock = vi.mocked(execFileSync);

describe("runPhotosReader", () => {
  beforeEach(() => {
    _resetPythonCache();
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed data on success", () => {
    execFileMock.mockReturnValue('{"count": 1, "photos": []}');
    const result = runPhotosReader("query", []);
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ count: 1, photos: [] });
  });

  it("returns the error key when stdout has one", () => {
    execFileMock.mockReturnValue('{"error": "library locked"}');
    const result = runPhotosReader("query", []);
    expect(result.error).toBe("library locked");
    expect(result.data).toBeUndefined();
  });

  it("surfaces stderr instead of a bare 'Command failed' when python crashes", () => {
    const err = Object.assign(new Error("Command failed: python3 photos_reader.py query"), {
      stderr: "Traceback (most recent call last):\n  ...\nValueError: bad date\n",
      status: 1,
    });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const result = runPhotosReader("query", []);
    expect(result.error).toContain("Traceback");
    expect(result.error).toContain("ValueError: bad date");
  });

  it("maps the missing-osxphotos stderr to a setup hint", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "ImportError: osxphotos not installed",
      status: 1,
    });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const result = runPhotosReader("health", []);
    expect(result.error).toContain("npm run setup");
  });

  it("converts ETIMEDOUT into a friendlier timeout message", () => {
    const err = Object.assign(new Error("ETIMEDOUT"), { status: null });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const result = runPhotosReader("query", [], 5000);
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain("5000");
  });
});
