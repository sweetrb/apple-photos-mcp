import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// These tests pin the ONE-SHOT execution path (execFile per call) — the
// persistent serve-mode routing is unit-tested separately in
// pythonPersistent.test.ts and sidecarClient.test.ts. Force one-shot mode so
// runPhotosReader never touches the (unmocked) spawn-based client.
process.env.APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR = "0";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "0.69.0\n"),
  execFile: vi.fn(),
  // Imported by utils/sidecarClient.ts (never called here — persistent mode
  // is disabled above); present so the ESM named import resolves.
  spawn: vi.fn(),
}));

// existsSync/readFileSync are controllable per-test so we can simulate a venv
// being present vs absent without touching the real filesystem. Defaults:
// nothing exists (forces the system-python fallback) and no file content.
// mkdirSync/rmSync/statSync/writeFileSync exist because utils/setupLock.ts
// (imported by python.ts) names them — they are never called here since
// auto-setup is disabled under VITEST.
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { execFile, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  runPhotosReader,
  checkDependencies,
  getPythonInfo,
  sidecarBusy,
  killActiveSidecars,
  isVenvReady,
  _resetPythonCache,
} from "../utils/python.js";

const execFileMock = vi.mocked(execFile);
const execMock = vi.mocked(execSync);
const existsMock = vi.mocked(existsSync);
const readFileMock = vi.mocked(readFileSync);

/**
 * The real async execFile invokes its callback with (error, stdout, stderr) —
 * stdout/stderr are CALLBACK ARGUMENTS, not properties pre-attached to the
 * error (that was the execFileSync shape; python.ts attaches them itself).
 * These helpers model exactly that contract so the mocks can't drift back to
 * the old sync error shape.
 */
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function fakeChild() {
  return { kill: vi.fn() };
}

/** Every execFile call succeeds with the given stdout. */
function execFileSucceeds(stdout: string) {
  execFileMock.mockImplementation(((...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as ExecFileCallback;
    process.nextTick(() => cb(null, stdout, ""));
    return fakeChild() as never;
  }) as never);
}

/** Every execFile call fails, passing stdout/stderr as callback args. */
function execFileFails(error: Error, stdout = "", stderr = "") {
  execFileMock.mockImplementation(((...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as ExecFileCallback;
    process.nextTick(() => cb(error, stdout, stderr));
    return fakeChild() as never;
  }) as never);
}

/** Options object of the nth execFile call. */
function callOptions(n = 0): Record<string, unknown> {
  return execFileMock.mock.calls[n]?.[2] as Record<string, unknown>;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

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

  it("returns parsed data on success", async () => {
    execFileSucceeds('{"count": 1, "photos": []}');
    const result = await runPhotosReader("query", []);
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ count: 1, photos: [] });
  });

  it("returns the error key when stdout has one", async () => {
    execFileSucceeds('{"error": "library locked"}');
    const result = await runPhotosReader("query", []);
    expect(result.error).toBe("library locked");
    expect(result.data).toBeUndefined();
  });

  it("surfaces stderr instead of a bare 'Command failed' when python crashes", async () => {
    execFileFails(
      Object.assign(new Error("Command failed: python3 photos_reader.py query"), { code: 1 }),
      "",
      "Traceback (most recent call last):\n  ...\nValueError: bad date\n"
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toContain("Traceback");
    expect(result.error).toContain("ValueError: bad date");
  });

  it("maps the sidecar's missing-osxphotos JSON error (stdout + exit 1) to a setup hint", async () => {
    // The real sidecar prints {"error": "osxphotos not installed. ..."} to
    // STDOUT before sys.exit(1) — stderr stays empty. This is the channel that
    // must trigger the setup hint (and the missing-dep bootstrap retry).
    execFileFails(
      Object.assign(new Error("Command failed: python3 photos_reader.py health"), { code: 1 }),
      JSON.stringify({ error: "osxphotos not installed. Install it with: ..." }),
      ""
    );
    const result = await runPhotosReader("health", []);
    expect(result.error).toContain("osxphotos not installed");
    expect(result.error).toContain("pip3 install osxphotos");
  });

  it("surfaces the sidecar's structured JSON error from stdout when python exits non-zero", async () => {
    // Every handled sidecar failure (bad args, unreadable library, FDA denial)
    // is {"error": ...} JSON on stdout + exit(1). The structured message must
    // surface verbatim — NOT a bare "Command failed: <python> <args>".
    execFileFails(
      Object.assign(new Error("Command failed: python3 photos_reader.py query"), { code: 1 }),
      JSON.stringify({ error: "unable to open database file" }),
      ""
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toBe("unable to open database file");
  });

  it("prefers the stdout JSON error over stderr noise on non-zero exit", async () => {
    execFileFails(
      Object.assign(new Error("Command failed"), { code: 1 }),
      JSON.stringify({ error: "Library not found: /nope.photoslibrary" }),
      "some low-level warning\n"
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toBe("Library not found: /nope.photoslibrary");
  });

  it("falls back to stderr when stdout on a failed exit isn't JSON", async () => {
    execFileFails(
      Object.assign(new Error("Command failed"), { code: 1 }),
      "not json at all",
      "Traceback (most recent call last):\nRuntimeError: boom\n"
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toContain("RuntimeError: boom");
  });

  it("still maps a missing-dep message on stderr to the setup hint (non-sidecar failures)", async () => {
    execFileFails(
      Object.assign(new Error("Command failed"), { code: 1 }),
      "",
      "ImportError: osxphotos not installed"
    );
    const result = await runPhotosReader("health", []);
    expect(result.error).toContain("osxphotos not installed");
    expect(result.error).toContain("pip3 install osxphotos");
  });

  it("maps a ModuleNotFoundError stderr to the setup hint too", async () => {
    execFileFails(
      Object.assign(new Error("Command failed"), { code: 1 }),
      "",
      "ModuleNotFoundError: No module named 'osxphotos'"
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toContain("osxphotos not installed");
    // The hint references the env var that can re-enable automatic setup.
    expect(result.error).toContain("APPLE_PHOTOS_MCP_NO_AUTO_SETUP");
  });

  it("converts a timeout kill (error.killed, no ETIMEDOUT message) into a friendly timeout message", async () => {
    // Async execFile does NOT produce an ETIMEDOUT message like execFileSync:
    // it kills the child with killSignal and sets error.killed.
    execFileFails(
      Object.assign(new Error("Command failed: python3 photos_reader.py query"), {
        killed: true,
        signal: "SIGKILL",
        code: null,
      }),
      "",
      ""
    );
    const result = await runPhotosReader("query", [], 5000);
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain("5000");
    expect(result.error).toContain("APPLE_PHOTOS_MCP_TIMEOUT");
  });

  it("does NOT misreport a maxBuffer overrun (also a kill) as a timeout", async () => {
    execFileFails(
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        killed: true,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
      "",
      ""
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toContain("maxBuffer");
    expect(result.error).not.toMatch(/timed out/i);
  });

  it("still maps a legacy ETIMEDOUT-style message to the timeout error", async () => {
    execFileFails(Object.assign(new Error("ETIMEDOUT"), { code: null }));
    const result = await runPhotosReader("query", [], 5000);
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain("5000");
  });

  it("does NOT attempt a real bootstrap under VITEST even when deps look missing", async () => {
    // execFile would be the ONLY way setup.sh gets spawned; if a bootstrap
    // were attempted it'd call execFile("bash", [setup], ...). We assert the
    // single call is the reader invocation, never "bash".
    execFileFails(
      Object.assign(new Error("Command failed"), { code: 1 }),
      "",
      "ModuleNotFoundError: No module named osxphotos"
    );
    const result = await runPhotosReader("query", []);
    expect(result.error).toContain("osxphotos not installed");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const firstArg = execFileMock.mock.calls[0]?.[0];
    expect(firstArg).not.toBe("bash");
  });

  it("passes a numeric maxBuffer and SIGKILL killSignal in the execFile options", async () => {
    execFileSucceeds("{}");
    await runPhotosReader("query", []);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const options = callOptions();
    expect(typeof options.maxBuffer).toBe("number");
    expect(options.maxBuffer as number).toBeGreaterThan(0);
    // Default is 100MB.
    expect(options.maxBuffer).toBe(100 * 1024 * 1024);
    // SIGKILL on timeout, matching the AppleScript siblings.
    expect(options.killSignal).toBe("SIGKILL");
  });

  it("honors APPLE_PHOTOS_MCP_MAX_BUFFER override", async () => {
    const prev = process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
    process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = "12345";
    try {
      execFileSucceeds("{}");
      await runPhotosReader("query", []);
      expect(callOptions().maxBuffer).toBe(12345);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
      else process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = prev;
    }
  });

  it("ignores an invalid APPLE_PHOTOS_MCP_MAX_BUFFER and uses the default", async () => {
    const prev = process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
    process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = "not-a-number";
    try {
      execFileSucceeds("{}");
      await runPhotosReader("query", []);
      expect(callOptions().maxBuffer).toBe(100 * 1024 * 1024);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_MAX_BUFFER;
      else process.env.APPLE_PHOTOS_MCP_MAX_BUFFER = prev;
    }
  });

  it("defaults the sidecar timeout to 60s when no explicit timeout is passed", async () => {
    execFileSucceeds("{}");
    await runPhotosReader("query", []);
    expect(callOptions().timeout).toBe(60_000);
  });

  it("honors APPLE_PHOTOS_MCP_TIMEOUT for the default sidecar timeout", async () => {
    const prev = process.env.APPLE_PHOTOS_MCP_TIMEOUT;
    process.env.APPLE_PHOTOS_MCP_TIMEOUT = "300000";
    try {
      execFileSucceeds("{}");
      await runPhotosReader("query", []);
      expect(callOptions().timeout).toBe(300_000);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_TIMEOUT;
      else process.env.APPLE_PHOTOS_MCP_TIMEOUT = prev;
    }
  });

  it("an explicit per-call timeout wins over APPLE_PHOTOS_MCP_TIMEOUT", async () => {
    const prev = process.env.APPLE_PHOTOS_MCP_TIMEOUT;
    process.env.APPLE_PHOTOS_MCP_TIMEOUT = "300000";
    try {
      execFileSucceeds("{}");
      await runPhotosReader("export", [], 30 * 60 * 1000);
      expect(callOptions().timeout).toBe(30 * 60 * 1000);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_TIMEOUT;
      else process.env.APPLE_PHOTOS_MCP_TIMEOUT = prev;
    }
  });

  it("ignores an invalid APPLE_PHOTOS_MCP_TIMEOUT and uses the default", async () => {
    const prev = process.env.APPLE_PHOTOS_MCP_TIMEOUT;
    process.env.APPLE_PHOTOS_MCP_TIMEOUT = "not-a-number";
    try {
      execFileSucceeds("{}");
      await runPhotosReader("query", []);
      expect(callOptions().timeout).toBe(60_000);
    } finally {
      if (prev === undefined) delete process.env.APPLE_PHOTOS_MCP_TIMEOUT;
      else process.env.APPLE_PHOTOS_MCP_TIMEOUT = prev;
    }
  });

  it("uses the cached venv python when the venv is present and ready", async () => {
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
    execFileSucceeds("{}");

    await runPhotosReader("query", []);

    // The interpreter passed to execFile should be the venv python, not a
    // bare "python3"/"python" system command.
    const interpreter = String(execFileMock.mock.calls[0]?.[0]);
    expect(interpreter).toContain("venv/bin/python3");
    // venv-ready means findSystemPython() / execSync version probe is never hit.
    expect(execMock).not.toHaveBeenCalled();
  });

  it("falls back to system python (not cached) when no venv exists", async () => {
    // No venv: resolvePython() should probe the system interpreter via execSync.
    existsMock.mockReturnValue(false);
    execFileSucceeds("{}");

    await runPhotosReader("query", []);

    expect(execMock).toHaveBeenCalled();
    const interpreter = String(execFileMock.mock.calls[0]?.[0]);
    expect(interpreter).toBe("python3");
  });
});

describe("serial gate over sidecar invocations", () => {
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

  it("serializes calls: the second spawn starts only after the first resolves", async () => {
    const pendingCallbacks: ExecFileCallback[] = [];
    execFileMock.mockImplementation(((...callArgs: unknown[]) => {
      pendingCallbacks.push(callArgs[callArgs.length - 1] as ExecFileCallback);
      return fakeChild() as never;
    }) as never);

    const p1 = runPhotosReader("query", []);
    const p2 = runPhotosReader("list-albums", []);

    await tick(10);
    // Only the FIRST sidecar spawned; the second is queued behind the gate.
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(sidecarBusy()).toBe(true);

    pendingCallbacks[0](null, '{"count": 0, "photos": []}', "");
    await tick(10);
    // Now — and only now — the second spawn happened.
    expect(execFileMock).toHaveBeenCalledTimes(2);

    pendingCallbacks[1](null, '{"count": 0, "albums": []}', "");
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.data).toEqual({ count: 0, photos: [] });
    expect(r2.data).toEqual({ count: 0, albums: [] });
    await tick(10);
    expect(sidecarBusy()).toBe(false);
  });

  it("sidecarBusy() is false when idle and true while a call is in flight", async () => {
    expect(sidecarBusy()).toBe(false);
    let release!: ExecFileCallback;
    execFileMock.mockImplementation(((...callArgs: unknown[]) => {
      release = callArgs[callArgs.length - 1] as ExecFileCallback;
      return fakeChild() as never;
    }) as never);

    const p = runPhotosReader("query", []);
    expect(sidecarBusy()).toBe(true);
    await tick(5);
    release(null, "{}", "");
    await p;
    await tick(5);
    expect(sidecarBusy()).toBe(false);
  });

  it("a failing call does not wedge the gate for later calls", async () => {
    execFileFails(
      Object.assign(new Error("Command failed"), { code: 1 }),
      JSON.stringify({ error: "boom" }),
      ""
    );
    const r1 = await runPhotosReader("query", []);
    expect(r1.error).toBe("boom");

    execFileSucceeds('{"ok": true}');
    const r2 = await runPhotosReader("health", []);
    expect(r2.data).toEqual({ ok: true });
    expect(sidecarBusy()).toBe(false);
  });

  it("killActiveSidecars() SIGKILLs an in-flight child", async () => {
    const child = { kill: vi.fn() };
    let release!: ExecFileCallback;
    execFileMock.mockImplementation(((...callArgs: unknown[]) => {
      release = callArgs[callArgs.length - 1] as ExecFileCallback;
      return child as never;
    }) as never);

    const p = runPhotosReader("query", []);
    await tick(5);
    killActiveSidecars();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    // Settle the pending call so the gate drains cleanly.
    release(Object.assign(new Error("killed"), { killed: true }), "", "");
    await p;
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

  it("clears cached state so a later venv is picked up without restart", async () => {
    // First call: no venv -> system python.
    existsMock.mockReturnValue(false);
    execFileSucceeds("{}");
    await runPhotosReader("query", []);
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
    execFileSucceeds("{}");

    await runPhotosReader("query", []);
    expect(String(execFileMock.mock.calls[0]?.[0])).toContain("venv/bin/python3");
  });
});

describe("isVenvReady", () => {
  beforeEach(() => {
    _resetPythonCache();
    existsMock.mockReset();
    existsMock.mockReturnValue(false);
    readFileMock.mockReset();
    readFileMock.mockReturnValue("");
  });

  it("is false when no venv python exists", () => {
    expect(isVenvReady()).toBe(false);
  });

  it("is true when the venv exists and the marker matches requirements", () => {
    const reqs = "osxphotos==0.69.0\n";
    existsMock.mockImplementation((p: unknown) => {
      const s = String(p);
      return (
        s.includes("venv/bin/python3") || s.includes("requirements.txt") || s.includes(".deps-ok")
      );
    });
    readFileMock.mockReturnValue(reqs);
    expect(isVenvReady()).toBe(true);
  });
});

describe("getPythonInfo", () => {
  beforeEach(() => {
    _resetPythonCache();
    execFileMock.mockReset();
    execMock.mockReset();
    execMock.mockReturnValue("Python 3.12.4\n");
    existsMock.mockReset();
    existsMock.mockReturnValue(false);
    readFileMock.mockReset();
    readFileMock.mockReturnValue("");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the venv interpreter path and version when the venv exists", async () => {
    existsMock.mockImplementation((p: unknown) => String(p).includes("venv/bin/python3"));
    execFileSucceeds("Python 3.12.4\n");

    const info = await getPythonInfo();

    expect(info).not.toBeNull();
    expect(info?.path).toContain("venv/bin/python3");
    expect(info?.version).toBe("Python 3.12.4");
    // The --version probe goes through execFile (no shell).
    const [, args] = execFileMock.mock.calls[0];
    expect(args).toEqual(["--version"]);
  });

  it("falls back to the system interpreter when no venv exists", async () => {
    execFileSucceeds("Python 3.9.6\n");

    const info = await getPythonInfo();

    expect(info?.path).toBe("python3");
    expect(info?.version).toBe("Python 3.9.6");
  });

  it("resolves null when no interpreter resolves at all", async () => {
    execMock.mockImplementation(() => {
      throw new Error("command not found");
    });

    await expect(getPythonInfo()).resolves.toBeNull();
  });

  it("resolves null when the version probe itself fails", async () => {
    execFileFails(new Error("boom"));

    await expect(getPythonInfo()).resolves.toBeNull();
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

  it("reports ok with the version when the import probe succeeds", async () => {
    // findSystemPython probes the interpreter via execSync; the import probe runs
    // via execFile (no shell).
    execMock.mockReturnValue("0.69.0\n"); // findSystemPython
    execFileSucceeds("0.69.0\n"); // import probe
    const result = await checkDependencies();
    expect(result.ok).toBe(true);
    expect(result.message).toContain("osxphotos");
    expect(result.message).toContain("0.69.0");
  });

  it("reports not-ok with the setup hint when the import probe throws", async () => {
    // findSystemPython succeeds (execSync); the execFile import probe fails.
    execMock.mockReturnValue("0.69.0\n"); // findSystemPython
    execFileFails(new Error("ModuleNotFoundError: No module named osxphotos"));
    const result = await checkDependencies();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("osxphotos not installed");
    expect(result.message).toContain("pip3 install osxphotos");
  });
});
