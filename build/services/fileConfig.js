/**
 * File-based configuration loader.
 *
 * Some host apps (e.g. Claude Desktop) spawn the MCP server with a scrubbed
 * environment and ignore the `env` block in their server config, so there's no
 * way to pass `APPLE_PHOTOS_MCP_*` settings in. This loads them from a JSON file
 * the host doesn't manage, merging into `process.env` WITHOUT overriding
 * anything already set (so an explicit env still wins).
 *
 * Only non-secret config belongs here.
 *
 * Path: `APPLE_PHOTOS_MCP_CONFIG_FILE`, else
 * `~/Library/Application Support/apple-photos-mcp/config.json`.
 *
 * @module services/fileConfig
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
export function fileConfigPath(env = process.env) {
    const override = env.APPLE_PHOTOS_MCP_CONFIG_FILE;
    if (override && override.trim())
        return override.trim();
    return join(homedir(), "Library", "Application Support", "apple-photos-mcp", "config.json");
}
/**
 * Merge a JSON config file's string values into `env` for keys not already set.
 * Returns the keys applied. Tolerates a missing/corrupt file.
 */
export function loadFileConfig(env = process.env, path = fileConfigPath(env)) {
    const applied = [];
    try {
        if (!existsSync(path))
            return applied;
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object")
            return applied;
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v !== "string")
                continue;
            if (env[k] === undefined || env[k] === "") {
                env[k] = v;
                applied.push(k);
            }
        }
    }
    catch (e) {
        console.error(`Failed to load apple-photos-mcp config file ${path}: ${String(e)}`);
    }
    return applied;
}
