<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=2f2f2f&height=200&section=header&text=TifEra&fontSize=80&fontColor=ffffff&fontAlignY=45&desc=In-Cluster%20Kubernetes%20Operations%20Console&descSize=22&descColor=c0c0c0&descAlignY=70&animation=fadeIn" width="100%" />

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=24&duration=3000&pause=1000&color=8a8a8a&center=true&vCenter=true&width=640&lines=One-Click+Container+Shells+%E2%8C%A8;In-Cluster+Only+-+No+Kubeconfig+%F0%9F%94%92;Files+%C2%B7+Logs+%C2%B7+Metrics+%C2%B7+Topology+%F0%9F%93%8A;No+Agents+in+Target+Pods+%E2%9A%99%EF%B8%8F" alt="Typing SVG" />

<br/>

[![CI](https://img.shields.io/github/actions/workflow/status/stratza/tiferea/ci.yml?branch=main&style=for-the-badge&logo=github&label=CI&labelColor=1a1a1a)](https://github.com/stratza/tiferea/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.1.1-6e6e6e?style=for-the-badge&labelColor=1a1a1a)](CHANGELOG.md)
[![Kubernetes](https://img.shields.io/badge/kubernetes-%E2%89%A5%201.27-4a4a4a?style=for-the-badge&logo=kubernetes&logoColor=white&labelColor=1a1a1a)](deploy/)
[![Python](https://img.shields.io/badge/python-3.12-4a4a4a?style=for-the-badge&logo=python&logoColor=white&labelColor=1a1a1a)](backend/)
[![License](https://img.shields.io/badge/license-MIT-9e9e9e?style=for-the-badge&labelColor=1a1a1a)](LICENSE)

<br />

<a href="#-quick-start"><b>Quick Start</b></a> • <a href="#-features"><b>Features</b></a> • <a href="SECURITY.md"><b>Security</b></a> • <a href="CONTRIBUTING.md"><b>Contributing</b></a> • <a href="CHANGELOG.md"><b>Changelog</b></a>

</div>

---

## ⚡ Overview

**TifEra** is a browser-based, terminal-first operations console for Kubernetes. It runs as a single pod *inside* the cluster it manages and gives every operator who can reach it an interactive interface to every container: one-click shells, file transfer, a filesystem browser, live logs, metrics, and a topology graph - all through the Kubernetes API using the pod's own ServiceAccount. No agents in target pods, no kubeconfig, no CLI on the client.

> [!WARNING]
> **TifEra has no console authentication - by design.** Access control is *network reachability*: whoever can open the page holds the full power of TifEra's ServiceAccount. The Service is ClusterIP by default; reach it with `kubectl port-forward` (which itself requires kubeconfig credentials). Widening exposure is your explicit decision - read [SECURITY.md](SECURITY.md) first.

### 🔥 The Two Rules

- 🔒 **In-Cluster Only**: All identity and credentials come from the pod environment (ServiceAccount token, Downward API). Run the image anywhere else and it exits within 5 seconds - no kubeconfig mode, no bypass flag, enforced by CI.
- 🌐 **Network Reachability = Access**: No accounts, logins, cookies or roles anywhere. Presence indicators and mutual warnings keep multiple operators aware of each other - awareness, not locking.

---

## 💎 Features

| | Area | What you get |
|:---:|:---|:---|
| ⌨ | **Shell** | One click on any container → full PTY (xterm.js), tabs and split-pane tiling, `bash`→`sh`→`ash` auto-detect, reconnect-on-drop with scrollback replay, ephemeral debug container for shell-less images |
| 📂 | **Files** | Remote browser rooted at `/`, drag-and-drop chunked uploads, file/dir (tar.gz) downloads, small-file editor, rename/delete/chmod/mkdir, bookmarks |
| 📜 | **Logs** | Live follow with pause/regex filter/level highlighting, previous-instance logs, merged multi-container view, downloads |
| 📊 | **Metrics** | Per-container CPU/memory with 60-min sparklines, usage vs requests/limits, node allocatable-vs-used, opt-in `df` disk sampling; degrades gracefully without metrics-server |
| 🕸 | **Topology** | Services → Pods, workloads → Pods, optional ConfigMap/Secret mount edges, unhealthy paths highlighted, drag-to-pan map, click-through to details |
| 👥 | **Multi-operator** | Isolated sessions per browser, presence badges, mutual "someone else has a shell here" warnings, **collaborative shared sessions** (join a colleague's live shell), edit-conflict courtesy checks |
| 🔍 | **Command palette** | `Ctrl+K` to search pods, containers, Services, Deployments, ConfigMaps and Secrets (names only), or jump to any view |
| 🧾 | **Accountability** | Action log (shell/file/quick actions with client identity + IP, JSONL export), optional terminal session recording (.cast files) |
| 🛠 | **Tools** | Pod restart with self-protection for TifEra's own pod, bulk multi-select actions, YAML/describe view (Secret values masked), events feed, command snippets, broadcast input to multiple terminals |

---

## 🧱 Tech Stack

<div align="left">

**Backend** ![Python](https://img.shields.io/badge/Python%203.12-4a4a4a?style=flat-square&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-5e5e5e?style=flat-square&logo=fastapi&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-6e6e6e?style=flat-square&logo=sqlite&logoColor=white)

**Frontend** ![JavaScript](https://img.shields.io/badge/Vanilla%20ES%20Modules-4a4a4a?style=flat-square&logo=javascript&logoColor=white)
![xterm.js](https://img.shields.io/badge/xterm.js-5e5e5e?style=flat-square&logoColor=white)

**Platform** ![Kubernetes](https://img.shields.io/badge/Kubernetes-4a4a4a?style=flat-square&logo=kubernetes&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-5e5e5e?style=flat-square&logo=docker&logoColor=white)
![Helm](https://img.shields.io/badge/Helm-6e6e6e?style=flat-square&logo=helm&logoColor=white)

</div>

The frontend is deliberately dependency-free: vanilla ES modules with vendored xterm.js - no build step, a smaller image, and an artifact that can be audited by reading it.

---

## 🚀 Quick Start

**From a published release** (multi-arch image on GHCR, no build needed):

```sh
# pinned manifest attached to each GitHub Release
kubectl apply -f https://github.com/stratza/tiferea/releases/latest/download/tifera-0.1.1.yaml
# …or Helm (chart published as an OCI artifact):
helm install tifera oci://ghcr.io/stratza/charts/tifera --version 0.1.1 -n tifera --create-namespace

kubectl -n tifera port-forward svc/tifera 8080:80   # → http://localhost:8080
```

**From source** (local build into your cluster):

```sh
docker build -t tifera:0.1.1 backend
# kind: `kind load docker-image tifera:0.1.1`  ·  k3d: `k3d image import tifera:0.1.1`
kubectl apply -f deploy/tifera.yaml                 # or: helm install tifera deploy/helm/tifera -n tifera --create-namespace
kubectl -n tifera port-forward svc/tifera 8080:80   # → http://localhost:8080  - no login, no configuration
```

> [!NOTE]
> **v0.1.1** - collaborative shared sessions, split-pane tiling, a command palette, a live dashboard and a monochrome UI, on top of the first working release. Deployed and exercised end-to-end on a single-node k3s v1.36 cluster. See the [CHANGELOG](CHANGELOG.md) for the full list, including the war stories.

<details>
<summary><b>📁 Repository layout</b></summary>

```
backend/
  tifera/            Python 3.12 backend (FastAPI + official kubernetes client)
    __main__.py      entry point: verify in-cluster env → serve
    incluster.py     in-cluster enforcement + RBAC self-check
    terminal.py      PTY session engine (exec streams, replay, recording)
    fsops.py         exec-based file ops (tar/cat pipes, no agent)
    inventory.py     pod watch → live tree
    metrics.py       metrics.k8s.io poller + history
    topology.py      relationship graph builder
    logs.py          log streaming
    presence.py      session presence + editor-conflict registries
    actionlog.py     SQLite action log
    snippets.py      snippet store
    debug.py         ephemeral debug containers
    app.py           HTTP/WS API
  static/            frontend: dependency-free ES modules + vendored xterm.js
  tests/             unit tests incl. the outside-cluster refusal test
  Dockerfile
deploy/
  tifera.yaml        single-file manifest (Deployment + RBAC + Service + PVC)
  helm/tifera/       Helm chart (same contract, configurable)
```
</details>

<details>
<summary><b>⚙️ Configuration (env vars, all optional)</b></summary>

| Var | Default | Purpose |
|:---|:---|:---|
| `TIFERA_LISTEN_PORT` | `8080` | listen port |
| `TIFERA_DATA_DIR` | `/data` | PVC mount for SQLite + recordings |
| `TIFERA_IDLE_TIMEOUT` | `1800` | terminal idle timeout, seconds |
| `TIFERA_RECONNECT_GRACE` | `10` | seconds a dropped session waits for reattach |
| `TIFERA_MAX_UPLOAD` | `2147483648` | max upload size in bytes |
| `TIFERA_DEBUG_IMAGE` | `busybox:1.36` | ephemeral debug container image |
| `TIFERA_RECORD_SESSIONS` | off | `1` = record sessions as .cast files |
| `TIFERA_CAST_RETENTION_DAYS` | `14` | recording retention |
| `TIFERA_METRICS_INTERVAL` | `15` | metrics poll seconds |

With Helm, set these through `values.yaml` (`config.*`, `persistence.*`, `rbac.allowPodDelete`, `networkPolicy.*`).
</details>

---

## 🧑‍💻 Development

```sh
pip install -r backend/requirements.txt pytest
PYTHONPATH=backend pytest backend/tests -q
```

There is deliberately no way to run the server against a remote cluster from a workstation - develop against a local cluster (kind/k3d/k3s) by building and loading the image. That friction is the point. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including how to build in-cluster with Kaniko when you have no local Docker.

---

## 🛡️ Security

- **Trust model**: no console auth; the network boundary is the security boundary - keep the Service ClusterIP and consider the shipped NetworkPolicy.
- **Least privilege**: documented ClusterRole; missing permissions surface as a UI banner via a startup self-check instead of failing silently.
- **Hardened pod**: non-root, read-only root filesystem, all capabilities dropped, bound ServiceAccount token only.
- **Browser hygiene**: CSP headers and WebSocket `Origin` checks; the browser stores nothing sensitive.
- **Full policy**: see [SECURITY.md](SECURITY.md) for the complete model, vulnerability reporting, and an operator hardening checklist.

---

## 🤝 Contributing

Contributions are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for the invariants that won't change, the dev setup, and PR guidelines.

Distributed under the **MIT License**. See [`LICENSE`](LICENSE) for more information.

<div align="center">

---

*TifEra Project © 2026 Stratza Labs*

<img src="https://capsule-render.vercel.app/api?type=waving&color=2f2f2f&height=100&section=footer" width="100%" />

</div>
