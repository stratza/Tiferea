"""Runtime configuration.

Everything comes from the pod environment (Downward API env vars in the
manifest) or defaults. There is deliberately no kubeconfig, no API-server URL
override and no auth-related configuration.
"""

import os

SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
SA_TOKEN_PATH = os.path.join(SA_DIR, "token")
SA_CA_PATH = os.path.join(SA_DIR, "ca.crt")

# Downward API identity
NAMESPACE = os.environ.get("TIFERA_NAMESPACE", "")
POD_NAME = os.environ.get("TIFERA_POD_NAME", "")
NODE_NAME = os.environ.get("TIFERA_NODE_NAME", "")

# Named LISTEN_PORT (not TIFERA_PORT) on purpose: a Service called "tifera"
# makes kubelet inject TIFERA_PORT=tcp://<ip>:<port> as a legacy service link.
LISTEN_PORT = int(os.environ.get("TIFERA_LISTEN_PORT", "8080"))
DATA_DIR = os.environ.get("TIFERA_DATA_DIR", "/data")

# Terminal behaviour
IDLE_TIMEOUT_SECONDS = int(os.environ.get("TIFERA_IDLE_TIMEOUT", str(30 * 60)))
# Grace ≤ 10 s so presence clears promptly after a drop.
RECONNECT_GRACE_SECONDS = int(os.environ.get("TIFERA_RECONNECT_GRACE", "10"))
SCROLLBACK_CHUNKS = int(os.environ.get("TIFERA_REPLAY_CHUNKS", "2000"))
SHELL_CANDIDATES = ("bash", "sh", "ash")

# Metrics polling
METRICS_INTERVAL_SECONDS = int(os.environ.get("TIFERA_METRICS_INTERVAL", "15"))

# File transfer / editor
MAX_UPLOAD_BYTES = int(os.environ.get("TIFERA_MAX_UPLOAD", str(2 * 1024**3)))
UPLOAD_CHUNK_LIMIT = 64 * 1024 * 1024  # per-request cap; clients send chunks
EDIT_MAX_BYTES = int(os.environ.get("TIFERA_EDIT_MAX", str(1024 * 1024)))

# Ephemeral debug containers for shell-less targets
DEBUG_IMAGE = os.environ.get("TIFERA_DEBUG_IMAGE", "busybox:1.36")

# Optional terminal session recording (.cast files)
RECORD_SESSIONS = os.environ.get("TIFERA_RECORD_SESSIONS", "") in ("1", "true", "yes")
CAST_RETENTION_DAYS = int(os.environ.get("TIFERA_CAST_RETENTION_DAYS", "14"))

# Static frontend bundle (baked into the image)
STATIC_DIR = os.environ.get(
    "TIFERA_STATIC_DIR",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static"),
)
