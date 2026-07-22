"""Session token issuance/verification (no live cluster required - the
Secret-backed load()/_save() path is not exercised here)."""

import secrets

from tifera.auth import AuthStore


def _store_with_key() -> AuthStore:
    store = AuthStore()
    store._signing_key = secrets.token_bytes(32)
    return store


def test_anonymous_viewer_token_has_no_real_username():
    store = _store_with_key()
    token = store.make_token("", "viewer")
    user = store.verify_token(token)
    assert user == {"username": "viewer", "role": "viewer"}


def test_named_viewer_is_revoked_when_user_is_removed():
    """A named account with the viewer role must be checked against the
    user table like any other role - not treated as the anonymous session."""
    store = _store_with_key()
    store._users = {"bob": {"role": "viewer", "password": "irrelevant"}}
    token = store.make_token("bob", "viewer")
    assert store.verify_token(token) == {"username": "bob", "role": "viewer"}

    del store._users["bob"]
    assert store.verify_token(token) is None


def test_named_viewer_is_revoked_when_role_changes():
    store = _store_with_key()
    store._users = {"bob": {"role": "viewer", "password": "irrelevant"}}
    token = store.make_token("bob", "viewer")
    assert store.verify_token(token) is not None

    store._users["bob"]["role"] = "operator"
    assert store.verify_token(token) is None


def test_tampered_signature_is_rejected():
    store = _store_with_key()
    token = store.make_token("bob", "admin")
    payload, _, sig = token.partition(".")
    assert store.verify_token(f"{payload}.{sig[:-1]}x") is None


def test_expired_token_is_rejected(monkeypatch):
    import time
    store = _store_with_key()
    store._users = {"bob": {"role": "admin", "password": "irrelevant"}}
    token = store.make_token("bob", "admin")
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: real_time() + 10**9)
    assert store.verify_token(token) is None
