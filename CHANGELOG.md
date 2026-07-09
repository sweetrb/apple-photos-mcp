# Changelog

## [1.2.0] - 2026-07-09
### Fixed
- **Hidden photos are now actually excluded from `query` by default** (privacy fix). The docs promised "hidden photos are excluded by default" everywhere, but osxphotos only filters hidden photos when a flag is explicitly set — so a plain query (or an export driven by one) silently included photos the user had hidden in Photos.app. The sidecar now defaults to `not_hidden` unless `hidden: true` is passed; `hidden: true` still returns only hidden photos.
- **Sidecar errors are no longer swallowed on non-zero exit.** The Python sidecar reports every handled failure as `{"error": ...}` JSON on stdout before exiting 1, but the TS layer only read stderr in the failure path — so users saw a bare `Command failed: <python> <args>` instead of the real message. The structured error now surfaces, restoring the Full-Disk-Access remediation on permission failures, `doctor`'s fail-vs-warn FDA classification, and the missing-dependency auto-bootstrap retry.
- **`export` accounts for every requested UUID.** Unknown UUIDs (and photos in Recently Deleted) were silently dropped — `exported` + `skipped` could sum to less than the request with no trace. Each unmatched UUID is now reported in `skipped` with reason "UUID not found (deleted or in trash)"; an all-unmatched request returns a normal result with everything skipped instead of a bare error.
- **`export` without `overwrite` now skips existing files instead of writing `IMG_1234 (1).jpg` duplicates.** osxphotos' default filename-increment behavior contradicted the documented "existing files are skipped" contract — re-running an export duplicated every prior file. Collisions are now skipped with a per-UUID "already exists at destination (pass overwrite=true to replace)" reason; `overwrite: true` still replaces in place.
- **A bare `toDate` no longer silently drops the whole last day.** osxphotos treats `to_date` as an exclusive bound, so `toDate: "2025-06-30"` (midnight) excluded every photo taken on June 30. A bare date now rolls forward one day, making the named day inclusive; a full datetime (e.g. `"2025-06-30T18:00:00"`) remains a precise exclusive bound.
- **`query` reports the true total: `count` vs new `returned` field.** `count` was the post-limit page size, so truncation was undetectable ("Found 50" whether 50 or 50,000 matched). `count` is now the total match count and `returned` is the page size; a default limit of 500 applies when `limit` is omitted, so a filterless query can no longer flood the response with the entire library.
- **Filter values starting with `-` no longer crash the query.** A keyword/album/person/title value like `"-archive"` hit an argparse "expected one argument" usage error; all value-carrying flags are now passed in the joined `--flag=value` form.
- **iCloud Shared Albums now appear in `list-albums`** (flagged `isShared: true`). They live in a separate osxphotos list that was never read, and the previous `isShared` came from a nonexistent attribute — so shared albums were invisible and the flag was always `false`.
- **Raw-photo export skips no longer block the iCloud fallback.** The "no raw sidecar exists" skip fired for ANY photo whose export returned nothing while `raw: true` was set — misreporting iCloud-only originals and suppressing the Photos.app download fallback that would have exported them. The skip now applies only when the photo actually has a raw component whose file is missing; the dead "no edited version exists" branch (osxphotos raises for that case) was removed.
- **The sidecar's own "osxphotos not installed" fallback message is now actionable** for no-clone installs: `pip3 install osxphotos` guidance (Python >= 3.11 note), the `doctor` tool, and an absolute Troubleshooting URL — replacing `Run: pnpm run setup`, which is meaningless outside a repo checkout.

### Added
- **`APPLE_PHOTOS_MCP_TIMEOUT`** environment variable (ms, default `60000`) — overrides the previously hardcoded 60-second sidecar timeout that made every read tool permanently fail on very large libraries. `export` keeps its own 30-minute window. Documented in the README Configuration table.

## [1.1.5] - 2026-07-09
### Fixed
- **Error messages are now actionable for no-clone (npx / marketplace) installs.** The "osxphotos not installed" hint previously said `Run: npm run setup` — a command that only exists inside a repo checkout and is meaningless to a user running the published package via `npx` or a plugin install. It now gives real remediation: `pip3 install osxphotos` (noting the Python ≥ 3.11 requirement — stock macOS ships 3.9; `brew install python@3.12`), `scripts/setup.sh` for repo checkouts, the `doctor` tool, and an absolute link to the README's Troubleshooting section. The "Python 3 not found" error got the same treatment, and `doctor` no longer appends a doubled `Run: npm run setup` suffix on top of the hint.
- **Full-Disk-Access remediation now names the HOST app and uses an absolute URL.** Both the `doctor` FDA check and the per-tool permission-error guidance now say to grant FDA to the host app that launches the server (Claude Desktop / Terminal / iTerm / VS Code — not `node`), to fully quit and relaunch it, and link to `https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/FULL-DISK-ACCESS.md` instead of the repo-relative `docs/FULL-DISK-ACCESS.md` (which a no-clone user has no copy of).

### Docs
- **README install command fixed to the npm registry:** `npm install -g apple-photos-mcp` (was `npm install -g github:sweetrb/apple-photos-mcp`, which builds from source at install time and requires pnpm — that form is now mentioned only under From Source, labeled as such).
- **Deterministic Claude Code one-liner added to Quick Start:** `claude mcp add apple-photos -s user -- npx -y apple-photos-mcp`.
- **Plugin-marketplace Quick Start now sets expectations:** the plugin is a git clone under `~/.claude/plugins/marketplaces/apple-photos-mcp/`; the first tool call auto-bootstraps the Python venv *inside that clone* (~a minute; requires Python ≥ 3.11 on PATH); Full Disk Access must be granted to the host app.
- **Troubleshooting "osxphotos not installed" rewritten:** the first bullet is now the actual most-common cause — `python3` older than 3.11 (stock macOS = 3.9) — with `brew install python@3.12` + retry (the venv rebuilds automatically); the heading now matches the emitted error string.
- **`docs/` now ships in the npm tarball** (added to package.json `files`) and all README cross-file relative links (docs guides, plugin configs, LICENSE, screenshot) were converted to absolute GitHub URLs, so they resolve on npmjs.com and in a tarball install, not just on GitHub.
- **skills/apple-photos SKILL.md updated:** first-run guidance now says setup is automatic and to run `doctor` FIRST when osxphotos is reported missing (diagnosing why auto-setup failed, usually old Python); notes the venv lives in the plugin clone, not "the project"; the error table gains a Full-Disk-Access row with host-app + full-restart remediation and the absolute guide URL.

## [1.1.4] - 2026-07-06
### Fixed
- **A bare `git clone` now runs the server with only Node present** ([#15]). Tracking `build/` (the previous release) put the compiled entrypoint in git, but `build/index.js` still `import`ed its dependencies (`@modelcontextprotocol/sdk`, `zod`) from `node_modules/`, which a plain clone / marketplace install lacks — so the server died on `ERR_MODULE_NOT_FOUND` before it could complete the MCP handshake. The build now **esbuild-bundles `src/index.ts` into a single self-contained `build/index.js`** (`tsc --noEmit` still type-checks; esbuild does the bundling), so the marketplace/git clone starts on Node alone with no install step. This mirrors the fix @oliverames landed for apple-notes-mcp (#69) and apple-mail-mcp (#79). The Python sidecar path logic was hardened alongside: `getProjectRoot()` now walks up to the directory that owns `package.json` + `src/utils/photos_reader.py` instead of assuming a fixed `build/utils/ → ../..` depth, so the collapsed single-file bundle still resolves `photos_reader.py`, the venv, `requirements.txt`, and `scripts/setup.sh` correctly.

### Changed
- **`.gitignore` now tracks only the bundled entrypoint** (`build/*` then `!build/index.js`) — per-module `tsc` output (e.g. from `pnpm run dev`) stays ignored. Added `esbuild` as a devDependency; dropped the now-unused `tsc-alias` devDependency and the `types` package.json field.
- **`build/` is tracked in git** (from the previous release, #17/#18), matching apple-mail-mcp and apple-numbers-mcp. The `.claude-plugin/plugin.json` launches `node ${CLAUDE_PLUGIN_ROOT}/build/index.js` directly, so a marketplace/git-installed plugin needs the compiled output committed. `tsconfig.json` excludes `**/*.test.ts` from compilation (as mail/numbers do) so `build/` contains only shippable runtime code, not compiled tests.

[#15]: https://github.com/sweetrb/apple-photos-mcp/issues/15

## [1.1.3] - 2026-06-30
### Changed
- **Toolchain migrated to pnpm** (dev + CI + publish). CI now runs on the Node `[22, 24]` matrix with `pnpm/action-setup` + `pnpm install --frozen-lockfile`; `publish.yml` releases via `pnpm publish --provenance --no-git-checks` through OIDC trusted publishing (no `NPM_TOKEN`). Runtime `engines.node` stays `>=20` — pnpm is dev/CI-only.
- **`query` short-circuits the per-photo projection at `limit`.** The Python sidecar already sliced the result list before projecting, but the path is now documented as the intended fast path so large libraries don't pay the full `_photo_summary` projection cost for a small page. Behavior is unchanged when no limit is set.

### Added
- **Input bounds on tool schemas.** `query` and `export` now cap string lengths (UUIDs, album/keyword/person names, title/description, library/dest paths) and array sizes, and the `limit` fields on `query`/`list-keywords`/`list-persons` gain a sane upper bound — rejecting pathological inputs at the schema boundary.
- **Deterministic shutdown handler.** The server now exits cleanly on `SIGTERM`/`SIGINT` and on stdin EOF/close (client disconnect), complementing the existing `uncaughtException`/`unhandledRejection` net so it no longer lingers as an orphan after the MCP host goes away.

### Docs
- **README developer/build commands switched from `npm` to `pnpm`** in the Quick Start, From-Source, Development, and Troubleshooting sections (end-user `npm install -g` global-install hints and npm badges left as-is). The sidecar's "osxphotos not installed" hint now reads `pnpm run setup` to match.

## [1.1.2] - 2026-06-25
### Fixed
- Added a process-level uncaughtException/unhandledRejection safety net so a stray error or a broken stdout pipe (EPIPE) on client disconnect can no longer crash the long-lived server; EPIPE now exits cleanly.


## [1.1.1] - 2026-06-24
### Security
- **The `doctor` dependency probe no longer builds a shell command.** `checkDependencies` previously interpolated the resolved interpreter path into a shell string passed to `execSync`; it now uses `execFileSync(python, ["-c", …])` (argv array, no shell), matching the reader path. This eliminates a CodeQL `js/shell-command-injection-from-environment` finding (defense-in-depth — the path is install-derived, not user-supplied). The system-Python probe keeps a `execSync` over hardcoded `python3`/`python` literals, now documented as non-injectable.

## [1.1.0] - 2026-06-23
### Added
- **All tools now declare an MCP `outputSchema`.** Every tool migrated from `server.tool(...)` to `server.registerTool(...)` so its structured-output shape is advertised in the tool metadata and validated by the SDK. Schemas are intentionally permissive (all fields optional, no `.strict()`, loose element types for arrays) so they can describe the output contract without ever rejecting a valid result. No tool names, inputs, descriptions, or handler behavior changed.

### Changed
- **Rewrote the Hermes Agent packaging to match NousResearch's real spec.** `.hermes-plugin/` previously shipped Claude-format JSON (`plugin.json` / `marketplace.json` / `mcp.json`) that Hermes never reads; it now provides a `config.yaml` (a `~/.hermes/config.yaml` `mcp_servers:` snippet) plus a README with the `hermes mcp add` command. The README "Other Hosts" section is corrected to match (Hermes has no plugin/marketplace drop-in; Antigravity uses its native `mcp_config.json`). Claude Code, Codex, and Antigravity packaging are unchanged.

## [1.0.0] - 2026-06-23

First stable release. The public tool API (query / get-photo / library-info / list-* / export — all read-only except `export`) is now committed under semver 1.0. This release consolidates the recent multi-host packaging + marketplace work and adds production hardening.

### Added
- **Structured MCP tool descriptions on all 10 tools** in the `Use when: / Returns: / Do not use when:` shape (with a `Safety:` clause on `export`), so an agent can pick the right tool from metadata alone — matching the other Apple MCP servers.
- **CONTRIBUTING.md and SECURITY.md.**

### Changed
- **Switched to the manual-bump release model** (`publish.yml`, replacing the auto-bump `auto-release.yml`): the version is now bumped in the release commit, so `main`'s HEAD is always a normal CI-checked commit. This fixes the repo's perpetual non-green status (the old model's bot-pushed `chore(release)` commit never ran CI) and restores a per-release CHANGELOG.
- **Bumped `@modelcontextprotocol/sdk` to ^1.29.0**, clearing all `npm audit` advisories (transitive, from the SDK's unused HTTP transport) — `npm audit --omit=dev` is now clean.
- **Pinned the Python dependency range** (`osxphotos>=0.69.0,<0.76`) so an incompatible future minor can't silently change the output contract.

### Fixed
- **Permission errors are now actionable.** When osxphotos hits a Full-Disk-Access / "unable to open database" failure, every tool appends guidance (grant Full Disk Access; run the `doctor` tool; see `docs/FULL-DISK-ACCESS.md`) instead of surfacing the raw low-level error.
- **Python version is gated.** `scripts/setup.sh` now prefers a Python ≥ 3.11 interpreter and fails fast with guidance if only an older one (e.g. macOS's stock 3.9) is found. README updated to **Python 3.11+** (osxphotos needs ≥ 3.10; the date filters need 3.11).
- **Release reliability:** the `npm install -g npm@latest` step in `publish.yml` now retries, so a transient registry `ECONNRESET` no longer aborts a release.
- **Codex marketplace shipped the Apple Notes icon for Apple Photos.** Replaced `codex/assets/icon.png` (and added an `icon.svg` source) with a Photos-specific icon — a teal card with a mountains-and-sun glyph, part of a consistent Apple MCP icon family. (Same root cause as the Mail #56 / Numbers #7 reports.)

### Documentation
- README: added npm-downloads, supported-Node, platform-macOS, and MCP badges next to the existing version/CI/License badges.
- Documented the `doctor` tool in the Apple Photos skill tool table (it was registered but missing from the skill); kept the canonical and Codex skill copies in sync.

### Added

- **Multi-host plugin packaging (Codex, Hermes, Antigravity).** In addition to the existing Claude Code plugin, the repo now ships plugin manifests for three more hosts: a full **Codex** package (`codex/` with `.codex-plugin/plugin.json`, `.mcp.json`, bundled Apple Photos skill, and marketplace assets) plus `.agents/plugins/marketplace.json`; **Hermes** packaging (`.hermes-plugin/`); and **Antigravity** packaging (`.antigravity-plugin/`, with the bundled skill). Every host registers the same `apple-photos` MCP server (launched via `npx -y apple-photos-mcp`) and ships the same skill, so behavior matches the Claude Code plugin. `scripts/sync-plugin-version.mjs` now keeps all of these manifests in step with `package.json` on `npm version`. This brings apple-photos-mcp to the same multi-host packaging parity as the other Apple MCP servers (mail, notes, numbers).

### Documentation
- Standardized the `package.json` `description` and GitHub one-liner to the shared house style ("… via Claude and other AI assistants") for consistency across the Apple MCP servers.
- Refreshed the README tagline to reflect the full query/search/export/inspect capabilities, matching the GitHub repo one-liner and `package.json` description.
- Added `docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`: why macOS re-prompts for Full Disk Access / Automation when the server runs under an ad-hoc-signed (e.g. Homebrew) Node, and the fix — run it under the official Developer-ID-signed Node so the grant survives Node updates. README and CLAUDE.md now point at it.

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
