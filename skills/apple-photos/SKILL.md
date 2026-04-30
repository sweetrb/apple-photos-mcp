---
name: apple-photos
description: Use this skill when the user wants to query or export photos from their macOS Apple Photos library — searching by date/album/keyword/person, browsing albums and folders, fetching metadata (location, dimensions, type flags), or exporting originals/edited versions to a directory. Backed by osxphotos.
---

# Apple Photos Skill

This skill enables you to query and export photos from the macOS Apple Photos library using natural language. It is backed by the [osxphotos](https://github.com/RhetTbull/osxphotos) Python library and operates **read-only** against the Photos library — no modifications are made to the library itself, but exports write files to disk.

## When to Use This Skill

Use this skill when the user:
- Wants to find photos by date, album, keyword, person, location, or favorite/hidden flags
- Asks for stats about their library (counts of photos, albums, etc.)
- Wants to list albums, folders, keywords, or detected persons
- Needs full metadata for a specific photo (dimensions, location, EXIF flags)
- Wants to export photos (originals, edited versions, raw, or live-photo videos) to a directory
- Mentions Apple Photos, Photos.app, "my photos", "my photo library"

## Available Tools

| Tool | Purpose |
|------|---------|
| `health-check` | Verify osxphotos is installed and the library can be opened |
| `library-info` | High-level stats: counts of photos, movies, albums, folders, keywords, persons |
| `query` | Search the library with combinable filters; returns photo summaries with UUIDs |
| `get-photo` | Full metadata for one photo by UUID (location, dimensions, type flags, etc.) |
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

### Inspect a specific photo
```
User: "Tell me everything about UUID ABC-123"
→ get-photo with uuid="ABC-123"
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

1. **Two-step workflow:** Use `query` to find UUIDs, then `get-photo` or `export` for details/files. Don't ask the user for UUIDs — derive them from a search first.

2. **Hidden photos are excluded by default.** Pass `hidden=true` if the user is looking for them specifically.

3. **System library is the default.** Pass `library` only when the user names a non-default `.photoslibrary` path.

4. **Date format is ISO 8601** (`2025-06-01` or `2025-06-01T00:00:00`).

5. **Export creates the destination directory** if it doesn't exist. Use `overwrite=true` only when the user has confirmed they want to replace existing files.

6. **macOS only.** The Photos library only exists on macOS.

7. **First-run setup:** If `health-check` reports osxphotos is missing, instruct the user to run `npm run setup` once in the project to create the venv.

## Error Handling

| Error | Likely Cause |
|-------|--------------|
| "osxphotos not installed" | First-run setup not done — run `npm run setup` |
| "Library not found" | The `library` path doesn't exist or isn't a `.photoslibrary` |
| "No photos matched the query" | Filters too narrow — relax the criteria |
| "Photo not found: <uuid>" | Wrong UUID, or photo deleted |
| Permission errors during export | Destination not writable, or library locked by Photos.app |
