"""Authentication & authorization.

TifEra now gates access behind login (a deliberate reversal of the original
no-auth model). State - the session-signing key and the user table - lives in
a Kubernetes Secret that TifEra manages in its own namespace, so nothing
sensitive is written to disk.

Roles (increasing power): viewer < operator < admin.
  viewer   - read-only, non-sensitive (inventory, metrics, topology, events,
             non-Secret describe). No shells/files/logs/kubectl/secrets/writes.
  operator - full operator access.
  admin    - operator + user management.

Passwords are hashed with scrypt (stdlib). Sessions are stateless HMAC-signed
tokens carried in an HttpOnly, SameSite=Strict cookie.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time

from kubernetes import client

from . import config as cfg

log = logging.getLogger("tifera.auth")

ROLE_LEVEL = {"viewer": 1, "operator": 2, "admin": 3}
ROLES = set(ROLE_LEVEL)

_SCRYPT = dict(n=2**14, r=8, p=1, dklen=32, maxmem=64 * 1024 * 1024)


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt_hex, hash_hex = stored.split("$")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), **_SCRYPT)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:  # noqa: BLE001
        return False


class AuthStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._signing_key: bytes | None = None
        self._users: dict[str, dict] = {}   # username -> {role, password}
        self._loaded = False

    # -- k8s Secret persistence ------------------------------------------

    def _api(self):
        return client.CoreV1Api()

    def load(self) -> None:
        """Read state from the Secret; absent Secret => setup mode."""
        with self._lock:
            self._loaded = True
            try:
                sec = self._api().read_namespaced_secret(cfg.AUTH_SECRET_NAME, cfg.NAMESPACE)
            except client.ApiException as exc:
                if exc.status == 404:
                    self._signing_key = None
                    self._users = {}
                    log.info("no auth Secret yet - first-run setup required")
                    return
                log.error("cannot read auth Secret: %s", exc.reason)
                raise
            blob = json.loads(base64.b64decode(sec.data["state"]).decode())
            self._signing_key = _b64d(blob["signing_key"])
            self._users = blob.get("users", {})
            log.info("auth loaded: %d user(s)", len(self._users))

    def _save(self) -> None:
        blob = {"signing_key": _b64e(self._signing_key), "users": self._users}
        body = client.V1Secret(
            metadata=client.V1ObjectMeta(name=cfg.AUTH_SECRET_NAME,
                                         namespace=cfg.NAMESPACE),
            string_data={"state": json.dumps(blob)},
            type="Opaque")
        try:
            self._api().replace_namespaced_secret(cfg.AUTH_SECRET_NAME, cfg.NAMESPACE, body)
        except client.ApiException as exc:
            if exc.status == 404:
                self._api().create_namespaced_secret(cfg.NAMESPACE, body)
            else:
                raise

    # -- state -----------------------------------------------------------

    def is_setup(self) -> bool:
        with self._lock:
            return bool(self._signing_key and self._users)

    def setup(self, username: str, password: str) -> None:
        """First-run: create the initial admin. Idempotency guard: refuses if
        already set up."""
        with self._lock:
            if self._signing_key and self._users:
                raise ValueError("already set up")
            _validate_username(username)
            _validate_password(password)
            self._signing_key = secrets.token_bytes(32)
            self._users = {username: {"role": "admin", "password": hash_password(password)}}
            self._save()
            log.info("initial admin '%s' created", username)

    def verify(self, username: str, password: str) -> dict | None:
        with self._lock:
            u = self._users.get(username)
        if u and verify_password(password, u["password"]):
            return {"username": username, "role": u["role"]}
        return None

    def list_users(self) -> list[dict]:
        with self._lock:
            return [{"username": n, "role": u["role"]} for n, u in sorted(self._users.items())]

    def add_user(self, username: str, password: str, role: str) -> None:
        _validate_username(username)
        _validate_password(password)
        if role not in ROLES:
            raise ValueError(f"invalid role: {role}")
        with self._lock:
            if username in self._users:
                raise ValueError("user already exists")
            self._users[username] = {"role": role, "password": hash_password(password)}
            self._save()

    def set_role(self, username: str, role: str) -> None:
        if role not in ROLES:
            raise ValueError(f"invalid role: {role}")
        with self._lock:
            if username not in self._users:
                raise ValueError("no such user")
            if self._users[username]["role"] == "admin" and role != "admin" \
                    and sum(1 for u in self._users.values() if u["role"] == "admin") <= 1:
                raise ValueError("cannot demote the last admin")
            self._users[username]["role"] = role
            self._save()

    def set_password(self, username: str, password: str) -> None:
        _validate_password(password)
        with self._lock:
            if username not in self._users:
                raise ValueError("no such user")
            self._users[username]["password"] = hash_password(password)
            self._save()

    def remove_user(self, username: str) -> None:
        with self._lock:
            if username not in self._users:
                raise ValueError("no such user")
            if self._users[username]["role"] == "admin" \
                    and sum(1 for u in self._users.values() if u["role"] == "admin") <= 1:
                raise ValueError("cannot remove the last admin")
            del self._users[username]
            self._save()

    # -- session tokens (stateless, HMAC-signed) -------------------------

    def make_token(self, username: str, role: str) -> str:
        payload = _b64e(json.dumps({
            "u": username, "r": role, "exp": int(time.time()) + cfg.SESSION_TTL_SECONDS,
        }).encode())
        sig = _b64e(hmac.new(self._signing_key, payload.encode(), hashlib.sha256).digest())
        return f"{payload}.{sig}"

    def verify_token(self, token: str | None) -> dict | None:
        if not token or "." not in token or not self._signing_key:
            return None
        payload, _, sig = token.partition(".")
        expected = _b64e(hmac.new(self._signing_key, payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig, expected):
            return None
        try:
            data = json.loads(_b64d(payload).decode())
        except Exception:  # noqa: BLE001
            return None
        if data.get("exp", 0) < time.time():
            return None
        role = data.get("r")
        if role not in ROLES:
            return None
        # Anonymous viewer tokens have no user record; named tokens must still
        # match an existing user (so removed users lose access immediately).
        if role != "viewer":
            with self._lock:
                rec = self._users.get(data.get("u"))
            if rec is None or rec["role"] != role:
                return None
        return {"username": data.get("u"), "role": role}


def _validate_username(name: str) -> None:
    if not name or not name.strip() or len(name) > 64 or "/" in name:
        raise ValueError("invalid username")


def _validate_password(pw: str) -> None:
    if not pw or len(pw) < 8:
        raise ValueError("password must be at least 8 characters")


store = AuthStore()
