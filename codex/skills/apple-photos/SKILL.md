---
name: apple-photos
description: Use this skill when the user wants to query, view, or export photos from their macOS Apple Photos library — searching by date/import-date/album/keyword/person/label/place/media-type, viewing photos inline as thumbnails, finding exact duplicates, browsing albums and folders, fetching metadata (location, dimensions, EXIF, type flags), or exporting originals/edited versions to a directory. Backed by osxphotos.
---

# Apple Photos Skill

This skill enables you to query and export photos from the macOS Apple Photos library using natural language. It is backed by the [osxphotos](https://github.com/RhetTbull/osxphotos) Python library and operates **read-only** against the Photos library — no modifications are made to the library itself, but exports write files to disk.

## When to Use This Skill

Use this skill when the user:
- Wants to find photos by date, import date ("what did I import this week?"), album, keyword, person, ML label, place, year, file size, media type (screenshots, selfies, panoramas, bursts, …), or favorite/hidden flags
- Wants to SEE a photo ("show me…", "which one is better?") — get-thumbnail returns viewable images inline
- Asks about duplicate photos in their library
- Asks for stats about their library (counts of photos, albums, etc.)
- Wants to list albums, folders, keywords, or detected persons
- Needs full metadata for one photo or a batch (dimensions, location, EXIF camera data, type flags)
- Wants to export photos (originals, edited versions, raw, or live-photo videos) to a directory
- Mentions Apple Photos, Photos.app, "my photos", "my photo library"

## Available Tools

| Tool | Purpose |
|------|---------|
| `health-check` | Verify osxphotos is installed and the library can be opened |
| `doctor` | Full diagnostic — five checks: Python interpreter version, osxphotos install, sidecar mode (persistent vs one-shot), library readability, and Full Disk Access (ok/warn/fail with advice) |
| `library-info` | High-level stats: counts of photos, movies, albums, folders, keywords, persons |
| `query` | Search the library with combinable filters (dates, import dates, albums, keywords, persons, labels, places, years, sizes, media types); `newestFirst` for the N most recent; returns photo summaries with UUIDs |
| `get-photo` | Full metadata for one photo by UUID (location, dimensions, EXIF camera data, type flags, etc.) |
| `get-photos` | Full metadata for up to 50 UUIDs in ONE batched call |
| `get-thumbnail` | The photo itself as an inline viewable image (from Photos' pre-generated derivatives; `minSize` px, default 360) |
| `find-duplicates` | Groups of exact duplicates via Photos' own fingerprint detection |
| `list-albums` | All albums with their folder paths and photo counts |
| `list-folders` | All folders with parent and album/subfolder counts |
| `list-keywords` | Keywords sorted by usage count (with optional top-N limit) |
| `list-persons` | People detected by face recognition, sorted by photo count |
| `export` | Export one or more photos by UUID to a destination directory |

## Usage Patterns

### Find photos
```
User: "Find photos of Sarah from last summer"
→ query with person=["Sarah"] fromDate="2025-06-01" toDate="2025-09-01"
```

```
User: "Show me my favorite sunsets"
→ query with keyword=["sunset"] favorite=true
```

```
User: "What did I import this week?"
→ query with addedInLast="7d" newestFirst=true limit=20
```

### See photos
```
User: "Show me the best photo from Saturday"
→ query for Saturday, then get-thumbnail on the candidates (images render inline)

User: "What does the sign in that photo say?"
→ get-thumbnail with uuid="ABC-123" minSize=1024   (raise minSize for small text)
```

### Inspect a specific photo — or a batch
```
User: "Tell me everything about UUID ABC-123"
→ get-photo with uuid="ABC-123"

User: "Compare these 20 shots and tell me which to keep"
→ get-photos with uuid=[...all 20...]   (one call, not 20)
```

### Duplicates
```
User: "Do I have duplicate photos?"
→ find-duplicates, then get-thumbnail on members to verify visually.
  Exact duplicates only (Photos' fingerprint). No deletion possible —
  suggest quarantining extras into an album in Photos.app.
```

### Explore the library
```
User: "What albums do I have?"
→ list-albums

User: "What are my top 20 keywords?"
→ list-keywords with limit=20
```

### Export
```
User: "Export the photos I just searched for to ~/Desktop/sunsets"
→ export with uuid=[...] dest="~/Desktop/sunsets"

User: "I want the edited versions, not the originals"
→ export with edited=true
```

## Important Guidelines

1. **Two-step workflow:** Use `query` to find UUIDs, then `get-photo`/`get-photos`, `get-thumbnail`, or `export` for details/images/files. Don't ask the user for UUIDs — derive them from a search first. Prefer `get-photos` over repeated `get-photo` calls when you hold several UUIDs.

2. **Query results are paged: `count` vs `returned`.** `count` is the TOTAL number of matches; `returned` is how many summaries are in the response (a default limit of 500 applies when `limit` is omitted). If `count > returned`, raise `limit`. Results are unsorted unless you pass `newestFirst=true`, which sorts before the limit — making `limit` mean "the N most recent".

2a. **Prefer `get-thumbnail` over `export` when the user wants to LOOK at a photo.** "Show me", "which is better", "read the text in it" → `get-thumbnail` returns the image inline with nothing written to disk (raise `minSize` to ~1024 for small detail). Reach for `export` only when the user wants actual files on disk.

3. **Hidden photos are excluded by default.** Pass `hidden=true` if the user is looking for them specifically (it returns ONLY hidden photos).

4. **System library is the default.** Pass `library` only when the user names a non-default `.photoslibrary` path.

5. **Date format is ISO 8601** (`2025-06-01` or `2025-06-01T00:00:00`). A bare `toDate` includes that whole day.

6. **Export creates the destination directory** if it doesn't exist, and the destination must resolve (after `~` expansion and symlink resolution) to a path under the home directory, `/tmp`, `/private/tmp`, or `/Volumes` — anything else is rejected. Use `overwrite=true` only when the user has confirmed they want to replace existing files.

7. **macOS only.** The Photos library only exists on macOS.

8. **First-run setup is automatic.** The server auto-bootstraps a Python venv with `osxphotos` on the first tool call — the venv lives inside the server package's own directory (the `npx` cache, for the Codex plugin's `npx -y apple-photos-mcp` launch), not in the user's project. If a tool still reports "osxphotos not installed", run the `doctor` tool FIRST to diagnose why auto-setup failed — the most common cause is `python3` older than 3.11 (stock macOS ships 3.9): have the user run `brew install python@3.12`, then simply retry the tool call (the venv rebuilds automatically).

## Error Handling

| Error | Likely Cause |
|-------|--------------|
| "osxphotos not installed" | Auto-setup failed — run `doctor` FIRST to see why. Most often `python3` is older than 3.11 (stock macOS ships 3.9): `brew install python@3.12`, then retry the tool call (the venv rebuilds automatically) |
| "Operation not permitted" / "unable to open database" | Full Disk Access missing — grant it to the HOST app (Claude Desktop / Terminal / iTerm / VS Code, not node), then fully quit and relaunch that app. Guide: https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/FULL-DISK-ACCESS.md |
| "Export destination ... is outside the allowed export roots" | `dest` resolves outside the home directory, `/tmp`, `/private/tmp`, and `/Volumes` (symlinks are followed) — pick a destination under one of those roots |
| "Library not found" | The `library` path doesn't exist or isn't a `.photoslibrary` |
| "No photos matched the query" | Filters too narrow — relax the criteria |
| "Photo not found: <uuid>" | Wrong UUID, or photo deleted |
| Permission errors during export | Destination not writable, or library locked by Photos.app |
