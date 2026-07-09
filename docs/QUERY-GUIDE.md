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

## How filters combine: AND across, OR within

- **Different filters are ANDed.** `keyword: ["beach"], person: ["Sarah"]`
  returns photos that have the beach keyword AND contain Sarah.
- **Values within one array filter are ORed** (ANY-match). `album`, `keyword`,
  `person`, and `uuid` are arrays: `keyword: ["beach", "lake"]` matches photos
  carrying either keyword.

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
- **`title` and `description` are case-sensitive substring matches** (single
  string each, not arrays).

## Flags and type filters

- **Hidden photos are excluded by default.** `hidden: true` returns ONLY
  hidden photos; `notHidden: true` just restates the default.
- **`favorite: true`** = only favorites; **`notFavorite: true`** = exclude them.
- **`photos` / `movies`**: both kinds are returned by default. `movies: true`
  alone = only movies; `photos: true` alone = only still photos; setting both
  is the same as the default.
- **`uuid`** fetches specific photos by UUID. Unknown UUIDs are silently
  dropped from the result (no error).
- **Recently Deleted is never searched.** `query` reads the main library only.
  (`get-photo`, by contrast, does fall back to the trash — so a UUID that
  `get-photo` resolves may still be absent from `query` results and skipped by
  `export`.)

## What is NOT filterable

`get-photo` returns location/place, `labels` (Photos' ML classifications),
`dateAdded`, file size, and the type flags (`isScreenshot`, `isSelfie`,
`isPanorama`, `isPortrait`, `isBurst`, `isLive`, `isRaw`, `isEdited`, `isHDR`,
`isSlowMo`, `isTimeLapse`) — but **none of these can be used as `query`
filters**, and neither can filename or folder. "Find my screenshots" or
"photos near Chicago" cannot be expressed as a single query: narrow with the
filters that DO exist (dates, keywords, persons, albums, favorite,
photo/movie), then inspect candidates with `get-photo`.

## Ordering, `limit`, and `count` vs `returned`

- **Results are unordered.** Photos come back in database order, and the
  keyword/person/album filters deduplicate through a set, which can scramble
  order further. There is **no sort parameter** (no `newest_first`), and
  `limit` slices the match list **before any sorting** — so `limit: 50` is NOT
  "the 50 most recent". To get the newest N, bound the search with `fromDate`
  (or fetch more and sort by `date` yourself).
- **`count` is the TOTAL number of matches; `returned` is the page size.**
  When `limit` is omitted, a **default limit of 500** applies. Check
  `count > returned` to detect truncation and raise `limit` (max 100000) if
  you need more.

## Input caps (schema-enforced)

| Parameter | Cap |
|-----------|-----|
| `uuid` | max 1000 entries, each ≤ 256 chars |
| `album` / `keyword` / `person` | max 100 entries, each ≤ 1024 chars |
| `fromDate` / `toDate` | ≤ 64 chars |
| `title` | ≤ 1024 chars |
| `description` | ≤ 2048 chars |
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
