/**
 * Serve-mode ROUTING tests for runPhotosReader: persistent-client outcomes
 * must map onto the exact same user-facing contract as one-shot mode
 * (structured errors, the setup hint, the timeout string), fallbacks must
 * transparently run one-shot, and only unfixable handshake failures may
 * disable serve mode for the process. The client's own protocol behavior is
 * covered in sidecarClient.test.ts; here it is a scripted mock.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { requestMock, killMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  killMock: vi.fn(),
}));

vi.mock("../utils/sidecarClient.js", () => ({
  PersistentSidecarClient: class {
    request = requestMock;
    kill = killMock;
    get status() {
      return { running: true, pid: 4242, spawnCount: 2, lastSpawnAt: 1751980800000 };
    }
  },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "0.69.0\n"),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { runPhotosReader, getSidecarInfo, _resetPythonCache } from "../utils/python.js";

const execFileMock = vi.mocked(execFile);

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

function execFileSucceeds(stdout: string) {
  execFileMock.mockImplementation(((...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as ExecFileCallback;
    process.nextTick(() => cb(null, stdout, ""));
    return { kill: vi.fn() } as never;
  }) as never);
}

describe("runPhotosReader over the persistent sidecar", () => {
  beforeEach(() => {
    delete process.env.APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR;
    requestMock.mockReset();
    killMock.mockReset();
    execFileMock.mockReset();
    _resetPythonCache(); // also re-enables serve mode + resets the fallback log
  });

  afterEach(() => {
    delete process.env.APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR;
    vi.restoreAllMocks();
  });

  it("returns serve-mode result data without spawning a one-shot process", async () => {
    requestMock.mockResolvedValue({ kind: "result", data: { count: 7, photos: [] } });
    const result = await runPhotosReader("query", ["--limit=5"]);
    expect(result.data).toEqual({ count: 7, photos: [] });
    expect(result.error).toBeUndefined();
    expect(requestMock).toHaveBeenCalledWith("query", ["--limit=5"], 60_000, undefined);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("maps a serve-mode result carrying {error} through the structured-error contract", async () => {
    requestMock.mockResolvedValue({ kind: "result", data: { error: "Photo not found: X" } });
    const result = await runPhotosReader("get-photo", ["--uuid=X"]);
    expect(result.error).toBe("Photo not found: X");
  });

  it("maps a serve-mode missing-dep error to the setup hint (same as one-shot)", async () => {
    requestMock.mockResolvedValue({
      kind: "error",
      error: "ModuleNotFoundError: No module named 'osxphotos'",
    });
    const result = await runPhotosReader("query", []);
    expect(result.error).toContain("osxphotos not installed");
    expect(result.error).toContain("pip3 install osxphotos");
  });

  it("maps a serve-mode error outcome verbatim when it isn't dep-related", async () => {
    requestMock.mockResolvedValue({ kind: "error", error: "unable to open database file" });
    const result = await runPhotosReader("query", []);
    expect(result.error).toBe("unable to open database file");
  });

  it("maps a serve-mode timeout to the exact one-shot timeout message", async () => {
    requestMock.mockResolvedValue({ kind: "timeout" });
    const result = await runPhotosReader("query", [], 5000);
    expect(result.error).toMatch(/timed out/i);
    expect(result.error).toContain("5000");
    expect(result.error).toContain("APPLE_PHOTOS_MCP_TIMEOUT");
  });

  it("forwards the onProgress callback to the client", async () => {
    requestMock.mockResolvedValue({ kind: "result", data: { exportedCount: 1 } });
    const onProgress = vi.fn();
    await runPhotosReader("export", ["--uuid=A"], 1000, onProgress);
    expect(requestMock).toHaveBeenCalledWith("export", ["--uuid=A"], 1000, onProgress);
  });

  it("falls back to one-shot on a handshake failure and disables serve mode permanently", async () => {
    requestMock.mockResolvedValue({
      kind: "fallback",
      reason: "unexpected handshake line: garbage",
    });
    execFileSucceeds('{"count": 0, "photos": []}');

    const r1 = await runPhotosReader("query", []);
    expect(r1.data).toEqual({ count: 0, photos: [] });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(getSidecarInfo().mode).toBe("one-shot");
    expect(getSidecarInfo().reason).toContain("handshake failed");

    // Second call: straight to one-shot — the client is never consulted again.
    const r2 = await runPhotosReader("query", []);
    expect(r2.data).toEqual({ count: 0, photos: [] });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("treats a missing-dep handshake failure as transient (serve mode retried)", async () => {
    requestMock.mockResolvedValue({
      kind: "fallback",
      reason: "osxphotos not installed. Install it with: ...",
    });
    execFileSucceeds('{"ok": true}');

    await runPhotosReader("health", []);
    expect(getSidecarInfo().mode).toBe("persistent"); // NOT disabled

    await runPhotosReader("health", []);
    // The client was consulted again on the second call.
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("never consults the client when APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR=0", async () => {
    process.env.APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR = "0";
    execFileSucceeds('{"ok": true}');

    const result = await runPhotosReader("health", []);
    expect(result.data).toEqual({ ok: true });
    expect(requestMock).not.toHaveBeenCalled();

    const info = getSidecarInfo();
    expect(info.mode).toBe("one-shot");
    expect(info.reason).toContain("APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR");
  });

  it("reports persistent mode with pid and last-spawn time when serving", async () => {
    requestMock.mockResolvedValue({ kind: "result", data: { ok: true } });
    await runPhotosReader("health", []);
    const info = getSidecarInfo();
    expect(info.mode).toBe("persistent");
    expect(info.running).toBe(true);
    expect(info.pid).toBe(4242);
    expect(info.spawnCount).toBe(2);
    expect(info.lastSpawnAt).toBe(new Date(1751980800000).toISOString());
  });
});
