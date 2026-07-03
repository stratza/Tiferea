"""Presence and editor registries (no cluster required - the
broadcaster has no bound loop in tests, so publishes are no-ops)."""

from tifera.presence import EditorRegistry, PresenceRegistry, target_key


def test_target_key():
    assert target_key("ns", "pod", "c") == "ns/pod/c"


def test_presence_isolation_and_warnings():
    reg = PresenceRegistry()
    reg.add("s1", "ns", "pod", "app", "client-alice", "alice")
    reg.add("s2", "ns", "pod", "app", "client-alice", "alice")   # same dev, 2 tabs
    reg.add("s3", "ns", "pod", "app", "client-bob", "bob")

    target = target_key("ns", "pod", "app")
    assert len(reg.sessions_for(target)) == 3  # badge counts all

    # Same-client sessions are counted but not warned about.
    others = reg.others_on(target, "client-alice")
    assert [e["clientName"] for e in others] == ["bob"]

    reg.remove("s3")
    assert reg.others_on(target, "client-alice") == []

    snap = reg.snapshot()
    assert set(snap.keys()) == {target}
    assert len(snap[target]) == 2


def test_presence_remove_unknown_is_noop():
    reg = PresenceRegistry()
    reg.remove("never-existed")  # must not raise


def test_editor_registry_mutual_warning_and_cleanup():
    reg = EditorRegistry()
    assert reg.open("ns/pod/app", "/etc/conf", "c1", "alice") == []
    others = reg.open("ns/pod/app", "/etc/conf", "c2", "bob")
    assert [e["clientName"] for e in others] == ["alice"]

    # Different file on the same container: no warning.
    assert reg.open("ns/pod/app", "/etc/other", "c2", "bob") == []

    # Client disconnect clears all of its entries.
    reg.drop_client("c1")
    assert reg.editors("ns/pod/app", "/etc/conf") == [
        e for e in reg.editors("ns/pod/app", "/etc/conf") if e["clientId"] == "c2"]
    assert reg.others("ns/pod/app", "/etc/conf", "c2") == []

    reg.close("ns/pod/app", "/etc/conf", "c2")
    assert reg.editors("ns/pod/app", "/etc/conf") == []
