import { execSync, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, parse } from "node:path";
import { REQUIREMENTS_URL, TROUBLESHOOTING_URL } from "./docsUrls.js";
import { acquireSetupLock, releaseSetupLock, waitForCompletion } from "./setupLock.js";
import { createSerialGate } from "./serialize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE = "osxphotos";
const ENV_PREFIX = "APPLE_PHOTOS_MCP";

let cachedProjectRoot: string | null = null;

/**
 * Locate the package root — the directory that owns package.json AND the shipped
 * python sidecar. Walking up from this module rather than assuming a fixed depth
 * is required because the shipped entrypoint is now an esbuild bundle:
 *   - bundled:   this code runs from build/index.js       (__dirname = build/)
 *   - unbundled: this code runs from build/utils/python.js (__dirname = build/utils/)
 *   - dev/tests: this code runs from src/utils/python.ts   (__dirname = src/utils/)
 * A fixed `../..` was correct only for the unbundled layout and pointed one level
 * ABOVE the real root once bundled, breaking the sidecar/venv/setup paths. The
 * "contains package.json + src/utils/photos_reader.py" check disambiguates from a
 * parent directory that merely happens to hold an unrelated package.json.
 */
function getProjectRoot(): string {
  if (cachedProjectRoot !== null) return cachedProjectRoot;
  const { root } = parse(__dirname);
  let dir = __dirname;
  while (true) {
    if (
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, "src", "utils", "photos_reader.py"))
    ) {
      cachedProjectRoot = dir;
      return dir;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  // Fallback to the historical two-levels-up guess if no marked root was found
  // (keeps behavior defined even in an unexpected layout).
  cachedProjectRoot = join(__dirname, "..", "..");
  return cachedProjectRoot;
}

function getScriptPath(): string {
  return join(getProjectRoot(), "src", "utils", "photos_reader.py");
}

function venvPythonPath(): string {
  return join(getProjectRoot(), "venv", "bin", "python3");
}

function requirementsPath(): string {
  return join(getProjectRoot(), "requirements.txt");
}

function setupScriptPath(): string {
  return join(getProjectRoot(), "scripts", "setup.sh");
}

// Cross-process bootstrap lock (see utils/setupLock.ts). Shared with
// scripts/setup.sh, which implements the same mkdir-lock protocol for manual
// runs — one directory, one protocol, whichever entry point gets there first.
function setupLockPath(): string {
  return join(getProjectRoot(), "venv.setup.lock");
}

// Written by scripts/setup.sh after a successful install; holds a copy of the
// requirements.txt the venv was built against, so we can detect a stale venv
// after a package update changes requirements.
function depsMarkerPath(): string {
  return join(getProjectRoot(), "venv", ".deps-ok");
}

function readIfExists(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * True when the venv exists AND was built against the CURRENT requirements.txt.
 * A package update that changes requirements invalidates the marker, so the
 * server knows to rebuild rather than run against stale deps.
 */
function venvIsReady(): boolean {
  if (!existsSync(venvPythonPath())) return false;
  const reqs = readIfExists(requirementsPath());
  // If requirements.txt isn't present (unexpected), trust an existing venv.
  if (reqs === null) return true;
  const marker = readIfExists(depsMarkerPath());
  return marker !== null && marker.trim() === reqs.trim();
}

/**
 * Pure-filesystem readiness signal (no process spawn) — lets health-check's
 * fast liveness path report whether the Python deps look installed while a
 * long sidecar operation holds the gate.
 */
export function isVenvReady(): boolean {
  return venvIsReady();
}

export interface PythonResult<T = unknown> {
  data?: T;
  error?: string;
}

let cachedPython: string | null = null;
let readyConfirmed = false;
let bootstrapAttempted = false;
let bootstrapPromise: Promise<boolean> | null = null;

export function _resetPythonCache(): void {
  cachedPython = null;
  readyConfirmed = false;
  bootstrapAttempted = false;
  bootstrapPromise = null;
}

function findSystemPython(): string {
  // The interpreter names below are hardcoded literals (no user/env input), so
  // this command is not injectable. The env-derived python path used elsewhere
  // (execReader, checkDependencies) goes through execFile with no shell.
  // Deliberately synchronous: a sub-100ms `--version` probe that only runs when
  // no venv exists — not worth an async seam.
  for (const cmd of ["python3", "python"]) {
    try {
      execSync(`${cmd} --version`, { stdio: "pipe" });
      return cmd;
    } catch {
      continue;
    }
  }
  throw new Error(
    "Python 3 not found on PATH. Install Python 3.11+ (stock macOS ships 3.9 — " +
      "brew install python@3.12), then retry. " +
      `See ${REQUIREMENTS_URL}.`
  );
}

/**
 * Resolve a Python interpreter. The project venv is cached once present (it's
 * stable); a system-Python fallback is deliberately NOT cached, so a venv
 * created later (e.g. by auto-bootstrap, or a manual `scripts/setup.sh`) is picked
 * up on the very next call WITHOUT requiring a server restart.
 */
function resolvePython(): string {
  if (cachedPython && existsSync(cachedPython)) return cachedPython;
  cachedPython = null;
  const venv = venvPythonPath();
  if (existsSync(venv)) {
    cachedPython = venv;
    return venv;
  }
  return findSystemPython();
}

function isTrueish(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** Auto-bootstrap is off under tests, or when explicitly disabled via env. */
function autoSetupDisabled(): boolean {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return true;
  return isTrueish(process.env[`${ENV_PREFIX}_NO_AUTO_SETUP`]);
}

function bootstrapTimeoutMs(): number {
  const raw = process.env[`${ENV_PREFIX}_SETUP_TIMEOUT`];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5 * 60 * 1000; // 5 minutes — pip install of osxphotos can be slow.
}

/**
 * A held bootstrap lock older than this is presumed abandoned (holder died
 * mid-setup) and taken over. Scaled off the setup timeout so a legitimately
 * slow install (raised APPLE_PHOTOS_MCP_SETUP_TIMEOUT) is never hijacked.
 */
function lockStaleMs(): number {
  return Math.max(2 * bootstrapTimeoutMs(), 10 * 60 * 1000);
}

/** Shape of the error the execFile callback reports on failure. */
interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  killed?: boolean;
  code?: number | string | null;
  signal?: NodeJS.Signals | null;
}

/**
 * Children spawned by this module that are still running. Killed on server
 * shutdown so an exiting parent can't orphan a long-running sidecar (an
 * iCloud-heavy export can run for many minutes).
 */
const activeChildren = new Set<ChildProcess>();

/** SIGKILL every in-flight sidecar child. Called from the shutdown path. */
export function killActiveSidecars(): void {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited — nothing to do.
    }
  }
  activeChildren.clear();
}

/**
 * Async execFile returning stdout, with the execFileSync-compatible error
 * shape (stdout/stderr attached to the rejection error) that the parsing in
 * execReader relies on. SIGKILL on timeout, matching the AppleScript siblings
 * (SIGTERM can be ignored by a wedged python child). The child never blocks
 * the event loop — that's the entire point of this module's async flip.
 */
function execFileAsync(
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf-8", killSignal: "SIGKILL", ...options },
      (error, stdout, stderr) => {
        activeChildren.delete(child);
        if (error) {
          const e = error as ExecFailure;
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
        } else {
          resolve(stdout);
        }
      }
    );
    activeChildren.add(child);
  });
}

/**
 * Create or refresh the venv by running scripts/setup.sh. Resolves true on
 * success. Progress is logged to STDERR only — stdout is the MCP protocol
 * channel and must never be written to.
 *
 * Concurrency: guarded by a cross-process mkdir lock (utils/setupLock.ts) so
 * two server instances hitting a fresh install can't both run pip into the
 * same ./venv and corrupt it. The lock loser waits (bounded by the setup
 * timeout) for the winner's completion marker instead of racing. Within this
 * process, callers go through attemptBootstrap() which single-flights the
 * promise.
 */
async function bootstrapVenv(): Promise<boolean> {
  bootstrapAttempted = true;
  const setup = setupScriptPath();
  if (!existsSync(setup)) return false;

  const lockDir = setupLockPath();
  if (!acquireSetupLock(lockDir, lockStaleMs())) {
    console.error(
      `[photos-mcp] Another process is already setting up the Python venv ` +
        `(lock: ${lockDir}) — waiting for it to finish…`
    );
    if (await waitForCompletion(() => venvIsReady(), bootstrapTimeoutMs())) {
      console.error("[photos-mcp] Python venv ready (set up by another process).");
      cachedPython = null;
      readyConfirmed = false;
      return true;
    }
    console.error(
      `[photos-mcp] Timed out after ${bootstrapTimeoutMs()}ms waiting for another ` +
        `process's venv setup to finish. If no setup is actually running, remove the ` +
        `stale lock directory ${lockDir} and retry, or run scripts/setup.sh from a ` +
        `repo checkout (raise ${ENV_PREFIX}_SETUP_TIMEOUT to wait longer).`
    );
    return false;
  }

  console.error(
    `[photos-mcp] ${PACKAGE} not ready — setting up the Python venv (one-time; this can take a minute)…`
  );
  try {
    const out = await execFileAsync("bash", [setup], {
      timeout: bootstrapTimeoutMs(),
      // The lock is already held by this process — tell setup.sh not to
      // re-acquire (it would deadlock waiting on its own parent).
      env: { ...process.env, [`${ENV_PREFIX}_SETUP_LOCK_HELD`]: "1" },
    });
    const last = out.trim().split("\n").pop() ?? "";
    console.error(`[photos-mcp] Python venv ready. ${last}`.trim());
    cachedPython = null;
    readyConfirmed = false;
    return true;
  } catch (err: unknown) {
    const e = err as ExecFailure;
    const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim();
    console.error(
      `[photos-mcp] Automatic venv setup failed: ${detail.split("\n").pop() ?? detail}`
    );
    return false;
  } finally {
    releaseSetupLock(lockDir);
  }
}

/**
 * Single-flight wrapper around bootstrapVenv: concurrent callers (a gated
 * sidecar call and an ungated checkDependencies probe can now overlap) await
 * the SAME bootstrap instead of racing a second pip install or — worse —
 * proceeding against a half-built venv because `bootstrapAttempted` was
 * already flipped by the other caller.
 */
function attemptBootstrap(): Promise<boolean> {
  if (bootstrapPromise === null) {
    bootstrapPromise = bootstrapVenv();
  }
  return bootstrapPromise;
}

/**
 * Ensure the Python deps are ready, auto-bootstrapping the venv if it's missing
 * or stale (and auto-setup isn't disabled). Cheap and idempotent: once the venv
 * is confirmed ready it short-circuits, and bootstrap is attempted at most once
 * per process (concurrent callers share the in-flight attempt).
 */
async function ensureReady(): Promise<void> {
  if (readyConfirmed) return;
  if (venvIsReady()) {
    readyConfirmed = true;
    return;
  }
  if (autoSetupDisabled()) return;
  // A finished (failed) bootstrap is not retried here; an in-flight one is
  // joined so a second caller can't proceed against a half-built venv.
  if (bootstrapAttempted && bootstrapPromise === null) return;
  if ((await attemptBootstrap()) && venvIsReady()) {
    readyConfirmed = true;
  }
}

function looksLikeMissingDep(message: string): boolean {
  return /not installed|No module named|ModuleNotFoundError/i.test(message);
}

function setupHint(): string {
  return (
    `Install it with: pip3 install osxphotos (requires Python >= 3.11; stock macOS ships 3.9 — ` +
    `brew install python@3.12), or run scripts/setup.sh from a repo checkout. ` +
    `Run the doctor tool to diagnose, or see ` +
    `${TROUBLESHOOTING_URL} ` +
    `(set ${ENV_PREFIX}_NO_AUTO_SETUP=0 to allow automatic setup).`
  );
}

async function execReader<T>(
  command: string,
  args: string[],
  timeoutMs: number
): Promise<PythonResult<T>> {
  const python = resolvePython();
  const scriptPath = getScriptPath();
  const fullArgs = [scriptPath, command, ...args];

  if (process.env.DEBUG || process.env.VERBOSE) {
    console.error(`[photos-mcp] ${python} ${fullArgs.join(" ")}`);
  }

  try {
    const stdout = await execFileAsync(python, fullArgs, {
      timeout: timeoutMs,
      maxBuffer: getMaxBuffer(),
    });

    const result = JSON.parse(stdout.trim());
    if (result.error) {
      return { error: result.error };
    }
    return { data: result as T };
  } catch (err: unknown) {
    const error = err as ExecFailure;
    const stdout = error.stdout?.toString().trim() ?? "";
    const stderr = error.stderr?.toString().trim() ?? "";

    // The sidecar reports every handled failure as {"error": ...} JSON on
    // STDOUT before exiting 1 (missing osxphotos, unreadable/locked library,
    // Full-Disk-Access denials, bad arguments). Prefer that structured message
    // — it's what augmentPermissionError / doctor / the bootstrap retry match
    // against — and only fall back to stderr/message noise when absent.
    if (stdout) {
      try {
        const parsed: unknown = JSON.parse(stdout);
        const structured =
          parsed && typeof (parsed as { error?: unknown }).error === "string"
            ? (parsed as { error: string }).error
            : null;
        if (structured) {
          if (structured.includes(`${PACKAGE} not installed`) || looksLikeMissingDep(structured)) {
            return { error: `${PACKAGE} not installed. ${setupHint()}` };
          }
          return { error: structured };
        }
      } catch {
        // stdout wasn't JSON — fall through to the stderr/message paths.
      }
    }

    if (stderr.includes(`${PACKAGE} not installed`) || looksLikeMissingDep(stderr)) {
      return { error: `${PACKAGE} not installed. ${setupHint()}` };
    }
    // Async execFile signals a timeout by killing the child (killSignal) and
    // setting error.killed — there is no ETIMEDOUT message like execFileSync
    // produced. A maxBuffer overrun ALSO kills the child, so exclude it by its
    // distinctive message; the legacy message checks stay for belt-and-braces.
    const bufferExceeded = /maxBuffer.*exceeded/i.test(error.message ?? "");
    if (
      (error.killed === true && !bufferExceeded) ||
      error.message?.includes("ETIMEDOUT") ||
      error.message?.includes("timed out")
    ) {
      return {
        error:
          `Operation timed out after ${timeoutMs}ms. Library may be very large. ` +
          `Raise ${ENV_PREFIX}_TIMEOUT (ms) if the library needs longer to load.`,
      };
    }
    // Surface the Python traceback when there is one — without it the user just
    // sees "Command failed: <python> <args>" with no clue what actually broke.
    if (stderr) {
      return { error: stderr };
    }
    return { error: error.message || "Unknown error executing Python script" };
  }
}

const DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024; // 100MB for large photo libraries

/** Max stdout bytes from the Python sidecar, overridable via env for huge libraries. */
function getMaxBuffer(): number {
  const raw = process.env[`${ENV_PREFIX}_MAX_BUFFER`];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_MAX_BUFFER_BYTES;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Default per-command sidecar timeout in ms, overridable via env. Every call
 * re-opens the Photos DB, and on very large libraries (100k+ photos) that load
 * alone can exceed the 60s default — the override is the escape hatch.
 * Commands that pass an explicit timeout (export's 30-minute iCloud window)
 * are unaffected.
 */
function getDefaultTimeout(): number {
  const raw = process.env[`${ENV_PREFIX}_TIMEOUT`];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Serial gate for the DB-touching sidecar invocations. Exactly one
 * photos_reader.py process runs at a time — preserving the one-at-a-time
 * semantics the old execFileSync layer enforced implicitly (concurrent-reader
 * safety against the Photos SQLite, bounded resource use) — while the promise
 * chain keeps the event loop free, so the server answers protocol traffic
 * (pings, health-check, doctor) during a long query or export.
 *
 * The light interpreter probes (getPythonInfo's `--version`, checkDependencies'
 * import check) deliberately do NOT go through the gate: they never open the
 * Photos DB and finish in well under a second, so doctor can always report
 * interpreter/deps status even while an export runs.
 */
const sidecarGate = createSerialGate(0);

/**
 * True while a sidecar invocation is running or queued. Health-check and
 * doctor use this to answer from fast pure-TS paths instead of queueing a
 * full library probe behind a long operation.
 */
export function sidecarBusy(): boolean {
  return sidecarGate.pending > 0;
}

export async function runPhotosReader<T = unknown>(
  command: string,
  args: string[],
  timeoutMs?: number
): Promise<PythonResult<T>> {
  return sidecarGate(async () => {
    await ensureReady();
    const timeout = timeoutMs ?? getDefaultTimeout();
    const result = await execReader<T>(command, args, timeout);

    // Belt-and-suspenders: if the deps still look missing and we haven't tried a
    // bootstrap yet, attempt it once and retry — covers a venv that exists but is
    // missing the package, which the marker check alone wouldn't catch.
    if (
      result.error &&
      looksLikeMissingDep(result.error) &&
      !bootstrapAttempted &&
      !autoSetupDisabled()
    ) {
      if (await attemptBootstrap()) {
        return execReader<T>(command, args, timeout);
      }
    }
    return result;
  });
}

export interface PythonInterpreterInfo {
  path: string;
  version: string;
}

/**
 * Report the Python interpreter the sidecar would use right now — the same
 * resolution order as every sidecar call (project venv first, then system
 * python3/python). Resolves null when no interpreter resolves at all. Used by
 * the doctor tool so an old stock Python (macOS ships 3.9; osxphotos needs
 * >= 3.11) is visible at a glance. Mirrors apple-numbers-mcp's getPythonInfo.
 * Ungated: a `--version` probe never touches the Photos DB.
 */
export async function getPythonInfo(): Promise<PythonInterpreterInfo | null> {
  try {
    const python = resolvePython();
    const version = (await execFileAsync(python, ["--version"])).trim();
    return { path: python, version };
  } catch {
    return null;
  }
}

/**
 * Probe that osxphotos is importable by the resolved interpreter. Ungated (no
 * Photos DB access; sub-second), so doctor/health-check can classify a missing
 * install even while a long sidecar operation holds the gate.
 */
export async function checkDependencies(): Promise<{ ok: boolean; message: string }> {
  await ensureReady();
  try {
    const python = resolvePython();
    const version = (
      await execFileAsync(python, ["-c", `import ${PACKAGE}; print(${PACKAGE}.__version__)`])
    ).trim();
    return { ok: true, message: `${PACKAGE} ${version} available` };
  } catch {
    return {
      ok: false,
      message: `${PACKAGE} not installed. ${setupHint()}`,
    };
  }
}
