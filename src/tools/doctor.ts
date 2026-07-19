/**
 * Setup "doctor": one diagnostic covering the things that actually break an
 * apple-photos-mcp setup — the resolved Python interpreter (path + version, so
 * an old stock Python is visible at a glance), osxphotos installation, the
 * sidecar execution mode (persistent serve process vs one-shot fallback, with
 * the last respawn), the write-tools gate (read-only by default; reports how
 * to opt in, and whether the photoscript backend looks usable when enabled),
 * Photos library reachability, and Full Disk Access (required for the host
 * process to read the library) — each reported as ok / warn / fail with an
 * actionable message.
 *
 * @module tools/doctor
 */
import { existsSync } from "node:fs";
import type { PhotosManager } from "../services/photosManager.js";
import {
  checkDependencies,
  checkPhotoscript,
  getPythonInfo,
  getSidecarInfo,
  sidecarBusy,
} from "../utils/python.js";
import { FDA_REMEDIATION, TROUBLESHOOTING_URL, WRITE_TOOLS_URL } from "../utils/docsUrls.js";
import { looksLikePermissionError } from "../utils/permissionErrors.js";
import { writesEnabled, WRITES_ENV } from "../utils/writeGate.js";

/** Where macOS installs Photos.app (the write tools drive it via AppleScript). */
const PHOTOS_APP_PATH = "/System/Applications/Photos.app";

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

/**
 * Run all diagnostic checks. This function NEVER throws — every probe is wrapped
 * in try/catch and converted to a fail/warn check.
 *
 * Gate interaction: checks 1–4 are light probes (python --version, `import
 * osxphotos`/`import photoscript`, pure-TS state) that never open the Photos
 * DB, so they always run — even while a long sidecar operation (query/export)
 * holds the serial gate. Check 5 (and the Full-Disk-Access check derived from
 * it) needs a real DB-touching sidecar call; when the gate is busy it is
 * SKIPPED with a warn instead of queueing doctor behind an operation that can
 * run for minutes.
 */
export async function runDoctor(manager: PhotosManager): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Python interpreter — the same resolution the sidecar uses (project venv
  //    first, then system python3). Reported with its version so the most
  //    common first-run failure — stock macOS Python 3.9 when osxphotos needs
  //    >= 3.11 — is diagnosed instead of surfacing as "osxphotos not installed".
  //    Mirrors apple-numbers-mcp's python_interpreter check.
  try {
    const info = await getPythonInfo();
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
    const dep = await checkDependencies();
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

  // 3. Sidecar execution mode — persistent (a long-lived serve process that
  //    keeps the parsed PhotosDB resident) vs one-shot (spawn per call).
  //    Pure-TS state, never touches the gate. One-shot via env override is a
  //    deliberate choice (ok); one-shot because the serve handshake failed is
  //    worth a warn — every call is paying the full library re-parse.
  try {
    const sidecar = getSidecarInfo();
    if (sidecar.mode === "persistent") {
      const liveness = sidecar.running
        ? `serving (pid ${sidecar.pid ?? "?"})`
        : sidecar.spawnCount > 0
          ? "idle (respawns on next call)"
          : "not yet spawned (starts on first tool call)";
      const spawns =
        sidecar.spawnCount > 0
          ? `; spawned ${sidecar.spawnCount}x, last at ${sidecar.lastSpawnAt ?? "?"}`
          : "";
      checks.push({
        name: "sidecar_mode",
        status: "ok",
        detail: `persistent — ${liveness}${spawns}`,
      });
    } else {
      const deliberate = sidecar.reason?.includes("PERSISTENT_SIDECAR") === true;
      checks.push({
        name: "sidecar_mode",
        status: deliberate ? "ok" : "warn",
        detail:
          `one-shot (${sidecar.reason ?? "unknown reason"})` +
          (deliberate ? "" : " — every call re-parses the library; see the server logs"),
      });
    }
  } catch (e) {
    checks.push({
      name: "sidecar_mode",
      status: "warn",
      detail: `could not determine the sidecar mode: ${String(e)}`,
    });
  }

  // 4. Write-tools gate. Disabled is the healthy default (read-only server) —
  //    reported ok with the opt-in recipe. When ENABLED, verify the parts that
  //    can be checked without side effects: photoscript importable and
  //    Photos.app present. macOS Automation permission is deliberately NOT
  //    probed — any AppleScript sent to Photos would launch it and/or trigger
  //    the TCC prompt, so doctor only explains that the first write prompts.
  try {
    if (!writesEnabled()) {
      checks.push({
        name: "writes",
        status: "ok",
        detail:
          `disabled — server is read-only (the default). To enable the write tools ` +
          `(create-album, add-to-album, remove-from-album, set-photo-metadata, ` +
          `set-keywords, set-photo-date, import-photos), set ${WRITES_ENV}=1 in the ` +
          `server env or config.json and restart. See ${WRITE_TOOLS_URL}`,
      });
    } else {
      const ps = await checkPhotoscript();
      const photosAppPresent = existsSync(PHOTOS_APP_PATH);
      checks.push({
        name: "writes",
        status: !ps.ok ? "fail" : photosAppPresent ? "ok" : "warn",
        detail:
          `ENABLED — the write tools can modify this Photos library (album membership, ` +
          `titles, descriptions, keywords, favorites, dates, imports; never deleting ` +
          `photos). ` +
          `${ps.message}; Photos.app ${photosAppPresent ? "present" : `NOT found at ${PHOTOS_APP_PATH}`}. ` +
          `Writes drive Photos.app via AppleScript and need macOS Automation permission ` +
          `for the host app — macOS asks via a one-time prompt on the first write ` +
          `(not verifiable here without triggering that prompt).`,
      });
    }
  } catch (e) {
    checks.push({
      name: "writes",
      status: "warn",
      detail: `could not determine the write-tools state: ${String(e)}`,
    });
  }

  // 5. Photos library reachability. We remember whether it was a permission
  //    error so the full_disk_access check can be derived from it. Skipped
  //    (warn) while another sidecar operation holds the gate — doctor must
  //    respond promptly, not queue behind a minutes-long query/export.
  let libraryOk = false;
  let libraryPermissionError = false;
  if (sidecarBusy()) {
    checks.push({
      name: "photos_library",
      status: "warn",
      detail:
        "skipped — another sidecar operation (a long query or export) is in flight; " +
        "re-run doctor when it completes",
    });
    checks.push({
      name: "full_disk_access",
      status: "warn",
      detail: "could not verify — the library probe was skipped while a sidecar operation runs",
    });
    const healthy = !checks.some((c) => c.status === "fail");
    return { healthy, checks };
  }
  try {
    const info = await manager.getLibraryInfo();
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

  // 6. Full Disk Access — derived from the photos_library check.
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
