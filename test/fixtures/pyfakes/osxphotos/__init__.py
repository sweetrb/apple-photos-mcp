"""Fake osxphotos for the hermetic sidecar tests.

Historically just enough for photos_reader.py to import (the write commands
never touch the read path). get-selected-photos additionally projects the GUI
selection through PhotosDB.photos(), so PhotosDB now constructs against the
same FAKE_PHOTOSCRIPT_STATE JSON the fake photoscript uses and serves minimal
PhotoInfo objects carrying exactly the attributes _photo_summary reads. With
no state file configured, construction still refuses (preserving the original
"reads are unavailable" contract for pure write tests).
"""

import json
import os
from datetime import datetime

__version__ = "0.0.0-fake"


class _FakePhotoInfo:
    def __init__(self, uuid, rec):
        raw_date = rec.get("date")
        self.uuid = uuid
        self.original_filename = rec.get("filename", f"{uuid}.jpg")
        self.date = datetime.fromisoformat(raw_date) if raw_date else None
        self.title = rec.get("title") or None
        self.favorite = bool(rec.get("favorite", False))
        self.hidden = bool(rec.get("hidden", False))
        self.ismissing = bool(rec.get("ismissing", False))
        self.isphoto = bool(rec.get("isphoto", True))
        self.ismovie = bool(rec.get("ismovie", False))
        self.width = rec.get("width")
        self.height = rec.get("height")
        self.albums = list(rec.get("albums", []))
        self.keywords = list(rec.get("keywords", []))
        self.persons = list(rec.get("persons", []))


class PhotosDB:
    def __init__(self, dbfile=None):
        state_path = os.environ.get("FAKE_PHOTOSCRIPT_STATE")
        if not state_path:
            raise RuntimeError("fake osxphotos: reads are unavailable in this test harness")
        with open(state_path) as f:
            self._photos = json.load(f).get("photos", {})
        self.library_path = None

    def photos(self, uuid=None, intrash=False):
        if intrash:
            return []
        uuids = uuid if uuid is not None else list(self._photos)
        # A photo record can opt out of the "library index" with
        # inLibraryIndex: false — simulating a just-imported item Photos.app
        # knows but hasn't checkpointed to Photos.sqlite yet.
        return [
            _FakePhotoInfo(u, self._photos[u])
            for u in uuids
            if u in self._photos and self._photos[u].get("inLibraryIndex", True)
        ]


class QueryOptions:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
