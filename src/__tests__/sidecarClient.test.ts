/**
 * Protocol-level unit tests for the persistent sidecar client, driven against
 * a fully scripted fake child (no real spawns): handshake, in-order id
 * matching, progress interleaving, malformed-line restart, crash respawn,
 * request timeout, and the idle-timeout kill.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { PersistentSidecarClient } from "../utils/sidecarClient.js";
import type { ChildLike, SidecarProgress } from "../utils/sidecarClient.js";

class FakeChild implements ChildLike {
  pid = 1000 + FakeChild.count++;
  static count = 0;
  killedWith: NodeJS.Signals | null = null;
  writes: string[] = [];
  private procEvents = new EventEmitter();
  private stdoutEvents = new EventEmitter();
  private stderrEvents = new EventEmitter();

  stdin = {
    write: (chunk: string): boolean => {
      this.writes.push(chunk);
      return true;
    },
    on: (): unknown => this.stdin,
  };
  stdout = {
    on: (event: "data", cb: (chunk: Buffer | string) => void): unknown =>
      this.stdoutEvents.on(event, cb),
  };
  stderr = {
    on: (event: "data", cb: (chunk: Buffer | string) => void): unknown =>
      this.stderrEvents.on(event, cb),
  };

  on(event: string, cb: (...args: never[]) => void): unknown {
    return this.procEvents.on(event, cb as (...args: unknown[]) => void);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? "SIGTERM";
    return true;
  }

  // --- test drivers ---
  emitStdout(s: string): void {
    this.stdoutEvents.emit("data", s);
  }
  emitStderr(s: string): void {
    this.stderrEvents.emit("data", s);
  }
  exit(code: number | null, signal: string | null = null): void {
    this.procEvents.emit("exit", code, signal);
  }
  ready(): void {
    this.emitStdout(JSON.stringify({ type: "ready", protocol: 1 }) + "\n");
  }
  respond(obj: Record<string, unknown>): void {
    this.emitStdout(JSON.stringify(obj) + "\n");
  }
  /** The id the client assigned to its most recent request. */
  lastRequestId(): number {
    const last = this.writes[this.writes.length - 1];
    return (JSON.parse(last) as { id: number }).id;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PersistentSidecarClient", () => {
  let children: FakeChild[];
  let idleMs: number;
  let client: PersistentSidecarClient;

  beforeEach(() => {
    children = [];
    idleMs = 0; // idle kill off unless a test opts in
    client = new PersistentSidecarClient({
      resolveSpawn: () => ({ file: "python3", args: ["reader.py", "--serve"] }),
      idleMs: () => idleMs,
      spawnImpl: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      log: () => {},
    });
  });

  afterEach(() => {
    client.kill("test teardown");
    vi.useRealTimers();
  });

  it("performs the handshake once and resolves a matching-id result", async () => {
    const p = client.request("query", ["--limit=5"], 5000);
    children[0].ready();
    await tick(); // handshake microtask → request line written
    expect(children[0].writes).toHaveLength(1);
    const req = JSON.parse(children[0].writes[0]) as {
      id: number;
      command: string;
      args: string[];
    };
    expect(req.command).toBe("query");
    expect(req.args).toEqual(["--limit=5"]);

    children[0].respond({ id: req.id, type: "result", data: { count: 3 }, dbCached: true });
    const outcome = await p;
    expect(outcome).toEqual({ kind: "result", data: { count: 3 }, dbCached: true });
    expect(client.status.running).toBe(true);
    expect(client.status.spawnCount).toBe(1);
  });

  it("reuses the same process for consecutive requests (no respawn)", async () => {
    const p1 = client.request("query", [], 5000);
    children[0].ready();
    await tick();
    children[0].respond({ id: children[0].lastRequestId(), type: "result", data: { n: 1 } });
    await p1;

    const p2 = client.request("list-albums", [], 5000);
    await tick();
    children[0].respond({ id: children[0].lastRequestId(), type: "result", data: { n: 2 } });
    const o2 = await p2;

    expect(children).toHaveLength(1); // one spawn served both
    expect(o2.kind).toBe("result");
  });

  it("forwards progress lines for the pending id to onProgress, in order", async () => {
    const seen: SidecarProgress[] = [];
    const p = client.request("export", ["--uuid=A", "--dest=/tmp/x"], 5000, (pr) => seen.push(pr));
    children[0].ready();
    await tick();
    const id = children[0].lastRequestId();
    children[0].respond({ id, type: "progress", done: 0, total: 2, current: "a.jpg", uuid: "A" });
    children[0].respond({ id, type: "progress", done: 1, total: 2, current: "b.jpg", uuid: "B" });
    children[0].respond({ id: 999, type: "progress", done: 9, total: 9 }); // wrong id → dropped
    children[0].respond({ id, type: "result", data: { exportedCount: 2 } });
    const outcome = await p;
    expect(outcome.kind).toBe("result");
    expect(seen).toEqual([
      { done: 0, total: 2, current: "a.jpg", uuid: "A" },
      { done: 1, total: 2, current: "b.jpg", uuid: "B" },
    ]);
  });

  it("falls back when the handshake line is not ready (old script, import error)", async () => {
    const p = client.request("query", [], 5000);
    children[0].respond({ error: "osxphotos not installed. Install it with: ..." });
    const outcome = await p;
    expect(outcome).toEqual({
      kind: "fallback",
      reason: "osxphotos not installed. Install it with: ...",
    });
    expect(children[0].killedWith).toBe("SIGKILL");
  });

  it("falls back when the child exits before the handshake", async () => {
    const p = client.request("query", [], 5000);
    children[0].emitStderr("photos_reader: error: unrecognized arguments: --serve\n");
    children[0].exit(2);
    const outcome = await p;
    expect(outcome.kind).toBe("fallback");
    expect((outcome as { reason: string }).reason).toContain("before the serve handshake");
    expect((outcome as { reason: string }).reason).toContain("unrecognized arguments");
  });

  it("kills the child and fails the request on a malformed protocol line", async () => {
    const p = client.request("query", [], 5000);
    children[0].ready();
    await tick();
    children[0].emitStdout("not json at all\n");
    const outcome = await p;
    expect(outcome.kind).toBe("error");
    expect((outcome as { error: string }).error).toContain("non-protocol line");
    expect(children[0].killedWith).toBe("SIGKILL");
    expect(client.status.running).toBe(false);
  });

  it("kills the child and fails the request on a mismatched result id", async () => {
    const p = client.request("query", [], 5000);
    children[0].ready();
    await tick();
    children[0].respond({ id: 424242, type: "result", data: {} });
    const outcome = await p;
    expect(outcome.kind).toBe("error");
    expect((outcome as { error: string }).error).toContain("424242");
    expect(children[0].killedWith).toBe("SIGKILL");
  });

  it("fails the request with the stderr tail when the child dies mid-request, then respawns", async () => {
    const p = client.request("query", [], 5000);
    children[0].ready();
    await tick();
    children[0].emitStderr("Traceback (most recent call last):\nRuntimeError: boom\n");
    children[0].exit(1);
    const outcome = await p;
    expect(outcome.kind).toBe("error");
    expect((outcome as { error: string }).error).toContain("exited unexpectedly");
    expect((outcome as { error: string }).error).toContain("RuntimeError: boom");

    // Restart-on-crash: the next request spawns a fresh process and succeeds.
    const p2 = client.request("query", [], 5000);
    expect(children).toHaveLength(2);
    children[1].ready();
    await tick();
    children[1].respond({ id: children[1].lastRequestId(), type: "result", data: { n: 2 } });
    const o2 = await p2;
    expect(o2.kind).toBe("result");
    expect(client.status.spawnCount).toBe(2);
  });

  it("SIGKILLs and reports timeout when the deadline passes without a response", async () => {
    vi.useFakeTimers();
    const p = client.request("query", [], 1000);
    children[0].ready();
    await vi.advanceTimersByTimeAsync(1); // handshake microtasks
    expect(children[0].writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1500);
    const outcome = await p;
    expect(outcome).toEqual({ kind: "timeout" });
    expect(children[0].killedWith).toBe("SIGKILL");
  });

  it("reports timeout when the handshake itself never arrives", async () => {
    vi.useFakeTimers();
    const p = client.request("query", [], 1000);
    await vi.advanceTimersByTimeAsync(1500);
    const outcome = await p;
    expect(outcome).toEqual({ kind: "timeout" });
    expect(children[0].killedWith).toBe("SIGKILL");
  });

  it("kills an idle process after the idle timeout and respawns on the next request", async () => {
    vi.useFakeTimers();
    idleMs = 200;
    const p = client.request("query", [], 5000);
    children[0].ready();
    await vi.advanceTimersByTimeAsync(1);
    children[0].respond({ id: children[0].lastRequestId(), type: "result", data: {} });
    await p;
    expect(client.status.running).toBe(true);

    await vi.advanceTimersByTimeAsync(300);
    expect(children[0].killedWith).toBe("SIGKILL");
    expect(client.status.running).toBe(false);

    const p2 = client.request("query", [], 5000);
    expect(children).toHaveLength(2);
    children[1].ready();
    await vi.advanceTimersByTimeAsync(1);
    children[1].respond({ id: children[1].lastRequestId(), type: "result", data: {} });
    const o2 = await p2;
    expect(o2.kind).toBe("result");
  });

  it("does not arm the idle kill when idleMs is 0", async () => {
    vi.useFakeTimers();
    idleMs = 0;
    const p = client.request("query", [], 5000);
    children[0].ready();
    await vi.advanceTimersByTimeAsync(1);
    children[0].respond({ id: children[0].lastRequestId(), type: "result", data: {} });
    await p;

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(children[0].killedWith).toBeNull();
    expect(client.status.running).toBe(true);
  });

  it("passes serve-mode {type:error} responses through as error outcomes", async () => {
    const p = client.request("get-photo", ["--uuid=NOPE"], 5000);
    children[0].ready();
    await tick();
    children[0].respond({
      id: children[0].lastRequestId(),
      type: "error",
      error: "Library not found: /nope",
    });
    const outcome = await p;
    expect(outcome).toEqual({ kind: "error", error: "Library not found: /nope" });
    // A structured error is a NORMAL response — the process stays up.
    expect(children[0].killedWith).toBeNull();
    expect(client.status.running).toBe(true);
  });

  it("rejects concurrent requests instead of interleaving protocol traffic", async () => {
    const p1 = client.request("query", [], 5000);
    const p2 = await client.request("query", [], 5000);
    expect(p2.kind).toBe("error");
    expect((p2 as { error: string }).error).toContain("busy");
    children[0].ready();
    await tick();
    children[0].respond({ id: children[0].lastRequestId(), type: "result", data: {} });
    await p1;
  });

  it("kill() clears state so the next request respawns cleanly", async () => {
    const p = client.request("query", [], 5000);
    children[0].ready();
    await tick();
    children[0].respond({ id: children[0].lastRequestId(), type: "result", data: {} });
    await p;

    client.kill("shutdown");
    expect(children[0].killedWith).toBe("SIGKILL");
    expect(client.status.running).toBe(false);

    const p2 = client.request("health", [], 5000);
    expect(children).toHaveLength(2);
    children[1].ready();
    await tick();
    children[1].respond({ id: children[1].lastRequestId(), type: "result", data: { ok: true } });
    const o2 = await p2;
    expect(o2.kind).toBe("result");
  });
});
