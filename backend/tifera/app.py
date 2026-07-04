"""TifEra backend application.

FastAPI app serving the REST API, the /ws/events broadcast channel, the
per-session terminal and log WebSockets, and the static frontend bundle.
The in-cluster check runs in __main__ *before* this module is
imported, so every handler here can assume a configured in-cluster client.
"""

import asyncio
import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from urllib.parse import quote, urlparse

import yaml
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from kubernetes import client as k8s
from kubernetes.client import ApiClient

from . import __version__
from . import config as cfg
from . import debug, fsops, resources, topology
from .resources import resource_index
from .actionlog import actionlog
from .broadcast import broadcaster
from .incluster import rbac_self_check
from .inventory import inventory
from .logs import LogStream
from .metrics import metrics_poller
from .presence import editors, presence, target_key
from .snippets import snippet_store
from .terminal import ShellNotFound, sessions

log = logging.getLogger("tifera.app")


def _run_rbac_check(app: FastAPI) -> None:
    missing = rbac_self_check()
    app.state.rbac_missing = missing
    # Surfaced as a status banner in the UI, not a crash.
    broadcaster.publish({"type": "rbac", "missing": missing})


@asynccontextmanager
async def lifespan(app: FastAPI):
    broadcaster.bind_loop(asyncio.get_running_loop())
    app.state.rbac_missing = None  # None = check still running
    app.state.event_clients = {}   # clientId -> open events-WS count
    actionlog.open()
    snippet_store.open()
    inventory.start()
    sessions.start()
    metrics_poller.start()
    threading.Thread(target=_run_rbac_check, args=(app,),
                     name="rbac-check", daemon=True).start()
    yield
    inventory.stop()
    metrics_poller.stop()
    sessions.stop()
    sessions.close_all("backend shutting down")
    snippet_store.close()
    actionlog.close()


app = FastAPI(title="TifEra", version=__version__, lifespan=lifespan)


@app.middleware("http")
async def security_headers(request, call_next):
    # No console auth by design, but CSP still blunts drive-by and
    # cross-site abuse from other pages the operator has open.
    response = await call_next(request)
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; connect-src 'self'")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    return response


def _origin_ok(ws: WebSocket) -> bool:
    """WebSocket Origin check - same host, or a non-browser client."""
    origin = ws.headers.get("origin")
    if not origin:
        return True
    return urlparse(origin).netloc == ws.headers.get("host", "")


def _identity() -> dict:
    # Who/where we are, from the Downward API.
    return {"namespace": cfg.NAMESPACE, "pod": cfg.POD_NAME,
            "node": cfg.NODE_NAME, "version": __version__}


def _client_of(request: Request) -> dict:
    return {
        "client_id": request.query_params.get("clientId", ""),
        "client_name": request.query_params.get("clientName", ""),
        "client_ip": request.client.host if request.client else "",
    }


def _fs(fn, *args, **kwargs):
    """Run an fsops call, mapping failures onto HTTP errors."""
    try:
        return fn(*args, **kwargs)
    except fsops.ExecError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except k8s.ApiException as exc:
        raise HTTPException(status_code=502,
                            detail=f"K8s API error: {exc.reason} (HTTP {exc.status})")


# -- health & self-observability --------------------------------------

@app.get("/healthz")
def healthz():
    return {"status": "ok", **_identity()}


@app.get("/readyz")
def readyz():
    missing = app.state.rbac_missing
    return {
        "status": "ok",
        "rbac": "checking" if missing is None else ("ok" if not missing else "degraded"),
        "missingPermissions": missing or [],
        "metricsAvailable": metrics_poller.available,
        **_identity(),
    }


@app.get("/metrics")
def prometheus_metrics():
    """Prometheus exposition of TifEra's own state."""
    missing = app.state.rbac_missing
    lines = [
        "# HELP tifera_sessions_active Active terminal sessions.",
        "# TYPE tifera_sessions_active gauge",
        f"tifera_sessions_active {sessions.count()}",
        "# HELP tifera_pods_watched Pods in the inventory snapshot.",
        "# TYPE tifera_pods_watched gauge",
        f"tifera_pods_watched {len(inventory.snapshot())}",
        "# HELP tifera_consoles_connected Connected /ws/events consoles.",
        "# TYPE tifera_consoles_connected gauge",
        f"tifera_consoles_connected {broadcaster.subscriber_count()}",
        "# HELP tifera_rbac_missing_permissions Permissions the ServiceAccount lacks.",
        "# TYPE tifera_rbac_missing_permissions gauge",
        f"tifera_rbac_missing_permissions {len(missing) if missing else 0}",
        "# HELP tifera_metrics_api_available 1 when metrics.k8s.io responds.",
        "# TYPE tifera_metrics_api_available gauge",
        f"tifera_metrics_api_available {1 if metrics_poller.available else 0}",
    ]
    return PlainTextResponse("\n".join(lines) + "\n",
                             media_type="text/plain; version=0.0.4; charset=utf-8")


@app.get("/api/config")
def api_config():
    return {
        "maxUploadBytes": cfg.MAX_UPLOAD_BYTES,
        "uploadChunkLimit": cfg.UPLOAD_CHUNK_LIMIT,
        "editMaxBytes": cfg.EDIT_MAX_BYTES,
        "debugImage": cfg.DEBUG_IMAGE,
        "recordSessions": cfg.RECORD_SESSIONS,
        "idleTimeoutSeconds": cfg.IDLE_TIMEOUT_SECONDS,
        "reconnectGraceSeconds": cfg.RECONNECT_GRACE_SECONDS,
    }


# -- inventory, metrics, topology, events -------------------------------------

@app.get("/api/pods")
def api_pods():
    return {"pods": inventory.snapshot()}


@app.get("/api/metrics")
def api_metrics():
    return metrics_poller.latest()


@app.get("/api/metrics/history")
def api_metrics_history(target: str):
    # target = "ns/pod/container"; samples are [ts, cpu_millicores, mem_bytes]
    return {"target": target, "samples": metrics_poller.history(target)}


@app.get("/api/topology")
def api_topology(namespace: str = "", mounts: int = 0):
    try:
        return topology.build(namespace or None, include_mounts=bool(mounts))
    except k8s.ApiException as exc:
        raise HTTPException(status_code=502,
                            detail=f"K8s API error: {exc.reason} (HTTP {exc.status})")


@app.get("/api/resources")
def api_resources():
    """Cached name index of non-pod resources for the command palette."""
    return {"resources": resource_index.list()}


@app.get("/api/describe/{kind}/{namespace}/{name}")
def api_describe(kind: str, namespace: str, name: str):
    """Read-only YAML for a resource (Secret values masked)."""
    try:
        obj = resources.read_object(kind, namespace, name)
    except k8s.ApiException as exc:
        raise HTTPException(status_code=404 if exc.status == 404 else 502,
                            detail=exc.reason)
    if obj is None:
        raise HTTPException(status_code=400, detail=f"unsupported kind: {kind}")
    data = ApiClient().sanitize_for_serialization(obj)
    data.get("metadata", {}).pop("managedFields", None)
    data = resources.mask_secret(data)
    return PlainTextResponse(yaml.safe_dump(data, sort_keys=False),
                             media_type="text/yaml")


@app.get("/api/events")
def api_events(namespace: str = "", name: str = ""):
    """Events feed per namespace/pod."""
    v1 = k8s.CoreV1Api()
    try:
        if namespace and name:
            items = v1.list_namespaced_event(
                namespace, field_selector=f"involvedObject.name={name}").items
        elif namespace:
            items = v1.list_namespaced_event(namespace).items
        else:
            items = v1.list_event_for_all_namespaces(limit=500).items
    except k8s.ApiException as exc:
        raise HTTPException(status_code=502,
                            detail=f"K8s API error: {exc.reason} (HTTP {exc.status})")
    events = []
    for e in items:
        ts = e.last_timestamp or e.event_time or e.metadata.creation_timestamp
        events.append({
            "type": e.type or "",
            "reason": e.reason or "",
            "message": e.message or "",
            "count": e.count or 1,
            "time": ts.isoformat() if ts else None,
            "kind": e.involved_object.kind or "",
            "name": e.involved_object.name or "",
            "namespace": e.involved_object.namespace or "",
        })
    events.sort(key=lambda x: x["time"] or "", reverse=True)
    return {"events": events[:500]}


# -- quick actions ----------------------------------------------------

@app.delete("/api/pods/{namespace}/{pod}")
def api_pod_delete(namespace: str, pod: str, request: Request):
    """Restart = delete and let the controller reschedule. The frontend adds
    the extra self-termination confirmation for TifEra's own pod."""
    v1 = k8s.CoreV1Api()
    try:
        v1.delete_namespaced_pod(pod, namespace)
    except k8s.ApiException as exc:
        raise HTTPException(status_code=502,
                            detail=f"delete failed: {exc.reason} (HTTP {exc.status})")
    actionlog.record("pod_restart", namespace=namespace, pod=pod, **_client_of(request))
    return {"status": "deleted"}


@app.get("/api/pods/{namespace}/{pod}/yaml")
def api_pod_yaml(namespace: str, pod: str):
    v1 = k8s.CoreV1Api()
    try:
        obj = v1.read_namespaced_pod(pod, namespace)
    except k8s.ApiException as exc:
        raise HTTPException(status_code=404 if exc.status == 404 else 502,
                            detail=exc.reason)
    data = ApiClient().sanitize_for_serialization(obj)
    data.get("metadata", {}).pop("managedFields", None)
    return PlainTextResponse(yaml.safe_dump(data, sort_keys=False),
                             media_type="text/yaml")


@app.post("/api/debug/{namespace}/{pod}")
def api_debug(namespace: str, pod: str, request: Request, container: str = ""):
    """Attach an ephemeral debug container; the console then opens a
    normal terminal session on the returned container name."""
    try:
        name = debug.create_debug_container(namespace, pod, container)
    except k8s.ApiException as exc:
        raise HTTPException(status_code=502,
                            detail=f"ephemeral container failed: {exc.reason}")
    except (RuntimeError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    actionlog.record("debug_attach", namespace=namespace, pod=pod,
                     container=container, detail=json.dumps({"debugContainer": name}),
                     **_client_of(request))
    return {"debugContainer": name}


# -- file browser & transfer --------------------------------------

@app.get("/api/fs/{namespace}/{pod}/{container}/list")
def fs_list(namespace: str, pod: str, container: str, path: str = "/"):
    return {"path": path, "entries": _fs(fsops.list_dir, namespace, pod, container, path)}


@app.get("/api/fs/{namespace}/{pod}/{container}/file")
def fs_read(namespace: str, pod: str, container: str, path: str):
    data = _fs(fsops.read_file, namespace, pod, container, path, cfg.EDIT_MAX_BYTES)
    mtime = _fs(fsops.stat_mtime, namespace, pod, container, path)
    return {"path": path, "text": data.decode("utf-8", "replace"),
            "size": len(data), "mtime": mtime}


@app.put("/api/fs/{namespace}/{pod}/{container}/file")
async def fs_write(namespace: str, pod: str, container: str, request: Request,
                   path: str, mtime: int = -1, force: int = 0):
    """Save from the built-in editor. Last-write-wins, but the second writer
    is told the file changed underneath them first: pass the mtime
    from load time; a mismatch returns 409 unless force=1."""
    body = await request.body()
    if len(body) > cfg.EDIT_MAX_BYTES:
        raise HTTPException(413, "file exceeds the editor size limit")
    if mtime >= 0 and not force:
        current = await asyncio.to_thread(
            _fs, fsops.stat_mtime, namespace, pod, container, path)
        if current is not None and current != mtime:
            raise HTTPException(409, "file changed since it was loaded")
    await asyncio.to_thread(_fs, fsops.write_file, namespace, pod, container, path, body)
    new_mtime = await asyncio.to_thread(
        _fs, fsops.stat_mtime, namespace, pod, container, path)
    actionlog.record("file_edit", namespace=namespace, pod=pod, container=container,
                     detail=json.dumps({"path": path, "bytes": len(body)}),
                     **_client_of(request))
    return {"status": "saved", "mtime": new_mtime}


@app.post("/api/fs/{namespace}/{pod}/{container}/upload")
async def fs_upload(namespace: str, pod: str, container: str, request: Request,
                    path: str, append: int = 0, final: int = 1, total: int = 0):
    """Chunked upload - the client slices the file and sends
    sequential requests with append=1 after the first chunk."""
    body = await request.body()
    if len(body) > cfg.UPLOAD_CHUNK_LIMIT:
        raise HTTPException(413, "chunk exceeds per-request limit")
    if total and total > cfg.MAX_UPLOAD_BYTES:
        raise HTTPException(413, "file exceeds the configured upload limit")
    await asyncio.to_thread(_fs, fsops.write_file, namespace, pod, container,
                            path, body, append=bool(append))
    if final:
        actionlog.record("file_upload", namespace=namespace, pod=pod,
                         container=container,
                         detail=json.dumps({"path": path, "bytes": total or len(body)}),
                         **_client_of(request))
    return {"status": "ok", "bytes": len(body)}


@app.get("/api/fs/{namespace}/{pod}/{container}/download")
def fs_download(namespace: str, pod: str, container: str, request: Request,
                path: str, dir: int = 0):
    """Stream a file, or a directory as tar.gz."""
    generator = _fs(fsops.download, namespace, pod, container, path, as_tar=bool(dir))
    name = path.rstrip("/").rpartition("/")[2] or "root"
    filename = f"{name}.tar.gz" if dir else name
    actionlog.record("file_download", namespace=namespace, pod=pod,
                     container=container, detail=json.dumps({"path": path, "dir": bool(dir)}),
                     **_client_of(request))
    return StreamingResponse(
        generator,
        media_type="application/gzip" if dir else "application/octet-stream",
        headers={"Content-Disposition":
                 f"attachment; filename*=UTF-8''{quote(filename)}"})


@app.post("/api/fs/{namespace}/{pod}/{container}/op")
async def fs_op(namespace: str, pod: str, container: str, request: Request):
    """Inline actions: {"op": mkdir|rename|delete|chmod, "path", ...}."""
    data = await request.json()
    op, path = data.get("op"), data.get("path", "")
    if not path:
        raise HTTPException(400, "path is required")
    if op == "mkdir":
        await asyncio.to_thread(_fs, fsops.mkdir, namespace, pod, container, path)
    elif op == "rename":
        if not data.get("to"):
            raise HTTPException(400, "'to' is required for rename")
        await asyncio.to_thread(_fs, fsops.rename, namespace, pod, container,
                                path, data["to"])
    elif op == "delete":
        await asyncio.to_thread(_fs, fsops.delete, namespace, pod, container, path)
    elif op == "chmod":
        if not data.get("mode"):
            raise HTTPException(400, "'mode' is required for chmod")
        await asyncio.to_thread(_fs, fsops.chmod, namespace, pod, container,
                                path, data["mode"])
    else:
        raise HTTPException(400, f"unknown op: {op}")
    actionlog.record(f"file_{op}", namespace=namespace, pod=pod, container=container,
                     detail=json.dumps({k: v for k, v in data.items() if k != "op"}),
                     **_client_of(request))
    return {"status": "ok"}


@app.get("/api/fs/{namespace}/{pod}/{container}/df")
def fs_df(namespace: str, pod: str, container: str):
    """Opt-in disk usage sampling via exec `df`."""
    return {"filesystems": _fs(fsops.disk_usage, namespace, pod, container)}


# -- editor presence --------------------------------------------------

@app.post("/api/editor")
async def api_editor(request: Request):
    data = await request.json()
    target = target_key(data.get("namespace", ""), data.get("pod", ""),
                        data.get("container", ""))
    path = data.get("path", "")
    client_id = data.get("clientId", "")
    if data.get("action") == "open":
        others = editors.open(target, path, client_id, data.get("clientName", ""))
        return {"others": others}
    editors.close(target, path, client_id)
    return {"others": []}


# -- logs: REST download + WS follow -------------------------------------

@app.get("/api/logs/{namespace}/{pod}/{container}")
def api_logs(namespace: str, pod: str, container: str,
             tailLines: int = 0, previous: int = 0, sinceSeconds: int = 0,
             timestamps: int = 0):
    """Download logs with tail/time-range selection."""
    v1 = k8s.CoreV1Api()
    kwargs: dict = {"container": container, "previous": bool(previous),
                    "timestamps": bool(timestamps)}
    if tailLines:
        kwargs["tail_lines"] = tailLines
    if sinceSeconds:
        kwargs["since_seconds"] = sinceSeconds
    try:
        text = v1.read_namespaced_pod_log(pod, namespace, **kwargs)
    except k8s.ApiException as exc:
        raise HTTPException(status_code=404 if exc.status == 400 else 502,
                            detail=exc.reason)
    return PlainTextResponse(text, headers={
        "Content-Disposition":
        f"attachment; filename*=UTF-8''{quote(f'{pod}-{container}.log')}"})


# -- action log ---------------------------------------------------------

@app.get("/api/actions")
def api_actions(limit: int = 200):
    return {"actions": actionlog.recent(limit=min(limit, 10_000))}


@app.get("/api/actions/export")
def api_actions_export():
    return PlainTextResponse(actionlog.export_jsonl(),
                             media_type="application/x-ndjson")


# -- snippets ------------------------------------------------------------

@app.get("/api/snippets")
def snippets_list():
    return {"snippets": snippet_store.list()}


@app.post("/api/snippets")
async def snippets_add(request: Request):
    data = await request.json()
    if not data.get("name") or not data.get("command"):
        raise HTTPException(400, "name and command are required")
    return snippet_store.add(data["name"], data["command"])


@app.delete("/api/snippets/{snippet_id}")
def snippets_delete(snippet_id: int):
    snippet_store.delete(snippet_id)
    return {"status": "deleted"}


# -- /ws/events: server-pushed inventory, presence, metrics, rbac deltas ----------

@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    if not _origin_ok(ws):
        await ws.close(code=4403)
        return
    await ws.accept()
    client_id = ws.query_params.get("clientId", "")
    counts: dict = app.state.event_clients
    if client_id:
        counts[client_id] = counts.get(client_id, 0) + 1
    q = broadcaster.subscribe()
    try:
        await ws.send_json({
            "type": "hello",
            "identity": _identity(),
            "pods": inventory.snapshot(),
            "presence": presence.snapshot(),
            "metrics": metrics_poller.latest(),
            "rbacMissing": app.state.rbac_missing,
        })
        while True:
            await ws.send_json(await q.get())
    except WebSocketDisconnect:
        pass
    finally:
        broadcaster.unsubscribe(q)
        if client_id:
            counts[client_id] = counts.get(client_id, 1) - 1
            if counts[client_id] <= 0:
                counts.pop(client_id, None)
                editors.drop_client(client_id)  # clear their editor warnings


# -- /ws/terminal: one console tab = one PTY session ----------------

@app.websocket("/ws/terminal/{namespace}/{pod}/{container}")
async def ws_terminal(ws: WebSocket, namespace: str, pod: str, container: str):
    """Binary frames carry terminal bytes both ways; text frames carry JSON
    control messages: in {"type":"resize"|"close"|"share"}, out {"type":
    "ready"|"error"|"exit"}. Query: clientId (required), clientName, shell,
    sessionId (reattach within the reconnect grace), join (attach to a
    shared session owned by anyone, feature 1)."""
    if not _origin_ok(ws):
        await ws.close(code=4403)
        return
    await ws.accept()
    p = ws.query_params
    client_id = p.get("clientId", "")
    if not client_id:
        await ws.send_json({"type": "error",
                            "error": "clientId query parameter is required"})
        await ws.close()
        return

    joined = False
    if join_id := p.get("join"):
        session = sessions.get_joinable(join_id, client_id)
        if session is None:
            await ws.send_json({"type": "error",
                                "error": "that shared session is no longer available"})
            await ws.close()
            return
        joined = session.client_id != client_id
        if joined:
            actionlog.record(
                "shell_join", client_id=client_id, client_name=p.get("clientName", ""),
                client_ip=ws.client.host if ws.client else "",
                namespace=session.namespace, pod=session.pod, container=session.container,
                detail=json.dumps({"sessionId": session.id, "owner": session.client_name}))
    elif reattach_id := p.get("sessionId"):
        session = sessions.get(reattach_id, client_id)
        if session is None:
            await ws.send_json({"type": "error",
                                "error": "session expired or not yours - open a new one"})
            await ws.close()
            return
    else:
        try:
            session = await asyncio.to_thread(
                sessions.create, namespace, pod, container,
                client_id=client_id, client_name=p.get("clientName", ""),
                client_ip=ws.client.host if ws.client else "",
                shell=p.get("shell"))
        except ShellNotFound as exc:
            await ws.send_json({"type": "error", "shellNotFound": True,
                                "error": str(exc)})
            await ws.close()
            return
        except Exception as exc:  # noqa: BLE001 - pod gone, RBAC, ...
            await ws.send_json({"type": "error", "error": f"exec failed: {exc}"})
            await ws.close()
            return

    # Tell the joining client who already has a shell here; the
    # existing clients learn about this session from the presence broadcast.
    await ws.send_json({
        "type": "ready",
        "sessionId": session.id,
        "shell": session.shell,
        "target": session.target,
        "others": presence.others_on(session.target, client_id),
        "shared": session.shared,
        "joined": joined,
        "owner": session.client_name or session.client_id[:6],
    })

    loop = asyncio.get_running_loop()
    q: asyncio.Queue[bytes | None] = asyncio.Queue()

    def sink(chunk: bytes | None) -> None:
        loop.call_soon_threadsafe(q.put_nowait, chunk)

    handle, replay = session.attach(sink)
    if replay:
        await ws.send_bytes(replay)

    async def to_browser() -> None:
        try:
            while True:
                chunk = await q.get()
                if chunk is None:
                    await ws.send_json({"type": "exit", "message": session.exit_message})
                    await ws.close()
                    return
                await ws.send_bytes(chunk)
        except Exception:  # noqa: BLE001 - browser went away mid-send
            pass

    forward = asyncio.create_task(to_browser())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if (data := msg.get("bytes")) is not None:
                session.write_stdin(data)
            elif (text := msg.get("text")) is not None:
                try:
                    ctrl = json.loads(text)
                    if ctrl.get("type") == "resize":
                        session.resize(int(ctrl["cols"]), int(ctrl["rows"]))
                    elif ctrl.get("type") == "close":
                        session.close("closed by client")
                    elif ctrl.get("type") == "share" and not joined:
                        # Only the owner may toggle sharing (feature 1).
                        session.set_shared(bool(ctrl.get("on")))
                except (ValueError, KeyError, TypeError):
                    continue
    except WebSocketDisconnect:
        pass
    finally:
        forward.cancel()
        if not session.closed.is_set():
            session.detach(handle)  # keep the PTY for reconnect / collaborators


# -- /ws/logs: live-follow and previous-instance logs ----------------------

@app.websocket("/ws/logs/{namespace}/{pod}/{container}")
async def ws_logs(ws: WebSocket, namespace: str, pod: str, container: str):
    """Binary frames carry raw log chunks. Query: follow (default 1),
    tailLines (default 500), previous, timestamps."""
    if not _origin_ok(ws):
        await ws.close(code=4403)
        return
    await ws.accept()
    p = ws.query_params
    loop = asyncio.get_running_loop()
    q: asyncio.Queue[bytes | None] = asyncio.Queue()

    def sink(chunk: bytes | None) -> None:
        loop.call_soon_threadsafe(q.put_nowait, chunk)

    try:
        logstream = await asyncio.to_thread(
            LogStream, namespace, pod, container, sink=sink,
            follow=p.get("follow", "1") not in ("0", "false"),
            tail_lines=int(p.get("tailLines", "500")),
            previous=p.get("previous") in ("1", "true"),
            timestamps=p.get("timestamps") in ("1", "true"))
    except Exception as exc:  # noqa: BLE001
        await ws.send_json({"type": "error", "error": f"cannot read logs: {exc}"})
        await ws.close()
        return

    async def to_browser() -> None:
        try:
            while True:
                chunk = await q.get()
                if chunk is None:
                    await ws.send_json({"type": "eof"})
                    await ws.close()
                    return
                await ws.send_bytes(chunk)
        except Exception:  # noqa: BLE001 - browser went away mid-send
            pass

    forward = asyncio.create_task(to_browser())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
    except WebSocketDisconnect:
        pass
    finally:
        forward.cancel()
        logstream.close()


# -- static frontend bundle --------------------------------------------------------

if os.path.isdir(cfg.STATIC_DIR):
    app.mount("/", StaticFiles(directory=cfg.STATIC_DIR, html=True), name="console")
else:
    @app.get("/")
    def index():
        return {"app": "TifEra", "version": __version__,
                "note": "frontend bundle not present; API and WebSockets are live"}
