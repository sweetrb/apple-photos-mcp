# Apple Photos MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to query, search, export, and inspect the macOS Apple Photos library — plus opt-in album and metadata write tools — backed by the [osxphotos](https://github.com/RhetTbull/osxphotos) library.

[![npm version](https://img.shields.io/npm/v/apple-photos-mcp)](https://www.npmjs.com/package/apple-photos-mcp)
[![npm downloads](https://img.shields.io/npm/dm/apple-photos-mcp)](https://www.npmjs.com/package/apple-photos-mcp)
[![node](https://img.shields.io/node/v/apple-photos-mcp)](https://www.npmjs.com/package/apple-photos-mcp)
[![CI](https://github.com/sweetrb/apple-photos-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-photos-mcp/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sweetrb/apple-photos-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/sweetrb/apple-photos-mcp)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-111?logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

<p align="center">
  <img src="https://raw.githubusercontent.com/sweetrb/apple-photos-mcp/main/codex/assets/screenshot.png" alt="Apple Photos MCP — search, browse, and export the macOS Photos library from Codex, Claude, and other AI assistants" width="680">
</p>

> **Read-only by default.** Out of the box the library is never modified — exports write files to a directory you choose, nothing more. A set of **opt-in [write tools](#write-tools-opt-in)** (albums, titles, descriptions, keywords, favorites, dates, imports — never deletion) unlocks only when you explicitly set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1`; without that flag, 2.x behaves exactly like the read-only 1.x releases.

## What is This?

This server acts as a bridge between AI assistants and Apple Photos. Once configured, you can ask Claude (or any MCP-compatible AI) to:

- "Find all my photos from our trip to Spain in 2023"
- "Show me my favorite sunset photos" — and actually **see** them (`get-thumbnail` returns viewable images)
- "How many photos do I have? What are my top keywords?"
- "Find photos of Sarah from last summer and export them to ~/Desktop/sarah-summer"
- "What did I import this week?" (`addedInLast`), "Find my screenshots from 2024"
- "Do I have duplicate photos?" (`find-duplicates` groups exact duplicates)
- "List my albums"
- "Tell me everything about photo UUID ABC-123" — including EXIF camera data
- With [writes enabled](#write-tools-opt-in): "File these into a Trailcam album", "Tag them all `deer`", "Favorite the best one and caption it"

The AI assistant communicates with this server, which uses [osxphotos](https://github.com/RhetTbull/osxphotos) to read the Photos library SQLite database directly. All data stays local on your machine.

## Quick Start

### Using Claude Code (Easiest)

If you're using [Claude Code](https://claude.com/product/claude-code) (in Terminal or VS Code), just ask Claude to install it:

```
Install the sweetrb/apple-photos-mcp MCP server so you can help me query my Apple Photos library
```

Claude will handle the installation and configuration automatically. Or register it yourself with one deterministic command:

```bash
claude mcp add apple-photos -s user -- npx -y apple-photos-mcp
```

The Python `osxphotos` dependency installs **automatically on first use** (a one-time, ~minute-long setup), so the only manual step is granting Full Disk Access — see [Requirements](#requirements) below.

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-photos-mcp
/plugin install apple-photos
```

This method also installs a **skill** that teaches Claude when and how to use Apple Photos effectively.

A few things to know about the plugin install:

- The plugin is a git clone under `~/.claude/plugins/marketplaces/apple-photos-mcp/`, and the server runs straight from that clone (no build step needed).
- The **first tool call auto-bootstraps a Python venv** with `osxphotos` *inside that clone* — a one-time, ~minute-long setup that requires **Python 3.11+ on your PATH** (stock macOS ships 3.9; `brew install python@3.12`).
- **Full Disk Access must be granted to the HOST app** running Claude Code (Terminal, iTerm, VS Code, Claude Desktop) — see [Requirements](#requirements) below.

### Using the Codex Marketplace

The same plugin is available for Codex. Add the marketplace and install the plugin:

```bash
codex plugin marketplace add sweetrb/apple-photos-mcp
codex plugin add apple-photos@apple-photos-mcp
```

The Codex plugin runs the published `apple-photos-mcp` server through `npx` and ships the same Apple Photos skill, so behavior matches the Claude Code plugin. Because the server is a Python-sidecar (osxphotos) server, the first tool call after an `npx` launch auto-bootstraps a project-local Python venv with `osxphotos` (a one-time, ~minute-long setup), and the host process still needs Full Disk Access — see [Requirements](#requirements) below.

### Other Hosts (Hermes, Antigravity)

Configuration for two more hosts is included — each registers the same `apple-photos` MCP server (`npx -y apple-photos-mcp`). As a Python-sidecar (osxphotos) server it also needs Full Disk Access; see [Requirements](#requirements).

- **[Hermes Agent](https://hermes-agent.nousresearch.com/)** (NousResearch) — Hermes has no plugin/marketplace drop-in. Add the server with `hermes mcp add apple-photos --command npx --args -y apple-photos-mcp`, or merge [`.hermes-plugin/config.yaml`](https://github.com/sweetrb/apple-photos-mcp/blob/main/.hermes-plugin/config.yaml) into `~/.hermes/config.yaml`. Details: [`.hermes-plugin/README.md`](https://github.com/sweetrb/apple-photos-mcp/blob/main/.hermes-plugin/README.md).
- **[Antigravity](https://antigravity.google/)** (Google) — add the server entry from [`.antigravity-plugin/mcp_config.json`](https://github.com/sweetrb/apple-photos-mcp/blob/main/.antigravity-plugin/mcp_config.json) to `~/.gemini/config/mcp_config.json` (or via Antigravity's MCP settings).

### Manual Installation

**1. Install the server:**
```bash
npm install -g apple-photos-mcp
```

**2. Python deps install automatically.** The first tool call auto-bootstraps a project-local Python venv with `osxphotos` (a one-time setup that can take ~a minute; progress is logged to stderr). You do **not** need to install anything by hand.

To skip the first-call delay, you can pre-warm the venv ahead of time:
```bash
pnpm run setup   # optional — pre-installs osxphotos so the first tool call is instant
```
Auto-setup needs Python 3, `pip`, and network access. If any are missing — or you disabled auto-setup via `APPLE_PHOTOS_MCP_NO_AUTO_SETUP=1` — run `pnpm run setup` (or `pip3 install osxphotos`) yourself. See [Configuration](#configuration) and [Troubleshooting](#troubleshooting).

**3. Add to Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "apple-photos": {
      "command": "npx",
      "args": ["apple-photos-mcp"]
    }
  }
}
```

**4. Grant Full Disk Access** to the app hosting the MCP server (Claude Desktop, Terminal, VS Code, etc.) — see [Full Disk Access](#full-disk-access) below.

**5. Restart Claude Desktop** and start using natural language:
```
"How many photos are in my library?"
```

## Requirements

- **macOS** - The Photos library is macOS-only
- **Node.js 20+** - Required for the MCP server
- **Python 3.11+** - The server uses [osxphotos](https://github.com/RhetTbull/osxphotos) under the hood and **installs it automatically on first use** into a project-local venv (one-time, ~a minute). You only need Python 3.11+, `pip`, and a network connection available. osxphotos requires Python ≥ 3.10 and the date filters need 3.11; macOS ships 3.9, so install a newer Python first (e.g. `brew install python@3.12`). Pre-warm it with `pnpm run setup` if you'd rather not wait on the first call.
- **Apple Photos** - Must have a Photos library (default location: `~/Pictures/Photos Library.photoslibrary`)
- **Full Disk Access** - The Photos library lives in a protected directory. The host app needs Full Disk Access — see [below](#full-disk-access) and the [Full Disk Access Setup Guide](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/FULL-DISK-ACCESS.md).

## Features

### Querying

| Feature | Description |
|---------|-------------|
| **Library Stats** | Total counts of photos, movies, albums, folders, keywords, persons |
| **Query** | Search by taken-date or import-date range (`addedInLast: "7d"` for "recently imported"), album, keyword, person, ML label, place name, GPS radius (`near`), folder, year, file size, media type (screenshot, screen recording, selfie, panorama, live, portrait, time-lapse, slow-mo, burst), aesthetic score (`minScore`), OCR-detected text (`detectedText`), favorite/hidden flags, or title/description substring — with `newestFirst` ordering |
| **Photo Details** | Full metadata for one photo: dimensions, location, place, EXIF camera data (make/model, lens, ISO, aperture, shutter speed, focal length), Photos' ML intelligence (aesthetic `score`, OCR `detectedText`), shared-album social data (owner, comments, likes), optional burst-sibling expansion, and type flags (HDR, live, portrait, panorama, raw, edited, etc.) |
| **Batch Details** | `get-photos` fetches full metadata for up to 50 UUIDs in one call |
| **Selection Bridge** | `get-selected-photos` returns the photos currently selected in the Photos.app window — "act on *these* photos" |
| **Thumbnails** | `get-thumbnail` returns a photo as an inline viewable image (MCP image content block) from Photos' pre-generated derivatives — see photos without exporting |
| **Find Duplicates** | `find-duplicates` groups exact duplicates using Photos' own fingerprint detection |
| **List Albums** | All albums with their folder paths and photo counts |
| **List Folders** | All folders with parent and album/subfolder counts |
| **List Keywords** | Keywords sorted by usage count |
| **List Persons** | People detected by Photos face recognition, sorted by photo count |

### Export

| Feature | Description |
|---------|-------------|
| **Export Originals** | Copy original photos to a destination directory |
| **Export Edited** | Copy the edited version instead of the original |
| **Live Photos** | Optionally include the live-photo video alongside the still |
| **Raw Files** | Optionally include the raw (NEF, CR2, etc.) sidecar |
| **Multi-photo Export** | Export multiple UUIDs in a single call |
| **Auto iCloud Download** | If an original isn't on disk, export falls back to Photos.app to download it on demand — no extra parameter needed |

### Write tools (opt-in — read-only by default)

| Feature | Description |
|---------|-------------|
| **Create Album** | `create-album` creates an album (optionally nested in a folder path); idempotent — an existing album of that name is returned instead of duplicated |
| **Add to Album** | `add-to-album` files photos (by UUID) into an album; idempotent, reports added / already-present / not-found per UUID |
| **Remove from Album** | `remove-from-album` takes photos out of an album — never out of the library (see [the caveats](#write-tools-opt-in)) |
| **Set Metadata** | `set-photo-metadata` sets title / description / favorite, echoing before/after values so changes can be reverted |
| **Set Keywords** | `set-keywords` adds/removes keywords with **union semantics** — existing keywords you don't mention are always preserved |
| **Set Date** | `set-photo-date` fixes a photo's date/time (absolute or shifted by seconds) — **dry run by default**, with before/after echoed for reverts; Photos-library date only, EXIF untouched |
| **Import** | `import-photos` brings files into the library (optionally into an existing album) — add-only, with source paths validated against the same allowlist as export |

All seven are **disabled unless `APPLE_PHOTOS_MCP_ENABLE_WRITES=1`** — see [Write tools (opt-in)](#write-tools-opt-in). None of them can delete a photo.

### Diagnostics

| Feature | Description |
|---------|-------------|
| **Health Check** | Verify osxphotos is installed and the library can be opened |
| **Doctor** | Richer setup diagnostic — six checks: Python interpreter (path + version), osxphotos install, sidecar mode (persistent vs one-shot fallback), the write-tools gate (enabled/disabled + backend readiness), Photos library readability, and Full Disk Access, each reported ok / warn / fail with actionable advice |

Read tools also return **structured JSON** (`structuredContent`) alongside the human-readable text, so agents can consume results without parsing prose.

### MCP resources & prompts

Resources expose read-only context the client can attach without a tool call:
`photos://library`, `photos://albums`, `photos://persons`, `photos://keywords`,
and the `photos://photo/{uuid}` template (full metadata for one photo). Prompts
package common workflows: `find-photos`, `export-photos`, `photo-summary`.

---

## Write tools (opt-in)

**The server is read-only by default — nothing changes for existing users.** Version 2.0.0 added five tools that can modify the Photos library (`create-album`, `add-to-album`, `remove-from-album`, `set-photo-metadata`, `set-keywords`), and 2.1.0 adds two more (`set-photo-date`, `import-photos`) behind the same gate. Every one of them is refused with a clear error until you opt in:

**Enable via environment variable** (e.g. in your MCP server config's `env` block, where the host honors it):

```json
{ "env": { "APPLE_PHOTOS_MCP_ENABLE_WRITES": "1" } }
```

**Or via the config file** (recommended for Claude Desktop, which strips `env`) — `~/Library/Application Support/apple-photos-mcp/config.json`:

```json
{
  "APPLE_PHOTOS_MCP_ENABLE_WRITES": "1"
}
```

Then **restart the MCP server** (restart the host app, or the conversation in hosts that spawn per-conversation servers). The `doctor` tool reports the gate state either way — run it first if a write tool returns "Write tools are disabled".

The write tools stay **registered** even while disabled (MCP clients cache the tool list at startup, so hiding them would only hurt discoverability — a gated call returns the exact opt-in recipe instead).

### Safety design

- **No deletion, ever.** There is deliberately no tool that deletes a photo, an album, or a folder. `remove-from-album` changes album *membership* only — the photos stay in All Photos and every other album. For actual deletion, quarantine photos into an album (the [dedupe pattern](#duplicate-cleanup)) and delete inside Photos.app, where Recently Deleted gives you a 30-day safety net. The same no-delete rule cuts the other way for `import-photos`: an import **cannot be programmatically undone** (Photos' AppleScript has no photo-delete verb), so removing a mistaken import is a by-hand operation in Photos.app.
- **Explicit targets only.** Every write takes explicit UUIDs, names, or file paths — there are no wildcard/all-photos operations, and every target is validated to exist before anything is modified (unknown UUIDs come back as clear errors or per-UUID `notFound` lists; import source paths must exist under the same allowlist roots as export).
- **Bounded batches.** Album operations accept at most 100 UUIDs per call; imports at most 50 files.
- **Reversible by design.** Metadata writes echo before/after values so an agent can revert; `set-keywords` uses union semantics (read-merge-write) so keywords you don't mention are never clobbered; album adds are idempotent; `set-photo-date` is a **dry run by default** — it writes nothing until you pass `dryRun: false`, and always echoes before/after so an applied change can be reverted.
- **The mechanism:** writes drive **Photos.app via AppleScript** (the [photoscript](https://github.com/RhetTbull/photoscript) library). Photos is launched if it isn't running, and macOS asks for **Automation permission** for the host app with a one-time system prompt on the first write. Writes always target the library **currently open in Photos.app** (normally the system library) — the `library` parameter of the read tools does not apply. (Reads, by contrast, go through osxphotos straight to the Photos database — fast and prompt-free. Why writes *can't* use that same path — and why osxphotos/PhotoKit aren't an escape from AppleScript — is spelled out in [docs/WRITE-BACKEND.md](docs/WRITE-BACKEND.md).)
- **One quirk to know:** Photos' AppleScript dictionary has no "remove from album" verb, so `remove-from-album` **rebuilds the album** (same name, remaining photos): the album's UUID changes (the response reports old and new) and any custom manual sort order is lost.

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Discovery

#### `health-check`

Verify osxphotos is installed and the Photos library can be opened.

**Parameters:** None

**Returns:** osxphotos version, library path, and total photo count — or an error if the library is inaccessible.

---

#### `doctor`

Run a full setup diagnostic: the resolved Python interpreter (path + version — warns when it's older than the required 3.11, with `brew install python@3.12` advice), osxphotos installation, Photos library readability, and Full Disk Access — each reported as ok / warn / fail with an actionable message. This is the richer counterpart to `health-check`; reach for it first when a tool returns a permission or "unable to open" error.

**Parameters:** None

**Returns:** A per-check report. The `structuredContent` carries the raw `{ healthy, checks[] }`, where each check has `name`, `status` (`ok`/`warn`/`fail`), and `detail`. The Full Disk Access check explicitly reports whether the host process can read the library — see [Full Disk Access](#full-disk-access).

---

#### `library-info`

High-level stats about the Photos library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | string | No | Path to a non-default `.photoslibrary` (defaults to system library) |

**Returns:** Library path, Photos DB version, Photos.app version, counts of photos / movies / albums / folders / keywords / persons.

---

### Query

#### `query`

Search the library with combinable filters. Returns photo summaries with UUIDs — use `get-photo` for full details on a specific match.

For the full filter syntax — accepted date forms, AND/OR combination semantics, exact-vs-substring matching, result ordering, and what is **not** filterable — see the **[Query Guide](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/QUERY-GUIDE.md)**.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string[] | No | Specific UUIDs to fetch (max 1000 entries, each ≤ 256 chars) |
| `album` | string[] | No | Album name(s); ANY-match, exact full folder path + name (max 100 entries) |
| `keyword` | string[] | No | Keyword(s); ANY-match, exact whole-string (max 100 entries) |
| `person` | string[] | No | Person name(s); ANY-match, exact whole-string (max 100 entries) |
| `fromDate` | string | No | ISO 8601 **inclusive** lower bound on photo date (e.g. `"2025-06-01"`) |
| `toDate` | string | No | ISO 8601 upper bound on photo date. A bare date (e.g. `"2025-06-30"`) includes that whole day; a full datetime (e.g. `"2025-06-30T18:00:00"`) is a precise exclusive bound |
| `favorite` | boolean | No | Only favorites |
| `notFavorite` | boolean | No | Exclude favorites |
| `hidden` | boolean | No | Only hidden photos |
| `notHidden` | boolean | No | Exclude hidden photos (default behavior) |
| `photos` | boolean | No | Include still photos |
| `movies` | boolean | No | Include movies |
| `title` | string | No | Substring match on title (case-sensitive, ≤ 1024 chars) |
| `description` | string | No | Substring match on description (case-sensitive, ≤ 2048 chars) |
| `addedAfter` | string | No | ISO 8601 **inclusive** lower bound on IMPORT date (`dateAdded` — when the photo entered the library, not when it was taken) |
| `addedBefore` | string | No | ISO 8601 upper bound on import date; a bare date includes that whole day |
| `addedInLast` | string | No | Imported within a trailing window — `"<number><unit>"`, unit `s`/`m`/`h`/`d`/`w` (e.g. `"7d"`, `"24h"`) |
| `label` | string[] | No | ML classification label(s) Photos computed (the `labels` field of `get-photo`, e.g. `Dog`, `Beach`); ANY-match, exact whole-string (max 100) |
| `folder` | string[] | No | Folder name(s)/path(s) — photos in albums inside the folder; ANY-match (max 100) |
| `place` | string[] | No | Place-name substring(s) from reverse geocoding (city, region, landmark). **Multiple values are ANDed**, not ORed (max 100) |
| `hasLocation` | boolean | No | `true` = only photos WITH GPS coordinates; `false` = only photos WITHOUT; omit for no filter |
| `near` | string | No | GPS-radius filter: `"lat,lon,radiusKm"` (e.g. `"46.5,-87.4,5"`) — only photos within the great-circle radius of the point. Composes (AND) with every other filter; photos without GPS data never match |
| `year` | number[] | No | Taken in calendar year(s); ANY-match (max 100) |
| `minSize` | number | No | Original file size at least this many bytes |
| `maxSize` | number | No | Original file size at most this many bytes |
| `noKeyword` | boolean | No | Only photos carrying no keyword at all |
| `burst` | boolean | No | Only burst photos |
| `screenshot` / `screenRecording` / `selfie` / `panorama` / `live` / `portrait` / `timelapse` / `slowMo` | boolean | No | Media-type filters — each `true` narrows to only that type |
| `video` | boolean | No | Only videos/movies (alias of `movies`) |
| `minScore` | number | No | Only photos whose Photos-computed overall **aesthetic score** (0–1) is at least this (e.g. `0.7` for "the good ones"). Post-filter; photos without a computed score never match |
| `detectedText` | string | No | Case-insensitive substring over the text Photos' own **OCR** indexed per photo (macOS 13+) — receipts, signs, screenshots. Post-filter that reads per-photo search info, so combine with narrowing filters on big libraries |
| `newestFirst` | boolean | No | Sort by taken date, newest first, **before** `limit` is applied — so `limit` means "the N most recent matches" |
| `limit` | number | No | Cap the number of results returned (default `500` when omitted, max `100000`) |
| `library` | string | No | Path to a non-default `.photoslibrary` |

Exceeding a cap rejects the call at the input schema, before the library is opened — chunk larger UUID batches across multiple calls.

**Example - Recent favorites of Sarah:**
```json
{
  "person": ["Sarah"],
  "favorite": true,
  "fromDate": "2025-06-01",
  "limit": 50
}
```

**Example - Sunset keyword across two albums:**
```json
{
  "keyword": ["sunset"],
  "album": ["Vacation 2024", "Beach Trips"]
}
```

**Example - The 20 most recent imports:**
```json
{
  "addedInLast": "7d",
  "newestFirst": true,
  "limit": 20
}
```

**Example - 2024 screenshot cleanup candidates:**
```json
{
  "screenshot": true,
  "year": [2024]
}
```

**Example - The best shots taken near the cabin:**
```json
{
  "near": "46.51,-87.42,5",
  "minScore": 0.6,
  "newestFirst": true,
  "limit": 20
}
```

**Returns:** `count` (the **total** number of matches), `returned` (the number of summaries in this response — capped at `limit`, default 500), and photo summaries (UUID, filename, date, dimensions, favorite/hidden flags, albums, keywords, persons).

---

#### `get-photo`

Get full metadata for a single photo by UUID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Photo UUID, as returned by `query` (hexadecimal segments separated by dashes, max 256 chars — anything else is rejected before the library is even opened) |
| `burstPhotos` | boolean | No | `true` = also return `burstPhotos`: the **other** frames of this photo's burst set (UUID, filename, date each; empty when the photo isn't a burst member) |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Example:**
```json
{
  "uuid": "33AC0410-D367-43AE-A839-12C7EF482020"
}
```

**Returns:** All metadata for the photo: dimensions, original dimensions, dates (taken/added/modified), title, description, location (lat/lon), place (name/country), albums, keywords, persons, labels, an `exif` object (camera make/model, lens, ISO, aperture, shutter speed, focal length, exposure bias, flash, and duration/fps/codec for video — `null` when Photos recorded no EXIF, e.g. manufacturer-app uploads and scans), Photos' ML intelligence (`score` — the overall aesthetic score 0–1; `detectedText` — the text Photos' OCR indexed, macOS 13+; both `null` on library versions without them), iCloud shared-album social data (`owner`, `comments`, `likes` — only populated for shared assets), type flags (HDR / live / raw / edited / portrait / panorama / selfie / screenshot / slow-mo / time-lapse / burst), file paths (original, edited, raw, live-photo video), file size, UTI.

**Recently Deleted:** `get-photo` falls back to the trash, so it returns full metadata even for a photo sitting in Recently Deleted. `query` and `export` read the main library only — so a UUID that `get-photo` resolves may return nothing from `query`, and `export` will skip it with reason `UUID not found (deleted or in trash)`.

---

#### `get-photos`

Get full metadata for a **batch** of photos (up to 50) in one call — the batch equivalent of `get-photo`, for dedupe reviews, EXIF audits, and captioning passes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string[] | Yes | 1–50 photo UUIDs, as returned by `query` (same hex-with-dashes format as `get-photo`) |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Example:**
```json
{
  "uuid": [
    "33AC0410-D367-43AE-A839-12C7EF482020",
    "1EB2B765-0765-43BA-A90C-0F0AE547B343"
  ]
}
```

**Returns:** `count`, `photos` (full per-photo detail — the same shape as `get-photo`, including the `exif` object, `score`, `detectedText`, shared-album `owner`/`comments`/`likes`, and the Recently-Deleted fallback), and `notFound` listing any requested UUIDs that matched nothing. Unknown UUIDs never fail the batch.

---

#### `get-selected-photos`

Get the photos **currently selected in the Photos.app window** — the bridge from "act on *these* photos" to UUIDs you can feed into `get-photos`, `get-thumbnail`, `export`, or `add-to-album`.

No parameters.

**Requirements & behavior:**
- Photos.app must be **running with a visible selection**; the tool returns a clear error otherwise, and **never launches Photos itself**.
- Read-only and **not** gated behind the writes flag, but it reads the selection over AppleScript, so the host app needs macOS **Automation permission** for Photos (one-time system prompt on first use).
- The selection comes from the library currently open in Photos.app; there is no `library` parameter.

**Returns:** `count`, `photos` (the same summary shape as `query` results — UUID, filename, date, dimensions, flags), and `notFound` for selected items the library index doesn't know yet (e.g. a just-finished import Photos hasn't checkpointed — reported with their filenames).

---

#### `get-thumbnail`

Return one photo as an **inline viewable image** — an MCP image content block (base64 JPEG/PNG) that vision-capable clients render directly. Serves the preview derivatives Photos has already generated, so nothing is exported and originals aren't transferred. Prefer this over `export` whenever the goal is to *look at* a photo rather than to obtain the file.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Photo UUID, as returned by `query` |
| `minSize` | number | No | Smallest acceptable long-edge size in pixels (default `360`, max `8192`). The smallest qualifying derivative is served — raise it (e.g. `1024`) when you need detail like small text |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** An image content block plus structured metadata: `uuid`, source `path`, `width`/`height`, `mimeType`, `byteSize`, and `isDerivative` (`false` means no suitable derivative existed and the image was rendered from the original via `sips` — never upscaled). Movies get a thumbnail only when Photos generated a poster-frame derivative; an iCloud-only photo with no local derivative or original returns an error suggesting `export` (which downloads on demand).

---

#### `find-duplicates`

Group **exact duplicates** using Photos' own fingerprint-based detection — the same data behind Photos' Duplicates album, no export or hashing required.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Max duplicate groups to return (default `100`; `groupCount` reports the total) |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** `groupCount` (total groups), `returned`, and `groups` ordered newest-first — each with the member `uuids` and per-member `filename`, `date`, `size`, `width`/`height`, and `isMovie`. Hidden and Recently-Deleted photos are never group members.

**Exact means exact:** the fingerprint matches identical image data only — edited copies, resized versions, and burst siblings will NOT group. Use `get-thumbnail` on a group's members to eyeball them before acting. This server cannot delete photos (Photos exposes no scriptable delete) — to act on duplicates, collect them into a quarantine album in Photos.app and review/delete there.

---

### Browse

#### `list-albums`

List all albums in the library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** Each album's title, folder path, photo count, shared status, and UUID. iCloud Shared Albums are included and flagged `isShared: true`.

---

#### `list-folders`

List all folders in the library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** Each folder's title, parent folder, album count, and subfolder count.

---

#### `list-keywords`

List keywords sorted by usage count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Cap to top-N keywords |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** Keywords with their photo counts, sorted descending.

---

#### `list-persons`

List people detected by Photos face recognition, sorted by photo count.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Cap to top-N persons |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** Persons with their photo counts, sorted descending. Unidentified faces appear as `_UNKNOWN_`.

---

### Export

#### `export`

Export one or more photos by UUID to a destination directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string[] | Yes | Photo UUID(s) to export (1–1000 entries, each ≤ 256 chars) |
| `dest` | string | Yes | Destination directory (created if missing). Must resolve — after expanding `~` and following symlinks — to a path under your **home directory**, **/tmp**, **/private/tmp**, or **/Volumes**; anything else is rejected |
| `edited` | boolean | No | Export the edited version instead of the original |
| `live` | boolean | No | Also export the live-photo video |
| `raw` | boolean | No | Also export the raw image |
| `overwrite` | boolean | No | Overwrite existing files at the destination. Without it, a photo whose file already exists is **skipped** (reported per-UUID) — never duplicated |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Example - Originals to a folder:**
```json
{
  "uuid": ["33AC0410-...", "EEFCEF1D-..."],
  "dest": "~/Desktop/exports"
}
```

**Example - Edited versions plus raw and live-photo video:**
```json
{
  "uuid": ["33AC0410-..."],
  "dest": "~/Desktop/exports",
  "edited": true,
  "raw": true,
  "live": true,
  "overwrite": true
}
```

**Returns:** Destination path, count of files exported, count skipped, list of exported file paths, and a per-UUID reason for every skip (file already exists, UUID not found / in Recently Deleted, iCloud download failed, ...). Every requested UUID is accounted for in `exported` + `skipped`. Note that `export` reads the main library only: a photo in Recently Deleted is skipped with `UUID not found (deleted or in trash)` even though `get-photo` still resolves it (that tool falls back to the trash).

**Destination allowlist:** the destination is canonicalized (leading `~` expanded, `..` normalized, symlinks resolved — including a not-yet-existing final directory) and must land under the home directory, `/tmp`, `/private/tmp`, or `/Volumes`. The check is segment-aware (`/Volumesx` does not pass as `/Volumes`), and the canonical path is what's exported into, so a symlink under an allowed root can't redirect the write outside it.

**Filename collisions:** Files keep the photo's original filename. If a file of that name already exists at the destination and `overwrite` is not set, the photo is skipped with reason `already exists at destination` — re-running an export never creates `IMG_1234 (1).jpg`-style duplicates. Pass `overwrite: true` to replace in place.

**iCloud-only originals:** If a photo's original isn't on disk (Photos is using "Optimize Mac Storage"), the export automatically falls back to Photos.app via AppleScript, which downloads the original on demand — same behavior as opening the photo in Photos. This is slower than a direct file copy; expect waits proportional to download size for large batches. Photos that genuinely can't be exported (e.g. `edited=true` requested but no edits exist) are still skipped with a per-UUID reason.

**Progress notifications:** For batch exports, the server emits one MCP progress notification per photo (`progress`/`total` plus a `message` naming the file being exported) when the client's request includes a `progressToken` — so hosts that surface progress can show a live counter instead of a silent multi-minute call. Clients that don't send a token simply get the final result, as before. (Progress requires the persistent sidecar; in the rare one-shot fallback mode the export still works but reports no intermediate progress.)

### Write (opt-in — see [Write tools](#write-tools-opt-in))

All five tools below require `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` and return a clear opt-in error otherwise. They drive Photos.app via AppleScript (macOS Automation permission; Photos is launched if needed), always target the library currently open in Photos.app (no `library` parameter), and can never delete photos.

#### `create-album`

Create an album — or return the existing one of that name (`created: false`), so re-running a filing workflow never piles up duplicates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Album name (≤ 255 chars) |
| `folder` | string | No | Folder path to nest the album under, `/`-separated for nesting (e.g. `"Trips/2026"`); folders are created as needed. (Folder names containing a literal `/` are not addressable.) |

**Returns:** `album {uuid, name, path}` and `created`. Without `folder`, the idempotency check matches an album of that name anywhere in the library; with `folder`, only inside that folder.

#### `add-to-album`

Add photos (by UUID) to an album (by name or UUID). Idempotent — Photos albums are sets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album` | string | Yes | Album name or UUID (UUID-looking values try the id lookup first, then fall back to a name match) |
| `uuid` | string[] | Yes | Photo UUID(s) to add (1–100) |

**Returns:** `album {uuid, name, path}`, `addedCount`, `added`, `alreadyPresent` (members already in the album), and `notFound` (UUIDs that don't exist in the library). Fails only when the album doesn't exist or *no* requested photo exists.

#### `remove-from-album`

Remove photos from an album — **never from the library** (they remain in All Photos and every other album).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `album` | string | Yes | Album name or UUID |
| `uuid` | string[] | Yes | Photo UUID(s) to remove from the album (1–100) |

**Returns:** the album *after* the operation, `removedCount`, `removed`, `notInAlbum` (requested UUIDs that weren't members — harmless no-ops), `albumRecreated`, and `previousAlbumUuid`.

**Album rebuild caveat:** Photos' AppleScript has no remove verb, so removal rebuilds the album (create replacement → copy the kept photos → delete the original → rename). The album's **UUID changes** (use `album.uuid` from the response) and custom manual sort order is lost. When none of the UUIDs are members, nothing is rebuilt (`albumRecreated: false`).

#### `set-photo-metadata`

Set a photo's title, description, and/or favorite flag. Only the fields you pass are touched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Photo UUID |
| `title` | string | No | New title (empty string clears it) |
| `description` | string | No | New description (empty string clears it) |
| `favorite` | boolean | No | Set or clear the favorite flag |

**Returns:** `uuid`, `updated` (which fields were written), and full `before` / `after` values of all three fields — revert a change by writing the `before` values back.

#### `set-keywords`

Add and/or remove keywords on a photo with **union semantics**: the photo's current keywords are read first and the edits merged in, so keywords you don't mention are always preserved — never a blind replace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Photo UUID |
| `add` | string[] | No | Keywords to add (≤ 100; created in Photos if new) |
| `remove` | string[] | No | Keywords to remove from this photo (≤ 100; exact match) |

At least one of `add` / `remove` is required; a keyword in both is rejected.

**Returns:** `uuid`, `before` / `after` keyword lists, `added` / `removed` (what actually changed — adding an existing keyword is a no-op), and `changed`. If the merge changes nothing, no write is performed.

#### `set-photo-date`

Fix a photo's date/time — set an absolute date or shift by a number of seconds. **Dry run by default**: nothing is written until you pass `dryRun: false`. This rewrites the date in the Photos **library database** only (the same thing Photos.app's *Adjust Date & Time* does) — the file's EXIF is never modified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Photo UUID |
| `date` | string | * | Absolute new date-time, ISO 8601 (e.g. `"2026-05-14T06:32:00"`), interpreted in the Mac's local timezone unless a UTC offset is included |
| `shiftSeconds` | number | * | Shift the current date by this many seconds (negative = earlier; `-86400` = one day back) |
| `dryRun` | boolean | No | **Default `true`** — preview the before/after dates without writing. Pass `false` to apply |

\* Exactly one of `date` / `shiftSeconds` is required.

**Returns:** `uuid`, `before`, `after` (the would-be date on a dry run), `shiftSeconds` (the effective delta), `applied`, and `dryRun`. Revert an applied change by re-running with `date` = the echoed `before` and `dryRun: false`.

#### `import-photos`

Import image/video files from disk into the Photos library, optionally straight into an **existing** album. Add-only: nothing is modified or deleted, and source files stay where they are (Photos copies them in).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | Yes | 1–50 absolute (or `~`-prefixed) file paths. Each must exist, under your home directory, `/tmp`, `/private/tmp`, or `/Volumes` |
| `album` | string | No | Existing album (name or UUID) to file the imports into — create it with `create-album` first; a missing album is an error, not auto-created |
| `skipDuplicateCheck` | boolean | No | Default `false`: Photos checks for duplicates, and a found duplicate raises a **blocking dialog in Photos.app** that a human must answer. `true` skips the check — duplicates WILL be re-imported silently |

**Returns:** `requestedCount`, `importedCount`, `imported` (`uuid` + `filename` per new item), and `album` when one was targeted. `importedCount < requestedCount` usually means Photos skipped duplicates.

**Cannot be undone programmatically:** Photos' AppleScript has no photo-delete verb, so removing a mistaken import means deleting it by hand in Photos.app.

---

## Usage Patterns

Getting `query` filters right (date forms, AND/OR semantics, exact-match rules, ordering, paging) is covered in the **[Query Guide](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/QUERY-GUIDE.md)**.

### Basic Workflow

```
User: "How many photos do I have?"
AI: [calls library-info]
    "You have 30,968 items: 30,435 photos and 533 movies across 46 albums..."

User: "Find my favorite sunset photos"
AI: [calls query with keyword=["sunset"], favorite=true]
    "Found 12 favorite sunset photos. Here are the most recent..."

User: "Tell me about the first one"
AI: [calls get-photo with uuid="..."]
    "Taken on 2025-09-14 at 19:47, in Big Sur..."
```

### Two-step: Query then Export

```
User: "Export all photos of Mollee from the beach to ~/Desktop/mollee-beach"
AI: [calls query with person=["Mollee"], keyword=["beach"]]
    "Found 109 photos."
AI: [calls export with the UUIDs and dest="~/Desktop/mollee-beach"]
    "Exported 109 files to ~/Desktop/mollee-beach."
```

### Seeing Photos: Query then Thumbnail

```
User: "Show me the best photo from Saturday"
AI: [calls query with fromDate/toDate for Saturday, newestFirst=true]
    "Found 14 photos from Saturday."
AI: [calls get-thumbnail on a few candidates — the images render inline]
    "This one of the lake at sunset is the standout..."
```

### Reviewing Recent Imports

```
User: "What came off the camera this week?"
AI: [calls query with addedInLast="7d", newestFirst=true, limit=20]
    "23 items imported in the last 7 days; here are the 20 newest..."

User: "Which of those have no keyword yet?"
AI: [calls query with addedInLast="7d", noKeyword=true]
    "9 of them are untagged."
```

### Duplicate Cleanup

```
User: "Do I have duplicate photos?"
AI: [calls find-duplicates]
    "312 groups of exact duplicates."
AI: [calls get-thumbnail on members of the first few groups to verify visually]
    "Each group is byte-identical — e.g. IMG_3588.HEIC appears twice..."
AI: "I can't delete photos (read-only) — collect one copy of each into a
     quarantine album in Photos.app and delete from there."
```

With [writes enabled](#write-tools-opt-in), the AI can build that quarantine album itself — the **album-quarantine pattern** (deletion still happens only in Photos.app, with its 30-day Recently Deleted safety net):

```
User: "Quarantine the duplicate extras for me."
AI: [calls create-album name="Duplicates — review & delete"]
AI: [calls add-to-album with every group's extra copies (keeping the best of each)]
    "312 extra copies are in 'Duplicates — review & delete'.
     Review the album in Photos.app and delete from there."
```

### Tagging and Filing (write tools)

```
User: "Tag this week's trailcam imports and file them into the Trailcam album"
AI: [calls query addedInLast="7d"] → UUIDs
AI: [calls create-album name="Trailcam"]        (idempotent — returns the existing album)
AI: [calls add-to-album album="Trailcam" uuid=[...]]
AI: [calls set-keywords per photo, add=["trailcam"]]
    "Filed 34 photos and tagged them 'trailcam' — existing keywords untouched
     (set-keywords merges, never replaces)."
```

### Fixing Wrong Dates (write tools — dry-run first)

```
User: "Those trailcam photos are stamped with the upload time, not the capture
       time. The strip in the image says 05/14/2026 06:32."
AI: [calls set-photo-date uuid=... date="2026-05-14T06:32:00"]         (dryRun defaults to TRUE)
    "Preview: 2026-07-09T21:14:03 → 2026-05-14T06:32:00. Apply?"
User: "Yes"
AI: [calls set-photo-date uuid=... date="2026-05-14T06:32:00" dryRun=false]
    "Done — and the response echoed the old date, so I can revert if needed."
```

Whole batches with the same clock offset shift with `shiftSeconds` instead of an absolute `date`. Only the Photos-library date changes — the file's EXIF is untouched (same as Photos.app's *Adjust Date & Time*).

### Acting on the Photos.app Selection

```
User: [selects six photos in Photos.app] "Add these to the Yearbook album"
AI: [calls get-selected-photos] → 6 UUIDs
AI: [calls add-to-album album="Yearbook" uuid=[...]]
    "Filed the 6 selected photos into Yearbook."
```

### Browsing Library Structure

```
User: "What are my top 10 keywords?"
AI: [calls list-keywords with limit=10]
    "Photo Stream (1561), Mollee (109), beach (109), 2015 Feb Keweenaw..."

User: "Who appears most in my photos?"
AI: [calls list-persons with limit=10]
    "Rita Sweet (29), Robert B Sweet (28), Jennifer Sweet (24)..."
```

### Targeting a Different Library

By default, all operations use the system Photos library. To work with a different `.photoslibrary`:

```
User: "Show albums in my old archive at /Volumes/Archive/Photos.photoslibrary"
AI: [calls list-albums with library="/Volumes/Archive/Photos.photoslibrary"]
    "32 albums in the archive..."
```

---

## Installation Options

### npm (Recommended)

```bash
npm install -g apple-photos-mcp
```

`osxphotos` installs automatically on the first tool call — no separate `pip3 install` needed.

### From Source (with Project-Local venv)

```bash
git clone https://github.com/sweetrb/apple-photos-mcp.git
cd apple-photos-mcp
pnpm install
pnpm run setup   # OPTIONAL — pre-builds ./venv with osxphotos; otherwise it's built on first use
pnpm run build
```

The `pnpm run setup` step is optional: if you skip it, the server auto-bootstraps the venv on the first tool call (one-time, ~a minute). Running it ahead of time just avoids that first-call delay.

You can also install straight from GitHub with `npm install -g github:sweetrb/apple-photos-mcp` — but this builds from source at install time (requires pnpm), so prefer the registry install above unless you specifically want an unreleased commit.

If installed from source, use this configuration:
```json
{
  "mcpServers": {
    "apple-photos": {
      "command": "node",
      "args": ["/path/to/apple-photos-mcp/build/index.js"]
    }
  }
}
```

The server prefers a project-local venv at `./venv/bin/python3` if present, and otherwise falls back to system `python3`. If neither has `osxphotos`, the server auto-builds the venv on first use (unless `APPLE_PHOTOS_MCP_NO_AUTO_SETUP=1`). The venv is also self-healing: it's picked up as soon as it exists — no server restart needed if you build or repair it while the server is running — and is rebuilt automatically if a package update changes its requirements.

#### Running from a clone in Claude Code (project-scope `.mcp.json`)

This repo ships a `.mcp.json` at its root so that, when you run `claude` from inside a clone, the server is registered automatically as a **project-scope** server — no manual config needed. Before launching, you must:

1. `pnpm run build` — compile the TypeScript to `build/index.js`.
2. `pnpm run setup` — *optional*; pre-builds the project-local venv at `./venv` with `osxphotos` (the server prefers `./venv/bin/python3`). Skip it and the server builds the venv on the first tool call.
3. **Grant Full Disk Access** to the app hosting Claude Code (Terminal, iTerm, VS Code, etc.) — the Photos library SQLite is in a protected directory and osxphotos reads it directly. See [Full Disk Access](#full-disk-access).

Then launch Claude Code from the repo directory and approve the server when prompted.

The entrypoint is written as:

```json
"args": ["${CLAUDE_PROJECT_DIR:-.}/build/index.js"]
```

`CLAUDE_PROJECT_DIR` is the variable Claude Code injects into a project/user-scoped server's environment, and it resolves to the repo root. **You must launch `claude` from inside the repo** for this to work — the bare `.` fallback is only a last resort and is *not* reliable, because it resolves against the launching process's working directory, not the repo.

> **Why not `${CLAUDE_PLUGIN_ROOT}`?** `CLAUDE_PLUGIN_ROOT` is set **only** for marketplace plugin installs, never for a project-scope clone, so it can't drive the clone workflow. Conversely, a plugin install can't use `CLAUDE_PROJECT_DIR` (in a plugin, that points at the *user's* project, not the plugin's own directory). Claude Code does **not** support nested defaults like `${CLAUDE_PLUGIN_ROOT:-${CLAUDE_PROJECT_DIR:-.}}`, so a single entrypoint string cannot serve both contexts. The two distribution paths are therefore decoupled: the **plugin** carries its own MCP config in `.claude-plugin/plugin.json` (using `${CLAUDE_PLUGIN_ROOT}`), while the root `.mcp.json` is dedicated to the **clone** workflow (using `${CLAUDE_PROJECT_DIR:-.}`). Because `plugin.json` declares its own `mcpServers`, the plugin does not also auto-load the root `.mcp.json`, so there is no double-registration.

> **Heads-up on scope precedence:** project-scope (`.mcp.json`) outranks user-scope. If you *also* have an `apple-photos` entry registered at user scope (e.g. an absolute path in `~/.claude.json`), the project-scope entry wins and the user-scope one is ignored entirely. Pick one — for local development on this repo, the project-scope `.mcp.json` is the intended source. To pin a specific local build instead, register it at **local** scope (`claude mcp add apple-photos -s local -- node /abs/path/build/index.js`), which outranks project scope.

---

## Full Disk Access

The Photos library SQLite database lives in a protected directory (`~/Pictures/Photos Library.photoslibrary/database/`). osxphotos reads this database directly — it does **not** go through Photos.app — so the host process needs **Full Disk Access**.

### How to Grant Full Disk Access

1. Open **System Settings** (or System Preferences on older macOS)
2. Go to **Privacy & Security > Full Disk Access**
3. Click the **+** button
4. Add the application that hosts the MCP server:
   - **Claude Desktop**: Add `/Applications/Claude.app`
   - **Terminal**: Add `/Applications/Utilities/Terminal.app`
   - **VS Code**: Add `/Applications/Visual Studio Code.app`
   - **iTerm**: Add `/Applications/iTerm.app`
5. Restart the application after granting access

### Verifying it worked

Run the **`doctor`** tool — it explicitly reports the **Full Disk Access** check (alongside the Python interpreter version, osxphotos install, and library readability) as ok / warn / fail, so it's the best way to confirm the grant took effect. `health-check` and `library-info` also work as a quick smoke test.

For the full why-and-how walkthrough, see the [Full Disk Access Setup Guide](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/FULL-DISK-ACCESS.md).

### Without Full Disk Access

The `health-check` tool will fail and report a permissions error, and `doctor`'s Full Disk Access check will report `fail`. No tool will be able to open the library.

---

## Configuration

All configuration is optional — the server works out of the box.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APPLE_PHOTOS_MCP_ENABLE_WRITES` | unset (**read-only**) | Set to `1` to enable the [write tools](#write-tools-opt-in) (`create-album`, `add-to-album`, `remove-from-album`, `set-photo-metadata`, `set-keywords`, `set-photo-date`, `import-photos`). Until then every write tool returns a clear opt-in error and the server cannot modify the library. Restart the server after changing it. |
| `APPLE_PHOTOS_MCP_MAX_BUFFER` | `104857600` (100 MB) | Max bytes captured from the Python sidecar's stdout. Raise it if a very large library/query is truncated; lower it to cap memory. |
| `APPLE_PHOTOS_MCP_TIMEOUT` | `60000` (60 s) | Default per-command timeout, in milliseconds, for the Python sidecar. The first (cold) call parses the whole Photos database, and on very large libraries (100k+ photos) that load alone can exceed 60 s — raise this if tools report "Operation timed out". `export` keeps its own 30-minute window. |
| `APPLE_PHOTOS_MCP_PERSISTENT_SIDECAR` | unset (persistent mode on) | Set to `0` (or `false`) to disable the long-lived serve-mode sidecar and spawn a fresh Python process per call (pre-1.4.0 behavior). Every call then re-pays the full library parse — only useful for debugging. |
| `APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS` | `300000` (5 min) | How long the persistent sidecar may sit idle before it's killed to free memory (a resident parsed library holds hundreds of MB for large libraries). The next call transparently respawns it, re-paying the one-time parse. `0` = never kill on idle. |
| `APPLE_PHOTOS_MCP_NO_AUTO_SETUP` | unset (auto-setup on) | Set to `1` (or any truthy value) to disable the automatic first-use venv bootstrap. With it on, you must run `pnpm run setup` (or `pip3 install osxphotos`) yourself. |
| `APPLE_PHOTOS_MCP_SETUP_TIMEOUT` | `300000` (5 min) | Max time, in milliseconds, the automatic venv bootstrap may run before it's aborted. Raise it on slow networks where the `osxphotos` install needs longer. Also bounds how long a second server instance waits on the cross-process setup lock for a concurrent bootstrap to finish (simultaneous first calls can't corrupt the venv). |
| `APPLE_PHOTOS_MCP_CONFIG_FILE` | `~/Library/Application Support/apple-photos-mcp/config.json` | Path to the JSON config file (see below). |

### Configuration file (when the host strips `env`)

Some host apps (e.g. Claude Desktop) launch the MCP server with a scrubbed
environment and ignore the `env` block in their server config, so there's no way
to pass `APPLE_PHOTOS_MCP_*` settings through it. In that case, put them in a JSON
file the host doesn't manage — `APPLE_PHOTOS_MCP_CONFIG_FILE`, or by default
`~/Library/Application Support/apple-photos-mcp/config.json`:

```json
{
  "APPLE_PHOTOS_MCP_MAX_BUFFER": "209715200",
  "APPLE_PHOTOS_MCP_ENABLE_WRITES": "1"
}
```

(The second line opts in to the [write tools](#write-tools-opt-in) — omit it to keep the server read-only.)

The server reads it at startup and merges values into the environment **without
overriding** anything already set there (so an explicit `env` still wins). This
is the recommended way to configure the server under Claude Desktop. Keep only
non-secret config here.

---

## Architecture

This package is a **TypeScript MCP server with a Python sidecar**:

- The MCP server (Node) speaks the Model Context Protocol over stdio.
- A bundled Python script (`src/utils/photos_reader.py`) uses `osxphotos` to read the Photos library and returns JSON.
- The sidecar runs as a **persistent process** (`photos_reader.py --serve`): the TypeScript side spawns it once on first use and sends it line-delimited JSON requests over stdin, behind a serial gate (exactly one request in flight at a time). The Node event loop stays free, so the server keeps answering MCP traffic (pings, `health-check`, `doctor`) even during a long `query` or a minutes-long iCloud `export`.
- If serve mode is unavailable (old script, broken environment), the server transparently falls back to spawning a fresh one-shot Python process per call — same results, same error messages, just slower. `doctor`'s `sidecar_mode` check reports which mode is active.

### Performance

Opening a Photos library is expensive: python startup + `import osxphotos` + a
full parse of the library database — about **4 seconds on a ~30k-photo
library**, and it grows with library size. The persistent sidecar pays that
cost **once**: the parsed library stays resident, and follow-up calls complete
in **milliseconds** (measured: ~4.5 s cold, then 6–160 ms warm on a 31k-photo
library). Freshness is preserved — before every request the sidecar checks the
library's `Photos.sqlite` modification time and re-parses automatically the
moment the library changes (an import, an edit, an album rename). An idle
sidecar is killed after `APPLE_PHOTOS_MCP_SIDECAR_IDLE_MS` (default 5 min) to
free memory, and the next call respawns it — so the ~4 s cost recurs only on
the first call after a quiet period or a library change.

This is the same TS + Python-sidecar pattern used by [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) for the `numbers-parser` Python library.

---

## Security and Privacy

- **Local only** — All operations happen locally via osxphotos. No data is sent to external servers.
- **Read-only by default** — the library is never modified unless you explicitly set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` (see [Write tools (opt-in)](#write-tools-opt-in)). Even with writes enabled, the tools are limited to album membership, photo metadata (titles, keywords, favorites, dates), and add-only imports — **nothing can delete a photo** — and every write requires explicit UUIDs/names/paths (no wildcard operations).
- **Exports write to disk** — `export` writes files to the destination directory you specify, and only into an allowlisted location: the destination must resolve (symlinks included) to a path under your home directory, `/tmp`, `/private/tmp`, or `/Volumes`. Confirm destinations before running on shared machines.
- **No credential storage** — The server doesn't store any passwords or authentication tokens.

---

## Known Limitations

For the full rundown — read-only scope, iCloud export caveats, face/album behavior, and library lag — see **[docs/LIMITATIONS.md](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/LIMITATIONS.md)**. For what `query` can and cannot filter by (and how), see **[docs/QUERY-GUIDE.md](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/QUERY-GUIDE.md)**. The summary below is the quick version.

| Limitation | Reason |
|------------|--------|
| macOS only | Apple Photos and osxphotos are macOS-specific |
| Read-only by default | osxphotos reads the Photos library directly; the [write tools](#write-tools-opt-in) are opt-in (`APPLE_PHOTOS_MCP_ENABLE_WRITES=1`) and limited to albums, metadata (incl. dates), and add-only imports |
| No photo deletion | Deliberate: no tool deletes photos, albums, or folders — quarantine into an album and delete in Photos.app |
| `remove-from-album` rebuilds the album | Photos' AppleScript has no remove verb — the album's UUID changes and manual sort order is lost |
| Writes target the open library | AppleScript talks to whatever library Photos.app has open — the `library` parameter applies to read tools only |
| Writes need Automation permission | Driving Photos.app via AppleScript triggers a one-time macOS Automation prompt for the host app |
| Full Disk Access required | The Photos library SQLite database is in a protected directory |
| iCloud-only export is slower | Originals that aren't on disk are downloaded on demand via Photos.app/AppleScript. The export still succeeds, but takes longer than a local copy and requires Photos.app to be installed and signed in to iCloud |
| Photos.app may lock the library | If Photos.app is mid-write, opening the library can fail; close Photos.app and retry |
| Person filter requires named faces | osxphotos cannot filter by unnamed/unrecognized faces |

---

## Troubleshooting

### The first tool call is slow / "setting up the Python venv" in the logs
- This is expected: it's the **one-time** automatic venv build (creating `./venv` and installing `osxphotos`). It can take ~a minute and logs progress to stderr. Subsequent calls are fast. Pre-warm with `pnpm run setup` to avoid it.
- If the build keeps hitting a timeout on a slow network, raise `APPLE_PHOTOS_MCP_SETUP_TIMEOUT` (milliseconds; default 5 min).

### "osxphotos not installed"
- **Most common cause: your `python3` is older than 3.11.** Stock macOS ships Python 3.9, which is too old for the automatic venv setup to succeed. Install a newer Python (`brew install python@3.12`), then simply retry the tool call — the venv rebuilds automatically.
- Auto-setup also can't run when `pip` or network access is unavailable, or when you set `APPLE_PHOTOS_MCP_NO_AUTO_SETUP=1`. Fix the missing piece (or unset the variable) and retry — or install by hand with `pip3 install osxphotos` (global) or `scripts/setup.sh` / `pnpm run setup` from a repo checkout (project-local venv).
- Run the `doctor` tool for a per-check diagnosis of what's missing.
- If you used a virtualenv, make sure it's the one at `./venv/` in the project directory.

### "Library not found" or permission errors
- Grant Full Disk Access to the host app — see [Full Disk Access](#full-disk-access).
- Verify the library path: default is `~/Pictures/Photos Library.photoslibrary`.

### Photo not found / "Photo not found: <uuid>"
- The UUID may be wrong — re-run `query` to get current UUIDs.
- The photo may have been permanently deleted from the library.
- **`export` says "UUID not found (deleted or in trash)" but `get-photo` returns the photo?** The photo is in **Recently Deleted**: `get-photo` falls back to the trash, while `query` and `export` read the main library only. Restore the photo in Photos.app to export it.

### Exports skip files with "missing"
- Since 0.1.3, the export auto-downloads iCloud-only originals via Photos.app, so this skip should be rare. If it still happens:
  - **"original not downloaded from iCloud (download attempt returned no files)"** — Photos.app couldn't fetch it. Check iCloud connectivity, that you're signed in, and that the photo isn't excluded by a Photos sync setting.
  - **"Photo does not have adjustments..."** — `edited=true` was requested but the photo has no edited version. Retry without that flag.
  - **"raw component not on disk (Photos.app fallback cannot fetch raw originals)"** — `raw=true` was requested but the raw file isn't downloaded locally. Retry without the flag, or download the original in Photos.app first (**File → Download Originals to this Mac**).

### "Write tools are disabled — apple-photos-mcp is read-only by default"
- Working as designed: the write tools require an explicit opt-in. Set `APPLE_PHOTOS_MCP_ENABLE_WRITES=1` in the server's environment or in `~/Library/Application Support/apple-photos-mcp/config.json`, then **restart the MCP server** — see [Write tools (opt-in)](#write-tools-opt-in).
- Run the `doctor` tool to confirm the gate state (its `writes` check reports enabled/disabled and, when enabled, whether the photoscript backend and Photos.app look usable).

### Write tools fail with an AppleScript / "not authorized" error
- The host app needs **macOS Automation permission** to control Photos.app. The first write normally triggers a one-time system prompt — click OK. If it was denied, re-enable it under **System Settings → Privacy & Security → Automation → (your host app) → Photos**, then retry.
- In headless contexts (no GUI session) the prompt can't be shown and the write fails with error `-1743`; run the first write from a normal GUI session once to grant it.
- Writes launch Photos.app if it isn't running — the first write after a reboot can take noticeably longer while Photos starts.

### Photos.app errors when running
- Closing Photos.app may resolve database-lock errors. osxphotos opens the library in read-only mode but still requires that no writer holds an exclusive lock.

### `apple-photos` server fails to connect when run from a clone
- **Launch `claude` from inside the repo directory** so `CLAUDE_PROJECT_DIR` resolves to the repo root. The bare `.` fallback resolves against the launching process's working directory, not the repo, and is unreliable.
- Run `pnpm run build` first — the entrypoint `${CLAUDE_PROJECT_DIR:-.}/build/index.js` won't exist until you compile.
- The `./venv` with `osxphotos` builds automatically on the first tool call; run `pnpm run setup` only to pre-warm it, or if you've set `APPLE_PHOTOS_MCP_NO_AUTO_SETUP=1`.
- Grant **Full Disk Access** to the host app (Terminal, iTerm, VS Code, etc.) — see [Full Disk Access](#full-disk-access).
- Run `claude mcp list` and check for conflicting scopes. Project-scope (`.mcp.json`) outranks user-scope; a stale user-scope `apple-photos` entry pointing at a bad path can mask the project-scope one. To pin a specific build, register it at **local** scope: `claude mcp add apple-photos -s local -- node /abs/path/build/index.js`.
- If the server shows as pending, approve the project-scope server when Claude Code prompts you.

---

## Development

```bash
pnpm install            # Install dependencies
pnpm run setup          # Create ./venv with osxphotos
pnpm run build          # Compile TypeScript
pnpm test               # Run unit tests
pnpm run test:integration  # Run integration tests against the real Photos library
pnpm run test:all       # Unit + integration
pnpm run test:coverage  # Unit tests with coverage report
pnpm run typecheck      # Type-check without emitting
pnpm run lint           # Check code style
pnpm run format         # Format code
```

The Python sidecar is a thin CLI that the TypeScript layer shells out to:

```bash
./venv/bin/python3 src/utils/photos_reader.py library-info
./venv/bin/python3 src/utils/photos_reader.py query --keyword sunset --limit 5
./venv/bin/python3 src/utils/photos_reader.py export --uuid <uuid> --dest /tmp/out
```

---

## Author

**Rob Sweet** - President, [Superior Technologies Research](https://www.superiortech.io)

A software consulting, contracting, and development company.

- Email: rob@superiortech.io
- GitHub: [@sweetrb](https://github.com/sweetrb)

## License

MIT License - see [LICENSE](https://github.com/sweetrb/apple-photos-mcp/blob/main/LICENSE) for details. This project is not affiliated with Apple Inc. or the [osxphotos](https://github.com/RhetTbull/osxphotos) project.

## Contributing

Contributions are welcome! Please open an issue or PR at [github.com/sweetrb/apple-photos-mcp](https://github.com/sweetrb/apple-photos-mcp).

## Related Projects

Part of a family of macOS MCP servers:

- [apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp) — MCP server for Apple Mail (read, search, send, and organize email)
- [apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) — MCP server for Apple Notes (create, search, update, and export notes)
- [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) — MCP server for Apple Numbers (read and write .numbers spreadsheets)
- [osxphotos](https://github.com/RhetTbull/osxphotos) — The Python library that powers this server

## Recurring macOS permission prompts

If macOS keeps re-prompting for Full Disk Access or Automation for `node` (often after a `brew upgrade`), see [docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md](https://github.com/sweetrb/apple-photos-mcp/blob/main/docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md) — the fix is to run this server under the official, Developer-ID-signed Node so the grant survives Node updates.
