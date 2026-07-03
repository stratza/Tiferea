"""In-cluster runtime enforcement.

TifEra runs only as a pod inside a Kubernetes cluster. verify_or_die() is
called before the server binds a port; there is no flag or env var to bypass
it. The K8s client is configured exclusively from in-cluster config.
"""

import logging
import os
import sys

from kubernetes import client, config

from . import config as cfg

log = logging.getLogger("tifera.incluster")

_DIAGNOSTIC = """\
================================================================================
TifEra must run inside a Kubernetes cluster.

The in-cluster environment was not found:
  %s

TifEra is in-cluster-only by design: it authenticates to the Kubernetes API
with the ServiceAccount token the kubelet mounts into its pod, and it has no
kubeconfig or standalone mode. Deploy it with:

    kubectl apply -f deploy/tifera.yaml

There is no way to bypass this check.
================================================================================\
"""


def _environment_problems() -> list[str]:
    problems = []
    if not os.environ.get("KUBERNETES_SERVICE_HOST"):
        problems.append("KUBERNETES_SERVICE_HOST is not set (not started by a kubelet)")
    if not os.path.isfile(cfg.SA_TOKEN_PATH):
        problems.append(f"ServiceAccount token missing at {cfg.SA_TOKEN_PATH} "
                        "(is automountServiceAccountToken enabled?)")
    if not os.path.isfile(cfg.SA_CA_PATH):
        problems.append(f"cluster CA bundle missing at {cfg.SA_CA_PATH}")
    return problems


def verify_or_die() -> None:
    """Fail fast, loudly and non-zero when not inside a cluster."""
    problems = _environment_problems()
    if not problems:
        try:
            config.load_incluster_config()
        except config.ConfigException as exc:
            problems.append(f"in-cluster config rejected: {exc}")
    if not problems:
        try:
            # Authenticated round-trip to the API server (SelfSubjectReview,
            # K8s >= 1.28 GA; falls back to a /version ping on older clusters).
            auth = client.AuthenticationV1Api()
            auth.create_self_subject_review(client.V1SelfSubjectReview())
        except client.ApiException as exc:
            if exc.status == 404:
                try:
                    client.VersionApi().get_code()
                except Exception as exc2:  # noqa: BLE001
                    problems.append(f"API server unreachable: {exc2}")
            else:
                problems.append(f"authenticated API call failed: {exc.reason} (HTTP {exc.status})")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"API server unreachable: {exc}")

    if problems:
        print(_DIAGNOSTIC % "\n  ".join(problems), file=sys.stderr)
        sys.exit(1)

    log.info("in-cluster environment verified (namespace=%s pod=%s node=%s)",
             cfg.NAMESPACE or "?", cfg.POD_NAME or "?", cfg.NODE_NAME or "?")


# (verb, group, resource, subresource) pairs TifEra needs - keep in sync
# with the ClusterRole in deploy/tifera.yaml and the Helm chart.
REQUIRED_ACCESS: list[tuple[str, str, str, str]] = [
    *[(v, "", r, "") for v in ("get", "list", "watch")
      for r in ("pods", "services", "endpoints", "events", "nodes", "namespaces")],
    # WebSocket clients connect exec/portforward with GET, SPDY with POST -
    # checking only "create" once hid a 403 on every exec-based feature.
    ("get", "", "pods", "exec"),
    ("create", "", "pods", "exec"),
    ("get", "", "pods", "portforward"),
    ("patch", "", "pods", "ephemeralcontainers"),
    ("get", "", "pods", "log"),
    ("delete", "", "pods", ""),
    ("get", "metrics.k8s.io", "pods", ""),
    ("list", "metrics.k8s.io", "pods", ""),
]


def rbac_self_check() -> list[str]:
    """SelfSubjectAccessReview for every verb we need.

    Returns human-readable descriptions of missing permissions (empty = all
    good). Never raises: RBAC problems are surfaced as warnings, not crashes.
    """
    authz = client.AuthorizationV1Api()
    missing = []
    for verb, group, resource, subresource in REQUIRED_ACCESS:
        attrs = client.V1ResourceAttributes(
            verb=verb, group=group, resource=resource, subresource=subresource or None)
        body = client.V1SelfSubjectAccessReview(
            spec=client.V1SelfSubjectAccessReviewSpec(resource_attributes=attrs))
        try:
            result = authz.create_self_subject_access_review(body)
            if not result.status.allowed:
                name = f"{resource}/{subresource}" if subresource else resource
                if group:
                    name = f"{name}.{group}"
                missing.append(f"{verb} {name}")
        except Exception as exc:  # noqa: BLE001
            log.warning("SelfSubjectAccessReview failed for %s: %s", (verb, resource), exc)
            missing.append(f"{verb} {resource} (review call failed)")
    if missing:
        log.warning("RBAC self-check: missing permissions: %s", ", ".join(missing))
    return missing
