"""Fan-out of server-pushed events (inventory, presence, metrics) to every
connected console over the /ws/events channel.

Publishers may run in worker threads (K8s watch loops); subscribers are
asyncio WebSocket handlers. publish() is therefore thread-safe.
"""

import asyncio
import logging
import threading

log = logging.getLogger("tifera.broadcast")


class Broadcaster:
    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queues: set[asyncio.Queue] = set()
        self._lock = threading.Lock()

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._queues.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self._queues.discard(q)

    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._queues)

    def publish(self, message: dict) -> None:
        """Thread-safe: usable from watch/poll threads and async handlers."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._publish_on_loop, message)

    def _publish_on_loop(self, message: dict) -> None:
        with self._lock:
            queues = list(self._queues)
        for q in queues:
            try:
                q.put_nowait(message)
            except asyncio.QueueFull:
                # Slow consumer: drop the message rather than stall everyone.
                log.warning("dropping event for slow events subscriber")


broadcaster = Broadcaster()
