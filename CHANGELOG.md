# Changelog

All notable changes to TifEra are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-07-04

Collaboration, a command palette, split panes, a live dashboard, and a
monochrome UI - plus a batch of fixes found by running the app on a real
cluster.

### Added
- **Collaborative shared sessions**: a session owner can share their shell;
  other operators join the same PTY from the tree (or a broadcast toast) and
  everyone connected sees the output and can type (tmux-style shared
  control). Joins and shares are recorded in the action log.
- **Split-pane tiling**: the panel area can show 1, 2 or 4 tabs at once in a
  grid; click a pane to focus it. Controls appear only with 2+ tabs and
  collapse back to plain tabs automatically.
- **Command palette** (`Ctrl+K`): fuzzy search across pods and containers,
  plus Services, Deployments, StatefulSets, DaemonSets, ConfigMaps and
  Secrets (names only), and jump-to-view commands. Selecting a resource
  opens a read-only YAML view with Secret values masked.
- **Live dashboard** on the welcome screen: animated cluster stat cards
  (namespaces, pods, running, issues, nodes, sessions) fed by the event
  stream.
- **IDE-style status bar**: connection state, cluster identity, live pod
  counts, active session count, editable display name and version.
- **Bulk actions**: multi-select pods in the tree to restart them (with the
  self-pod guard) or open shells into all of them at once.
- **Topology map navigation**: drag-to-pan, wheel-zoom toward the cursor,
  double-click / "fit" to reset.
- Helm chart (`deploy/helm/tifera`) as an alternative to the plain manifest.

### Changed
- **Monochrome grey/white redesign** of the entire console (both themes):
  new surfaces, tabs, scrollbars, focus rings and typography; semantic
  status colours kept but desaturated.
- "MultiExec" broadcast input renamed to **Broadcast**.
- RBAC widened with `get`/`list` on ConfigMaps, Secrets and the `apps`
  workloads to power palette search + describe (Secret *values* are never
  exposed - masked server-side). Reflected in the manifest, Helm chart and
  the startup self-check.
- Documentation restructured around README/CONTRIBUTING/SECURITY; internal
  spec references, personal information and tool name-drops removed.

### Fixed
- **All open tabs rendered at once** - a CSS cascade bug where component
  roots (`.term-root`, `.fs-root`, …) set `display:flex` and outranked the
  panel-hide rule; masked by the old absolute stacking, exposed by the new
  split grid. Non-visible panes are now hidden with an ID-scoped rule.
- **File transfer/browsing on distroless containers** returned a raw OCI
  runtime error; now detects shell-less targets and shows a clear message
  pointing to the ephemeral debug container.
- **Ephemeral debug containers on `runAsNonRoot` pods** (e.g. cert-manager)
  failed with `CreateContainerConfigError`; TifEra now matches the pod's
  security context and fails fast with the real reason otherwise.
- **Black screen after closing the last tab** - the welcome panel was
  destroyed on first tab open instead of hidden; it now returns.
- Log viewer strips ANSI escape codes; duplicate tabs focus-and-blink the
  existing one; a banner shows when the console loses its backend.

## [0.1.0] - 2026-07-03

First working release: deployed and exercised end-to-end on a single-node
k3s cluster (v1.36).

### Added
- **In-cluster-only runtime**: startup verification of the pod environment
  with fail-fast refusal outside a cluster (< 5 s, no bypass), in-cluster
  K8s client only, Downward API identity, RBAC self-check surfaced via
  `/readyz` and a UI banner.
- **Interactive shells**: one-click PTY terminals (xterm.js) over
  `pods/exec`, shell auto-detection (`bash` → `sh` → `ash`), tabbed layout,
  10k scrollback, search-in-buffer, resize propagation, reconnect-on-drop
  with scrollback replay, idle timeout, ephemeral debug containers for
  shell-less images.
- **File transfer & browser**: agentless exec-based file operations
  (`tar`/`cat`/`head -c` pipes), chunked uploads with drag-and-drop, file
  and directory (tar.gz) downloads, small-file editor with conflict
  detection, rename/delete/chmod/mkdir, per-container bookmarks.
- **Logs**: live follow with pause, regex filter and level highlighting,
  previous-instance logs, merged multi-container view, downloads with
  tail/time-range selection.
- **Metrics**: metrics.k8s.io polling with 60-minute per-container history
  and sparklines, usage vs requests/limits indicators, node
  allocatable-vs-used, opt-in `df` disk sampling; degrades gracefully
  without metrics-server.
- **Topology**: Services → Pods and workload → Pods graph with optional
  ConfigMap/Secret mount edges, unhealthy paths highlighted, click-through
  to pod details.
- **Multi-client presence**: per-browser client identity, fully isolated
  sessions, presence badges, mutual same-container shell warnings, editor
  conflict warnings.
- **Accountability**: SQLite action log with client identity + IP and JSONL
  export; optional terminal session recording (.cast files) with retention
  policy.
- **Operator tools**: pod restart with self-termination protection for
  TifEra's own pod, pod YAML view, events feed, command snippets, broadcast
  input to multiple terminals.
- **Deployment**: single-file manifest (`deploy/tifera.yaml`) with
  least-privilege ClusterRole, Deployment, ClusterIP Service, PVC and a
  commented sample NetworkPolicy; Dockerfile; GitHub Actions CI including
  the outside-cluster refusal test.
- Frontend: dependency-free vanilla ES modules with vendored xterm.js.

### Fixed
- **Event-loop deadlock on log-stream close** - closing a followed logs tab
  called `resp.close()` on the asyncio event loop while the reader thread
  held the buffered-reader lock, freezing the entire server until the
  liveness probe killed the pod. Streams are now aborted via socket
  `shutdown()` and closed by their reader thread; terminal session closes
  also moved off the event loop.
- **403 on every exec-based feature** - the ClusterRole granted only
  `create` on `pods/exec`, but WebSocket clients connect with GET (verb
  `get`), breaking shells, file transfer and disk sampling. RBAC now grants
  `get`+`create` on `pods/exec`/`pods/portforward` and `patch` on
  `pods/ephemeralcontainers`; the startup RBAC self-check verifies the
  verbs actually used.
- **Env-var collision crash** - a Service named `tifera` makes kubelet
  inject `TIFERA_PORT=tcp://...`, which crashed config parsing at startup.
  The setting was renamed `TIFERA_LISTEN_PORT` and the pod sets
  `enableServiceLinks: false`.
- UI: duplicate tabs replaced by focus-and-blink deduplication (with an
  explicit ⊕ button for a second shell in the same container), panel
  stacking/z-order hardened, ANSI escape codes stripped from log views, a
  visible banner when the console loses its backend connection, probe
  timeouts hardened in the manifest.

[Unreleased]: https://github.com/stratza/tiferea/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/stratza/tiferea/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stratza/tiferea/releases/tag/v0.1.0
