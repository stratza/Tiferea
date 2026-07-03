"""Running TifEra outside a Kubernetes
cluster must exit non-zero within 5 s with an actionable message. This is the
CI-enforced version of the in-cluster invariant."""

import os
import subprocess
import sys
import time

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_refuses_to_start_outside_cluster():
    env = {k: v for k, v in os.environ.items() if not k.startswith("KUBERNETES")}
    env["PYTHONPATH"] = BACKEND_DIR

    started = time.monotonic()
    proc = subprocess.run([sys.executable, "-m", "tifera"],
                          capture_output=True, env=env, timeout=30)
    elapsed = time.monotonic() - started

    assert proc.returncode != 0
    assert elapsed < 5, f"refusal took {elapsed:.1f}s (must be < 5s)"
    stderr = proc.stderr.decode()
    assert "must run inside a Kubernetes cluster" in stderr
    assert "no way to bypass" in stderr
