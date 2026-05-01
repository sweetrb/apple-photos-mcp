# Changelog

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
