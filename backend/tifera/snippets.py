"""User-defined command snippets, persisted in SQLite on the PVC
(same database file as the action log, separate connection)."""

import logging
import os
import sqlite3
import threading
import time

from . import config as cfg

log = logging.getLogger("tifera.snippets")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    created REAL NOT NULL
);
"""


class SnippetStore:
    def __init__(self) -> None:
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    def open(self) -> None:
        os.makedirs(cfg.DATA_DIR, exist_ok=True)
        self._conn = sqlite3.connect(os.path.join(cfg.DATA_DIR, "tifera.db"),
                                     check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def list(self) -> list[dict]:
        if self._conn is None:
            return []
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, name, command, created FROM snippets ORDER BY name").fetchall()
        return [{"id": r[0], "name": r[1], "command": r[2], "created": r[3]}
                for r in rows]

    def add(self, name: str, command: str) -> dict:
        if self._conn is None:
            raise RuntimeError("snippet store not open")
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO snippets (name, command, created) VALUES (?,?,?)",
                (name, command, time.time()))
            self._conn.commit()
        return {"id": cur.lastrowid, "name": name, "command": command}

    def delete(self, snippet_id: int) -> None:
        if self._conn is None:
            return
        with self._lock:
            self._conn.execute("DELETE FROM snippets WHERE id = ?", (snippet_id,))
            self._conn.commit()


snippet_store = SnippetStore()
