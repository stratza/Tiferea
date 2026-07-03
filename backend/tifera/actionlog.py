"""Action log.

Every shell session, file transfer/edit and quick action is recorded with
timestamp, client identity (self-declared - cooperative, not forensic),
client IP and target. SQLite on the PVC; exportable as JSONL.
"""

import json
import logging
import os
import sqlite3
import threading
import time

from . import config as cfg

log = logging.getLogger("tifera.actionlog")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    action TEXT NOT NULL,
    client_id TEXT,
    client_name TEXT,
    client_ip TEXT,
    namespace TEXT,
    pod TEXT,
    container TEXT,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions (ts);
"""


class ActionLog:
    def __init__(self) -> None:
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.Lock()

    def open(self) -> None:
        os.makedirs(cfg.DATA_DIR, exist_ok=True)
        path = os.path.join(cfg.DATA_DIR, "tifera.db")
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        log.info("action log at %s", path)

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    def record(self, action: str, *, client_id: str = "", client_name: str = "",
               client_ip: str = "", namespace: str = "", pod: str = "",
               container: str = "", detail: str = "") -> None:
        if self._conn is None:
            return
        try:
            with self._lock:
                self._conn.execute(
                    "INSERT INTO actions (ts, action, client_id, client_name, client_ip,"
                    " namespace, pod, container, detail) VALUES (?,?,?,?,?,?,?,?,?)",
                    (time.time(), action, client_id, client_name, client_ip,
                     namespace, pod, container, detail))
                self._conn.commit()
        except sqlite3.Error as exc:
            log.error("action log write failed: %s", exc)

    def recent(self, limit: int = 200) -> list[dict]:
        if self._conn is None:
            return []
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, action, client_id, client_name, client_ip, namespace,"
                " pod, container, detail FROM actions ORDER BY id DESC LIMIT ?",
                (limit,)).fetchall()
        keys = ("ts", "action", "clientId", "clientName", "clientIp",
                "namespace", "pod", "container", "detail")
        return [dict(zip(keys, row)) for row in rows]

    def export_jsonl(self) -> str:
        return "\n".join(json.dumps(row) for row in reversed(self.recent(limit=100_000)))


actionlog = ActionLog()
