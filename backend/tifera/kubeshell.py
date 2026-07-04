"""In-cluster kubectl console (Rancher-style).

Spawns an interactive PTY shell inside TifEra's own container - which ships
kubectl - so operators can run cluster commands from the browser. kubectl
authenticates with TifEra's ServiceAccount via in-cluster config, so the
console is bounded by TifEra's RBAC; it is NOT cluster-admin.

The shell is a local subprocess (not a K8s exec), so this works without any
extra permissions. ptyprocess is Linux-only and imported lazily so the rest
of the app still imports on non-Unix dev machines.
"""

import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Callable

from . import config as cfg
from .actionlog import actionlog

log = logging.getLogger("tifera.kubeshell")

Sink = Callable[[bytes | None], None]

try:
    from ptyprocess import PtyProcess
except Exception:  # noqa: BLE001 - Unix-only; absent on Windows dev boxes
    PtyProcess = None


def available() -> tuple[bool, str]:
    """Whether the kubectl console can run here: needs a PTY backend and the
    kubectl binary on PATH."""
    if PtyProcess is None:
        return False, "PTY support is unavailable (ptyprocess not importable)"
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if os.path.isfile(os.path.join(d, "kubectl")):
            return True, ""
    if os.path.isfile("/usr/local/bin/kubectl"):
        return True, ""
    return False, "kubectl is not installed in this image"


class KubeShell:
    def __init__(self, sink: Sink, *, client_id: str, client_name: str,
                 client_ip: str, cols: int = 80, rows: int = 24) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.client_id = client_id
        self.client_name = client_name
        self.client_ip = client_ip
        self.created_at = time.time()
        self.last_activity = time.time()
        self.exit_message = ""
        self.closed = threading.Event()
        self._sink = sink
        self._lock = threading.Lock()

        env = dict(os.environ)
        env.update({
            "HOME": "/tmp",                 # writable under read-only rootfs
            "KUBECONFIG": "",               # force in-cluster config
            "KUBECACHEDIR": "/tmp/.kube-cache",
            "TERM": "xterm-256color",
            "PAGER": "cat",                 # never block on a pager
            "PS1": r"\[\e[90m\]kubectl\[\e[0m\] \w $ ",
        })
        os.makedirs("/tmp/.kube-cache", exist_ok=True)
        shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
        argv = [shell, "-i"] if shell.endswith("bash") else [shell, "-i"]

        # PtyProcess.spawn does the fork/setsid/TIOCSCTTY dance correctly.
        self._pty = PtyProcess.spawn(
            argv, env=env, cwd="/tmp", dimensions=(rows, cols))
        self._thread = threading.Thread(target=self._pump, name=f"kubectl-{self.id}",
                                        daemon=True)

    def start(self) -> None:
        self._thread.start()
        actionlog.record("kubectl_open", client_id=self.client_id,
                         client_name=self.client_name, client_ip=self.client_ip,
                         detail=json.dumps({"sessionId": self.id}))
        log.info("kubectl console %s opened by %s (%s)",
                 self.id, self.client_name or self.client_id, self.client_ip)

    def write_stdin(self, data: bytes) -> None:
        self.last_activity = time.time()
        try:
            with self._lock:
                self._pty.write(data)
        except Exception:  # noqa: BLE001 - closing
            pass

    def resize(self, cols: int, rows: int) -> None:
        try:
            with self._lock:
                self._pty.setwinsize(rows, cols)
        except Exception:  # noqa: BLE001
            pass

    def close(self, reason: str) -> None:
        if not self.exit_message:
            self.exit_message = reason
        try:
            self._pty.terminate(force=True)
        except Exception:  # noqa: BLE001
            pass

    def _pump(self) -> None:
        try:
            while True:
                data = self._pty.read(65536)   # raises EOFError at end
                if data:
                    self.last_activity = time.time()
                    self._sink(data)
        except EOFError:
            pass
        except Exception as exc:  # noqa: BLE001
            if not self.exit_message:
                self.exit_message = f"shell error: {exc}"
        if not self.exit_message:
            self.exit_message = "shell exited"
        self._finalize()

    def _finalize(self) -> None:
        self.closed.set()
        actionlog.record("kubectl_close", client_id=self.client_id,
                         client_name=self.client_name, client_ip=self.client_ip,
                         detail=json.dumps({"sessionId": self.id,
                                            "durationSeconds": round(time.time() - self.created_at, 1)}))
        self._sink(None)
        shells._discard(self.id)
        log.info("kubectl console %s closed (%s)", self.id, self.exit_message)


class KubeShellManager:
    def __init__(self) -> None:
        self._shells: dict[str, KubeShell] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()

    def start(self) -> None:
        threading.Thread(target=self._reap_loop, name="kubectl-reaper", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def create(self, sink: Sink, **kw) -> KubeShell:
        shell = KubeShell(sink, **kw)
        with self._lock:
            self._shells[shell.id] = shell
        shell.start()
        return shell

    def count(self) -> int:
        with self._lock:
            return len(self._shells)

    def close_all(self, reason: str) -> None:
        with self._lock:
            active = list(self._shells.values())
        for s in active:
            s.close(reason)

    def _discard(self, shell_id: str) -> None:
        with self._lock:
            self._shells.pop(shell_id, None)

    def _reap_loop(self) -> None:
        while not self._stop.wait(30):
            now = time.time()
            with self._lock:
                active = list(self._shells.values())
            for s in active:
                if not s.closed.is_set() and now - s.last_activity > cfg.IDLE_TIMEOUT_SECONDS:
                    s.close("idle timeout")


shells = KubeShellManager()
