# Security Policy

## The trust model, stated plainly

TifEra has **no console authentication by design**. Anyone who can reach
the TifEra Service holds the full power of its ServiceAccount: interactive
shells in every visible container, file read/write, log access, and pod
deletion. This is an invariant, not a default - no auth layer will be added
behind a flag.

Consequently, **network reachability is the entire security boundary**:

- The shipped Service is `ClusterIP`. Reaching it requires either being
  inside the cluster network or `kubectl port-forward` (which itself
  requires kubeconfig credentials). That is the intended posture.
- Switching the Service to `NodePort`/`LoadBalancer` publishes root-level
  cluster access to whoever can reach that address. Do this only behind
  network controls you trust, and use the sample NetworkPolicy shipped with
  the manifests.
- Traffic is plain HTTP/WS. TifEra terminates no TLS; put your own proxy in
  front if you need encryption in transit.

Deploying TifEra with wide network exposure is a *configuration* decision,
not a TifEra vulnerability.

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
| 0.1.x | ✅ |

## Hardening checklist for operators

- Keep the Service `ClusterIP`; prefer `kubectl port-forward` for access.
- Apply (and adapt) the sample NetworkPolicy shipped with the manifests.
- Review the ClusterRole; drop the `delete pods` rule (or set
  `rbac.allowPodDelete: false` in the Helm chart) if you don't want the
  restart quick-action.
- The action log records who did what with self-declared names - useful for
  coordination, **not** forensic attribution.
- Enable session recording (`TIFERA_RECORD_SESSIONS=1`) if you need an
  audit trail of terminal activity.
