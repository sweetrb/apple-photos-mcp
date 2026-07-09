#!/usr/bin/env python3
"""
Bridge script: queries the Apple Photos library using osxphotos and outputs JSON.
Called by the TypeScript MCP server via child_process.

All commands write a single JSON object to stdout. On error, the object has
an "error" key with a human-readable message.
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


def _open_db(library: str | None) -> PhotosDB:
    """Open the Photos library. None = system default library."""
    if library:
        path = Path(library).expanduser().resolve()
        return PhotosDB(dbfile=str(path))
    return PhotosDB()


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

    for p in matches:
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


def main() -> int:
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

    args = parser.parse_args()

    handlers = {
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

    try:
        result = handlers[args.cmd](args)
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
