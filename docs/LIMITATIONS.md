# Limitations

Apple Photos MCP is a **read-only-by-default** bridge to the macOS Photos
library, backed by [osxphotos](https://github.com/RhetTbull/osxphotos). This
page documents the real limitations — what the server cannot do and why — so
they aren't re-investigated every release. These agree with the README's
[Known Limitations](../README.md#known-limitations); this page adds the *why*
and *what to do* for each.

## Read-only by default — writes are an explicit opt-in

**Why:** osxphotos reads the Photos library; the read tools never write to it,
and out of the box neither does anything else — the only disk writes are
`export`'s **copies of files to a destination directory you choose**. Since
2.0.0 a set of **write tools** exists (`create-album`, `add-to-album`,
`remove-from-album`, `set-photo-metadata`, `set-keywords`), but every one of
them is refused unless the user has set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` —
see the README's [Write tools (opt-in)](../README.md#write-tools-opt-in)
section for the gate, the setup, and the safety design.

**What to do:** Use the server to find, inspect, and export; opt in to the
write gate if you want it organizing albums and metadata too. To change
anything the write tools don't cover (rename an album, name a face, edit an
image), do it in Photos.app; the change shows up on the next query once Photos
has persisted it.

## No photo deletion — even with writes enabled

**Why:** Deliberate safety design. No tool deletes photos, albums, or folders;
`remove-from-album` changes album *membership* only (the photos stay in the
library). An LLM-driven deletion of irreplaceable photos is an unacceptable
failure mode, so the capability simply doesn't exist in this server.

**What to do:** Use the **album-quarantine pattern**: collect the photos to
discard into a clearly-named album (`create-album` + `add-to-album`, or by
hand), then review and delete inside Photos.app — Recently Deleted keeps them
recoverable for ~30 days.

## Write-tool caveats (when the gate is enabled)

**Why:** Writes drive **Photos.app via AppleScript** (photoscript), which has
real constraints: (1) macOS requires **Automation permission** for the host
app — a one-time system prompt on the first write, which can't be granted
headlessly; (2) AppleScript talks to whatever library Photos.app has **open**,
so writes always target that library (normally the system one) — the read
tools' `library` parameter does not apply; (3) Photos' AppleScript dictionary
has **no remove-from-album verb**, so `remove-from-album` rebuilds the album
(same name, remaining photos): the album's **UUID changes** and custom manual
sort order is lost; (4) Photos is launched if it isn't running, so the first
write can be slow.

**What to do:** Run `doctor` first — its `writes` check reports the gate state
and backend readiness. Grant the Automation prompt once from a GUI session.
After a `remove-from-album`, use the returned `album.uuid` (or the album name)
for follow-up calls.

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
[FULL-DISK-ACCESS.md](./FULL-DISK-ACCESS.md). Verify with the `doctor` tool —
its dedicated Full Disk Access check reports ok / warn / fail with remediation
(`health-check` also works as a quick smoke test).

## The first (cold) call is slow — warm calls are fast

**Why:** Opening a Photos library means starting Python, importing osxphotos,
and parsing the entire library database — about 4 seconds on a ~30k-photo
library, and it scales with library size (a 100k+ photo library can take much
longer, potentially past the default 60 s timeout — raise
`APPLE_PHOTOS_MCP_TIMEOUT` if so). Since 1.4.0 the sidecar is a **persistent
process**, so this cost is paid **once**: the parsed library stays resident
and follow-up calls complete in milliseconds. The cold cost recurs only when
the sidecar has to (re)start — the first call after server startup, after
`APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS` (default 5 min) of inactivity, after a
crash, or when the library changed on disk (the sidecar re-checks
`Photos.sqlite`'s modification time before every request, so cached results
are never stale).

**What to do:** Nothing, usually — chain as many calls as you like; only the
first pays the parse. If even the cold call times out on a very large library,
raise `APPLE_PHOTOS_MCP_TIMEOUT` (ms). To keep the sidecar resident longer (or
forever), raise `APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS` or set it to `0` — at the
price of a few hundred MB of resident memory for large libraries. `doctor`'s
`sidecar_mode` check shows whether the persistent sidecar is active and when
it last (re)started.

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
and choose **File → Download Originals to this Mac** before exporting. Batch
exports emit one MCP progress notification per photo (when the client sends a
`progressToken`), so a long iCloud-heavy export shows a live counter in hosts
that surface progress instead of appearing hung.

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
regular albums (and, as of 1.2.0, iCloud Shared Albums — flagged
`isShared: true` in `list-albums`), but **smart albums are not surfaced at
all**: they never appear in `list-albums` and never match `query`'s `album`
filter, because smart-album membership is computed by Photos from its rules
rather than stored as an album record osxphotos can read. There is no tool to
read or edit a smart album's rule.

**What to do:** Treat `list-albums` and album-filtered queries as a snapshot of
what Photos currently has in each album. For precise, reproducible filtering,
prefer explicit `query` filters (keyword, person, date range) over relying on a
smart album's rule — see [QUERY-GUIDE.md](./QUERY-GUIDE.md) for the filter
syntax and combination semantics.

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
