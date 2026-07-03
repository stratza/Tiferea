"""Pure-parsing units: ls output (fsops) and K8s quantities (metrics)."""

from tifera.fsops import parse_ls_line
from tifera.metrics import parse_cpu, parse_mem


def test_ls_regular_file():
    e = parse_ls_line("-rw-r--r--    1 0        0             1024 Jan  1 12:00 config.yaml")
    assert e == {
        "name": "config.yaml", "type": "file", "perms": "rw-r--r--",
        "uid": "0", "gid": "0", "size": 1024,
        "mtimeText": "Jan 1 12:00", "linkTarget": None,
    }


def test_ls_directory_and_year_format():
    e = parse_ls_line("drwxr-xr-x    2 1000     1000          4096 Mar 15  2024 my dir with spaces")
    assert e["type"] == "dir"
    assert e["name"] == "my dir with spaces"
    assert e["mtimeText"] == "Mar 15 2024"


def test_ls_symlink():
    e = parse_ls_line("lrwxrwxrwx    1 0        0                7 Jul  1 09:30 bin -> usr/bin")
    assert e["type"] == "link"
    assert e["name"] == "bin"
    assert e["linkTarget"] == "usr/bin"


def test_ls_device_and_junk_lines():
    e = parse_ls_line("crw-rw-rw-    1 0        0           1,   3 Jul  1 09:30 null")
    assert e["type"] == "char"
    assert e["name"] == "null"
    assert e["size"] == 0
    assert parse_ls_line("total 44") is None
    assert parse_ls_line("") is None
    assert parse_ls_line("ls: /nope: No such file or directory") is None


def test_parse_cpu():
    assert parse_cpu("250m") == 250.0
    assert parse_cpu("1") == 1000.0
    assert parse_cpu("1500000n") == 1.5
    assert parse_cpu("2500u") == 2.5
    assert parse_cpu("") == 0.0
    assert parse_cpu("garbage") == 0.0


def test_parse_mem():
    assert parse_mem("128Mi") == 128 * 1024**2
    assert parse_mem("1Gi") == 1024**3
    assert parse_mem("500k") == 500_000
    assert parse_mem("1048576") == 1048576
    assert parse_mem("") == 0
    assert parse_mem("garbage") == 0
