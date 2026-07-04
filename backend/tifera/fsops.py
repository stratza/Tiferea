"""Exec-based file operations - no agent in the target.

Every operation is a short non-TTY exec in the target container over a
binary WebSocket stream. Transfers are `cat`/`tar` pipes; nothing
is staged on TifEra's own filesystem.

The exec protocol cannot half-close stdin, so commands that read from stdin
use `head -c <n>` with an exact byte count instead of waiting for EOF.
"""

import json
import logging
import shlex
import time
from collections.abc import Iterator

from kubernetes import client
from kubernetes.stream import stream
from kubernetes.stream.ws_client import ERROR_CHANNEL

log = logging.getLogger("tifera.fsops")

_WRITE_CHUNK = 256 * 1024

_NO_SHELL_HINT = (
    "this container has no shell or core utilities - it looks distroless or "
    "scratch. File browsing and transfer run commands (sh, ls, cat, tar) "
    "inside the target, so they aren't available here. Open a terminal and "
    "use the ephemeral debug container to inspect its filesystem instead.")


class ExecError(RuntimeError):
    pass


class NoShellError(ExecError):
    """The target container ships no shell / coreutils (distroless/scratch)."""


def _looks_shellless(text: str) -> bool:
    low = text.lower()
    return ("executable file not found" in low
            or "exec format error" in low
            or ('"sh"' in text and "not found" in low)
            or ("no such file or directory" in low and "oci runtime exec" in low))


def _connect(namespace: str, pod: str, container: str, argv: list[str], *,
             stdin: bool = False):
    v1 = client.CoreV1Api()
    return stream(v1.connect_get_namespaced_pod_exec, pod, namespace,
                  container=container, command=argv,
                  stdin=stdin, stdout=True, stderr=True, tty=False,
                  binary=True, _preload_content=False)


def _exit_info(ws) -> tuple[int, str]:
    try:
        raw = ws.read_channel(ERROR_CHANNEL)
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        status = json.loads(raw or "{}")
    except Exception:  # noqa: BLE001
        return 0, ""
    if status.get("status") == "Success" or not status:
        return 0, ""
    code = 1
    for cause in (status.get("details") or {}).get("causes") or []:
        if cause.get("reason") == "ExitCode":
            try:
                code = int(cause.get("message") or 1)
            except ValueError:
                pass
    return code, status.get("message") or ""


def run(namespace: str, pod: str, container: str, argv: list[str], *,
        stdin_bytes: bytes | None = None, timeout: float = 60,
        ) -> tuple[int, bytes, bytes]:
    """Run argv to completion; returns (exit_code, stdout, stderr)."""
    ws = _connect(namespace, pod, container, argv, stdin=stdin_bytes is not None)
    out, err = bytearray(), bytearray()
    try:
        if stdin_bytes:
            for i in range(0, len(stdin_bytes), _WRITE_CHUNK):
                ws.write_stdin(stdin_bytes[i:i + _WRITE_CHUNK])
        deadline = time.monotonic() + timeout
        while ws.is_open():
            if time.monotonic() > deadline:
                raise ExecError(f"exec timed out after {timeout:.0f}s: {argv[0]}")
            ws.update(timeout=1)
            if ws.peek_stdout():
                out += ws.read_stdout()
            if ws.peek_stderr():
                err += ws.read_stderr()
        if ws.peek_stdout():
            out += ws.read_stdout()
        if ws.peek_stderr():
            err += ws.read_stderr()
        code, msg = _exit_info(ws)
    finally:
        ws.close()
    if code != 0 and not err and msg:
        err = bytearray(msg.encode())
    return code, bytes(out), bytes(err)


def _check(namespace: str, pod: str, container: str, argv: list[str],
           *, stdin_bytes: bytes | None = None, timeout: float = 60) -> bytes:
    code, out, err = run(namespace, pod, container, argv,
                         stdin_bytes=stdin_bytes, timeout=timeout)
    if code != 0:
        text = err.decode("utf-8", "replace").strip()
        if _looks_shellless(text):
            raise NoShellError(_NO_SHELL_HINT)
        raise ExecError(text or f"{argv[0]} failed (exit {code})")
    return out


# -- directory listing ------------------------------------------

_TYPES = {"d": "dir", "l": "link", "-": "file", "b": "block", "c": "char",
          "p": "fifo", "s": "socket"}


def parse_ls_line(line: str) -> dict | None:
    """Parse one `ls -lnA` line (GNU coreutils and busybox layouts)."""
    if not line or line.startswith("total"):
        return None
    f = line.split()
    if len(f) < 9 or len(f[0]) < 10:
        return None
    perms = f[0]
    if perms[0] in "bc" and f[4].endswith(","):  # device: "maj, min" not size
        size, rest = 0, f[9:]
    else:
        try:
            size = int(f[4])
        except ValueError:
            return None
        rest = f[8:]
    name = " ".join(rest)
    target = None
    if perms[0] == "l" and " -> " in name:
        name, target = name.split(" -> ", 1)
    return {
        "name": name,
        "type": _TYPES.get(perms[0], "file"),
        "perms": perms[1:10],
        "uid": f[2],
        "gid": f[3],
        "size": size,
        "mtimeText": " ".join(f[5:8]) if perms[0] not in "bc" else " ".join(f[6:9]),
        "linkTarget": target,
    }


def list_dir(namespace: str, pod: str, container: str, path: str) -> list[dict]:
    out = _check(namespace, pod, container, ["ls", "-lnA", path], timeout=30)
    entries = []
    for line in out.decode("utf-8", "replace").splitlines():
        e = parse_ls_line(line)
        if e:
            entries.append(e)
    return entries


def stat_mtime(namespace: str, pod: str, container: str, path: str) -> int | None:
    """Unix mtime via `stat -c %Y`; None when stat is unavailable/fails."""
    code, out, _ = run(namespace, pod, container,
                       ["stat", "-c", "%Y", path], timeout=15)
    if code != 0:
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None


def exists(namespace: str, pod: str, container: str, path: str) -> bool:
    code, _, err = run(namespace, pod, container,
                       ["sh", "-c", f"test -e {shlex.quote(path)}"], timeout=15)
    if code != 0 and _looks_shellless(err.decode("utf-8", "replace")):
        raise NoShellError(_NO_SHELL_HINT)
    return code == 0


# -- small-file editor -----------------------------------------------

def read_file(namespace: str, pod: str, container: str, path: str,
              max_bytes: int) -> bytes:
    out = _check(namespace, pod, container,
                 ["head", "-c", str(max_bytes + 1), path], timeout=30)
    if len(out) > max_bytes:
        raise ExecError(f"file larger than the {max_bytes} byte editor limit")
    return out


def write_file(namespace: str, pod: str, container: str, path: str,
               data: bytes, *, append: bool = False) -> None:
    redirect = ">>" if append else ">"
    _check(namespace, pod, container,
           ["sh", "-c", f"head -c {len(data)} {redirect} {shlex.quote(path)}"],
           stdin_bytes=data, timeout=300)


# -- download: streamed, directories as tar.gz -----------------------

def download(namespace: str, pod: str, container: str, path: str,
             *, as_tar: bool) -> Iterator[bytes]:
    if not exists(namespace, pod, container, path):
        raise ExecError(f"no such file or directory: {path}")
    if as_tar:
        parent, _, name = path.rstrip("/").rpartition("/")
        argv = ["tar", "-cz", "-C", parent or "/", name or "/"]
    else:
        argv = ["cat", path]
    ws = _connect(namespace, pod, container, argv)

    def generate() -> Iterator[bytes]:
        try:
            while ws.is_open():
                ws.update(timeout=1)
                if ws.peek_stdout():
                    yield ws.read_stdout()
            if ws.peek_stdout():
                yield ws.read_stdout()
        finally:
            ws.close()

    return generate()


# -- inline actions ---------------------------------------------------

def mkdir(namespace: str, pod: str, container: str, path: str) -> None:
    _check(namespace, pod, container, ["mkdir", "-p", path], timeout=15)


def rename(namespace: str, pod: str, container: str, src: str, dst: str) -> None:
    _check(namespace, pod, container, ["mv", src, dst], timeout=30)


def delete(namespace: str, pod: str, container: str, path: str) -> None:
    if path.rstrip("/") in ("", "/"):
        raise ExecError("refusing to delete /")
    _check(namespace, pod, container, ["rm", "-rf", path], timeout=60)


def chmod(namespace: str, pod: str, container: str, path: str, mode: str) -> None:
    if not all(c in "01234567ugoarwxstX+-=," for c in mode):
        raise ExecError(f"invalid mode: {mode}")
    _check(namespace, pod, container, ["chmod", mode, path], timeout=15)


# -- disk usage sampling (opt-in per request) ----------------------------------

def disk_usage(namespace: str, pod: str, container: str) -> list[dict]:
    out = _check(namespace, pod, container, ["df", "-P", "-k"], timeout=30)
    rows = []
    for line in out.decode("utf-8", "replace").splitlines()[1:]:
        f = line.split()
        if len(f) < 6:
            continue
        try:
            rows.append({
                "filesystem": f[0],
                "sizeKb": int(f[1]),
                "usedKb": int(f[2]),
                "availKb": int(f[3]),
                "mount": " ".join(f[5:]),
            })
        except ValueError:
            continue
    return rows
