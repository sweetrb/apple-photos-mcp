# Limitations

Apple Photos MCP is a **read-only** bridge to the macOS Photos library, backed by
[osxphotos](https://github.com/RhetTbull/osxphotos). This page documents the real
limitations — what the server cannot do and why — so they aren't re-investigated
every release. These agree with the README's
[Known Limitations](../README.md#known-limitations); this page adds the *why* and
*what to do* for each.

## Read-only — no writes back to Photos

**Why:** osxphotos reads the Photos library; this server deliberately never
writes to it. There is no tool to create or rename albums, add or edit keywords,
tag people, set titles/descriptions, favorite/unfavorite, or otherwise modify the
library. The only tool that writes anything at all is `export`, and it writes
**copies of files to a destination directory you choose** — it never touches the
library itself.

**What to do:** Use the server to find, inspect, and export. To change anything
*inside* the library (rename an album, add a keyword, name a face), do it in
Photos.app; the change will show up on the next query once Photos has persisted
it.

## macOS only

**Why:** Apple Photos and osxphotos are macOS-specific. There is no Photos
library to read on Linux or Windows.

**What to do:** Run the server on the Mac that holds the Photos library.

## Requires Full Disk Access

**Why:** The Photos library database lives in a macOS-protected directory
(`~/Pictures/Photos Library.photoslibrary/database/`). osxphotos reads it
directly, so the host process must have Full Disk Access. Without it, **every**
tool fails with a permission error (`operation not permitted` / `unable to open
database`).

**What to do:** Grant FDA to the host app and fully restart it. Full
step-by-step instructions are in
[FULL-DISK-ACCESS.md](./FULL-DISK-ACCESS.md). Verify with `health-check`.

## iCloud-only originals are slow to export (and may be skipped)

**Why:** When Photos uses **Optimize Mac Storage**, the full-resolution original
of a photo may live only in iCloud, with just a thumbnail on disk. A direct file
copy can't export what isn't there, so `export` falls back to **Photos.app via
AppleScript** to download the original on demand — the same thing that happens
when you open the photo in Photos. That download is slower than a local copy and
takes time proportional to the file size, so large batches can be slow.

**What to do:** Expect waits for iCloud-only batches. Make sure Photos.app is
installed and signed in to iCloud, and that the host app is allowed to control
Photos via Automation (see [FULL-DISK-ACCESS.md](./FULL-DISK-ACCESS.md)). If a
download fails (no connectivity, not signed in, excluded by a sync setting), that
photo is **skipped** with a per-UUID reason in the export result; the rest of the
export still succeeds. To prefetch, you can also select the photos in Photos.app
and choose **File → Download Originals to this Mac** before exporting.

## Person / face filtering depends on Photos having named the people

**Why:** The `person` filter (and `list-persons`) is driven by Photos' own face
recognition and the names *you* have assigned in Photos. osxphotos can only
filter by faces Photos has already detected and named. Unidentified faces appear
as `_UNKNOWN_` and cannot be filtered by name.

**What to do:** Name the people in Photos (People album) first. Use
`list-persons` to see exactly which names are available (and their photo counts)
before filtering a `query` by `person`.

## Smart albums vs. regular albums

**Why:** Photos has two kinds of albums: **regular** albums (you add photos
manually) and **smart** albums (auto-populated by a rule). osxphotos surfaces
albums and their contents, but smart-album membership is computed by Photos from
its rules, and what osxphotos sees reflects Photos' last evaluation — not a live
re-run of the smart-album query. There is no tool to read or edit a smart album's
rule.

**What to do:** Treat `list-albums` and album-filtered queries as a snapshot of
what Photos currently has in each album. For precise, reproducible filtering,
prefer explicit `query` filters (keyword, person, date range) over relying on a
smart album's rule.

## The library view may lag very recent edits

**Why:** osxphotos reads the on-disk Photos database. Photos.app buffers some
changes (new imports, edits, keyword/people changes, iCloud sync) before it
writes them to that database. Until Photos persists a change, osxphotos can't see
it — so a photo you edited or tagged seconds ago may not reflect the change yet,
and very recent imports may not appear.

**What to do:** Give Photos a moment to write, then re-run the query. If results
look stale or incomplete, let any in-progress iCloud sync settle and retry.

## Photos.app may lock the library

**Why:** osxphotos opens the library in read-only mode, but if Photos.app is
mid-write it can hold a lock that prevents the database from being opened, causing
a database-lock error.

**What to do:** Close Photos.app and retry. (Note this is in tension with the
iCloud-export fallback, which *needs* Photos.app — for plain queries, closing
Photos avoids lock errors; for exporting iCloud-only originals, Photos must be
available to download them.)
