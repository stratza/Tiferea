"""Ephemeral debug container attach for shell-less targets.

Patches the pod with an ephemeral container (`kubectl debug` equivalent),
waits for it to start, and returns its name; the console then opens a normal
terminal session against that container.
"""

import logging
import time
import uuid

from kubernetes import client

from . import config as cfg

log = logging.getLogger("tifera.debug")

# Waiting reasons that will never resolve by waiting longer.
_FATAL_WAITING = ("ErrImagePull", "ImagePullBackOff", "InvalidImageName",
                  "CreateContainerConfigError", "CreateContainerError",
                  "RunContainerError")


def create_debug_container(namespace: str, pod: str, target_container: str,
                           image: str | None = None, timeout: float = 30) -> str:
    v1 = client.CoreV1Api()
    name = f"tifera-debug-{uuid.uuid4().hex[:6]}"
    spec: dict = {
        "name": name,
        "image": image or cfg.DEBUG_IMAGE,
        "command": ["sh"],
        "stdin": True,
        "tty": True,
        "targetContainerName": target_container,
        "terminationMessagePolicy": "File",
    }

    # Pods that enforce runAsNonRoot reject a root debug container with
    # CreateContainerConfigError (cert-manager, most security-hardened
    # charts). Match the pod's policy with a restricted-style context; the
    # shell then runs unprivileged, which beats not running at all.
    try:
        pod_obj = v1.read_namespaced_pod(pod, namespace)
        pod_sc = pod_obj.spec.security_context
        if pod_sc and pod_sc.run_as_non_root:
            spec["securityContext"] = {
                "runAsNonRoot": True,
                "runAsUser": 65532,
                "runAsGroup": 65532,
                "allowPrivilegeEscalation": False,
                "capabilities": {"drop": ["ALL"]},
                "seccompProfile": {"type": "RuntimeDefault"},
            }
    except client.ApiException:
        pass  # patch below will surface any real problem

    body = {"spec": {"ephemeralContainers": [spec]}}
    v1.patch_namespaced_pod_ephemeralcontainers(pod, namespace, body)
    log.info("ephemeral debug container %s added to %s/%s (target %s%s)",
             name, namespace, pod, target_container,
             ", non-root" if "securityContext" in spec else "")

    deadline = time.monotonic() + timeout
    last_waiting = ""
    while time.monotonic() < deadline:
        p = v1.read_namespaced_pod(pod, namespace)
        for status in (p.status.ephemeral_container_statuses or []):
            if status.name != name or not status.state:
                continue
            if status.state.running:
                return name
            if status.state.terminated:
                raise RuntimeError(
                    f"debug container exited immediately "
                    f"({status.state.terminated.reason or 'unknown'})")
            if status.state.waiting:
                waiting = status.state.waiting
                last_waiting = f"{waiting.reason or 'waiting'}: {waiting.message or ''}".strip(": ")
                if waiting.reason in _FATAL_WAITING:
                    raise RuntimeError(f"debug container cannot start - {last_waiting}")
        time.sleep(0.5)
    raise TimeoutError(
        f"debug container did not start within {timeout:.0f}s "
        f"({last_waiting or 'no status reported'})")
