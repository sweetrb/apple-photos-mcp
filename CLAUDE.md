# CLAUDE.md - Apple Photos MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server gives AI assistants access to the macOS Apple Photos library
via [osxphotos](https://github.com/RhetTbull/osxphotos) — **read-only by
default**. All operations are **local** — nothing leaves the user's machine.
You can query the library (including by GPS radius, aesthetic score, and
OCR-detected text), inspect individual photos (singly or in batches, including
EXIF camera data, ML score/detected text, shared-album comments/likes, and
burst siblings), read the **live Photos.app selection**, **see** photos inline
via thumbnails, find exact-duplicate groups, browse the library's structure
(albums, folders, keywords, persons), and **export** copies of photos to a
directory.

**Write tools exist but are gated:** `create-album`, `add-to-album`,
`remove-from-album`, `set-photo-metadata`, `set-keywords`, `set-photo-date`,
and `import-photos` only work when the user has set
`APPLE_PHOTOS_MCP_ENABLE_WRITES=1` (env or config.json + server restart).
Until then every write call returns a clear opt-in error — **run `doctor`
first** when writes matter: its `writes` check reports the gate state. Even
with writes enabled, **nothing can delete a photo** (see "Write workflow"
below).

## Related Documentation

- **[docs/FULL-DISK-ACCESS.md](./docs/FULL-DISK-ACCESS.md)** — why Full Disk
  Access is required, how to grant it, and how to verify it. Required reading
  when tools fail with permission errors.
- **[docs/LIMITATIONS.md](./docs/LIMITATIONS.md)** — what the server can and
  can't do (read-only, iCloud export caveats, face/album behavior, library lag).
- **[docs/QUERY-GUIDE.md](./docs/QUERY-GUIDE.md)** — `query` filter syntax in
  detail: accepted date forms, AND/OR combination semantics, exact-vs-substring
  matching, result ordering, and what is *not* filterable.
- **[docs/WRITE-BACKEND.md](./docs/WRITE-BACKEND.md)** — why reads use osxphotos
  (direct DB) and writes use photoscript/AppleScript, and why that split can't be
  collapsed (no safe DB writes; osxphotos's own writes *are* AppleScript; PhotoKit
  needs an app bundle). Read before proposing to "eliminate AppleScript" in writes.

## First-run requirements

Before any tool works, two things must be in place:

1. **Python sidecar installed — self-installing.** The server shells out to
   osxphotos (Python). For most users this needs **no manual step**: the venv at
   `./venv` is built automatically on the first tool call (a one-time setup that
   can take ~a minute; progress logs to stderr), then the call proceeds. The venv
   is also picked up without a restart once it exists, and rebuilt automatically
   if a package update changes its requirements. Pre-warm it with `pnpm run setup`
   to skip the first-call delay. Auto-setup needs Python 3, `pip`, and network
   access; it can be disabled with `APPLE_PHOTOS_MCP_NO_AUTO_SETUP=1` (then you
   must run `pnpm run setup` or `pip3 install osxphotos` yourself).
2. **Full Disk Access granted** to the host app (Claude/Terminal/iTerm/VS Code),
   then the host app **fully restarted**. The Photos library database is in a
   protected directory; without FDA, *every* tool fails. See
   [docs/FULL-DISK-ACCESS.md](./docs/FULL-DISK-ACCESS.md).

Run **`health-check`** first when in doubt — it confirms both at once (osxphotos
present + library openable). When something is actually broken, reach for
**`doctor`**: it's the richest diagnostic, checking the Python interpreter
(path + version — warns below the required 3.11), osxphotos install, the
sidecar execution mode (persistent vs one-shot fallback), the write-tools gate
(enabled/disabled + backend readiness), library readability, and Full Disk
Access separately and reporting each as ok / warn / fail with an actionable
message — so it pinpoints *which* of the first-run requirements is missing.

## Performance model: cold vs warm calls

The Python sidecar runs as a **persistent process**: the first tool call pays a
one-time cost (python start + osxphotos import + a full parse of the library
database — roughly ~4 s on a ~30k-photo library, more on bigger ones), and
subsequent calls reuse the resident parsed library and complete in
**milliseconds**. The sidecar re-checks the library's modification time before
every request, so results are never stale — a changed library (import, edit,
album rename) triggers an automatic re-parse on the next call. After 5 idle
minutes (`APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS`) the process is killed to free
memory and the next call pays the cold cost again. Practical upshot: don't
avoid follow-up calls for cost reasons — a `query` → `get-photo` → `export`
chain costs the parse once, not three times. Batch `export`s report per-photo
MCP progress notifications when the request carries a `progressToken`.

## The core workflow: query, then act

The reliable pattern is **two steps**: use `query` to find photos and get their
**UUIDs**, then use those UUIDs with `get-photo` / `get-photos` (full details),
`get-thumbnail` (see the image), or `export` (copy files).

```
1. query   → returns photo summaries, each with a UUID
2a. get-photo uuid="..."          → full metadata for one photo
2b. get-photos uuid=["...", ...]  → full metadata for up to 50 in ONE call
2c. get-thumbnail uuid="..."      → the photo itself, as an inline image
2d. export uuid=["...","..."] dest="..."   → copy files out
```

UUIDs are the **canonical, reliable handle** for a photo. Filenames and titles
can repeat or be empty; a UUID is unique and stable. Always carry the UUID from
`query` into the follow-up tools rather than re-searching by name.

**Prefer `get-thumbnail` over `export` when the user wants to LOOK at a
photo** ("show me", "which one is better", "what does it say") — it returns a
renderable image block with nothing written to disk. Use `export` only when
the user wants actual files. **Prefer `get-photos` over N `get-photo` calls**
whenever you hold more than a couple of UUIDs.

Two worked patterns built from these pieces:

- **Recently-imported sweep:** `query { addedInLast: "7d", newestFirst: true,
  limit: 20 }` → the newest imports; refine with `noKeyword: true` for the
  untagged backlog, or `screenshot: true` for cleanup candidates. Import date
  (`dateAdded`) is not the taken date — `addedInLast` is the right filter for
  "what just came in".
- **Dedupe with visual verification:** `find-duplicates` → groups of exact
  duplicates (Photos' fingerprint; identical image data only) → `get-thumbnail`
  a member or two per group to eyeball them → since this server cannot delete,
  collect the extra copies into a quarantine album (writes enabled: the
  album-quarantine pattern below; otherwise have the user do it in Photos.app)
  and let the user delete from there.

## Write workflow (gated — check `doctor` first)

The write tools follow the same query-then-act shape: `query` /
`find-duplicates` for UUIDs, then the write tool with those explicit UUIDs.
Rules that keep writes safe and predictable:

- **Check the gate before promising anything.** A write call on a read-only
  server returns "Write tools are disabled…" with the opt-in recipe
  (`APPLE_PHOTOS_MCP_ENABLE_WRITES=1` via env or config.json + restart) —
  relay that recipe to the user rather than retrying. `doctor`'s `writes`
  check reports the state up front.
- **There is NO delete.** Deliberately: no tool deletes photos, albums, or
  folders. The deletion UX is the **album-quarantine pattern** — file the
  condemned photos into a clearly-named album and have the user review +
  delete inside Photos.app (30-day Recently Deleted safety net):
  ```
  1. find-duplicates                        → groups with UUIDs
  2. create-album name="Duplicates — review & delete"   (idempotent)
  3. add-to-album with each group's EXTRA copies (keep the best per group)
  4. tell the user to review the album in Photos.app and delete there
  ```
- **`remove-from-album` rebuilds the album.** Photos' AppleScript has no
  remove verb, so removal recreates the album minus the removed photos: the
  album **UUID changes** (response carries `previousAlbumUuid` → `album.uuid`)
  and manual sort order is lost. It never touches the photos themselves. Use
  the NEW uuid for follow-up calls (or just use the album name).
- **`set-keywords` merges, never replaces.** Union semantics: existing
  keywords the caller doesn't mention are preserved. Revert with the echoed
  `before` list. A keyword in both `add` and `remove` is rejected.
- **Metadata writes echo before/after** — capture `before` when the user may
  want an undo.
- **`set-photo-date` is a DRY RUN by default.** Always preview first, then
  apply with `dryRun: false` — the trailcam/scanner date-fix workflow:
  ```
  1. get-thumbnail on the photo (raise minSize) → read the burned-in date strip
  2. set-photo-date uuid=… date="2026-05-14T06:32:00"      ← dryRun defaults TRUE
     → echoes before/after, writes NOTHING; sanity-check the delta
  3. set-photo-date … dryRun=false                          ← the actual write
  4. keep the echoed `before` — reverting = set-photo-date date=<before> dryRun=false
  ```
  Whole batches with one wrong clock shift with `shiftSeconds` (the same
  offset per photo) instead of an absolute `date`. Photos-library date only —
  the file's EXIF is never touched (same as Photos.app's *Adjust Date & Time*).
- **`import-photos` is add-only and CANNOT be undone programmatically** (no
  AppleScript photo-delete verb) — confirm the file list with the user before
  importing. Sources must exist under the export allowlist roots; the target
  `album` must already exist (`create-album` first). The default duplicate
  check makes Photos.app pop a blocking dialog on duplicates — warn the user,
  or pass `skipDuplicateCheck: true` only when re-imports are acceptable.
- **Writes target the library currently open in Photos.app** (normally the
  system library); the `library` parameter applies to read tools only. Writes
  launch Photos.app if needed and require macOS **Automation** permission —
  the first write may pop a one-time system prompt.

## Conventions and behaviors to know

- **Dates are ISO 8601.** `fromDate` / `toDate` on `query` take ISO 8601 strings
  (e.g. `"2025-06-01"`). A bare `toDate` (no time part) includes that whole day;
  a full datetime (e.g. `"2025-06-30T18:00:00"`) is a precise exclusive upper
  bound. Dates returned by the tools are ISO 8601 too.
- **Hidden photos are excluded by default.** `query` does not return hidden
  photos unless you pass `hidden: true` (only hidden) — `notHidden` is the
  default behavior. Likewise use `favorite` / `notFavorite` to narrow on
  favorites.
- **Results are paged: `count` vs `returned`.** `query` reports `count` (the
  TOTAL number of matches) and `returned` (how many summaries are in the
  response). When `limit` is omitted, a default limit of 500 applies — check
  `count > returned` to detect truncation and raise `limit` if you need more.
- **Filters are ANY-match and combinable.** `album`, `keyword`, `person`, and
  `uuid` are arrays; within one filter the match is ANY (OR). Combining
  different filters narrows the result (AND across filter types).
- **`person` depends on named faces.** Only people you've named in Photos are
  filterable; unnamed faces show as `_UNKNOWN_`. Use `list-persons` to see
  available names first.
- **Export is the only write — and it never touches the library.** `export`
  writes file copies to the `dest` directory (created if missing). `dest` must
  resolve — after `~` expansion and symlink resolution — to a path under the
  home directory, `/tmp`, `/private/tmp`, or `/Volumes`; anything else is
  rejected with an error naming those roots. It never
  modifies the Photos library. By default it exports the original; use
  `edited: true`, `live: true` (live-photo video), `raw: true`, and
  `overwrite: true` as needed. Without `overwrite`, a photo whose file already
  exists at `dest` is skipped with a per-UUID reason (never duplicated), and
  unknown/trashed UUIDs are reported as skipped too — every requested UUID is
  accounted for. Note the asymmetry: `get-photo` DOES resolve photos in
  Recently Deleted (it falls back to the trash), while `query` and `export`
  read the main library only — so a UUID `get-photo` just returned can still be
  skipped by `export` as "UUID not found (deleted or in trash)". Confirm `dest`
  before running on shared machines.
- **iCloud-only originals are slow.** If an original isn't on disk, `export`
  falls back to Photos.app to download it on demand — slower for large batches,
  and skipped (with a per-UUID reason) if the download fails. See
  [docs/LIMITATIONS.md](./docs/LIMITATIONS.md). The server stays responsive
  while a long export (or query) runs: operations are serialized one-at-a-time,
  and a concurrent `health-check` returns a quick liveness summary — while
  `doctor` still reports the interpreter/osxphotos checks and marks the
  library probe as skipped — instead of hanging until the operation finishes.
- **Non-default libraries.** Every tool accepts an optional `library` path to
  target a `.photoslibrary` other than the system one.

## Tools at a glance

| Tool | Purpose |
|------|---------|
| `health-check` | Verify osxphotos is installed and the library opens (while another operation is running it answers immediately with a liveness summary instead of queueing behind it) |
| `doctor` | Full setup diagnostic — Python interpreter version, osxphotos install, sidecar mode (persistent vs one-shot), write-tools gate, library readability, and Full Disk Access, each ok/warn/fail with advice (richer than `health-check`) |
| `library-info` | High-level counts (photos, movies, albums, folders, keywords, persons) |
| `query` | Find photos by taken/import date, album, keyword, person, ML label, place, GPS radius (`near`), folder, year, size, media type, aesthetic score (`minScore`), OCR text (`detectedText`), or flags → returns UUIDs (`newestFirst` for the N most recent) |
| `get-photo` | Full metadata for one photo by UUID (incl. EXIF camera data, ML `score`/`detectedText`, shared-album social data; `burstPhotos: true` adds burst siblings) |
| `get-photos` | Full metadata for up to 50 UUIDs in one batched call |
| `get-selected-photos` | The photos currently selected in the Photos.app window — "act on these"; errors (never launches Photos) when Photos isn't running or nothing is selected |
| `get-thumbnail` | The photo itself as an inline viewable image (from Photos' derivatives; `minSize` px, default 360) |
| `find-duplicates` | Groups of exact duplicates via Photos' fingerprint detection |
| `list-albums` | All albums with folder paths and photo counts |
| `list-folders` | All folders with parent and album/subfolder counts |
| `list-keywords` | Keywords sorted by usage count |
| `list-persons` | Named people sorted by photo count |
| `export` | Copy photo(s) by UUID to a destination directory |
| `create-album` | *(write, gated)* Create an album, optionally in a folder path; idempotent |
| `add-to-album` | *(write, gated)* File photos into an album by UUID; idempotent, per-UUID report |
| `remove-from-album` | *(write, gated)* Remove photos from an album ONLY (never the library); rebuilds the album — UUID changes |
| `set-photo-metadata` | *(write, gated)* Set title/description/favorite; echoes before/after for undo |
| `set-keywords` | *(write, gated)* Add/remove keywords with union semantics — unmentioned keywords preserved |
| `set-photo-date` | *(write, gated)* Fix a photo's date (absolute or `shiftSeconds`); **dry run by default**, before/after echoed for revert; Photos-DB date only |
| `import-photos` | *(write, gated)* Import files into the library (optionally into an existing album); add-only, cannot be undone programmatically |

## Error Handling

| Error | Likely cause | What to do |
|-------|--------------|------------|
| "osxphotos not installed. Install it with: pip3 install osxphotos ..." | Auto-setup couldn't run — disabled via `APPLE_PHOTOS_MCP_NO_AUTO_SETUP=1`, or Python 3 / `pip` / network unavailable (normally the venv self-installs on first use) | Run the `doctor` tool to diagnose; `pip3 install osxphotos` (needs Python >= 3.11) or `scripts/setup.sh` from a checkout, or unset `APPLE_PHOTOS_MCP_NO_AUTO_SETUP` |
| "operation not permitted" / "unable to open database" / permission error | Full Disk Access not granted (or granted to the wrong app) | Grant FDA to the **host** app and fully restart it — see [docs/FULL-DISK-ACCESS.md](./docs/FULL-DISK-ACCESS.md) |
| "Photo not found: <uuid>" | Wrong/stale UUID, or photo deleted | Re-run `query` to get current UUIDs, then retry |
| Export skipped: "original not downloaded from iCloud" | iCloud-only original couldn't be fetched | Check iCloud connectivity / signed-in state; ensure Photos.app automation is allowed |
| Export skipped: "Photo does not have adjustments..." / "raw component not on disk..." | `edited` requested but the photo has no edits / `raw` requested but the raw file isn't downloaded | Retry without that flag |
| Export skipped: "already exists at destination" | A file with that name is already at `dest` and `overwrite` wasn't set | Pass `overwrite: true` to replace, or export to a fresh directory |
| Export skipped: "UUID not found (deleted or in trash)" | Stale UUID — photo deleted or moved to Recently Deleted since the query | Re-run `query` to get current UUIDs |
| "Write tools are disabled — apple-photos-mcp is read-only by default" | The `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` opt-in isn't set | Relay the opt-in recipe (env or config.json + server restart); confirm with `doctor`'s `writes` check |
| "Album not found: '…'" | Wrong album name/UUID, or the album lives in a different library than the one open in Photos.app | `list-albums` for exact names; `create-album` to create it |
| Write fails with AppleScript error `-1743` / "not authorized" | macOS Automation permission for Photos not granted (or denied) to the host app | Re-enable under System Settings → Privacy & Security → Automation → (host app) → Photos; first write from a GUI session triggers the one-time prompt |
| "Operation timed out after 60000ms" | Very large library — the first (cold) call after startup, an idle period, or a library change parses the whole Photos DB | Set `APPLE_PHOTOS_MCP_TIMEOUT` (ms) higher; warm calls are then fast |
| "Export destination ... is outside the allowed export roots" | `dest` resolves outside home, `/tmp`, `/private/tmp`, and `/Volumes` (symlinks are followed) | Pick a destination under one of those roots |
| Database-lock error | Photos.app is mid-write | Close Photos.app and retry (queries only — iCloud export needs Photos) |

## Quick reference: getting the most from a request

- "How many photos do I have?" → `library-info`
- "Find X" → `query` (then summarize the UUIDs/filenames returned)
- "What did I import this week?" → `query` with `addedInLast: "7d"`, `newestFirst: true`
- "Find my screenshots / selfies / panoramas" → `query` with the media-type flag
- "Tell me about that photo" → `get-photo` with the UUID from the query
- "Compare these / audit EXIF across these" → `get-photos` with the UUIDs (one call)
- "Show me that photo" / "which is better?" → `get-thumbnail` (raise `minSize` to read small text)
- "Do I have duplicates?" → `find-duplicates`, then `get-thumbnail` to verify visually
- "Export those" → `export` with the UUIDs and a `dest`
- "What albums / keywords / people are there?" → `list-albums` / `list-keywords` / `list-persons`
- "File these into an album" → *(writes gated)* `create-album` then `add-to-album` with the UUIDs
- "Tag / caption / favorite these" → *(writes gated)* `set-keywords` (union merge) / `set-photo-metadata`
- "These photos" (selected in Photos.app) → `get-selected-photos` → feed the UUIDs onward
- "The dates on these are wrong" → *(writes gated)* `set-photo-date` — dry run first, then `dryRun: false`
- "Photos near the cabin / at these coordinates" → `query` with `near: "lat,lon,radiusKm"`
- "The good ones / best shots" → `query` with `minScore` (+ `newestFirst`)
- "Photos with text / of receipts" → `query` with `detectedText` (combine with `screenshot` or dates)
- "Import these files / scans" → *(writes gated)* `import-photos` (confirm the list first — imports can't be undone programmatically)
- "Delete the duplicates" → cannot delete: album-quarantine pattern (`create-album` + `add-to-album`), user deletes in Photos.app

## Recurring macOS permission prompts → offer the official-Node fix

If a user reports being **repeatedly** prompted for Full Disk Access or
Automation for "node" (especially after a `brew upgrade`), or that this MCP
loses its permissions every so often, the cause is almost always an **ad-hoc
signed Node** (typically Homebrew's) whose cdhash changes on every update, so
macOS TCC keeps treating it as a brand-new binary.

Detect it:

```bash
codesign -dvvv "$(which node)" 2>&1 | grep -E 'Signature=adhoc|TeamIdentifier=not set'
```

If that matches (ad-hoc / no Team ID), **offer to migrate this MCP to the
official Developer-ID-signed Node** per
[`docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`](docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md):
install an official LTS Node to a stable path (e.g. `~/mcp-runtime/node-current`),
repoint this server's `command` at it, and have the user grant the permission
once — it then persists across Node updates. Do not repoint `npx`-launched
servers that don't need Full Disk Access.
