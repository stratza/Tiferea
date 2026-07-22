# TifEra backend image.
# In-cluster-only: running this image outside Kubernetes (e.g. `docker run`)
# exits non-zero within 5 s with an actionable error.

# kubectl for the in-cluster console (Rancher-style). Downloaded per target
# arch; pin TIFERA_KUBECTL_VERSION as a build-arg for reproducibility.
FROM curlimages/curl:8.11.0 AS kubectl
ARG TARGETARCH
ARG KUBECTL_VERSION
RUN set -eux; \
    ver="${KUBECTL_VERSION:-$(curl -fsSL https://dl.k8s.io/release/stable.txt)}"; \
    curl -fsSLo /tmp/kubectl "https://dl.k8s.io/release/${ver}/bin/linux/${TARGETARCH:-amd64}/kubectl"; \
    chmod +x /tmp/kubectl

FROM python:3.12-slim

LABEL org.opencontainers.image.title="TifEra" \
      org.opencontainers.image.description="In-cluster-only Kubernetes operations console" \
      org.opencontainers.image.vendor="Stratza Labs" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/stratza/tiferea"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=kubectl /tmp/kubectl /usr/local/bin/kubectl

COPY tifera ./tifera
COPY static ./static

# Named, non-root account for UID/GID 65532 (matches the pod securityContext's
# runAsUser/runAsGroup). A bare numeric UID has no /etc/passwd entry, which
# makes some tools misbehave ("I have no name!", failed getpwuid lookups) -
# notably inside the in-cluster kubectl console's interactive bash shell.
# Home is /tmp: the image root is read-only at runtime.
RUN groupadd -g 65532 tifera \
    && useradd -u 65532 -g 65532 -d /tmp -s /usr/sbin/nologin -c "TifEra" tifera

USER tifera:tifera
EXPOSE 8080

ENTRYPOINT ["python", "-m", "tifera"]
