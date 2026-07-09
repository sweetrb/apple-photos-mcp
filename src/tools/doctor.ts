/**
 * Setup "doctor": one diagnostic covering the things that actually break an
 * apple-photos-mcp setup — the resolved Python interpreter (path + version, so
 * an old stock Python is visible at a glance), osxphotos installation, Photos
 * library reachability, and Full Disk Access (required for the host process to
 * read the library) — each reported as ok / warn / fail with an actionable
 * message.
 *
 * @module tools/doctor
 */
import type { PhotosManager } from "../services/photosManager.js";
import { checkDependencies, getPythonInfo } from "../utils/python.js";
import { FDA_REMEDIATION, TROUBLESHOOTING_URL } from "../utils/docsUrls.js";

export type CheckStatus = "ok" | "warn" | "fail";
export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}
export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
}

/** Heuristic: does this error look like a permission / Full Disk Access failure? */
function looksLikePermissionError(message: string): boolean {
  return /not permitted|permission|full disk|denied|unable to open/i.test(message);
}

/**
 * Run all diagnostic checks. This function NEVER throws — every probe is wrapped
 * in try/catch and converted to a fail/warn check.
 */
export function runDoctor(manager: PhotosManager): DoctorReport {
  const checks: DoctorCheck[] = [];

  // 1. Python interpreter — the same resolution the sidecar uses (project venv
  //    first, then system python3). Reported with its version so the most
  //    common first-run failure — stock macOS Python 3.9 when osxphotos needs
  //    >= 3.11 — is diagnosed instead of surfacing as "osxphotos not installed".
  //    Mirrors apple-numbers-mcp's python_interpreter check.
  try {
    const info = getPythonInfo();
    if (info) {
      const m = /Python (\d+)\.(\d+)/.exec(info.version);
      const tooOld = m !== null && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 11));
      checks.push({
        name: "python_interpreter",
        status: tooOld ? "warn" : "ok",
        detail: tooOld
          ? `${info.version} at ${info.path} — osxphotos requires Python >= 3.11 ` +
            `(stock macOS ships 3.9). Install a newer Python (brew install python@3.12) ` +
            `and retry — the venv rebuilds automatically. ` +
            `See ${TROUBLESHOOTING_URL}`
          : `${info.version} (${info.path})`,
      });
    } else {
      checks.push({
        name: "python_interpreter",
        status: "fail",
        detail:
          "Python 3 not found on PATH. Install Python >= 3.11 (e.g. brew install python@3.12). " +
          `See ${TROUBLESHOOTING_URL}`,
      });
    }
  } catch (e) {
    checks.push({
      name: "python_interpreter",
      status: "warn",
      detail: `could not resolve the Python interpreter: ${String(e)}`,
    });
  }

  // 2. osxphotos installation.
  try {
    const dep = checkDependencies();
    checks.push({
      name: "osxphotos",
      status: dep.ok ? "ok" : "fail",
      detail: dep.message,
    });
  } catch (e) {
    checks.push({
      name: "osxphotos",
      status: "fail",
      detail: `could not verify osxphotos: ${String(e)}. See ${TROUBLESHOOTING_URL}`,
    });
  }

  // 3. Photos library reachability. We remember whether it was a permission
  //    error so the full_disk_access check can be derived from it.
  let libraryOk = false;
  let libraryPermissionError = false;
  try {
    const info = manager.getLibraryInfo();
    libraryOk = true;
    checks.push({
      name: "photos_library",
      status: "ok",
      detail: `${info.photoCount} photos at ${info.libraryPath}`,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    libraryPermissionError = looksLikePermissionError(message);
    checks.push({
      name: "photos_library",
      status: "fail",
      detail: libraryPermissionError ? `${message}. ${FDA_REMEDIATION}` : message,
    });
  }

  // 4. Full Disk Access — derived from the photos_library check.
  if (libraryOk) {
    checks.push({
      name: "full_disk_access",
      status: "ok",
      detail: "Photos library readable",
    });
  } else if (libraryPermissionError) {
    checks.push({
      name: "full_disk_access",
      status: "fail",
      detail: `Full Disk Access appears to be missing. ${FDA_REMEDIATION}`,
    });
  } else {
    checks.push({
      name: "full_disk_access",
      status: "warn",
      detail:
        "could not verify (library did not open, but the error did not look permission-related)",
    });
  }

  const healthy = !checks.some((c) => c.status === "fail");
  return { healthy, checks };
}

/** Render a DoctorReport as readable text. */
export function formatDoctorReport(r: DoctorReport): string {
  const icon = (s: CheckStatus): string => (s === "ok" ? "✅" : s === "warn" ? "⚠️ " : "❌");
  const lines = [`🩺 apple-photos-mcp doctor — ${r.healthy ? "healthy" : "ISSUES FOUND"}`, ""];
  for (const c of r.checks) lines.push(`${icon(c.status)} ${c.name}: ${c.detail}`);
  return lines.join("\n");
}
