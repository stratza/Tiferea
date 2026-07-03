"""Cluster inventory (namespaces → pods → containers) kept live with a
K8s watch stream and pushed to consoles as deltas over /ws/events.
"""

import logging
import threading
import time

from kubernetes import client, watch

from .broadcast import broadcaster

log = logging.getLogger("tifera.inventory")


def _container_state(status) -> str:
    if status is None or status.state is None:
        return "unknown"
    st = status.state
    if st.running:
        return "running"
    if st.waiting:
        return st.waiting.reason or "waiting"
    if st.terminated:
        return st.terminated.reason or "terminated"
    return "unknown"


def pod_summary(pod) -> dict:
    spec_containers = {c.name: c for c in (pod.spec.containers or [])}
    statuses = {s.name: s for s in (pod.status.container_statuses or [])}
    containers = []
    for name, c in spec_containers.items():
        s = statuses.get(name)
        res = c.resources
        containers.append({
            "name": name,
            "image": c.image,
            "ready": bool(s.ready) if s else False,
            "state": _container_state(s),
            "restarts": s.restart_count if s else 0,
            # Raw quantity strings; shown next to live usage.
            "requests": dict(res.requests) if res and res.requests else {},
            "limits": dict(res.limits) if res and res.limits else {},
        })
    # Surface the most useful status word (CrashLoopBackOff beats "Running").
    phase = pod.status.phase or "Unknown"
    reason = pod.status.reason or ""
    for c in containers:
        if c["state"] not in ("running", "unknown") and not c["ready"]:
            reason = c["state"]
            break
    if pod.metadata.deletion_timestamp is not None:
        reason = "Terminating"
    return {
        "uid": pod.metadata.uid,
        "namespace": pod.metadata.namespace,
        "name": pod.metadata.name,
        "phase": phase,
        "reason": reason,
        "node": pod.spec.node_name or "",
        "createdAt": pod.metadata.creation_timestamp.isoformat()
        if pod.metadata.creation_timestamp else None,
        "restarts": sum(c["restarts"] for c in containers),
        "labels": pod.metadata.labels or {},
        "containers": containers,
    }


class InventoryWatcher:
    """Maintains an in-memory snapshot of all pods and streams deltas."""

    def __init__(self) -> None:
        self._pods: dict[str, dict] = {}  # uid -> summary
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="inventory-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def snapshot(self) -> list[dict]:
        with self._lock:
            return list(self._pods.values())

    def _run(self) -> None:
        v1 = client.CoreV1Api()
        while not self._stop.is_set():
            resource_version = self._resync(v1)
            if resource_version is None:
                time.sleep(5)
                continue
            try:
                w = watch.Watch()
                for event in w.stream(v1.list_pod_for_all_namespaces,
                                      resource_version=resource_version,
                                      timeout_seconds=300):
                    if self._stop.is_set():
                        return
                    self._apply(event["type"], event["object"])
            except client.ApiException as exc:
                if exc.status == 410:  # resourceVersion too old - full resync
                    log.info("watch expired, resyncing")
                else:
                    log.warning("pod watch error: %s", exc)
                    time.sleep(5)
            except Exception as exc:  # noqa: BLE001
                log.warning("pod watch dropped: %s", exc)
                time.sleep(5)

    def _resync(self, v1) -> str | None:
        try:
            pods = v1.list_pod_for_all_namespaces()
        except Exception as exc:  # noqa: BLE001
            log.error("pod list failed: %s", exc)
            return None
        with self._lock:
            self._pods = {p.metadata.uid: pod_summary(p) for p in pods.items}
        broadcaster.publish({"type": "snapshot", "pods": self.snapshot()})
        return pods.metadata.resource_version

    def _apply(self, event_type: str, pod) -> None:
        summary = pod_summary(pod)
        with self._lock:
            if event_type == "DELETED":
                self._pods.pop(summary["uid"], None)
            else:
                self._pods[summary["uid"]] = summary
        broadcaster.publish({
            "type": "pod",
            "op": "delete" if event_type == "DELETED" else "upsert",
            "pod": summary,
        })


inventory = InventoryWatcher()
