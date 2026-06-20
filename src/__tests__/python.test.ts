import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "0.69.0\n"),
  execFileSync: vi.fn(),
}));

// existsSync/readFileSync are controllable per-test so we can simulate a venv
// being present vs absent without touching the real filesystem. Defaults:
// nothing exists (forces the system-python fallback) and no file content.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runPhotosReader, checkDependencies, _resetPythonCache } from "../utils/python.js";

const execFileMock = vi.mocked(execFileSync);
const execMock = vi.mocked(execSync);
const existsMock = vi.mocked(existsSync);
const readFileMock = vi.mocked(readFileSync);

// VITEST is set by the runner; assert it so the auto-setup guard really is off.
// If this ever changed, the bootstrap tests below could spawn the real setup.sh.
describe("test harness", () => {
  it("has VITEST set so auto-setup stays disabled", () => {
    expect(process.env.VITEST).toBeTruthy();
  });
});

describe("runPhotosReader", () => {
  beforeEach(() => {
    _resetPythonCache();
    execFileMock.mockReset();
    execMock.mockReset();
    execMock.mockReturnValue("0.69.0\n");
    existsMock.mockReset();
    existsMock.mockReturnValue(false);
    readFileMock.mockReset();
    readFileMock.mockReturnValue("");
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
    expect(result.error).toContain("osxphotos not installed");
    expect(result.error).toContain("npm run setup");
  });

  it("maps a ModuleNotFoundError stderr to the setup hint too", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: "ModuleNotFoundError: No module named 'osxphotos'",
      status: 1,
    });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const result = runPhotosReader("query", []);
    expect(result.error).toContain("osxphotos not installed");
    // The hint references the env var that can re-enable automatic setup.
    expect(result.error).toContain("APPLE_PHOTOS_MCP_NO_AUTO_SETUP");
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

  it("does NOT attempt a real bootstrap under VITEST even when deps look missing", () => {
    // execFileSync would be the ONLY way setup.sh gets spawned; if a bootstrap
    // were attempted it'd call execFileSync("bash", [setup], ...). We assert the
    // single call is the reader invocation, never "bash".
    const err = Object.assign(new Error("Command failed"), {
      stderr: "ModuleNotFoundError: No module named osxphotos",
      status: 1,
    });
    execFileMock.mockImplementation(() => {
      throw err;
    });
    const result = runPhotosReader("query", []);
    expect(result.error).toContain("osxphotos not installed");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const firstArg = execFileMock.mock.calls[0]?.[0];
    expect(firstArg).not.toBe("bash");
  });

  it("passes a numeric maxBuffer in the execFileSync options", () => {
    execFileMock.mockReturnValue("{}");
    runPhotosReader("query", []);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const options = execFileMock.mock.calls[0]?.[2] as { maxBuffer?: unknown };
    expect(typeof options.maxBuffer).toBe("number");
    expect(options.maxBuffer as number).toBeGreaterThan(0);
    // Default is 100MB.
    expect(options.maxBuffer).toBe(100 * 1024 * 1024);
  });

  it("honors APPLE_PHOTOS_MCP_MAX_BUFFER override", () => {
    const prev = process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
    process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = "12345";
    try {
      execFileMock.mockReturnValue("{}");
      runPhotosReader("query", []);
      const options = execFileMock.mock.calls[0]?.[2] as { maxBuffer?: unknown };
      expect(options.maxBuffer).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
      else process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = prev;
    }
  });

  it("ignores an invalid APPLE_PHOTOS_MCP_MAX_BUFFER and uses the default", () => {
    const prev = process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
    process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = "not-a-number";
    try {
      execFileMock.mockReturnValue("{}");
      runPhotosReader("query", []);
      const options = execFileMock.mock.calls[0]?.[2] as { maxBuffer?: unknown };
      expect(options.maxBuffer).toBe(100 * 1024 * 1024);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
      else process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = prev;
    }
  });

  it("uses the cached venv python when the venv is present and ready", () => {
    // Simulate a ready venv: venv python exists, requirements.txt exists, and
    // the .deps-ok marker matches requirements.txt exactly.
    const reqs = "osxphotos==0.69.0\n";
    existsMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("venv/bin/python3") || s.includes("requirements.txt") || s.includes(".deps-ok")
      );
    });
    readFileMock.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("requirements.txt") || s.includes(".deps-ok")) return reqs;
      return "";
    });
    execFileMock.mockReturnValue("{}");

    runPhotosReader("query", []);

    // The interpreter passed to execFileSync should be the venv python, not a
    // bare "python3"/"python" system command.
    const interpreter = String(execFileMock.mock.calls[0]?.[0]);
    expect(interpreter).toContain("venv/bin/python3");
    // venv-ready means findSystemPython() / execSync version probe is never hit.
    expect(execMock).not.toHaveBeenCalled();
  });

  it("falls back to system python (not cached) when no venv exists", () => {
    // No venv: resolvePython() should probe the system interpreter via execSync.
    existsMock.mockReturnValue(false);
    execFileMock.mockReturnValue("{}");

    runPhotosReader("query", []);

    expect(execMock).toHaveBeenCalled();
    const interpreter = String(execFileMock.mock.calls[0]?.[0]);
    expect(interpreter).toBe("python3");
  });
});

describe("_resetPythonCache", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    execMock.mockReset();
    execMock.mockReturnValue("0.69.0\n");
    existsMock.mockReset();
    existsMock.mockReturnValue(false);
    readFileMock.mockReset();
    readFileMock.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears cached state so a later venv is picked up without restart", () => {
    // First call: no venv -> system python.
    existsMock.mockReturnValue(false);
    execFileMock.mockReturnValue("{}");
    runPhotosReader("query", []);
    expect(String(execFileMock.mock.calls[0]?.[0])).toBe("python3");

    // A venv appears (e.g. created by a manual setup) and the cache is reset.
    _resetPythonCache();
    const reqs = "osxphotos==0.69.0\n";
    existsMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("venv/bin/python3") || s.includes("requirements.txt") || s.includes(".deps-ok")
      );
    });
    readFileMock.mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("requirements.txt") || s.includes(".deps-ok")) return reqs;
      return "";
    });
    execFileMock.mockReset();
    execFileMock.mockReturnValue("{}");

    runPhotosReader("query", []);
    expect(String(execFileMock.mock.calls[0]?.[0])).toContain("venv/bin/python3");
  });
});

describe("checkDependencies", () => {
  beforeEach(() => {
    _resetPythonCache();
    execFileMock.mockReset();
    execMock.mockReset();
    existsMock.mockReset();
    existsMock.mockReturnValue(false);
    readFileMock.mockReset();
    readFileMock.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ok with the version when the import probe succeeds", () => {
    execMock.mockReturnValue("0.69.0\n");
    const result = checkDependencies();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("osxphotos");
    expect(result.message).toContain("0.69.0");
  });

  it("reports not-ok with the setup hint when the import probe throws", () => {
    // First execSync (system python version probe) succeeds; the import probe
    // throws. Simplest: make every execSync throw -> findSystemPython throws and
    // checkDependencies catches it, returning the missing-dep message.
    execMock.mockImplementation(() => {
      throw new Error("ModuleNotFoundError: No module named osxphotos");
    });
    const result = checkDependencies();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("osxphotos not installed");
    expect(result.message).toContain("npm run setup");
  });
});
