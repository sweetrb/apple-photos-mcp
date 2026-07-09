/**
 * Setup "doctor": one diagnostic covering the things that actually break an
 * apple-photos-mcp setup — osxphotos installation, Photos library reachability,
 * and Full Disk Access (required for the host process to read the library) —
 * each reported as ok / warn / fail with an actionable message.
 *
 * @module tools/doctor
 */
import type { PhotosManager } from "../services/photosManager.js";
import { checkDependencies } from "../utils/python.js";

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

/** Remediation message pointing the user at Full Disk Access. */
const FDA_REMEDIATION =
  "Grant Full Disk Access to the HOST app that launches this MCP server " +
  "(Claude Desktop / Terminal / iTerm / VS Code — not node) in " +
  "System Settings > Privacy & Security > Full Disk Access, then fully quit " +
  "and relaunch that app. Guide: " +
  "https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/FULL-DISK-ACCESS.md";

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

  // 1. osxphotos installation.
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
      detail:
        `could not verify osxphotos: ${String(e)}. ` +
        `See https://github.com/sweetrb/apple-photos-mcp#troubleshooting`,
    });
  }

  // 2. Photos library reachability. We remember whether it was a permission
  //    error so check #3 (full_disk_access) can be derived from it.
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

  // 3. Full Disk Access — derived from check #2.
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
