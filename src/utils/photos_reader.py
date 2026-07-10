#!/usr/bin/env python3
"""
Bridge script: queries the Apple Photos library using osxphotos and outputs JSON.
Called by the TypeScript MCP server via child_process.

Reads go through osxphotos (direct SQLite parse). The OPT-IN write commands
(create-album, add-to-album, remove-from-album, set-photo-metadata,
set-keywords) go through photoscript, which drives Photos.app over AppleScript
— they are refused unless APPLE_PHOTOS_MCP_ENABLE_WRITES is set (the TS layer
gates them too; this is defense in depth for direct CLI invocation).

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
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from uuid import uuid4

try:
    import bitmath
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


_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$", re.IGNORECASE)
_DURATION_UNITS = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days", "w": "weeks"}


def _parse_duration(value: str) -> timedelta:
    """Parse a compact duration string ("30d", "24h", "90m", "2w", "45s") into
    a timedelta for QueryOptions.added_in_last."""
    m = _DURATION_RE.match(value)
    if not m:
        raise ValueError(
            f"Invalid duration: {value!r}. Use <number><unit> where unit is "
            "s(econds), m(inutes), h(ours), d(ays), or w(eeks) — e.g. \"7d\", \"24h\"."
        )
    return timedelta(**{_DURATION_UNITS[m.group(2).lower()]: float(m.group(1))})


def _normalize_count(value) -> int:
    """osxphotos may return either an int count or a list of UUIDs depending on version."""
    return value if isinstance(value, int) else len(value)


def _date_sort_key(p) -> float:
    """Timestamp sort key for newest-first ordering; photos without a date sort
    last. timestamp() works for both naive and tz-aware datetimes (naive is
    interpreted as local time), so mixed libraries can't raise a naive/aware
    comparison TypeError."""
    try:
        return p.date.timestamp() if p.date else float("-inf")
    except (OverflowError, OSError, ValueError):
        return float("-inf")


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


def _exif(p) -> dict | None:
    """Project PhotoInfo.exif_info (camera/lens/exposure data Photos captured
    at import) into a JSON-friendly dict; None when Photos recorded no EXIF
    (e.g. manufacturer-app uploads, scans)."""
    try:
        e = p.exif_info
    except Exception:  # noqa: BLE001 - EXIF must never break a detail response
        return None
    if e is None:
        return None
    return {
        "cameraMake": e.camera_make,
        "cameraModel": e.camera_model,
        "lensModel": e.lens_model,
        "iso": e.iso,
        "aperture": e.aperture,
        "shutterSpeed": e.shutter_speed,
        "focalLength": e.focal_length,
        "exposureBias": e.exposure_bias,
        "flashFired": e.flash_fired,
        "duration": e.duration,
        "fps": e.fps,
        "codec": e.codec,
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
        "exif": _exif(p),
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
    # --- import-date window (date_added, not the photo's taken date) ---
    if args.added_after:
        kwargs["added_after"] = _parse_date(args.added_after)
    if args.added_before:
        # Same bare-date convenience as --to-date: a bare date rolls forward a
        # day so the named day is included in the (exclusive) upper bound.
        kwargs["added_before"] = _parse_to_date(args.added_before)
    if args.added_in_last:
        kwargs["added_in_last"] = _parse_duration(args.added_in_last)
    # --- content/organization filters ---
    if args.label:
        kwargs["label"] = args.label
    if args.folder:
        kwargs["folder"] = args.folder
    if args.place:
        kwargs["place"] = args.place
    if args.has_location:
        kwargs["location"] = True
    elif args.no_location:
        kwargs["no_location"] = True
    if args.year:
        kwargs["year"] = args.year
    if args.min_size is not None:
        kwargs["min_size"] = bitmath.Byte(args.min_size)
    if args.max_size is not None:
        kwargs["max_size"] = bitmath.Byte(args.max_size)
    if args.no_keyword:
        kwargs["no_keyword"] = True
    if args.burst:
        kwargs["burst"] = True
    # --- media-type flags (one-sided: True filters to only that type) ---
    for flag in (
        "screenshot",
        "screen_recording",
        "selfie",
        "panorama",
        "live",
        "portrait",
        "time_lapse",
        "slow_mo",
    ):
        if getattr(args, flag):
            kwargs[flag] = True
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
    if args.newest_first:
        # Sort BEFORE the limit slice so limit means "the N most recent
        # matches" instead of "N in database order".
        photos = sorted(photos, key=_date_sort_key, reverse=True)
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


def cmd_get_photos(args):
    """Get full details for a batch of photos by UUID in ONE library pass —
    the batch equivalent of get-photo (same per-photo shape, same trash
    fallback). Unknown UUIDs are reported in notFound rather than erroring."""
    db = _open_db(args.library)
    requested = list(dict.fromkeys(args.uuid))  # dedupe, preserve caller order
    found = {p.uuid: p for p in db.photos(uuid=requested, intrash=False)}
    missing = [u for u in requested if u not in found]
    if missing:
        for p in db.photos(uuid=missing, intrash=True):
            found[p.uuid] = p
    photos = [_photo_detail(found[u]) for u in requested if u in found]
    not_found = [u for u in requested if u not in found]
    return {"count": len(photos), "photos": photos, "notFound": not_found}


# --- get-thumbnail helpers -------------------------------------------------

# Refuse to base64 anything bigger than this — a thumbnail response must stay
# a small fraction of the MCP transport/window, and every Photos-generated
# derivative is far below it. (Original-file fallbacks are downscaled first.)
MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024

DEFAULT_THUMBNAIL_MIN_SIZE = 360

# MIME types MCP clients can actually render inline. HEIC deliberately absent:
# Photos' derivatives are JPEG in practice, and anything else is converted.
_RENDERABLE_MIME = {"image/jpeg", "image/png", "image/gif", "image/webp"}

_EXT_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}


def _image_dims(path: str) -> tuple[int, int] | None:
    """(width, height) via a pure-Python header sniff for JPEG/PNG/GIF —
    covers every Photos-generated derivative (they are JPEG in practice).
    Returns None for anything unrecognized rather than guessing."""
    try:
        with open(path, "rb") as f:
            head = f.read(26)
            if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
                return (
                    int.from_bytes(head[16:20], "big"),
                    int.from_bytes(head[20:24], "big"),
                )
            if head[:4] in (b"GIF8",):
                return (
                    int.from_bytes(head[6:8], "little"),
                    int.from_bytes(head[8:10], "little"),
                )
            if head[:2] != b"\xff\xd8":
                return None
            # JPEG: walk the marker chain to the first SOFn frame header.
            f.seek(2)
            while True:
                b = f.read(1)
                if not b:
                    return None
                if b[0] != 0xFF:
                    continue
                code = 0xFF
                while code == 0xFF:
                    nxt = f.read(1)
                    if not nxt:
                        return None
                    code = nxt[0]
                if code in (0x01,) or 0xD0 <= code <= 0xD9:
                    continue  # standalone markers carry no length
                ln = int.from_bytes(f.read(2), "big")
                if ln < 2:
                    return None
                if 0xC0 <= code <= 0xCF and code not in (0xC4, 0xC8, 0xCC):
                    body = f.read(5)
                    if len(body) < 5:
                        return None
                    return (
                        int.from_bytes(body[3:5], "big"),
                        int.from_bytes(body[1:3], "big"),
                    )
                f.seek(ln - 2, 1)
    except OSError:
        return None


def _render_jpeg(src: str, max_dim: int) -> str:
    """Downscale/convert any macOS-readable image to a JPEG capped at max_dim
    px on the long edge, via the always-present `sips`. Returns the temp-file
    path (caller unlinks). Used only for fallbacks — HEIC-or-huge originals
    with no usable derivative."""
    tmp = tempfile.NamedTemporaryFile(suffix=".jpeg", delete=False)
    tmp.close()
    try:
        subprocess.run(
            [
                "/usr/bin/sips",
                "-s", "format", "jpeg",
                "--resampleHeightWidthMax", str(max_dim),
                src,
                "--out", tmp.name,
            ],
            check=True,
            capture_output=True,
            timeout=60,
        )
    except Exception as exc:
        Path(tmp.name).unlink(missing_ok=True)
        raise RuntimeError(f"could not render a JPEG thumbnail from {src}: {exc}") from exc
    return tmp.name


def cmd_get_thumbnail(args):
    """Return a small renderable image (base64 JPEG/PNG) for one photo, using
    the preview derivatives Photos has already generated — no export, no
    original-file transfer."""
    db = _open_db(args.library)
    matches = db.photos(uuid=[args.uuid], intrash=False) or db.photos(
        uuid=[args.uuid], intrash=True
    )
    if not matches:
        return {"error": f"Photo not found: {args.uuid}"}
    p = matches[0]
    min_size = args.min_size if args.min_size and args.min_size > 0 else DEFAULT_THUMBNAIL_MIN_SIZE

    # Catalog the image derivatives (skip video derivatives of movies).
    candidates = []
    for d in p.path_derivatives or []:
        mime = _EXT_MIME.get(Path(d).suffix.lower())
        if mime is None:
            continue
        try:
            size = Path(d).stat().st_size
        except OSError:
            continue
        candidates.append({"path": d, "mime": mime, "bytes": size, "dims": _image_dims(d)})

    renderable = [c for c in candidates if c["mime"] in _RENDERABLE_MIME]

    def _read(choice, converted=False):
        data = Path(choice["path"]).read_bytes()
        if len(data) > MAX_THUMBNAIL_BYTES:
            raise RuntimeError(
                f"thumbnail is {len(data)} bytes (cap {MAX_THUMBNAIL_BYTES}); "
                "request a smaller minSize"
            )
        dims = choice["dims"] or _image_dims(choice["path"])
        return {
            "uuid": p.uuid,
            "path": choice["path"] if not converted else (p.path or choice["path"]),
            "width": dims[0] if dims else None,
            "height": dims[1] if dims else None,
            "mimeType": choice["mime"],
            "byteSize": len(data),
            "isDerivative": not converted,
            "base64": base64.b64encode(data).decode("ascii"),
        }

    # Preferred path: the smallest renderable derivative whose long edge
    # meets minSize — the cheapest response that honors the requested detail.
    qualifying = [
        c
        for c in renderable
        if c["dims"] and max(c["dims"]) >= min_size and c["bytes"] <= MAX_THUMBNAIL_BYTES
    ]
    if qualifying:
        return _read(min(qualifying, key=lambda c: max(c["dims"])))

    # Nothing pre-generated meets minSize. Prefer RENDERING a right-sized JPEG
    # (via sips) from a larger local source over returning an undersized
    # thumbnail — an agent that raised minSize to read small text must not
    # silently get a 360px preview. Never upscale: that adds bytes, not detail.
    best_fallback = None
    fallback = [c for c in renderable if c["bytes"] <= MAX_THUMBNAIL_BYTES]
    if fallback:
        best_fallback = max(
            fallback, key=lambda c: (max(c["dims"]) if c["dims"] else 0, c["bytes"])
        )
    have = max(best_fallback["dims"]) if best_fallback and best_fallback["dims"] else 0

    source = None  # a local file plausibly LARGER than the best derivative
    target = min_size
    original_edge = max(p.original_width or 0, p.original_height or 0)
    if not p.ismovie and (p.path or p.path_edited) and original_edge > have:
        source = p.path or p.path_edited
        # Cap at the original's own size so sips never upscales.
        target = min(min_size, original_edge)
    if source is None:
        # A non-renderable derivative (e.g. HEIC): dims unreadable here, but
        # Photos only generates those larger than its thumbnail-size JPEGs.
        non_renderable = [c for c in candidates if c["mime"] not in _RENDERABLE_MIME]
        if non_renderable:
            source = max(non_renderable, key=lambda c: c["bytes"])["path"]
    if source is None and best_fallback is None and not p.ismovie:
        # No derivatives at all — the original/edited file is the only option.
        source = p.path or p.path_edited

    if source is not None:
        try:
            rendered = _render_jpeg(source, target)
        except RuntimeError:
            rendered = None  # sips couldn't read it — settle for the fallback
        if rendered is not None:
            try:
                return _read(
                    {"path": rendered, "mime": "image/jpeg", "bytes": 0, "dims": None},
                    converted=True,
                )
            finally:
                Path(rendered).unlink(missing_ok=True)

    if best_fallback is not None:
        return _read(best_fallback)

    if p.ismovie:
        return {
            "error": (
                f"No image derivative available for movie {args.uuid} — "
                "export it and extract a frame instead."
            )
        }
    return {
        "error": (
            f"No local image available for {args.uuid} (original may be "
            "iCloud-only with no derivatives) — export it first."
        )
    }


def cmd_find_duplicates(args):
    """Group exact duplicates (Photos' own fingerprint-based detection).

    Grouping walks the PhotoInfo.duplicates adjacency instead of the exposed
    `fingerprint` attribute — on newer Photos versions (macOS 15+) fingerprint
    reads as None even though duplicate detection works. Hidden photos are
    excluded (same privacy contract as query); photos in Recently Deleted are
    never group members."""
    db = _open_db(args.library)
    photos = db.query(QueryOptions(duplicate=True, not_hidden=True))
    live = {p.uuid: p for p in photos}

    seen: set[str] = set()
    groups = []
    for p in photos:
        if p.uuid in seen:
            continue
        # Connected component over the duplicates relation, restricted to
        # live (non-trashed, non-hidden) photos.
        members = []
        stack = [p]
        seen.add(p.uuid)
        while stack:
            cur = stack.pop()
            members.append(cur)
            for d in cur.duplicates:
                if d.uuid in live and d.uuid not in seen:
                    seen.add(d.uuid)
                    stack.append(live[d.uuid])
        if len(members) < 2:
            continue  # its only duplicate is hidden or already in the trash
        members.sort(key=_date_sort_key, reverse=True)
        groups.append(
            {
                "uuids": [m.uuid for m in members],
                "count": len(members),
                "photos": [
                    {
                        "uuid": m.uuid,
                        "filename": m.original_filename,
                        "date": m.date.isoformat() if m.date else None,
                        "size": m.original_filesize,
                        "width": m.width,
                        "height": m.height,
                        "isMovie": m.ismovie,
                    }
                    for m in members
                ],
            }
        )

    # Most recently taken first — recent imports (the usual dedupe target)
    # surface at the top.
    groups.sort(key=lambda g: g["photos"][0]["date"] or "", reverse=True)
    total = len(groups)
    limit = args.limit if args.limit and args.limit > 0 else 100
    page = groups[:limit]
    return {"groupCount": total, "returned": len(page), "groups": page}


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
# Write commands (photoscript → Photos.app AppleScript) — OPT-IN
# ---------------------------------------------------------------------------
#
# Everything below MODIFIES the user's Photos library and is therefore gated
# behind APPLE_PHOTOS_MCP_ENABLE_WRITES (checked per command, here AND in the
# TS layer). Design invariants:
#
#   - Writes target the library currently open in Photos.app (normally the
#     system library) — AppleScript cannot address any other library, so the
#     write commands deliberately take no --library flag.
#   - Every target is validated first: unknown photo UUIDs / album names come
#     back as clear errors (or per-UUID notFound lists for batches), never as
#     silent no-ops on the wrong object.
#   - Nothing here can DELETE a photo from the library. remove-from-album
#     changes album membership only; there is intentionally no delete command
#     (Photos' AppleScript delete verbs are not exposed as MCP tools).
#   - After any write the resident PhotosDB cache is dropped: Photos commits
#     through SQLite WAL, so the Photos.sqlite mtime the cache revalidates on
#     may not change immediately — trusting it could serve a stale snapshot.

WRITES_ENV = "APPLE_PHOTOS_MCP_ENABLE_WRITES"

# UUID-ish (hex segments and dashes, optional AppleScript "/L0/nnn" suffix) —
# used to decide whether an album reference should try an id lookup first.
_UUID_ISH_RE = re.compile(r"^[0-9A-Fa-f-]+(/L0/\d+)?$")

_photoscript_module = None


def _writes_enabled() -> bool:
    value = os.environ.get(WRITES_ENV, "")
    return value not in ("", "0") and value.lower() != "false"


def _require_writes() -> None:
    if not _writes_enabled():
        raise RuntimeError(
            "Write tools are disabled — apple-photos-mcp is read-only by default. "
            f"Set {WRITES_ENV}=1 in the server's environment (or in "
            "~/Library/Application Support/apple-photos-mcp/config.json) and restart "
            "the MCP server to enable them. Run the doctor tool to see the gate "
            "state, or see "
            "https://github.com/sweetrb/apple-photos-mcp#write-tools-opt-in"
        )


def _photoscript():
    """Lazily import photoscript (read-only users never pay for it) and make
    its AppleScript runner safe for MCP use: photoscript's default retry
    policy runs `killall Photos` when an AppleScript call times out — an MCP
    server must NEVER kill the user's Photos.app out from under them, so
    retries are disabled and timeouts surface as plain errors instead."""
    global _photoscript_module
    if _photoscript_module is None:
        try:
            import photoscript
            from photoscript.script_loader import configure_run_script
        except ImportError as exc:
            raise RuntimeError(
                "photoscript not installed. Install it with: pip3 install photoscript, "
                "or run scripts/setup.sh from a repo checkout (it installs "
                "requirements.txt into ./venv). Run the doctor tool to diagnose, or see "
                "https://github.com/sweetrb/apple-photos-mcp#troubleshooting"
            ) from exc
        configure_run_script(retry_enabled=False)
        _photoscript_module = photoscript
    return _photoscript_module


def _run_script(ps, name: str, *args):
    """One raw AppleScript call via photoscript's runner. Used where the
    object API would spawn one osascript per photo (Album.photos() constructs
    a Photo — one existence probe each — for every member; albumPhotes/albumAdd
    move the whole id list in a single call). photoscript is version-pinned in
    requirements.txt, so these two handler names are stable."""
    return ps.script_loader.run_script(name, *args)


def _mark_library_written() -> None:
    """Drop every resident PhotosDB after a write (see invariants above)."""
    _db_cache.clear()


def _bare_uuid(media_id: str) -> str:
    """Strip the AppleScript '/L0/nnn' suffix: media-item id → osxphotos UUID."""
    return media_id.split("/")[0]


def _album_payload(album) -> dict:
    return {
        "uuid": album.uuid,
        "name": album.name,
        "path": album.path_str("/"),
    }


def _resolve_album(ps, lib, ref: str):
    """Resolve an album by UUID or name. UUID-looking refs try the id lookup
    first and fall back to a name lookup (an album could be *named* like a
    UUID). Raises with a clear message when nothing matches."""
    if _UUID_ISH_RE.match(ref):
        try:
            return ps.Album(ref)
        except ValueError:
            pass  # not a known album id — fall through to the name lookup
    album = lib.album(ref)
    if album is None:
        raise RuntimeError(
            f"Album not found: {ref!r}. Pass an exact album name or UUID "
            "(see list-albums), or create it with create-album."
        )
    return album


def _resolve_photo(ps, uuid: str):
    """One photo by UUID via Photos.app; same message contract as get-photo."""
    try:
        return ps.Photo(uuid)
    except ValueError:
        raise RuntimeError(f"Photo not found: {uuid}") from None


def _resolve_photos(ps, uuids: list[str]) -> tuple[list, list[str]]:
    """Batch photo resolution: (found Photo objects, notFound uuids) — dupes
    collapsed, caller order preserved."""
    found: list = []
    not_found: list[str] = []
    for u in dict.fromkeys(uuids):
        try:
            found.append(ps.Photo(u))
        except ValueError:
            not_found.append(u)
    return found, not_found


def _temp_album_name(lib) -> str:
    """A collision-checked scratch-album name for the remove rebuild."""
    while True:
        candidate = f"apple-photos-mcp-tmp-{uuid4().hex[:12]}"
        if lib.album(candidate) is None:
            return candidate


def _merge_keywords(
    current: list[str], add: list[str], remove: list[str]
) -> tuple[list[str], list[str], list[str]]:
    """UNION semantics for set-keywords: start from the photo's CURRENT
    keywords, drop `remove`, append `add` — never blind-replace, so keywords
    the caller didn't mention are always preserved. Order: survivors keep
    their existing order, additions append in caller order.

    Returns (after, added, removed) where added/removed reflect what actually
    changed (adding an existing keyword or removing an absent one is a no-op).
    """
    remove_set = set(remove)
    after = [k for k in current if k not in remove_set]
    seen = set(after)
    added = []
    for k in add:
        if k not in seen:
            after.append(k)
            seen.add(k)
            added.append(k)
    removed = [k for k in dict.fromkeys(current) if k in remove_set]
    return after, added, removed


def cmd_create_album(args):
    """Create an album (optionally nested in a folder path), or return the
    existing album of that name with created=false — idempotent by design so
    re-running a filing workflow never piles up duplicate albums."""
    _require_writes()
    ps = _photoscript()
    lib = ps.PhotosLibrary()
    try:
        if args.folder:
            # "/"-separated folder path; each segment is created if missing
            # (folder names containing a literal "/" are not addressable).
            path = [seg for seg in args.folder.split("/") if seg.strip()]
            if not path:
                raise RuntimeError("folder must contain at least one folder name")
            folder = lib.make_folders(path)
            existing = folder.album(args.name)
            if existing is not None:
                return {"album": _album_payload(existing), "created": False}
            return {"album": _album_payload(folder.create_album(args.name)), "created": True}
        # No folder: the idempotency check matches an album of that name
        # ANYWHERE in the library (first match), so re-runs find the album
        # even if it was originally created inside a folder.
        existing = lib.album(args.name)
        if existing is not None:
            return {"album": _album_payload(existing), "created": False}
        return {"album": _album_payload(lib.create_album(args.name)), "created": True}
    finally:
        _mark_library_written()


def cmd_add_to_album(args):
    """Add photos (by UUID) to an album. Idempotent: photos already in the
    album are reported in alreadyPresent, not added twice (Photos albums are
    sets). Unknown UUIDs are reported in notFound; the batch fails only when
    NO requested photo exists."""
    _require_writes()
    ps = _photoscript()
    lib = ps.PhotosLibrary()
    try:
        album = _resolve_album(ps, lib, args.album)
        photos, not_found = _resolve_photos(ps, args.uuid)
        if not photos:
            raise RuntimeError(
                "None of the requested photos exist in the library: "
                + ", ".join(not_found)
            )
        members = {_bare_uuid(m) for m in _run_script(ps, "albumPhotes", album.id)}
        to_add = [p for p in photos if p.uuid not in members]
        already = [p.uuid for p in photos if p.uuid in members]
        if to_add:
            # albumAdd verifies membership after adding (retrying internally),
            # so a normal return means every photo really is in the album.
            _run_script(ps, "albumAdd", album.id, [p.id for p in to_add])
        return {
            "album": _album_payload(album),
            "addedCount": len(to_add),
            "added": [p.uuid for p in to_add],
            "alreadyPresent": already,
            "notFound": not_found,
        }
    finally:
        _mark_library_written()


def cmd_remove_from_album(args):
    """Remove photos (by UUID) from an album — NEVER from the library: the
    photos stay in All Photos and every other album.

    Photos' AppleScript dictionary has no remove-from-album verb, so removal
    REBUILDS the album (the same approach photoscript's Album.remove uses,
    implemented here with bulk id calls instead of per-photo objects): create
    a scratch album in the same folder, add every kept photo, delete the
    original, rename. Consequences callers must know: the album's UUID CHANGES
    (albumRecreated=true, previousAlbumUuid reports the old one) and any custom
    manual sort order is lost. When none of the UUIDs are in the album the
    rebuild is skipped entirely (albumRecreated=false)."""
    _require_writes()
    ps = _photoscript()
    lib = ps.PhotosLibrary()
    try:
        album = _resolve_album(ps, lib, args.album)
        requested = list(dict.fromkeys(args.uuid))
        member_ids = _run_script(ps, "albumPhotes", album.id)
        members = {_bare_uuid(m) for m in member_ids}
        to_remove = [u for u in requested if u in members]
        not_in_album = [u for u in requested if u not in members]
        if not to_remove:
            return {
                "album": _album_payload(album),
                "removedCount": 0,
                "removed": [],
                "notInAlbum": not_in_album,
                "albumRecreated": False,
            }

        remove_set = set(to_remove)
        keep_ids = [m for m in member_ids if _bare_uuid(m) not in remove_set]
        previous_uuid = album.uuid
        name = album.name
        new_album = lib.create_album(_temp_album_name(lib), folder=album.parent)
        try:
            if keep_ids:
                _run_script(ps, "albumAdd", new_album.id, keep_ids)
        except Exception:
            # Rebuild failed before anything was destroyed: drop the scratch
            # album and leave the original untouched.
            lib.delete_album(new_album)
            raise
        lib.delete_album(album)
        new_album.name = name
        return {
            "album": _album_payload(new_album),
            "removedCount": len(to_remove),
            "removed": to_remove,
            "notInAlbum": not_in_album,
            "albumRecreated": True,
            "previousAlbumUuid": previous_uuid,
        }
    finally:
        _mark_library_written()


def cmd_set_photo_metadata(args):
    """Set title / description / favorite on one photo. Only the fields passed
    are touched; before/after values are echoed so a caller can revert."""
    _require_writes()
    if args.title is None and args.description is None and args.favorite is None:
        raise RuntimeError(
            "Nothing to update: pass at least one of --title, --description, --favorite"
        )
    ps = _photoscript()
    try:
        photo = _resolve_photo(ps, args.uuid)
        before = {
            "title": photo.title,
            "description": photo.description,
            "favorite": photo.favorite,
        }
        updated = []
        if args.title is not None:
            photo.title = args.title
            updated.append("title")
        if args.description is not None:
            photo.description = args.description
            updated.append("description")
        if args.favorite is not None:
            photo.favorite = args.favorite == "true"
            updated.append("favorite")
        after = {
            "title": photo.title,
            "description": photo.description,
            "favorite": photo.favorite,
        }
        return {"uuid": photo.uuid, "updated": updated, "before": before, "after": after}
    finally:
        _mark_library_written()


def cmd_set_keywords(args):
    """Add/remove keywords on one photo with UNION semantics (_merge_keywords):
    existing keywords the caller didn't mention are always preserved — the
    photoscript setter replaces the whole list, so the merge happens here
    against the photo's live keywords. Echoes before/after for revertability."""
    _require_writes()
    add = args.add or []
    remove = args.remove or []
    if not add and not remove:
        raise RuntimeError("Nothing to do: pass --add and/or --remove")
    overlap = sorted(set(add) & set(remove))
    if overlap:
        raise RuntimeError(
            "Keywords cannot be both added and removed: " + ", ".join(overlap)
        )
    ps = _photoscript()
    try:
        photo = _resolve_photo(ps, args.uuid)
        before = list(photo.keywords)
        after, added, removed = _merge_keywords(before, add, remove)
        changed = after != before
        if changed:
            photo.keywords = after
        return {
            "uuid": photo.uuid,
            "before": before,
            "after": after,
            "added": added,
            "removed": removed,
            "changed": changed,
        }
    finally:
        _mark_library_written()


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
    # --- import-date window (QueryOptions added_after/added_before/added_in_last) ---
    p.add_argument("--added-after", help="ISO 8601 lower bound on import date")
    p.add_argument("--added-before", help="ISO 8601 upper bound on import date")
    p.add_argument("--added-in-last", help='Imported within a duration ("7d", "24h")')
    # --- content/organization filters ---
    p.add_argument("--label", action="append", help="Filter by ML label (repeatable)")
    p.add_argument("--folder", action="append", help="Albums in folder (repeatable)")
    p.add_argument("--place", action="append", help="Place-name substring (repeatable)")
    p.add_argument("--has-location", action="store_true", help="Only photos with GPS data")
    p.add_argument("--no-location", action="store_true", help="Only photos without GPS data")
    p.add_argument("--year", action="append", type=int, help="Taken in year (repeatable)")
    p.add_argument("--min-size", type=int, help="Original file size >= bytes")
    p.add_argument("--max-size", type=int, help="Original file size <= bytes")
    p.add_argument("--no-keyword", action="store_true", help="Only photos with no keyword")
    p.add_argument("--burst", action="store_true", help="Only burst photos")
    # --- media-type flags ---
    p.add_argument("--screenshot", action="store_true", help="Only screenshots")
    p.add_argument("--screen-recording", action="store_true", help="Only screen recordings")
    p.add_argument("--selfie", action="store_true", help="Only selfies")
    p.add_argument("--panorama", action="store_true", help="Only panoramas")
    p.add_argument("--live", action="store_true", help="Only live photos")
    p.add_argument("--portrait", action="store_true", help="Only portrait-mode photos")
    p.add_argument("--time-lapse", action="store_true", help="Only time-lapse videos")
    p.add_argument("--slow-mo", action="store_true", help="Only slow-motion videos")
    # --- ordering ---
    p.add_argument(
        "--newest-first",
        action="store_true",
        help="Sort by date descending BEFORE the limit slice (limit = N most recent)",
    )


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

    p = sub.add_parser("get-photos")
    _add_library(p)
    p.add_argument("--uuid", action="append", required=True, help="UUID(s) to fetch (repeatable)")

    p = sub.add_parser("get-thumbnail")
    _add_library(p)
    p.add_argument("--uuid", required=True)
    p.add_argument(
        "--min-size",
        type=int,
        help=f"Smallest acceptable long-edge pixels (default {DEFAULT_THUMBNAIL_MIN_SIZE})",
    )

    p = sub.add_parser("find-duplicates")
    _add_library(p)
    p.add_argument("--limit", type=int, help="Max number of duplicate groups (default 100)")

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

    # --- write commands (gated; no --library: writes always target the
    #     library currently open in Photos.app) ---
    p = sub.add_parser("create-album")
    p.add_argument("--name", required=True, help="Album name")
    p.add_argument(
        "--folder",
        help='Folder path to nest the album under ("A/B"); folders are created as needed',
    )

    p = sub.add_parser("add-to-album")
    p.add_argument("--album", required=True, help="Album name or UUID")
    p.add_argument("--uuid", action="append", required=True, help="Photo UUID(s) to add")

    p = sub.add_parser("remove-from-album")
    p.add_argument("--album", required=True, help="Album name or UUID")
    p.add_argument("--uuid", action="append", required=True, help="Photo UUID(s) to remove")

    p = sub.add_parser("set-photo-metadata")
    p.add_argument("--uuid", required=True, help="Photo UUID")
    p.add_argument("--title", help="New title (empty string clears)")
    p.add_argument("--description", help="New description (empty string clears)")
    p.add_argument("--favorite", choices=["true", "false"], help="Favorite flag")

    p = sub.add_parser("set-keywords")
    p.add_argument("--uuid", required=True, help="Photo UUID")
    p.add_argument("--add", action="append", help="Keyword to add (repeatable)")
    p.add_argument("--remove", action="append", help="Keyword to remove (repeatable)")

    return parser


HANDLERS = {
    "health": cmd_health,
    "library-info": cmd_library_info,
    "query": cmd_query,
    "get-photo": cmd_get_photo,
    "get-photos": cmd_get_photos,
    "get-thumbnail": cmd_get_thumbnail,
    "find-duplicates": cmd_find_duplicates,
    "list-albums": cmd_list_albums,
    "list-folders": cmd_list_folders,
    "list-keywords": cmd_list_keywords,
    "list-persons": cmd_list_persons,
    "export": cmd_export,
    # write commands (gated behind APPLE_PHOTOS_MCP_ENABLE_WRITES)
    "create-album": cmd_create_album,
    "add-to-album": cmd_add_to_album,
    "remove-from-album": cmd_remove_from_album,
    "set-photo-metadata": cmd_set_photo_metadata,
    "set-keywords": cmd_set_keywords,
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
