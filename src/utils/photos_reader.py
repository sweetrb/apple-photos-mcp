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
from datetime import datetime
from pathlib import Path

try:
    import osxphotos
    from osxphotos import PhotosDB, QueryOptions
except ImportError:
    print(json.dumps({
        "error": "osxphotos not installed. Run: npm run setup"
    }))
    sys.exit(1)


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
        kwargs["to_date"] = _parse_date(args.to_date)
    if args.favorite:
        kwargs["favorite"] = True
    if args.not_favorite:
        kwargs["not_favorite"] = True
    if args.hidden:
        kwargs["hidden"] = True
    if args.not_hidden:
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

    if args.limit and args.limit > 0:
        photos = photos[: args.limit]

    return {
        "count": len(photos),
        "photos": [_photo_summary(p) for p in photos],
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
    """List all albums (and optionally folders)."""
    db = _open_db(args.library)
    items = []
    for album in db.album_info:
        items.append({
            "uuid": album.uuid,
            "title": album.title,
            "folder": list(album.folder_names),
            "photoCount": len(album),
            "isShared": getattr(album, "shared", False),
        })
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
    if not matches:
        return {"error": f"No photos found for UUIDs: {args.uuid}"}

    dest = Path(args.dest).expanduser().resolve()
    dest.mkdir(parents=True, exist_ok=True)

    exported: list[str] = []
    skipped: list[dict] = []
    for p in matches:
        try:
            paths = p.export(
                str(dest),
                edited=args.edited,
                live_photo=args.live,
                raw_photo=args.raw,
                overwrite=args.overwrite,
                use_photos_export=False,
            )
            if paths:
                exported.extend(paths)
            else:
                # osxphotos returns an empty list (not an exception) when
                # the original isn't downloaded locally. Surface that as a skip.
                if p.ismissing or not p.path:
                    reason = "original not downloaded from iCloud"
                elif args.edited and not p.hasadjustments:
                    reason = "no edited version exists"
                elif args.raw and not p.path_raw:
                    reason = "no raw sidecar exists"
                else:
                    reason = "export returned no files"
                skipped.append({"uuid": p.uuid, "error": reason})
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
