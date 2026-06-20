# Changelog

## [0.3.0] (2026-06-20)

Bulletproof install & updates — the Python sidecar now sets itself up.

### Added

- **Automatic Python venv bootstrap on first use.** If the `osxphotos` venv is missing or out of date, the first tool call now creates the venv and installs `osxphotos` automatically (one-time; the first call can take ~a minute, with progress logged to stderr), then proceeds. A fresh install via npm, `npx`, or the Claude Code marketplace now works with **no manual `npm run setup` step** — though running it ahead of time still works as a pre-warm.
- New env vars: `APPLE_PHOTOS_MCP_NO_AUTO_SETUP` (set truthy to disable the automatic bootstrap and require a manual `npm run setup`) and `APPLE_PHOTOS_MCP_SETUP_TIMEOUT` (ms cap on the bootstrap, default 5 min).

### Fixed

- **Self-healing interpreter resolution.** The Python interpreter is no longer pinned at startup: a venv created or repaired while the server is running is picked up on the next call, with **no restart required**. (Previously, if the venv didn't exist when the server started, the server cached the system Python and kept reporting the dependency as missing until restarted.)
- **Stale-venv detection.** `scripts/setup.sh` records the `requirements.txt` it installed against (a `venv/.deps-ok` marker); after an update changes requirements, the server detects the mismatch and rebuilds the venv automatically — so **updates are picked up without a manual reinstall**.
- When automatic setup can't run (no Python 3, no `pip`, or offline), tools now return a clear, actionable error pointing at `npm run setup`.

Maturity release bringing apple-photos-mcp to feature/stability parity with apple-mail-mcp and apple-notes-mcp.

### Added

- **`doctor` tool** — a richer diagnostic than `health-check`: checks the osxphotos install, Photos library readability, and Full Disk Access separately, each reported as ok / warn / fail with actionable advice (`structuredContent` carries the raw `{ healthy, checks[] }`). Reach for it when a tool returns a permission or "unable to open" error — it pinpoints which requirement is missing.
- **`structuredContent` on every read tool** — `health-check`, `library-info`, `query`, `get-photo`, `list-albums`, `list-folders`, `list-keywords`, `list-persons`, and `export` now return typed JSON alongside the human-readable text, so agents can consume results without parsing prose.
- **MCP resources & prompts** — resources `photos://library`, `photos://albums`, `photos://persons`, `photos://keywords`, and the templated `photos://photo/{uuid}`; prompts `find-photos`, `export-photos`, and `photo-summary`.
- **File-based config loader** — reads `~/Library/Application Support/apple-photos-mcp/config.json` (override via `APPLE_PHOTOS_MCP_CONFIG_FILE`), merging string values into the environment without overriding already-set vars, so settings survive a host that strips the MCP env block.
- **Integration test suite** — `test/integration.test.ts` (+ `vitest.integration.config.ts`, `npm run test:integration` / `test:all`) drives the real osxphotos → Photos library stack read-only; the live tests self-skip when no library is available, so it is safe on CI. A new `integration` CI job runs it on macOS.
- **Docs** — `docs/FULL-DISK-ACCESS.md` (why Full Disk Access is required and how to grant/verify it) and `docs/LIMITATIONS.md` (read-only scope, iCloud-export caveats, face/album behavior, library lag), plus a `CLAUDE.md` agent guide.

### Changed

- **Hardened the Python bridge** — the subprocess `maxBuffer` (100 MB default) is now overridable via `APPLE_PHOTOS_MCP_MAX_BUFFER` for very large libraries.
- **CI** now runs `format:check` and tests with coverage (per-directory thresholds), and a separate macOS `integration` job.
- **Plugin version sync** — `scripts/sync-plugin-version.mjs` keeps both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` in step with `package.json` on `npm version` (the marketplace manifest had drifted to 0.1.0).
- Test suite grown from 17 to 57 unit tests plus 9 integration tests.

### Fixed

- **Plugin install no longer blocked by husky** — `prepare` changed from `husky && npm run build` to `husky; npm run build`, so the build still runs when husky can't initialize (e.g. a marketplace git-clone install).
- **Decoupled plugin vs project-scope MCP entrypoint resolution.** The root `.mcp.json` uses `${CLAUDE_PROJECT_DIR:-.}/build/index.js` for the clone/contributor workflow, and `.claude-plugin/plugin.json` declares its own `mcpServers` using `${CLAUDE_PLUGIN_ROOT}/build/index.js` for marketplace plugin installs. Previously the bare relative path `build/index.js` failed in both contexts. Because `plugin.json` now declares `mcpServers`, the plugin no longer auto-loads the root `.mcp.json`, avoiding double-registration. Mirrors the fix in apple-mail-mcp.

## 0.1.3 (2026-05-01)

- **feat(export):** automatic iCloud download fallback. When an original isn't on disk, the export now retries via Photos.app/AppleScript (`use_photos_export=True`) — same behavior as opening the photo in Photos, which downloads it on demand. Previously these photos were always skipped with "original not downloaded from iCloud" even when the user had iCloud connectivity.
- Subprocess timeout for `export` raised from 5 minutes to 30 minutes to accommodate large iCloud download batches.
- Skip reason on the unrecoverable case now reads `"original not downloaded from iCloud (download attempt returned no files)"` so it's distinguishable from the no-attempt skip.

## 0.1.1 (2026-04-30)

- **fix(query):** parse `fromDate` / `toDate` as ISO 8601 datetimes — osxphotos requires real `datetime` objects, not strings, so date filters previously crashed with an opaque "Command failed" error.
- **fix(export):** when osxphotos returns no files because the original isn't downloaded from iCloud, surface that as a `skipped` entry with reason "original not downloaded from iCloud" instead of silently reporting `0 exported / 0 skipped`.
- **fix(python bridge):** when the Python sidecar crashes with a traceback, return the stderr output instead of the bare Node "Command failed: …" message — much easier to debug.
- Tests: covered date forwarding, missing-photo skip, and all five `runPhotosReader` error paths (8 → 16 tests).

## 0.1.0 (2026-04-30)

Initial release.

- TypeScript MCP server with a Python sidecar based on [osxphotos](https://github.com/RhetTbull/osxphotos).
- Tools: `health-check`, `library-info`, `query`, `get-photo`, `list-albums`, `list-folders`, `list-keywords`, `list-persons`, `export`.
- `query` filters: album, keyword, person, date range, favorite/hidden flags, photo/movie type, title/description substring, and limit.
- `export` supports originals, edited versions, raw, live-photo videos, and overwrite.
