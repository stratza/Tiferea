# Security Policy

## The trust model, stated plainly

TifEra requires **login**, with role-based access enforced server-side:

- On first run an admin sets a username + password. It is hashed with
  `scrypt` and stored, together with the session-signing key, in a
  Kubernetes Secret (`tifera-auth`) that TifEra manages in its own
  namespace - nothing sensitive is written to disk.
- Sessions are stateless HMAC-signed tokens in an HttpOnly, SameSite=Strict
  cookie (12h default TTL).
- Roles: **Admin** (full access + user management), **Operator** (full
  operator access), **Viewer** (read-only, non-sensitive: inventory,
  metrics, topology, events, non-Secret YAML - no shells, files, kubectl,
  logs, Secrets, apply/delete or the action log). Every sensitive endpoint
  and WebSocket checks the role; the UI gating is convenience, not the
  boundary.

Two boundaries still matter alongside login:

- **Network exposure.** The shipped Service is `ClusterIP`; reach it via
  `kubectl port-forward`. Switching to `NodePort`/`LoadBalancer` exposes the
  login page more widely - do it only behind network controls you trust,
  and consider the sample NetworkPolicy shipped with the manifests.
- **TLS.** Traffic is plain HTTP/WS - TifEra terminates no TLS. Because
  session cookies and passwords cross the wire, **put a TLS proxy in front
  for any exposure beyond local `port-forward`.** The session cookie is not
  marked `Secure` (so it works over plain-HTTP port-forward); terminate TLS
  at your proxy.

An operator with the cluster's ServiceAccount RBAC still bounds what any
logged-in user can ultimately do - TifEra never exceeds its own RBAC.

## What *is* a vulnerability

Reports are very welcome for anything that breaks the model above or the
in-cluster invariants, for example:

- Bypassing the in-cluster-only enforcement or extracting the
  ServiceAccount token via any API/UI surface.
- Cross-site abuse from other pages an operator has open (CSP or WebSocket
  `Origin` check bypass).
- One client affecting another client's sessions (session isolation).
- Secret *values* appearing anywhere in the UI or API.
- Privilege escalation beyond the documented ClusterRole.
- Server crash/denial triggered through normal console traffic.

## Reporting

Please report privately via
[GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories)
("Report a vulnerability" on the repository's Security tab). Please do not
open public issues for unpatched vulnerabilities.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Hardening checklist for operators

- Keep the Service `ClusterIP`; prefer `kubectl port-forward` for access, and
  front any wider exposure with a TLS proxy (cookies/passwords cross the wire).
- Use strong admin/user passwords; grant Operator sparingly, prefer Viewer.
- Apply (and adapt) the sample NetworkPolicy shipped with the manifests.
- Review the ClusterRole; drop the `delete pods` rule (or set
  `rbac.allowPodDelete: false` in the Helm chart) if you don't want the
  restart quick-action.
- The action log records who did what with self-declared names - useful for
  coordination, **not** forensic attribution.
- Enable session recording (`TIFERA_RECORD_SESSIONS=1`) if you need an
  audit trail of terminal activity.
