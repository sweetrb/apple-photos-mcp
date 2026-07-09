# CLAUDE.md - Apple Photos MCP Server

This file provides guidance for AI agents (Claude, etc.) when using this MCP server.

## Overview

This MCP server gives AI assistants **read-only** access to the macOS Apple
Photos library via [osxphotos](https://github.com/RhetTbull/osxphotos). All
operations are **local** — nothing leaves the user's machine. You can query the
library, inspect individual photos, browse its structure (albums, folders,
keywords, persons), and **export** copies of photos to a directory. You cannot
modify the library itself.

## Related Documentation

- **[docs/FULL-DISK-ACCESS.md](./docs/FULL-DISK-ACCESS.md)** — why Full Disk
  Access is required, how to grant it, and how to verify it. Required reading
  when tools fail with permission errors.
- **[docs/LIMITATIONS.md](./docs/LIMITATIONS.md)** — what the server can and
  can't do (read-only, iCloud export caveats, face/album behavior, library lag).
- **[docs/QUERY-GUIDE.md](./docs/QUERY-GUIDE.md)** — `query` filter syntax in
  detail: accepted date forms, AND/OR combination semantics, exact-vs-substring
  matching, result ordering, and what is *not* filterable.

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
(path + version — warns below the required 3.11), osxphotos install, library
readability, and Full Disk Access separately and reporting each as ok / warn /
fail with an actionable message — so it pinpoints *which* of the first-run
requirements is missing.

## The core workflow: query, then act

The reliable pattern is **two steps**: use `query` to find photos and get their
**UUIDs**, then use those UUIDs with `get-photo` (for full details) or `export`
(to copy files).

```
1. query   → returns photo summaries, each with a UUID
2a. get-photo uuid="..."   → full metadata for one photo
2b. export  uuid=["...","..."] dest="..."   → copy files out
```

UUIDs are the **canonical, reliable handle** for a photo. Filenames and titles
can repeat or be empty; a UUID is unique and stable. Always carry the UUID from
`query` into `get-photo` / `export` rather than re-searching by name.

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
  [docs/LIMITATIONS.md](./docs/LIMITATIONS.md).
- **Non-default libraries.** Every tool accepts an optional `library` path to
  target a `.photoslibrary` other than the system one.

## Tools at a glance

| Tool | Purpose |
|------|---------|
| `health-check` | Verify osxphotos is installed and the library opens |
| `doctor` | Full setup diagnostic — Python interpreter version, osxphotos install, library readability, and Full Disk Access, each ok/warn/fail with advice (richer than `health-check`) |
| `library-info` | High-level counts (photos, movies, albums, folders, keywords, persons) |
| `query` | Find photos by date/album/keyword/person/flags → returns UUIDs |
| `get-photo` | Full metadata for one photo by UUID |
| `list-albums` | All albums with folder paths and photo counts |
| `list-folders` | All folders with parent and album/subfolder counts |
| `list-keywords` | Keywords sorted by usage count |
| `list-persons` | Named people sorted by photo count |
| `export` | Copy photo(s) by UUID to a destination directory |

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
| "Operation timed out after 60000ms" | Very large library — every call re-opens the Photos DB | Set `APPLE_PHOTOS_MCP_TIMEOUT` (ms) higher |
| "Export destination ... is outside the allowed export roots" | `dest` resolves outside home, `/tmp`, `/private/tmp`, and `/Volumes` (symlinks are followed) | Pick a destination under one of those roots |
| Database-lock error | Photos.app is mid-write | Close Photos.app and retry (queries only — iCloud export needs Photos) |

## Quick reference: getting the most from a request

- "How many photos do I have?" → `library-info`
- "Find X" → `query` (then summarize the UUIDs/filenames returned)
- "Tell me about that photo" → `get-photo` with the UUID from the query
- "Export those" → `export` with the UUIDs and a `dest`
- "What albums / keywords / people are there?" → `list-albums` / `list-keywords` / `list-persons`

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
