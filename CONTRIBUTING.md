# Contributing to TifEra

Thanks for considering a contribution! TifEra is small and opinionated;
this document explains the ground rules and the development workflow.

## The two invariants (please read first)

Contributions that violate these will be declined regardless of quality -
they are the product's identity, not implementation details:

1. **In-cluster only.** No kubeconfig loading, no API-server URL override,
   no standalone/desktop mode, no flag to bypass the startup check.
2. **No console authentication.** No accounts, logins, cookies, tokens or
   roles - access control is network reachability by design. Cooperative
   awareness (presence, warnings) yes; access control no.

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

## Reporting bugs

Open an issue with: cluster type/version (kind, k3s, EKS…), TifEra version
(`/healthz` payload), pod logs (`kubectl -n tifera logs -l app=tifera`),
and `/readyz` output (it includes the RBAC self-check detail).

For anything security-related, see [SECURITY.md](SECURITY.md).
