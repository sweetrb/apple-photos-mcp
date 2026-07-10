"""Fake script_loader: the two raw AppleScript calls photos_reader.py uses
(albumPhotes / albumAdd) plus configure_run_script (recorded so tests can
assert the killall-Photos retry policy is disabled)."""

from . import _album_record, _log


def configure_run_script(retry_enabled=None, retries=None, wait_seconds=None):
    _log({"op": "configure_run_script", "retry_enabled": retry_enabled})


def run_script(name, *args):
    if name == "albumPhotes":
        rec = _album_record(args[0].split("/")[0])
        if rec is None:
            raise RuntimeError(f"fake: no album {args[0]}")
        return [m + "/L0/001" for m in rec["members"]]

    if name == "albumAdd":
        rec = _album_record(args[0].split("/")[0])
        if rec is None:
            raise RuntimeError(f"fake: no album {args[0]}")
        ids = [i.split("/")[0] for i in args[1]]
        for i in ids:
            if i not in rec["members"]:
                rec["members"].append(i)
        _log({"op": "album_add", "album": rec["uuid"], "ids": ids})
        return [i + "/L0/001" for i in ids]

    raise RuntimeError(f"fake run_script: unhandled handler {name!r}")
