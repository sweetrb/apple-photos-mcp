/**
 * Absolute documentation URLs shared by error messages and the doctor tool.
 *
 * Errors that tell a user "X is broken" must be actionable for someone who
 * installed from npm or a plugin marketplace and has never seen the repo — so
 * they end with an absolute docs URL plus a pointer at the `doctor` tool,
 * instead of referencing files relative to a checkout they don't have.
 * (House standard: mirrors src/utils/docsUrls.ts in apple-mail-mcp /
 * apple-notes-mcp.)
 *
 * @module utils/docsUrls
 */

/** Repository home page. */
export const REPO_URL = "https://github.com/sweetrb/apple-photos-mcp";

/** README Requirements section (Python >= 3.11, macOS, Photos library). */
export const REQUIREMENTS_URL = `${REPO_URL}#requirements`;

/** README Troubleshooting section (setup failures, permissions, timeouts). */
export const TROUBLESHOOTING_URL = `${REPO_URL}#troubleshooting`;

/** Step-by-step Full Disk Access walkthrough with screenshots. */
export const FDA_GUIDE_URL = `${REPO_URL}/blob/main/docs/FULL-DISK-ACCESS.md`;

/** README section documenting the opt-in write tools and their gate. */
export const WRITE_TOOLS_URL = `${REPO_URL}#write-tools-opt-in`;

/**
 * Shared Full-Disk-Access remediation prose. Used verbatim by both the
 * per-tool permission-error augmentation (photosManager) and the doctor's
 * full_disk_access check, so the two can never drift apart and tell users
 * different things.
 */
export const FDA_REMEDIATION =
  "Grant Full Disk Access to the HOST app that launches this MCP server " +
  "(Claude Desktop / Terminal / iTerm / VS Code — not node) in " +
  "System Settings > Privacy & Security > Full Disk Access, then fully quit " +
  "and relaunch that app. Run the `doctor` tool for a full diagnosis, or see " +
  `${FDA_GUIDE_URL}.`;
