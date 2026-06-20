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

## First-run requirements

Before any tool works, two things must be in place:

1. **Python sidecar installed.** The server shells out to osxphotos (Python). On
   a source clone, run `npm run setup` to create the project-local venv at
   `./venv` with osxphotos. On a global install, `pip3 install osxphotos`.
2. **Full Disk Access granted** to the host app (Claude/Terminal/iTerm/VS Code),
   then the host app **fully restarted**. The Photos library database is in a
   protected directory; without FDA, *every* tool fails. See
   [docs/FULL-DISK-ACCESS.md](./docs/FULL-DISK-ACCESS.md).

Run **`health-check`** first when in doubt — it confirms both at once (osxphotos
present + library openable). When something is actually broken, reach for
**`doctor`**: it's the richest diagnostic, checking osxphotos install, library
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
  (e.g. `"2025-06-01"`). Dates returned by the tools are ISO 8601 too.
- **Hidden photos are excluded by default.** `query` does not return hidden
  photos unless you pass `hidden: true` (only hidden) — `notHidden` is the
  default behavior. Likewise use `favorite` / `notFavorite` to narrow on
  favorites.
- **Filters are ANY-match and combinable.** `album`, `keyword`, `person`, and
  `uuid` are arrays; within one filter the match is ANY (OR). Combining
  different filters narrows the result (AND across filter types).
- **`person` depends on named faces.** Only people you've named in Photos are
  filterable; unnamed faces show as `_UNKNOWN_`. Use `list-persons` to see
  available names first.
- **Export is the only write — and it never touches the library.** `export`
  writes file copies to the `dest` directory (created if missing). It never
  modifies the Photos library. By default it exports the original; use
  `edited: true`, `live: true` (live-photo video), `raw: true`, and
  `overwrite: true` as needed. Confirm `dest` before running on shared machines.
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
| `doctor` | Full setup diagnostic — osxphotos install, library readability, and Full Disk Access, each ok/warn/fail with advice (richer than `health-check`) |
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
| "osxphotos not installed. Run: npm run setup" | Python sidecar/venv missing | Run `npm run setup` (source clone) or `pip3 install osxphotos` (global) |
| "operation not permitted" / "unable to open database" / permission error | Full Disk Access not granted (or granted to the wrong app) | Grant FDA to the **host** app and fully restart it — see [docs/FULL-DISK-ACCESS.md](./docs/FULL-DISK-ACCESS.md) |
| "Photo not found: <uuid>" | Wrong/stale UUID, or photo deleted | Re-run `query` to get current UUIDs, then retry |
| Export skipped: "original not downloaded from iCloud" | iCloud-only original couldn't be fetched | Check iCloud connectivity / signed-in state; ensure Photos.app automation is allowed |
| Export skipped: "no edited version exists" / "no raw sidecar exists" | `edited`/`raw` requested but none exists | Retry without that flag |
| Database-lock error | Photos.app is mid-write | Close Photos.app and retry (queries only — iCloud export needs Photos) |

## Quick reference: getting the most from a request

- "How many photos do I have?" → `library-info`
- "Find X" → `query` (then summarize the UUIDs/filenames returned)
- "Tell me about that photo" → `get-photo` with the UUID from the query
- "Export those" → `export` with the UUIDs and a `dest`
- "What albums / keywords / people are there?" → `list-albums` / `list-keywords` / `list-persons`
