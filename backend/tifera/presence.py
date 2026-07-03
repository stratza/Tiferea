"""Multi-client presence.

In-memory registry of active terminal sessions keyed by target container.
Every open/close broadcasts a presence delta to all consoles; the frontend
derives badges and mutual same-container warnings from it.
Nothing here is persisted - a backend restart resets presence.
"""

import threading
import time


def target_key(namespace: str, pod: str, container: str) -> str:
    return f"{namespace}/{pod}/{container}"


class PresenceRegistry:
    def __init__(self) -> None:
        self._sessions: dict[str, dict] = {}  # session_id -> entry
        self._lock = threading.Lock()

    def add(self, session_id: str, namespace: str, pod: str, container: str,
            client_id: str, client_name: str) -> None:
        with self._lock:
            self._sessions[session_id] = {
                "sessionId": session_id,
                "target": target_key(namespace, pod, container),
                "clientId": client_id,
                "clientName": client_name,
                "startedAt": time.time(),
            }
        self._broadcast(target_key(namespace, pod, container))

    def remove(self, session_id: str) -> None:
        with self._lock:
            entry = self._sessions.pop(session_id, None)
        if entry:
            self._broadcast(entry["target"])

    def sessions_for(self, target: str) -> list[dict]:
        with self._lock:
            return [dict(e) for e in self._sessions.values() if e["target"] == target]

    def snapshot(self) -> dict[str, list[dict]]:
        """target -> active sessions, for the initial events-WS payload."""
        with self._lock:
            out: dict[str, list[dict]] = {}
            for e in self._sessions.values():
                out.setdefault(e["target"], []).append(dict(e))
            return out

    def others_on(self, target: str, client_id: str) -> list[dict]:
        """Active sessions on `target` from clients other than `client_id`
        (same client in two tabs is counted, not warned)."""
        return [e for e in self.sessions_for(target) if e["clientId"] != client_id]

    def _broadcast(self, target: str) -> None:
        from .broadcast import broadcaster
        broadcaster.publish({
            "type": "presence",
            "target": target,
            "sessions": self.sessions_for(target),
        })


class EditorRegistry:
    """Courtesy tracking of files open in the built-in editor.

    Purely informational, like session presence: both sides get a mutual
    warning when two clients edit the same file in the same container.
    Entries are dropped when the client's events WebSocket goes away.
    """

    def __init__(self) -> None:
        self._open: dict[tuple[str, str, str], dict] = {}  # (client, target, path)
        self._lock = threading.Lock()

    def open(self, target: str, path: str, client_id: str, client_name: str) -> list[dict]:
        with self._lock:
            self._open[(client_id, target, path)] = {
                "target": target, "path": path,
                "clientId": client_id, "clientName": client_name,
                "openedAt": time.time(),
            }
        self._broadcast(target, path)
        return self.others(target, path, client_id)

    def close(self, target: str, path: str, client_id: str) -> None:
        with self._lock:
            removed = self._open.pop((client_id, target, path), None)
        if removed:
            self._broadcast(target, path)

    def drop_client(self, client_id: str) -> None:
        with self._lock:
            gone = [k for k in self._open if k[0] == client_id]
            entries = [self._open.pop(k) for k in gone]
        for e in entries:
            self._broadcast(e["target"], e["path"])

    def editors(self, target: str, path: str) -> list[dict]:
        with self._lock:
            return [dict(e) for e in self._open.values()
                    if e["target"] == target and e["path"] == path]

    def others(self, target: str, path: str, client_id: str) -> list[dict]:
        return [e for e in self.editors(target, path) if e["clientId"] != client_id]

    def _broadcast(self, target: str, path: str) -> None:
        from .broadcast import broadcaster
        broadcaster.publish({
            "type": "editor",
            "target": target,
            "path": path,
            "editors": self.editors(target, path),
        })


presence = PresenceRegistry()
editors = EditorRegistry()
