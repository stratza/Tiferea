"""Lightweight, cached name index of non-pod resources for the command
palette (feature 5): Services, Deployments, StatefulSets, DaemonSets,
ConfigMaps and Secrets. Names only - never values (secret data is masked in
the describe endpoint). Cached briefly so repeated palette opens are cheap.
"""

from __future__ import annotations

import logging
import threading
import time

from kubernetes import client

log = logging.getLogger("tifera.resources")

_TTL = 15  # seconds


class ResourceIndex:
    def __init__(self) -> None:
        self._cache: list[dict] = []
        self._at = 0.0
        self._lock = threading.Lock()

    def list(self) -> list[dict]:
        with self._lock:
            if time.monotonic() - self._at < _TTL and self._cache:
                return self._cache
        items = self._collect()
        with self._lock:
            self._cache = items
            self._at = time.monotonic()
        return items

    def _collect(self) -> list[dict]:
        core = client.CoreV1Api()
        apps = client.AppsV1Api()
        out: list[dict] = []

        def grab(kind, fn):
            try:
                for it in fn(limit=2000).items:
                    out.append({"kind": kind,
                                "namespace": it.metadata.namespace or "",
                                "name": it.metadata.name})
            except client.ApiException as exc:
                if exc.status not in (403, 404):
                    log.warning("listing %s failed: %s", kind, exc.reason)
            except Exception as exc:  # noqa: BLE001
                log.warning("listing %s failed: %s", kind, exc)

        grab("Service", core.list_service_for_all_namespaces)
        grab("ConfigMap", core.list_config_map_for_all_namespaces)
        grab("Secret", core.list_secret_for_all_namespaces)
        grab("Deployment", apps.list_deployment_for_all_namespaces)
        grab("StatefulSet", apps.list_stateful_set_for_all_namespaces)
        grab("DaemonSet", apps.list_daemon_set_for_all_namespaces)
        return out


resource_index = ResourceIndex()


# kind -> (api factory, read-method name) for the describe endpoint.
_READERS = {
    "Service": (client.CoreV1Api, "read_namespaced_service"),
    "ConfigMap": (client.CoreV1Api, "read_namespaced_config_map"),
    "Secret": (client.CoreV1Api, "read_namespaced_secret"),
    "Endpoints": (client.CoreV1Api, "read_namespaced_endpoints"),
    "Deployment": (client.AppsV1Api, "read_namespaced_deployment"),
    "StatefulSet": (client.AppsV1Api, "read_namespaced_stateful_set"),
    "DaemonSet": (client.AppsV1Api, "read_namespaced_daemon_set"),
    "ReplicaSet": (client.AppsV1Api, "read_namespaced_replica_set"),
}


def read_object(kind: str, namespace: str, name: str):
    """Fetch a resource object for the describe endpoint; None if the kind is
    unsupported here."""
    entry = _READERS.get(kind)
    if entry is None:
        return None
    api_cls, method = entry
    return getattr(api_cls(), method)(name, namespace)


def mask_secret(data: dict) -> dict:
    """Replace Secret values with placeholders (never expose secret data)."""
    if data.get("kind") == "Secret":
        for field in ("data", "stringData"):
            if isinstance(data.get(field), dict):
                data[field] = {k: "***" for k in data[field]}
    return data
