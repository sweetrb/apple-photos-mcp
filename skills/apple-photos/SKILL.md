---
name: apple-photos
description: Use this skill when the user wants to query, view, organize, or export photos from their macOS Apple Photos library — searching by date/import-date/album/keyword/person/label/place/GPS-radius/media-type/aesthetic-score/OCR-text, viewing photos inline as thumbnails, acting on the live Photos.app selection, finding exact duplicates, browsing albums and folders, fetching metadata (location, dimensions, EXIF, ML score, detected text, shared-album comments/likes, burst siblings, type flags), exporting originals/edited versions to a directory, or (when the opt-in write gate is enabled) creating albums, filing photos into albums, setting titles/descriptions/keywords/favorites, fixing photo dates, and importing files. Backed by osxphotos.
---

# Apple Photos Skill

This skill enables you to query, organize, and export photos from the macOS Apple Photos library using natural language. It is backed by the [osxphotos](https://github.com/RhetTbull/osxphotos) Python library and operates **read-only by default** — no modifications are made to the library itself, but exports write files to disk.

**Write tools exist but are gated:** `create-album`, `add-to-album`, `remove-from-album`, `set-photo-metadata`, `set-keywords`, `set-photo-date`, and `import-photos` only work when the user has set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` (in the server env or in `~/Library/Application Support/apple-photos-mcp/config.json`, then restarted the server). **Check `doctor` first** when a task needs writes — its `writes` check reports the gate state; a gated call returns the opt-in recipe to relay to the user. Even with writes enabled, **no tool can delete photos** (quarantine into an album; the user deletes in Photos.app).

## When to Use This Skill

Use this skill when the user:
- Wants to find photos by date, import date ("what did I import this week?"), album, keyword, person, ML label, place, GPS radius ("near the cabin"), year, file size, media type (screenshots, selfies, panoramas, bursts, …), aesthetic score ("the good ones"), OCR-detected text ("photos of receipts"), or favorite/hidden flags
- Wants to SEE a photo ("show me…", "which one is better?") — get-thumbnail returns viewable images inline
- Asks about duplicate photos in their library
- Asks for stats about their library (counts of photos, albums, etc.)
- Wants to list albums, folders, keywords, or detected persons
- Needs full metadata for one photo or a batch (dimensions, location, EXIF camera data, type flags)
- Wants to export photos (originals, edited versions, raw, or live-photo videos) to a directory
- Says "these photos" about a selection in the Photos.app window — get-selected-photos bridges the GUI selection to UUIDs
- Wants to organize photos — create albums, file photos into albums, tag with keywords, set titles/descriptions/favorites (write tools; gated — see above)
- Wants to fix wrong photo dates (trailcam/scanner imports, mis-set camera clocks) — set-photo-date, dry-run first (write tool; gated)
- Wants to import image/video files into the library — import-photos (write tool; gated; cannot be undone programmatically)
- Mentions Apple Photos, Photos.app, "my photos", "my photo library"

## Available Tools

| Tool | Purpose |
|------|---------|
| `health-check` | Verify osxphotos is installed and the library can be opened |
| `doctor` | Full diagnostic — six checks: Python interpreter version, osxphotos install, sidecar mode (persistent vs one-shot), write-tools gate, library readability, and Full Disk Access (ok/warn/fail with advice) |
| `library-info` | High-level stats: counts of photos, movies, albums, folders, keywords, persons |
| `query` | Search the library with combinable filters (dates, import dates, albums, keywords, persons, labels, places, GPS radius `near`, years, sizes, media types, aesthetic `minScore`, OCR `detectedText`); `newestFirst` for the N most recent; returns photo summaries with UUIDs |
| `get-photo` | Full metadata for one photo by UUID (location, dimensions, EXIF camera data, ML score/detected text, shared-album social data, type flags; `burstPhotos=true` adds burst siblings) |
| `get-photos` | Full metadata for up to 50 UUIDs in ONE batched call |
| `get-selected-photos` | The photos currently selected in the Photos.app window ("act on these") — errors, never launches Photos, when it isn't running or nothing is selected |
| `get-thumbnail` | The photo itself as an inline viewable image (from Photos' pre-generated derivatives; `minSize` px, default 360) |
| `find-duplicates` | Groups of exact duplicates via Photos' own fingerprint detection |
| `list-albums` | All albums with their folder paths and photo counts |
| `list-folders` | All folders with parent and album/subfolder counts |
| `list-keywords` | Keywords sorted by usage count (with optional top-N limit) |
| `list-persons` | People detected by face recognition, sorted by photo count |
| `export` | Export one or more photos by UUID to a destination directory |
| `create-album` | *(write, gated)* Create an album, optionally nested in a folder path; idempotent (existing album returned, not duplicated) |
| `add-to-album` | *(write, gated)* File photos into an album by UUID (1–100); idempotent, reports added/alreadyPresent/notFound |
| `remove-from-album` | *(write, gated)* Remove photos from an album ONLY — never from the library; rebuilds the album (its UUID changes) |
| `set-photo-metadata` | *(write, gated)* Set title/description/favorite; echoes before/after values for undo |
| `set-keywords` | *(write, gated)* Add/remove keywords with union semantics — keywords you don't mention are preserved |
| `set-photo-date` | *(write, gated)* Fix a photo's date — absolute or shift by seconds; **dry run by default** (pass `dryRun=false` to write); echoes before/after for revert; Photos-DB date only, EXIF untouched |
| `import-photos` | *(write, gated)* Import files into the library, optionally into an existing album; add-only — imports cannot be deleted programmatically |

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

```
User: "The best shots from near the cabin"
→ query with near="46.51,-87.42,5" minScore=0.6 newestFirst=true limit=20

User: "Find the screenshot with the wifi password"
→ query with screenshot=true detectedText="password"
```

### Act on the Photos.app selection
```
User: [selects photos in Photos.app] "Add these to the Yearbook album"
→ get-selected-photos → UUIDs → add-to-album album="Yearbook" uuid=[...]
  (Photos must be running with a visible selection — the tool errors,
   and never launches Photos, otherwise)
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

### Organize (write tools — gated; check doctor first)
```
User: "File this week's imports into a Trailcam album and tag them"
→ doctor (writes check = ENABLED?)
→ query addedInLast="7d" → UUIDs
→ create-album name="Trailcam"          (idempotent)
→ add-to-album album="Trailcam" uuid=[...]
→ set-keywords per photo add=["trailcam"]   (merges — existing keywords kept)

User: "Delete the duplicate copies"
→ You CANNOT delete. Album-quarantine pattern instead:
  find-duplicates → create-album "Duplicates — review & delete"
  → add-to-album with each group's extras → user reviews + deletes in Photos.app
```

### Fix wrong dates (write tools — dry-run first)
```
User: "This trailcam photo is stamped with the upload time; the strip says 05/14 06:32"
→ set-photo-date uuid=... date="2026-05-14T06:32:00"       (dryRun defaults TRUE — preview)
→ confirm the echoed before → after with the user
→ set-photo-date uuid=... date="2026-05-14T06:32:00" dryRun=false
  (batches with one wrong clock: shiftSeconds instead; revert = date=<echoed before>)
```

### Import files (write tools)
```
User: "Import these scans into the family album"
→ confirm the file list (imports CANNOT be undone programmatically)
→ create-album name="Family Scans" if needed → import-photos paths=[...] album="Family Scans"
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

7a. **`set-photo-date` is a dry run by default** — preview, confirm the echoed before/after with the user, then re-run with `dryRun=false`. It changes the Photos-library date only (like Photos.app's Adjust Date & Time); the file's EXIF is untouched. **`import-photos` cannot be undone programmatically** (no AppleScript photo-delete verb) — confirm the file list first; sources must exist under the export allowlist roots; the target album must already exist. **`get-selected-photos`** needs Photos.app running with a visible selection and never launches Photos itself.

7b. **Writes are opt-in — never assume they're available.** If a write tool returns "Write tools are disabled", relay the recipe: set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` (env or config.json) and restart the server. `remove-from-album` removes album membership only (never deletes photos) and rebuilds the album — its UUID changes, so use the returned `album.uuid` (or the name) afterwards. `set-keywords` merges (union): keywords the user didn't mention are preserved. Writes drive Photos.app via AppleScript — the first write may pop a one-time macOS Automation prompt, and writes always target the library currently open in Photos.app.

8. **First-run setup is automatic.** The server auto-bootstraps a Python venv with `osxphotos` on the first tool call — the venv lives inside the plugin's own clone (under `~/.claude/plugins/` for a marketplace install), not in the user's project. If a tool still reports "osxphotos not installed", run the `doctor` tool FIRST to diagnose why auto-setup failed — the most common cause is `python3` older than 3.11 (stock macOS ships 3.9): have the user run `brew install python@3.12`, then simply retry the tool call (the venv rebuilds automatically).

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
| "Write tools are disabled — apple-photos-mcp is read-only by default" | The opt-in gate isn't set — relay: `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` (env or config.json) + server restart; confirm with `doctor` |
| "Album not found: '…'" | Wrong album name/UUID — `list-albums` for exact names, or `create-album` |
| "Photos.app is not running..." (get-selected-photos) | The selection bridge never launches Photos — have the user open Photos and select items, then retry |
| "No photos are selected in Photos.app..." | Nothing highlighted (or full-screen/edit view) — have the user select photos in the grid view |
| Write fails with AppleScript `-1743` / "not authorized" | macOS Automation permission for Photos not granted to the host app — System Settings → Privacy & Security → Automation → (host app) → Photos |
