/**
 * Shared detection for osxphotos errors that are really macOS Full Disk Access
 * (TCC) denials in disguise. Both the doctor tool and the per-tool error
 * augmentation use this, so the two can never disagree about whether a failure
 * is permission-related.
 *
 * @module utils/permissionErrors
 */

/**
 * Does this error look like a permission / Full Disk Access failure?
 *
 * Two families are recognized:
 *
 * 1. **Explicit denials** — "operation not permitted", "unable to open
 *    database file", etc. These name the permission directly.
 *
 * 2. **osxphotos copy failures** — `Error copying …/Photos.sqlite to
 *    /tmp/osxphotos_…/Photos.sqlite`. osxphotos copies the live Photos
 *    database to a temp dir before opening it; when the host process lacks FDA,
 *    macOS denies the *read* of the source and osxphotos surfaces it as a
 *    generic copy error with none of the words in family (1). Left
 *    unclassified, `doctor` reports "did not look permission-related", which
 *    actively sends users away from the real cause (FDA on the host process,
 *    including the nested-bundle attribution gotcha — see FULL-DISK-ACCESS.md).
 *    On a machine where the same copy succeeds standalone, this message inside
 *    the MCP child process is overwhelmingly an FDA denial, so we treat it as
 *    one.
 */
export function looksLikePermissionError(message: string): boolean {
  if (/not permitted|permission|full disk|denied|unable to open/i.test(message)) {
    return true;
  }
  // osxphotos "Error copying <library>/…/Photos.sqlite to <tmp>/…" — a failed
  // copy of the protected Photos database is an FDA denial in disguise.
  return /error copying\b.*photos\.sqlite/is.test(message);
}
