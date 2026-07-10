# Write backend: why reads use osxphotos and writes use AppleScript

This server uses **two different backends on purpose**, and the split is a
considered decision. Please don't "simplify" it by routing writes through
osxphotos or by writing to the Photos SQLite database directly — both are dead
ends, explained below.

## The split

| Path | Backend | Why |
|------|---------|-----|
| **Reads** — `query`, browse, `export`, diagnostics | **osxphotos**, reading the Photos SQLite DB directly | Fast, no app scripting, no Automation prompt, no Photos.app launch. |
| **Writes** — `create-album`, `add-to-album`, `remove-from-album`, `set-photo-metadata`, `set-keywords` (opt-in, gated behind `APPLE_PHOTOS_MCP_ENABLE_WRITES=1`) | **photoscript → AppleScript → Photos.app** | The only *safe, supported* way to mutate the live library. |

## Why not write to the SQLite DB the way we read it?

Photos.app owns its CoreData SQLite store. Writing to it directly:

- risks **corrupting** the library — CoreData invariants, entity relationships, and derived tables are undocumented and version-specific;
- is **not synced** to iCloud — Photos commits real changes through its own layer, not the raw DB; and
- gets **clobbered** the next time Photos rewrites the store.

osxphotos itself never writes to the DB, for exactly these reasons — it is a
read/export tool by design.

## Why not route writes through osxphotos?

osxphotos' own write-ish operations (`PhotosAlbum`, date setters, etc.) are
implemented **on top of `photoscript`** — i.e. the very same AppleScript this
server already calls. Going through osxphotos would wrap a layer around the
identical AppleScript, not eliminate it. No speed win, no permission win.

## Why not PhotoKit (the AppleScript-free native path)?

PhotoKit (`PHPhotoLibrary.performChanges`) is the only way to mutate the library
without AppleScript. But **PhotoKit write authorization requires an app bundle**
with the right entitlements and an `NSPhotoLibraryUsageDescription` — macOS does
not grant PhotoKit write access to a bare `python3`/`node` interpreter. osxphotos
bundles a PhotoKit module, and its own source notes it *"[hasn't] figured out how
to get the call to requestAuthorization to actually work"* for this case.
Shipping PhotoKit writes would mean building, signing, notarizing, and
distributing a native (Swift) helper — a large lift, disproportionate to five
opt-in tools, and an unsolved problem even in osxphotos.

## The accepted trade-off

The write tools pay AppleScript's costs: Photos.app is launched if needed
(photoscript waits up to ~300 s), each round-trip is slow-ish, and the first
write needs the one-time **Automation** grant (host → Photos). This is confined
to the **opt-in** write tools — the default read path is entirely
AppleScript-free and prompt-free.

One deliberate detail: `set-keywords` reads the photo's current keywords via
**photoscript** (not osxphotos) immediately before writing, so the union-merge
can never drop a keyword added since the DB's last sync. That is a correctness
choice over a marginally faster — but potentially stale — osxphotos read.

**Bottom line:** osxphotos for reads, photoscript for writes is the right design.
Revisit only if a signed PhotoKit helper ever becomes worth building and
maintaining.
