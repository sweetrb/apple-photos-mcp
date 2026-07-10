/**
 * The write-tools gate.
 *
 * apple-photos-mcp is read-only by default — the write tools (create-album,
 * add-to-album, remove-from-album, set-photo-metadata, set-keywords from
 * 2.0.0; set-photo-date and import-photos from 2.1.0) only work when
 * APPLE_PHOTOS_MCP_ENABLE_WRITES is set to a truthy value ("1"/"true"/anything
 * but ""/"0"/"false"), via the environment or the config.json file the server
 * loads at startup (services/fileConfig).
 *
 * The write tools are ALWAYS REGISTERED and return this gate's error when
 * disabled, rather than being hidden from the tool list. Rationale: MCP
 * clients cache the tool list at server startup, so conditional registration
 * buys no security (flipping the env needs a restart either way) — but it
 * costs discoverability: an agent that can't see the tool can only tell the
 * user "that's impossible", while an agent that gets this error can explain
 * exactly how to opt in. The gate is enforced per call in PhotosManager (and
 * again inside the Python sidecar, for direct CLI invocations).
 *
 * @module utils/writeGate
 */
import { WRITE_TOOLS_URL } from "./docsUrls.js";

export const WRITES_ENV = "APPLE_PHOTOS_MCP_ENABLE_WRITES";

/** True when the opt-in write gate is open. */
export function writesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[WRITES_ENV];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/** The exact user-facing gated-off message (also asserted by tests). */
export function writesDisabledMessage(): string {
  return (
    `Write tools are disabled — apple-photos-mcp is read-only by default. ` +
    `To enable them, set ${WRITES_ENV}=1 in the server's environment, or add ` +
    `{"${WRITES_ENV}": "1"} to ` +
    `~/Library/Application Support/apple-photos-mcp/config.json, then restart ` +
    `the MCP server. Run the doctor tool to see the gate state, or see ` +
    `${WRITE_TOOLS_URL}`
  );
}

/** Throw the gated-off error unless writes are enabled. */
export function assertWritesEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!writesEnabled(env)) {
    throw new Error(writesDisabledMessage());
  }
}
