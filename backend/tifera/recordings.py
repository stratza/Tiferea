"""Session recording index + retrieval (feature: playback).

Recordings are asciinema v2 .cast files written under DATA_DIR/casts when
TIFERA_RECORD_SESSIONS is enabled. This module lists them (reading each
header line) and serves/deletes individual files, with strict name
validation to prevent path traversal.
"""

import glob
import json
import os
import re

from . import config as cfg

_NAME_RE = re.compile(r"^[\w.\-]+\.cast$")


def _casts_dir() -> str:
    return os.path.join(cfg.DATA_DIR, "casts")


def list_recordings() -> list[dict]:
    out = []
    for path in glob.glob(os.path.join(_casts_dir(), "*.cast")):
        try:
            st = os.stat(path)
            with open(path, encoding="utf-8") as f:
                header = json.loads(f.readline() or "{}")
        except (OSError, ValueError):
            continue
        out.append({
            "name": os.path.basename(path),
            "size": st.st_size,
            "mtime": st.st_mtime,
            "title": header.get("title", ""),
            "timestamp": header.get("timestamp"),
            "width": header.get("width"),
            "height": header.get("height"),
        })
    out.sort(key=lambda r: r["mtime"], reverse=True)
    return out


def _safe_path(name: str) -> str | None:
    if not _NAME_RE.match(name):
        return None
    path = os.path.join(_casts_dir(), name)
    # Defence in depth: the resolved path must stay inside the casts dir.
    if os.path.dirname(os.path.abspath(path)) != os.path.abspath(_casts_dir()):
        return None
    return path


def read_recording(name: str) -> str | None:
    path = _safe_path(name)
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as f:
        return f.read()


def delete_recording(name: str) -> bool:
    path = _safe_path(name)
    if not path or not os.path.isfile(path):
        return False
    try:
        os.remove(path)
        return True
    except OSError:
        return False
