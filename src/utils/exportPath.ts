/**
 * Export-destination allowlist.
 *
 * `export` is the only side-effecting tool — it writes files (and creates
 * directories) wherever `dest` points. Restrict that to a small set of roots
 * so a confused or prompted-injected agent can't scribble into system
 * locations, app bundles, or dotfile directories outside the user's own space.
 * Mirrors apple-mail-mcp's ALLOWED_SAVE_ROOTS / isPathWithinAllowedRoots.
 *
 * @module utils/exportPath
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

/** Roots under which `export` is permitted to write. */
export const ALLOWED_EXPORT_ROOTS = [homedir(), "/tmp", "/private/tmp", "/Volumes"];

/** Human-readable rendering of the allowed roots for error messages. */
export const ALLOWED_EXPORT_ROOTS_TEXT = "your home directory, /tmp, /private/tmp, or /Volumes";

/**
 * True if `resolvedPath` is one of the allowed roots or strictly inside one.
 *
 * Uses a path-segment boundary check rather than a bare `startsWith`, which
 * would let a sibling whose name merely shares the prefix slip through —
 * `/Volumes-evil` startsWith `/Volumes`, `/Users/robother` startsWith
 * `/Users/rob` (mail audit finding #12). `resolvedPath` must already be
 * absolute and normalized (callers pass resolveExportDest output).
 */
export function isPathWithinAllowedRoots(resolvedPath: string): boolean {
  return ALLOWED_EXPORT_ROOTS.some((root) => {
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    return resolvedPath === base || resolvedPath.startsWith(base + sep);
  });
}

/** Expand a leading `~` / `~/` to the user's home directory (like the sidecar's expanduser). */
function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith(`~${sep}`) || p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve symlinks in `p` even when `p` itself doesn't exist yet (export
 * creates the destination): realpath the deepest EXISTING ancestor, then
 * re-append the not-yet-created remainder. This is what defeats a
 * symlink-under-an-allowed-root pointing outside it (e.g. /tmp/link -> /etc),
 * and also canonicalizes macOS's /tmp -> /private/tmp.
 */
function realpathDeepestExisting(p: string): string {
  let existing = p;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    tail.unshift(basename(existing));
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    real = existing;
  }
  return tail.length ? join(real, ...tail) : real;
}

/**
 * Canonicalize an export destination (expand ~, resolve `..` and symlinks)
 * and enforce the allowlist. Returns the canonical absolute path to hand to
 * the sidecar — validating and using the SAME path closes the gap where the
 * validated string and the written-to directory could differ.
 *
 * @throws Error naming the allowed roots when the destination falls outside them.
 */
export function resolveExportDest(dest: string): string {
  const resolved = realpathDeepestExisting(resolve(expandTilde(dest)));
  if (!isPathWithinAllowedRoots(resolved)) {
    throw new Error(
      `Export destination "${dest}" resolves to "${resolved}", which is outside the ` +
        `allowed export roots (${ALLOWED_EXPORT_ROOTS_TEXT}). Choose a destination ` +
        `under one of those roots.`
    );
  }
  return resolved;
}
