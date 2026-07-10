# Changelog

## [2.1.0] - 2026-07-10

**Roadmap close-out: date fixing, imports, the Photos.app selection bridge, ML/social metadata, and GPS-radius search.** The two new write tools ride the existing `APPLE_PHOTOS_MCP_ENABLE_WRITES` gate — the server remains read-only by default, and still nothing can delete a photo.

### Added
- **`set-photo-date` `{uuid, date? | shiftSeconds?, dryRun?}`** *(write, gated)* — fix a photo's date/time: an absolute ISO 8601 `date` (local timezone; tz-aware input converted) or a relative `shiftSeconds` (negative = earlier), exactly one required. **Dry run by default:** nothing is written unless `dryRun: false` is passed, and every response echoes `before`/`after`/`shiftSeconds` so an applied change can be reverted with `date = before`. Rewrites the **Photos library date only** — the same operation as Photos.app's *Adjust Date & Time*; the file's EXIF is never modified. The trailcam/scanner "timewarp" op.
- **`import-photos` `{paths[], album?, skipDuplicateCheck?}`** *(write, gated)* — import 1–50 files into the library, optionally into an **existing** album (a missing album is an error, not auto-created). Add-only: source files stay on disk, nothing in the library is modified or deleted — but note an import **cannot be programmatically undone** (Photos' AppleScript has no photo-delete verb). Source paths must be absolute (or `~`-prefixed), exist, and resolve under the same allowlist roots as `export` (home, `/tmp`, `/private/tmp`, `/Volumes`) — validated in the TS layer *and* the sidecar. Duplicate checking is on by default (a found duplicate raises Photos.app's blocking dialog; `skipDuplicateCheck: true` re-imports silently). Returns `requestedCount` / `importedCount` / per-item `uuid`+`filename`.
- **`get-selected-photos`** *(read-only, not gated)* — the GUI-selection bridge: returns the photos currently selected in the Photos.app window as query-shaped summaries plus `notFound` (selected items the library index hasn't checkpointed yet, with filenames). Errors clearly — and **never launches Photos itself** — when Photos isn't running or nothing is selected (the running check deliberately precedes photoscript's `PhotosLibrary()` constructor, which would otherwise launch Photos and could surface a stale restored selection). Requires macOS Automation permission.
- **ML intelligence in photo details** — `get-photo`/`get-photos` now include `score` (Photos' overall aesthetic score, 0–1) and `detectedText` (the text Photos' own OCR indexed, macOS 13+); both null-graceful across macOS versions. Both read the search/score tables osxphotos already parses at library load — no extra per-photo compute.
- **Shared-album social data in photo details** — `owner`, `comments` (user/text/date/isMine), and `likes` (user/date/isMine), populated only for iCloud shared-album assets; null/[] otherwise.
- **Burst expansion** — `get-photo` gains `burstPhotos?: boolean`: when set, the response lists the OTHER frames of the photo's burst set (UUID, filename, date each; `[]` for non-burst photos).
- **`query` post-filters** (compose with every other filter; applied before `count` and the `limit` slice):
  - **`near: "lat,lon,radiusKm"`** — GPS-radius search via a haversine post-filter; photos without location data never match. Validated (ranges included) in the TS layer *and* the sidecar.
  - **`minScore: 0–1`** — only photos whose computed aesthetic score meets the threshold; unscored photos never match.
  - **`detectedText: "substring"`** — case-insensitive substring over the OCR-indexed text; documented as a per-photo search-info read, best combined with narrowing filters on big libraries.
- **Tests:** hermetic fake-photoscript coverage for all three new commands (dry-run contract, shift math, revert echo, import path validation, album resolution, selection summaries/not-running/no-selection, gate refusals — the fake osxphotos now serves minimal read summaries and can simulate index lag); manager unit tests for the new argv translations and validations; CI-safe gated-error integration assertions; live-writes suite extended with a set-photo-date dry-run/apply/revert round-trip and a real import of a generated 100×100 random-pixel JPEG into a scratch album (the un-deletable imported photo is titled "MCP live-import test — safe to delete"; random pixels keep re-runs off Photos' duplicate dialog).

### Changed
- **`health-check` no longer spawns a redundant dependency probe** (optimistic-first): the `health` sidecar command's success already proves osxphotos is importable, and its failure path already classifies missing deps with the setup hint — saving the ~0.5–1 s `import osxphotos` probe spawn on every healthy call. `doctor` intentionally keeps its explicit probes: they are the diagnostic content (independent, ungated checks that report interpreter/package versions even while a long operation holds the sidecar gate).
- `query`'s tool description, README (Features, Tool Reference, Usage Patterns, Safety design), QUERY-GUIDE (post-filters section + examples), CLAUDE.md (date-fix dry-run-first workflow, selection/near/score/text quick-reference), LIMITATIONS.md (import-undo, EXIF-untouched, selection preconditions), and all three SKILL.md copies document the new tools and parameters; `doctor`'s writes check names all seven gated tools.

### Documentation
- **`docs/WRITE-BACKEND.md`** — records why reads use osxphotos (direct Photos DB) while the opt-in write tools use photoscript/AppleScript, and why the split can't be collapsed: direct SQLite writes would corrupt/desync the library, osxphotos's own write ops *are* AppleScript underneath, and PhotoKit writes require an app bundle + entitlements (unsolved even in osxphotos). Linked from the README write-tools section and CLAUDE.md.

## [2.0.0] - 2026-07-10

**New: opt-in write tools — the server stays read-only by default, with behavior unchanged from 1.x unless you set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1`.**

This is the first release that *can* modify the Photos library, which is why it's a major version: the read-only guarantee is now an opt-in default rather than an absolute. Nothing changes for existing users — without the gate variable, every write tool returns a clear "how to enable" error and the library cannot be touched.

### Added
- **Five write tools** (gated behind `APPLE_PHOTOS_MCP_ENABLE_WRITES=1`, settable via env or the `config.json` mechanism; a restart applies it):
  - **`create-album` `{name, folder?}`** — creates an album, optionally nested in a `/`-separated folder path (folders created as needed). Idempotent: an existing album of that name is returned with `created: false` instead of duplicating.
  - **`add-to-album` `{album, uuid[]}`** — files photos into an album by name or UUID (1–100 UUIDs). Idempotent; returns `added` / `alreadyPresent` / `notFound` per UUID.
  - **`remove-from-album` `{album, uuid[]}`** — removes photos from the ALBUM only, never from the library. Photos' AppleScript has no remove verb, so the album is rebuilt (its UUID changes — reported as `previousAlbumUuid` → `album.uuid`; manual sort order is lost); a call matching no members skips the rebuild entirely.
  - **`set-photo-metadata` `{uuid, title?, description?, favorite?}`** — writes only the fields passed and echoes full before/after values so any change can be reverted.
  - **`set-keywords` `{uuid, add?, remove?}`** — **union semantics**: reads the photo's current keywords and merges the edits, so keywords the caller doesn't mention are always preserved (never a blind replace). Echoes before/after; a no-change merge skips the write.
- **Safety design (the core of this release):** no deletion capability of any kind (photos, albums, or folders — album-quarantine + Photos.app is the deletion path, keeping the 30-day Recently Deleted net); explicit UUIDs/names only (no "current selection", no wildcard operations); every target validated before any mutation; 100-UUID batch caps; the write tools are **always registered** and return the opt-in recipe when gated off (MCP clients cache tool lists, so hiding them would cost discoverability without adding safety); photoscript's default `killall Photos`-on-timeout retry policy is disabled — this server never kills the user's Photos.app.
- **`doctor` gains a `writes` check** (now six checks): reports the gate state with the opt-in recipe when disabled; when enabled, verifies photoscript is importable and Photos.app is present, and explains the one-time macOS Automation prompt (deliberately not probed — probing would trigger it).
- **Backend:** writes drive Photos.app via AppleScript through [photoscript](https://github.com/RhetTbull/photoscript) (now an explicit pinned dependency in `requirements.txt`; it was already installed as an osxphotos dependency). Writes always target the library currently open in Photos.app — the read tools' `library` parameter does not apply — and need macOS Automation permission (one-time prompt on first write).

### Changed
- **BREAKING (semantics only):** the package can no longer be described as unconditionally read-only — read-only is now the (unchanged) default rather than a hard guarantee. No API, tool, or configuration behaves differently unless `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` is set.
- After any write, both metadata caches (the Node catalog cache and the sidecar's resident parsed library) are force-invalidated rather than trusting the `Photos.sqlite` mtime — Photos commits through SQLite WAL, so the mtime alone can lag a write and serve a stale snapshot.
- README gains a prominent **Write tools (opt-in)** section (gate setup via env and config.json, safety design, the album-rebuild caveat); Tool Reference, SKILL.md (all three copies), CLAUDE.md, and LIMITATIONS.md updated to match.

## [1.5.0] - 2026-07-10
### Added
- **`get-thumbnail` — see photos, not just metadata.** New tool returning one photo as an inline MCP **image content block** (base64 JPEG/PNG that vision-capable clients render directly) plus structured metadata (source path, dimensions, MIME type, byte size, `isDerivative`). It serves the smallest preview derivative Photos has **already generated** whose long edge meets `minSize` (default 360 px) — no export, no original-file transfer. When no derivative is big enough, a right-sized JPEG is rendered from the original via `sips` (never upscaled — raising `minSize` to read small text actually gets you more pixels); responses are capped at 8 MB. Movies get a thumbnail when Photos generated a poster-frame derivative; iCloud-only photos with no local image return a clear error suggesting `export`. Unlocks visual triage ("show me the best photo from Saturday"), duplicate eyeballing, and reading text in photos — every workflow that previously dead-ended at metadata or required export-to-disk.
- **`query` filter expansion — ~20 new filters** (each verified against the pinned osxphotos 0.75.9):
  - **Import-date window:** `addedAfter` / `addedBefore` (ISO 8601, same bare-date semantics as `fromDate`/`toDate`) and `addedInLast` (`"7d"`, `"24h"` — trailing-window "recently imported" sweeps). These filter on `dateAdded`, not the taken date.
  - **Content/organization:** `label` (Photos' ML classification labels — "find photos of dogs" via Photos' own object detection; exact ANY-match like `keyword`), `folder` (photos in albums inside a folder), `place` (reverse-geocoded place-name substrings; multiple values AND), `hasLocation` (tri-state: `true` = with GPS, `false` = without), `year` (repeatable), `minSize`/`maxSize` (original file size in bytes — storage-hog hunting), `noKeyword` (the untagged backlog), `burst`.
  - **Media types:** `screenshot`, `screenRecording`, `selfie`, `panorama`, `live`, `portrait`, `timelapse`, `slowMo`, plus `video` as an alias of `movies` — "find my screenshots" is now a single query.
  - **`newestFirst` ordering:** sorts by taken date, newest first, **before** the `limit` slice — `newestFirst: true, limit: 50` now means "the 50 most recent matches" (previously results were database-ordered and limit-sliced, so "most recent N" was inexpressible).
- **`get-photos` — batch detail fetch.** New tool taking 1–50 UUIDs and returning full per-photo detail (same shape as `get-photo`, same Recently-Deleted fallback) in **one** sidecar round-trip, with unknown UUIDs reported in `notFound` instead of failing the batch. A 30-photo EXIF audit is now one call instead of 30.
- **EXIF in photo details.** `get-photo`/`get-photos` now include a null-safe `exif` object — camera make/model, lens, ISO, aperture, shutter speed, focal length, exposure bias, flash, and duration/fps/codec for video (`null` when Photos recorded no EXIF, e.g. manufacturer-app uploads and scans). The `get-photo` text output gains a `Camera:` line.
- **`find-duplicates` — exact-duplicate groups.** New tool grouping duplicates via Photos' own fingerprint-based detection (connected components over the `duplicates` relation — robust on macOS 15+, where the raw fingerprint attribute reads as `None`). Returns `groupCount`/`returned`/`groups` (newest first, default limit 100) with member UUIDs, filenames, dates, sizes, and dimensions. Hidden and Recently-Deleted photos are never group members. Exact duplicates only (identical image data) — the tool description points at `get-thumbnail` for visual verification and album-quarantine for cleanup, since deletion isn't scriptable.
- **Test hardening:** ~20 new unit tests (expanded-filter argv translation, `hasLocation` tri-state, `video` aliasing, batch/thumbnail/duplicates client paths, `imageResponse` shape) and 6 new live integration tests (newest-first ordering, `addedInLast` plausibility, screenshot-flag round-trip, batch-with-bogus-UUID accounting, decodable-thumbnail magic-byte check, well-formed duplicate groups). All live-verified end-to-end over the MCP protocol against a real 31k-photo library.

### Changed
- Tool responses can now carry MCP **image** content blocks (`imageResponse` helper) alongside the house text + `structuredContent` pattern; the thumbnail's base64 payload deliberately stays OUT of `structuredContent` so it isn't transmitted twice.
- `query`'s tool description, README tables, QUERY-GUIDE, CLAUDE.md, and all three SKILL.md copies document the new filters, the `newestFirst` contract, the batch/thumbnail/duplicates workflows (prefer `get-thumbnail` before `export` when the user wants to LOOK at a photo), and the recently-imported sweep pattern.

## [1.4.0] - 2026-07-09
### Changed
- **Persistent sidecar — the ~4-second fixed cost per tool call is now paid once, not per call.** Every call previously spawned a fresh Python process that imported osxphotos and re-parsed the entire Photos database (~3.8–4.0 s measured on a 31k-photo library — ~97% of a typical call, growing with library size). The sidecar now runs as a long-lived process (`photos_reader.py --serve`, line-delimited JSON over stdin/stdout, one request in flight behind the existing serial gate): the parsed `PhotosDB` stays resident per library path and is revalidated against `Photos.sqlite`'s mtime before **every** request, so a changed library re-parses immediately and results are never stale (same staleness witness as the 1.2.1 Node-side metadata cache, which stays and still absorbs repeat catalog reads). Measured live on a 31k-photo library: cold call 4.5 s → warm calls 6–160 ms (~28× on the first warm query). Robustness: per-request timeouts SIGKILL the serve process and surface the exact same timeout message as before; a crash or protocol error fails only the in-flight request and the next call respawns; an idle sidecar is killed after `APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS` (default 5 min, `0` = never) to bound resident memory; shutdown kills it deterministically; and if serve mode can't start at all (old script, broken env) the server transparently falls back to the previous spawn-per-call mode — same results, same error strings — logging the reason once. One-shot argv mode still works unchanged (CI, doctor probes, manual debugging, the fallback).
- **`doctor` gains a `sidecar_mode` check** (now five checks): reports persistent mode with the serving pid, spawn count, and last (re)spawn time — or one-shot mode with the reason (ok when deliberately disabled via env, warn when it's an unplanned handshake fallback).

### Added
- **Per-photo `export` progress.** In serve mode the sidecar emits a progress line per photo, and the server forwards them as MCP progress notifications (`progress`/`total` + a message naming the file being exported) whenever the client's request carries a `progressToken` — a 1000-photo iCloud-heavy export now shows a live counter instead of a silent up-to-30-minute call. Clients that send no token, and the rare one-shot fallback mode, behave exactly as before.
- **`APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR`** environment variable — set `0`/`false` to disable serve mode and restore the pre-1.4.0 spawn-per-call behavior (debugging escape hatch).
- **`APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS`** environment variable (default `300000`) — idle lifetime of the resident sidecar before it's killed to free memory; `0` keeps it alive indefinitely.

## [1.3.0] - 2026-07-09
### Changed
- **The server stays responsive during long operations** (responsiveness/perf minor — same results, same error messages, same schemas). Every sidecar invocation previously ran through `execFileSync`, freezing the Node event loop for the entire run — up to 30 minutes during an iCloud-heavy `export` — so MCP pings went unanswered (hosts could declare the server dead and respawn it mid-export), a concurrent `health-check` hung until the operation finished, and the SIGTERM/SIGINT handlers couldn't run (defeating deterministic shutdown exactly when it mattered). Sidecar execution is now **asynchronous** (`child_process.execFile`, SIGKILL-on-timeout like the sibling servers) behind a **serial gate** (ported from apple-mail-mcp): exactly one `photos_reader.py` process runs at a time — preserving the old one-at-a-time semantics (concurrent-reader safety against the Photos SQLite, bounded resource use) — while the event loop stays free to answer protocol traffic.
- **`health-check` answers immediately while another operation is in flight.** When the gate is busy (a long query or export), `health-check` returns a fast pure-TS liveness summary — server responsive, sidecar operation in flight, venv-marker state — instead of queueing a full library probe behind the operation; re-run it after the operation completes for the full result. When idle, behavior is unchanged. `doctor` similarly keeps its interpreter and osxphotos checks (light probes that never open the Photos DB, so they run even mid-export) and reports the library/Full-Disk-Access probe as `warn: skipped` while an operation runs.
- **Concurrent same-catalog calls coalesce.** Two overlapping calls for the same cached catalog command (`library-info`, `list-albums`, `list-folders`, `list-keywords`, `list-persons`, same args/library/DB-mtime) now share one in-flight sidecar spawn instead of queueing a duplicate; the existing mtime-validated metadata cache is unchanged.
- **Shutdown now kills in-flight sidecars.** Signal handlers actually fire mid-operation now, so SIGTERM/SIGINT (and stdin EOF/EPIPE) SIGKILL any running python child before exiting — an exiting server can no longer orphan a long-running export.
- **The venv bootstrap wait is async too.** The lock-loser's bounded wait for another process's setup no longer blocks the event loop (`Atomics.wait` replaced with an awaitable poll), and concurrent in-process bootstrap attempts are single-flighted.

## [1.2.1] - 2026-07-09
### Added
- **`export` destination allowlist.** The destination is now canonicalized (leading `~` expanded, `..` normalized, symlinks resolved — including a not-yet-existing final directory) and must land under the **home directory**, **/tmp**, **/private/tmp**, or **/Volumes**; anything else is rejected with an error naming the allowed roots. The check is path-segment-aware (`/Volumesx` does not pass as `/Volumes`), and the canonical path is what's handed to the sidecar, so a symlink under an allowed root can't redirect the write outside it. Ports apple-mail-mcp's `ALLOWED_SAVE_ROOTS` pattern to photos' only side-effecting tool.
- **`doctor` now checks the Python interpreter** (new first check, `python_interpreter`): reports the resolved path + version using the same venv-then-system resolution the sidecar uses, **warns** below the required 3.11 with `brew install python@3.12` advice (the most common first-run failure — stock macOS ships 3.9 — previously surfaced only as a bare "osxphotos not installed"), and **fails** when no Python resolves at all. Ports apple-numbers-mcp's check.
- **In-process metadata cache for the catalog commands** (`library-info`, `list-albums`, `list-folders`, `list-keywords`, `list-persons`). Every sidecar call re-parses the whole Photos database (seconds of fixed cost on large libraries), and agents habitually re-list catalogs within a session — repeats are now served from a small bounded cache keyed on (command, args, library) and invalidated the moment the library's `Photos.sqlite` mtime changes, so results are never stale. `query`, `get-photo`, and `export` are never cached; when the DB file can't be stat'ed, caching quietly stays out of the way.

### Fixed
- **Concurrent first-run venv bootstraps can no longer corrupt the venv.** Hosts that spawn one server instance per conversation could race two `python -m venv` + `pip install` runs into the same `./venv` — worse, the faster run's completion marker could bless a venv the slower run was still mutating. The bootstrap (both the server's auto-setup and `scripts/setup.sh`) is now guarded by an atomic cross-process `mkdir` lock: the winner runs the install, losers wait (bounded by `APPLE_PHOTOS_MCP_SETUP_TIMEOUT`) for the winner's completion marker, a lock abandoned by a dead process is reclaimed by age, and the `.deps-ok` marker is written atomically (tmp file + rename) as the very last step of setup — so an observable marker always describes a fully installed venv.
- **`get-photo` validates its `uuid` input** (max 256 chars, hexadecimal-with-dashes) so junk input fails fast at the schema with a clear message instead of costing a full sidecar spawn + library parse — matching the length cap `query`/`export` UUIDs already had.

### Changed
- **Doc URLs and the Full-Disk-Access remediation are now single-sourced** in a new `src/utils/docsUrls.ts` (the house standard mail and notes already follow), replacing five hardcoded `github.com/sweetrb/apple-photos-mcp` URLs and two near-verbatim duplicated FDA remediation blocks (photosManager + doctor) that were one edit away from telling users different things.

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
