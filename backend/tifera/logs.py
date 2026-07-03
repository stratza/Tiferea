"""Container log streaming.

Live-follow and previous-instance logs are read from the K8s API as a
blocking urllib3 response on a worker thread and handed to the console
WebSocket chunk by chunk. close() closes the response, which unblocks the
thread and ends the stream.
"""

import logging
import socket
import threading
from collections.abc import Callable

from kubernetes import client

log = logging.getLogger("tifera.logs")

# sink(chunk) per log chunk; sink(None) at end of stream.
Sink = Callable[[bytes | None], None]


class LogStream:
    def __init__(self, namespace: str, pod: str, container: str, *, sink: Sink,
                 follow: bool = True, tail_lines: int = 500,
                 previous: bool = False, timestamps: bool = False) -> None:
        self._sink = sink
        v1 = client.CoreV1Api()
        # Raises ApiException synchronously (container unknown, no previous
        # instance, RBAC) - the caller reports that to the console.
        self._resp = v1.read_namespaced_pod_log(
            pod, namespace, container=container, follow=follow,
            tail_lines=tail_lines, previous=previous, timestamps=timestamps,
            _preload_content=False)
        threading.Thread(target=self._pump, name=f"logs-{pod}-{container}",
                         daemon=True).start()

    def _pump(self) -> None:
        try:
            for chunk in self._resp.stream(amt=16384, decode_content=True):
                if chunk:
                    self._sink(chunk)
        except Exception as exc:  # noqa: BLE001 - includes our own close()
            log.debug("log stream ended: %s", exc)
        try:
            # The reader thread owns resp.close(); see close() below.
            self._resp.close()
        except Exception:  # noqa: BLE001
            pass
        self._sink(None)

    def close(self) -> None:
        """Abort the stream WITHOUT blocking the caller.

        Never call resp.close() here: it takes the BufferedReader lock the
        pump thread holds while blocked in read() on a quiet follow stream,
        deadlocking the caller (this froze the entire event loop once -
        liveness kill, pod restart). Shutting the socket down instead makes
        the blocked read return; the pump thread then closes the response.
        """
        try:
            self._resp.shutdown()          # urllib3 >= 2.3, made for this
            return
        except AttributeError:
            pass
        except Exception:  # noqa: BLE001
            return
        try:
            sock = self._resp.connection.sock
            if sock:
                sock.shutdown(socket.SHUT_RDWR)
        except Exception:  # noqa: BLE001
            pass
