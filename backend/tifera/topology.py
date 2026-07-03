"""Topology graph - Services → Endpoints → Pods, workloads → owned
Pods, and (toggleable) ConfigMap/Secret mounts as edges. Computed on demand
from live API state; only object *names* are exposed, never secret
values.
"""

import logging

from kubernetes import client

log = logging.getLogger("tifera.topology")


def _pod_healthy(pod) -> bool:
    if pod.status.phase == "Succeeded":
        return True
    if pod.status.phase != "Running":
        return False
    statuses = pod.status.container_statuses or []
    return bool(statuses) and all(s.ready for s in statuses)


def build(namespace: str | None = None, include_mounts: bool = False) -> dict:
    v1 = client.CoreV1Api()
    if namespace:
        pods = v1.list_namespaced_pod(namespace).items
        services = v1.list_namespaced_service(namespace).items
        endpoints = v1.list_namespaced_endpoints(namespace).items
    else:
        pods = v1.list_pod_for_all_namespaces().items
        services = v1.list_service_for_all_namespaces().items
        endpoints = v1.list_endpoints_for_all_namespaces().items

    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def add(node_id: str, **attrs) -> None:
        nodes.setdefault(node_id, {"id": node_id, **attrs})

    for pod in pods:
        ns, name = pod.metadata.namespace, pod.metadata.name
        healthy = _pod_healthy(pod)
        pod_id = f"pod:{ns}/{name}"
        add(pod_id, kind="Pod", namespace=ns, name=name, healthy=healthy,
            phase=pod.status.phase or "Unknown",
            containers=[c.name for c in (pod.spec.containers or [])])

        owner = next((o for o in (pod.metadata.owner_references or []) if o.controller), None)
        if owner:
            kind, oname = owner.kind, owner.name
            if kind == "ReplicaSet" and "-" in oname:
                # Pod-template-hash heuristic: show the Deployment, not the RS.
                kind, oname = "Deployment", oname.rsplit("-", 1)[0]
            wid = f"workload:{ns}/{kind}/{oname}"
            add(wid, kind=kind, namespace=ns, name=oname, healthy=True)
            edges.append({"from": wid, "to": pod_id, "kind": "owns", "healthy": healthy})
            if not healthy:
                nodes[wid]["healthy"] = False

        if include_mounts:
            for vol in (pod.spec.volumes or []):
                ref = None
                if vol.config_map:
                    ref = ("ConfigMap", vol.config_map.name)
                elif vol.secret:
                    ref = ("Secret", vol.secret.secret_name)
                if ref and ref[1]:
                    cid = f"{ref[0].lower()}:{ns}/{ref[1]}"
                    add(cid, kind=ref[0], namespace=ns, name=ref[1], healthy=True)
                    edges.append({"from": pod_id, "to": cid, "kind": "mounts",
                                  "healthy": True})

    ep_index = {(e.metadata.namespace, e.metadata.name): e for e in endpoints}
    for svc in services:
        ns, name = svc.metadata.namespace, svc.metadata.name
        svc_id = f"svc:{ns}/{name}"
        add(svc_id, kind="Service", namespace=ns, name=name, healthy=True,
            clusterIp=svc.spec.cluster_ip or "")
        any_ready = False
        ep = ep_index.get((ns, name))
        for subset in (ep.subsets or []) if ep else []:
            for addr in (subset.addresses or []):
                if addr.target_ref and addr.target_ref.kind == "Pod":
                    edges.append({"from": svc_id, "to": f"pod:{ns}/{addr.target_ref.name}",
                                  "kind": "routes", "healthy": True})
                    any_ready = True
            for addr in (subset.not_ready_addresses or []):
                if addr.target_ref and addr.target_ref.kind == "Pod":
                    # Failing endpoint - highlight the path.
                    edges.append({"from": svc_id, "to": f"pod:{ns}/{addr.target_ref.name}",
                                  "kind": "routes", "healthy": False})
        if svc.spec.selector and not any_ready:
            nodes[svc_id]["healthy"] = False

    # Endpoints can briefly reference pods that no longer exist.
    edges = [e for e in edges if e["from"] in nodes and e["to"] in nodes]
    return {"nodes": list(nodes.values()), "edges": edges}
