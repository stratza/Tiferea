"""Topology - readable at scale by aggregating instead of drawing everything.

Two shapes, both computed on demand from live API state:
  summary() - cluster-wide per-namespace counts for the overview cards
              (a 900-service cluster is never rendered as one graph).
  graph(ns) - a per-namespace, workload-aggregated graph: pods are rolled up
              into their owning workload (ready/total), and per-pod Service
              endpoints collapse into one Service -> Workload edge carrying
              endpoint counts. Pod details ride along as workload children
              for the focus view.

Only object *names* are exposed, never secret values.
"""

import logging
import time

from kubernetes import client

log = logging.getLogger("tifera.topology")


def _pod_healthy(pod) -> bool:
    if pod.status.phase == "Succeeded":
        return True
    if pod.status.phase != "Running":
        return False
    statuses = pod.status.container_statuses or []
    return bool(statuses) and all(s.ready for s in statuses)


def _owner(pod) -> tuple[str, str] | None:
    """Controlling workload as (kind, name), or None for a bare pod."""
    ref = next((o for o in (pod.metadata.owner_references or []) if o.controller), None)
    if not ref:
        return None
    kind, name = ref.kind, ref.name
    if kind == "ReplicaSet" and "-" in name:
        # Pod-template-hash heuristic: show the Deployment, not the RS.
        kind, name = "Deployment", name.rsplit("-", 1)[0]
    return kind, name


def _ready_endpoint_names(endpoints) -> set[tuple[str, str]]:
    """(namespace, name) of Endpoints objects with at least one ready address."""
    ready = set()
    for ep in endpoints:
        for subset in (ep.subsets or []):
            if subset.addresses:
                ready.add((ep.metadata.namespace, ep.metadata.name))
                break
    return ready


def summary() -> dict:
    """Cluster-wide per-namespace counts for the topology overview cards."""
    started = time.monotonic()
    v1 = client.CoreV1Api()
    pods = v1.list_pod_for_all_namespaces().items
    services = v1.list_service_for_all_namespaces().items
    endpoints = v1.list_endpoints_for_all_namespaces().items
    log.info("topology summary: %d pods, %d services, %d endpoints in %.1fs",
             len(pods), len(services), len(endpoints), time.monotonic() - started)

    stats: dict[str, dict] = {}

    def ns_stat(ns: str) -> dict:
        return stats.setdefault(ns, {
            "name": ns, "services": 0, "workloads": 0, "pods": 0,
            "unhealthyPods": 0, "unhealthyServices": 0})

    workloads_seen: set[tuple] = set()
    for pod in pods:
        st = ns_stat(pod.metadata.namespace)
        st["pods"] += 1
        if not _pod_healthy(pod):
            st["unhealthyPods"] += 1
        owner = _owner(pod) or ("Pod", pod.metadata.name)
        key = (pod.metadata.namespace, *owner)
        if key not in workloads_seen:
            workloads_seen.add(key)
            st["workloads"] += 1

    ready = _ready_endpoint_names(endpoints)
    for svc in services:
        ns, name = svc.metadata.namespace, svc.metadata.name
        st = ns_stat(ns)
        st["services"] += 1
        if svc.spec.selector and (ns, name) not in ready:
            st["unhealthyServices"] += 1

    return {"namespaces": sorted(stats.values(), key=lambda s: s["name"])}


def graph(namespace: str, include_mounts: bool = False) -> dict:
    """Workload-aggregated graph for one namespace."""
    v1 = client.CoreV1Api()
    pods = v1.list_namespaced_pod(namespace).items
    services = v1.list_namespaced_service(namespace).items
    endpoints = v1.list_namespaced_endpoints(namespace).items

    nodes: dict[str, dict] = {}
    pod_workload: dict[str, str] = {}      # pod name -> workload node id
    mount_edges: set[tuple[str, str]] = set()

    for pod in pods:
        name = pod.metadata.name
        healthy = _pod_healthy(pod)
        kind, wname = _owner(pod) or ("Pod", name)
        wid = f"workload:{namespace}/{kind}/{wname}"
        node = nodes.setdefault(wid, {
            "id": wid, "kind": kind, "namespace": namespace, "name": wname,
            "ready": 0, "total": 0, "healthy": True, "pods": []})
        node["total"] += 1
        if healthy:
            node["ready"] += 1
        else:
            node["healthy"] = False
        node["pods"].append({"name": name, "healthy": healthy,
                             "phase": pod.status.phase or "Unknown"})
        pod_workload[name] = wid

        if include_mounts:
            for vol in (pod.spec.volumes or []):
                ref = None
                if vol.config_map:
                    ref = ("ConfigMap", vol.config_map.name)
                elif vol.secret:
                    ref = ("Secret", vol.secret.secret_name)
                if ref and ref[1]:
                    cid = f"{ref[0].lower()}:{namespace}/{ref[1]}"
                    nodes.setdefault(cid, {"id": cid, "kind": ref[0],
                                           "namespace": namespace, "name": ref[1],
                                           "healthy": True})
                    mount_edges.add((wid, cid))

    # Per-pod endpoint addresses collapse into Service -> Workload edges.
    ep_index = {e.metadata.name: e for e in endpoints}
    routes: dict[tuple[str, str], dict] = {}   # (svc_id, wid) -> counts
    for svc in services:
        name = svc.metadata.name
        svc_id = f"svc:{namespace}/{name}"
        nodes[svc_id] = {"id": svc_id, "kind": "Service", "namespace": namespace,
                         "name": name, "healthy": True,
                         "clusterIp": svc.spec.cluster_ip or ""}
        any_ready = False
        ep = ep_index.get(name)
        for subset in (ep.subsets or []) if ep else []:
            addrs = ([(a, True) for a in (subset.addresses or [])]
                     + [(a, False) for a in (subset.not_ready_addresses or [])])
            for addr, is_ready in addrs:
                tref = addr.target_ref
                if not tref or tref.kind != "Pod":
                    continue
                wid = pod_workload.get(tref.name)
                if not wid:   # endpoints can briefly reference deleted pods
                    continue
                agg = routes.setdefault((svc_id, wid), {"ready": 0, "total": 0})
                agg["total"] += 1
                if is_ready:
                    agg["ready"] += 1
                    any_ready = True
        if svc.spec.selector and not any_ready:
            nodes[svc_id]["healthy"] = False

    edges = [{"from": svc_id, "to": wid, "kind": "routes",
              "ready": agg["ready"], "total": agg["total"],
              "healthy": agg["ready"] > 0 and agg["ready"] == agg["total"]}
             for (svc_id, wid), agg in sorted(routes.items())]
    edges += [{"from": wid, "to": cid, "kind": "mounts", "healthy": True}
              for wid, cid in sorted(mount_edges)]

    for n in nodes.values():
        if "pods" in n:
            n["pods"].sort(key=lambda p: p["name"])

    # Stable ordering -> stable layout across refreshes.
    return {"namespace": namespace,
            "nodes": sorted(nodes.values(), key=lambda n: (n["kind"], n["name"])),
            "edges": edges}
