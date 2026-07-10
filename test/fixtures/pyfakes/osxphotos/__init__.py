"""Fake osxphotos — just enough for photos_reader.py to import. The write-tool
tests never touch the read path, so PhotosDB refuses to construct."""

__version__ = "0.0.0-fake"


class PhotosDB:
    def __init__(self, dbfile=None):
        raise RuntimeError("fake osxphotos: reads are unavailable in this test harness")


class QueryOptions:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
