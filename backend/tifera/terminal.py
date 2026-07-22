"""Interactive shell sessions (the core feature).

A Session owns one `pods/exec` PTY stream against the K8s API. Sessions are
fully isolated per client: each has its own exec stream, PTY size,
scrollback buffer and lifecycle, and is retrievable only by the client that
opened it (keyed client ID + session ID).

The session outlives the browser WebSocket: on drop, the PTY keeps running
for RECONNECT_GRACE_SECONDS and the scrollback buffer is replayed on
reattach. Sessions with no input/output for IDLE_TIMEOUT_SECONDS are closed.
"""

import glob
import json
import logging
import os
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable

from kubernetes import client
from kubernetes.stream import stream
from kubernetes.stream.ws_client import ERROR_CHANNEL, RESIZE_CHANNEL

from . import config as cfg
from .actionlog import actionlog
from .presence import presence, target_key

log = logging.getLogger("tifera.terminal")

# sink(chunk) receives PTY output; sink(None) means the session ended.
Sink = Callable[[bytes | None], None]


class ShellNotFound(RuntimeError):
    """No usable shell in the target container; the console offers the
    ephemeral debug-container fallback when it sees this."""


def _open_exec(namespace: str, pod: str, container: str, shell: str):
    """Open a TTY exec stream running `shell`; raise ShellNotFound if the
    kubelet rejects it (typically: executable not found)."""
    v1 = client.CoreV1Api()
    ws = stream(v1.connect_get_namespaced_pod_exec, pod, namespace,
                container=container, command=[shell],
                stdin=True, stdout=True, stderr=True, tty=True,
                _preload_content=False)
    # A missing binary is reported on the error channel moments after the
    # handshake; wait briefly so the caller can try the next candidate.
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        ws.update(timeout=0.1)
        if not ws.is_open():
            try:
                reason = ws.read_channel(ERROR_CHANNEL) or ""
            except Exception:  # noqa: BLE001
                reason = ""
            raise ShellNotFound(f"{shell}: {reason.strip() or 'exec stream closed immediately'}")
        if ws.peek_stdout() or ws.peek_stderr():
            break  # the shell produced output (prompt) - it is alive
    return ws


class Session:
    def __init__(self, ws, *, namespace: str, pod: str, container: str,
                 shell: str, client_id: str, client_name: str, client_ip: str) -> None:
        self.id = uuid.uuid4().hex[:16]
        self.namespace = namespace
        self.pod = pod
        self.container = container
        self.target = target_key(namespace, pod, container)
        self.shell = shell
        self.client_id = client_id
        self.client_name = client_name
        self.client_ip = client_ip
        self.created_at = time.time()
        self.last_activity = time.time()
        self.exit_message = ""
        self.closed = threading.Event()
        self.detached_at: float | None = time.time()  # no console attached yet
        self.shared = False   # collaborative: other clients may join (feature 1)
        self._ws = ws
        self._send_lock = threading.Lock()
        self._buffer: deque[bytes] = deque(maxlen=cfg.SCROLLBACK_CHUNKS)
        self._sinks: dict[str, Sink] = {}   # attach handle -> console feed
        self._sink_lock = threading.Lock()
        self._thread = threading.Thread(target=self._pump, name=f"term-{self.id}", daemon=True)
        self._cast = None
        if cfg.RECORD_SESSIONS:  # cast v2 file format
            try:
                cast_dir = os.path.join(cfg.DATA_DIR, "casts")
                os.makedirs(cast_dir, exist_ok=True)
                self._cast = open(os.path.join(cast_dir, f"{int(self.created_at)}-{self.id}.cast"),
                                  "w", encoding="utf-8")
                self._cast.write(json.dumps({
                    "version": 2, "width": 80, "height": 24,
                    "timestamp": int(self.created_at),
                    "title": f"{self.target} ({client_name or client_id})"}) + "\n")
            except OSError as exc:
                log.warning("session recording disabled for %s: %s", self.id, exc)
                self._cast = None

    # -- console attachment (one owner + optional collaborators) ---------

    def attach(self, sink: Sink) -> tuple[str, bytes]:
        """Register a console feed; returns (handle, scrollback-to-replay).
        A session may have several feeds at once when it is shared."""
        handle = uuid.uuid4().hex[:12]
        with self._sink_lock:
            self._sinks[handle] = sink
            self.detached_at = None
            replay = b"".join(self._buffer)
        if self.closed.is_set():
            sink(None)
        elif self.shared:
            self._announce_participants()
        return handle, replay

    def detach(self, handle: str) -> None:
        with self._sink_lock:
            self._sinks.pop(handle, None)
            empty = not self._sinks
            if empty:
                self.detached_at = time.time()
        if self.shared and not self.closed.is_set():
            self._announce_participants()

    def participant_count(self) -> int:
        with self._sink_lock:
            return len(self._sinks)

    def set_shared(self, on: bool) -> None:
        """Owner toggles collaboration. Shared sessions can be joined by any
        client and everyone attached can type (tmux-style shared control)."""
        self.shared = on
        self._announce_participants()
        actionlog.record(
            "shell_share" if on else "shell_unshare",
            client_id=self.client_id, client_name=self.client_name,
            client_ip=self.client_ip, namespace=self.namespace, pod=self.pod,
            container=self.container, detail=json.dumps({"sessionId": self.id}))

    def _announce_participants(self) -> None:
        presence.set_shared(self.id, self.shared, self.participant_count())

    # -- browser -> PTY ---------------------------------------------------

    def write_stdin(self, data: bytes) -> None:
        self.last_activity = time.time()
        try:
            with self._send_lock:
                self._ws.write_stdin(data.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001 - session is closing; exit follows
            pass

    def resize(self, cols: int, rows: int) -> None:
        # Applies only to this session's own PTY.
        try:
            with self._send_lock:
                self._ws.write_channel(
                    RESIZE_CHANNEL, json.dumps({"Width": cols, "Height": rows}))
        except Exception:  # noqa: BLE001
            pass

    def close(self, reason: str) -> None:
        if not self.exit_message:
            self.exit_message = reason
        # websocket-client's close() performs a close handshake and can block
        # while the pump thread is mid-recv - never run it on the event loop.
        threading.Thread(target=self._close_ws, name=f"close-{self.id}",
                         daemon=True).start()

    def _close_ws(self) -> None:
        try:
            self._ws.close()
        except Exception:  # noqa: BLE001
            pass

    # -- PTY -> console ----------------------------------------------------

    def _pump(self) -> None:
        ws = self._ws
        try:
            while ws.is_open():
                ws.update(timeout=1)
                out = ""
                if ws.peek_stdout():
                    out += ws.read_stdout()
                if ws.peek_stderr():
                    out += ws.read_stderr()
                if out:
                    self.last_activity = time.time()
                    self._emit(out.encode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            if not self.exit_message:
                self.exit_message = f"exec stream error: {exc}"
        if not self.exit_message:
            try:
                status = json.loads(ws.read_channel(ERROR_CHANNEL) or "{}")
                self.exit_message = (status.get("message") or "shell exited"
                                     if status.get("status") != "Success" else "shell exited")
            except Exception:  # noqa: BLE001
                self.exit_message = "shell exited"
        self._finalize()

    def _emit(self, chunk: bytes) -> None:
        with self._sink_lock:
            self._buffer.append(chunk)
            sinks = list(self._sinks.values())
        if self._cast:
            try:
                self._cast.write(json.dumps(
                    [round(time.time() - self.created_at, 6), "o",
                     chunk.decode("utf-8", "replace")]) + "\n")
            except (OSError, ValueError):
                pass
        for sink in sinks:
            sink(chunk)

    def _finalize(self) -> None:
        self.closed.set()
        if self._cast:
            try:
                self._cast.close()
            except OSError:
                pass
        presence.remove(self.id)
        actionlog.record(
            "shell_close", client_id=self.client_id, client_name=self.client_name,
            client_ip=self.client_ip, namespace=self.namespace, pod=self.pod,
            container=self.container,
            detail=json.dumps({"sessionId": self.id, "reason": self.exit_message,
                               "durationSeconds": round(time.time() - self.created_at, 1)}))
        with self._sink_lock:
            sinks = list(self._sinks.values())
        for sink in sinks:
            sink(None)
        sessions._discard(self.id)
        log.info("session %s closed (%s)", self.id, self.exit_message)


class SessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def start(self) -> None:
        if cfg.RECORD_SESSIONS:
            self._prune_casts()
        threading.Thread(target=self._reap_loop, name="session-reaper", daemon=True).start()

    @staticmethod
    def _prune_casts() -> None:
        """Recording retention: drop cast files older than CAST_RETENTION_DAYS."""
        cutoff = time.time() - cfg.CAST_RETENTION_DAYS * 86400
        for path in glob.glob(os.path.join(cfg.DATA_DIR, "casts", "*.cast")):
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass

    def stop(self) -> None:
        self._stop.set()

    def create(self, namespace: str, pod: str, container: str, *,
               client_id: str, client_name: str, client_ip: str,
               shell: str | None = None) -> Session:
        # Auto-detection order bash -> sh -> ash, user-overridable.
        candidates = (shell,) if shell else cfg.SHELL_CANDIDATES
        ws = None
        last_error: Exception | None = None
        for candidate in candidates:
            try:
                ws = _open_exec(namespace, pod, container, candidate)
                break
            except ShellNotFound as exc:
                last_error = exc
        if ws is None:
            raise ShellNotFound(
                f"no usable shell in {target_key(namespace, pod, container)} "
                f"(tried {', '.join(candidates)}) - last error: {last_error}")
        session = Session(ws, namespace=namespace, pod=pod, container=container,
                          shell=candidate, client_id=client_id,
                          client_name=client_name, client_ip=client_ip)
        with self._lock:
            self._sessions[session.id] = session
        session._thread.start()
        presence.add(session.id, namespace, pod, container, client_id, client_name)
        actionlog.record(
            "shell_open", client_id=client_id, client_name=client_name,
            client_ip=client_ip, namespace=namespace, pod=pod, container=container,
            detail=json.dumps({"sessionId": session.id, "shell": candidate}))
        log.info("session %s opened by %s (%s) on %s [%s]",
                 session.id, client_name or client_id, client_ip, session.target, candidate)
        return session

    def count(self) -> int:
        with self._lock:
            return len(self._sessions)

    def get(self, session_id: str, client_id: str) -> Session | None:
        """Sessions are private to the client that opened them."""
        with self._lock:
            s = self._sessions.get(session_id)
        if s is None or s.client_id != client_id or s.closed.is_set():
            return None
        return s

    def get_joinable(self, session_id: str, client_id: str) -> Session | None:
        """A session another client may attach to: the owner always may
        (reconnect); everyone else only when the owner has shared it."""
        with self._lock:
            s = self._sessions.get(session_id)
        if s is None or s.closed.is_set():
            return None
        if s.client_id == client_id or s.shared:
            return s
        return None

    def close_all(self, reason: str) -> None:
        """Graceful shutdown."""
        with self._lock:
            active = list(self._sessions.values())
        for s in active:
            s.close(reason)

    def _discard(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)

    def _reap_loop(self) -> None:
        while not self._stop.wait(5):
            now = time.time()
            with self._lock:
                active = list(self._sessions.values())
            for s in active:
                try:
                    if s.closed.is_set():
                        continue
                    if (s.detached_at is not None
                            and now - s.detached_at > cfg.RECONNECT_GRACE_SECONDS):
                        s.close("reconnect grace expired")
                    elif now - s.last_activity > cfg.IDLE_TIMEOUT_SECONDS:
                        s.close("idle timeout")
                except Exception:  # noqa: BLE001 - one bad session must not
                    # stop the reaper from ever running again (it is a
                    # daemon thread with no supervisor).
                    log.exception("session reaper failed on session %s", s.id)


sessions = SessionManager()
