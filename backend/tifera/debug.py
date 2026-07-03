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


def create_debug_container(namespace: str, pod: str, target_container: str,
                           image: str | None = None, timeout: float = 30) -> str:
    v1 = client.CoreV1Api()
    name = f"tifera-debug-{uuid.uuid4().hex[:6]}"
    body = {"spec": {"ephemeralContainers": [{
        "name": name,
        "image": image or cfg.DEBUG_IMAGE,
        "command": ["sh"],
        "stdin": True,
        "tty": True,
        "targetContainerName": target_container,
        "terminationMessagePolicy": "File",
    }]}}
    v1.patch_namespaced_pod_ephemeralcontainers(pod, namespace, body)
    log.info("ephemeral debug container %s added to %s/%s (target %s)",
             name, namespace, pod, target_container)

    deadline = time.monotonic() + timeout
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
            if (status.state.waiting
                    and status.state.waiting.reason in ("ErrImagePull", "ImagePullBackOff")):
                raise RuntimeError(
                    f"cannot pull debug image {image or cfg.DEBUG_IMAGE} "
                    f"({status.state.waiting.reason})")
        time.sleep(0.5)
    raise TimeoutError(f"debug container did not start within {timeout:.0f}s")
