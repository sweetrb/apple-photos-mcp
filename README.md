# apple-photos-mcp

[![npm version](https://img.shields.io/npm/v/apple-photos-mcp.svg)](https://www.npmjs.com/package/apple-photos-mcp)
[![macOS only](https://img.shields.io/badge/platform-macOS-blue.svg)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

MCP server for **Apple Photos** on macOS. Backed by [osxphotos](https://github.com/RhetTbull/osxphotos), it lets AI assistants query and export from your Photos library — search by date, album, keyword, person, or favorite/hidden flags; list albums and folders; fetch full metadata; and export originals or edited versions.

> **Read-only against the Photos library.** Exports write files to a directory you choose, but the library itself is never modified.

## Architecture

This package is a **TypeScript MCP server with a Python sidecar**:

- The MCP server (Node) speaks the Model Context Protocol over stdio.
- A bundled Python script (`src/utils/photos_reader.py`) uses `osxphotos` to read the Photos library and returns JSON.
- The TypeScript side spawns the Python script via `child_process.execFileSync`.

The Python sidecar requires `osxphotos`, which is installed into a project-local virtual environment via `npm run setup`.

## Install

```bash
npm install -g apple-photos-mcp
apple-photos-mcp --version  # smoke test (will fail until setup is run)
```

Or, locally:

```bash
git clone https://github.com/sweetrb/apple-photos-mcp
cd apple-photos-mcp
npm install
npm run setup       # creates ./venv and installs osxphotos
npm run build
```

### MCP client config

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

## Tools

| Tool | Purpose |
|------|---------|
| `health-check` | Verify osxphotos is installed and the library can be opened. |
| `library-info` | High-level stats: counts of photos, movies, albums, folders, keywords, persons. |
| `query` | Search the library with combinable filters. Returns photo summaries with UUIDs. |
| `get-photo` | Full metadata for one photo by UUID. |
| `list-albums` | All albums with their folder paths and photo counts. |
| `list-folders` | All folders with parent and album/subfolder counts. |
| `list-keywords` | Keywords sorted by usage count. |
| `list-persons` | People detected by face recognition, sorted by photo count. |
| `export` | Export one or more photos by UUID to a destination directory. |

### `query` filters

| Filter | Type | Notes |
|--------|------|-------|
| `uuid` | `string[]` | Specific UUIDs to fetch. |
| `album` | `string[]` | ANY-match across album names. |
| `keyword` | `string[]` | ANY-match across keywords. |
| `person` | `string[]` | ANY-match across person names. |
| `fromDate` / `toDate` | `string` | ISO 8601 date bounds on photo date. |
| `favorite` / `notFavorite` | `boolean` | |
| `hidden` / `notHidden` | `boolean` | Hidden photos are excluded by default. |
| `photos` / `movies` | `boolean` | Pass one to filter to that type. |
| `title` / `description` | `string` | Substring match. |
| `limit` | `number` | Cap on results. |
| `library` | `string` | Path to a non-default `.photoslibrary`. |

### `export` options

| Option | Effect |
|--------|--------|
| `uuid` | UUID(s) to export (required, non-empty). |
| `dest` | Destination directory (created if missing). |
| `edited` | Export the edited version instead of the original. |
| `live` | Also export the live-photo video. |
| `raw` | Also export the raw image. |
| `overwrite` | Overwrite existing files at the destination. |

## Permissions

osxphotos reads the Photos library SQLite database directly. macOS may require:

- **Full Disk Access** for the process running the MCP server, to access `~/Pictures/Photos Library.photoslibrary`.

Grant this in **System Settings → Privacy & Security → Full Disk Access** for whichever app launches the MCP server (Terminal, your IDE, Claude Code, etc.).

## Development

```bash
npm install
npm run setup          # creates ./venv with osxphotos
npm run build
npm test
npm run typecheck
npm run lint
```

The Python sidecar is a thin CLI:

```bash
./venv/bin/python3 src/utils/photos_reader.py library-info
./venv/bin/python3 src/utils/photos_reader.py query --keyword sunset --limit 5
./venv/bin/python3 src/utils/photos_reader.py export --uuid <uuid> --dest /tmp/out
```

## License

MIT — see [LICENSE](LICENSE).
