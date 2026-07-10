# Query Guide

A practical reference for the `query` tool's filter syntax — what each filter
accepts, how filters combine, what is *not* filterable, and how results are
ordered and paged. Every statement here reflects the actual behavior of the
Python sidecar (`src/utils/photos_reader.py`) and the pinned
[osxphotos](https://github.com/RhetTbull/osxphotos) query engine.

## Dates: `fromDate` / `toDate`

Both take ISO 8601 strings — a **bare date** (`2025-06-01`) or a **full
datetime** (`2025-06-01T14:30:00`, optionally with a UTC offset).

- **`fromDate` is inclusive**: photos taken at or after that instant match. A
  bare date means midnight, so `fromDate: "2025-06-01"` includes all of June 1.
- **`toDate` is an exclusive upper bound** in osxphotos (`date < toDate`) —
  but a **bare `toDate` includes that whole day**: the sidecar rolls a bare
  date forward one day, so `toDate: "2025-06-30"` includes every photo taken
  on June 30 (and `fromDate` = `toDate` = the same bare date returns that
  single day). A **full datetime** is passed through unchanged and remains a
  precise exclusive bound: `toDate: "2025-06-30T18:00:00"` excludes 18:00:00
  and later.

## Import dates: `addedAfter` / `addedBefore` / `addedInLast`

These filter on **when the photo entered the library** (`dateAdded`), not when
it was taken — the right tool for "recently imported" sweeps.

- **`addedAfter`** (inclusive) and **`addedBefore`** take the same ISO 8601
  forms as `fromDate`/`toDate`, with the same bare-date convenience: a bare
  `addedBefore` date includes that whole day.
- **`addedInLast`** takes a trailing window as `"<number><unit>"` with unit
  `s`(econds), `m`(inutes), `h`(ours), `d`(ays), or `w`(eeks) — e.g. `"7d"`,
  `"24h"`. It is the simplest way to say "imported this week".

## How filters combine: AND across, OR within

- **Different filters are ANDed.** `keyword: ["beach"], person: ["Sarah"]`
  returns photos that have the beach keyword AND contain Sarah.
- **Values within one array filter are ORed** (ANY-match). `album`, `keyword`,
  `person`, `label`, `folder`, `year`, and `uuid` are arrays:
  `keyword: ["beach", "lake"]` matches photos carrying either keyword.
- **Exception: `place` values are ANDed.** `place: ["Michigan", "Houghton"]`
  matches only photos whose place names contain BOTH strings — pass one value
  for the usual single-place search.

## Exact match vs. substring

- **`keyword` and `person` are exact, case-sensitive, whole-string matches**
  against the photo's keyword/person lists — `"Beach"` does not match
  `"beach"`, and `"Sar"` does not match `"Sarah"`. Discover the exact
  spellings first with `list-keywords` / `list-persons`. Unnamed faces appear
  as `_UNKNOWN_`.
- **`album` matches the exact full folder path + album name**, case-sensitive.
  A top-level album is just its name (`"Vacation 2024"`); an album inside a
  folder must include the folder path, `/`-separated (`"Trips/Vacation 2024"`)
  — the bare album name will NOT match it. A literal `/` in a folder or album
  name is escaped as `//`. `list-albums` returns each album's `folder` array
  and `title`, which join to the path `query` expects. Smart albums are never
  matchable (see [LIMITATIONS.md](./LIMITATIONS.md)).
- **`label` is exact, case-sensitive, whole-string** — like `keyword`, but
  against the ML classification labels Photos computes automatically (the
  `labels` field `get-photo` returns, e.g. `Dog`, `Beach`, `Text`). Labels vary
  by Photos version; check a representative photo's `labels` first.
- **`folder` matches folder names/paths** — it returns photos in albums that
  live inside the named folder (same path rules as `album`).
- **`place` is a case-sensitive substring match** against the photo's
  reverse-geocoded place names (city, region, landmark, country). Remember:
  multiple `place` values are ANDed.
- **`title` and `description` are case-sensitive substring matches** (single
  string each, not arrays).

## Flags and type filters

- **Hidden photos are excluded by default.** `hidden: true` returns ONLY
  hidden photos; `notHidden: true` just restates the default.
- **`favorite: true`** = only favorites; **`notFavorite: true`** = exclude them.
- **`photos` / `movies`**: both kinds are returned by default. `movies: true`
  alone = only movies; `photos: true` alone = only still photos; setting both
  is the same as the default. `video: true` is an alias of `movies: true`.
- **Media-type flags** — each `true` narrows to only that type (they AND with
  everything else): `screenshot`, `screenRecording`, `selfie`, `panorama`,
  `live` (live photos), `portrait` (depth-effect), `timelapse`, `slowMo`,
  `burst`. There are no `not*` counterparts.
- **`hasLocation`** is tri-state: `true` = only photos WITH GPS coordinates,
  `false` = only photos WITHOUT, omitted = no location filter.
- **`year`** matches the calendar year the photo was taken (`year: [2024, 2025]`).
- **`minSize` / `maxSize`** bound the ORIGINAL file size in bytes — storage-hog
  hunting (`minSize: 50000000`) or thumbnail-junk sweeps (`maxSize: 100000`).
- **`noKeyword: true`** = only photos carrying no keyword at all — the
  untagged-backlog filter.
- **`uuid`** fetches specific photos by UUID. Unknown UUIDs are silently
  dropped from the result (no error).
- **Recently Deleted is never searched.** `query` reads the main library only.
  (`get-photo`, by contrast, does fall back to the trash — so a UUID that
  `get-photo` resolves may still be absent from `query` results and skipped by
  `export`.)

## Post-filters: `near`, `minScore`, `detectedText`

Three filters have no native osxphotos query equivalent, so the sidecar
applies them AFTER the other filters, before `count` and the `limit` slice —
they compose (AND) with everything above, and `count` reflects them:

- **`near: "lat,lon,radiusKm"`** — GPS-radius search: only photos within the
  great-circle (haversine) radius of the point (`"46.5,-87.4,5"` = within
  5 km). **Requires location data**: photos without GPS coordinates never
  match. Latitude −90…90, longitude −180…180, radius > 0.
- **`minScore: 0..1`** — only photos whose Photos-computed overall
  **aesthetic score** is at least the threshold (`0.7` ≈ "the good ones";
  scores concentrate below ~0.5, so start low). Photos without a computed
  score (freshly imported, or pre-analysis) never match.
- **`detectedText: "substring"`** — case-insensitive substring over the text
  Photos' own OCR indexed per photo (macOS 13+ / Photos 8+): receipts, signs,
  screenshots, whiteboards. This reads per-photo search info across every
  other filter's matches, so on big libraries combine it with narrowing
  filters (dates, `screenshot: true`, an album) rather than running it bare.

## What is NOT filterable

`get-photo` returns a few fields that still have **no `query` filter**:
filename, EXIF camera make/model/settings, shared-album comments/likes, and
the `isRaw` / `isEdited` / `isHDR` / `isMissing` flags. For these, narrow with
the filters that DO exist, then inspect candidates with `get-photos` (batch)
and post-filter.

## Ordering, `limit`, and `count` vs `returned`

- **Results are unordered by default.** Photos come back in database order,
  and the keyword/person/album filters deduplicate through a set, which can
  scramble order further. A plain `limit: 50` is NOT "the 50 most recent".
- **`newestFirst: true` sorts by taken date, newest first, BEFORE the `limit`
  slice** — so `newestFirst: true, limit: 50` IS "the 50 most recent matches".
  Photos with no date sort last.
- **`count` is the TOTAL number of matches; `returned` is the page size.**
  When `limit` is omitted, a **default limit of 500** applies. Check
  `count > returned` to detect truncation and raise `limit` (max 100000) if
  you need more.

## Input caps (schema-enforced)

| Parameter | Cap |
|-----------|-----|
| `uuid` | max 1000 entries, each ≤ 256 chars |
| `album` / `keyword` / `person` / `label` / `folder` / `place` | max 100 entries, each ≤ 1024 chars |
| `year` | max 100 entries, each 0–9999 |
| `fromDate` / `toDate` / `addedAfter` / `addedBefore` | ≤ 64 chars |
| `addedInLast` | ≤ 32 chars, must match `<number><unit>` (`s`/`m`/`h`/`d`/`w`) |
| `title` | ≤ 1024 chars |
| `description` | ≤ 2048 chars |
| `minSize` / `maxSize` | positive integer (bytes) |
| `near` | ≤ 128 chars, `"lat,lon,radiusKm"` (three numbers) |
| `minScore` | number 0–1 |
| `detectedText` | 1–256 chars |
| `limit` | positive integer ≤ 100000 |
| `library` | ≤ 4096 chars |

Exceeding a cap rejects the call at the schema, before the library is opened —
chunk larger UUID batches across multiple calls.

## Worked examples

```json
{ "keyword": ["beach", "lake"], "person": ["Sarah"], "favorite": true }
```
Favorites of Sarah tagged beach OR lake.

```json
{ "fromDate": "2025-06-01", "toDate": "2025-06-30" }
```
All of June 2025, inclusive of June 30.

```json
{ "album": ["Trips/Vacation 2024"], "movies": true, "limit": 25 }
```
Up to 25 movies from the "Vacation 2024" album inside the "Trips" folder
(`count` still reports the total number of matches).

```json
{ "addedInLast": "7d", "newestFirst": true, "limit": 20 }
```
The 20 most recent of everything imported this week — the
"what just came off the camera/SD card" sweep.

```json
{ "screenshot": true, "year": [2024], "maxSize": 500000 }
```
Small screenshots taken in 2024 — a typical cleanup candidate list.

```json
{ "label": ["Dog"], "hasLocation": true, "newestFirst": true, "limit": 10 }
```
The 10 newest geotagged photos Photos itself classified as containing a dog.

```json
{ "near": "46.51,-87.42,5", "minScore": 0.6, "newestFirst": true, "limit": 20 }
```
The 20 newest well-scored photos taken within 5 km of the point — a
"best shots from the property" sweep.

```json
{ "screenshot": true, "detectedText": "invoice" }
```
Screenshots whose OCR-indexed text contains "invoice" — the poor-man's
document search (`detectedText` composes with `screenshot` to stay cheap).
