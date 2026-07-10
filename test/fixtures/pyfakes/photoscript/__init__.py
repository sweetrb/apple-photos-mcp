"""Fake photoscript backed by an in-memory library loaded from the JSON file
named by FAKE_PHOTOSCRIPT_STATE. Mirrors the slice of photoscript 0.5.3's API
that photos_reader.py's write commands use (Photo/Album/Folder/PhotosLibrary
plus script_loader.run_script for albumPhotes/albumAdd), so the REAL handler
logic — gating, validation, union merges, the remove rebuild — runs unmodified
against deterministic data with no Photos.app, no AppleScript, no TCC.

Every mutation is appended as a JSON line to FAKE_PHOTOSCRIPT_LOG so tests can
assert exactly which writes happened (and, as importantly, which didn't).

State shape:
{
  "albums": [{"uuid", "name", "path", "members": [uuid...], "folder": [..]?}],
  "photos": {uuid: {"title", "description", "favorite", "keywords": [...],
                    "date": "ISO"?, "filename": str?}},
  "running": bool?,        # Photos.app running (default true)
  "selection": [uuid...]?  # current GUI selection (default [])
}
"""

import json
import os
from datetime import datetime

_state_cache = None


def _state():
    global _state_cache
    if _state_cache is None:
        with open(os.environ["FAKE_PHOTOSCRIPT_STATE"]) as f:
            _state_cache = json.load(f)
    return _state_cache


def _log(event):
    path = os.environ.get("FAKE_PHOTOSCRIPT_LOG")
    if path:
        with open(path, "a") as f:
            f.write(json.dumps(event) + "\n")


def _album_record(bare_uuid):
    for a in _state()["albums"]:
        if a["uuid"] == bare_uuid:
            return a
    return None


class Photo:
    def __init__(self, uuid):
        bare = uuid.split("/")[0]
        if bare not in _state()["photos"]:
            raise ValueError(f"Invalid photo id: {bare}")
        self._uuid = bare
        self.id = bare + "/L0/001"

    @property
    def uuid(self):
        return self._uuid

    def _rec(self):
        return _state()["photos"][self._uuid]

    @property
    def title(self):
        return self._rec().get("title", "")

    @title.setter
    def title(self, value):
        self._rec()["title"] = value
        _log({"op": "set_title", "uuid": self._uuid, "value": value})

    @property
    def description(self):
        return self._rec().get("description", "")

    @description.setter
    def description(self, value):
        self._rec()["description"] = value
        _log({"op": "set_description", "uuid": self._uuid, "value": value})

    @property
    def favorite(self):
        return self._rec().get("favorite", False)

    @favorite.setter
    def favorite(self, value):
        self._rec()["favorite"] = bool(value)
        _log({"op": "set_favorite", "uuid": self._uuid, "value": bool(value)})

    @property
    def keywords(self):
        return list(self._rec().get("keywords", []))

    @keywords.setter
    def keywords(self, value):
        self._rec()["keywords"] = list(value)
        _log({"op": "set_keywords", "uuid": self._uuid, "value": list(value)})

    @property
    def date(self):
        raw = self._rec().get("date")
        return datetime.fromisoformat(raw) if raw else None

    @date.setter
    def date(self, value):
        self._rec()["date"] = value.isoformat()
        _log({"op": "set_date", "uuid": self._uuid, "value": value.isoformat()})

    @property
    def filename(self):
        return self._rec().get("filename", f"{self._uuid}.jpg")


class Album:
    def __init__(self, uuid):
        bare = uuid.split("/")[0]
        if _album_record(bare) is None:
            raise ValueError(f"Invalid album id: {bare}")
        self._uuid = bare
        self.id = bare + "/L0/040"

    def _rec(self):
        return _album_record(self._uuid)

    @property
    def uuid(self):
        return self._uuid

    @property
    def name(self):
        return self._rec()["name"]

    @name.setter
    def name(self, value):
        self._rec()["name"] = value
        _log({"op": "rename_album", "uuid": self._uuid, "name": value})

    @property
    def parent(self):
        folder = self._rec().get("folder")
        return Folder(folder) if folder else None

    def path_str(self, delim="/"):
        rec = self._rec()
        return rec.get("path") or rec["name"]


class Folder:
    def __init__(self, path):
        self._path = list(path)
        self.idstring = "folder:" + "/".join(self._path)

    @property
    def name(self):
        return self._path[-1]

    def album(self, name):
        for a in _state()["albums"]:
            if a["name"] == name and a.get("folder") == self._path:
                return Album(a["uuid"])
        return None

    def create_album(self, name):
        return _create_album(name, folder=self)


def _create_album(name, folder=None):
    n = len(_state()["albums"]) + 1
    rec = {
        "uuid": f"CEA{n:03d}",
        "name": name,
        "path": "/".join((folder._path if folder else []) + [name]),
        "members": [],
    }
    if folder is not None:
        rec["folder"] = folder._path
    _state()["albums"].append(rec)
    _log(
        {
            "op": "create_album",
            "uuid": rec["uuid"],
            "name": name,
            "folder": folder._path if folder else None,
        }
    )
    return Album(rec["uuid"])


class PhotosLibrary:
    def __init__(self):
        pass

    def album(self, *name, uuid=None, top_level=False):
        if name:
            for a in _state()["albums"]:
                if a["name"] == name[0]:
                    return Album(a["uuid"])
            return None
        return Album(uuid)

    def create_album(self, name, folder=None):
        return _create_album(name, folder=folder)

    def delete_album(self, album):
        state = _state()
        state["albums"] = [a for a in state["albums"] if a["uuid"] != album.uuid]
        _log({"op": "delete_album", "uuid": album.uuid})

    def make_folders(self, folder_path):
        if not isinstance(folder_path, list) or not folder_path:
            raise ValueError("folder_path must be a non-empty list")
        _log({"op": "make_folders", "path": folder_path})
        return Folder(folder_path)

    @property
    def running(self):
        return bool(_state().get("running", True))

    @property
    def selection(self):
        return [Photo(u) for u in _state().get("selection", [])]

    def import_photos(self, photo_paths, album=None, skip_duplicate_check=False):
        state = _state()
        imported = []
        for path in photo_paths:
            n = len(state["photos"]) + 1
            uuid = f"IMP{n:03d}"
            state["photos"][uuid] = {
                "title": "",
                "description": "",
                "favorite": False,
                "keywords": [],
                "filename": os.path.basename(str(path)),
            }
            if album is not None:
                _album_record(album.uuid)["members"].append(uuid)
            imported.append(uuid)
        _log(
            {
                "op": "import_photos",
                "paths": [str(p) for p in photo_paths],
                "album": album.uuid if album is not None else None,
                "skip_duplicate_check": bool(skip_duplicate_check),
            }
        )
        return [Photo(u) for u in imported]
