/**
 * Persistent sidecar client — the Node side of photos_reader.py's `--serve`
 * protocol.
 *
 * Every one-shot sidecar call pays a fixed multi-second cost (python spawn +
 * `import osxphotos` + a full PhotosDB parse of the entire library) that
 * dwarfs the actual command. This client keeps ONE `photos_reader.py --serve`
 * process alive and sends it line-delimited JSON requests over stdin, so the
 * import and the parsed PhotosDB are paid once and reused — the sidecar
 * revalidates the library's Photos.sqlite mtime before every request, so a
 * changed library still re-parses immediately.
 *
 * Protocol (all lines are single JSON objects, one per line):
 *   -> {"id", "command", "args": [argv tokens]}
 *   <- {"type": "ready", "protocol": 1}                    handshake, once
 *   <- {"id", "type": "result", "data", "dbCached"}        terminal
 *   <- {"id", "type": "error", "error"}                    terminal
 *   <- {"id", "type": "progress", "done", "total", ...}    0..n before terminal
 *
 * Concurrency: exactly one request is in flight at a time — the caller
 * (python.ts's serial gate) guarantees it, and this client enforces it.
 *
 * Failure policy:
 *   - handshake never arrives / non-ready first line → resolve
 *     {kind: "fallback"} so the caller can transparently run the command in
 *     one-shot mode (old script, broken env, missing deps);
 *   - per-request timeout → SIGKILL the child, resolve {kind: "timeout"}
 *     (the caller maps it to the exact same user-facing timeout string as
 *     one-shot mode);
 *   - malformed/mismatched protocol line, EOF, or child exit mid-request →
 *     SIGKILL/clean up, fail THIS request with a diagnostic (stderr tail),
 *     and let the next request respawn (restart-on-crash);
 *   - idle timeout (APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS) kills the child between
 *     requests to bound resident memory; the next request respawns.
 *
 * Child stderr is captured into a small ring buffer for diagnostics and never
 * touches protocol parsing.
 *
 * @module utils/sidecarClient
 */

import { spawn as nodeSpawn } from "node:child_process";

/** Progress payload forwarded from a serve-mode `export`. */
export interface SidecarProgress {
  done: number;
  total: number;
  current?: string;
  uuid?: string;
}

/** Outcome of a serve-mode request. */
export type ServeOutcome =
  | { kind: "result"; data: unknown; dbCached?: boolean }
  | { kind: "error"; error: string }
  | { kind: "timeout" }
  | { kind: "fallback"; reason: string };

/**
 * The slice of ChildProcess this client uses — narrow so unit tests can
 * substitute a fully scripted fake (streams + events) without real spawns.
 */
export interface ChildLike {
  pid?: number;
  stdin: { write(chunk: string): boolean; on(event: "error", cb: (err: Error) => void): unknown };
  stdout: {
    on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
    unref?: () => void;
  };
  stderr: {
    on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
    unref?: () => void;
  };
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref?: () => void;
}

export type SpawnFn = (file: string, args: string[]) => ChildLike;

export interface SidecarClientOptions {
  /** Resolve the interpreter + argv at spawn time (venv may appear later). */
  resolveSpawn: () => { file: string; args: string[] };
  /** Idle kill delay in ms, read at arm time; <= 0 disables the idle kill. */
  idleMs: () => number;
  /** Injectable spawn for tests. */
  spawnImpl?: SpawnFn;
  /** Diagnostic logger (defaults to console.error — NEVER stdout). */
  log?: (message: string) => void;
}

export interface SidecarClientStatus {
  running: boolean;
  pid?: number;
  /** Number of serve processes spawned over this server's lifetime. */
  spawnCount: number;
  /** Epoch ms of the most recent spawn, or null if never spawned. */
  lastSpawnAt: number | null;
}

const STDERR_RING_LINES = 40;
const STDERR_TAIL_CHARS = 2000;

interface Pending {
  id: number;
  settled: boolean;
  resolve: (outcome: ServeOutcome) => void;
  onProgress?: (p: SidecarProgress) => void;
  timer: NodeJS.Timeout;
}

interface Handshake {
  settled: boolean;
  resolve: (outcome: true | { kind: "fallback"; reason: string } | { kind: "timeout" }) => void;
  timer: NodeJS.Timeout;
}

export class PersistentSidecarClient {
  private proc: ChildLike | null = null;
  private ready = false;
  private buffer = "";
  private stderrRing: string[] = [];
  private nextId = 1;
  private pending: Pending | null = null;
  private handshake: Handshake | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private spawnCount = 0;
  private lastSpawnAt: number | null = null;
  private readonly spawnImpl: SpawnFn;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: SidecarClientOptions) {
    this.spawnImpl = opts.spawnImpl ?? ((file, args) => nodeSpawn(file, args) as ChildLike);
    this.log = opts.log ?? ((m) => console.error(m));
  }

  get status(): SidecarClientStatus {
    return {
      running: this.proc !== null && this.ready,
      pid: this.proc?.pid,
      spawnCount: this.spawnCount,
      lastSpawnAt: this.lastSpawnAt,
    };
  }

  /**
   * Run one command through the serve protocol. The timeout covers the whole
   * request — including a cold spawn + handshake when no process is running.
   * Progress lines for this request's id are forwarded to onProgress.
   */
  async request(
    command: string,
    args: string[],
    timeoutMs: number,
    onProgress?: (p: SidecarProgress) => void
  ): Promise<ServeOutcome> {
    if (this.pending !== null || this.handshake !== null) {
      // The serial gate upstream should make this impossible; refuse rather
      // than interleave protocol traffic.
      return { kind: "error", error: "sidecar client busy (concurrent request)" };
    }
    this.clearIdleTimer();
    const deadline = Date.now() + timeoutMs;

    if (this.proc === null || !this.ready) {
      const hs = await this.spawnAndHandshake(deadline);
      if (hs !== true) return hs;
    }
    return new Promise<ServeOutcome>((resolve) => {
      const id = this.nextId++;
      const pending: Pending = {
        id,
        settled: false,
        onProgress,
        resolve: (outcome) => {
          if (pending.settled) return;
          pending.settled = true;
          clearTimeout(pending.timer);
          this.pending = null;
          // If the child survived this request, it becomes eligible for the
          // idle kill (armIdleTimer no-ops when the process is already gone).
          this.armIdleTimer();
          resolve(outcome);
        },
        timer: setTimeout(
          () => {
            this.kill("request timeout");
            pending.resolve({ kind: "timeout" });
          },
          Math.max(1, deadline - Date.now())
        ),
      };
      this.pending = pending;
      try {
        this.proc?.stdin.write(JSON.stringify({ id, command, args }) + "\n");
      } catch (err) {
        this.kill("stdin write failed");
        pending.resolve({
          kind: "error",
          error: `Photos sidecar request could not be written: ${String(err)}${this.stderrTail()}`,
        });
      }
    });
  }

  /** SIGKILL the serve process (shutdown, timeout, idle, protocol error). */
  kill(reason: string): void {
    this.clearIdleTimer();
    const proc = this.proc;
    this.proc = null;
    this.ready = false;
    this.buffer = "";
    if (proc !== null) {
      if (process.env.DEBUG || process.env.VERBOSE) {
        this.log(`[photos-mcp] killing persistent sidecar (${reason})`);
      }
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }

  // -------------------------------------------------------------------------

  private async spawnAndHandshake(
    deadline: number
  ): Promise<true | { kind: "fallback"; reason: string } | { kind: "timeout" }> {
    let proc: ChildLike;
    try {
      const { file, args } = this.opts.resolveSpawn();
      proc = this.spawnImpl(file, args);
    } catch (err) {
      return { kind: "fallback", reason: `spawn failed: ${String(err)}` };
    }
    this.proc = proc;
    this.ready = false;
    this.buffer = "";
    this.stderrRing = [];
    this.spawnCount += 1;
    this.lastSpawnAt = Date.now();

    // An idle background helper must never keep the parent's event loop alive.
    proc.unref?.();
    proc.stdout.unref?.();
    proc.stderr.unref?.();

    proc.stdout.on("data", (chunk) => this.onStdout(proc, String(chunk)));
    proc.stderr.on("data", (chunk) => this.onStderr(String(chunk)));
    proc.on("exit", (code, signal) => this.onExit(proc, code, signal));
    proc.on("error", (err) => this.onProcError(proc, err));
    proc.stdin.on("error", () => {
      // EPIPE from a dead child — surfaced through exit handling; swallowing
      // here just prevents an uncaught stream error.
    });

    return new Promise((resolve) => {
      const handshake: Handshake = {
        settled: false,
        resolve: (outcome) => {
          if (handshake.settled) return;
          handshake.settled = true;
          clearTimeout(handshake.timer);
          this.handshake = null;
          resolve(outcome);
        },
        timer: setTimeout(
          () => {
            this.kill("handshake timeout");
            handshake.resolve({ kind: "timeout" });
          },
          Math.max(1, deadline - Date.now())
        ),
      };
      this.handshake = handshake;
    });
  }

  private onStdout(proc: ChildLike, chunk: string): void {
    if (proc !== this.proc) return; // stale stream from a killed child
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.onLine(line);
      if (proc !== this.proc) return; // a protocol error mid-loop killed it
    }
  }

  private onLine(line: string): void {
    let msg: {
      type?: unknown;
      id?: unknown;
      protocol?: unknown;
      data?: unknown;
      dbCached?: unknown;
      error?: unknown;
      done?: unknown;
      total?: unknown;
      current?: unknown;
      uuid?: unknown;
    };
    try {
      msg = JSON.parse(line) as typeof msg;
      if (msg === null || typeof msg !== "object") throw new Error("not an object");
    } catch {
      this.protocolFailure(`sidecar produced a non-protocol line: ${truncate(line, 200)}`);
      return;
    }

    // --- handshake phase ---
    if (this.handshake !== null) {
      if (msg.type === "ready" && msg.protocol === 1) {
        this.ready = true;
        this.handshake.resolve(true);
      } else {
        // Anything else (an {"error": ...} import failure, an old script's
        // output, garbage) → this process can't serve; fall back to one-shot.
        this.kill("handshake failed");
        this.handshake?.resolve({
          kind: "fallback",
          reason:
            typeof msg.error === "string"
              ? msg.error
              : `unexpected handshake line: ${truncate(line, 200)}`,
        });
      }
      return;
    }

    const pending = this.pending;
    if (msg.type === "progress") {
      // Progress for a request that's no longer pending is dropped, not fatal.
      if (pending !== null && msg.id === pending.id && pending.onProgress) {
        pending.onProgress({
          done: typeof msg.done === "number" ? msg.done : 0,
          total: typeof msg.total === "number" ? msg.total : 0,
          current: typeof msg.current === "string" ? msg.current : undefined,
          uuid: typeof msg.uuid === "string" ? msg.uuid : undefined,
        });
      }
      return;
    }

    if (msg.type === "result" || msg.type === "error") {
      if (pending === null || msg.id !== pending.id) {
        this.protocolFailure(
          `sidecar answered id ${JSON.stringify(msg.id)} but ` +
            `${pending === null ? "no request is pending" : `id ${pending.id} was expected`}`
        );
        return;
      }
      if (msg.type === "result") {
        pending.resolve({
          kind: "result",
          data: msg.data,
          dbCached: typeof msg.dbCached === "boolean" ? msg.dbCached : undefined,
        });
      } else {
        pending.resolve({
          kind: "error",
          error: typeof msg.error === "string" ? msg.error : "sidecar reported an unknown error",
        });
      }
      return;
    }

    this.protocolFailure(`sidecar sent an unknown message type: ${truncate(line, 200)}`);
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trimEnd();
      if (trimmed.length === 0) continue;
      this.stderrRing.push(trimmed);
      if (this.stderrRing.length > STDERR_RING_LINES) this.stderrRing.shift();
    }
  }

  private onExit(proc: ChildLike, code: number | null, signal: string | null): void {
    if (proc !== this.proc) return; // already replaced/killed
    this.proc = null;
    this.ready = false;
    this.buffer = "";
    this.clearIdleTimer();
    const detail = `exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"})`;
    if (this.handshake !== null) {
      this.handshake.resolve({
        kind: "fallback",
        reason: `sidecar ${detail} before the serve handshake${this.stderrTail()}`,
      });
      return;
    }
    if (this.pending !== null) {
      this.pending.resolve({
        kind: "error",
        error: `Photos sidecar ${detail}${this.stderrTail()}`,
      });
    }
  }

  private onProcError(proc: ChildLike, err: Error): void {
    if (proc !== this.proc) return;
    this.proc = null;
    this.ready = false;
    if (this.handshake !== null) {
      this.handshake.resolve({ kind: "fallback", reason: `spawn failed: ${err.message}` });
      return;
    }
    if (this.pending !== null) {
      this.pending.resolve({
        kind: "error",
        error: `Photos sidecar process error: ${err.message}${this.stderrTail()}`,
      });
    }
  }

  /** A malformed or out-of-order protocol line: kill and fail the request. */
  private protocolFailure(detail: string): void {
    this.kill("protocol failure");
    if (this.handshake !== null) {
      this.handshake.resolve({ kind: "fallback", reason: detail });
      return;
    }
    if (this.pending !== null) {
      this.pending.resolve({ kind: "error", error: `${detail}${this.stderrTail()}` });
    }
  }

  private stderrTail(): string {
    if (this.stderrRing.length === 0) return "";
    const tail = this.stderrRing.slice(-8).join("\n");
    return `\nsidecar stderr:\n${truncate(tail, STDERR_TAIL_CHARS)}`;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const ms = this.opts.idleMs();
    if (!(ms > 0) || this.proc === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending === null && this.handshake === null) {
        this.kill("idle timeout");
      }
    }, ms);
    // Never keep the server process alive just to kill an idle helper.
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
