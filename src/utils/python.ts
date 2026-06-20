import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PACKAGE = "osxphotos";
const ENV_PREFIX = "APPLE_PHOTOS_MCP";

function getProjectRoot(): string {
  // build/utils/ or src/utils/ -> project root
  return join(__dirname, "..", "..");
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

export interface PythonResult<T = unknown> {
  data?: T;
  error?: string;
}

let cachedPython: string | null = null;
let readyConfirmed = false;
let bootstrapAttempted = false;

export function _resetPythonCache(): void {
  cachedPython = null;
  readyConfirmed = false;
  bootstrapAttempted = false;
}

function findSystemPython(): string {
  for (const cmd of ["python3", "python"]) {
    try {
      execSync(`${cmd} --version`, { stdio: "pipe" });
      return cmd;
    } catch {
      continue;
    }
  }
  throw new Error(
    'Python 3 not found. Install Python 3 (https://www.python.org), or run "npm run setup".'
  );
}

/**
 * Resolve a Python interpreter. The project venv is cached once present (it's
 * stable); a system-Python fallback is deliberately NOT cached, so a venv
 * created later (e.g. by auto-bootstrap, or a manual `npm run setup`) is picked
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
 * Create or refresh the venv by running scripts/setup.sh. Returns true on
 * success. Progress is logged to STDERR only — stdout is the MCP protocol
 * channel and must never be written to.
 */
function bootstrapVenv(): boolean {
  bootstrapAttempted = true;
  const setup = setupScriptPath();
  if (!existsSync(setup)) return false;

  console.error(
    `[photos-mcp] ${PACKAGE} not ready — setting up the Python venv (one-time; this can take a minute)…`
  );
  try {
    const out = execFileSync("bash", [setup], {
      encoding: "utf-8",
      timeout: bootstrapTimeoutMs(),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const last = out.trim().split("\n").pop() ?? "";
    console.error(`[photos-mcp] Python venv ready. ${last}`.trim());
    cachedPython = null;
    readyConfirmed = false;
    return true;
  } catch (err: unknown) {
    const e = err as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const detail = (e.stderr?.toString() || e.stdout?.toString() || e.message || "").trim();
    console.error(
      `[photos-mcp] Automatic venv setup failed: ${detail.split("\n").pop() ?? detail}`
    );
    return false;
  }
}

/**
 * Ensure the Python deps are ready, auto-bootstrapping the venv if it's missing
 * or stale (and auto-setup isn't disabled). Cheap and idempotent: once the venv
 * is confirmed ready it short-circuits, and bootstrap is attempted at most once
 * per process.
 */
function ensureReady(): void {
  if (readyConfirmed) return;
  if (venvIsReady()) {
    readyConfirmed = true;
    return;
  }
  if (bootstrapAttempted || autoSetupDisabled()) return;
  if (bootstrapVenv() && venvIsReady()) {
    readyConfirmed = true;
  }
}

function looksLikeMissingDep(message: string): boolean {
  return /not installed|No module named|ModuleNotFoundError/i.test(message);
}

function setupHint(): string {
  return `Run: npm run setup (or set ${ENV_PREFIX}_NO_AUTO_SETUP=0 to allow automatic setup).`;
}

function execReader<T>(command: string, args: string[], timeoutMs: number): PythonResult<T> {
  const python = resolvePython();
  const scriptPath = getScriptPath();
  const fullArgs = [scriptPath, command, ...args];

  if (process.env.DEBUG || process.env.VERBOSE) {
    console.error(`[photos-mcp] ${python} ${fullArgs.join(" ")}`);
  }

  try {
    const stdout = execFileSync(python, fullArgs, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: getMaxBuffer(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const result = JSON.parse(stdout.trim());
    if (result.error) {
      return { error: result.error };
    }
    return { data: result as T };
  } catch (err: unknown) {
    const error = err as Error & { stderr?: string | Buffer; status?: number };
    const stderr = error.stderr?.toString().trim() ?? "";

    if (stderr.includes(`${PACKAGE} not installed`) || looksLikeMissingDep(stderr)) {
      return { error: `${PACKAGE} not installed. ${setupHint()}` };
    }
    if (error.message?.includes("ETIMEDOUT") || error.message?.includes("timed out")) {
      return {
        error: `Operation timed out after ${timeoutMs}ms. Library may be very large.`,
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

export function runPhotosReader<T = unknown>(
  command: string,
  args: string[],
  timeoutMs = 60000
): PythonResult<T> {
  ensureReady();
  const result = execReader<T>(command, args, timeoutMs);

  // Belt-and-suspenders: if the deps still look missing and we haven't tried a
  // bootstrap yet, attempt it once and retry — covers a venv that exists but is
  // missing the package, which the marker check alone wouldn't catch.
  if (
    result.error &&
    looksLikeMissingDep(result.error) &&
    !bootstrapAttempted &&
    !autoSetupDisabled()
  ) {
    if (bootstrapVenv()) {
      return execReader<T>(command, args, timeoutMs);
    }
  }
  return result;
}

export function checkDependencies(): { ok: boolean; message: string } {
  ensureReady();
  try {
    const python = resolvePython();
    const version = execSync(`${python} -c "import ${PACKAGE}; print(${PACKAGE}.__version__)"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, message: `${PACKAGE} ${version} available` };
  } catch {
    return {
      ok: false,
      message: `${PACKAGE} not installed. ${setupHint()}`,
    };
  }
}
