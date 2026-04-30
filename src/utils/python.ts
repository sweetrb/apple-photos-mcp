import { execSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getProjectRoot(): string {
  // build/utils/ or src/utils/ -> project root
  return join(__dirname, "..", "..");
}

function getScriptPath(): string {
  return join(getProjectRoot(), "src", "utils", "photos_reader.py");
}

/**
 * Find the best Python executable. Preference order:
 *   1. Project-local venv (./venv/bin/python3)
 *   2. System python3
 *   3. System python
 */
function findPython(): string {
  const projectRoot = getProjectRoot();
  const venvPython = join(projectRoot, "venv", "bin", "python3");

  if (existsSync(venvPython)) {
    return venvPython;
  }

  for (const cmd of ["python3", "python"]) {
    try {
      execSync(`${cmd} --version`, { stdio: "pipe" });
      return cmd;
    } catch {
      continue;
    }
  }
  throw new Error(
    'Python 3 not found. Run "npm run setup" to create a venv, or ensure python3 is on PATH.'
  );
}

export interface PythonResult<T = unknown> {
  data?: T;
  error?: string;
}

let cachedPython: string | null = null;

export function _resetPythonCache(): void {
  cachedPython = null;
}

export function runPhotosReader<T = unknown>(
  command: string,
  args: string[],
  timeoutMs = 60000
): PythonResult<T> {
  const python = cachedPython ?? (cachedPython = findPython());
  const scriptPath = getScriptPath();
  const fullArgs = [scriptPath, command, ...args];

  if (process.env.DEBUG || process.env.VERBOSE) {
    console.error(`[photos-mcp] ${python} ${fullArgs.join(" ")}`);
  }

  try {
    const stdout = execFileSync(python, fullArgs, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 100 * 1024 * 1024, // 100MB for large photo libraries
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

    if (stderr.includes("osxphotos not installed")) {
      return { error: "osxphotos not installed. Run: npm run setup" };
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

export function checkDependencies(): { ok: boolean; message: string } {
  try {
    const python = cachedPython ?? (cachedPython = findPython());
    const version = execSync(`${python} -c "import osxphotos; print(osxphotos.__version__)"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return { ok: true, message: `osxphotos ${version} available` };
  } catch {
    return {
      ok: false,
      message: "osxphotos not installed. Run: npm run setup",
    };
  }
}
