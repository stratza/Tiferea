"""Resource metrics via metrics.k8s.io.

Polled every METRICS_INTERVAL_SECONDS, cached with ~60 min of history per
container, pushed as deltas over /ws/events. Degrades gracefully
when metrics-server is absent: `available: false` is broadcast
and polling retries at a slower cadence.
"""

import logging
import threading
import time
from collections import deque

from kubernetes import client

from . import config as cfg
from .broadcast import broadcaster

log = logging.getLogger("tifera.metrics")

_MEM_UNITS = {"Ki": 1024, "Mi": 1024**2, "Gi": 1024**3, "Ti": 1024**4,
              "Pi": 1024**5, "Ei": 1024**6,
              "k": 1000, "M": 1000**2, "G": 1000**3, "T": 1000**4,
              "P": 1000**5, "E": 1000**6}


def parse_cpu(q: str) -> float:
    """Kubernetes CPU quantity -> millicores."""
    if not q:
        return 0.0
    try:
        if q.endswith("n"):
            return float(q[:-1]) / 1e6
        if q.endswith("u"):
            return float(q[:-1]) / 1e3
        if q.endswith("m"):
            return float(q[:-1])
        return float(q) * 1000.0
    except ValueError:
        return 0.0


def parse_mem(q: str) -> int:
    """Kubernetes memory quantity -> bytes."""
    if not q:
        return 0
    try:
        for suffix, mult in _MEM_UNITS.items():
            if q.endswith(suffix):
                return int(float(q[:-len(suffix)]) * mult)
        if q.endswith("m"):  # millibytes appear in some API responses
            return int(float(q[:-1]) / 1000)
        return int(float(q))
    except ValueError:
        return 0


class MetricsPoller:
    def __init__(self) -> None:
        self.available: bool | None = None  # None = not yet probed
        self._pods_now: dict[str, dict] = {}   # "ns/pod" and "ns/pod/container"
        self._history: dict[str, deque] = {}   # container target -> (ts, cpu, mem)
        self._nodes: list[dict] = []
        self._alloc: dict[str, dict] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._polls = 0

    def start(self) -> None:
        threading.Thread(target=self._run, name="metrics-poll", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()

    def latest(self) -> dict:
        with self._lock:
            return {"available": self.available, "pods": dict(self._pods_now),
                    "nodes": list(self._nodes)}

    def history(self, target: str) -> list[list]:
        with self._lock:
            return [list(sample) for sample in self._history.get(target, ())]

    def _run(self) -> None:
        co = client.CustomObjectsApi()
        v1 = client.CoreV1Api()
        while True:
            try:
                self._poll(co, v1)
            except Exception:  # noqa: BLE001 - this is the whole poll loop;
                # one bad response must not stop metrics forever.
                log.exception("metrics poll iteration failed")
            # Slow retry cadence while metrics-server is missing.
            interval = cfg.METRICS_INTERVAL_SECONDS * (1 if self.available else 4)
            if self._stop.wait(max(interval, 5)):
                return

    def _poll(self, co, v1) -> None:
        try:
            pod_metrics = co.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods")
        except client.ApiException as exc:
            if exc.status in (403, 404, 503):
                if self.available is not False:
                    log.warning("metrics.k8s.io unavailable (HTTP %s) - "
                                "is metrics-server installed?", exc.status)
                    self.available = False
                    broadcaster.publish({"type": "metrics", "available": False})
                return
            log.warning("pod metrics poll failed: %s", exc.reason)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("pod metrics poll failed: %s", exc)
            return

        now = round(time.time())
        maxlen = max(4, 3600 // max(cfg.METRICS_INTERVAL_SECONDS, 1))
        pods_now: dict[str, dict] = {}
        with self._lock:
            for item in pod_metrics.get("items", []):
                ns = item["metadata"]["namespace"]
                pod = item["metadata"]["name"]
                pod_cpu, pod_mem = 0.0, 0
                for c in item.get("containers", []):
                    target = f"{ns}/{pod}/{c['name']}"
                    cpu = parse_cpu(c.get("usage", {}).get("cpu", ""))
                    mem = parse_mem(c.get("usage", {}).get("memory", ""))
                    pods_now[target] = {"cpu": round(cpu, 1), "mem": mem}
                    hist = self._history.get(target)
                    if hist is None:
                        hist = self._history[target] = deque(maxlen=maxlen)
                    hist.append((now, round(cpu, 1), mem))
                    pod_cpu += cpu
                    pod_mem += mem
                pods_now[f"{ns}/{pod}"] = {"cpu": round(pod_cpu, 1), "mem": pod_mem}
            if self._polls % 40 == 0:  # prune history of deleted containers
                for key in [k for k in self._history if k not in pods_now]:
                    del self._history[key]
                # History grows with (container count x retention window);
                # worth having in the logs when correlating memory against
                # cluster size.
                log.info("metrics history: %d tracked targets, %d samples",
                         len(self._history),
                         sum(len(h) for h in self._history.values()))
            self._pods_now = pods_now

        if self._polls % 20 == 0 or not self._alloc:
            try:
                self._alloc = {
                    n.metadata.name: {
                        "cpu": parse_cpu(n.status.allocatable.get("cpu", "")),
                        "mem": parse_mem(n.status.allocatable.get("memory", "")),
                    } for n in v1.list_node().items}
            except Exception as exc:  # noqa: BLE001
                log.warning("node list failed: %s", exc)

        try:
            node_metrics = co.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "nodes")
        except Exception:  # noqa: BLE001
            node_metrics = {"items": []}
        nodes = []
        for item in node_metrics.get("items", []):
            name = item["metadata"]["name"]
            alloc = self._alloc.get(name, {})
            nodes.append({
                "name": name,
                "cpu": round(parse_cpu(item.get("usage", {}).get("cpu", "")), 1),
                "mem": parse_mem(item.get("usage", {}).get("memory", "")),
                "cpuAlloc": alloc.get("cpu", 0),
                "memAlloc": alloc.get("mem", 0),
            })
        with self._lock:
            self._nodes = nodes

        self._polls += 1
        if self.available is not True:
            self.available = True
            log.info("metrics.k8s.io available")
        broadcaster.publish({"type": "metrics", "available": True, "ts": now,
                             "pods": pods_now, "nodes": nodes})


metrics_poller = MetricsPoller()
