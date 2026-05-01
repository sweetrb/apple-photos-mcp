# Apple Photos MCP Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants like Claude to query and export from the macOS Apple Photos library, backed by the [osxphotos](https://github.com/RhetTbull/osxphotos) library.

[![npm version](https://img.shields.io/npm/v/apple-photos-mcp)](https://www.npmjs.com/package/apple-photos-mcp)
[![CI](https://github.com/sweetrb/apple-photos-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sweetrb/apple-photos-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> **Read-only against the Photos library.** Exports write files to a directory you choose, but the library itself is never modified.

## What is This?

This server acts as a bridge between AI assistants and Apple Photos. Once configured, you can ask Claude (or any MCP-compatible AI) to:

- "Find all my photos from our trip to Spain in 2023"
- "Show me my favorite sunset photos"
- "How many photos do I have? What are my top keywords?"
- "Find photos of Sarah from last summer and export them to ~/Desktop/sarah-summer"
- "List my albums"
- "Tell me everything about photo UUID ABC-123"

The AI assistant communicates with this server, which uses [osxphotos](https://github.com/RhetTbull/osxphotos) to read the Photos library SQLite database directly. All data stays local on your machine.

## Quick Start

### Using Claude Code (Easiest)

If you're using [Claude Code](https://claude.com/product/claude-code) (in Terminal or VS Code), just ask Claude to install it:

```
Install the sweetrb/apple-photos-mcp MCP server so you can help me query my Apple Photos library
```

Claude will handle the installation and configuration automatically. After install, you'll need to install `osxphotos` (Python) and grant Full Disk Access — see [Requirements](#requirements) below.

### Using the Plugin Marketplace

Install as a Claude Code plugin for automatic configuration and enhanced AI behavior:

```bash
/plugin marketplace add sweetrb/apple-photos-mcp
/plugin install apple-photos
```

This method also installs a **skill** that teaches Claude when and how to use Apple Photos effectively.

### Manual Installation

**1. Install the server:**
```bash
npm install -g github:sweetrb/apple-photos-mcp
```

**2. Install osxphotos** (the Python library this server depends on):
```bash
pip3 install osxphotos
```

Or, if you cloned the repo, run `npm run setup` to create a project-local Python venv with `osxphotos` pre-installed.

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
- **Python 3.9+ with osxphotos** - The server uses [osxphotos](https://github.com/RhetTbull/osxphotos) under the hood. Install via `pip3 install osxphotos` or via `npm run setup` if installing from source.
- **Apple Photos** - Must have a Photos library (default location: `~/Pictures/Photos Library.photoslibrary`)
- **Full Disk Access** - The Photos library lives in a protected directory. The host app needs Full Disk Access — see [below](#full-disk-access).

## Features

### Querying

| Feature | Description |
|---------|-------------|
| **Library Stats** | Total counts of photos, movies, albums, folders, keywords, persons |
| **Query** | Search by date range, album, keyword, person, favorite/hidden flags, photo/movie type, title/description substring |
| **Photo Details** | Full metadata for one photo: dimensions, location, place, EXIF-derived flags (HDR, live, portrait, panorama, raw, edited, etc.) |
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

### Diagnostics

| Feature | Description |
|---------|-------------|
| **Health Check** | Verify osxphotos is installed and the library can be opened |

---

## Tool Reference

This section documents all available tools. AI agents should use these tool names and parameters exactly as specified.

### Discovery

#### `health-check`

Verify osxphotos is installed and the Photos library can be opened.

**Parameters:** None

**Returns:** osxphotos version, library path, and total photo count — or an error if the library is inaccessible.

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

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string[] | No | Specific UUIDs to fetch |
| `album` | string[] | No | Album name(s); ANY-match |
| `keyword` | string[] | No | Keyword(s); ANY-match |
| `person` | string[] | No | Person name(s); ANY-match |
| `fromDate` | string | No | ISO 8601 lower bound on photo date (e.g. `"2025-06-01"`) |
| `toDate` | string | No | ISO 8601 upper bound on photo date |
| `favorite` | boolean | No | Only favorites |
| `notFavorite` | boolean | No | Exclude favorites |
| `hidden` | boolean | No | Only hidden photos |
| `notHidden` | boolean | No | Exclude hidden photos (default behavior) |
| `photos` | boolean | No | Include still photos |
| `movies` | boolean | No | Include movies |
| `title` | string | No | Substring match on title |
| `description` | string | No | Substring match on description |
| `limit` | number | No | Cap the number of results |
| `library` | string | No | Path to a non-default `.photoslibrary` |

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

**Returns:** Photo summaries (UUID, filename, date, dimensions, favorite/hidden flags, albums, keywords, persons).

---

#### `get-photo`

Get full metadata for a single photo by UUID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uuid` | string | Yes | Photo UUID |
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Example:**
```json
{
  "uuid": "33AC0410-D367-43AE-A839-12C7EF482020"
}
```

**Returns:** All metadata for the photo: dimensions, original dimensions, dates (taken/added/modified), title, description, location (lat/lon), place (name/country), albums, keywords, persons, labels, type flags (HDR / live / raw / edited / portrait / panorama / selfie / screenshot / slow-mo / time-lapse / burst), file paths (original, edited, raw, live-photo video), file size, UTI.

---

### Browse

#### `list-albums`

List all albums in the library.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `library` | string | No | Path to a non-default `.photoslibrary` |

**Returns:** Each album's title, folder path, photo count, shared status, and UUID.

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
| `uuid` | string[] | Yes | Photo UUID(s) to export (non-empty) |
| `dest` | string | Yes | Destination directory (created if missing) |
| `edited` | boolean | No | Export the edited version instead of the original |
| `live` | boolean | No | Also export the live-photo video |
| `raw` | boolean | No | Also export the raw image |
| `overwrite` | boolean | No | Overwrite existing files at the destination |
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

**Returns:** Destination path, count of files exported, count skipped, list of exported file paths, and any errors per UUID.

**iCloud-only originals:** If a photo's original isn't on disk (Photos is using "Optimize Mac Storage"), the export automatically falls back to Photos.app via AppleScript, which downloads the original on demand — same behavior as opening the photo in Photos. This is slower than a direct file copy; expect waits proportional to download size for large batches. Photos that genuinely can't be exported (e.g. `edited=true` requested but no edits exist) are still skipped with a per-UUID reason.

---

## Usage Patterns

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
npm install -g github:sweetrb/apple-photos-mcp
pip3 install osxphotos
```

### From Source (with Project-Local venv)

```bash
git clone https://github.com/sweetrb/apple-photos-mcp.git
cd apple-photos-mcp
npm install
npm run setup    # creates ./venv and installs osxphotos
npm run build
```

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

The server prefers a project-local venv at `./venv/bin/python3` if present, and otherwise falls back to system `python3`. This means a global npm install works as long as `osxphotos` is on the system Python.

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

### Without Full Disk Access

The `health-check` tool will fail and report a permissions error. No tool will be able to open the library.

---

## Architecture

This package is a **TypeScript MCP server with a Python sidecar**:

- The MCP server (Node) speaks the Model Context Protocol over stdio.
- A bundled Python script (`src/utils/photos_reader.py`) uses `osxphotos` to read the Photos library and returns JSON.
- The TypeScript side spawns the Python script via `child_process.execFileSync`.

This is the same pattern used by [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) for the `numbers-parser` Python library.

---

## Security and Privacy

- **Local only** — All operations happen locally via osxphotos. No data is sent to external servers.
- **Read-only** against the Photos library — the library is never modified.
- **Exports write to disk** — `export` writes files to the destination directory you specify. Confirm destinations before running on shared machines.
- **No credential storage** — The server doesn't store any passwords or authentication tokens.

---

## Known Limitations

| Limitation | Reason |
|------------|--------|
| macOS only | Apple Photos and osxphotos are macOS-specific |
| Read-only | osxphotos reads the Photos library; this server does not modify it |
| Full Disk Access required | The Photos library SQLite database is in a protected directory |
| iCloud-only export is slower | Originals that aren't on disk are downloaded on demand via Photos.app/AppleScript. The export still succeeds, but takes longer than a local copy and requires Photos.app to be installed and signed in to iCloud |
| Photos.app may lock the library | If Photos.app is mid-write, opening the library can fail; close Photos.app and retry |
| Person filter requires named faces | osxphotos cannot filter by unnamed/unrecognized faces |

---

## Troubleshooting

### "osxphotos not installed. Run: npm run setup"
- Run `pip3 install osxphotos` (global install) or `npm run setup` (project-local venv).
- If you used a virtualenv, make sure it's the one at `./venv/` in the project directory.

### "Library not found" or permission errors
- Grant Full Disk Access to the host app — see [Full Disk Access](#full-disk-access).
- Verify the library path: default is `~/Pictures/Photos Library.photoslibrary`.

### Photo not found / "Photo not found: <uuid>"
- The UUID may be wrong — re-run `query` to get current UUIDs.
- The photo may have been deleted from the library.

### Exports skip files with "missing"
- Since 0.1.3, the export auto-downloads iCloud-only originals via Photos.app, so this skip should be rare. If it still happens:
  - **"original not downloaded from iCloud (download attempt returned no files)"** — Photos.app couldn't fetch it. Check iCloud connectivity, that you're signed in, and that the photo isn't excluded by a Photos sync setting.
  - **"no edited version exists"** / **"no raw sidecar exists"** — `edited=true` or `raw=true` was requested but the photo doesn't have one. Retry without that flag.

### Photos.app errors when running
- Closing Photos.app may resolve database-lock errors. osxphotos opens the library in read-only mode but still requires that no writer holds an exclusive lock.

---

## Development

```bash
npm install         # Install dependencies
npm run setup       # Create ./venv with osxphotos
npm run build       # Compile TypeScript
npm test            # Run unit tests
npm run typecheck   # Type-check without emitting
npm run lint        # Check code style
npm run format      # Format code
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

MIT License - see [LICENSE](LICENSE) for details. This project is not affiliated with Apple Inc. or the [osxphotos](https://github.com/RhetTbull/osxphotos) project.

## Contributing

Contributions are welcome! Please open an issue or PR at [github.com/sweetrb/apple-photos-mcp](https://github.com/sweetrb/apple-photos-mcp).

## Related Projects

- [apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp) — MCP server for Apple Mail
- [apple-notes-mcp](https://github.com/sweetrb/apple-notes-mcp) — MCP server for Apple Notes
- [apple-numbers-mcp](https://github.com/sweetrb/apple-numbers-mcp) — MCP server for Apple Numbers spreadsheets
- [osxphotos](https://github.com/RhetTbull/osxphotos) — The Python library that powers this server
