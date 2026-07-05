# Contributing to TifEra

Thanks for considering a contribution! TifEra is small and opinionated;
this document explains the ground rules and the development workflow.

## The invariants (please read first)

Contributions that violate these will be declined regardless of quality -
they are the product's identity, not implementation details:

1. **In-cluster only.** No kubeconfig loading, no API-server URL override,
   no standalone/desktop mode, no flag to bypass the startup check.
2. **Login + roles, enforced server-side.** Access is gated by
   authentication with Admin / Operator / Viewer roles, checked on every
   sensitive endpoint and WebSocket - UI gating is convenience, not the
   boundary. TifEra never exceeds its own ServiceAccount RBAC.

## Repository layout

```
backend/tifera/      Python 3.12 backend (FastAPI + official kubernetes client)
backend/static/      frontend - dependency-free ES modules + vendored xterm.js
backend/tests/       pytest suite (no cluster required)
deploy/tifera.yaml   single-file deployment manifest
deploy/helm/tifera   Helm chart (same contract, configurable)
```

## Development setup

```sh
python -m venv .venv && . .venv/bin/activate   # or Scripts\activate on Windows
pip install -r backend/requirements.txt pytest
PYTHONPATH=backend pytest backend/tests -q     # must pass
```

Frontend has no build step. Syntax-check with:

```sh
for f in backend/static/js/*.js; do cp "$f" /tmp/check.mjs; node --check /tmp/check.mjs; done
```

## Running against a real cluster

There is deliberately no way to run the backend from your workstation -
use a local cluster (kind/k3d/k3s) and deploy the image:

```sh
docker build -t tifera:dev backend
kind load docker-image tifera:dev          # or: k3d image import tifera:dev
kubectl apply -f deploy/tifera.yaml        # adjust the image tag first
kubectl -n tifera port-forward svc/tifera 8080:80
```

No Docker on your machine? You can build in-cluster with Kaniko and import
the tarball into containerd - stream the build context to a Kaniko pod with
`--context=tar://stdin --no-push --tarPath=...`, then `ctr images import`
on the node.

## Guidelines

- **Never block the event loop.** Anything that can wait on the network -
  exec streams, log reads, websocket-client calls, urllib3 `close()` -
  belongs on a worker thread or behind `asyncio.to_thread`. We froze the
  entire server once because a `resp.close()` ran on the loop; see
  `logs.py::LogStream.close` for the pattern and the war story.
- **RBAC changes come in threes:** the ClusterRole in `deploy/tifera.yaml`,
  the chart template in `deploy/helm/tifera`, and
  `incluster.py::REQUIRED_ACCESS` (the self-check - test the verbs the code
  *actually uses*; WebSocket exec is `get`, SPDY is `create`).
- **Gate every sensitive endpoint by role.** New REST routes and WebSockets
  must be reachable only at the right role (viewer/operator/admin) - the
  `auth_gate` middleware and the per-WS `_ws_user` check in `app.py` are the
  boundary. Viewers must never reach shells, files, kubectl, logs, Secrets or
  any write. UI hiding is convenience, not enforcement.
- **Frontend stays dependency-free.** Vanilla ES modules, no build step,
  no CDN loads (CSP is `default-src 'self'`); vendor new libraries into
  `static/vendor/` only with good reason.
- **Tests:** pure-logic changes need a unit test in `backend/tests`
  (no cluster required there). Cluster-dependent behaviour should at least
  document a manual verification path in the PR.
- Match the existing code style; keep comments about *constraints*, not
  narration.

## Pull requests

- One logical change per PR; explain the *why*, not just the what.
- `PYTHONPATH=backend pytest backend/tests -q` and the JS syntax check must
  pass (CI runs both, plus a Docker build that asserts the outside-cluster
  refusal).
- Update `CHANGELOG.md` under **Unreleased**.

## Cutting a release

Releases are tag-driven and fully automated by
[`.github/workflows/release.yml`](.github/workflows/release.yml). To ship
version `X.Y.Z`:

1. Bump the version in the four places it lives, and keep them in sync:
   `backend/tifera/__init__.py`, `deploy/helm/tifera/Chart.yaml`
   (`version` + `appVersion`), `deploy/tifera.yaml` (image tag), and the
   README badge/quickstart.
2. Move the `CHANGELOG.md` **[Unreleased]** items under a new
   `## [X.Y.Z] - <date>` heading (the workflow copies this section verbatim
   into the GitHub Release notes, so keep the heading format exact).
3. Commit, then tag and push:
   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Pushing the tag runs the workflow, which gates on the test suite and then:

- builds and pushes a multi-arch (amd64 + arm64) image to
  `ghcr.io/<owner>/tifera:X.Y.Z` (and `:latest`);
- packages the Helm chart and pushes it as an OCI artifact to
  `ghcr.io/<owner>/charts/tifera`;
- generates `tifera-X.Y.Z.yaml`, a ready-to-apply manifest pinned to the
  published image;
- creates the GitHub Release with notes from the CHANGELOG, attaching the
  manifest and the chart `.tgz`.

You can also trigger it manually from the Actions tab
(**workflow_dispatch**) by entering a `vX.Y.Z` tag that already exists.

**One-time setup:** the workflow uses the built-in `GITHUB_TOKEN` (no
secrets to configure). The first pushed image package is private by
default - make it public under **Packages → tifera → Package settings** if
you want `kubectl apply` of the manifest to pull without a pull secret.

## Reporting bugs

Open an issue with: cluster type/version (kind, k3s, EKS…), TifEra version
(`/healthz` payload), pod logs (`kubectl -n tifera logs -l app=tifera`),
and `/readyz` output (it includes the RBAC self-check detail).

For anything security-related, see [SECURITY.md](SECURITY.md).
