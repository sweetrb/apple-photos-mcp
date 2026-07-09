#!/usr/bin/env python3
"""
Bridge script: queries the Apple Photos library using osxphotos and outputs JSON.
Called by the TypeScript MCP server via child_process.

Two modes:

- **One-shot (argv)**: `photos_reader.py <command> [--flags]` — runs one command
  and writes a single JSON object to stdout. On error, the object has an
  "error" key with a human-readable message (printed to stdout, exit 1).
  Used by CI, doctor probes, manual debugging, and as the TS layer's fallback.

- **Serve (persistent)**: `photos_reader.py --serve` — reads line-delimited
  JSON requests from stdin ({"id", "command", "args": [argv tokens]}) and
  writes line-delimited JSON responses to stdout:
      {"type": "ready", "protocol": 1}                     (handshake, once)
      {"id", "type": "result", "data": {...}, "dbCached"}  (per request)
      {"id", "type": "error", "error": "..."}              (per request)
      {"id", "type": "progress", "done", "total", ...}     (export, 0..n times)
  Exactly one request is in flight at a time (the Node serial gate guarantees
  it; the id echo is belt-and-braces). The PhotosDB instance is cached per
  library path and re-parsed only when the library's Photos.sqlite mtime
  changes — amortizing the multi-second full-database parse that otherwise
  dominates every call. Stdout is exclusively protocol lines; diagnostics go
  to stderr. The loop exits cleanly on stdin EOF, so a dying parent can never
  orphan a serving sidecar.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import osxphotos
    from osxphotos import PhotosDB, QueryOptions
except ImportError:
    print(json.dumps({
        "error": (
            "osxphotos not installed. Install it with: pip3 install osxphotos "
            "(requires Python >= 3.11; stock macOS ships 3.9 — "
            "brew install python@3.12), or run scripts/setup.sh from a repo "
            "checkout. Run the doctor tool to diagnose, or see "
            "https://github.com/sweetrb/apple-photos-mcp#troubleshooting"
        )
    }))
    sys.exit(1)


# Applied when a query omits --limit, so a filterless query over a huge library
# can't swamp the JSON pipe / MCP response. The true match total is still
# reported as "count" (the page size is "returned").
DEFAULT_QUERY_LIMIT = 500

# Serve-mode protocol version, echoed in the ready handshake line so the Node
# client can refuse to talk to a future incompatible script.
PROTOCOL_VERSION = 1

# Serve mode: at most this many PhotosDB instances stay resident (one per
# library path). A resident PhotosDB for a large library holds hundreds of MB,
# so the cache is deliberately tiny; the Node side's idle timeout bounds how
# long even these live.
MAX_DB_CACHE_ENTRIES = 2


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_date(value: str) -> datetime:
    """Parse an ISO 8601 date or datetime string into a datetime object.

    osxphotos QueryOptions requires real datetime objects for from_date / to_date.
    Accept either a bare date ("2025-06-01") or a full ISO 8601 datetime.
    """
    # datetime.fromisoformat accepts both "YYYY-MM-DD" and full ISO 8601 in 3.11+.
    return datetime.fromisoformat(value)


def _parse_to_date(value: str) -> datetime:
    """Parse the query's to-date upper bound.

    osxphotos treats to_date as an EXCLUSIVE bound (imageDate < to_date), so a
    bare date like "2025-06-30" — which parses to midnight — would silently
    exclude every photo taken ON that day. A bare date therefore rolls forward
    one day, making the named day inclusive (the intuitive reading). A full
    datetime (e.g. "2025-06-30T18:00:00") is passed through unchanged and
    remains a precise exclusive bound.
    """
    dt = _parse_date(value)
    try:
        date.fromisoformat(value)  # succeeds only for a bare date
    except ValueError:
        return dt
    return dt + timedelta(days=1)


def _normalize_count(value) -> int:
    """osxphotos may return either an int count or a list of UUIDs depending on version."""
    return value if isinstance(value, int) else len(value)


# Per-library-path PhotosDB cache (serve mode). Each entry remembers the
# library's Photos.sqlite path and the mtime observed when the DB was parsed;
# _open_db revalidates the mtime on EVERY call and re-parses on change. The
# staleness witness is deliberately the same file the Node-side metadata cache
# stats (<library>/database/Photos.sqlite) so the two layers agree on what
# "changed" means. In one-shot mode the cache is populated but the process
# exits after one command, so it has no effect.
_db_cache: dict[str, dict] = {}

# Whether the most recent _open_db call was served from the cache — reported
# in serve-mode response envelopes as "dbCached" so the reuse is observable.
_db_cache_hit = False

# Progress sink: None in one-shot mode; serve mode points it at a function
# that writes an {"id", "type": "progress", ...} line for the current request.
_progress_sink = None


def _emit_progress(**payload) -> None:
    if _progress_sink is not None:
        _progress_sink(payload)


def _library_cache_key(library: str | None) -> str:
    if library:
        return str(Path(library).expanduser().resolve())
    return ""


def _sqlite_mtime(sqlite_path: Path | None) -> float | None:
    if sqlite_path is None:
        return None
    try:
        return sqlite_path.stat().st_mtime
    except OSError:
        return None


def _open_db(library: str | None) -> PhotosDB:
    """Open the Photos library (None = system default), reusing a cached
    PhotosDB when the library's Photos.sqlite mtime is unchanged."""
    global _db_cache_hit
    key = _library_cache_key(library)

    entry = _db_cache.get(key)
    if entry is not None:
        mtime = _sqlite_mtime(entry["sqlite"])
        if mtime is not None and mtime == entry["mtime"]:
            _db_cache_hit = True
            return entry["db"]
        # Library changed (or became unstatable) — drop and re-parse.
        del _db_cache[key]

    _db_cache_hit = False
    if library:
        path = Path(library).expanduser().resolve()
        db = PhotosDB(dbfile=str(path))
    else:
        db = PhotosDB()

    # Cache only when the staleness witness is statable; otherwise caching
    # quietly stays out of the way (mirrors the Node-side cache's behavior).
    library_path = db.library_path
    sqlite_path = Path(library_path) / "database" / "Photos.sqlite" if library_path else None
    mtime = _sqlite_mtime(sqlite_path)
    if mtime is not None:
        _db_cache[key] = {"db": db, "sqlite": sqlite_path, "mtime": mtime}
        while len(_db_cache) > MAX_DB_CACHE_ENTRIES:
            _db_cache.pop(next(iter(_db_cache)))
    return db


def _photo_summary(p) -> dict:
    """Lightweight projection of a PhotoInfo for list responses."""
    return {
        "uuid": p.uuid,
        "filename": p.original_filename,
        "date": p.date.isoformat() if p.date else None,
        "title": p.title,
        "favorite": p.favorite,
        "hidden": p.hidden,
        "isMissing": p.ismissing,
        "isPhoto": p.isphoto,
        "isMovie": p.ismovie,
        "width": p.width,
        "height": p.height,
        "albums": list(p.albums),
        "keywords": list(p.keywords),
        "persons": list(p.persons),
    }


def _photo_detail(p) -> dict:
    """Full projection of a PhotoInfo for detail responses."""
    place = p.place
    location = None
    if p.latitude is not None and p.longitude is not None:
        location = {"latitude": p.latitude, "longitude": p.longitude}
    return {
        "uuid": p.uuid,
        "filename": p.original_filename,
        "currentFilename": p.filename,
        "date": p.date.isoformat() if p.date else None,
        "dateAdded": p.date_added.isoformat() if p.date_added else None,
        "dateModified": p.date_modified.isoformat() if p.date_modified else None,
        "title": p.title,
        "description": p.description,
        "favorite": p.favorite,
        "hidden": p.hidden,
        "isMissing": p.ismissing,
        "isPhoto": p.isphoto,
        "isMovie": p.ismovie,
        "isHDR": p.hdr,
        "isLive": p.live_photo,
        "isScreenshot": p.screenshot,
        "isSelfie": p.selfie,
        "isPanorama": p.panorama,
        "isPortrait": p.portrait,
        "isSlowMo": p.slow_mo,
        "isTimeLapse": p.time_lapse,
        "isBurst": p.burst,
        "isRaw": p.israw,
        "isEdited": p.hasadjustments,
        "width": p.width,
        "height": p.height,
        "originalWidth": p.original_width,
        "originalHeight": p.original_height,
        "uti": p.uti,
        "uti_original": p.uti_original,
        "originalFilesize": p.original_filesize,
        "path": p.path,
        "pathEdited": p.path_edited,
        "pathRaw": p.path_raw,
        "pathLivePhoto": p.path_live_photo,
        "albums": list(p.albums),
        "keywords": list(p.keywords),
        "persons": list(p.persons),
        "labels": list(p.labels),
        "location": location,
        "place": {
            "name": place.name if place else None,
            "country": place.country_code if place else None,
        } if place else None,
    }


def _query_options(args) -> QueryOptions:
    """Build an osxphotos QueryOptions from CLI args."""
    kwargs: dict = {}
    if args.uuid:
        kwargs["uuid"] = args.uuid
    if args.album:
        kwargs["album"] = args.album
    if args.keyword:
        kwargs["keyword"] = args.keyword
    if args.person:
        kwargs["person"] = args.person
    if args.from_date:
        kwargs["from_date"] = _parse_date(args.from_date)
    if args.to_date:
        kwargs["to_date"] = _parse_to_date(args.to_date)
    if args.favorite:
        kwargs["favorite"] = True
    if args.not_favorite:
        kwargs["not_favorite"] = True
    # Privacy contract: hidden photos are EXCLUDED unless explicitly requested
    # with --hidden. (osxphotos includes hidden photos when neither flag is
    # set, so not_hidden must be the active default. hidden/not_hidden are a
    # mutually-exclusive pair in QueryOptions — never set both.)
    if args.hidden:
        kwargs["hidden"] = True
    else:
        kwargs["not_hidden"] = True
    if args.movies and not args.photos:
        kwargs["movies"] = True
        kwargs["photos"] = False
    elif args.photos and not args.movies:
        kwargs["photos"] = True
        kwargs["movies"] = False
    if args.title:
        kwargs["title"] = [args.title]
    if args.description:
        kwargs["description"] = [args.description]
    return QueryOptions(**kwargs)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_health(args):
    """Verify that osxphotos can open the library."""
    db = _open_db(args.library)
    return {
        "ok": True,
        "osxphotosVersion": osxphotos.__version__,
        "libraryPath": db.library_path,
        "photoCount": len(db.photos(intrash=False)),
    }


def cmd_library_info(args):
    """High-level stats about the Photos library."""
    db = _open_db(args.library)
    photos = db.photos(intrash=False)
    return {
        "libraryPath": db.library_path,
        "dbVersion": db.db_version,
        "photosVersion": db.photos_version,
        "photoCount": sum(1 for p in photos if p.isphoto),
        "movieCount": sum(1 for p in photos if p.ismovie),
        "totalCount": len(photos),
        "albumCount": len(db.albums),
        "folderCount": len(db.folders),
        "keywordCount": len(db.keywords),
        "personCount": len(db.persons),
    }


def cmd_query(args):
    """Run a query against the library and return matching photos."""
    db = _open_db(args.library)
    options = _query_options(args)
    photos = db.query(options)

    # db.query() returns lightweight PhotoInfo handles; the expensive work is the
    # per-photo property access in _photo_summary (albums/keywords/persons/etc.).
    # Slice to the limit *before* projecting so large libraries don't pay the
    # full-projection cost for a small page. The total match count is captured
    # BEFORE the slice so callers can tell when results were truncated; when no
    # limit is given, DEFAULT_QUERY_LIMIT applies.
    total = len(photos)
    limit = args.limit if args.limit and args.limit > 0 else DEFAULT_QUERY_LIMIT
    page = photos[:limit]

    return {
        "count": total,
        "returned": len(page),
        "photos": [_photo_summary(p) for p in page],
    }


def cmd_get_photo(args):
    """Get full details for one photo by UUID, including photos in the trash."""
    db = _open_db(args.library)
    # PhotosDB.photos accepts intrash as a strict bool — query the live library
    # first, then fall back to the trash so a single get-photo call works either way.
    matches = db.photos(uuid=[args.uuid], intrash=False) or db.photos(
        uuid=[args.uuid], intrash=True
    )
    if not matches:
        return {"error": f"Photo not found: {args.uuid}"}
    return {"photo": _photo_detail(matches[0])}


def cmd_list_albums(args):
    """List all albums, including iCloud Shared Albums."""
    db = _open_db(args.library)
    items = []

    def _append(album, is_shared: bool) -> None:
        try:
            folder = list(album.folder_names)
        except Exception:  # noqa: BLE001 - shared albums have no folder path
            folder = []
        items.append({
            "uuid": album.uuid,
            "title": album.title,
            "folder": folder,
            "photoCount": len(album),
            "isShared": is_shared,
        })

    for album in db.album_info:
        _append(album, False)

    # iCloud Shared Albums live in a separate list — AlbumInfo has no "shared"
    # attribute, so they must be enumerated explicitly. Photos <= 4 has no
    # shared-album support (osxphotos warns and returns []).
    try:
        shared_albums = db.album_info_shared
    except Exception:  # noqa: BLE001
        shared_albums = []
    for album in shared_albums:
        _append(album, True)

    return {"count": len(items), "albums": items}


def cmd_list_folders(args):
    """List folders with their nested albums."""
    db = _open_db(args.library)
    items = []
    for folder in db.folder_info:
        items.append({
            "uuid": folder.uuid,
            "title": folder.title,
            "parent": folder.parent.title if folder.parent else None,
            "albumCount": len(folder.album_info),
            "subfolderCount": len(folder.subfolders),
        })
    return {"count": len(items), "folders": items}


def cmd_list_keywords(args):
    """Counts of each keyword."""
    db = _open_db(args.library)
    counts = db.keywords_as_dict
    items = sorted(
        ({"keyword": k, "count": _normalize_count(v)} for k, v in counts.items()),
        key=lambda x: -x["count"],
    )
    if args.limit and args.limit > 0:
        items = items[: args.limit]
    return {"count": len(items), "keywords": items}


def cmd_list_persons(args):
    """List persons (faces) in the library."""
    db = _open_db(args.library)
    counts = db.persons_as_dict
    items = sorted(
        ({"name": k, "count": _normalize_count(v)} for k, v in counts.items()),
        key=lambda x: -x["count"],
    )
    if args.limit and args.limit > 0:
        items = items[: args.limit]
    return {"count": len(items), "persons": items}


def cmd_export(args):
    """Export one or more photos to a destination directory."""
    db = _open_db(args.library)
    matches = db.photos(uuid=args.uuid, intrash=False)

    exported: list[str] = []
    skipped: list[dict] = []

    # PhotosDB.photos() silently drops UUIDs it doesn't know (and photos in
    # Recently Deleted, since intrash=False). Report every requested UUID that
    # produced no match so exported + skipped always accounts for the request.
    found = {p.uuid for p in matches}
    seen: set[str] = set()
    for u in args.uuid:
        if u not in found and u not in seen:
            seen.add(u)
            skipped.append({"uuid": u, "error": "UUID not found (deleted or in trash)"})

    if not matches:
        return {
            "destination": str(Path(args.dest).expanduser().resolve()),
            "exportedCount": 0,
            "skippedCount": len(skipped),
            "exported": [],
            "skipped": skipped,
        }

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    def _do_export(p, use_photos_export: bool):
        # increment=False: with overwrite unset, a name collision raises
        # FileExistsError (mapped to a per-UUID skip below) instead of
        # osxphotos' default of silently writing an "IMG_1234 (1).jpg"
        # duplicate — matching the tool's documented "existing files are
        # skipped" contract.
        return p.export(
            str(dest),
            edited=args.edited,
            live_photo=args.live,
            raw_photo=args.raw,
            overwrite=args.overwrite,
            increment=False,
            use_photos_export=use_photos_export,
            timeout=300 if use_photos_export else 120,
        )

    def _unrecoverable_reason(p):
        # Reasons retrying via Photos.app cannot fix. Note: export(edited=True)
        # on a photo without adjustments RAISES ValueError (caught per-photo
        # below), so no edited check belongs here. And raw_photo=True on a
        # photo with no raw component still exports the original, so an empty
        # result only implicates the raw file when the photo actually HAS one
        # — anything else (e.g. an iCloud-only original) must fall through to
        # the Photos.app download fallback.
        if args.raw and p.has_raw and not p.path_raw:
            return "raw component not on disk (Photos.app fallback cannot fetch raw originals)"
        return None

    total = len(matches)
    for i, p in enumerate(matches):
        # Serve mode: one progress line per photo (no-op in one-shot mode).
        # done = photos completed so far; current = the photo being exported.
        _emit_progress(
            done=i, total=total, current=p.original_filename or p.uuid, uuid=p.uuid
        )
        try:
            paths = _do_export(p, use_photos_export=False)
            if not paths:
                unrecoverable = _unrecoverable_reason(p)
                if unrecoverable:
                    skipped.append({"uuid": p.uuid, "error": unrecoverable})
                    continue
                # Original isn't on disk (iCloud-only). Fall back to Photos.app
                # via AppleScript, which downloads the original on demand —
                # same behavior as opening the photo in Photos.
                try:
                    paths = _do_export(p, use_photos_export=True)
                except FileExistsError:
                    raise  # handled by the per-photo FileExistsError below
                except Exception as exc:  # noqa: BLE001
                    skipped.append(
                        {"uuid": p.uuid, "error": f"iCloud download failed: {exc}"}
                    )
                    continue

            if paths:
                exported.extend(paths)
            else:
                skipped.append(
                    {
                        "uuid": p.uuid,
                        "error": "original not downloaded from iCloud (download attempt returned no files)",
                    }
                )
        except FileExistsError:
            skipped.append(
                {
                    "uuid": p.uuid,
                    "error": "already exists at destination (pass overwrite=true to replace)",
                }
            )
        except Exception as exc:  # noqa: BLE001 - report any export failure
            skipped.append({"uuid": p.uuid, "error": str(exc)})

    _emit_progress(done=total, total=total)
    return {
        "destination": str(dest),
        "exportedCount": len(exported),
        "skippedCount": len(skipped),
        "exported": exported,
        "skipped": skipped,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _add_library(p: argparse.ArgumentParser) -> None:
    p.add_argument("--library", help="Path to a .photoslibrary (default: system library)")


def _add_query_filters(p: argparse.ArgumentParser) -> None:
    p.add_argument("--uuid", action="append", help="Filter by UUID (repeatable)")
    p.add_argument("--album", action="append", help="Filter by album name (repeatable)")
    p.add_argument("--keyword", action="append", help="Filter by keyword (repeatable)")
    p.add_argument("--person", action="append", help="Filter by person name (repeatable)")
    p.add_argument("--from-date", help="ISO 8601 date lower bound")
    p.add_argument("--to-date", help="ISO 8601 date upper bound")
    p.add_argument("--favorite", action="store_true", help="Only favorites")
    p.add_argument("--not-favorite", action="store_true", help="Exclude favorites")
    p.add_argument("--hidden", action="store_true", help="Only hidden photos")
    p.add_argument("--not-hidden", action="store_true", help="Exclude hidden photos")
    p.add_argument("--photos", action="store_true", help="Include still photos")
    p.add_argument("--movies", action="store_true", help="Include movies")
    p.add_argument("--title", help="Substring match on title")
    p.add_argument("--description", help="Substring match on description")
    p.add_argument("--limit", type=int, help="Max number of results")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="photos_reader")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("health")
    _add_library(p)

    p = sub.add_parser("library-info")
    _add_library(p)

    p = sub.add_parser("query")
    _add_library(p)
    _add_query_filters(p)

    p = sub.add_parser("get-photo")
    _add_library(p)
    p.add_argument("--uuid", required=True)

    p = sub.add_parser("list-albums")
    _add_library(p)

    p = sub.add_parser("list-folders")
    _add_library(p)

    p = sub.add_parser("list-keywords")
    _add_library(p)
    p.add_argument("--limit", type=int)

    p = sub.add_parser("list-persons")
    _add_library(p)
    p.add_argument("--limit", type=int)

    p = sub.add_parser("export")
    _add_library(p)
    p.add_argument("--uuid", action="append", required=True, help="UUID(s) to export")
    p.add_argument("--dest", required=True, help="Destination directory")
    p.add_argument("--edited", action="store_true", help="Export edited version")
    p.add_argument("--live", action="store_true", help="Include live-photo video")
    p.add_argument("--raw", action="store_true", help="Include raw image")
    p.add_argument("--overwrite", action="store_true", help="Overwrite existing files")

    return parser


HANDLERS = {
    "health": cmd_health,
    "library-info": cmd_library_info,
    "query": cmd_query,
    "get-photo": cmd_get_photo,
    "list-albums": cmd_list_albums,
    "list-folders": cmd_list_folders,
    "list-keywords": cmd_list_keywords,
    "list-persons": cmd_list_persons,
    "export": cmd_export,
}


def _write_line(obj: dict) -> None:
    """Write one protocol line to stdout and flush (serve mode is interactive)."""
    print(json.dumps(obj, default=str), flush=True)


def serve() -> int:
    """Persistent mode: line-delimited JSON requests on stdin, responses on
    stdout. One request in flight at a time; exits 0 on stdin EOF."""
    global _progress_sink
    parser = _build_parser()
    _write_line({
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "osxphotosVersion": osxphotos.__version__,
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            command = req.get("command")
            argv = req.get("args") or []
            if not isinstance(command, str) or not isinstance(argv, list):
                raise ValueError("malformed request: expected {id, command, args[]}")
            try:
                # Same argparse surface as one-shot mode — a single source of
                # truth for flags, defaults, and types. argparse exits on bad
                # input; in serve mode that must become an error response.
                args = parser.parse_args([command, *[str(a) for a in argv]])
            except (SystemExit, argparse.ArgumentError):
                _write_line({
                    "id": rid,
                    "type": "error",
                    "error": f"invalid arguments for {command} (argparse rejected the request)",
                })
                continue

            _progress_sink = lambda payload, _rid=rid: _write_line(
                {"id": _rid, "type": "progress", **payload}
            )
            try:
                result = HANDLERS[args.cmd](args)
            finally:
                _progress_sink = None
            _write_line({"id": rid, "type": "result", "data": result, "dbCached": _db_cache_hit})
        except FileNotFoundError as exc:
            _write_line({"id": rid, "type": "error", "error": f"Library not found: {exc}"})
        except Exception as exc:  # noqa: BLE001 - same message contract as one-shot
            _write_line({"id": rid, "type": "error", "error": str(exc)})
    return 0


def main() -> int:
    if sys.argv[1:2] == ["--serve"]:
        return serve()

    args = _build_parser().parse_args()

    try:
        result = HANDLERS[args.cmd](args)
    except FileNotFoundError as exc:
        print(json.dumps({"error": f"Library not found: {exc}"}))
        return 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 1

    print(json.dumps(result, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
