<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=2f2f2f&height=200&section=header&text=TifEra&fontSize=80&fontColor=ffffff&fontAlignY=45&desc=In-Cluster%20Kubernetes%20Operations%20Console&descSize=22&descColor=c0c0c0&descAlignY=70&animation=fadeIn" width="100%" />

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=24&duration=3000&pause=1000&color=8a8a8a&center=true&vCenter=true&width=640&lines=One-Click+Container+Shells+%E2%8C%A8;In-Cluster+Only+-+No+Kubeconfig+%F0%9F%94%92;Files+%C2%B7+Logs+%C2%B7+Metrics+%C2%B7+Topology+%F0%9F%93%8A;No+Agents+in+Target+Pods+%E2%9A%99%EF%B8%8F" alt="Typing SVG" />

<br/>

[![CI](https://img.shields.io/github/actions/workflow/status/stratza/tiferea/ci.yml?branch=main&style=for-the-badge&logo=github&label=CI&labelColor=1a1a1a)](https://github.com/stratza/tiferea/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.3.5-6e6e6e?style=for-the-badge&labelColor=1a1a1a)](CHANGELOG.md)
[![Kubernetes](https://img.shields.io/badge/kubernetes-%E2%89%A5%201.27-4a4a4a?style=for-the-badge&logo=kubernetes&logoColor=white&labelColor=1a1a1a)](deploy/)
[![License](https://img.shields.io/badge/license-MIT-9e9e9e?style=for-the-badge&labelColor=1a1a1a)](LICENSE)

<br />

<a href="#-quick-start"><b>Quick Start</b></a> • <a href="#-features"><b>Features</b></a> • <a href="SECURITY.md"><b>Security</b></a> • <a href="CONTRIBUTING.md"><b>Contributing</b></a> • <a href="CHANGELOG.md"><b>Changelog</b></a>

</div>

---

## ⚡ Overview

**TifEra** is a browser-based, terminal-first operations console for Kubernetes - "MobaXterm for K8s". It runs as a single pod *inside* the cluster and drives everything through the Kubernetes API with the pod's own ServiceAccount: no agents, no kubeconfig, no client CLI. Built with FastAPI + dependency-free vanilla JS and vendored xterm.js.

Two invariants define it:

- 🔒 **In-cluster only** - all cluster credentials come from the pod environment; run the image anywhere else and it exits in 5s (no bypass, CI-enforced).
- 👤 **Login + roles** - first run bootstraps an admin; users are **Admin / Operator / Viewer**, enforced server-side. A Viewer sees only non-sensitive data (no shells, files, kubectl, logs, Secrets or writes).

> [!IMPORTANT]
> TifEra terminates no TLS - keep the Service ClusterIP (`kubectl port-forward`) or front it with a TLS proxy. See [SECURITY.md](SECURITY.md).

---

## 💎 Features

| | | |
|:---:|:---|:---|
| ⌨ | **Shell** | One-click PTY (xterm.js) into any container; tabs + split panes, reconnect-with-replay, debug container for distroless |
| 📂 | **Files** | Browse, drag-drop upload, download (dirs as tar.gz), edit/rename/chmod - all over exec, no agent |
| 📜 | **Logs** | Live follow with filter & highlighting, previous-instance, merged multi-container |
| 📊 | **Metrics** | CPU/mem sparklines vs requests/limits, node usage (via metrics-server; degrades without) |
| 🕸 | **Topology** | Namespace overview cards → workload-aggregated Services→Workloads graph → click-to-focus with pods; search, problems-only filter, readable at any cluster size |
| 👥 | **Multi-operator** | Presence badges, **shared sessions** (join a colleague's live shell), edit-conflict warnings |
| 🔍 | **Command palette** | `Ctrl+K` to find pods/containers/resources or jump to any view |
| ⎈ | **kubectl console** | Rancher-style in-cluster kubectl shell (bounded by TifEra's RBAC) |
| 🔐 | **Auth** | First-run admin in a k8s Secret, scrypt passwords, HMAC sessions, roles enforced server-side |
| 🧾 | **Accountability** | Action log (JSONL export) + optional session recording with in-browser playback |
| 🛠 | **Tools** | Pod restart, bulk actions, YAML edit & apply (Secrets masked), events, snippets, broadcast input |
| ⚙️ | **Settings** | Theme, font size, workspace persistence, resizable sidebar |

---

## 🚀 Quick Start

**From a published release** (multi-arch image on GHCR):

```sh
kubectl apply -f https://github.com/stratza/tiferea/releases/latest/download/tifera-0.3.5.yaml
# …or Helm:  helm install tifera oci://ghcr.io/stratza/charts/tifera --version 0.3.5 -n tifera --create-namespace
kubectl -n tifera port-forward svc/tifera 8080:80   # → http://localhost:8080
```

**From source** (build into a local cluster):

```sh
docker build -t tifera:0.3.5 backend
kind load docker-image tifera:0.3.5   # or: k3d image import tifera:0.3.5
kubectl apply -f deploy/tifera.yaml
kubectl -n tifera port-forward svc/tifera 8080:80
```

On first visit you create the admin account; after that, sign in or continue as a read-only Viewer. Needs a default StorageClass (RWO PVC); `metrics-server` is optional.

<details>
<summary><b>⚙️ Configuration (env vars)</b></summary>

| Var | Default | Purpose |
|:---|:---|:---|
| `TIFERA_LISTEN_PORT` | `8080` | listen port |
| `TIFERA_DATA_DIR` | `/data` | PVC mount for SQLite + recordings |
| `TIFERA_IDLE_TIMEOUT` | `1800` | terminal idle timeout, seconds |
| `TIFERA_RECONNECT_GRACE` | `10` | seconds a dropped session waits for reattach |
| `TIFERA_MAX_UPLOAD` | `2147483648` | max upload size in bytes |
| `TIFERA_DEBUG_IMAGE` | `busybox:1.36` | ephemeral debug container image |
| `TIFERA_RECORD_SESSIONS` | off | `1` = record sessions as playable .cast files |
| `TIFERA_METRICS_INTERVAL` | `15` | metrics poll seconds |
| `TIFERA_AUTH_SECRET` | `tifera-auth` | k8s Secret holding users + session key |
| `TIFERA_SESSION_TTL` | `43200` | login session lifetime, seconds |

Helm exposes these via `values.yaml` (`config.*`, `persistence.*`, `rbac.*`, `networkPolicy.*`).
</details>

<details>
<summary><b>🛰️ Air-gapped install</b></summary>

At runtime TifEra pulls nothing (kubectl + xterm.js are baked in); only the build and image distribution need internet.

1. **Build** on a connected machine: `docker build -t tifera:0.3.5 backend` (add `--build-arg KUBECTL_VERSION=v1.31.4` to pin kubectl; `docker buildx --platform ...` for other arches).
2. **Move it in** - push to an internal registry, or `docker save … | ` copy `| sudo k3s ctr images import …` (or `kind load image-archive`).
3. **Mirror the one runtime image** - the debug container (default `busybox:1.36`); mirror it and set `TIFERA_DEBUG_IMAGE` / Helm `config.debugImage`, or skip it.
4. **Deploy** with the image rewritten: `sed 's#image: tifera:0.3.5#image: registry.internal/tifera:0.3.5#' deploy/tifera.yaml | kubectl apply -f -`, or Helm `--set image.repository=…,image.tag=0.3.5`.
</details>

<details>
<summary><b>📁 Repository layout</b></summary>

```
backend/tifera/   Python 3.12 backend (FastAPI + official kubernetes client)
                  auth · terminal · kubeshell · fsops · inventory · metrics ·
                  topology · resources · recordings · logs · presence ·
                  actionlog · snippets · debug · incluster · app
backend/static/   frontend: dependency-free ES modules + vendored xterm.js
backend/tests/    unit tests incl. the outside-cluster refusal test
deploy/           single-file manifest + Helm chart
```
</details>

---

## 🧑‍💻 Development

```sh
pip install -r backend/requirements.txt pytest
PYTHONPATH=backend pytest backend/tests -q
```

There's deliberately no way to run against a remote cluster from a workstation - develop against a local cluster (kind/k3d/k3s) by building and loading the image. See [CONTRIBUTING.md](CONTRIBUTING.md) (incl. building in-cluster with Kaniko when you have no local Docker).

## 🛡️ Security

Login required with server-enforced Admin/Operator/Viewer roles; TifEra never exceeds its own least-privilege ClusterRole; hardened pod (non-root, read-only rootfs, all caps dropped). Full model, reporting and hardening in [SECURITY.md](SECURITY.md).

## 🤝 Contributing

Contributions welcome - see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed; see [`LICENSE`](LICENSE).

<div align="center">

---

*TifEra Project © 2026 Stratza Labs*

<img src="https://capsule-render.vercel.app/api?type=waving&color=2f2f2f&height=100&section=footer" width="100%" />

</div>
