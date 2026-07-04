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
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=kubectl /tmp/kubectl /usr/local/bin/kubectl

COPY tifera ./tifera
COPY static ./static

USER 65532:65532
EXPOSE 8080

ENTRYPOINT ["python", "-m", "tifera"]
