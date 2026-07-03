"""SQLite-backed stores: action log and snippets."""

import json

from tifera import config as cfg
from tifera.actionlog import ActionLog
from tifera.snippets import SnippetStore


def test_actionlog_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg, "DATA_DIR", str(tmp_path))
    log = ActionLog()
    log.open()
    try:
        log.record("shell_open", client_id="c1", client_name="alice",
                   client_ip="10.0.0.5", namespace="ns", pod="p", container="c",
                   detail=json.dumps({"shell": "bash"}))
        log.record("file_upload", client_id="c2", namespace="ns", pod="p",
                   container="c", detail=json.dumps({"path": "/tmp/x", "bytes": 42}))

        rows = log.recent()
        assert len(rows) == 2
        assert rows[0]["action"] == "file_upload"  # newest first
        assert rows[1]["clientName"] == "alice"
        assert rows[1]["clientIp"] == "10.0.0.5"

        lines = log.export_jsonl().splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0])["action"] == "shell_open"  # oldest first
    finally:
        log.close()


def test_actionlog_closed_is_safe():
    log = ActionLog()
    log.record("noop")          # before open: silently dropped
    assert log.recent() == []
    assert log.export_jsonl() == ""


def test_snippets_crud(tmp_path, monkeypatch):
    monkeypatch.setattr(cfg, "DATA_DIR", str(tmp_path))
    store = SnippetStore()
    store.open()
    try:
        added = store.add("disk hogs", "du -sh /* 2>/dev/null | sort -h | tail")
        assert added["id"] > 0
        store.add("listeners", "netstat -tlnp")

        names = [s["name"] for s in store.list()]
        assert names == ["disk hogs", "listeners"]  # sorted by name

        store.delete(added["id"])
        assert [s["name"] for s in store.list()] == ["listeners"]
    finally:
        store.close()
